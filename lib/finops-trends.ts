/**
 * Pure, deterministic cost-trends + forecasting engine over ALREADY-persisted
 * CUR/FOCUS spend. It groups spend into calendar-month billing PERIODS, PER
 * CURRENCY, then derives month-over-month change, a trailing moving average,
 * and a forward forecast.
 *
 * Evidence-honesty rules (never relaxed):
 * - Currencies are NEVER summed together. One series is returned per currency;
 *   two currencies are never folded into a single scalar.
 * - Month-over-month percent is null when the prior period is 0 (division would
 *   be undefined) — the basis discloses "no prior baseline"/"prior-period-zero"
 *   rather than inventing a percentage. The first period has no prior at all, so
 *   its absolute delta and percent are both null (basis "no-prior-baseline").
 * - The trailing moving average is null during warm-up (until at least `window`
 *   periods exist) — it is never back-filled from too few points.
 * - The forecast is a deterministic least-squares LINEAR regression over the
 *   historical period totals. It always discloses the method ("linear-regression"),
 *   that the projected values are ESTIMATES (not a guarantee/quote), and the
 *   number of historical points used. Fewer than 3 historical periods → forecast
 *   is null with reason "insufficient-history" (need >= 3). A confidence band is
 *   emitted ONLY when explicitly requested AND is derived honestly from the
 *   residual standard deviation (labelled one-sigma); otherwise it is omitted —
 *   never fabricated.
 * - The clock is INJECTED (`now`/`nowMs`); Date.now() is never called. When a
 *   clock is supplied, the current calendar month is disclosed and any historical
 *   period equal to it is flagged as a partial (in-progress) period so it is not
 *   mistaken for a complete month. With no clock the engine stays fully pure and
 *   flags nothing.
 * - Money is integer micro-units via BigInt (BigInt(0), never 0n). Regression is
 *   fractional by nature, so projected values are computed in floating point over
 *   the micro totals and rounded back to integer micros, and are labelled estimates.
 */

/** One pre-bucketed spend entry: a (period, currency, service) total. */
export interface CostTrendEntry {
  /** Calendar month "YYYY-MM" (UTC), e.g. "2026-07". */
  readonly period: string;
  readonly currency: string;
  /** Service dimension for optional breakdown; null when unattributed. */
  readonly service: string | null;
  /** Summed spend for this bucket in integer micro-units (bigint-safe string). */
  readonly amountMicros: string;
  /** Number of source line items folded into this bucket. */
  readonly lineCount: number;
}

/** A line the input adapter could not bucket; disclosed, never guessed. */
export interface SkippedTrendLine {
  readonly reason: string;
}

export interface CostTrendsInput {
  readonly entries: readonly CostTrendEntry[];
  /** Optional disclosure of lines the adapter dropped (the engine ignores it). */
  readonly skipped?: readonly SkippedTrendLine[];
}

export interface CostTrendsOptions {
  /** Injected clock. Preferred over `nowMs`. Never defaults to Date.now(). */
  readonly now?: () => Date;
  /** Injected clock as epoch millis (used when `now` is absent). */
  readonly nowMs?: number;
  /** Trailing simple-moving-average window in periods (default 3, floored at 1). */
  readonly movingAverageWindow?: number;
  /** Number of future periods to forecast (default 3, floored at 0). */
  readonly forecastPeriods?: number;
  /** Minimum historical periods required to forecast (fixed floor of 3). */
  readonly minHistoryForForecast?: number;
  /** Emit a per-service breakdown series inside each currency series. */
  readonly breakdownByService?: boolean;
  /** Emit a one-sigma residual band on forecast points (derived, not invented). */
  readonly includeResidualBand?: boolean;
}

export type MomBasis = "no-prior-baseline" | "prior-period-zero" | "prior-period";

export interface CostTrendPeriod {
  readonly period: string;
  readonly totalMicros: string;
  readonly lineCount: number;
  /** current - prior in micros; null for the first period (no prior). */
  readonly momDeltaMicros: string | null;
  /** Percent change vs prior; null on first period or when the prior is 0. */
  readonly momDeltaPercent: number | null;
  readonly momBasis: MomBasis;
  /** Trailing moving average in micros; null during warm-up. */
  readonly movingAverageMicros: string | null;
  /** True only when a clock was supplied AND this period is the current month. */
  readonly isCurrentPartialPeriod: boolean;
}

