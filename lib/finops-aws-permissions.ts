/**
 * Enterprise AWS permission boundaries for FinOps.
 *
 * Data collection is always read-only. Infrastructure provisioning and
 * customer-approved write actions are deliberately separate role plans so an
 * always-on collector can never inherit mutation authority by convenience.
 */
import {
  FINOPS_CAPABILITY_DEFINITIONS,
  type FinopsCapabilityId,
  type FinopsSourceId,
} from "./finops-source-health.ts";
import { AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS } from "./finops-amazon-connect-cost-insight.ts";
import {
  CORA_ENROLLMENT_PROVISIONER_OPERATIONS,
  CORA_EXPORT_PROVISIONER_OPERATIONS,
  CORA_ORGANIZATION_READ_OPERATIONS,
  CORA_PERMANENT_EXPORT_READ_OPERATIONS,
  CORA_PERMANENT_HUB_READ_OPERATIONS,
  CORA_PERMANENT_S3_READ_OPERATIONS,
} from "./finops-cora.ts";
import {
  AWS_CONFIG_AGGREGATOR_READ_OPERATIONS,
  AWS_CONFIG_ORGANIZATION_READ_OPERATIONS,
  AWS_CONFIG_RECORDER_COVERAGE_READ_OPERATIONS,
  AWS_CONFIG_RULE_LIFECYCLE_READ_OPERATIONS,
} from "./finops-aws-config-compliance.ts";
import { KUBECOST_RUNTIME_S3_READ_IAM_ACTIONS } from "./finops-kubecost-allocation.ts";
import { PRICING_CHANGE_READ_OPERATIONS } from "./finops-pricing-change-analysis.ts";
import {
  SCAD_ONE_TIME_PROVISIONER_IAM_ACTIONS,
  SCAD_RUNTIME_S3_READ_IAM_ACTIONS,
} from "./finops-scad-allocation.ts";
import { AWS_CARBON_DATA_EXPORT_ACCESS_IAM_ACTIONS } from "./finops-sustainability-carbon.ts";

export type AwsPartition = "aws" | "aws-us-gov" | "aws-cn";
export type FinopsPermissionBoundary = "collector" | "provisioner" | "action";

export interface FinopsIamStatement {
  readonly sid: string;
  readonly effect: "Allow";
  readonly actions: readonly string[];
  readonly resources: readonly string[];
  readonly conditions?: Readonly<Partial<Record<
    "StringLike" | "StringEquals",
    Readonly<Record<string, string | readonly string[]>>
  >>>;
  readonly resourceScopeReason?:
    | "service_does_not_support_resource_level_permissions"
    | "operation_requires_account_wide_discovery";
}

export interface FinopsRolePlan {
  readonly boundary: FinopsPermissionBoundary;
  readonly roleName: string;
  readonly statements: readonly FinopsIamStatement[];
}

export type FinopsWriteCapability =
  | "manage_aws_budgets"
  | "acknowledge_cost_anomaly"
  | "update_cost_optimization_preferences";

export interface FinopsActionApproval {
  readonly capability: FinopsWriteCapability;
  readonly approvedBy: string;
  readonly approvedAtIso: string;
  readonly expiresAtIso: string;
  readonly changeTicket: string;
}

export interface BuildFinopsPermissionPlanInput {
  readonly partition: AwsPartition;
  readonly accountId: string;
  readonly region: string;
  readonly exportBucketName: string;
  /** Exact customer-authorized S3 key prefix, including the trailing slash. */
  readonly exportKeyPrefix: string;
  /**
   * Exact tenant-authorized Amazon Connect instances. Required whenever the
   * Amazon Connect Cost Insight capability is enabled; account-wide instance
   * discovery is deliberately unsupported.
   */
  readonly amazonConnectInstanceArns?: readonly string[];
  /**
   * Exact registered AWS Config organization aggregator. Required when Config
   * compliance is enabled so aggregator reads are never account-wide.
   */
  readonly awsConfigAggregatorArn?: string;
  /**
   * Exact post-provisioning Data Export resources authorized for collection.
   * Wildcard export/table resources are not accepted in the permanent role.
   */
  readonly authorizedDataExportArns?: readonly string[];
  readonly authorizedDataExportTableArns?: readonly string[];
  readonly enabledCapabilityIds: readonly FinopsCapabilityId[];
  readonly includeProvisioner: boolean;
  readonly actionApprovals?: readonly FinopsActionApproval[];
  readonly nowIso?: string;
}

export interface FinopsPermissionPlan {
  readonly collector: FinopsRolePlan;
  readonly provisioner: FinopsRolePlan | null;
  readonly action: FinopsRolePlan | null;
  readonly enabledCapabilityIds: readonly FinopsCapabilityId[];
  readonly requiredSourceIds: readonly FinopsSourceId[];
  readonly externalPrerequisites: readonly string[];
  readonly disclaimer: string;
}

export class FinopsPermissionPlanError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "UNKNOWN_CAPABILITY"
    | "COLLECTOR_NOT_READ_ONLY"
    | "INVALID_APPROVAL"
    | "UNSUPPORTED_WRITE_CAPABILITY";

  public constructor(code: FinopsPermissionPlanError["code"], message: string) {
    super(message);
    this.name = "FinopsPermissionPlanError";
    this.code = code;
  }
}

interface SourcePermissionDefinition {
  readonly actions: readonly string[];
  readonly prerequisites?: readonly string[];
}

