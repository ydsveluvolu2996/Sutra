/**
 * Evidence-honest AWS Media Services Insights source and projection engine.
 *
 * The credential-owning collector lives outside this module. A trusted server
 * pins tenant/AWS scope, the broker returns bounded normalized inventory plus
 * an immutable active-CUR2 slice, and this pure module validates and projects
 * that evidence. It performs no I/O and never accepts a browser tenant selector.
 */
import type {
  FinopsSourceEvidence,
  FinopsSourceScope,
} from "./finops-source-health.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/u;
const CAPTURE_ID = /^media_[a-f0-9]{64}$/u;
const GENERATION_ID = /^fbg_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const MICROS = /^-?(?:0|[1-9]\d{0,29})$/u;
const ARN = /^arn:(aws|aws-cn|aws-us-gov):([a-z0-9-]+):([a-z0-9-]+):(\d{12}):(.+)$/u;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export const MEDIA_SERVICES_INSIGHTS_BOUNDS = Object.freeze({
  maximumCaptureBytes: 64 * 1_024 * 1_024,
  maximumDashboardInputBytes: 80 * 1_024 * 1_024,
  maximumDurationMs: 15 * 60 * 1_000,
  maximumConcurrency: 4,
  maximumApiCallsPerProvider: 20_000,
  maximumResourcesPerProvider: 100_000,
  maximumResources: 300_000,
  maximumCostRows: 500_000,
  maximumTagsPerResource: 50,
  maximumAttributesPerResource: 32,
  maximumTextCharacters: 2_048,
  maximumDashboardResources: 5_000,
  maximumDashboardUsageRows: 5_000,
  sourceFreshnessSlaHours: 48,
} as const);

/** Exact read-only API surface for the v1 normalized inventory contract. */
export const MEDIA_SERVICES_INSIGHTS_READ_OPERATIONS = Object.freeze({
  MEDIACONNECT: Object.freeze([
    "mediaconnect:ListFlows",
    "mediaconnect:DescribeFlow",
    "mediaconnect:ListTagsForResource",
  ] as const),
  MEDIACONVERT: Object.freeze([
    "mediaconvert:DescribeEndpoints",
    "mediaconvert:ListQueues",
    "mediaconvert:GetQueue",
    "mediaconvert:ListJobs",
    "mediaconvert:GetJob",
    "mediaconvert:ListTagsForResource",
  ] as const),
  MEDIALIVE: Object.freeze([
    "medialive:ListChannels",
    "medialive:DescribeChannel",
    "medialive:ListMultiplexes",
    "medialive:DescribeMultiplex",
    "medialive:ListOfferings",
    "medialive:DescribeOffering",
    "medialive:ListReservations",
    "medialive:DescribeReservation",
    "medialive:ListTagsForResource",
  ] as const),
  MEDIAPACKAGE_V1: Object.freeze([
    "mediapackage:ListChannels",
    "mediapackage:DescribeChannel",
    "mediapackage:ListOriginEndpoints",
    "mediapackage:DescribeOriginEndpoint",
    "mediapackage:ListHarvestJobs",
    "mediapackage:DescribeHarvestJob",
    "mediapackage:ListTagsForResource",
  ] as const),
  MEDIAPACKAGE_V2: Object.freeze([
    "mediapackagev2:ListChannelGroups",
    "mediapackagev2:GetChannelGroup",
    "mediapackagev2:ListChannels",
    "mediapackagev2:GetChannel",
    "mediapackagev2:ListOriginEndpoints",
    "mediapackagev2:GetOriginEndpoint",
    "mediapackagev2:ListHarvestJobs",
    "mediapackagev2:GetHarvestJob",
    "mediapackagev2:ListTagsForResource",
  ] as const),
  MEDIATAILOR: Object.freeze([
    "mediatailor:ListPlaybackConfigurations",
    "mediatailor:GetPlaybackConfiguration",
    "mediatailor:ListChannels",
    "mediatailor:DescribeChannel",
    "mediatailor:ListSourceLocations",
    "mediatailor:DescribeSourceLocation",
    "mediatailor:ListLiveSources",
    "mediatailor:DescribeLiveSource",
    "mediatailor:ListVodSources",
    "mediatailor:DescribeVodSource",
    "mediatailor:ListAlerts",
    "mediatailor:ListTagsForResource",
  ] as const),
} as const);

export type MediaServicesPartition = "aws" | "aws-cn" | "aws-us-gov";
export type MediaProvider = keyof typeof MEDIA_SERVICES_INSIGHTS_READ_OPERATIONS;
export type MediaCostService =
  | "MEDIACONNECT"
  | "MEDIACONVERT"
  | "MEDIALIVE"
  | "MEDIAPACKAGE"
  | "MEDIATAILOR";
export type MediaResourceType =
  | "FLOW"
  | "QUEUE"
  | "JOB"
  | "CHANNEL"
  | "MULTIPLEX"
  | "OFFERING"
  | "RESERVATION"
  | "CHANNEL_GROUP"
  | "ORIGIN_ENDPOINT"
  | "HARVEST_JOB"
  | "PLAYBACK_CONFIGURATION"
  | "SOURCE_LOCATION"
  | "LIVE_SOURCE"
  | "VOD_SOURCE";
