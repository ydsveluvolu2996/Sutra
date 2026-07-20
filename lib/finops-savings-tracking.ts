/**
 * Pure, deterministic EFFECTIVE / REALIZED savings-tracking engine over
 * ALREADY-persisted CUR/FOCUS spend. "Realized commitment savings" is what a
 * Reserved-Instance / Savings-Plan commitment actually saved in a billing
 * period: the public on-demand-equivalent cost of the covered usage MINUS the
 * amortized cost actually incurred. It is a look-back on real billed lines — NOT
 * a forecast and NOT a purchase recommendation.
 *
 * Evidence-honesty rules (never relaxed):
 * - Currencies are NEVER summed together — one series per currency.
 * - A realized saving is emitted ONLY when the on-demand-equivalent (public)
 *   cost of the covered usage is present in the billing data. When covered usage
 *   exists but that public figure is absent, the saving is null with reason
 *   "on-demand-equivalent-not-derivable" — it is NEVER fabricated. A period with
 *   no commitment-covered usage has a factual realized saving of 0 (basis
 *   "no-commitment-usage"), which is data, not an estimate.
 * - Coverage (share of on-demand-equivalent spend covered by commitments) is
 *   emitted only when derivable from the same lines; otherwise null with a reason.
 * - Cumulative and period-over-period figures only sum periods whose saving was
 *   actually derivable; the count of contributing vs skipped periods is disclosed.
 * - Money is integer micro-units via BigInt (BigInt(0), never 0n). No synthetic
 *   baselines, no assumed discount rates, no invented percentages.
 * - The clock is INJECTED (`now`/`nowMs`); Date.now() is never called. When
 *   supplied, the current calendar month is disclosed and a matching historical
 *   period is flagged partial (in-progress) so it is not read as a full month.
 */

/** A pre-aggregated (period, currency) bucket produced by the input adapter. */
export interface SavingsPeriodBucket {
  /** Calendar month "YYYY-MM" (UTC). */
  readonly period: string;
  readonly currency: string;
  /** Amortized/effective cost actually incurred for commitment-COVERED usage. */
  readonly coveredAmortizedMicros: string;
  /**
   * Public on-demand-equivalent cost of the covered usage, or null when the
   * billing data did not carry it (savings then not derivable for this period).
   */
  readonly coveredOnDemandEquivalentMicros: string | null;
  /** On-demand (uncovered) usage cost in the period. */
  readonly onDemandUsageMicros: string;
  /** Amortized commitment fees (RIFee / SavingsPlanRecurringFee) in the period. */
  readonly commitmentFeeMicros: string;
  readonly coveredLineCount: number;
  readonly onDemandLineCount: number;
}

export interface SavingsTrackingInput {
  readonly buckets: readonly SavingsPeriodBucket[];
  /** Optional disclosure of lines the adapter dropped (the engine ignores it). */
  readonly skipped?: readonly { readonly reason: string }[];
}

export interface SavingsTrackingOptions {
  /** Injected clock. Preferred over `nowMs`. Never defaults to Date.now(). */
  readonly now?: () => Date;
  /** Injected clock as epoch millis (used when `now` is absent). */
  readonly nowMs?: number;
}

export type RealizedSavingsBasis =
  | "derived-from-cur"
  | "no-commitment-usage"
  | "on-demand-equivalent-not-derivable";

export type CoverageBasis = "derived-from-cur" | "coverage-not-derivable";

export interface SavingsPeriod {
  readonly period: string;
  /** Realized commitment savings in micros, or null when not derivable. */
  readonly realizedSavingsMicros: string | null;
  readonly realizedSavingsBasis: RealizedSavingsBasis;
  /** Amortized cost incurred for covered usage (always a fact from the lines). */
  readonly coveredAmortizedMicros: string;
  /** Public on-demand-equivalent of covered usage, or null when absent. */
  readonly coveredOnDemandEquivalentMicros: string | null;
  readonly onDemandUsageMicros: string;
  readonly commitmentFeeMicros: string;
  /** Share (0-100) of on-demand-equivalent spend covered by commitments. */
  readonly coveragePercent: number | null;
  readonly coverageBasis: CoverageBasis;
  /** current - prior realized saving; null when either side is not derivable. */
  readonly periodOverPeriodDeltaMicros: string | null;
  /** Running sum of derivable realized savings up to and including this period. */
  readonly cumulativeRealizedSavingsMicros: string;
  /** True only when a clock was supplied AND this period is the current month. */
  readonly isCurrentPartialPeriod: boolean;
}

