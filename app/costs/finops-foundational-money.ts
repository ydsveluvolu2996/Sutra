/**
 * Money helpers for charting canonical FinOps evidence.
 *
 * Every monetary figure in the canonical engines is an integer number of
 * currency micro-units carried as a decimal string, so it survives transport
 * without float drift. A chart needs a JavaScript number for geometry, and this
 * module is the only place that conversion happens.
 *
 * The conversion is exact rather than approximate. An integer count of micros is
 * represented exactly by a double up to 2^53 micros — about 9.0 billion currency
 * units — so a realistic bill converts without losing a single micro. A value
 * beyond that range, or one that is not a canonical integer string, returns
 * `null` and is excluded from the plot rather than being silently rounded.
 *
 * Exact figures shown as text still go through `formatMicrosExact` from the
 * foundational panels, which never converts to a number at all.
 */

const MICROS = /^-?(?:0|[1-9]\d*)$/u;
const MICROS_PER_UNIT = 1_000_000;

/** Largest micro magnitude a double represents exactly. */
export const MAX_EXACT_MICROS = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Convert integer micro-units to currency units for plotting.
 * Returns null when the input is absent, malformed, or too large to convert
 * without losing precision — a chart must not display a rounded number as fact.
 */
export function microsToUnits(micros: string | null | undefined): number | null {
  if (typeof micros !== "string" || !MICROS.test(micros)) return null;
  const value = BigInt(micros);
  if (value > MAX_EXACT_MICROS || value < -MAX_EXACT_MICROS) return null;
  return Number(value) / MICROS_PER_UNIT;
}

/**
 * Format currency units produced by `microsToUnits` for an axis or tooltip.
 * Up to six fraction digits, matching micro precision, with trailing zeros
 * dropped so a whole amount reads as a whole amount.
 */
export function formatUnits(value: number, currency: string): string {
  if (!Number.isFinite(value)) return "Not available";
  const code = /^[A-Z]{3}$/u.test(currency) ? currency : "USD";
  const magnitude = Math.abs(value);
  // Large axis labels stay readable; small ones keep the precision that matters.
  const fractionDigits = magnitude >= 1_000 ? 0 : magnitude >= 1 ? 2 : 6;
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  }).format(value);
  // Match the exact formatter's unicode minus so the two never disagree visually.
  return formatted.replace("-", "−");
}

/** Whole-number formatter for counts on a shared axis. */
export function formatCount(value: number): string {
  return Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)
    : "Not available";
}

/**
 * Basis points to a percentage for plotting. Accepts the integer-string form the
 * engines emit and the plain number form the KPI engine uses.
 */
export function basisPointsToPercent(value: string | number | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value / 100 : null;
  }
  if (typeof value !== "string" || !MICROS.test(value)) return null;
  const points = BigInt(value);
  if (points > MAX_EXACT_MICROS || points < -MAX_EXACT_MICROS) return null;
  return Number(points) / 100;
}

export function formatPercent(value: number): string {
  return Number.isFinite(value)
    ? `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value).replace("-", "−")}%`
    : "Not available";
}
