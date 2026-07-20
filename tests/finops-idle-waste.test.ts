import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_IDLE_WASTE_PRICING,
  buildIdleWaste,
  type IdleWasteInput,
} from "../lib/finops-idle-waste.ts";

const units = (whole: number): string => String(whole * 1_000_000);

test("prices an unattached EBS volume from the bundled list price and skips attached ones", () => {
  const report = buildIdleWaste({
    volumes: [
      { resourceKey: "vol-a", region: "us-east-1", name: "orphan", attached: false, sizeGiB: 100, volumeType: "gp3" },
      { resourceKey: "vol-b", region: "us-east-1", name: null, attached: true, sizeGiB: 50, volumeType: "gp3" },
    ],
  });
  assert.equal(report.findings.length, 1);
  const finding = report.findings[0];
  assert.equal(finding.category, "unattached-ebs-volume");
  assert.equal(finding.currency, "USD");
  // 100 GiB * 80000 micros/GiB-month.
  assert.equal(finding.estimatedMonthlyWasteMicros, "8000000");
  assert.equal(finding.costBasis, "bundled-list-price");
  assert.equal(report.summary.wasteByCurrencyMicros.USD, "8000000");
  assert.equal(report.summary.findingsWithoutEstimate, 0);
});

test("emits a null estimate with a disclosed reason when the sizing attribute is missing", () => {
  const report = buildIdleWaste({
    volumes: [{ resourceKey: "vol-a", region: null, name: null, attached: false, sizeGiB: null, volumeType: null }],
  });
  const finding = report.findings[0];
  assert.equal(finding.estimatedMonthlyWasteMicros, null);
  assert.equal(finding.currency, null);
  assert.equal(finding.costBasis, "none");
  assert.match(finding.basisReason, /VOLUME_SIZE_NOT_COLLECTED/u);
  assert.equal(report.summary.findingsWithoutEstimate, 1);
  assert.deepEqual(report.summary.wasteByCurrencyMicros, {});
});

test("prefers an exact per-resource CUR cost over the bundled price", () => {
  const report = buildIdleWaste({
    volumes: [{
      resourceKey: "vol-a",
      region: "eu-west-1",
      name: null,
      attached: false,
      sizeGiB: 100,
      volumeType: "gp3",
      curCost: { currency: "EUR", monthlyMicros: units(12) },
    }],
  });
  const finding = report.findings[0];
  assert.equal(finding.costBasis, "cur-line-items");
  assert.equal(finding.currency, "EUR");
  assert.equal(finding.estimatedMonthlyWasteMicros, units(12));
  assert.equal(report.summary.wasteByCurrencyMicros.EUR, units(12));
});

test("flags idle load balancers only when no healthy targets and prices by type", () => {
  const report = buildIdleWaste({
    loadBalancers: [
      { resourceKey: "lb-idle", region: "us-east-1", name: "idle", loadBalancerType: "application", healthyTargetCount: 0, registeredTargetCount: 3 },
      { resourceKey: "lb-live", region: "us-east-1", name: "live", loadBalancerType: "application", healthyTargetCount: 2, registeredTargetCount: 2 },
      { resourceKey: "lb-unknown", region: "us-east-1", name: null, loadBalancerType: null, healthyTargetCount: 0, registeredTargetCount: 0 },
    ],
  });
  const idle = report.findings.find((f) => f.resourceKey === "lb-idle");
  assert.equal(idle?.estimatedMonthlyWasteMicros, DEFAULT_IDLE_WASTE_PRICING.albMonthMicros);
  assert.equal(idle?.costBasis, "bundled-list-price");
  // The healthy balancer is not waste.
  assert.equal(report.findings.some((f) => f.resourceKey === "lb-live"), false);
  // No type => no bundled price, null estimate with a disclosed reason.
  const unknown = report.findings.find((f) => f.resourceKey === "lb-unknown");
  assert.equal(unknown?.estimatedMonthlyWasteMicros, null);
  assert.match(unknown?.basisReason ?? "", /LOAD_BALANCER_TYPE_NOT_COLLECTED/u);
});

test("flags only unassociated Elastic IPs at the bundled monthly price", () => {
  const report = buildIdleWaste({
    elasticIps: [
      { resourceKey: "eip-idle", region: "us-east-1", name: null, associated: false },
      { resourceKey: "eip-live", region: "us-east-1", name: null, associated: true },
    ],
  });
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].resourceKey, "eip-idle");
  assert.equal(report.findings[0].estimatedMonthlyWasteMicros, DEFAULT_IDLE_WASTE_PRICING.elasticIpMonthMicros);
});

test("prices a stopped instance from its attached EBS storage, not compute", () => {
  const report = buildIdleWaste({
    stoppedInstances: [
      { resourceKey: "i-stopped", region: "us-east-1", name: null, stopped: true, attachedVolumeGiB: 30, instanceType: "t3.medium" },
      { resourceKey: "i-running", region: "us-east-1", name: null, stopped: false, attachedVolumeGiB: 30, instanceType: "t3.medium" },
    ],
  });
  assert.equal(report.findings.length, 1);
  const finding = report.findings[0];
  assert.equal(finding.category, "stopped-instance-billing");
  // 30 GiB * 80000 = 2,400,000 micros of attached EBS.
  assert.equal(finding.estimatedMonthlyWasteMicros, "2400000");
});

test("flags an orphaned snapshot (source volume gone) with a snapshot-price upper bound", () => {
  const report = buildIdleWaste({
    snapshots: [
      { resourceKey: "snap-orphan", region: "us-east-1", name: null, sourceVolumeExists: false, volumeSizeGiB: 40 },
      { resourceKey: "snap-live", region: "us-east-1", name: null, sourceVolumeExists: true, volumeSizeGiB: 40 },
    ],
  });
  assert.equal(report.findings.length, 1);
  const finding = report.findings[0];
  assert.equal(finding.category, "orphaned-snapshot");
  // 40 GiB * 50000 = 2,000,000 micros.
  assert.equal(finding.estimatedMonthlyWasteMicros, "2000000");
  assert.match(finding.basisReason, /UPPER_BOUND/u);
});

test("totals waste per currency without summing across currencies and is deterministic", () => {
  const input: IdleWasteInput = {
    volumes: [
      { resourceKey: "vol-usd", region: "us-east-1", name: null, attached: false, sizeGiB: 100, volumeType: "gp3", curCost: { currency: "USD", monthlyMicros: units(10) } },
      { resourceKey: "vol-eur", region: "eu-west-1", name: null, attached: false, sizeGiB: 100, volumeType: "gp3", curCost: { currency: "EUR", monthlyMicros: units(20) } },
    ],
    elasticIps: [{ resourceKey: "eip-usd", region: "us-east-1", name: null, associated: false, curCost: { currency: "USD", monthlyMicros: units(5) } }],
  };
  const first = buildIdleWaste(input);
  const second = buildIdleWaste(input);
  assert.deepEqual(first, second);
  assert.equal(first.summary.wasteByCurrencyMicros.USD, units(15));
  assert.equal(first.summary.wasteByCurrencyMicros.EUR, units(20));
});
