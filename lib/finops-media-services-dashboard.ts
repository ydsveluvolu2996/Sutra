import {
  buildMediaServicesDashboard,
  type MediaCostBasis,
  type MediaCostService,
  type MediaProvider,
  type MediaResourceType,
  type MediaServicesDashboard,
  type MediaServicesSnapshot,
} from "./finops-media-services-insights.ts";

export interface MediaServicesAcceptedHead {
  readonly generationId: string;
  readonly contentSha256: string;
  readonly snapshot: MediaServicesSnapshot;
}

export interface MediaServicesDashboardFilters {
  readonly accountId: string | null;
  readonly region: string | null;
  readonly service: MediaCostService | null;
  readonly provider: MediaProvider | null;
  readonly resourceType: MediaResourceType | null;
  readonly search: string | null;
}

export interface MediaServicesPortfolio {
  readonly schemaVersion: "sutra.media-services-insights-portfolio.v1";
  readonly generatedAtIso: string;
  readonly filters: MediaServicesDashboardFilters;
  readonly executiveSummary: {
    readonly targetCount: number;
    readonly accountCount: number;
    readonly regionCount: number;
    readonly resourceCount: number;
    readonly costRowCount: number;
    readonly costGroups: readonly CostGroup[];
  };
  readonly workflows: readonly WorkflowSummary[];
  readonly trends: readonly TrendPoint[];
  readonly forecast: readonly ForecastPoint[];
  readonly reservations: {
    readonly reservationCount: number;
    readonly offeringCount: number;
    readonly channelCount: number;
    readonly savingsStatus: "unavailable";
    readonly reason: string;
  };
  readonly budget: {
    readonly available: false;
    readonly reason: string;
  };
  readonly targets: readonly PortfolioTarget[];
  readonly filterOptions: {
    readonly accounts: readonly string[];
    readonly regions: readonly string[];
    readonly services: readonly MediaCostService[];
    readonly providers: readonly MediaProvider[];
    readonly resourceTypes: readonly MediaResourceType[];
  };
  readonly limitations: readonly string[];
}

export interface CostGroup {
  readonly currency: string;
  readonly costBasis: MediaCostBasis;
  readonly costMicros: string;
}

export interface WorkflowSummary {
  readonly id: "MEDIACONNECT_FLOW" | "MEDIACONVERT_PROCESSING" | "MEDIALIVE_CHANNEL" | "MEDIATAILOR_AD_INSERTION" | "MEDIAPACKAGE_ORIGINATION";
  readonly label: string;
  readonly resourceCount: number;
  readonly costGroups: readonly CostGroup[];
  readonly signals: readonly string[];
}

export interface TrendPoint extends CostGroup {
  readonly period: string;
  readonly service: MediaCostService;
  readonly rowCount: number;
}

export interface ForecastPoint extends CostGroup {
  readonly period: string;
  readonly service: MediaCostService;
  readonly method: "SUTRA_TRAILING_THREE_PERIOD_MEAN";
  readonly observedPeriodCount: number;
}

export interface PortfolioTarget {
  readonly generationId: string;
  readonly contentSha256: string;
  readonly accountId: string;
  readonly partition: string;
  readonly region: string;
  readonly captureId: string;
  readonly completedAtIso: string;
  readonly state: MediaServicesSnapshot["state"];
  readonly lineage: MediaServicesDashboard["lineage"];
  readonly providerCoverage: MediaServicesDashboard["providerCoverage"];
  readonly serviceSummary: MediaServicesDashboard["serviceSummary"];
  readonly usage: MediaServicesDashboard["usage"];
  readonly resources: MediaServicesDashboard["resources"];
  readonly limitations: readonly string[];
}

const WORKFLOWS = Object.freeze([
  { id: "MEDIACONNECT_FLOW", label: "MediaConnect connections & data transfer", services: ["MEDIACONNECT"], resourceTypes: ["FLOW"] },
  { id: "MEDIACONVERT_PROCESSING", label: "MediaConvert jobs, queues & processing", services: ["MEDIACONVERT"], resourceTypes: ["JOB", "QUEUE"] },
  { id: "MEDIALIVE_CHANNEL", label: "MediaLive channels, utilization & reservations", services: ["MEDIALIVE"], resourceTypes: ["CHANNEL", "MULTIPLEX", "OFFERING", "RESERVATION"] },
  { id: "MEDIATAILOR_AD_INSERTION", label: "MediaTailor ad insertion & sessions", services: ["MEDIATAILOR"], resourceTypes: ["PLAYBACK_CONFIGURATION", "CHANNEL", "SOURCE_LOCATION", "LIVE_SOURCE", "VOD_SOURCE"] },
  { id: "MEDIAPACKAGE_ORIGINATION", label: "MediaPackage packaging, origination & endpoints", services: ["MEDIAPACKAGE"], resourceTypes: ["CHANNEL_GROUP", "CHANNEL", "ORIGIN_ENDPOINT", "HARVEST_JOB"] },
] as const);

