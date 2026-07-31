/**
 * Evidence-honest AWS sustainability normalization and projection.
 *
 * The credential-owning collector and durable store live outside this module.
 * A trusted server pins the Sutra tenant and AWS payer boundary, then supplies
 * two independent evidence planes:
 *
 * 1. immutable active-CUR2 usage rows normalized into resource-efficiency
 *    proxy metrics; and
 * 2. AWS Sustainability CARBON_EMISSIONS Data Export rows, which are provider
 *    estimates in MTCO2e.
 *
 * Proxy usage is never converted to emissions, and provider emissions are
 * never allocated to workloads or resources that AWS did not publish.
 */
import type {
  FinopsSourceEvidence,
  FinopsSourceScope,
} from "./finops-source-health.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/u;
const CAPTURE_ID = /^sustainability_[a-f0-9]{64}$/u;
const GENERATION_ID = /^fbg_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const EXPORT_NAME = /^[A-Za-z0-9_-]{1,128}$/u;
const EXPORT_ARN = /^arn:aws:bcm-data-exports:[a-z0-9-]+:\d{12}:export\/[A-Za-z0-9_-]{1,128}$/u;
const MODEL_VERSION = /^v\d+\.\d+\.\d+$/u;
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const NON_NEGATIVE_INTEGER = /^(?:0|[1-9]\d{0,30})$/u;
const DECIMAL_MTCO2E = /^(?:0|[1-9]\d{0,20})(?:\.\d{1,6})?$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f<>]{1,1024}$/u;
const S3_BUCKET = /^(?!\d+\.\d+\.\d+\.\d+$)(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export const SUSTAINABILITY_CARBON_BOUNDS = Object.freeze({
  maximumCaptureBytes: 96 * 1_024 * 1_024,
  maximumDashboardInputBytes: 112 * 1_024 * 1_024,
  maximumCaptureDurationMs: 20 * 60 * 1_000,
  maximumProxyRows: 500_000,
  maximumCarbonRows: 500_000,
  maximumExpectedPeriods: 120,
  maximumUsageAccounts: 10_000,
  maximumObjects: 20_000,
  maximumObjectBytes: 5 * 1_024 * 1_024 * 1_024,
  maximumWorkloadTextCharacters: 256,
  proxyFreshnessSlaHours: 48,
  carbonFreshnessSlaHours: 840,
} as const);

/** Current AWS CARBON_EMISSIONS table contract, including the 2025 scope fields. */
export const AWS_CARBON_EMISSIONS_COLUMNS = Object.freeze([
  "last_refresh_timestamp",
  "location",
  "model_version",
  "payer_account_id",
  "product_code",
  "region_code",
  "total_lbm_emissions_unit",
  "total_lbm_emissions_value",
  "total_mbm_emissions_unit",
  "total_mbm_emissions_value",
  "total_scope_1_emissions_value",
  "total_scope_1_emissions_unit",
  "total_scope_2_lbm_emissions_value",
  "total_scope_2_lbm_emissions_unit",
  "total_scope_2_mbm_emissions_value",
  "total_scope_2_mbm_emissions_unit",
  "total_scope_3_lbm_emissions_value",
  "total_scope_3_lbm_emissions_unit",
  "total_scope_3_mbm_emissions_value",
  "total_scope_3_mbm_emissions_unit",
  "usage_account_id",
  "usage_period_end",
  "usage_period_start",
] as const);

/** Required to authorize creation/access of a CARBON_EMISSIONS Data Export. */
export const AWS_CARBON_DATA_EXPORT_ACCESS_IAM_ACTIONS = Object.freeze([
  "sustainability:GetCarbonFootprintSummary",
] as const);

/** Current direct AWS Sustainability read API. It is optional in this S3-export slice. */
export const AWS_SUSTAINABILITY_API_READ_IAM_ACTIONS = Object.freeze([
  "sustainability:GetEstimatedCarbonEmissions",
  "sustainability:GetEstimatedCarbonEmissionsDimensionValues",
] as const);

export type SustainabilityPartition = "aws" | "aws-cn" | "aws-us-gov";

export interface SustainabilityScope extends FinopsSourceScope {
  /** Payer/management account represented by the export. */
  readonly accountId: string;
  readonly partition: SustainabilityPartition;
}

export type SustainabilityProxyMetric =
  | "COMPUTE_VCPU_HOURS"
  | "COMPUTE_MEMORY_GB_HOURS"
  | "LAMBDA_GB_SECONDS"
  | "STORAGE_GB_HOURS"
  | "STORAGE_REQUESTS"
  | "DATA_TRANSFER_GB"
  | "DATABASE_VCPU_HOURS";

export type SustainabilityProxyUnit =
  | "vCPU-hours"
  | "GB-hours"
  | "GB-seconds"
  | "requests"
  | "GB";

export interface SustainabilityProxyNormalization {
  readonly kind: "IDENTITY" | "PINNED_MULTIPLIER";
  /** Exact rational factor applied to the CUR2 usage quantity. */
  readonly numerator: string;
  readonly denominator: string;
  /** Required for non-identity factors, for example an EC2 metadata snapshot. */
  readonly evidenceSource: string | null;
  readonly evidenceVersion: string | null;
}

export interface SustainabilityCur2ProxyRow {
  readonly lineItemId: string;
  readonly usageAccountId: string;
  readonly service: string;
  readonly region: string | null;
  readonly resourceId: string | null;
  readonly usageStartIso: string;
  readonly usageEndIso: string;
  readonly usageType: string;
  readonly sourceUsageUnit: string;
  /** Exact CUR2 quantity in micro source-units. */
  readonly sourceUsageQuantityMicros: string;
  readonly metric: SustainabilityProxyMetric;
  readonly normalization: SustainabilityProxyNormalization;
  /** Only an explicitly selected CUR2 cost-allocation tag may populate these. */
  readonly workloadTagKey: string | null;
  readonly workloadTagValue: string | null;
}

export interface SustainabilityCur2ProxyEvidence {
  readonly source: "AWS_CUR2_ACTIVE_GENERATION";
  readonly generationId: string;
  readonly manifestSha256: string;
  readonly dataThroughAtIso: string;
  readonly rowsExhausted: boolean;
  readonly rows: readonly SustainabilityCur2ProxyRow[];
}

export interface NormalizedSustainabilityProxyRow extends SustainabilityCur2ProxyRow {
  readonly metricUnit: SustainabilityProxyUnit;
  /** Exact normalized quantity in micro metric-units. */
  readonly metricValueMicros: string;
}

export interface AwsCarbonObjectEvidence {
  readonly bucket: string;
  readonly key: string;
  readonly eTag: string;
  readonly versionId: string | null;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface AwsCarbonPeriodEvidence {
  readonly usagePeriod: string;
  readonly selectedModelVersion: string;
  readonly deliveryState: "DELIVERED_ROWS" | "DELIVERED_EMPTY";
  readonly objectKeys: readonly string[];
  readonly complete: boolean;
}

export interface AwsCarbonExportRow {
  readonly lastRefreshTimestampIso: string;
  readonly location: string | null;
  readonly modelVersion: string;
  readonly payerAccountId: string;
  readonly productCode: string | null;
  readonly regionCode: string | null;
  readonly totalLbmEmissionsUnit: "MTCO2e" | null;
  readonly totalLbmEmissionsValue: string | null;
  readonly totalMbmEmissionsUnit: "MTCO2e" | null;
  readonly totalMbmEmissionsValue: string | null;
  readonly totalScope1EmissionsValue: string;
  readonly totalScope1EmissionsUnit: "MTCO2e";
  readonly totalScope2LbmEmissionsValue: string;
  readonly totalScope2LbmEmissionsUnit: "MTCO2e";
  readonly totalScope2MbmEmissionsValue: string;
  readonly totalScope2MbmEmissionsUnit: "MTCO2e";
  readonly totalScope3LbmEmissionsValue: string;
  readonly totalScope3LbmEmissionsUnit: "MTCO2e";
  readonly totalScope3MbmEmissionsValue: string;
  readonly totalScope3MbmEmissionsUnit: "MTCO2e";
  readonly usageAccountId: string;
  readonly usagePeriodEndIso: string;
  readonly usagePeriodStartIso: string;
}

export interface AwsCarbonExportEvidence {
  readonly source: "AWS_SUSTAINABILITY_CARBON_DATA_EXPORT";
  readonly tableName: "CARBON_EMISSIONS";
  readonly exportName: string;
  readonly exportArn: string;
  readonly exportRegion: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly generationId: string;
  readonly manifestSha256: string;
  readonly schemaColumns: readonly string[];
  readonly publicationKind: "MONTHLY" | "BACKFILL" | "CORRECTION";
  readonly publishedAtIso: string;
  readonly allowedUsageAccountIds: readonly string[];
  readonly expectedUsagePeriods: readonly string[];
  readonly objectsExhausted: boolean;
  readonly objects: readonly AwsCarbonObjectEvidence[];
  readonly rowsExhausted: boolean;
  readonly periods: readonly AwsCarbonPeriodEvidence[];
  readonly rows: readonly AwsCarbonExportRow[];
}

export interface SustainabilityCarbonCapture {
  readonly schemaVersion: "sutra.sustainability-carbon.v1";
  readonly scope: SustainabilityScope;
  readonly captureId: string;
  readonly startedAtIso: string;
  readonly completedAtIso: string;
  /** Authenticated account boundary supplied independently of either source. */
  readonly allowedUsageAccountIds: readonly string[];
  readonly configuration: {
    readonly cur2Configured: boolean;
    readonly carbonExportConfigured: boolean;
    readonly carbonExportAccessValidated: boolean;
  };
  readonly proxyEvidence: SustainabilityCur2ProxyEvidence | null;
  readonly carbonEvidence: AwsCarbonExportEvidence | null;
}

export type SustainabilityChannelState =
  | "not_configured"
  | "waiting_first_delivery"
  | "empty"
  | "partial"
  | "stale"
  | "current";

export type SustainabilityCarbonState =
  | "configuration_required"
  | "waiting_first_delivery"
  | "empty"
  | "partial"
  | "stale"
  | "current";

export interface SustainabilityCarbonSnapshot {
  readonly schemaVersion: "sutra.sustainability-carbon-snapshot.v1";
  readonly scope: SustainabilityScope;
  readonly captureId: string;
  readonly completedAtIso: string;
  readonly state: SustainabilityCarbonState;
  readonly proxy: {
    readonly state: SustainabilityChannelState;
    readonly evidence: Omit<SustainabilityCur2ProxyEvidence, "rows"> | null;
    readonly rows: readonly NormalizedSustainabilityProxyRow[];
  };
  readonly providerCarbon: {
    readonly state: SustainabilityChannelState;
    readonly evidence: Omit<AwsCarbonExportEvidence, "rows"> | null;
    readonly rows: readonly AwsCarbonExportRow[];
  };
  readonly complete: boolean;
  readonly limitations: readonly string[];
}

export type SustainabilityCarbonErrorCode =
  | "INVALID_INPUT"
  | "SCOPE_MISMATCH"
  | "UNSUPPORTED_PARTITION"
  | "BOUND_REACHED"
  | "CONFLICTING_DUPLICATE"
  | "INCOMPLETE_LINEAGE";

export class SustainabilityCarbonError extends Error {
  readonly code: SustainabilityCarbonErrorCode;

  constructor(code: SustainabilityCarbonErrorCode) {
    super("AWS sustainability evidence is invalid.");
    this.name = "SustainabilityCarbonError";
    this.code = code;
  }
}

function reject(code: SustainabilityCarbonErrorCode): never {
  throw new SustainabilityCarbonError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) reject("INVALID_INPUT");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) reject("INVALID_INPUT");
  return value;
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function text(value: unknown, maximum = 256): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
    || !SAFE_TEXT.test(value)
  ) reject("INVALID_INPUT");
  return value;
}