export interface SavingsTrackingSeries {
  readonly currency: string;
  readonly periods: readonly SavingsPeriod[];
  /** Total realized savings across the window (derivable periods only). */
  readonly totalRealizedSavingsMicros: string;
  /** How many periods contributed a derivable saving to the total. */
  readonly derivablePeriodCount: number;
  /** How many periods were skipped because the saving was not derivable. */
  readonly notDerivablePeriodCount: number;
}

export interface SavingsTrackingReport {
  readonly schema: "sutra.finops-savings-tracking.v1";
  readonly series: readonly SavingsTrackingSeries[];
  /** Current calendar month "YYYY-MM" from the injected clock, or null. */
  readonly currentPeriod: string | null;
  readonly limitations: readonly string[];
  readonly disclaimer: string;
}

export const SAVINGS_TRACKING_DISCLAIMER =
  "Realized savings are a look-back over persisted billing line items, per currency " +
  "(currencies are never summed together). A period's realized commitment saving is the " +
  "public on-demand-equivalent cost of commitment-covered usage MINUS the amortized cost " +
  "actually incurred — computed ONLY where the on-demand-equivalent is present in the data. " +
  "Where it is absent the saving is disclosed as not-derivable, never estimated. This is not " +
  "a forecast, not an assumed discount rate, and not a purchase recommendation.";

const NOT_DERIVABLE_REASON = "on-demand-equivalent-not-derivable";

const LIMITATIONS: readonly string[] = [
  "REALIZED_SAVINGS_ARE_A_LOOKBACK_OVER_ALREADY_PERSISTED_BILLING_LINES",
  "CURRENCIES_ARE_NEVER_SUMMED_ONE_SERIES_PER_CURRENCY",
  "A_SAVING_IS_DERIVED_ONLY_WHEN_THE_ON_DEMAND_EQUIVALENT_IS_PRESENT_ELSE_NULL_WITH_REASON",
  "PERIODS_WITH_NO_COMMITMENT_USAGE_HAVE_A_FACTUAL_ZERO_SAVING_NOT_AN_ESTIMATE",
  "CUMULATIVE_AND_PERIOD_OVER_PERIOD_SUM_ONLY_DERIVABLE_PERIODS_COUNTS_DISCLOSED",
  "NO_ASSUMED_DISCOUNT_RATE_AND_NO_SYNTHETIC_BASELINE_IS_APPLIED",
];

const MICROS_INT = /^-?\d+$/u;
const PERIOD_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const CURRENCY_RE = /^[A-Z]{3}$/u;

function resolveNowMs(options?: SavingsTrackingOptions): number | null {
  if (options?.now !== undefined) {
    const value = options.now().getTime();
    return Number.isFinite(value) ? value : null;
  }
  if (typeof options?.nowMs === "number" && Number.isFinite(options.nowMs)) return options.nowMs;
  return null;
}

function toMicros(value: string | null): bigint | null {
  if (value === null || !MICROS_INT.test(value)) return null;
  return BigInt(value);
}

function roundPercent(value: number): number {
  return Math.round(value * 10000) / 10000;
}

interface MergedBucket {
  coveredAmortized: bigint;
  coveredOnDemandEquiv: bigint | null;
  onDemandUsage: bigint;
  commitmentFee: bigint;
  coveredLineCount: number;
  onDemandLineCount: number;
}

function emptyMerged(): MergedBucket {
  return {
    coveredAmortized: BigInt(0),
    coveredOnDemandEquiv: null,
    onDemandUsage: BigInt(0),
    commitmentFee: BigInt(0),
    coveredLineCount: 0,
    onDemandLineCount: 0,
  };
}

