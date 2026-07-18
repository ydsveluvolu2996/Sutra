import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDescribedVolumes } from "../lib/aws-agentless-discovery.ts";
import { buildAgentlessScanPlan } from "../lib/aws-agentless-scan-plan.ts";
import { executeAgentlessScan, type AgentlessExecutor, type AgentlessScanFinding } from "../lib/aws-agentless-scan-runner.ts";

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
    deleteSnapshot: async ({ snapshotId }) => { recorder.calls.push(`delsnap:${snapshotId}`); },
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
  assert.deepEqual(recorder.calls, ["snap:vol-a", "vol:snap-vol-a", "scan", "delvol:scanvol-snap-vol-a", "delsnap:snap-vol-a"]);
  assert.equal(execution.results[0]?.teardownFailures.length, 0);
});

test("KMS re-encrypt path copies then tears down the copied AND source snapshots", async () => {
  const recorder: Recorder = { calls: [] };
  const execution = await executeAgentlessScan(planFor("vol-a", true), fakeExecutor(recorder));
  assert.ok(recorder.calls.includes("copy:snap-vol-a"));
  assert.ok(recorder.calls.includes("delsnap:snap-vol-a-kms"));
  assert.ok(recorder.calls.includes("delsnap:snap-vol-a"));
  assert.equal(execution.results[0]?.toreDown.length, 3); // scan volume + copied + source
});

test("a failed scan still tears everything down (cost/blast-radius invariant)", async () => {
  const recorder: Recorder = { calls: [] };
  const executor = fakeExecutor(recorder, { runScan: async () => { throw new Error("scanner crashed"); } });
  const execution = await executeAgentlessScan(planFor("vol-a"), executor);
  assert.equal(execution.summary.failed, 1);
  assert.equal(execution.results[0]?.error, "scanner crashed");
  // Teardown ran despite the failure.
  assert.ok(recorder.calls.includes("delvol:scanvol-snap-vol-a"));
  assert.ok(recorder.calls.includes("delsnap:snap-vol-a"));
  assert.equal(execution.results[0]?.toreDown.length, 2);
});

test("a teardown failure is recorded for the TTL sweeper, never thrown", async () => {
  const recorder: Recorder = { calls: [] };
  const executor = fakeExecutor(recorder, { deleteSnapshot: async () => { throw new Error("snapshot in use"); } });
  const execution = await executeAgentlessScan(planFor("vol-a"), executor);
  assert.equal(execution.results[0]?.status, "scanned");
  assert.deepEqual(execution.results[0]?.teardownFailures, ["snap-vol-a"]);
  assert.equal(execution.summary.teardownFailures, 1);
});
