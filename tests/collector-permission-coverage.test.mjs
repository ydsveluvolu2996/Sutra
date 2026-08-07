import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const collectorSrc = resolve(root, "services/aws-collector/src");
const templatePath = resolve(root, "infrastructure/customer-onboarding-role.yaml");
const finopsTemplatePath = resolve(
  root,
  "infrastructure/customer-onboarding-role-standard-2026-08.3.yaml",
);

/**
 * The definitive set of AWS SDK commands the wired collector constructs, keyed
 * by the identifier used at the `new <Command>(` call site (aliases included),
 * mapped to the IAM action it invokes.
 *
 * scope:
 *   "customer" — runs under the assumed customer onboarding role and therefore
 *                MUST be permitted by the default onboarding template.
 *   "finops_source" — runs under the immutable advanced FinOps permission pack
 *                and an exact, separately attested source policy. These actions
 *                MUST remain absent from the current default metadata role.
 *   "source_session" — runs only inside a source-specific, fail-closed session
 *                policy. The provider contract tests pin each exact action set;
 *                this drift guard additionally proves that the command remains
 *                read-only and absent from the default metadata role.
 *   "finops_launch" — runs only inside the short-lived Compute Optimizer export
 *                launch session. These export APIs create report jobs, so they
 *                are deliberately excluded from the read-only collector claim
 *                and checked against the exact launch-action contract below.
 *   "vendor"   — runs under Sutra's own workload identity (the initial
 *                AssumeRole into the customer role) and is NOT part of the
 *                customer role's permission policy.
 *   "vendor_cryptographic" — runs under Sutra's broker task role against the
 *                exact server-owned signing key. It never uses the assumed
 *                customer session and is not an onboarding-role permission.
 *   "agentless" — runs under the AGENTLESS STS ceiling
 *                (agentlessSnapshotSessionPolicy) or in Sutra's own scan account.
 *                These are NOT read-only: agentless scanning creates a snapshot in
 *                the customer account by design, which is exactly why it has its own
 *                ceiling with explicit Denies on every destructive verb instead of
 *                riding on the read-only collection role. Excluded from the read-only
 *                assertion and from the onboarding template — putting them there
 *                would widen the default role EVERY customer grants, for a feature
 *                they may never enable.
 *
 * Every command must be mapped. If a collector adds a new SDK command it must
 * be added here (drift guard below fails otherwise), and any new "customer"
 * action must also be granted by the template (coverage below).
 */
