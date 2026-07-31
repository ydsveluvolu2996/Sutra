/**
 * Evidence-honest AWS Pricing Change Analysis engine.
 *
 * The engine performs no I/O and receives no credentials. It re-prices an
 * immutable, active CUR 2.0 usage generation with two versioned AWS Price
 * List files. The result is a public-catalog what-if comparison. It is not an
 * invoice, forecast, quote, discount calculation, or savings claim.
 */
import type { FinopsSourceScope } from "./finops-source-health.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const COLLECTION_ID = /^pca_[a-f0-9]{64}$/u;
const GENERATION_ID = /^gen_[a-f0-9]{64}$/u;
const SNAPSHOT_ID = /^pls_[a-f0-9]{64}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^(?:[a-z]{2}(?:-gov)?-[a-z]+-\d|GLOBAL)$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const SERVICE_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,95}$/u;
const UNSIGNED_INTEGER = /^(?:0|[1-9]\d{0,59})$/u;
const POSITIVE_INTEGER = /^[1-9]\d{0,59}$/u;
const PRICE_LIST_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):pricing:::price-list\/[A-Za-z0-9._/-]+$/u;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const MICROS = BigInt(1_000_000);
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);

export const PRICING_CHANGE_ANALYSIS_BOUNDS = Object.freeze({
  maximumCaptureBytes: 64 * 1_024 * 1_024,
  maximumResponseBytes: 8 * 1_024 * 1_024,
  maximumDurationMs: 15 * 60 * 1_000,
  maximumAccounts: 1_000,
  maximumRegions: 50,
  maximumUsageRecords: 250_000,
  maximumCatalogSnapshots: 20_000,
  maximumCatalogTerms: 500_000,
  maximumCatalogCoverageRecords: 40_000,
  maximumAttributes: 32,
  maximumGroupsInResponse: 5_000,
  maximumExclusionGroupsInResponse: 2_000,
  maximumTextLength: 512,
  maximumCur2GenerationAgeHours: 48,
  maximumCatalogRetrievalAgeHours: 31 * 24,
  maximumUsageHistoryDays: 400,
  maximumDecimalScale: 12,
} as const);

/** Historical bulk files are sufficient; discovery operations are optional. */
export const PRICING_CHANGE_READ_OPERATIONS = Object.freeze([
  "pricing:ListPriceLists",
  "pricing:GetPriceListFileUrl",
] as const);

export const PRICING_CHANGE_ASSUMPTIONS = Object.freeze([
  "ACTUAL_CUR2_USAGE_HELD_CONSTANT",
  "PUBLIC_AWS_CATALOG_UNIT_RATES_ONLY",
  "EXACT_CURRENCY_UNIT_TERM_AND_PRODUCT_APPLICABILITY",
  "EXCLUDES_PRIVATE_PRICING_DISCOUNTS_CREDITS_TAXES_AND_COMMITMENT_BENEFITS",
  "NOT_AN_INVOICE_FORECAST_QUOTE_OR_SAVINGS_CLAIM",
] as const);

export type PricingChangePartition = "aws" | "aws-us-gov" | "aws-cn";
export type PricingCatalogRole = "BASELINE" | "COMPARISON";
export type PricingTermType = "ON_DEMAND" | "RESERVED" | "SAVINGS_PLAN";
export type PricingLineItemType =
  | "USAGE"
  | "DISCOUNTED_USAGE"
  | "SAVINGS_PLAN_COVERED_USAGE";
export type PricingSourceStatus = "SUCCEEDED" | "PARTIAL" | "FAILED";
export type PricingChangeSnapshotState =
  | "READY"
  | "PARTIAL"
  | "CONFIGURATION_REQUIRED"
  | "STALE"
  | "NO_USAGE";
export type PricingChangeExclusionReason =
  | "STALE_CUR2_GENERATION"
  | "CUR2_SOURCE_INCOMPLETE"
  | "MISSING_BASELINE_PRICE"
  | "MISSING_COMPARISON_PRICE"
  | "MISSING_BASELINE_SNAPSHOT"
  | "MISSING_COMPARISON_SNAPSHOT"
  | "STALE_BASELINE_CATALOG"
  | "STALE_COMPARISON_CATALOG"
  | "PRICE_SERVICE_MISMATCH"
  | "PRICE_REGION_MISMATCH"
  | "PRICE_CURRENCY_MISMATCH"
  | "PRICE_UNIT_MISMATCH"
  | "PRICE_TERM_MISMATCH"
  | "PRICE_PRODUCT_APPLICABILITY_MISMATCH"
  | "PRICE_NOT_EFFECTIVE_AT_ANALYSIS_DATE"
  | "TIERED_RATE_REQUIRES_ALLOCATION_EVIDENCE";
export type PricingChangeFailureCode =
  | "INVALID_INPUT"
  | "SCOPE_MISMATCH"
  | "CONFLICTING_DUPLICATE"
  | "RECORD_LIMIT_EXCEEDED"
  | "BYTE_LIMIT_EXCEEDED"
  | "TIME_LIMIT_EXCEEDED"
  | "OUTPUT_LIMIT_EXCEEDED";

export interface PricingChangeTenantBoundary {
  readonly scope: FinopsSourceScope;
  readonly partition: PricingChangePartition;
  readonly payerAccountIds: readonly string[];
  readonly linkedAccountIds: readonly string[];
  readonly regions: readonly string[];
}

export interface PricingChangeEvidenceReference {
  readonly id: string;
  readonly kind:
    | "CUR2_DATA_EXPORT"
    | "AWS_PRICE_LIST_API"
    | "AWS_PRICE_LIST_FILE";
  readonly operation: string;
  readonly url: string;
  readonly retrievedAt: string;
  readonly effectiveAt: string;
  readonly sha256: string;
}

/** Canonical, reduced rational with a decimal (power-of-ten) denominator. */
export interface PricingChangeRationalInput {
  readonly numerator: string;
  readonly denominator: string;
}

export interface PricingChangeApplicabilityAttribute {
  readonly name: string;
  readonly value: string;
}

export interface PricingChangeCur2Coverage {
  readonly status: PricingSourceStatus;
  readonly readPermissionsValidated: boolean;
  readonly manifestObjectCount: number;
  readonly processedObjectCount: number;
  readonly errorCode: string | null;
}

export interface PricingChangeCatalogCoverage {
  readonly role: PricingCatalogRole;
  readonly serviceCode: string;
  readonly region: string;
  readonly currency: string;
  readonly status: PricingSourceStatus;
  readonly readPermissionsValidated: boolean;
  readonly priceListCount: number;
  readonly processedPriceListCount: number;
  readonly errorCode: string | null;
}

export interface PricingChangeUsageRecord {
  readonly usageId: string;
  readonly generationId: string;
  readonly payerAccountId: string;
  readonly linkedAccountId: string;
  readonly serviceCode: string;
  readonly region: string;
  readonly usageStartAt: string;
  readonly usageEndAt: string;
  readonly lineItemType: PricingLineItemType;
  readonly termType: PricingTermType;
  readonly currency: string;
  readonly usageUnit: string;
  readonly usageQuantity: PricingChangeRationalInput;
  readonly applicabilityAttributes: readonly PricingChangeApplicabilityAttribute[];
  /** Null means that the collector could not prove an exact catalog match. */
  readonly baselinePriceId: string | null;
  readonly comparisonPriceId: string | null;
  readonly source: PricingChangeEvidenceReference;
}

