import assert from "node:assert/strict";
import test from "node:test";
import { buildCostOptimizations, COMMITMENT_DISCOUNT_DISCLOSURE } from "../lib/aws-cost-optimization.ts";
import type { AwsCostSnapshot } from "../lib/cost-types.ts";
import type { NormalizedCurLine } from "../lib/finops-cur.ts";
import type { PilotResource } from "../lib/pilot-types.ts";

const units = (whole: number): string => String(whole * 1_000_000);

function curLine(over: Partial<NormalizedCurLine> & { service: string; day: string; amountUnits: number }): NormalizedCurLine {
  return {
    lineItemId: `${over.service}-${over.day}`,
    usageAccountId: "111122223333",
    service: over.service,
    chargeCategory: over.chargeCategory ?? "Usage",
    usageStartIso: `${over.day}T00:00:00.000Z`,
    amountMicros: units(over.amountUnits),
    currency: over.currency ?? "USD",
    tags: over.tags ?? {},
  };
}

function resource(over: Partial<PilotResource> & { resourceKey: string }): PilotResource {
  return {
    service: "ec2", resourceType: "ec2.instance", nativeId: over.resourceKey, arn: null, name: over.resourceKey,
    region: "us-east-1", state: "running", tags: { Environment: "prod" }, configuration: {},
    source: { api: "EC2.DescribeInstances", accountId: "111122223333", collectedAt: "2026-07-19T00:00:00.000Z" },
    contentSha256: "a".repeat(64), ...over,
  };
}

function snapshot(over: Partial<AwsCostSnapshot> = {}): AwsCostSnapshot {
  return {
    schemaVersion: "sutra.aws-costs.v1", status: "COMPLETE", accountId: "111122223333", currency: "USD",
    collectedAt: "2026-07-19T00:00:00.000Z", periodStart: "2026-07-01", periodEnd: "2026-07-31",
    totalCost: 1000, monthToDateCost: 800, previousMonthCost: 500, trendPercent: 60,
    monthlyTrend: [], serviceBreakdown: [{ key: "ec2", label: "Amazon EC2", amount: 700, sharePercent: 70 }],
    accountBreakdown: [], forecast: { status: "AVAILABLE", source: "AWS_COST_EXPLORER", amount: 900, periodStart: "2026-07-01", periodEnd: "2026-07-31", reasonCode: null },
    anomalies: [], recommendations: [], limitations: [], unavailableReason: null, ...over,
  };
}

test("flags stopped billable resources as idle with no fabricated savings", () => {
  const report = buildCostOptimizations({
    snapshot: null,
    resources: [resource({ resourceKey: "i-1", state: "stopped" }), resource({ resourceKey: "i-2", state: "running" })],
  });
  const idle = report.recommendations.find((r) => r.category === "idle-resource");
  assert.ok(idle);
  assert.equal(idle.evidence.stoppedResources, 1);
  assert.equal(idle.estimatedMonthlySavings, null); // no per-resource cost data → never invented
});

test("derives spend-anomaly, forecast-overage (with savings), and concentration from the snapshot", () => {
  const report = buildCostOptimizations({ snapshot: snapshot(), resources: [] });
  const anomaly = report.recommendations.find((r) => r.category === "spend-anomaly");
  assert.equal(anomaly?.severity, "high"); // 60% >= 60
  const overage = report.recommendations.find((r) => r.category === "forecast-overage");
  assert.equal(overage?.estimatedMonthlySavings, 400); // 900 forecast - 500 prev = derivable overage
  const concentration = report.recommendations.find((r) => r.category === "concentration");
  assert.equal(concentration?.evidence.sharePercent, 70);
  assert.equal(report.summary.estimatedMonthlySavings, 400);
});

test("flags cost-allocation tag gaps only when coverage is materially low", () => {
  const untagged = Array.from({ length: 6 }, (_, i) => resource({ resourceKey: `i-${i}`, tags: {} }));
  const tagged = Array.from({ length: 4 }, (_, i) => resource({ resourceKey: `t-${i}`, tags: { Owner: "team" } }));
  const report = buildCostOptimizations({ snapshot: null, resources: [...untagged, ...tagged] });
  const tag = report.recommendations.find((r) => r.category === "tag-coverage");
  assert.ok(tag);
  assert.equal(tag.evidence.untagged, 6);
  assert.equal(tag.evidence.coveragePercent, 40);
});

test("stays quiet and honest when there is no cost snapshot and nothing actionable", () => {
  const report = buildCostOptimizations({ snapshot: null, resources: [resource({ resourceKey: "i-ok" })] });
  assert.deepEqual(report.recommendations, []);
  assert.equal(report.summary.estimatedMonthlySavings, null);
  assert.ok(report.limitations.includes("PER_RESOURCE_UTILIZATION_COLLECTED_VIA_CLOUDWATCH_SEE_UTILIZATION_BASED_RIGHTSIZING"));
});

test("is deterministic and severity-ordered", () => {
  const build = () => buildCostOptimizations({ snapshot: snapshot(), resources: [resource({ resourceKey: "i-1", state: "stopped" })] });
  assert.equal(JSON.stringify(build()), JSON.stringify(build()));
  const severities = build().recommendations.map((r) => r.severity);
  assert.deepEqual([...severities].sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a] - ({ high: 0, medium: 1, low: 2 })[b]), severities);
});

