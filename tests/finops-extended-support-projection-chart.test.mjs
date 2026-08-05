import assert from "node:assert/strict";
import { after, test } from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

/**
 * Pins the per-currency projected-cost ranking that feeds the charts on ADV-02.
 *
 * The panel previously rendered one card per (service, currency) pair, so the
 * shape of the data was never asserted and nothing stopped two currencies from
 * being read side by side as comparable magnitudes. Charting it makes three
 * properties load-bearing:
 *
 * 1. Currency is a grouping key, not a label. A EUR projection and a USD
 *    projection share no scale, so they never share an axis and are never
 *    ranked against each other.
 * 2. An absent or inexact amount is omitted and counted, never plotted as zero.
 *    An uncollected projection is not a projection of no incremental cost.
 * 3. The figure printed beside a bar is formatted from the original micros, not
 *    from the plot coordinate, so a monetary amount is never shown rounded.
 */

const vite = await createServer({
  root: new URL("..", import.meta.url).pathname,
  configFile: false,
  logLevel: "silent",
  plugins: [react()],
  server: { middlewareMode: true },
});
const dashboard = await vite.ssrLoadModule(
  "/app/costs/finops-extended-support-projection-dashboard.tsx",
);
after(async () => vite.close());

const service = (name, costs) => ({
  service: name,
  horizon: { projectedIncrementalCosts: costs },
});
const money = (currency, amountMicros) => ({ currency, amountMicros });

test("each currency becomes its own chart group, ordered by currency", () => {
  const groups = dashboard.projectedCostsByCurrency({
    services: [
      service("RDS", [money("USD", "5000000"), money("EUR", "9000000")]),
      service("EKS", [money("USD", "1000000")]),
    ],
  });
  assert.deepEqual(groups.map((group) => group.currency), ["EUR", "USD"]);
  // No group carries another currency's amounts.
  for (const group of groups) {
    for (const item of group.items) {
      assert.ok(item.id.endsWith(group.currency), item.id);
    }
  }
});

test("services rank descending within a currency, never across currencies", () => {
  const [eur, usd] = dashboard.projectedCostsByCurrency({
    services: [
      // The EUR amount is numerically the largest, but must not outrank USD rows
      // in the USD chart — it is not in that chart at all.
      service("OpenSearch", [money("EUR", "99000000")]),
      service("RDS", [money("USD", "5000000")]),
      service("EKS", [money("USD", "7000000")]),
    ],
  });
  assert.deepEqual(eur.items.map((item) => item.label), ["OpenSearch"]);
  assert.deepEqual(usd.items.map((item) => item.label), ["EKS", "RDS"]);
  assert.deepEqual(usd.items.map((item) => item.value), [7, 5]);
});

test("the amount beside each bar is formatted from exact micros", () => {
  const [usd] = dashboard.projectedCostsByCurrency({
    services: [service("RDS", [money("USD", "1234567")])],
  });
  assert.equal(usd.items[0].detail, "USD 1.234567");
  assert.equal(usd.items[0].value, 1.234567);
});

test("a malformed or absent amount is omitted and counted, never zero", () => {
  const [usd] = dashboard.projectedCostsByCurrency({
    services: [
      service("RDS", [money("USD", "2000000")]),
      service("EKS", [money("USD", "not-a-number")]),
      service("ElastiCache", [money("USD", "1.5")]),
    ],
  });
  assert.deepEqual(usd.items.map((item) => item.label), ["RDS"]);
  assert.equal(usd.omittedCount, 2);
  for (const item of usd.items) {
    assert.notEqual(item.value, 0, "an uncollected projection must not plot as zero");
  }
});

test("a measured zero projection is a real value and stays plotted", () => {
  const [usd] = dashboard.projectedCostsByCurrency({
    services: [service("RDS", [money("USD", "0")])],
  });
  assert.deepEqual(usd.items.map((item) => item.value), [0]);
  assert.equal(usd.omittedCount, 0);
});

test("a negative projection keeps its sign", () => {
  const [usd] = dashboard.projectedCostsByCurrency({
    services: [service("RDS", [money("USD", "-2500000")])],
  });
  assert.equal(usd.items[0].value, -2.5);
  // The dashboard's existing money() formatter puts the sign before the
  // currency code; the ranking reuses it rather than inventing a second format.
  assert.equal(usd.items[0].detail, "-USD 2.5");
});

test("an amount too large for an exact plot coordinate is omitted, not rounded", () => {
  const beyondExact = String(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
  const [usd] = dashboard.projectedCostsByCurrency({
    services: [service("RDS", [money("USD", beyondExact)])],
  });
  assert.deepEqual(usd.items, []);
  assert.equal(usd.omittedCount, 1);
  assert.equal(dashboard.microsToNumber(beyondExact), null);
  // The largest exactly representable micro amount is still plotted.
  assert.equal(
    dashboard.microsToNumber(String(Number.MAX_SAFE_INTEGER)),
    Number.MAX_SAFE_INTEGER / 1_000_000,
  );
});

test("micro conversion is exact for values a double can hold", () => {
  assert.equal(dashboard.microsToNumber("0"), 0);
  assert.equal(dashboard.microsToNumber("1000000"), 1);
  assert.equal(dashboard.microsToNumber("1234567"), 1.234567);
  assert.equal(dashboard.microsToNumber("-2500000"), -2.5);
  assert.equal(dashboard.microsToNumber("1.5"), null, "micros are integers");
  assert.equal(dashboard.microsToNumber(""), null);
  assert.equal(dashboard.microsToNumber(null), null);
});

test("ties break by service name so the order is deterministic", () => {
  const [usd] = dashboard.projectedCostsByCurrency({
    services: [
      service("RDS", [money("USD", "3000000")]),
      service("EKS", [money("USD", "3000000")]),
    ],
  });
  assert.deepEqual(usd.items.map((item) => item.label), ["EKS", "RDS"]);
});

test("no projections produce no chart group rather than an empty axis", () => {
  assert.deepEqual(dashboard.projectedCostsByCurrency({ services: [] }), []);
  assert.deepEqual(
    dashboard.projectedCostsByCurrency({ services: [service("RDS", [])] }),
    [],
  );
});

test("a currency whose only amounts are unusable still reports the omission", () => {
  // The group exists so the reader is told the projection was not chartable,
  // rather than the currency vanishing silently.
  const groups = dashboard.projectedCostsByCurrency({
    services: [service("RDS", [money("USD", "not-a-number")])],
  });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].items, []);
  assert.equal(groups[0].omittedCount, 1);
});
