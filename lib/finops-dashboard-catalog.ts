/**
 * Client-safe presentation catalog for the complete AWS Cloud Intelligence
 * Dashboards catalog. This is deliberately separate from the AWS collector and
 * permission registries: Azure and GCP dashboards are official catalog entries,
 * but an AWS trust-role runtime cannot prove either provider is connected.
 */

export type FinopsDashboardLevel = "foundational" | "advanced" | "additional";
export type FinopsDashboardProvider = "aws" | "azure" | "gcp" | "multi-cloud";
export type FinopsDashboardMaturity =
  | "LOCAL_VERTICAL_CANDIDATE"
  | "PARTIAL_PIPELINE"
  | "ENGINE_ONLY"
  | "ABSENT"
  | "LOCAL_VERTICAL_VERIFIED"
  | "LIVE_ACCEPTED";

export type FinopsSharedAnalysisSection =
  | "overview"
  | "explorer"
  | "allocation"
  | "optimization"
  | "commitments"
  | "budgets"
  | "containers"
  | "services"
  | "marketplace"
  | "sustainability"
  | "operations"
  | "sources";

export interface FinopsDashboardCatalogEntry {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly shortName: string;
  readonly level: FinopsDashboardLevel;
  readonly provider: FinopsDashboardProvider;
  /** Delivery maturity only; no value means production-ready or accepted. */
  readonly currentMaturity: FinopsDashboardMaturity;
  readonly summary: string;
  readonly targetAudience: readonly string[];
  readonly documentationUrl: string;
  /** Existing concern-based analysis that is relevant, but not equivalent. */
  readonly relatedSharedAnalysis: FinopsSharedAnalysisSection | null;
}

const AWS_CID_ROOT =
  "https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards";

