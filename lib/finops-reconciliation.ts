/**
 * Pure reconciliation boundary for one staged canonical billing generation.
 *
 * This module deliberately does not read or write persistence. A caller may
 * atomically activate a generation only when this function returns
 * `activation: "activate_staged_generation"`. All money remains signed integer
 * micro-units and currencies are reconciled independently; no float conversion,
 * currency conversion, or implicit rounding is permitted.
 */
import type { CanonicalCurLine, CurChargeKind } from "./finops-cur";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const GENERATION_ID = /^fbg_[a-f0-9]{64}$/u;
const INTEGER_MICROS = /^-?(?:0|[1-9]\d{0,127})$/u;
const NON_NEGATIVE_MICROS = /^(?:0|[1-9]\d{0,127})$/u;
const MAX_SOURCE_EVIDENCE_ID_LENGTH = 1_024;

/**
 * Static ISO 4217 currency snapshot. Keeping this list in the contract makes
 * acceptance deterministic across Node, Workers, and ICU runtime versions.
 */
export const FINOPS_RECONCILIATION_CURRENCIES = new Set([
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
  "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL",
  "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY",
  "COP", "CRC", "CUC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD",
  "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP",
  "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HRK", "HTG", "HUF", "IDR",
  "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS",
  "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR",
  "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP",
  "MRU", "MUR", "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO",
  "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN",
  "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG",
  "SEK", "SGD", "SHP", "SLE", "SLL", "SOS", "SRD", "SSP", "STN", "SVC",
  "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD",
  "TZS", "UAH", "UGX", "USD", "UYU", "UZS", "VES", "VND", "VUV", "WST",
  "XAF", "XCD", "XCG", "XDR", "XOF", "XPF", "XSU", "YER", "ZAR", "ZMW",
  "ZWG", "ZWL",
] as const);

export const FINOPS_RECONCILIATION_CATEGORIES = [
  "usage",
  "tax",
  "credit",
  "refund",
  "fee",
  "other",
] as const;

export type FinopsReconciliationCategory =
  typeof FINOPS_RECONCILIATION_CATEGORIES[number];

export interface FinopsReconciliationScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly exportName: string;
  readonly billingPeriod: string;
  readonly generationId: string;
}

export interface ScopedCanonicalBillingRow extends FinopsReconciliationScope {
  readonly line: CanonicalCurLine;
}

export interface FinopsExpectedCurrencyEvidence {
  readonly currency: string;
  readonly rowCount: number;
  /** Exact signed integer micro-unit total from authoritative source evidence. */
  readonly totalMicros: string;
  /** Optional because not every authoritative source publishes category totals. */
  readonly categoryTotalsMicros?: Readonly<
    Partial<Record<FinopsReconciliationCategory, string>>
  >;
  /** Optional because not every authoritative source publishes category counts. */
  readonly categoryRowCounts?: Readonly<
    Partial<Record<FinopsReconciliationCategory, number>>
  >;
}

export interface FinopsReconciliationEvidence {
  readonly scope: FinopsReconciliationScope;
  readonly sourceEvidenceId: string;
  readonly manifestSha256: string;
  /** Accepted canonical source rows; rejected or missing source rows are not hidden here. */
  readonly rowCount: number;
  readonly currencies: readonly FinopsExpectedCurrencyEvidence[];
}

export interface FinopsReconciliationInput {
  readonly scope: FinopsReconciliationScope;
  readonly evidence: FinopsReconciliationEvidence | null;
  readonly rows: readonly ScopedCanonicalBillingRow[];
  /**
   * Maximum absolute difference permitted for each independently reconciled
   * total, in integer micro-units. Omission means exact reconciliation ("0").
   */
  readonly toleranceMicros?: string;
}

