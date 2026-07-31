/**
 * Server-owned runtime registry for the 27 AWS Cloud Intelligence Dashboard
 * capabilities.
 *
 * This module is policy, not a browser request model. A client may select only
 * a canonical capability ID. AWS operations, endpoints, ARNs, account scope,
 * resource scope, pagination, deadlines, and filters are resolved exclusively
 * from this deeply frozen server registry and persisted tenant connection
 * state.
 */
import {
  FINOPS_CAPABILITY_DEFINITIONS,
  FINOPS_SOURCE_DEFINITIONS,
  type FinopsCapabilityId,
  type FinopsSourceId,
} from "./finops-source-health.ts";

export type FinopsRuntimeTransport =
  | "aws_api_broker"
  | "bounded_s3_export"
  | "public_https_allowlist"
  | "persisted_internal";

export interface FinopsRuntimeCodeReference {
  readonly modulePath: `./finops-${string}.ts`;
  readonly exportName: string;
}

export type FinopsRuntimeOperationSet =
  | {
      readonly kind: "fixed_operations";
      readonly operations: readonly string[];
    }
  | {
      readonly kind: "code_references";
      readonly references: readonly FinopsRuntimeCodeReference[];
    }
  | {
      readonly kind: "no_provider_operation";
      readonly reason: "persisted_tenant_evidence";
    };

export interface FinopsRuntimeQueryContract {
  readonly contractId: string;
  readonly transport: FinopsRuntimeTransport;
  readonly operationSet: FinopsRuntimeOperationSet;
  /** Browser/job payloads cannot add provider request fields. */
  readonly clientControlledFields: readonly [];
  readonly tenantScopeBinding: "persisted_org_customer_connection";
  readonly accountScopeBinding: "persisted_connection_accounts_only";
  readonly endpointBinding: "server_sdk_or_allowlist_only";
  readonly arnBinding: "persisted_authorization_only";
  readonly filterBinding: "registered_query_only";
}

export type FinopsRuntimeEvidenceAdapter =
  | {
      readonly kind: "code_reference";
      readonly reference: FinopsRuntimeCodeReference;
    }
  | {
      readonly kind: "deferred";
      readonly reasonCode:
        | "SOURCE_EVIDENCE_ADAPTER_NOT_IMPLEMENTED"
        | "COMPOSITE_PERSISTENCE_ADAPTER_NOT_IMPLEMENTED";
    };

export interface FinopsSourceRuntimeBinding {
  readonly sourceId: FinopsSourceId;
  readonly sourceHealthId: FinopsSourceId;
  readonly freshnessSlaHours: number;
  readonly queryContract: FinopsRuntimeQueryContract;
  readonly evidenceAdapter: FinopsRuntimeEvidenceAdapter;
}

export type FinopsRuntimeProcessorBinding =
  | {
      readonly kind: "normalizer_and_report_builder";
      readonly normalizer: FinopsRuntimeCodeReference;
      readonly reportBuilder: FinopsRuntimeCodeReference;
    }
  | {
      readonly kind: "report_builder";
      readonly reportBuilder: FinopsRuntimeCodeReference;
    }
  | {
      readonly kind: "deferred";
      readonly availableNormalizer?: FinopsRuntimeCodeReference;
      readonly reasonCode:
        | "CAPABILITY_REPORT_BINDING_NOT_IMPLEMENTED"
        | "CAPABILITY_PERSISTENCE_BINDING_NOT_IMPLEMENTED";
    };

export interface FinopsRuntimeBounds {
  readonly maxPages: number;
  readonly maxBytes: number;
  readonly maxRecords: number;
  readonly maxConcurrency: number;
  readonly deadlineMs: number;
}

export interface FinopsCapabilityRuntimeEntry {
  readonly capabilityId: FinopsCapabilityId;
  readonly capabilityUiKey: string;
  readonly capabilityQueryContractId: string;
  readonly requiredSourceIds: readonly FinopsSourceId[];
  readonly supplementalSourceIds: readonly FinopsSourceId[];
  readonly sourceBindings: readonly FinopsSourceRuntimeBinding[];
  readonly processor: FinopsRuntimeProcessorBinding;
  readonly bounds: FinopsRuntimeBounds;
}

export class FinopsRuntimeRegistryError extends Error {
  public readonly code:
    | "MUTABLE_REGISTRY"
    | "UNKNOWN_CAPABILITY"
    | "DUPLICATE_CAPABILITY"
    | "INCOMPLETE_REGISTRY"
    | "SOURCE_CONTRACT_MISMATCH"
    | "UNSAFE_QUERY_CONTRACT"
    | "INVALID_CLIENT_REQUEST";

  public constructor(code: FinopsRuntimeRegistryError["code"]) {
    super("FinOps runtime registry request rejected");
    this.name = "FinopsRuntimeRegistryError";
    this.code = code;
  }
}

