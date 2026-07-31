/**
 * Evidence-honest AWS data-transfer analysis over one immutable active CUR 2.0
 * generation. This pure module performs no I/O and requires no AWS API beyond
 * the already-governed CUR2 Data Export/S3 evidence path.
 *
 * Classification is intentionally narrow. A row is classified only when its
 * CUR usage type and, for CloudFront, product code match a pinned AWS-published
 * pattern. New or ambiguous transfer patterns remain visible as unclassified.
 */
import type { CanonicalCurLine } from "./finops-cur.ts";
import {
  FINOPS_RECONCILIATION_CURRENCIES,
  type FinopsReconciliationScope,
  type ScopedCanonicalBillingRow,
} from "./finops-reconciliation.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const GENERATION_ID = /^fbg_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const INTEGER_MICROS = /^-?(?:0|[1-9]\d{0,127})$/u;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,95}$/u;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

export const DATA_TRANSFER_ANALYSIS_BOUNDS = Object.freeze({
  maximumCaptureBytes: 96 * 1_024 * 1_024,
  maximumOutputBytes: 12 * 1_024 * 1_024,
  maximumRows: 250_000,
  maximumManifestObjects: 100_000,
  maximumAccounts: 10_000,
  maximumGroups: 5_000,
  maximumSourceLineIdsPerGroup: 50,
  maximumUsageTypesPerGroup: 50,
  maximumTextLength: 4_096,
  freshnessSlaHours: 48,
} as const);

/** No additional AWS permission is required beyond immutable CUR2 evidence. */
export const DATA_TRANSFER_ADDITIONAL_READ_OPERATIONS = Object.freeze([] as const);

export const DATA_TRANSFER_COST_BASES = Object.freeze([
  "unblended",
  "net",
  "amortized",
  "list",
  "contracted",
  "public",
] as const);

export type DataTransferCostBasis = typeof DATA_TRANSFER_COST_BASES[number];
export type DataTransferCategory =
  | "INTERNET"
  | "INTER_REGION"
  | "INTER_AZ"
  | "CLOUDFRONT"
  | "UNKNOWN"
  | "UNCLASSIFIED";
export type DataTransferDirection = "INBOUND" | "OUTBOUND" | "UNKNOWN";
export type DataTransferSnapshotState =
  | "CONFIGURATION_REQUIRED"
  | "ERROR"
  | "EMPTY"
  | "PARTIAL"
  | "STALE"
  | "READY";
export type DataTransferSourceStatus = "SUCCEEDED" | "PARTIAL" | "FAILED";

/** Stable UTF-8 payload whose SHA-256 identifies the executable taxonomy. */
export const DATA_TRANSFER_TAXONOMY_CANONICAL =
  "{\"id\":\"aws-cur2-data-transfer\",\"version\":\"2026-07-31.v1\",\"rules\":[{\"id\":\"CLOUDFRONT_PRODUCT_OUT_BYTES_V1\",\"predicate\":\"productCode=AmazonCloudFront AND usageType=/(?:^|-)DataTransfer-Out-(?:O)?Bytes$/\"},{\"id\":\"INTER_AZ_REGIONAL_BYTES_V1\",\"predicate\":\"usageType=/(?:^|-)DataTransfer-Regional-Bytes$/\"},{\"id\":\"INTER_REGION_AWS_BYTES_V1\",\"predicate\":\"usageType=/(?:^|-)AWS-(?:In|Out)-(?:A)?Bytes$/\"},{\"id\":\"INTERNET_DATA_TRANSFER_BYTES_V1\",\"predicate\":\"usageType=/(?:^|-)DataTransfer-(?:In|Out)-(?:A)?Bytes$/\"}],\"unitToBytes\":{\"Byte\":\"1\",\"Bytes\":\"1\",\"GB\":\"1000000000\",\"GiB\":\"1073741824\",\"KB\":\"1000\",\"KiB\":\"1024\",\"MB\":\"1000000\",\"MiB\":\"1048576\",\"TB\":\"1000000000000\",\"TiB\":\"1099511627776\"}}";

export const DATA_TRANSFER_TAXONOMY = Object.freeze({
  id: "aws-cur2-data-transfer",
  version: "2026-07-31.v1",
  sha256: "8f1c4fe405bb45d02a4eaff961d00a2fb3f4eb619ea012512997061209d8a03a",
  references: Object.freeze([
    "https://docs.aws.amazon.com/cur/latest/userguide/cur-data-transfers-charges.html",
    "https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/datatransfer-dashboard.html",
  ]),
  rules: Object.freeze([
    Object.freeze({
      id: "CLOUDFRONT_PRODUCT_OUT_BYTES_V1",
      category: "CLOUDFRONT" as const,
      evidenceFields: Object.freeze(["productCode", "usageType"]),
    }),
    Object.freeze({
      id: "INTER_AZ_REGIONAL_BYTES_V1",
      category: "INTER_AZ" as const,
      evidenceFields: Object.freeze(["usageType"]),
    }),
    Object.freeze({
      id: "INTER_REGION_AWS_BYTES_V1",
      category: "INTER_REGION" as const,
      evidenceFields: Object.freeze(["usageType"]),
    }),
    Object.freeze({
      id: "INTERNET_DATA_TRANSFER_BYTES_V1",
      category: "INTERNET" as const,
      evidenceFields: Object.freeze(["usageType"]),
    }),
  ]),
  /** Exact byte factors for source units; no undocumented unit is converted. */
  unitToBytes: Object.freeze({
    Byte: "1",
    Bytes: "1",
    KB: "1000",
    MB: "1000000",
    GB: "1000000000",
    TB: "1000000000000",
    KiB: "1024",
    MiB: "1048576",
    GiB: "1073741824",
    TiB: "1099511627776",
  }),
} as const);

