import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUnitCostTrend,
  type UnitTrendInput,
} from "../lib/finops-unit-trend.ts";

const micros = (whole: number): string => String(whole * 1_000_000);

test("rising cost-per-unit across three periods: series, up direction, deltaPercent", () => {
  const input: UnitTrendInput = {
    periodsCost: [
      { period: "2024-01", amountMicros: micros(100) }, // 100 / 10 = 10 per unit
      { period: "2024-02", amountMicros: micros(240) }, // 240 / 12 = 20 per unit
      { period: "2024-03", amountMicros: micros(300) }, // 300 / 10 = 30 per unit
    ],
    unitCounts: [
      { period: "2024-01", unitLabel: "transactions", count: 10 },
      { period: "2024-02", unitLabel: "transactions", count: 12 },
      { period: "2024-03", unitLabel: "transactions", count: 10 },
    ],
  };
  const report = buildUnitCostTrend(input);
  assert.equal(report.schema, "sutra.finops-unit-trend.v1");
  assert.equal(report.metrics.length, 1);
  const metric = report.metrics[0];
  assert.equal(metric.unit, "transactions");

  // Series is chronological (ascending period) and carries raw totals + counts.
  assert.deepEqual(
    metric.series.map((point) => point.period),
    ["2024-01", "2024-02", "2024-03"],
  );
  assert.deepEqual(
    metric.series.map((point) => point.costPerUnit),
    [10_000_000, 20_000_000, 30_000_000],
  );
  assert.equal(metric.series[1].totalCost, micros(240));
  assert.equal(metric.series[1].unitCount, 12);

  // latest = 2024-03, previous = 2024-02; (30 - 20) / 20 * 100 = 50%.
  assert.equal(metric.latest?.period, "2024-03");
  assert.equal(metric.previous?.period, "2024-02");
  assert.equal(metric.deltaPercent, 50);
  assert.equal(metric.direction, "up");
});

test("a falling cost-per-unit is reported as down", () => {
  const report = buildUnitCostTrend({
    periodsCost: [
      { period: "2024-01", amountMicros: micros(300) }, // 300 / 10 = 30
      { period: "2024-02", amountMicros: micros(150) }, // 150 / 10 = 15
    ],
    unitCounts: [
      { period: "2024-01", unitLabel: "seats", count: 10 },
      { period: "2024-02", unitLabel: "seats", count: 10 },
    ],
  });
  const metric = report.metrics[0];
  // (15 - 30) / 30 * 100 = -50%.
  assert.equal(metric.deltaPercent, -50);
  assert.equal(metric.direction, "down");
});

test("a period missing its unit count is excluded from the series", () => {
  const report = buildUnitCostTrend({
    periodsCost: [
      { period: "2024-01", amountMicros: micros(100) },
      { period: "2024-02", amountMicros: micros(200) }, // has cost but NO count
      { period: "2024-03", amountMicros: micros(300) },
    ],
    unitCounts: [
      { period: "2024-01", unitLabel: "transactions", count: 10 },
      { period: "2024-03", unitLabel: "transactions", count: 10 },
    ],
  });
  const metric = report.metrics[0];
  assert.deepEqual(
    metric.series.map((point) => point.period),
    ["2024-01", "2024-03"],
  );
  // The gap collapses: latest/previous are the two counted periods.
  assert.equal(metric.latest?.period, "2024-03");
  assert.equal(metric.previous?.period, "2024-01");
});

test("a period whose count exists but whose cost is missing is excluded", () => {
  const report = buildUnitCostTrend({
    periodsCost: [{ period: "2024-01", amountMicros: micros(100) }],
    unitCounts: [
      { period: "2024-01", unitLabel: "transactions", count: 10 },
      { period: "2024-02", unitLabel: "transactions", count: 20 }, // no cost for 02
    ],
  });
  const metric = report.metrics[0];
  assert.deepEqual(
    metric.series.map((point) => point.period),
    ["2024-01"],
  );
});

test("a zero count yields costPerUnit null (never divide-by-zero)", () => {
  const report = buildUnitCostTrend({
    periodsCost: [
      { period: "2024-01", amountMicros: micros(100) },
      { period: "2024-02", amountMicros: micros(200) },
    ],
    unitCounts: [
      { period: "2024-01", unitLabel: "transactions", count: 5 },
      { period: "2024-02", unitLabel: "transactions", count: 0 },
    ],
  });
  const metric = report.metrics[0];
  // The zero-count period is still plotted (cost + count both exist) but its
  // ratio is null, and it carries the raw count.
  assert.equal(metric.series.length, 2);
  const zero = metric.series[1];
  assert.equal(zero.period, "2024-02");
  assert.equal(zero.unitCount, 0);
  assert.equal(zero.costPerUnit, null);
  // With a null endpoint the delta is not derivable and the trend reads flat.
  assert.equal(metric.deltaPercent, null);
  assert.equal(metric.direction, "flat");
});

test("a single period has no previous, no delta, and a flat direction", () => {
  const report = buildUnitCostTrend({
    periodsCost: [{ period: "2024-01", amountMicros: micros(100) }],
    unitCounts: [{ period: "2024-01", unitLabel: "transactions", count: 4 }],
  });
  const metric = report.metrics[0];
  assert.equal(metric.series.length, 1);
  assert.equal(metric.latest?.costPerUnit, 25_000_000);
  assert.equal(metric.previous, null);
  assert.equal(metric.deltaPercent, null);
  assert.equal(metric.direction, "flat");
});

test("separate unit metrics get their own series, sorted by label", () => {
  const report = buildUnitCostTrend({
    periodsCost: [{ period: "2024-01", amountMicros: micros(100) }],
    unitCounts: [
      { period: "2024-01", unitLabel: "transactions", count: 10 },
      { period: "2024-01", unitLabel: "seats", count: 5 },
    ],
  });
  assert.deepEqual(
    report.metrics.map((metric) => metric.unit),
    ["seats", "transactions"],
  );
});

test("is deterministic across identical calls", () => {
  const input: UnitTrendInput = {
    periodsCost: [
      { period: "2024-02", amountMicros: micros(240) },
      { period: "2024-01", amountMicros: micros(100) },
    ],
    unitCounts: [
      { period: "2024-02", unitLabel: "transactions", count: 12 },
      { period: "2024-01", unitLabel: "transactions", count: 10 },
    ],
  };
  const first = buildUnitCostTrend(input);
  const second = buildUnitCostTrend(input);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("empty input yields honest empty metrics with limitations and disclaimer", () => {
  const report = buildUnitCostTrend({ periodsCost: [], unitCounts: [] });
  assert.deepEqual(report.metrics, []);
  assert.ok(report.limitations.length > 0);
  assert.ok(report.disclaimer.length > 0);
});
