/**
 * Enterprise AWS CUR 2.0 trends intelligence over immutable active generations.
 *
 * This pure module performs no I/O, persistence, forecasting, or currency
 * conversion. A caller supplies one persistence-verified active generation for
 * each available billing month. The engine re-checks every tenant/generation
 * boundary and keeps all arithmetic in signed BigInt micro-units or reduced
 * rational numbers.
 *
 * The older `finops-trends.ts` module intentionally remains unchanged for its
 * existing callers. In particular, its Number-based regression is never used
 * here and no projected value is presented as evidence.
 */
import {
  FINOPS_COST_BASES,
  type FinopsCostBasis,
} from "./finops-billing-projections.ts";
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
const INTEGER_MICROS = /^-?(?:0|[1-9]\d{0,127})$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,95}$/u;
const MAX_STALE_AFTER_SECONDS = 31 * 24 * 60 * 60;
const DEFAULT_STALE_AFTER_SECONDS = 36 * 60 * 60;
const DEFAULT_ROLLING_WINDOW_MONTHS = 3;
const DEFAULT_CONTRIBUTOR_LIMIT = 10;
const ZERO = BigInt(0);
const ONE = BigInt(1);
const HUNDRED = BigInt(100);

export const FINOPS_TRENDS_INTELLIGENCE_BOUNDS = Object.freeze({
  maximumPeriods: 120,
  maximumRowsPerPeriod: 250_000,
  maximumTotalRows: 500_000,
  maximumSeries: 1_200,
  maximumDimensionValues: 50_000,
  maximumContributorLimit: 50,
  maximumRollingWindowMonths: 12,
  maximumLineageLineItemIds: 50,
  maximumTextLength: 1_024,
} as const);

/** Pinned, reviewable alert policy; callers cannot silently tune it. */
export const FINOPS_TRENDS_SIGNAL_POLICY = Object.freeze({
  momAbsolutePercentThreshold: 20,
  trailingBaselineMonths: 3,
  trailingAbsolutePercentThreshold: 30,
  formulas: Object.freeze({
    momAbsolutePercentChange:
      "abs(currentMicros-priorMicros)*100 >= abs(priorMicros)*20",
    trailingBaselineDeviation:
      "abs(currentMicros*3-sum(previous3Micros))*100 >= sum(previous3Micros)*30",
  }),
} as const);

/** Trends reuses the already-authorized active CUR2 source. */
export const FINOPS_TRENDS_ADDITIONAL_READ_OPERATIONS = Object.freeze([] as const);

export const FINOPS_TRENDS_LIMITATIONS = Object.freeze([
  "ACTIVE_RECONCILED_IMMUTABLE_AWS_CUR2_GENERATIONS_ONLY",
  "CURRENCIES_AND_COST_BASES_ARE_NEVER_MERGED_OR_CONVERTED",
  "PARTIAL_OR_MISSING_PERIODS_ARE_NOT_INTERPOLATED",
  "SIGNALS_USE_PINNED_EXPLAINABLE_THRESHOLDS_NOT_MACHINE_LEARNING",
  "NO_FORECAST_QUOTE_INVOICE_OR_SAVINGS_CLAIM_IS_PRODUCED",
] as const);

export type FinopsTrendsSourceState =
  | "READY"
  | "CONFIGURATION_REQUIRED"
  | "ERROR";

export type FinopsTrendsLoadKind =
  | "ORIGINAL"
  | "CORRECTION"
  | "BACKFILL"
  | "UNCLASSIFIED";
export type FinopsTrendsCollectionState = "COMPLETE" | "PARTIAL";

export type FinopsTrendsPeriodState =
  | "COMPLETE"
  | "MISSING"
  | "CURRENT_PARTIAL"
  | "CORRECTION"
  | "BACKFILL"
  | "PARTIAL"
  | "STALE"
  | "EMPTY"
  | "ERROR"
  | "CONFIGURATION_REQUIRED";

export type FinopsTrendsSnapshotState =
  | "READY"
  | "PARTIAL"
  | "STALE"
  | "EMPTY"
  | "ERROR"
  | "CONFIGURATION_REQUIRED";

export type FinopsTrendsDimension =
  | "account"
  | "service"
  | "region"
  | "charge_category";

export interface FinopsTrendsTenantScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly exportName: string;
}

export interface FinopsTrendsSourceInput {
  readonly state: FinopsTrendsSourceState;
  readonly evaluatedAtIso: string;
  readonly errorCode: string | null;
  readonly staleAfterSeconds?: number;
}

export interface FinopsTrendsPeriodEvidenceInput {
  readonly sourceEvidenceId: string;
  readonly manifestSha256: string;
  readonly sourceUpdatedAtIso: string | null;
  readonly observedAtIso: string;
  readonly committedAtIso: string;
  readonly activatedAtIso: string;
  readonly active: true;
  readonly immutable: true;
  readonly reconciliationState: "RECONCILED";
  readonly collectionState: FinopsTrendsCollectionState;
  readonly rowsExhausted: boolean;
  readonly reconciledRowCount: number;
  readonly rejectedRowCount: number;
  readonly availableCostBases: readonly FinopsCostBasis[];
  readonly loadKind: FinopsTrendsLoadKind;
  readonly supersededGenerationId: string | null;
}

export interface FinopsTrendsActivePeriodInput {
  readonly scope: FinopsReconciliationScope;
  readonly evidence: FinopsTrendsPeriodEvidenceInput;
  readonly rows: readonly ScopedCanonicalBillingRow[];
}

export interface FinopsTrendsIntelligenceInput {
  readonly tenant: FinopsTrendsTenantScope;
  readonly window: {
    readonly fromPeriod: string;
    readonly toPeriod: string;
  };
  readonly expectedCurrencies: readonly string[];
  readonly source: FinopsTrendsSourceInput;
  readonly periods: readonly FinopsTrendsActivePeriodInput[];
  readonly options?: {
    readonly costBases?: readonly FinopsCostBasis[];
    readonly rollingWindowMonths?: number;
    readonly contributorLimit?: number;
  };
}

export interface FinopsTrendsExactRational {
  readonly numerator: string;
  readonly denominator: string;
}

export interface FinopsTrendsUnavailable {
  readonly available: false;
  readonly reason:
    | "NO_PRIOR_PERIOD"
    | "MISSING_PERIOD"
    | "INCOMPLETE_PERIOD"
    | "INCOMPLETE_COST_BASIS"
    | "INSUFFICIENT_CONTIGUOUS_HISTORY";
}

