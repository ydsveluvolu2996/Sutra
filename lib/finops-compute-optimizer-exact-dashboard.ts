/**
 * Bounded, report-independent read model for one exact Compute Optimizer
 * generation. The public entry point re-verifies the content-addressed
 * generation against its immutable plan set and expected tenant scope.
 */
import type {
  ComputeOptimizerMappedFieldEvidence,
  ComputeOptimizerMappedRecommendation,
  ComputeOptimizerMappedSavingsChannel,
} from "./finops-compute-optimizer-export-mapper.ts";
import {
  verifyComputeOptimizerExportGeneration,
  type ComputeOptimizerExportGeneration,
} from "./finops-compute-optimizer-export-generation.ts";
import type {
  ComputeOptimizerExportFamily,
  ComputeOptimizerExportPlanSet,
} from "./finops-compute-optimizer-export-plan.ts";

const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const SAFE_FILTER = /^[^\u0000-\u001f\u007f<>]{1,256}$/u;
const SIGNED_INTEGER = /^-?(?:0|[1-9]\d{0,18})$/u;
const PROVIDER_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?:T| )\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/u;
const SIGNED_64_MIN = -(BigInt(1) << BigInt(63));
const SIGNED_64_MAX = (BigInt(1) << BigInt(63)) - BigInt(1);
const FAMILIES = new Set<ComputeOptimizerExportFamily>([
  "EC2_INSTANCE", "AUTO_SCALING_GROUP", "EBS_VOLUME", "LAMBDA_FUNCTION",
  "ECS_SERVICE", "LICENSE", "RDS_DATABASE", "IDLE_RESOURCE",
]);
const FILTER_KEYS = new Set([
  "accountId", "region", "exportFamily", "finding", "tagKey", "tagValue",
  "groupByTagKey", "search", "offset", "limit",
]);

export const COMPUTE_OPTIMIZER_EXACT_DASHBOARD_BOUNDS = Object.freeze({
  maximumRecommendations: 100_000,
  defaultPageSize: 100,
  maximumPageSize: 500,
  maximumOffset: 100_000,
  maximumGroupValues: 2_000,
  maximumCurrencies: 64,
  maximumSerializedOutputBytes: 48 * 1_024 * 1_024,
} as const);

export interface ComputeOptimizerExactDashboardScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface ComputeOptimizerExactDashboardFilters {
  readonly accountId: string | null;
  readonly region: string | null;
  readonly exportFamily: ComputeOptimizerExportFamily | null;
  readonly finding: string | null;
  readonly tagKey: string | null;
  readonly tagValue: string | null;
  readonly groupByTagKey: string | null;
  readonly search: string | null;
  readonly offset: number;
  readonly limit: number;
}

export interface ComputeOptimizerExactMoney {
  readonly scope: "RESOURCE" | "INSTANCE" | "STORAGE";
  readonly includesExistingDiscounts: boolean;
  readonly currency: string;
  readonly amountMicros: string;
}

export interface ComputeOptimizerExactGroupKey {
  readonly state: "PRESENT" | "MISSING" | "NOT_SELECTED";
  readonly value: string | null;
}

export interface ComputeOptimizerExactCountGroup {
  readonly key: ComputeOptimizerExactGroupKey;
  readonly count: number;
}

export interface ComputeOptimizerExactSavingsGroup extends ComputeOptimizerExactCountGroup {
  readonly savings: readonly ComputeOptimizerExactMoney[];
}

export interface ComputeOptimizerExactDashboardRow {
  readonly key: string;
  readonly accountId: string;
  readonly region: string;
  readonly exportFamily: ComputeOptimizerExportFamily;
  readonly resourceArn: string;
  readonly resourceId: string;
  readonly lastRefreshDate: string | null;
  readonly findings: readonly {
    readonly scope: "RESOURCE" | "INSTANCE" | "STORAGE";
    readonly value: string;
    readonly reasonCodes: readonly string[];
  }[];
  readonly currentConfiguration: readonly ComputeOptimizerMappedFieldEvidence[];
  readonly recommendedConfiguration: readonly ComputeOptimizerMappedFieldEvidence[];
  readonly currentRisk: readonly ComputeOptimizerMappedFieldEvidence[];
  readonly rankedOptions: ComputeOptimizerMappedRecommendation["rankedOptions"];
  readonly selectedSavings: readonly ComputeOptimizerExactMoney[];
  readonly unresolvedSavingsChannelCount: number;
  readonly tags: ComputeOptimizerMappedRecommendation["tags"];
  readonly lineage: {
    readonly jobId: string;
    readonly requestSha256: string;
    readonly csvObjectKey: string;
    readonly csvObjectVersionId: string | null;
    readonly csvSha256: string;
    readonly metadataObjectKey: string;
    readonly metadataObjectVersionId: string | null;
    readonly metadataSha256: string;
  };
}

