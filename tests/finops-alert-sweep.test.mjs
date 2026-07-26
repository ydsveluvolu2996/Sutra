import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// The handler module imports `cloudflare:workers`; the loader resolves it. No
// database is needed here — the handler takes injected deps and the tick takes
// an injected queue, so these are pure unit tests of the sweep + tick logic.
register(new URL("./cloudflare-loader.mjs", import.meta.url));

const { runFinopsAlertSweepJob, ensureDueFinopsAlertSweepsEnqueued } = await import("../db/background-job-handlers.ts");

function alert(id, severity = "high") {
  return { id, kind: "cost_anomaly", severity, title: `t-${id}`, summary: `s-${id}`, evidence: {} };
}

test("runFinopsAlertSweepJob dispatches each alert to each enabled destination", async () => {
  const dispatched = [];
  await runFinopsAlertSweepJob(
    { id: "job1", orgId: "org1", customerId: "cust1", connectionId: null, kind: "finops-alert-sweep", payload: {}, attempt: 1, maxAttempts: 3 },
    {
      listConnections: async () => [{ id: "conn_a" }, { id: "conn_b" }],
      listDestinations: async () => [
        { id: "ndest_1", enabled: true, configuration: { channel: "slack" } },
        { id: "ndest_2", enabled: false, configuration: { channel: "email", recipients: ["x@y.z"] } },
      ],
      evaluate: async (_org, _cust, connectionId) => ({ alerts: connectionId === "conn_a" ? [alert("a1"), alert("a2")] : [alert("b1")] }),
      dispatch: async (args) => { dispatched.push(`${args.connectionId}:${args.destinationId}:${args.alert.id}`); },
    },
  );
  // 3 alerts total, ONE enabled destination → 3 dispatches, all to ndest_1.
  assert.equal(dispatched.length, 3);
  assert.ok(dispatched.every((entry) => entry.includes("ndest_1")));
  assert.ok(dispatched.includes("conn_a:ndest_1:a1"));
  assert.ok(dispatched.includes("conn_b:ndest_1:b1"));
});

test("runFinopsAlertSweepJob is a no-op with no enabled destination", async () => {
  let evaluated = false;
  await runFinopsAlertSweepJob(
    { id: "job2", orgId: "org1", customerId: "cust1", connectionId: null, kind: "finops-alert-sweep", payload: {}, attempt: 1, maxAttempts: 3 },
    {
      listConnections: async () => [{ id: "conn_a" }],
      listDestinations: async () => [{ id: "ndest_1", enabled: false, configuration: { channel: "slack" } }],
      evaluate: async () => { evaluated = true; return { alerts: [alert("a1")] }; },
      dispatch: async () => { throw new Error("should not dispatch"); },
    },
  );
  assert.equal(evaluated, false);
});

test("runFinopsAlertSweepJob rejects a job with no customer scope", async () => {
  await assert.rejects(
    () => runFinopsAlertSweepJob(
      { id: "job3", orgId: "org1", customerId: null, connectionId: null, kind: "finops-alert-sweep", payload: {}, attempt: 1, maxAttempts: 3 },
      { listConnections: async () => [], listDestinations: async () => [], evaluate: async () => ({ alerts: [] }), dispatch: async () => {} },
    ),
    /finops-alert-sweep-requires-customer/u,
  );
});

/** Minimal in-memory queue capturing enqueues, duck-typed for the tick. */
function fakeQueue(existing = []) {
  const enqueued = [];
  return {
    enqueued,
    async list(orgId, customerId) {
      return existing.filter((job) => job.orgId === orgId && job.customerId === customerId);
    },
    async enqueue(job) {
      enqueued.push(job);
      return { id: `job_${enqueued.length}`, ...job };
    },
  };
}

test("ensureDueFinopsAlertSweepsEnqueued enqueues one sweep per distinct (org, customer)", async () => {
  const queue = fakeQueue();
  const enqueued = await ensureDueFinopsAlertSweepsEnqueued(
    queue,
    ["orgA", "orgB"],
    async (orgId) => orgId === "orgA"
      ? [{ customerId: "c1" }, { customerId: "c1" }, { customerId: "c2" }] // two connections share c1
      : [{ customerId: "c3" }],
    1000,
  );
  assert.equal(enqueued, 3); // orgA→{c1,c2}, orgB→{c3}
  assert.deepEqual(
    queue.enqueued.map((job) => `${job.orgId}:${job.customerId}:${job.kind}`).sort(),
    ["orgA:c1:finops-alert-sweep", "orgA:c2:finops-alert-sweep", "orgB:c3:finops-alert-sweep"],
  );
});

test("ensureDueFinopsAlertSweepsEnqueued skips a tenant with an in-flight sweep", async () => {
  const queue = fakeQueue([
    { orgId: "orgA", customerId: "c1", kind: "finops-alert-sweep", status: "queued" },
  ]);
  const enqueued = await ensureDueFinopsAlertSweepsEnqueued(
    queue,
    ["orgA"],
    async () => [{ customerId: "c1" }, { customerId: "c2" }],
    1000,
  );
  assert.equal(enqueued, 1); // c1 already active → only c2 enqueued
  assert.deepEqual(queue.enqueued.map((job) => job.customerId), ["c2"]);
});
