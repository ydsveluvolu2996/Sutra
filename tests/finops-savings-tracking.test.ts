import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSavingsTracking,
  type SavingsPeriodBucket,
  type SavingsTrackingInput,
} from "../lib/finops-savings-tracking.ts";

const units = (whole: number): string => String(whole * 1_000_000);

function bucket(over: Partial<SavingsPeriodBucket> & { period: string }): SavingsPeriodBucket {
  return {
    period: over.period,
    currency: over.currency ?? "USD",
    coveredAmortizedMicros: over.coveredAmortizedMicros ?? "0",
    coveredOnDemandEquivalentMicros:
      over.coveredOnDemandEquivalentMicros === undefined ? null : over.coveredOnDemandEquivalentMicros,
    onDemandUsageMicros: over.onDemandUsageMicros ?? "0",
    commitmentFeeMicros: over.commitmentFeeMicros ?? "0",
    coveredLineCount: over.coveredLineCount ?? 0,
    onDemandLineCount: over.onDemandLineCount ?? 0,
  };
}

function input(buckets: readonly SavingsPeriodBucket[]): SavingsTrackingInput {
  return { buckets };
}

const CLOCK = () => new Date("2027-01-15T00:00:00.000Z");

test("realized commitment savings when the on-demand-equivalent IS derivable", () => {
  const report = buildSavingsTracking(
    input([
      bucket({
        period: "2026-01",
        coveredAmortizedMicros: units(70),
        coveredOnDemandEquivalentMicros: units(100),
        onDemandUsageMicros: units(100),
        coveredLineCount: 3,
        onDemandLineCount: 5,
      }),
    ]),
    { now: CLOCK },
  );
  const p = report.series[0].periods[0];
  // 100 (public) - 70 (amortized) = 30 realized.
  assert.equal(p.realizedSavingsMicros, units(30));
  assert.equal(p.realizedSavingsBasis, "derived-from-cur");
  // Coverage: 100 covered / (100 covered + 100 on-demand) = 50%.
  assert.equal(p.coveragePercent, 50);
  assert.equal(p.coverageBasis, "derived-from-cur");
  assert.equal(report.series[0].totalRealizedSavingsMicros, units(30));
  assert.equal(report.series[0].derivablePeriodCount, 1);
});

test("null + reason when covered usage exists but the on-demand-equivalent is NOT present", () => {
  const report = buildSavingsTracking(
    input([
      bucket({
        period: "2026-01",
        coveredAmortizedMicros: units(70),
        coveredOnDemandEquivalentMicros: null, // absent in the billing data
        coveredLineCount: 3,
      }),
    ]),
    { now: CLOCK },
  );
  const p = report.series[0].periods[0];
  assert.equal(p.realizedSavingsMicros, null);
  assert.equal(p.realizedSavingsBasis, "on-demand-equivalent-not-derivable");
  assert.equal(p.coveragePercent, null);
  assert.equal(p.coverageBasis, "coverage-not-derivable");
  // Nothing derivable contributed to the total.
  assert.equal(report.series[0].totalRealizedSavingsMicros, "0");
  assert.equal(report.series[0].derivablePeriodCount, 0);
  assert.equal(report.series[0].notDerivablePeriodCount, 1);
});

test("a period with no commitment usage has a factual zero saving, not an estimate", () => {
  const report = buildSavingsTracking(
    input([bucket({ period: "2026-01", onDemandUsageMicros: units(500), onDemandLineCount: 9 })]),
    { now: CLOCK },
  );
  const p = report.series[0].periods[0];
  assert.equal(p.realizedSavingsMicros, "0");
  assert.equal(p.realizedSavingsBasis, "no-commitment-usage");
  // No commitments -> 0% coverage is a fact.
  assert.equal(p.coveragePercent, 0);
  assert.equal(p.coverageBasis, "derived-from-cur");
});