const SOURCE_PERMISSIONS: Readonly<Record<FinopsSourceId, SourcePermissionDefinition>> = {
  aws_cur2_data_export: {
    actions: ["s3:GetBucketLocation", "s3:GetObject", "s3:GetObjectAttributes", "s3:ListBucket"],
  },
  aws_focus_1_2_data_export: {
    actions: ["s3:GetBucketLocation", "s3:GetObject", "s3:GetObjectAttributes", "s3:ListBucket"],
  },
  trusted_advisor_organization: {
    actions: [
      "trustedadvisor:DescribeAccount",
      "trustedadvisor:DescribeAccountAccess",
      "trustedadvisor:GetOrganizationRecommendation",
      "trustedadvisor:ListChecks",
      "trustedadvisor:ListOrganizationRecommendationAccounts",
      "trustedadvisor:ListOrganizationRecommendationResources",
      "trustedadvisor:ListOrganizationRecommendations",
    ],
    prerequisites: [
      "Trusted Advisor Priority organization APIs require a qualifying AWS Support plan, Trusted Advisor Priority activation, and management or delegated-administrator access; they do not represent every standard Trusted Advisor check.",
    ],
  },
  trusted_advisor_standard_checks: {
    actions: [
      "support:DescribeTrustedAdvisorCheckResult",
      "support:DescribeTrustedAdvisorChecks",
    ],
    prerequisites: [
      "Standard Trusted Advisor checks are collected per account through the AWS Support API in us-east-1 and require a qualifying AWS Support plan.",
    ],
  },
  compute_optimizer_organization_export: {
    actions: [
      "autoscaling:DescribeAutoScalingGroups",
      "compute-optimizer:DescribeRecommendationExportJobs",
      "compute-optimizer:GetAutoScalingGroupRecommendations",
      "compute-optimizer:GetEBSVolumeRecommendations",
      "compute-optimizer:GetEC2InstanceRecommendations",
      "compute-optimizer:GetECSServiceRecommendations",
      "compute-optimizer:GetEnrollmentStatus",
      "compute-optimizer:GetEnrollmentStatusesForOrganization",
      "compute-optimizer:GetIdleRecommendations",
      "compute-optimizer:GetLambdaFunctionRecommendations",
      "compute-optimizer:GetLicenseRecommendations",
      "compute-optimizer:GetRDSDatabaseRecommendations",
      "compute-optimizer:GetRecommendationSummaries",
      "ec2:DescribeInstances",
      "ec2:DescribeVolumes",
      "ecs:ListClusters",
      "ecs:ListServices",
      "lambda:ListFunctions",
      "lambda:ListProvisionedConcurrencyConfigs",
      "organizations:ListAccounts",
      "rds:DescribeDBClusters",
      "rds:DescribeDBInstances",
      "s3:GetBucketLocation",
      "s3:GetObject",
      "s3:ListBucket",
    ],
    prerequisites: ["Compute Optimizer organization enrollment and export must be configured."],
  },
  cost_anomaly_detection: {
    actions: ["ce:GetAnomalies", "ce:GetAnomalyMonitors", "ce:GetAnomalySubscriptions"],
    prerequisites: ["AWS Cost Anomaly Detection monitors must be enabled."],
  },
  extended_support_inventory: {
    actions: [
      "elasticache:DescribeCacheClusters",
      "elasticache:DescribeCacheEngineVersions",
      "elasticache:DescribeReplicationGroups",
      "eks:DescribeCluster",
      "eks:DescribeClusterVersions",
      "eks:ListClusters",
      "es:DescribeDomain",
      "es:DescribeDomains",
      "es:ListDomainNames",
      "pricing:GetProducts",
      "rds:DescribeDBClusters",
      "rds:DescribeDBMajorEngineVersions",
      "rds:DescribeDBInstances",
      "rds:DescribeOrderableDBInstanceOptions",
    ],
  },
  aws_health_organization: {
    actions: [
      "health:DescribeAffectedAccountsForOrganization",
      "health:DescribeAffectedEntitiesForOrganization",
      "health:DescribeEventDetailsForOrganization",
      "health:DescribeEventsForOrganization",
      "health:DescribeHealthServiceStatusForOrganization",
      "organizations:DescribeOrganization",
      "organizations:ListDelegatedAdministrators",
    ],
    prerequisites: ["AWS Health Organizational View and a qualifying AWS Support plan must be enabled."],
  },
  aws_news_feeds: {
    actions: [],
    prerequisites: ["AWS public feeds are collected over bounded HTTPS endpoints and do not grant AWS account mutation access."],
  },
  aws_budgets: {
    actions: [
      "aws-portal:ViewBilling",
      "billing:GetBillingViewData",
      "budgets:DescribeBudgetActionsForBudget",
      "budgets:ViewBudget",
      "organizations:DescribeOrganization",
      "organizations:ListAccounts",
      "organizations:ListOrganizationalUnitsForParent",
      "organizations:ListParents",
      "organizations:ListRoots",
    ],
  },
  aws_support_cases_organization: {
    actions: ["support:DescribeCases", "support:DescribeCommunications"],
    prerequisites: [
      "A qualifying AWS Support plan is required. AWS Support exposes account-local cases, so organization coverage requires explicitly configured, tenant-pinned account fan-out.",
    ],
  },
  aws_resilience_hub: {
    actions: [
      "resiliencehub:DescribeApp",
      "resiliencehub:DescribeAppAssessment",
      "resiliencehub:DescribeResiliencyPolicy",
      "resiliencehub:ListAlarmRecommendations",
      "resiliencehub:ListAppAssessmentComplianceDrifts",
      "resiliencehub:ListAppAssessmentResourceDrifts",
      "resiliencehub:ListAppAssessments",
      "resiliencehub:ListAppComponentCompliances",
      "resiliencehub:ListAppComponentRecommendations",
      "resiliencehub:ListAppVersionResources",
      "resiliencehub:ListApps",
      "resiliencehub:ListResiliencyPolicies",
      "resiliencehub:ListSopRecommendations",
      "resiliencehub:ListTestRecommendations",
    ],
  },
  end_user_computing_telemetry: {
    actions: [
      "appstream:DescribeFleets",
      "appstream:DescribeSessions",
      "appstream:DescribeStacks",
      "appstream:ListAssociatedFleets",
      "cloudwatch:GetMetricData",
      "workspaces:DescribeWorkspaceBundles",
      "workspaces:DescribeWorkspaces",
      "workspaces:DescribeWorkspacesConnectionStatus",
    ],
    prerequisites: [
      "Classic AWS/WorkSpaces and AWS/AppStream GetMetricData queries require live policy simulation before CloudWatch dataset-ARN scoping can be claimed; until then metrics stay in an account/Region-bounded temporary read session.",
    ],
  },
  data_collection_telemetry: {
    actions: [
      "bcm-data-exports:GetExecution",
      "bcm-data-exports:GetExport",
      "bcm-data-exports:GetTable",
      "bcm-data-exports:ListExecutions",
      "bcm-data-exports:ListExports",
      "bcm-data-exports:ListTables",
      "cloudwatch:GetMetricData",
      "logs:DescribeLogGroups",
      "logs:DescribeLogStreams",
      "logs:GetLogEvents",
      "states:DescribeExecution",
      "states:ListExecutions",
    ],
  },
  media_services_telemetry: {
    actions: [
      "mediaconnect:DescribeFlow",
      "mediaconnect:ListFlows",
      "mediaconnect:ListTagsForResource",
      "mediaconvert:DescribeEndpoints",
      "mediaconvert:GetJob",
      "mediaconvert:GetQueue",
      "mediaconvert:ListJobs",
      "mediaconvert:ListQueues",
      "mediaconvert:ListTagsForResource",
      "medialive:DescribeChannel",
      "medialive:DescribeMultiplex",
      "medialive:DescribeOffering",
      "medialive:DescribeReservation",
      "medialive:ListChannels",
      "medialive:ListMultiplexes",
      "medialive:ListOfferings",
      "medialive:ListReservations",
      "medialive:ListTagsForResource",
      "mediapackage:DescribeChannel",
      "mediapackage:DescribeHarvestJob",
      "mediapackage:DescribeOriginEndpoint",
      "mediapackage:ListChannels",
      "mediapackage:ListHarvestJobs",
      "mediapackage:ListOriginEndpoints",
      "mediapackage:ListTagsForResource",
      "mediapackagev2:GetChannel",
      "mediapackagev2:GetChannelGroup",
      "mediapackagev2:GetHarvestJob",
      "mediapackagev2:GetOriginEndpoint",
      "mediapackagev2:ListChannelGroups",
      "mediapackagev2:ListChannels",
      "mediapackagev2:ListHarvestJobs",
      "mediapackagev2:ListOriginEndpoints",
      "mediapackagev2:ListTagsForResource",
      "mediatailor:DescribeChannel",
      "mediatailor:DescribeLiveSource",
      "mediatailor:DescribeSourceLocation",
      "mediatailor:DescribeVodSource",
      "mediatailor:GetPlaybackConfiguration",
      "mediatailor:ListAlerts",
      "mediatailor:ListChannels",
      "mediatailor:ListLiveSources",
      "mediatailor:ListPlaybackConfigurations",
      "mediatailor:ListSourceLocations",
      "mediatailor:ListTagsForResource",
      "mediatailor:ListVodSources",
    ],
    prerequisites: [
      "Media-service availability varies by Region. Inventory must be joined only to the immutable active CUR2 generation; CloudWatch/performance, audience and revenue claims require separately approved sources.",
    ],
  },
  cost_optimization_hub_export: {
    actions: [
      ...CORA_PERMANENT_HUB_READ_OPERATIONS,
      ...CORA_PERMANENT_EXPORT_READ_OPERATIONS,
      ...CORA_PERMANENT_S3_READ_OPERATIONS,
      ...CORA_ORGANIZATION_READ_OPERATIONS,
    ],
    prerequisites: [
      "Cost Optimization Hub organization enrollment and an unfiltered COST_OPTIMIZATION_RECOMMENDATIONS Data Export must be configured; filtered or de-duplicated exports remain visibly partial.",
      "AWS estimates, immutable active CUR2 observed costs, and Sutra owner/action/audit workflow evidence remain separate; recommendations are never reported as realized savings.",
    ],
  },
  aws_marketplace_intelligence: {
    actions: [
      "aws-marketplace:DescribeAgreement",
      "aws-marketplace:GetAgreementEntitlements",
      "aws-marketplace:GetAgreementTerms",
      "aws-marketplace:GetProduct",
      "aws-marketplace:ListAgreementCharges",
      "aws-marketplace:SearchAgreements",
      "license-manager:GetServiceSettings",
      "license-manager:ListReceivedGrants",
      "license-manager:ListReceivedGrantsForOrganization",
      "license-manager:ListReceivedLicenses",
      "license-manager:ListReceivedLicensesForOrganization",
      "organizations:DescribeOrganization",
      "organizations:ListAccounts",
    ],
    prerequisites: [
      "AWS Marketplace Agreement/Discovery is commercial-partition buyer evidence. Complete organization coverage requires active-account evidence, per-account acceptor collection, and License Manager organization integration; seller-only entitlements and invoice APIs are excluded.",
    ],
  },
  kubecost_allocation: {
    actions: KUBECOST_RUNTIME_S3_READ_IAM_ACTIONS,
    prerequisites: [
      "A per-cluster Kubecost or OpenCost exporter must publish the pinned raw hourly lineage contract, query hash and cost-model hash to the tenant S3 prefix.",
      "Kubecost totals are reconciled to the immutable active CUR2 generation and must never be added to CUR2 spend. Versioned objects replace GetObject with GetObjectVersion; SSE-KMS adds only exact-key kms:Decrypt.",
      "Exporter s3:PutObject and optional KMS encryption belong to a separate exporter identity, never the permanent Sutra collector.",
    ],
  },
  scad_allocation: {
    actions: SCAD_RUNTIME_S3_READ_IAM_ACTIONS,
    prerequisites: ["Split Cost Allocation Data must be enabled; AWS does not backfill data from before enablement."],
  },
  aws_carbon_footprint: {
    actions: ["s3:GetBucketLocation", "s3:GetObject", "s3:ListBucket"],
    prerequisites: [
      "AWS CARBON_EMISSIONS Data Export must be configured with sustainability:GetCarbonFootprintSummary in the one-time provisioner; routine collection remains exact-prefix S3 read-only and its cadence is monthly.",
    ],
  },
  amazon_connect_telemetry: {
    actions: AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS,
    prerequisites: [
      "Amazon Connect instance ARNs must be supplied by tenant-pinned connection state; account-wide ListInstances is excluded.",
      "ListPhoneNumbersV2 cannot be scoped to one Connect instance in IAM, so the broker must enforce the exact authorized TargetArn and discard raw phone-number records before its trust boundary.",
      "Contact-level drilldown requires tenant-scoped rotating HMAC tokens and a separately approved, expiring sensitive-data grant.",
    ],
  },
  aws_config_organization_aggregator: {
    actions: [
      ...AWS_CONFIG_AGGREGATOR_READ_OPERATIONS,
      ...AWS_CONFIG_RULE_LIFECYCLE_READ_OPERATIONS,
      ...AWS_CONFIG_RECORDER_COVERAGE_READ_OPERATIONS,
      ...AWS_CONFIG_ORGANIZATION_READ_OPERATIONS,
    ],
    prerequisites: [
      "AWS Config recording and the exact registered organization aggregator must cover every intended account and Region; incomplete source status is reported as partial, never compliant.",
      "Historical configuration-activity exports are optional and require a separately tenant-pinned S3 prefix; rule cost is reconciled only from immutable CUR2, never estimated per rule.",
    ],
  },
  aws_pricing_catalog: {
    actions: PRICING_CHANGE_READ_OPERATIONS,
    prerequisites: [
      "Pricing Change Analysis uses pinned AWS Price List Bulk API files. DescribeServices and GetAttributeValues are optional discovery only; GetProducts is not required for this bounded bulk-file path.",
    ],
  },
  aws_organizations_taxonomy: {
    actions: [
      "organizations:DescribeAccount",
      "organizations:DescribeOrganization",
      "organizations:ListAccounts",
      "organizations:ListAccountsForParent",
      "organizations:ListOrganizationalUnitsForParent",
      "organizations:ListParents",
      "organizations:ListRoots",
      "organizations:ListTagsForResource",
    ],
    prerequisites: ["AWS Organizations management or delegated-administrator read access is required for account and OU taxonomy."],
  },
  sutra_billing_workspace: {
    actions: [],
  },
};