export interface ForecastPoint {
  readonly period: string;
  readonly amountMicros: string;
  /** One-sigma band bounds; null unless a residual band was requested/derivable. */
  readonly bandLowMicros: string | null;
  readonly bandHighMicros: string | null;
}

export interface ResidualBand {
  readonly method: "residual-stddev-one-sigma";
  readonly sigmaMicros: string;
}

export type ForecastResult =
  | {
      readonly available: false;
      readonly reason: "insufficient-history";
      readonly historicalPointsUsed: number;
      readonly minRequired: number;
    }
  | {
      readonly available: true;
      readonly method: "linear-regression";
      /** Explicit reminder that projected values are estimates, not a quote. */
      readonly estimate: true;
      readonly historicalPointsUsed: number;
      /** Regression slope in micros per period (fractional). */
      readonly slopeMicrosPerPeriod: number;
      /** Regression intercept in micros at period index 0 (fractional). */
      readonly interceptMicros: number;
      readonly points: readonly ForecastPoint[];
      readonly residualBand: ResidualBand | null;
      readonly disclaimer: string;
    };

export interface CostTrendServiceSeries {
  readonly service: string;
  readonly periods: readonly CostTrendPeriod[];
  readonly forecast: ForecastResult;
}

export interface CostTrendSeries {
  readonly currency: string;
  readonly movingAverageWindow: number;
  readonly periods: readonly CostTrendPeriod[];
  readonly forecast: ForecastResult;
  /** Per-service sub-series when `breakdownByService` is set; otherwise null. */
  readonly serviceBreakdown: readonly CostTrendServiceSeries[] | null;
}

export interface CostTrendsReport {
  readonly schema: "sutra.finops-trends.v1";
  readonly series: readonly CostTrendSeries[];
  /** Current calendar month "YYYY-MM" from the injected clock, or null. */
  readonly currentPeriod: string | null;
  readonly options: {
    readonly movingAverageWindow: number;
    readonly forecastPeriods: number;
    readonly minHistoryForForecast: number;
    readonly breakdownByService: boolean;
    readonly includeResidualBand: boolean;
  };
  readonly limitations: readonly string[];
  readonly disclaimer: string;
}

export const COST_TRENDS_DISCLAIMER =
  "Cost trends group persisted billing line items into calendar-month periods, per " +
  "currency (currencies are never summed together). Month-over-month percent is null " +
  "when there is no prior baseline. The forecast is a deterministic linear-regression " +
  "ESTIMATE over the historical period totals — not a guarantee, not an AWS quote, and " +
  "not a savings claim. Periods are treated as evenly spaced; missing months are not " +
  "interpolated. Any current in-progress month is flagged as partial when a clock is supplied.";

const FORECAST_DISCLAIMER =
  "PROJECTED_VALUES_ARE_LINEAR_REGRESSION_ESTIMATES_NOT_A_GUARANTEE_OR_QUOTE";

const LIMITATIONS: readonly string[] = [
  "TRENDS_ARE_COMPUTED_OVER_ALREADY_PERSISTED_BILLING_LINES_NO_NEW_INGESTION",
  "CURRENCIES_ARE_NEVER_SUMMED_ONE_SERIES_PER_CURRENCY",
  "FORECAST_NEEDS_AT_LEAST_3_HISTORICAL_PERIODS_ELSE_NULL_WITH_REASON",
  "FORECAST_IS_A_LINEAR_REGRESSION_ESTIMATE_NOT_A_GUARANTEE",
  "PERIODS_ARE_TREATED_AS_EVENLY_SPACED_MISSING_MONTHS_ARE_NOT_INTERPOLATED",
  "A_CONFIDENCE_BAND_IS_EMITTED_ONLY_WHEN_REQUESTED_AND_DERIVED_FROM_RESIDUAL_STDDEV",
];

const MICROS_INT = /^-?\d+$/u;
const PERIOD_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
/** Fixed floor: a linear trend below 3 points is not disclosed as a forecast. */
const MIN_HISTORY_FLOOR = 3;

interface ResolvedOptions {
  readonly currentPeriod: string | null;
  readonly movingAverageWindow: number;
  readonly forecastPeriods: number;
  readonly minHistoryForForecast: number;
  readonly breakdownByService: boolean;
  readonly includeResidualBand: boolean;
}