export type FinopsReconciliationFailureCode =
  | "INVALID_SCOPE"
  | "MISSING_SOURCE_EVIDENCE"
  | "INVALID_SOURCE_EVIDENCE"
  | "EVIDENCE_SCOPE_MISMATCH"
  | "INVALID_TOLERANCE_MICROS"
  | "UNKNOWN_CURRENCY"
  | "DUPLICATE_CURRENCY_EVIDENCE"
  | "EVIDENCE_ROW_COUNT_INCONSISTENT"
  | "INVALID_STAGED_ROWS"
  | "ROW_SCOPE_MISMATCH"
  | "INVALID_CANONICAL_ROW"
  | "UNEXPECTED_CURRENCY"
  | "CURRENCY_ROW_COUNT_MISMATCH"
  | "CURRENCY_TOTAL_MISMATCH"
  | "CATEGORY_ROW_COUNT_MISMATCH"
  | "CATEGORY_TOTAL_MISMATCH";

export interface FinopsReconciliationFailure {
  readonly code: FinopsReconciliationFailureCode;
  /** Stable machine path; no localized prose is needed to identify the failure. */
  readonly field: string;
  readonly rowIndex?: number;
  readonly currency?: string;
  readonly category?: FinopsReconciliationCategory;
  readonly expected?: string;
  readonly actual?: string;
  readonly absoluteDeltaMicros?: string;
}

export interface FinopsReconciledCategorySummary {
  readonly category: FinopsReconciliationCategory;
  readonly rowCount: number;
  readonly totalMicros: string;
}

export interface FinopsReconciledCurrencySummary {
  readonly currency: string;
  readonly rowCount: number;
  readonly totalMicros: string;
  readonly categories: readonly FinopsReconciledCategorySummary[];
}

export interface FinopsReconciliationSummary {
  readonly rowCount: number;
  readonly currencies: readonly FinopsReconciledCurrencySummary[];
}

export type FinopsReconciliationResult =
  | {
      readonly ok: true;
      readonly activation: "activate_staged_generation";
      readonly toleranceMicros: string;
      readonly sourceEvidenceId: string;
      readonly manifestSha256: string;
      readonly actual: FinopsReconciliationSummary;
      readonly failures: readonly [];
    }
  | {
      readonly ok: false;
      readonly activation: "retain_current_active_generation";
      readonly toleranceMicros: string;
      readonly sourceEvidenceId: string | null;
      readonly manifestSha256: string | null;
      readonly actual: FinopsReconciliationSummary | null;
      readonly failures: readonly FinopsReconciliationFailure[];
    };

interface MutableCategorySummary {
  rowCount: number;
  totalMicros: bigint;
}

interface MutableCurrencySummary {
  rowCount: number;
  totalMicros: bigint;
  categories: Record<FinopsReconciliationCategory, MutableCategorySummary>;
}

interface NormalizedExpectedCurrency {
  readonly currency: string;
  readonly rowCount: number;
  readonly totalMicros: bigint;
  readonly categoryTotalsMicros: Readonly<
    Partial<Record<FinopsReconciliationCategory, bigint>>
  >;
  readonly categoryRowCounts: Readonly<
    Partial<Record<FinopsReconciliationCategory, number>>
  >;
}

interface NormalizedEvidence {
  readonly sourceEvidenceId: string;
  readonly manifestSha256: string;
  readonly rowCount: number;
  readonly currencies: readonly NormalizedExpectedCurrency[];
}