const CODE_REFERENCE = /^\.\/finops-[a-z0-9-]+\.ts#[A-Z_a-z][A-Za-z0-9_]*$/u;
const CONTRACT_ID = /^sutra\.finops\.[a-z0-9_.-]+\.v1$/u;
const UI_KEY = /^finops\.(?:foundational|advanced|additional)\.[a-z0-9_]+$/u;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,127}$/u;
const MAX_RUNTIME_PAGES = 10_000;
const MAX_RUNTIME_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RUNTIME_RECORDS = 5_000_000;
const MAX_RUNTIME_CONCURRENCY = 32;
const MAX_RUNTIME_DEADLINE_MS = 15 * 60 * 1_000;

function ref(modulePath: FinopsRuntimeCodeReference["modulePath"], exportName: string): FinopsRuntimeCodeReference {
  return { modulePath, exportName };
}

function referencedOperationSet(
  ...references: readonly FinopsRuntimeCodeReference[]
): FinopsRuntimeOperationSet {
  return { kind: "code_references", references };
}

function fixedOperationSet(...operations: readonly string[]): FinopsRuntimeOperationSet {
  return { kind: "fixed_operations", operations };
}

function query(
  contractId: string,
  transport: FinopsRuntimeTransport,
  operationSet: FinopsRuntimeOperationSet,
): FinopsRuntimeQueryContract {
  return {
    contractId,
    transport,
    operationSet,
    clientControlledFields: [],
    tenantScopeBinding: "persisted_org_customer_connection",
    accountScopeBinding: "persisted_connection_accounts_only",
    endpointBinding: "server_sdk_or_allowlist_only",
    arnBinding: "persisted_authorization_only",
    filterBinding: "registered_query_only",
  };
}

function sourceFreshness(sourceId: FinopsSourceId): number {
  const definition = FINOPS_SOURCE_DEFINITIONS.find((candidate) => candidate.id === sourceId);
  if (definition === undefined) throw new FinopsRuntimeRegistryError("SOURCE_CONTRACT_MISMATCH");
  return definition.freshnessSlaHours;
}

function source(
  sourceId: FinopsSourceId,
  queryContract: FinopsRuntimeQueryContract,
  evidenceAdapter: FinopsRuntimeEvidenceAdapter,
): FinopsSourceRuntimeBinding {
  return {
    sourceId,
    sourceHealthId: sourceId,
    freshnessSlaHours: sourceFreshness(sourceId),
    queryContract,
    evidenceAdapter,
  };
}

const PERSISTED_EVIDENCE_ADAPTER: FinopsRuntimeEvidenceAdapter = {
  kind: "code_reference",
  reference: ref("./finops-source-health-evidence.ts", "buildPersistedFinopsSourceEvidence"),
};

const DEFERRED_SOURCE_ADAPTER: FinopsRuntimeEvidenceAdapter = {
  kind: "deferred",
  reasonCode: "SOURCE_EVIDENCE_ADAPTER_NOT_IMPLEMENTED",
};

function evidenceAdapter(
  modulePath: FinopsRuntimeCodeReference["modulePath"],
  exportName: string,
): FinopsRuntimeEvidenceAdapter {
  return { kind: "code_reference", reference: ref(modulePath, exportName) };
}

