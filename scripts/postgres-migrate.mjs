import { createHash } from "node:crypto";
import pg from "pg";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const databaseUrl = (process.env.SUTRA_MIGRATOR_DATABASE_URL ?? process.env.DATABASE_URL)?.trim();
if (!databaseUrl) throw new Error("SUTRA_MIGRATOR_DATABASE_URL is required to migrate Sutra PostgreSQL");

const parsed = new URL(databaseUrl);
if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
  throw new Error("DATABASE_URL must be a PostgreSQL URL");
}

const root = resolve(import.meta.dirname, "..");
const migrationId = "0000_sutra_baseline";
const migrationSql = await readFile(
  resolve(root, "postgres/migrations/0000_sutra_baseline.sql"),
  "utf8",
);
const statements = migrationSql
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);
const migrationSha256 = createHash("sha256").update(migrationSql, "utf8").digest("hex");
const runtimeRole = process.env.SUTRA_POSTGRES_RUNTIME_ROLE?.trim();
if (runtimeRole !== undefined && !/^[a-z][a-z0-9_]{0,62}$/u.test(runtimeRole)) {
  throw new Error("SUTRA_POSTGRES_RUNTIME_ROLE is invalid");
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  application_name: "sutra-local-migrator",
  max: 1,
  connectionTimeoutMillis: 10_000,
});
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('sutra:postgres:migrations'))");
  await client.query(
    `CREATE TABLE IF NOT EXISTS sutra_runtime_migrations (
      migration_id text PRIMARY KEY NOT NULL,
      migration_sha256 text NOT NULL,
      applied_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
    )`,
  );
  await client.query("ALTER TABLE sutra_runtime_migrations ADD COLUMN IF NOT EXISTS migration_sha256 text");
  const applied = await client.query(
    "SELECT migration_id, migration_sha256 FROM sutra_runtime_migrations WHERE migration_id = $1 LIMIT 1",
    [migrationId],
  );
  if (applied.rowCount === 0) {
    for (const statement of statements) await client.query(statement);
    await client.query(
      "INSERT INTO sutra_runtime_migrations (migration_id, migration_sha256) VALUES ($1, $2) ON CONFLICT (migration_id) DO NOTHING",
      [migrationId, migrationSha256],
    );
  } else if (applied.rows[0].migration_sha256 === null) {
    throw new Error(
      `Applied PostgreSQL migration ${migrationId} has no checksum; restore a verified backup or reset the unshipped local database`,
    );
  } else if (applied.rows[0].migration_sha256 !== migrationSha256) {
    throw new Error(`Applied PostgreSQL migration ${migrationId} no longer matches its immutable checksum`);
  }
  if (runtimeRole !== undefined) {
    await client.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtimeRole}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtimeRole}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtimeRole}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${runtimeRole}`);
  }
  await client.query("COMMIT");
  process.stdout.write(applied.rowCount === 0
    ? "Applied Sutra PostgreSQL baseline.\n"
    : "Sutra PostgreSQL schema is current.\n");
} catch (error) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the migration failure.
  }
  throw error;
} finally {
  client.release();
  await pool.end();
}