function nullableText(value: unknown, maximum = 256): string | null {
  return value === null ? null : text(value, maximum);
}

function timestamp(value: unknown, maximumMs: number): string {
  const candidate = text(value, 40);
  const parsed = Date.parse(candidate);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== candidate || parsed > maximumMs) {
    reject("INVALID_INPUT");
  }
  return candidate;
}

function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) reject("INVALID_INPUT");
  return value as T;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") reject("INVALID_INPUT");
  return value;
}

function sortedUniqueStrings(
  value: unknown,
  maximumItems: number,
  parser: (entry: unknown) => string = (entry) => text(entry),
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) reject("BOUND_REACHED");
  const parsed = value.map(parser);
  if (new Set(parsed).size !== parsed.length || JSON.stringify(parsed) !== JSON.stringify([...parsed].sort())) {
    reject("INVALID_INPUT");
  }
  return parsed;
}

function parseScope(value: unknown): SustainabilityScope {
  const record = exact(value, ["orgId", "customerId", "connectionId", "accountId", "partition"]);
  const orgId = text(record.orgId);
  const customerId = text(record.customerId);
  const connectionId = text(record.connectionId, 37);
  const accountId = text(record.accountId, 12);
  const partition = choice(record.partition, ["aws", "aws-cn", "aws-us-gov"] as const);
  if (!IDENTIFIER.test(orgId) || !IDENTIFIER.test(customerId) || !CONNECTION_ID.test(connectionId)
    || !ACCOUNT_ID.test(accountId)) reject("INVALID_INPUT");
  return { orgId, customerId, connectionId, accountId, partition };
}