const SOURCE_RUNTIME_BINDINGS = {
  aws_cur2_data_export: source(
    "aws_cur2_data_export",
    query(
      "sutra.finops.source.aws_cur2_data_export.v1",
      "bounded_s3_export",
      fixedOperationSet("s3:GetBucketLocation", "s3:GetObject", "s3:GetObjectAttributes", "s3:ListBucket"),
    ),
    PERSISTED_EVIDENCE_ADAPTER,
  ),
  aws_focus_1_2_data_export: source(
    "aws_focus_1_2_data_export",
    query(
      "sutra.finops.source.aws_focus_1_2_data_export.v1",
      "bounded_s3_export",
      fixedOperationSet("s3:GetBucketLocation", "s3:GetObject", "s3:GetObjectAttributes", "s3:ListBucket"),
    ),
    PERSISTED_EVIDENCE_ADAPTER,
  ),
  trusted_advisor_organization: source(
    "trusted_advisor_organization",
    query(
      "sutra.finops.source.trusted_advisor_organization.v1",
      "aws_api_broker",
      referencedOperationSet(ref("./finops-trusted-advisor-organization.ts", "TRUSTED_ADVISOR_ORGANIZATION_API_OPERATIONS")),
    ),
    evidenceAdapter("./finops-trusted-advisor-organization.ts", "trustedAdvisorOrganizationSourceEvidence"),
  ),
  compute_optimizer_organization_export: source(
    "compute_optimizer_organization_export",
    query(
      "sutra.finops.source.compute_optimizer_organization_export.v1",
      "aws_api_broker",
      referencedOperationSet(ref("./finops-compute-optimizer-organization.ts", "COMPUTE_OPTIMIZER_READ_OPERATIONS")),
    ),
    evidenceAdapter("./finops-compute-optimizer-organization.ts", "computeOptimizerOrganizationSourceEvidence"),
  ),
  cost_anomaly_detection: source(
    "cost_anomaly_detection",
    query(
      "sutra.finops.source.cost_anomaly_detection.v1",
      "aws_api_broker",
      referencedOperationSet(ref("./finops-aws-cost-anomaly.ts", "createCostAnomalyQueryService")),
    ),
    evidenceAdapter("./finops-aws-cost-anomaly.ts", "buildAwsCostAnomalySourceEvidence"),
  ),
  extended_support_inventory: source(
    "extended_support_inventory",
    query(
      "sutra.finops.source.extended_support_inventory.v1",
      "aws_api_broker",
      referencedOperationSet(ref("./finops-extended-support-projection.ts", "EXTENDED_SUPPORT_READ_OPERATIONS")),
    ),
    DEFERRED_SOURCE_ADAPTER,
  ),
  aws_health_organization: source(
    "aws_health_organization",
    query(
      "sutra.finops.source.aws_health_organization.v1",
      "aws_api_broker",
      referencedOperationSet(ref("./finops-aws-health-organization.ts", "AWS_HEALTH_ORGANIZATION_READ_OPERATIONS")),
    ),
    evidenceAdapter("./finops-aws-health-organization.ts", "awsHealthOrganizationSourceEvidence"),
  ),
  aws_news_feeds: source(
    "aws_news_feeds",
    query(
      "sutra.finops.source.aws_news_feeds.v1",
      "public_https_allowlist",
      referencedOperationSet(
        ref("./finops-aws-news-feeds.ts", "AWS_NEWS_FEED_SOURCES"),
        ref("./finops-aws-news-feeds.ts", "assertAwsNewsFeedRequestTarget"),
      ),
    ),
    evidenceAdapter("./finops-aws-news-feeds.ts", "awsNewsFeedsSourceEvidence"),
  ),
  aws_budgets: source(
    "aws_budgets",
    query(
      "sutra.finops.source.aws_budgets.v1",
      "aws_api_broker",
      referencedOperationSet(ref("./finops-aws-budgets-organization.ts", "AWS_BUDGETS_READ_API_OPERATIONS")),
    ),
    evidenceAdapter("./finops-aws-budgets-organization.ts", "awsBudgetsOrganizationSourceEvidence"),
  ),
  aws_support_cases_organization: source(
    "aws_support_cases_organization",
    query(
      "sutra.finops.source.aws_support_cases_organization.v1",
      "aws_api_broker",
      referencedOperationSet(ref("./finops-aws-support-cases-radar.ts", "AWS_SUPPORT_CASES_READ_OPERATIONS")),
    ),
    evidenceAdapter("./finops-aws-support-cases-radar.ts", "awsSupportCasesSourceEvidence"),
  ),
  aws_resilience_hub: source(
    "aws_resilience_hub",
    query(
      "sutra.finops.source.aws_resilience_hub.v1",
      "aws_api_broker",
      referencedOperationSet(ref("./finops-resilience-vue.ts", "RESILIENCE_VUE_READ_OPERATIONS")),
    ),
    evidenceAdapter("./finops-resilience-vue.ts", "resilienceVueSourceEvidence"),
  ),
  end_user_computing_telemetry: source(
    "end_user_computing_telemetry",
    query(
      "sutra.finops.source.end_user_computing_telemetry.v1",
      "aws_api_broker",
      referencedOperationSet(ref("./finops-end-user-computing.ts", "END_USER_COMPUTING_READ_OPERATIONS")),
    ),
    evidenceAdapter("./finops-end-user-computing.ts", "endUserComputingSourceEvidence"),
  ),
  data_collection_telemetry: source(
    "data_collection_telemetry",
    query(
      "sutra.finops.source.data_collection_telemetry.v1",
      "aws_api_broker",
      fixedOperationSet(
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
      ),
    ),
    PERSISTED_EVIDENCE_ADAPTER,
  ),
  media_services_telemetry: source(
    "media_services_telemetry",
    query(
      "sutra.finops.source.media_services_telemetry.v1",
      "aws_api_broker",
      referencedOperationSet(ref("./finops-media-services-insights.ts", "MEDIA_SERVICES_INSIGHTS_READ_OPERATIONS")),
    ),
    evidenceAdapter("./finops-media-services-insights.ts", "mediaServicesSourceEvidence"),
  ),
  cost_optimization_hub_export: source(
    "cost_optimization_hub_export",
    query(
      "sutra.finops.source.cost_optimization_hub_export.v1",
      "bounded_s3_export",
      referencedOperationSet(
        ref("./finops-cora.ts", "CORA_PERMANENT_HUB_READ_OPERATIONS"),
        ref("./finops-cora.ts", "CORA_PERMANENT_EXPORT_READ_OPERATIONS"),
        ref("./finops-cora.ts", "CORA_PERMANENT_S3_READ_OPERATIONS"),
        ref("./finops-cora.ts", "CORA_ORGANIZATION_READ_OPERATIONS"),
      ),
    ),
    evidenceAdapter("./finops-cora.ts", "coraSourceEvidence"),
  ),
  aws_marketplace_intelligence: source(
    "aws_marketplace_intelligence",
    query(
      "sutra.finops.source.aws_marketplace_intelligence.v1",
      "aws_api_broker",
      referencedOperationSet(
        ref("./finops-marketplace-spg.ts", "AWS_MARKETPLACE_BUYER_API_OPERATIONS"),
        ref("./finops-marketplace-spg.ts", "AWS_MARKETPLACE_LICENSE_MANAGER_API_OPERATIONS"),
      ),
    ),
    evidenceAdapter("./finops-marketplace-spg.ts", "awsMarketplaceSpgSourceEvidence"),
  ),
  kubecost_allocation: source(
    "kubecost_allocation",
    query(
      "sutra.finops.source.kubecost_allocation.v1",
      "bounded_s3_export",
      referencedOperationSet(ref("./finops-kubecost-allocation.ts", "KUBECOST_RUNTIME_S3_READ_IAM_ACTIONS")),
    ),
    evidenceAdapter("./finops-kubecost-allocation.ts", "kubecostAllocationSourceEvidence"),
  ),
  scad_allocation: source(
    "scad_allocation",
    query(
      "sutra.finops.source.scad_allocation.v1",
      "bounded_s3_export",
      referencedOperationSet(ref("./finops-scad-allocation.ts", "SCAD_RUNTIME_S3_READ_IAM_ACTIONS")),
    ),
    evidenceAdapter("./finops-scad-allocation.ts", "scadAllocationSourceEvidence"),
  ),
  aws_carbon_footprint: source(
    "aws_carbon_footprint",
    query(
      "sutra.finops.source.aws_carbon_footprint.v1",
      "bounded_s3_export",
      referencedOperationSet(ref("./finops-sustainability-carbon.ts", "AWS_CARBON_DATA_EXPORT_ACCESS_IAM_ACTIONS")),
    ),
    evidenceAdapter("./finops-sustainability-carbon.ts", "sustainabilityCarbonSourceEvidence"),
  ),
  amazon_connect_telemetry: source(
    "amazon_connect_telemetry",
    query(
      "sutra.finops.source.amazon_connect_telemetry.v1",
      "aws_api_broker",
      referencedOperationSet(ref("./finops-amazon-connect-cost-insight.ts", "AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS")),
    ),
    evidenceAdapter("./finops-amazon-connect-cost-insight.ts", "amazonConnectCostInsightSourceEvidence"),
  ),
  aws_config_organization_aggregator: source(
    "aws_config_organization_aggregator",
    query(
      "sutra.finops.source.aws_config_organization_aggregator.v1",
      "aws_api_broker",
      referencedOperationSet(
        ref("./finops-aws-config-compliance.ts", "AWS_CONFIG_AGGREGATOR_READ_OPERATIONS"),
        ref("./finops-aws-config-compliance.ts", "AWS_CONFIG_RULE_LIFECYCLE_READ_OPERATIONS"),
        ref("./finops-aws-config-compliance.ts", "AWS_CONFIG_RECORDER_COVERAGE_READ_OPERATIONS"),
        ref("./finops-aws-config-compliance.ts", "AWS_CONFIG_ORGANIZATION_READ_OPERATIONS"),
      ),
    ),
    evidenceAdapter("./finops-aws-config-compliance.ts", "awsConfigComplianceSourceEvidence"),
  ),
  aws_pricing_catalog: source(
    "aws_pricing_catalog",
    query(
      "sutra.finops.source.aws_pricing_catalog.v1",
      "aws_api_broker",
      referencedOperationSet(ref("./finops-pricing-change-analysis.ts", "PRICING_CHANGE_READ_OPERATIONS")),
    ),
    DEFERRED_SOURCE_ADAPTER,
  ),
  aws_organizations_taxonomy: source(
    "aws_organizations_taxonomy",
    query(
      "sutra.finops.source.aws_organizations_taxonomy.v1",
      "aws_api_broker",
      fixedOperationSet(
        "organizations:DescribeAccount",
        "organizations:DescribeOrganization",
        "organizations:ListAccounts",
        "organizations:ListAccountsForParent",
        "organizations:ListOrganizationalUnitsForParent",
        "organizations:ListParents",
        "organizations:ListRoots",
        "organizations:ListTagsForResource",
      ),
    ),
    DEFERRED_SOURCE_ADAPTER,
  ),
  sutra_billing_workspace: source(
    "sutra_billing_workspace",
    query(
      "sutra.finops.source.sutra_billing_workspace.v1",
      "persisted_internal",
      { kind: "no_provider_operation", reason: "persisted_tenant_evidence" },
    ),
    PERSISTED_EVIDENCE_ADAPTER,
  ),
} as const satisfies Readonly<Record<FinopsSourceId, FinopsSourceRuntimeBinding>>;

