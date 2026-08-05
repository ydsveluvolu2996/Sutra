import assert from "node:assert/strict";
import { after, test } from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

/**
 * Pins the monthly Graviton trend series that feeds the chart on ADV-05.
 *
 * The panel previously rendered per-period totals as a grid of cards, so the
 * shape of the data was never asserted. Turning it into a chart makes two
 * properties load-bearing that a card grid could get away with ignoring:
 *
 * 1. Currencies must not share an axis. A EUR total and a USD total have no
 *    common scale, so plotting them on one axis, or summing them, would state a
 *    magnitude that does not exist.
 * 2. A period with no collected total is a GAP, not a zero. Drawing it as zero
 *    would assert a month of measured zero savings that was never collected —
 *    the exact inference the FinOps evidence rules forbid.
 */

const vite = await createServer({
  root: new URL("..", import.meta.url).pathname,
  configFile: false,
  logLevel: "silent",
  plugins: [react()],
  server: { middlewareMode: true },
});
const dashboard = await vite.ssrLoadModule("/app/costs/finops-graviton-savings-dashboard.tsx");
after(async () => vite.close());

const period = (start, currency, micros) => ({
  periodStartAt: `${start}T00:00:00.000Z`,
  periodEndAt: `${start}T00:00:00.000Z`,
  currency,
  amountMicros: micros,
});

test("each currency becomes its own chart group", () => {
  const groups = dashboard.trendsByCurrency({
    modeledPotentialByPeriod: [
      period("2026-06-01", "USD", "1000000"),
      period("2026-06-01", "EUR", "2000000"),
    ],
    measuredRealizedByPeriod: [period("2026-06-01", "USD", "500000")],
  });
  assert.deepEqual(groups.map((group) => group.currency), ["EUR", "USD"]);
  // No group mixes another currency's amounts into its series.
  for (const group of groups) {
    for (const series of group.series) {
      assert.ok(series.id.endsWith(group.currency), series.id);
    }
  }
});

test("modeled potential and measured realized stay separate series", () => {
  const [usd] = dashboard.trendsByCurrency({
    modeledPotentialByPeriod: [period("2026-06-01", "USD", "1000000")],
    measuredRealizedByPeriod: [period("2026-06-01", "USD", "250000")],
  });
  assert.equal(usd.series.length, 2);
  assert.deepEqual(usd.series.map((series) => series.label), [
    "Modeled potential",
    "Measured realized",
  ]);
  assert.equal(usd.series[0].points[0].value, 1);
  assert.equal(usd.series[1].points[0].value, 0.25);
  // Distinct tones, so the two are visually separable and never read as one.
  assert.notEqual(usd.series[0].tone, usd.series[1].tone);
});

test("a period with no collected total is a gap, never a zero", () => {
  const [usd] = dashboard.trendsByCurrency({
    modeledPotentialByPeriod: [
      period("2026-05-01", "USD", "1000000"),
      period("2026-07-01", "USD", "3000000"),
    ],
    // Realized was only ever collected for the middle month.
    measuredRealizedByPeriod: [period("2026-06-01", "USD", "2000000")],
  });
  assert.deepEqual(usd.series[0].points.map((point) => point.value), [1, null, 3]);
  assert.deepEqual(usd.series[1].points.map((point) => point.value), [null, 2, null]);
  // The absent months are explicitly null, not 0.
  for (const series of usd.series) {
    for (const point of series.points) {
      assert.notEqual(point.value, 0, "an uncollected period must not render as zero");
    }
  }
});

test("periods are ordered and labelled by month", () => {
  const [usd] = dashboard.trendsByCurrency({
    modeledPotentialByPeriod: [
      period("2026-07-01", "USD", "3000000"),
      period("2026-05-01", "USD", "1000000"),
    ],
    measuredRealizedByPeriod: [],
  });
  assert.deepEqual(usd.series[0].points.map((point) => point.label), [
    "2026-05",
    "2026-06",
    "2026-07",
  ].filter((month) => ["2026-05", "2026-07"].includes(month)));
});

test("a measured zero is preserved as a real value", () => {
  // Zero is a legitimate measurement: it means realized savings were computed
  // and came to nothing. Only an ABSENT period is a gap.
  const [usd] = dashboard.trendsByCurrency({
    modeledPotentialByPeriod: [period("2026-06-01", "USD", "0")],
    measuredRealizedByPeriod: [period("2026-06-01", "USD", "0")],
  });
  assert.equal(usd.series[0].points[0].value, 0);
  assert.equal(usd.series[1].points[0].value, 0);
});

test("negative totals keep their sign", () => {
  const [usd] = dashboard.trendsByCurrency({
    modeledPotentialByPeriod: [period("2026-06-01", "USD", "-1500000")],
    measuredRealizedByPeriod: [],
  });
  assert.equal(usd.series[0].points[0].value, -1.5);
});

test("a malformed amount is unavailable rather than zero", () => {
  const [usd] = dashboard.trendsByCurrency({
    modeledPotentialByPeriod: [period("2026-06-01", "USD", "not-a-number")],
    measuredRealizedByPeriod: [],
  });
  assert.equal(usd.series[0].points[0].value, null);
  assert.equal(dashboard.microsToNumber("1.5"), null, "micros are integers");
  assert.equal(dashboard.microsToNumber(""), null);
});

test("micro conversion is exact for values a double can hold", () => {
  assert.equal(dashboard.microsToNumber("0"), 0);
  assert.equal(dashboard.microsToNumber("1000000"), 1);
  assert.equal(dashboard.microsToNumber("1234567"), 1.234567);
  assert.equal(dashboard.microsToNumber("-2500000"), -2.5);
});

test("no currency produces no chart group rather than an empty axis", () => {
  assert.deepEqual(
    dashboard.trendsByCurrency({ modeledPotentialByPeriod: [], measuredRealizedByPeriod: [] }),
    [],
  );
});