export interface PricingChangeCatalogSnapshot {
  readonly snapshotId: string;
  readonly role: PricingCatalogRole;
  readonly partition: PricingChangePartition;
  readonly serviceCode: string;
  readonly region: string;
  readonly currency: string;
  readonly requestedEffectiveAt: string;
  readonly catalogEffectiveAt: string;
  readonly catalogPublicationAt: string;
  readonly catalogVersion: string;
  readonly priceListArn: string;
  readonly fileFormat: "json";
  readonly listEvidence: PricingChangeEvidenceReference;
  readonly fileEvidence: PricingChangeEvidenceReference;
}

export interface PricingChangeCatalogTerm {
  readonly priceId: string;
  readonly snapshotId: string;
  readonly serviceCode: string;
  readonly region: string;
  readonly currency: string;
  readonly productSku: string;
  readonly offerTermCode: string;
  readonly rateCode: string;
  readonly termType: PricingTermType;
  readonly usageUnit: string;
  readonly applicabilityAttributes: readonly PricingChangeApplicabilityAttribute[];
  readonly beginRange: PricingChangeRationalInput;
  /** Null denotes the AWS Price List `Inf` upper bound. */
  readonly endRange: PricingChangeRationalInput | null;
  readonly unitPrice: PricingChangeRationalInput;
  readonly effectiveFromAt: string;
  readonly effectiveToAt: string | null;
}

export interface PricingChangeCapture {
  readonly schemaVersion: "sutra.pricing-change.capture.v1";
  readonly scope: FinopsSourceScope;
  readonly partition: PricingChangePartition;
  readonly payerAccountIds: readonly string[];
  readonly linkedAccountIds: readonly string[];
  readonly regions: readonly string[];
  readonly collectionId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly usagePeriodStartAt: string;
  readonly usagePeriodEndAt: string;
  readonly baselineEffectiveAt: string;
  readonly comparisonEffectiveAt: string;
  readonly activeCur2GenerationId: string;
  readonly activeCur2GeneratedAt: string;
  readonly activeCur2ManifestSha256: string;
  readonly cur2Coverage: PricingChangeCur2Coverage;
  readonly catalogCoverage: readonly PricingChangeCatalogCoverage[];
  readonly usage: readonly PricingChangeUsageRecord[];
  readonly catalogSnapshots: readonly PricingChangeCatalogSnapshot[];
  readonly catalogTerms: readonly PricingChangeCatalogTerm[];
}

export interface PricingChangeExactMoney {
  readonly currency: string;
  readonly exactNumerator: string;
  readonly exactDenominator: string;
  /** Half-away-from-zero display rounding only; calculations use the rational. */
  readonly roundedMicros: string;
}

export interface PricingChangeExactQuantity {
  readonly unit: string;
  readonly exactNumerator: string;
  readonly exactDenominator: string;
}

export interface PricingChangeGroup {
  readonly serviceCode: string;
  readonly payerAccountId: string;
  readonly linkedAccountId: string;
  readonly region: string;
  readonly currency: string;
  readonly usageUnit: string;
  readonly termType: PricingTermType;
  readonly usage: PricingChangeExactQuantity;
  readonly baselineModeledCost: PricingChangeExactMoney;
  readonly comparisonModeledCost: PricingChangeExactMoney;
  /** Comparison minus baseline; a negative value is not labeled savings. */
  readonly modeledChange: PricingChangeExactMoney;
  readonly modeledLineCount: number;
  readonly catalogSnapshotIds: readonly string[];
}

export interface PricingChangeExclusionGroup {
  readonly reason: PricingChangeExclusionReason;
  readonly serviceCode: string;
  readonly payerAccountId: string;
  readonly linkedAccountId: string;
  readonly region: string;
  readonly usageUnit: string;
  readonly termType: PricingTermType;
  readonly excludedLineCount: number;
  readonly excludedUsage: PricingChangeExactQuantity;
}

export interface PricingChangeCatalogEvidence {
  readonly snapshotId: string;
  readonly role: PricingCatalogRole;
  readonly serviceCode: string;
  readonly region: string;
  readonly currency: string;
  readonly requestedEffectiveAt: string;
  readonly catalogEffectiveAt: string;
  readonly catalogPublicationAt: string;
  readonly catalogVersion: string;
  readonly priceListArn: string;
  readonly retrievedAt: string;
  readonly listResponseSha256: string;
  readonly priceListFileSha256: string;
}

export interface PricingChangeSnapshot {
  readonly schemaVersion: "sutra.pricing-change.snapshot.v1";
  readonly scope: FinopsSourceScope;
  readonly collectionId: string;
  readonly generatedAt: string;
  readonly state: PricingChangeSnapshotState;
  readonly usagePeriodStartAt: string;
  readonly usagePeriodEndAt: string;
  readonly baselineEffectiveAt: string;
  readonly comparisonEffectiveAt: string;
  readonly activeCur2GenerationId: string;
  readonly activeCur2GeneratedAt: string;
  readonly activeCur2ManifestSha256: string;
  readonly assumptions: typeof PRICING_CHANGE_ASSUMPTIONS;
  readonly catalogEvidence: readonly PricingChangeCatalogEvidence[];
  readonly summary: {
    readonly inputLineCount: number;
    readonly modeledLineCount: number;
    readonly excludedLineCount: number;
    readonly catalogSnapshotCount: number;
    readonly catalogTermCount: number;
    readonly modeledTotalsByCurrency: readonly {
      readonly currency: string;
      readonly baselineModeledCost: PricingChangeExactMoney;
      readonly comparisonModeledCost: PricingChangeExactMoney;
      readonly modeledChange: PricingChangeExactMoney;
    }[];
  };
  readonly groups: readonly PricingChangeGroup[];
  readonly exclusions: readonly PricingChangeExclusionGroup[];
}

export class PricingChangeAnalysisError extends Error {
  readonly code: PricingChangeFailureCode;

  constructor(code: PricingChangeFailureCode) {
    super(code);
    this.name = "PricingChangeAnalysisError";
    this.code = code;
  }
}

interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

interface NormalizedCapture {
  readonly capture: PricingChangeCapture;
  readonly completedAtMs: number;
  readonly evaluatedAtMs: number;
  readonly usage: readonly PricingChangeUsageRecord[];
  readonly snapshots: ReadonlyMap<string, PricingChangeCatalogSnapshot>;
  readonly terms: ReadonlyMap<string, PricingChangeCatalogTerm>;
  readonly catalogCoverage: ReadonlyMap<string, PricingChangeCatalogCoverage>;
}

const PARTITIONS = new Set<PricingChangePartition>([
  "aws", "aws-us-gov", "aws-cn",
]);
const ROLES = new Set<PricingCatalogRole>(["BASELINE", "COMPARISON"]);
const TERM_TYPES = new Set<PricingTermType>([
  "ON_DEMAND", "RESERVED", "SAVINGS_PLAN",
]);
const LINE_ITEM_TYPES = new Set<PricingLineItemType>([
  "USAGE", "DISCOUNTED_USAGE", "SAVINGS_PLAN_COVERED_USAGE",
]);
const SOURCE_STATUSES = new Set<PricingSourceStatus>([
  "SUCCEEDED", "PARTIAL", "FAILED",
]);
const SOURCE_KINDS = new Set<PricingChangeEvidenceReference["kind"]>([
  "CUR2_DATA_EXPORT", "AWS_PRICE_LIST_API", "AWS_PRICE_LIST_FILE",
]);

