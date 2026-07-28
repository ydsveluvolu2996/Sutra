import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SWEEP_RESOURCES,
  settledResourceIds,
  sweepAgentlessTeardownDebt,
  type OutstandingResource,
  type TeardownProber,
} from "../lib/aws-agentless-teardown-sweep.ts";

function resource(overrides: Partial<OutstandingResource> & { resourceId: string }): OutstandingResource {
  return {
    resourceId: overrides.resourceId,
    resourceKind: overrides.resourceKind ?? "snapshot",
    region: overrides.region ?? "ap-south-1",
    accountScope: overrides.accountScope ?? "sutra-scan-account",
    attempts: overrides.attempts ?? 1,
    firstSeenAt: overrides.firstSeenAt ?? "2026-07-28T00:00:00.000Z",
  };
}

function prober(over: Partial<TeardownProber> = {}, log: string[] = []): TeardownProber {
  return {
    stillExists: async () => true,
    deleteScanAccountResource: async ({ resourceId }) => { log.push(`del:${resourceId}`); },
    ...over,
  };
}

test("a resource AWS reports absent is settled without any delete attempt", async () => {
  const log: string[] = [];
  const result = await sweepAgentlessTeardownDebt(
    [resource({ resourceId: "snap-gone" })],
    prober({ stillExists: async () => false }, log),
  );
  assert.equal(result.outcomes[0]?.disposition, "settled");
  assert.deepEqual(log, [], "must not delete something already gone");
  assert.equal(result.summary.stillOutstanding, 0);
});

test("a surviving SCAN-ACCOUNT resource is deleted, because Sutra owns it", async () => {
  const log: string[] = [];
  const result = await sweepAgentlessTeardownDebt(
    [resource({ resourceId: "vol-mine", resourceKind: "volume", accountScope: "sutra-scan-account" })],
    prober({}, log),
  );
  assert.equal(result.outcomes[0]?.disposition, "deleted");
  assert.deepEqual(log, ["del:vol-mine"]);
  assert.equal(result.summary.stillOutstanding, 0);
});

test("a surviving CUSTOMER resource is NEVER deleted — Sutra holds an explicit deny", async () => {
  const log: string[] = [];
  const result = await sweepAgentlessTeardownDebt(
    [resource({ resourceId: "snap-theirs", accountScope: "customer" })],
    prober({}, log),
  );
  assert.equal(result.outcomes[0]?.disposition, "awaiting-customer");
  // The property that matters: no delete call was even attempted. Retrying
  // against the IAM deny would fail forever and imply a capability Sutra
  // deliberately gave up.
  assert.deepEqual(log, []);
  assert.equal(result.summary.awaitingCustomer, 1);
  assert.equal(result.summary.stillOutstanding, 1, "customer-side debt is still billable");
});

test("an ambiguous existence answer is never settled", async () => {
  for (const answer of ["unknown" as const]) {
    const result = await sweepAgentlessTeardownDebt(
      [resource({ resourceId: "snap-maybe" })],
      prober({ stillExists: async () => answer }),
    );
    assert.equal(result.outcomes[0]?.disposition, "unknown");
    assert.equal(result.summary.settled, 0);
    // Optimism here would under-report live spend, so unknown is outstanding.
    assert.equal(result.summary.stillOutstanding, 1);
  }
});

test("a THROWN existence check is treated as unknown, not as absence", async () => {
  const log: string[] = [];
  const result = await sweepAgentlessTeardownDebt(
    [resource({ resourceId: "snap-err" })],
    prober({ stillExists: async () => { throw new Error("throttled"); } }, log),
  );
  assert.equal(result.outcomes[0]?.disposition, "unknown");
  assert.match(result.outcomes[0]?.detail ?? "", /throttled/u);
  assert.deepEqual(log, [], "a failed lookup must not trigger a delete");
  assert.equal(result.summary.stillOutstanding, 1);
});

test("a failed scan-account delete is retryable, not settled", async () => {
  const result = await sweepAgentlessTeardownDebt(
    [resource({ resourceId: "vol-busy", resourceKind: "volume" })],
    prober({ deleteScanAccountResource: async () => { throw new Error("volume in use"); } }),
  );
  assert.equal(result.outcomes[0]?.disposition, "retry-failed");
  assert.match(result.outcomes[0]?.detail ?? "", /volume in use/u);
  assert.equal(result.summary.stillOutstanding, 1);
  assert.deepEqual(settledResourceIds(result), []);
});

test("one bad resource does not stop the sweep", async () => {
  const log: string[] = [];
  const result = await sweepAgentlessTeardownDebt(
    [
      resource({ resourceId: "snap-err" }),
      resource({ resourceId: "vol-ok", resourceKind: "volume" }),
      resource({ resourceId: "snap-theirs", accountScope: "customer" }),
    ],
    {
      stillExists: async ({ resourceId }) => {
        if (resourceId === "snap-err") throw new Error("boom");
        return true;
      },
      deleteScanAccountResource: async ({ resourceId }) => { log.push(`del:${resourceId}`); },
    },
  );
  assert.equal(result.summary.considered, 3);
  assert.deepEqual(log, ["del:vol-ok"], "only the Sutra-owned survivor is deleted");
  assert.deepEqual(result.outcomes.map((o) => o.disposition), ["unknown", "deleted", "awaiting-customer"]);
  assert.equal(result.summary.stillOutstanding, 2);
});

test("settledResourceIds returns exactly the rows safe to close", async () => {
  const result = await sweepAgentlessTeardownDebt(
    [
      resource({ resourceId: "snap-gone" }),
      resource({ resourceId: "vol-mine", resourceKind: "volume" }),
      resource({ resourceId: "snap-theirs", accountScope: "customer" }),
    ],
    {
      stillExists: async ({ resourceId }) => resourceId !== "snap-gone",
      deleteScanAccountResource: async () => {},
    },
  );
  assert.deepEqual([...settledResourceIds(result)].sort(), ["snap-gone", "vol-mine"]);
});

test("the sweep is bounded so a large backlog cannot fan out unboundedly", async () => {
  const many = Array.from({ length: MAX_SWEEP_RESOURCES + 50 }, (_, index) => resource({ resourceId: `snap-${index}` }));
  const result = await sweepAgentlessTeardownDebt(many, prober({ stillExists: async () => false }));
  assert.equal(result.summary.considered, MAX_SWEEP_RESOURCES);
  const capped = await sweepAgentlessTeardownDebt(many, prober({ stillExists: async () => false }), 5);
  assert.equal(capped.summary.considered, 5);
});