export type MediaProviderFailureCode =
  | "ACCESS_DENIED"
  | "REGION_UNAVAILABLE"
  | "THROTTLED"
  | "TIMEOUT"
  | "BOUND_REACHED"
  | "PROVIDER_UNAVAILABLE"
  | "UNKNOWN";

export interface MediaServicesScope extends FinopsSourceScope {
  readonly accountId: string;
  readonly partition: MediaServicesPartition;
  readonly region: string;
}

export interface MediaResourceTag {
  readonly key: string;
  readonly value: string;
}

export interface MediaResourceAttribute {
  /** Allowlisted, normalized non-secret attribute name. */
  readonly key:
    | "availability_zone"
    | "channel_class"
    | "concurrent_jobs"
    | "content_duration_ms"
    | "endpoint_count"
    | "failure_count"
    | "fixed_price_micros"
    | "job_count"
    | "job_duration_ms"
    | "job_status"
    | "output_count"
    | "offering_duration_seconds"
    | "offering_type"
    | "package_type"
    | "pipeline_count"
    | "playback_mode"
    | "pricing_plan"
    | "queue_type"
    | "reservation_end"
    | "reservation_start"
    | "reservation_state"
    | "source_count"
    | "usage_price_micros";
  readonly value: string;
}

export interface MediaResourceObservation {
  readonly provider: MediaProvider;
  readonly service: MediaCostService;
  readonly resourceType: MediaResourceType;
  readonly resourceArn: string;
  readonly resourceId: string;
  readonly name: string;
  readonly state: string;
  readonly observedAtIso: string;
  readonly tags: readonly MediaResourceTag[];
  readonly attributes: readonly MediaResourceAttribute[];
}

export interface MediaProviderCollection {
  readonly provider: MediaProvider;
  readonly configured: boolean;
  readonly regionSupported: boolean;
  readonly readPermissionsValidated: boolean;
  readonly paginationExhausted: boolean;
  readonly apiCallCount: number;
  readonly failureCode: MediaProviderFailureCode | null;
  readonly resources: readonly MediaResourceObservation[];
}

export type MediaCostBasis =
  | "UNBLENDED"
  | "AMORTIZED"
  | "NET_UNBLENDED"
  | "NET_AMORTIZED";

export interface MediaCur2CostRow {
  readonly rowId: string;
  readonly service: MediaCostService;
  readonly accountId: string;
  readonly region: string;
  readonly resourceArn: string | null;
  readonly chargePeriodStartIso: string;
  readonly chargePeriodEndIso: string;
  readonly operation: string | null;
  readonly usageType: string | null;
  readonly usageUnit: string | null;
  /** Signed decimal integer micro-units; correction rows may be negative. */
  readonly usageQuantityMicros: string;
  /** Signed decimal integer currency micros; credits/refunds may be negative. */
  readonly costMicros: string;
  readonly chargeCategory:
    | "USAGE"
    | "FEE"
    | "TAX"
    | "CREDIT"
    | "DISCOUNT"
    | "REFUND"
    | "SUPPORT"
    | "OTHER";
}

export interface MediaCur2Evidence {
  readonly source: "AWS_CUR2_ACTIVE_GENERATION";
  readonly generationId: string;
  readonly manifestSha256: string;
  readonly dataThroughAtIso: string;
  readonly costBasis: MediaCostBasis;
  readonly currency: string;
  readonly rowsExhausted: boolean;
  readonly rows: readonly MediaCur2CostRow[];
}

export interface MediaServicesCapture {
  readonly schemaVersion: "sutra.media-services-insights.v1";
  readonly scope: MediaServicesScope;
  readonly captureId: string;
  readonly startedAtIso: string;
  readonly completedAtIso: string;
  readonly execution: {
    readonly concurrencyLimit: 4;
    readonly observedPeakConcurrency: number;
  };
  /** Exactly one collection result for every provider in the v1 contract. */
  readonly collections: readonly MediaProviderCollection[];
  readonly costEvidence: MediaCur2Evidence;
}

export type MediaProviderState =
  | "not_configured"
  | "unsupported"
  | "permission_required"
  | "failed"
  | "partial"
  | "empty"
  | "stale"
  | "current";
export type MediaServicesState =
  | "configuration_required"
  | "failed"
  | "partial"
  | "empty"
  | "stale"
  | "current";

export interface NormalizedMediaProviderCollection {
  readonly provider: MediaProvider;
  readonly state: MediaProviderState;
  readonly complete: boolean;
  readonly apiCallCount: number;
  readonly failureCode: MediaProviderFailureCode | null;
  readonly resources: readonly MediaResourceObservation[];
}

export interface MediaServicesSnapshot {
  readonly schemaVersion: "sutra.media-services-insights-snapshot.v1";
  readonly scope: MediaServicesScope;
  readonly captureId: string;
  readonly completedAtIso: string;
  readonly state: MediaServicesState;
  readonly collections: readonly NormalizedMediaProviderCollection[];
  readonly resources: readonly MediaResourceObservation[];
  readonly costEvidence: MediaCur2Evidence;
  readonly complete: boolean;
  readonly limitations: readonly string[];
}

