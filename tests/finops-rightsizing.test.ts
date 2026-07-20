import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRightsizingRecommendations,
  type InstanceCatalogEntry,
  type RightsizingInput,
  type UtilizationSample,
} from "../lib/finops-rightsizing.ts";

const units = (whole: number): string => String(whole * 1_000_000);

// A minimal same-family catalog: large=1x, xlarge=2x (a one-step downsize halves cost).
const CATALOG: readonly InstanceCatalogEntry[] = [
  { instanceType: "m5.large", family: "m5", vcpu: 2, memGiB: 8, relativeCost: 1 },
  { instanceType: "m5.xlarge", family: "m5", vcpu: 4, memGiB: 16, relativeCost: 2 },
  { instanceType: "m5.2xlarge", family: "m5", vcpu: 8, memGiB: 32, relativeCost: 4 },
];

function sample(over: Partial<UtilizationSample> & { resourceKey: string }): UtilizationSample {
  return {
    currentInstanceType: "m5.xlarge",
    region: "us-east-1",
    cpuP95Percent: 12,
    networkP95BytesPerMinute: 1_000_000,
    memoryP95Percent: null,
    sampleWindowDays: 21,
    ...over,
  };
}

function build(over: Partial<RightsizingInput> = {}): RightsizingInput {
  return { samples: [], costs: [], catalog: CATALOG, ...over };
}

test("recommends a real downsize with a derivable, correct saving", () => {
  const report = buildRightsizingRecommendations(
    build({
      samples: [sample({ resourceKey: "i-1", currentInstanceType: "m5.xlarge", cpuP95Percent: 12 })],
      costs: [{ resourceKey: "i-1", currency: "USD", currentMonthlyCostMicros: units(200) }],
    }),
  );
  const rec = report.recommendations[0];
  assert.equal(rec.state, "downsize-recommended");
  assert.equal(rec.targetInstanceType, "m5.large");
  // m5.large is half the cost of m5.xlarge -> target 100, saving 100.
  assert.equal(rec.targetMonthlyCostMicros, units(100));
  assert.equal(rec.estimatedMonthlySavingsMicros, units(100));
  assert.equal(report.summary.savingsByCurrencyMicros.USD, units(100));
  assert.equal(report.summary.downsizeRecommended, 1);
  // Saving is disclosed as an estimate.
  assert.ok(rec.reasons.some((reason) => reason.includes("ESTIMATE")));
  assert.ok(rec.reasons.some((reason) => reason.startsWith("OBSERVATION_WINDOW_")));
});

test("insufficient data (short window) yields null savings and insufficient-data state", () => {
  const report = buildRightsizingRecommendations(
    build({
      samples: [sample({ resourceKey: "i-1", sampleWindowDays: 5 })],
      costs: [{ resourceKey: "i-1", currency: "USD", currentMonthlyCostMicros: units(200) }],
    }),
  );
  const rec = report.recommendations[0];
  assert.equal(rec.state, "insufficient-data");
  assert.equal(rec.estimatedMonthlySavingsMicros, null);
  assert.equal(rec.targetInstanceType, null);
  assert.ok(rec.reasons.some((reason) => reason.includes("WINDOW_BELOW_MINIMUM")));
  assert.deepEqual(report.summary.savingsByCurrencyMicros, {});
});

test("missing CPU signal is insufficient-data, never a fabricated saving", () => {
  const report = buildRightsizingRecommendations(
    build({
      samples: [sample({ resourceKey: "i-1", cpuP95Percent: null })],
      costs: [{ resourceKey: "i-1", currency: "USD", currentMonthlyCostMicros: units(200) }],
    }),
  );
  const rec = report.recommendations[0];
  assert.equal(rec.state, "insufficient-data");
  assert.equal(rec.estimatedMonthlySavingsMicros, null);
});

test("memory-unknown recommendation discloses that memory was not collected", () => {
  const report = buildRightsizingRecommendations(
    build({
      samples: [sample({ resourceKey: "i-1", memoryP95Percent: null })],
      costs: [{ resourceKey: "i-1", currency: "USD", currentMonthlyCostMicros: units(80) }],
    }),
  );
  const rec = report.recommendations[0];
  assert.equal(rec.state, "downsize-recommended");
  assert.equal(rec.memoryKnown, false);
  assert.equal(rec.basis, "cpu-network");
  assert.equal(rec.observed.memoryP95Percent, null);
  assert.ok(rec.reasons.some((reason) => reason.includes("MEMORY_UTILIZATION_NOT_COLLECTED")));
});