export interface FinopsTrendsExactChange {
  readonly available: true;
  readonly baselineMicros: string;
  readonly currentMicros: string;
  readonly deltaMicros: string;
  readonly percent: FinopsTrendsExactRational | null;
  readonly percentUnavailableReason: "BASELINE_ZERO" | null;
}

export type FinopsTrendsComparison =
  | FinopsTrendsUnavailable
  | FinopsTrendsExactChange;

export interface FinopsTrendsRollingComparisonAvailable {
  readonly available: true;
  readonly windowMonths: number;
  readonly currentWindowStartPeriod: string;
  readonly currentWindowEndPeriod: string;
  readonly priorWindowStartPeriod: string;
  readonly priorWindowEndPeriod: string;
  readonly currentWindowTotalMicros: string;
  readonly priorWindowTotalMicros: string;
  readonly deltaMicros: string;
  readonly percent: FinopsTrendsExactRational | null;
  readonly percentUnavailableReason: "BASELINE_ZERO" | null;
}

export type FinopsTrendsRollingComparison =
  | FinopsTrendsUnavailable
  | FinopsTrendsRollingComparisonAvailable;

export interface FinopsTrendsTrailingAverageAvailable {
  readonly available: true;
  readonly windowMonths: number;
  readonly exactAverageMicros: FinopsTrendsExactRational;
}

export type FinopsTrendsTrailingAverage =
  | FinopsTrendsUnavailable
  | FinopsTrendsTrailingAverageAvailable;

export interface FinopsTrendsContributor {
  readonly value: string | null;
  readonly currentMicros: string;
  readonly priorMicros: string;
  readonly deltaMicros: string;
  readonly absoluteMovementShare: FinopsTrendsExactRational;
}

export interface FinopsTrendsContributorGroup {
  readonly dimension: FinopsTrendsDimension;
  readonly available: boolean;
  readonly unavailableReason: FinopsTrendsUnavailable["reason"] | null;
  readonly contributors: readonly FinopsTrendsContributor[];
  readonly totalDimensionValues: number;
  readonly truncated: boolean;
}

export interface FinopsTrendsSignal {
  readonly code: "MOM_ABSOLUTE_PERCENT_CHANGE" | "TRAILING_BASELINE_DEVIATION";
  readonly severity: "INFORMATIONAL";
  readonly formula: string;
  readonly thresholdPercent: number;
  readonly observedPercent: FinopsTrendsExactRational;
  readonly baseline: "PRIOR_MONTH" | "PREVIOUS_3_MONTH_AVERAGE";
  readonly explanation: string;
}

export interface FinopsTrendsPeriodLineage {
  readonly sourceEvidenceId: string;
  readonly manifestSha256: string;
  readonly generationId: string;
  readonly sourceUpdatedAtIso: string | null;
  readonly observedAtIso: string;
  readonly committedAtIso: string;
  readonly activatedAtIso: string;
  readonly sourceRowCount: number;
  readonly sourceLineItemIdCount: number;
  readonly sourceLineItemIds: readonly string[];
  readonly sourceLineItemIdsTruncated: boolean;
}

export interface FinopsTrendsPeriodSummary {
  readonly period: string;
  readonly state: FinopsTrendsPeriodState;
  readonly stateReasons: readonly FinopsTrendsPeriodState[];
  readonly loadKind: FinopsTrendsLoadKind | null;
  readonly generationId: string | null;
  readonly collectionState: FinopsTrendsCollectionState | null;
  readonly rowCount: number | null;
  readonly rejectedRowCount: number | null;
  readonly ageSeconds: number | null;
  readonly staleAfterSeconds: number;
  readonly lineage: FinopsTrendsPeriodLineage | null;
}

export interface FinopsTrendsSeriesPoint {
  readonly period: string;
  readonly periodState: FinopsTrendsPeriodState;
  readonly totalMicros: string | null;
  readonly contributingRowCount: number;
  readonly missingCostRowCount: number;
  readonly costCoverage: "complete" | "partial" | "unavailable";
  readonly monthOverMonth: FinopsTrendsComparison;
  readonly trailingAverage: FinopsTrendsTrailingAverage;
  readonly rollingComparison: FinopsTrendsRollingComparison;
  readonly contributors: readonly FinopsTrendsContributorGroup[];
  readonly signals: readonly FinopsTrendsSignal[];
}

export interface FinopsTrendsSeries {
  readonly currency: string;
  readonly costBasis: FinopsCostBasis;
  readonly points: readonly FinopsTrendsSeriesPoint[];
}

export interface FinopsTrendsIntelligenceSnapshot {
  readonly ok: true;
  readonly schema: "sutra.finops-trends-intelligence.v1";
  readonly state: FinopsTrendsSnapshotState;
  readonly tenant: FinopsTrendsTenantScope;
  readonly window: {
    readonly fromPeriod: string;
    readonly toPeriod: string;
    readonly periodCount: number;
  };
  readonly evaluatedAtIso: string;
  readonly expectedCurrencies: readonly string[];
  readonly selectedCostBases: readonly FinopsCostBasis[];
  readonly rollingWindowMonths: number;
  readonly contributorLimit: number;
  readonly periods: readonly FinopsTrendsPeriodSummary[];
  readonly series: readonly FinopsTrendsSeries[];
  readonly summary: {
    readonly activeGenerationCount: number;
    readonly sourceRowCount: number;
    readonly completePeriodCount: number;
    readonly missingPeriodCount: number;
    readonly currentPartialPeriodCount: number;
    readonly correctionPeriodCount: number;
    readonly backfillPeriodCount: number;
    readonly stalePeriodCount: number;
    readonly partialPeriodCount: number;
    readonly emptyPeriodCount: number;
    readonly signalCount: number;
  };
  readonly forecast: {
    readonly available: false;
    readonly reason: "NOT_PRODUCED_EVIDENCE_HONEST_TRENDS_ONLY";
  };
  readonly signalPolicy: typeof FINOPS_TRENDS_SIGNAL_POLICY;
  readonly additionalReadOperations: typeof FINOPS_TRENDS_ADDITIONAL_READ_OPERATIONS;
  readonly limitations: typeof FINOPS_TRENDS_LIMITATIONS;
}