const COLLECTOR_COMMANDS = {
  AssumeRoleCommand: { action: "sts:AssumeRole", scope: "vendor" },
  SignCommand: { action: "kms:Sign", scope: "vendor_cryptographic" },
  // Wrap and unwrap the data keys that encrypt customer-supplied AWS access
  // keys. Vendor-cryptographic, not customer: the CMK lives in Sutra's own
  // account and is used by the broker task role, never by the assumed customer
  // session. Granting either of these in the onboarding template would ask
  // every customer for a permission Sutra does not use against their account.
  // The instance-role grant lives in deploy/ec2/cloudformation-single-node.yaml
  // and is bound to the envelope's exact encryption context.
  GenerateDataKeyCommand: { action: "kms:GenerateDataKey", scope: "vendor_cryptographic" },
  DecryptCommand: { action: "kms:Decrypt", scope: "vendor_cryptographic" },
  // Reads an agentless scan's published findings from SUTRA's OWN bucket. Vendor
  // scope, deliberately: this is never a customer permission, and putting it in the
  // onboarding template would misrepresent what Sutra asks customers to grant.
  GetObjectCommand: { action: "s3:GetObject", scope: "vendor" },
  // ─── Agentless scanning. NOT read-only, NOT in the onboarding template. ─────
  // Customer account, bounded by agentlessSnapshotSessionPolicy:
  CreateSnapshotCommand: { action: "ec2:CreateSnapshot", scope: "agentless" },
  ModifySnapshotAttributeCommand: { action: "ec2:ModifySnapshotAttribute", scope: "agentless" },
  // Sutra's own scan account, under the orchestrator role:
  CopySnapshotCommand: { action: "ec2:CopySnapshot", scope: "agentless" },
  CreateVolumeCommand: { action: "ec2:CreateVolume", scope: "agentless" },
  DeleteVolumeCommand: { action: "ec2:DeleteVolume", scope: "agentless" },
  DeleteSnapshotCommand: { action: "ec2:DeleteSnapshot", scope: "agentless" },
  RunInstancesCommand: { action: "ec2:RunInstances", scope: "agentless" },
  AttachVolumeCommand: { action: "ec2:AttachVolume", scope: "agentless" },
  TerminateInstancesCommand: { action: "ec2:TerminateInstances", scope: "agentless" },
  DescribeInstanceStatusCommand: { action: "ec2:DescribeInstanceStatus", scope: "agentless" },
  CreateTagsCommand: { action: "ec2:CreateTags", scope: "agentless" },
  GetCallerIdentityCommand: { action: "sts:GetCallerIdentity", scope: "customer" },
  GetRoleCommand: { action: "iam:GetRole", scope: "customer" },
  GetRolePolicyCommand: { action: "iam:GetRolePolicy", scope: "customer" },
  ListRolePoliciesCommand: { action: "iam:ListRolePolicies", scope: "customer" },
  ListAttachedRolePoliciesCommand: { action: "iam:ListAttachedRolePolicies", scope: "customer" },
  GetAccountSummaryCommand: { action: "iam:GetAccountSummary", scope: "customer" },
  GetAccountPasswordPolicyCommand: { action: "iam:GetAccountPasswordPolicy", scope: "customer" },
  DescribeRegionsCommand: { action: "ec2:DescribeRegions", scope: "customer" },
  DescribeInstancesCommand: { action: "ec2:DescribeInstances", scope: "customer" },
  DescribeVpcsCommand: { action: "ec2:DescribeVpcs", scope: "customer" },
  DescribeSubnetsCommand: { action: "ec2:DescribeSubnets", scope: "customer" },
  DescribeSecurityGroupsCommand: { action: "ec2:DescribeSecurityGroups", scope: "customer" },
  DescribeVolumesCommand: { action: "ec2:DescribeVolumes", scope: "customer" },
  DescribeNetworkInterfacesCommand: { action: "ec2:DescribeNetworkInterfaces", scope: "customer" },
  DescribeNetworkAclsCommand: { action: "ec2:DescribeNetworkAcls", scope: "customer" },
  DescribeRouteTablesCommand: { action: "ec2:DescribeRouteTables", scope: "customer" },
  DescribeInternetGatewaysCommand: { action: "ec2:DescribeInternetGateways", scope: "customer" },
  DescribeAddressesCommand: { action: "ec2:DescribeAddresses", scope: "customer" },
  DescribeFlowLogsCommand: { action: "ec2:DescribeFlowLogs", scope: "customer" },
  DescribeSnapshotsCommand: { action: "ec2:DescribeSnapshots", scope: "customer" },
  DescribeLoadBalancersCommand: { action: "elasticloadbalancing:DescribeLoadBalancers", scope: "customer" },
  DescribeListenersCommand: { action: "elasticloadbalancing:DescribeListeners", scope: "customer" },
  DescribeTargetGroupsCommand: { action: "elasticloadbalancing:DescribeTargetGroups", scope: "customer" },
  DescribeTargetHealthCommand: { action: "elasticloadbalancing:DescribeTargetHealth", scope: "customer" },
  // Foundational billing export discovery. Customer scope, unlike the KMS
  // envelope pair above: these run inside the assumed customer session against
  // the customer's own Data Exports, and the onboarding template must therefore
  // Allow them. It already does — pack standard-2026-08.12 grants both — so no
  // successor pack is required for this vertical.
  ListExportsCommand: { action: "bcm-data-exports:ListExports", scope: "customer" },
  GetExportCommand: { action: "bcm-data-exports:GetExport", scope: "customer" },
  ListKeysCommand: { action: "kms:ListKeys", scope: "customer" },
  ListAliasesCommand: { action: "kms:ListAliases", scope: "customer" },
  DescribeKeyCommand: { action: "kms:DescribeKey", scope: "customer" },
  ListTablesCommand: { action: "dynamodb:ListTables", scope: "customer" },
  DescribeTableCommand: { action: "dynamodb:DescribeTable", scope: "customer" },
  DescribeRepositoriesCommand: { action: "ecr:DescribeRepositories", scope: "customer" },
  ListClustersCommand: { action: "eks:ListClusters", scope: "customer" },
  DescribeClusterCommand: { action: "eks:DescribeCluster", scope: "customer" },
  ListDetectorsCommand: { action: "guardduty:ListDetectors", scope: "customer" },
  GetDetectorCommand: { action: "guardduty:GetDetector", scope: "customer" },
  ListGuardDutyFindingsCommand: { action: "guardduty:ListFindings", scope: "customer" },
  GetGuardDutyFindingsCommand: { action: "guardduty:GetFindings", scope: "customer" },
  BatchGetAccountStatusCommand: { action: "inspector2:BatchGetAccountStatus", scope: "customer" },
  ListInspectorFindingsCommand: { action: "inspector2:ListFindings", scope: "customer" },
  ListGuardrailsCommand: { action: "bedrock:ListGuardrails", scope: "customer" },
  GetGuardrailCommand: { action: "bedrock:GetGuardrail", scope: "customer" },
  GetModelInvocationLoggingConfigurationCommand: {
    action: "bedrock:GetModelInvocationLoggingConfiguration",
    scope: "customer",
  },
  GetAccountDataRetentionCommand: { action: "bedrock:GetAccountDataRetention", scope: "customer" },
  DescribeDBInstancesCommand: { action: "rds:DescribeDBInstances", scope: "customer" },
  ListBucketsCommand: { action: "s3:ListAllMyBuckets", scope: "customer" },
  GetPublicAccessBlockCommand: { action: "s3:GetBucketPublicAccessBlock", scope: "customer" },
  DescribeHubCommand: { action: "securityhub:DescribeHub", scope: "customer" },
  GetSecurityHubFindingsCommand: { action: "securityhub:GetFindings", scope: "customer" },
  DescribeTrailsCommand: { action: "cloudtrail:DescribeTrails", scope: "customer" },
  GetTrailStatusCommand: { action: "cloudtrail:GetTrailStatus", scope: "customer" },
  LookupEventsCommand: { action: "cloudtrail:LookupEvents", scope: "customer" },
  GetCostAndUsageCommand: { action: "ce:GetCostAndUsage", scope: "customer" },
  GetCostForecastCommand: { action: "ce:GetCostForecast", scope: "customer" },
  GetAnomaliesCommand: { action: "ce:GetAnomalies", scope: "finops_source" },
  GetAnomalyMonitorsCommand: { action: "ce:GetAnomalyMonitors", scope: "finops_source" },
  GetAnomalySubscriptionsCommand: {
    action: "ce:GetAnomalySubscriptions",
    scope: "finops_source",
  },
  GetEnrollmentStatusCommand: {
    action: "compute-optimizer:GetEnrollmentStatus",
    scope: "finops_source",
  },
  GetEnrollmentStatusesForOrganizationCommand: {
    action: "compute-optimizer:GetEnrollmentStatusesForOrganization",
    scope: "finops_source",
  },
  DescribeRecommendationExportJobsCommand: {
    action: "compute-optimizer:DescribeRecommendationExportJobs",
    scope: "finops_source",
  },
  DescribeTrustedAdvisorChecksCommand: {
    action: "support:DescribeTrustedAdvisorChecks",
    scope: "finops_source",
  },
  DescribeTrustedAdvisorCheckResultCommand: {
    action: "support:DescribeTrustedAdvisorCheckResult",
    scope: "finops_source",
  },
  DescribeOrganizationCommand: {
    action: "organizations:DescribeOrganization",
    scope: "finops_source",
  },
  ListAccountsCommand: {
    action: "organizations:ListAccounts",
    scope: "finops_source",
  },
  // Source-specific provider sessions. These commands do not run under the
  // default metadata role; exact per-provider action sets are separately pinned.
  DescribeBudgetPerformanceHistoryCommand: { action: "budgets:ViewBudget", scope: "source_session" },
  DescribeBudgetsCommand: { action: "budgets:ViewBudget", scope: "source_session" },
  DescribeNotificationsForBudgetCommand: { action: "budgets:ViewBudget", scope: "source_session" },
  DescribeSubscribersForNotificationCommand: { action: "budgets:ViewBudget", scope: "source_session" },
  DescribeBudgetActionsForBudgetCommand: {
    action: "budgets:DescribeBudgetActionsForBudget",
    scope: "source_session",
  },
  ListTagsForResourceCommand: { action: "budgets:ListTagsForResource", scope: "source_session" },
  ListRootsCommand: { action: "organizations:ListRoots", scope: "source_session" },
  ListOrganizationalUnitsForParentCommand: {
    action: "organizations:ListOrganizationalUnitsForParent",
    scope: "source_session",
  },
  ListParentsCommand: { action: "organizations:ListParents", scope: "source_session" },
  ListDelegatedAdministratorsCommand: {
    action: "organizations:ListDelegatedAdministrators",
    scope: "source_session",
  },
  DescribeAffectedAccountsForOrganizationCommand: {
    action: "health:DescribeAffectedAccountsForOrganization",
    scope: "source_session",
  },
  DescribeAffectedEntitiesForOrganizationCommand: {
    action: "health:DescribeAffectedEntitiesForOrganization",
    scope: "source_session",
  },
  DescribeEventDetailsForOrganizationCommand: {
    action: "health:DescribeEventDetailsForOrganization",
    scope: "source_session",
  },
  DescribeEventsForOrganizationCommand: {
    action: "health:DescribeEventsForOrganization",
    scope: "source_session",
  },
  DescribeHealthServiceStatusForOrganizationCommand: {
    action: "health:DescribeHealthServiceStatusForOrganization",
    scope: "source_session",
  },
  DescribeCasesCommand: { action: "support:DescribeCases", scope: "source_session" },
  DescribeCommunicationsCommand: {
    action: "support:DescribeCommunications",
    scope: "source_session",
  },
  DescribeClusterVersionsCommand: {
    action: "eks:DescribeClusterVersions",
    scope: "source_session",
  },
  DescribeDBClustersCommand: { action: "rds:DescribeDBClusters", scope: "source_session" },
  DescribeDBMajorEngineVersionsCommand: {
    action: "rds:DescribeDBMajorEngineVersions",
    scope: "source_session",
  },
  DescribeOrderableDBInstanceOptionsCommand: {
    action: "rds:DescribeOrderableDBInstanceOptions",
    scope: "source_session",
  },
  ListDomainNamesCommand: { action: "es:ListDomainNames", scope: "source_session" },
  DescribeDomainCommand: { action: "es:DescribeDomain", scope: "source_session" },
  DescribeDomainsCommand: { action: "es:DescribeDomains", scope: "source_session" },
  DescribeCacheClustersCommand: {
    action: "elasticache:DescribeCacheClusters",
    scope: "source_session",
  },
  DescribeReplicationGroupsCommand: {
    action: "elasticache:DescribeReplicationGroups",
    scope: "source_session",
  },
  DescribeCacheEngineVersionsCommand: {
    action: "elasticache:DescribeCacheEngineVersions",
    scope: "source_session",
  },
  GetProductsCommand: { action: "pricing:GetProducts", scope: "source_session" },
  GetEC2InstanceRecommendationsCommand: {
    action: "compute-optimizer:GetEC2InstanceRecommendations",
    scope: "source_session",
  },
  GetAutoScalingGroupRecommendationsCommand: {
    action: "compute-optimizer:GetAutoScalingGroupRecommendations",
    scope: "source_session",
  },
  GetRDSDatabaseRecommendationsCommand: {
    action: "compute-optimizer:GetRDSDatabaseRecommendations",
    scope: "source_session",
  },
  DescribeImagesCommand: { action: "ec2:DescribeImages", scope: "source_session" },
  DescribeInstanceTypesCommand: {
    action: "ec2:DescribeInstanceTypes",
    scope: "source_session",
  },
  DescribeAutoScalingGroupsCommand: {
    action: "autoscaling:DescribeAutoScalingGroups",
    scope: "source_session",
  },
  ListPriceListsCommand: { action: "pricing:ListPriceLists", scope: "source_session" },
  GetPriceListFileUrlCommand: {
    action: "pricing:GetPriceListFileUrl",
    scope: "source_session",
  },
  DescribeAppCommand: { action: "resiliencehub:DescribeApp", scope: "source_session" },
  DescribeAppAssessmentCommand: {
    action: "resiliencehub:DescribeAppAssessment",
    scope: "source_session",
  },
  DescribeResiliencyPolicyCommand: {
    action: "resiliencehub:DescribeResiliencyPolicy",
    scope: "source_session",
  },
  ListAlarmRecommendationsCommand: {
    action: "resiliencehub:ListAlarmRecommendations",
    scope: "source_session",
  },
  ListAppAssessmentComplianceDriftsCommand: {
    action: "resiliencehub:ListAppAssessmentComplianceDrifts",
    scope: "source_session",
  },
  ListAppAssessmentResourceDriftsCommand: {
    action: "resiliencehub:ListAppAssessmentResourceDrifts",
    scope: "source_session",
  },
  ListAppAssessmentsCommand: {
    action: "resiliencehub:ListAppAssessments",
    scope: "source_session",
  },
  ListAppComponentCompliancesCommand: {
    action: "resiliencehub:ListAppComponentCompliances",
    scope: "source_session",
  },
  ListAppComponentRecommendationsCommand: {
    action: "resiliencehub:ListAppComponentRecommendations",
    scope: "source_session",
  },
  ListAppVersionResourcesCommand: {
    action: "resiliencehub:ListAppVersionResources",
    scope: "source_session",
  },
  ListAppsCommand: { action: "resiliencehub:ListApps", scope: "source_session" },
  ListResiliencyPoliciesCommand: {
    action: "resiliencehub:ListResiliencyPolicies",
    scope: "source_session",
  },
  ListSopRecommendationsCommand: {
    action: "resiliencehub:ListSopRecommendations",
    scope: "source_session",
  },
  ListTestRecommendationsCommand: {
    action: "resiliencehub:ListTestRecommendations",
    scope: "source_session",
  },
  DescribeExecutionCommand: { action: "states:DescribeExecution", scope: "source_session" },
  DescribeStateMachineCommand: {
    action: "states:DescribeStateMachine",
    scope: "source_session",
  },
  ListExecutionsCommand: { action: "states:ListExecutions", scope: "source_session" },
  DescribeFleetsCommand: { action: "appstream:DescribeFleets", scope: "source_session" },
  DescribeSessionsCommand: { action: "appstream:DescribeSessions", scope: "source_session" },
  DescribeStacksCommand: { action: "appstream:DescribeStacks", scope: "source_session" },
  ListAssociatedFleetsCommand: {
    action: "appstream:ListAssociatedFleets",
    scope: "source_session",
  },
  DescribeWorkspaceBundlesCommand: {
    action: "workspaces:DescribeWorkspaceBundles",
    scope: "source_session",
  },
  DescribeWorkspacesCommand: {
    action: "workspaces:DescribeWorkspaces",
    scope: "source_session",
  },
  DescribeWorkspacesConnectionStatusCommand: {
    action: "workspaces:DescribeWorkspacesConnectionStatus",
    scope: "source_session",
  },
  GetBucketLocationCommand: { action: "s3:GetBucketLocation", scope: "source_session" },
  ListObjectsV2Command: { action: "s3:ListBucket", scope: "source_session" },
  // S3 authorizes HeadObject with s3:GetObject; there is no s3:HeadObject action.
  HeadObjectCommand: { action: "s3:GetObject", scope: "source_session" },
  // Short-lived Compute Optimizer export-launch session, not the read-only role.
  ExportAutoScalingGroupRecommendationsCommand: {
    action: "compute-optimizer:ExportAutoScalingGroupRecommendations",
    scope: "finops_launch",
  },
  ExportEBSVolumeRecommendationsCommand: {
    action: "compute-optimizer:ExportEBSVolumeRecommendations",
    scope: "finops_launch",
  },
  ExportEC2InstanceRecommendationsCommand: {
    action: "compute-optimizer:ExportEC2InstanceRecommendations",
    scope: "finops_launch",
  },
  ExportECSServiceRecommendationsCommand: {
    action: "compute-optimizer:ExportECSServiceRecommendations",
    scope: "finops_launch",
  },
  ExportIdleRecommendationsCommand: {
    action: "compute-optimizer:ExportIdleRecommendations",
    scope: "finops_launch",
  },
  ExportLambdaFunctionRecommendationsCommand: {
    action: "compute-optimizer:ExportLambdaFunctionRecommendations",
    scope: "finops_launch",
  },
  ExportLicenseRecommendationsCommand: {
    action: "compute-optimizer:ExportLicenseRecommendations",
    scope: "finops_launch",
  },
  ExportRDSDatabaseRecommendationsCommand: {
    action: "compute-optimizer:ExportRDSDatabaseRecommendations",
    scope: "finops_launch",
  },
  GetMetricDataCommand: { action: "cloudwatch:GetMetricData", scope: "customer" },
  ListMetricsCommand: { action: "cloudwatch:ListMetrics", scope: "customer" },
  DescribeInstanceInformationCommand: { action: "ssm:DescribeInstanceInformation", scope: "customer" },
  DescribeInstancePatchStatesCommand: { action: "ssm:DescribeInstancePatchStates", scope: "customer" },
  DescribeInstancePatchesCommand: { action: "ssm:DescribeInstancePatches", scope: "customer" },
};

