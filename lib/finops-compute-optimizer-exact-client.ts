/** Fail-closed browser parser for the exact Compute Optimizer API response. */
import { canonicalJson } from "./canonical-json.ts";
import type {
  ComputeOptimizerExactDashboard,
  ComputeOptimizerExactDashboardRow,
  ComputeOptimizerExactMoney,
} from "./finops-compute-optimizer-exact-dashboard.ts";
import {
  FINOPS_COMPUTE_OPTIMIZER_OFFICIAL_DEFINITION,
  type FinopsComputeOptimizerOfficialDefinition,
} from "./finops-compute-optimizer-official-definition.ts";

const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const SIGNED = /^-?(?:0|[1-9]\d{0,18})$/u;
const AGGREGATE_SIGNED = /^-?(?:0|[1-9]\d{0,23})$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const SAFE_FILTER = /^[^\u0000-\u001f\u007f<>]{1,256}$/u;
const MAX_RESPONSE_BYTES = 50 * 1_024 * 1_024;
const MAX_RECOMMENDATIONS = 100_000;
const MAX_GENERATION_ROWS = 40_000_000;
const MAX_SELECTED_CHANNELS_PER_RECOMMENDATION = 64 * 3;
const MAX_SAVINGS_CHANNELS_PER_RECOMMENDATION = 64 * 3 * 2;
const SIGNED_64_MIN = -(BigInt(1) << BigInt(63));
const SIGNED_64_MAX = (BigInt(1) << BigInt(63)) - BigInt(1);
const MAX_AGGREGATE_ABSOLUTE = SIGNED_64_MAX * BigInt(100_000);
const FAMILIES = new Set(["EC2_INSTANCE", "AUTO_SCALING_GROUP", "EBS_VOLUME", "LAMBDA_FUNCTION", "ECS_SERVICE", "LICENSE", "RDS_DATABASE", "IDLE_RESOURCE"]);
const ASSURANCES = new Set(["USER_GUIDE_CSV_LABEL", "API_FIELD_NAME_ONLY"]);
const DATATYPES = new Set(["string", "integer", "double", "datetime"]);
const HISTOGRAM_BUCKETS = new Set(["NEGATIVE", "ZERO", "LT_1", "1_TO_LT_10", "10_TO_LT_100", "100_TO_LT_1000", "GTE_1000"]);
const SCHEMA_ASSURANCES = new Set(["OFFICIAL_USER_GUIDE_CSV_LABELS", "API_FIELD_NAME_ONLY_UNVERIFIED", "METADATA_DERIVED_TAG_COLUMNS_UNVERIFIED"]);

export interface ComputeOptimizerExactApiPayload {
  readonly schema: "sutra.finops-compute-optimizer.v2";
  readonly connectionId: string;
  readonly sourceState: "READY" | "STALE" | "COLLECTING" | "COLLECTION_FAILED"
    | "EXPORT_CONFIGURATION_REQUIRED" | "EVIDENCE_KEY_UNAVAILABLE";
  readonly source?: "AWS_COMPUTE_OPTIMIZER_EXACT_ORGANIZATION_S3_EXPORT";
  readonly freshness?: { readonly dataThroughAt: string; readonly ageHours: number; readonly staleAfterHours: 48 };
  readonly dashboard: ComputeOptimizerExactDashboard | null;
  readonly officialDefinition: FinopsComputeOptimizerOfficialDefinition;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly collection: Readonly<Record<string, unknown>>;
  readonly limitations?: readonly string[];
}

export class ComputeOptimizerExactClientError extends Error {
  public constructor() {
    super("Compute Optimizer exact response rejected");
    this.name = "ComputeOptimizerExactClientError";
  }
}

export function hasExactComputeOptimizerOfficialDefinition(
  value: unknown,
): value is FinopsComputeOptimizerOfficialDefinition {
  try {
    return canonicalJson(value) === canonicalJson(FINOPS_COMPUTE_OPTIMIZER_OFFICIAL_DEFINITION);
  } catch {
    return false;
  }
}