export interface DataTransferTenantBoundary {
  readonly scope: FinopsReconciliationScope;
  readonly payerAccountIds: readonly string[];
  readonly usageAccountIds: readonly string[];
}

export interface DataTransferCur2Evidence {
  readonly source: "AWS_CUR2_ACTIVE_GENERATION";
  readonly sourceFormat: "aws-cur";
  readonly sourceVersion: "2.0";
  readonly sourceEvidenceId: string;
  readonly manifestSha256: string;
  readonly generationId: string;
  readonly generationState: "ACTIVE";
  readonly generatedAtIso: string | null;
  readonly dataThroughAtIso: string | null;
  readonly observedAtIso: string;
  readonly payerAccountIds: readonly string[];
  readonly usageAccountIds: readonly string[];
  readonly status: DataTransferSourceStatus;
  /** Null when active-generation persistence did not retain manifest coverage. */
  readonly manifestObjectCount: number | null;
  /** Null when active-generation persistence did not retain manifest coverage. */
  readonly processedObjectCount: number | null;
  readonly sourceRowCount: number;
  readonly acceptedRowCount: number;
  readonly rejectedRowCount: number;
  readonly rowsExhausted: boolean;
  readonly errorCode: string | null;
}

export interface DataTransferCapture {
  readonly schemaVersion: "sutra.finops-data-transfer-capture.v1";
  readonly scope: FinopsReconciliationScope;
  readonly evidence: DataTransferCur2Evidence | null;
  readonly rows: readonly ScopedCanonicalBillingRow[];
  /** A caller may lower, but never raise, the server's response bound. */
  readonly groupLimit?: number;
}

export interface DataTransferCostSummary {
  readonly basis: DataTransferCostBasis;
  readonly totalMicros: string | null;
  readonly contributingRowCount: number;
  readonly missingRowCount: number;
  readonly coverage: "complete" | "partial" | "unavailable";
}

export interface DataTransferQuantitySummary {
  readonly sourceUnit: string;
  readonly quantityMicros: string;
  /** Exact signed microbytes, or null for a unit absent from the taxonomy. */
  readonly normalizedBytesMicros: string | null;
  readonly rowCount: number;
}

export interface DataTransferCategorySummary {
  readonly category: DataTransferCategory;
  readonly currency: string;
  readonly rowCount: number;
  readonly directionCounts: Readonly<Record<DataTransferDirection, number>>;
  readonly costs: readonly DataTransferCostSummary[];
  readonly quantities: readonly DataTransferQuantitySummary[];
  readonly normalizedBytesMicros: string | null;
  readonly byteNormalizedRowCount: number;
  readonly missingOrUnknownUnitRowCount: number;
}

export interface DataTransferDrilldown {
  readonly category: DataTransferCategory;
  readonly direction: DataTransferDirection;
  readonly currency: string;
  readonly usageAccountId: string;
  readonly service: string;
  readonly region: string | null;
  readonly availabilityZone: string | null;
  readonly resourceId: string | null;
  readonly rowCount: number;
  readonly costs: readonly DataTransferCostSummary[];
  readonly quantities: readonly DataTransferQuantitySummary[];
  readonly normalizedBytesMicros: string | null;
  readonly classificationRuleIds: readonly string[];
  readonly usageTypes: readonly string[];
  readonly usageTypesTruncated: boolean;
  readonly sourceLineIdCount: number;
  readonly sourceLineIds: readonly string[];
  readonly sourceLineIdsTruncated: boolean;
}

export interface DataTransferCoverage {
  readonly scannedRowCount: number;
  readonly transferCandidateRowCount: number;
  readonly classifiedRowCount: number;
  readonly unknownRowCount: number;
  readonly unclassifiedRowCount: number;
  readonly excludedNonTransferRowCount: number;
  readonly missingUsageTypeRowCount: number;
  readonly classification: "complete" | "partial" | "unavailable";
  readonly dimensions: {
    readonly account: "complete" | "partial" | "unavailable";
    readonly service: "complete" | "partial" | "unavailable";
    readonly region: "complete" | "partial" | "unavailable";
    readonly resource: "complete" | "partial" | "unavailable";
  };
  readonly byteNormalization: "complete" | "partial" | "unavailable";
  readonly byteNormalizedRowCount: number;
  readonly missingQuantityRowCount: number;
  readonly unknownUnitRowCount: number;
}

export interface DataTransferSnapshot {
  readonly schemaVersion: "sutra.finops-data-transfer-snapshot.v1";
  readonly state: DataTransferSnapshotState;
  readonly complete: boolean;
  readonly scope: FinopsReconciliationScope;
  readonly source: {
    readonly kind: "AWS_CUR2_ACTIVE_GENERATION";
    readonly evidenceId: string | null;
    readonly generationId: string;
    readonly manifestSha256: string | null;
    readonly status: DataTransferSourceStatus | "NOT_CONFIGURED";
    readonly generatedAtIso: string | null;
    readonly dataThroughAtIso: string | null;
    readonly evaluatedAtIso: string;
    readonly ageHours: number | null;
    readonly freshnessSlaHours: number;
    readonly errorCode: string | null;
    readonly objectCoverage: {
      readonly status: "complete" | "unavailable";
      readonly manifestObjectCount: number | null;
      readonly processedObjectCount: number | null;
    };
  };
  readonly taxonomy: typeof DATA_TRANSFER_TAXONOMY;
  readonly coverage: DataTransferCoverage;
  readonly categorySummaries: readonly DataTransferCategorySummary[];
  readonly drilldowns: readonly DataTransferDrilldown[];
  readonly limitations: readonly string[];
}