const CHARGE_KINDS = new Set<CurChargeKind>([
  "usage",
  "purchase",
  "tax",
  "credit",
  "refund",
  "discount",
  "adjustment",
  "other",
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validText(value: unknown, maxLength = 256): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !value.includes("\0");
}

function validScope(scope: unknown): scope is FinopsReconciliationScope {
  if (!isRecord(scope)) return false;
  return typeof scope.organizationId === "string"
    && IDENTIFIER.test(scope.organizationId)
    && typeof scope.customerId === "string"
    && IDENTIFIER.test(scope.customerId)
    && typeof scope.connectionId === "string"
    && IDENTIFIER.test(scope.connectionId)
    && validText(scope.exportName)
    && PERIOD.test(String(scope.billingPeriod))
    && typeof scope.generationId === "string"
    && GENERATION_ID.test(scope.generationId);
}

function sameScope(
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

function integerMicros(value: unknown): value is string {
  return typeof value === "string" && INTEGER_MICROS.test(value);
}

function safeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function knownCurrency(value: unknown): value is string {
  return typeof value === "string" && FINOPS_RECONCILIATION_CURRENCIES.has(
    value as (typeof FINOPS_RECONCILIATION_CURRENCIES extends Set<infer T> ? T : never),
  );
}

function categoryFor(chargeKind: CurChargeKind): FinopsReconciliationCategory {
  switch (chargeKind) {
    case "usage":
    case "tax":
    case "credit":
    case "refund":
      return chargeKind;
    case "purchase":
      return "fee";
    default:
      return "other";
  }
}

function emptyCategoryRecord(): Record<
  FinopsReconciliationCategory,
  MutableCategorySummary
> {
  return {
    usage: { rowCount: 0, totalMicros: BigInt(0) },
    tax: { rowCount: 0, totalMicros: BigInt(0) },
    credit: { rowCount: 0, totalMicros: BigInt(0) },
    refund: { rowCount: 0, totalMicros: BigInt(0) },
    fee: { rowCount: 0, totalMicros: BigInt(0) },
    other: { rowCount: 0, totalMicros: BigInt(0) },
  };
}

function failure(
  code: FinopsReconciliationFailureCode,
  field: string,
  detail: Omit<FinopsReconciliationFailure, "code" | "field"> = {},
): FinopsReconciliationFailure {
  return { code, field, ...detail };
}

function rejected(
  toleranceMicros: string,
  failures: readonly FinopsReconciliationFailure[],
  evidence: Pick<NormalizedEvidence, "sourceEvidenceId" | "manifestSha256"> | null = null,
  actual: FinopsReconciliationSummary | null = null,
): FinopsReconciliationResult {
  return {
    ok: false,
    activation: "retain_current_active_generation",
    toleranceMicros,
    sourceEvidenceId: evidence?.sourceEvidenceId ?? null,
    manifestSha256: evidence?.manifestSha256 ?? null,
    actual,
    failures,
  };
}

function normalizeCategoryTotals(
  value: unknown,
  currencyIndex: number,
  failures: FinopsReconciliationFailure[],
): Readonly<Partial<Record<FinopsReconciliationCategory, bigint>>> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    failures.push(failure(
      "INVALID_SOURCE_EVIDENCE",
      `evidence.currencies[${currencyIndex}].categoryTotalsMicros`,
    ));
    return {};
  }
  const normalized: Partial<Record<FinopsReconciliationCategory, bigint>> = {};
  const allowed = new Set<string>(FINOPS_RECONCILIATION_CATEGORIES);
  for (const key of Object.keys(value).sort()) {
    if (!allowed.has(key) || !integerMicros(value[key])) {
      failures.push(failure(
        "INVALID_SOURCE_EVIDENCE",
        `evidence.currencies[${currencyIndex}].categoryTotalsMicros.${key}`,
      ));
      continue;
    }
    normalized[key as FinopsReconciliationCategory] = BigInt(value[key]);
  }
  return normalized;
}

function normalizeCategoryCounts(
  value: unknown,
  currencyIndex: number,
  failures: FinopsReconciliationFailure[],
): Readonly<Partial<Record<FinopsReconciliationCategory, number>>> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    failures.push(failure(
      "INVALID_SOURCE_EVIDENCE",
      `evidence.currencies[${currencyIndex}].categoryRowCounts`,
    ));
    return {};
  }
  const normalized: Partial<Record<FinopsReconciliationCategory, number>> = {};
  const allowed = new Set<string>(FINOPS_RECONCILIATION_CATEGORIES);
  for (const key of Object.keys(value).sort()) {
    if (!allowed.has(key) || !safeCount(value[key])) {
      failures.push(failure(
        "INVALID_SOURCE_EVIDENCE",
        `evidence.currencies[${currencyIndex}].categoryRowCounts.${key}`,
      ));
      continue;
    }
    normalized[key as FinopsReconciliationCategory] = value[key];
  }
  return normalized;
}