export type MediaServicesErrorCode =
  | "INVALID_INPUT"
  | "SCOPE_MISMATCH"
  | "BOUND_REACHED"
  | "CONFLICTING_DUPLICATE";

export class MediaServicesInsightsError extends Error {
  public readonly code: MediaServicesErrorCode;
  public constructor(code: MediaServicesErrorCode) {
    super("The AWS media services evidence is invalid");
    this.name = "MediaServicesInsightsError";
    this.code = code;
  }
}

function reject(code: MediaServicesErrorCode): never {
  throw new MediaServicesInsightsError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) reject("INVALID_INPUT");
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) reject("INVALID_INPUT");
  return value;
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function text(value: unknown, maximum = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) reject("INVALID_INPUT");
  return value;
}

function nullableText(value: unknown, maximum = 256): string | null {
  return value === null ? null : text(value, maximum);
}

function possiblyEmptyText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) reject("INVALID_INPUT");
  return value;
}

function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) reject("INVALID_INPUT");
  return value as T;
}

function timestamp(value: unknown, maximumMs: number): string {
  const result = text(value, 40);
  const milliseconds = Date.parse(result);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== result || milliseconds > maximumMs) reject("INVALID_INPUT");
  return result;
}

function parseScope(value: unknown): MediaServicesScope {
  const record = exact(value, ["orgId", "customerId", "connectionId", "accountId", "partition", "region"]);
  const orgId = text(record.orgId);
  const customerId = text(record.customerId);
  const connectionId = text(record.connectionId, 37);
  const accountId = text(record.accountId, 12);
  const partition = choice(record.partition, ["aws", "aws-cn", "aws-us-gov"] as const);
  const region = text(record.region, 32);
  if (!IDENTIFIER.test(orgId) || !IDENTIFIER.test(customerId) || !CONNECTION_ID.test(connectionId)
    || !ACCOUNT_ID.test(accountId) || !REGION.test(region)) reject("INVALID_INPUT");
  return { orgId, customerId, connectionId, accountId, partition, region };
}

function sameScope(left: MediaServicesScope, right: MediaServicesScope): boolean {
  return left.orgId === right.orgId && left.customerId === right.customerId
    && left.connectionId === right.connectionId && left.accountId === right.accountId
    && left.partition === right.partition && left.region === right.region;
}

const SERVICE_PREFIX_BY_PROVIDER: Readonly<Record<MediaProvider, string>> = Object.freeze({
  MEDIACONNECT: "mediaconnect",
  MEDIACONVERT: "mediaconvert",
  MEDIALIVE: "medialive",
  MEDIAPACKAGE_V1: "mediapackage",
  MEDIAPACKAGE_V2: "mediapackagev2",
  MEDIATAILOR: "mediatailor",
});

const COST_SERVICE_BY_PROVIDER: Readonly<Record<MediaProvider, MediaCostService>> = Object.freeze({
  MEDIACONNECT: "MEDIACONNECT",
  MEDIACONVERT: "MEDIACONVERT",
  MEDIALIVE: "MEDIALIVE",
  MEDIAPACKAGE_V1: "MEDIAPACKAGE",
  MEDIAPACKAGE_V2: "MEDIAPACKAGE",
  MEDIATAILOR: "MEDIATAILOR",
});

const RESOURCE_TYPES_BY_PROVIDER: Readonly<Record<MediaProvider, readonly MediaResourceType[]>> = Object.freeze({
  MEDIACONNECT: ["FLOW"],
  MEDIACONVERT: ["QUEUE", "JOB"],
  MEDIALIVE: ["CHANNEL", "MULTIPLEX", "OFFERING", "RESERVATION"],
  MEDIAPACKAGE_V1: ["CHANNEL", "ORIGIN_ENDPOINT", "HARVEST_JOB"],
  MEDIAPACKAGE_V2: ["CHANNEL_GROUP", "CHANNEL", "ORIGIN_ENDPOINT", "HARVEST_JOB"],
  MEDIATAILOR: ["PLAYBACK_CONFIGURATION", "CHANNEL", "SOURCE_LOCATION", "LIVE_SOURCE", "VOD_SOURCE"],
});

const ATTRIBUTE_KEYS = Object.freeze([
  "availability_zone", "channel_class", "concurrent_jobs", "content_duration_ms",
  "endpoint_count", "failure_count", "fixed_price_micros", "job_count", "job_duration_ms", "job_status",
  "offering_duration_seconds", "offering_type", "output_count", "package_type", "pipeline_count", "playback_mode", "pricing_plan",
  "queue_type", "reservation_end", "reservation_start", "reservation_state", "source_count",
  "usage_price_micros",
] as const);

function scopedArn(value: unknown, provider: MediaProvider, scope: MediaServicesScope): string {
  const result = text(value, 1_500);
  const match = ARN.exec(result);
  if (!match || match[1] !== scope.partition || match[2] !== SERVICE_PREFIX_BY_PROVIDER[provider]
    || match[3] !== scope.region || match[4] !== scope.accountId) reject("SCOPE_MISMATCH");
  return result;
}