function reject(code: PricingChangeFailureCode): never {
  throw new PricingChangeAnalysisError(code);
}

function encodedBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return reject("INVALID_INPUT");
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) reject("INVALID_INPUT");
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    reject("INVALID_INPUT");
  }
  return value;
}

function safeText(value: unknown, maximum = 128): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) reject("INVALID_INPUT");
  return value;
}

function identifier(value: unknown): string {
  const result = safeText(value);
  if (!IDENTIFIER.test(result)) reject("INVALID_INPUT");
  return result;
}

function safeCode(value: unknown): string {
  const result = safeText(value, 96);
  if (!SAFE_CODE.test(result)) reject("INVALID_INPUT");
  return result;
}

function safeInteger(value: unknown, minimum: number, maximum: number): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) reject("INVALID_INPUT");
  return value as number;
}

function timestamp(value: unknown, maximumMs: number): string {
  const result = safeText(value, 40);
  const milliseconds = Date.parse(result);
  if (
    !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== result
    || milliseconds > maximumMs
  ) reject("INVALID_INPUT");
  return result;
}

function optionalTimestamp(value: unknown, maximumMs: number): string | null {
  return value === null ? null : timestamp(value, maximumMs);
}

function sortedStrings(
  value: unknown,
  maximum: number,
  validator: (entry: string) => boolean,
): readonly string[] {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > maximum
    || !value.every((entry) => typeof entry === "string" && validator(entry))
  ) reject("INVALID_INPUT");
  const result = [...new Set(value)].sort();
  if (
    result.length !== value.length
    || JSON.stringify(result) !== JSON.stringify(value)
  ) reject("INVALID_INPUT");
  return result;
}

function scope(value: unknown): FinopsSourceScope {
  const record = exactRecord(value, ["orgId", "customerId", "connectionId"]);
  const orgId = identifier(record.orgId);
  const customerId = identifier(record.customerId);
  const connectionId = safeText(record.connectionId, 37);
  if (!CONNECTION_ID.test(connectionId)) reject("INVALID_INPUT");
  return { orgId, customerId, connectionId };
}

function sameScope(left: FinopsSourceScope, right: FinopsSourceScope): boolean {
  return left.orgId === right.orgId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId;
}

function validateBoundary(value: unknown): asserts value is PricingChangeTenantBoundary {
  const record = exactRecord(value, [
    "scope", "partition", "payerAccountIds", "linkedAccountIds", "regions",
  ]);
  scope(record.scope);
  if (typeof record.partition !== "string" || !PARTITIONS.has(record.partition as PricingChangePartition)) {
    reject("INVALID_INPUT");
  }
  sortedStrings(
    record.payerAccountIds,
    PRICING_CHANGE_ANALYSIS_BOUNDS.maximumAccounts,
    (entry) => ACCOUNT_ID.test(entry),
  );
  sortedStrings(
    record.linkedAccountIds,
    PRICING_CHANGE_ANALYSIS_BOUNDS.maximumAccounts,
    (entry) => ACCOUNT_ID.test(entry),
  );
  sortedStrings(
    record.regions,
    PRICING_CHANGE_ANALYSIS_BOUNDS.maximumRegions,
    (entry) => REGION.test(entry),
  );
}

function validEvidenceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.username === ""
      && url.password === ""
      && url.port === ""
      && url.search === ""
      && url.hash === ""
      && (
        url.hostname === "docs.aws.amazon.com"
        || url.hostname.endsWith(".amazonaws.com")
      );
  } catch {
    return false;
  }
}

function evidence(
  value: unknown,
  completedAtMs: number,
): PricingChangeEvidenceReference {
  const record = exactRecord(value, [
    "id", "kind", "operation", "url", "retrievedAt", "effectiveAt", "sha256",
  ]);
  const kind = safeText(record.kind) as PricingChangeEvidenceReference["kind"];
  const operation = safeText(record.operation, 256);
  const url = safeText(record.url, 2_048);
  const retrievedAt = timestamp(record.retrievedAt, completedAtMs);
  const effectiveAt = timestamp(record.effectiveAt, Date.parse(retrievedAt));
  const sha256 = safeText(record.sha256, 64);
  if (!SOURCE_KINDS.has(kind) || !validEvidenceUrl(url) || !SHA256.test(sha256)) {
    reject("INVALID_INPUT");
  }
  if (
    (kind === "CUR2_DATA_EXPORT" && operation !== "AWS_DATA_EXPORTS_CUR2")
    || (kind === "AWS_PRICE_LIST_API" && operation !== "pricing:ListPriceLists")
    || (kind === "AWS_PRICE_LIST_FILE" && operation !== "pricing:GetPriceListFileUrl")
  ) reject("INVALID_INPUT");
  return {
    id: identifier(record.id),
    kind,
    operation,
    url,
    retrievedAt,
    effectiveAt,
    sha256,
  };
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < ZERO ? -left : left;
  let b = right < ZERO ? -right : right;
  while (b !== ZERO) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

function decimalDenominator(value: bigint): boolean {
  let remaining = value;
  let twos = 0;
  let fives = 0;
  while (remaining > ONE && remaining % TWO === ZERO) {
    remaining /= TWO;
    twos += 1;
  }
  while (remaining > ONE && remaining % BigInt(5) === ZERO) {
    remaining /= BigInt(5);
    fives += 1;
  }
  return remaining === ONE
    && Math.max(twos, fives) <= PRICING_CHANGE_ANALYSIS_BOUNDS.maximumDecimalScale;
}

function rational(value: unknown, allowZero = true): Rational {
  const record = exactRecord(value, ["numerator", "denominator"]);
  const numeratorText = safeText(record.numerator, 60);
  const denominatorText = safeText(record.denominator, 60);
  if (
    !UNSIGNED_INTEGER.test(numeratorText)
    || !POSITIVE_INTEGER.test(denominatorText)
  ) reject("INVALID_INPUT");
  const numerator = BigInt(numeratorText);
  const denominator = BigInt(denominatorText);
  if (
    (!allowZero && numerator === ZERO)
    || !decimalDenominator(denominator)
    || gcd(numerator, denominator) !== ONE
  ) reject("INVALID_INPUT");
  return { numerator, denominator };
}

function normalize(value: Rational): Rational {
  if (value.numerator === ZERO) return { numerator: ZERO, denominator: ONE };
  const divisor = gcd(value.numerator, value.denominator);
  const denominator = value.denominator / divisor;
  let numerator = value.numerator / divisor;
  if (denominator < ZERO) numerator = -numerator;
  const result = {
    numerator,
    denominator: denominator < ZERO ? -denominator : denominator,
  };
  if (
    result.numerator.toString().replace("-", "").length > 80
    || result.denominator.toString().length > 40
  ) reject("OUTPUT_LIMIT_EXCEEDED");
  return result;
}

function add(left: Rational, right: Rational): Rational {
  return normalize({
    numerator: left.numerator * right.denominator
      + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  });
}

function subtract(left: Rational, right: Rational): Rational {
  return add(left, { numerator: -right.numerator, denominator: right.denominator });
}

function multiply(left: Rational, right: Rational): Rational {
  return normalize({
    numerator: left.numerator * right.numerator,
    denominator: left.denominator * right.denominator,
  });
}

function compare(left: Rational, right: Rational): number {
  const difference = left.numerator * right.denominator
    - right.numerator * left.denominator;
  return difference < ZERO ? -1 : difference > ZERO ? 1 : 0;
}

function roundedMicros(value: Rational): string {
  const scaled = value.numerator * MICROS;
  const negative = scaled < ZERO;
  const absolute = negative ? -scaled : scaled;
  const quotient = absolute / value.denominator;
  const remainder = absolute % value.denominator;
  const rounded = remainder * TWO >= value.denominator ? quotient + ONE : quotient;
  return (negative ? -rounded : rounded).toString();
}

function quantityOutput(unit: string, value: Rational): PricingChangeExactQuantity {
  const normalized = normalize(value);
  return {
    unit,
    exactNumerator: normalized.numerator.toString(),
    exactDenominator: normalized.denominator.toString(),
  };
}

function moneyOutput(currency: string, value: Rational): PricingChangeExactMoney {
  const normalized = normalize(value);
  return {
    currency,
    exactNumerator: normalized.numerator.toString(),
    exactDenominator: normalized.denominator.toString(),
    roundedMicros: roundedMicros(normalized),
  };
}

function attributes(value: unknown): readonly PricingChangeApplicabilityAttribute[] {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > PRICING_CHANGE_ANALYSIS_BOUNDS.maximumAttributes
  ) reject("INVALID_INPUT");
  const parsed = value.map((entry) => {
    const record = exactRecord(entry, ["name", "value"]);
    return {
      name: safeText(record.name, 128),
      value: safeText(record.value, PRICING_CHANGE_ANALYSIS_BOUNDS.maximumTextLength),
    };
  });
  const sorted = [...parsed].sort((left, right) =>
    left.name.localeCompare(right.name) || left.value.localeCompare(right.value)
  );
  if (
    new Set(parsed.map((entry) => entry.name)).size !== parsed.length
    || JSON.stringify(parsed) !== JSON.stringify(sorted)
  ) reject("INVALID_INPUT");
  return parsed;
}

