import assert from "node:assert/strict";
import test from "node:test";

import { Ec2ScanWorker, ScanWorkerError, type ScanInstanceOperations } from "../src/ec2-scan-worker.js";
import type { AgentlessScanFinding } from "../src/executor.js";

const IMAGE = "738663485493.dkr.ecr.ap-south-1.amazonaws.com/sutra/agentless-scanner@sha256:"
  + "7c525ef4a8deb23a3ea4d9f1a232244b3054241a2601c74e3fe32d1ed81fefc6";
const VOLUME = "vol-0a1b2c3d4e5f6a7b8";
const INSTANCE = "i-0f1e2d3c4b5a69788";
const REGION = "ap-south-1";

const FINDING: AgentlessScanFinding = {
  source: "trivy-agentless",
  severity: "high",
  title: "CVE-2026-0001 in openssl@3.0.2",
} as AgentlessScanFinding;

interface Recorder {
  readonly calls: string[];
  readonly operations: ScanInstanceOperations;
}

function recorder(overrides: Partial<ScanInstanceOperations> = {}): Recorder {
  const calls: string[] = [];
  const operations: ScanInstanceOperations = {
    launch: async () => { calls.push("launch"); return INSTANCE; },
    waitUntilAttachable: async () => { calls.push("waitUntilAttachable"); },
    attachVolume: async () => { calls.push("attachVolume"); },
    readPublishedRefusal: async () => { calls.push("readRefusal"); return null; },
    readPublishedFindings: async () => { calls.push("readFindings"); return [FINDING]; },
    terminate: async () => { calls.push("terminate"); },
    ...overrides,
  };
  return { calls, operations };
}

/** Narrows in one place so each assertion reads as the property it checks. */
function refusedWith(code: string, messagePattern?: RegExp) {
  return (error: unknown): boolean => {
    if (!(error instanceof ScanWorkerError)) return false;
    if (error.code !== code) return false;
    return messagePattern === undefined || messagePattern.test(error.message);
  };
}

const worker = (r: Recorder, extra = {}) =>
  new Ec2ScanWorker({ operations: r.operations, scannerImage: IMAGE, pollIntervalMs: 1, sleep: async () => {}, ...extra });

test("the happy path launches, attaches, reads findings, and always terminates", async () => {
  const r = recorder();
  const findings = await worker(r).scan({ scanVolumeId: VOLUME, region: REGION, scanners: ["vuln"] });
  assert.deepEqual(findings, [FINDING]);
  // Attach must come after the instance is attachable, and terminate must be last.
  assert.deepEqual(r.calls.slice(0, 3), ["launch", "waitUntilAttachable", "attachVolume"]);
  assert.equal(r.calls.at(-1), "terminate");
});

test("the instance is terminated even when the scan throws", async () => {
  const r = recorder({ attachVolume: async () => { throw new Error("attach denied"); } });
  await assert.rejects(() => worker(r).scan({ scanVolumeId: VOLUME, region: REGION, scanners: ["vuln"] }));
  assert.ok(r.calls.includes("terminate"), "a failed scan must not leave the instance running");
});

test("a scanner refusal is raised, never returned as an empty findings list", async () => {
  const r = recorder({
    readPublishedRefusal: async () => ({ code: "AMBIGUOUS_DEVICE", message: "found 2 candidates" }),
  });
  await assert.rejects(
    () => worker(r).scan({ scanVolumeId: VOLUME, region: REGION, scanners: ["vuln"] }),
    refusedWith("SCANNER_REFUSED_AMBIGUOUS_DEVICE"),
  );
  assert.ok(r.calls.includes("terminate"));
});

test("a scan that never publishes times out loudly and terminates", async () => {
  const r = recorder({ readPublishedFindings: async () => null });
  await assert.rejects(
    () => worker(r, { scanTimeoutMs: 3 }).scan({ scanVolumeId: VOLUME, region: REGION, scanners: ["vuln"] }),
    refusedWith("SCAN_TIMED_OUT"),
  );
  assert.ok(r.calls.includes("terminate"), "a timed-out scan must not leave the instance billing");
});

test("a terminate failure does not mask the scan result", async () => {
  const r = recorder({ terminate: async () => { throw new Error("terminate failed"); } });
  const findings = await worker(r).scan({ scanVolumeId: VOLUME, region: REGION, scanners: ["vuln"] });
  assert.deepEqual(findings, [FINDING], "the findings survive a teardown failure");
});

test("an unusable instance id is reported as needing manual checking", async () => {
  const r = recorder({ launch: async () => "not-an-instance" });
  await assert.rejects(
    () => worker(r).scan({ scanVolumeId: VOLUME, region: REGION, scanners: ["vuln"] }),
    refusedWith("INSTANCE_ID_UNUSABLE", /MUST be checked by hand/u),
  );
});

test("a mutable scanner image is refused at construction", () => {
  assert.throws(
    () => new Ec2ScanWorker({ operations: recorder().operations, scannerImage: "sutra/agentless-scanner:0.1.0" }),
    refusedWith("SCANNER_IMAGE_NOT_PINNED"),
  );
});

test("an empty scanner list is refused rather than reporting nothing found", async () => {
  const r = recorder();
  await assert.rejects(
    () => worker(r).scan({ scanVolumeId: VOLUME, region: REGION, scanners: [] }),
    refusedWith("NO_SCANNERS"),
  );
  assert.equal(r.calls.length, 0, "nothing may be launched for a scan that cannot find anything");
});

test("a malformed volume id or region is refused before anything launches", async () => {
  for (const [volume, region] of [[ "vol-nothex", REGION ], [ VOLUME, "ap_south_1" ]] as const) {
    const r = recorder();
    await assert.rejects(() => worker(r).scan({ scanVolumeId: volume, region, scanners: ["vuln"] }));
    assert.equal(r.calls.length, 0);
  }
});
