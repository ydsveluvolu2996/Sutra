import assert from "node:assert/strict";
import test from "node:test";
import { buildCostOptimizations } from "../lib/aws-cost-optimization.ts";
import type { AwsCostSnapshot } from "../lib/cost-types.ts";
import type { PilotResource } from "../lib/pilot-types.ts";

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
  assert.ok(report.limitations.includes("NO_PER_RESOURCE_UTILIZATION_METRICS_COLLECTED"));
});

test("is deterministic and severity-ordered", () => {
  const build = () => buildCostOptimizations({ snapshot: snapshot(), resources: [resource({ resourceKey: "i-1", state: "stopped" })] });
  assert.equal(JSON.stringify(build()), JSON.stringify(build()));
  const severities = build().recommendations.map((r) => r.severity);
  assert.deepEqual([...severities].sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a] - ({ high: 0, medium: 1, low: 2 })[b]), severities);
});
