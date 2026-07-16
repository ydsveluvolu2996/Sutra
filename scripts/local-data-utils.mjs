import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";

const MANIFEST_VERSION = 1;
const D1_SOURCE = ".wrangler/state/v3/d1";
const REGISTRY_SOURCE = ".sutra/collector-registry.enc";
const JOB_STATE_SOURCE = ".sutra/local-jobs.json";
const CONFIG_SOURCE = ".dev.vars";
const REQUIRED_KEY_NAMES = [
  "SUTRA_CONNECTION_ENCRYPTION_KEY",
  "SUTRA_BROKER_SHARED_SECRET",
  "SUTRA_REGISTRY_ENCRYPTION_KEY",
  "SUTRA_AUTH_ENCRYPTION_KEY",
];

function pathInside(root, candidate) {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function safeRelativePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error("Backup manifest contains an unsafe path");
  }
  return value;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function filesUnder(directory) {
  if (!(await exists(directory))) return [];
  const files = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Local backup refuses non-file state at ${path}`);
    }
  }
  await visit(directory);
  return files;
}

async function sha256File(path) {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function keyFingerprints(configurationPath) {
  const raw = await readFile(configurationPath, "utf8");
  const values = new Map();
  for (const rawLine of raw.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const fingerprints = {};
  for (const name of REQUIRED_KEY_NAMES) {
    const value = values.get(name);
    if (value === undefined || value.length < 32) {
      throw new Error(`Local configuration is missing ${name}; run pnpm pilot:setup`);
    }
    fingerprints[name] = sha256Text(value);
  }
  return fingerprints;
}

async function portIsOpen(port) {
  return await new Promise((resolvePromise) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(350);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function assertLocalServicesStopped() {
  const openPorts = [];
  for (const port of [3000, 8788]) {
    if (await portIsOpen(port)) openPorts.push(port);
  }
  if (openPorts.length > 0) {
    throw new Error(
      `Stop pnpm dev:pilot before backup or restore (local port${openPorts.length === 1 ? "" : "s"} ${openPorts.join(", ")} still open)`,
    );
  }
}

function defaultBackupDirectory(root, now) {
  const stamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return join(root, ".sutra", "backups", `${stamp}-${randomUUID().slice(0, 8)}`);
}

async function copyIntoBackup(source, destination, backupDirectory, files) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
  await chmod(destination, 0o600);
  const fileStat = await stat(destination);
  files.push({
    path: relative(backupDirectory, destination).split(sep).join("/"),
    bytes: fileStat.size,
    sha256: await sha256File(destination),
  });
}

export async function backupLocalState({
  root,
  target,
  now = new Date(),
  assertStopped = assertLocalServicesStopped,
} = {}) {
  if (!root) throw new Error("A Sutra repository root is required");
  await assertStopped();
  const repositoryRoot = resolve(root);
  const backupDirectory = resolve(target ?? defaultBackupDirectory(repositoryRoot, now));
  if (!pathInside(repositoryRoot, backupDirectory)) {
    throw new Error("Local backups must stay inside the Sutra repository so permissions and cleanup remain explicit");
  }
  await mkdir(dirname(backupDirectory), { recursive: true, mode: 0o700 });
  await mkdir(backupDirectory, { recursive: false, mode: 0o700 });

  const files = [];
  try {
    const configPath = join(repositoryRoot, CONFIG_SOURCE);
    if (!(await exists(configPath))) throw new Error("Run pnpm pilot:setup before creating a backup");
    const fingerprints = await keyFingerprints(configPath);

    const registryPath = join(repositoryRoot, REGISTRY_SOURCE);
    if (await exists(registryPath)) {
      await copyIntoBackup(
        registryPath,
        join(backupDirectory, "collector", "collector-registry.enc"),
        backupDirectory,
        files,
      );
    }

    const jobStatePath = join(repositoryRoot, JOB_STATE_SOURCE);
    if (await exists(jobStatePath)) {
      await copyIntoBackup(jobStatePath, join(backupDirectory, "jobs", "local-jobs.json"), backupDirectory, files);
    }

    const d1Directory = join(repositoryRoot, D1_SOURCE);
    for (const source of await filesUnder(d1Directory)) {
      const suffix = relative(d1Directory, source);
      await copyIntoBackup(source, join(backupDirectory, "d1", suffix), backupDirectory, files);
    }

    files.sort((left, right) => left.path.localeCompare(right.path));
    const manifest = {
      schema: "sutra.local-backup.v1",
      version: MANIFEST_VERSION,
      createdAt: now.toISOString(),
      keyFingerprints: fingerprints,
      files,
    };
    await writeFile(join(backupDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(backupDirectory, 0o700);
    return { backupDirectory, manifest };
  } catch (error) {
    await rm(backupDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function validateManifest(backupDirectory) {
  const raw = await readFile(join(backupDirectory, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw);
  if (
    manifest?.schema !== "sutra.local-backup.v1" ||
    manifest?.version !== MANIFEST_VERSION ||
    typeof manifest?.keyFingerprints !== "object" ||
    manifest.keyFingerprints === null ||
    Array.isArray(manifest.keyFingerprints) ||
    !Array.isArray(manifest?.files)
  ) {
    throw new Error("Backup manifest is missing or uses an unsupported version");
  }
  const seen = new Set();
  for (const entry of manifest.files) {
    const path = safeRelativePath(entry?.path);
    if (
      path !== "collector/collector-registry.enc" &&
      path !== "jobs/local-jobs.json" &&
      !path.startsWith("d1/")
    ) {
      throw new Error(`Backup manifest contains an unsupported file: ${path}`);
    }
    if (seen.has(path)) throw new Error("Backup manifest contains duplicate files");
    seen.add(path);
    if (!Number.isSafeInteger(entry?.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/u.test(entry?.sha256 ?? "")) {
      throw new Error("Backup manifest contains invalid integrity metadata");
    }
    const source = join(backupDirectory, ...path.split("/"));
    const sourceStat = await stat(source);
    if (!sourceStat.isFile() || sourceStat.size !== entry.bytes || (await sha256File(source)) !== entry.sha256) {
      throw new Error(`Backup integrity check failed for ${path}`);
    }
  }
  for (const name of REQUIRED_KEY_NAMES) {
    if (!/^[a-f0-9]{64}$/u.test(manifest.keyFingerprints[name] ?? "")) {
      throw new Error("Backup manifest is missing encryption-key compatibility metadata");
    }
  }
  return manifest;
}

async function moveIfPresent(source, destination) {
  if (!(await exists(source))) return false;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await rename(source, destination);
  return true;
}

export async function restoreLocalState({
  root,
  backup,
  assertStopped = assertLocalServicesStopped,
} = {}) {
  if (!root || !backup) throw new Error("A Sutra repository root and backup directory are required");
  await assertStopped();
  const repositoryRoot = resolve(root);
  const backupDirectory = resolve(backup);
  if (!pathInside(repositoryRoot, backupDirectory)) throw new Error("The backup must be inside the Sutra repository");
  const manifest = await validateManifest(backupDirectory);
  const currentFingerprints = await keyFingerprints(join(repositoryRoot, CONFIG_SOURCE));
  for (const name of REQUIRED_KEY_NAMES) {
    if (currentFingerprints[name] !== manifest.keyFingerprints[name]) {
      throw new Error(
        `Backup requires a different ${name}; restore the matching secret through the separate secure secret process first`,
      );
    }
  }

  const operationId = randomUUID();
  const staging = join(repositoryRoot, ".sutra", `restore-staging-${operationId}`);
  const rollback = join(repositoryRoot, ".sutra", `restore-rollback-${operationId}`);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  await mkdir(rollback, { recursive: true, mode: 0o700 });

  try {
    for (const entry of manifest.files) {
      const source = join(backupDirectory, ...entry.path.split("/"));
      const destination = join(staging, ...entry.path.split("/"));
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(source, destination);
      await chmod(destination, 0o600);
    }

    const currentD1 = join(repositoryRoot, D1_SOURCE);
    const currentRegistry = join(repositoryRoot, REGISTRY_SOURCE);
    const currentJobs = join(repositoryRoot, JOB_STATE_SOURCE);
    const moved = {
      d1: await moveIfPresent(currentD1, join(rollback, "d1")),
      registry: await moveIfPresent(currentRegistry, join(rollback, "collector-registry.enc")),
      jobs: await moveIfPresent(currentJobs, join(rollback, "local-jobs.json")),
    };

    try {
      await mkdir(dirname(currentD1), { recursive: true, mode: 0o700 });
      await moveIfPresent(join(staging, "d1"), currentD1);
      await mkdir(dirname(currentRegistry), { recursive: true, mode: 0o700 });
      await moveIfPresent(join(staging, "collector", "collector-registry.enc"), currentRegistry);
      await moveIfPresent(join(staging, "jobs", "local-jobs.json"), currentJobs);
      if (await exists(currentRegistry)) await chmod(currentRegistry, 0o600);
      if (await exists(currentJobs)) await chmod(currentJobs, 0o600);
      await rm(rollback, { recursive: true, force: true });
    } catch (error) {
      await rm(currentD1, { recursive: true, force: true });
      await rm(currentRegistry, { force: true });
      await rm(currentJobs, { force: true });
      if (moved.d1) await moveIfPresent(join(rollback, "d1"), currentD1);
      if (moved.registry) await moveIfPresent(join(rollback, "collector-registry.enc"), currentRegistry);
      if (moved.jobs) await moveIfPresent(join(rollback, "local-jobs.json"), currentJobs);
      throw error;
    }
    return { restoredFrom: backupDirectory, fileCount: manifest.files.length };
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(rollback, { recursive: true, force: true });
  }
}