const READ_ONLY_VERBS =
  /^[a-z0-9-]+:(Describe|Get|List|View|BatchGet|LookupEvents|AssumeRole)/u;

function actionsInStatement(source, sid) {
  const marker = `- Sid: ${sid}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing statement ${sid}`);
  const following = source.indexOf("\n              - Sid:", start + marker.length);
  const block = source.slice(start, following === -1 ? source.length : following);
  return [...block.matchAll(/^\s+- ([a-z0-9*-]+:[A-Za-z0-9*]+)\s*$/gmu)].map((m) => m[1]);
}

function actionsInPolicy(source, policyName) {
  const marker = `- PolicyName: ${policyName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing policy ${policyName}`);
  const candidates = [
    source.indexOf("\n        - PolicyName:", start + marker.length),
    source.indexOf("\n      Tags:", start + marker.length),
  ].filter((value) => value >= 0);
  assert.ok(candidates.length > 0, `unbounded policy ${policyName}`);
  const block = source.slice(start, Math.min(...candidates));
  assert.match(block, /- Sid: ExactFinopsSourceRead/u);
  return [...block.matchAll(/^\s+- ([a-z0-9*-]+:[A-Za-z0-9*]+)\s*$/gmu)]
    .map((match) => match[1]);
}

async function commandsConstructedInCollector() {
  const entries = await readdir(collectorSrc, { withFileTypes: true });
  const used = new Set();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const source = await readFile(resolve(collectorSrc, entry.name), "utf8");
    for (const match of source.matchAll(/new\s+([A-Z][A-Za-z0-9]*Command)\s*\(/gu)) {
      used.add(match[1]);
    }
  }
  return used;
}

