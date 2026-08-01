import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunnableJob } from "../lib/background-job-runner.ts";
import type { ExtendedSupportProjectionCapture } from "../lib/finops-extended-support-projection.ts";
import {
  EXTENDED_SUPPORT_RUNTIME_BINDING,
  EXTENDED_SUPPORT_RUNTIME_JOB_KIND,
  ExtendedSupportRuntimeError,
  extendedSupportCollectionWindow,
  runExtendedSupportRuntimeHandler,
  scheduleExtendedSupportCollections,
  type ExtendedSupportReplayClaim,
  type ExtendedSupportRuntimeDependencies,
  type ExtendedSupportRuntimeResult,
} from "../lib/finops-extended-support-runtime-binding.ts";

const CONNECTION_A = `conn_${"a".repeat(32)}`;
const CONNECTION_B = `conn_${"b".repeat(32)}`;
const WINDOW = "2026-08-01T00:00:00.000Z";
const SCOPE_A = {
  organizationId: "org_extended",
  customerId: "customer_extended",
  connectionId: CONNECTION_A,
};
const BOUNDARY = {
  scope: {
    orgId: SCOPE_A.organizationId,
    customerId: SCOPE_A.customerId,
    connectionId: SCOPE_A.connectionId,
  },
  managementAccountId: "111122223333",
  partition: "aws" as const,
  accountIds: ["111122223333", "222233334444"],
  regions: ["us-east-1", "us-west-2"],
};
const RESULT: ExtendedSupportRuntimeResult = {
  generationId: `espg_${"c".repeat(64)}`,
  collectionId: `esp_${"d".repeat(64)}`,
  state: "READY",
  becameActive: true,
};

function job(overrides: Partial<RunnableJob> = {}): RunnableJob {
  return {
    id: `job_${"e".repeat(32)}`,
    orgId: SCOPE_A.organizationId,
    customerId: SCOPE_A.customerId,
    connectionId: SCOPE_A.connectionId,
    kind: EXTENDED_SUPPORT_RUNTIME_JOB_KIND,
    payload: { scheduledWindow: WINDOW },
    attempt: 1,
    maxAttempts: 5,
    ...overrides,
  };
}

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(bytes)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function dependencies(input: {
  claim?: ExtendedSupportReplayClaim;
  boundary?: typeof BOUNDARY;
  brokerCalls?: { value: number };
  completed?: unknown[];
  failed?: unknown[];
} = {}): ExtendedSupportRuntimeDependencies {
  const brokerCalls = input.brokerCalls ?? { value: 0 };
  const capture = {
    scope: BOUNDARY.scope,
    managementAccountId: BOUNDARY.managementAccountId,
    partition: BOUNDARY.partition,
    accountIds: BOUNDARY.accountIds,
    regions: BOUNDARY.regions,
    collectionId: RESULT.collectionId,
  } as unknown as ExtendedSupportProjectionCapture;
  return {
    loadBoundary: async () => input.boundary ?? BOUNDARY,
    broker: {
      collect: async (request) => {
        brokerCalls.value += 1;
        assert.deepEqual(request.boundary, BOUNDARY);
        assert.equal(request.inventoryScope, "SERVER_PINNED_ACCOUNT_REGION_FANOUT");
        assert.equal(request.actualCostSource, "ACTIVE_RECONCILED_CUR2_GENERATION");
        assert.equal(request.deadlineAtIso, "2026-08-01T00:15:00.000Z");
        return capture;
      },
    },
    store: {
      recordCapture: async (boundary, received, nowMs) => {
        assert.deepEqual(boundary, BOUNDARY);
        assert.equal(received, capture);
        assert.equal(nowMs, Date.parse(WINDOW));
        return {
          snapshot: {
            generationId: RESULT.generationId,
            snapshot: { collectionId: RESULT.collectionId, state: RESULT.state },
          },
          becameActive: RESULT.becameActive,
        };
      },
    },
    replayStore: {
      claim: async () => input.claim ?? { state: "ACQUIRED", leaseToken: "lease-extended" },
      complete: async (value) => { input.completed?.push(value); },
      fail: async (value) => { input.failed?.push(value); },
    },
    now: () => Date.parse(WINDOW),
  };
}