interface VisualPage {
  readonly rowKeys: readonly string[];
  readonly total: number;
  readonly hasMore: boolean;
}

export interface ComputeOptimizerExactDashboard {
  readonly schemaVersion: "sutra.finops-compute-optimizer-exact-dashboard.v1";
  readonly scope: ComputeOptimizerExactDashboardScope;
  readonly requesterAccountId: string;
  readonly partition: ComputeOptimizerExportGeneration["partition"];
  readonly generation: Pick<ComputeOptimizerExportGeneration,
    "generationId" | "contentSha256" | "planSetId" | "planSetContentSha256"
    | "scheduledWindow" | "materializedAtIso" | "dataThroughAtIso" | "observedAtIso"
    | "regions" | "exportFamilies" | "coverage" | "schemaAssurances" | "unresolvedEvidence">;
  readonly filters: ComputeOptimizerExactDashboardFilters;
  readonly filterOptions: {
    readonly accounts: readonly string[];
    readonly regions: readonly string[];
    readonly exportFamilies: readonly ComputeOptimizerExportFamily[];
    readonly findings: readonly string[];
    readonly tagKeys: readonly string[];
    readonly tagValues: readonly string[];
  };
  readonly summary: {
    readonly recommendationCount: number;
    readonly filteredRecommendationCount: number;
    readonly rejectedRowCount: number;
    readonly selectedExactSavings: readonly ComputeOptimizerExactMoney[];
    readonly selectedExactSavingsChannelCount: number;
    readonly unresolvedSavingsChannelCount: number;
    readonly resourcesWithCurrentRiskEvidence: number;
  };
  /** Canonical row dictionary; visual pages carry keys and never duplicate rows. */
  readonly rows: readonly ComputeOptimizerExactDashboardRow[];
  readonly visuals: {
    readonly totalInstances: number;
    readonly findings: readonly ComputeOptimizerExactCountGroup[];
    readonly findingsByDate: readonly ComputeOptimizerExactCountGroup[];
    readonly findingsByBusinessUnit: readonly ComputeOptimizerExactCountGroup[];
    readonly operationalRiskFindingCount: number;
    readonly maximumPotentialSavingsEc2: readonly {
      readonly resourceArn: string;
      readonly savings: ComputeOptimizerExactMoney;
    }[];
    readonly potentialSavingsByDate: readonly ComputeOptimizerExactSavingsGroup[];
    readonly potentialSavingsByBusinessUnit: readonly ComputeOptimizerExactSavingsGroup[];
    readonly operationalRisksByBusinessUnit: readonly ComputeOptimizerExactCountGroup[];
    readonly selectedInstances: VisualPage;
    readonly currentVersusRecommendedOptionProjection: VisualPage;
    readonly recommendedInstanceFamilyChanges: VisualPage;
    readonly potentialSavingsHistogram: readonly {
      readonly currency: string;
      readonly bucket: "NEGATIVE" | "ZERO" | "LT_1" | "1_TO_LT_10" | "10_TO_LT_100" | "100_TO_LT_1000" | "GTE_1000";
      readonly count: number;
    }[];
    readonly potentialSavingsByInstance: VisualPage;
  };
  readonly page: VisualPage;
  readonly limitations: readonly string[];
}

