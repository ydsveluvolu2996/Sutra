import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDescribedVolumes } from "../lib/aws-agentless-discovery.ts";
import { buildAgentlessScanPlan } from "../lib/aws-agentless-scan-plan.ts";
import { executeAgentlessScan, type AgentlessExecutor, type AgentlessScanFinding } from "../services/agentless-scanner/src/scan-runner.ts";

test("discovery normalizes DescribeVolumes into planner input, deriving region from AZ", () => {
  const volumes = normalizeDescribedVolumes({
    Volumes: [
      { VolumeId: "vol-b", Size: 40, Encrypted: true, AvailabilityZone: "ap-south-1b", Attachments: [{ InstanceId: "i-1", State: "attached" }], Tags: [{ Key: "sutra-agentless", Value: "true" }] },
      { VolumeId: "vol-a", Size: 8, Encrypted: false, AvailabilityZone: "ap-south-1a", Attachments: [] },
      { Size: 10, AvailabilityZone: "ap-south-1a" }, // no id → dropped
    ],
  });
  assert.deepEqual(volumes.map((v) => v.volumeId), ["vol-a", "vol-b"]); // sorted, id-less dropped
  const b = volumes.find((v) => v.volumeId === "vol-b");
  assert.equal(b?.region, "ap-south-1");
  assert.equal(b?.instanceId, "i-1");
  assert.equal(b?.attached, true);
  assert.equal(b?.tags?.["sutra-agentless"], "true");
  assert.equal(volumes.find((v) => v.volumeId === "vol-a")?.attached, false);
});

interface Recorder { readonly calls: string[] }
function fakeExecutor(recorder: Recorder, over: Partial<AgentlessExecutor> = {}): AgentlessExecutor {
  return {
    createSnapshot: async ({ volumeId }) => { recorder.calls.push(`snap:${volumeId}`); return { snapshotId: `snap-${volumeId}` }; },
    copySnapshotKms: async ({ snapshotId }) => { recorder.calls.push(`copy:${snapshotId}`); return { snapshotId: `${snapshotId}-kms` }; },
    createScanVolume: async ({ snapshotId }) => { recorder.calls.push(`vol:${snapshotId}`); return { volumeId: `scanvol-${snapshotId}` }; },
    runScan: async (): Promise<readonly AgentlessScanFinding[]> => { recorder.calls.push("scan"); return [{ source: "trivy", severity: "high", title: "CVE-2026-1" }]; },
    deleteVolume: async ({ volumeId }) => { recorder.calls.push(`delvol:${volumeId}`); },
    deleteScanAccountSnapshot: async ({ snapshotId }: { readonly snapshotId: string }) => { recorder.calls.push(`delsnap:${snapshotId}`); },
    ...over,
  };
}

function planFor(volumeId: string, kms = false) {
  return buildAgentlessScanPlan({
    scanAccountId: "111122223333",
    kmsKeyArn: kms ? "arn:aws:kms:ap-south-1:111122223333:key/abc" : null,
    volumes: [{ volumeId, region: "ap-south-1", sizeGiB: 20, encrypted: true, attached: true }],
  });
}

test("executes snapshot -> scan -> teardown and returns findings", async () => {
  const recorder: Recorder = { calls: [] };
  const execution = await executeAgentlessScan(planFor("vol-a"), fakeExecutor(recorder));
  assert.equal(execution.summary.scanned, 1);
  assert.equal(execution.summary.findings, 1);
  // No delsnap for the SOURCE snapshot: Sutra holds no delete permission in the
  // customer account, so the source is handed off, not destroyed.
  assert.deepEqual(recorder.calls, ["snap:vol-a", "vol:snap-vol-a", "scan", "delvol:scanvol-snap-vol-a"]);
  assert.equal(execution.results[0]?.teardownFailures.length, 0);
  assert.deepEqual(execution.results[0]?.cleanupHandoff, ["snap-vol-a"]);
  assert.equal(execution.summary.cleanupHandoffs, 1);
});

test("Sutra NEVER calls a delete against the customer-account source snapshot", async () => {
  const recorder: Recorder = { calls: [] };
  // The executor contract has no method capable of deleting a customer snapshot;
  // this asserts the runner never even attempts one under either code path.
  for (const kms of [false, true]) {
    recorder.calls.length = 0;
    await executeAgentlessScan(planFor("vol-z", kms), fakeExecutor(recorder));
    assert.ok(!recorder.calls.includes("delsnap:snap-vol-z"), `source deleted (kms=${kms})`);
  }
});

test("KMS re-encrypt path tears down the Sutra-owned copy and hands off the source", async () => {
  const recorder: Recorder = { calls: [] };
  const execution = await executeAgentlessScan(planFor("vol-a", true), fakeExecutor(recorder));
  assert.ok(recorder.calls.includes("copy:snap-vol-a"));
  assert.ok(recorder.calls.includes("delsnap:snap-vol-a-kms"));
  // The Sutra-owned copy IS torn down; the customer's source is not.
  assert.ok(!recorder.calls.includes("delsnap:snap-vol-a"));
  assert.equal(execution.results[0]?.toreDown.length, 2); // scan volume + copied
  assert.deepEqual(execution.results[0]?.cleanupHandoff, ["snap-vol-a"]);
});

test("a failed scan still tears down Sutra-owned resources and hands off the source", async () => {
  const recorder: Recorder = { calls: [] };
  const executor = fakeExecutor(recorder, { runScan: async () => { throw new Error("scanner crashed"); } });
  const execution = await executeAgentlessScan(planFor("vol-a"), executor);
  assert.equal(execution.summary.failed, 1);
  assert.equal(execution.results[0]?.error, "scanner crashed");
  // Teardown ran despite the failure.
  assert.ok(recorder.calls.includes("delvol:scanvol-snap-vol-a"));
  assert.equal(execution.results[0]?.toreDown.length, 1);
  // A failed scan still leaves a billable customer snapshot — it must be handed
  // off, not silently forgotten.
  assert.deepEqual(execution.results[0]?.cleanupHandoff, ["snap-vol-a"]);
});

test("a teardown failure is recorded for the TTL sweeper, never thrown", async () => {
  const recorder: Recorder = { calls: [] };
  const executor = fakeExecutor(recorder, { deleteVolume: async () => { throw new Error("volume in use"); } });
  const execution = await executeAgentlessScan(planFor("vol-a"), executor);
  assert.equal(execution.results[0]?.status, "scanned");
  assert.deepEqual(execution.results[0]?.teardownFailures, ["scanvol-snap-vol-a"]);
  assert.equal(execution.summary.teardownFailures, 1);
});