export type DataTransferAnalysisErrorCode =
  | "INVALID_INPUT"
  | "SCOPE_MISMATCH"
  | "SOURCE_MISMATCH"
  | "IMMUTABILITY_VIOLATION"
  | "DUPLICATE_EVIDENCE"
  | "BOUND_EXCEEDED";

export class DataTransferAnalysisError extends Error {
  readonly code: DataTransferAnalysisErrorCode;

  constructor(code: DataTransferAnalysisErrorCode) {
    super(code);
    this.name = "DataTransferAnalysisError";
    this.code = code;
  }
}

interface Classification {
  readonly candidate: boolean;
  readonly category: DataTransferCategory | null;
  readonly direction: DataTransferDirection;
  readonly ruleId: string | null;
}

interface MutableCost {
  total: bigint;
  contributingRows: number;
}

interface MutableQuantity {
  total: bigint;
  normalizedBytes: bigint;
  normalizedRows: number;
  rowCount: number;
}

interface MutableAggregate {
  readonly category: DataTransferCategory;
  readonly currency: string;
  rowCount: number;
  readonly directions: Record<DataTransferDirection, number>;
  readonly costs: Record<DataTransferCostBasis, MutableCost>;
  readonly quantities: Map<string, MutableQuantity>;
  missingQuantityRows: number;
  unknownUnitRows: number;
}

interface MutableDrilldown extends MutableAggregate {
  readonly direction: DataTransferDirection;
  readonly usageAccountId: string;
  readonly service: string;
  readonly region: string | null;
  readonly availabilityZone: string | null;
  readonly resourceId: string | null;
  readonly ruleIds: Set<string>;
  readonly usageTypes: Set<string>;
  readonly sourceLineIds: Set<string>;
  sourceLineIdCount: number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validText(
  value: unknown,
  maximum: number = DATA_TRANSFER_ANALYSIS_BOUNDS.maximumTextLength,
): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !value.includes("\0");
}

function validIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function safeCount(value: unknown, maximum: number = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= maximum;
}

function validScope(value: unknown): value is FinopsReconciliationScope {
  if (!isRecord(value)) return false;
  return typeof value.organizationId === "string"
    && IDENTIFIER.test(value.organizationId)
    && typeof value.customerId === "string"
    && IDENTIFIER.test(value.customerId)
    && typeof value.connectionId === "string"
    && IDENTIFIER.test(value.connectionId)
    && validText(value.exportName, 256)
    && typeof value.billingPeriod === "string"
    && PERIOD.test(value.billingPeriod)
    && typeof value.generationId === "string"
    && GENERATION_ID.test(value.generationId);
}

function sameScope(left: FinopsReconciliationScope, right: FinopsReconciliationScope): boolean {
  return left.organizationId === right.organizationId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId
    && left.exportName === right.exportName
    && left.billingPeriod === right.billingPeriod
    && left.generationId === right.generationId;
}

function sortedAccounts(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > DATA_TRANSFER_ANALYSIS_BOUNDS.maximumAccounts) {
    return null;
  }
  const result = new Set<string>();
  for (const accountId of value) {
    if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)) return null;
    result.add(accountId);
  }
  if (result.size !== value.length) return null;
  return [...result].sort(compareText);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function byteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return Number.POSITIVE_INFINITY;
    return new TextEncoder().encode(serialized).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function nullableText(value: unknown, maximum = 1_024): value is string | null {
  return value === null || validText(value, maximum);
}

function costValue(line: CanonicalCurLine, basis: DataTransferCostBasis): string | null {
  switch (basis) {
    case "unblended": return line.amountMicros;
    case "net": return line.netUnblendedCostMicros;
    case "amortized": return line.amortizedMicros;
    case "list": return line.listCostMicros;
    case "contracted": return line.contractedCostMicros;
    case "public": return line.publicOnDemandCostMicros;
  }
}

function validLine(value: unknown): value is CanonicalCurLine {
  if (!isRecord(value)) return false;
  if (
    value.sourceFormat !== "aws-cur"
    || value.sourceVersion !== "2.0"
    || !validText(value.lineItemId)
    || typeof value.usageAccountId !== "string"
    || !ACCOUNT_ID.test(value.usageAccountId)
    || typeof value.payerAccountId !== "string"
    || !ACCOUNT_ID.test(value.payerAccountId)
    || !validText(value.service, 1_024)
    || !validIso(value.usageStartIso)
    || (value.usageEndIso !== null && !validIso(value.usageEndIso))
    || !nullableText(value.usageType, 1_024)
    || !nullableText(value.usageUnit, 128)
    || !nullableText(value.region, 128)
    || !nullableText(value.availabilityZone, 128)
    || !nullableText(value.resourceId)
    || !nullableText(value.productCode, 256)
    || !nullableText(value.productFamily, 512)
    || typeof value.currency !== "string"
    || !FINOPS_RECONCILIATION_CURRENCIES.has(
      value.currency as (typeof FINOPS_RECONCILIATION_CURRENCIES extends Set<infer T> ? T : never),
    )
  ) return false;
  for (const basis of DATA_TRANSFER_COST_BASES) {
    const amount = costValue(value as unknown as CanonicalCurLine, basis);
    if (amount !== null && !INTEGER_MICROS.test(amount)) return false;
  }
  return value.usageAmountMicros === null
    || (typeof value.usageAmountMicros === "string" && INTEGER_MICROS.test(value.usageAmountMicros));
}