describe("Extended Support durable runtime binding", () => {
  it("prevalidates every eligible scope before identity-only scheduling", async () => {
    const enqueued: unknown[] = [];
    const count = await scheduleExtendedSupportCollections({
      scheduledWindow: WINDOW,
      loadEligibleScopes: async () => [
        { ...SCOPE_A, connectionId: CONNECTION_B },
        SCOPE_A,
      ],
      queue: { enqueue: async (value) => { enqueued.push(value); } },
    });
    assert.equal(count, 2);
    assert.deepEqual(enqueued, [
      {
        orgId: SCOPE_A.organizationId,
        customerId: SCOPE_A.customerId,
        connectionId: CONNECTION_A,
        kind: EXTENDED_SUPPORT_RUNTIME_JOB_KIND,
        payload: { scheduledWindow: WINDOW },
        maxAttempts: 5,
        idempotencyKey: `extended-support:${SCOPE_A.organizationId}:${SCOPE_A.customerId}:${CONNECTION_A}:2026-08-01T00%3A00%3A00.000Z`,
      },
      {
        orgId: SCOPE_A.organizationId,
        customerId: SCOPE_A.customerId,
        connectionId: CONNECTION_B,
        kind: EXTENDED_SUPPORT_RUNTIME_JOB_KIND,
        payload: { scheduledWindow: WINDOW },
        maxAttempts: 5,
        idempotencyKey: `extended-support:${SCOPE_A.organizationId}:${SCOPE_A.customerId}:${CONNECTION_B}:2026-08-01T00%3A00%3A00.000Z`,
      },
    ]);

    let called = false;
    await assert.rejects(scheduleExtendedSupportCollections({
      scheduledWindow: WINDOW,
      loadEligibleScopes: async () => [SCOPE_A, { ...SCOPE_A }],
      queue: { enqueue: async () => { called = true; } },
    }), (error) => error instanceof ExtendedSupportRuntimeError
      && error.code === "INVALID_JOB");
    assert.equal(called, false);
  });

  it("reloads the server boundary, executes once and seals replay evidence", async () => {
    const completed: unknown[] = [];
    const brokerCalls = { value: 0 };
    const result = await runExtendedSupportRuntimeHandler(
      job(),
      dependencies({ completed, brokerCalls }),
    );
    assert.deepEqual(result, { disposition: "EXECUTED", result: RESULT });
    assert.equal(brokerCalls.value, 1);
    assert.equal(completed.length, 1);
    const completion = completed[0] as { resultSha256: string; result: unknown };
    assert.equal(completion.resultSha256, await digest(RESULT));
    assert.deepEqual(completion.result, RESULT);
  });

  it("replays a sealed result without another provider read", async () => {
    const brokerCalls = { value: 0 };
    const result = await runExtendedSupportRuntimeHandler(job(), dependencies({
      brokerCalls,
      claim: { state: "COMPLETED", result: RESULT, resultSha256: await digest(RESULT) },
    }));
    assert.deepEqual(result, { disposition: "REPLAYED", result: RESULT });
    assert.equal(brokerCalls.value, 0);

    await assert.rejects(runExtendedSupportRuntimeHandler(job(), dependencies({
      claim: { state: "COMPLETED", result: RESULT, resultSha256: "f".repeat(64) },
    })), (error) => error instanceof ExtendedSupportRuntimeError
      && error.code === "COLLECTION_FAILED");
  });

  it("rejects malformed retries and substituted boundaries before provider I/O", async () => {
    for (const malformed of [
      job({ maxAttempts: 4 }),
      job({ attempt: 6 }),
      job({ payload: { scheduledWindow: WINDOW, accountId: "999999999999" } }),
    ]) {
      await assert.rejects(runExtendedSupportRuntimeHandler(malformed, dependencies()),
        (error) => error instanceof ExtendedSupportRuntimeError
          && error.code === "INVALID_JOB");
    }

    const brokerCalls = { value: 0 };
    await assert.rejects(runExtendedSupportRuntimeHandler(job(), dependencies({
      brokerCalls,
      boundary: {
        ...BOUNDARY,
        scope: { ...BOUNDARY.scope, customerId: "customer_attacker" },
      },
    })), (error) => error instanceof ExtendedSupportRuntimeError
      && error.code === "COLLECTION_FAILED"
      && !error.message.includes("attacker"));
    assert.equal(brokerCalls.value, 0);

    await assert.rejects(runExtendedSupportRuntimeHandler(job(), dependencies({
      brokerCalls,
      boundary: { ...BOUNDARY, accountIds: ["222233334444"] },
    })), (error) => error instanceof ExtendedSupportRuntimeError
      && error.code === "COLLECTION_FAILED");
    assert.equal(brokerCalls.value, 0);
  });

  it("uses a canonical UTC day and leaves shared activation disabled", () => {
    assert.equal(
      extendedSupportCollectionWindow(Date.parse("2026-08-01T19:45:00.000Z")),
      WINDOW,
    );
    assert.equal(EXTENDED_SUPPORT_RUNTIME_BINDING.registeredInSharedRuntime, false);
    assert.equal(
      EXTENDED_SUPPORT_RUNTIME_BINDING.activationReason,
      "EXTENDED_SUPPORT_DURABLE_RUNTIME_NOT_REGISTERED",
    );
  });
});
