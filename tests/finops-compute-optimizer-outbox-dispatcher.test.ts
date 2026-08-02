import assert from "node:assert/strict";
import { test } from "node:test";

import { createComputeOptimizerActivationBoundary } from
  "../lib/finops-compute-optimizer-activation-jobs.ts";
import {
  ComputeOptimizerOutboxDispatcherError,
  dispatchComputeOptimizerMaterializerOutbox,
  type ComputeOptimizerOutboxWork,
} from "../lib/finops-compute-optimizer-outbox-dispatcher.ts";
import { parseComputeOptimizerMaterializationJobPayload } from
  "../lib/finops-compute-optimizer-materialization-runtime.ts";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");
const CONNECTION = `conn_${"a".repeat(32)}`;

async function work(state: ComputeOptimizerOutboxWork["state"]): Promise<ComputeOptimizerOutboxWork> {
  const payload = await parseComputeOptimizerMaterializationJobPayload({
    schemaVersion: "sutra.compute-optimizer-materialization-job.v1",
    activationId: `comra_${"1".repeat(64)}`,
    planCheckpointId: `comrp_${"2".repeat(64)}`,
    scheduledWindow: "2026-08-02T00:00:00.000Z",
    scope: {
      organizationId: "org-outbox",
      customerId: "customer-outbox",
      connectionId: CONNECTION,
    },
    requesterAccountId: "123456789012",
    partition: "aws",
    planSetId: `copes_${"3".repeat(64)}`,
    planSetContentSha256: "3".repeat(64),
    regionContracts: [{
      region: "us-east-1",
      describeContractId: "describe-use1",
      objectContractId: "object-use1",
    }],
  });
  return {
    outboxId: `coob_${"4".repeat(64)}`,
    scope: {
      organizationId: "org-outbox",
      customerId: "customer-outbox",
      connectionId: CONNECTION,
    },
    payload,
    state,
    deliveryAttempt: state === "PENDING" ? 0 : 1,
    leaseExpiresAtIso: state === "LEASED"
      ? new Date(NOW - 1).toISOString() : null,
  };
}

function boundary(signal?: AbortSignal) {
  return createComputeOptimizerActivationBoundary({
    nowMs: NOW,
    maximumDurationMs: 60_000,
    ...(signal === undefined ? {} : { signal }),
  });
}

test("expired lease recovers, requeues, publishes by immutable outbox id, then CAS dispatches", async () => {
  const initial = await work("LEASED");
  const events: string[] = [];
  const enqueued: Array<Readonly<Record<string, unknown>>> = [];
  const result = await dispatchComputeOptimizerMaterializerOutbox({
    listWork: async () => [initial],
    markExpiredLeaseRecoverable: async (_scope, input) => {
      events.push(`recover:${input.outboxId}`);
      return { ...initial, state: "RECOVERABLE", leaseExpiresAtIso: null };
    },
    requeueRecoverable: async (_scope, input) => {
      events.push(`requeue:${input.outboxId}`);
      return { ...initial, state: "PENDING", leaseExpiresAtIso: null };
    },
    lease: async (_scope, input) => {
      events.push(`lease:${input.outboxId}`);
      return {
        ...initial,
        state: "LEASED",
        deliveryAttempt: 2,
        leaseExpiresAtIso: new Date(NOW + 300_000).toISOString(),
      };
    },
    enqueue: async (input) => {
      enqueued.push(structuredClone(input));
      events.push("enqueue");
      return { id: `job_${"5".repeat(32)}` };
    },
    markDispatched: async (_scope, input) => {
      events.push(`dispatch:${input.outboxId}`);
    },
    createLeaseToken: () => "lease-token-outbox-0001",
    now: () => NOW,
  }, boundary());
  assert.deepEqual(result, { examined: 1, recovered: 1, dispatched: 1 });
  assert.deepEqual(events, [
    `recover:${initial.outboxId}`,
    `requeue:${initial.outboxId}`,
    `lease:${initial.outboxId}`,
    "enqueue",
    `dispatch:${initial.outboxId}`,
  ]);
  assert.equal(enqueued[0]?.idempotencyKey,
    `finops-compute-optimizer-materializer-outbox:${initial.outboxId}`);
});

test("crash after queue publication is retried with the same deterministic queue identity", async () => {
  const pending = await work("PENDING");
  const queueKeys: string[] = [];
  let first = true;
  const common = {
    listWork: async () => [pending],
    markExpiredLeaseRecoverable: async () => pending,
    requeueRecoverable: async () => pending,
    lease: async () => ({
      ...pending,
      state: "LEASED" as const,
      deliveryAttempt: 1,
      leaseExpiresAtIso: new Date(NOW + 300_000).toISOString(),
    }),
    enqueue: async (input: { idempotencyKey: string }) => {
      queueKeys.push(input.idempotencyKey);
      return { id: `job_${"6".repeat(32)}` };
    },
    markDispatched: async () => {
      if (first) { first = false; throw new Error("crash-window"); }
    },
    createLeaseToken: () => "lease-token-outbox-0002",
    now: () => NOW,
  };
  await assert.rejects(dispatchComputeOptimizerMaterializerOutbox(common, boundary()),
    (error) => error instanceof ComputeOptimizerOutboxDispatcherError
      && error.code === "CAS_REJECTED");
  await dispatchComputeOptimizerMaterializerOutbox(common, boundary());
  assert.equal(queueKeys.length, 2);
  assert.equal(queueKeys[0], queueKeys[1]);
});

test("pre-aborted dispatcher starts no repository or queue side effect", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(dispatchComputeOptimizerMaterializerOutbox({
    listWork: async () => { calls += 1; return []; },
    markExpiredLeaseRecoverable: async () => { throw new Error(); },
    requeueRecoverable: async () => { throw new Error(); },
    lease: async () => { throw new Error(); },
    enqueue: async () => { throw new Error(); },
    markDispatched: async () => { throw new Error(); },
    now: () => NOW,
  }, boundary(controller.signal)), (error) => error instanceof ComputeOptimizerOutboxDispatcherError
    && error.code === "ABORTED");
  assert.equal(calls, 0);
});

test("dispatcher absolute deadline returns when repository work never settles", async () => {
  const startedAt = Date.now();
  await assert.rejects(dispatchComputeOptimizerMaterializerOutbox({
    listWork: async () => new Promise(() => undefined),
    markExpiredLeaseRecoverable: async () => { throw new Error("unreachable"); },
    requeueRecoverable: async () => { throw new Error("unreachable"); },
    lease: async () => { throw new Error("unreachable"); },
    enqueue: async () => { throw new Error("unreachable"); },
    markDispatched: async () => { throw new Error("unreachable"); },
    now: () => NOW,
  }, {
    signal: new AbortController().signal,
    deadlineAtMs: NOW + 25,
  }), (error) => error instanceof ComputeOptimizerOutboxDispatcherError
    && error.code === "DEADLINE_EXCEEDED");
  assert.ok(Date.now() - startedAt < 500);
});
