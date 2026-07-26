import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NormalizedCurLine } from "../lib/finops-cur.ts";
import { groupCostByRegion } from "../lib/finops-region.ts";

function line(over: Partial<NormalizedCurLine> & { amountMicros: string }): NormalizedCurLine {
  return {
    lineItemId: over.lineItemId ?? "li-1",
    usageAccountId: over.usageAccountId ?? "111111111111",
    service: over.service ?? "AmazonEC2",
    chargeCategory: over.chargeCategory ?? "Usage",
    usageStartIso: over.usageStartIso ?? "2026-07-01T00:00:00.000Z",
    amountMicros: over.amountMicros,
    currency: over.currency ?? "USD",
    region: over.region ?? null,
    amortizedMicros: over.amortizedMicros ?? null,
    commitmentType: over.commitmentType ?? null,
    commitmentId: over.commitmentId ?? null,
    commitmentExpiry: over.commitmentExpiry ?? null,
    tags: over.tags ?? {},
  };
}

describe("groupCostByRegion", () => {
  it("reports unavailable when every line has a null region (pre-parser uploads)", () => {
    const result = groupCostByRegion([
      line({ amountMicros: "10000000" }),
      line({ amountMicros: "5000000" }),
    ]);
    assert.equal(result.available, false);
    assert.deepEqual(result.regions, []);
    assert.equal(result.currency, "USD");
  });

  it("is unavailable on an empty line set", () => {
    assert.deepEqual(groupCostByRegion([]), { available: false, currency: "", regions: [] });
  });

  it("groups by region sorted desc, with percents, when some lines carry a region", () => {
    const result = groupCostByRegion([
      line({ amountMicros: "10000000", region: "us-east-1" }),
      line({ amountMicros: "30000000", region: "eu-west-1" }),
      line({ amountMicros: "10000000", region: "us-east-1" }),
    ]);
    assert.equal(result.available, true);
    assert.equal(result.currency, "USD");
    assert.equal(result.regions.length, 2);
    // eu-west-1 (30) leads us-east-1 (20); total 50.
    assert.deepEqual(result.regions[0], { region: "eu-west-1", amountMicros: "30000000", amount: 30, percent: 60 });
    assert.deepEqual(result.regions[1], { region: "us-east-1", amountMicros: "20000000", amount: 20, percent: 40 });
  });

  it("buckets null-region lines under 'unattributed' only when some lines have a region", () => {
    const result = groupCostByRegion([
      line({ amountMicros: "40000000", region: "us-east-1" }),
      line({ amountMicros: "10000000", region: null }),
    ]);
    assert.equal(result.available, true);
    const unattributed = result.regions.find((entry) => entry.region === "unattributed");
    assert.equal(unattributed?.amountMicros, "10000000");
    assert.equal(unattributed?.percent, 20);
  });

  it("never mixes currencies — aggregates only the deterministically chosen currency", () => {
    const result = groupCostByRegion([
      line({ amountMicros: "10000000", currency: "USD", region: "us-east-1" }),
      line({ amountMicros: "90000000", currency: "EUR", region: "eu-west-1" }),
    ]);
    // "EUR" sorts before "USD"; only EUR lines are aggregated.
    assert.equal(result.currency, "EUR");
    assert.equal(result.regions.length, 1);
    assert.equal(result.regions[0].region, "eu-west-1");
    assert.equal(result.regions[0].amountMicros, "90000000");
  });
});