export class ComputeOptimizerExactDashboardError extends Error {
  // Declared and assigned rather than a constructor parameter property: Node's default strip-only TypeScript mode
  // cannot transform parameter properties, so any test importing this module without the transform loader fails to
  // load it.
  public readonly code: "INVALID_INPUT" | "LIMIT_EXCEEDED";
  public constructor(code: ComputeOptimizerExactDashboardError["code"]) {
    super("Compute Optimizer exact dashboard projection rejected");
    this.name = "ComputeOptimizerExactDashboardError";
    this.code = code;
  }
}

function reject(code: ComputeOptimizerExactDashboardError["code"]): never {
  throw new ComputeOptimizerExactDashboardError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeOptional(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() !== value || !SAFE_FILTER.test(value)) reject("INVALID_INPUT");
  return value;
}

function filtersFrom(value: unknown): ComputeOptimizerExactDashboardFilters {
  if (value !== undefined && (!isRecord(value)
    || Object.keys(value).some((key) => !FILTER_KEYS.has(key)))) reject("INVALID_INPUT");
  const record = value ?? {} as Readonly<Record<string, unknown>>;
  const accountId = safeOptional(record.accountId);
  const region = safeOptional(record.region);
  const exportFamily = safeOptional(record.exportFamily);
  const result = {
    accountId,
    region,
    exportFamily: exportFamily as ComputeOptimizerExportFamily | null,
    finding: safeOptional(record.finding),
    tagKey: safeOptional(record.tagKey),
    tagValue: safeOptional(record.tagValue),
    groupByTagKey: safeOptional(record.groupByTagKey),
    search: safeOptional(record.search),
    offset: record.offset ?? 0,
    limit: record.limit ?? COMPUTE_OPTIMIZER_EXACT_DASHBOARD_BOUNDS.defaultPageSize,
  };
  if ((accountId !== null && !ACCOUNT_ID.test(accountId))
    || (region !== null && !REGION.test(region))
    || (exportFamily !== null && !FAMILIES.has(exportFamily as ComputeOptimizerExportFamily))
    || !Number.isSafeInteger(result.offset) || (result.offset as number) < 0
    || (result.offset as number) > COMPUTE_OPTIMIZER_EXACT_DASHBOARD_BOUNDS.maximumOffset
    || !Number.isSafeInteger(result.limit) || (result.limit as number) < 1
    || (result.limit as number) > COMPUTE_OPTIMIZER_EXACT_DASHBOARD_BOUNDS.maximumPageSize
    || (result.tagValue !== null && result.tagKey === null)) reject("INVALID_INPUT");
  return Object.freeze(result as ComputeOptimizerExactDashboardFilters);
}

function exactAmount(value: string): bigint {
  if (!SIGNED_INTEGER.test(value) || value === "-0") reject("INVALID_INPUT");
  const parsed = BigInt(value);
  if (parsed < SIGNED_64_MIN || parsed > SIGNED_64_MAX) reject("INVALID_INPUT");
  return parsed;
}

function channelKey(channel: Pick<ComputeOptimizerMappedSavingsChannel,
  "scope" | "includesExistingDiscounts" | "currency">): string {
  return `${channel.scope}\u0000${channel.includesExistingDiscounts ? "1" : "0"}\u0000${channel.currency}`;
}

/** Choose post-discount evidence per scope/currency when present, otherwise pre-discount. */
function selectedSavings(recommendation: ComputeOptimizerMappedRecommendation): readonly ComputeOptimizerExactMoney[] {
  const exact = recommendation.savings.filter((channel): channel is ComputeOptimizerMappedSavingsChannel =>
    channel.normalizationState !== "UNRESOLVED_PROVIDER_CSV_LABEL");
  const preferred = new Map<string, ComputeOptimizerMappedSavingsChannel>();
  for (const channel of exact) {
    exactAmount(channel.amountMicros);
    const base = `${channel.scope}\u0000${channel.currency}`;
    const current = preferred.get(base);
    if (current === undefined || (!current.includesExistingDiscounts && channel.includesExistingDiscounts)) {
      preferred.set(base, channel);
    } else if (current.includesExistingDiscounts === channel.includesExistingDiscounts) {
      reject("INVALID_INPUT");
    }
  }
  return Object.freeze([...preferred.values()].sort((left, right) =>
    compare(channelKey(left), channelKey(right))).map((channel) => Object.freeze({
      scope: channel.scope,
      includesExistingDiscounts: channel.includesExistingDiscounts,
      currency: channel.currency,
      amountMicros: channel.amountMicros,
    })));
}

