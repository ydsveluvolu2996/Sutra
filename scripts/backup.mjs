import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const databaseUrl = (process.env.SUTRA_MIGRATOR_DATABASE_URL ?? process.env.DATABASE_URL)?.trim();
if (!databaseUrl) throw new Error("SUTRA_MIGRATOR_DATABASE_URL is required to back up Sutra PostgreSQL");
const parsed = new URL(databaseUrl);
if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) throw new Error("DATABASE_URL must be a PostgreSQL URL");

const backupRoot = resolve(import.meta.dirname, "..", ".sutra", "postgres-backups");
await mkdir(backupRoot, { recursive: true, mode: 0o700 });
const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const dumpPath = resolve(backupRoot, `sutra-${timestamp}.dump`);

await new Promise((resolvePromise, reject) => {
  const child = spawn("pg_dump", [
    "--dbname", databaseUrl, "--format=custom", "--no-owner", "--no-privileges", "--file", dumpPath,
  ], { stdio: ["ignore", "inherit", "inherit"] });
  child.once("error", reject);
  child.once("exit", (code, signal) => code === 0
    ? resolvePromise()
    : reject(new Error(`pg_dump exited ${signal ?? code}`)));
});

process.stdout.write(`Created ${dumpPath}\n`);
process.stdout.write(`Restore into an empty database with: pg_restore --clean --if-exists --no-owner --dbname <DATABASE_URL> ${dumpPath}\n`);