function add(map: Map<string, bigint>, key: string, amount: string): void {
  map.set(key, (map.get(key) ?? BigInt(0)) + BigInt(amount));
}

function groupKey(currency: string, basis: MediaCostBasis): string {
  return JSON.stringify([currency, basis]);
}

function costGroups(map: ReadonlyMap<string, bigint>): readonly CostGroup[] {
  return [...map.entries()].map(([key, amount]) => {
    const [currency, costBasis] = JSON.parse(key) as [string, MediaCostBasis];
    return { currency, costBasis, costMicros: amount.toString() };
  }).sort((left, right) => left.currency.localeCompare(right.currency) || left.costBasis.localeCompare(right.costBasis));
}

function nextMonth(period: string): string {
  const [year, month] = period.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month!, 1));
  return date.toISOString().slice(0, 7);
}

function includesSearch(value: string, search: string | null): boolean {
  return search === null || value.toLocaleLowerCase().includes(search.toLocaleLowerCase());
}

export function buildMediaServicesPortfolio(
  allHeads: readonly MediaServicesAcceptedHead[],
  filters: MediaServicesDashboardFilters,
  nowMs = Date.now(),
): MediaServicesPortfolio {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || allHeads.length > 5_000) throw new Error("media-services-portfolio-invalid");
  const selected = allHeads.filter((head) =>
    (filters.accountId === null || head.snapshot.scope.accountId === filters.accountId)
    && (filters.region === null || head.snapshot.scope.region === filters.region));
  const targetDashboards = selected.map((head) => ({ head, dashboard: buildMediaServicesDashboard(head.snapshot, nowMs) }));
  const targets: PortfolioTarget[] = targetDashboards.map(({ head, dashboard }) => {
    const resources = dashboard.resources.filter((row) =>
      (filters.service === null || row.observation.service === filters.service)
      && (filters.provider === null || row.observation.provider === filters.provider)
      && (filters.resourceType === null || row.observation.resourceType === filters.resourceType)
      && includesSearch(`${row.observation.name} ${row.observation.resourceId} ${row.observation.resourceArn}`, filters.search));
    const allowedServices = new Set(resources.map((row) => row.observation.service));
    const serviceSummary = dashboard.serviceSummary.filter((row) =>
      (filters.service === null ? (filters.search === null && filters.provider === null && filters.resourceType === null) || allowedServices.has(row.service) : row.service === filters.service));
    const usage = dashboard.usage.filter((row) =>
      (filters.service === null || row.service === filters.service)
      && (filters.search === null || includesSearch(`${row.service} ${row.operation ?? ""} ${row.usageType ?? ""} ${row.unit ?? ""}`, filters.search)));
    return {
      generationId: head.generationId, contentSha256: head.contentSha256,
      accountId: head.snapshot.scope.accountId, partition: head.snapshot.scope.partition,
      region: head.snapshot.scope.region, captureId: head.snapshot.captureId,
      completedAtIso: head.snapshot.completedAtIso, state: head.snapshot.state,
      lineage: dashboard.lineage, providerCoverage: dashboard.providerCoverage,
      serviceSummary, usage, resources, limitations: dashboard.limitations,
    };
  });

  const totalCosts = new Map<string, bigint>();
  const workflowCosts = new Map<string, Map<string, bigint>>();
  const trends = new Map<string, { period: string; service: MediaCostService; currency: string; costBasis: MediaCostBasis; cost: bigint; rows: number }>();
  let costRowCount = 0;
  for (const { head } of targetDashboards) {
    const currency = head.snapshot.costEvidence.currency;
    const basis = head.snapshot.costEvidence.costBasis;
    for (const row of head.snapshot.costEvidence.rows) {
      if (filters.service !== null && row.service !== filters.service) continue;
      if (filters.search !== null && !includesSearch(`${row.service} ${row.operation ?? ""} ${row.usageType ?? ""} ${row.resourceArn ?? ""}`, filters.search)) continue;
      const costsKey = groupKey(currency, basis); add(totalCosts, costsKey, row.costMicros); costRowCount += 1;
      const workflow = WORKFLOWS.find((item) => item.services.includes(row.service as never));
      if (workflow) {
        const byGroup = workflowCosts.get(workflow.id) ?? new Map<string, bigint>();
        add(byGroup, costsKey, row.costMicros); workflowCosts.set(workflow.id, byGroup);
      }
      const period = row.chargePeriodStartIso.slice(0, 7);
      const trendKey = JSON.stringify([period, row.service, currency, basis]);
      const point = trends.get(trendKey) ?? { period, service: row.service, currency, costBasis: basis, cost: BigInt(0), rows: 0 };
      point.cost += BigInt(row.costMicros); point.rows += 1; trends.set(trendKey, point);
    }
  }
  const trendRows: TrendPoint[] = [...trends.values()].map((point) => ({
    period: point.period, service: point.service, currency: point.currency, costBasis: point.costBasis,
    costMicros: point.cost.toString(), rowCount: point.rows,
  })).sort((left, right) => left.period.localeCompare(right.period) || left.service.localeCompare(right.service)
    || left.currency.localeCompare(right.currency) || left.costBasis.localeCompare(right.costBasis));
  const forecastGroups = new Map<string, TrendPoint[]>();
  for (const point of trendRows) {
    const key = JSON.stringify([point.service, point.currency, point.costBasis]);
    forecastGroups.set(key, [...(forecastGroups.get(key) ?? []), point]);
  }
  const forecast: ForecastPoint[] = [];
  for (const points of forecastGroups.values()) {
    if (points.length < 2) continue;
    const recent = points.slice(-3); const total = recent.reduce((sum, point) => sum + BigInt(point.costMicros), BigInt(0));
    const last = recent.at(-1)!;
    forecast.push({ period: nextMonth(last.period), service: last.service, currency: last.currency,
      costBasis: last.costBasis, costMicros: (total / BigInt(recent.length)).toString(),
      method: "SUTRA_TRAILING_THREE_PERIOD_MEAN", observedPeriodCount: recent.length });
  }
  const allResources = targets.flatMap((target) => target.resources);
  const workflows: WorkflowSummary[] = WORKFLOWS.map((workflow) => {
    const resources = allResources.filter((row) => workflow.services.includes(row.observation.service as never)
      && workflow.resourceTypes.includes(row.observation.resourceType as never));
    const signals = [...new Set(resources.flatMap((row) => row.observation.attributes.map((attribute) => attribute.key)))].sort();
    return { id: workflow.id, label: workflow.label, resourceCount: resources.length,
      costGroups: costGroups(workflowCosts.get(workflow.id) ?? new Map()), signals };
  });
  return {
    schemaVersion: "sutra.media-services-insights-portfolio.v1", generatedAtIso: new Date(nowMs).toISOString(), filters,
    executiveSummary: {
      targetCount: targets.length, accountCount: new Set(targets.map((target) => target.accountId)).size,
      regionCount: new Set(targets.map((target) => target.region)).size, resourceCount: allResources.length,
      costRowCount, costGroups: costGroups(totalCosts),
    },
    workflows, trends: trendRows, forecast: forecast.sort((a, b) => a.period.localeCompare(b.period) || a.service.localeCompare(b.service)),
    reservations: {
      reservationCount: allResources.filter((row) => row.observation.resourceType === "RESERVATION").length,
      offeringCount: allResources.filter((row) => row.observation.resourceType === "OFFERING").length,
      channelCount: allResources.filter((row) => row.observation.provider === "MEDIALIVE" && row.observation.resourceType === "CHANNEL").length,
      savingsStatus: "unavailable",
      reason: "Savings require a versioned on-demand price comparison that is not part of the accepted Media Services/CUR2 evidence contract.",
    },
    budget: { available: false, reason: "No AWS Budgets evidence is included in this dashboard contract; the UI does not invent a threshold." },
    targets,
    filterOptions: {
      accounts: [...new Set(allHeads.map((head) => head.snapshot.scope.accountId))].sort(),
      regions: [...new Set(allHeads.map((head) => head.snapshot.scope.region))].sort(),
      services: [...new Set(allHeads.flatMap((head) => head.snapshot.resources.map((row) => row.service)))].sort(),
      providers: [...new Set(allHeads.flatMap((head) => head.snapshot.collections.map((row) => row.provider)))].sort(),
      resourceTypes: [...new Set(allHeads.flatMap((head) => head.snapshot.resources.map((row) => row.resourceType)))].sort(),
    },
    limitations: [
      "Forecasts are visibly labeled Sutra trailing-period projections, not AWS forecasts or commitments.",
      "Budget variance is unavailable until governed AWS Budgets evidence is joined by the server.",
      "MediaLive savings are not estimated without versioned on-demand price evidence.",
      "Inventory attributes describe configuration and job state; they do not prove CloudWatch utilization, viewer engagement, ad revenue, or stream reliability.",
    ],
  };
}