function bounds(
  maxPages: number,
  maxBytes: number,
  maxRecords: number,
  maxConcurrency: number,
  deadlineMs: number,
): FinopsRuntimeBounds {
  return { maxPages, maxBytes, maxRecords, maxConcurrency, deadlineMs };
}

const BILLING_BOUNDS = bounds(2_000, 1024 * 1024 * 1024, 2_000_000, 8, 5 * 60 * 1_000);
const API_BOUNDS = bounds(2_000, 256 * 1024 * 1024, 500_000, 8, 2 * 60 * 1_000);
const HEAVY_API_BOUNDS = bounds(5_000, 1024 * 1024 * 1024, 2_000_000, 16, 5 * 60 * 1_000);
const INTERNAL_BOUNDS = bounds(100, 64 * 1024 * 1024, 100_000, 4, 30 * 1_000);

function processor(
  modulePath: FinopsRuntimeCodeReference["modulePath"],
  reportBuilder: string,
): FinopsRuntimeProcessorBinding {
  return { kind: "report_builder", reportBuilder: ref(modulePath, reportBuilder) };
}

function pipeline(
  modulePath: FinopsRuntimeCodeReference["modulePath"],
  normalizer: string,
  reportBuilder: string,
): FinopsRuntimeProcessorBinding {
  return {
    kind: "normalizer_and_report_builder",
    normalizer: ref(modulePath, normalizer),
    reportBuilder: ref(modulePath, reportBuilder),
  };
}

