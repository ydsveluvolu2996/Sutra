import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NormalizedCurLine } from "../lib/finops-cur.ts";
import { buildCommitmentCoverage, classifyCommitmentType } from "../lib/finops-commitments.ts";

const NOW = "2026-07-26T00:00:00.000Z";

function line(over: Partial<NormalizedCurLine> & { amountMicros: string }): NormalizedCurLine {
  return {
    lineItemId: over.lineItemId ?? "li",
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
    usageType: over.usageType ?? null,
    usageAmountMicros: over.usageAmountMicros ?? null,
    usageUnit: over.usageUnit ?? null,
    tags: over.tags ?? {},
  };
}

describe("classifyCommitmentType", () => {
  it("maps FOCUS and CUR tokens onto coverage classes", () => {
    assert.equal(classifyCommitmentType("Reserved"), "committed");
    assert.equal(classifyCommitmentType("SavingsPlan"), "committed");
    assert.equal(classifyCommitmentType("reserved"), "committed");
    assert.equal(classifyCommitmentType("savings_plan"), "committed");
    assert.equal(classifyCommitmentType("on_demand"), "on_demand");
    assert.equal(classifyCommitmentType("OnDemand"), "on_demand");
    assert.equal(classifyCommitmentType("spot"), "spot");
    assert.equal(classifyCommitmentType(null), "unclassified");
    assert.equal(classifyCommitmentType("mystery"), "unclassified");
  });
});

describe("buildCommitmentCoverage", () => {
  it("computes coverage %, the on-demand/committed split, and excludes spot + unclassified", () => {
    const report = buildCommitmentCoverage([
      // Committed (SP-covered usage): $0 billed, $30 effective/amortized.
      line({ commitmentType: "savings_plan", commitmentId: "sp-1", amountMicros: "0", amortizedMicros: "30000000" }),
      // On-demand: $70 effective (no amortized figure).
      line({ commitmentType: "on_demand", amountMicros: "70000000" }),
      // Spot: excluded from the eligible base, disclosed separately.
      line({ commitmentType: "spot", amountMicros: "50000000" }),
      // Unclassified (null type): excluded, never guessed.
      line({ commitmentType: null, amountMicros: "20000000" }),
    ], NOW);

    assert.equal(report.available, true);
    assert.equal(report.currency, "USD");
    assert.equal(report.committedMicros, "30000000");
    assert.equal(report.onDemandMicros, "70000000");
    assert.equal(report.eligibleMicros, "100000000");
    assert.equal(report.spotMicros, "50000000");
    assert.equal(report.unclassifiedMicros, "20000000");
    // committed / (committed + on-demand) = 30 / 100 = 30%.
    assert.equal(report.coveragePercent, 30);

    // Split by commitment type, sorted by spend descending.
    assert.deepEqual(report.byCommitmentType.map((entry) => entry.commitmentType), ["on_demand", "spot", "savings_plan"]);
    assert.deepEqual(report.byCommitmentType.map((entry) => entry.class), ["on_demand", "spot", "committed"]);
    assert.equal(report.byCommitmentType[2].spendMicros, "30000000");
  });

  it("reports unavailable when there is no commitment data", () => {
    const report = buildCommitmentCoverage([
      line({ commitmentType: "on_demand", amountMicros: "40000000" }),
      line({ commitmentType: null, amountMicros: "10000000" }),
    ], NOW);
    assert.equal(report.available, false);
    // No committed spend, so coverage is 0% over the on-demand-only eligible base.
    assert.equal(report.committedMicros, "0");
    assert.equal(report.coveragePercent, 0);
    assert.equal(report.effectiveSavingsRate.derivable, false);
    assert.equal(report.effectiveSavingsRate.percent, null);
  });

  it("derives the Effective Savings Rate when a committed line carries both figures", () => {
    const report = buildCommitmentCoverage([
      // SP-covered usage: billed cost IS the on-demand-equivalent ($100), the
      // amortized figure ($60) is the discounted effective cost.
      line({ commitmentType: "savings_plan", commitmentId: "sp-1", amountMicros: "100000000", amortizedMicros: "60000000" }),
    ], NOW);
    const esr = report.effectiveSavingsRate;
    assert.equal(esr.derivable, true);
    assert.equal(esr.onDemandEquivalentMicros, "100000000");
    assert.equal(esr.actualMicros, "60000000");
    // (100 - 60) / 100 = 40%.
    assert.equal(esr.percent, 40);
    assert.equal(esr.note, null);
  });

  it("returns a null ESR (disclosed) when committed lines carry no amortized figure", () => {
    const report = buildCommitmentCoverage([
      line({ commitmentType: "reserved", commitmentId: "ri-1", amountMicros: "80000000" }),
    ], NOW);
    assert.equal(report.effectiveSavingsRate.derivable, false);
    assert.equal(report.effectiveSavingsRate.percent, null);
    assert.match(report.effectiveSavingsRate.note ?? "", /on-demand-equivalent/u);
  });

  it("builds a de-duplicated expiry list, soonest-first, with days-to-expiry from nowIso", () => {
    const report = buildCommitmentCoverage([
      line({ commitmentType: "savings_plan", commitmentId: "sp-a", commitmentExpiry: "2026-08-05T00:00:00.000Z", amountMicros: "10000000" }),
      // Duplicate id + expiry -> collapsed to a single entry.
      line({ commitmentType: "savings_plan", commitmentId: "sp-a", commitmentExpiry: "2026-08-05T00:00:00.000Z", amountMicros: "5000000" }),
      line({ commitmentType: "reserved", commitmentId: "ri-b", commitmentExpiry: "2026-07-20T00:00:00.000Z", amountMicros: "8000000" }),
      line({ commitmentType: "savings_plan", commitmentId: "sp-c", commitmentExpiry: "2027-01-01T00:00:00.000Z", amountMicros: "12000000" }),
    ], NOW);

    assert.equal(report.expirations.length, 3);
    // Soonest (most expired) first.
    assert.deepEqual(report.expirations.map((entry) => entry.commitmentId), ["ri-b", "sp-a", "sp-c"]);
    assert.equal(report.expirations[0].daysToExpiry, -6);
    assert.equal(report.expirations[0].expired, true);
    assert.equal(report.expirations[1].daysToExpiry, 10);
    assert.equal(report.expirations[1].expired, false);
    assert.ok((report.expirations[2].daysToExpiry ?? 0) > 100);
  });

  it("analyses only the dominant currency and discloses the rest", () => {
    const report = buildCommitmentCoverage([
      line({ commitmentType: "savings_plan", amountMicros: "100000000", amortizedMicros: "60000000", currency: "USD" }),
      line({ commitmentType: "on_demand", amountMicros: "9000000", currency: "EUR" }),
    ], NOW);
    assert.equal(report.currency, "USD");
    assert.deepEqual([...report.currenciesPresent], ["EUR", "USD"]);
    // EUR on-demand line is excluded; coverage is 100% over the USD base.
    assert.equal(report.onDemandMicros, "0");
    assert.equal(report.coveragePercent, 100);
  });
});