test("every AWS command the collector constructs is mapped to its permission action", async () => {
  const used = await commandsConstructedInCollector();
  for (const command of used) {
    assert.ok(
      Object.hasOwn(COLLECTOR_COMMANDS, command),
      `collector constructs ${command} but it is not mapped in COLLECTOR_COMMANDS; ` +
        "add its IAM action here and grant it in the onboarding template",
    );
  }
  // The read-only claim is about COLLECTION. Agentless is excluded because it
  // genuinely writes — but not thereby unbounded: the next test pins the exact set,
  // so a new write verb cannot be slipped in under this label.
  for (const [command, { action, scope }] of Object.entries(COLLECTOR_COMMANDS)) {
    if (scope === "agentless" || scope === "vendor_cryptographic" || scope === "finops_launch") continue;
    assert.match(action, READ_ONLY_VERBS, `${command} maps to non-read-only action ${action}`);
  }
});

test("default onboarding template permits every read-only action the collector calls", async () => {
  const template = await readFile(templatePath, "utf8");

  const allowed = new Set([
    ...actionsInStatement(template, "ImplementedMetadataApis"),
    ...actionsInStatement(template, "TrustContractAttestation"),
  ]);
  const denyCeiling = new Set(actionsInStatement(template, "DenyUnimplementedActions"));

  const customerActions = [...new Set(
    Object.values(COLLECTOR_COMMANDS)
      .filter((entry) => entry.scope === "customer")
      .map((entry) => entry.action),
  )];

  for (const action of customerActions) {
    assert.ok(
      allowed.has(action),
      `collector calls ${action} but the onboarding template does not Allow it`,
    );
    // Deny uses NotAction: an action is only escaped from the Deny when it is
    // listed in NotAction. If a collector action is missing here it is denied.
    assert.ok(
      denyCeiling.has(action),
      `collector calls ${action} but the template's Deny ceiling would deny it`,
    );
  }

  // No customer action the collector relies on may be a mutation.
  for (const action of customerActions) {
    assert.match(action, READ_ONLY_VERBS, `granted collector action ${action} is not read-only`);
  }
});

