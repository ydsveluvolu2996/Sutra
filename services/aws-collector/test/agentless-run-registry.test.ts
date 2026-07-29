import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentlessRunAlreadyRunningError,
  AgentlessRunRegistry,
} from "../src/agentless-run-registry.js";

const CLAIM = { runId: "scan_01HXYZABCDEF", tenantId: "org_1", connectionId: "conn_1" };

function registry(): AgentlessRunRegistry {
  let tick = 0;
  return new AgentlessRunRegistry(() => new Date(Date.UTC(2026, 6, 29, 12, 0, tick++)));
}

test("a claimed run reports running until it finishes", () => {
  const runs = registry();
  const claimed = runs.claim(CLAIM);
  assert.equal(claimed.phase, "running");
  assert.equal(claimed.finishedAt, null);
  assert.equal(runs.runningCount(), 1);
});

/**
 * A retried POST must not start a second scan of the same run. Two concurrent scans
 * would double the snapshots, the instances and the bill — and the second teardown
 * could delete resources the first is still using.
 */
test("a second claim while running is refused", () => {
  const runs = registry();
  runs.claim(CLAIM);
  assert.throws(
    () => runs.claim(CLAIM),
    (error: unknown) => error instanceof AgentlessRunAlreadyRunningError,
  );
});

test("a finished run may be claimed again", () => {
  const runs = registry();
  runs.claim(CLAIM);
  runs.fail(CLAIM.runId, { code: "SCAN_TIMED_OUT", message: "no result" });
  assert.doesNotThrow(() => runs.claim(CLAIM), "a retry after a failure is legitimate");
});

test("completion carries the execution result", () => {
  const runs = registry();
  runs.claim(CLAIM);
  runs.complete(CLAIM.runId, { summary: { scanned: 1, findings: 3 } });
  const state = runs.read(CLAIM.runId, CLAIM);
  assert.equal(state?.phase, "completed");
  assert.deepEqual(state?.execution, { summary: { scanned: 1, findings: 3 } });
  assert.equal(state?.error, null);
  assert.equal(runs.runningCount(), 0);
});

test("failure carries a code and never an execution result", () => {
  const runs = registry();
  runs.claim(CLAIM);
  runs.fail(CLAIM.runId, { code: "SCANNER_REFUSED_AMBIGUOUS_DEVICE", message: "2 candidates" });
  const state = runs.read(CLAIM.runId, CLAIM);
  assert.equal(state?.phase, "failed");
  assert.equal(state?.execution, null, "a failed scan must not carry findings");
  assert.equal(state?.error?.code, "SCANNER_REFUSED_AMBIGUOUS_DEVICE");
});

/**
 * A run id is not a capability. A poll from the wrong tenant or a different
 * connection must be indistinguishable from a run that does not exist.
 */
test("a run is invisible to another tenant or another connection", () => {
  const runs = registry();
  runs.claim(CLAIM);
  assert.equal(runs.read(CLAIM.runId, { tenantId: "org_2", connectionId: "conn_1" }), null);
  assert.equal(runs.read(CLAIM.runId, { tenantId: "org_1", connectionId: "conn_2" }), null);
  assert.notEqual(runs.read(CLAIM.runId, CLAIM), null, "the owner still sees it");
});

test("an unknown run reads as null rather than an invented outcome", () => {
  assert.equal(registry().read("scan_neverstarted", CLAIM), null);
});

test("completing or failing an unknown run is a no-op, not a resurrection", () => {
  const runs = registry();
  runs.complete("scan_ghost", { summary: {} });
  runs.fail("scan_ghost", { code: "X", message: "y" });
  assert.equal(runs.read("scan_ghost", CLAIM), null);
});
