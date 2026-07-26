import assert from "node:assert/strict";
import test from "node:test";
import {
  BUNDLED_INSTANCE_CATALOG,
  buildRightsizingInput,
  type CollectedUtilizationSample,
} from "../lib/finops-rightsizing-inputs.ts";
import { buildRightsizingRecommendations } from "../lib/finops-rightsizing.ts";
import type { NormalizedCurLine } from "../lib/finops-cur.ts";
import type { PilotResource } from "../lib/pilot-types.ts";

const units = (whole: number): string => String(whole * 1_000_000);

function collected(over: Partial<CollectedUtilizationSample> & { instanceId: string }): CollectedUtilizationSample {
  return {
    resourceKey: over.resourceKey ?? over.instanceId,
    region: "us-east-1",
    instanceType: "m5.xlarge",
    cpuP95Percent: 10,
    networkP95BytesPerMinute: 1_000_000,
    memoryP95Percent: null,
    sampleWindowDays: 21,
    ...over,
  };
}

function ec2Resource(over: Partial<PilotResource> & { nativeId: string }): PilotResource {
  return {
    resourceKey: `aws:1:us-east-1:ec2:aws.ec2.instance:${over.nativeId}`,
    service: "ec2",
    resourceType: "aws.ec2.instance",
    arn: null,
    name: null,
    region: "us-east-1",
    state: "running",
    tags: {},
    configuration: { instanceType: "m5.xlarge" },
    source: { api: "ec2:DescribeInstances", accountId: "111122223333", collectedAt: "2026-07-01T00:00:00.000Z" },
    contentSha256: "0".repeat(64),
    ...over,
  };
}

test("maps collected samples + direct resource cost into a working engine input", () => {
  const input = buildRightsizingInput({
    utilization: [collected({ instanceId: "i-1", resourceKey: "rk-1" })],
    resourceCosts: [{ resourceKey: "rk-1", currency: "USD", currentMonthlyCostMicros: units(200) }],
  });
  assert.equal(input.samples.length, 1);
  assert.equal(input.samples[0].currentInstanceType, "m5.xlarge");
  assert.equal(input.costs.length, 1);
  assert.equal(input.catalog, BUNDLED_INSTANCE_CATALOG);

  const report = buildRightsizingRecommendations(input);
  assert.equal(report.recommendations[0].state, "downsize-recommended");
  assert.equal(report.recommendations[0].targetInstanceType, "m5.large");
  assert.equal(report.recommendations[0].estimatedMonthlySavingsMicros, units(100));
});

test("backfills the instance type and region from the CMDB resource when the sample omits them", () => {
  const input = buildRightsizingInput({
    utilization: [collected({ instanceId: "i-9", resourceKey: "rk-9", instanceType: null, region: "" })],
    resources: [ec2Resource({ nativeId: "i-9", resourceKey: "rk-9", region: "eu-west-1", configuration: { instanceType: "c5.2xlarge" } })],
    resourceCosts: [{ resourceKey: "rk-9", currency: "USD", currentMonthlyCostMicros: units(400) }],
  });
  assert.equal(input.samples[0].currentInstanceType, "c5.2xlarge");
  assert.equal(input.samples[0].region, "eu-west-1");
  const report = buildRightsizingRecommendations(input);
  assert.equal(report.recommendations[0].targetInstanceType, "c5.xlarge");
});

test("derives per-resource on-demand cost from CUR lines via the resource tag key", () => {
  const curLines: NormalizedCurLine[] = [
    line({ instanceId: "i-1", day: "2026-07-01", amountUnits: 120 }),
    line({ instanceId: "i-1", day: "2026-07-02", amountUnits: 80 }),
    line({ instanceId: "i-other", day: "2026-07-01", amountUnits: 999 }),
  ];
  const input = buildRightsizingInput({
    utilization: [collected({ instanceId: "i-1", resourceKey: "rk-1" })],
    curLines,
    curResourceTagKey: "resourceId",
  });
  assert.equal(input.costs.length, 1);
  assert.equal(input.costs[0].resourceKey, "rk-1");
  assert.equal(input.costs[0].currency, "USD");
  assert.equal(input.costs[0].currentMonthlyCostMicros, units(200));
});

test("omits cost (null saving downstream) when no cost is derivable — never fabricated", () => {
  const input = buildRightsizingInput({ utilization: [collected({ instanceId: "i-1", resourceKey: "rk-1" })] });
  assert.deepEqual(input.costs, []);
  const report = buildRightsizingRecommendations(input);
  assert.equal(report.recommendations[0].state, "downsize-recommended");
  assert.equal(report.recommendations[0].estimatedMonthlySavingsMicros, null);
  assert.deepEqual(report.summary.savingsByCurrencyMicros, {});
});

test("does not guess a total when a resource has CUR lines in mixed currencies", () => {
  const input = buildRightsizingInput({
    utilization: [collected({ instanceId: "i-1", resourceKey: "rk-1" })],
    curLines: [
      line({ instanceId: "i-1", day: "2026-07-01", amountUnits: 100, currency: "USD" }),
      line({ instanceId: "i-1", day: "2026-07-02", amountUnits: 100, currency: "EUR" }),
    ],
    curResourceTagKey: "resourceId",
  });
  assert.deepEqual(input.costs, []);
});

function line(over: { instanceId: string; day: string; amountUnits: number; currency?: string }): NormalizedCurLine {
  return {
    lineItemId: `${over.instanceId}-${over.day}`,
    usageAccountId: "111122223333",
    service: "AmazonEC2",
    chargeCategory: "Usage",
    usageStartIso: `${over.day}T00:00:00.000Z`,
    amountMicros: units(over.amountUnits),
    currency: over.currency ?? "USD",
    region: null,
    amortizedMicros: null,
    commitmentType: null,
    commitmentId: null,
    commitmentExpiry: null,
    usageType: null,
    usageAmountMicros: null,
    usageUnit: null,
    tags: { resourceId: over.instanceId },
  };
}
