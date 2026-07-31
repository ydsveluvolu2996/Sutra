/**
 * Evidence-honest readiness model for the AWS Cloud Intelligence Dashboards
 * capability catalog.
 *
 * The engine is deliberately pure. A caller must supply tenant-scoped,
 * persisted evidence; an absent record never becomes a successful source.
 * "Healthy" means that a source has a recent successful delivery AND explicit
 * complete coverage under Sutra's acceptance policy. It does not mean that an
 * AWS service is enabled merely because a related Sutra feature exists.
 */

export type FinopsSourceState =
  | "not_configured"
  | "waiting_first_delivery"
  | "healthy"
  | "stale"
  | "partial"
  | "failed";

export type FinopsDashboardLevel = "foundational" | "advanced" | "additional";
export type FinopsCoverageAssessment = "complete" | "partial" | "unknown";
export type FinopsSourceAttemptOutcome =
  | "succeeded"
  | "partial"
  | "failed"
  | "in_progress"
  | "unknown";

export interface FinopsSourceScope {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export const FINOPS_SOURCE_DEFINITIONS = [
  {
    id: "aws_cur2_data_export",
    name: "AWS CUR 2.0 Data Export",
    kind: "billing",
    freshnessSlaHours: 48,
  },
  {
    id: "aws_focus_1_2_data_export",
    name: "AWS FOCUS 1.2 Data Export",
    kind: "billing",
    freshnessSlaHours: 48,
  },
  {
    id: "trusted_advisor_organization",
    name: "AWS Trusted Advisor organizational checks",
    kind: "recommendations",
    freshnessSlaHours: 48,
  },
  {
    id: "compute_optimizer_organization_export",
    name: "AWS Compute Optimizer organizational export",
    kind: "recommendations",
    freshnessSlaHours: 384,
  },
  {
    id: "cost_anomaly_detection",
    name: "AWS Cost Anomaly Detection",
    kind: "cost-management",
    freshnessSlaHours: 48,
  },
  {
    id: "extended_support_inventory",
    name: "AWS service lifecycle inventory",
    kind: "inventory",
    freshnessSlaHours: 48,
  },
  {
    id: "aws_health_organization",
    name: "AWS Health organizational events",
    kind: "operations",
    freshnessSlaHours: 72,
  },
  {
    id: "aws_news_feeds",
    name: "AWS news and security feeds",
    kind: "operations",
    freshnessSlaHours: 48,
  },
  {
    id: "aws_budgets",
    name: "AWS Budgets",
    kind: "cost-management",
    freshnessSlaHours: 48,
  },
  {
    id: "aws_support_cases_organization",
    name: "AWS Support organizational cases",
    kind: "operations",
    freshnessSlaHours: 48,
  },
  {
    id: "aws_resilience_hub",
    name: "AWS Resilience Hub",
    kind: "operations",
    freshnessSlaHours: 168,
  },
  {
    id: "end_user_computing_telemetry",
    name: "AWS end-user computing telemetry",
    kind: "service-telemetry",
    freshnessSlaHours: 48,
  },
  {
    id: "data_collection_telemetry",
    name: "Sutra AWS data-collection telemetry",
    kind: "collection",
    freshnessSlaHours: 25,
  },
  {
    id: "media_services_telemetry",
    name: "AWS media services telemetry",
    kind: "service-telemetry",
    freshnessSlaHours: 48,
  },
  {
    id: "cost_optimization_hub_export",
    name: "AWS Cost Optimization Hub export",
    kind: "recommendations",
    freshnessSlaHours: 48,
  },
  {
    id: "aws_marketplace_intelligence",
    name: "AWS Marketplace agreements and entitlements",
    kind: "marketplace",
    freshnessSlaHours: 48,
  },
  {
    id: "kubecost_allocation",
    name: "Kubecost allocation export",
    kind: "containers",
    freshnessSlaHours: 24,
  },
  {
    id: "scad_allocation",
    name: "AWS Split Cost Allocation Data",
    kind: "containers",
    freshnessSlaHours: 48,
  },
  {
    id: "aws_carbon_footprint",
    name: "AWS Customer Carbon Footprint export",
    kind: "sustainability",
    freshnessSlaHours: 840,
  },
  {
    id: "amazon_connect_telemetry",
    name: "Amazon Connect usage and contact telemetry",
    kind: "service-telemetry",
    freshnessSlaHours: 48,
  },
  {
    id: "aws_config_organization_aggregator",
    name: "AWS Config organizational aggregator",
    kind: "compliance",
    freshnessSlaHours: 48,
  },
  {
    id: "aws_pricing_catalog",
    name: "AWS pricing catalog",
    kind: "pricing",
    freshnessSlaHours: 840,
  },
  {
    id: "aws_organizations_taxonomy",
    name: "AWS Organizations account and OU taxonomy",
    kind: "organization",
    freshnessSlaHours: 48,
  },
  {
    id: "sutra_billing_workspace",
    name: "Sutra persisted billing workspace",
    kind: "supplemental",
    freshnessSlaHours: 48,
  },
] as const;

export type FinopsSourceId = (typeof FINOPS_SOURCE_DEFINITIONS)[number]["id"];

export interface FinopsSourceEvidence {
  readonly scope: FinopsSourceScope;
  readonly sourceId: FinopsSourceId;
  /**
   * Configuration must be proven by persisted state. An absent integration
   * record is represented by omitting the evidence or setting this to false.
   */
  readonly configured: boolean;
  readonly deliveryObserved: boolean;
  readonly lastAttemptAt: string | null;
  readonly lastAttemptOutcome: FinopsSourceAttemptOutcome | null;
  readonly lastSuccessAt: string | null;
  /** Timestamp through which the delivered source data is known to be current. */
  readonly dataThroughAt: string | null;
  readonly coverage: {
    readonly assessment: FinopsCoverageAssessment;
    readonly acceptedRecords: number | null;
    readonly expectedRecords: number | null;
    /** Null when the source contract does not provide a rejected-row count. */
    readonly rejectedRecords: number | null;
  };
  readonly lastError: {
    readonly code: string;
    readonly message: string;
    readonly at: string;
  } | null;
  readonly evidenceBasis: string;
  readonly limitations?: readonly string[];
}

export interface FinopsSourceHealth {
  readonly id: FinopsSourceId;
  readonly name: string;
  readonly kind: string;
  readonly state: FinopsSourceState;
  readonly configured: boolean;
  readonly deliveryObserved: boolean;
  readonly freshness: {
    readonly slaHours: number;
    readonly dataThroughAt: string | null;
    readonly lastSuccessAt: string | null;
    readonly ageHours: number | null;
    readonly fresh: boolean | null;
  };
  readonly coverage: {
    readonly assessment: FinopsCoverageAssessment;
    readonly acceptedRecords: number | null;
    readonly expectedRecords: number | null;
    readonly rejectedRecords: number | null;
    readonly percent: number | null;
  };
  readonly lastAttemptAt: string | null;
  readonly lastAttemptOutcome: FinopsSourceAttemptOutcome | null;
  readonly lastError: FinopsSourceEvidence["lastError"];
  readonly evidenceBasis: string | null;
  readonly limitations: readonly string[];
}

const AWS_CID_ROOT = "https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards";

export const FINOPS_CAPABILITY_DEFINITIONS = [
  {
    id: "cudos",
    name: "CUDOS Dashboard",
    level: "foundational",
    documentationUrl: `${AWS_CID_ROOT}/cudos-cid-kpi.html`,
    requiredSourceIds: ["aws_cur2_data_export"],
    supplementalSourceIds: ["aws_organizations_taxonomy", "sutra_billing_workspace"],
  },
  {
    id: "cost_intelligence_dashboard",
    name: "Cost Intelligence Dashboard",
    level: "foundational",
    documentationUrl: `${AWS_CID_ROOT}/cudos-cid-kpi.html`,
    requiredSourceIds: ["aws_cur2_data_export"],
    supplementalSourceIds: ["aws_organizations_taxonomy", "sutra_billing_workspace"],
  },
  {
    id: "kpi_dashboard",
    name: "KPI Dashboard",
    level: "foundational",
    documentationUrl: `${AWS_CID_ROOT}/cudos-cid-kpi.html`,
    requiredSourceIds: ["aws_cur2_data_export"],
    supplementalSourceIds: ["aws_organizations_taxonomy", "sutra_billing_workspace"],
  },
  {
    id: "trusted_advisor_organizational",
    name: "Trusted Advisor Organizational Dashboard",
    level: "advanced",
    documentationUrl: `${AWS_CID_ROOT}/trusted-advisor-dashboard.html`,
    requiredSourceIds: ["trusted_advisor_organization"],
    supplementalSourceIds: [],
  },
  {
    id: "compute_optimizer",
    name: "Compute Optimizer Dashboard",
    level: "advanced",
    documentationUrl: `${AWS_CID_ROOT}/compute-optimizer-dashboard.html`,
    requiredSourceIds: ["compute_optimizer_organization_export"],
    supplementalSourceIds: ["data_collection_telemetry"],
  },
  {
    id: "cost_anomaly",
    name: "Cost Anomaly Dashboard",
    level: "advanced",
    documentationUrl: `${AWS_CID_ROOT}/cost-anomaly-dashboard.html`,
    requiredSourceIds: ["cost_anomaly_detection"],
    supplementalSourceIds: ["sutra_billing_workspace"],
  },
  {
    id: "extended_support_projection",
    name: "Extended Support Projection Dashboard",
    level: "advanced",
    documentationUrl: `${AWS_CID_ROOT}/extended-support.html`,
    requiredSourceIds: ["aws_cur2_data_export", "extended_support_inventory"],
    supplementalSourceIds: ["sutra_billing_workspace", "data_collection_telemetry"],
  },
  {
    id: "graviton_savings",
    name: "Graviton Savings Dashboard",
    level: "advanced",
    documentationUrl: `${AWS_CID_ROOT}/graviton-savings-dashboard.html`,
    requiredSourceIds: ["aws_cur2_data_export", "compute_optimizer_organization_export"],
    supplementalSourceIds: ["sutra_billing_workspace", "data_collection_telemetry"],
  },
  {
    id: "health_events",
    name: "AWS Health Events Dashboard",
    level: "advanced",
    documentationUrl: `${AWS_CID_ROOT}/health-events-dashboard.html`,
    requiredSourceIds: ["aws_health_organization"],
    supplementalSourceIds: [],
  },
  {
    id: "aws_news_feeds",
    name: "AWS News Feeds Dashboard",
    level: "advanced",
    documentationUrl: `${AWS_CID_ROOT}/news-feeds.html`,
    requiredSourceIds: ["aws_news_feeds"],
    supplementalSourceIds: [],
  },
  {
    id: "aws_budgets",
    name: "AWS Budgets Dashboard",
    level: "advanced",
    documentationUrl: `${AWS_CID_ROOT}/budgets-dashboard.html`,
    requiredSourceIds: ["aws_budgets"],
    supplementalSourceIds: ["sutra_billing_workspace"],
  },
  {
    id: "support_cases_radar",
    name: "Support Cases Radar",
    level: "advanced",
    documentationUrl: `${AWS_CID_ROOT}/support-cases-radar.html`,
    requiredSourceIds: ["aws_support_cases_organization"],
    supplementalSourceIds: [],
  },
  {
    id: "resiliencevue",
    name: "ResilienceVue Dashboard",
    level: "advanced",
    documentationUrl: `${AWS_CID_ROOT}/resiliencevue-dashboard.html`,
    requiredSourceIds: ["aws_resilience_hub"],
    supplementalSourceIds: ["data_collection_telemetry"],
  },
  {
    id: "end_user_computing",
    name: "End User Computing Dashboard",
    level: "advanced",
    documentationUrl: `${AWS_CID_ROOT}/euc-dashboard.html`,
    requiredSourceIds: ["aws_cur2_data_export", "end_user_computing_telemetry"],
    supplementalSourceIds: ["sutra_billing_workspace"],
  },
  {
    id: "data_collection_monitor",
    name: "Data Collection Monitor",
    level: "advanced",
    documentationUrl: `${AWS_CID_ROOT}/data-collection-monitor.html`,
    requiredSourceIds: ["data_collection_telemetry"],
    supplementalSourceIds: [],
  },
  {
    id: "media_services_insights",
    name: "Media Services Insights Hub",
    level: "advanced",
    documentationUrl: `${AWS_CID_ROOT}/media-services-insights.html`,
    requiredSourceIds: ["aws_cur2_data_export", "media_services_telemetry"],
    supplementalSourceIds: ["sutra_billing_workspace"],
  },
  {
    id: "cora",
    name: "Cost Optimization Recommended Actions",
    level: "additional",
    documentationUrl: `${AWS_CID_ROOT}/cora-dashboard.html`,
    requiredSourceIds: ["cost_optimization_hub_export", "aws_cur2_data_export"],
    supplementalSourceIds: ["sutra_billing_workspace", "data_collection_telemetry"],
  },
  {
    id: "focus",
    name: "FOCUS Dashboard",
    level: "additional",
    documentationUrl: `${AWS_CID_ROOT}/focus-dashboard.html`,
    requiredSourceIds: ["aws_focus_1_2_data_export"],
    supplementalSourceIds: ["sutra_billing_workspace"],
  },
  {
    id: "marketplace_spg",
    name: "AWS Marketplace Spend and Procurement Governance",
    level: "additional",
    documentationUrl: `${AWS_CID_ROOT}/marketplace-dashboard.html`,
    requiredSourceIds: ["aws_cur2_data_export", "aws_marketplace_intelligence"],
    supplementalSourceIds: ["sutra_billing_workspace"],
  },
  {
    id: "kubecost_container_allocation",
    name: "Kubecost Container Cost Allocation",
    level: "additional",
    documentationUrl: `${AWS_CID_ROOT}/kubecost-containers-dashboard.html`,
    requiredSourceIds: ["aws_cur2_data_export", "kubecost_allocation"],
    supplementalSourceIds: ["sutra_billing_workspace"],
  },
  {
    id: "scad_container_allocation",
    name: "Split Cost Allocation Data Dashboard",
    level: "additional",
    documentationUrl: `${AWS_CID_ROOT}/scad-containers-dashboard.html`,
    requiredSourceIds: ["aws_cur2_data_export", "scad_allocation"],
    supplementalSourceIds: ["sutra_billing_workspace"],
  },
  {
    id: "sustainability_proxy",
    name: "Sustainability Proxy Metrics Dashboard",
    level: "additional",
    documentationUrl: `${AWS_CID_ROOT}/sustainability-proxy-metrics-dashboard.html`,
    requiredSourceIds: ["aws_cur2_data_export", "aws_carbon_footprint"],
    supplementalSourceIds: ["sutra_billing_workspace"],
  },
  {
    id: "trends",
    name: "Trends Dashboard",
    level: "additional",
    documentationUrl: `${AWS_CID_ROOT}/trends-dashboard.html`,
    requiredSourceIds: ["aws_cur2_data_export"],
    supplementalSourceIds: ["sutra_billing_workspace"],
  },
  {
    id: "data_transfer",
    name: "Data Transfer Dashboard",
    level: "additional",
    documentationUrl: `${AWS_CID_ROOT}/datatransfer-dashboard.html`,
    requiredSourceIds: ["aws_cur2_data_export"],
    supplementalSourceIds: ["sutra_billing_workspace"],
  },
  {
    id: "amazon_connect_cost_insights",
    name: "Amazon Connect Cost Insights Dashboard",
    level: "additional",
    documentationUrl: `${AWS_CID_ROOT}/connect-cost-insight.html`,
    requiredSourceIds: ["aws_cur2_data_export", "amazon_connect_telemetry"],
    supplementalSourceIds: ["sutra_billing_workspace"],
  },
  {
    id: "config_resource_compliance",
    name: "AWS Config Resource Compliance Dashboard",
    level: "additional",
    documentationUrl: `${AWS_CID_ROOT}/config-resource-compliance-dashboard.html`,
    requiredSourceIds: ["aws_config_organization_aggregator"],
    supplementalSourceIds: ["data_collection_telemetry"],
  },
  {
    id: "pricing_change",
    name: "AWS Pricing Change Dashboard",
    level: "additional",
    documentationUrl: `${AWS_CID_ROOT}/pricing-change-dashboard.html`,
    requiredSourceIds: ["aws_cur2_data_export", "aws_pricing_catalog"],
    supplementalSourceIds: ["sutra_billing_workspace"],
  },
] as const satisfies readonly {
  readonly id: string;
  readonly name: string;
  readonly level: FinopsDashboardLevel;
  readonly documentationUrl: string;
  readonly requiredSourceIds: readonly FinopsSourceId[];
  readonly supplementalSourceIds: readonly FinopsSourceId[];
}[];

export type FinopsCapabilityId = (typeof FINOPS_CAPABILITY_DEFINITIONS)[number]["id"];

export interface FinopsCapabilityReadiness {
  readonly id: FinopsCapabilityId;
  readonly name: string;
  readonly level: FinopsDashboardLevel;
  readonly documentationUrl: string;
  readonly state: FinopsSourceState;
  readonly ready: boolean;
  readonly requiredSources: readonly {
    readonly sourceId: FinopsSourceId;
    readonly state: FinopsSourceState;
  }[];
  readonly supplementalSources: readonly {
    readonly sourceId: FinopsSourceId;
    readonly state: FinopsSourceState;
  }[];
  readonly blockingSourceIds: readonly FinopsSourceId[];
}

export interface FinopsSourceReadinessReport {
  readonly scope: {
    readonly connectionId: string;
  };
  readonly generatedAt: string;
  readonly summary: {
    readonly sources: Readonly<Record<FinopsSourceState, number>>;
    readonly capabilities: Readonly<Record<FinopsSourceState, number>>;
    readonly readyCapabilities: number;
    readonly totalCapabilities: number;
  };
  readonly sources: readonly FinopsSourceHealth[];
  readonly capabilities: readonly FinopsCapabilityReadiness[];
  readonly disclaimer: string;
}

const EMPTY_COUNTS: Readonly<Record<FinopsSourceState, number>> = {
  not_configured: 0,
  waiting_first_delivery: 0,
  healthy: 0,
  stale: 0,
  partial: 0,
  failed: 0,
};

function finiteNonNegativeInteger(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isoMilliseconds(value: string | null): number | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function evidenceRecency(evidence: FinopsSourceEvidence): number {
  return Math.max(
    isoMilliseconds(evidence.lastAttemptAt) ?? -1,
    isoMilliseconds(evidence.lastSuccessAt) ?? -1,
    isoMilliseconds(evidence.dataThroughAt) ?? -1,
  );
}

function selectScopedEvidence(
  scope: FinopsSourceScope,
  sourceId: FinopsSourceId,
  evidence: readonly FinopsSourceEvidence[],
): FinopsSourceEvidence | null {
  const matching = evidence.filter((entry) =>
    entry.sourceId === sourceId
    && entry.scope.orgId === scope.orgId
    && entry.scope.customerId === scope.customerId
    && entry.scope.connectionId === scope.connectionId
  );
  if (matching.length === 0) return null;
  return [...matching].sort((left, right) => evidenceRecency(right) - evidenceRecency(left))[0] ?? null;
}

function sourceHealth(
  definition: (typeof FINOPS_SOURCE_DEFINITIONS)[number],
  evidence: FinopsSourceEvidence | null,
  nowMs: number,
): FinopsSourceHealth {
  const configured = evidence?.configured === true;
  const deliveryObserved = evidence?.deliveryObserved === true || evidence?.lastSuccessAt !== null && evidence?.lastSuccessAt !== undefined;
  const acceptedRecords = finiteNonNegativeInteger(evidence?.coverage.acceptedRecords ?? null);
  const expectedRecords = finiteNonNegativeInteger(evidence?.coverage.expectedRecords ?? null);
  const rejectedRecords = finiteNonNegativeInteger(evidence?.coverage.rejectedRecords ?? null);
  const percent =
    acceptedRecords === null || expectedRecords === null || expectedRecords === 0
      ? null
      : Math.min(100, Math.round((acceptedRecords / expectedRecords) * 10_000) / 100);
  const freshnessTimestamp = isoMilliseconds(evidence?.dataThroughAt ?? null)
    ?? isoMilliseconds(evidence?.lastSuccessAt ?? null);
  const futureTimestamp = freshnessTimestamp !== null && freshnessTimestamp > nowMs + 5 * 60 * 1_000;
  const ageHours = freshnessTimestamp === null || futureTimestamp
    ? null
    : Math.max(0, Math.round(((nowMs - freshnessTimestamp) / 3_600_000) * 100) / 100);
  const fresh = ageHours === null ? null : ageHours <= definition.freshnessSlaHours;

  let state: FinopsSourceState;
  if (!configured) {
    state = "not_configured";
  } else if (
    evidence?.lastAttemptOutcome === "failed"
    && (
      isoMilliseconds(evidence.lastAttemptAt) ?? Number.POSITIVE_INFINITY
    ) >= (
      isoMilliseconds(evidence.lastSuccessAt) ?? Number.NEGATIVE_INFINITY
    )
  ) {
    state = "failed";
  } else if (!deliveryObserved) {
    state = "waiting_first_delivery";
  } else if (fresh === false) {
    state = "stale";
  } else if (
    fresh === null
    || evidence?.lastAttemptOutcome === "partial"
    || evidence?.coverage.assessment !== "complete"
    || (rejectedRecords !== null && rejectedRecords > 0)
    || (
      acceptedRecords !== null
      && expectedRecords !== null
      && acceptedRecords < expectedRecords
    )
  ) {
    state = "partial";
  } else {
    state = "healthy";
  }

  const limitations = [...(evidence?.limitations ?? [])];
  if (futureTimestamp) limitations.push("The source freshness timestamp is in the future and was not trusted.");

  return {
    id: definition.id,
    name: definition.name,
    kind: definition.kind,
    state,
    configured,
    deliveryObserved,
    freshness: {
      slaHours: definition.freshnessSlaHours,
      dataThroughAt: evidence?.dataThroughAt ?? null,
      lastSuccessAt: evidence?.lastSuccessAt ?? null,
      ageHours,
      fresh,
    },
    coverage: {
      assessment: evidence?.coverage.assessment ?? "unknown",
      acceptedRecords,
      expectedRecords,
      rejectedRecords,
      percent,
    },
    lastAttemptAt: evidence?.lastAttemptAt ?? null,
    lastAttemptOutcome: evidence?.lastAttemptOutcome ?? null,
    lastError: evidence?.lastError ?? null,
    evidenceBasis: evidence?.evidenceBasis ?? null,
    limitations,
  };
}

function capabilityState(
  required: readonly FinopsSourceHealth[],
  supplemental: readonly FinopsSourceHealth[],
): FinopsSourceState {
  if (required.some((source) => source.state === "failed")) return "failed";
  const missing = required.some((source) => source.state === "not_configured");
  const supplementalObserved = supplemental.some((source) =>
    source.state !== "not_configured" && source.state !== "waiting_first_delivery"
  );
  const anyRequiredConfigured = required.some((source) => source.state !== "not_configured");
  if (missing) return anyRequiredConfigured || supplementalObserved ? "partial" : "not_configured";
  if (required.some((source) => source.state === "waiting_first_delivery")) return "waiting_first_delivery";
  if (required.some((source) => source.state === "stale")) return "stale";
  if (required.some((source) => source.state === "partial")) return "partial";
  return "healthy";
}

function countsFor(values: readonly FinopsSourceState[]): Readonly<Record<FinopsSourceState, number>> {
  const counts: Record<FinopsSourceState, number> = { ...EMPTY_COUNTS };
  for (const value of values) counts[value] += 1;
  return counts;
}

export function buildFinopsSourceReadiness(input: {
  readonly scope: FinopsSourceScope;
  readonly evidence: readonly FinopsSourceEvidence[];
  readonly nowMs?: number;
}): FinopsSourceReadinessReport {
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) throw new Error("A finite readiness assessment time is required");

  const sources = FINOPS_SOURCE_DEFINITIONS.map((definition) =>
    sourceHealth(
      definition,
      selectScopedEvidence(input.scope, definition.id, input.evidence),
      nowMs,
    )
  );
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const capabilities = FINOPS_CAPABILITY_DEFINITIONS.map((definition) => {
    const requiredSources = definition.requiredSourceIds.map((sourceId) => sourceById.get(sourceId))
      .filter((source): source is FinopsSourceHealth => source !== undefined);
    const supplementalSources = definition.supplementalSourceIds.map((sourceId) => sourceById.get(sourceId))
      .filter((source): source is FinopsSourceHealth => source !== undefined);
    const state = capabilityState(requiredSources, supplementalSources);
    return {
      id: definition.id,
      name: definition.name,
      level: definition.level,
      documentationUrl: definition.documentationUrl,
      state,
      ready: state === "healthy",
      requiredSources: requiredSources.map((source) => ({ sourceId: source.id, state: source.state })),
      supplementalSources: supplementalSources.map((source) => ({ sourceId: source.id, state: source.state })),
      blockingSourceIds: requiredSources.filter((source) => source.state !== "healthy").map((source) => source.id),
    };
  });

  return {
    // Tenant identifiers are intentionally not echoed. The connection is the
    // smallest useful reference and was already resolved inside the session's
    // org/customer authorization boundary by the API adapter.
    scope: { connectionId: input.scope.connectionId },
    generatedAt: new Date(nowMs).toISOString(),
    summary: {
      sources: countsFor(sources.map((source) => source.state)),
      capabilities: countsFor(capabilities.map((capability) => capability.state)),
      readyCapabilities: capabilities.filter((capability) => capability.ready).length,
      totalCapabilities: capabilities.length,
    },
    sources,
    capabilities,
    disclaimer:
      "Readiness is derived only from persisted, tenant-scoped source evidence. Missing evidence is never treated as configured; partial or supplemental data does not prove invoice reconciliation or AWS export completeness.",
  };
}