const BASE_PROVISIONER_ACTIONS = [
  "bcm-data-exports:CreateExport",
  "bcm-data-exports:DeleteExport",
  "bcm-data-exports:GetExecution",
  "bcm-data-exports:GetExport",
  "bcm-data-exports:GetTable",
  "bcm-data-exports:ListExecutions",
  "bcm-data-exports:ListExports",
  "bcm-data-exports:ListTables",
  "bcm-data-exports:UpdateExport",
  "cur:PutReportDefinition",
  "events:DeleteRule",
  "events:DescribeRule",
  "events:ListTargetsByRule",
  "events:PutRule",
  "events:PutTargets",
  "events:RemoveTargets",
  "s3:GetBucketLocation",
  "s3:GetBucketNotification",
  "s3:GetBucketPolicy",
  "s3:PutBucketNotification",
  "s3:PutBucketPolicy",
] as const;

const WRITE_ACTIONS: Readonly<Record<FinopsWriteCapability, readonly string[]>> = {
  manage_aws_budgets: ["aws-portal:ModifyBilling", "budgets:ModifyBudget"],
  acknowledge_cost_anomaly: ["ce:UpdateAnomalySubscription"],
  update_cost_optimization_preferences: [
    "cost-optimization-hub:UpdateEnrollmentStatus",
    "cost-optimization-hub:UpdatePreferences",
  ],
};

