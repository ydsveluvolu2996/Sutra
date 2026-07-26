/**
 * Pure, deterministic UNIT-COST TREND engine. It takes a total cost per billing
 * period (already summed from persisted CUR/FOCUS lines) and the operator's
 * per-period unit counts, and derives a cost-per-unit TIME SERIES per unit
 * metric so a user can see the trend across periods.
 *
 * This deliberately does NOT re-implement the point-in-time cost-per-unit math
 * of lib/finops-unit-economics.ts. That engine attributes spend per customer
 * for a single period; this engine consumes an already-totalled cost per period
 * and lines it up against the same operator-provided unit counts across MANY
 * periods to expose the period-over-period movement.
 *
 * Evidence-honesty rules (never relaxed):
 * - A single currency only. The caller selects one currency and totals it per
 *   period; cross-currency totals are never summed here.
 * - Cost-per-unit is null when the denominator is zero, negative or non-finite
 *   — there is NEVER a divide-by-zero and a count is NEVER assumed.
 * - A series point exists ONLY for a period that has BOTH a cost AND a supplied
 *   unit count. A period missing its count is dropped, never back-filled.
 * - Money is integer micro-units carried as BigInt (BigInt(0), never 0n) and
 *   emitted as a decimal string so no precision is lost in transit.
 * - Fully deterministic: no clock, no randomness; identical input yields
 *   byte-identical output.
 */

/** Total cost for one billing period, in integer micro-units. */
export interface PeriodCost {
  readonly period: string; // "YYYY-MM"
  readonly amountMicros: string; // integer micros, e.g. "12500000"
}

/**
 * One operator-provided unit count for a period. Structurally compatible with
 * `StoredUnitCount` from db/finops-unit-count-repository.ts (which carries extra
 * `customerId`/`createdAt`/`updatedAt` fields), so rows read from that
 * repository can be passed straight through without adaptation.
 */
export interface UnitCountEntry {
  readonly period: string; // "YYYY-MM"
  readonly unitLabel: string;
  readonly count: number;
}

export interface UnitTrendInput {
  /** Total cost per billing period for a SINGLE currency. */
  readonly periodsCost: readonly PeriodCost[];
  /** Per-period operator unit counts (any number of unit metrics). */
  readonly unitCounts: readonly UnitCountEntry[];
}

export interface UnitTrendOptions {
  /**
   * Decimals to which the DISPLAY cost-per-unit (micros per unit) is rounded.
   * The raw total micros and count are always emitted alongside so the UI can
   * format honestly. Default 6.
   */
  readonly ratioDecimals?: number;
  /** Decimals for the period-over-period deltaPercent. Default 2. */
  readonly deltaDecimals?: number;
}

export type TrendDirection = "up" | "down" | "flat";

export interface UnitTrendPoint {
  readonly period: string;
  /** Raw total cost for the period in integer micro-units. */
  readonly totalCost: string;
  /** The provided unit count (denominator) for the period. */
  readonly unitCount: number;
  /**
   * Rounded display cost-per-unit (micros per unit); null when the count is not
   * a usable denominator (zero, negative or non-finite).
   */
  readonly costPerUnit: number | null;
}

export interface UnitTrendMetric {
  readonly unit: string;
  /** Chronological (ascending period) series of cost-per-unit points. */
  readonly series: readonly UnitTrendPoint[];
  /** Most recent series point, or null when the series is empty. */
  readonly latest: UnitTrendPoint | null;
  /** Second-most-recent series point, or null when fewer than two exist. */
  readonly previous: UnitTrendPoint | null;
  /**
   * Period-over-period percent change in cost-per-unit (previous -> latest);
   * null when either endpoint is null or the previous cost-per-unit is zero.
   */
  readonly deltaPercent: number | null;
  readonly direction: TrendDirection;
}

export interface UnitTrendReport {
  readonly schema: "sutra.finops-unit-trend.v1";
  readonly metrics: readonly UnitTrendMetric[];
  readonly options: { readonly ratioDecimals: number; readonly deltaDecimals: number };
  readonly limitations: readonly string[];
  readonly disclaimer: string;
}

export const UNIT_TREND_DISCLAIMER =
  "Unit-cost trend lines up an already-totalled cost per billing period (one " +
  "currency) against operator-provided unit counts to show how cost-per-unit " +
  "moves across periods. Unit counts are business metrics not present in " +
  "billing data and are never assumed: a period is only plotted when it has " +
  "both a cost and a supplied count, and cost-per-unit is null when the count " +
  "is zero or invalid (never a divide-by-zero). Raw total micros and the raw " +
  "count are emitted so the display ratio is not trusted blindly. This is a " +
  "cost-attribution trend, not an invoice or a margin statement.";

