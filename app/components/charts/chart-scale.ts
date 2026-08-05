/**
 * Pure geometry for the Sutra chart kit.
 *
 * Every function here is deterministic and free of React, the DOM and the wall
 * clock, so chart output is identical on the server and in the browser and can
 * be asserted exactly in tests. Honesty rules that the callers depend on:
 *
 * - A domain is never widened to include zero unless the data crosses zero or a
 *   caller asks for it. A chart must not imply a zero baseline that the evidence
 *   does not contain.
 * - Negative values are first-class. FinOps evidence legitimately contains
 *   credits, refunds and negative amortization, and clamping them to zero would
 *   misstate spend.
 * - A single-point or flat series is reported as such rather than being scaled
 *   into a misleading full-height bar or a divide-by-zero.
 */

/** Inclusive numeric domain. `min` is always <= `max`. */
export interface ChartDomain {
  readonly min: number;
  readonly max: number;
}

/** Pixel extent a domain is projected onto. */
export interface ChartRange {
  readonly start: number;
  readonly end: number;
}

export interface ChartPlotArea {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface ChartPadding {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export class ChartGeometryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChartGeometryError";
  }
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new ChartGeometryError(`CHART_${label}_NOT_FINITE`);
  }
}

/**
 * Round to a fixed number of decimals so emitted SVG coordinates are stable
 * strings rather than long binary-float expansions. Three decimals is well
 * below one device pixel at any realistic chart size.
 */
export function roundCoordinate(value: number): number {
  assertFinite(value, "COORDINATE");
  return Math.round(value * 1_000) / 1_000;
}

/**
 * Compute the domain of a set of values.
 *
 * `includeZero` extends the domain to the zero baseline, which is correct for
 * bar charts (a bar's length is only meaningful against zero) and wrong for
 * trend lines of large, narrowly varying values, where it would flatten the
 * very variation the chart exists to show.
 */
export function domainOf(
  values: readonly number[],
  { includeZero = false }: { readonly includeZero?: boolean } = {},
): ChartDomain | null {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return null;

  let min = finite[0]!;
  let max = finite[0]!;
  for (const value of finite) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  return { min, max };
}

/**
 * Give a degenerate (zero-width) domain a symmetric span so a flat series draws
 * as a centred line instead of dividing by zero. A flat zero series gets a unit
 * span; any other flat value gets ±10% of its magnitude.
 */
export function padDegenerateDomain(domain: ChartDomain): ChartDomain {
  if (domain.max > domain.min) return domain;
  const magnitude = Math.abs(domain.max);
  const span = magnitude === 0 ? 1 : magnitude * 0.1;
  return { min: domain.min - span, max: domain.max + span };
}

/**
 * Project a domain value onto a pixel range. `range.start` may be greater than
 * `range.end`, which is how a value axis is inverted for SVG's downward y.
 * Values outside the domain project outside the range rather than being
 * clamped, so a caller can detect and handle overflow explicitly.
 */
export function projectValue(
  value: number,
  domain: ChartDomain,
  range: ChartRange,
): number {
  assertFinite(value, "VALUE");
  const span = domain.max - domain.min;
  if (span === 0) {
    return roundCoordinate((range.start + range.end) / 2);
  }
  const ratio = (value - domain.min) / span;
  return roundCoordinate(range.start + ratio * (range.end - range.start));
}

/**
 * Evenly spaced band positions for categorical data, matching the conventional
 * band scale: each category owns a slot of `step` pixels and occupies
 * `step * (1 - padding)` of it, centred.
 */
export interface ChartBand {
  readonly start: number;
  readonly center: number;
  readonly width: number;
}

export function bandScale(
  count: number,
  range: ChartRange,
  { padding = 0.2 }: { readonly padding?: number } = {},
): readonly ChartBand[] {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new ChartGeometryError("CHART_BAND_COUNT_INVALID");
  }
  if (padding < 0 || padding >= 1) {
    throw new ChartGeometryError("CHART_BAND_PADDING_INVALID");
  }
  if (count === 0) return [];

  const extent = range.end - range.start;
  const step = extent / count;
  const width = step * (1 - padding);
  const offset = (step - width) / 2;

  return Object.freeze(Array.from({ length: count }, (_unused, index) => {
    const start = range.start + step * index + offset;
    return Object.freeze({
      start: roundCoordinate(start),
      center: roundCoordinate(start + width / 2),
      width: roundCoordinate(width),
    });
  }));
}

const TICK_STEPS = [1, 2, 2.5, 5, 10] as const;

/**
 * Human-readable tick values covering a domain, using the standard 1/2/2.5/5/10
 * progression. The returned ticks are aligned to the step, so they land on round
 * numbers, and always span the whole domain.
 */