test("a memory-bound workload is NOT downsized even with low CPU", () => {
  const report = buildRightsizingRecommendations(
    build({
      samples: [sample({ resourceKey: "i-1", cpuP95Percent: 12, memoryP95Percent: 78 })],
      costs: [{ resourceKey: "i-1", currency: "USD", currentMonthlyCostMicros: units(200) }],
    }),
  );
  const rec = report.recommendations[0];
  assert.notEqual(rec.state, "downsize-recommended");
  assert.equal(rec.state, "already-optimal");
  assert.equal(rec.estimatedMonthlySavingsMicros, null);
  assert.equal(rec.memoryKnown, true);
  assert.ok(rec.reasons.some((reason) => reason.includes("MEMORY_P95_ABOVE_THRESHOLD")));
});

test("known low memory allows the downsize (memory-aware basis)", () => {
  const report = buildRightsizingRecommendations(
    build({
      samples: [sample({ resourceKey: "i-1", cpuP95Percent: 10, memoryP95Percent: 30 })],
      costs: [{ resourceKey: "i-1", currency: "USD", currentMonthlyCostMicros: units(200) }],
    }),
  );
  const rec = report.recommendations[0];
  assert.equal(rec.state, "downsize-recommended");
  assert.equal(rec.basis, "cpu-network-memory");
  assert.equal(rec.estimatedMonthlySavingsMicros, units(100));
});

test("busy instances are already-optimal, not downsized", () => {
  const report = buildRightsizingRecommendations(
    build({
      samples: [sample({ resourceKey: "i-1", cpuP95Percent: 72 })],
      costs: [{ resourceKey: "i-1", currency: "USD", currentMonthlyCostMicros: units(200) }],
    }),
  );
  assert.equal(report.recommendations[0].state, "already-optimal");
  assert.equal(report.summary.savingsByCurrencyMicros.USD, undefined);
});

test("per-currency savings are tracked separately, never summed", () => {
  const report = buildRightsizingRecommendations(
    build({
      samples: [
        sample({ resourceKey: "i-usd", cpuP95Percent: 10 }),
        sample({ resourceKey: "i-eur", cpuP95Percent: 10 }),
      ],
      costs: [
        { resourceKey: "i-usd", currency: "USD", currentMonthlyCostMicros: units(200) },
        { resourceKey: "i-eur", currency: "EUR", currentMonthlyCostMicros: units(60) },
      ],
    }),
  );
  assert.equal(report.summary.savingsByCurrencyMicros.USD, units(100));
  assert.equal(report.summary.savingsByCurrencyMicros.EUR, units(30));
  // The two currencies are never folded into one scalar.
  assert.equal(Object.keys(report.summary.savingsByCurrencyMicros).length, 2);
});

test("a confidently-idle instance with no derivable cost gets a target but a null saving", () => {
  const report = buildRightsizingRecommendations(
    build({ samples: [sample({ resourceKey: "i-1", cpuP95Percent: 10 })], costs: [] }),
  );
  const rec = report.recommendations[0];
  assert.equal(rec.state, "downsize-recommended");
  assert.equal(rec.targetInstanceType, "m5.large");
  assert.equal(rec.estimatedMonthlySavingsMicros, null);
  assert.ok(rec.reasons.some((reason) => reason.includes("COST_NOT_DERIVABLE")));
  assert.deepEqual(report.summary.savingsByCurrencyMicros, {});
});

test("the smallest instance in a family is already-optimal", () => {
  const report = buildRightsizingRecommendations(
    build({
      samples: [sample({ resourceKey: "i-1", currentInstanceType: "m5.large", cpuP95Percent: 5 })],
      costs: [{ resourceKey: "i-1", currency: "USD", currentMonthlyCostMicros: units(100) }],
    }),
  );
  assert.equal(report.recommendations[0].state, "already-optimal");
  assert.ok(report.recommendations[0].reasons.some((reason) => reason.includes("SMALLEST_INSTANCE")));
});

test("is deterministic and resource-key ordered", () => {
  const input = build({
    samples: [
      sample({ resourceKey: "i-b", cpuP95Percent: 10 }),
      sample({ resourceKey: "i-a", cpuP95Percent: 10 }),
    ],
    costs: [
      { resourceKey: "i-a", currency: "USD", currentMonthlyCostMicros: units(200) },
      { resourceKey: "i-b", currency: "USD", currentMonthlyCostMicros: units(200) },
    ],
  });
  const first = buildRightsizingRecommendations(input);
  const second = buildRightsizingRecommendations(input);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first.recommendations.map((rec) => rec.resourceKey), ["i-a", "i-b"]);
});