function sameScope(left: SustainabilityScope, right: SustainabilityScope): boolean {
  return left.orgId === right.orgId && left.customerId === right.customerId
    && left.connectionId === right.connectionId && left.accountId === right.accountId
    && left.partition === right.partition;
}

function monthBounds(month: string): { readonly start: string; readonly end: string } {
  if (!MONTH.test(month)) reject("INVALID_INPUT");
  const [yearText, monthText] = month.split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  return {
    start: new Date(Date.UTC(year, monthIndex, 1)).toISOString(),
    end: new Date(Date.UTC(year, monthIndex + 1, 1)).toISOString(),
  };
}

function periodFromBounds(start: string, end: string): string {
  const month = start.slice(0, 7);
  const bounds = monthBounds(month);
  if (bounds.start !== start || bounds.end !== end) reject("INVALID_INPUT");
  return month;
}

function safeS3Key(value: unknown, prefix: string): string {
  const key = text(value, 1_024);
  if (key.startsWith("/") || key.includes("\\") || key.split("/").some((part) => part === "." || part === "..")) {
    reject("INVALID_INPUT");
  }
  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  if (!key.startsWith(normalizedPrefix)) reject("SCOPE_MISMATCH");
  return key;
}

function integer(value: unknown, allowZero = true): string {
  const candidate = text(value, 31);
  if (!NON_NEGATIVE_INTEGER.test(candidate) || (!allowZero && candidate === "0")) reject("INVALID_INPUT");
  return candidate;
}

function emissionsMicroMtco2e(value: unknown): string {
  const candidate = text(value, 32);
  if (!DECIMAL_MTCO2E.test(candidate)) reject("INVALID_INPUT");
  const [whole, fraction = ""] = candidate.split(".");
  return (BigInt(whole) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, "0"))).toString();
}

function nullableEmission(value: unknown, unit: unknown): { readonly value: string | null; readonly unit: "MTCO2e" | null } {
  if (value === null || unit === null) {
    if (value !== null || unit !== null) reject("INVALID_INPUT");
    return { value: null, unit: null };
  }
  if (unit !== "MTCO2e") reject("INVALID_INPUT");
  emissionsMicroMtco2e(value);
  return { value: value as string, unit: "MTCO2e" };
}

const PROXY_UNITS: Readonly<Record<SustainabilityProxyMetric, SustainabilityProxyUnit>> = {
  COMPUTE_VCPU_HOURS: "vCPU-hours",
  COMPUTE_MEMORY_GB_HOURS: "GB-hours",
  LAMBDA_GB_SECONDS: "GB-seconds",
  STORAGE_GB_HOURS: "GB-hours",
  STORAGE_REQUESTS: "requests",
  DATA_TRANSFER_GB: "GB",
  DATABASE_VCPU_HOURS: "vCPU-hours",
};

function proxyNormalization(value: unknown): SustainabilityProxyNormalization {
  const record = exact(value, ["kind", "numerator", "denominator", "evidenceSource", "evidenceVersion"]);
  const kind = choice(record.kind, ["IDENTITY", "PINNED_MULTIPLIER"] as const);
  const numerator = integer(record.numerator, false);
  const denominator = integer(record.denominator, false);
  const evidenceSource = nullableText(record.evidenceSource, 256);
  const evidenceVersion = nullableText(record.evidenceVersion, 256);
  if (kind === "IDENTITY") {
    if (numerator !== "1" || denominator !== "1" || evidenceSource !== null || evidenceVersion !== null) {
      reject("INCOMPLETE_LINEAGE");
    }
  } else if (evidenceSource === null || evidenceVersion === null) {
    reject("INCOMPLETE_LINEAGE");
  }
  return { kind, numerator, denominator, evidenceSource, evidenceVersion };
}

function proxyRow(
  value: unknown,
  allowedAccounts: ReadonlySet<string>,
  maximumMs: number,
): NormalizedSustainabilityProxyRow {
  const record = exact(value, [
    "lineItemId", "usageAccountId", "service", "region", "resourceId",
    "usageStartIso", "usageEndIso", "usageType", "sourceUsageUnit",
    "sourceUsageQuantityMicros", "metric", "normalization", "workloadTagKey",
    "workloadTagValue",
  ]);
  const usageAccountId = text(record.usageAccountId, 12);
  if (!ACCOUNT_ID.test(usageAccountId) || !allowedAccounts.has(usageAccountId)) reject("SCOPE_MISMATCH");
  const region = nullableText(record.region, 32);
  if (region !== null && !REGION.test(region)) reject("INVALID_INPUT");
  const usageStartIso = timestamp(record.usageStartIso, maximumMs);
  const usageEndIso = timestamp(record.usageEndIso, maximumMs);
  if (Date.parse(usageEndIso) <= Date.parse(usageStartIso)) reject("INVALID_INPUT");
  const metric = choice(record.metric, Object.keys(PROXY_UNITS) as SustainabilityProxyMetric[]);
  const normalization = proxyNormalization(record.normalization);
  const sourceUsageUnit = text(record.sourceUsageUnit, 128);
  const directUnits: Readonly<Record<SustainabilityProxyMetric, readonly string[]>> = {
    COMPUTE_VCPU_HOURS: ["vCPU-Hours", "vCPU-Hrs"],
    COMPUTE_MEMORY_GB_HOURS: ["GB-Hours", "GB-Hrs"],
    LAMBDA_GB_SECONDS: ["GB-Seconds"],
    STORAGE_GB_HOURS: ["GB-Hours", "GB-Hrs"],
    STORAGE_REQUESTS: ["Requests", "Count"],
    DATA_TRANSFER_GB: ["GB", "GBytes", "Gigabytes"],
    DATABASE_VCPU_HOURS: ["vCPU-Hours", "vCPU-Hrs"],
  };
  const multiplierUnits: Readonly<Record<SustainabilityProxyMetric, readonly string[]>> = {
    COMPUTE_VCPU_HOURS: ["Hrs", "Hours"],
    COMPUTE_MEMORY_GB_HOURS: ["GB-Mo", "GB-Month", "GB-Months"],
    LAMBDA_GB_SECONDS: [],
    STORAGE_GB_HOURS: ["GB-Mo", "GB-Month", "GB-Months"],
    STORAGE_REQUESTS: [],
    DATA_TRANSFER_GB: [],
    DATABASE_VCPU_HOURS: ["Hrs", "Hours"],
  };
  if (normalization.kind === "IDENTITY" && !directUnits[metric].includes(sourceUsageUnit)) {
    reject("INCOMPLETE_LINEAGE");
  }
  if (normalization.kind === "PINNED_MULTIPLIER" && !multiplierUnits[metric].includes(sourceUsageUnit)) {
    reject("INCOMPLETE_LINEAGE");
  }
  const sourceUsageQuantityMicros = integer(record.sourceUsageQuantityMicros);
  const numerator = BigInt(normalization.numerator);
  const denominator = BigInt(normalization.denominator);
  const product = BigInt(sourceUsageQuantityMicros) * numerator;
  if (product % denominator !== BigInt(0)) reject("INVALID_INPUT");
  const workloadTagKey = nullableText(record.workloadTagKey, SUSTAINABILITY_CARBON_BOUNDS.maximumWorkloadTextCharacters);
  const workloadTagValue = nullableText(record.workloadTagValue, SUSTAINABILITY_CARBON_BOUNDS.maximumWorkloadTextCharacters);
  if ((workloadTagKey === null) !== (workloadTagValue === null)) reject("INCOMPLETE_LINEAGE");
  return {
    lineItemId: text(record.lineItemId, 512),
    usageAccountId,
    service: text(record.service, 256),
    region,
    resourceId: nullableText(record.resourceId, 1_024),
    usageStartIso,
    usageEndIso,
    usageType: text(record.usageType, 512),
    sourceUsageUnit,
    sourceUsageQuantityMicros,
    metric,
    normalization,
    workloadTagKey,
    workloadTagValue,
    metricUnit: PROXY_UNITS[metric],
    metricValueMicros: (product / denominator).toString(),
  };
}