function directionFor(usageType: string): DataTransferDirection {
  if (/(?:^|[-:])In(?:-|:|$)/u.test(usageType)) return "INBOUND";
  if (/(?:^|[-:])Out(?:-|:|$)/u.test(usageType)) return "OUTBOUND";
  return "UNKNOWN";
}

function classify(line: CanonicalCurLine): Classification {
  const usageType = line.usageType;
  const productFamilySignal = line.productFamily?.toLowerCase().includes("data transfer") === true;
  if (usageType === null) {
    return productFamilySignal
      ? { candidate: true, category: "UNKNOWN", direction: "UNKNOWN", ruleId: "MISSING_USAGE_TYPE_V1" }
      : { candidate: false, category: null, direction: "UNKNOWN", ruleId: null };
  }
  if (
    line.productCode === "AmazonCloudFront"
    && /(?:^|-)DataTransfer-Out-(?:O)?Bytes$/u.test(usageType)
  ) {
    return {
      candidate: true,
      category: "CLOUDFRONT",
      direction: "OUTBOUND",
      ruleId: "CLOUDFRONT_PRODUCT_OUT_BYTES_V1",
    };
  }
  if (/(?:^|-)DataTransfer-Regional-Bytes$/u.test(usageType)) {
    return {
      candidate: true,
      category: "INTER_AZ",
      direction: "UNKNOWN",
      ruleId: "INTER_AZ_REGIONAL_BYTES_V1",
    };
  }
  if (/(?:^|-)AWS-(?:In|Out)-(?:A)?Bytes$/u.test(usageType)) {
    return {
      candidate: true,
      category: "INTER_REGION",
      direction: directionFor(usageType),
      ruleId: "INTER_REGION_AWS_BYTES_V1",
    };
  }
  if (/(?:^|-)DataTransfer-(?:In|Out)-(?:A)?Bytes$/u.test(usageType)) {
    return {
      candidate: true,
      category: "INTERNET",
      direction: directionFor(usageType),
      ruleId: "INTERNET_DATA_TRANSFER_BYTES_V1",
    };
  }
  const usageSignal = /(?:DataTransfer|DataXfer|AWS-(?:In|Out)-|CloudFront-(?:In|Out)-)/iu.test(usageType);
  return usageSignal || productFamilySignal
    ? {
        candidate: true,
        category: "UNCLASSIFIED",
        direction: directionFor(usageType),
        ruleId: "UNMAPPED_TRANSFER_SIGNAL_V1",
      }
    : { candidate: false, category: null, direction: "UNKNOWN", ruleId: null };
}

function emptyCosts(): Record<DataTransferCostBasis, MutableCost> {
  return {
    unblended: { total: BigInt(0), contributingRows: 0 },
    net: { total: BigInt(0), contributingRows: 0 },
    amortized: { total: BigInt(0), contributingRows: 0 },
    list: { total: BigInt(0), contributingRows: 0 },
    contracted: { total: BigInt(0), contributingRows: 0 },
    public: { total: BigInt(0), contributingRows: 0 },
  };
}

function emptyAggregate(category: DataTransferCategory, currency: string): MutableAggregate {
  return {
    category,
    currency,
    rowCount: 0,
    directions: { INBOUND: 0, OUTBOUND: 0, UNKNOWN: 0 },
    costs: emptyCosts(),
    quantities: new Map(),
    missingQuantityRows: 0,
    unknownUnitRows: 0,
  };
}

function addLine(aggregate: MutableAggregate, line: CanonicalCurLine, direction: DataTransferDirection): void {
  aggregate.rowCount += 1;
  aggregate.directions[direction] += 1;
  for (const basis of DATA_TRANSFER_COST_BASES) {
    const amount = costValue(line, basis);
    if (amount === null) continue;
    aggregate.costs[basis].total += BigInt(amount);
    aggregate.costs[basis].contributingRows += 1;
  }
  if (line.usageAmountMicros === null || line.usageUnit === null) {
    aggregate.missingQuantityRows += 1;
    return;
  }
  const current = aggregate.quantities.get(line.usageUnit) ?? {
    total: BigInt(0),
    normalizedBytes: BigInt(0),
    normalizedRows: 0,
    rowCount: 0,
  };
  const quantity = BigInt(line.usageAmountMicros);
  current.total += quantity;
  current.rowCount += 1;
  const factor = DATA_TRANSFER_TAXONOMY.unitToBytes[
    line.usageUnit as keyof typeof DATA_TRANSFER_TAXONOMY.unitToBytes
  ];
  if (factor === undefined) {
    aggregate.unknownUnitRows += 1;
  } else {
    current.normalizedBytes += quantity * BigInt(factor);
    current.normalizedRows += 1;
  }
  aggregate.quantities.set(line.usageUnit, current);
}

function coverage(contributing: number, total: number): "complete" | "partial" | "unavailable" {
  if (contributing === 0 || total === 0) return "unavailable";
  return contributing === total ? "complete" : "partial";
}

