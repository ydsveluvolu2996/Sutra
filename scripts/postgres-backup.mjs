import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { ensureDockerLocalEnvironment } from "./docker-local-env.mjs";

const root = resolve(import.meta.dirname, "..");
const backupRoot = resolve(root, ".sutra", "postgres-backups");
const { environmentPath, ownerPassword, appPassword } = await ensureDockerLocalEnvironment(root);
const composePrefix = ["compose", "--env-file", environmentPath];
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const dumpPath = resolve(backupRoot, `sutra-${stamp}.dump`);
const statePath = resolve(backupRoot, `sutra-${stamp}.application-state.tar`);
const manifestPath = `${dumpPath}.manifest.json`;

await mkdir(backupRoot, { recursive: true, mode: 0o700 });

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function runDocker(args, { outputPath, capture = false } = {}) {
  const output = outputPath ? await open(outputPath, "wx", 0o600) : undefined;
  let stdout = "";
  try {
    await new Promise((resolvePromise, reject) => {
      const child = spawn("docker", args, {
        cwd: root,
        stdio: ["ignore", output?.fd ?? (capture ? "pipe" : "inherit"), "inherit"],
      });
      if (capture) child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0
        ? resolvePromise()
        : reject(new Error(`docker operation exited ${signal ?? code}`)));
    });
    await output?.sync();
    return stdout;
  } finally {
    await output?.close();
  }
}

let restartRequired = false;
try {
  await runDocker([...composePrefix, "up", "-d", "--wait", "postgres"]);
  await runDocker([...composePrefix, "stop", "app"]);
  restartRequired = true;

  const runtimeFingerprintOutput = await runDocker([
    ...composePrefix, "run", "--rm", "--no-deps", "--entrypoint", "node", "app",
    "scripts/runtime-key-fingerprints.mjs",
  ], { capture: true });
  const runtimeFingerprints = JSON.parse(runtimeFingerprintOutput);

  await runDocker([
    ...composePrefix, "exec", "-T", "postgres", "pg_dump",
    "--username", "sutra_owner", "--dbname", "sutra", "--format=custom", "--no-owner", "--no-privileges",
  ], { outputPath: dumpPath });
  await runDocker([
    ...composePrefix, "run", "--rm", "--no-deps", "--entrypoint", "tar", "app",
    "-C", "/app/.sutra", "-cf", "-", ".",
  ], { outputPath: statePath });

  await Promise.all([chmod(dumpPath, 0o600), chmod(statePath, 0o600)]);
  const [dumpStat, stateStat, dumpSha256, stateSha256] = await Promise.all([
    stat(dumpPath),
    stat(statePath),
    sha256File(dumpPath),
    sha256File(statePath),
  ]);
  const manifest = {
    schema: "sutra.local-stack-backup.v2",
    createdAt: new Date().toISOString(),
    database: "sutra",
    files: {
      database: {
        format: "postgres-custom",
        name: basename(dumpPath),
        bytes: dumpStat.size,
        sha256: dumpSha256,
      },
      applicationState: {
        format: "tar",
        name: basename(statePath),
        bytes: stateStat.size,
        sha256: stateSha256,
      },
    },
    keyFingerprints: {
      ...runtimeFingerprints,
      postgresOwnerPassword: sha256Text(ownerPassword),
      postgresRuntimePassword: sha256Text(appPassword),
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(`Created coordinated local-stack backup ${dumpPath}\n`);
} catch (error) {
  await Promise.all([
    rm(dumpPath, { force: true }),
    rm(statePath, { force: true }),
    rm(manifestPath, { force: true }),
  ]);
  throw error;
} finally {
  if (restartRequired) await runDocker([...composePrefix, "up", "-d", "--wait", "app"]);
}