test("cumulative and period-over-period across derivable periods", () => {
  const report = buildSavingsTracking(
    input([
      bucket({ period: "2026-01", coveredAmortizedMicros: units(80), coveredOnDemandEquivalentMicros: units(100), coveredLineCount: 1 }),
      bucket({ period: "2026-02", coveredAmortizedMicros: units(60), coveredOnDemandEquivalentMicros: units(100), coveredLineCount: 1 }),
      bucket({ period: "2026-03", coveredAmortizedMicros: units(55), coveredOnDemandEquivalentMicros: units(100), coveredLineCount: 1 }),
    ]),
    { now: CLOCK },
  );
  const periods = report.series[0].periods;
  // Realized: 20, 40, 45.
  assert.equal(periods[0].realizedSavingsMicros, units(20));
  assert.equal(periods[1].realizedSavingsMicros, units(40));
  assert.equal(periods[2].realizedSavingsMicros, units(45));
  // PoP: null, +20, +5.
  assert.equal(periods[0].periodOverPeriodDeltaMicros, null);
  assert.equal(periods[1].periodOverPeriodDeltaMicros, units(20));
  assert.equal(periods[2].periodOverPeriodDeltaMicros, units(5));
  // Cumulative: 20, 60, 105.
  assert.equal(periods[0].cumulativeRealizedSavingsMicros, units(20));
  assert.equal(periods[1].cumulativeRealizedSavingsMicros, units(60));
  assert.equal(periods[2].cumulativeRealizedSavingsMicros, units(105));
  assert.equal(report.series[0].totalRealizedSavingsMicros, units(105));
});

test("a non-derivable period breaks the period-over-period chain honestly", () => {
  const report = buildSavingsTracking(
    input([
      bucket({ period: "2026-01", coveredAmortizedMicros: units(80), coveredOnDemandEquivalentMicros: units(100), coveredLineCount: 1 }),
      bucket({ period: "2026-02", coveredAmortizedMicros: units(60), coveredOnDemandEquivalentMicros: null, coveredLineCount: 1 }),
      bucket({ period: "2026-03", coveredAmortizedMicros: units(55), coveredOnDemandEquivalentMicros: units(100), coveredLineCount: 1 }),
    ]),
    { now: CLOCK },
  );
  const periods = report.series[0].periods;
  assert.equal(periods[1].realizedSavingsMicros, null);
  // March cannot compare against a non-derivable February.
  assert.equal(periods[2].periodOverPeriodDeltaMicros, null);
  // Cumulative sums only the two derivable periods: 20 + 45.
  assert.equal(report.series[0].totalRealizedSavingsMicros, units(65));
  assert.equal(report.series[0].derivablePeriodCount, 2);
  assert.equal(report.series[0].notDerivablePeriodCount, 1);
});

test("currencies are isolated into separate series and never merged", () => {
  const report = buildSavingsTracking(
    input([
      bucket({ period: "2026-01", currency: "USD", coveredAmortizedMicros: units(70), coveredOnDemandEquivalentMicros: units(100), coveredLineCount: 1 }),
      bucket({ period: "2026-01", currency: "EUR", coveredAmortizedMicros: units(7), coveredOnDemandEquivalentMicros: units(10), coveredLineCount: 1 }),
    ]),
    { now: CLOCK },
  );
  assert.equal(report.series.length, 2);
  assert.deepEqual(report.series.map((s) => s.currency), ["EUR", "USD"]);
  assert.equal(report.series[0].totalRealizedSavingsMicros, units(3)); // EUR
  assert.equal(report.series[1].totalRealizedSavingsMicros, units(30)); // USD
});

test("flags the current in-progress month as partial when a clock is supplied", () => {
  const report = buildSavingsTracking(
    input([
      bucket({ period: "2026-05", coveredAmortizedMicros: units(70), coveredOnDemandEquivalentMicros: units(100), coveredLineCount: 1 }),
      bucket({ period: "2026-06", coveredAmortizedMicros: units(60), coveredOnDemandEquivalentMicros: units(100), coveredLineCount: 1 }),
    ]),
    { now: () => new Date("2026-06-10T00:00:00.000Z") },
  );
  assert.equal(report.currentPeriod, "2026-06");
  assert.equal(report.series[0].periods[0].isCurrentPartialPeriod, false);
  assert.equal(report.series[0].periods[1].isCurrentPartialPeriod, true);
});

test("empty input produces an honest empty result", () => {
  const report = buildSavingsTracking(input([]), { now: CLOCK });
  assert.deepEqual(report.series, []);
  assert.equal(report.schema, "sutra.finops-savings-tracking.v1");
  assert.ok(report.disclaimer.length > 0);
  assert.ok(report.limitations.length > 0);
});

test("no clock keeps the engine pure and deterministic", () => {
  const built = input([
    bucket({ period: "2026-02", coveredAmortizedMicros: units(60), coveredOnDemandEquivalentMicros: units(100), coveredLineCount: 1 }),
    bucket({ period: "2026-01", coveredAmortizedMicros: units(80), coveredOnDemandEquivalentMicros: units(100), coveredLineCount: 1 }),
  ]);
  const first = buildSavingsTracking(built);
  const second = buildSavingsTracking(built);
  assert.equal(first.currentPeriod, null);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