function costsFor(aggregate: MutableAggregate): DataTransferCostSummary[] {
  return DATA_TRANSFER_COST_BASES.map((basis) => ({
    basis,
    totalMicros: aggregate.costs[basis].contributingRows === 0
      ? null
      : aggregate.costs[basis].total.toString(),
    contributingRowCount: aggregate.costs[basis].contributingRows,
    missingRowCount: aggregate.rowCount - aggregate.costs[basis].contributingRows,
    coverage: coverage(aggregate.costs[basis].contributingRows, aggregate.rowCount),
  }));
}

function quantitiesFor(aggregate: MutableAggregate): DataTransferQuantitySummary[] {
  return [...aggregate.quantities.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([sourceUnit, quantity]) => ({
      sourceUnit,
      quantityMicros: quantity.total.toString(),
      normalizedBytesMicros: quantity.normalizedRows === quantity.rowCount
        ? quantity.normalizedBytes.toString()
        : null,
      rowCount: quantity.rowCount,
    }));
}

function normalizedBytesFor(aggregate: MutableAggregate): string | null {
  const quantities = [...aggregate.quantities.values()];
  const normalizedRows = quantities.reduce((sum, quantity) => sum + quantity.normalizedRows, 0);
  const expectedRows = aggregate.rowCount - aggregate.missingQuantityRows;
  if (expectedRows === 0 || normalizedRows !== expectedRows) return null;
  return quantities.reduce((sum, quantity) => sum + quantity.normalizedBytes, BigInt(0)).toString();
}

function validEvidence(
  value: unknown,
  scope: FinopsReconciliationScope,
  payerAccountIds: readonly string[],
  usageAccountIds: readonly string[],
  rowCount: number,
  nowMs: number,
): value is DataTransferCur2Evidence {
  if (!isRecord(value)) return false;
  const evidencePayers = sortedAccounts(value.payerAccountIds);
  const evidenceUsage = sortedAccounts(value.usageAccountIds);
  const hasObjectCoverage = value.manifestObjectCount !== null
    && value.processedObjectCount !== null;
  if (
    value.source !== "AWS_CUR2_ACTIVE_GENERATION"
    || value.sourceFormat !== "aws-cur"
    || value.sourceVersion !== "2.0"
    || !validText(value.sourceEvidenceId, 1_024)
    || typeof value.manifestSha256 !== "string"
    || !SHA256.test(value.manifestSha256)
    || value.generationId !== scope.generationId
    || value.generationState !== "ACTIVE"
    || (value.generatedAtIso !== null && !validIso(value.generatedAtIso))
    || (value.dataThroughAtIso !== null && !validIso(value.dataThroughAtIso))
    || !validIso(value.observedAtIso)
    || (value.generatedAtIso !== null && Date.parse(value.generatedAtIso) > nowMs + CLOCK_SKEW_MS)
    || (value.dataThroughAtIso !== null && Date.parse(value.dataThroughAtIso) > nowMs + CLOCK_SKEW_MS)
    || Date.parse(value.observedAtIso) > nowMs + CLOCK_SKEW_MS
    || (value.generatedAtIso === null) !== (value.dataThroughAtIso === null)
    || (
      value.generatedAtIso !== null
      && value.dataThroughAtIso !== null
      && Date.parse(value.dataThroughAtIso) > Date.parse(value.generatedAtIso)
    )
    || evidencePayers === null
    || evidenceUsage === null
    || !sameStrings(evidencePayers, payerAccountIds)
    || !sameStrings(evidenceUsage, usageAccountIds)
    || !["SUCCEEDED", "PARTIAL", "FAILED"].includes(String(value.status))
    || (
      value.manifestObjectCount !== null
      && !safeCount(value.manifestObjectCount, DATA_TRANSFER_ANALYSIS_BOUNDS.maximumManifestObjects)
    )
    || (
      value.processedObjectCount !== null
      && !safeCount(value.processedObjectCount, DATA_TRANSFER_ANALYSIS_BOUNDS.maximumManifestObjects)
    )
    || (value.manifestObjectCount === null) !== (value.processedObjectCount === null)
    || (
      hasObjectCoverage
      && value.processedObjectCount! > value.manifestObjectCount!
    )
    || !safeCount(value.sourceRowCount, DATA_TRANSFER_ANALYSIS_BOUNDS.maximumRows)
    || !safeCount(value.acceptedRowCount, DATA_TRANSFER_ANALYSIS_BOUNDS.maximumRows)
    || !safeCount(value.rejectedRowCount, DATA_TRANSFER_ANALYSIS_BOUNDS.maximumRows)
    || value.acceptedRowCount !== rowCount
    || value.acceptedRowCount + value.rejectedRowCount > value.sourceRowCount
    || typeof value.rowsExhausted !== "boolean"
    || (value.errorCode !== null && (typeof value.errorCode !== "string" || !SAFE_ERROR_CODE.test(value.errorCode)))
  ) return false;
  if (value.status === "SUCCEEDED") {
    return hasObjectCoverage
      && value.generatedAtIso !== null
      && value.dataThroughAtIso !== null
      && value.rowsExhausted
      && value.processedObjectCount === value.manifestObjectCount
      && value.acceptedRowCount + value.rejectedRowCount === value.sourceRowCount
      && value.rejectedRowCount === 0
      && value.errorCode === null;
  }
  if (value.status === "PARTIAL") {
    return value.errorCode !== null && (
      !hasObjectCoverage
      || value.generatedAtIso === null
      || value.dataThroughAtIso === null
      || !value.rowsExhausted
      || (
        value.processedObjectCount !== null
        && value.manifestObjectCount !== null
        && value.processedObjectCount < value.manifestObjectCount
      )
      || value.acceptedRowCount + value.rejectedRowCount < value.sourceRowCount
      || value.rejectedRowCount > 0
    );
  }
  return value.errorCode !== null && rowCount === 0;
}

