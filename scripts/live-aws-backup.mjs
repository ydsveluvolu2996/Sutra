import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, chmod, mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ensureDockerLocalEnvironment } from "./docker-local-env.mjs";
import { LIVE_COMPOSE_PROJECT, LIVE_RUNTIME_CONFIG } from "./live-aws-host.mjs";

const STATE_FILES = Object.freeze([
  LIVE_RUNTIME_CONFIG,
  ".sutra/live-aws-collector-registry.enc",
  ".sutra/live-aws-jobs.json",
]);

export function assertLiveProcessesStopped({ webOpen, collectorOpen }) {
  if (webOpen || collectorOpen) {
    throw new Error("Stop the live AWS launcher with Ctrl-C before creating a coordinated backup");
  }
}

async function portOpen(port) {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (open) => { socket.destroy(); resolvePromise(open); };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function run(command, args, { cwd, outputPath, capture = false } = {}) {
  const output = outputPath === undefined ? undefined : await open(outputPath, "wx", 0o600);
  let stdout = "";
  try {
    await new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd,
        stdio: ["ignore", output?.fd ?? (capture ? "pipe" : "inherit"), "inherit"],
      });
      if (capture) child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0
        ? resolvePromise()
        : reject(new Error(`${command} exited ${signal ?? code}`)));
    });
    await output?.sync();
    return stdout;
  } finally {
    await output?.close();
  }
}

async function composeRunning(root, environmentPath) {
  const output = await run("docker", [
    "compose", "--project-name", LIVE_COMPOSE_PROJECT, "--env-file", environmentPath,
    "ps", "--status", "running", "--services", "postgres",
  ], { cwd: root, capture: true });
  return output.split(/\r?\n/u).includes("postgres");
}

async function main() {
  const root = resolve(import.meta.dirname, "..");
  const [webOpen, collectorOpen] = await Promise.all([portOpen(3000), portOpen(8788)]);
  assertLiveProcessesStopped({ webOpen, collectorOpen });

  const { environmentPath } = await ensureDockerLocalEnvironment(root);
  const availableState = [];
  for (const file of STATE_FILES) {
    try {
      await access(resolve(root, file));
      availableState.push(file);
    } catch (error) {
      if (error?.code !== "ENOENT" || file === LIVE_RUNTIME_CONFIG) throw error;
    }
  }

  const backupRoot = resolve(root, ".sutra", "live-aws-backups");
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const dumpPath = resolve(backupRoot, `sutra-live-${stamp}.dump`);
  const statePath = resolve(backupRoot, `sutra-live-${stamp}.state.tar`);
  const manifestPath = resolve(backupRoot, `sutra-live-${stamp}.manifest.json`);
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });

  const compose = ["compose", "--project-name", LIVE_COMPOSE_PROJECT, "--env-file", environmentPath];
  let startedPostgres = false;
  try {
    if (!await composeRunning(root, environmentPath)) {
      await run("docker", [...compose, "up", "--detach", "--wait", "postgres"], { cwd: root });
      startedPostgres = true;
    }
    await run("docker", [
      ...compose, "exec", "-T", "postgres", "pg_dump",
      "--username", "sutra_owner", "--dbname", "sutra", "--format=custom",
      "--no-owner", "--no-privileges",
    ], { cwd: root, outputPath: dumpPath });
    await run("tar", ["-C", root, "-cf", statePath, "--", ...availableState], { cwd: root });
    await Promise.all([chmod(dumpPath, 0o600), chmod(statePath, 0o600)]);
    const [dumpStatus, stateStatus, databaseSha256, applicationStateSha256, runtimeConfigSha256] = await Promise.all([
      stat(dumpPath),
      stat(statePath),
      sha256File(dumpPath),
      sha256File(statePath),
      sha256File(resolve(root, LIVE_RUNTIME_CONFIG)),
    ]);
    await writeFile(manifestPath, `${JSON.stringify({
      schema: "sutra.live-aws-backup.v1",
      createdAt: new Date().toISOString(),
      requiresStoppedHostProcesses: true,
      database: { name: basename(dumpPath), bytes: dumpStatus.size, sha256: databaseSha256 },
      applicationState: {
        name: basename(statePath), bytes: stateStatus.size, sha256: applicationStateSha256,
        files: availableState,
      },
      runtimeConfigSha256,
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    process.stdout.write(`Created coordinated live AWS backup ${manifestPath}\n`);
  } catch (error) {
    await Promise.all([rm(dumpPath, { force: true }), rm(statePath, { force: true }), rm(manifestPath, { force: true })]);
    throw error;
  } finally {
    if (startedPostgres) await run("docker", [...compose, "stop", "postgres"], { cwd: root }).catch(() => undefined);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
