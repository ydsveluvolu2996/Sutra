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
import postgresKubernetesSbomLicensePolicySql from "../postgres/migrations/0014_kubernetes_sbom_license_policy.sql?raw";
import postgresVulnerabilityFeedMirrorSql from "../postgres/migrations/0015_vulnerability_feed_mirror.sql?raw";
import postgresVulnerabilityWaiversSql from "../postgres/migrations/0016_vulnerability_waivers.sql?raw";
import postgresCloudVulnerabilityFindingsSql from "../postgres/migrations/0017_cloud_vulnerability_findings.sql?raw";
import postgresCaseRoutingRulesSql from "../postgres/migrations/0018_case_routing_rules.sql?raw";
import postgresLatencySamplesSql from "../postgres/migrations/0019_latency_samples.sql?raw";
import postgresCmdbWorkspaceSql from "../postgres/migrations/0020_cmdb_workspace.sql?raw";
import postgresComplianceWorkspaceSql from "../postgres/migrations/0021_compliance_workspace.sql?raw";
import postgresFinopsWorkspaceSql from "../postgres/migrations/0022_finops_workspace.sql?raw";
import postgresPublicApiSql from "../postgres/migrations/0023_public_api.sql?raw";
import postgresItsmConnectorsSql from "../postgres/migrations/0024_itsm_connectors.sql?raw";
import postgresBackgroundJobsSql from "../postgres/migrations/0025_background_jobs.sql?raw";
import postgresFindingExceptionsSql from "../postgres/migrations/0026_finding_exceptions.sql?raw";
import postgresRegistryVulnerabilitiesSql from "../postgres/migrations/0027_registry_vulnerabilities.sql?raw";
import postgresKubernetesAgentNodesSql from "../postgres/migrations/0028_kubernetes_agent_nodes.sql?raw";
import postgresCustomerScopedInvitationsSql from "../postgres/migrations/0029_customer_scoped_invitations.sql?raw";
import postgresContactSubmissionsSql from "../postgres/migrations/0030_contact_submissions.sql?raw";
import postgresFinopsUnitCountsSql from "../postgres/migrations/0031_finops_unit_counts.sql?raw";
import postgresFinopsScheduledReportsSql from "../postgres/migrations/0032_finops_scheduled_reports.sql?raw";
import postgresKubernetesNodeSideArraySql from "../postgres/migrations/0033_kubernetes_node_side_array.sql?raw";
import postgresSavedReportsSql from "../postgres/migrations/0034_saved_reports.sql?raw";
import postgresAlertRulesSql from "../postgres/migrations/0035_alert_rules.sql?raw";
import postgresCmdbRelationshipsSql from "../postgres/migrations/0036_cmdb_relationships.sql?raw";
import postgresCmdbCustomAssetsSql from "../postgres/migrations/0037_cmdb_custom_assets.sql?raw";
import postgresUptimeSamplesSql from "../postgres/migrations/0038_uptime_samples.sql?raw";
import postgresHostedBrokerReplayNoncesSql from "../postgres/migrations/0041_hosted_broker_replay_nonces.sql?raw";
import postgresHostedSignupRateLimitsSql from "../postgres/migrations/0042_hosted_signup_rate_limits.sql?raw";
import postgresCustomerManagedAwsRolesSql from "../postgres/migrations/0043_customer_managed_aws_roles.sql?raw";
import postgresInvitationDeliverySql from "../postgres/migrations/0044_invitation_delivery.sql?raw";
import postgresInvitationOperationLedgerSql from "../postgres/migrations/0045_invitation_operation_ledger.sql?raw";
import postgresBackgroundJobsConnectionScopeSql from "../postgres/migrations/0046_background_jobs_connection_scope.sql?raw";
import postgresContactRateLimitsSql from "../postgres/migrations/0047_contact_rate_limits.sql?raw";
import postgresPasswordResetSql from "../postgres/migrations/0048_password_reset.sql?raw";

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
  { id: "0014_kubernetes_sbom_license_policy", source: postgresKubernetesSbomLicensePolicySql },
  { id: "0015_vulnerability_feed_mirror", source: postgresVulnerabilityFeedMirrorSql },
  { id: "0016_vulnerability_waivers", source: postgresVulnerabilityWaiversSql },
  { id: "0017_cloud_vulnerability_findings", source: postgresCloudVulnerabilityFindingsSql },
  { id: "0018_case_routing_rules", source: postgresCaseRoutingRulesSql },
  { id: "0019_latency_samples", source: postgresLatencySamplesSql },
  { id: "0020_cmdb_workspace", source: postgresCmdbWorkspaceSql },
  { id: "0021_compliance_workspace", source: postgresComplianceWorkspaceSql },
  { id: "0022_finops_workspace", source: postgresFinopsWorkspaceSql },
  { id: "0023_public_api", source: postgresPublicApiSql },
  { id: "0024_itsm_connectors", source: postgresItsmConnectorsSql },
  { id: "0025_background_jobs", source: postgresBackgroundJobsSql },
  { id: "0026_finding_exceptions", source: postgresFindingExceptionsSql },
  { id: "0027_registry_vulnerabilities", source: postgresRegistryVulnerabilitiesSql },
  { id: "0028_kubernetes_agent_nodes", source: postgresKubernetesAgentNodesSql },
  { id: "0029_customer_scoped_invitations", source: postgresCustomerScopedInvitationsSql },
  { id: "0030_contact_submissions", source: postgresContactSubmissionsSql },
  { id: "0031_finops_unit_counts", source: postgresFinopsUnitCountsSql },
  { id: "0032_finops_scheduled_reports", source: postgresFinopsScheduledReportsSql },
  { id: "0033_kubernetes_node_side_array", source: postgresKubernetesNodeSideArraySql },
  { id: "0034_saved_reports", source: postgresSavedReportsSql },
  { id: "0035_alert_rules", source: postgresAlertRulesSql },
  { id: "0036_cmdb_relationships", source: postgresCmdbRelationshipsSql },
  { id: "0037_cmdb_custom_assets", source: postgresCmdbCustomAssetsSql },
  { id: "0038_uptime_samples", source: postgresUptimeSamplesSql },
  { id: "0041_hosted_broker_replay_nonces", source: postgresHostedBrokerReplayNoncesSql },
  { id: "0042_hosted_signup_rate_limits", source: postgresHostedSignupRateLimitsSql },
  { id: "0043_customer_managed_aws_roles", source: postgresCustomerManagedAwsRolesSql },
  { id: "0044_invitation_delivery", source: postgresInvitationDeliverySql },
  { id: "0045_invitation_operation_ledger", source: postgresInvitationOperationLedgerSql },
  { id: "0046_background_jobs_connection_scope", source: postgresBackgroundJobsConnectionScopeSql },
  { id: "0047_contact_rate_limits", source: postgresContactRateLimitsSql },
  { id: "0048_password_reset", source: postgresPasswordResetSql },
] as const;