function reject(): never { throw new ComputeOptimizerExactClientError(); }
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject();
  return value as Readonly<Record<string, unknown>>;
}
function exact(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort(); const wanted = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) reject();
}
function text(value: unknown, maximum = 4_096): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000]/u.test(value)) reject();
  return value;
}
function integer(value: unknown, maximum = 100_000): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) reject();
  return value;
}
function strings(value: unknown, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) reject();
  return value.map((item) => text(item));
}
function uniqueStrings(value: unknown, maximum: number): readonly string[] {
  const result = strings(value, maximum);
  if (new Set(result).size !== result.length) reject();
  return result;
}
function nullableFilter(value: unknown): string | null {
  if (value === null) return null;
  const result = text(value, 256);
  if (!SAFE_FILTER.test(result) || result.trim() !== result) reject();
  return result;
}
function iso(value: unknown): string {
  const result = text(value, 64); const epoch = Date.parse(result);
  if (!Number.isSafeInteger(epoch) || new Date(epoch).toISOString() !== result) reject();
  return result;
}
function money(value: unknown, sourceChannel: boolean): ComputeOptimizerExactMoney {
  const result = record(value); exact(result, ["scope", "includesExistingDiscounts", "currency", "amountMicros"]);
  if (!["RESOURCE", "INSTANCE", "STORAGE"].includes(String(result.scope))
    || typeof result.includesExistingDiscounts !== "boolean"
    || typeof result.currency !== "string" || !/^[A-Z]{3}$/u.test(result.currency)
    || typeof result.amountMicros !== "string"
    || !(sourceChannel ? SIGNED : AGGREGATE_SIGNED).test(result.amountMicros)
    || result.amountMicros === "-0") reject();
  const amount = BigInt(result.amountMicros);
  const maximum = sourceChannel ? SIGNED_64_MAX : MAX_AGGREGATE_ABSOLUTE;
  const minimum = sourceChannel ? SIGNED_64_MIN : -MAX_AGGREGATE_ABSOLUTE;
  if (amount < minimum || amount > maximum) reject();
  return result as unknown as ComputeOptimizerExactMoney;
}

function moneyArray(value: unknown, maximum: number, sourceChannel: boolean, alternativesAllowed: boolean): readonly ComputeOptimizerExactMoney[] {
  if (!Array.isArray(value) || value.length > maximum) reject();
  const parsed = value.map((item) => money(item, sourceChannel));
  const keys = new Set<string>();
  for (const item of parsed) {
    const key = `${item.scope}\u0000${alternativesAllowed ? String(item.includesExistingDiscounts) : "selected"}\u0000${item.currency}`;
    if (keys.has(key)) reject();
    keys.add(key);
  }
  return parsed;
}

function field(value: unknown): void {
  const result = record(value); exact(result, ["apiField", "column", "datatype", "raw", "assurance"]);
  text(result.apiField, 256); text(result.column, 2_048); text(result.raw, 4_096);
  if (!DATATYPES.has(String(result.datatype)) || !ASSURANCES.has(String(result.assurance))) reject();
}