test("FinOps source commands require the exact successor source policy and deny ceiling", async () => {
  const currentTemplate = await readFile(templatePath, "utf8");
  const finopsTemplate = await readFile(finopsTemplatePath, "utf8");
  const sourceAllowed = new Set([
    ...actionsInPolicy(finopsTemplate, "SutraFinopsCostAnomalyReadV1"),
    ...actionsInPolicy(finopsTemplate, "SutraFinopsTrustedAdvisorStandardReadV1"),
    ...actionsInPolicy(finopsTemplate, "SutraFinopsOrganizationsTaxonomyReadV1"),
    ...actionsInPolicy(finopsTemplate, "SutraFinopsComputeOptimizerExportReadV1"),
  ]);
  const denyCeiling = new Set(actionsInStatement(finopsTemplate, "DenyUnimplementedActions"));
  const sourceActions = [...new Set(
    Object.values(COLLECTOR_COMMANDS)
      .filter((entry) => entry.scope === "finops_source")
      .map((entry) => entry.action),
  )];

  assert.match(finopsTemplate, /PolicyName: SutraFinopsCostAnomalyReadV1/u);
  assert.match(finopsTemplate, /PolicyName: SutraFinopsTrustedAdvisorStandardReadV1/u);
  assert.match(finopsTemplate, /PolicyName: SutraFinopsOrganizationsTaxonomyReadV1/u);
  assert.match(finopsTemplate, /PolicyName: SutraFinopsComputeOptimizerExportReadV1/u);
  assert.equal(finopsTemplate.includes("- kms:Sign"), false);
  assert.deepEqual([...sourceAllowed].sort(), [...sourceActions].sort());

  // The "default metadata role" is the ImplementedMetadataApis statement — the
  // broad inventory grant every connection gets. A FinOps source action must
  // reach the role only through its own named source policy, never by being
  // folded into that statement, where it would be granted to every collection
  // path rather than to the one source that declares it.
  //
  // Checked against that statement rather than the whole file: onboarding now
  // deploys the standard-2026-08.12 action set, so these actions are legitimately
  // present in the template's dedicated FinOps policies and in its deny ceiling.
  // A whole-file check would forbid exactly the grant the design requires.
  const defaultMetadataActions = new Set(
    actionsInStatement(currentTemplate, "ImplementedMetadataApis"),
  );
  for (const action of sourceActions) {
    assert.ok(
      denyCeiling.has(action),
      `FinOps source calls ${action} but the successor deny ceiling would deny it`,
    );
    assert.equal(
      defaultMetadataActions.has(action),
      false,
      `${action} must not widen the current default metadata role`,
    );
    assert.match(action, READ_ONLY_VERBS, `${action} is not a read-only FinOps source action`);
  }
});

