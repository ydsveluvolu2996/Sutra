import assert from "node:assert/strict";
import test from "node:test";
import { detectResourceWaste, type ResourceWasteFinding } from "../lib/finops-waste.ts";
import type { JsonValue, PilotResource } from "../lib/pilot-types.ts";

const NOW = new Date("2026-07-26T00:00:00.000Z");

function resource(
  overrides: Partial<PilotResource> & Pick<PilotResource, "resourceKey" | "resourceType">,
): PilotResource {
  return {
    resourceKey: overrides.resourceKey,
    service: overrides.service ?? "ec2",
    resourceType: overrides.resourceType,
    nativeId: overrides.nativeId ?? overrides.resourceKey,
    arn: overrides.arn ?? null,
    name: overrides.name ?? null,
    region: overrides.region ?? "us-east-1",
    state: overrides.state ?? "",
    tags: overrides.tags ?? {},
    configuration: (overrides.configuration ?? {}) as Readonly<Record<string, JsonValue>>,
    source: overrides.source ?? { api: "test", accountId: "111122223333", collectedAt: NOW.toISOString() },
    contentSha256: overrides.contentSha256 ?? "sha",
  };
}

function find(findings: readonly ResourceWasteFinding[], key: string): ResourceWasteFinding | undefined {
  return findings.find((finding) => finding.resourceKey === key);
}

test("flags an available EBS volume with a gp3 estimate and skips an in-use one", () => {
  const report = detectResourceWaste(
    [
      resource({
        resourceKey: "vol-available",
        resourceType: "aws.ec2.volume",
        configuration: { state: "available", sizeGiB: 100, volumeType: "gp3" },
      }),
      resource({
        resourceKey: "vol-in-use",
        resourceType: "aws.ec2.volume",
        configuration: { state: "in-use", sizeGiB: 50, instanceIds: ["i-123"] },
      }),
    ],
    { now: NOW },
  );

  const available = find(report.findings, "vol-available");
  assert.ok(available, "expected the available volume to be flagged");
  assert.equal(available.wasteKind, "available-ebs-volume");
  assert.equal(available.region, "us-east-1");
  assert.equal(available.estimatedMonthlyUsd, 8); // 100 GiB * $0.08
  assert.equal(available.estimateBasis, "approx gp3 list price");
  // The healthy in-use volume must NOT be flagged (it is the CUR engine's domain).
  assert.equal(find(report.findings, "vol-in-use"), undefined);
});

test("flags an unassociated Elastic IP and skips an associated one", () => {
  const report = detectResourceWaste(
    [
      resource({ resourceKey: "eip-idle", resourceType: "aws.ec2.elastic-ip", configuration: {} }),
      resource({
        resourceKey: "eip-used",
        resourceType: "aws.ec2.elastic-ip",
        configuration: { associationId: "eipassoc-1", instanceId: "i-9" },
      }),
    ],
    { now: NOW },
  );

  const idle = find(report.findings, "eip-idle");
  assert.ok(idle);
  assert.equal(idle.wasteKind, "unassociated-elastic-ip");
  assert.equal(idle.estimatedMonthlyUsd, 3.6);
  assert.equal(idle.estimateBasis, "approx idle Elastic IP list price");
  assert.equal(find(report.findings, "eip-used"), undefined);
});

test("flags an empty load balancer and skips one with registered targets", () => {
  const empty = resource({
    resourceKey: "alb-empty",
    resourceType: "aws.elasticloadbalancingv2.load-balancer",
    arn: "arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/empty/1",
    configuration: { type: "application" },
  });
  const busy = resource({
    resourceKey: "alb-busy",
    resourceType: "aws.elasticloadbalancingv2.load-balancer",
    arn: "arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/busy/2",
    configuration: { type: "application" },
  });
  const busyTargetGroup = resource({
    resourceKey: "tg-busy",
    resourceType: "aws.elasticloadbalancingv2.target-group",
    configuration: {
      loadBalancerArns: ["arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/busy/2"],
      targets: [{ id: "i-1", state: "healthy" }],
    },
  });

  const report = detectResourceWaste([empty, busy, busyTargetGroup], { now: NOW });

  const flagged = find(report.findings, "alb-empty");
  assert.ok(flagged);
  assert.equal(flagged.wasteKind, "empty-load-balancer");
  assert.equal(flagged.estimatedMonthlyUsd, 16.2);
  assert.equal(flagged.estimateBasis, "approx load balancer fixed-hours list price");
  assert.equal(find(report.findings, "alb-busy"), undefined);
});