function row(value: unknown): ComputeOptimizerExactDashboardRow {
  const result = record(value);
  exact(result, ["key", "accountId", "region", "exportFamily", "resourceArn", "resourceId", "lastRefreshDate", "findings", "currentConfiguration", "recommendedConfiguration", "currentRisk", "rankedOptions", "selectedSavings", "unresolvedSavingsChannelCount", "tags", "lineage"]);
  text(result.key, 2_048); if (typeof result.accountId !== "string" || !ACCOUNT.test(result.accountId)) reject();
  text(result.region, 64); if (typeof result.exportFamily !== "string" || !FAMILIES.has(result.exportFamily)) reject();
  text(result.resourceArn, 2_048); text(result.resourceId, 1_024);
  if (result.lastRefreshDate !== null && (typeof result.lastRefreshDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(result.lastRefreshDate))) reject();
  if (!Array.isArray(result.findings) || result.findings.length > 3) reject();
  for (const item of result.findings) {
    const finding = record(item); exact(finding, ["scope", "value", "reasonCodes"]);
    if (!["RESOURCE", "INSTANCE", "STORAGE"].includes(String(finding.scope))) reject();
    text(finding.value); strings(finding.reasonCodes, 256);
  }
  for (const name of ["currentConfiguration", "recommendedConfiguration", "currentRisk"] as const) {
    if (!Array.isArray(result[name]) || result[name].length > 2_048) reject();
    for (const item of result[name]) field(item);
  }
  if (!Array.isArray(result.rankedOptions) || result.rankedOptions.length > 10) reject();
  for (const item of result.rankedOptions) {
    const option = record(item); exact(option, ["rank", "configuration", "risk"]);
    if (integer(option.rank, 10) < 1) reject();
    if (!Array.isArray(option.configuration) || option.configuration.length > 2_048) reject();
    for (const entry of option.configuration) field(entry); if (option.risk !== null) field(option.risk);
  }
  moneyArray(result.selectedSavings, MAX_SELECTED_CHANNELS_PER_RECOMMENDATION, true, false);
  integer(result.unresolvedSavingsChannelCount, MAX_SAVINGS_CHANNELS_PER_RECOMMENDATION);
  if (!Array.isArray(result.tags) || result.tags.length > 256) reject();
  for (const item of result.tags) {
    const tag = record(item); exact(tag, ["key", "value", "column", "assurance"]);
    text(tag.key, 256); text(tag.value, 4_096); text(tag.column, 2_048); if (tag.assurance !== "CSVW_NAME_AND_TITLE") reject();
  }
  const lineage = record(result.lineage);
  exact(lineage, ["jobId", "requestSha256", "csvObjectKey", "csvObjectVersionId", "csvSha256", "metadataObjectKey", "metadataObjectVersionId", "metadataSha256"]);
  text(lineage.jobId, 256); if (typeof lineage.requestSha256 !== "string" || !SHA.test(lineage.requestSha256)) reject();
  text(lineage.csvObjectKey, 2_048); text(lineage.metadataObjectKey, 2_048);
  if (lineage.csvObjectVersionId !== null) text(lineage.csvObjectVersionId, 1_024);
  if (lineage.metadataObjectVersionId !== null) text(lineage.metadataObjectVersionId, 1_024);
  if (typeof lineage.csvSha256 !== "string" || !SHA.test(lineage.csvSha256)
    || typeof lineage.metadataSha256 !== "string" || !SHA.test(lineage.metadataSha256)) reject();
  return result as unknown as ComputeOptimizerExactDashboardRow;
}

function groupKey(value: unknown): void {
  const result = record(value); exact(result, ["state", "value"]);
  if (!["PRESENT", "MISSING", "NOT_SELECTED"].includes(String(result.state))) reject();
  if ((result.state === "PRESENT") !== (typeof result.value === "string")) reject();
  if (typeof result.value === "string") text(result.value);
}

function page(value: unknown, rowKeys: ReadonlySet<string>, offset?: number): number {
  const result = record(value); exact(result, ["rowKeys", "total", "hasMore"]);
  const keys = uniqueStrings(result.rowKeys, 500); if (keys.some((key) => !rowKeys.has(key))) reject();
  const total = integer(result.total); if (total < keys.length || typeof result.hasMore !== "boolean") reject();
  if (offset !== undefined && result.hasMore !== (offset + keys.length < total)) reject();
  return total;
}

function filters(value: unknown): void {
  const result = record(value);
  exact(result, ["accountId", "region", "exportFamily", "finding", "tagKey", "tagValue", "groupByTagKey", "search", "offset", "limit"]);
  const accountId = nullableFilter(result.accountId);
  const region = nullableFilter(result.region);
  const family = nullableFilter(result.exportFamily);
  nullableFilter(result.finding); const tagKey = nullableFilter(result.tagKey);
  const tagValue = nullableFilter(result.tagValue); nullableFilter(result.groupByTagKey); nullableFilter(result.search);
  if ((accountId !== null && !ACCOUNT.test(accountId)) || (region !== null && !REGION.test(region))
    || (family !== null && !FAMILIES.has(family)) || (tagValue !== null && tagKey === null)
    || integer(result.offset) > 100_000 || integer(result.limit, 500) < 1) reject();
}

