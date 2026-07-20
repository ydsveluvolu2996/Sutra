import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSavingsTrackingInput,
  type AmortizedCurLine,
} from "../lib/finops-savings-tracking-inputs.ts";
import { buildSavingsTracking } from "../lib/finops-savings-tracking.ts";

const units = (whole: number): string => String(whole * 1_000_000);

function line(over: Partial<AmortizedCurLine> & { usageStartIso: string; chargeCategory: string }): AmortizedCurLine {
  return {
    usageStartIso: over.usageStartIso,
    service: over.service ?? "AmazonEC2",
    chargeCategory: over.chargeCategory,
    amountMicros: over.amountMicros ?? units(10),
    currency: over.currency ?? "USD",
    publicOnDemandCostMicros: over.publicOnDemandCostMicros,
    amortizedCostMicros: over.amortizedCostMicros,
  };
}

test("buckets covered + on-demand lines per period and derives realized savings", () => {
  const built = buildSavingsTrackingInput({
    curLines: [
      line({ usageStartIso: "2026-01-03T00:00:00.000Z", chargeCategory: "SavingsPlanCoveredUsage", amountMicros: units(40), publicOnDemandCostMicros: units(60) }),
      line({ usageStartIso: "2026-01-20T00:00:00.000Z", chargeCategory: "DiscountedUsage", amountMicros: units(30), publicOnDemandCostMicros: units(40) }),
      line({ usageStartIso: "2026-01-10T00:00:00.000Z", chargeCategory: "Usage", amountMicros: units(100) }),
    ],
  });
  assert.equal(built.buckets.length, 1);
  const b = built.buckets[0];
  assert.equal(b.period, "2026-01");
  assert.equal(b.coveredAmortizedMicros, units(70)); // 40 + 30
  assert.equal(b.coveredOnDemandEquivalentMicros, units(100)); // 60 + 40
  assert.equal(b.onDemandUsageMicros, units(100));
  assert.equal(b.coveredLineCount, 2);
  assert.equal(b.onDemandLineCount, 1);

  const report = buildSavingsTracking(built);
  assert.equal(report.series[0].periods[0].realizedSavingsMicros, units(30));
});

test("groups per currency without merging", () => {
  const built = buildSavingsTrackingInput({
    curLines: [
      line({ usageStartIso: "2026-01-01T00:00:00.000Z", chargeCategory: "DiscountedUsage", amountMicros: units(40), publicOnDemandCostMicros: units(50), currency: "USD" }),
      line({ usageStartIso: "2026-01-01T00:00:00.000Z", chargeCategory: "DiscountedUsage", amountMicros: units(4), publicOnDemandCostMicros: units(5), currency: "EUR" }),
    ],
  });
  const currencies = built.buckets.map((b) => b.currency).sort();
  assert.deepEqual(currencies, ["EUR", "USD"]);
  const report = buildSavingsTracking(built);
  assert.deepEqual(report.series.map((s) => s.currency), ["EUR", "USD"]);
});

test("commitment fees are captured separately from covered/on-demand usage", () => {
  const built = buildSavingsTrackingInput({
    curLines: [
      line({ usageStartIso: "2026-01-01T00:00:00.000Z", chargeCategory: "SavingsPlanRecurringFee", amountMicros: units(25) }),
      line({ usageStartIso: "2026-01-01T00:00:00.000Z", chargeCategory: "Usage", amountMicros: units(100) }),
    ],
  });
  const b = built.buckets[0];
  assert.equal(b.commitmentFeeMicros, units(25));
  assert.equal(b.onDemandUsageMicros, units(100));
  assert.equal(b.coveredLineCount, 0);
});

test("covered line WITHOUT a public on-demand cost leaves the equivalent null (not-derivable downstream)", () => {
  const built = buildSavingsTrackingInput({
    curLines: [
      line({ usageStartIso: "2026-01-01T00:00:00.000Z", chargeCategory: "DiscountedUsage", amountMicros: units(70) }),
    ],
  });
  assert.equal(built.buckets[0].coveredOnDemandEquivalentMicros, null);
  assert.equal(built.buckets[0].coveredAmortizedMicros, units(70));
  const report = buildSavingsTracking(built);
  assert.equal(report.series[0].periods[0].realizedSavingsMicros, null);
  assert.equal(report.series[0].periods[0].realizedSavingsBasis, "on-demand-equivalent-not-derivable");
});

test("skips and discloses unattributable/edge lines instead of guessing", () => {
  const built = buildSavingsTrackingInput({
    curLines: [
      line({ usageStartIso: "2026-01-01T00:00:00.000Z", chargeCategory: "Usage", amountMicros: units(100) }),
      line({ usageStartIso: "", chargeCategory: "Usage", amountMicros: units(9) }), // no parseable month
      line({ usageStartIso: "2026-01-01T00:00:00.000Z", chargeCategory: "Credit", amountMicros: units(-5) }), // not usage/fee
    ],
  });
  assert.equal(built.buckets.length, 1);
  assert.equal((built.skipped ?? []).length, 2);
  assert.ok((built.skipped ?? []).some((s) => /calendar month/.test(s.reason)));
  assert.ok((built.skipped ?? []).some((s) => /not usage or a commitment fee/.test(s.reason)));
});

test("empty input yields empty buckets and no skips", () => {
  const built = buildSavingsTrackingInput({ curLines: [] });
  assert.deepEqual(built.buckets, []);
  assert.deepEqual(built.skipped, []);
});
