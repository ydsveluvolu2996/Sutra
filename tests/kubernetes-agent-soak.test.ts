import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { runKubernetesAgentSoak } from "../services/kubernetes-collector/src/soak-harness.ts";

const execute = promisify(execFile);

test("bounded soak keeps the agent healthy through restarts, outages, rotation, and replays", async () => {
  const report = await runKubernetesAgentSoak({ cycles: 150, seed: 20_260_717 });
  assert.equal(report.schema, "sutra.kubernetes-agent-soak.v1");
  assert.equal(report.passed, true, JSON.stringify(report.invariants, null, 2));
  assert.equal(report.cycles, 150);
  assert.equal(report.completedCycles + report.failedCycles, 150);
  assert.ok(report.restarts >= 10, `restarts=${String(report.restarts)}`);
  assert.ok(report.failedCycles >= 1, "the fault plan must inject at least one outage");
  assert.ok(report.injectedUploadResponseLossCycles >= 1, "the fault plan must lose one upload response");
  assert.equal(report.successfulEnrollments, 1);
  assert.ok(report.rotations >= 1);
  assert.ok(report.replayedUploads >= 1, "a lost upload response must be replayed idempotently");
  assert.equal(report.staleCredentialUses, 0);
  assert.equal(report.uniquePublications, report.finalSequence);
  assert.ok(report.maximumStateBytes <= 256 * 1024);
  assert.ok(report.virtualDurationMs > 0);
});

test("soak runs are deterministic for the same seed and bounded in cycle count", async () => {
  const [first, second] = await Promise.all([
    runKubernetesAgentSoak({ cycles: 60, seed: 7 }),
    runKubernetesAgentSoak({ cycles: 60, seed: 7 }),
  ]);
  assert.deepEqual(
    { ...first, virtualDurationMs: 0 },
    { ...second, virtualDurationMs: 0 },
  );
  assert.equal(first.virtualDurationMs, second.virtualDurationMs);
  await assert.rejects(runKubernetesAgentSoak({ cycles: 9, seed: 1 }), /cycles must be/u);
  await assert.rejects(runKubernetesAgentSoak({ cycles: 10_001, seed: 1 }), /cycles must be/u);
  await assert.rejects(runKubernetesAgentSoak({ cycles: 60, seed: -1 }), /seed/u);
});

test("soak CLI persists agent state on disk, prints a report, and exits zero on success", async () => {
  const { stdout } = await execute(process.execPath, [
    "scripts/kubernetes-agent-soak.mjs", "--cycles", "60", "--seed", "11",
  ], { cwd: new URL("..", import.meta.url) });
  const report = JSON.parse(stdout) as { passed: boolean; invariants: readonly { name: string }[] };
  assert.equal(report.passed, true);
  assert.deepEqual(report.invariants.map((entry) => entry.name), [
    "single-enrollment",
    "credential-rotation",
    "recovers-after-network-loss",
    "replay-safe-publication",
    "pending-work-drained",
    "bounded-agent-state",
    "no-secret-persisted",
  ]);
});