function sortedTags(value: unknown): readonly MediaResourceTag[] {
  if (!Array.isArray(value) || value.length > MEDIA_SERVICES_INSIGHTS_BOUNDS.maximumTagsPerResource) reject("BOUND_REACHED");
  const output = value.map((entry) => {
    const record = exact(entry, ["key", "value"]);
    return { key: text(record.key, 128), value: possiblyEmptyText(record.value, 256) };
  });
  const sorted = [...output].sort((a, b) => a.key.localeCompare(b.key));
  if (new Set(sorted.map((item) => item.key)).size !== sorted.length || JSON.stringify(sorted) !== JSON.stringify(output)) reject("CONFLICTING_DUPLICATE");
  return output;
}

function sortedAttributes(value: unknown): readonly MediaResourceAttribute[] {
  if (!Array.isArray(value) || value.length > MEDIA_SERVICES_INSIGHTS_BOUNDS.maximumAttributesPerResource) reject("BOUND_REACHED");
  const output = value.map((entry) => {
    const record = exact(entry, ["key", "value"]);
    return {
      key: choice(record.key, ATTRIBUTE_KEYS),
      value: text(record.value, MEDIA_SERVICES_INSIGHTS_BOUNDS.maximumTextCharacters),
    };
  });
  const sorted = [...output].sort((a, b) => a.key.localeCompare(b.key));
  if (new Set(sorted.map((item) => item.key)).size !== sorted.length || JSON.stringify(sorted) !== JSON.stringify(output)) reject("CONFLICTING_DUPLICATE");
  return output;
}

function resource(value: unknown, provider: MediaProvider, scope: MediaServicesScope, maximumMs: number): MediaResourceObservation {
  const record = exact(value, ["provider", "service", "resourceType", "resourceArn", "resourceId", "name", "state", "observedAtIso", "tags", "attributes"]);
  if (record.provider !== provider) reject("SCOPE_MISMATCH");
  const service = choice(record.service, ["MEDIACONNECT", "MEDIACONVERT", "MEDIALIVE", "MEDIAPACKAGE", "MEDIATAILOR"] as const);
  if (service !== COST_SERVICE_BY_PROVIDER[provider]) reject("SCOPE_MISMATCH");
  const resourceType = choice(record.resourceType, RESOURCE_TYPES_BY_PROVIDER[provider]);
  return {
    provider,
    service,
    resourceType,
    resourceArn: scopedArn(record.resourceArn, provider, scope),
    resourceId: text(record.resourceId, 512),
    name: text(record.name, 512),
    state: text(record.state, 128),
    observedAtIso: timestamp(record.observedAtIso, maximumMs),
    tags: sortedTags(record.tags),
    attributes: sortedAttributes(record.attributes),
  };
}

function providerCollection(value: unknown, scope: MediaServicesScope, maximumMs: number): NormalizedMediaProviderCollection {
  const record = exact(value, ["provider", "configured", "regionSupported", "readPermissionsValidated", "paginationExhausted", "apiCallCount", "failureCode", "resources"]);
  const provider = choice(record.provider, Object.keys(MEDIA_SERVICES_INSIGHTS_READ_OPERATIONS) as MediaProvider[]);
  if (![record.configured, record.regionSupported, record.readPermissionsValidated, record.paginationExhausted].every((item) => typeof item === "boolean")
    || !Number.isInteger(record.apiCallCount) || (record.apiCallCount as number) < 0
    || (record.apiCallCount as number) > MEDIA_SERVICES_INSIGHTS_BOUNDS.maximumApiCallsPerProvider
    || !Array.isArray(record.resources) || record.resources.length > MEDIA_SERVICES_INSIGHTS_BOUNDS.maximumResourcesPerProvider) reject("BOUND_REACHED");
  const failureCode = record.failureCode === null ? null : choice(record.failureCode, ["ACCESS_DENIED", "REGION_UNAVAILABLE", "THROTTLED", "TIMEOUT", "BOUND_REACHED", "PROVIDER_UNAVAILABLE", "UNKNOWN"] as const);
  const cannotCollect = record.configured !== true || record.regionSupported !== true || record.readPermissionsValidated !== true;
  if (cannotCollect && ((record.apiCallCount as number) !== 0 || record.resources.length !== 0 || record.paginationExhausted !== false)) reject("INVALID_INPUT");
  if (record.regionSupported === false && failureCode !== null && failureCode !== "REGION_UNAVAILABLE") reject("INVALID_INPUT");
  if (record.readPermissionsValidated === false && record.configured === true && record.regionSupported === true && failureCode !== "ACCESS_DENIED") reject("INVALID_INPUT");
  if (failureCode !== null && record.paginationExhausted === true) reject("INVALID_INPUT");
  const resources = record.resources.map((entry) => resource(entry, provider, scope, maximumMs));
  const unique = new Map<string, MediaResourceObservation>();
  for (const item of resources) {
    const previous = unique.get(item.resourceArn);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(item)) reject("CONFLICTING_DUPLICATE");
    unique.set(item.resourceArn, item);
  }
  const sorted = [...unique.values()].sort((a, b) => a.resourceArn.localeCompare(b.resourceArn));
  let state: MediaProviderState;
  if (record.configured !== true) state = "not_configured";
  else if (record.regionSupported !== true) state = "unsupported";
  else if (record.readPermissionsValidated !== true) state = "permission_required";
  else if (failureCode !== null && resources.length === 0) state = "failed";
  else if (failureCode !== null || record.paginationExhausted !== true) state = "partial";
  else if (resources.length === 0) state = "empty";
  else if (sorted.some((item) => maximumMs - Date.parse(item.observedAtIso) > MEDIA_SERVICES_INSIGHTS_BOUNDS.sourceFreshnessSlaHours * 3_600_000)) state = "stale";
  else state = "current";
  return {
    provider,
    state,
    complete: state === "unsupported" || state === "empty" || state === "current" || state === "stale",
    apiCallCount: record.apiCallCount as number,
    failureCode,
    resources: sorted,
  };
}