function proxyEvidence(
  value: unknown,
  allowedAccounts: ReadonlySet<string>,
  maximumMs: number,
): { readonly evidence: SustainabilityCur2ProxyEvidence; readonly rows: readonly NormalizedSustainabilityProxyRow[] } {
  const record = exact(value, ["source", "generationId", "manifestSha256", "dataThroughAtIso", "rowsExhausted", "rows"]);
  if (record.source !== "AWS_CUR2_ACTIVE_GENERATION") reject("INVALID_INPUT");
  const generationId = text(record.generationId, 68);
  const manifestSha256 = text(record.manifestSha256, 64);
  if (!GENERATION_ID.test(generationId) || !SHA256.test(manifestSha256) || !Array.isArray(record.rows)) reject("INVALID_INPUT");
  if (record.rows.length > SUSTAINABILITY_CARBON_BOUNDS.maximumProxyRows) reject("BOUND_REACHED");
  const dataThroughAtIso = timestamp(record.dataThroughAtIso, maximumMs);
  const rows = record.rows.map((entry) => proxyRow(entry, allowedAccounts, Date.parse(dataThroughAtIso)));
  const keys = new Set<string>();
  for (const row of rows) {
    const key = `${row.lineItemId}\u0000${row.metric}`;
    if (keys.has(key)) reject("CONFLICTING_DUPLICATE");
    keys.add(key);
  }
  return {
    evidence: {
      source: "AWS_CUR2_ACTIVE_GENERATION",
      generationId,
      manifestSha256,
      dataThroughAtIso,
      rowsExhausted: booleanValue(record.rowsExhausted),
      rows: record.rows as readonly SustainabilityCur2ProxyRow[],
    },
    rows: [...rows].sort((left, right) => `${left.usageStartIso}\u0000${left.lineItemId}\u0000${left.metric}`
      .localeCompare(`${right.usageStartIso}\u0000${right.lineItemId}\u0000${right.metric}`)),
  };
}

function carbonRow(
  value: unknown,
  scope: SustainabilityScope,
  allowedAccounts: ReadonlySet<string>,
  selectedModels: ReadonlyMap<string, string>,
  maximumMs: number,
): AwsCarbonExportRow {
  const record = exact(value, [
    "lastRefreshTimestampIso", "location", "modelVersion", "payerAccountId",
    "productCode", "regionCode", "totalLbmEmissionsUnit", "totalLbmEmissionsValue",
    "totalMbmEmissionsUnit", "totalMbmEmissionsValue", "totalScope1EmissionsValue",
    "totalScope1EmissionsUnit", "totalScope2LbmEmissionsValue",
    "totalScope2LbmEmissionsUnit", "totalScope2MbmEmissionsValue",
    "totalScope2MbmEmissionsUnit", "totalScope3LbmEmissionsValue",
    "totalScope3LbmEmissionsUnit", "totalScope3MbmEmissionsValue",
    "totalScope3MbmEmissionsUnit", "usageAccountId", "usagePeriodEndIso",
    "usagePeriodStartIso",
  ]);
  const payerAccountId = text(record.payerAccountId, 12);
  const usageAccountId = text(record.usageAccountId, 12);
  if (payerAccountId !== scope.accountId || !allowedAccounts.has(usageAccountId)) reject("SCOPE_MISMATCH");
  const usagePeriodStartIso = timestamp(record.usagePeriodStartIso, maximumMs);
  const usagePeriodEndIso = timestamp(record.usagePeriodEndIso, maximumMs);
  const usagePeriod = periodFromBounds(usagePeriodStartIso, usagePeriodEndIso);
  const modelVersion = text(record.modelVersion, 32);
  if (!MODEL_VERSION.test(modelVersion) || selectedModels.get(usagePeriod) !== modelVersion) reject("INCOMPLETE_LINEAGE");
  const lastRefreshTimestampIso = timestamp(record.lastRefreshTimestampIso, maximumMs);
  if (Date.parse(lastRefreshTimestampIso) < Date.parse(usagePeriodEndIso)) reject("INVALID_INPUT");
  const regionCode = nullableText(record.regionCode, 32);
  if (regionCode !== null && !REGION.test(regionCode)) reject("INVALID_INPUT");
  const totalLbm = nullableEmission(record.totalLbmEmissionsValue, record.totalLbmEmissionsUnit);
  const totalMbm = nullableEmission(record.totalMbmEmissionsValue, record.totalMbmEmissionsUnit);
  for (const unit of [
    record.totalScope1EmissionsUnit,
    record.totalScope2LbmEmissionsUnit,
    record.totalScope2MbmEmissionsUnit,
    record.totalScope3LbmEmissionsUnit,
    record.totalScope3MbmEmissionsUnit,
  ]) if (unit !== "MTCO2e") reject("INVALID_INPUT");
  for (const amount of [
    record.totalScope1EmissionsValue,
    record.totalScope2LbmEmissionsValue,
    record.totalScope2MbmEmissionsValue,
    record.totalScope3LbmEmissionsValue,
    record.totalScope3MbmEmissionsValue,
  ]) emissionsMicroMtco2e(amount);
  return {
    lastRefreshTimestampIso,
    location: nullableText(record.location, 256),
    modelVersion,
    payerAccountId,
    productCode: nullableText(record.productCode, 256),
    regionCode,
    totalLbmEmissionsUnit: totalLbm.unit,
    totalLbmEmissionsValue: totalLbm.value,
    totalMbmEmissionsUnit: totalMbm.unit,
    totalMbmEmissionsValue: totalMbm.value,
    totalScope1EmissionsValue: record.totalScope1EmissionsValue as string,
    totalScope1EmissionsUnit: "MTCO2e",
    totalScope2LbmEmissionsValue: record.totalScope2LbmEmissionsValue as string,
    totalScope2LbmEmissionsUnit: "MTCO2e",
    totalScope2MbmEmissionsValue: record.totalScope2MbmEmissionsValue as string,
    totalScope2MbmEmissionsUnit: "MTCO2e",
    totalScope3LbmEmissionsValue: record.totalScope3LbmEmissionsValue as string,
    totalScope3LbmEmissionsUnit: "MTCO2e",
    totalScope3MbmEmissionsValue: record.totalScope3MbmEmissionsValue as string,
    totalScope3MbmEmissionsUnit: "MTCO2e",
    usageAccountId,
    usagePeriodEndIso,
    usagePeriodStartIso,
  };
}

