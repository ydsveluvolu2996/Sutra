import baseSchemaSql from "../drizzle/0000_wild_lenny_balinger.sql?raw";
import pilotSchemaSql from "../drizzle/0001_good_sunspot.sql?raw";
import localAuthSchemaSql from "../drizzle/0002_aspiring_terrax.sql?raw";
import changeHistorySchemaSql from "../drizzle/0003_opposite_siren.sql?raw";
import localOperationsSchemaSql from "../drizzle/0004_ambiguous_landau.sql?raw";
import activeRunSchemaSql from "../drizzle/0005_tiny_hobgoblin.sql?raw";
import scheduleOutboxSchemaSql from "../drizzle/0006_acoustic_thunderbolt.sql?raw";
import scheduleSequenceSchemaSql from "../drizzle/0007_demonic_hardball.sql?raw";
import scheduleProvenanceSchemaSql from "../drizzle/0008_far_nicolaos.sql?raw";
import costSnapshotsSchemaSql from "../drizzle/0009_acoustic_moondragon.sql?raw";
import operationsWaveSchemaSql from "../drizzle/0010_sutra_operations_wave.sql?raw";
import hostedIdentityLifecycleSchemaSql from "../drizzle/0011_blushing_logan.sql?raw";
import kubernetesPersistenceSchemaSql from "../drizzle/0012_nasty_satana.sql?raw";
import kubernetesScannerEvidenceSchemaSql from "../drizzle/0013_gorgeous_mercury.sql?raw";
import falcoRuntimeEventsSchemaSql from "../drizzle/0014_falco_runtime_events.sql?raw";
import kubernetesAgentControlSchemaSql from "../drizzle/0015_kubernetes_agent_control.sql?raw";
import kubernetesSupplyChainSchemaSql from "../drizzle/0016_kubernetes_supply_chain.sql?raw";
import notificationDestinationsOutboxSchemaSql from "../drizzle/0017_notification_destinations_outbox.sql?raw";
import hubbleNetworkVisibilitySchemaSql from "../drizzle/0018_hubble_network_visibility.sql?raw";
import runtimeEventCasesSchemaSql from "../drizzle/0019_runtime_event_cases.sql?raw";
import kubernetesSbomLicensePolicySchemaSql from "../drizzle/0020_kubernetes_sbom_license_policy.sql?raw";
import vulnerabilityFeedMirrorSchemaSql from "../drizzle/0021_vulnerability_feed_mirror.sql?raw";
import vulnerabilityWaiversSchemaSql from "../drizzle/0022_vulnerability_waivers.sql?raw";
import cloudVulnerabilityFindingsSchemaSql from "../drizzle/0023_cloud_vulnerability_findings.sql?raw";
import caseRoutingRulesSchemaSql from "../drizzle/0024_case_routing_rules.sql?raw";
import latencySamplesSchemaSql from "../drizzle/0025_latency_samples.sql?raw";
import cmdbWorkspaceSchemaSql from "../drizzle/0026_cmdb_workspace.sql?raw";
import complianceWorkspaceSchemaSql from "../drizzle/0027_compliance_workspace.sql?raw";
import finopsWorkspaceSchemaSql from "../drizzle/0028_finops_workspace.sql?raw";
import publicApiSchemaSql from "../drizzle/0029_public_api.sql?raw";
import itsmConnectorsSchemaSql from "../drizzle/0030_itsm_connectors.sql?raw";
import backgroundJobsSchemaSql from "../drizzle/0031_background_jobs.sql?raw";
import findingExceptionsSchemaSql from "../drizzle/0032_finding_exceptions.sql?raw";
import registryVulnerabilitiesSchemaSql from "../drizzle/0033_registry_vulnerabilities.sql?raw";
import kubernetesAgentNodesSchemaSql from "../drizzle/0034_kubernetes_agent_nodes.sql?raw";
import customerScopedInvitationsSchemaSql from "../drizzle/0035_customer_scoped_invitations.sql?raw";
import contactSubmissionsSchemaSql from "../drizzle/0036_contact_submissions.sql?raw";
import finopsUnitCountsSchemaSql from "../drizzle/0037_finops_unit_counts.sql?raw";
import finopsScheduledReportsSchemaSql from "../drizzle/0038_finops_scheduled_reports.sql?raw";
import kubernetesNodeSideArraySchemaSql from "../drizzle/0039_kubernetes_node_side_array.sql?raw";
import savedReportsSchemaSql from "../drizzle/0040_saved_reports.sql?raw";
import alertRulesSchemaSql from "../drizzle/0041_alert_rules.sql?raw";
import cmdbRelationshipsSchemaSql from "../drizzle/0042_cmdb_relationships.sql?raw";
import cmdbCustomAssetsSchemaSql from "../drizzle/0043_cmdb_custom_assets.sql?raw";
import uptimeSamplesSchemaSql from "../drizzle/0044_uptime_samples.sql?raw";
import hostedBrokerReplayNoncesSchemaSql from "../drizzle/0047_hosted_broker_replay_nonces.sql?raw";
import hostedSignupRateLimitsSchemaSql from "../drizzle/0048_hosted_signup_rate_limits.sql?raw";
import customerManagedAwsRolesSchemaSql from "../drizzle/0049_customer_managed_aws_roles.sql?raw";
import invitationDeliverySchemaSql from "../drizzle/0050_invitation_delivery.sql?raw";
import invitationOperationLedgerSchemaSql from "../drizzle/0051_invitation_operation_ledger.sql?raw";
import backgroundJobsConnectionScopeSql from "../drizzle/0052_background_jobs_connection_scope.sql?raw";
import contactRateLimitsSchemaSql from "../drizzle/0053_contact_rate_limits.sql?raw";
import passwordResetSchemaSql from "../drizzle/0054_password_reset.sql?raw";
import backgroundJobsKindIndexSchemaSql from "../drizzle/0055_background_jobs_kind_index.sql?raw";
import finopsCurRegionSchemaSql from "../drizzle/0056_finops_cur_region.sql?raw";
import finopsCurCommitmentsSchemaSql from "../drizzle/0057_finops_cur_commitments.sql?raw";
import finopsAllocationRulesSchemaSql from "../drizzle/0058_finops_allocation_rules.sql?raw";
import finopsCustomerMarginSchemaSql from "../drizzle/0059_finops_customer_margin.sql?raw";
import finopsBudgetsCustomerScopeSchemaSql from "../drizzle/0060_finops_budgets_customer_scope.sql?raw";
import finopsResourceSchedulesSchemaSql from "../drizzle/0061_finops_resource_schedules.sql?raw";
import finopsCurUsageTypeSchemaSql from "../drizzle/0062_finops_cur_usage_type.sql?raw";
import finopsExternalCostsSchemaSql from "../drizzle/0063_finops_external_costs.sql?raw";
import governancePoliciesSchemaSql from "../drizzle/0064_governance_policies.sql?raw";
import agentlessScansSchemaSql from "../drizzle/0065_agentless_scans.sql?raw";
import invitationZohoProviderSchemaSql from "../drizzle/0066_invitation_zoho_provider.sql?raw";
import awsLiveSnapshotOriginSchemaSql from "../drizzle/0067_aws_live_snapshot_origin.sql?raw";
import samlAssertionReplaysSchemaSql from "../drizzle/0068_saml_assertion_replays.sql?raw";
import dspmWorkspaceSchemaSql from "../drizzle/0069_dspm_workspace.sql?raw";
import scimIdentityLifecycleSchemaSql from "../drizzle/0070_scim_identity_lifecycle.sql?raw";
import itsmManagedSecretsSchemaSql from "../drizzle/0071_itsm_managed_secrets.sql?raw";
import auditHashVersionSchemaSql from "../drizzle/0072_audit_hash_version.sql?raw";
import awsGlobalOwnershipSchemaSql from "../drizzle/0073_aws_global_ownership.sql?raw";
import cmdbResourceRetirementSchemaSql from "../drizzle/0074_cmdb_resource_retirement.sql?raw";
import managedEvidenceObjectsSchemaSql from "../drizzle/0075_managed_evidence_objects.sql?raw";
import itsmDeliveryEvidenceSchemaSql from "../drizzle/0076_itsm_delivery_evidence.sql?raw";
import sesDeliveryFeedbackSchemaSql from "../drizzle/0077_ses_delivery_feedback.sql?raw";
import finopsBillingEngineV2SchemaSql from "../drizzle/0078_finops_billing_engine_v2.sql?raw";
import finopsFoundationalConfigSchemaSql from "../drizzle/0079_finops_foundational_config.sql?raw";
import finopsSourceJobLedgerSchemaSql from "../drizzle/0080_finops_source_job_ledger.sql?raw";
import finopsSourceSnapshotsSchemaSql from "../drizzle/0081_finops_source_snapshots.sql?raw";
import finopsSourceEvidenceArtifactSchemaSql from "../drizzle/0082_finops_source_evidence_artifact.sql?raw";
import finopsDataExportObservationsSchemaSql from "../drizzle/0083_finops_data_export_observations.sql?raw";
import { isPostgresDatabase } from "./postgres-d1-adapter";
import { ensurePostgresRuntimeSchema, resetPostgresRuntimeSchemaCacheForTests } from "./postgres-runtime-migrations";