const READ_ONLY_VERBS = new Set([
  "Describe",
  "Get",
  "List",
  "Search",
  "Select",
  "View",
]);

function assertInput(input: BuildFinopsPermissionPlanInput): number {
  if (!/^\d{12}$/u.test(input.accountId)) {
    throw new FinopsPermissionPlanError("INVALID_INPUT", "AWS account ID must contain exactly 12 digits.");
  }
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u.test(input.region)) {
    throw new FinopsPermissionPlanError("INVALID_INPUT", "AWS Region is invalid.");
  }
  if (!/^(?!\d+\.\d+\.\d+\.\d+$)(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(input.exportBucketName)) {
    throw new FinopsPermissionPlanError("INVALID_INPUT", "AWS export bucket name is invalid.");
  }
  if (
    !/^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9!_.'()/-]{1,900}\/$/u
      .test(input.exportKeyPrefix)
  ) {
    throw new FinopsPermissionPlanError(
      "INVALID_INPUT",
      "AWS export key prefix must be a relative, traversal-free S3 prefix ending in '/'.",
    );
  }
  const now = Date.parse(input.nowIso ?? new Date().toISOString());
  if (!Number.isFinite(now)) throw new FinopsPermissionPlanError("INVALID_INPUT", "Plan time is invalid.");
  return now;
}

function actionVerb(action: string): string {
  const operation = action.split(":")[1] ?? "";
  const match = /^(Describe|Get|List|Search|Select|View)/u.exec(operation);
  return match?.[1] ?? "";
}