function carbonEvidence(
  value: unknown,
  scope: SustainabilityScope,
  maximumMs: number,
): { readonly evidence: AwsCarbonExportEvidence; readonly rows: readonly AwsCarbonExportRow[]; readonly complete: boolean } {
  const record = exact(value, [
    "source", "tableName", "exportName", "exportArn", "exportRegion", "bucket",
    "prefix", "generationId", "manifestSha256", "schemaColumns", "publicationKind",
    "publishedAtIso", "allowedUsageAccountIds", "expectedUsagePeriods",
    "objectsExhausted", "objects", "rowsExhausted", "periods", "rows",
  ]);
  if (scope.partition !== "aws") reject("UNSUPPORTED_PARTITION");
  if (record.source !== "AWS_SUSTAINABILITY_CARBON_DATA_EXPORT" || record.tableName !== "CARBON_EMISSIONS") {
    reject("INVALID_INPUT");
  }
  const exportName = text(record.exportName, 128);
  const exportArn = text(record.exportArn, 256);
  const exportRegion = text(record.exportRegion, 32);
  const bucket = text(record.bucket, 63);
  const prefix = text(record.prefix, 1_024);
  const generationId = text(record.generationId, 68);
  const manifestSha256 = text(record.manifestSha256, 64);
  if (!EXPORT_NAME.test(exportName) || !EXPORT_ARN.test(exportArn) || !REGION.test(exportRegion)
    || !S3_BUCKET.test(bucket) || prefix.startsWith("/") || prefix.includes("\\")
    || prefix.split("/").some((part) => part === "." || part === "..")
    || !GENERATION_ID.test(generationId) || !SHA256.test(manifestSha256)) reject("INVALID_INPUT");
  const arnMatch = /^arn:aws:bcm-data-exports:([a-z0-9-]+):(\d{12}):export\/([A-Za-z0-9_-]+)$/u.exec(exportArn);
  if (arnMatch?.[1] !== exportRegion || arnMatch[2] !== scope.accountId || arnMatch[3] !== exportName) {
    reject("SCOPE_MISMATCH");
  }
  if (!Array.isArray(record.schemaColumns)
    || JSON.stringify(record.schemaColumns) !== JSON.stringify(AWS_CARBON_EMISSIONS_COLUMNS)) {
    reject("INCOMPLETE_LINEAGE");
  }
  const publicationKind = choice(record.publicationKind, ["MONTHLY", "BACKFILL", "CORRECTION"] as const);
  const publishedAtIso = timestamp(record.publishedAtIso, maximumMs);
  const allowedUsageAccountIds = sortedUniqueStrings(
    record.allowedUsageAccountIds,
    SUSTAINABILITY_CARBON_BOUNDS.maximumUsageAccounts,
    (entry) => {
      const accountId = text(entry, 12);
      if (!ACCOUNT_ID.test(accountId)) reject("INVALID_INPUT");
      return accountId;
    },
  );
  if (!allowedUsageAccountIds.includes(scope.accountId)) reject("SCOPE_MISMATCH");
  const expectedUsagePeriods = sortedUniqueStrings(
    record.expectedUsagePeriods,
    SUSTAINABILITY_CARBON_BOUNDS.maximumExpectedPeriods,
    (entry) => {
      const period = text(entry, 7);
      if (!MONTH.test(period)) reject("INVALID_INPUT");
      return period;
    },
  );
  if (expectedUsagePeriods.length < 1) reject("INVALID_INPUT");
  if (!Array.isArray(record.objects) || record.objects.length > SUSTAINABILITY_CARBON_BOUNDS.maximumObjects) {
    reject("BOUND_REACHED");
  }
  const objectKeys = new Set<string>();
  const objects = record.objects.map((entry): AwsCarbonObjectEvidence => {
    const object = exact(entry, ["bucket", "key", "eTag", "versionId", "sha256", "sizeBytes"]);
    const objectBucket = text(object.bucket, 63);
    if (objectBucket !== bucket) reject("SCOPE_MISMATCH");
    const key = safeS3Key(object.key, prefix);
    if (objectKeys.has(key)) reject("CONFLICTING_DUPLICATE");
    objectKeys.add(key);
    const eTag = text(object.eTag, 256);
    const versionId = nullableText(object.versionId, 1_024);
    const objectSha256 = text(object.sha256, 64);
    if (!SHA256.test(objectSha256) || !Number.isSafeInteger(object.sizeBytes)
      || (object.sizeBytes as number) < 0 || (object.sizeBytes as number) > SUSTAINABILITY_CARBON_BOUNDS.maximumObjectBytes) {
      reject("INVALID_INPUT");
    }
    return { bucket: objectBucket, key, eTag, versionId, sha256: objectSha256, sizeBytes: object.sizeBytes as number };
  });
  if (!Array.isArray(record.periods) || record.periods.length !== expectedUsagePeriods.length) reject("INCOMPLETE_LINEAGE");
  const selectedModels = new Map<string, string>();
  const periods = record.periods.map((entry): AwsCarbonPeriodEvidence => {
    const period = exact(entry, ["usagePeriod", "selectedModelVersion", "deliveryState", "objectKeys", "complete"]);
    const usagePeriod = text(period.usagePeriod, 7);
    const selectedModelVersion = text(period.selectedModelVersion, 32);
    if (!MONTH.test(usagePeriod) || !expectedUsagePeriods.includes(usagePeriod) || !MODEL_VERSION.test(selectedModelVersion)
      || selectedModels.has(usagePeriod)) reject("INCOMPLETE_LINEAGE");
    selectedModels.set(usagePeriod, selectedModelVersion);
    const periodObjectKeys = sortedUniqueStrings(
      period.objectKeys,
      SUSTAINABILITY_CARBON_BOUNDS.maximumObjects,
      (entryValue) => safeS3Key(entryValue, prefix),
    );
    if (periodObjectKeys.length < 1 || periodObjectKeys.some((key) => !objectKeys.has(key))) reject("INCOMPLETE_LINEAGE");
    return {
      usagePeriod,
      selectedModelVersion,
      deliveryState: choice(period.deliveryState, ["DELIVERED_ROWS", "DELIVERED_EMPTY"] as const),
      objectKeys: periodObjectKeys,
      complete: booleanValue(period.complete),
    };
  }).sort((left, right) => left.usagePeriod.localeCompare(right.usagePeriod));
  if (JSON.stringify(periods.map((entry) => entry.usagePeriod)) !== JSON.stringify(expectedUsagePeriods)) {
    reject("INCOMPLETE_LINEAGE");
  }
  if (!Array.isArray(record.rows) || record.rows.length > SUSTAINABILITY_CARBON_BOUNDS.maximumCarbonRows) {
    reject("BOUND_REACHED");
  }
  const allowedAccounts = new Set(allowedUsageAccountIds);
  const rows = record.rows.map((entry) => carbonRow(entry, scope, allowedAccounts, selectedModels, Date.parse(publishedAtIso)));
  const rowKeys = new Set<string>();
  const rowCounts = new Map<string, number>();
  for (const row of rows) {
    const period = row.usagePeriodStartIso.slice(0, 7);
    rowCounts.set(period, (rowCounts.get(period) ?? 0) + 1);
    const key = [period, row.modelVersion, row.usageAccountId, row.regionCode ?? "", row.productCode ?? "", row.location ?? ""].join("\u0000");
    if (rowKeys.has(key)) reject("CONFLICTING_DUPLICATE");
    rowKeys.add(key);
  }
  for (const period of periods) {
    const count = rowCounts.get(period.usagePeriod) ?? 0;
    if ((period.deliveryState === "DELIVERED_ROWS" && count === 0)
      || (period.deliveryState === "DELIVERED_EMPTY" && count !== 0)) reject("INCOMPLETE_LINEAGE");
  }
  const objectsExhausted = booleanValue(record.objectsExhausted);
  const rowsExhausted = booleanValue(record.rowsExhausted);
  const complete = objectsExhausted && rowsExhausted && periods.every((entry) => entry.complete);
  return {
    evidence: {
      source: "AWS_SUSTAINABILITY_CARBON_DATA_EXPORT",
      tableName: "CARBON_EMISSIONS",
      exportName,
      exportArn,
      exportRegion,
      bucket,
      prefix,
      generationId,
      manifestSha256,
      schemaColumns: [...AWS_CARBON_EMISSIONS_COLUMNS],
      publicationKind,
      publishedAtIso,
      allowedUsageAccountIds,
      expectedUsagePeriods,
      objectsExhausted,
      objects,
      rowsExhausted,
      periods,
      rows: record.rows as readonly AwsCarbonExportRow[],
    },
    rows: [...rows].sort((left, right) => [left.usagePeriodStartIso, left.usageAccountId, left.regionCode ?? "", left.productCode ?? ""]
      .join("\u0000").localeCompare([right.usagePeriodStartIso, right.usageAccountId, right.regionCode ?? "", right.productCode ?? ""].join("\u0000"))),
    complete,
  };
}