function costServiceForArn(value: string): MediaCostService | null {
  const match = ARN.exec(value);
  if (!match) return null;
  if (match[2] === "mediaconnect") return "MEDIACONNECT";
  if (match[2] === "mediaconvert") return "MEDIACONVERT";
  if (match[2] === "medialive") return "MEDIALIVE";
  if (match[2] === "mediapackage" || match[2] === "mediapackagev2") return "MEDIAPACKAGE";
  if (match[2] === "mediatailor") return "MEDIATAILOR";
  return null;
}

function costRow(value: unknown, scope: MediaServicesScope, maximumMs: number): MediaCur2CostRow {
  const record = exact(value, ["rowId", "service", "accountId", "region", "resourceArn", "chargePeriodStartIso", "chargePeriodEndIso", "operation", "usageType", "usageUnit", "usageQuantityMicros", "costMicros", "chargeCategory"]);
  const rowId = text(record.rowId, 256);
  const service = choice(record.service, ["MEDIACONNECT", "MEDIACONVERT", "MEDIALIVE", "MEDIAPACKAGE", "MEDIATAILOR"] as const);
  const accountId = text(record.accountId, 12);
  const region = text(record.region, 32);
  if (accountId !== scope.accountId || region !== scope.region) reject("SCOPE_MISMATCH");
  const resourceArn = nullableText(record.resourceArn, 1_500);
  if (resourceArn !== null) {
    const match = ARN.exec(resourceArn);
    if (!match || match[1] !== scope.partition || match[3] !== scope.region || match[4] !== scope.accountId || costServiceForArn(resourceArn) !== service) reject("SCOPE_MISMATCH");
  }
  const chargePeriodStartIso = timestamp(record.chargePeriodStartIso, maximumMs);
  const chargePeriodEndIso = timestamp(record.chargePeriodEndIso, maximumMs);
  if (Date.parse(chargePeriodEndIso) <= Date.parse(chargePeriodStartIso)) reject("INVALID_INPUT");
  const usageQuantityMicros = text(record.usageQuantityMicros, 30);
  const costMicros = text(record.costMicros, 31);
  if (!MICROS.test(usageQuantityMicros) || !MICROS.test(costMicros)) reject("INVALID_INPUT");
  return {
    rowId,
    service,
    accountId,
    region,
    resourceArn,
    chargePeriodStartIso,
    chargePeriodEndIso,
    operation: nullableText(record.operation, 512),
    usageType: nullableText(record.usageType, 512),
    usageUnit: nullableText(record.usageUnit, 128),
    usageQuantityMicros,
    costMicros,
    chargeCategory: choice(record.chargeCategory, ["USAGE", "FEE", "TAX", "CREDIT", "DISCOUNT", "REFUND", "SUPPORT", "OTHER"] as const),
  };
}

function costEvidence(value: unknown, scope: MediaServicesScope, maximumMs: number): MediaCur2Evidence {
  const record = exact(value, ["source", "generationId", "manifestSha256", "dataThroughAtIso", "costBasis", "currency", "rowsExhausted", "rows"]);
  if (record.source !== "AWS_CUR2_ACTIVE_GENERATION" || typeof record.generationId !== "string" || !GENERATION_ID.test(record.generationId)
    || typeof record.manifestSha256 !== "string" || !SHA256.test(record.manifestSha256)
    || typeof record.currency !== "string" || !CURRENCY.test(record.currency)
    || typeof record.rowsExhausted !== "boolean" || !Array.isArray(record.rows)
    || record.rows.length > MEDIA_SERVICES_INSIGHTS_BOUNDS.maximumCostRows) reject("INVALID_INPUT");
  const rows = record.rows.map((entry) => costRow(entry, scope, maximumMs));
  const unique = new Map<string, MediaCur2CostRow>();
  for (const item of rows) {
    const previous = unique.get(item.rowId);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(item)) reject("CONFLICTING_DUPLICATE");
    unique.set(item.rowId, item);
  }
  const dataThroughAtIso = timestamp(record.dataThroughAtIso, maximumMs);
  if (rows.some((item) => Date.parse(item.chargePeriodEndIso) > Date.parse(dataThroughAtIso))) reject("INVALID_INPUT");
  return {
    source: "AWS_CUR2_ACTIVE_GENERATION",
    generationId: record.generationId,
    manifestSha256: record.manifestSha256,
    dataThroughAtIso,
    costBasis: choice(record.costBasis, ["UNBLENDED", "AMORTIZED", "NET_UNBLENDED", "NET_AMORTIZED"] as const),
    currency: record.currency,
    rowsExhausted: record.rowsExhausted,
    rows: [...unique.values()].sort((a, b) => a.rowId.localeCompare(b.rowId)),
  };
}