function normalizeEvidence(
  scope: FinopsReconciliationScope,
  value: FinopsReconciliationEvidence,
): {
  readonly evidence: NormalizedEvidence | null;
  readonly failures: readonly FinopsReconciliationFailure[];
} {
  const failures: FinopsReconciliationFailure[] = [];
  if (!isRecord(value)) {
    return {
      evidence: null,
      failures: [failure("INVALID_SOURCE_EVIDENCE", "evidence")],
    };
  }
  if (!validScope(value.scope)) {
    failures.push(failure("INVALID_SOURCE_EVIDENCE", "evidence.scope"));
  } else if (!sameScope(scope, value.scope)) {
    failures.push(failure("EVIDENCE_SCOPE_MISMATCH", "evidence.scope"));
  }
  const sourceEvidenceId = validText(
    value.sourceEvidenceId,
    MAX_SOURCE_EVIDENCE_ID_LENGTH,
  ) ? value.sourceEvidenceId : null;
  if (sourceEvidenceId === null) {
    failures.push(failure("INVALID_SOURCE_EVIDENCE", "evidence.sourceEvidenceId"));
  }
  const manifestSha256 = typeof value.manifestSha256 === "string"
    && SHA256.test(value.manifestSha256)
    ? value.manifestSha256
    : null;
  if (manifestSha256 === null) {
    failures.push(failure("INVALID_SOURCE_EVIDENCE", "evidence.manifestSha256"));
  }
  const evidenceRowCount = safeCount(value.rowCount) ? value.rowCount : null;
  if (evidenceRowCount === null) {
    failures.push(failure("INVALID_SOURCE_EVIDENCE", "evidence.rowCount"));
  }
  if (!Array.isArray(value.currencies)) {
    failures.push(failure("INVALID_SOURCE_EVIDENCE", "evidence.currencies"));
    return { evidence: null, failures };
  }
  if (value.currencies.length === 0 && evidenceRowCount !== 0) {
    failures.push(failure("INVALID_SOURCE_EVIDENCE", "evidence.currencies"));
  }

  const seenCurrencies = new Set<string>();
  const currencies: NormalizedExpectedCurrency[] = [];
  value.currencies.forEach((entry, index) => {
    if (!isRecord(entry)) {
      failures.push(failure(
        "INVALID_SOURCE_EVIDENCE",
        `evidence.currencies[${index}]`,
      ));
      return;
    }
    if (!knownCurrency(entry.currency)) {
      failures.push(failure(
        "UNKNOWN_CURRENCY",
        `evidence.currencies[${index}].currency`,
        { currency: typeof entry.currency === "string" ? entry.currency : undefined },
      ));
      return;
    }
    if (seenCurrencies.has(entry.currency)) {
      failures.push(failure(
        "DUPLICATE_CURRENCY_EVIDENCE",
        `evidence.currencies[${index}].currency`,
        { currency: entry.currency },
      ));
      return;
    }
    seenCurrencies.add(entry.currency);
    if (!safeCount(entry.rowCount)) {
      failures.push(failure(
        "INVALID_SOURCE_EVIDENCE",
        `evidence.currencies[${index}].rowCount`,
        { currency: entry.currency },
      ));
      return;
    }
    if (!integerMicros(entry.totalMicros)) {
      failures.push(failure(
        "INVALID_SOURCE_EVIDENCE",
        `evidence.currencies[${index}].totalMicros`,
        { currency: entry.currency },
      ));
      return;
    }
    currencies.push({
      currency: entry.currency,
      rowCount: entry.rowCount,
      totalMicros: BigInt(entry.totalMicros),
      categoryTotalsMicros: normalizeCategoryTotals(
        entry.categoryTotalsMicros,
        index,
        failures,
      ),
      categoryRowCounts: normalizeCategoryCounts(
        entry.categoryRowCounts,
        index,
        failures,
      ),
    });
  });

  if (
    evidenceRowCount !== null
    && currencies.reduce((sum, entry) => sum + entry.rowCount, 0) !== evidenceRowCount
  ) {
    failures.push(failure(
      "EVIDENCE_ROW_COUNT_INCONSISTENT",
      "evidence.rowCount",
      {
        expected: String(evidenceRowCount),
        actual: String(currencies.reduce((sum, entry) => sum + entry.rowCount, 0)),
      },
    ));
  }
  if (
    failures.length > 0
    || sourceEvidenceId === null
    || manifestSha256 === null
    || evidenceRowCount === null
  ) {
    return { evidence: null, failures };
  }
  return {
    evidence: {
      sourceEvidenceId,
      manifestSha256,
      rowCount: evidenceRowCount,
      currencies: currencies.sort((left, right) =>
        left.currency.localeCompare(right.currency)),
    },
    failures: [],
  };
}

