import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { ensureDockerLocalEnvironment } from "./docker-local-env.mjs";

const root = resolve(import.meta.dirname, "..");
const backupRoot = resolve(root, ".sutra", "postgres-backups");
const fromIndex = process.argv.indexOf("--from");
if (!process.argv.includes("--confirm-restore") || fromIndex < 0 || !process.argv[fromIndex + 1]) {
  throw new Error("Restore is destructive. Use --from <dump> --confirm-restore");
}

await mkdir(backupRoot, { recursive: true, mode: 0o700 });
const backupRootReal = await realpath(backupRoot);
const source = await realpath(resolve(root, process.argv[fromIndex + 1]));
if (source !== backupRootReal && !source.startsWith(`${backupRootReal}${sep}`)) {
  throw new Error("Restore files must be under .sutra/postgres-backups");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const manifest = JSON.parse(await readFile(`${source}.manifest.json`, "utf8"));
if (
  manifest?.schema !== "sutra.local-stack-backup.v2" ||
  manifest?.database !== "sutra" ||
  manifest?.files?.database?.format !== "postgres-custom" ||
  manifest?.files?.database?.name !== basename(source) ||
  manifest?.files?.applicationState?.format !== "tar" ||
  basename(manifest.files.applicationState.name ?? "") !== manifest.files.applicationState.name
) {
  throw new Error("Local-stack backup manifest is invalid");
}
const statePath = await realpath(resolve(dirname(source), manifest.files.applicationState.name));
if (!statePath.startsWith(`${backupRootReal}${sep}`)) throw new Error("Application-state backup path is invalid");
const [sourceStat, stateStat, sourceSha256, stateSha256] = await Promise.all([
  stat(source),
  stat(statePath),
  sha256File(source),
  sha256File(statePath),
]);
if (
  !sourceStat.isFile() ||
  !stateStat.isFile() ||
  manifest.files.database.bytes !== sourceStat.size ||
  manifest.files.applicationState.bytes !== stateStat.size ||
  manifest.files.database.sha256 !== sourceSha256 ||
  manifest.files.applicationState.sha256 !== stateSha256
) {
  throw new Error("Local-stack backup size or checksum is invalid");
}
const sourceHandle = await open(source, "r");
const headerBuffer = Buffer.alloc(5);
try {
  await sourceHandle.read(headerBuffer, 0, 5, 0);
} finally {
  await sourceHandle.close();
}
if (headerBuffer.toString("ascii") !== "PGDMP") throw new Error("Restore source is not a PostgreSQL custom dump");

const { environmentPath, ownerPassword, appPassword } = await ensureDockerLocalEnvironment(root);
const composePrefix = ["compose", "--env-file", environmentPath];

async function runDocker(args, { inputPath, outputPath, capture = false } = {}) {
  const input = inputPath ? await open(inputPath, "r") : undefined;
  const output = outputPath ? await open(outputPath, "wx", 0o600) : undefined;
  let stdout = "";
  try {
    await new Promise((resolvePromise, reject) => {
      const child = spawn("docker", args, {
        cwd: root,
        stdio: [input?.fd ?? "ignore", output?.fd ?? (capture ? "pipe" : "inherit"), "inherit"],
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
    await Promise.all([input?.close(), output?.close()]);
  }
}

async function recreateDatabase() {
  await runDocker([
    ...composePrefix, "exec", "-T", "postgres", "psql", "--username", "sutra_owner", "--dbname", "postgres",
    "--set", "ON_ERROR_STOP=1",
    "--command", "DROP DATABASE IF EXISTS sutra WITH (FORCE)",
    "--command", "CREATE DATABASE sutra OWNER sutra_owner",
  ]);
}

async function restoreDump(path) {
  await runDocker([
    ...composePrefix, "exec", "-T", "postgres", "pg_restore",
    "--username", "sutra_owner", "--dbname", "sutra", "--exit-on-error", "--no-owner", "--no-privileges",
  ], { inputPath: path });
}

async function migrateDatabase() {
  await runDocker([
    ...composePrefix, "run", "--rm", "--no-deps", "migrate",
  ]);
}

async function archiveState(path) {
  await runDocker([
    ...composePrefix, "run", "--rm", "--no-deps", "--entrypoint", "tar", "app",
    "-C", "/app/.sutra", "-cf", "-", ".",
  ], { outputPath: path });
}

async function restoreState(path) {
  await runDocker([
    ...composePrefix, "run", "--rm", "--no-deps", "--entrypoint", "node", "app",
    "scripts/reset-docker-app-state.mjs",
  ]);
  await runDocker([
    ...composePrefix, "run", "--rm", "--no-deps", "--entrypoint", "tar", "app",
    "-C", "/app/.sutra", "-xf", "-",
  ], { inputPath: path });
}

await runDocker([...composePrefix, "up", "-d", "--wait", "postgres"]);
await runDocker([...composePrefix, "exec", "-T", "postgres", "pg_restore", "--list"], {
  inputPath: source,
  capture: true,
});
await runDocker([
  ...composePrefix, "run", "--rm", "--no-deps", "--entrypoint", "tar", "app", "-tf", "-",
], { inputPath: statePath, capture: true });

const runtimeFingerprintOutput = await runDocker([
  ...composePrefix, "run", "--rm", "--no-deps", "--entrypoint", "node", "app",
  "scripts/runtime-key-fingerprints.mjs",
], { capture: true });
const currentFingerprints = {
  ...JSON.parse(runtimeFingerprintOutput),
  postgresOwnerPassword: sha256Text(ownerPassword),
  postgresRuntimePassword: sha256Text(appPassword),
};
if (JSON.stringify(currentFingerprints) !== JSON.stringify(manifest.keyFingerprints)) {
  throw new Error("Local runtime/database key fingerprints do not match this backup");
}

await runDocker([...composePrefix, "stop", "app"]);
const rollbackStamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const rollbackDump = resolve(backupRoot, `pre-restore-${rollbackStamp}.dump`);
const rollbackState = resolve(backupRoot, `pre-restore-${rollbackStamp}.application-state.tar`);
try {
  await runDocker([
    ...composePrefix, "exec", "-T", "postgres", "pg_dump",
    "--username", "sutra_owner", "--dbname", "sutra", "--format=custom", "--no-owner", "--no-privileges",
  ], { outputPath: rollbackDump });
  await archiveState(rollbackState);
} catch (error) {
  await runDocker([...composePrefix, "up", "-d", "--wait", "app"]);
  throw error;
}

let deferredFailure;
try {
  await recreateDatabase();
  await restoreDump(source);
  await migrateDatabase();
  await restoreState(statePath);
} catch (error) {
  try {
    await recreateDatabase();
    await restoreDump(rollbackDump);
    await migrateDatabase();
    await restoreState(rollbackState);
  } catch {
    throw new Error(
      `Restore and automatic rollback failed; the app remains stopped. Recovery files: ${rollbackDump}, ${rollbackState}`,
      { cause: error },
    );
  }
  deferredFailure = new Error("Restore failed; Sutra restored the complete pre-restore local state", { cause: error });
}

await runDocker([...composePrefix, "up", "-d", "--wait", "app"]);
if (deferredFailure) throw deferredFailure;
process.stdout.write(`Restored coordinated local-stack backup ${source}.\n`);