export function normalizeMediaServicesCapture(
  input: MediaServicesCapture,
  expectedScope: MediaServicesScope,
  nowMs = Date.now(),
): MediaServicesSnapshot {
  if (!Number.isFinite(nowMs) || jsonBytes(input) > MEDIA_SERVICES_INSIGHTS_BOUNDS.maximumCaptureBytes) reject("BOUND_REACHED");
  const root = exact(input, ["schemaVersion", "scope", "captureId", "startedAtIso", "completedAtIso", "execution", "collections", "costEvidence"]);
  if (root.schemaVersion !== "sutra.media-services-insights.v1" || typeof root.captureId !== "string" || !CAPTURE_ID.test(root.captureId)) reject("INVALID_INPUT");
  const trustedScope = parseScope(expectedScope);
  const capturedScope = parseScope(root.scope);
  if (!sameScope(trustedScope, capturedScope)) reject("SCOPE_MISMATCH");
  const startedAtIso = timestamp(root.startedAtIso, nowMs + MAX_CLOCK_SKEW_MS);
  const completedAtIso = timestamp(root.completedAtIso, nowMs + MAX_CLOCK_SKEW_MS);
  const duration = Date.parse(completedAtIso) - Date.parse(startedAtIso);
  if (duration < 0 || duration > MEDIA_SERVICES_INSIGHTS_BOUNDS.maximumDurationMs) reject("BOUND_REACHED");
  const execution = exact(root.execution, ["concurrencyLimit", "observedPeakConcurrency"]);
  if (execution.concurrencyLimit !== 4 || !Number.isInteger(execution.observedPeakConcurrency)
    || (execution.observedPeakConcurrency as number) < 0 || (execution.observedPeakConcurrency as number) > 4) reject("BOUND_REACHED");
  if (!Array.isArray(root.collections) || root.collections.length !== Object.keys(MEDIA_SERVICES_INSIGHTS_READ_OPERATIONS).length) reject("INVALID_INPUT");
  const collections = root.collections.map((entry) => providerCollection(entry, trustedScope, Date.parse(completedAtIso)));
  const providerSet = new Set(collections.map((item) => item.provider));
  if (providerSet.size !== Object.keys(MEDIA_SERVICES_INSIGHTS_READ_OPERATIONS).length) reject("CONFLICTING_DUPLICATE");
  const resources = collections.flatMap((item) => item.resources);
  if (resources.length > MEDIA_SERVICES_INSIGHTS_BOUNDS.maximumResources) reject("BOUND_REACHED");
  const resourceMap = new Map<string, MediaResourceObservation>();
  for (const item of resources) {
    const previous = resourceMap.get(item.resourceArn);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(item)) reject("CONFLICTING_DUPLICATE");
    resourceMap.set(item.resourceArn, item);
  }
  const cost = costEvidence(root.costEvidence, trustedScope, Date.parse(completedAtIso));
  const captureFresh = nowMs - Date.parse(completedAtIso) <= MEDIA_SERVICES_INSIGHTS_BOUNDS.sourceFreshnessSlaHours * 3_600_000;
  const billingFresh = nowMs - Date.parse(cost.dataThroughAtIso) <= MEDIA_SERVICES_INSIGHTS_BOUNDS.sourceFreshnessSlaHours * 3_600_000;
  const limitations: string[] = [];
  if (collections.some((item) => item.state === "not_configured" || item.state === "permission_required")) limitations.push("One or more required regional media inventory collectors are not configured or have not validated their complete read-only permission set.");
  if (collections.some((item) => item.state === "failed")) limitations.push("At least one configured media provider collection failed without usable records.");
  if (collections.some((item) => item.state === "partial")) limitations.push("At least one provider result set stopped at a declared bound or provider failure.");
  if (!cost.rowsExhausted) limitations.push("The active CUR2 media cost slice is incomplete; totals must not be treated as reconciled.");
  if (!captureFresh || !billingFresh) limitations.push("Inventory capture or active CUR2 billing evidence is older than the 48-hour source SLA.");
  if (cost.rows.some((item) => item.resourceArn === null)) limitations.push("Some CUR2 rows do not contain a resource ARN and remain service-level unattributed spend.");
  limitations.push("Inventory APIs describe configuration and job state; they do not prove CloudWatch performance, availability, viewer engagement, ad revenue, or end-to-end stream reliability.");
  limitations.push("Costs and usage are retained exactly by CUR2 cost basis, currency, usage type, operation, and unit; unlike units are never combined.");

  const configurationRequired = collections.some((item) => item.state === "not_configured" || item.state === "permission_required");
  const failed = collections.some((item) => item.state === "failed");
  const partial = collections.some((item) => item.state === "partial") || !cost.rowsExhausted;
  const stale = !captureFresh || !billingFresh || collections.some((item) => item.state === "stale");
  let state: MediaServicesState;
  if (configurationRequired) state = "configuration_required";
  else if (failed) state = "failed";
  else if (partial) state = "partial";
  else if (stale) state = "stale";
  else if (resources.length === 0 && cost.rows.length === 0) state = "empty";
  else state = "current";
  return {
    schemaVersion: "sutra.media-services-insights-snapshot.v1",
    scope: trustedScope,
    captureId: root.captureId,
    completedAtIso,
    state,
    collections: [...collections].sort((a, b) => a.provider.localeCompare(b.provider)),
    resources: [...resourceMap.values()].sort((a, b) => a.resourceArn.localeCompare(b.resourceArn)),
    costEvidence: cost,
    complete: !configurationRequired && !failed && !partial,
    limitations,
  };
}