function deferred(
  modulePath?: FinopsRuntimeCodeReference["modulePath"],
  availableNormalizer?: string,
): FinopsRuntimeProcessorBinding {
  return {
    kind: "deferred",
    ...(modulePath !== undefined && availableNormalizer !== undefined
      ? { availableNormalizer: ref(modulePath, availableNormalizer) }
      : {}),
    reasonCode: "CAPABILITY_REPORT_BINDING_NOT_IMPLEMENTED",
  };
}

function capabilityEntry(
  capabilityId: FinopsCapabilityId,
  capabilityUiKey: string,
  runtimeBounds: FinopsRuntimeBounds,
  processorBinding: FinopsRuntimeProcessorBinding,
): FinopsCapabilityRuntimeEntry {
  const definition = FINOPS_CAPABILITY_DEFINITIONS.find((candidate) => candidate.id === capabilityId);
  if (definition === undefined) throw new FinopsRuntimeRegistryError("UNKNOWN_CAPABILITY");
  const sourceIds = [...definition.requiredSourceIds, ...definition.supplementalSourceIds];
  return {
    capabilityId,
    capabilityUiKey,
    capabilityQueryContractId: `sutra.finops.capability.${capabilityId}.v1`,
    requiredSourceIds: definition.requiredSourceIds,
    supplementalSourceIds: definition.supplementalSourceIds,
    sourceBindings: sourceIds.map((sourceId) => SOURCE_RUNTIME_BINDINGS[sourceId]),
    processor: processorBinding,
    bounds: runtimeBounds,
  };
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function isDeeplyFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return true;
  if (seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Object.values(value as Record<string, unknown>).every((child) => isDeeplyFrozen(child, seen));
}

const REGISTRY_DATA = deepFreeze([
  capabilityEntry("cudos", "finops.foundational.cudos", BILLING_BOUNDS, processor("./finops-cudos.ts", "buildFinopsCudosDashboard")),
  capabilityEntry("cost_intelligence_dashboard", "finops.foundational.cost_intelligence", BILLING_BOUNDS, processor("./finops-cost-intelligence.ts", "buildFinopsCostIntelligence")),
  capabilityEntry("kpi_dashboard", "finops.foundational.kpi", BILLING_BOUNDS, processor("./finops-kpi.ts", "evaluateFinopsKpis")),
  capabilityEntry("trusted_advisor_organizational", "finops.advanced.trusted_advisor", API_BOUNDS, pipeline("./finops-trusted-advisor-organization.ts", "normalizeTrustedAdvisorOrganizationCapture", "buildTrustedAdvisorOrganizationDashboard")),
  capabilityEntry("compute_optimizer", "finops.advanced.compute_optimizer", HEAVY_API_BOUNDS, pipeline("./finops-compute-optimizer-organization.ts", "normalizeComputeOptimizerOrganizationCapture", "buildComputeOptimizerDashboard")),
  capabilityEntry("cost_anomaly", "finops.advanced.cost_anomaly", API_BOUNDS, pipeline("./finops-aws-cost-anomaly.ts", "parseAwsCostAnomalyCollection", "buildCostAnomalyDashboard")),
  capabilityEntry("extended_support_projection", "finops.advanced.extended_support", HEAVY_API_BOUNDS, processor("./finops-extended-support-projection.ts", "buildExtendedSupportProjection")),
  capabilityEntry("graviton_savings", "finops.advanced.graviton_savings", HEAVY_API_BOUNDS, processor("./finops-graviton-savings.ts", "buildGravitonSavingsSnapshot")),
  capabilityEntry("health_events", "finops.advanced.health_events", API_BOUNDS, pipeline("./finops-aws-health-organization.ts", "normalizeAwsHealthOrganizationCapture", "buildAwsHealthOrganizationDashboard")),
  capabilityEntry("aws_news_feeds", "finops.advanced.aws_news", API_BOUNDS, deferred("./finops-aws-news-feeds.ts", "normalizeAwsNewsFeedsCapture")),
  capabilityEntry("aws_budgets", "finops.advanced.aws_budgets", API_BOUNDS, pipeline("./finops-aws-budgets-organization.ts", "normalizeAwsBudgetsCapture", "buildAwsBudgetsOrganizationDashboard")),
  capabilityEntry("support_cases_radar", "finops.advanced.support_cases", API_BOUNDS, pipeline("./finops-aws-support-cases-radar.ts", "normalizeAwsSupportCasesCapture", "buildAwsSupportCasesRadar")),
  capabilityEntry("resiliencevue", "finops.advanced.resiliencevue", HEAVY_API_BOUNDS, pipeline("./finops-resilience-vue.ts", "normalizeResilienceVueCapture", "buildResilienceVueDashboard")),
  capabilityEntry("end_user_computing", "finops.advanced.end_user_computing", HEAVY_API_BOUNDS, pipeline("./finops-end-user-computing.ts", "normalizeEndUserComputingCapture", "buildEndUserComputingDashboard")),
  capabilityEntry("data_collection_monitor", "finops.advanced.data_collection_monitor", INTERNAL_BOUNDS, processor("./finops-source-health.ts", "buildFinopsSourceReadiness")),
  capabilityEntry("media_services_insights", "finops.advanced.media_services", HEAVY_API_BOUNDS, pipeline("./finops-media-services-insights.ts", "normalizeMediaServicesCapture", "buildMediaServicesDashboard")),
  capabilityEntry("cora", "finops.additional.cora", BILLING_BOUNDS, deferred("./finops-cora.ts", "normalizeCoraCapture")),
  capabilityEntry("focus", "finops.additional.focus", BILLING_BOUNDS, deferred("./finops-cur.ts", "parseCurCsv")),
  capabilityEntry("marketplace_spg", "finops.additional.marketplace_spg", HEAVY_API_BOUNDS, deferred("./finops-marketplace-spg.ts", "normalizeAwsMarketplaceSpgCapture")),
  capabilityEntry("kubecost_container_allocation", "finops.additional.kubecost", BILLING_BOUNDS, processor("./finops-kubecost-allocation.ts", "buildKubecostAllocationSnapshot")),
  capabilityEntry("scad_container_allocation", "finops.additional.scad", BILLING_BOUNDS, processor("./finops-scad-allocation.ts", "buildScadAllocationSnapshot")),
  capabilityEntry("sustainability_proxy", "finops.additional.sustainability", BILLING_BOUNDS, pipeline("./finops-sustainability-carbon.ts", "normalizeSustainabilityCarbonCapture", "buildSustainabilityCarbonDashboard")),
  capabilityEntry("trends", "finops.additional.trends", BILLING_BOUNDS, processor("./finops-trends-intelligence.ts", "buildFinopsTrendsIntelligence")),
  capabilityEntry("data_transfer", "finops.additional.data_transfer", BILLING_BOUNDS, processor("./finops-data-transfer.ts", "buildDataTransferAnalysis")),
  capabilityEntry("amazon_connect_cost_insights", "finops.additional.amazon_connect", HEAVY_API_BOUNDS, pipeline("./finops-amazon-connect-cost-insight.ts", "normalizeAmazonConnectCostInsightCapture", "buildAmazonConnectCostInsightDashboard")),
  capabilityEntry("config_resource_compliance", "finops.additional.config_compliance", HEAVY_API_BOUNDS, deferred("./finops-aws-config-compliance.ts", "normalizeAwsConfigComplianceCapture")),
  capabilityEntry("pricing_change", "finops.additional.pricing_change", BILLING_BOUNDS, processor("./finops-pricing-change-analysis.ts", "buildPricingChangeAnalysis")),
] satisfies readonly FinopsCapabilityRuntimeEntry[]);

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validReference(reference: FinopsRuntimeCodeReference): boolean {
  return CODE_REFERENCE.test(`${reference.modulePath}#${reference.exportName}`);
}

function assertSafeQueryContract(contract: FinopsRuntimeQueryContract): void {
  if (
    !CONTRACT_ID.test(contract.contractId)
    || contract.clientControlledFields.length !== 0
    || contract.tenantScopeBinding !== "persisted_org_customer_connection"
    || contract.accountScopeBinding !== "persisted_connection_accounts_only"
    || contract.endpointBinding !== "server_sdk_or_allowlist_only"
    || contract.arnBinding !== "persisted_authorization_only"
    || contract.filterBinding !== "registered_query_only"
  ) throw new FinopsRuntimeRegistryError("UNSAFE_QUERY_CONTRACT");
  if (contract.operationSet.kind === "fixed_operations") {
    if (
      contract.operationSet.operations.length === 0
      || new Set(contract.operationSet.operations).size !== contract.operationSet.operations.length
      || contract.operationSet.operations.some((operation) => operation.includes("*") || !/^[a-z0-9-]+:[A-Z][A-Za-z0-9]+$/u.test(operation))
    ) throw new FinopsRuntimeRegistryError("UNSAFE_QUERY_CONTRACT");
  } else if (contract.operationSet.kind === "code_references") {
    if (
      contract.operationSet.references.length === 0
      || contract.operationSet.references.some((reference) => !validReference(reference))
    ) throw new FinopsRuntimeRegistryError("UNSAFE_QUERY_CONTRACT");
  } else if (contract.transport !== "persisted_internal") {
    throw new FinopsRuntimeRegistryError("UNSAFE_QUERY_CONTRACT");
  }
}

function assertProcessor(processorBinding: FinopsRuntimeProcessorBinding): void {
  if (processorBinding.kind === "normalizer_and_report_builder") {
    if (!validReference(processorBinding.normalizer) || !validReference(processorBinding.reportBuilder)) {
      throw new FinopsRuntimeRegistryError("SOURCE_CONTRACT_MISMATCH");
    }
  } else if (processorBinding.kind === "report_builder") {
    if (!validReference(processorBinding.reportBuilder)) {
      throw new FinopsRuntimeRegistryError("SOURCE_CONTRACT_MISMATCH");
    }
  } else if (
    processorBinding.availableNormalizer !== undefined
    && !validReference(processorBinding.availableNormalizer)
  ) {
    throw new FinopsRuntimeRegistryError("SOURCE_CONTRACT_MISMATCH");
  }
}

/**
 * Validate and expose only a complete, deeply immutable canonical registry.
 * This is exported for isolated composition testing; production uses the
 * constant below.
 */
export function createFinopsSourceRuntimeRegistry(
  entries: readonly FinopsCapabilityRuntimeEntry[],
): readonly FinopsCapabilityRuntimeEntry[] {
  if (!isDeeplyFrozen(entries)) throw new FinopsRuntimeRegistryError("MUTABLE_REGISTRY");
  const canonical = new Map(FINOPS_CAPABILITY_DEFINITIONS.map((definition) => [definition.id, definition]));
  const sourceDefinitions = new Map(FINOPS_SOURCE_DEFINITIONS.map((definition) => [definition.id, definition]));
  const seen = new Set<FinopsCapabilityId>();
  const uiKeys = new Set<string>();
  for (const entry of entries) {
    if (!IDENTIFIER.test(entry.capabilityId) || !canonical.has(entry.capabilityId)) {
      throw new FinopsRuntimeRegistryError("UNKNOWN_CAPABILITY");
    }
    if (seen.has(entry.capabilityId)) throw new FinopsRuntimeRegistryError("DUPLICATE_CAPABILITY");
    seen.add(entry.capabilityId);
    if (!UI_KEY.test(entry.capabilityUiKey) || uiKeys.has(entry.capabilityUiKey)) {
      throw new FinopsRuntimeRegistryError("SOURCE_CONTRACT_MISMATCH");
    }
    uiKeys.add(entry.capabilityUiKey);
    if (
      !CONTRACT_ID.test(entry.capabilityQueryContractId)
      || !Number.isSafeInteger(entry.bounds.maxPages)
      || entry.bounds.maxPages < 1
      || entry.bounds.maxPages > MAX_RUNTIME_PAGES
      || !Number.isSafeInteger(entry.bounds.maxBytes)
      || entry.bounds.maxBytes < 1
      || entry.bounds.maxBytes > MAX_RUNTIME_BYTES
      || !Number.isSafeInteger(entry.bounds.maxRecords)
      || entry.bounds.maxRecords < 1
      || entry.bounds.maxRecords > MAX_RUNTIME_RECORDS
      || !Number.isSafeInteger(entry.bounds.maxConcurrency)
      || entry.bounds.maxConcurrency < 1
      || entry.bounds.maxConcurrency > MAX_RUNTIME_CONCURRENCY
      || !Number.isSafeInteger(entry.bounds.deadlineMs)
      || entry.bounds.deadlineMs < 1
      || entry.bounds.deadlineMs > MAX_RUNTIME_DEADLINE_MS
    ) throw new FinopsRuntimeRegistryError("SOURCE_CONTRACT_MISMATCH");
    const definition = canonical.get(entry.capabilityId)!;
    if (
      !sameStrings(entry.requiredSourceIds, definition.requiredSourceIds)
      || !sameStrings(entry.supplementalSourceIds, definition.supplementalSourceIds)
    ) throw new FinopsRuntimeRegistryError("SOURCE_CONTRACT_MISMATCH");
    const expectedSourceIds = [...definition.requiredSourceIds, ...definition.supplementalSourceIds];
    if (
      entry.sourceBindings.length !== expectedSourceIds.length
      || new Set(entry.sourceBindings.map((binding) => binding.sourceId)).size !== entry.sourceBindings.length
      || !sameStrings(entry.sourceBindings.map((binding) => binding.sourceId), expectedSourceIds)
    ) throw new FinopsRuntimeRegistryError("SOURCE_CONTRACT_MISMATCH");
    for (const binding of entry.sourceBindings) {
      const sourceDefinition = sourceDefinitions.get(binding.sourceId);
      if (
        sourceDefinition === undefined
        || binding.sourceHealthId !== binding.sourceId
        || binding.freshnessSlaHours !== sourceDefinition.freshnessSlaHours
      ) throw new FinopsRuntimeRegistryError("SOURCE_CONTRACT_MISMATCH");
      assertSafeQueryContract(binding.queryContract);
      if (
        binding.evidenceAdapter.kind === "code_reference"
        && !validReference(binding.evidenceAdapter.reference)
      ) throw new FinopsRuntimeRegistryError("SOURCE_CONTRACT_MISMATCH");
    }
    assertProcessor(entry.processor);
  }
  if (entries.length !== canonical.size || seen.size !== canonical.size) {
    throw new FinopsRuntimeRegistryError("INCOMPLETE_REGISTRY");
  }
  return entries;
}

export const FINOPS_SOURCE_RUNTIME_REGISTRY = createFinopsSourceRuntimeRegistry(REGISTRY_DATA);

const REGISTRY_SOURCE_DATA = deepFreeze(
  FINOPS_SOURCE_DEFINITIONS.map((definition) => SOURCE_RUNTIME_BINDINGS[definition.id]),
);

/** Return the deeply frozen canonical capability contract or fail closed. */
export function getFinopsCapabilityRuntime(
  capabilityId: unknown,
): FinopsCapabilityRuntimeEntry {
  if (typeof capabilityId !== "string" || !IDENTIFIER.test(capabilityId)) {
    throw new FinopsRuntimeRegistryError("UNKNOWN_CAPABILITY");
  }
  const entry = FINOPS_SOURCE_RUNTIME_REGISTRY.find((candidate) => candidate.capabilityId === capabilityId);
  if (entry === undefined) throw new FinopsRuntimeRegistryError("UNKNOWN_CAPABILITY");
  return entry;
}

/** Return the deeply frozen canonical source contract or fail closed. */
export function getFinopsSourceRuntimeBinding(
  sourceId: unknown,
): FinopsSourceRuntimeBinding {
  if (typeof sourceId !== "string" || !IDENTIFIER.test(sourceId)) {
    throw new FinopsRuntimeRegistryError("SOURCE_CONTRACT_MISMATCH");
  }
  const binding = REGISTRY_SOURCE_DATA.find((candidate) => candidate.sourceId === sourceId);
  if (binding === undefined) throw new FinopsRuntimeRegistryError("SOURCE_CONTRACT_MISMATCH");
  return binding;
}

/**
 * Re-run the immutable coverage assertion at a server startup/test boundary.
 * Exactly the canonical 27 definitions must be present, once each.
 */
export function assertFinopsSourceRuntimeRegistryCoverage(): void {
  createFinopsSourceRuntimeRegistry(FINOPS_SOURCE_RUNTIME_REGISTRY);
  if (
    REGISTRY_SOURCE_DATA.length !== FINOPS_SOURCE_DEFINITIONS.length
    || new Set(REGISTRY_SOURCE_DATA.map((binding) => binding.sourceId)).size
      !== FINOPS_SOURCE_DEFINITIONS.length
  ) throw new FinopsRuntimeRegistryError("SOURCE_CONTRACT_MISMATCH");
}

/** List policy contracts without defensive copies because every descendant is frozen. */
export function listFinopsCapabilityRuntimes(): readonly FinopsCapabilityRuntimeEntry[] {
  assertFinopsSourceRuntimeRegistryCoverage();
  return FINOPS_SOURCE_RUNTIME_REGISTRY;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Resolve a browser/API request without accepting any provider-controlled
 * fields. Server jobs use the returned frozen contracts plus persisted scope.
 */
export function resolveFinopsCapabilityRuntimeRequest(
  request: unknown,
): FinopsCapabilityRuntimeEntry {
  if (!plainRecord(request) || !sameStrings(Object.keys(request).sort(), ["capabilityId"])) {
    throw new FinopsRuntimeRegistryError("INVALID_CLIENT_REQUEST");
  }
  const capabilityId = request.capabilityId;
  if (typeof capabilityId !== "string" || !IDENTIFIER.test(capabilityId)) {
    throw new FinopsRuntimeRegistryError("INVALID_CLIENT_REQUEST");
  }
  return getFinopsCapabilityRuntime(capabilityId);
}