function aggregateMoney(rows: readonly (readonly ComputeOptimizerExactMoney[])[]): readonly ComputeOptimizerExactMoney[] {
  const totals = new Map<string, { template: ComputeOptimizerExactMoney; amount: bigint }>();
  for (const money of rows) for (const item of money) {
    const key = channelKey(item);
    const current = totals.get(key);
    totals.set(key, { template: item, amount: (current?.amount ?? BigInt(0)) + exactAmount(item.amountMicros) });
    if (totals.size > COMPUTE_OPTIMIZER_EXACT_DASHBOARD_BOUNDS.maximumCurrencies * 3 * 2) reject("LIMIT_EXCEEDED");
  }
  return Object.freeze([...totals].sort(([left], [right]) => compare(left, right)).map(([, value]) =>
    Object.freeze({ ...value.template, amountMicros: value.amount.toString() })));
}

function canonicalDate(value: string): string | null {
  if (!PROVIDER_TIMESTAMP.test(value)) return null;
  const literalDate = value.slice(0, 10);
  const dateEpoch = Date.parse(`${literalDate}T00:00:00.000Z`);
  if (!Number.isSafeInteger(dateEpoch)
    || new Date(dateEpoch).toISOString().slice(0, 10) !== literalDate) return null;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const hasZone = /(?:Z|[+-]\d{2}:\d{2})$/u.test(normalized);
  const instant = Date.parse(hasZone ? normalized : `${normalized}Z`);
  if (!Number.isSafeInteger(instant)) return null;
  const time = /^\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2}):(\d{2})/u.exec(value);
  if (time === null || Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3]) > 59) return null;
  const offset = /([+-])(\d{2}):(\d{2})$/u.exec(normalized);
  if (offset !== null && (Number(offset[2]) > 14 || Number(offset[3]) > 59)) return null;
  return new Date(instant).toISOString().slice(0, 10);
}

function keyToken(key: ComputeOptimizerExactGroupKey): string {
  return `${key.state}\u0000${key.value ?? ""}`;
}

function present(value: string): ComputeOptimizerExactGroupKey {
  return Object.freeze({ state: "PRESENT", value });
}

function groupTag(recommendation: ComputeOptimizerMappedRecommendation, key: string | null): ComputeOptimizerExactGroupKey {
  if (key === null) return Object.freeze({ state: "NOT_SELECTED", value: null });
  const tag = recommendation.tags.find((candidate) => candidate.key === key);
  return tag === undefined
    ? Object.freeze({ state: "MISSING", value: null })
    : present(tag.value);
}

function addCount(map: Map<string, { key: ComputeOptimizerExactGroupKey; count: number }>, key: ComputeOptimizerExactGroupKey): void {
  const token = keyToken(key);
  const current = map.get(token);
  map.set(token, { key, count: (current?.count ?? 0) + 1 });
  if (map.size > COMPUTE_OPTIMIZER_EXACT_DASHBOARD_BOUNDS.maximumGroupValues) reject("LIMIT_EXCEEDED");
}

function countGroups(map: ReadonlyMap<string, { key: ComputeOptimizerExactGroupKey; count: number }>): readonly ComputeOptimizerExactCountGroup[] {
  return Object.freeze([...map].sort(([left], [right]) => compare(left, right))
    .map(([, value]) => Object.freeze(value)));
}

function matches(recommendation: ComputeOptimizerMappedRecommendation, filters: ComputeOptimizerExactDashboardFilters): boolean {
  if (filters.accountId !== null && recommendation.accountId !== filters.accountId) return false;
  if (filters.region !== null && recommendation.region !== filters.region) return false;
  if (filters.exportFamily !== null && recommendation.exportFamily !== filters.exportFamily) return false;
  if (filters.finding !== null && !recommendation.findings.some((finding) => finding.finding.raw === filters.finding)) return false;
  if (filters.tagKey !== null && !recommendation.tags.some((tag) =>
    tag.key === filters.tagKey && (filters.tagValue === null || tag.value === filters.tagValue))) return false;
  if (filters.search !== null) {
    const needle = filters.search.toLocaleLowerCase("en-US");
    const values = [recommendation.resourceArn, recommendation.resourceId, recommendation.accountId,
      recommendation.region, recommendation.exportFamily,
      ...recommendation.findings.map((finding) => finding.finding.raw),
      ...recommendation.tags.flatMap((tag) => [tag.key, tag.value])];
    if (!values.some((item) => item.toLocaleLowerCase("en-US").includes(needle))) return false;
  }
  return true;
}

