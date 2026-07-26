import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// The handler module imports `cloudflare:workers`; the loader resolves it. No
// database is needed here — the handler takes injected deps and the tick takes
// an injected queue, so these are pure unit tests of the sweep + tick logic.
register(new URL("./cloudflare-loader.mjs", import.meta.url));

const {
  runFinopsAlertSweepJob,
  ensureDueFinopsAlertSweepsEnqueued,
  FINOPS_ALERT_SWEEP_INTERVAL_MS,
} = await import("../db/background-job-handlers.ts");

function alert(id, severity = "high") {
  return { id, kind: "cost_anomaly", severity, title: `t-${id}`, summary: `s-${id}`, evidence: {} };
}

function sweepJob(id, overrides = {}) {
  return {
    id,
    orgId: "org1",
    customerId: "cust1",
    connectionId: null,
    kind: "finops-alert-sweep",
    payload: {},
    attempt: 1,
    maxAttempts: 3,
    ...overrides,
  };
}

test("runFinopsAlertSweepJob dispatches each alert to each enabled destination", async () => {
  const dispatched = [];
  const recorded = [];
  await runFinopsAlertSweepJob(sweepJob("job1"), {
    listConnections: async () => [{ id: "conn_a" }, { id: "conn_b" }],
    listDestinations: async () => [
      { id: "ndest_1", enabled: true, configuration: { channel: "slack" } },
      { id: "ndest_2", enabled: false, configuration: { channel: "email", recipients: ["x@y.z"] } },
    ],
    // The customer is evaluated ONCE over every connection id (budgets are
    // customer-wide); the returned alert set already carries per-connection ids.
    evaluate: async (_org, _cust, connectionIds) => {
      assert.deepEqual([...connectionIds], ["conn_a", "conn_b"]);
      return { alerts: [alert("a1"), alert("a2"), alert("b1")] };
    },
    dispatch: async (args) => { dispatched.push(`${args.destinationId}:${args.alert.id}`); },
    recordOutcome: async (outcome) => { recorded.push(outcome); },
  });
  // 3 alerts, ONE enabled destination → 3 dispatches, all to ndest_1.
  assert.deepEqual(dispatched.sort(), ["ndest_1:a1", "ndest_1:a2", "ndest_1:b1"]);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].deliveryState, "queued");
  assert.equal(recorded[0].orgId, "org1");
  assert.equal(recorded[0].customerId, "cust1");
  assert.equal(recorded[0].connectionCount, 2);
  assert.equal(recorded[0].destinationCount, 1);
  assert.equal(recorded[0].alertsEvaluated, 3);
  assert.equal(recorded[0].dispatched, 3);
  assert.equal(recorded[0].dispatchFailures, 0);
  assert.equal(recorded[0].truncated, false);
});

test("runFinopsAlertSweepJob dispatches nothing but RECORDS the undeliverable alerts with no enabled destination", async () => {
  const recorded = [];
  await runFinopsAlertSweepJob(sweepJob("job2"), {
    listConnections: async () => [{ id: "conn_a" }],
    listDestinations: async () => [{ id: "ndest_1", enabled: false, configuration: { channel: "slack" } }],
    evaluate: async () => ({ alerts: [alert("a1")] }),
    dispatch: async () => { throw new Error("should not dispatch"); },
    recordOutcome: async (outcome) => { recorded.push(outcome); },
  });
  // No delivery is attempted, but the sweep no longer disappears silently: the
  // audit trail states that one alert existed and had nowhere to go.
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].deliveryState, "no_destination");
  assert.equal(recorded[0].alertsEvaluated, 1);
  assert.equal(recorded[0].destinationCount, 0);
  assert.equal(recorded[0].dispatched, 0);
});

test("runFinopsAlertSweepJob records nothing when the engines produce no alert", async () => {
  const recorded = [];
  await runFinopsAlertSweepJob(sweepJob("job2b"), {
    listConnections: async () => [{ id: "conn_a" }],
    listDestinations: async () => [{ id: "ndest_1", enabled: true, configuration: { channel: "slack" } }],
    evaluate: async () => ({ alerts: [] }),
    dispatch: async () => { throw new Error("should not dispatch"); },
    recordOutcome: async (outcome) => { recorded.push(outcome); },
  });
  // An hourly "all clear" per tenant would be pure audit-chain noise.
  assert.deepEqual(recorded, []);
});

