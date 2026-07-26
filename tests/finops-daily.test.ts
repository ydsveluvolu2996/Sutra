import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NormalizedCurLine } from "../lib/finops-cur.ts";
import { buildDailyCost, DAILY_COST_NOTE } from "../lib/finops-daily.ts";

/** Minimal CUR line — the engine only reads usageStartIso + amountMicros. */
function line(usageStartIso: string, amountMicros: string): NormalizedCurLine {
  return {
    lineItemId: `li-${usageStartIso}-${amountMicros}`,
    usageAccountId: "111111111111",
    service: "AmazonEC2",
    chargeCategory: "Usage",
    usageStartIso,
    amountMicros,
    currency: "USD",
    region: null,
    amortizedMicros: null,
    commitmentType: null,
    commitmentId: null,
    commitmentExpiry: null,
    tags: {},
  };
}

describe("buildDailyCost", () => {
  it("builds a multi-day series and reports the day-over-day delta and percent", () => {
    // Two lines on day 1 (100 + 50 = 150), one line on day 2 (200). Out of order
    // and multiple lines per day to prove grouping + ascending sort.
    const result = buildDailyCost([
      line("2026-07-02T06:00:00.000Z", "200000000"),
      line("2026-07-01T00:00:00.000Z", "100000000"),
      line("2026-07-01T12:00:00.000Z", "50000000"),
    ], "USD");

    assert.deepEqual(result.series, [
      { date: "2026-07-01", amount: 150000000 },
      { date: "2026-07-02", amount: 200000000 },
    ]);
    assert.deepEqual(result.latestDay, { date: "2026-07-02", amount: 200000000 });
    assert.deepEqual(result.priorDay, { date: "2026-07-01", amount: 150000000 });
    assert.equal(result.deltaAmount, 50000000);
    assert.equal(result.deltaPercent, (50000000 / 150000000) * 100);
    assert.equal(result.currency, "USD");
    assert.equal(result.note, DAILY_COST_NOTE);
  });

  it("returns a null prior day (and null deltas) for a single-day series", () => {
    const result = buildDailyCost([
      line("2026-07-01T00:00:00.000Z", "100000000"),
      line("2026-07-01T18:00:00.000Z", "25000000"),
    ], "USD");

    assert.deepEqual(result.series, [{ date: "2026-07-01", amount: 125000000 }]);
    assert.deepEqual(result.latestDay, { date: "2026-07-01", amount: 125000000 });
    assert.equal(result.priorDay, null);
    assert.equal(result.deltaAmount, null);
    assert.equal(result.deltaPercent, null);
  });

  it("returns everything null for an empty line set", () => {
    const result = buildDailyCost([], "");

    assert.deepEqual(result.series, []);
    assert.equal(result.latestDay, null);
    assert.equal(result.priorDay, null);
    assert.equal(result.deltaAmount, null);
    assert.equal(result.deltaPercent, null);
    assert.equal(result.currency, "");
    assert.equal(result.note, DAILY_COST_NOTE);
  });

  it("reports a null percent (but a real delta) when the prior day is zero", () => {
    const result = buildDailyCost([
      line("2026-07-01T00:00:00.000Z", "0"),
      line("2026-07-02T00:00:00.000Z", "300000000"),
    ], "USD");

    assert.deepEqual(result.priorDay, { date: "2026-07-01", amount: 0 });
    assert.deepEqual(result.latestDay, { date: "2026-07-02", amount: 300000000 });
    assert.equal(result.deltaAmount, 300000000);
    assert.equal(result.deltaPercent, null);
  });
});