function familyChange(recommendation: ComputeOptimizerMappedRecommendation): boolean {
  if (recommendation.exportFamily !== "EC2_INSTANCE") return false;
  const current = recommendation.currentConfiguration.find((field) => field.apiField === "CurrentInstanceType")?.raw;
  const proposed = recommendation.rankedOptions.find((option) => option.rank === 1)?.configuration
    .find((field) => field.apiField === "RecommendationOptionsInstanceType")?.raw;
  const family = (value: string | undefined): string | null => {
    if (value === undefined) return null;
    const match = /^([a-z][a-z0-9-]{0,31})\.[a-z0-9-]{1,32}$/u.exec(value);
    return match?.[1] ?? null;
  };
  const currentFamily = family(current);
  const proposedFamily = family(proposed);
  return currentFamily !== null && proposedFamily !== null && currentFamily !== proposedFamily;
}

function rowFor(generationId: string, item: SourceRecommendation): ComputeOptimizerExactDashboardRow {
  const { recommendation, source } = item;
  const money = selectedSavings(recommendation);
  return Object.freeze({
    key: `${generationId}:${source.jobId}:${recommendation.rowNumber}:${recommendation.resourceArn}`,
    accountId: recommendation.accountId,
    region: recommendation.region,
    exportFamily: recommendation.exportFamily,
    resourceArn: recommendation.resourceArn,
    resourceId: recommendation.resourceId,
    lastRefreshDate: canonicalDate(recommendation.lastRefreshTimestamp),
    findings: Object.freeze(recommendation.findings.map((finding) => Object.freeze({
      scope: finding.scope, value: finding.finding.raw,
      reasonCodes: Object.freeze(finding.reasons.map((reason) => reason.raw)),
    }))),
    currentConfiguration: recommendation.currentConfiguration,
    recommendedConfiguration: recommendation.recommendedConfiguration,
    currentRisk: recommendation.currentRisk,
    rankedOptions: recommendation.rankedOptions,
    selectedSavings: money,
    unresolvedSavingsChannelCount: recommendation.savings.filter((channel) =>
      channel.normalizationState === "UNRESOLVED_PROVIDER_CSV_LABEL").length,
    tags: recommendation.tags,
    lineage: Object.freeze({
      jobId: source.jobId,
      requestSha256: source.requestSha256,
      csvObjectKey: source.csvObject.key,
      csvObjectVersionId: source.csvObject.versionId,
      csvSha256: source.csvSha256,
      metadataObjectKey: source.metadataObject.key,
      metadataObjectVersionId: source.metadataObject.versionId,
      metadataSha256: source.metadataSha256,
    }),
  });
}

interface SourceRecommendation {
  readonly recommendation: ComputeOptimizerMappedRecommendation;
  readonly source: ComputeOptimizerExportGeneration["targets"][number]["source"];
}

function sorted(items: readonly SourceRecommendation[]): SourceRecommendation[] {
  return [...items].sort((left, right) => compare(left.recommendation.accountId, right.recommendation.accountId)
    || compare(left.recommendation.region, right.recommendation.region)
    || compare(left.recommendation.exportFamily, right.recommendation.exportFamily)
    || compare(left.recommendation.resourceArn, right.recommendation.resourceArn)
    || compare(left.source.jobId, right.source.jobId)
    || left.recommendation.rowNumber - right.recommendation.rowNumber);
}

function visualPage(items: readonly SourceRecommendation[], generationId: string,
  filters: ComputeOptimizerExactDashboardFilters): VisualPage {
  const pageItems = items.slice(filters.offset, filters.offset + filters.limit);
  return Object.freeze({
    rowKeys: Object.freeze(pageItems.map(({ recommendation, source }) =>
      `${generationId}:${source.jobId}:${recommendation.rowNumber}:${recommendation.resourceArn}`)),
    total: items.length,
    hasMore: filters.offset + pageItems.length < items.length,
  });
}