export function niceTicks(domain: ChartDomain, desiredCount = 5): readonly number[] {
  assertFinite(domain.min, "DOMAIN_MIN");
  assertFinite(domain.max, "DOMAIN_MAX");
  if (!Number.isSafeInteger(desiredCount) || desiredCount < 2) {
    throw new ChartGeometryError("CHART_TICK_COUNT_INVALID");
  }

  const padded = padDegenerateDomain(domain);
  const rawStep = (padded.max - padded.min) / (desiredCount - 1);
  if (rawStep <= 0) return Object.freeze([padded.min]);

  const exponent = Math.floor(Math.log10(rawStep));
  const magnitude = 10 ** exponent;
  const normalized = rawStep / magnitude;
  const chosen = TICK_STEPS.find((candidate) => normalized <= candidate) ?? 10;
  const step = chosen * magnitude;

  /*
   * Decimal places the step genuinely needs. Multiplying back by the step is not
   * enough to shed float error — `3 * 0.1` is 0.30000000000000004 — so each tick
   * is rounded to the precision the step implies. The only fractional multiplier
   * in the 1/2/2.5/5/10 progression is 2.5, which needs one extra place.
   */
  const decimals = Math.min(20, Math.max(0, -exponent + (chosen === 2.5 ? 1 : 0)));

  const first = Math.floor(padded.min / step) * step;
  const ticks: number[] = [];
  // Bounded so a pathological domain/step ratio cannot spin; the tick count is
  // presentation detail and never worth hanging a render over.
  for (let index = 0; index < 64; index += 1) {
    const value = Number((first + step * index).toFixed(decimals));
    ticks.push(Object.is(value, -0) ? 0 : value);
    if (value >= padded.max) break;
  }
  return Object.freeze(ticks);
}

/** Resolve the plot area left after axis padding. */
export function plotArea(
  width: number,
  height: number,
  padding: ChartPadding,
): ChartPlotArea {
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  if (plotWidth <= 0 || plotHeight <= 0) {
    throw new ChartGeometryError("CHART_PLOT_AREA_EMPTY");
  }
  return {
    left: padding.left,
    top: padding.top,
    width: plotWidth,
    height: plotHeight,
  };
}

export interface ChartPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Straight-segment path through the given points. Deliberately not smoothed: a
 * spline through sampled cost data invents values between real observations.
 */
export function linePath(points: readonly ChartPoint[]): string {
  if (points.length === 0) return "";
  return points
    .map((point, index) =>
      `${index === 0 ? "M" : "L"}${roundCoordinate(point.x)} ${roundCoordinate(point.y)}`)
    .join(" ");
}

/** Closed area path from a line down to a baseline. */
export function areaPath(points: readonly ChartPoint[], baselineY: number): string {
  if (points.length === 0) return "";
  const baseline = roundCoordinate(baselineY);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return [
    linePath(points),
    `L${roundCoordinate(last.x)} ${baseline}`,
    `L${roundCoordinate(first.x)} ${baseline}`,
    "Z",
  ].join(" ");
}

/**
 * Arc path for one donut segment, expressed from a start and end fraction of the
 * whole so callers never have to reason in radians.
 */
export function donutSegmentPath(
  startFraction: number,
  endFraction: number,
  { cx, cy, outerRadius, innerRadius }: {
    readonly cx: number;
    readonly cy: number;
    readonly outerRadius: number;
    readonly innerRadius: number;
  },
): string {
  if (innerRadius < 0 || outerRadius <= innerRadius) {
    throw new ChartGeometryError("CHART_DONUT_RADIUS_INVALID");
  }
  const sweep = endFraction - startFraction;
  if (sweep <= 0) return "";

  // A full ring has no arc endpoints to join, so draw it as two half sweeps.
  if (sweep >= 1) {
    return [
      donutSegmentPath(0, 0.5, { cx, cy, outerRadius, innerRadius }),
      donutSegmentPath(0.5, 1, { cx, cy, outerRadius, innerRadius }),
    ].join(" ");
  }

  const TAU = Math.PI * 2;
  // Start at 12 o'clock and sweep clockwise, which is how a reader expects a
  // composition ring to be ordered.
  const startAngle = startFraction * TAU - Math.PI / 2;
  const endAngle = endFraction * TAU - Math.PI / 2;
  const largeArc = sweep > 0.5 ? 1 : 0;

  const point = (radius: number, angle: number) => ({
    x: roundCoordinate(cx + radius * Math.cos(angle)),
    y: roundCoordinate(cy + radius * Math.sin(angle)),
  });
  const outerStart = point(outerRadius, startAngle);
  const outerEnd = point(outerRadius, endAngle);
  const innerEnd = point(innerRadius, endAngle);
  const innerStart = point(innerRadius, startAngle);

  return [
    `M${outerStart.x} ${outerStart.y}`,
    `A${roundCoordinate(outerRadius)} ${roundCoordinate(outerRadius)} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L${innerEnd.x} ${innerEnd.y}`,
    `A${roundCoordinate(innerRadius)} ${roundCoordinate(innerRadius)} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    "Z",
  ].join(" ");
}

/**
 * Cumulative fractions for a composition chart. Returns null when the parts do
 * not describe a proportion — no parts, a non-positive total, or any negative
 * part — because a share of a meaningless total must not be drawn.
 */
export interface ChartFraction {
  readonly startFraction: number;
  readonly endFraction: number;
  readonly fraction: number;
}

export function fractionsOf(values: readonly number[]): readonly ChartFraction[] | null {
  if (values.length === 0) return null;
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;

  let cursor = 0;
  const fractions = values.map((value) => {
    const fraction = value / total;
    const startFraction = cursor;
    cursor += fraction;
    return Object.freeze({ startFraction, endFraction: cursor, fraction });
  });
  return Object.freeze(fractions);
}