const LIMITATIONS: readonly string[] = [
  "TREND_IS_COMPUTED_OVER_ALREADY_PERSISTED_BILLING_LINES_NO_NEW_INGESTION",
  "A_SINGLE_CURRENCY_ONLY_THE_CALLER_SELECTS_AND_TOTALS_ONE_CURRENCY_PER_PERIOD",
  "UNIT_COUNTS_ARE_PROVIDED_INPUTS_A_COUNT_IS_NEVER_ASSUMED",
  "A_SERIES_POINT_EXISTS_ONLY_WHEN_A_PERIOD_HAS_BOTH_A_COST_AND_A_SUPPLIED_COUNT",
  "COST_PER_UNIT_IS_NULL_WHEN_THE_COUNT_IS_ZERO_OR_INVALID_NEVER_DIVIDE_BY_ZERO",
];

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/u;
const MICROS_INT = /^-?\d+$/u;

function resolveDecimals(raw: number | undefined, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.min(12, Math.max(0, Math.trunc(raw)));
}

/** Compute cost-per-unit, honestly returning null for an unusable denominator. */
function ratio(total: bigint, count: number, factor: number): number | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return Math.round((Number(total) / count) * factor) / factor;
}

export function buildUnitCostTrend(input: UnitTrendInput, options?: UnitTrendOptions): UnitTrendReport {
  const ratioDecimals = resolveDecimals(options?.ratioDecimals, 6);
  const deltaDecimals = resolveDecimals(options?.deltaDecimals, 2);
  const ratioFactor = 10 ** ratioDecimals;
  const deltaFactor = 10 ** deltaDecimals;

  // Total cost per period (BigInt). Duplicate period rows are summed so a caller
  // that passes multiple partial totals for a period is never silently dropped.
  const costByPeriod = new Map<string, bigint>();
  for (const entry of input.periodsCost) {
    if (!PERIOD_RE.test(entry.period) || !MICROS_INT.test(entry.amountMicros)) continue;
    costByPeriod.set(entry.period, (costByPeriod.get(entry.period) ?? BigInt(0)) + BigInt(entry.amountMicros));
  }

  // Group counts by unit metric -> (period -> count). A repeated (unit, period)
  // takes the last provided value deterministically.
  const byUnit = new Map<string, Map<string, number>>();
  for (const uc of input.unitCounts) {
    if (!PERIOD_RE.test(uc.period)) continue;
    if (typeof uc.unitLabel !== "string" || uc.unitLabel.length === 0) continue;
    let periods = byUnit.get(uc.unitLabel);
    if (periods === undefined) {
      periods = new Map();
      byUnit.set(uc.unitLabel, periods);
    }
    periods.set(uc.period, uc.count);
  }

  const metrics: UnitTrendMetric[] = [...byUnit.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en-US"))
    .map(([unit, periodCounts]) => {
      // Only periods with BOTH a cost and a count; ascending period (YYYY-MM
      // sorts lexically = chronologically).
      const periods = [...periodCounts.keys()]
        .filter((period) => costByPeriod.has(period))
        .sort((a, b) => a.localeCompare(b, "en-US"));
      const series: UnitTrendPoint[] = periods.map((period) => {
        const total = costByPeriod.get(period) ?? BigInt(0);
        const count = periodCounts.get(period) ?? 0;
        return {
          period,
          totalCost: total.toString(),
          unitCount: count,
          costPerUnit: ratio(total, count, ratioFactor),
        };
      });
      const latest = series.length > 0 ? series[series.length - 1] : null;
      const previous = series.length > 1 ? series[series.length - 2] : null;
      let deltaPercent: number | null = null;
      if (
        latest !== null &&
        previous !== null &&
        latest.costPerUnit !== null &&
        previous.costPerUnit !== null &&
        previous.costPerUnit !== 0
      ) {
        deltaPercent =
          Math.round(((latest.costPerUnit - previous.costPerUnit) / previous.costPerUnit) * 100 * deltaFactor) /
          deltaFactor;
      }
      const direction: TrendDirection =
        deltaPercent === null || deltaPercent === 0 ? "flat" : deltaPercent > 0 ? "up" : "down";
      return { unit, series, latest, previous, deltaPercent, direction };
    });

  return {
    schema: "sutra.finops-unit-trend.v1",
    metrics,
    options: { ratioDecimals, deltaDecimals },
    limitations: LIMITATIONS,
    disclaimer: UNIT_TREND_DISCLAIMER,
  };
}