const FINOPS_DASHBOARD_CATALOG_DATA = [
  {
    id: "cudos",
    slug: "cudos",
    name: "CUDOS Dashboard",
    shortName: "CUDOS",
    level: "foundational",
    provider: "aws",
    currentMaturity: "LOCAL_VERTICAL_CANDIDATE",
    summary: "Operational AWS cost and usage analysis with resource-level drilldowns and evidence-backed optimization candidates.",
    targetAudience: ["Product owners", "Finance", "FinOps", "DevOps", "Engineering"],
    documentationUrl: `${AWS_CID_ROOT}/cudos-cid-kpi.html`,
    relatedSharedAnalysis: "overview",
  },
  {
    id: "cost_intelligence_dashboard",
    slug: "cost-intelligence",
    name: "Cost Intelligence Dashboard",
    shortName: "Cost Intelligence",
    level: "foundational",
    provider: "aws",
    currentMaturity: "LOCAL_VERTICAL_CANDIDATE",
    summary: "Executive-friendly cloud financial management, allocation, forecasting, and cost optimization analysis.",
    targetAudience: ["Executives", "Finance/Procurement"],
    documentationUrl: `${AWS_CID_ROOT}/cudos-cid-kpi.html`,
    relatedSharedAnalysis: "allocation",
  },
  {
    id: "kpi_dashboard",
    slug: "kpi-modernization",
    name: "KPI and Modernization Dashboard",
    shortName: "KPI & Modernization",
    level: "foundational",
    provider: "aws",
    currentMaturity: "LOCAL_VERTICAL_CANDIDATE",
    summary: "Versioned modernization and optimization KPIs with governed goals across business and engineering teams.",
    targetAudience: ["Product owners", "Finance", "FinOps", "DevOps", "Engineering"],
    documentationUrl: `${AWS_CID_ROOT}/cudos-cid-kpi.html`,
    relatedSharedAnalysis: "optimization",
  },
  {
    id: "trusted_advisor_organizational",
    slug: "trusted-advisor-organizational",
    name: "Trusted Advisor Organizational (TAO) Dashboard",
    shortName: "Trusted Advisor",
    level: "advanced",
    provider: "aws",
    currentMaturity: "PARTIAL_PIPELINE",
    summary: "Organization-wide Trusted Advisor checks, risks, resources, and historical optimization outcomes.",
    targetAudience: ["Product owners", "FinOps", "DevOps", "Engineering", "SRE", "Security"],
    documentationUrl: `${AWS_CID_ROOT}/trusted-advisor-dashboard.html`,
    relatedSharedAnalysis: "operations",
  },
  {
    id: "compute_optimizer",
    slug: "compute-optimizer",
    name: "Compute Optimizer Dashboard",
    shortName: "Compute Optimizer",
    level: "advanced",
    provider: "aws",
    currentMaturity: "PARTIAL_PIPELINE",
    summary: "Organization-wide rightsizing recommendations, savings opportunities, and under-provisioning risk.",
    targetAudience: ["Product owners", "FinOps", "DevOps", "Engineering"],
    documentationUrl: `${AWS_CID_ROOT}/compute-optimizer-dashboard.html`,
    relatedSharedAnalysis: "optimization",
  },
  {
    id: "cost_anomaly",
    slug: "cost-anomaly",
    name: "Cost Anomaly Dashboard",
    shortName: "Cost Anomaly",
    level: "advanced",
    provider: "aws",
    currentMaturity: "LOCAL_VERTICAL_CANDIDATE",
    summary: "AWS Cost Anomaly Detection findings, monitors, subscriptions, impact, and root-cause evidence.",
    targetAudience: ["Product owners", "FinOps", "DevOps", "Engineering"],
    documentationUrl: `${AWS_CID_ROOT}/cost-anomaly-dashboard.html`,
    relatedSharedAnalysis: "budgets",
  },
  {
    id: "extended_support_projection",
    slug: "extended-support-projection",
    name: "Extended Support Cost Projection",
    shortName: "Extended Support",
    level: "advanced",
    provider: "aws",
    currentMaturity: "PARTIAL_PIPELINE",
    summary: "Projected ElastiCache, EKS, RDS/Aurora, and OpenSearch Extended Support charges from authoritative resource and usage evidence.",
    targetAudience: ["Product owners", "FinOps", "DevOps", "Engineering"],
    documentationUrl: `${AWS_CID_ROOT}/extended-support.html`,
    relatedSharedAnalysis: "services",
  },
  {
    id: "graviton_savings",
    slug: "graviton-savings",
    name: "Graviton Savings Dashboard",
    shortName: "Graviton Savings",
    level: "advanced",
    provider: "aws",
    currentMaturity: "PARTIAL_PIPELINE",
    summary: "Graviton usage and compatible migration opportunities across EC2, RDS, OpenSearch, and ElastiCache.",
    targetAudience: ["Product owners", "FinOps", "DevOps", "Engineering"],
    documentationUrl: `${AWS_CID_ROOT}/graviton-savings-dashboard.html`,
    relatedSharedAnalysis: "optimization",
  },
  {
    id: "health_events",
    slug: "health-events",
    name: "Health Events Dashboard",
    shortName: "Health Events",
    level: "advanced",
    provider: "aws",
    currentMaturity: "PARTIAL_PIPELINE",
    summary: "Past, active, and upcoming AWS Health events across organization accounts and affected entities.",
    targetAudience: ["Product owners", "DevOps", "Engineering", "SRE", "Security"],
    documentationUrl: `${AWS_CID_ROOT}/health-events-dashboard.html`,
    relatedSharedAnalysis: "operations",
  },
  {
    id: "aws_news_feeds",
    slug: "aws-news-feeds",
    name: "AWS News Feeds",
    shortName: "AWS News",
    level: "advanced",
    provider: "aws",
    currentMaturity: "PARTIAL_PIPELINE",
    summary: "Governed AWS What’s New, blog, video, and security bulletin feeds for operational review.",
    targetAudience: ["Product owners", "FinOps", "DevOps", "Engineering"],
    documentationUrl: `${AWS_CID_ROOT}/news-feeds.html`,
    relatedSharedAnalysis: "operations",
  },
  {
    id: "aws_budgets",
    slug: "aws-budgets",
    name: "AWS Budgets Dashboard",
    shortName: "AWS Budgets",
    level: "advanced",
    provider: "aws",
    currentMaturity: "PARTIAL_PIPELINE",
    summary: "Organization-wide AWS budget configuration, actual spend, forecasts, thresholds, and status.",
    targetAudience: ["Product owners", "FinOps", "DevOps", "Engineering"],
    documentationUrl: `${AWS_CID_ROOT}/budgets-dashboard.html`,
    relatedSharedAnalysis: "budgets",
  },
  {
    id: "support_cases_radar",
    slug: "support-cases-radar",
    name: "AWS Support Cases Radar Dashboard",
    shortName: "Support Cases",
    level: "advanced",
    provider: "aws",
    currentMaturity: "PARTIAL_PIPELINE",
    summary: "Consolidated support-case volume, status, severity, age, ownership, and account trends.",
    targetAudience: ["Product owners", "FinOps", "DevOps", "Engineering", "CCOE", "Security"],
    documentationUrl: `${AWS_CID_ROOT}/support-cases-radar.html`,
    relatedSharedAnalysis: "operations",
  },
  {
    id: "resiliencevue",
    slug: "resiliencevue",
    name: "ResilienceVue Dashboard",
    shortName: "ResilienceVue",
    level: "advanced",
    provider: "aws",
    currentMaturity: "PARTIAL_PIPELINE",
    summary: "AWS Resilience Hub application posture, assessments, drift, policies, and recommendations.",
    targetAudience: ["Product owners", "DevOps", "Engineering", "SRE", "Security"],
    documentationUrl: `${AWS_CID_ROOT}/resiliencevue-dashboard.html`,
    relatedSharedAnalysis: "operations",
  },
  {
    id: "end_user_computing",
    slug: "end-user-computing",
    name: "AWS End User Computing (EUC) Dashboard",
    shortName: "End User Computing",
    level: "advanced",
    provider: "aws",
    currentMaturity: "PARTIAL_PIPELINE",
    summary: "WorkSpaces usage, cost, performance, and user-behavior evidence for fleet optimization.",
    targetAudience: ["IT administrators", "FinOps", "Product owners"],
    documentationUrl: `${AWS_CID_ROOT}/euc-dashboard.html`,
    relatedSharedAnalysis: "services",
  },
  {
    id: "data_collection_monitor",
    slug: "data-collection-monitor",
    name: "Data Collection Monitor Dashboard",
    shortName: "Collection Monitor",
    level: "advanced",
    provider: "aws",
    currentMaturity: "PARTIAL_PIPELINE",
    summary: "Data Collection Framework execution history, module instrumentation, failures, and troubleshooting evidence.",
    targetAudience: ["IT administrators", "FinOps"],
    documentationUrl: `${AWS_CID_ROOT}/data-collection-monitor.html`,
    relatedSharedAnalysis: "sources",
  },
  {
    id: "media_services_insights",
    slug: "media-services-insights",
    name: "Media Services Insights Hub",
    shortName: "Media Services",
    level: "advanced",
    provider: "aws",
    currentMaturity: "PARTIAL_PIPELINE",
    summary: "AWS Elemental Media Services usage, cost, performance, and workflow optimization insights.",
    targetAudience: ["Product owners", "DevOps", "Engineering", "SRE"],
    documentationUrl: `${AWS_CID_ROOT}/media-services-insights.html`,
    relatedSharedAnalysis: "services",
  },
  {
    id: "cora",
    slug: "cora",
    name: "CORA Dashboard",
    shortName: "CORA",
    level: "additional",
    provider: "aws",
    currentMaturity: "PARTIAL_PIPELINE",
    summary: "Cost Optimization Hub rightsizing, Graviton, idle-resource, Savings Plan, and Reserved Instance recommendations.",
    targetAudience: ["Executives", "Finance", "Procurement", "FinOps", "Product owners"],
    documentationUrl: `${AWS_CID_ROOT}/cora-dashboard.html`,
    relatedSharedAnalysis: "optimization",
  },
  {
    id: "azure_cid",
    slug: "azure-cloud-intelligence",
    name: "Cloud Intelligence Dashboard for Azure",
    shortName: "Azure CID",
    level: "additional",
    provider: "azure",
    currentMaturity: "PARTIAL_PIPELINE",
    summary: "Azure billing exports normalized for cost visualization, reporting, allocation, and multicloud financial analysis.",
    targetAudience: ["Executives", "Finance", "Procurement", "FinOps", "Product owners"],
    documentationUrl: "https://aws.amazon.com/blogs/modernizing-with-aws/cloud-intelligence-dashboard-for-azure/",
    relatedSharedAnalysis: null,
  },
  {
    id: "gcp_cid",
    slug: "gcp-cloud-intelligence",
    name: "Cloud Intelligence Dashboard for GCP",
    shortName: "GCP CID",
    level: "additional",
    provider: "gcp",
    currentMaturity: "PARTIAL_PIPELINE",
    summary: "GCP Cloud Billing exports normalized for cost visualization, reporting, and multicloud financial analysis.",
    targetAudience: ["Executives", "Finance", "Procurement", "FinOps", "Product owners"],
    documentationUrl: "https://catalog.workshops.aws/cid-gcp-cost-dashboard",
    relatedSharedAnalysis: null,
  },
  {
    id: "focus",
    slug: "focus",
    name: "FOCUS Dashboard",
    shortName: "FOCUS",
    level: "additional",
    provider: "multi-cloud",
    currentMaturity: "PARTIAL_PIPELINE",
    summary: "Portable cloud-cost analysis based on normalized FinOps Open Cost and Usage Specification data.",
    targetAudience: ["Executives", "Finance", "Procurement", "FinOps", "Product owners"],
    documentationUrl: `${AWS_CID_ROOT}/focus-dashboard.html`,
    relatedSharedAnalysis: "explorer",
  },
  {
    id: "marketplace_spg",
    slug: "marketplace-spg",
    name: "AWS Marketplace Single Pane of Glass (SPG) Dashboard",
    shortName: "Marketplace SPG",
    level: "additional",
    provider: "aws",
    currentMaturity: "PARTIAL_PIPELINE",
    summary: "Marketplace spend, subscriptions, agreements, licenses, grants, entitlements, and procurement governance.",
    targetAudience: ["AWS Marketplace buyers", "Procurement", "Sourcing", "Finance", "FinOps", "Legal", "GRC", "IT", "BizApps"],
    documentationUrl: `${AWS_CID_ROOT}/marketplace-dashboard.html`,
    relatedSharedAnalysis: "marketplace",
  },
  {
    id: "kubecost_container_allocation",
    slug: "kubecost-container-allocation",
    name: "Kubecost Containers Cost Allocation Dashboard",
    shortName: "Kubecost",
    level: "additional",
    provider: "multi-cloud",
    currentMaturity: "PARTIAL_PIPELINE",
    summary: "Kubernetes workload allocation, showback, chargeback, efficiency, and container rightsizing evidence.",
    targetAudience: ["DevOps", "FinOps", "Cloud engineering", "Product management"],
    documentationUrl: `${AWS_CID_ROOT}/kubecost-containers-dashboard.html`,
    relatedSharedAnalysis: "containers",
  },
  {
    id: "scad_container_allocation",
    slug: "scad-container-allocation",
    name: "SCAD Containers Cost Allocation Dashboard",
    shortName: "SCAD",
    level: "additional",
    provider: "aws",
    currentMaturity: "PARTIAL_PIPELINE",
    summary: "EKS and ECS workload cost allocation using AWS Split Cost Allocation Data lineage.",
    targetAudience: ["DevOps", "FinOps", "Cloud engineering", "Product management"],
    documentationUrl: `${AWS_CID_ROOT}/scad-containers-dashboard.html`,
    relatedSharedAnalysis: "containers",
  },
  {
    id: "sustainability_proxy",
    slug: "sustainability-carbon",
    name: "Sustainability Proxy Metrics and Carbon Emissions Dashboard",
    shortName: "Sustainability",
    level: "additional",
    provider: "aws",
    currentMaturity: "PARTIAL_PIPELINE",
    summary: "Resource-efficiency proxy metrics and separately sourced AWS carbon-emissions evidence.",
    targetAudience: ["Product owners", "FinOps", "DevOps", "Engineering"],
    documentationUrl: `${AWS_CID_ROOT}/sustainability-proxy-metrics-dashboard.html`,
    relatedSharedAnalysis: "sustainability",
  },
  {
    id: "trends",
    slug: "trends",
    name: "Trends Dashboard",
    shortName: "Trends",
    level: "additional",
    provider: "aws",
    currentMaturity: "LOCAL_VERTICAL_CANDIDATE",
    summary: "Longitudinal financial and technology trends, signals, contributors, and anomalies.",
    targetAudience: ["Executives", "Finance", "Procurement"],
    documentationUrl: `${AWS_CID_ROOT}/trends-dashboard.html`,
    relatedSharedAnalysis: "overview",
  },
  {
    id: "data_transfer",
    slug: "data-transfer",
    name: "Data Transfer Dashboard",
    shortName: "Data Transfer",
    level: "additional",
    provider: "aws",
    currentMaturity: "LOCAL_VERTICAL_CANDIDATE",
    summary: "Paid internet, inter-Region, inter-AZ, and service data-transfer cost and usage analysis.",
    targetAudience: ["Network Team"],
    documentationUrl: `${AWS_CID_ROOT}/datatransfer-dashboard.html`,
    relatedSharedAnalysis: "services",
  },
  {
    id: "amazon_connect_cost_insights",
    slug: "amazon-connect-cost-insights",
    name: "Amazon Connect Cost Insights Dashboard",
    shortName: "Amazon Connect",
    level: "additional",
    provider: "aws",
    currentMaturity: "PARTIAL_PIPELINE",
    summary: "Amazon Connect spend, usage trends, voice and telecom services, and call-cost breakdowns.",
    targetAudience: ["FinOps", "Telecom engineering", "Product management"],
    documentationUrl: `${AWS_CID_ROOT}/connect-cost-insight.html`,
    relatedSharedAnalysis: "services",
  },
  {
    id: "config_resource_compliance",
    slug: "config-resource-compliance",
    name: "AWS Config Resource Compliance Dashboard",
    shortName: "Config Compliance",
    level: "additional",
    provider: "aws",
    currentMaturity: "PARTIAL_PIPELINE",
    summary: "Organization resource inventory and AWS Config compliance across accounts and Regions.",
    targetAudience: ["Security", "SecOps", "DevOps", "Product owners", "Engineering"],
    documentationUrl: `${AWS_CID_ROOT}/config-resource-compliance-dashboard.html`,
    relatedSharedAnalysis: "operations",
  },
  {
    id: "pricing_change",
    slug: "pricing-change-analysis",
    name: "Pricing Change Analysis Dashboard",
    shortName: "Pricing Changes",
    level: "additional",
    provider: "aws",
    currentMaturity: "PARTIAL_PIPELINE",
    summary: "Impact of version-pinned AWS price changes when applied to the organization’s actual usage.",
    targetAudience: ["Executives", "Finance", "Procurement", "FinOps", "Product owners"],
    documentationUrl: `${AWS_CID_ROOT}/pricing-change-dashboard.html`,
    relatedSharedAnalysis: "explorer",
  },
] as const satisfies readonly FinopsDashboardCatalogEntry[];

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export const FINOPS_DASHBOARD_CATALOG = deepFreeze(FINOPS_DASHBOARD_CATALOG_DATA);

export const FINOPS_DASHBOARD_MATURITY_BY_ID = deepFreeze(
  Object.fromEntries(FINOPS_DASHBOARD_CATALOG.map((entry) => [
    entry.id,
    entry.currentMaturity,
  ])) as Readonly<Record<string, FinopsDashboardMaturity>>,
);

export function getFinopsDashboardCatalogEntry(idOrSlug: string): FinopsDashboardCatalogEntry | null {
  return FINOPS_DASHBOARD_CATALOG.find((entry) =>
    entry.id === idOrSlug || entry.slug === idOrSlug) ?? null;
}

export function listFinopsDashboardsByLevel(
  level: FinopsDashboardLevel,
): readonly FinopsDashboardCatalogEntry[] {
  return FINOPS_DASHBOARD_CATALOG.filter((entry) => entry.level === level);
}