function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    reject("RECORD_LIMIT_EXCEEDED");
  }
  return value;
}

function addStable<T>(target: Map<string, T>, key: string, value: T): void {
  const existing = target.get(key);
  if (existing === undefined) target.set(key, value);
  else if (JSON.stringify(existing) !== JSON.stringify(value)) {
    reject("CONFLICTING_DUPLICATE");
  }
}

function cur2Coverage(value: unknown): PricingChangeCur2Coverage {
  const record = exactRecord(value, [
    "status", "readPermissionsValidated", "manifestObjectCount",
    "processedObjectCount", "errorCode",
  ]);
  const status = safeText(record.status) as PricingSourceStatus;
  const manifestObjectCount = safeInteger(record.manifestObjectCount, 0, 1_000_000);
  const processedObjectCount = safeInteger(record.processedObjectCount, 0, 1_000_000);
  const errorCode = record.errorCode === null ? null : safeCode(record.errorCode);
  if (
    !SOURCE_STATUSES.has(status)
    || typeof record.readPermissionsValidated !== "boolean"
    || processedObjectCount > manifestObjectCount
    || (status === "SUCCEEDED" && (
      !record.readPermissionsValidated
      || manifestObjectCount === 0
      || manifestObjectCount !== processedObjectCount
      || errorCode !== null
    ))
    || (status !== "SUCCEEDED" && errorCode === null)
  ) reject("INVALID_INPUT");
  return {
    status,
    readPermissionsValidated: record.readPermissionsValidated,
    manifestObjectCount,
    processedObjectCount,
    errorCode,
  };
}

function coverageKey(value: Pick<PricingChangeCatalogCoverage,
  "role" | "serviceCode" | "region" | "currency">): string {
  return [value.role, value.serviceCode, value.region, value.currency].join("|");
}

function catalogCoverage(value: unknown): PricingChangeCatalogCoverage {
  const record = exactRecord(value, [
    "role", "serviceCode", "region", "currency", "status",
    "readPermissionsValidated", "priceListCount", "processedPriceListCount",
    "errorCode",
  ]);
  const role = safeText(record.role) as PricingCatalogRole;
  const serviceCode = safeText(record.serviceCode, 64);
  const region = safeText(record.region);
  const currency = safeText(record.currency, 3);
  const status = safeText(record.status) as PricingSourceStatus;
  const priceListCount = safeInteger(record.priceListCount, 0, 100_000);
  const processedPriceListCount = safeInteger(record.processedPriceListCount, 0, 100_000);
  const errorCode = record.errorCode === null ? null : safeCode(record.errorCode);
  if (
    !ROLES.has(role)
    || !SERVICE_CODE.test(serviceCode)
    || !REGION.test(region)
    || !CURRENCY.test(currency)
    || !SOURCE_STATUSES.has(status)
    || typeof record.readPermissionsValidated !== "boolean"
    || processedPriceListCount > priceListCount
    || (status === "SUCCEEDED" && (
      !record.readPermissionsValidated
      || priceListCount !== processedPriceListCount
      || errorCode !== null
    ))
    || (status !== "SUCCEEDED" && errorCode === null)
  ) reject("INVALID_INPUT");
  return {
    role,
    serviceCode,
    region,
    currency,
    status,
    readPermissionsValidated: record.readPermissionsValidated,
    priceListCount,
    processedPriceListCount,
    errorCode,
  };
}

function usageRecord(
  value: unknown,
  boundary: PricingChangeTenantBoundary,
  capture: Pick<PricingChangeCapture,
    "activeCur2GenerationId" | "activeCur2GeneratedAt" | "usagePeriodStartAt" | "usagePeriodEndAt">,
  completedAtMs: number,
): PricingChangeUsageRecord {
  const record = exactRecord(value, [
    "usageId", "generationId", "payerAccountId", "linkedAccountId",
    "serviceCode", "region", "usageStartAt", "usageEndAt", "lineItemType",
    "termType", "currency", "usageUnit", "usageQuantity", "applicabilityAttributes",
    "baselinePriceId", "comparisonPriceId", "source",
  ]);
  const payerAccountId = safeText(record.payerAccountId, 12);
  const linkedAccountId = safeText(record.linkedAccountId, 12);
  const serviceCode = safeText(record.serviceCode, 64);
  const region = safeText(record.region);
  const usageStartAt = timestamp(record.usageStartAt, completedAtMs);
  const usageEndAt = timestamp(record.usageEndAt, completedAtMs);
  const lineItemType = safeText(record.lineItemType) as PricingLineItemType;
  const termType = safeText(record.termType) as PricingTermType;
  const currency = safeText(record.currency, 3);
  const usageUnit = safeText(record.usageUnit, 64);
  const source = evidence(record.source, completedAtMs);
  if (
    !boundary.payerAccountIds.includes(payerAccountId)
    || !boundary.linkedAccountIds.includes(linkedAccountId)
    || !boundary.regions.includes(region)
  ) reject("SCOPE_MISMATCH");
  if (
    record.generationId !== capture.activeCur2GenerationId
    || !SERVICE_CODE.test(serviceCode)
    || !LINE_ITEM_TYPES.has(lineItemType)
    || !TERM_TYPES.has(termType)
    || !CURRENCY.test(currency)
    || usageUnit.includes("|")
    || source.kind !== "CUR2_DATA_EXPORT"
    || Date.parse(source.retrievedAt) > Date.parse(capture.activeCur2GeneratedAt)
    || Date.parse(usageEndAt) <= Date.parse(usageStartAt)
    || Date.parse(usageStartAt) < Date.parse(capture.usagePeriodStartAt)
    || Date.parse(usageEndAt) > Date.parse(capture.usagePeriodEndAt)
  ) reject("INVALID_INPUT");
  return {
    usageId: identifier(record.usageId),
    generationId: safeText(record.generationId, 68),
    payerAccountId,
    linkedAccountId,
    serviceCode,
    region,
    usageStartAt,
    usageEndAt,
    lineItemType,
    termType,
    currency,
    usageUnit,
    usageQuantity: (() => {
      const parsed = rational(record.usageQuantity, false);
      return {
        numerator: parsed.numerator.toString(),
        denominator: parsed.denominator.toString(),
      };
    })(),
    applicabilityAttributes: attributes(record.applicabilityAttributes),
    baselinePriceId: record.baselinePriceId === null
      ? null
      : identifier(record.baselinePriceId),
    comparisonPriceId: record.comparisonPriceId === null
      ? null
      : identifier(record.comparisonPriceId),
    source,
  };
}

