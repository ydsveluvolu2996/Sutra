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
  "0025_background_jobs.sql",
  "0026_finding_exceptions.sql",
  "0027_registry_vulnerabilities.sql",
  "0028_kubernetes_agent_nodes.sql",
  "0029_customer_scoped_invitations.sql",
  "0030_contact_submissions.sql",
  "0031_finops_unit_counts.sql",
  "0032_finops_scheduled_reports.sql",
  "0033_kubernetes_node_side_array.sql",
  "0034_saved_reports.sql",
  "0035_alert_rules.sql",
  "0036_cmdb_relationships.sql",
  "0037_cmdb_custom_assets.sql",
  "0038_uptime_samples.sql",
  "0041_hosted_broker_replay_nonces.sql",
  "0042_hosted_signup_rate_limits.sql",
  "0043_customer_managed_aws_roles.sql",
  "0044_invitation_delivery.sql",
  "0045_invitation_operation_ledger.sql",
  "0046_background_jobs_connection_scope.sql",
  "0047_contact_rate_limits.sql",
  "0048_password_reset.sql",
  "0049_background_jobs_kind_index.sql",
  "0050_finops_cur_region.sql",
  "0051_finops_cur_commitments.sql",
  "0052_finops_allocation_rules.sql",
  "0053_finops_customer_margin.sql",
  "0054_finops_budgets_customer_scope.sql",
  "0055_finops_resource_schedules.sql",
  "0056_finops_cur_usage_type.sql",
  "0057_finops_external_costs.sql",
  "0058_governance_policies.sql",
  "0059_agentless_scans.sql",
  "0060_invitation_zoho_provider.sql",
  "0061_aws_live_snapshot_origin.sql",
  "0062_saml_assertion_replays.sql",
  "0063_dspm_workspace.sql",
  "0064_scim_identity_lifecycle.sql",
  "0065_hosted_broker_runtime.sql",
  "0066_itsm_managed_secrets.sql",
  "0067_audit_hash_version.sql",
  "0068_aws_global_ownership.sql",
  "0069_cmdb_resource_retirement.sql",
  "0070_managed_evidence_objects.sql",
  "0071_itsm_delivery_evidence.sql",
  "0072_ses_delivery_feedback.sql",
  "0073_finops_billing_engine_v2.sql",
  "0074_finops_foundational_config.sql",
  "0075_finops_source_job_ledger.sql",
  "0076_finops_source_snapshots.sql",
  "0077_finops_source_evidence_artifact.sql",
  "0078_finops_data_export_observations.sql",
  "0079_finops_trusted_advisor_organization.sql",
  "0080_finops_compute_optimizer_discovery.sql",
  "0081_finops_active_file_count.sql",
  "0082_finops_aws_config_compliance.sql",
  "0083_finops_pricing_change_materializations.sql",
  "0084_finops_cora_snapshots.sql",
  "0085_finops_aws_news_feed_snapshots.sql",
  "0086_finops_aws_budgets_organization.sql",
  "0087_finops_aws_support_cases.sql",
  "0088_finops_resilience_vue.sql",
  "0089_finops_end_user_computing.sql",
  "0090_finops_media_services_insights.sql",
  "0091_finops_marketplace_spg.sql",
  "0092_finops_kubecost_allocation.sql",
  "0093_finops_scad_allocation.sql",
  "0094_finops_sustainability_carbon.sql",
  "0095_finops_amazon_connect_cost_insights.sql",
  "0096_finops_compute_optimizer_export_history.sql",
  "0097_finops_extended_support_projection.sql",
  "0098_finops_graviton_savings.sql",
  "0099_finops_aws_health_events.sql",
  "0100_finops_azure_cid.sql",
  "0101_finops_gcp_cloud_intelligence.sql",
  "0102_finops_dcf_execution_history.sql",
  "0103_finops_cora_export_objects.sql",
  "0104_finops_aws_budgets_durable_attempts.sql",
  "0105_finops_euc_runtime_attempts.sql",
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
