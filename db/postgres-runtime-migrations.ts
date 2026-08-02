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
import postgresBackgroundJobsKindIndexSql from "../postgres/migrations/0049_background_jobs_kind_index.sql?raw";
import postgresFinopsCurRegionSql from "../postgres/migrations/0050_finops_cur_region.sql?raw";
import postgresFinopsCurCommitmentsSql from "../postgres/migrations/0051_finops_cur_commitments.sql?raw";
import postgresFinopsAllocationRulesSql from "../postgres/migrations/0052_finops_allocation_rules.sql?raw";
import postgresFinopsCustomerMarginSql from "../postgres/migrations/0053_finops_customer_margin.sql?raw";
import postgresFinopsBudgetsCustomerScopeSql from "../postgres/migrations/0054_finops_budgets_customer_scope.sql?raw";
import postgresFinopsResourceSchedulesSql from "../postgres/migrations/0055_finops_resource_schedules.sql?raw";
import postgresFinopsCurUsageTypeSql from "../postgres/migrations/0056_finops_cur_usage_type.sql?raw";
import postgresFinopsExternalCostsSql from "../postgres/migrations/0057_finops_external_costs.sql?raw";
import postgresGovernancePoliciesSql from "../postgres/migrations/0058_governance_policies.sql?raw";
import postgresAgentlessScansSql from "../postgres/migrations/0059_agentless_scans.sql?raw";
import postgresInvitationZohoProviderSql from "../postgres/migrations/0060_invitation_zoho_provider.sql?raw";
import postgresAwsLiveSnapshotOriginSql from "../postgres/migrations/0061_aws_live_snapshot_origin.sql?raw";
import postgresSamlAssertionReplaysSql from "../postgres/migrations/0062_saml_assertion_replays.sql?raw";
import postgresDspmWorkspaceSql from "../postgres/migrations/0063_dspm_workspace.sql?raw";
import postgresScimIdentityLifecycleSql from "../postgres/migrations/0064_scim_identity_lifecycle.sql?raw";
import postgresHostedBrokerRuntimeSql from "../postgres/migrations/0065_hosted_broker_runtime.sql?raw";
import postgresItsmManagedSecretsSql from "../postgres/migrations/0066_itsm_managed_secrets.sql?raw";
import postgresAuditHashVersionSql from "../postgres/migrations/0067_audit_hash_version.sql?raw";
import postgresAwsGlobalOwnershipSql from "../postgres/migrations/0068_aws_global_ownership.sql?raw";
import postgresCmdbResourceRetirementSql from "../postgres/migrations/0069_cmdb_resource_retirement.sql?raw";
import postgresManagedEvidenceObjectsSql from "../postgres/migrations/0070_managed_evidence_objects.sql?raw";
import postgresItsmDeliveryEvidenceSql from "../postgres/migrations/0071_itsm_delivery_evidence.sql?raw";
import postgresSesDeliveryFeedbackSql from "../postgres/migrations/0072_ses_delivery_feedback.sql?raw";
import postgresFinopsBillingEngineV2Sql from "../postgres/migrations/0073_finops_billing_engine_v2.sql?raw";
import postgresFinopsFoundationalConfigSql from "../postgres/migrations/0074_finops_foundational_config.sql?raw";
import postgresFinopsSourceJobLedgerSql from "../postgres/migrations/0075_finops_source_job_ledger.sql?raw";
import postgresFinopsSourceSnapshotsSql from "../postgres/migrations/0076_finops_source_snapshots.sql?raw";
import postgresFinopsSourceEvidenceArtifactSql from "../postgres/migrations/0077_finops_source_evidence_artifact.sql?raw";
import postgresFinopsDataExportObservationsSql from "../postgres/migrations/0078_finops_data_export_observations.sql?raw";
import postgresFinopsTrustedAdvisorOrganizationSql from "../postgres/migrations/0079_finops_trusted_advisor_organization.sql?raw";
import postgresFinopsComputeOptimizerDiscoverySql from "../postgres/migrations/0080_finops_compute_optimizer_discovery.sql?raw";
import postgresFinopsActiveFileCountSql from "../postgres/migrations/0081_finops_active_file_count.sql?raw";
import postgresFinopsAwsConfigComplianceSql from "../postgres/migrations/0082_finops_aws_config_compliance.sql?raw";
import postgresFinopsPricingChangeMaterializationsSql from "../postgres/migrations/0083_finops_pricing_change_materializations.sql?raw";
import postgresFinopsCoraSnapshotsSql from "../postgres/migrations/0084_finops_cora_snapshots.sql?raw";
import postgresFinopsAwsNewsFeedSnapshotsSql from "../postgres/migrations/0085_finops_aws_news_feed_snapshots.sql?raw";
import postgresFinopsAwsBudgetsOrganizationSql from "../postgres/migrations/0086_finops_aws_budgets_organization.sql?raw";
import postgresFinopsAwsSupportCasesSql from "../postgres/migrations/0087_finops_aws_support_cases.sql?raw";
import postgresFinopsResilienceVueSql from "../postgres/migrations/0088_finops_resilience_vue.sql?raw";
import postgresFinopsEndUserComputingSql from "../postgres/migrations/0089_finops_end_user_computing.sql?raw";
import postgresFinopsMediaServicesInsightsSql from "../postgres/migrations/0090_finops_media_services_insights.sql?raw";
import postgresFinopsMarketplaceSpgSql from "../postgres/migrations/0091_finops_marketplace_spg.sql?raw";
import postgresFinopsKubecostAllocationSql from "../postgres/migrations/0092_finops_kubecost_allocation.sql?raw";
import postgresFinopsScadAllocationSql from "../postgres/migrations/0093_finops_scad_allocation.sql?raw";
import postgresFinopsSustainabilityCarbonSql from "../postgres/migrations/0094_finops_sustainability_carbon.sql?raw";
import postgresFinopsAmazonConnectCostInsightsSql from "../postgres/migrations/0095_finops_amazon_connect_cost_insights.sql?raw";
import postgresFinopsComputeOptimizerExportHistorySql from "../postgres/migrations/0096_finops_compute_optimizer_export_history.sql?raw";
import postgresFinopsExtendedSupportProjectionSql from "../postgres/migrations/0097_finops_extended_support_projection.sql?raw";
import postgresFinopsGravitonSavingsSql from "../postgres/migrations/0098_finops_graviton_savings.sql?raw";
import postgresFinopsAwsHealthEventsSql from "../postgres/migrations/0099_finops_aws_health_events.sql?raw";
import postgresFinopsAzureCidSql from "../postgres/migrations/0100_finops_azure_cid.sql?raw";
import postgresFinopsGcpCloudIntelligenceSql from "../postgres/migrations/0101_finops_gcp_cloud_intelligence.sql?raw";
import postgresFinopsDcfExecutionHistorySql from "../postgres/migrations/0102_finops_dcf_execution_history.sql?raw";
import postgresFinopsCoraExportObjectsSql from "../postgres/migrations/0103_finops_cora_export_objects.sql?raw";
import postgresFinopsAwsBudgetsDurableAttemptsSql from "../postgres/migrations/0104_finops_aws_budgets_durable_attempts.sql?raw";
import postgresFinopsEucRuntimeAttemptsSql from "../postgres/migrations/0105_finops_euc_runtime_attempts.sql?raw";
import postgresFinopsKubecostRuntimeAttemptsSql from "../postgres/migrations/0106_finops_kubecost_runtime_attempts.sql?raw";
import postgresFinopsComputeOptimizerExportPlansSql from "../postgres/migrations/0107_finops_compute_optimizer_export_plans.sql?raw";
import postgresFinopsComputeOptimizerExportPlanSetsSql from "../postgres/migrations/0108_finops_compute_optimizer_export_plan_sets.sql?raw";
import postgresFinopsComputeOptimizerExportPlanTimestampGuardSql from "../postgres/migrations/0109_finops_compute_optimizer_export_plan_timestamp_guard.sql?raw";
import postgresFinopsComputeOptimizerExactGenerationsSql from "../postgres/migrations/0110_finops_compute_optimizer_exact_generations.sql?raw";
import postgresComputeOptimizerExportLaunchLedgerSql from "../postgres/migrations/0111_compute_optimizer_export_launch_ledger.sql?raw";
import postgresFinopsComputeOptimizerActivationOutboxSql from "../postgres/migrations/0112_finops_compute_optimizer_activation_outbox.sql?raw";
import postgresFinopsAwsNewsFeedsReplaySql from "../postgres/migrations/0113_finops_aws_news_feeds_replay.sql?raw";
import postgresFinopsExtendedSupportRuntimeSql from "../postgres/migrations/0114_finops_extended_support_runtime.sql?raw";
import postgresFinopsAwsHealthRuntimeSql from "../postgres/migrations/0115_finops_aws_health_runtime.sql?raw";
import postgresFinopsResilienceVueRuntimeSql from "../postgres/migrations/0116_finops_resilience_vue_runtime.sql?raw";

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
  { id: "0049_background_jobs_kind_index", source: postgresBackgroundJobsKindIndexSql },
  { id: "0050_finops_cur_region", source: postgresFinopsCurRegionSql },
  { id: "0051_finops_cur_commitments", source: postgresFinopsCurCommitmentsSql },
  { id: "0052_finops_allocation_rules", source: postgresFinopsAllocationRulesSql },
  { id: "0053_finops_customer_margin", source: postgresFinopsCustomerMarginSql },
  { id: "0054_finops_budgets_customer_scope", source: postgresFinopsBudgetsCustomerScopeSql },
  { id: "0055_finops_resource_schedules", source: postgresFinopsResourceSchedulesSql },
  { id: "0056_finops_cur_usage_type", source: postgresFinopsCurUsageTypeSql },
  { id: "0057_finops_external_costs", source: postgresFinopsExternalCostsSql },
  { id: "0058_governance_policies", source: postgresGovernancePoliciesSql },
  { id: "0059_agentless_scans", source: postgresAgentlessScansSql },
  { id: "0060_invitation_zoho_provider", source: postgresInvitationZohoProviderSql },
  { id: "0061_aws_live_snapshot_origin", source: postgresAwsLiveSnapshotOriginSql },
  { id: "0062_saml_assertion_replays", source: postgresSamlAssertionReplaysSql },
  { id: "0063_dspm_workspace", source: postgresDspmWorkspaceSql },
  { id: "0064_scim_identity_lifecycle", source: postgresScimIdentityLifecycleSql },
  { id: "0065_hosted_broker_runtime", source: postgresHostedBrokerRuntimeSql },
  { id: "0066_itsm_managed_secrets", source: postgresItsmManagedSecretsSql },
  { id: "0067_audit_hash_version", source: postgresAuditHashVersionSql },
  { id: "0068_aws_global_ownership", source: postgresAwsGlobalOwnershipSql },
  { id: "0069_cmdb_resource_retirement", source: postgresCmdbResourceRetirementSql },
  { id: "0070_managed_evidence_objects", source: postgresManagedEvidenceObjectsSql },
  { id: "0071_itsm_delivery_evidence", source: postgresItsmDeliveryEvidenceSql },
  { id: "0072_ses_delivery_feedback", source: postgresSesDeliveryFeedbackSql },
  { id: "0073_finops_billing_engine_v2", source: postgresFinopsBillingEngineV2Sql },
  { id: "0074_finops_foundational_config", source: postgresFinopsFoundationalConfigSql },
  { id: "0075_finops_source_job_ledger", source: postgresFinopsSourceJobLedgerSql },
  { id: "0076_finops_source_snapshots", source: postgresFinopsSourceSnapshotsSql },
  { id: "0077_finops_source_evidence_artifact", source: postgresFinopsSourceEvidenceArtifactSql },
  { id: "0078_finops_data_export_observations", source: postgresFinopsDataExportObservationsSql },
  { id: "0079_finops_trusted_advisor_organization", source: postgresFinopsTrustedAdvisorOrganizationSql },
  { id: "0080_finops_compute_optimizer_discovery", source: postgresFinopsComputeOptimizerDiscoverySql },
  { id: "0081_finops_active_file_count", source: postgresFinopsActiveFileCountSql },
  { id: "0082_finops_aws_config_compliance", source: postgresFinopsAwsConfigComplianceSql },
  { id: "0083_finops_pricing_change_materializations", source: postgresFinopsPricingChangeMaterializationsSql },
  { id: "0084_finops_cora_snapshots", source: postgresFinopsCoraSnapshotsSql },
  { id: "0085_finops_aws_news_feed_snapshots", source: postgresFinopsAwsNewsFeedSnapshotsSql },
  { id: "0086_finops_aws_budgets_organization", source: postgresFinopsAwsBudgetsOrganizationSql },
  { id: "0087_finops_aws_support_cases", source: postgresFinopsAwsSupportCasesSql },
  { id: "0088_finops_resilience_vue", source: postgresFinopsResilienceVueSql },
  { id: "0089_finops_end_user_computing", source: postgresFinopsEndUserComputingSql },
  { id: "0090_finops_media_services_insights", source: postgresFinopsMediaServicesInsightsSql },
  { id: "0091_finops_marketplace_spg", source: postgresFinopsMarketplaceSpgSql },
  { id: "0092_finops_kubecost_allocation", source: postgresFinopsKubecostAllocationSql },
  { id: "0093_finops_scad_allocation", source: postgresFinopsScadAllocationSql },
  { id: "0094_finops_sustainability_carbon", source: postgresFinopsSustainabilityCarbonSql },
  { id: "0095_finops_amazon_connect_cost_insights", source: postgresFinopsAmazonConnectCostInsightsSql },
  { id: "0096_finops_compute_optimizer_export_history", source: postgresFinopsComputeOptimizerExportHistorySql },
  { id: "0097_finops_extended_support_projection", source: postgresFinopsExtendedSupportProjectionSql },
  { id: "0098_finops_graviton_savings", source: postgresFinopsGravitonSavingsSql },
  { id: "0099_finops_aws_health_events", source: postgresFinopsAwsHealthEventsSql },
  { id: "0100_finops_azure_cid", source: postgresFinopsAzureCidSql },
  { id: "0101_finops_gcp_cloud_intelligence", source: postgresFinopsGcpCloudIntelligenceSql },
  { id: "0102_finops_dcf_execution_history", source: postgresFinopsDcfExecutionHistorySql },
  { id: "0103_finops_cora_export_objects", source: postgresFinopsCoraExportObjectsSql },
  { id: "0104_finops_aws_budgets_durable_attempts", source: postgresFinopsAwsBudgetsDurableAttemptsSql },
  { id: "0105_finops_euc_runtime_attempts", source: postgresFinopsEucRuntimeAttemptsSql },
  { id: "0106_finops_kubecost_runtime_attempts", source: postgresFinopsKubecostRuntimeAttemptsSql },
  { id: "0107_finops_compute_optimizer_export_plans", source: postgresFinopsComputeOptimizerExportPlansSql },
  { id: "0108_finops_compute_optimizer_export_plan_sets", source: postgresFinopsComputeOptimizerExportPlanSetsSql },
  { id: "0109_finops_compute_optimizer_export_plan_timestamp_guard", source: postgresFinopsComputeOptimizerExportPlanTimestampGuardSql },
  { id: "0110_finops_compute_optimizer_exact_generations", source: postgresFinopsComputeOptimizerExactGenerationsSql },
  { id: "0111_compute_optimizer_export_launch_ledger", source: postgresComputeOptimizerExportLaunchLedgerSql },
  { id: "0112_finops_compute_optimizer_activation_outbox", source: postgresFinopsComputeOptimizerActivationOutboxSql },
  { id: "0113_finops_aws_news_feeds_replay", source: postgresFinopsAwsNewsFeedsReplaySql },
  { id: "0114_finops_extended_support_runtime", source: postgresFinopsExtendedSupportRuntimeSql },
  { id: "0115_finops_aws_health_runtime", source: postgresFinopsAwsHealthRuntimeSql },
  { id: "0116_finops_resilience_vue_runtime", source: postgresFinopsResilienceVueRuntimeSql },
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
