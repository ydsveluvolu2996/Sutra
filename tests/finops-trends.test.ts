import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCostTrends,
  type CostTrendEntry,
  type CostTrendsInput,
} from "../lib/finops-trends.ts";

const units = (whole: number): string => String(whole * 1_000_000);

function entry(over: Partial<CostTrendEntry> & { period: string; amountUnits: number }): CostTrendEntry {
  return {
    period: over.period,
    currency: over.currency ?? "USD",
    service: over.service ?? "AmazonEC2",
    amountMicros: units(over.amountUnits),
    lineCount: over.lineCount ?? 1,
  };
}

function input(entries: readonly CostTrendEntry[]): CostTrendsInput {
  return { entries };
}

// A fixed clock in a month AFTER all the test data, so nothing is flagged partial
// unless a test explicitly targets the current month.
const CLOCK = () => new Date("2027-01-15T00:00:00.000Z");

test("computes month-over-month absolute and percent deltas across periods", () => {
  const report = buildCostTrends(
    input([
      entry({ period: "2026-01", amountUnits: 100 }),
      entry({ period: "2026-02", amountUnits: 150 }),
      entry({ period: "2026-03", amountUnits: 120 }),
    ]),
    { now: CLOCK },
  );
  const [series] = report.series;
  assert.equal(series.currency, "USD");
  assert.equal(series.periods.length, 3);

  // First period: no prior baseline.
  assert.equal(series.periods[0].momDeltaMicros, null);
  assert.equal(series.periods[0].momDeltaPercent, null);
  assert.equal(series.periods[0].momBasis, "no-prior-baseline");

  // 100 -> 150: +50 units, +50%.
  assert.equal(series.periods[1].momDeltaMicros, units(50));
  assert.equal(series.periods[1].momDeltaPercent, 50);
  assert.equal(series.periods[1].momBasis, "prior-period");

  // 150 -> 120: -30 units, -20%.
  assert.equal(series.periods[2].momDeltaMicros, units(-30));
  assert.equal(series.periods[2].momDeltaPercent, -20);
});

test("month-over-month percent is null (not fabricated) when the prior period is 0", () => {
  const report = buildCostTrends(
    input([
      entry({ period: "2026-01", amountUnits: 0 }),
      entry({ period: "2026-02", amountUnits: 200 }),
    ]),
    { now: CLOCK },
  );
  const [series] = report.series;
  const second = series.periods[1];
  // Absolute delta is still derivable, but percent has no baseline.
  assert.equal(second.momDeltaMicros, units(200));
  assert.equal(second.momDeltaPercent, null);
  assert.equal(second.momBasis, "prior-period-zero");
});

test("moving average is null during warm-up, then a trailing average", () => {
  const report = buildCostTrends(
    input([
      entry({ period: "2026-01", amountUnits: 100 }),
      entry({ period: "2026-02", amountUnits: 200 }),
      entry({ period: "2026-03", amountUnits: 300 }),
      entry({ period: "2026-04", amountUnits: 600 }),
    ]),
    { now: CLOCK, movingAverageWindow: 3 },
  );
  const [series] = report.series;
  assert.equal(series.movingAverageWindow, 3);
  // Warm-up: first two periods have no 3-period window yet.
  assert.equal(series.periods[0].movingAverageMicros, null);
  assert.equal(series.periods[1].movingAverageMicros, null);
  // (100+200+300)/3 = 200
  assert.equal(series.periods[2].movingAverageMicros, units(200));
  // (200+300+600)/3 = 366.67 -> floor in micros
  assert.equal(series.periods[3].movingAverageMicros, String(Math.floor((200 + 300 + 600) * 1_000_000 / 3)));
});

test("linear forecast on a clean increasing series projects the correct slope", () => {
  const report = buildCostTrends(
    input([
      entry({ period: "2026-01", amountUnits: 100 }),
      entry({ period: "2026-02", amountUnits: 200 }),
      entry({ period: "2026-03", amountUnits: 300 }),
    ]),
    { now: CLOCK, forecastPeriods: 3 },
  );
  const forecast = report.series[0].forecast;
  assert.equal(forecast.available, true);
  if (!forecast.available) return;
  assert.equal(forecast.method, "linear-regression");
  assert.equal(forecast.estimate, true);
  assert.equal(forecast.historicalPointsUsed, 3);
  // Slope is +100 units per period.
  assert.equal(forecast.slopeMicrosPerPeriod, 100 * 1_000_000);
  assert.equal(forecast.points.length, 3);
  // Projected next three months: 400, 500, 600 units.
  assert.deepEqual(
    forecast.points.map((p) => p.period),
    ["2026-04", "2026-05", "2026-06"],
  );
  assert.deepEqual(
    forecast.points.map((p) => p.amountMicros),
    [units(400), units(500), units(600)],
  );
  // No band was requested, so none is fabricated.
  assert.equal(forecast.residualBand, null);
  assert.equal(forecast.points[0].bandLowMicros, null);
});