function resolveNowMs(options?: CostTrendsOptions): number | null {
  if (options?.now !== undefined) {
    const value = options.now().getTime();
    return Number.isFinite(value) ? value : null;
  }
  if (typeof options?.nowMs === "number" && Number.isFinite(options.nowMs)) return options.nowMs;
  return null;
}

function periodFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

function resolveOptions(options?: CostTrendsOptions): ResolvedOptions {
  const nowMs = resolveNowMs(options);
  return {
    currentPeriod: nowMs === null ? null : periodFromMs(nowMs),
    movingAverageWindow: Math.max(1, Math.trunc(options?.movingAverageWindow ?? 3)),
    forecastPeriods: Math.max(0, Math.trunc(options?.forecastPeriods ?? 3)),
    minHistoryForForecast: Math.max(MIN_HISTORY_FLOOR, Math.trunc(options?.minHistoryForForecast ?? MIN_HISTORY_FLOOR)),
    breakdownByService: options?.breakdownByService === true,
    includeResidualBand: options?.includeResidualBand === true,
  };
}

/** Add `n` calendar months to a "YYYY-MM" period label (deterministic, UTC-agnostic). */
function addMonths(period: string, n: number): string {
  const [yearRaw, monthRaw] = period.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const zeroBased = year * 12 + (month - 1) + n;
  const newYear = Math.floor(zeroBased / 12);
  const newMonth = zeroBased - newYear * 12 + 1;
  return `${String(newYear).padStart(4, "0")}-${String(newMonth).padStart(2, "0")}`;
}

function roundPercent(value: number): number {
  return Math.round(value * 10000) / 10000;
}

interface PeriodTotal {
  readonly period: string;
  readonly micros: bigint;
  readonly lineCount: number;
}

/** Sum a currency's entries into an ascending, deduplicated period timeline. */
function toPeriodTotals(entries: readonly CostTrendEntry[]): PeriodTotal[] {
  const byPeriod = new Map<string, { micros: bigint; lineCount: number }>();
  for (const entry of entries) {
    if (!PERIOD_RE.test(entry.period) || !MICROS_INT.test(entry.amountMicros)) continue;
    const bucket = byPeriod.get(entry.period) ?? { micros: BigInt(0), lineCount: 0 };
    bucket.micros += BigInt(entry.amountMicros);
    bucket.lineCount += Number.isFinite(entry.lineCount) ? Math.max(0, Math.trunc(entry.lineCount)) : 0;
    byPeriod.set(entry.period, bucket);
  }
  return [...byPeriod.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en-US"))
    .map(([period, bucket]) => ({ period, micros: bucket.micros, lineCount: bucket.lineCount }));
}

function buildPeriods(totals: readonly PeriodTotal[], options: ResolvedOptions): CostTrendPeriod[] {
  const periods: CostTrendPeriod[] = [];
  for (let i = 0; i < totals.length; i += 1) {
    const current = totals[i];
    const prior = i > 0 ? totals[i - 1] : null;

    let momDeltaMicros: string | null = null;
    let momDeltaPercent: number | null = null;
    let momBasis: MomBasis = "no-prior-baseline";
    if (prior !== null) {
      const delta = current.micros - prior.micros;
      momDeltaMicros = delta.toString();
      if (prior.micros === BigInt(0)) {
        momDeltaPercent = null;
        momBasis = "prior-period-zero";
      } else {
        momDeltaPercent = roundPercent((Number(delta) / Number(prior.micros)) * 100);
        momBasis = "prior-period";
      }
    }

    // Trailing simple moving average: null until `window` periods are available.
    let movingAverageMicros: string | null = null;
    if (i + 1 >= options.movingAverageWindow) {
      let sum = BigInt(0);
      for (let j = i - options.movingAverageWindow + 1; j <= i; j += 1) sum += totals[j].micros;
      movingAverageMicros = (sum / BigInt(options.movingAverageWindow)).toString();
    }

    periods.push({
      period: current.period,
      totalMicros: current.micros.toString(),
      lineCount: current.lineCount,
      momDeltaMicros,
      momDeltaPercent,
      momBasis,
      movingAverageMicros,
      isCurrentPartialPeriod: options.currentPeriod !== null && current.period === options.currentPeriod,
    });
  }
  return periods;
}

function buildForecast(totals: readonly PeriodTotal[], options: ResolvedOptions): ForecastResult {
  const n = totals.length;
  if (n < options.minHistoryForForecast) {
    return {
      available: false,
      reason: "insufficient-history",
      historicalPointsUsed: n,
      minRequired: options.minHistoryForForecast,
    };
  }

  // Ordinal least squares over evenly-spaced period indices 0..n-1.
  const ys = totals.map((point) => Number(point.micros));
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = i - meanX;
    numerator += dx * (ys[i] - meanY);
    denominator += dx * dx;
  }
  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = meanY - slope * meanX;

  // Residual standard deviation (population) for an honest, derived band only.
  let residualBand: ResidualBand | null = null;
  if (options.includeResidualBand) {
    let sumSq = 0;
    for (let i = 0; i < n; i += 1) {
      const residual = ys[i] - (intercept + slope * i);
      sumSq += residual * residual;
    }
    const sigma = Math.sqrt(sumSq / n);
    residualBand = { method: "residual-stddev-one-sigma", sigmaMicros: String(Math.round(sigma)) };
  }

  const lastPeriod = totals[n - 1].period;
  const points: ForecastPoint[] = [];
  for (let step = 1; step <= options.forecastPeriods; step += 1) {
    const index = n - 1 + step;
    const projected = Math.round(intercept + slope * index);
    let bandLowMicros: string | null = null;
    let bandHighMicros: string | null = null;
    if (residualBand !== null) {
      const sigma = Number(residualBand.sigmaMicros);
      bandLowMicros = String(Math.round(projected - sigma));
      bandHighMicros = String(Math.round(projected + sigma));
    }
    points.push({
      period: addMonths(lastPeriod, step),
      amountMicros: String(projected),
      bandLowMicros,
      bandHighMicros,
    });
  }

  return {
    available: true,
    method: "linear-regression",
    estimate: true,
    historicalPointsUsed: n,
    slopeMicrosPerPeriod: slope,
    interceptMicros: intercept,
    points,
    residualBand,
    disclaimer: FORECAST_DISCLAIMER,
  };
}

