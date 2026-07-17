import postgresBaselineSql from "../postgres/migrations/0000_sutra_baseline.sql?raw";
import postgresFinopsSql from "../postgres/migrations/0001_finops_cost_snapshots.sql?raw";
import postgresCaseManagementSql from "../postgres/migrations/0002_case_management.sql?raw";
import postgresSecurityEventsSql from "../postgres/migrations/0003_security_events.sql?raw";
import postgresComplianceExceptionsSql from "../postgres/migrations/0004_compliance_exceptions.sql?raw";
import postgresHostedIdentityLifecycleSql from "../postgres/migrations/0005_hosted_identity_lifecycle.sql?raw";
import postgresKubernetesPersistenceSql from "../postgres/migrations/0006_kubernetes_persistence.sql?raw";
import postgresKubernetesScannerEvidenceSql from "../postgres/migrations/0007_kubernetes_scanner_evidence.sql?raw";
import postgresFalcoRuntimeEventsSql from "../postgres/migrations/0008_falco_runtime_events.sql?raw";
import postgresKubernetesAgentControlSql from "../postgres/migrations/0009_kubernetes_agent_control.sql?raw";
import postgresKubernetesSupplyChainSql from "../postgres/migrations/0010_kubernetes_supply_chain.sql?raw";
import postgresNotificationDestinationsOutboxSql from "../postgres/migrations/0011_notification_destinations_outbox.sql?raw";
import postgresHubbleNetworkVisibilitySql from "../postgres/migrations/0012_hubble_network_visibility.sql?raw";
import postgresRuntimeEventCasesSql from "../postgres/migrations/0013_runtime_event_cases.sql?raw";

const migrations = [
  { id: "0000_sutra_baseline", source: postgresBaselineSql },
  { id: "0001_finops_cost_snapshots", source: postgresFinopsSql },
  { id: "0002_case_management", source: postgresCaseManagementSql },
  { id: "0003_security_events", source: postgresSecurityEventsSql },
  { id: "0004_compliance_exceptions", source: postgresComplianceExceptionsSql },
  { id: "0005_hosted_identity_lifecycle", source: postgresHostedIdentityLifecycleSql },
  { id: "0006_kubernetes_persistence", source: postgresKubernetesPersistenceSql },
  { id: "0007_kubernetes_scanner_evidence", source: postgresKubernetesScannerEvidenceSql },
  { id: "0008_falco_runtime_events", source: postgresFalcoRuntimeEventsSql },
  { id: "0009_kubernetes_agent_control", source: postgresKubernetesAgentControlSql },
  { id: "0010_kubernetes_supply_chain", source: postgresKubernetesSupplyChainSql },
  { id: "0011_notification_destinations_outbox", source: postgresNotificationDestinationsOutboxSql },
  { id: "0012_hubble_network_visibility", source: postgresHubbleNetworkVisibilitySql },
  { id: "0013_runtime_event_cases", source: postgresRuntimeEventCasesSql },
] as const;

let schemaReady: Promise<void> | undefined;

async function migrationSha256(source: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function ensurePostgresRuntimeSchema(db: D1Database): Promise<void> {
  if (schemaReady !== undefined) return schemaReady;
  const attempt = (async () => {
    for (const migration of migrations) {
      const applied = await db.prepare(
        `SELECT migration_id, migration_sha256 FROM sutra_runtime_migrations WHERE migration_id = ? LIMIT 1`,
      ).bind(migration.id).first<{ migration_id: string; migration_sha256: string | null }>();
      if (applied === null) throw new Error("PostgreSQL is not migrated; run pnpm db:postgres:migrate with the owner role");
      if (applied.migration_sha256 !== await migrationSha256(migration.source)) {
        throw new Error(`Applied PostgreSQL migration ${migration.id} failed its immutable checksum`);
      }
    }
  })();
  schemaReady = attempt;
  void attempt.catch(() => {
    if (schemaReady === attempt) schemaReady = undefined;
  });
  return attempt;
}

export function resetPostgresRuntimeSchemaCacheForTests(): void {
  schemaReady = undefined;
}