function catalogSnapshot(
  value: unknown,
  boundary: PricingChangeTenantBoundary,
  analysisDates: Readonly<Record<PricingCatalogRole, string>>,
  completedAtMs: number,
): PricingChangeCatalogSnapshot {
  const record = exactRecord(value, [
    "snapshotId", "role", "partition", "serviceCode", "region", "currency",
    "requestedEffectiveAt", "catalogEffectiveAt", "catalogPublicationAt",
    "catalogVersion", "priceListArn", "fileFormat", "listEvidence", "fileEvidence",
  ]);
  const role = safeText(record.role) as PricingCatalogRole;
  const partition = safeText(record.partition) as PricingChangePartition;
  const serviceCode = safeText(record.serviceCode, 64);
  const region = safeText(record.region);
  const currency = safeText(record.currency, 3);
  if (!ROLES.has(role)) reject("INVALID_INPUT");
  const requestedEffectiveAt = timestamp(record.requestedEffectiveAt, completedAtMs);
  const catalogEffectiveAt = timestamp(record.catalogEffectiveAt, Date.parse(requestedEffectiveAt));
  const catalogPublicationAt = timestamp(record.catalogPublicationAt, completedAtMs);
  const priceListArn = safeText(record.priceListArn, 1_024);
  const listEvidence = evidence(record.listEvidence, completedAtMs);
  const fileEvidence = evidence(record.fileEvidence, completedAtMs);
  const arnPartition = PRICE_LIST_ARN.exec(priceListArn)?.[1];
  if (
    partition !== boundary.partition
    || !boundary.regions.includes(region)
    || !SERVICE_CODE.test(serviceCode)
    || !CURRENCY.test(currency)
    || requestedEffectiveAt !== analysisDates[role]
    || arnPartition !== partition
    || record.fileFormat !== "json"
    || listEvidence.kind !== "AWS_PRICE_LIST_API"
    || fileEvidence.kind !== "AWS_PRICE_LIST_FILE"
    || listEvidence.effectiveAt !== requestedEffectiveAt
    || fileEvidence.effectiveAt !== catalogEffectiveAt
    || Date.parse(catalogPublicationAt) > Date.parse(fileEvidence.retrievedAt)
    || !priceListArn.endsWith(
      `/${serviceCode}/${currency}/${safeText(record.catalogVersion, 128)}/${region}`,
    )
  ) reject(partition !== boundary.partition ? "SCOPE_MISMATCH" : "INVALID_INPUT");
  return {
    snapshotId: safeText(record.snapshotId, 68),
    role,
    partition,
    serviceCode,
    region,
    currency,
    requestedEffectiveAt,
    catalogEffectiveAt,
    catalogPublicationAt,
    catalogVersion: safeText(record.catalogVersion, 128),
    priceListArn,
    fileFormat: "json",
    listEvidence,
    fileEvidence,
  };
}

function catalogTerm(
  value: unknown,
  completedAtMs: number,
): PricingChangeCatalogTerm {
  const record = exactRecord(value, [
    "priceId", "snapshotId", "serviceCode", "region", "currency", "productSku",
    "offerTermCode", "rateCode", "termType", "usageUnit",
    "applicabilityAttributes", "beginRange", "endRange", "unitPrice",
    "effectiveFromAt", "effectiveToAt",
  ]);
  const serviceCode = safeText(record.serviceCode, 64);
  const region = safeText(record.region);
  const currency = safeText(record.currency, 3);
  const termType = safeText(record.termType) as PricingTermType;
  const usageUnit = safeText(record.usageUnit, 64);
  const beginRange = rational(record.beginRange);
  const endRange = record.endRange === null ? null : rational(record.endRange, false);
  const unitPrice = rational(record.unitPrice);
  const effectiveFromAt = timestamp(record.effectiveFromAt, completedAtMs);
  const effectiveToAt = optionalTimestamp(record.effectiveToAt, completedAtMs + 366 * DAY_MS);
  if (
    !SERVICE_CODE.test(serviceCode)
    || !REGION.test(region)
    || !CURRENCY.test(currency)
    || !TERM_TYPES.has(termType)
    || usageUnit.includes("|")
    || (endRange !== null && compare(endRange, beginRange) <= 0)
    || (effectiveToAt !== null && Date.parse(effectiveToAt) <= Date.parse(effectiveFromAt))
  ) reject("INVALID_INPUT");
  return {
    priceId: identifier(record.priceId),
    snapshotId: safeText(record.snapshotId, 68),
    serviceCode,
    region,
    currency,
    productSku: safeText(record.productSku, 256),
    offerTermCode: safeText(record.offerTermCode, 256),
    rateCode: safeText(record.rateCode, 256),
    termType,
    usageUnit,
    applicabilityAttributes: attributes(record.applicabilityAttributes),
    beginRange: {
      numerator: beginRange.numerator.toString(),
      denominator: beginRange.denominator.toString(),
    },
    endRange: endRange === null ? null : {
      numerator: endRange.numerator.toString(),
      denominator: endRange.denominator.toString(),
    },
    unitPrice: {
      numerator: unitPrice.numerator.toString(),
      denominator: unitPrice.denominator.toString(),
    },
    effectiveFromAt,
    effectiveToAt,
  };
}