function filterOptions(value: unknown): void {
  const result = record(value);
  exact(result, ["accounts", "regions", "exportFamilies", "findings", "tagKeys", "tagValues"]);
  const accounts = uniqueStrings(result.accounts, 2_000); if (accounts.some((item) => !ACCOUNT.test(item))) reject();
  const regions = uniqueStrings(result.regions, 2_000); if (regions.some((item) => !REGION.test(item))) reject();
  const families = uniqueStrings(result.exportFamilies, 8); if (families.some((item) => !FAMILIES.has(item))) reject();
  uniqueStrings(result.findings, 2_000); uniqueStrings(result.tagKeys, 2_000); uniqueStrings(result.tagValues, 2_000);
}

function coverage(value: unknown): number {
  const result = record(value);
  exact(result, ["expectedTargetCount", "mappedTargetCount", "rowCount", "recommendationCount", "rejectedRowCount", "sourceBytes"]);
  const expected = integer(result.expectedTargetCount, 400);
  const mapped = integer(result.mappedTargetCount, 400);
  if (mapped !== expected) reject();
  const rowCount = integer(result.rowCount, MAX_GENERATION_ROWS);
  const recommendationCount = integer(result.recommendationCount, MAX_RECOMMENDATIONS);
  const rejectedRowCount = integer(result.rejectedRowCount, MAX_GENERATION_ROWS);
  if (rowCount !== recommendationCount + rejectedRowCount) reject();
  integer(result.sourceBytes, Number.MAX_SAFE_INTEGER);
  return expected;
}

function unresolvedEvidence(value: unknown, regions?: ReadonlySet<string>, families?: ReadonlySet<string>): void {
  const result = record(value); exact(result, ["targetCount", "savingsChannelCount", "targetKeys"]);
  const targetCount = integer(result.targetCount, 400); integer(result.savingsChannelCount, 6_400_000);
  if (!Array.isArray(result.targetKeys) || result.targetKeys.length !== targetCount) reject();
  const keys = new Set<string>();
  for (const item of result.targetKeys) {
    const key = record(item); exact(key, ["region", "exportFamily"]);
    const region = text(key.region, 64); const family = text(key.exportFamily, 32);
    if (!REGION.test(region) || !FAMILIES.has(family)
      || (regions !== undefined && !regions.has(region)) || (families !== undefined && !families.has(family))
      || keys.has(`${region}\u0000${family}`)) reject();
    keys.add(`${region}\u0000${family}`);
  }
}

function collection(value: unknown, sourceState: unknown): void {
  const result = record(value);
  if (sourceState === "READY" || sourceState === "STALE") {
    exact(result, ["available", "state", "acceptedGenerationId"]);
    if (result.available !== true || result.state !== "READY"
      || typeof result.acceptedGenerationId !== "string"
      || !/^cog_[a-f0-9]{64}$/u.test(result.acceptedGenerationId)) reject();
    return;
  }
  if (sourceState === "EVIDENCE_KEY_UNAVAILABLE") {
    exact(result, ["available", "state"]);
    if (result.available !== false || result.state !== "EXACT_EVIDENCE_KEY_NOT_CONFIGURED") reject();
    return;
  }
  exact(result, ["available", "state", "activationId", "scheduledWindow", "updatedAtIso"]);
  if (result.available !== true
    || (sourceState === "EXPORT_CONFIGURATION_REQUIRED" && result.state !== "UNAVAILABLE")
    || (sourceState === "COLLECTING" && result.state !== "COLLECTING")
    || (sourceState === "COLLECTION_FAILED" && result.state !== "FAILED")
    || (result.activationId !== null
      && (typeof result.activationId !== "string"
        || !/^comra_[a-f0-9]{64}$/u.test(result.activationId)))
    || (result.scheduledWindow !== null
      && (typeof result.scheduledWindow !== "string"
        || !/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u.test(result.scheduledWindow)))
    || (result.updatedAtIso !== null && iso(result.updatedAtIso) !== result.updatedAtIso)) reject();
}