export function mediaServicesSourceEvidence(snapshot: MediaServicesSnapshot): FinopsSourceEvidence {
  const acceptedRecords = snapshot.resources.length + snapshot.costEvidence.rows.length;
  const configured = snapshot.state !== "configuration_required";
  return {
    scope: snapshot.scope,
    sourceId: "media_services_telemetry",
    configured,
    deliveryObserved: true,
    lastAttemptAt: snapshot.completedAtIso,
    lastAttemptOutcome: snapshot.complete ? "succeeded" : "partial",
    lastSuccessAt: snapshot.complete ? snapshot.completedAtIso : null,
    dataThroughAt: snapshot.costEvidence.dataThroughAtIso,
    coverage: {
      assessment: snapshot.complete ? "complete" : "partial",
      acceptedRecords,
      expectedRecords: snapshot.complete ? acceptedRecords : null,
      rejectedRecords: 0,
    },
    lastError: null,
    evidenceBasis: "Persisted, tenant-scoped AWS media inventory joined only by exact ARN to an immutable active CUR2 generation.",
    limitations: snapshot.limitations,
  };
}

export interface MediaServicesDashboard {
  readonly schemaVersion: "sutra.media-services-insights-dashboard.v1";
  readonly scope: MediaServicesScope;
  readonly generatedAtIso: string;
  readonly state: MediaServicesState;
  readonly lineage: {
    readonly captureId: string;
    readonly billingGenerationId: string;
    readonly billingManifestSha256: string;
    readonly dataThroughAtIso: string;
    readonly costBasis: MediaCostBasis;
    readonly currency: string;
  };
  readonly providerCoverage: readonly ({
    readonly provider: MediaProvider;
    readonly state: MediaProviderState;
    readonly resourceCount: number;
    readonly apiCallCount: number;
    readonly failureCode: MediaProviderFailureCode | null;
  })[];
  readonly serviceSummary: readonly ({
    readonly service: MediaCostService;
    readonly resourceCount: number;
    readonly costMicros: string;
    readonly attributedCostMicros: string;
    readonly unattributedCostMicros: string;
    readonly costRowCount: number;
  })[];
  readonly usage: readonly ({
    readonly service: MediaCostService;
    readonly operation: string | null;
    readonly usageType: string | null;
    readonly unit: string | null;
    readonly quantityMicros: string;
    readonly costMicros: string;
    readonly rowCount: number;
  })[];
  readonly resources: readonly ({
    readonly observation: MediaResourceObservation;
    readonly exactArnCostMicros: string;
    readonly exactArnCostRowCount: number;
  })[];
  readonly limitations: readonly string[];
}

function add(map: Map<string, bigint>, key: string, amount: string): void {
  map.set(key, (map.get(key) ?? BigInt(0)) + BigInt(amount));
}