test("a residual band, when requested, is derived from residuals (zero for a perfect line)", () => {
  const report = buildCostTrends(
    input([
      entry({ period: "2026-01", amountUnits: 100 }),
      entry({ period: "2026-02", amountUnits: 200 }),
      entry({ period: "2026-03", amountUnits: 300 }),
    ]),
    { now: CLOCK, includeResidualBand: true },
  );
  const forecast = report.series[0].forecast;
  assert.equal(forecast.available, true);
  if (!forecast.available) return;
  assert.notEqual(forecast.residualBand, null);
  assert.equal(forecast.residualBand?.method, "residual-stddev-one-sigma");
  // Perfectly linear -> zero residual sigma; band equals the point estimate.
  assert.equal(forecast.residualBand?.sigmaMicros, "0");
  assert.equal(forecast.points[0].bandLowMicros, forecast.points[0].amountMicros);
});

test("insufficient history (< 3 periods) yields a null forecast with a reason", () => {
  const report = buildCostTrends(
    input([
      entry({ period: "2026-01", amountUnits: 100 }),
      entry({ period: "2026-02", amountUnits: 200 }),
    ]),
    { now: CLOCK },
  );
  const forecast = report.series[0].forecast;
  assert.equal(forecast.available, false);
  if (forecast.available) return;
  assert.equal(forecast.reason, "insufficient-history");
  assert.equal(forecast.historicalPointsUsed, 2);
  assert.equal(forecast.minRequired, 3);
});

test("currencies are isolated into separate series and never merged", () => {
  const report = buildCostTrends(
    input([
      entry({ period: "2026-01", amountUnits: 100, currency: "USD" }),
      entry({ period: "2026-02", amountUnits: 200, currency: "USD" }),
      entry({ period: "2026-03", amountUnits: 300, currency: "USD" }),
      entry({ period: "2026-01", amountUnits: 10, currency: "EUR" }),
      entry({ period: "2026-02", amountUnits: 20, currency: "EUR" }),
      entry({ period: "2026-03", amountUnits: 30, currency: "EUR" }),
    ]),
    { now: CLOCK },
  );
  assert.equal(report.series.length, 2);
  assert.deepEqual(report.series.map((s) => s.currency), ["EUR", "USD"]);
  const eur = report.series[0];
  const usd = report.series[1];
  // The EUR series total is not contaminated by USD spend.
  assert.equal(eur.periods[0].totalMicros, units(10));
  assert.equal(usd.periods[0].totalMicros, units(100));
  // Each currency forecasts on its own slope.
  if (usd.forecast.available) assert.equal(usd.forecast.slopeMicrosPerPeriod, 100 * 1_000_000);
  if (eur.forecast.available) assert.equal(eur.forecast.slopeMicrosPerPeriod, 10 * 1_000_000);
});

test("flags the current in-progress month as partial when a clock is supplied", () => {
  const report = buildCostTrends(
    input([
      entry({ period: "2026-05", amountUnits: 100 }),
      entry({ period: "2026-06", amountUnits: 200 }),
    ]),
    { now: () => new Date("2026-06-10T00:00:00.000Z") },
  );
  assert.equal(report.currentPeriod, "2026-06");
  const [series] = report.series;
  assert.equal(series.periods[0].isCurrentPartialPeriod, false);
  assert.equal(series.periods[1].isCurrentPartialPeriod, true);
});

test("no clock keeps the engine pure and flags nothing partial", () => {
  const report = buildCostTrends(
    input([entry({ period: "2026-06", amountUnits: 200 })]),
  );
  assert.equal(report.currentPeriod, null);
  assert.equal(report.series[0].periods[0].isCurrentPartialPeriod, false);
});

test("optional per-service breakdown honors the same rules", () => {
  const report = buildCostTrends(
    input([
      entry({ period: "2026-01", amountUnits: 60, service: "AmazonEC2" }),
      entry({ period: "2026-02", amountUnits: 90, service: "AmazonEC2" }),
      entry({ period: "2026-03", amountUnits: 120, service: "AmazonEC2" }),
      entry({ period: "2026-01", amountUnits: 40, service: "AmazonS3" }),
    ]),
    { now: CLOCK, breakdownByService: true },
  );
  const [series] = report.series;
  assert.notEqual(series.serviceBreakdown, null);
  const services = series.serviceBreakdown ?? [];
  assert.deepEqual(services.map((s) => s.service), ["AmazonEC2", "AmazonS3"]);
  // EC2 has 3 periods -> forecast available; S3 has 1 -> insufficient history.
  assert.equal(services[0].forecast.available, true);
  assert.equal(services[1].forecast.available, false);
});

test("empty input produces an honest empty result, not fabricated series", () => {
  const report = buildCostTrends(input([]), { now: CLOCK });
  assert.deepEqual(report.series, []);
  assert.equal(report.schema, "sutra.finops-trends.v1");
  assert.ok(report.disclaimer.length > 0);
  assert.ok(report.limitations.length > 0);
});

test("is deterministic across identical calls", () => {
  const built = input([
    entry({ period: "2026-02", amountUnits: 200 }),
    entry({ period: "2026-01", amountUnits: 100 }),
    entry({ period: "2026-03", amountUnits: 300 }),
  ]);
  const first = buildCostTrends(built, { now: CLOCK });
  const second = buildCostTrends(built, { now: CLOCK });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