export type FinopsTrendsFailureCode =
  | "INVALID_INPUT"
  | "INVALID_TENANT_SCOPE"
  | "INVALID_WINDOW"
  | "PERIOD_LIMIT_EXCEEDED"
  | "INVALID_SOURCE_STATE"
  | "INVALID_OPTIONS"
  | "INVALID_PERIOD_EVIDENCE"
  | "DUPLICATE_PERIOD"
  | "DUPLICATE_GENERATION"
  | "PERIOD_OUTSIDE_WINDOW"
  | "ROW_LIMIT_EXCEEDED"
  | "ROW_SCOPE_MISMATCH"
  | "INVALID_CUR2_ROW"
  | "CURRENCY_OUTSIDE_SCOPE"
  | "COST_BASIS_EVIDENCE_MISMATCH"
  | "DUPLICATE_LINE_ITEM"
  | "SERIES_LIMIT_EXCEEDED"
  | "DIMENSION_LIMIT_EXCEEDED";

export interface FinopsTrendsFailure {
  readonly code: FinopsTrendsFailureCode;
  readonly field: string;
  readonly period?: string;
  readonly rowIndex?: number;
}

export interface FinopsTrendsIntelligenceFailure {
  readonly ok: false;
  readonly schema: "sutra.finops-trends-intelligence.v1";
  readonly state: "ERROR";
  readonly failures: readonly FinopsTrendsFailure[];
}

export type FinopsTrendsIntelligenceResult =
  | FinopsTrendsIntelligenceSnapshot
  | FinopsTrendsIntelligenceFailure;

interface NormalizedOptions {
  readonly costBases: readonly FinopsCostBasis[];
  readonly rollingWindowMonths: number;
  readonly contributorLimit: number;
}

interface PeriodRuntime {
  readonly period: string;
  readonly input: FinopsTrendsActivePeriodInput | null;
  readonly state: FinopsTrendsPeriodState;
  readonly stateReasons: readonly FinopsTrendsPeriodState[];
  readonly ageSeconds: number | null;
}

interface PointAggregate {
  readonly total: bigint | null;
  readonly contributingRowCount: number;
  readonly missingCostRowCount: number;
  readonly coverage: "complete" | "partial" | "unavailable";
}