function validateCapture(
  boundary: PricingChangeTenantBoundary,
  value: unknown,
  now: Date,
): NormalizedCapture {
  validateBoundary(boundary);
  if (!Number.isFinite(now.getTime())) reject("INVALID_INPUT");
  const captureBytes = encodedBytes(value);
  if (captureBytes > PRICING_CHANGE_ANALYSIS_BOUNDS.maximumCaptureBytes) {
    reject("BYTE_LIMIT_EXCEEDED");
  }
  const record = exactRecord(value, [
    "schemaVersion", "scope", "partition", "payerAccountIds", "linkedAccountIds",
    "regions", "collectionId", "startedAt", "completedAt", "usagePeriodStartAt",
    "usagePeriodEndAt", "baselineEffectiveAt", "comparisonEffectiveAt",
    "activeCur2GenerationId", "activeCur2GeneratedAt", "activeCur2ManifestSha256", "cur2Coverage",
    "catalogCoverage", "usage", "catalogSnapshots", "catalogTerms",
  ]);
  if (record.schemaVersion !== "sutra.pricing-change.capture.v1") reject("INVALID_INPUT");
  const captureScope = scope(record.scope);
  const partition = safeText(record.partition) as PricingChangePartition;
  const payerAccountIds = sortedStrings(
    record.payerAccountIds,
    PRICING_CHANGE_ANALYSIS_BOUNDS.maximumAccounts,
    (entry) => ACCOUNT_ID.test(entry),
  );
  const linkedAccountIds = sortedStrings(
    record.linkedAccountIds,
    PRICING_CHANGE_ANALYSIS_BOUNDS.maximumAccounts,
    (entry) => ACCOUNT_ID.test(entry),
  );
  const regions = sortedStrings(
    record.regions,
    PRICING_CHANGE_ANALYSIS_BOUNDS.maximumRegions,
    (entry) => REGION.test(entry),
  );
  if (
    !sameScope(captureScope, boundary.scope)
    || partition !== boundary.partition
    || JSON.stringify(payerAccountIds) !== JSON.stringify(boundary.payerAccountIds)
    || JSON.stringify(linkedAccountIds) !== JSON.stringify(boundary.linkedAccountIds)
    || JSON.stringify(regions) !== JSON.stringify(boundary.regions)
  ) reject("SCOPE_MISMATCH");
  const nowMs = now.getTime();
  const completedAt = timestamp(record.completedAt, nowMs + CLOCK_SKEW_MS);
  const completedAtMs = Date.parse(completedAt);
  const startedAt = timestamp(record.startedAt, completedAtMs);
  if (completedAtMs - Date.parse(startedAt) > PRICING_CHANGE_ANALYSIS_BOUNDS.maximumDurationMs) {
    reject("TIME_LIMIT_EXCEEDED");
  }
  const usagePeriodStartAt = timestamp(record.usagePeriodStartAt, completedAtMs);
  const usagePeriodEndAt = timestamp(record.usagePeriodEndAt, completedAtMs);
  const baselineEffectiveAt = timestamp(record.baselineEffectiveAt, completedAtMs);
  const comparisonEffectiveAt = timestamp(record.comparisonEffectiveAt, completedAtMs);
  if (
    Date.parse(usagePeriodEndAt) <= Date.parse(usagePeriodStartAt)
    || completedAtMs - Date.parse(usagePeriodStartAt)
      > PRICING_CHANGE_ANALYSIS_BOUNDS.maximumUsageHistoryDays * DAY_MS
    || Date.parse(comparisonEffectiveAt) <= Date.parse(baselineEffectiveAt)
  ) reject("INVALID_INPUT");
  const collectionId = safeText(record.collectionId, 68);
  const activeCur2GenerationId = safeText(record.activeCur2GenerationId, 68);
  const activeCur2GeneratedAt = timestamp(record.activeCur2GeneratedAt, completedAtMs);
  const activeCur2ManifestSha256 = safeText(record.activeCur2ManifestSha256, 64);
  if (
    !COLLECTION_ID.test(collectionId)
    || !GENERATION_ID.test(activeCur2GenerationId)
    || !SHA256.test(activeCur2ManifestSha256)
    || Date.parse(activeCur2GeneratedAt) < Date.parse(usagePeriodEndAt)
  ) reject("INVALID_INPUT");
  const parsedCur2Coverage = cur2Coverage(record.cur2Coverage);
  const parsedCoverage = new Map<string, PricingChangeCatalogCoverage>();
  for (const entry of array(
    record.catalogCoverage,
    PRICING_CHANGE_ANALYSIS_BOUNDS.maximumCatalogCoverageRecords,
  )) {
    const parsed = catalogCoverage(entry);
    if (!regions.includes(parsed.region)) reject("SCOPE_MISMATCH");
    addStable(parsedCoverage, coverageKey(parsed), parsed);
  }
  const captureBase = {
    activeCur2GenerationId,
    activeCur2GeneratedAt,
    usagePeriodStartAt,
    usagePeriodEndAt,
  };
  const usageMap = new Map<string, PricingChangeUsageRecord>();
  for (const entry of array(
    record.usage,
    PRICING_CHANGE_ANALYSIS_BOUNDS.maximumUsageRecords,
  )) {
    const parsed = usageRecord(entry, boundary, captureBase, completedAtMs);
    addStable(usageMap, parsed.usageId, parsed);
  }
  const analysisDates = {
    BASELINE: baselineEffectiveAt,
    COMPARISON: comparisonEffectiveAt,
  } as const;
  const snapshots = new Map<string, PricingChangeCatalogSnapshot>();
  for (const entry of array(
    record.catalogSnapshots,
    PRICING_CHANGE_ANALYSIS_BOUNDS.maximumCatalogSnapshots,
  )) {
    const parsed = catalogSnapshot(entry, boundary, analysisDates, completedAtMs);
    if (!SNAPSHOT_ID.test(parsed.snapshotId)) reject("INVALID_INPUT");
    addStable(snapshots, parsed.snapshotId, parsed);
  }
  const terms = new Map<string, PricingChangeCatalogTerm>();
  for (const entry of array(
    record.catalogTerms,
    PRICING_CHANGE_ANALYSIS_BOUNDS.maximumCatalogTerms,
  )) {
    const parsed = catalogTerm(entry, completedAtMs);
    const snapshot = snapshots.get(parsed.snapshotId);
    if (snapshot === undefined) reject("INVALID_INPUT");
    if (
      parsed.serviceCode !== snapshot.serviceCode
      || parsed.region !== snapshot.region
      || parsed.currency !== snapshot.currency
    ) reject("INVALID_INPUT");
    addStable(terms, parsed.priceId, parsed);
  }
  const normalizedCapture: PricingChangeCapture = {
    schemaVersion: "sutra.pricing-change.capture.v1",
    scope: captureScope,
    partition,
    payerAccountIds,
    linkedAccountIds,
    regions,
    collectionId,
    startedAt,
    completedAt,
    usagePeriodStartAt,
    usagePeriodEndAt,
    baselineEffectiveAt,
    comparisonEffectiveAt,
    activeCur2GenerationId,
    activeCur2GeneratedAt,
    activeCur2ManifestSha256,
    cur2Coverage: parsedCur2Coverage,
    catalogCoverage: [...parsedCoverage.values()].sort((left, right) =>
      coverageKey(left).localeCompare(coverageKey(right))
    ),
    usage: [...usageMap.values()].sort((left, right) => left.usageId.localeCompare(right.usageId)),
    catalogSnapshots: [...snapshots.values()].sort((left, right) =>
      left.snapshotId.localeCompare(right.snapshotId)
    ),
    catalogTerms: [...terms.values()].sort((left, right) => left.priceId.localeCompare(right.priceId)),
  };
  return {
    capture: normalizedCapture,
    completedAtMs,
    evaluatedAtMs: nowMs,
    usage: normalizedCapture.usage,
    snapshots,
    terms,
    catalogCoverage: parsedCoverage,
  };
}

