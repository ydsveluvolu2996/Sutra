import assert from "node:assert/strict";
import test from "node:test";

const { enqueueTenantCollectionJob, HostedCollectorJobError, HOSTED_COLLECTOR_COLLECT_JOB_KIND } =
  await import("../lib/hosted-collector-job.ts");

const VALID = { orgId: "org_1", customerId: "cust_1", connectionId: "conn_1", operationId: "onb_1" };

function recordingPort() {
  const calls = [];
  return {
    calls,
    async enqueue(input) {
      calls.push(input);
      return { id: "job_deadbeefdeadbeefdeadbeefdeadbeef" };
    },
  };
}

test("adapter rejects malformed identifiers before enqueuing", async () => {
  const port = recordingPort();
  for (const bad of [
    { ...VALID, orgId: "" },
    { ...VALID, customerId: "has space" },
    { ...VALID, connectionId: "bad\nid" },
    { ...VALID, operationId: "" },
  ]) {
    await assert.rejects(() => enqueueTenantCollectionJob(port, bad), (e) => e instanceof HostedCollectorJobError);
  }
  assert.equal(port.calls.length, 0, "no enqueue is attempted for invalid input");
});

test("adapter enqueues exactly once with server-scoped fields and no tenant identity in payload", async () => {
  const port = recordingPort();
  const result = await enqueueTenantCollectionJob(port, VALID);
  assert.equal(port.calls.length, 1);
  const call = port.calls[0];
  assert.equal(call.kind, HOSTED_COLLECTOR_COLLECT_JOB_KIND);
  assert.equal(call.orgId, "org_1");
  assert.equal(call.customerId, "cust_1");
  assert.equal(call.connectionId, "conn_1", "connectionId is a top-level scoped field, not only in the payload");
  assert.deepEqual(call.payload, { connectionId: "conn_1", operationId: "onb_1" });
  assert.equal(result.jobId, "job_deadbeefdeadbeefdeadbeefdeadbeef");
});

test("adapter surfaces a port that enforces tenant ownership (two-org isolation)", async () => {
  // Port double emulating JobQueueRepository: throws SCOPE_NOT_FOUND when the
  // connection is not owned by the org, succeeds for the matching tenant.
  const owner = { org_1: "conn_1", org_2: "conn_2" };
  const port = {
    async enqueue(input) {
      if (owner[input.orgId] !== input.connectionId) {
        throw Object.assign(new Error("scope"), { code: "SCOPE_NOT_FOUND" });
      }
      return { id: "job_00000000000000000000000000000001" };
    },
  };
  await assert.rejects(
    () => enqueueTenantCollectionJob(port, { orgId: "org_2", customerId: "cust_2", connectionId: "conn_1", operationId: "onb_2" }),
    (e) => e.code === "SCOPE_NOT_FOUND",
  );
  const ok = await enqueueTenantCollectionJob(port, { orgId: "org_1", customerId: "cust_1", connectionId: "conn_1", operationId: "onb_1" });
  assert.equal(ok.jobId, "job_00000000000000000000000000000001");
});