/** Merge same-(period) buckets within one currency into an ascending timeline. */
function mergeByPeriod(buckets: readonly SavingsPeriodBucket[]): { period: string; merged: MergedBucket }[] {
  const byPeriod = new Map<string, MergedBucket>();
  for (const bucket of buckets) {
    if (!PERIOD_RE.test(bucket.period)) continue;
    const target = byPeriod.get(bucket.period) ?? emptyMerged();

    const covered = toMicros(bucket.coveredAmortizedMicros);
    if (covered !== null) target.coveredAmortized += covered;
    const onDemand = toMicros(bucket.onDemandUsageMicros);
    if (onDemand !== null) target.onDemandUsage += onDemand;
    const fee = toMicros(bucket.commitmentFeeMicros);
    if (fee !== null) target.commitmentFee += fee;

    const ode = toMicros(bucket.coveredOnDemandEquivalentMicros);
    if (ode !== null) target.coveredOnDemandEquiv = (target.coveredOnDemandEquiv ?? BigInt(0)) + ode;

    target.coveredLineCount += Math.max(0, Math.trunc(bucket.coveredLineCount || 0));
    target.onDemandLineCount += Math.max(0, Math.trunc(bucket.onDemandLineCount || 0));
    byPeriod.set(bucket.period, target);
  }
  return [...byPeriod.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en-US"))
    .map(([period, merged]) => ({ period, merged }));
}

function buildSeriesForCurrency(
  currency: string,
  buckets: readonly SavingsPeriodBucket[],
  currentPeriod: string | null,
): SavingsTrackingSeries {
  const timeline = mergeByPeriod(buckets);
  const periods: SavingsPeriod[] = [];

  let cumulative = BigInt(0);
  let derivablePeriodCount = 0;
  let notDerivablePeriodCount = 0;
  let priorRealized: bigint | null = null;

  for (const { period, merged } of timeline) {
    // --- Realized commitment saving (tri-state) ---
    let realized: bigint | null = null;
    let realizedBasis: RealizedSavingsBasis;
    if (merged.coveredLineCount === 0 && merged.coveredAmortized === BigInt(0)) {
      // No commitment-covered usage at all: a factual zero saving, not an estimate.
      realized = BigInt(0);
      realizedBasis = "no-commitment-usage";
    } else if (merged.coveredOnDemandEquiv === null) {
      // Covered usage exists but the public on-demand-equivalent is absent.
      realized = null;
      realizedBasis = NOT_DERIVABLE_REASON;
    } else {
      realized = merged.coveredOnDemandEquiv - merged.coveredAmortized;
      realizedBasis = "derived-from-cur";
    }

    // --- Coverage share of on-demand-equivalent spend ---
    let coveragePercent: number | null = null;
    let coverageBasis: CoverageBasis = "coverage-not-derivable";
    if (merged.coveredLineCount === 0 && merged.coveredAmortized === BigInt(0)) {
      // No commitments; coverage is a factual 0% of on-demand-equivalent spend.
      coveragePercent = 0;
      coverageBasis = "derived-from-cur";
    } else if (merged.coveredOnDemandEquiv !== null) {
      const denominator = merged.coveredOnDemandEquiv + merged.onDemandUsage;
      if (denominator > BigInt(0)) {
        coveragePercent = roundPercent((Number(merged.coveredOnDemandEquiv) / Number(denominator)) * 100);
        coverageBasis = "derived-from-cur";
      }
    }

    // --- Cumulative + period-over-period over DERIVABLE periods only ---
    let periodOverPeriodDeltaMicros: string | null = null;
    if (realized !== null) {
      if (priorRealized !== null) periodOverPeriodDeltaMicros = (realized - priorRealized).toString();
      cumulative += realized;
      derivablePeriodCount += 1;
      priorRealized = realized;
    } else {
      notDerivablePeriodCount += 1;
      // A non-derivable period breaks the PoP chain (no honest prior to compare).
      priorRealized = null;
    }

    periods.push({
      period,
      realizedSavingsMicros: realized === null ? null : realized.toString(),
      realizedSavingsBasis: realizedBasis,
      coveredAmortizedMicros: merged.coveredAmortized.toString(),
      coveredOnDemandEquivalentMicros: merged.coveredOnDemandEquiv === null ? null : merged.coveredOnDemandEquiv.toString(),
      onDemandUsageMicros: merged.onDemandUsage.toString(),
      commitmentFeeMicros: merged.commitmentFee.toString(),
      coveragePercent,
      coverageBasis,
      periodOverPeriodDeltaMicros,
      cumulativeRealizedSavingsMicros: cumulative.toString(),
      isCurrentPartialPeriod: currentPeriod !== null && period === currentPeriod,
    });
  }

  return {
    currency,
    periods,
    totalRealizedSavingsMicros: cumulative.toString(),
    derivablePeriodCount,
    notDerivablePeriodCount,
  };
}

export function buildSavingsTracking(
  input: SavingsTrackingInput,
  options?: SavingsTrackingOptions,
): SavingsTrackingReport {
  const nowMs = resolveNowMs(options);
  const currentPeriod = nowMs === null ? null : new Date(nowMs).toISOString().slice(0, 7);

  const byCurrency = new Map<string, SavingsPeriodBucket[]>();
  for (const bucket of input.buckets) {
    if (!CURRENCY_RE.test(bucket.currency)) continue;
    const list = byCurrency.get(bucket.currency) ?? [];
    list.push(bucket);
    byCurrency.set(bucket.currency, list);
  }

  const series: SavingsTrackingSeries[] = [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en-US"))
    .map(([currency, currencyBuckets]) => buildSeriesForCurrency(currency, currencyBuckets, currentPeriod));

  return {
    schema: "sutra.finops-savings-tracking.v1",
    series,
    currentPeriod,
    limitations: LIMITATIONS,
    disclaimer: SAVINGS_TRACKING_DISCLAIMER,
  };
}
