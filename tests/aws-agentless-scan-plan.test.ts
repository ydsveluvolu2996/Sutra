import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentlessScanPlan, type AgentlessVolume } from "../lib/aws-agentless-scan-plan.ts";

function volume(over: Partial<AgentlessVolume> & { volumeId: string }): AgentlessVolume {
  return { region: "ap-south-1", sizeGiB: 30, encrypted: true, attached: true, tags: { "sutra-agentless": "true" }, ...over };
}

test("plans snapshot -> scan -> guaranteed teardown per in-scope volume", () => {
  const plan = buildAgentlessScanPlan({
    scanAccountId: "111122223333",
    volumes: [volume({ volumeId: "vol-a" }), volume({ volumeId: "vol-b" })],
  });
  assert.equal(plan.schema, "sutra.aws-agentless-scan-plan.v1");
  assert.equal(plan.mode, "plan");
  assert.equal(plan.summary.inScope, 2);
  const kinds = plan.volumes[0]?.steps.map((step) => step.kind);
  // The final step is a HANDOFF, not a delete: Sutra holds no delete permission
  // in the customer account, so the source snapshot is reaped by the customer's
  // own lifecycle policy. Keeping it as an explicit step means the plan never
  // reads as though the snapshot simply disappears.
  assert.deepEqual(kinds, [
    "create-snapshot", "create-scan-volume", "scan",
    "delete-scan-volume", "handoff-source-snapshot-cleanup",
  ]);
  assert.ok(!kinds?.includes("delete-source-snapshot"));
  // Only Sutra-owned resources are teardown steps — one per volume here (the
  // scan volume). The handoff is deliberately NOT marked teardown, because Sutra
  // does not perform it.
  assert.equal(plan.summary.teardownSteps, 2);
  assert.ok(plan.volumes.every((v) => v.steps.filter((s) => s.teardown).length === 1));
  assert.ok(plan.volumes.every((v) =>
    v.steps.filter((s) => s.kind === "handoff-source-snapshot-cleanup").every((s) => !s.teardown)));
});

test("inserts a KMS re-encryption + copied-snapshot teardown when a scan-account key is given", () => {
  const plan = buildAgentlessScanPlan({
    scanAccountId: "111122223333",
    kmsKeyArn: "arn:aws:kms:ap-south-1:111122223333:key/abc",
    volumes: [volume({ volumeId: "vol-a" })],
  });
  assert.equal(plan.kmsReencrypt, true);
  const kinds = plan.volumes[0]?.steps.map((step) => step.kind);
  assert.ok(kinds?.includes("copy-snapshot-kms"));
  assert.ok(kinds?.includes("delete-copied-snapshot"));
  // Two Sutra-owned teardowns now (scan volume + the re-encrypted copy), and
  // still no delete against the customer's source snapshot.
  assert.equal(plan.summary.teardownSteps, 2);
  assert.ok(!kinds?.includes("delete-source-snapshot"));
  assert.ok(kinds?.includes("handoff-source-snapshot-cleanup"));
});

test("skips volumes honestly (never silently) by required tag and unattached policy", () => {
  const plan = buildAgentlessScanPlan({
    scanAccountId: "111122223333",
    policy: { requiredTags: { "sutra-agentless": "true" }, includeUnattached: false },
    volumes: [
      volume({ volumeId: "vol-tagged" }),
      volume({ volumeId: "vol-untagged", tags: {} }),
      volume({ volumeId: "vol-detached", attached: false }),
    ],
  });
  assert.deepEqual(plan.volumes.map((v) => v.volumeId), ["vol-tagged"]);
  assert.deepEqual(
    plan.skipped,
    [
      { volumeId: "vol-detached", reason: "unattached-excluded" },
      { volumeId: "vol-untagged", reason: "missing-required-tag" },
    ],
  );
});

test("bounds concurrency into waves and clamps TTL/scanners deterministically", () => {
  const volumes = Array.from({ length: 10 }, (_, index) => volume({ volumeId: `vol-${index}` }));
  const plan = buildAgentlessScanPlan({
    scanAccountId: "111122223333",
    policy: { maxConcurrentScans: 4, snapshotTtlHours: 999, scanners: ["malware", "vuln", "vuln"] },
    volumes,
  });
  assert.equal(plan.summary.concurrencyWaves, 3); // ceil(10/4)
  assert.equal(plan.summary.snapshotTtlHours, 168); // clamped to a week
  assert.deepEqual(plan.scanners, ["malware", "vuln"]); // deduped + sorted
});

test("is deterministic regardless of input volume order", () => {
  const a = buildAgentlessScanPlan({ scanAccountId: "1", volumes: [volume({ volumeId: "vol-b" }), volume({ volumeId: "vol-a" })] });
  const b = buildAgentlessScanPlan({ scanAccountId: "1", volumes: [volume({ volumeId: "vol-a" }), volume({ volumeId: "vol-b" })] });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