function fail(
  code: FinopsTrendsFailureCode,
  field: string,
  details: { readonly period?: string; readonly rowIndex?: number } = {},
): FinopsTrendsIntelligenceFailure {
  return {
    ok: false,
    schema: "sutra.finops-trends-intelligence.v1",
    state: "ERROR",
    failures: [{ code, field, ...details }],
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validText(
  value: unknown,
  maximum: number = FINOPS_TRENDS_INTELLIGENCE_BOUNDS.maximumTextLength,
): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !value.includes("\0");
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function abs(value: bigint): bigint {
  return value < ZERO ? -value : value;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = abs(left);
  let b = abs(right);
  while (b !== ZERO) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a === ZERO ? ONE : a;
}

function rational(numerator: bigint, denominator: bigint): FinopsTrendsExactRational {
  const normalizedDenominator = denominator < ZERO ? -denominator : denominator;
  const normalizedNumerator = denominator < ZERO ? -numerator : numerator;
  const divisor = gcd(normalizedNumerator, normalizedDenominator);
  return {
    numerator: (normalizedNumerator / divisor).toString(),
    denominator: (normalizedDenominator / divisor).toString(),
  };
}

function periodIndex(period: string): number {
  const [yearText, monthText] = period.split("-");
  return Number(yearText) * 12 + Number(monthText) - 1;
}

function periodFromIndex(index: number): string {
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

function periodRange(fromPeriod: string, toPeriod: string): readonly string[] | null {
  if (!PERIOD.test(fromPeriod) || !PERIOD.test(toPeriod)) return null;
  const from = periodIndex(fromPeriod);
  const to = periodIndex(toPeriod);
  if (from > to) return null;
  const count = to - from + 1;
  if (count > FINOPS_TRENDS_INTELLIGENCE_BOUNDS.maximumPeriods) return [];
  return Array.from({ length: count }, (_, index) => periodFromIndex(from + index));
}

function validTenant(value: unknown): value is FinopsTrendsTenantScope {
  if (!isRecord(value)) return false;
  return typeof value.organizationId === "string" && IDENTIFIER.test(value.organizationId)
    && typeof value.customerId === "string" && IDENTIFIER.test(value.customerId)
    && typeof value.connectionId === "string" && IDENTIFIER.test(value.connectionId)
    && validText(value.exportName, 256);
}

function tenantMatchesScope(
  tenant: FinopsTrendsTenantScope,
  scope: FinopsReconciliationScope,
): boolean {
  return tenant.organizationId === scope.organizationId
    && tenant.customerId === scope.customerId
    && tenant.connectionId === scope.connectionId
    && tenant.exportName === scope.exportName;
}

function scopeMatches(
  left: FinopsReconciliationScope,
  right: FinopsReconciliationScope,
): boolean {
  return left.organizationId === right.organizationId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId
    && left.exportName === right.exportName
    && left.billingPeriod === right.billingPeriod
    && left.generationId === right.generationId;
}

function validScope(value: unknown): value is FinopsReconciliationScope {
  if (!isRecord(value)) return false;
  return validTenant(value)
    && typeof value.billingPeriod === "string" && PERIOD.test(value.billingPeriod)
    && typeof value.generationId === "string" && GENERATION_ID.test(value.generationId);
}

function normalizeCurrencies(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return null;
  const currencies = new Set<string>();
  for (const entry of value) {
    if (
      typeof entry !== "string"
      || !FINOPS_RECONCILIATION_CURRENCIES.has(
        entry as (typeof FINOPS_RECONCILIATION_CURRENCIES extends Set<infer T> ? T : never),
      )
    ) return null;
    currencies.add(entry);
  }
  return [...currencies].sort(compareText);
}

function normalizeOptions(value: unknown): NormalizedOptions | null {
  if (value !== undefined && !isRecord(value)) return null;
  const options = value as Readonly<Record<string, unknown>> | undefined;
  if (options !== undefined && Object.keys(options).some((key) =>
    !["costBases", "rollingWindowMonths", "contributorLimit"].includes(key))) return null;
  const requestedBases = options?.costBases ?? ["unblended"];
  if (!Array.isArray(requestedBases) || requestedBases.length === 0) return null;
  const bases = new Set<FinopsCostBasis>();
  for (const basis of requestedBases) {
    if (
      typeof basis !== "string"
      || !FINOPS_COST_BASES.includes(basis as FinopsCostBasis)
    ) return null;
    bases.add(basis as FinopsCostBasis);
  }
  const rollingWindowMonths = options?.rollingWindowMonths
    ?? DEFAULT_ROLLING_WINDOW_MONTHS;
  const contributorLimit = options?.contributorLimit
    ?? DEFAULT_CONTRIBUTOR_LIMIT;
  if (
    typeof rollingWindowMonths !== "number"
    || !Number.isSafeInteger(rollingWindowMonths)
    || rollingWindowMonths < 1
    || rollingWindowMonths > FINOPS_TRENDS_INTELLIGENCE_BOUNDS.maximumRollingWindowMonths
    || typeof contributorLimit !== "number"
    || !Number.isSafeInteger(contributorLimit)
    || contributorLimit < 1
    || contributorLimit > FINOPS_TRENDS_INTELLIGENCE_BOUNDS.maximumContributorLimit
  ) return null;
  return {
    costBases: [...bases].sort((left, right) =>
      FINOPS_COST_BASES.indexOf(left) - FINOPS_COST_BASES.indexOf(right)),
    rollingWindowMonths,
    contributorLimit,
  };
}

function validSource(value: unknown): value is FinopsTrendsSourceInput {
  if (!isRecord(value) || !validIso(value.evaluatedAtIso)) return false;
  if (
    typeof value.state !== "string"
    || !new Set(["READY", "CONFIGURATION_REQUIRED", "ERROR"]).has(value.state)
  ) return false;
  if (value.state === "ERROR") {
    if (typeof value.errorCode !== "string" || !ERROR_CODE.test(value.errorCode)) return false;
  } else if (value.errorCode !== null) return false;
  return value.staleAfterSeconds === undefined
    || (
      safeNonNegativeInteger(value.staleAfterSeconds)
      && value.staleAfterSeconds > 0
      && value.staleAfterSeconds <= MAX_STALE_AFTER_SECONDS
    );
}

function normalizeCostBases(value: unknown): readonly FinopsCostBasis[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const bases = new Set<FinopsCostBasis>();
  for (const basis of value) {
    if (typeof basis !== "string" || !FINOPS_COST_BASES.includes(basis as FinopsCostBasis)) return null;
    bases.add(basis as FinopsCostBasis);
  }
  if (!bases.has("unblended")) return null;
  return [...bases].sort((left, right) =>
    FINOPS_COST_BASES.indexOf(left) - FINOPS_COST_BASES.indexOf(right));
}

function validEvidence(value: unknown, rowCount: number): value is FinopsTrendsPeriodEvidenceInput {
  if (!isRecord(value)) return false;
  const bases = normalizeCostBases(value.availableCostBases);
  if (
    !validText(value.sourceEvidenceId)
    || typeof value.manifestSha256 !== "string" || !SHA256.test(value.manifestSha256)
    || (value.sourceUpdatedAtIso !== null && !validIso(value.sourceUpdatedAtIso))
    || !validIso(value.observedAtIso)
    || !validIso(value.committedAtIso)
    || !validIso(value.activatedAtIso)
    || value.active !== true
    || value.immutable !== true
    || value.reconciliationState !== "RECONCILED"
    || typeof value.collectionState !== "string"
    || !new Set(["COMPLETE", "PARTIAL"]).has(value.collectionState)
    || typeof value.rowsExhausted !== "boolean"
    || !safeNonNegativeInteger(value.reconciledRowCount)
    || value.reconciledRowCount !== rowCount
    || !safeNonNegativeInteger(value.rejectedRowCount)
    || bases === null
    || typeof value.loadKind !== "string"
    || !new Set(["ORIGINAL", "CORRECTION", "BACKFILL", "UNCLASSIFIED"]).has(value.loadKind)
  ) return false;
  if (value.loadKind === "CORRECTION") {
    return typeof value.supersededGenerationId === "string"
      && GENERATION_ID.test(value.supersededGenerationId);
  }
  return value.supersededGenerationId === null;
}

function costValue(line: CanonicalCurLine, basis: FinopsCostBasis): string | null {
  switch (basis) {
    case "unblended": return line.amountMicros;
    case "net": return line.netUnblendedCostMicros;
    case "amortized": return line.amortizedMicros;
    case "list": return line.listCostMicros;
    case "contracted": return line.contractedCostMicros;
    case "public": return line.publicOnDemandCostMicros;
  }
}

function validCur2Row(line: unknown): line is CanonicalCurLine {
  if (!isRecord(line)) return false;
  return validText(line.lineItemId, 4_096)
    && validText(line.usageAccountId, 256)
    && validText(line.service)
    && validText(line.chargeCategory, 512)
    && validIso(line.usageStartIso)
    && line.sourceFormat === "aws-cur"
    && line.sourceVersion === "2.0"
    && typeof line.currency === "string"
    && FINOPS_RECONCILIATION_CURRENCIES.has(
      line.currency as (typeof FINOPS_RECONCILIATION_CURRENCIES extends Set<infer T> ? T : never),
    )
    && FINOPS_COST_BASES.every((basis) => {
      const amount = costValue(line as unknown as CanonicalCurLine, basis);
      return amount === null || INTEGER_MICROS.test(amount);
    });
}

function stateReasonsFor(
  period: string,
  input: FinopsTrendsActivePeriodInput | null,
  source: FinopsTrendsSourceInput,
): { readonly reasons: readonly FinopsTrendsPeriodState[]; readonly ageSeconds: number | null } {
  if (source.state === "CONFIGURATION_REQUIRED") {
    return { reasons: ["CONFIGURATION_REQUIRED"], ageSeconds: null };
  }
  if (source.state === "ERROR") return { reasons: ["ERROR"], ageSeconds: null };
  if (input === null) return { reasons: ["MISSING"], ageSeconds: null };
  const reasons: FinopsTrendsPeriodState[] = [];
  const currentPeriod = source.evaluatedAtIso.slice(0, 7);
  if (period === currentPeriod) reasons.push("CURRENT_PARTIAL");
  if (input.evidence.collectionState === "PARTIAL" || !input.evidence.rowsExhausted) reasons.push("PARTIAL");
  let ageSeconds: number | null = null;
  if (input.evidence.sourceUpdatedAtIso === null) {
    reasons.push("PARTIAL");
  } else {
    ageSeconds = Math.floor(
      (Date.parse(source.evaluatedAtIso) - Date.parse(input.evidence.sourceUpdatedAtIso)) / 1_000,
    );
    const staleAfter = source.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS;
    if (ageSeconds > staleAfter) reasons.push("STALE");
    if (ageSeconds < -300) reasons.push("PARTIAL");
  }
  if (input.evidence.loadKind === "CORRECTION") reasons.push("CORRECTION");
  if (input.evidence.loadKind === "BACKFILL") reasons.push("BACKFILL");
  if (input.rows.length === 0) reasons.push("EMPTY");
  if (reasons.length === 0) reasons.push("COMPLETE");
  return { reasons: [...new Set(reasons)], ageSeconds };
}

function primaryPeriodState(reasons: readonly FinopsTrendsPeriodState[]): FinopsTrendsPeriodState {
  const precedence: readonly FinopsTrendsPeriodState[] = [
    "ERROR",
    "CONFIGURATION_REQUIRED",
    "MISSING",
    "CURRENT_PARTIAL",
    "PARTIAL",
    "STALE",
    "CORRECTION",
    "BACKFILL",
    "EMPTY",
    "COMPLETE",
  ];
  return precedence.find((candidate) => reasons.includes(candidate)) ?? "COMPLETE";
}

function completeForComparison(runtime: PeriodRuntime): boolean {
  return runtime.input !== null
    && !runtime.stateReasons.some((state) =>
      ["MISSING", "CURRENT_PARTIAL", "PARTIAL", "ERROR", "CONFIGURATION_REQUIRED"].includes(state));
}

function aggregateFor(
  runtime: PeriodRuntime,
  currency: string,
  basis: FinopsCostBasis,
): PointAggregate {
  if (runtime.input === null) {
    return { total: null, contributingRowCount: 0, missingCostRowCount: 0, coverage: "unavailable" };
  }
  const currencyRows = runtime.input.rows.filter(({ line }) => line.currency === currency);
  const basisDeclared = runtime.input.evidence.availableCostBases.includes(basis);
  let total = ZERO;
  let contributing = 0;
  for (const { line } of currencyRows) {
    const value = costValue(line, basis);
    if (value === null) continue;
    total += BigInt(value);
    contributing += 1;
  }
  if (currencyRows.length === 0) {
    return basisDeclared
      ? { total: ZERO, contributingRowCount: 0, missingCostRowCount: 0, coverage: "complete" }
      : { total: null, contributingRowCount: 0, missingCostRowCount: 0, coverage: "unavailable" };
  }
  if (contributing === 0) {
    return {
      total: null,
      contributingRowCount: 0,
      missingCostRowCount: currencyRows.length,
      coverage: "unavailable",
    };
  }
  return {
    total,
    contributingRowCount: contributing,
    missingCostRowCount: currencyRows.length - contributing,
    coverage: contributing === currencyRows.length && basisDeclared ? "complete" : "partial",
  };
}

function comparisonUnavailable(
  reason: FinopsTrendsUnavailable["reason"],
): FinopsTrendsUnavailable {
  return { available: false, reason };
}

function comparableReason(runtime: PeriodRuntime, aggregate: PointAggregate): FinopsTrendsUnavailable["reason"] | null {
  if (runtime.input === null || runtime.stateReasons.includes("MISSING")) return "MISSING_PERIOD";
  if (!completeForComparison(runtime)) return "INCOMPLETE_PERIOD";
  if (aggregate.coverage !== "complete" || aggregate.total === null) return "INCOMPLETE_COST_BASIS";
  return null;
}

function exactChange(baseline: bigint, current: bigint): FinopsTrendsExactChange {
  const delta = current - baseline;
  return {
    available: true,
    baselineMicros: baseline.toString(),
    currentMicros: current.toString(),
    deltaMicros: delta.toString(),
    percent: baseline === ZERO ? null : rational(delta * HUNDRED, baseline),
    percentUnavailableReason: baseline === ZERO ? "BASELINE_ZERO" : null,
  };
}

function monthOverMonth(
  runtimes: readonly PeriodRuntime[],
  aggregates: readonly PointAggregate[],
  index: number,
): FinopsTrendsComparison {
  if (index === 0) return comparisonUnavailable("NO_PRIOR_PERIOD");
  const currentReason = comparableReason(runtimes[index], aggregates[index]);
  const priorReason = comparableReason(runtimes[index - 1], aggregates[index - 1]);
  if (currentReason !== null) return comparisonUnavailable(currentReason);
  if (priorReason !== null) return comparisonUnavailable(priorReason);
  return exactChange(aggregates[index - 1].total ?? ZERO, aggregates[index].total ?? ZERO);
}

function unavailableForWindow(
  runtimes: readonly PeriodRuntime[],
  aggregates: readonly PointAggregate[],
  start: number,
  end: number,
): FinopsTrendsUnavailable["reason"] | null {
  for (let index = start; index <= end; index += 1) {
    const reason = comparableReason(runtimes[index], aggregates[index]);
    if (reason !== null) return reason;
  }
  return null;
}

function sumTotals(aggregates: readonly PointAggregate[], start: number, end: number): bigint {
  let total = ZERO;
  for (let index = start; index <= end; index += 1) total += aggregates[index].total ?? ZERO;
  return total;
}

function trailingAverage(
  runtimes: readonly PeriodRuntime[],
  aggregates: readonly PointAggregate[],
  index: number,
  windowMonths: number,
): FinopsTrendsTrailingAverage {
  const start = index - windowMonths + 1;
  if (start < 0) return comparisonUnavailable("INSUFFICIENT_CONTIGUOUS_HISTORY");
  const reason = unavailableForWindow(runtimes, aggregates, start, index);
  if (reason !== null) return comparisonUnavailable(reason);
  return {
    available: true,
    windowMonths,
    exactAverageMicros: rational(sumTotals(aggregates, start, index), BigInt(windowMonths)),
  };
}

function rollingComparison(
  runtimes: readonly PeriodRuntime[],
  aggregates: readonly PointAggregate[],
  index: number,
  windowMonths: number,
): FinopsTrendsRollingComparison {
  const currentStart = index - windowMonths + 1;
  const priorStart = currentStart - windowMonths;
  if (priorStart < 0) return comparisonUnavailable("INSUFFICIENT_CONTIGUOUS_HISTORY");
  const priorEnd = currentStart - 1;
  const currentReason = unavailableForWindow(runtimes, aggregates, currentStart, index);
  const priorReason = unavailableForWindow(runtimes, aggregates, priorStart, priorEnd);
  if (currentReason !== null) return comparisonUnavailable(currentReason);
  if (priorReason !== null) return comparisonUnavailable(priorReason);
  const current = sumTotals(aggregates, currentStart, index);
  const prior = sumTotals(aggregates, priorStart, priorEnd);
  const delta = current - prior;
  return {
    available: true,
    windowMonths,
    currentWindowStartPeriod: runtimes[currentStart].period,
    currentWindowEndPeriod: runtimes[index].period,
    priorWindowStartPeriod: runtimes[priorStart].period,
    priorWindowEndPeriod: runtimes[priorEnd].period,
    currentWindowTotalMicros: current.toString(),
    priorWindowTotalMicros: prior.toString(),
    deltaMicros: delta.toString(),
    percent: prior === ZERO ? null : rational(delta * HUNDRED, prior),
    percentUnavailableReason: prior === ZERO ? "BASELINE_ZERO" : null,
  };
}

function dimensionValue(line: CanonicalCurLine, dimension: FinopsTrendsDimension): string | null {
  switch (dimension) {
    case "account": return line.usageAccountId;
    case "service": return line.service;
    case "region": return line.region;
    case "charge_category": return line.chargeCategory;
  }
}

function dimensionTotals(
  input: FinopsTrendsActivePeriodInput,
  currency: string,
  basis: FinopsCostBasis,
  dimension: FinopsTrendsDimension,
): Map<string, { readonly value: string | null; total: bigint }> {
  const totals = new Map<string, { readonly value: string | null; total: bigint }>();
  for (const { line } of input.rows) {
    if (line.currency !== currency) continue;
    const amount = costValue(line, basis);
    if (amount === null) continue;
    const value = dimensionValue(line, dimension);
    const key = value ?? "\0";
    const current = totals.get(key) ?? { value, total: ZERO };
    current.total += BigInt(amount);
    totals.set(key, current);
  }
  return totals;
}

function contributorGroups(
  runtimes: readonly PeriodRuntime[],
  aggregates: readonly PointAggregate[],
  index: number,
  currency: string,
  basis: FinopsCostBasis,
  limit: number,
): readonly FinopsTrendsContributorGroup[] {
  const dimensions: readonly FinopsTrendsDimension[] = ["account", "service", "region", "charge_category"];
  if (index === 0) {
    return dimensions.map((dimension) => ({
      dimension,
      available: false,
      unavailableReason: "NO_PRIOR_PERIOD",
      contributors: [],
      totalDimensionValues: 0,
      truncated: false,
    }));
  }
  const currentReason = comparableReason(runtimes[index], aggregates[index]);
  const priorReason = comparableReason(runtimes[index - 1], aggregates[index - 1]);
  const unavailableReason = currentReason ?? priorReason;
  if (
    unavailableReason !== null
    || runtimes[index].input === null
    || runtimes[index - 1].input === null
  ) {
    return dimensions.map((dimension) => ({
      dimension,
      available: false,
      unavailableReason: unavailableReason ?? "MISSING_PERIOD",
      contributors: [],
      totalDimensionValues: 0,
      truncated: false,
    }));
  }
  const currentInput = runtimes[index].input as FinopsTrendsActivePeriodInput;
  const priorInput = runtimes[index - 1].input as FinopsTrendsActivePeriodInput;
  return dimensions.map((dimension) => {
    const current = dimensionTotals(currentInput, currency, basis, dimension);
    const prior = dimensionTotals(priorInput, currency, basis, dimension);
    const keys = new Set([...current.keys(), ...prior.keys()]);
    if (keys.size > FINOPS_TRENDS_INTELLIGENCE_BOUNDS.maximumDimensionValues) {
      throw new FinopsTrendsBoundError("DIMENSION_LIMIT_EXCEEDED");
    }
    const movements = [...keys].map((key) => {
      const currentEntry = current.get(key);
      const priorEntry = prior.get(key);
      const currentMicros = currentEntry?.total ?? ZERO;
      const priorMicros = priorEntry?.total ?? ZERO;
      return {
        value: currentEntry?.value ?? priorEntry?.value ?? null,
        currentMicros,
        priorMicros,
        delta: currentMicros - priorMicros,
      };
    }).filter(({ delta }) => delta !== ZERO)
      .sort((left, right) => {
        const leftAbs = abs(left.delta);
        const rightAbs = abs(right.delta);
        return leftAbs === rightAbs
          ? compareText(left.value ?? "", right.value ?? "")
          : leftAbs > rightAbs ? -1 : 1;
      });
    const absoluteMovement = movements.reduce((sum, item) => sum + abs(item.delta), ZERO);
    return {
      dimension,
      available: true,
      unavailableReason: null,
      contributors: movements.slice(0, limit).map((item) => ({
        value: item.value,
        currentMicros: item.currentMicros.toString(),
        priorMicros: item.priorMicros.toString(),
        deltaMicros: item.delta.toString(),
        absoluteMovementShare: rational(
          abs(item.delta),
          absoluteMovement === ZERO ? ONE : absoluteMovement,
        ),
      })),
      totalDimensionValues: movements.length,
      truncated: movements.length > limit,
    };
  });
}

class FinopsTrendsBoundError extends Error {
  readonly code: "DIMENSION_LIMIT_EXCEEDED";

  constructor(code: "DIMENSION_LIMIT_EXCEEDED") {
    super(code);
    this.code = code;
  }
}

function signals(
  runtimes: readonly PeriodRuntime[],
  aggregates: readonly PointAggregate[],
  index: number,
  mom: FinopsTrendsComparison,
): readonly FinopsTrendsSignal[] {
  const found: FinopsTrendsSignal[] = [];
  if (mom.available) {
    const baseline = BigInt(mom.baselineMicros);
    const delta = BigInt(mom.deltaMicros);
    if (
      baseline !== ZERO
      && abs(delta) * HUNDRED
        >= abs(baseline) * BigInt(FINOPS_TRENDS_SIGNAL_POLICY.momAbsolutePercentThreshold)
    ) {
      found.push({
        code: "MOM_ABSOLUTE_PERCENT_CHANGE",
        severity: "INFORMATIONAL",
        formula: FINOPS_TRENDS_SIGNAL_POLICY.formulas.momAbsolutePercentChange,
        thresholdPercent: FINOPS_TRENDS_SIGNAL_POLICY.momAbsolutePercentThreshold,
        observedPercent: rational(delta * HUNDRED, baseline),
        baseline: "PRIOR_MONTH",
        explanation: "The exact month-over-month absolute percentage change met the pinned 20% review threshold.",
      });
    }
  }
  const baselineMonths = FINOPS_TRENDS_SIGNAL_POLICY.trailingBaselineMonths;
  const priorStart = index - baselineMonths;
  if (priorStart >= 0) {
    const currentReason = comparableReason(runtimes[index], aggregates[index]);
    const historyReason = unavailableForWindow(runtimes, aggregates, priorStart, index - 1);
    if (currentReason === null && historyReason === null) {
      const baselineSum = sumTotals(aggregates, priorStart, index - 1);
      const current = aggregates[index].total ?? ZERO;
      if (baselineSum > ZERO) {
        const deviationNumerator = current * BigInt(baselineMonths) - baselineSum;
        if (
          abs(deviationNumerator) * HUNDRED
            >= baselineSum * BigInt(FINOPS_TRENDS_SIGNAL_POLICY.trailingAbsolutePercentThreshold)
        ) {
          found.push({
            code: "TRAILING_BASELINE_DEVIATION",
            severity: "INFORMATIONAL",
            formula: FINOPS_TRENDS_SIGNAL_POLICY.formulas.trailingBaselineDeviation,
            thresholdPercent: FINOPS_TRENDS_SIGNAL_POLICY.trailingAbsolutePercentThreshold,
            observedPercent: rational(deviationNumerator * HUNDRED, baselineSum),
            baseline: "PREVIOUS_3_MONTH_AVERAGE",
            explanation: "The current total differed from the exact previous-three-month average by at least the pinned 30% review threshold.",
          });
        }
      }
    }
  }
  return found;
}

function lineageFor(input: FinopsTrendsActivePeriodInput): FinopsTrendsPeriodLineage {
  const ids = [...new Set(input.rows.map(({ line }) => line.lineItemId))].sort(compareText);
  return {
    sourceEvidenceId: input.evidence.sourceEvidenceId,
    manifestSha256: input.evidence.manifestSha256,
    generationId: input.scope.generationId,
    sourceUpdatedAtIso: input.evidence.sourceUpdatedAtIso,
    observedAtIso: input.evidence.observedAtIso,
    committedAtIso: input.evidence.committedAtIso,
    activatedAtIso: input.evidence.activatedAtIso,
    sourceRowCount: input.rows.length,
    sourceLineItemIdCount: ids.length,
    sourceLineItemIds: ids.slice(0, FINOPS_TRENDS_INTELLIGENCE_BOUNDS.maximumLineageLineItemIds),
    sourceLineItemIdsTruncated:
      ids.length > FINOPS_TRENDS_INTELLIGENCE_BOUNDS.maximumLineageLineItemIds,
  };
}

function overallState(
  source: FinopsTrendsSourceInput,
  periods: readonly PeriodRuntime[],
  series: readonly FinopsTrendsSeries[],
): FinopsTrendsSnapshotState {
  if (source.state === "CONFIGURATION_REQUIRED") return "CONFIGURATION_REQUIRED";
  if (source.state === "ERROR") return "ERROR";
  if (periods.some(({ stateReasons }) => stateReasons.includes("MISSING")
    || stateReasons.includes("CURRENT_PARTIAL")
    || stateReasons.includes("PARTIAL"))) return "PARTIAL";
  if (series.some(({ points }) => points.some(({ costCoverage }) => costCoverage !== "complete"))) return "PARTIAL";
  if (periods.some(({ stateReasons }) => stateReasons.includes("STALE"))) return "STALE";
  if (periods.every(({ stateReasons }) => stateReasons.includes("EMPTY"))) return "EMPTY";
  return "READY";
}

/**
 * Build bounded, deterministic trends intelligence from persistence-verified
 * active CUR2 generations. No wall clock or external source is consulted.
 */
export function buildFinopsTrendsIntelligence(
  input: FinopsTrendsIntelligenceInput,
): FinopsTrendsIntelligenceResult {
  if (!isRecord(input)) return fail("INVALID_INPUT", "input");
  if (!validTenant(input.tenant)) return fail("INVALID_TENANT_SCOPE", "tenant");
  if (
    !isRecord(input.window)
    || typeof input.window.fromPeriod !== "string"
    || typeof input.window.toPeriod !== "string"
  ) return fail("INVALID_WINDOW", "window");
  const periods = periodRange(input.window.fromPeriod, input.window.toPeriod);
  if (periods === null) return fail("INVALID_WINDOW", "window");
  if (periods.length === 0) return fail("PERIOD_LIMIT_EXCEEDED", "window");
  const expectedCurrencies = normalizeCurrencies(input.expectedCurrencies);
  if (expectedCurrencies === null) return fail("INVALID_INPUT", "expectedCurrencies");
  if (!validSource(input.source)) return fail("INVALID_SOURCE_STATE", "source");
  const options = normalizeOptions(input.options);
  if (options === null) return fail("INVALID_OPTIONS", "options");
  if (expectedCurrencies.length * options.costBases.length
    > FINOPS_TRENDS_INTELLIGENCE_BOUNDS.maximumSeries) {
    return fail("SERIES_LIMIT_EXCEEDED", "expectedCurrencies");
  }
  if (!Array.isArray(input.periods)) return fail("INVALID_INPUT", "periods");
  if (input.source.state !== "READY" && input.periods.length > 0) {
    return fail("INVALID_SOURCE_STATE", "periods");
  }

  const byPeriod = new Map<string, FinopsTrendsActivePeriodInput>();
  const generationIds = new Set<string>();
  let totalRows = 0;
  for (let periodIndexValue = 0; periodIndexValue < input.periods.length; periodIndexValue += 1) {
    const candidate = input.periods[periodIndexValue];
    if (!isRecord(candidate) || !validScope(candidate.scope) || !Array.isArray(candidate.rows)) {
      return fail("INVALID_PERIOD_EVIDENCE", `periods[${periodIndexValue}]`);
    }
    const period = candidate.scope.billingPeriod;
    if (!tenantMatchesScope(input.tenant, candidate.scope)) {
      return fail("ROW_SCOPE_MISMATCH", `periods[${periodIndexValue}].scope`, { period });
    }
    if (!periods.includes(period)) {
      return fail("PERIOD_OUTSIDE_WINDOW", `periods[${periodIndexValue}].scope.billingPeriod`, { period });
    }
    if (byPeriod.has(period)) return fail("DUPLICATE_PERIOD", "periods", { period });
    if (generationIds.has(candidate.scope.generationId)) {
      return fail("DUPLICATE_GENERATION", `periods[${periodIndexValue}].scope.generationId`, { period });
    }
    if (candidate.rows.length > FINOPS_TRENDS_INTELLIGENCE_BOUNDS.maximumRowsPerPeriod) {
      return fail("ROW_LIMIT_EXCEEDED", `periods[${periodIndexValue}].rows`, { period });
    }
    totalRows += candidate.rows.length;
    if (totalRows > FINOPS_TRENDS_INTELLIGENCE_BOUNDS.maximumTotalRows) {
      return fail("ROW_LIMIT_EXCEEDED", "periods.rows");
    }
    if (!validEvidence(candidate.evidence, candidate.rows.length)) {
      return fail("INVALID_PERIOD_EVIDENCE", `periods[${periodIndexValue}].evidence`, { period });
    }
    if (
      candidate.evidence.loadKind === "CORRECTION"
      && candidate.evidence.supersededGenerationId === candidate.scope.generationId
    ) return fail("INVALID_PERIOD_EVIDENCE", `periods[${periodIndexValue}].evidence.supersededGenerationId`, { period });

    const lineIds = new Set<string>();
    for (let rowIndex = 0; rowIndex < candidate.rows.length; rowIndex += 1) {
      const row = candidate.rows[rowIndex];
      if (!isRecord(row) || !validScope(row) || !scopeMatches(candidate.scope, row)) {
        return fail("ROW_SCOPE_MISMATCH", `periods[${periodIndexValue}].rows[${rowIndex}]`, { period, rowIndex });
      }
      if (!validCur2Row(row.line)) {
        return fail("INVALID_CUR2_ROW", `periods[${periodIndexValue}].rows[${rowIndex}].line`, { period, rowIndex });
      }
      if (
        row.line.billingPeriodStartIso === null
        || !validIso(row.line.billingPeriodStartIso)
        || row.line.billingPeriodStartIso.slice(0, 7) !== period
      ) {
        return fail("INVALID_CUR2_ROW", `periods[${periodIndexValue}].rows[${rowIndex}].line.billingPeriodStartIso`, { period, rowIndex });
      }
      if (!expectedCurrencies.includes(row.line.currency)) {
        return fail("CURRENCY_OUTSIDE_SCOPE", `periods[${periodIndexValue}].rows[${rowIndex}].line.currency`, { period, rowIndex });
      }
      if (lineIds.has(row.line.lineItemId)) {
        return fail("DUPLICATE_LINE_ITEM", `periods[${periodIndexValue}].rows[${rowIndex}].line.lineItemId`, { period, rowIndex });
      }
      lineIds.add(row.line.lineItemId);
      for (const basis of candidate.evidence.availableCostBases) {
        if (costValue(row.line, basis) === null) {
          return fail("COST_BASIS_EVIDENCE_MISMATCH", `periods[${periodIndexValue}].rows[${rowIndex}].line`, { period, rowIndex });
        }
      }
    }
    generationIds.add(candidate.scope.generationId);
    byPeriod.set(period, candidate as unknown as FinopsTrendsActivePeriodInput);
  }

  const runtimes: PeriodRuntime[] = periods.map((period) => {
    const periodInput = byPeriod.get(period) ?? null;
    const evaluated = stateReasonsFor(period, periodInput, input.source);
    return {
      period,
      input: periodInput,
      state: primaryPeriodState(evaluated.reasons),
      stateReasons: evaluated.reasons,
      ageSeconds: evaluated.ageSeconds,
    };
  });

  let series: readonly FinopsTrendsSeries[];
  try {
    series = expectedCurrencies.flatMap((currency) =>
      options.costBases.map((costBasis): FinopsTrendsSeries => {
        const aggregates = runtimes.map((runtime) => aggregateFor(runtime, currency, costBasis));
        return {
          currency,
          costBasis,
          points: runtimes.map((runtime, index): FinopsTrendsSeriesPoint => {
            const aggregate = aggregates[index];
            const mom = monthOverMonth(runtimes, aggregates, index);
            return {
              period: runtime.period,
              periodState: runtime.state,
              totalMicros: aggregate.total?.toString() ?? null,
              contributingRowCount: aggregate.contributingRowCount,
              missingCostRowCount: aggregate.missingCostRowCount,
              costCoverage: aggregate.coverage,
              monthOverMonth: mom,
              trailingAverage: trailingAverage(
                runtimes,
                aggregates,
                index,
                options.rollingWindowMonths,
              ),
              rollingComparison: rollingComparison(
                runtimes,
                aggregates,
                index,
                options.rollingWindowMonths,
              ),
              contributors: contributorGroups(
                runtimes,
                aggregates,
                index,
                currency,
                costBasis,
                options.contributorLimit,
              ),
              signals: signals(runtimes, aggregates, index, mom),
            };
          }),
        };
      }));
  } catch (error: unknown) {
    if (error instanceof FinopsTrendsBoundError) return fail(error.code, "contributors");
    throw error;
  }

  const periodSummaries: FinopsTrendsPeriodSummary[] = runtimes.map((runtime) => ({
    period: runtime.period,
    state: runtime.state,
    stateReasons: runtime.stateReasons,
    loadKind: runtime.input?.evidence.loadKind ?? null,
    generationId: runtime.input?.scope.generationId ?? null,
    collectionState: runtime.input?.evidence.collectionState ?? null,
    rowCount: runtime.input?.rows.length ?? null,
    rejectedRowCount: runtime.input?.evidence.rejectedRowCount ?? null,
    ageSeconds: runtime.ageSeconds,
    staleAfterSeconds: input.source.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS,
    lineage: runtime.input === null ? null : lineageFor(runtime.input),
  }));
  const countReason = (reason: FinopsTrendsPeriodState): number =>
    runtimes.filter(({ stateReasons }) => stateReasons.includes(reason)).length;

  return {
    ok: true,
    schema: "sutra.finops-trends-intelligence.v1",
    state: overallState(input.source, runtimes, series),
    tenant: input.tenant,
    window: {
      fromPeriod: periods[0],
      toPeriod: periods[periods.length - 1],
      periodCount: periods.length,
    },
    evaluatedAtIso: input.source.evaluatedAtIso,
    expectedCurrencies,
    selectedCostBases: options.costBases,
    rollingWindowMonths: options.rollingWindowMonths,
    contributorLimit: options.contributorLimit,
    periods: periodSummaries,
    series,
    summary: {
      activeGenerationCount: byPeriod.size,
      sourceRowCount: totalRows,
      completePeriodCount: countReason("COMPLETE"),
      missingPeriodCount: countReason("MISSING"),
      currentPartialPeriodCount: countReason("CURRENT_PARTIAL"),
      correctionPeriodCount: countReason("CORRECTION"),
      backfillPeriodCount: countReason("BACKFILL"),
      stalePeriodCount: countReason("STALE"),
      partialPeriodCount: countReason("PARTIAL"),
      emptyPeriodCount: countReason("EMPTY"),
      signalCount: series.reduce(
        (total, item) => total + item.points.reduce((subtotal, point) => subtotal + point.signals.length, 0),
        0,
      ),
    },
    forecast: {
      available: false,
      reason: "NOT_PRODUCED_EVIDENCE_HONEST_TRENDS_ONLY",
    },
    signalPolicy: FINOPS_TRENDS_SIGNAL_POLICY,
    additionalReadOperations: FINOPS_TRENDS_ADDITIONAL_READ_OPERATIONS,
    limitations: FINOPS_TRENDS_LIMITATIONS,
  };
}