function summarize(
  rowCount: number,
  currencies: ReadonlyMap<string, MutableCurrencySummary>,
): FinopsReconciliationSummary {
  return {
    rowCount,
    currencies: [...currencies.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, summary]) => ({
        currency,
        rowCount: summary.rowCount,
        totalMicros: summary.totalMicros.toString(),
        categories: FINOPS_RECONCILIATION_CATEGORIES.map((category) => ({
          category,
          rowCount: summary.categories[category].rowCount,
          totalMicros: summary.categories[category].totalMicros.toString(),
        })),
      })),
  };
}

function absoluteDelta(left: bigint, right: bigint): bigint {
  const delta = left - right;
  return delta < BigInt(0) ? -delta : delta;
}

/**
 * Reconcile authoritative source evidence to the staged canonical rows.
 *
 * Failure always instructs the caller to retain the current active generation.
 * Success is the sole pure authorization for an atomic activation attempt.
 */
export function reconcileCanonicalBillingGeneration(
  input: FinopsReconciliationInput,
): FinopsReconciliationResult {
  if (!isRecord(input) || !validScope(input.scope)) {
    return rejected("0", [failure("INVALID_SCOPE", "scope")]);
  }

  const toleranceMicros = input.toleranceMicros ?? "0";
  if (
    typeof toleranceMicros !== "string"
    || !NON_NEGATIVE_MICROS.test(toleranceMicros)
  ) {
    return rejected("0", [
      failure("INVALID_TOLERANCE_MICROS", "toleranceMicros"),
    ]);
  }
  const tolerance = BigInt(toleranceMicros);

  if (input.evidence === null || input.evidence === undefined) {
    return rejected(toleranceMicros, [
      failure("MISSING_SOURCE_EVIDENCE", "evidence"),
    ]);
  }
  const normalized = normalizeEvidence(input.scope, input.evidence);
  if (normalized.evidence === null) {
    return rejected(toleranceMicros, normalized.failures);
  }
  const evidence = normalized.evidence;

  if (!Array.isArray(input.rows)) {
    return rejected(
      toleranceMicros,
      [failure("INVALID_STAGED_ROWS", "rows")],
      evidence,
    );
  }

  const expectedCurrencies = new Set(
    evidence.currencies.map((entry) => entry.currency),
  );
  const actualByCurrency = new Map<string, MutableCurrencySummary>();
  const rowFailures: FinopsReconciliationFailure[] = [];
  input.rows.forEach((row, rowIndex) => {
    if (!isRecord(row)) {
      rowFailures.push(failure(
        "INVALID_CANONICAL_ROW",
        `rows[${rowIndex}]`,
        { rowIndex },
      ));
      return;
    }
    if (!validScope(row) || !sameScope(input.scope, row)) {
      rowFailures.push(failure(
        "ROW_SCOPE_MISMATCH",
        `rows[${rowIndex}].scope`,
        { rowIndex },
      ));
      return;
    }
    if (
      !isRecord(row.line)
      || !validText(row.line.lineItemId, 4_096)
      || !integerMicros(row.line.amountMicros)
      || !CHARGE_KINDS.has(row.line.chargeKind as CurChargeKind)
    ) {
      rowFailures.push(failure(
        "INVALID_CANONICAL_ROW",
        `rows[${rowIndex}].line`,
        { rowIndex },
      ));
      return;
    }
    if (!knownCurrency(row.line.currency)) {
      rowFailures.push(failure(
        "UNKNOWN_CURRENCY",
        `rows[${rowIndex}].line.currency`,
        {
          rowIndex,
          currency: typeof row.line.currency === "string"
            ? row.line.currency
            : undefined,
        },
      ));
      return;
    }
    if (!expectedCurrencies.has(row.line.currency)) {
      rowFailures.push(failure(
        "UNEXPECTED_CURRENCY",
        `rows[${rowIndex}].line.currency`,
        { rowIndex, currency: row.line.currency },
      ));
      return;
    }

    const currencySummary = actualByCurrency.get(row.line.currency) ?? {
      rowCount: 0,
      totalMicros: BigInt(0),
      categories: emptyCategoryRecord(),
    };
    const amountMicros = BigInt(row.line.amountMicros);
    const category = categoryFor(row.line.chargeKind as CurChargeKind);
    currencySummary.rowCount += 1;
    currencySummary.totalMicros += amountMicros;
    currencySummary.categories[category].rowCount += 1;
    currencySummary.categories[category].totalMicros += amountMicros;
    actualByCurrency.set(row.line.currency, currencySummary);
  });

  const actual = summarize(input.rows.length, actualByCurrency);
  if (rowFailures.length > 0) {
    return rejected(toleranceMicros, rowFailures, evidence, actual);
  }

  const comparisonFailures: FinopsReconciliationFailure[] = [];
  for (const expected of evidence.currencies) {
    const actualCurrency = actualByCurrency.get(expected.currency) ?? {
      rowCount: 0,
      totalMicros: BigInt(0),
      categories: emptyCategoryRecord(),
    };
    if (actualCurrency.rowCount !== expected.rowCount) {
      comparisonFailures.push(failure(
        "CURRENCY_ROW_COUNT_MISMATCH",
        `currencies.${expected.currency}.rowCount`,
        {
          currency: expected.currency,
          expected: String(expected.rowCount),
          actual: String(actualCurrency.rowCount),
        },
      ));
    }
    const totalDelta = absoluteDelta(
      actualCurrency.totalMicros,
      expected.totalMicros,
    );
    if (totalDelta > tolerance) {
      comparisonFailures.push(failure(
        "CURRENCY_TOTAL_MISMATCH",
        `currencies.${expected.currency}.totalMicros`,
        {
          currency: expected.currency,
          expected: expected.totalMicros.toString(),
          actual: actualCurrency.totalMicros.toString(),
          absoluteDeltaMicros: totalDelta.toString(),
        },
      ));
    }
    for (const category of FINOPS_RECONCILIATION_CATEGORIES) {
      const expectedCount = expected.categoryRowCounts[category];
      if (
        expectedCount !== undefined
        && actualCurrency.categories[category].rowCount !== expectedCount
      ) {
        comparisonFailures.push(failure(
          "CATEGORY_ROW_COUNT_MISMATCH",
          `currencies.${expected.currency}.categoryRowCounts.${category}`,
          {
            currency: expected.currency,
            category,
            expected: String(expectedCount),
            actual: String(actualCurrency.categories[category].rowCount),
          },
        ));
      }
      const expectedTotal = expected.categoryTotalsMicros[category];
      if (expectedTotal === undefined) continue;
      const categoryDelta = absoluteDelta(
        actualCurrency.categories[category].totalMicros,
        expectedTotal,
      );
      if (categoryDelta > tolerance) {
        comparisonFailures.push(failure(
          "CATEGORY_TOTAL_MISMATCH",
          `currencies.${expected.currency}.categoryTotalsMicros.${category}`,
          {
            currency: expected.currency,
            category,
            expected: expectedTotal.toString(),
            actual: actualCurrency.categories[category].totalMicros.toString(),
            absoluteDeltaMicros: categoryDelta.toString(),
          },
        ));
      }
    }
  }
  if (actual.rowCount !== evidence.rowCount) {
    comparisonFailures.push(failure(
      "CURRENCY_ROW_COUNT_MISMATCH",
      "rowCount",
      {
        expected: String(evidence.rowCount),
        actual: String(actual.rowCount),
      },
    ));
  }

  if (comparisonFailures.length > 0) {
    return rejected(toleranceMicros, comparisonFailures, evidence, actual);
  }
  return {
    ok: true,
    activation: "activate_staged_generation",
    toleranceMicros,
    sourceEvidenceId: evidence.sourceEvidenceId,
    manifestSha256: evidence.manifestSha256,
    actual,
    failures: [],
  };
}