function withoutRows<T extends { readonly rows: readonly unknown[] }>(value: T): Omit<T, "rows"> {
  const { rows: _rows, ...rest } = value;
  void _rows;
  return rest;
}

export function normalizeSustainabilityCarbonCapture(
  input: SustainabilityCarbonCapture,
  expectedScope: SustainabilityScope,
  nowMs = Date.now(),
): SustainabilityCarbonSnapshot {
  if (!Number.isFinite(nowMs)) reject("INVALID_INPUT");
  if (jsonBytes(input) > SUSTAINABILITY_CARBON_BOUNDS.maximumCaptureBytes) reject("BOUND_REACHED");
  const root = exact(input, [
    "schemaVersion", "scope", "captureId", "startedAtIso", "completedAtIso",
    "allowedUsageAccountIds", "configuration", "proxyEvidence", "carbonEvidence",
  ]);
  if (root.schemaVersion !== "sutra.sustainability-carbon.v1") reject("INVALID_INPUT");
  const trustedScope = parseScope(expectedScope);
  const parsedScope = parseScope(root.scope);
  if (!sameScope(parsedScope, trustedScope)) reject("SCOPE_MISMATCH");
  const captureId = text(root.captureId, 79);
  if (!CAPTURE_ID.test(captureId)) reject("INVALID_INPUT");
  const startedAtIso = timestamp(root.startedAtIso, nowMs + MAX_CLOCK_SKEW_MS);
  const completedAtIso = timestamp(root.completedAtIso, nowMs + MAX_CLOCK_SKEW_MS);
  const duration = Date.parse(completedAtIso) - Date.parse(startedAtIso);
  if (duration < 0 || duration > SUSTAINABILITY_CARBON_BOUNDS.maximumCaptureDurationMs) reject("BOUND_REACHED");
  const allowedUsageAccountIds = sortedUniqueStrings(
    root.allowedUsageAccountIds,
    SUSTAINABILITY_CARBON_BOUNDS.maximumUsageAccounts,
    (entry) => {
      const accountId = text(entry, 12);
      if (!ACCOUNT_ID.test(accountId)) reject("INVALID_INPUT");
      return accountId;
    },
  );
  if (!allowedUsageAccountIds.includes(trustedScope.accountId)) reject("SCOPE_MISMATCH");
  const configuration = exact(root.configuration, [
    "cur2Configured", "carbonExportConfigured", "carbonExportAccessValidated",
  ]);
  const cur2Configured = booleanValue(configuration.cur2Configured);
  const carbonExportConfigured = booleanValue(configuration.carbonExportConfigured);
  const carbonExportAccessValidated = booleanValue(configuration.carbonExportAccessValidated);
  if (trustedScope.partition !== "aws" && (carbonExportConfigured || root.carbonEvidence !== null)) {
    reject("UNSUPPORTED_PARTITION");
  }
  if ((!cur2Configured && root.proxyEvidence !== null)
    || ((!carbonExportConfigured || !carbonExportAccessValidated) && root.carbonEvidence !== null)) {
    reject("INCOMPLETE_LINEAGE");
  }
  if (root.carbonEvidence !== null) {
    const carbonAccounts = sortedUniqueStrings(
      exact(root.carbonEvidence, [
        "source", "tableName", "exportName", "exportArn", "exportRegion", "bucket",
        "prefix", "generationId", "manifestSha256", "schemaColumns", "publicationKind",
        "publishedAtIso", "allowedUsageAccountIds", "expectedUsagePeriods",
        "objectsExhausted", "objects", "rowsExhausted", "periods", "rows",
      ]).allowedUsageAccountIds,
      SUSTAINABILITY_CARBON_BOUNDS.maximumUsageAccounts,
      (entry) => {
        const accountId = text(entry, 12);
        if (!ACCOUNT_ID.test(accountId)) reject("INVALID_INPUT");
        return accountId;
      },
    );
    if (JSON.stringify(carbonAccounts) !== JSON.stringify(allowedUsageAccountIds)) reject("SCOPE_MISMATCH");
  }
  const allowedProxyAccounts = new Set(allowedUsageAccountIds);
  const parsedProxy = root.proxyEvidence === null
    ? null
    : proxyEvidence(root.proxyEvidence, allowedProxyAccounts, Date.parse(completedAtIso));
  const parsedCarbon = root.carbonEvidence === null
    ? null
    : carbonEvidence(root.carbonEvidence, trustedScope, Date.parse(completedAtIso));

  let proxyState: SustainabilityChannelState;
  if (!cur2Configured) proxyState = "not_configured";
  else if (parsedProxy === null) proxyState = "waiting_first_delivery";
  else if (!parsedProxy.evidence.rowsExhausted) proxyState = "partial";
  else if (nowMs - Date.parse(parsedProxy.evidence.dataThroughAtIso) > SUSTAINABILITY_CARBON_BOUNDS.proxyFreshnessSlaHours * 3_600_000) proxyState = "stale";
  else if (parsedProxy.rows.length === 0) proxyState = "empty";
  else proxyState = "current";

  let carbonState: SustainabilityChannelState;
  if (trustedScope.partition !== "aws" || !carbonExportConfigured || !carbonExportAccessValidated) carbonState = "not_configured";
  else if (parsedCarbon === null) carbonState = "waiting_first_delivery";
  else if (!parsedCarbon.complete) carbonState = "partial";
  else if (nowMs - Date.parse(parsedCarbon.evidence.publishedAtIso) > SUSTAINABILITY_CARBON_BOUNDS.carbonFreshnessSlaHours * 3_600_000) carbonState = "stale";
  else if (parsedCarbon.rows.length === 0) carbonState = "empty";
  else carbonState = "current";

  let state: SustainabilityCarbonState;
  if (proxyState === "not_configured" || carbonState === "not_configured") state = "configuration_required";
  else if (proxyState === "waiting_first_delivery" || carbonState === "waiting_first_delivery") state = "waiting_first_delivery";
  else if (proxyState === "partial" || carbonState === "partial") state = "partial";
  else if (proxyState === "stale" || carbonState === "stale") state = "stale";
  else if (proxyState === "empty" && carbonState === "empty") state = "empty";
  else state = "current";

  const limitations: string[] = [
    "CUR2 proxy metrics are resource-usage indicators, not measured energy or carbon emissions; Sutra never converts them to MTCO2e.",
    "AWS provider carbon is monthly estimated evidence. Sutra does not allocate it to workloads or resources beyond AWS-published account, Region, service, location, method, and scope dimensions.",
    "Market-based and location-based estimates remain separate, and Scope 1/2/3 values are not merged across methods.",
  ];
  if (trustedScope.partition !== "aws") limitations.push("AWS documents the CARBON_EMISSIONS Data Export for commercial AWS Regions; this contract fails closed for aws-cn and aws-us-gov.");
  if (proxyState === "not_configured") limitations.push("The active CUR2 proxy source is not configured.");
  if (proxyState === "waiting_first_delivery") limitations.push("The active CUR2 source is configured but has no validated proxy delivery.");
  if (proxyState === "partial") limitations.push("The CUR2 proxy row set stopped before its declared bound was exhausted.");
  if (proxyState === "stale") limitations.push("The CUR2 proxy generation is older than the 48-hour source SLA.");
  if (carbonState === "not_configured") limitations.push("The carbon export is unavailable for this partition or its configuration/access attestation is incomplete.");
  if (carbonState === "waiting_first_delivery") limitations.push("The monthly carbon export is configured but its first validated delivery has not arrived.");
  if (carbonState === "partial") limitations.push("One or more carbon export objects, rows, or expected monthly partitions are incomplete.");
  if (carbonState === "stale") limitations.push("The carbon publication is older than the 35-day source SLA.");
  if (carbonState === "empty") limitations.push("AWS delivered complete empty carbon files; this is unknown/no published row evidence, not a zero-emissions claim.");
  if (parsedCarbon?.rows.some((row) => row.totalLbmEmissionsValue === null || row.totalMbmEmissionsValue === null)) {
    limitations.push("Some provider rows omit total LBM or MBM values; missing provider values remain null and are not replaced with zero.");
  }

  return {
    schemaVersion: "sutra.sustainability-carbon-snapshot.v1",
    scope: trustedScope,
    captureId,
    completedAtIso,
    state,
    proxy: {
      state: proxyState,
      evidence: parsedProxy === null ? null : withoutRows(parsedProxy.evidence),
      rows: parsedProxy?.rows ?? [],
    },
    providerCarbon: {
      state: carbonState,
      evidence: parsedCarbon === null ? null : withoutRows(parsedCarbon.evidence),
      rows: parsedCarbon?.rows ?? [],
    },
    complete: !["configuration_required", "waiting_first_delivery", "partial"].includes(state),
    limitations,
  };
}