function evidence(value: unknown, generation: Readonly<Record<string, unknown>>): void {
  const result = record(value); exact(result, ["acceptedHead", "planIds", "schemaAssurances", "unresolvedEvidence"]);
  const head = record(result.acceptedHead); exact(head, ["generationId", "planSetId", "planSetContentSha256"]);
  if (head.generationId !== generation.generationId || head.planSetId !== generation.planSetId
    || head.planSetContentSha256 !== generation.planSetContentSha256) reject();
  const planIds = uniqueStrings(result.planIds, 50);
  if (planIds.length < 1 || planIds.some((item) => !/^cope_[a-f0-9]{64}$/u.test(item))) reject();
  const assurances = uniqueStrings(result.schemaAssurances, 3);
  if (assurances.some((item) => !SCHEMA_ASSURANCES.has(item))
    || canonicalJson(assurances) !== canonicalJson(generation.schemaAssurances)) reject();
  unresolvedEvidence(result.unresolvedEvidence);
  if (canonicalJson(result.unresolvedEvidence) !== canonicalJson(generation.unresolvedEvidence)) reject();
}

function dashboard(value: unknown, expectedConnectionId: string): ComputeOptimizerExactDashboard {
  const result = record(value);
  exact(result, ["schemaVersion", "scope", "requesterAccountId", "partition", "generation", "filters", "filterOptions", "summary", "rows", "visuals", "page", "limitations"]);
  if (result.schemaVersion !== "sutra.finops-compute-optimizer-exact-dashboard.v1") reject();
  const scope = record(result.scope); exact(scope, ["organizationId", "customerId", "connectionId"]);
  text(scope.organizationId, 256); text(scope.customerId, 256); if (scope.connectionId !== expectedConnectionId) reject();
  if (typeof result.requesterAccountId !== "string" || !ACCOUNT.test(result.requesterAccountId)
    || !["aws", "aws-cn", "aws-us-gov"].includes(String(result.partition))) reject();
  const generation = record(result.generation);
  exact(generation, ["generationId", "contentSha256", "planSetId", "planSetContentSha256", "scheduledWindow", "materializedAtIso", "dataThroughAtIso", "observedAtIso", "regions", "exportFamilies", "coverage", "schemaAssurances", "unresolvedEvidence"]);
  if (typeof generation.generationId !== "string" || !/^cog_[a-f0-9]{64}$/u.test(generation.generationId)
    || typeof generation.contentSha256 !== "string" || !SHA.test(generation.contentSha256)
    || generation.generationId !== `cog_${generation.contentSha256}`) reject();
  if (typeof generation.planSetId !== "string" || !/^copes_[a-f0-9]{64}$/u.test(generation.planSetId)
    || typeof generation.planSetContentSha256 !== "string" || !SHA.test(generation.planSetContentSha256)
    || generation.planSetId !== `copes_${generation.planSetContentSha256}`) reject();
  iso(generation.scheduledWindow); iso(generation.materializedAtIso); iso(generation.dataThroughAtIso); iso(generation.observedAtIso);
  const generationRegions = uniqueStrings(generation.regions, 50); if (generationRegions.some((item) => !REGION.test(item))) reject();
  const generationFamilies = uniqueStrings(generation.exportFamilies, 8); if (generationFamilies.some((item) => !FAMILIES.has(item))) reject();
  if (generationRegions.length < 1 || generationFamilies.length < 1) reject();
  const generationCoverage = record(generation.coverage);
  const expectedTargetCount = coverage(generationCoverage);
  if (expectedTargetCount !== generationRegions.length * generationFamilies.length) reject();
  const assurances = uniqueStrings(generation.schemaAssurances, 3);
  if (assurances.length < 1 || assurances.some((item) => !SCHEMA_ASSURANCES.has(item))) reject();
  unresolvedEvidence(generation.unresolvedEvidence, new Set(generationRegions), new Set(generationFamilies));
  filters(result.filters); filterOptions(result.filterOptions);
  const parsedFilters = record(result.filters);
  const summary = record(result.summary); exact(summary, ["recommendationCount", "filteredRecommendationCount", "rejectedRowCount", "selectedExactSavings", "selectedExactSavingsChannelCount", "unresolvedSavingsChannelCount", "resourcesWithCurrentRiskEvidence"]);
  const recommendationCount = integer(summary.recommendationCount, MAX_RECOMMENDATIONS);
  const filteredRecommendationCount = integer(summary.filteredRecommendationCount);
  const rejectedRowCount = integer(summary.rejectedRowCount, MAX_GENERATION_ROWS);
  if (recommendationCount !== generationCoverage.recommendationCount
    || rejectedRowCount !== generationCoverage.rejectedRowCount
    || filteredRecommendationCount > recommendationCount) reject();
  integer(summary.selectedExactSavingsChannelCount, MAX_RECOMMENDATIONS * MAX_SELECTED_CHANNELS_PER_RECOMMENDATION);
  integer(summary.unresolvedSavingsChannelCount, MAX_RECOMMENDATIONS * MAX_SAVINGS_CHANNELS_PER_RECOMMENDATION);
  if (integer(summary.resourcesWithCurrentRiskEvidence) > filteredRecommendationCount) reject();
  moneyArray(summary.selectedExactSavings, MAX_SAVINGS_CHANNELS_PER_RECOMMENDATION, false, true);
  if (!Array.isArray(result.rows) || result.rows.length > 2_500) reject();
  const rows = result.rows.map(row); const rowKeys = new Set(rows.map((item) => item.key));
  if (rowKeys.size !== rows.length) reject();
  const pageTotal = page(result.page, rowKeys, parsedFilters.offset as number);
  if (pageTotal !== filteredRecommendationCount || rows.length > filteredRecommendationCount) reject();
  const visuals = record(result.visuals);
  exact(visuals, ["totalInstances", "findings", "findingsByDate", "findingsByBusinessUnit", "operationalRiskFindingCount", "maximumPotentialSavingsEc2", "potentialSavingsByDate", "potentialSavingsByBusinessUnit", "operationalRisksByBusinessUnit", "selectedInstances", "currentVersusRecommendedOptionProjection", "recommendedInstanceFamilyChanges", "potentialSavingsHistogram", "potentialSavingsByInstance"]);
  if (integer(visuals.totalInstances) > filteredRecommendationCount
    || integer(visuals.operationalRiskFindingCount) > filteredRecommendationCount) reject();
  for (const name of ["findings", "findingsByDate", "findingsByBusinessUnit", "operationalRisksByBusinessUnit"] as const) {
    if (!Array.isArray(visuals[name]) || visuals[name].length > 2_000) reject();
    for (const item of visuals[name]) { const group = record(item); exact(group, ["key", "count"]); groupKey(group.key);
      const maximum = name === "findings" ? filteredRecommendationCount * 3 : filteredRecommendationCount;
      if (integer(group.count) > maximum) reject(); }
  }
  for (const name of ["potentialSavingsByDate", "potentialSavingsByBusinessUnit"] as const) {
    if (!Array.isArray(visuals[name]) || visuals[name].length > 2_000) reject();
    for (const item of visuals[name]) { const group = record(item); exact(group, ["key", "count", "savings"]); groupKey(group.key);
      if (integer(group.count) > filteredRecommendationCount) reject();
      moneyArray(group.savings, MAX_SAVINGS_CHANNELS_PER_RECOMMENDATION, false, true); }
  }
  if (!Array.isArray(visuals.maximumPotentialSavingsEc2) || visuals.maximumPotentialSavingsEc2.length > 384) reject();
  const maximumChannels = new Set<string>();
  for (const item of visuals.maximumPotentialSavingsEc2) {
    const maximum = record(item); exact(maximum, ["resourceArn", "savings"]); text(maximum.resourceArn, 2_048);
    const savings = money(maximum.savings, true);
    const key = `${savings.scope}\u0000${String(savings.includesExistingDiscounts)}\u0000${savings.currency}`;
    if (maximumChannels.has(key)) reject(); maximumChannels.add(key);
  }
  if (!Array.isArray(visuals.potentialSavingsHistogram) || visuals.potentialSavingsHistogram.length > 448) reject();
  for (const item of visuals.potentialSavingsHistogram) { const bucket = record(item); exact(bucket, ["currency", "bucket", "count"]);
    if (typeof bucket.currency !== "string" || !/^[A-Z]{3}$/u.test(bucket.currency)
      || typeof bucket.bucket !== "string" || !HISTOGRAM_BUCKETS.has(bucket.bucket)) reject();
    if (integer(bucket.count, MAX_RECOMMENDATIONS * MAX_SELECTED_CHANNELS_PER_RECOMMENDATION)
      > filteredRecommendationCount * MAX_SELECTED_CHANNELS_PER_RECOMMENDATION) reject(); }
  for (const name of ["selectedInstances", "currentVersusRecommendedOptionProjection", "recommendedInstanceFamilyChanges", "potentialSavingsByInstance"] as const) {
    if (page(visuals[name], rowKeys, parsedFilters.offset as number) > filteredRecommendationCount) reject();
  }
  strings(result.limitations, 16);
  return result as unknown as ComputeOptimizerExactDashboard;
}