function baseCoverage(scannedRowCount: number): DataTransferCoverage {
  return {
    scannedRowCount,
    transferCandidateRowCount: 0,
    classifiedRowCount: 0,
    unknownRowCount: 0,
    unclassifiedRowCount: 0,
    excludedNonTransferRowCount: scannedRowCount,
    missingUsageTypeRowCount: 0,
    classification: "unavailable",
    dimensions: {
      account: "unavailable",
      service: "unavailable",
      region: "unavailable",
      resource: "unavailable",
    },
    byteNormalization: "unavailable",
    byteNormalizedRowCount: 0,
    missingQuantityRowCount: 0,
    unknownUnitRowCount: 0,
  };
}

function emptySnapshot(
  state: "CONFIGURATION_REQUIRED" | "ERROR" | "EMPTY",
  scope: FinopsReconciliationScope,
  evidence: DataTransferCur2Evidence | null,
  nowIso: string,
): DataTransferSnapshot {
  return {
    schemaVersion: "sutra.finops-data-transfer-snapshot.v1",
    state,
    complete: state === "EMPTY",
    scope,
    source: {
      kind: "AWS_CUR2_ACTIVE_GENERATION",
      evidenceId: evidence?.sourceEvidenceId ?? null,
      generationId: scope.generationId,
      manifestSha256: evidence?.manifestSha256 ?? null,
      status: evidence?.status ?? "NOT_CONFIGURED",
      generatedAtIso: evidence?.generatedAtIso ?? null,
      dataThroughAtIso: evidence?.dataThroughAtIso ?? null,
      evaluatedAtIso: nowIso,
      ageHours: evidence === null || evidence.dataThroughAtIso === null
        ? null
        : Math.floor((Date.parse(nowIso) - Date.parse(evidence.dataThroughAtIso)) / HOUR_MS),
      freshnessSlaHours: DATA_TRANSFER_ANALYSIS_BOUNDS.freshnessSlaHours,
      errorCode: evidence?.errorCode ?? null,
      objectCoverage: {
        status: evidence === null || evidence.manifestObjectCount === null
          ? "unavailable"
          : "complete",
        manifestObjectCount: evidence?.manifestObjectCount ?? null,
        processedObjectCount: evidence?.processedObjectCount ?? null,
      },
    },
    taxonomy: DATA_TRANSFER_TAXONOMY,
    coverage: baseCoverage(0),
    categorySummaries: [],
    drilldowns: [],
    limitations: [
      "Only immutable active AWS CUR 2.0 evidence is analyzed; absent or failed evidence never becomes live data.",
      "Classification uses pinned AWS-documented CUR usage-type patterns; ambiguous and new patterns remain unknown or unclassified.",
      "Region and Availability Zone fields are the CUR line dimensions, not inferred traffic endpoints.",
      "Costs are signed source micro-units by currency and basis; this is not an invoice reconciliation or savings claim.",
    ],
  };
}

/**
 * Build the bounded enterprise Data Transfer snapshot. Invalid or cross-tenant
 * input fails closed; ordinary source readiness is represented in the result.
 */