test("source-specific collector sessions do not widen the default metadata role", async () => {
  const currentTemplate = await readFile(templatePath, "utf8");
  const sourceActions = [...new Set(
    Object.values(COLLECTOR_COMMANDS)
      .filter((entry) => entry.scope === "source_session")
      .map((entry) => entry.action),
  )];

  assert.ok(sourceActions.length > 0, "source-specific command scope must not be empty");
  // Same boundary as above: the broad ImplementedMetadataApis grant, not the
  // whole template. A source-session action belongs to the named source policy
  // that declares it, so folding it into the default metadata statement would
  // hand it to every collection path.
  const defaultMetadataActions = new Set(
    actionsInStatement(currentTemplate, "ImplementedMetadataApis"),
  );
  for (const action of sourceActions) {
    assert.match(action, READ_ONLY_VERBS, `${action} is not a read-only source-session action`);
    assert.equal(
      defaultMetadataActions.has(action),
      false,
      `${action} must not widen the current default metadata role`,
    );
  }
});

test("Compute Optimizer export commands stay inside the exact launch contract", async () => {
  const broker = await readFile(resolve(collectorSrc, "role-broker.ts"), "utf8");
  const start = broker.indexOf("export const COMPUTE_OPTIMIZER_EXPORT_LAUNCH_ACTIONS");
  assert.notEqual(start, -1, "Compute Optimizer export launch contract is missing");
  const block = broker.slice(start, broker.indexOf("] as const);", start));
  const allowed = new Set(
    [...block.matchAll(/"(compute-optimizer:Export[A-Za-z0-9]+)"/gu)].map((match) => match[1]),
  );
  const launched = Object.values(COLLECTOR_COMMANDS)
    .filter((entry) => entry.scope === "finops_launch")
    .map((entry) => entry.action);

  assert.deepEqual([...new Set(launched)].sort(), [...allowed].sort());
});