export function assertFinopsCollectorReadOnly(statements: readonly FinopsIamStatement[]): void {
  for (const statement of statements) {
    for (const action of statement.actions) {
      if (action.includes("*") || !READ_ONLY_VERBS.has(actionVerb(action))) {
        throw new FinopsPermissionPlanError(
          "COLLECTOR_NOT_READ_ONLY",
          `Collector action ${action} is not an explicit read/list/get/describe/search/select/view permission.`,
        );
      }
    }
    if (
      statement.resources.includes("*")
      && statement.resourceScopeReason !== "service_does_not_support_resource_level_permissions"
      && statement.resourceScopeReason !== "operation_requires_account_wide_discovery"
    ) {
      throw new FinopsPermissionPlanError("COLLECTOR_NOT_READ_ONLY", "An unscoped collector resource requires an explicit service limitation.");
    }
  }
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function validatedAmazonConnectInstanceArns(
  input: BuildFinopsPermissionPlanInput,
  requiredSourceIds: readonly FinopsSourceId[],
): readonly string[] {
  if (!requiredSourceIds.includes("amazon_connect_telemetry")) return [];
  const instanceArns = uniqueSorted(input.amazonConnectInstanceArns ?? []);
  if (instanceArns.length === 0 || instanceArns.length > 100) {
    throw new FinopsPermissionPlanError(
      "INVALID_INPUT",
      "Amazon Connect Cost Insight requires 1 to 100 exact authorized instance ARNs.",
    );
  }
  const expectedPrefix =
    `arn:${input.partition}:connect:${input.region}:${input.accountId}:instance/`;
  if (instanceArns.some((arn) =>
    !arn.startsWith(expectedPrefix)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
      .test(arn.slice(expectedPrefix.length))
  )) {
    throw new FinopsPermissionPlanError(
      "INVALID_INPUT",
      "Every Amazon Connect instance ARN must match the planned partition, account, and Region.",
    );
  }
  return instanceArns;
}

function validatedAwsConfigAggregatorArn(
  input: BuildFinopsPermissionPlanInput,
  requiredSourceIds: readonly FinopsSourceId[],
): string | null {
  if (!requiredSourceIds.includes("aws_config_organization_aggregator")) return null;
  const prefix =
    `arn:${input.partition}:config:${input.region}:${input.accountId}:config-aggregator/`;
  const arn = input.awsConfigAggregatorArn ?? "";
  if (
    !arn.startsWith(prefix)
    || !/^[A-Za-z0-9_-]{1,256}$/u.test(arn.slice(prefix.length))
  ) {
    throw new FinopsPermissionPlanError(
      "INVALID_INPUT",
      "AWS Config compliance requires an exact aggregator ARN matching the planned partition, account, and Region.",
    );
  }
  return arn;
}

function validatedDataExportResourceArns(
  input: BuildFinopsPermissionPlanInput,
  actions: readonly string[],
): {
  readonly exportArns: readonly string[];
  readonly tableArns: readonly string[];
} {
  const needsExportArns = actions.some((action) =>
    action === "bcm-data-exports:GetExecution"
    || action === "bcm-data-exports:GetExport"
    || action === "bcm-data-exports:ListExecutions"
  );
  const needsTableArns = actions.includes("bcm-data-exports:GetTable");
  const exportArns = uniqueSorted(input.authorizedDataExportArns ?? []);
  const tableArns = uniqueSorted(input.authorizedDataExportTableArns ?? []);
  const exportPattern = new RegExp(
    `^arn:${input.partition}:bcm-data-exports:[a-z0-9-]+:`
    + `${input.accountId}:export\\/[A-Za-z0-9_-]{1,128}$`,
    "u",
  );
  const tablePattern = new RegExp(
    `^arn:${input.partition}:bcm-data-exports:[a-z0-9-]+:`
    + `${input.accountId}:table\\/[A-Za-z0-9_-]{1,128}$`,
    "u",
  );
  if (
    (needsExportArns
      && (exportArns.length === 0
        || exportArns.length > 100
        || exportArns.some((arn) => !exportPattern.test(arn))))
    || (needsTableArns
      && (tableArns.length === 0
        || tableArns.length > 100
        || tableArns.some((arn) => !tablePattern.test(arn))))
  ) {
    throw new FinopsPermissionPlanError(
      "INVALID_INPUT",
      "Permanent Data Export reads require exact authorized export and table ARNs for the planned account.",
    );
  }
  return { exportArns, tableArns };
}

function resourcesForActions(
  actions: readonly string[],
  partition: AwsPartition,
  accountId: string,
  region: string,
  bucketName: string,
  exportKeyPrefix: string,
): readonly string[] {
  const resources = new Set<string>();
  for (const action of actions) {
    if (action.startsWith("s3:")) {
      resources.add(`arn:${partition}:s3:::${bucketName}`);
      if (action !== "s3:GetBucketLocation" && action !== "s3:ListBucket") {
        resources.add(`arn:${partition}:s3:::${bucketName}/${exportKeyPrefix}*`);
      }
    } else if (action.startsWith("logs:")) {
      resources.add(`arn:${partition}:logs:${region}:${accountId}:log-group:/aws/sutra/*`);
    } else if (action.startsWith("states:")) {
      resources.add(`arn:${partition}:states:${region}:${accountId}:execution:sutra-finops-*:*`);
    } else {
      // Many billing/organization read APIs require Resource "*"; the action
      // list remains explicit and read-only, and the customer role/account trust
      // boundary provides the account isolation.
      resources.add("*");
    }
  }
  return [...resources].sort((left, right) => left.localeCompare(right));
}

function provisionerActionsForSources(
  requiredSourceIds: readonly FinopsSourceId[],
): readonly string[] {
  const includesCora = requiredSourceIds.includes("cost_optimization_hub_export");
  return uniqueSorted([
    ...BASE_PROVISIONER_ACTIONS,
    ...(requiredSourceIds.includes("aws_carbon_footprint")
      ? AWS_CARBON_DATA_EXPORT_ACCESS_IAM_ACTIONS
      : []),
    ...(requiredSourceIds.includes("scad_allocation")
      ? SCAD_ONE_TIME_PROVISIONER_IAM_ACTIONS
        .filter((action) => action !== "iam:CreateServiceLinkedRole")
      : []),
    ...(includesCora
      ? [
          ...CORA_ENROLLMENT_PROVISIONER_OPERATIONS,
          ...CORA_EXPORT_PROVISIONER_OPERATIONS,
        ].filter((action) => action !== "iam:CreateServiceLinkedRole")
      : []),
  ]);
}

function provisionerScopeForAction(
  action: string,
  partition: AwsPartition,
  accountId: string,
  region: string,
  bucketName: string,
): {
  readonly resources: readonly string[];
  readonly conditions?: FinopsIamStatement["conditions"];
} {
  if (action.startsWith("s3:")) {
    return { resources: [`arn:${partition}:s3:::${bucketName}`] };
  }
  if (action.startsWith("events:")) {
    return {
      resources: [`arn:${partition}:events:${region}:${accountId}:rule/sutra-finops-*`],
    };
  }
  if (
    action === "bcm-data-exports:DeleteExport"
    || action === "bcm-data-exports:GetExecution"
    || action === "bcm-data-exports:GetExport"
    || action === "bcm-data-exports:ListExecutions"
  ) {
    return {
      resources: [`arn:${partition}:bcm-data-exports:*:${accountId}:export/*`],
    };
  }
  if (action === "bcm-data-exports:GetTable") {
    return {
      resources: [`arn:${partition}:bcm-data-exports:*:${accountId}:table/*`],
    };
  }
  if (action === "bcm-data-exports:CreateExport") {
    return {
      resources: [
        `arn:${partition}:bcm-data-exports:*:${accountId}:table/*`,
        `arn:${partition}:billing::${accountId}:billingview/*`,
      ],
    };
  }
  if (action === "bcm-data-exports:UpdateExport") {
    return {
      resources: [
        `arn:${partition}:bcm-data-exports:*:${accountId}:export/*`,
        `arn:${partition}:bcm-data-exports:*:${accountId}:table/*`,
        `arn:${partition}:billing::${accountId}:billingview/*`,
      ],
    };
  }
  if (action === "bcm-data-exports:TagResource") {
    return {
      resources: [
        `arn:${partition}:bcm-data-exports:*:${accountId}:export/sutra-cora-*`,
      ],
    };
  }
  if (action === "iam:PutRolePolicy") {
    return {
      resources: [
        `arn:${partition}:iam::${accountId}:role/aws-service-role/`
        + "cost-optimization-hub.bcm.amazonaws.com/"
        + "AWSServiceRoleForCostOptimizationHub",
      ],
    };
  }
  if (action === "organizations:EnableAWSServiceAccess") {
    return {
      resources: ["*"],
      conditions: {
        StringEquals: {
          "organizations:ServicePrincipal":
            "cost-optimization-hub.bcm.amazonaws.com",
        },
      },
    };
  }
  return { resources: ["*"] };
}

function provisionerStatementsForActions(
  actions: readonly string[],
  partition: AwsPartition,
  accountId: string,
  region: string,
  bucketName: string,
): readonly FinopsIamStatement[] {
  const grouped = new Map<string, {
    readonly resources: readonly string[];
    readonly conditions?: FinopsIamStatement["conditions"];
    readonly actions: string[];
  }>();
  for (const action of actions) {
    const scope = provisionerScopeForAction(
      action,
      partition,
      accountId,
      region,
      bucketName,
    );
    const resources = uniqueSorted(scope.resources);
    const key = JSON.stringify([resources, scope.conditions ?? null]);
    const group = grouped.get(key) ?? {
      resources,
      ...(scope.conditions === undefined ? {} : { conditions: scope.conditions }),
      actions: [],
    };
    group.actions.push(action);
    grouped.set(key, group);
  }
  return [...grouped.values()]
    .sort((left, right) =>
      left.resources.join("\n").localeCompare(right.resources.join("\n"))
    )
    .map((group, index) => ({
      sid: `SutraFinopsOneTimeProvisioning${index + 1}`,
      effect: "Allow",
      actions: uniqueSorted(group.actions),
      resources: group.resources,
      ...(group.conditions === undefined ? {} : { conditions: group.conditions }),
    }));
}

function serviceLinkedRoleProvisionerStatements(
  requiredSourceIds: readonly FinopsSourceId[],
  partition: AwsPartition,
  accountId: string,
): readonly FinopsIamStatement[] {
  const services: {
    readonly serviceName: string;
    readonly roleName: string;
    readonly sid: string;
  }[] = [];
  if (requiredSourceIds.includes("cost_optimization_hub_export")) {
    services.push(
      {
        serviceName: "cost-optimization-hub.bcm.amazonaws.com",
        roleName: "AWSServiceRoleForCostOptimizationHub",
        sid: "SutraFinopsProvisionCostOptimizationHubServiceRole",
      },
      {
        serviceName: "bcm-data-exports.amazonaws.com",
        roleName: "AWSServiceRoleForBCMDataExports",
        sid: "SutraFinopsProvisionDataExportsServiceRole",
      },
    );
  }
  if (requiredSourceIds.includes("scad_allocation")) {
    services.push({
      serviceName: "split-cost-allocation-data.bcm.amazonaws.com",
      roleName: "AWSServiceRoleForSplitCostAllocationData",
      sid: "SutraFinopsProvisionSplitCostServiceRole",
    });
  }
  return services.map(({ serviceName, roleName, sid }) => ({
    sid,
    effect: "Allow",
    actions: ["iam:CreateServiceLinkedRole"],
    resources: [
      `arn:${partition}:iam::${accountId}:role/aws-service-role/`
      + `${serviceName}/${roleName}`,
    ],
    conditions: {
      StringEquals: {
        "iam:AWSServiceName": serviceName,
      },
    },
  }));
}

function collectorResourcesForAction(
  action: string,
  partition: AwsPartition,
  accountId: string,
  region: string,
  bucketName: string,
  exportKeyPrefix: string,
  amazonConnectInstanceArns: readonly string[],
  awsConfigAggregatorArn: string | null,
  authorizedDataExportArns: readonly string[],
  authorizedDataExportTableArns: readonly string[],
): {
  readonly resources: readonly string[];
  readonly conditions?: FinopsIamStatement["conditions"];
} | null {
  if (action === "s3:GetBucketLocation") {
    return { resources: [`arn:${partition}:s3:::${bucketName}`] };
  }
  if (action === "s3:ListBucket") {
    return {
      resources: [`arn:${partition}:s3:::${bucketName}`],
      conditions: {
        StringLike: {
          "s3:prefix": [
            exportKeyPrefix,
            `${exportKeyPrefix}*`,
          ],
        },
      },
    };
  }
  if (action === "s3:GetObject" || action === "s3:GetObjectAttributes") {
    return {
      resources: [`arn:${partition}:s3:::${bucketName}/${exportKeyPrefix}*`],
    };
  }
  if (action === "logs:DescribeLogStreams") {
    return {
      resources: [`arn:${partition}:logs:${region}:${accountId}:log-group:/aws/sutra/*`],
    };
  }
  if (action === "logs:GetLogEvents") {
    return {
      resources: [`arn:${partition}:logs:${region}:${accountId}:log-group:/aws/sutra/*:log-stream:*`],
    };
  }
  if (action === "states:DescribeExecution") {
    return {
      resources: [`arn:${partition}:states:${region}:${accountId}:execution:sutra-finops-*:*`],
    };
  }
  if (action === "states:ListExecutions") {
    return {
      resources: [`arn:${partition}:states:${region}:${accountId}:stateMachine:sutra-finops-*`],
    };
  }
  if (action === "budgets:ViewBudget" || action === "budgets:DescribeBudgetActionsForBudget") {
    return { resources: [`arn:${partition}:budgets::${accountId}:budget/*`] };
  }
  if (action === "billing:GetBillingViewData") {
    return { resources: [`arn:${partition}:billing::${accountId}:billingview/*`] };
  }
  if (action === "aws-marketplace:GetProduct") {
    return {
      resources: [`arn:${partition}:aws-marketplace:::catalog/AWSMarketplace/product/*`],
    };
  }
  if (
    action === "bcm-data-exports:GetExecution"
    || action === "bcm-data-exports:GetExport"
    || action === "bcm-data-exports:ListExecutions"
  ) {
    return { resources: authorizedDataExportArns };
  }
  if (action === "bcm-data-exports:GetTable") {
    return { resources: authorizedDataExportTableArns };
  }
  if (action === "eks:DescribeCluster") {
    return { resources: [`arn:${partition}:eks:${region}:${accountId}:cluster/*`] };
  }
  if (action === "es:DescribeDomain" || action === "es:DescribeDomains") {
    return { resources: [`arn:${partition}:es:${region}:${accountId}:domain/*`] };
  }
  if (
    action === "resiliencehub:DescribeApp"
    || action === "resiliencehub:DescribeAppAssessment"
    || action === "resiliencehub:ListAlarmRecommendations"
    || action === "resiliencehub:ListAppAssessmentComplianceDrifts"
    || action === "resiliencehub:ListAppAssessmentResourceDrifts"
    || action === "resiliencehub:ListAppComponentCompliances"
    || action === "resiliencehub:ListAppComponentRecommendations"
    || action === "resiliencehub:ListAppVersionResources"
    || action === "resiliencehub:ListSopRecommendations"
    || action === "resiliencehub:ListTestRecommendations"
  ) {
    return { resources: [`arn:${partition}:resiliencehub:${region}:${accountId}:app/*`] };
  }
  if (action === "resiliencehub:DescribeResiliencyPolicy") {
    return {
      resources: [`arn:${partition}:resiliencehub:${region}:${accountId}:resiliency-policy/*`],
    };
  }
  if (action === "appstream:DescribeSessions") {
    return {
      resources: [
        `arn:${partition}:appstream:${region}:${accountId}:fleet/*`,
        `arn:${partition}:appstream:${region}:${accountId}:stack/*`,
      ],
    };
  }
  if (action === "appstream:ListAssociatedFleets") {
    return {
      resources: [`arn:${partition}:appstream:${region}:${accountId}:stack/*`],
    };
  }
  if (action === "mediaconnect:DescribeFlow") {
    return {
      resources: [`arn:${partition}:mediaconnect:${region}:${accountId}:flow:*:*`],
    };
  }
  if (action === "mediaconvert:GetJob") {
    return {
      resources: [`arn:${partition}:mediaconvert:${region}:${accountId}:jobs/*`],
    };
  }
  if (action === "mediaconvert:GetQueue" || action === "mediaconvert:ListJobs") {
    return {
      resources: [`arn:${partition}:mediaconvert:${region}:${accountId}:queues/*`],
    };
  }
  if (action === "mediaconvert:ListTagsForResource") {
    return {
      resources: [
        `arn:${partition}:mediaconvert:${region}:${accountId}:jobs/*`,
        `arn:${partition}:mediaconvert:${region}:${accountId}:queues/*`,
      ],
    };
  }
  if (action === "medialive:DescribeChannel") {
    return {
      resources: [`arn:${partition}:medialive:${region}:${accountId}:channel:*`],
    };
  }
  if (action === "medialive:DescribeMultiplex") {
    return {
      resources: [`arn:${partition}:medialive:${region}:${accountId}:multiplex:*`],
    };
  }
  if (action === "medialive:DescribeOffering") {
    return {
      resources: [`arn:${partition}:medialive:${region}:${accountId}:offering:*`],
    };
  }
  if (action === "medialive:DescribeReservation") {
    return {
      resources: [`arn:${partition}:medialive:${region}:${accountId}:reservation:*`],
    };
  }
  if (action === "medialive:ListTagsForResource") {
    return {
      resources: [
        `arn:${partition}:medialive:${region}:${accountId}:channel:*`,
        `arn:${partition}:medialive:${region}:${accountId}:multiplex:*`,
        `arn:${partition}:medialive:${region}:${accountId}:reservation:*`,
      ],
    };
  }
  if (action === "mediapackage:DescribeChannel") {
    return {
      resources: [`arn:${partition}:mediapackage:${region}:${accountId}:channels/*`],
    };
  }
  if (action === "mediapackage:DescribeHarvestJob") {
    return {
      resources: [`arn:${partition}:mediapackage:${region}:${accountId}:harvest_jobs/*`],
    };
  }
  if (action === "mediapackage:DescribeOriginEndpoint") {
    return {
      resources: [`arn:${partition}:mediapackage:${region}:${accountId}:origin_endpoints/*`],
    };
  }
  if (action === "mediapackage:ListTagsForResource") {
    return {
      resources: [
        `arn:${partition}:mediapackage:${region}:${accountId}:channels/*`,
        `arn:${partition}:mediapackage:${region}:${accountId}:harvest_jobs/*`,
        `arn:${partition}:mediapackage:${region}:${accountId}:origin_endpoints/*`,
      ],
    };
  }
  const mediaPackageV2ChannelGroup =
    `arn:${partition}:mediapackagev2:${region}:${accountId}:channelGroup/*`;
  const mediaPackageV2Channel =
    `arn:${partition}:mediapackagev2:${region}:${accountId}:channelGroup/*/channel/*`;
  const mediaPackageV2OriginEndpoint =
    `arn:${partition}:mediapackagev2:${region}:${accountId}:channelGroup/*/channel/*/originEndpoint/*`;
  const mediaPackageV2HarvestJob =
    `arn:${partition}:mediapackagev2:${region}:${accountId}:channelGroup/*/channel/*/originEndpoint/*/harvestJob/*`;
  if (
    action === "mediapackagev2:GetChannelGroup"
    || action === "mediapackagev2:ListChannels"
    || action === "mediapackagev2:ListHarvestJobs"
  ) {
    return { resources: [mediaPackageV2ChannelGroup] };
  }
  if (action === "mediapackagev2:GetChannel") {
    return {
      resources: [mediaPackageV2Channel, mediaPackageV2ChannelGroup],
    };
  }
  if (action === "mediapackagev2:ListOriginEndpoints") {
    return {
      resources: [mediaPackageV2Channel, mediaPackageV2ChannelGroup],
    };
  }
  if (action === "mediapackagev2:GetOriginEndpoint") {
    return {
      resources: [
        mediaPackageV2Channel,
        mediaPackageV2ChannelGroup,
        mediaPackageV2OriginEndpoint,
      ],
    };
  }
  if (action === "mediapackagev2:GetHarvestJob") {
    return {
      resources: [
        mediaPackageV2Channel,
        mediaPackageV2ChannelGroup,
        mediaPackageV2HarvestJob,
        mediaPackageV2OriginEndpoint,
      ],
    };
  }
  if (action === "mediapackagev2:ListTagsForResource") {
    return {
      resources: [
        mediaPackageV2Channel,
        mediaPackageV2ChannelGroup,
        mediaPackageV2HarvestJob,
        mediaPackageV2OriginEndpoint,
      ],
    };
  }
  if (action === "mediatailor:GetPlaybackConfiguration") {
    return {
      resources: [`arn:${partition}:mediatailor:${region}:${accountId}:playbackConfiguration/*`],
    };
  }
  if (action === "mediatailor:DescribeChannel") {
    return {
      resources: [`arn:${partition}:mediatailor:${region}:${accountId}:channel/*`],
    };
  }
  if (action === "mediatailor:DescribeSourceLocation") {
    return {
      resources: [`arn:${partition}:mediatailor:${region}:${accountId}:sourceLocation/*`],
    };
  }
  if (action === "mediatailor:DescribeLiveSource") {
    return {
      resources: [`arn:${partition}:mediatailor:${region}:${accountId}:liveSource/*/*`],
    };
  }
  if (action === "mediatailor:DescribeVodSource") {
    return {
      resources: [`arn:${partition}:mediatailor:${region}:${accountId}:vodSource/*/*`],
    };
  }
  if (action === "mediatailor:ListTagsForResource") {
    return {
      resources: [
        `arn:${partition}:mediatailor:${region}:${accountId}:channel/*`,
        `arn:${partition}:mediatailor:${region}:${accountId}:liveSource/*/*`,
        `arn:${partition}:mediatailor:${region}:${accountId}:playbackConfiguration/*`,
        `arn:${partition}:mediatailor:${region}:${accountId}:sourceLocation/*`,
        `arn:${partition}:mediatailor:${region}:${accountId}:vodSource/*/*`,
      ],
    };
  }
  if (action === "connect:DescribeInstance") {
    return { resources: amazonConnectInstanceArns };
  }
  if (action === "connect:ListPhoneNumbersV2") {
    return { resources: [`arn:${partition}:connect:${region}:${accountId}:phone-number/*`] };
  }
  if (
    action !== "config:DescribeConfigurationAggregators"
    && AWS_CONFIG_AGGREGATOR_READ_OPERATIONS.some((operation) => operation === action)
  ) {
    return { resources: awsConfigAggregatorArn === null ? [] : [awsConfigAggregatorArn] };
  }
  if (
    action === "config:DescribeConfigurationRecorders"
    || action === "config:DescribeConfigurationRecorderStatus"
  ) {
    return {
      resources: [
        `arn:${partition}:config:${region}:${accountId}:configuration-recorder/*/*`,
      ],
    };
  }
  return null;
}

function collectorStatementsForActions(
  actions: readonly string[],
  partition: AwsPartition,
  accountId: string,
  region: string,
  bucketName: string,
  exportKeyPrefix: string,
  amazonConnectInstanceArns: readonly string[],
  awsConfigAggregatorArn: string | null,
  authorizedDataExportArns: readonly string[],
  authorizedDataExportTableArns: readonly string[],
): readonly FinopsIamStatement[] {
  const scoped = new Map<string, {
    readonly resources: readonly string[];
    readonly conditions?: FinopsIamStatement["conditions"];
    readonly actions: string[];
  }>();
  const global: string[] = [];
  for (const action of actions) {
    const scope = collectorResourcesForAction(
      action,
      partition,
      accountId,
      region,
      bucketName,
      exportKeyPrefix,
      amazonConnectInstanceArns,
      awsConfigAggregatorArn,
      authorizedDataExportArns,
      authorizedDataExportTableArns,
    );
    if (scope === null) {
      global.push(action);
      continue;
    }
    const sortedResources = uniqueSorted(scope.resources);
    const key = JSON.stringify([sortedResources, scope.conditions ?? null]);
    const group = scoped.get(key) ?? {
      resources: sortedResources,
      ...(scope.conditions === undefined ? {} : { conditions: scope.conditions }),
      actions: [],
    };
    group.actions.push(action);
    scoped.set(key, group);
  }
  const statements: FinopsIamStatement[] = [...scoped.values()]
    .sort((left, right) => left.resources.join("\n").localeCompare(right.resources.join("\n")))
    .map((group, index) => ({
      sid: `SutraFinopsReadOnlyScopedEvidence${index + 1}`,
      effect: "Allow",
      actions: uniqueSorted(group.actions),
      resources: group.resources,
      ...(group.conditions === undefined ? {} : { conditions: group.conditions }),
    }));
  if (global.length > 0) {
    statements.push({
      sid: "SutraFinopsReadOnlyGlobalServiceEvidence",
      effect: "Allow",
      actions: uniqueSorted(global),
      resources: ["*"],
      resourceScopeReason: "operation_requires_account_wide_discovery",
    });
  }
  return statements;
}

function validatedApprovals(
  approvals: readonly FinopsActionApproval[],
  now: number,
): readonly FinopsActionApproval[] {
  const approved: FinopsActionApproval[] = [];
  const seen = new Set<FinopsWriteCapability>();
  for (const approval of approvals) {
    if (!(approval.capability in WRITE_ACTIONS)) {
      throw new FinopsPermissionPlanError("UNSUPPORTED_WRITE_CAPABILITY", "The requested FinOps write capability is unsupported.");
    }
    const approvedAt = Date.parse(approval.approvedAtIso);
    const expiresAt = Date.parse(approval.expiresAtIso);
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u.test(approval.approvedBy)
      || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/u.test(approval.changeTicket)
      || !Number.isFinite(approvedAt)
      || !Number.isFinite(expiresAt)
      || approvedAt > now
      || expiresAt <= now
      || expiresAt - approvedAt > 31 * 24 * 60 * 60 * 1_000
      || seen.has(approval.capability)
    ) {
      throw new FinopsPermissionPlanError("INVALID_APPROVAL", "Write approval must be unique, current, attributable, ticketed, and expire within 31 days.");
    }
    seen.add(approval.capability);
    approved.push(approval);
  }
  return approved;
}