export function buildDataTransferAnalysis(
  boundary: DataTransferTenantBoundary,
  capture: DataTransferCapture,
  now: Date = new Date(),
): DataTransferSnapshot {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || !isRecord(boundary) || !validScope(boundary.scope) || !isRecord(capture) || !validScope(capture.scope)) {
    throw new DataTransferAnalysisError("INVALID_INPUT");
  }
  if (!sameScope(boundary.scope, capture.scope)) {
    throw new DataTransferAnalysisError("SCOPE_MISMATCH");
  }
  const payerAccountIds = sortedAccounts(boundary.payerAccountIds);
  const usageAccountIds = sortedAccounts(boundary.usageAccountIds);
  if (payerAccountIds === null || usageAccountIds === null) {
    throw new DataTransferAnalysisError("INVALID_INPUT");
  }
  if (capture.schemaVersion !== "sutra.finops-data-transfer-capture.v1" || !Array.isArray(capture.rows)) {
    throw new DataTransferAnalysisError("INVALID_INPUT");
  }
  if (capture.rows.length > DATA_TRANSFER_ANALYSIS_BOUNDS.maximumRows) {
    throw new DataTransferAnalysisError("BOUND_EXCEEDED");
  }
  const groupLimit = capture.groupLimit ?? DATA_TRANSFER_ANALYSIS_BOUNDS.maximumGroups;
  if (!safeCount(groupLimit, DATA_TRANSFER_ANALYSIS_BOUNDS.maximumGroups) || groupLimit < 1) {
    throw new DataTransferAnalysisError("INVALID_INPUT");
  }
  if (byteLength(capture) > DATA_TRANSFER_ANALYSIS_BOUNDS.maximumCaptureBytes) {
    throw new DataTransferAnalysisError("BOUND_EXCEEDED");
  }
  const nowIso = now.toISOString();
  if (capture.evidence === null) {
    if (capture.rows.length > 0) throw new DataTransferAnalysisError("SOURCE_MISMATCH");
    return emptySnapshot("CONFIGURATION_REQUIRED", capture.scope, null, nowIso);
  }
  if (capture.evidence.generationId !== capture.scope.generationId || capture.evidence.generationState !== "ACTIVE") {
    throw new DataTransferAnalysisError("IMMUTABILITY_VIOLATION");
  }
  if (!validEvidence(
    capture.evidence,
    capture.scope,
    payerAccountIds,
    usageAccountIds,
    capture.rows.length,
    nowMs,
  )) {
    throw new DataTransferAnalysisError("SOURCE_MISMATCH");
  }
  if (capture.evidence.status === "FAILED") {
    return emptySnapshot("ERROR", capture.scope, capture.evidence, nowIso);
  }
  if (capture.evidence.status === "SUCCEEDED" && capture.rows.length === 0) {
    return emptySnapshot("EMPTY", capture.scope, capture.evidence, nowIso);
  }

  const payerSet = new Set(payerAccountIds);
  const accountSet = new Set(usageAccountIds);
  const seenLineIds = new Set<string>();
  const categoryAggregates = new Map<string, MutableAggregate>();
  const drilldownAggregates = new Map<string, MutableDrilldown>();
  let candidates = 0;
  let classified = 0;
  let unknown = 0;
  let unclassified = 0;
  let excluded = 0;
  let missingUsageType = 0;
  let regionRows = 0;
  let resourceRows = 0;
  let normalizedRows = 0;
  let missingQuantityRows = 0;
  let unknownUnitRows = 0;

  for (let index = 0; index < capture.rows.length; index += 1) {
    const row = capture.rows[index];
    if (!isRecord(row) || !validScope(row) || !sameScope(capture.scope, row)) {
      throw new DataTransferAnalysisError("SCOPE_MISMATCH");
    }
    if (!validLine(row.line)) throw new DataTransferAnalysisError("SOURCE_MISMATCH");
    const line = row.line;
    if (!payerSet.has(line.payerAccountId ?? "") || !accountSet.has(line.usageAccountId)) {
      throw new DataTransferAnalysisError("SCOPE_MISMATCH");
    }
    if (seenLineIds.has(line.lineItemId)) throw new DataTransferAnalysisError("DUPLICATE_EVIDENCE");
    seenLineIds.add(line.lineItemId);

    const result = classify(line);
    if (!result.candidate || result.category === null || result.ruleId === null) {
      excluded += 1;
      continue;
    }
    candidates += 1;
    if (line.usageType === null) missingUsageType += 1;
    if (result.category === "UNKNOWN") unknown += 1;
    else if (result.category === "UNCLASSIFIED") unclassified += 1;
    else classified += 1;
    if (line.region !== null) regionRows += 1;
    if (line.resourceId !== null) resourceRows += 1;
    if (line.usageAmountMicros === null || line.usageUnit === null) {
      missingQuantityRows += 1;
    } else if (DATA_TRANSFER_TAXONOMY.unitToBytes[
      line.usageUnit as keyof typeof DATA_TRANSFER_TAXONOMY.unitToBytes
    ] === undefined) {
      unknownUnitRows += 1;
    } else {
      normalizedRows += 1;
    }

    const categoryKey = JSON.stringify([result.category, line.currency]);
    let category = categoryAggregates.get(categoryKey);
    if (category === undefined) {
      category = emptyAggregate(result.category, line.currency);
      categoryAggregates.set(categoryKey, category);
    }
    addLine(category, line, result.direction);

    const dimensions = [
      result.category,
      result.direction,
      line.currency,
      line.usageAccountId,
      line.service,
      line.region,
      line.availabilityZone,
      line.resourceId,
    ] as const;
    const groupKey = JSON.stringify(dimensions);
    let drilldown = drilldownAggregates.get(groupKey);
    if (drilldown === undefined) {
      if (drilldownAggregates.size >= groupLimit) {
        throw new DataTransferAnalysisError("BOUND_EXCEEDED");
      }
      drilldown = {
        ...emptyAggregate(result.category, line.currency),
        direction: result.direction,
        usageAccountId: line.usageAccountId,
        service: line.service,
        region: line.region,
        availabilityZone: line.availabilityZone,
        resourceId: line.resourceId,
        ruleIds: new Set(),
        usageTypes: new Set(),
        sourceLineIds: new Set(),
        sourceLineIdCount: 0,
      };
      drilldownAggregates.set(groupKey, drilldown);
    }
    addLine(drilldown, line, result.direction);
    drilldown.ruleIds.add(result.ruleId);
    if (
      line.usageType !== null
      && drilldown.usageTypes.size <= DATA_TRANSFER_ANALYSIS_BOUNDS.maximumUsageTypesPerGroup
    ) {
      drilldown.usageTypes.add(line.usageType);
    }
    drilldown.sourceLineIdCount += 1;
    if (drilldown.sourceLineIds.size < DATA_TRANSFER_ANALYSIS_BOUNDS.maximumSourceLineIdsPerGroup) {
      drilldown.sourceLineIds.add(line.lineItemId);
    }
  }

  const categorySummaries = [...categoryAggregates.values()]
    .sort((left, right) => compareText(left.category, right.category) || compareText(left.currency, right.currency))
    .map((aggregate): DataTransferCategorySummary => ({
      category: aggregate.category,
      currency: aggregate.currency,
      rowCount: aggregate.rowCount,
      directionCounts: aggregate.directions,
      costs: costsFor(aggregate),
      quantities: quantitiesFor(aggregate),
      normalizedBytesMicros: normalizedBytesFor(aggregate),
      byteNormalizedRowCount: aggregate.rowCount - aggregate.missingQuantityRows - aggregate.unknownUnitRows,
      missingOrUnknownUnitRowCount: aggregate.missingQuantityRows + aggregate.unknownUnitRows,
    }));
  const drilldowns = [...drilldownAggregates.values()]
    .sort((left, right) => compareText(
      JSON.stringify([left.category, left.direction, left.currency, left.usageAccountId, left.service, left.region, left.availabilityZone, left.resourceId]),
      JSON.stringify([right.category, right.direction, right.currency, right.usageAccountId, right.service, right.region, right.availabilityZone, right.resourceId]),
    ))
    .map((aggregate): DataTransferDrilldown => ({
      category: aggregate.category,
      direction: aggregate.direction,
      currency: aggregate.currency,
      usageAccountId: aggregate.usageAccountId,
      service: aggregate.service,
      region: aggregate.region,
      availabilityZone: aggregate.availabilityZone,
      resourceId: aggregate.resourceId,
      rowCount: aggregate.rowCount,
      costs: costsFor(aggregate),
      quantities: quantitiesFor(aggregate),
      normalizedBytesMicros: normalizedBytesFor(aggregate),
      classificationRuleIds: [...aggregate.ruleIds].sort(compareText),
      usageTypes: [...aggregate.usageTypes]
        .sort(compareText)
        .slice(0, DATA_TRANSFER_ANALYSIS_BOUNDS.maximumUsageTypesPerGroup),
      usageTypesTruncated: aggregate.usageTypes.size > DATA_TRANSFER_ANALYSIS_BOUNDS.maximumUsageTypesPerGroup,
      sourceLineIdCount: aggregate.sourceLineIdCount,
      sourceLineIds: [...aggregate.sourceLineIds].sort(compareText),
      sourceLineIdsTruncated: aggregate.sourceLineIdCount > aggregate.sourceLineIds.size,
    }));
  const classificationCoverage = candidates === 0
    ? "unavailable"
    : classified === candidates
      ? "complete"
      : "partial";
  const ageHours = capture.evidence.dataThroughAtIso === null
    ? null
    : Math.floor((nowMs - Date.parse(capture.evidence.dataThroughAtIso)) / HOUR_MS);
  const state: DataTransferSnapshotState = capture.evidence.status === "PARTIAL"
    ? "PARTIAL"
    : ageHours !== null && ageHours > DATA_TRANSFER_ANALYSIS_BOUNDS.freshnessSlaHours
      ? "STALE"
      : "READY";
  const snapshot: DataTransferSnapshot = {
    schemaVersion: "sutra.finops-data-transfer-snapshot.v1",
    state,
    complete: state === "READY",
    scope: capture.scope,
    source: {
      kind: "AWS_CUR2_ACTIVE_GENERATION",
      evidenceId: capture.evidence.sourceEvidenceId,
      generationId: capture.evidence.generationId,
      manifestSha256: capture.evidence.manifestSha256,
      status: capture.evidence.status,
      generatedAtIso: capture.evidence.generatedAtIso,
      dataThroughAtIso: capture.evidence.dataThroughAtIso,
      evaluatedAtIso: nowIso,
      ageHours,
      freshnessSlaHours: DATA_TRANSFER_ANALYSIS_BOUNDS.freshnessSlaHours,
      errorCode: capture.evidence.errorCode,
      objectCoverage: {
        status: capture.evidence.manifestObjectCount === null
          ? "unavailable"
          : "complete",
        manifestObjectCount: capture.evidence.manifestObjectCount,
        processedObjectCount: capture.evidence.processedObjectCount,
      },
    },
    taxonomy: DATA_TRANSFER_TAXONOMY,
    coverage: {
      scannedRowCount: capture.rows.length,
      transferCandidateRowCount: candidates,
      classifiedRowCount: classified,
      unknownRowCount: unknown,
      unclassifiedRowCount: unclassified,
      excludedNonTransferRowCount: excluded,
      missingUsageTypeRowCount: missingUsageType,
      classification: classificationCoverage,
      dimensions: {
        account: coverage(candidates, candidates),
        service: coverage(candidates, candidates),
        region: coverage(regionRows, candidates),
        resource: coverage(resourceRows, candidates),
      },
      byteNormalization: coverage(normalizedRows, candidates),
      byteNormalizedRowCount: normalizedRows,
      missingQuantityRowCount: missingQuantityRows,
      unknownUnitRowCount: unknownUnitRows,
    },
    categorySummaries,
    drilldowns,
    limitations: [
      "Only immutable active AWS CUR 2.0 evidence is analyzed; no live service telemetry is inferred.",
      "CloudFront requires both its product code and documented usage-type pattern; ambiguous patterns remain unclassified.",
      "Inter-AZ rows do not identify both traffic endpoints, and CUR region/AZ fields are not presented as inferred source or destination.",
      "Byte normalization uses only the exact pinned unit multipliers; unknown or missing units remain null and disclosed.",
      "Costs and quantities retain signed corrections, remain separated by currency and source unit, and are not invoices, forecasts, or savings claims.",
    ],
  };
  if (byteLength(snapshot) > DATA_TRANSFER_ANALYSIS_BOUNDS.maximumOutputBytes) {
    throw new DataTransferAnalysisError("BOUND_EXCEEDED");
  }
  return snapshot;
}
