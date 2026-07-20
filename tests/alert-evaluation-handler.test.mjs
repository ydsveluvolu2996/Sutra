import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const { runAlertEvaluationJob } = await import("../db/background-job-handlers.ts");

const SCOPE = { orgId: "org_h", customerId: "cust_h" };

function rule(over) {
  return {
    id: `arule_${"a".repeat(32)}`,
    name: "critical-findings",
    metric: "open-critical-findings-count",
    comparator: "gt",
    threshold: 0,
    severity: "high",
    scope: SCOPE,
    enabled: true,
    destinationRef: null,
    ...over,
  };
}

function job() {
  return { id: `job_${"b".repeat(32)}`, orgId: SCOPE.orgId, customerId: SCOPE.customerId, kind: "alert-evaluation", payload: {} };
}

function fired(value) {
  return { "open-critical-findings-count": { value, available: true, basis: "test" } };
}

test("a fired rule is recorded and dispatched through the injected delivery", async () => {
  const recorded = [];
  const dispatched = [];
  const summary = await runAlertEvaluationJob(job(), {
    loadEnabledRules: async () => [rule()],
    loadMetrics: async () => fired(4),
    recordEvent: async (input) => { recorded.push(input); return input; },
    dispatch: async (input) => {
      dispatched.push(input);
      return { deliveryState: "queued", destinationCount: 2 };
    },
    now: () => 1_700_000_000_000,
  });

  assert.equal(summary.rulesEvaluated, 1);
  assert.equal(summary.fired, 1);
  assert.equal(summary.dispatched, 1);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].evaluation.observedValue, 4);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].deliveryState, "queued");
  assert.equal(recorded[0].destinationCount, 2);
  assert.equal(recorded[0].observedValue, 4);
  assert.equal(recorded[0].ruleId, rule().id);
});

test("a firing with NO configured destination is recorded as not-delivered, never faked", async () => {
  const recorded = [];
  const summary = await runAlertEvaluationJob(job(), {
    loadEnabledRules: async () => [rule()],
    loadMetrics: async () => fired(9),
    recordEvent: async (input) => { recorded.push(input); return input; },
    dispatch: async () => ({ deliveryState: "no_destination", destinationCount: 0 }),
    now: () => 1_700_000_000_000,
  });

  assert.equal(summary.fired, 1);
  assert.equal(summary.dispatched, 0);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].deliveryState, "no_destination");
  assert.equal(recorded[0].destinationCount, 0);
});

test("an unavailable metric never dispatches and records nothing", async () => {
  const recorded = [];
  let dispatchCalls = 0;
  const summary = await runAlertEvaluationJob(job(), {
    loadEnabledRules: async () => [rule({ comparator: "gt", threshold: -1 })],
    loadMetrics: async () => ({ "open-critical-findings-count": { value: null, available: false, basis: "unreachable" } }),
    recordEvent: async (input) => { recorded.push(input); return input; },
    dispatch: async () => { dispatchCalls += 1; return { deliveryState: "queued", destinationCount: 1 }; },
    now: () => 1_700_000_000_000,
  });

  assert.equal(summary.fired, 0);
  assert.equal(dispatchCalls, 0);
  assert.equal(recorded.length, 0);
});

test("with no enabled rules the job is a no-op", async () => {
  const summary = await runAlertEvaluationJob(job(), {
    loadEnabledRules: async () => [],
    loadMetrics: async () => { throw new Error("metrics should not be collected when there are no rules"); },
    recordEvent: async () => { throw new Error("no event should be recorded"); },
    dispatch: async () => { throw new Error("no dispatch should happen"); },
    now: () => 1_700_000_000_000,
  });
  assert.deepEqual(summary, { rulesEvaluated: 0, fired: 0, dispatched: 0 });
});

test("a job with no customer scope is rejected", async () => {
  await assert.rejects(
    () => runAlertEvaluationJob({ ...job(), customerId: null }, {
      loadEnabledRules: async () => [rule()],
      loadMetrics: async () => fired(4),
      recordEvent: async (input) => input,
      dispatch: async () => ({ deliveryState: "queued", destinationCount: 1 }),
      now: () => 1,
    }),
    /alert-evaluation-requires-customer/u,
  );
});