function buildServiceBreakdown(
  entries: readonly CostTrendEntry[],
  options: ResolvedOptions,
): CostTrendServiceSeries[] {
  const byService = new Map<string, CostTrendEntry[]>();
  for (const entry of entries) {
    const service = entry.service === null || entry.service.length === 0 ? "Unattributed" : entry.service;
    const list = byService.get(service) ?? [];
    list.push(entry);
    byService.set(service, list);
  }
  return [...byService.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en-US"))
    .map(([service, serviceEntries]) => {
      const totals = toPeriodTotals(serviceEntries);
      return {
        service,
        periods: buildPeriods(totals, options),
        forecast: buildForecast(totals, options),
      };
    });
}

export function buildCostTrends(input: CostTrendsInput, options?: CostTrendsOptions): CostTrendsReport {
  const resolved = resolveOptions(options);

  const byCurrency = new Map<string, CostTrendEntry[]>();
  for (const entry of input.entries) {
    if (!/^[A-Z]{3}$/u.test(entry.currency)) continue;
    const list = byCurrency.get(entry.currency) ?? [];
    list.push(entry);
    byCurrency.set(entry.currency, list);
  }

  const series: CostTrendSeries[] = [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en-US"))
    .map(([currency, currencyEntries]) => {
      const totals = toPeriodTotals(currencyEntries);
      return {
        currency,
        movingAverageWindow: resolved.movingAverageWindow,
        periods: buildPeriods(totals, resolved),
        forecast: buildForecast(totals, resolved),
        serviceBreakdown: resolved.breakdownByService ? buildServiceBreakdown(currencyEntries, resolved) : null,
      };
    });

  return {
    schema: "sutra.finops-trends.v1",
    series,
    currentPeriod: resolved.currentPeriod,
    options: {
      movingAverageWindow: resolved.movingAverageWindow,
      forecastPeriods: resolved.forecastPeriods,
      minHistoryForForecast: resolved.minHistoryForForecast,
      breakdownByService: resolved.breakdownByService,
      includeResidualBand: resolved.includeResidualBand,
    },
    limitations: LIMITATIONS,
    disclaimer: COST_TRENDS_DISCLAIMER,
  };
}
