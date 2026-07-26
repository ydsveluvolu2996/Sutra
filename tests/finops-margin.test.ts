import assert from "node:assert/strict";
import test from "node:test";
import { applyMargin, type CustomerCost, type MarginRate } from "../lib/finops-margin.ts";

const units = (whole: number): string => String(whole * 1_000_000);

function cost(customerId: string, whole: number, currency = "USD"): CustomerCost {
  return { customerId, currency, costMicros: units(whole) };
}
function rate(customerId: string, markupPercent: number, feeWhole: number, currency = "USD"): MarginRate {
  return { customerId, markupPercent, monthlyFeeMicros: units(feeWhole), currency };
}

test("markup only: billed = cost * (1 + markup%)", () => {
  const result = applyMargin([cost("acme", 100)], [rate("acme", 20, 0)]);
  const row = result.rows[0];
  assert.equal(row?.costMicros, units(100));
  assert.equal(row?.billedMicros, units(120));
  assert.equal(row?.marginMicros, units(20));
  assert.ok(row && Math.abs((row.marginPercent ?? 0) - (20 / 120) * 100) < 1e-9);
  assert.equal(row?.hasRate, true);
});

test("fixed monthly fee only", () => {
  const result = applyMargin([cost("acme", 100)], [rate("acme", 0, 50)]);
  const row = result.rows[0];
  assert.equal(row?.billedMicros, units(150));
  assert.equal(row?.marginMicros, units(50));
  assert.equal(row?.monthlyFeeMicros, units(50));
});

test("markup and fee combine", () => {
  const result = applyMargin([cost("acme", 100)], [rate("acme", 10, 25)]);
  const row = result.rows[0];
  // 100 + 10 + 25 = 135
  assert.equal(row?.billedMicros, units(135));
  assert.equal(row?.marginMicros, units(35));
});

test("customer with no rate is still listed with zero margin", () => {
  const result = applyMargin([cost("acme", 100), cost("beta", 40)], [rate("acme", 50, 0)]);
  const beta = result.rows.find((r) => r.customerId === "beta");
  assert.ok(beta);
  assert.equal(beta?.hasRate, false);
  assert.equal(beta?.billedMicros, units(40));
  assert.equal(beta?.marginMicros, "0");
});

test("fixed fee is not applied across a currency mismatch (markup still applies)", () => {
  const result = applyMargin([cost("acme", 100, "EUR")], [rate("acme", 10, 50, "USD")]);
  const row = result.rows[0];
  // markup applies (currency-agnostic %), fee does NOT (rate is USD, cost is EUR)
  assert.equal(row?.currency, "EUR");
  assert.equal(row?.billedMicros, units(110));
  assert.equal(row?.monthlyFeeMicros, "0");
});

test("blended totals per currency; margin never crosses currencies", () => {
  const result = applyMargin(
    [cost("acme", 100, "USD"), cost("beta", 100, "USD"), cost("gamma", 200, "EUR")],
    [rate("acme", 20, 0, "USD"), rate("gamma", 10, 0, "EUR")],
  );
  const usd = result.totalsByCurrency.find((t) => t.currency === "USD");
  const eur = result.totalsByCurrency.find((t) => t.currency === "EUR");
  // USD: cost 200, billed 100*1.2 + 100 = 220, margin 20
  assert.equal(usd?.totalCostMicros, units(200));
  assert.equal(usd?.totalBilledMicros, units(220));
  assert.equal(usd?.totalMarginMicros, units(20));
  // EUR: cost 200, billed 220, margin 20
  assert.equal(eur?.totalBilledMicros, units(220));
  assert.equal(eur?.totalMarginMicros, units(20));
});

test("marginPercent is null when billed is zero", () => {
  const result = applyMargin([cost("acme", 0)], []);
  assert.equal(result.rows[0]?.marginPercent, null);
  assert.equal(result.totalsByCurrency[0]?.blendedMarginPercent, null);
});
