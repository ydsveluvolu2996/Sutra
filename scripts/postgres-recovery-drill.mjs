import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, resolve, sep } from "node:path";
import { assessRecoveryObjectives } from "../lib/recovery-objectives.ts";
import { ensureDockerLocalEnvironment } from "./docker-local-env.mjs";

const root = resolve(import.meta.dirname, "..");
const backupRoot = resolve(root, ".sutra", "postgres-backups");
const evidenceRoot = resolve(root, ".sutra", "recovery-drills");
const fromIndex = process.argv.indexOf("--from");
if (!process.argv.includes("--confirm-isolated-drill") || fromIndex < 0 || !process.argv[fromIndex + 1]) {
  throw new Error("Use --from <dump> --confirm-isolated-drill. The production database is never replaced.");
}

await Promise.all([
  mkdir(backupRoot, { recursive: true, mode: 0o700 }),
  mkdir(evidenceRoot, { recursive: true, mode: 0o700 }),
]);
const backupRootReal = await realpath(backupRoot);
const source = await realpath(resolve(root, process.argv[fromIndex + 1]));
if (!source.startsWith(`${backupRootReal}${sep}`)) {
  throw new Error("Recovery drill files must be under .sutra/postgres-backups");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const manifest = JSON.parse(await readFile(`${source}.manifest.json`, "utf8"));
if (
  manifest?.schema !== "sutra.local-stack-backup.v2" ||
  manifest?.files?.database?.name !== basename(source) ||
  manifest?.files?.database?.format !== "postgres-custom" ||
  manifest?.files?.applicationState?.format !== "tar"
) throw new Error("Recovery drill manifest is invalid");
const statePath = await realpath(resolve(dirname(source), manifest.files.applicationState.name));
if (!statePath.startsWith(`${backupRootReal}${sep}`)) throw new Error("Application-state archive path is invalid");
const [dumpStat, stateStat, dumpHash, stateHash] = await Promise.all([
  stat(source),
  stat(statePath),
  sha256File(source),
  sha256File(statePath),
]);
if (
  !dumpStat.isFile() ||
  !stateStat.isFile() ||
  dumpStat.size !== manifest.files.database.bytes ||
  stateStat.size !== manifest.files.applicationState.bytes ||
  dumpHash !== manifest.files.database.sha256 ||
  stateHash !== manifest.files.applicationState.sha256
) throw new Error("Recovery drill backup integrity verification failed");

const { environmentPath } = await ensureDockerLocalEnvironment(root);
const composeProject = `sutra-recovery-${randomBytes(6).toString("hex")}`;
const port = await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.unref();
  server.once("error", reject);
  server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      reject(new Error("Could not allocate an isolated recovery-drill port"));
      return;
    }
    server.close((error) => error ? reject(error) : resolvePort(address.port));
  });
});
const composePrefix = ["compose", "--project-name", composeProject, "--env-file", environmentPath];
const dockerEnvironment = { ...process.env, SUTRA_POSTGRES_PORT: String(port) };
const databaseName = `sutra_recovery_drill_${randomBytes(8).toString("hex")}`;
const startedAt = new Date().toISOString();
let restoredTableCount = 0;
let organizationCount = 0;
let customerCount = 0;
let auditEventCount = 0;

async function runDocker(args, { inputPath, capture = false } = {}) {
  let output = "";
  await new Promise((resolvePromise, reject) => {
    const child = spawn("docker", args, {
      cwd: root,
      env: dockerEnvironment,
      stdio: [inputPath ? "pipe" : "ignore", capture ? "pipe" : "inherit", "inherit"],
    });
    if (inputPath) createReadStream(inputPath).pipe(child.stdin);
    if (capture) child.stdout?.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolvePromise()
      : reject(new Error(`docker operation exited ${signal ?? code}`)));
  });
  return output.trim();
}

function psql(database, sql, capture = false) {
  return runDocker([
    ...composePrefix, "exec", "-T", "postgres", "psql",
    "--username", "sutra_owner", "--dbname", database,
    "--set", "ON_ERROR_STOP=1", "--tuples-only", "--no-align",
    "--command", sql,
  ], { capture });
}

let postgresStarted = false;
try {
  await runDocker([...composePrefix, "up", "-d", "--wait", "postgres"]);
  postgresStarted = true;
  await psql("postgres", `CREATE DATABASE "${databaseName}" OWNER sutra_owner`);
  await runDocker([
    ...composePrefix, "exec", "-T", "postgres", "pg_restore",
    "--username", "sutra_owner", "--dbname", databaseName,
    "--exit-on-error", "--no-owner", "--no-privileges",
  ], { inputPath: source });
  await new Promise((resolvePromise, reject) => {
    const child = spawn("tar", ["-tf", statePath], { cwd: root, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolvePromise()
      : reject(new Error(`application-state archive validation exited ${signal ?? code}`)));
  });
  const invariantSql = `
    SELECT
      (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'),
      (SELECT count(*) FROM organizations),
      (SELECT count(*) FROM customers),
      (SELECT count(*) FROM audit_events),
      (SELECT count(*) FROM customers c LEFT JOIN organizations o ON o.id = c.org_id WHERE o.id IS NULL);`;
  const invariantOutput = await psql(databaseName, invariantSql, true);
  const [tables, organizations, customers, auditEvents, orphanCustomers] = invariantOutput
    .split("|")
    .map((value) => Number(value.trim()));
  if (
    [tables, organizations, customers, auditEvents, orphanCustomers].some((value) => !Number.isSafeInteger(value)) ||
    tables < 10 ||
    orphanCustomers !== 0
  ) throw new Error("Restored database invariant verification failed");
  restoredTableCount = tables;
  organizationCount = organizations;
  customerCount = customers;
  auditEventCount = auditEvents;
} finally {
  if (postgresStarted) {
    await psql("postgres", `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  }
  await runDocker([...composePrefix, "down", "--volumes", "--remove-orphans"]);
}

const completedAt = new Date().toISOString();
const objectives = assessRecoveryObjectives({
  backupCreatedAt: manifest.createdAt,
  drillStartedAt: startedAt,
  drillCompletedAt: completedAt,
});
const evidence = {
  schema: "sutra.recovery-drill.v1",
  drillId: `recovery_${randomBytes(16).toString("hex")}`,
  startedAt,
  completedAt,
  source: {
    backupCreatedAt: manifest.createdAt,
    databaseSha256: dumpHash,
    applicationStateSha256: stateHash,
  },
  verification: {
    isolatedRestore: "passed",
    productionDatabaseModified: false,
    applicationStateArchive: "readable",
    restoredTableCount,
    organizationCount,
    customerCount,
    auditEventCount,
    orphanCustomerCount: 0,
    temporaryDatabaseRemoved: true,
  },
  objectives,
};
const evidencePath = resolve(
  evidenceRoot,
  `${startedAt.replaceAll(":", "-").replaceAll(".", "-")}.json`,
);
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
process.stdout.write(`Recovery drill ${objectives.outcome}: ${evidencePath}\n`);
if (objectives.outcome !== "passed") process.exitCode = 2;
