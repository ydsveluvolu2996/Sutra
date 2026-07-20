import assert from "node:assert/strict";
import test from "node:test";
import { buildIdleWasteInputs } from "../lib/finops-idle-waste-inputs.ts";
import { buildIdleWaste } from "../lib/finops-idle-waste.ts";
import type { NormalizedCurLine } from "../lib/finops-cur.ts";
import type { JsonValue, PilotResource } from "../lib/pilot-types.ts";

const units = (whole: number): string => String(whole * 1_000_000);

function resource(over: Partial<PilotResource> & { resourceType: string; nativeId: string }): PilotResource {
  return {
    resourceKey: over.resourceKey ?? `aws:1:us-east-1:svc:${over.resourceType}:${over.nativeId}`,
    service: over.service ?? "ec2",
    resourceType: over.resourceType,
    nativeId: over.nativeId,
    arn: over.arn ?? null,
    name: over.name ?? null,
    region: over.region ?? "us-east-1",
    state: over.state ?? "available",
    tags: over.tags ?? {},
    configuration: (over.configuration ?? {}) as Readonly<Record<string, JsonValue>>,
    source: over.source ?? { api: "ec2:Describe", accountId: "111122223333", collectedAt: "2026-07-01T00:00:00.000Z" },
    contentSha256: over.contentSha256 ?? "0".repeat(64),
  };
}

test("maps an unattached volume and marks an in-use volume attached", () => {
  const input = buildIdleWasteInputs({
    resources: [
      resource({ resourceType: "aws.ec2.volume", nativeId: "vol-free", configuration: { state: "available", sizeGiB: 200, volumeType: "gp3" } }),
      resource({ resourceType: "aws.ec2.volume", nativeId: "vol-used", configuration: { state: "in-use", sizeGiB: 50, instanceIds: ["i-1"] } }),
    ],
  });
  const free = input.volumes?.find((v) => v.resourceKey.endsWith("vol-free"));
  const used = input.volumes?.find((v) => v.resourceKey.endsWith("vol-used"));
  assert.equal(free?.attached, false);
  assert.equal(free?.sizeGiB, 200);
  assert.equal(used?.attached, true);
});

test("aggregates healthy/registered targets per load balancer across its target groups", () => {
  const lbArn = "arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/demo/1";
  const input = buildIdleWasteInputs({
    resources: [
      resource({ resourceType: "aws.elasticloadbalancingv2.load-balancer", nativeId: lbArn, arn: lbArn, configuration: { type: "application" } }),
      resource({ resourceType: "aws.elasticloadbalancingv2.target-group", nativeId: "tg-1", configuration: { loadBalancerArns: [lbArn], targets: [{ id: "i-1", state: "unhealthy" }, { id: "i-2", state: "unused" }] } }),
    ],
  });
  const lb = input.loadBalancers?.[0];
  assert.equal(lb?.healthyTargetCount, 0);
  assert.equal(lb?.registeredTargetCount, 2);
  // Downstream the engine flags it as idle (no healthy targets).
  assert.equal(buildIdleWaste(input).findings.some((f) => f.category === "idle-load-balancer"), true);
});

test("treats an Elastic IP as associated via associationId / instanceId / networkInterfaceId", () => {
  const input = buildIdleWasteInputs({
    resources: [
      resource({ resourceType: "aws.ec2.elastic-ip", nativeId: "eipalloc-idle", configuration: { associated: false } }),
      resource({ resourceType: "aws.ec2.elastic-ip", nativeId: "eipalloc-eni", configuration: { networkInterfaceId: "eni-1" } }),
    ],
  });
  const idle = input.elasticIps?.find((e) => e.resourceKey.endsWith("eipalloc-idle"));
  const bound = input.elasticIps?.find((e) => e.resourceKey.endsWith("eipalloc-eni"));
  assert.equal(idle?.associated, false);
  assert.equal(bound?.associated, true);
});

test("sums attached EBS storage for a stopped instance from the collected volumes", () => {
  const input = buildIdleWasteInputs({
    resources: [
      resource({ resourceType: "aws.ec2.instance", nativeId: "i-stop", state: "stopped", configuration: { instanceType: "t3.small", state: "stopped" } }),
      resource({ resourceType: "aws.ec2.volume", nativeId: "vol-1", configuration: { state: "in-use", sizeGiB: 30, instanceIds: ["i-stop"] } }),
      resource({ resourceType: "aws.ec2.volume", nativeId: "vol-2", configuration: { state: "in-use", sizeGiB: 20, attachments: [{ instanceId: "i-stop" }] } }),
    ],
  });
  const stopped = input.stoppedInstances?.[0];
  assert.equal(stopped?.attachedVolumeGiB, 50);
});

test("flags an orphaned snapshot when its source volume is not in the collected inventory", () => {
  const input = buildIdleWasteInputs({
    resources: [
      resource({ resourceType: "aws.ec2.volume", nativeId: "vol-present", configuration: { state: "available", sizeGiB: 10 } }),
      resource({ resourceType: "aws.ec2.snapshot", nativeId: "snap-orphan", configuration: { volumeId: "vol-gone", volumeSizeGiB: 40 } }),
      resource({ resourceType: "aws.ec2.snapshot", nativeId: "snap-live", configuration: { volumeId: "vol-present", volumeSizeGiB: 10 } }),
    ],
  });
  const orphan = input.snapshots?.find((s) => s.resourceKey.endsWith("snap-orphan"));
  const live = input.snapshots?.find((s) => s.resourceKey.endsWith("snap-live"));
  assert.equal(orphan?.sourceVolumeExists, false);
  assert.equal(live?.sourceVolumeExists, true);
});

test("joins per-resource CUR cost by tag key and never guesses a mixed-currency total", () => {
  const curLines: NormalizedCurLine[] = [
    line({ id: "vol-free", amount: 7, currency: "USD" }),
    line({ id: "vol-free", amount: 3, currency: "USD" }),
    line({ id: "vol-mixed", amount: 5, currency: "USD" }),
    line({ id: "vol-mixed", amount: 5, currency: "EUR" }),
  ];
  const input = buildIdleWasteInputs({
    resources: [
      resource({ resourceType: "aws.ec2.volume", nativeId: "vol-free", configuration: { state: "available", sizeGiB: 100 } }),
      resource({ resourceType: "aws.ec2.volume", nativeId: "vol-mixed", configuration: { state: "available", sizeGiB: 100 } }),
    ],
    curLines,
    curResourceTagKey: "resourceId",
  });
  const free = input.volumes?.find((v) => v.resourceKey.endsWith("vol-free"));
  const mixed = input.volumes?.find((v) => v.resourceKey.endsWith("vol-mixed"));
  assert.deepEqual(free?.curCost, { currency: "USD", monthlyMicros: units(10) });
  assert.equal(mixed?.curCost, null); // mixed currency -> not joined
});

function line(over: { id: string; amount: number; currency?: string }): NormalizedCurLine {
  return {
    lineItemId: `${over.id}-${over.amount}-${over.currency ?? "USD"}`,
    usageAccountId: "111122223333",
    service: "AmazonEC2",
    chargeCategory: "Usage",
    usageStartIso: "2026-07-01T00:00:00.000Z",
    amountMicros: units(over.amount),
    currency: over.currency ?? "USD",
    tags: { resourceId: over.id },
  };
}