test("commitment: derives a Savings-Plan candidate with a discount-assumption-labeled saving", () => {
  // EC2 on-demand, sustained across the window, varying daily so it is not also
  // a flat rightsizing candidate. Total 600 units → 20% assumed discount = 120.
  const curLines = [
    curLine({ service: "AmazonEC2", day: "2026-07-01", amountUnits: 100 }),
    curLine({ service: "AmazonEC2", day: "2026-07-02", amountUnits: 200 }),
    curLine({ service: "AmazonEC2", day: "2026-07-03", amountUnits: 300 }),
  ];
  const report = buildCostOptimizations({ snapshot: null, resources: [], curLines });
  const commitment = report.recommendations.find((r) => r.category === "commitment");
  assert.ok(commitment);
  assert.equal(commitment.currency, "USD");
  assert.equal(commitment.estimatedMonthlySavingsMicros, units(120)); // 20% of 600
  assert.equal(commitment.evidence.commitmentVehicle, "compute-savings-plan");
  assert.equal(commitment.evidence.assumedDiscountPercent, 20);
  assert.equal(commitment.evidence.disclosure, COMMITMENT_DISCOUNT_DISCLOSURE); // exact wording surfaced
  assert.equal(commitment.estimatedMonthlySavings, null); // legacy whole-unit scalar unused for CUR
  assert.equal(report.summary.commitmentSavingsByCurrencyMicros.USD, units(120));
  assert.equal(report.summary.estimatedMonthlySavings, null); // CUR savings never fold into the scalar
});

test("commitment: emits candidate WITHOUT savings when CUR lacks family/usage-type granularity", () => {
  const curLines = [
    curLine({ service: "AmazonRDS", day: "2026-07-01", amountUnits: 50 }),
    curLine({ service: "AmazonRDS", day: "2026-07-02", amountUnits: 100 }),
    curLine({ service: "AmazonRDS", day: "2026-07-03", amountUnits: 150 }),
  ];
  const report = buildCostOptimizations({ snapshot: null, resources: [], curLines });
  const commitment = report.recommendations.find((r) => r.category === "commitment");
  assert.ok(commitment);
  assert.equal(commitment.estimatedMonthlySavingsMicros, null); // not derivable → never invented
  assert.equal(commitment.evidence.commitmentVehicle, "reserved-instance");
  assert.equal(commitment.evidence.noSavingsReason, "COMMITMENT_DISCOUNT_REQUIRES_USAGE_TYPE_AND_INSTANCE_FAMILY_NOT_COLLECTED");
  assert.deepEqual(report.summary.commitmentSavingsByCurrencyMicros, {}); // nothing summable
});

test("rightsizing: flat sustained non-committable spend is a candidate with null savings + reason", () => {
  const curLines = [
    curLine({ service: "AmazonS3", day: "2026-07-01", amountUnits: 5 }),
    curLine({ service: "AmazonS3", day: "2026-07-02", amountUnits: 5 }),
    curLine({ service: "AmazonS3", day: "2026-07-03", amountUnits: 5 }),
  ];
  const report = buildCostOptimizations({ snapshot: null, resources: [], curLines });
  const rightsizing = report.recommendations.find((r) => r.category === "rightsizing");
  assert.ok(rightsizing);
  assert.equal(rightsizing.estimatedMonthlySavingsMicros, null); // utilization not collected
  assert.equal(rightsizing.estimatedMonthlySavings, null);
  assert.equal(rightsizing.evidence.noSavingsReason, "CUR_SPEND_PATTERN_CANDIDATE_SEE_UTILIZATION_BASED_RIGHTSIZING_FOR_ESTIMATED_SAVINGS");
  assert.equal(rightsizing.evidence.pattern, "flat");
  // S3 is not commitment-eligible → no commitment rec is produced for it.
  assert.equal(report.recommendations.find((r) => r.category === "commitment"), undefined);
  assert.ok(report.limitations.includes("CUR_PATTERN_RIGHTSIZING_CANDIDATES_CARRY_NO_SAVING_USE_UTILIZATION_BASED_RIGHTSIZING_FOR_ESTIMATES"));
  assert.ok(report.limitations.includes("COMMITMENT_SAVINGS_USE_ASSUMED_DISCOUNT_RATE_NOT_A_QUOTE"));
});

test("mixed currencies are kept per-currency and never summed", () => {
  const curLines = [
    curLine({ service: "AmazonEC2", day: "2026-07-01", amountUnits: 100, currency: "USD" }),
    curLine({ service: "AmazonEC2", day: "2026-07-02", amountUnits: 200, currency: "USD" }),
    curLine({ service: "AmazonEC2", day: "2026-07-03", amountUnits: 300, currency: "USD" }),
    curLine({ service: "AmazonEC2", day: "2026-07-01", amountUnits: 40, currency: "EUR" }),
    curLine({ service: "AmazonEC2", day: "2026-07-02", amountUnits: 80, currency: "EUR" }),
    curLine({ service: "AmazonEC2", day: "2026-07-03", amountUnits: 120, currency: "EUR" }),
  ];
  const report = buildCostOptimizations({ snapshot: null, resources: [], curLines });
  const byCurrency = report.summary.commitmentSavingsByCurrencyMicros;
  assert.equal(byCurrency.USD, units(120)); // 20% of 600
  assert.equal(byCurrency.EUR, units(48)); // 20% of 240 — a separate bucket
  assert.equal(Object.keys(byCurrency).length, 2); // two buckets, never one merged total
  const currencies = report.recommendations.filter((r) => r.category === "commitment").map((r) => r.currency);
  assert.deepEqual([...currencies].sort(), ["EUR", "USD"]);
});