export function buildFinopsPermissionPlan(input: BuildFinopsPermissionPlanInput): FinopsPermissionPlan {
  const now = assertInput(input);
  const definitions = new Map(FINOPS_CAPABILITY_DEFINITIONS.map((definition) => [definition.id, definition]));
  const enabledCapabilityIds = uniqueSorted(input.enabledCapabilityIds) as readonly FinopsCapabilityId[];
  if (enabledCapabilityIds.length === 0 || enabledCapabilityIds.some((id) => !definitions.has(id))) {
    throw new FinopsPermissionPlanError("UNKNOWN_CAPABILITY", "At least one known FinOps capability is required.");
  }
  const requiredSourceIds = uniqueSorted(enabledCapabilityIds.flatMap((id) => {
    const definition = definitions.get(id);
    return definition === undefined ? [] : [...definition.requiredSourceIds, ...definition.supplementalSourceIds];
  })) as readonly FinopsSourceId[];
  const actions = uniqueSorted(requiredSourceIds.flatMap((sourceId) => SOURCE_PERMISSIONS[sourceId].actions));
  const amazonConnectInstanceArns = validatedAmazonConnectInstanceArns(
    input,
    requiredSourceIds,
  );
  const awsConfigAggregatorArn = validatedAwsConfigAggregatorArn(
    input,
    requiredSourceIds,
  );
  const {
    exportArns: authorizedDataExportArns,
    tableArns: authorizedDataExportTableArns,
  } = validatedDataExportResourceArns(input, actions);
  const collectorStatements = collectorStatementsForActions(
    actions,
    input.partition,
    input.accountId,
    input.region,
    input.exportBucketName,
    input.exportKeyPrefix,
    amazonConnectInstanceArns,
    awsConfigAggregatorArn,
    authorizedDataExportArns,
    authorizedDataExportTableArns,
  );
  assertFinopsCollectorReadOnly(collectorStatements);

  const provisionerActions = provisionerActionsForSources(requiredSourceIds);
  const provisioner = input.includeProvisioner
    ? {
        boundary: "provisioner" as const,
        roleName: "SutraFinopsProvisionerRole",
        statements: provisionerStatementsForActions(
          provisionerActions,
          input.partition,
          input.accountId,
          input.region,
          input.exportBucketName,
        ).concat(serviceLinkedRoleProvisionerStatements(
          requiredSourceIds,
          input.partition,
          input.accountId,
        )),
      }
    : null;

  const approvals = validatedApprovals(input.actionApprovals ?? [], now);
  const actionActions = uniqueSorted(approvals.flatMap((approval) => WRITE_ACTIONS[approval.capability]));
  const action = actionActions.length === 0
    ? null
    : {
        boundary: "action" as const,
        roleName: "SutraFinopsApprovedActionRole",
        statements: [{
          sid: "SutraFinopsTimeBoundApprovedActions",
          effect: "Allow" as const,
          actions: actionActions,
          resources: resourcesForActions(
            actionActions,
            input.partition,
            input.accountId,
            input.region,
            input.exportBucketName,
            input.exportKeyPrefix,
          ),
        }],
      };

  return {
    collector: {
      boundary: "collector",
      roleName: "SutraFinopsCollectorRole",
      statements: collectorStatements,
    },
    provisioner,
    action,
    enabledCapabilityIds,
    requiredSourceIds,
    externalPrerequisites: uniqueSorted(requiredSourceIds.flatMap((sourceId) => SOURCE_PERMISSIONS[sourceId].prerequisites ?? [])),
    disclaimer: "The collector is read-only. Provisioning and approved write actions use separate roles and must never be merged into the collector policy.",
  };
}