test("flags an aged snapshot past the threshold and not a recent one", () => {
  const report = detectResourceWaste(
    [
      resource({
        resourceKey: "snap-old",
        resourceType: "aws.ec2.snapshot",
        configuration: { startTime: "2026-01-01T00:00:00.000Z", volumeId: "vol-x" }, // ~206 days old
      }),
      resource({
        resourceKey: "snap-recent",
        resourceType: "aws.ec2.snapshot",
        configuration: { startTime: "2026-07-01T00:00:00.000Z", volumeId: "vol-y" }, // 25 days old
      }),
    ],
    { now: NOW, thresholdDays: 90 },
  );

  const old = find(report.findings, "snap-old");
  assert.ok(old, "expected the aged snapshot to be flagged");
  assert.equal(old.wasteKind, "aged-ebs-snapshot");
  assert.equal(old.estimatedMonthlyUsd, null); // incremental storage not derivable — never fabricated
  assert.equal(old.estimateBasis, null);
  assert.equal(find(report.findings, "snap-recent"), undefined);
});

test("aged-snapshot detection is skipped when no reference clock is supplied", () => {
  const report = detectResourceWaste([
    resource({
      resourceKey: "snap-old",
      resourceType: "aws.ec2.snapshot",
      configuration: { startTime: "2020-01-01T00:00:00.000Z" },
    }),
  ]);
  assert.equal(report.findings.length, 0);
});

test("flags a stopped instance holding EBS (informational) with an attached-storage estimate", () => {
  const report = detectResourceWaste(
    [
      resource({
        resourceKey: "i-stopped",
        resourceType: "aws.ec2.instance",
        nativeId: "i-stopped",
        configuration: { state: "stopped", instanceType: "m5.large" },
      }),
      resource({
        resourceKey: "vol-attached",
        resourceType: "aws.ec2.volume",
        configuration: { state: "in-use", sizeGiB: 200, instanceIds: ["i-stopped"] },
      }),
    ],
    { now: NOW },
  );

  const stopped = find(report.findings, "i-stopped");
  assert.ok(stopped);
  assert.equal(stopped.wasteKind, "stopped-ec2-instance-storage");
  assert.equal(stopped.estimatedMonthlyUsd, 16); // 200 GiB * $0.08
  assert.equal(stopped.estimateBasis, "approx gp3 list price (attached EBS)");
  // The in-use volume attached to the stopped instance is NOT itself flagged.
  assert.equal(find(report.findings, "vol-attached"), undefined);
});

test("groups by wasteKind with counts, summed estimate, and a total", () => {
  const report = detectResourceWaste(
    [
      resource({ resourceKey: "vol-1", resourceType: "aws.ec2.volume", configuration: { state: "available", sizeGiB: 100 } }),
      resource({ resourceKey: "vol-2", resourceType: "aws.ec2.volume", configuration: { state: "available", sizeGiB: 50 } }),
      resource({ resourceKey: "eip-1", resourceType: "aws.ec2.elastic-ip", configuration: {} }),
    ],
    { now: NOW },
  );

  const volumeGroup = report.groups.find((group) => group.wasteKind === "available-ebs-volume");
  assert.ok(volumeGroup);
  assert.equal(volumeGroup.count, 2);
  assert.equal(volumeGroup.estimatedMonthlyUsd, 12); // (100 + 50) * $0.08
  assert.equal(report.totalEstimatedMonthlyUsd, 15.6); // 12 + 3.6 EIP
});

test("is robust to missing/malformed configuration keys (never throws)", () => {
  const report = detectResourceWaste(
    [
      resource({ resourceKey: "vol-nostate", resourceType: "aws.ec2.volume", configuration: {} }),
      resource({ resourceKey: "snap-badtime", resourceType: "aws.ec2.snapshot", configuration: { startTime: "not-a-date" } }),
      resource({ resourceKey: "other", resourceType: "aws.s3.bucket", configuration: { anything: [1, 2, 3] } }),
    ],
    { now: NOW },
  );
  // A volume with no state and no attachment signal is treated as available (unattached) with a null estimate.
  const volume = find(report.findings, "vol-nostate");
  assert.ok(volume);
  assert.equal(volume.estimatedMonthlyUsd, null);
  // A snapshot with an unparseable time is skipped; an unrelated type is ignored.
  assert.equal(find(report.findings, "snap-badtime"), undefined);
  assert.equal(find(report.findings, "other"), undefined);
});