function histogramBucket(value: bigint): ComputeOptimizerExactDashboard["visuals"]["potentialSavingsHistogram"][number]["bucket"] {
  if (value < BigInt(0)) return "NEGATIVE";
  if (value === BigInt(0)) return "ZERO";
  if (value < BigInt(1_000_000)) return "LT_1";
  if (value < BigInt(10_000_000)) return "1_TO_LT_10";
  if (value < BigInt(100_000_000)) return "10_TO_LT_100";
  if (value < BigInt(1_000_000_000)) return "100_TO_LT_1000";
  return "GTE_1000";
}

/** Re-verify and project an accepted exact generation. */
export async function buildComputeOptimizerExactDashboard(input: {
  readonly scope: ComputeOptimizerExactDashboardScope;
  readonly planSet: ComputeOptimizerExportPlanSet;
  readonly generation: ComputeOptimizerExportGeneration;
  readonly filters?: unknown;
}): Promise<ComputeOptimizerExactDashboard> {
  const { scope, planSet } = input;
  if (planSet.scope.orgId !== scope.organizationId || planSet.scope.customerId !== scope.customerId
    || planSet.scope.connectionId !== scope.connectionId) reject("INVALID_INPUT");
  let generation: ComputeOptimizerExportGeneration;
  try {
    generation = await verifyComputeOptimizerExportGeneration(planSet, input.generation, {
      scheduledWindow: input.generation.scheduledWindow,
      materializedAtMs: Date.parse(input.generation.materializedAtIso),
      limits: { maximumSerializedBytes: 32 * 1_024 * 1_024 },
    });
  } catch {
    reject("INVALID_INPUT");
  }
  if (generation.scope.orgId !== scope.organizationId || generation.scope.customerId !== scope.customerId
    || generation.scope.connectionId !== scope.connectionId) reject("INVALID_INPUT");
  if (generation.coverage.recommendationCount
    > COMPUTE_OPTIMIZER_EXACT_DASHBOARD_BOUNDS.maximumRecommendations) reject("LIMIT_EXCEEDED");
  const filters = filtersFrom(input.filters);
  const all: SourceRecommendation[] = [];
  for (const target of generation.targets) for (const recommendation of target.recommendations) {
    all.push({ recommendation, source: target.source });
  }
  if (all.length !== generation.coverage.recommendationCount) reject("INVALID_INPUT");
  const filtered = sorted(all.filter(({ recommendation }) => matches(recommendation, filters)));

  const accounts = new Set<string>();
  const regions = new Set<string>();
  const families = new Set<ComputeOptimizerExportFamily>();
  const findings = new Set<string>();
  const tagKeys = new Set<string>();
  const tagValues = new Set<string>();
  const findingGroups = new Map<string, { key: ComputeOptimizerExactGroupKey; count: number }>();
  const dateGroups = new Map<string, { key: ComputeOptimizerExactGroupKey; count: number }>();
  const businessGroups = new Map<string, { key: ComputeOptimizerExactGroupKey; count: number }>();
  const riskBusinessGroups = new Map<string, { key: ComputeOptimizerExactGroupKey; count: number }>();
  const dateMoney = new Map<string, ComputeOptimizerExactMoney[][]>();
  const businessMoney = new Map<string, ComputeOptimizerExactMoney[][]>();
  const summaryMoney: ComputeOptimizerExactMoney[][] = [];
  const histogram = new Map<string, number>();
  let unresolved = 0;
  let selectedChannelCount = 0;
  let currentRiskCount = 0;
  const maximumEc2 = new Map<string, { resourceArn: string; savings: ComputeOptimizerExactMoney; amount: bigint }>();
  for (const { recommendation } of filtered) {
    accounts.add(recommendation.accountId); regions.add(recommendation.region); families.add(recommendation.exportFamily);
    for (const finding of recommendation.findings) findings.add(finding.finding.raw);
    for (const tag of recommendation.tags) {
      tagKeys.add(tag.key);
      if (filters.tagKey === null || tag.key === filters.tagKey) tagValues.add(tag.value);
    }
    if ([accounts.size, regions.size, families.size, findings.size, tagKeys.size, tagValues.size]
      .some((size) => size > COMPUTE_OPTIMIZER_EXACT_DASHBOARD_BOUNDS.maximumGroupValues)) reject("LIMIT_EXCEEDED");
    if (recommendation.findings.length === 0) addCount(findingGroups, Object.freeze({ state: "MISSING", value: null }));
    for (const finding of recommendation.findings) addCount(findingGroups, present(finding.finding.raw));
    const dateKey = canonicalDate(recommendation.lastRefreshTimestamp) === null
      ? Object.freeze({ state: "MISSING", value: null } as const)
      : present(canonicalDate(recommendation.lastRefreshTimestamp)!);
    const businessKey = groupTag(recommendation, filters.groupByTagKey);
    addCount(dateGroups, dateKey); addCount(businessGroups, businessKey);
    const money = selectedSavings(recommendation);
    summaryMoney.push(money as ComputeOptimizerExactMoney[]);
    selectedChannelCount += money.length;
    unresolved += recommendation.savings.filter((channel) =>
      channel.normalizationState === "UNRESOLVED_PROVIDER_CSV_LABEL").length;
    const dateToken = keyToken(dateKey); const businessToken = keyToken(businessKey);
    (dateMoney.get(dateToken) ?? (dateMoney.set(dateToken, []), dateMoney.get(dateToken)!)).push(money as ComputeOptimizerExactMoney[]);
    (businessMoney.get(businessToken) ?? (businessMoney.set(businessToken, []), businessMoney.get(businessToken)!)).push(money as ComputeOptimizerExactMoney[]);
    if (recommendation.currentRisk.length > 0) {
      currentRiskCount += 1;
      addCount(riskBusinessGroups, businessKey);
    }
    for (const item of money) {
      const bucket = histogramBucket(exactAmount(item.amountMicros));
      const token = `${item.currency}\u0000${bucket}`;
      histogram.set(token, (histogram.get(token) ?? 0) + 1);
    }
    if (recommendation.exportFamily === "EC2_INSTANCE") {
      for (const savings of money) {
        const key = channelKey(savings);
        const amount = exactAmount(savings.amountMicros);
        const current = maximumEc2.get(key);
        if (current === undefined || amount > current.amount
          || (amount === current.amount && recommendation.resourceArn < current.resourceArn)) {
          maximumEc2.set(key, { resourceArn: recommendation.resourceArn, savings, amount });
        }
      }
    }
  }
  const savingsGroup = (counts: ReadonlyMap<string, { key: ComputeOptimizerExactGroupKey; count: number }>,
    amounts: ReadonlyMap<string, readonly (readonly ComputeOptimizerExactMoney[])[]>): readonly ComputeOptimizerExactSavingsGroup[] =>
    Object.freeze([...counts].sort(([left], [right]) => compare(left, right)).map(([token, item]) => Object.freeze({
      key: item.key, count: item.count, savings: aggregateMoney(amounts.get(token) ?? []),
    })));
  const instance = filtered.filter(({ recommendation }) => recommendation.exportFamily === "EC2_INSTANCE");
  const currentVs = filtered.filter(({ recommendation }) => recommendation.currentConfiguration.length > 0
    && (recommendation.recommendedConfiguration.length > 0 || recommendation.rankedOptions.length > 0));
  const changes = filtered.filter(({ recommendation }) => familyChange(recommendation));
  const withSavings = instance.filter(({ recommendation }) => selectedSavings(recommendation).length > 0);
  const page = visualPage(filtered, generation.generationId, filters);
  const selectedInstances = visualPage(instance, generation.generationId, filters);
  const currentProjection = visualPage(currentVs, generation.generationId, filters);
  const familyChanges = visualPage(changes, generation.generationId, filters);
  const savingsInstances = visualPage(withSavings, generation.generationId, filters);
  const referenced = new Set([
    ...page.rowKeys,
    ...selectedInstances.rowKeys,
    ...currentProjection.rowKeys,
    ...familyChanges.rowKeys,
    ...savingsInstances.rowKeys,
  ]);
  const rows = filtered.filter(({ recommendation, source }) => referenced.has(
    `${generation.generationId}:${source.jobId}:${recommendation.rowNumber}:${recommendation.resourceArn}`,
  )).map((item) => rowFor(generation.generationId, item));
  const result: ComputeOptimizerExactDashboard = Object.freeze({
    schemaVersion: "sutra.finops-compute-optimizer-exact-dashboard.v1",
    scope: Object.freeze({ ...scope }), requesterAccountId: generation.requesterAccountId, partition: generation.partition,
    generation: Object.freeze({
      generationId: generation.generationId, contentSha256: generation.contentSha256,
      planSetId: generation.planSetId, planSetContentSha256: generation.planSetContentSha256,
      scheduledWindow: generation.scheduledWindow, materializedAtIso: generation.materializedAtIso,
      dataThroughAtIso: generation.dataThroughAtIso, observedAtIso: generation.observedAtIso,
      regions: generation.regions, exportFamilies: generation.exportFamilies, coverage: generation.coverage,
      schemaAssurances: generation.schemaAssurances, unresolvedEvidence: generation.unresolvedEvidence,
    }),
    filters,
    filterOptions: Object.freeze({ accounts: Object.freeze([...accounts].sort(compare)), regions: Object.freeze([...regions].sort(compare)),
      exportFamilies: Object.freeze([...families].sort(compare)), findings: Object.freeze([...findings].sort(compare)),
      tagKeys: Object.freeze([...tagKeys].sort(compare)), tagValues: Object.freeze([...tagValues].sort(compare)) }),
    summary: Object.freeze({ recommendationCount: generation.coverage.recommendationCount,
      filteredRecommendationCount: filtered.length, rejectedRowCount: generation.coverage.rejectedRowCount,
      selectedExactSavings: aggregateMoney(summaryMoney), selectedExactSavingsChannelCount: selectedChannelCount,
      unresolvedSavingsChannelCount: unresolved, resourcesWithCurrentRiskEvidence: currentRiskCount }),
    rows: Object.freeze(rows),
    visuals: Object.freeze({
      totalInstances: instance.length, findings: countGroups(findingGroups), findingsByDate: countGroups(dateGroups),
      findingsByBusinessUnit: countGroups(businessGroups), operationalRiskFindingCount: currentRiskCount,
      maximumPotentialSavingsEc2: Object.freeze([...maximumEc2].sort(([left], [right]) => compare(left, right))
        .map(([, item]) => Object.freeze({ resourceArn: item.resourceArn, savings: item.savings }))),
      potentialSavingsByDate: savingsGroup(dateGroups, dateMoney),
      potentialSavingsByBusinessUnit: savingsGroup(businessGroups, businessMoney),
      operationalRisksByBusinessUnit: countGroups(riskBusinessGroups),
      selectedInstances,
      currentVersusRecommendedOptionProjection: currentProjection,
      recommendedInstanceFamilyChanges: familyChanges,
      potentialSavingsHistogram: Object.freeze([...histogram].sort(([left], [right]) => compare(left, right)).map(([token, count]) => {
        const [currency, bucket] = token.split("\u0000") as [string, ComputeOptimizerExactDashboard["visuals"]["potentialSavingsHistogram"][number]["bucket"]];
        return Object.freeze({ currency, bucket, count });
      })),
      potentialSavingsByInstance: savingsInstances,
    }),
    page,
    limitations: Object.freeze([
      "Savings use after-discount evidence per scope and currency when present, otherwise pre-discount evidence; alternatives are never added together.",
      "Unresolved provider savings objects are counted but never emitted or parsed into monetary totals.",
      filters.groupByTagKey === null ? "Business-unit grouping is not selected." : `Business-unit grouping uses the exact exported tag key ${filters.groupByTagKey}.`,
      "The public QuickSight definition is unavailable; geometry and hidden calculations are not inferred from screenshots.",
    ]),
  });
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength
    > COMPUTE_OPTIMIZER_EXACT_DASHBOARD_BOUNDS.maximumSerializedOutputBytes) reject("LIMIT_EXCEEDED");
  return result;
}
