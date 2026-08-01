import assert from "node:assert/strict";
import test from "node:test";
import {
  ComputeOptimizerDiscoveryJobError,
  enqueueComputeOptimizerDiscovery,
  parseComputeOptimizerDiscoveryJobPayload,
} from "../lib/finops-compute-optimizer-discovery-job.ts";

const scope = {
  organizationId: "org_co",
  customerId: "customer_co",
  connectionId: `conn_${"a".repeat(32)}`,
};
const run = {
  scope,
  runId: `cor_${"b".repeat(64)}`,
  jobId: "collector-run",
  status: "pending" as const,
  contentSha256: null,
  collectedAt: null,
  dataThroughAt: null,
  accountId: "111122223333",
  partition: "aws" as const,
  region: "us-east-1",
  memberCount: 0,
  exportJobCount: 0,
  coverageCount: 0,
  errorCode: null,
  limitations: [],
  createdAtIso: "2026-08-01T00:00:00.000Z",
  startedAtIso: null,
  finalizedAtIso: null,
};

test("enqueues only the frozen server-owned connection identity", async () => {
  let observed: unknown;
  const id = await enqueueComputeOptimizerDiscovery({
    async enqueue(input) { observed = input; return { id: `job_${"c".repeat(32)}` }; },
  }, scope, run, 100);
  assert.equal(id, `job_${"c".repeat(32)}`);
  assert.deepEqual(observed, {
    orgId: scope.organizationId,
    customerId: scope.customerId,
    connectionId: scope.connectionId,
    kind: "finops-compute-optimizer-discovery",
    payload: { runId: run.runId, connectionId: scope.connectionId },
    maxAttempts: 6,
    idempotencyKey: `finops-compute-optimizer-discovery:${run.runId}`,
  });
  assert.equal(JSON.stringify(observed).includes("region"), false);
  assert.equal(JSON.stringify(observed).includes("s3"), false);
  assert.equal(JSON.stringify(observed).includes("Export"), false);
});

test("payload parser and enqueue reject extra AWS controls, foreign scope, and non-pending runs", async () => {
  for (const payload of [
    { runId: run.runId, connectionId: scope.connectionId, region: "us-west-2" },
    { runId: "bad", connectionId: scope.connectionId },
    { runId: run.runId, connectionId: "bad" },
  ]) assert.throws(() => parseComputeOptimizerDiscoveryJobPayload(payload), ComputeOptimizerDiscoveryJobError);
  await assert.rejects(enqueueComputeOptimizerDiscovery({ async enqueue() { return { id: `job_${"d".repeat(32)}` }; } },
    { ...scope, organizationId: "foreign" }, run), ComputeOptimizerDiscoveryJobError);
  await assert.rejects(enqueueComputeOptimizerDiscovery({ async enqueue() { return { id: `job_${"d".repeat(32)}` }; } },
    scope, { ...run, status: "partial" }), ComputeOptimizerDiscoveryJobError);
});
