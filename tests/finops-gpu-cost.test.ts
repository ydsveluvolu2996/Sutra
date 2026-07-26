import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NormalizedCurLine } from "../lib/finops-cur.ts";
import { parseCurCsv } from "../lib/finops-cur.ts";
import type { PilotResource } from "../lib/pilot-types.ts";
import {
  acceleratorFamily,
  buildGpuCostView,
  instanceTypeFromUsageType,
  UNKNOWN_REGION,
} from "../lib/finops-gpu-cost.ts";

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

function resource(over: Partial<PilotResource> & { resourceKey: string }): PilotResource {
  return {
    resourceKey: over.resourceKey,
    service: over.service ?? "ec2",
    resourceType: over.resourceType ?? "aws.ec2.instance",
    nativeId: over.nativeId ?? over.resourceKey,
    arn: over.arn ?? null,
    name: over.name ?? null,
    region: over.region ?? "us-east-1",
    state: over.state ?? "running",
    tags: over.tags ?? {},
    configuration: over.configuration ?? {},
    source: over.source ?? { api: "ec2:DescribeInstances", accountId: "111111111111", collectedAt: "2026-07-01T00:00:00.000Z" },
    contentSha256: over.contentSha256 ?? "sha",
  };
}

/** An hour quantity expressed as an integer-micro amount. */
function hours(count: number): string {
  return (BigInt(count) * BigInt(1_000_000)).toString();
}

describe("accelerator identification", () => {
  it("derives the family from the instance type, catalog first", () => {
    assert.deepEqual(acceleratorFamily("p4d.24xlarge"), { family: "p4d", accelerator: "gpu", matchedBy: "catalog" });
    assert.deepEqual(acceleratorFamily("g5.xlarge"), { family: "g5", accelerator: "gpu", matchedBy: "catalog" });
    assert.deepEqual(acceleratorFamily("inf2.8xlarge"), { family: "inf2", accelerator: "inferentia", matchedBy: "catalog" });
    assert.deepEqual(acceleratorFamily("trn1.32xlarge"), { family: "trn1", accelerator: "trainium", matchedBy: "catalog" });
    // Non-accelerated families are not GPUs, however large.
    assert.equal(acceleratorFamily("m5.24xlarge"), null);
    assert.equal(acceleratorFamily("r6g.16xlarge"), null);
    assert.equal(acceleratorFamily("not-an-instance-type"), null);
  });

  it("falls back to the accelerator prefix for families not in the catalog", () => {
    // A family AWS has not shipped yet: recognised, and disclosed as a fallback.
    assert.deepEqual(acceleratorFamily("p9.48xlarge"), { family: "p9", accelerator: "gpu", matchedBy: "prefix-fallback" });
    assert.deepEqual(acceleratorFamily("g9e.4xlarge"), { family: "g9e", accelerator: "gpu", matchedBy: "prefix-fallback" });
    assert.deepEqual(acceleratorFamily("trn3.48xlarge"), { family: "trn3", accelerator: "trainium", matchedBy: "prefix-fallback" });
  });

  it("lifts the instance type out of a compute usage type only when present", () => {
    assert.equal(instanceTypeFromUsageType("USE1-BoxUsage:p4d.24xlarge"), "p4d.24xlarge");
    assert.equal(instanceTypeFromUsageType("SpotUsage:g5.xlarge"), "g5.xlarge");
    assert.equal(instanceTypeFromUsageType("EUC1-HeavyUsage:trn1.32xlarge"), "trn1.32xlarge");
    // No colon-suffixed instance type -> null, never inferred from the prefix.
    assert.equal(instanceTypeFromUsageType("USE1-DataTransfer-Out-Bytes"), null);
    assert.equal(instanceTypeFromUsageType("USE1-InputTokenCount-anthropic.claude-3-sonnet"), null);
  });
});