export function parseComputeOptimizerExactApiPayload(value: unknown, expectedConnectionId: string): ComputeOptimizerExactApiPayload {
  if (!CONNECTION.test(expectedConnectionId)) reject();
  try { if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_RESPONSE_BYTES) reject(); } catch { reject(); }
  const result = record(value);
  if (result.schema !== "sutra.finops-compute-optimizer.v2"
    || result.connectionId !== expectedConnectionId
    || !["READY", "STALE", "COLLECTING", "COLLECTION_FAILED",
      "EXPORT_CONFIGURATION_REQUIRED", "EVIDENCE_KEY_UNAVAILABLE"].includes(String(result.sourceState))
    || !hasExactComputeOptimizerOfficialDefinition(result.officialDefinition)) reject();
  if (result.dashboard === null) {
    exact(result, ["schema", "connectionId", "sourceState", "dashboard", "officialDefinition", "collection", "limitations"]);
    if (!["COLLECTING", "COLLECTION_FAILED", "EXPORT_CONFIGURATION_REQUIRED",
      "EVIDENCE_KEY_UNAVAILABLE"].includes(String(result.sourceState))) reject();
    collection(result.collection, result.sourceState); strings(result.limitations, 16);
  } else {
    exact(result, ["schema", "connectionId", "sourceState", "source", "freshness", "dashboard", "officialDefinition", "evidence", "collection"]);
    if (!["READY", "STALE"].includes(String(result.sourceState))
      || result.source !== "AWS_COMPUTE_OPTIMIZER_EXACT_ORGANIZATION_S3_EXPORT") reject();
    const parsedDashboard = dashboard(result.dashboard, expectedConnectionId);
    const freshness = record(result.freshness); exact(freshness, ["dataThroughAt", "ageHours", "staleAfterHours"]);
    iso(freshness.dataThroughAt);
    if (freshness.dataThroughAt !== parsedDashboard.generation.dataThroughAtIso
      || typeof freshness.ageHours !== "number" || !Number.isFinite(freshness.ageHours)
      || freshness.ageHours < 0 || freshness.staleAfterHours !== 48
      || (result.sourceState === "STALE") !== (freshness.ageHours > 48)) reject();
    evidence(result.evidence, parsedDashboard.generation as unknown as Readonly<Record<string, unknown>>);
    collection(result.collection, result.sourceState);
  }
  return result as unknown as ComputeOptimizerExactApiPayload;
}