/**
 * "agentless" must not become a way to add arbitrary write verbs. Nothing labelled
 * agentless may be a verb the STS ceiling in role-broker.ts explicitly Denies, and a
 * customer-side write must be one that ceiling Allows.
 */
test("agentless write actions stay inside the STS ceiling that bounds them", async () => {
  const broker = await readFile(resolve(collectorSrc, "role-broker.ts"), "utf8");
  const listed = (name) => {
    const start = broker.indexOf(`const ${name} = [`);
    assert.ok(start !== -1, `${name} not found in role-broker.ts`);
    const block = broker.slice(start, broker.indexOf("] as const;", start));
    return [...block.matchAll(/"([a-z0-9]+:[A-Za-z0-9*]+)"/gu)].map((m) => m[1]);
  };
  const allowed = listed("SESSION_AGENTLESS_WRITE_ACTIONS");
  const denied = listed("SESSION_AGENTLESS_DENY_ACTIONS");

  const agentless = Object.entries(COLLECTOR_COMMANDS).filter(([, e]) => e.scope === "agentless");
  assert.ok(agentless.length > 0, "the agentless scope must not be empty while the feature exists");

  const matches = (pattern, action) =>
    new RegExp(`^${pattern.replaceAll(".", "\\.").replaceAll("*", ".*")}$`, "u").test(action);

  for (const [command, { action }] of agentless) {
    for (const pattern of denied) {
      // A denied verb is unreachable whatever the label claims. DeleteVolume and
      // DeleteSnapshot are exempt: they run in SUTRA's OWN account under the
      // orchestrator role, which is a different principal from the customer session
      // the deny list bounds.
      if (action === "ec2:DeleteVolume" || action === "ec2:DeleteSnapshot") continue;
      if (action === "ec2:TerminateInstances") continue;
      assert.ok(
        !matches(pattern, action),
        `${command} maps to ${action}, which SESSION_AGENTLESS_DENY_ACTIONS denies as ${pattern}`,
      );
    }
    if (action === "ec2:CreateSnapshot" || action === "ec2:ModifySnapshotAttribute") {
      assert.ok(
        allowed.some((a) => matches(a, action)),
        `${command} maps to ${action}, which the agentless STS ceiling does not allow`,
      );
    }
  }
});