export function buildMediaServicesDashboard(snapshot: MediaServicesSnapshot, nowMs = Date.now()): MediaServicesDashboard {
  if (!Number.isFinite(nowMs) || jsonBytes(snapshot) > MEDIA_SERVICES_INSIGHTS_BOUNDS.maximumDashboardInputBytes) reject("BOUND_REACHED");
  const resourcesByArn = new Map(snapshot.resources.map((item) => [item.resourceArn, item]));
  const costsByService = new Map<string, bigint>();
  const attributedByService = new Map<string, bigint>();
  const resourceCosts = new Map<string, bigint>();
  const resourceRows = new Map<string, number>();
  const rowCounts = new Map<string, number>();
  const usage = new Map<string, { service: MediaCostService; operation: string | null; usageType: string | null; unit: string | null; quantity: bigint; cost: bigint; rows: number }>();
  for (const row of snapshot.costEvidence.rows) {
    add(costsByService, row.service, row.costMicros);
    rowCounts.set(row.service, (rowCounts.get(row.service) ?? 0) + 1);
    if (row.resourceArn !== null && resourcesByArn.has(row.resourceArn)) {
      add(attributedByService, row.service, row.costMicros);
      add(resourceCosts, row.resourceArn, row.costMicros);
      resourceRows.set(row.resourceArn, (resourceRows.get(row.resourceArn) ?? 0) + 1);
    }
    const key = JSON.stringify([row.service, row.operation, row.usageType, row.usageUnit]);
    const item = usage.get(key) ?? { service: row.service, operation: row.operation, usageType: row.usageType, unit: row.usageUnit, quantity: BigInt(0), cost: BigInt(0), rows: 0 };
    item.quantity += BigInt(row.usageQuantityMicros);
    item.cost += BigInt(row.costMicros);
    item.rows += 1;
    usage.set(key, item);
  }
  const services: readonly MediaCostService[] = ["MEDIACONNECT", "MEDIACONVERT", "MEDIALIVE", "MEDIAPACKAGE", "MEDIATAILOR"];
  const serviceSummary = services.map((service) => {
    const cost = costsByService.get(service) ?? BigInt(0);
    const attributed = attributedByService.get(service) ?? BigInt(0);
    return {
      service,
      resourceCount: snapshot.resources.filter((item) => item.service === service).length,
      costMicros: cost.toString(),
      attributedCostMicros: attributed.toString(),
      unattributedCostMicros: (cost - attributed).toString(),
      costRowCount: rowCounts.get(service) ?? 0,
    };
  });
  const usageRows = [...usage.values()].map((item) => ({
    service: item.service,
    operation: item.operation,
    usageType: item.usageType,
    unit: item.unit,
    quantityMicros: item.quantity.toString(),
    costMicros: item.cost.toString(),
    rowCount: item.rows,
  })).sort((a, b) => a.service.localeCompare(b.service)
    || (a.usageType ?? "").localeCompare(b.usageType ?? "")
    || (a.operation ?? "").localeCompare(b.operation ?? "")
    || (a.unit ?? "").localeCompare(b.unit ?? ""));
  if (usageRows.length > MEDIA_SERVICES_INSIGHTS_BOUNDS.maximumDashboardUsageRows) reject("BOUND_REACHED");
  return {
    schemaVersion: "sutra.media-services-insights-dashboard.v1",
    scope: snapshot.scope,
    generatedAtIso: new Date(nowMs).toISOString(),
    state: snapshot.state,
    lineage: {
      captureId: snapshot.captureId,
      billingGenerationId: snapshot.costEvidence.generationId,
      billingManifestSha256: snapshot.costEvidence.manifestSha256,
      dataThroughAtIso: snapshot.costEvidence.dataThroughAtIso,
      costBasis: snapshot.costEvidence.costBasis,
      currency: snapshot.costEvidence.currency,
    },
    providerCoverage: snapshot.collections.map((item) => ({ provider: item.provider, state: item.state, resourceCount: item.resources.length, apiCallCount: item.apiCallCount, failureCode: item.failureCode })),
    serviceSummary,
    usage: usageRows,
    resources: snapshot.resources.slice(0, MEDIA_SERVICES_INSIGHTS_BOUNDS.maximumDashboardResources).map((observation) => ({
      observation,
      exactArnCostMicros: (resourceCosts.get(observation.resourceArn) ?? BigInt(0)).toString(),
      exactArnCostRowCount: resourceRows.get(observation.resourceArn) ?? 0,
    })),
    limitations: snapshot.limitations,
  };
}

export interface MediaServicesBrokerRequest {
  readonly schemaVersion: "sutra.media-services-insights-query.v1";
  readonly scope: MediaServicesScope;
  readonly operations: typeof MEDIA_SERVICES_INSIGHTS_READ_OPERATIONS;
  readonly requiredBillingSource: "AWS_CUR2_ACTIVE_GENERATION";
  readonly bounds: typeof MEDIA_SERVICES_INSIGHTS_BOUNDS;
}

export interface MediaServicesTransport {
  readonly collect: (request: MediaServicesBrokerRequest) => Promise<MediaServicesCapture>;
}

export class MediaServicesQueryError extends Error {
  public readonly code: "SOURCE_UNAVAILABLE" | "INVALID_EVIDENCE";
  public constructor(code: "SOURCE_UNAVAILABLE" | "INVALID_EVIDENCE") {
    super("AWS media services evidence is unavailable");
    this.name = "MediaServicesQueryError";
    this.code = code;
  }
}

export function createMediaServicesQueryService(
  configuredScope: MediaServicesScope,
  transport: MediaServicesTransport,
  now: () => number = Date.now,
): { readonly query: () => Promise<MediaServicesDashboard> } {
  const trustedScope = parseScope(configuredScope);
  return {
    async query(): Promise<MediaServicesDashboard> {
      let capture: MediaServicesCapture;
      try {
        capture = await transport.collect({
          schemaVersion: "sutra.media-services-insights-query.v1",
          scope: trustedScope,
          operations: MEDIA_SERVICES_INSIGHTS_READ_OPERATIONS,
          requiredBillingSource: "AWS_CUR2_ACTIVE_GENERATION",
          bounds: MEDIA_SERVICES_INSIGHTS_BOUNDS,
        });
      } catch {
        throw new MediaServicesQueryError("SOURCE_UNAVAILABLE");
      }
      try {
        const currentTime = now();
        return buildMediaServicesDashboard(normalizeMediaServicesCapture(capture, trustedScope, currentTime), currentTime);
      } catch {
        throw new MediaServicesQueryError("INVALID_EVIDENCE");
      }
    },
  };
}