describe("buildGpuCostView", () => {
  it("totals accelerated spend and splits it by family, region and accelerator", () => {
    const view = buildGpuCostView({
      curLines: [
        line({ amountMicros: "780000000", usageType: "USE1-BoxUsage:p4d.24xlarge", region: "us-east-1", usageAmountMicros: hours(24), usageUnit: "Hrs" }),
        line({ amountMicros: "120000000", usageType: "USE1-BoxUsage:g5.12xlarge", region: "us-east-1", usageAmountMicros: hours(30), usageUnit: "Hrs" }),
        line({ amountMicros: "60000000", usageType: "EUC1-BoxUsage:g5.12xlarge", region: "eu-central-1", usageAmountMicros: hours(15), usageUnit: "Hrs" }),
        line({ amountMicros: "40000000", usageType: "USE1-BoxUsage:inf2.xlarge", region: "us-east-1", usageAmountMicros: hours(100), usageUnit: "Hrs" }),
        // Non-accelerated compute and a non-compute line must not be counted.
        line({ amountMicros: "500000000", usageType: "USE1-BoxUsage:m5.4xlarge", region: "us-east-1" }),
        line({ amountMicros: "9000000", usageType: "USE1-DataTransfer-Out-Bytes", region: "us-east-1" }),
      ],
    });

    assert.equal(view.spendAvailable, true);
    assert.equal(view.usageTypePresent, true);
    assert.equal(view.currency, "USD");
    // 780 + 120 + 60 + 40 = 1000; the m5 and data-transfer lines are excluded.
    assert.equal(view.spendMicros, "1000000000");
    assert.equal(view.spendUnits, 1000);
    assert.equal(view.lineCount, 4);

    assert.deepEqual(view.byFamily.map((row) => [row.family, row.spendMicros]), [
      ["p4d", "780000000"],
      ["g5", "180000000"],
      ["inf2", "40000000"],
    ]);
    // Billed hours are the metered quantity, summed exactly across the family.
    assert.equal(view.byFamily[1].billedHours, 45);
    assert.deepEqual(view.byFamily[1].instanceTypes, ["g5.12xlarge"]);
    assert.equal(view.byFamily[0].matchedBy, "catalog");

    assert.deepEqual(view.byRegion.map((row) => [row.region, row.spendMicros]), [
      ["us-east-1", "940000000"],
      ["eu-central-1", "60000000"],
    ]);
    assert.deepEqual(view.byAccelerator.map((row) => [row.accelerator, row.spendMicros]), [
      ["gpu", "960000000"],
      ["inferentia", "40000000"],
    ]);
  });

  it("withholds billed hours when the quantity or unit is missing, and buckets a null region", () => {
    const view = buildGpuCostView({
      curLines: [
        line({ amountMicros: "10000000", usageType: "USE1-BoxUsage:g4dn.xlarge", region: null, usageAmountMicros: hours(5), usageUnit: "Hrs" }),
        // Same family, no metered quantity -> the family's hours are not derivable.
        line({ amountMicros: "10000000", usageType: "USE1-BoxUsage:g4dn.xlarge", region: null }),
      ],
    });
    assert.equal(view.byFamily[0].billedHours, null);
    assert.equal(view.byFamily[0].billedHoursMicros, null);
    assert.equal(view.byRegion[0].region, UNKNOWN_REGION);
  });

  it("reports GPU idle detection as unavailable, never inferring idleness", () => {
    const view = buildGpuCostView({
      curLines: [line({ amountMicros: "780000000", usageType: "USE1-BoxUsage:p4d.24xlarge", region: "us-east-1" })],
      resources: [resource({ resourceKey: "i-gpu-1", configuration: { instanceType: "p4d.24xlarge" } })],
      // The production case: no GPU utilisation collector exists.
      utilization: [],
    });
    // Spend and inventory are truthful...
    assert.equal(view.spendAvailable, true);
    assert.equal(view.inventory.instanceCount, 1);
    // ...and idleness is simply not claimed.
    assert.equal(view.utilization.collected, false);
    assert.equal(view.utilization.sampleCount, 0);
    assert.deepEqual(view.idleCandidates, []);
    assert.match(view.utilization.reason ?? "", /gpu utilisation is not collected/iu);
    assert.match(view.utilization.requiredCollector, /dcgm|nvidia-smi/iu);
    assert.match(view.disclaimer, /cpu utilisation is never used as a proxy/iu);
    assert.ok(view.limitations.includes("GPU_UTILISATION_IS_NOT_COLLECTED_SO_NO_IDLE_GPU_IS_REPORTED"));
  });

  it("stays unavailable when samples exist but none carries a GPU utilisation figure", () => {
    const view = buildGpuCostView({
      curLines: [],
      utilization: [{ resourceKey: "i-gpu-1", gpuUtilizationP95Percent: null, gpuMemoryUtilizationP95Percent: null, sampleWindowDays: 30 }],
    });
    assert.equal(view.utilization.collected, false);
    assert.equal(view.utilization.sampleCount, 1);
    assert.equal(view.utilization.usableSampleCount, 0);
    assert.deepEqual(view.idleCandidates, []);
    assert.match(view.utilization.reason ?? "", /none named a gpu utilisation figure/iu);
  });

  it("flags idle GPUs only once real GPU samples over a long enough window exist", () => {
    const view = buildGpuCostView({
      curLines: [line({ amountMicros: "780000000", usageType: "USE1-BoxUsage:p4d.24xlarge" })],
      resources: [resource({ resourceKey: "i-idle", configuration: { instanceType: "p4d.24xlarge" } })],
      utilization: [
        { resourceKey: "i-idle", gpuUtilizationP95Percent: 2, gpuMemoryUtilizationP95Percent: 4, sampleWindowDays: 30 },
        // Busy GPU: not a candidate.
        { resourceKey: "i-busy", gpuUtilizationP95Percent: 88, gpuMemoryUtilizationP95Percent: 70, sampleWindowDays: 30 },
        // Idle but observed for too short a window: not a candidate.
        { resourceKey: "i-new", gpuUtilizationP95Percent: 1, gpuMemoryUtilizationP95Percent: null, sampleWindowDays: 3 },
      ],
    });
    assert.equal(view.utilization.collected, true);
    assert.equal(view.utilization.usableSampleCount, 3);
    assert.deepEqual(view.idleCandidates.map((row) => row.resourceKey), ["i-idle"]);
    assert.equal(view.idleCandidates[0].instanceType, "p4d.24xlarge");
    assert.match(view.idleCandidates[0].evidence, /GPU p95 2% over 30d/u);
  });

  it("builds the CMDB inventory independently of the billing file", () => {
    const view = buildGpuCostView({
      curLines: [],
      resources: [
        resource({ resourceKey: "i-1", configuration: { instanceType: "g5.xlarge" } }),
        resource({ resourceKey: "i-2", configuration: { instanceType: "g5.xlarge" }, state: "stopped" }),
        resource({ resourceKey: "i-3", configuration: { instanceType: "p5.48xlarge" }, region: "eu-west-1" }),
        // Not accelerated.
        resource({ resourceKey: "i-4", configuration: { instanceType: "m5.large" } }),
        // Instance type not collected: disclosed as unknown, never assumed.
        resource({ resourceKey: "i-5", configuration: {} }),
        // Not an EC2 instance.
        resource({ resourceKey: "vol-1", resourceType: "aws.ec2.volume" }),
      ],
    });
    assert.equal(view.inventory.instanceCount, 3);
    assert.equal(view.inventory.notRunningCount, 1);
    assert.equal(view.inventory.instanceTypeUnknownCount, 1);
    assert.deepEqual(view.inventory.byFamily, [{ family: "g5", instanceCount: 2 }, { family: "p5", instanceCount: 1 }]);
    // No CUR at all: spend is unavailable with a reason, inventory still stands.
    assert.equal(view.spendAvailable, false);
    assert.equal(view.spendMicros, "0");
    assert.match(view.spendUnavailableReason ?? "", /no billing lines have been ingested/iu);
  });

  it("says so when the billing file carries no usage-type column at all", () => {
    const view = buildGpuCostView({
      curLines: [line({ amountMicros: "900000000" }), line({ amountMicros: "100000000" })],
    });
    assert.equal(view.spendAvailable, false);
    assert.equal(view.usageTypePresent, false);
    assert.match(view.spendUnavailableReason ?? "", /no usage-type column/iu);
    assert.deepEqual(view.byFamily, []);
  });

  it("never sums currencies: only the dominant currency is aggregated", () => {
    const view = buildGpuCostView({
      curLines: [
        line({ amountMicros: "10000000", currency: "USD", usageType: "USE1-BoxUsage:g5.xlarge" }),
        line({ amountMicros: "70000000", currency: "EUR", usageType: "EUC1-BoxUsage:g5.xlarge" }),
        line({ amountMicros: "5000000", currency: "EUR", usageType: "EUC1-BoxUsage:p4d.24xlarge" }),
      ],
    });
    assert.equal(view.currency, "EUR");
    assert.deepEqual(view.currenciesPresent, ["EUR", "USD"]);
    assert.equal(view.spendMicros, "75000000");
    assert.equal(view.lineCount, 2);
  });

  it("keeps money exact at bigint magnitudes no float could hold", () => {
    const view = buildGpuCostView({
      curLines: [
        line({ amountMicros: "9007199254740993000000", usageType: "USE1-BoxUsage:p5.48xlarge" }),
        line({ amountMicros: "1", usageType: "USE1-BoxUsage:p5.48xlarge" }),
      ],
    });
    assert.equal(view.spendMicros, "9007199254740993000001");
    assert.equal(view.byFamily[0].spendMicros, "9007199254740993000001");
  });

  it("is deterministic: the same input yields a byte-identical view", () => {
    const input = {
      curLines: [
        line({ amountMicros: "5000000", usageType: "USE1-BoxUsage:g5.xlarge", region: "us-east-1" }),
        line({ amountMicros: "5000000", usageType: "USE1-BoxUsage:p3.2xlarge", region: "us-west-2" }),
        line({ amountMicros: "5000000", usageType: "USE1-BoxUsage:inf1.xlarge", region: "eu-west-1" }),
      ],
      resources: [resource({ resourceKey: "i-b", configuration: { instanceType: "g5.xlarge" } }),
        resource({ resourceKey: "i-a", configuration: { instanceType: "g5.xlarge" } })],
    };
    assert.equal(JSON.stringify(buildGpuCostView(input)), JSON.stringify(buildGpuCostView(input)));
    // Equal spend ties break on the family name, and inventory on resource key.
    assert.deepEqual(buildGpuCostView(input).byFamily.map((row) => row.family), ["g5", "inf1", "p3"]);
    assert.deepEqual(buildGpuCostView(input).inventory.entries.map((row) => row.resourceKey), ["i-a", "i-b"]);
  });

  it("works end-to-end from a real CUR CSV carrying GPU compute line items", () => {
    const parsed = parseCurCsv([
      "line_item_id,line_item_usage_account_id,product_servicecode,line_item_line_item_type,line_item_usage_start_date,line_item_unblended_cost,line_item_currency_code,product_region_code,line_item_usage_type,line_item_usage_amount,pricing_unit",
      "li-1,111111111111,AmazonEC2,Usage,2026-07-01T00:00:00Z,785.6224,USD,us-east-1,USE1-BoxUsage:p4d.24xlarge,24,Hrs",
      "li-2,111111111111,AmazonEC2,SpotUsage,2026-07-01T00:00:00Z,30.10,USD,us-east-1,USE1-SpotUsage:g5.2xlarge,24,Hrs",
      "li-3,111111111111,AmazonEC2,Usage,2026-07-01T00:00:00Z,12.00,USD,us-east-1,USE1-BoxUsage:m5.large,24,Hrs",
    ].join("\n"));
    if ("error" in parsed) throw new Error(parsed.error);
    const view = buildGpuCostView({ curLines: parsed.lines });
    assert.equal(view.spendAvailable, true);
    // 785.6224 + 30.10, exactly, in micro-units; the m5 line is excluded.
    assert.equal(view.spendMicros, "815722400");
    assert.deepEqual(view.byFamily.map((row) => row.family), ["p4d", "g5"]);
    assert.equal(view.byFamily[0].billedHours, 24);
    // Idleness still unavailable: spend evidence never becomes utilisation evidence.
    assert.equal(view.utilization.collected, false);
    assert.deepEqual(view.idleCandidates, []);
  });
});
