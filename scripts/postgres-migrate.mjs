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
const migrationFiles = [
  "0000_sutra_baseline.sql",
  "0001_finops_cost_snapshots.sql",
  "0002_case_management.sql",
  "0003_security_events.sql",
  "0004_compliance_exceptions.sql",
  "0005_hosted_identity_lifecycle.sql",
  "0006_kubernetes_persistence.sql",
  "0007_kubernetes_scanner_evidence.sql",
  "0008_falco_runtime_events.sql",
  "0009_kubernetes_agent_control.sql",
  "0010_kubernetes_supply_chain.sql",
  "0011_notification_destinations_outbox.sql",
  "0012_hubble_network_visibility.sql",
  "0013_runtime_event_cases.sql",
  "0014_kubernetes_sbom_license_policy.sql",
  "0015_vulnerability_feed_mirror.sql",
  "0016_vulnerability_waivers.sql",
  "0017_cloud_vulnerability_findings.sql",
  "0018_case_routing_rules.sql",
  "0019_latency_samples.sql",
  "0020_cmdb_workspace.sql",
  "0021_compliance_workspace.sql",
  "0022_finops_workspace.sql",
  "0023_public_api.sql",
  "0024_itsm_connectors.sql",
];
const migrations = await Promise.all(migrationFiles.map(async (file) => {
  const source = await readFile(resolve(root, "postgres/migrations", file), "utf8");
  return {
    id: file.replace(/\.sql$/u, ""),
    source,
    statements: source
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0),
    sha256: createHash("sha256").update(source, "utf8").digest("hex"),
  };
}));
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
  let appliedCount = 0;
  for (const migration of migrations) {
    const applied = await client.query(
      "SELECT migration_id, migration_sha256 FROM sutra_runtime_migrations WHERE migration_id = $1 LIMIT 1",
      [migration.id],
    );
    if (applied.rowCount === 0) {
      for (const statement of migration.statements) await client.query(statement);
      await client.query(
        "INSERT INTO sutra_runtime_migrations (migration_id, migration_sha256) VALUES ($1, $2) ON CONFLICT (migration_id) DO NOTHING",
        [migration.id, migration.sha256],
      );
      appliedCount += 1;
    } else if (applied.rows[0].migration_sha256 === null) {
      throw new Error(
        `Applied PostgreSQL migration ${migration.id} has no checksum; restore a verified backup or reset the unshipped local database`,
      );
    } else if (applied.rows[0].migration_sha256 !== migration.sha256) {
      throw new Error(`Applied PostgreSQL migration ${migration.id} no longer matches its immutable checksum`);
    }
  }
  if (runtimeRole !== undefined) {
    await client.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtimeRole}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtimeRole}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtimeRole}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${runtimeRole}`);
  }
  await client.query("COMMIT");
  process.stdout.write(appliedCount > 0
    ? `Applied ${appliedCount} Sutra PostgreSQL migration${appliedCount === 1 ? "" : "s"}.\n`
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
