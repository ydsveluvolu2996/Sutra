import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import pg from "pg";
import { ensureDockerLocalEnvironment } from "./docker-local-env.mjs";

const root = resolve(import.meta.dirname, "..");
const POSTGRES_TEST_PROJECT = "sutra-postgres-test";
const suppliedOwnerUrl = optionalEnvironmentValue("SUTRA_POSTGRES_TEST_URL");
const suppliedRuntimeUrl = optionalEnvironmentValue("SUTRA_POSTGRES_RUNTIME_TEST_URL");
if ((suppliedOwnerUrl === undefined) !== (suppliedRuntimeUrl === undefined)) {
  throw new Error("Provide both SUTRA_POSTGRES_TEST_URL and SUTRA_POSTGRES_RUNTIME_TEST_URL");
}
// Keep the isolated verification database separate from the live-demo stack,
// which intentionally uses the normal local PostgreSQL port while Sutra runs.
const requestedPort = process.env.SUTRA_POSTGRES_TEST_PORT?.trim();
if (requestedPort !== undefined && !validPort(requestedPort)) {
  throw new Error("SUTRA_POSTGRES_TEST_PORT must be an integer from 1 through 65535");
}
const port = requestedPort ?? String(await findAvailableLoopbackPort());

async function run(command, args, environment = process.env) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, env: environment, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited ${signal ?? code}`));
    });
  });
}

function optionalEnvironmentValue(name) {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function validPort(value) {
  return /^\d{1,5}$/u.test(value) && Number(value) >= 1 && Number(value) <= 65_535;
}

async function findAvailableLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port for the PostgreSQL test container"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

let environmentPath;
let baseOwnerUrl;
let baseRuntimeUrl;
if (suppliedOwnerUrl === undefined) {
  const local = await ensureDockerLocalEnvironment(root);
  environmentPath = local.environmentPath;
  baseOwnerUrl =
    `postgresql://sutra_owner:${encodeURIComponent(local.ownerPassword)}@127.0.0.1:${port}/sutra`;
  baseRuntimeUrl =
    `postgresql://sutra_app:${encodeURIComponent(local.appPassword)}@127.0.0.1:${port}/sutra`;
  await run("docker", [
    "compose",
    "--project-name",
    POSTGRES_TEST_PROJECT,
    "--env-file",
    environmentPath,
    "up",
    "-d",
    "--wait",
    "postgres",
  ], {
    ...process.env,
    SUTRA_POSTGRES_PORT: port,
  });
}

let databaseName;
let databaseUrl = suppliedOwnerUrl;
let runtimeDatabaseUrl = suppliedRuntimeUrl;
let adminPool;
if (!databaseUrl && !runtimeDatabaseUrl) {
  if (baseOwnerUrl === undefined || baseRuntimeUrl === undefined) {
    throw new Error("The local PostgreSQL test environment is incomplete");
  }
  databaseName = `sutra_test_${randomBytes(8).toString("hex")}`;
  const adminUrl = new URL(baseOwnerUrl);
  adminUrl.pathname = "/postgres";
  adminPool = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 });
  await adminPool.query(`CREATE DATABASE "${databaseName}" OWNER sutra_owner`);
  const owner = new URL(baseOwnerUrl);
  owner.pathname = `/${databaseName}`;
  databaseUrl = owner.toString();
  const runtime = new URL(baseRuntimeUrl);
  runtime.pathname = `/${databaseName}`;
  runtimeDatabaseUrl = runtime.toString();
}

try {
  await run(process.execPath, [resolve(root, "scripts/postgres-migrate.mjs")], {
    ...process.env,
    DATABASE_URL: databaseUrl,
    SUTRA_MIGRATOR_DATABASE_URL: databaseUrl,
    SUTRA_POSTGRES_RUNTIME_ROLE: "sutra_app",
  });
  await run(process.execPath, ["--test", resolve(root, "tests/postgres-adapter.test.ts")], {
    ...process.env,
    SUTRA_POSTGRES_TEST_URL: databaseUrl,
    SUTRA_POSTGRES_RUNTIME_TEST_URL: runtimeDatabaseUrl,
  });
  await run(process.execPath, ["--test", resolve(root, "tests/postgres-schema-parity.test.mjs")], {
    ...process.env,
    SUTRA_POSTGRES_TEST_URL: runtimeDatabaseUrl,
  });
  await run(process.execPath, ["--test", resolve(root, "tests/postgres-repositories.test.mjs")], {
    ...process.env,
    SUTRA_POSTGRES_RUNTIME_TEST_URL: runtimeDatabaseUrl,
  });
  await run(process.execPath, ["--test", resolve(root, "tests/postgres-ses-feedback.test.mjs")], {
    ...process.env,
    SUTRA_POSTGRES_RUNTIME_TEST_URL: runtimeDatabaseUrl,
  });
  await run(process.execPath, ["--test", resolve(root, "tests/postgres-resource-retirement.test.mjs")], {
    ...process.env,
    SUTRA_POSTGRES_RUNTIME_TEST_URL: runtimeDatabaseUrl,
  });
  await run(process.execPath, ["--test", resolve(root, "tests/postgres-trust-audit.test.mjs")], {
    ...process.env,
    SUTRA_POSTGRES_RUNTIME_TEST_URL: runtimeDatabaseUrl,
  });
} finally {
  if (databaseName && adminPool) {
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  }
  if (!suppliedOwnerUrl && !suppliedRuntimeUrl) {
    if (environmentPath === undefined) {
      throw new Error("The local PostgreSQL test environment path is unavailable");
    }
    await run("docker", [
      "compose",
      "--project-name",
      POSTGRES_TEST_PROJECT,
      "--env-file",
      environmentPath,
      "down",
      "--volumes",
      "--remove-orphans",
    ]);
  }
}