export interface SustainabilityCarbonDashboard {
  readonly schemaVersion: "sutra.sustainability-carbon-dashboard.v1";
  readonly scope: SustainabilityScope;
  readonly generatedAtIso: string;
  readonly state: SustainabilityCarbonState;
  readonly lineage: {
    readonly proxyGenerationId: string | null;
    readonly proxyManifestSha256: string | null;
    readonly proxyDataThroughAtIso: string | null;
    readonly carbonExportArn: string | null;
    readonly carbonGenerationId: string | null;
    readonly carbonManifestSha256: string | null;
    readonly carbonPublishedAtIso: string | null;
    readonly carbonPublicationKind: AwsCarbonExportEvidence["publicationKind"] | null;
    readonly carbonModelVersions: readonly string[];
  };
  readonly proxySeries: readonly ({
    readonly usagePeriod: string;
    readonly usageAccountId: string;
    readonly region: string | null;
    readonly service: string;
    readonly workloadTagKey: string | null;
    readonly workloadTagValue: string | null;
    readonly metric: SustainabilityProxyMetric;
    readonly unit: SustainabilityProxyUnit;
    readonly valueMicros: string;
    readonly sourceRowCount: number;
  })[];
  readonly providerCarbonSeries: readonly ({
    readonly usagePeriod: string;
    readonly modelVersion: string;
    readonly usageAccountId: string;
    readonly regionCode: string | null;
    readonly location: string | null;
    readonly productCode: string | null;
    readonly unit: "MTCO2e";
    readonly totalLbmMicroMtco2e: string | null;
    readonly totalMbmMicroMtco2e: string | null;
    readonly scope1MicroMtco2e: string;
    readonly scope2LbmMicroMtco2e: string;
    readonly scope2MbmMicroMtco2e: string;
    readonly scope3LbmMicroMtco2e: string;
    readonly scope3MbmMicroMtco2e: string;
  })[];
  readonly limitations: readonly string[];
}