let schemaReady: Promise<void> | undefined;

async function migrationSha256(source: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function ensurePostgresRuntimeSchema(db: D1Database): Promise<void> {
  if (schemaReady !== undefined) return schemaReady;
  const attempt = (async () => {
    // Verify every applied migration in a SINGLE round-trip rather than one
    // SELECT per migration. On a cold workerd isolate this ran ~48 sequential
    // queries (each its own connection) before any real work; batching it into
    // one IN(...) query removes that per-cold-request stall.
    const placeholders = migrations.map(() => "?").join(", ");
    const appliedRows = await db.prepare(
      `SELECT migration_id, migration_sha256 FROM sutra_runtime_migrations WHERE migration_id IN (${placeholders})`,
    ).bind(...migrations.map((migration) => migration.id)).all<{ migration_id: string; migration_sha256: string | null }>();
    const appliedById = new Map<string, string | null>(
      (appliedRows.results ?? []).map((row) => [row.migration_id, row.migration_sha256]),
    );
    // Checksum verification is pure CPU; compute the expected digests in parallel.
    await Promise.all(migrations.map(async (migration) => {
      if (!appliedById.has(migration.id)) {
        throw new Error("PostgreSQL is not migrated; run pnpm db:postgres:migrate with the owner role");
      }
      if (appliedById.get(migration.id) !== await migrationSha256(migration.source)) {
        throw new Error(`Applied PostgreSQL migration ${migration.id} failed its immutable checksum`);
      }
    }));
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