test("runFinopsAlertSweepJob isolates a failing destination: the good dispatch still lands and the job succeeds", async () => {
  const dispatched = [];
  const failures = [];
  const recorded = [];
  await runFinopsAlertSweepJob(sweepJob("job4"), {
    listConnections: async () => [{ id: "conn_a" }],
    listDestinations: async () => [
      { id: "ndest_bad", enabled: true, configuration: { channel: "slack" } },
      { id: "ndest_good", enabled: true, configuration: { channel: "email", recipients: ["x@y.z"] } },
    ],
    evaluate: async () => ({ alerts: [alert("a1"), alert("a2")] }),
    dispatch: async (args) => {
      if (args.destinationId === "ndest_bad") throw new Error("outbox exploded");
      dispatched.push(`${args.destinationId}:${args.alert.id}`);
    },
    onDispatchError: (alertId, destinationId, error) => { failures.push(`${destinationId}:${alertId}:${String(error)}`); },
    recordOutcome: async (outcome) => { recorded.push(outcome); },
  });
  // 2 alerts x 2 destinations: the bad destination fails twice, the good one
  // still receives BOTH alerts, and the job does not throw (so the runner does
  // not retry-and-re-dispatch everything, and does not dead-letter).
  assert.deepEqual(dispatched.sort(), ["ndest_good:a1", "ndest_good:a2"]);
  assert.equal(failures.length, 2);
  assert.ok(failures.every((entry) => entry.startsWith("ndest_bad:") && entry.includes("outbox exploded")));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].dispatched, 2);
  assert.equal(recorded[0].dispatchFailures, 2);
  assert.equal(recorded[0].deliveryState, "queued");
});

test("runFinopsAlertSweepJob throws only when EVERY dispatch failed, after recording the failure", async () => {
  const recorded = [];
  await assert.rejects(
    () => runFinopsAlertSweepJob(sweepJob("job5"), {
      listConnections: async () => [{ id: "conn_a" }],
      listDestinations: async () => [{ id: "ndest_1", enabled: true, configuration: { channel: "slack" } }],
      evaluate: async () => ({ alerts: [alert("a1")] }),
      dispatch: async () => { throw new Error("outbox down"); },
      recordOutcome: async (outcome) => { recorded.push(outcome); },
    }),
    /finops-alert-sweep-all-dispatches-failed \(1\/1\)/u,
  );
  // The systemic failure is evidenced BEFORE the throw, so it is not only
  // visible as a dead-lettered job.
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].dispatched, 0);
  assert.equal(recorded[0].dispatchFailures, 1);
});

test("runFinopsAlertSweepJob survives a failing audit write", async () => {
  const dispatched = [];
  await runFinopsAlertSweepJob(sweepJob("job6"), {
    listConnections: async () => [{ id: "conn_a" }],
    listDestinations: async () => [{ id: "ndest_1", enabled: true, configuration: { channel: "slack" } }],
    evaluate: async () => ({ alerts: [alert("a1")] }),
    dispatch: async (args) => { dispatched.push(args.alert.id); },
    recordOutcome: async () => { throw new Error("audit chain busy"); },
  });
  // Evidence is best-effort: losing it must not lose the delivered alert.
  assert.deepEqual(dispatched, ["a1"]);
});

test("runFinopsAlertSweepJob rejects a job with no customer scope", async () => {
  await assert.rejects(
    () => runFinopsAlertSweepJob(
      sweepJob("job3", { customerId: null }),
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
    { orgId: "orgA", customerId: "c1", kind: "finops-alert-sweep", status: "queued", createdAt: 0 },
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

test("ensureDueFinopsAlertSweepsEnqueued holds a terminal tenant off until the cadence interval elapses", async () => {
  const finishedAt = 5_000_000;
  const connections = async () => [{ customerId: "c1" }];
  // `list` is created_at DESC, so the newest sweep is first whatever its status.
  const existing = [{ orgId: "orgA", customerId: "c1", kind: "finops-alert-sweep", status: "succeeded", createdAt: finishedAt }];

  const tooSoon = fakeQueue(existing);
  assert.equal(await ensureDueFinopsAlertSweepsEnqueued(tooSoon, ["orgA"], connections, finishedAt + 1), 0);
  assert.deepEqual(tooSoon.enqueued, []);

  const due = fakeQueue(existing);
  assert.equal(
    await ensureDueFinopsAlertSweepsEnqueued(due, ["orgA"], connections, finishedAt + FINOPS_ALERT_SWEEP_INTERVAL_MS + 1),
    1,
  );
  assert.deepEqual(due.enqueued.map((job) => job.customerId), ["c1"]);
});

test("the cadence gate is also the dead-letter cooldown", async () => {
  const deadAt = 9_000_000;
  const queue = fakeQueue([
    { orgId: "orgA", customerId: "c1", kind: "finops-alert-sweep", status: "dead_letter", createdAt: deadAt },
  ]);
  // A dead-lettered sweep is not retried on the very next tick forever…
  assert.equal(await ensureDueFinopsAlertSweepsEnqueued(queue, ["orgA"], async () => [{ customerId: "c1" }], deadAt + 60_000), 0);
  // …it gets exactly one fresh attempt per interval.
  assert.equal(
    await ensureDueFinopsAlertSweepsEnqueued(queue, ["orgA"], async () => [{ customerId: "c1" }], deadAt + FINOPS_ALERT_SWEEP_INTERVAL_MS),
    1,
  );
});