export function buildSustainabilityCarbonDashboard(
  snapshot: SustainabilityCarbonSnapshot,
  nowMs = Date.now(),
): SustainabilityCarbonDashboard {
  if (!Number.isFinite(nowMs) || jsonBytes(snapshot) > SUSTAINABILITY_CARBON_BOUNDS.maximumDashboardInputBytes) {
    reject("BOUND_REACHED");
  }
  const proxy = new Map<string, SustainabilityCarbonDashboard["proxySeries"][number]>();
  for (const row of snapshot.proxy.rows) {
    const usagePeriod = row.usageStartIso.slice(0, 7);
    const key = [usagePeriod, row.usageAccountId, row.region ?? "", row.service, row.workloadTagKey ?? "", row.workloadTagValue ?? "", row.metric, row.metricUnit].join("\u0000");
    const previous = proxy.get(key);
    proxy.set(key, {
      usagePeriod,
      usageAccountId: row.usageAccountId,
      region: row.region,
      service: row.service,
      workloadTagKey: row.workloadTagKey,
      workloadTagValue: row.workloadTagValue,
      metric: row.metric,
      unit: row.metricUnit,
      valueMicros: ((previous === undefined ? BigInt(0) : BigInt(previous.valueMicros)) + BigInt(row.metricValueMicros)).toString(),
      sourceRowCount: (previous?.sourceRowCount ?? 0) + 1,
    });
  }
  const providerCarbonSeries = snapshot.providerCarbon.rows.map((row) => ({
    usagePeriod: row.usagePeriodStartIso.slice(0, 7),
    modelVersion: row.modelVersion,
    usageAccountId: row.usageAccountId,
    regionCode: row.regionCode,
    location: row.location,
    productCode: row.productCode,
    unit: "MTCO2e" as const,
    totalLbmMicroMtco2e: row.totalLbmEmissionsValue === null ? null : emissionsMicroMtco2e(row.totalLbmEmissionsValue),
    totalMbmMicroMtco2e: row.totalMbmEmissionsValue === null ? null : emissionsMicroMtco2e(row.totalMbmEmissionsValue),
    scope1MicroMtco2e: emissionsMicroMtco2e(row.totalScope1EmissionsValue),
    scope2LbmMicroMtco2e: emissionsMicroMtco2e(row.totalScope2LbmEmissionsValue),
    scope2MbmMicroMtco2e: emissionsMicroMtco2e(row.totalScope2MbmEmissionsValue),
    scope3LbmMicroMtco2e: emissionsMicroMtco2e(row.totalScope3LbmEmissionsValue),
    scope3MbmMicroMtco2e: emissionsMicroMtco2e(row.totalScope3MbmEmissionsValue),
  }));
  return {
    schemaVersion: "sutra.sustainability-carbon-dashboard.v1",
    scope: snapshot.scope,
    generatedAtIso: new Date(nowMs).toISOString(),
    state: snapshot.state,
    lineage: {
      proxyGenerationId: snapshot.proxy.evidence?.generationId ?? null,
      proxyManifestSha256: snapshot.proxy.evidence?.manifestSha256 ?? null,
      proxyDataThroughAtIso: snapshot.proxy.evidence?.dataThroughAtIso ?? null,
      carbonExportArn: snapshot.providerCarbon.evidence?.exportArn ?? null,
      carbonGenerationId: snapshot.providerCarbon.evidence?.generationId ?? null,
      carbonManifestSha256: snapshot.providerCarbon.evidence?.manifestSha256 ?? null,
      carbonPublishedAtIso: snapshot.providerCarbon.evidence?.publishedAtIso ?? null,
      carbonPublicationKind: snapshot.providerCarbon.evidence?.publicationKind ?? null,
      carbonModelVersions: [...new Set(snapshot.providerCarbon.rows.map((row) => row.modelVersion))].sort(),
    },
    proxySeries: [...proxy.values()].sort((left, right) => [left.usagePeriod, left.usageAccountId, left.service, left.metric]
      .join("\u0000").localeCompare([right.usagePeriod, right.usageAccountId, right.service, right.metric].join("\u0000"))),
    providerCarbonSeries,
    limitations: snapshot.limitations,
  };
}

export function sustainabilityCarbonSourceEvidence(
  snapshot: SustainabilityCarbonSnapshot,
): FinopsSourceEvidence {
  const configured = snapshot.providerCarbon.state !== "not_configured";
  const deliveryObserved = snapshot.providerCarbon.evidence !== null;
  const successful = deliveryObserved
    && snapshot.providerCarbon.state !== "partial"
    && snapshot.providerCarbon.state !== "waiting_first_delivery";
  const acceptedRecords = snapshot.providerCarbon.rows.length;
  const dataThroughAt = snapshot.providerCarbon.evidence?.expectedUsagePeriods.at(-1) === undefined
    ? null
    : monthBounds(snapshot.providerCarbon.evidence.expectedUsagePeriods.at(-1) as string).end;
  return {
    scope: snapshot.scope,
    sourceId: "aws_carbon_footprint",
    configured,
    deliveryObserved,
    lastAttemptAt: snapshot.completedAtIso,
    lastAttemptOutcome: !deliveryObserved ? "in_progress" : successful ? "succeeded" : "partial",
    lastSuccessAt: successful ? snapshot.providerCarbon.evidence?.publishedAtIso ?? null : null,
    dataThroughAt,
    coverage: {
      assessment: successful ? "complete" : "partial",
      acceptedRecords,
      expectedRecords: successful ? acceptedRecords : null,
      rejectedRecords: 0,
    },
    lastError: null,
    evidenceBasis: snapshot.providerCarbon.evidence === null
      ? "No validated AWS Sustainability carbon Data Export delivery has been observed."
      : `AWS CARBON_EMISSIONS export ${snapshot.providerCarbon.evidence.exportArn}; generation ${snapshot.providerCarbon.evidence.generationId}; manifest ${snapshot.providerCarbon.evidence.manifestSha256}.`,
    limitations: snapshot.limitations,
  };
}