const BREAKPOINT = "--> statement-breakpoint";

let schemaReady: Promise<void> | undefined;

function statementsFrom(sql: string): string[] {
  return sql
    .split(BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

const migrations = [
  { id: "0000_wild_lenny_balinger", statements: statementsFrom(baseSchemaSql) },
  { id: "0001_good_sunspot", statements: statementsFrom(pilotSchemaSql) },
  { id: "0002_aspiring_terrax", statements: statementsFrom(localAuthSchemaSql) },
  { id: "0003_opposite_siren", statements: statementsFrom(changeHistorySchemaSql) },
  { id: "0004_ambiguous_landau", statements: statementsFrom(localOperationsSchemaSql) },
  { id: "0005_tiny_hobgoblin", statements: statementsFrom(activeRunSchemaSql) },
  { id: "0006_acoustic_thunderbolt", statements: statementsFrom(scheduleOutboxSchemaSql) },
  { id: "0007_demonic_hardball", statements: statementsFrom(scheduleSequenceSchemaSql) },
  { id: "0008_far_nicolaos", statements: statementsFrom(scheduleProvenanceSchemaSql) },
  { id: "0009_acoustic_moondragon", statements: statementsFrom(costSnapshotsSchemaSql) },
  { id: "0010_sutra_operations_wave", statements: statementsFrom(operationsWaveSchemaSql) },
  { id: "0011_blushing_logan", statements: statementsFrom(hostedIdentityLifecycleSchemaSql) },
  { id: "0012_nasty_satana", statements: statementsFrom(kubernetesPersistenceSchemaSql) },
  { id: "0013_gorgeous_mercury", statements: statementsFrom(kubernetesScannerEvidenceSchemaSql) },
  { id: "0014_falco_runtime_events", statements: statementsFrom(falcoRuntimeEventsSchemaSql) },
  { id: "0015_kubernetes_agent_control", statements: statementsFrom(kubernetesAgentControlSchemaSql) },
  { id: "0016_kubernetes_supply_chain", statements: statementsFrom(kubernetesSupplyChainSchemaSql) },
  { id: "0017_notification_destinations_outbox", statements: statementsFrom(notificationDestinationsOutboxSchemaSql) },
  { id: "0018_hubble_network_visibility", statements: statementsFrom(hubbleNetworkVisibilitySchemaSql) },
  { id: "0019_runtime_event_cases", statements: statementsFrom(runtimeEventCasesSchemaSql) },
  { id: "0020_kubernetes_sbom_license_policy", statements: statementsFrom(kubernetesSbomLicensePolicySchemaSql) },
  { id: "0021_vulnerability_feed_mirror", statements: statementsFrom(vulnerabilityFeedMirrorSchemaSql) },
  { id: "0022_vulnerability_waivers", statements: statementsFrom(vulnerabilityWaiversSchemaSql) },
  { id: "0023_cloud_vulnerability_findings", statements: statementsFrom(cloudVulnerabilityFindingsSchemaSql) },
  { id: "0024_case_routing_rules", statements: statementsFrom(caseRoutingRulesSchemaSql) },
  { id: "0025_latency_samples", statements: statementsFrom(latencySamplesSchemaSql) },
  { id: "0026_cmdb_workspace", statements: statementsFrom(cmdbWorkspaceSchemaSql) },
  { id: "0027_compliance_workspace", statements: statementsFrom(complianceWorkspaceSchemaSql) },
  { id: "0028_finops_workspace", statements: statementsFrom(finopsWorkspaceSchemaSql) },
  { id: "0029_public_api", statements: statementsFrom(publicApiSchemaSql) },
  { id: "0030_itsm_connectors", statements: statementsFrom(itsmConnectorsSchemaSql) },
  { id: "0031_background_jobs", statements: statementsFrom(backgroundJobsSchemaSql) },
  { id: "0032_finding_exceptions", statements: statementsFrom(findingExceptionsSchemaSql) },
  { id: "0033_registry_vulnerabilities", statements: statementsFrom(registryVulnerabilitiesSchemaSql) },
  { id: "0034_kubernetes_agent_nodes", statements: statementsFrom(kubernetesAgentNodesSchemaSql) },
  { id: "0035_customer_scoped_invitations", statements: statementsFrom(customerScopedInvitationsSchemaSql) },
  { id: "0036_contact_submissions", statements: statementsFrom(contactSubmissionsSchemaSql) },
  { id: "0037_finops_unit_counts", statements: statementsFrom(finopsUnitCountsSchemaSql) },
  { id: "0038_finops_scheduled_reports", statements: statementsFrom(finopsScheduledReportsSchemaSql) },
  { id: "0039_kubernetes_node_side_array", statements: statementsFrom(kubernetesNodeSideArraySchemaSql) },
  { id: "0040_saved_reports", statements: statementsFrom(savedReportsSchemaSql) },
  { id: "0041_alert_rules", statements: statementsFrom(alertRulesSchemaSql) },
  { id: "0042_cmdb_relationships", statements: statementsFrom(cmdbRelationshipsSchemaSql) },
  { id: "0043_cmdb_custom_assets", statements: statementsFrom(cmdbCustomAssetsSchemaSql) },
  { id: "0044_uptime_samples", statements: statementsFrom(uptimeSamplesSchemaSql) },
  { id: "0047_hosted_broker_replay_nonces", statements: statementsFrom(hostedBrokerReplayNoncesSchemaSql) },
  { id: "0048_hosted_signup_rate_limits", statements: statementsFrom(hostedSignupRateLimitsSchemaSql) },
  { id: "0049_customer_managed_aws_roles", statements: statementsFrom(customerManagedAwsRolesSchemaSql) },
  { id: "0050_invitation_delivery", statements: statementsFrom(invitationDeliverySchemaSql) },
  { id: "0051_invitation_operation_ledger", statements: statementsFrom(invitationOperationLedgerSchemaSql) },
  { id: "0052_background_jobs_connection_scope", statements: statementsFrom(backgroundJobsConnectionScopeSql) },
  { id: "0053_contact_rate_limits", statements: statementsFrom(contactRateLimitsSchemaSql) },
  { id: "0054_password_reset", statements: statementsFrom(passwordResetSchemaSql) },
  { id: "0055_background_jobs_kind_index", statements: statementsFrom(backgroundJobsKindIndexSchemaSql) },
  { id: "0056_finops_cur_region", statements: statementsFrom(finopsCurRegionSchemaSql) },
  { id: "0057_finops_cur_commitments", statements: statementsFrom(finopsCurCommitmentsSchemaSql) },
  { id: "0058_finops_allocation_rules", statements: statementsFrom(finopsAllocationRulesSchemaSql) },
  { id: "0059_finops_customer_margin", statements: statementsFrom(finopsCustomerMarginSchemaSql) },
  { id: "0060_finops_budgets_customer_scope", statements: statementsFrom(finopsBudgetsCustomerScopeSchemaSql) },
  { id: "0061_finops_resource_schedules", statements: statementsFrom(finopsResourceSchedulesSchemaSql) },
  { id: "0062_finops_cur_usage_type", statements: statementsFrom(finopsCurUsageTypeSchemaSql) },
  { id: "0063_finops_external_costs", statements: statementsFrom(finopsExternalCostsSchemaSql) },
  { id: "0064_governance_policies", statements: statementsFrom(governancePoliciesSchemaSql) },
  { id: "0065_agentless_scans", statements: statementsFrom(agentlessScansSchemaSql) },
  { id: "0066_invitation_zoho_provider", statements: statementsFrom(invitationZohoProviderSchemaSql) },
  { id: "0067_aws_live_snapshot_origin", statements: statementsFrom(awsLiveSnapshotOriginSchemaSql) },
  { id: "0068_saml_assertion_replays", statements: statementsFrom(samlAssertionReplaysSchemaSql) },
  { id: "0069_dspm_workspace", statements: statementsFrom(dspmWorkspaceSchemaSql) },
  { id: "0070_scim_identity_lifecycle", statements: statementsFrom(scimIdentityLifecycleSchemaSql) },
  { id: "0071_itsm_managed_secrets", statements: statementsFrom(itsmManagedSecretsSchemaSql) },
  { id: "0072_audit_hash_version", statements: statementsFrom(auditHashVersionSchemaSql) },
  { id: "0073_aws_global_ownership", statements: statementsFrom(awsGlobalOwnershipSchemaSql) },
  { id: "0074_cmdb_resource_retirement", statements: statementsFrom(cmdbResourceRetirementSchemaSql) },
  { id: "0075_managed_evidence_objects", statements: statementsFrom(managedEvidenceObjectsSchemaSql) },
  { id: "0076_itsm_delivery_evidence", statements: statementsFrom(itsmDeliveryEvidenceSchemaSql) },
  { id: "0077_ses_delivery_feedback", statements: statementsFrom(sesDeliveryFeedbackSchemaSql) },
  { id: "0078_finops_billing_engine_v2", statements: statementsFrom(finopsBillingEngineV2SchemaSql) },
  { id: "0079_finops_foundational_config", statements: statementsFrom(finopsFoundationalConfigSchemaSql) },
  { id: "0080_finops_source_job_ledger", statements: statementsFrom(finopsSourceJobLedgerSchemaSql) },
  { id: "0081_finops_source_snapshots", statements: statementsFrom(finopsSourceSnapshotsSchemaSql) },
  { id: "0082_finops_source_evidence_artifact", statements: statementsFrom(finopsSourceEvidenceArtifactSchemaSql) },
  { id: "0083_finops_data_export_observations", statements: statementsFrom(finopsDataExportObservationsSchemaSql) },
] as const;

const ADD_COLUMN = /^ALTER TABLE `([A-Za-z0-9_]+)` ADD `([A-Za-z0-9_]+)`\s/iu;
const CREATE_OBJECT = /^CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER)\s/iu;

async function columnExists(db: D1Database, table: string, column: string): Promise<boolean> {
  const result = await db.prepare(`PRAGMA table_info(\"${table}\")`).all<{ name: string }>();
  return (result.results ?? []).some((candidate) => candidate.name === column);
}

async function applyStatement(db: D1Database, statement: string): Promise<void> {
  const addColumn = ADD_COLUMN.exec(statement);
  if (addColumn !== null && await columnExists(db, addColumn[1], addColumn[2])) return;
  try {
    await db.prepare(statement).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (CREATE_OBJECT.test(statement) && /already exists/iu.test(message)) return;
    if (
      addColumn !== null &&
      /duplicate column name/iu.test(message) &&
      await columnExists(db, addColumn[1], addColumn[2])
    ) return;
    throw error;
  }
}

/**
 * The local pilot creates the checked-in schema lazily inside Miniflare D1.
 * Production deployments still use the same generated migrations as a
 * separately approved release step.
 */
export function ensureRuntimeSchema(db: D1Database): Promise<void> {
  if (isPostgresDatabase(db)) return ensurePostgresRuntimeSchema(db);
  if (schemaReady !== undefined) return schemaReady;
  const attempt = (async () => {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS sutra_runtime_migrations (
        migration_id text PRIMARY KEY NOT NULL,
        applied_at integer DEFAULT (unixepoch() * 1000) NOT NULL
      )`,
    ).run();
    for (const migration of migrations) {
      const applied = await db.prepare(
        `SELECT migration_id FROM sutra_runtime_migrations WHERE migration_id = ? LIMIT 1`,
      ).bind(migration.id).first<{ migration_id: string }>();
      if (applied !== null) continue;
      if (migration.id === "0082_finops_source_evidence_artifact") {
        // Rebuilding the checked evidence table also rebuilds its two FK child
        // tables. D1 batch is transactional, so a replica cannot be left with
        // immutability triggers removed or a half-copied evidence graph.
        await db.batch(migration.statements.map((statement) => db.prepare(statement)));
      } else {
        for (const statement of migration.statements) {
          await applyStatement(db, statement);
        }
      }
      await db.prepare(
        `INSERT OR IGNORE INTO sutra_runtime_migrations (migration_id) VALUES (?)`,
      ).bind(migration.id).run();
    }
  })();
  schemaReady = attempt;
  void attempt.catch(() => {
    if (schemaReady === attempt) schemaReady = undefined;
  });
  return attempt;
}

export function resetRuntimeSchemaCacheForTests(): void {
  schemaReady = undefined;
  resetPostgresRuntimeSchemaCacheForTests();
}