function attributesEqual(
  left: readonly PricingChangeApplicabilityAttribute[],
  right: readonly PricingChangeApplicabilityAttribute[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function flatRate(term: PricingChangeCatalogTerm): boolean {
  const begin = rational(term.beginRange);
  return begin.numerator === ZERO && term.endRange === null;
}

function priceExclusion(
  usage: PricingChangeUsageRecord,
  term: PricingChangeCatalogTerm,
  snapshot: PricingChangeCatalogSnapshot,
  role: PricingCatalogRole,
  analysisAt: string,
  evaluatedAtMs: number,
): PricingChangeExclusionReason | null {
  const prefix = role === "BASELINE" ? "BASELINE" : "COMPARISON";
  if (snapshot.role !== role) return `MISSING_${prefix}_SNAPSHOT`;
  if (term.serviceCode !== usage.serviceCode) return "PRICE_SERVICE_MISMATCH";
  if (term.region !== usage.region) return "PRICE_REGION_MISMATCH";
  if (term.currency !== usage.currency || snapshot.currency !== usage.currency) {
    return "PRICE_CURRENCY_MISMATCH";
  }
  if (term.usageUnit !== usage.usageUnit) return "PRICE_UNIT_MISMATCH";
  if (term.termType !== usage.termType) return "PRICE_TERM_MISMATCH";
  if (!attributesEqual(term.applicabilityAttributes, usage.applicabilityAttributes)) {
    return "PRICE_PRODUCT_APPLICABILITY_MISMATCH";
  }
  if (
    Date.parse(term.effectiveFromAt) > Date.parse(analysisAt)
    || (term.effectiveToAt !== null && Date.parse(term.effectiveToAt) <= Date.parse(analysisAt))
  ) return "PRICE_NOT_EFFECTIVE_AT_ANALYSIS_DATE";
  if (!flatRate(term)) return "TIERED_RATE_REQUIRES_ALLOCATION_EVIDENCE";
  if (
    evaluatedAtMs - Date.parse(snapshot.fileEvidence.retrievedAt)
      > PRICING_CHANGE_ANALYSIS_BOUNDS.maximumCatalogRetrievalAgeHours * HOUR_MS
  ) return `STALE_${prefix}_CATALOG`;
  return null;
}

interface MutableGroup {
  usage: Rational;
  baseline: Rational;
  comparison: Rational;
  lineCount: number;
  snapshotIds: Set<string>;
}

interface MutableExclusion {
  usage: Rational;
  lineCount: number;
}

function groupKey(usage: PricingChangeUsageRecord, currency: string): string {
  return [
    usage.serviceCode,
    usage.payerAccountId,
    usage.linkedAccountId,
    usage.region,
    currency,
    usage.usageUnit,
    usage.termType,
  ].join("|");
}

function exclusionKey(
  usage: PricingChangeUsageRecord,
  reason: PricingChangeExclusionReason,
): string {
  return [
    reason,
    usage.serviceCode,
    usage.payerAccountId,
    usage.linkedAccountId,
    usage.region,
    usage.usageUnit,
    usage.termType,
  ].join("|");
}

function parseGroupKey(key: string): {
  serviceCode: string;
  payerAccountId: string;
  linkedAccountId: string;
  region: string;
  currency: string;
  usageUnit: string;
  termType: PricingTermType;
} {
  const [serviceCode, payerAccountId, linkedAccountId, region, currency, usageUnit, termType] =
    key.split("|");
  return {
    serviceCode: serviceCode!,
    payerAccountId: payerAccountId!,
    linkedAccountId: linkedAccountId!,
    region: region!,
    currency: currency!,
    usageUnit: usageUnit!,
    termType: termType as PricingTermType,
  };
}

function parseExclusionKey(key: string): {
  reason: PricingChangeExclusionReason;
  serviceCode: string;
  payerAccountId: string;
  linkedAccountId: string;
  region: string;
  usageUnit: string;
  termType: PricingTermType;
} {
  const [reason, serviceCode, payerAccountId, linkedAccountId, region, usageUnit, termType] =
    key.split("|");
  return {
    reason: reason as PricingChangeExclusionReason,
    serviceCode: serviceCode!,
    payerAccountId: payerAccountId!,
    linkedAccountId: linkedAccountId!,
    region: region!,
    usageUnit: usageUnit!,
    termType: termType as PricingTermType,
  };
}

function coverageFor(
  normalized: NormalizedCapture,
  role: PricingCatalogRole,
  usage: PricingChangeUsageRecord,
  currency: string,
): PricingChangeCatalogCoverage | undefined {
  return normalized.catalogCoverage.get(coverageKey({
    role,
    serviceCode: usage.serviceCode,
    region: usage.region,
    currency,
  }));
}

export function buildPricingChangeAnalysis(
  boundary: PricingChangeTenantBoundary,
  input: unknown,
  now = new Date(),
): PricingChangeSnapshot {
  const normalized = validateCapture(boundary, input, now);
  const capture = normalized.capture;
  const groups = new Map<string, MutableGroup>();
  const exclusions = new Map<string, MutableExclusion>();
  let modeledLineCount = 0;
  let staleExclusionCount = 0;
  let configurationExclusionCount = 0;

  const addExclusion = (
    usage: PricingChangeUsageRecord,
    reason: PricingChangeExclusionReason,
  ): void => {
    const key = exclusionKey(usage, reason);
    const quantity = rational(usage.usageQuantity, false);
    const existing = exclusions.get(key) ?? {
      usage: { numerator: ZERO, denominator: ONE },
      lineCount: 0,
    };
    existing.usage = add(existing.usage, quantity);
    existing.lineCount += 1;
    exclusions.set(key, existing);
    if (reason.startsWith("STALE_")) staleExclusionCount += 1;
    else configurationExclusionCount += 1;
  };

  const cur2Stale = normalized.evaluatedAtMs - Date.parse(capture.activeCur2GeneratedAt)
    > PRICING_CHANGE_ANALYSIS_BOUNDS.maximumCur2GenerationAgeHours * HOUR_MS;
  const cur2Incomplete = capture.cur2Coverage.status !== "SUCCEEDED"
    || !capture.cur2Coverage.readPermissionsValidated
    || capture.cur2Coverage.manifestObjectCount !== capture.cur2Coverage.processedObjectCount;

  for (const usage of normalized.usage) {
    if (cur2Stale) {
      addExclusion(usage, "STALE_CUR2_GENERATION");
      continue;
    }
    if (cur2Incomplete) {
      addExclusion(usage, "CUR2_SOURCE_INCOMPLETE");
      continue;
    }
    if (usage.baselinePriceId === null) {
      addExclusion(usage, "MISSING_BASELINE_PRICE");
      continue;
    }
    if (usage.comparisonPriceId === null) {
      addExclusion(usage, "MISSING_COMPARISON_PRICE");
      continue;
    }
    const baseline = normalized.terms.get(usage.baselinePriceId);
    const comparison = normalized.terms.get(usage.comparisonPriceId);
    if (baseline === undefined) {
      addExclusion(usage, "MISSING_BASELINE_PRICE");
      continue;
    }
    if (comparison === undefined) {
      addExclusion(usage, "MISSING_COMPARISON_PRICE");
      continue;
    }
    const baselineSnapshot = normalized.snapshots.get(baseline.snapshotId)!;
    const comparisonSnapshot = normalized.snapshots.get(comparison.snapshotId)!;
    const baselineCoverage = coverageFor(
      normalized,
      "BASELINE",
      usage,
      baseline.currency,
    );
    const comparisonCoverage = coverageFor(
      normalized,
      "COMPARISON",
      usage,
      comparison.currency,
    );
    if (
      baselineCoverage === undefined
      || baselineCoverage.status !== "SUCCEEDED"
      || baselineCoverage.processedPriceListCount < 1
    ) {
      addExclusion(usage, "MISSING_BASELINE_SNAPSHOT");
      continue;
    }
    if (
      comparisonCoverage === undefined
      || comparisonCoverage.status !== "SUCCEEDED"
      || comparisonCoverage.processedPriceListCount < 1
    ) {
      addExclusion(usage, "MISSING_COMPARISON_SNAPSHOT");
      continue;
    }
    const baselineReason = priceExclusion(
      usage,
      baseline,
      baselineSnapshot,
      "BASELINE",
      capture.baselineEffectiveAt,
      normalized.evaluatedAtMs,
    );
    if (baselineReason !== null) {
      addExclusion(usage, baselineReason);
      continue;
    }
    const comparisonReason = priceExclusion(
      usage,
      comparison,
      comparisonSnapshot,
      "COMPARISON",
      capture.comparisonEffectiveAt,
      normalized.evaluatedAtMs,
    );
    if (comparisonReason !== null) {
      addExclusion(usage, comparisonReason);
      continue;
    }
    if (baseline.currency !== comparison.currency) {
      addExclusion(usage, "PRICE_CURRENCY_MISMATCH");
      continue;
    }
    const quantity = rational(usage.usageQuantity, false);
    const baselineCost = multiply(quantity, rational(baseline.unitPrice));
    const comparisonCost = multiply(quantity, rational(comparison.unitPrice));
    const key = groupKey(usage, baseline.currency);
    const existing = groups.get(key) ?? {
      usage: { numerator: ZERO, denominator: ONE },
      baseline: { numerator: ZERO, denominator: ONE },
      comparison: { numerator: ZERO, denominator: ONE },
      lineCount: 0,
      snapshotIds: new Set<string>(),
    };
    existing.usage = add(existing.usage, quantity);
    existing.baseline = add(existing.baseline, baselineCost);
    existing.comparison = add(existing.comparison, comparisonCost);
    existing.lineCount += 1;
    existing.snapshotIds.add(baseline.snapshotId);
    existing.snapshotIds.add(comparison.snapshotId);
    groups.set(key, existing);
    modeledLineCount += 1;
  }

  if (groups.size > PRICING_CHANGE_ANALYSIS_BOUNDS.maximumGroupsInResponse
    || exclusions.size > PRICING_CHANGE_ANALYSIS_BOUNDS.maximumExclusionGroupsInResponse) {
    reject("OUTPUT_LIMIT_EXCEEDED");
  }

  const outputGroups: PricingChangeGroup[] = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      const dimensions = parseGroupKey(key);
      return {
        ...dimensions,
        usage: quantityOutput(dimensions.usageUnit, value.usage),
        baselineModeledCost: moneyOutput(dimensions.currency, value.baseline),
        comparisonModeledCost: moneyOutput(dimensions.currency, value.comparison),
        modeledChange: moneyOutput(
          dimensions.currency,
          subtract(value.comparison, value.baseline),
        ),
        modeledLineCount: value.lineCount,
        catalogSnapshotIds: [...value.snapshotIds].sort(),
      };
    });

  const outputExclusions: PricingChangeExclusionGroup[] = [...exclusions.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      const dimensions = parseExclusionKey(key);
      return {
        ...dimensions,
        excludedLineCount: value.lineCount,
        excludedUsage: quantityOutput(dimensions.usageUnit, value.usage),
      };
    });

  const totals = new Map<string, { baseline: Rational; comparison: Rational }>();
  for (const group of outputGroups) {
    const current = totals.get(group.currency) ?? {
      baseline: { numerator: ZERO, denominator: ONE },
      comparison: { numerator: ZERO, denominator: ONE },
    };
    current.baseline = add(current.baseline, {
      numerator: BigInt(group.baselineModeledCost.exactNumerator),
      denominator: BigInt(group.baselineModeledCost.exactDenominator),
    });
    current.comparison = add(current.comparison, {
      numerator: BigInt(group.comparisonModeledCost.exactNumerator),
      denominator: BigInt(group.comparisonModeledCost.exactDenominator),
    });
    totals.set(group.currency, current);
  }
  const modeledTotalsByCurrency = [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, value]) => ({
      currency,
      baselineModeledCost: moneyOutput(currency, value.baseline),
      comparisonModeledCost: moneyOutput(currency, value.comparison),
      modeledChange: moneyOutput(currency, subtract(value.comparison, value.baseline)),
    }));

  let state: PricingChangeSnapshotState;
  if (capture.usage.length === 0 && !cur2Incomplete && !cur2Stale) state = "NO_USAGE";
  else if (modeledLineCount === capture.usage.length && !cur2Incomplete) state = "READY";
  else if (modeledLineCount > 0) state = "PARTIAL";
  else if (staleExclusionCount > 0 && configurationExclusionCount === 0) state = "STALE";
  else state = "CONFIGURATION_REQUIRED";

  const result: PricingChangeSnapshot = {
    schemaVersion: "sutra.pricing-change.snapshot.v1",
    scope: capture.scope,
    collectionId: capture.collectionId,
    generatedAt: now.toISOString(),
    state,
    usagePeriodStartAt: capture.usagePeriodStartAt,
    usagePeriodEndAt: capture.usagePeriodEndAt,
    baselineEffectiveAt: capture.baselineEffectiveAt,
    comparisonEffectiveAt: capture.comparisonEffectiveAt,
    activeCur2GenerationId: capture.activeCur2GenerationId,
    activeCur2GeneratedAt: capture.activeCur2GeneratedAt,
    activeCur2ManifestSha256: capture.activeCur2ManifestSha256,
    assumptions: PRICING_CHANGE_ASSUMPTIONS,
    catalogEvidence: capture.catalogSnapshots.map((snapshot) => ({
      snapshotId: snapshot.snapshotId,
      role: snapshot.role,
      serviceCode: snapshot.serviceCode,
      region: snapshot.region,
      currency: snapshot.currency,
      requestedEffectiveAt: snapshot.requestedEffectiveAt,
      catalogEffectiveAt: snapshot.catalogEffectiveAt,
      catalogPublicationAt: snapshot.catalogPublicationAt,
      catalogVersion: snapshot.catalogVersion,
      priceListArn: snapshot.priceListArn,
      retrievedAt: snapshot.fileEvidence.retrievedAt,
      listResponseSha256: snapshot.listEvidence.sha256,
      priceListFileSha256: snapshot.fileEvidence.sha256,
    })),
    summary: {
      inputLineCount: capture.usage.length,
      modeledLineCount,
      excludedLineCount: capture.usage.length - modeledLineCount,
      catalogSnapshotCount: capture.catalogSnapshots.length,
      catalogTermCount: capture.catalogTerms.length,
      modeledTotalsByCurrency,
    },
    groups: outputGroups,
    exclusions: outputExclusions,
  };
  if (encodedBytes(result)
    > PRICING_CHANGE_ANALYSIS_BOUNDS.maximumResponseBytes) {
    reject("OUTPUT_LIMIT_EXCEEDED");
  }
  return result;
}
