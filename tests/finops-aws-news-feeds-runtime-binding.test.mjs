import assert from "node:assert/strict";
import test from "node:test";

import {
  AWS_NEWS_FEEDS_RUNTIME_CAPABILITY,
  AwsNewsFeedsRuntimeBindingError,
  buildAwsNewsFeedsRuntimeHandler,
  runAwsNewsFeedsRuntimeJob,
  runAwsNewsFeedsScheduleTick,
} from "../lib/finops-aws-news-feeds-runtime-binding.ts";
import { AWS_NEWS_FEEDS_JOB_KIND } from "../lib/finops-aws-news-feeds-job.ts";

const window = "2026-07-31T12:00:00.000Z";
const scheduledAtMs = Date.parse("2026-07-31T15:59:00.000Z");
const connectionA = {
  organizationId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: `conn_${"a".repeat(32)}`,
  sourceKind: "aws_trust_role",
  status: "active",
};
const connectionB = {
  organizationId: "org_beta",
  customerId: "customer_beta",
  connectionId: `conn_${"b".repeat(32)}`,
  sourceKind: "aws_trust_role",
  status: "active",
};

test("runtime capability reports the registered production adapters", () => {
  assert.deepEqual(AWS_NEWS_FEEDS_RUNTIME_CAPABILITY, {
    schemaVersion: "sutra.aws-news-feeds-runtime-binding.v1",
    handlerImplemented: true,
    schedulerImplemented: true,
    replayContractImplemented: true,
    intervalMs: 21_600_000,
    sharedWorkerRegistered: true,
    durableReplayAdapterRegistered: true,
    outboundGatewayRegistered: true,
    reason: "AWS_NEWS_FEEDS_RUNTIME_REGISTERED",
  });
});

test("six-hour tick submits exact deterministic jobs and isolates per-connection queue failures", async () => {
  const submitted = [];
  const result = await runAwsNewsFeedsScheduleTick({
    scheduledAtMs,
    dependencies: {
      listActiveConnections: async () => [connectionB, connectionA],
      queue: {
        enqueue: async (job, now) => {
          submitted.push({ job, now });
          if (job.connectionId === connectionB.connectionId) throw new Error("tenant queue secret");
        },
      },
    },
  });
  assert.deepEqual(result, {
    schemaVersion: "sutra.aws-news-feeds-runtime-binding.v1",
    scheduledWindow: window,
    connectionCount: 2,
    submittedCount: 1,
    rejectedCount: 1,
  });
  assert.deepEqual(submitted.map(({ job }) => job.connectionId), [connectionA.connectionId, connectionB.connectionId]);
  assert.deepEqual(submitted[0], {
    job: {
      orgId: connectionA.organizationId,
      customerId: connectionA.customerId,
      connectionId: connectionA.connectionId,
      kind: AWS_NEWS_FEEDS_JOB_KIND,
      payload: { scheduledWindow: window },
      maxAttempts: 5,
      runAfter: scheduledAtMs,
      idempotencyKey: `aws-news-feeds:org_alpha:customer_alpha:${connectionA.connectionId}:${window}`,
    },
    now: scheduledAtMs,
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("tick rejects invalid, duplicate, and unbounded discovery and sanitizes discovery failures", async () => {
  const queue = { enqueue: async () => undefined };
  for (const connections of [
    [{ ...connectionA, status: "inactive" }],
    [{ ...connectionA, sourceKind: "azure_service_principal" }],
    [connectionA, connectionA],
    Array.from({ length: 5_001 }, (_, index) => ({ ...connectionA, customerId: `customer_${index}` })),
  ]) {
    await assert.rejects(
      runAwsNewsFeedsScheduleTick({ scheduledAtMs, dependencies: { listActiveConnections: async () => connections, queue } }),
      (error) => error instanceof AwsNewsFeedsRuntimeBindingError && error.code === "INVALID_RUNTIME_INPUT",
    );
  }
  await assert.rejects(
    runAwsNewsFeedsScheduleTick({ scheduledAtMs, dependencies: { listActiveConnections: async () => { throw new Error("database password"); }, queue } }),
    (error) => error instanceof AwsNewsFeedsRuntimeBindingError
      && error.code === "RUNTIME_UNAVAILABLE"
      && !error.message.includes("password"),
  );
  await assert.rejects(
    runAwsNewsFeedsScheduleTick({ scheduledAtMs: -1, dependencies: { listActiveConnections: async () => [], queue } }),
    (error) => error instanceof AwsNewsFeedsRuntimeBindingError && error.code === "INVALID_RUNTIME_INPUT",
  );
});

function runnable(overrides = {}) {
  return {
    id: `job_${"1".repeat(32)}`,
    orgId: connectionA.organizationId,
    customerId: connectionA.customerId,
    connectionId: connectionA.connectionId,
    kind: AWS_NEWS_FEEDS_JOB_KIND,
    payload: { scheduledWindow: window },
    attempt: 1,
    maxAttempts: 5,
    ...overrides,
  };
}

function dependencies(replayStore) {
  const times = [Date.parse(window), Date.parse(window) + 1_000];
  return {
    replayStore,
    gateway: {
      collect: async (source) => ({
        sourceId: source.id,
        status: "FAILED",
        requestUrl: source.feedUrl,
        finalUrl: source.feedUrl,
        redirectChain: [source.feedUrl],
        durationMs: 10,
        fetchedAt: window,
        contentType: null,
        responseBytes: 0,
        parser: null,
        truncated: false,
        failureCode: "PROVIDER_UNAVAILABLE",
        items: [],
      }),
    },
    loadTenantBoundary: async () => ({
      scope: { orgId: connectionA.organizationId, customerId: connectionA.customerId, connectionId: connectionA.connectionId },
      binding: "SERVER_RESOLVED_CONNECTION",
      catalogId: `catalog_${"c".repeat(64)}`,
      catalogCapturedAt: window,
      services: [],
    }),
    recordCapture: async (scope, capture) => ({
      snapshot: {
        scope,
        generationId: `newsg_${"d".repeat(64)}`,
        contentSha256: "e".repeat(64),
        snapshot: { state: "FAILED" },
        createdAtIso: window,
        committedAtIso: null,
      },
      becameActive: false,
      capture,
    }),
    now: () => times.shift(),
  };
}

test("runtime job constructs the exact durable envelope and commits a replay receipt", async () => {
  const claims = [];
  const receipts = [];
  const result = await runAwsNewsFeedsRuntimeJob(runnable(), dependencies({
    claim: async (input) => { claims.push(input); return { state: "ACQUIRED", leaseToken: "lease_runtime" }; },
    complete: async (input) => receipts.push(input),
    fail: async () => assert.fail("successful work must not fail the receipt"),
  }));
  assert.equal(result.disposition, "EXECUTED");
  assert.equal(result.result.state, "FAILED");
  assert.deepEqual(claims, [{
    key: `aws-news-feeds:org_alpha:customer_alpha:${connectionA.connectionId}:${window}`,
    jobId: `job_${"1".repeat(32)}`,
    leaseDurationMs: 60_000,
  }]);
  assert.match(receipts[0].resultSha256, /^[a-f0-9]{64}$/u);
  assert.equal(receipts[0].key, claims[0].key);
});

test("runtime rejects malformed leased scope or payload before claiming replay work", async () => {
  let claimed = false;
  const deps = dependencies({
    claim: async () => { claimed = true; return { state: "IN_PROGRESS" }; },
    complete: async () => undefined,
    fail: async () => undefined,
  });
  for (const job of [
    runnable({ customerId: null }),
    runnable({ connectionId: `conn_${"z".repeat(32)}` }),
    runnable({ payload: { scheduledWindow: window, url: "https://evil.example" } }),
    runnable({ kind: "attacker-kind" }),
    runnable({ attempt: 0 }),
    runnable({ attempt: 6 }),
    runnable({ maxAttempts: 4 }),
    runnable({ payload: { scheduledWindow: "2026-99-31T12:00:00.000Z" } }),
  ]) {
    await assert.rejects(
      runAwsNewsFeedsRuntimeJob(job, deps),
      (error) => error instanceof AwsNewsFeedsRuntimeBindingError && error.code === "INVALID_RUNTIME_INPUT",
    );
  }
  assert.equal(claimed, false);
});

test("shared-worker handler converts an active replay lease into a retryable generic error", async () => {
  const handler = buildAwsNewsFeedsRuntimeHandler(dependencies({
    claim: async () => ({ state: "IN_PROGRESS" }),
    complete: async () => assert.fail("in-progress work must not complete"),
    fail: async () => assert.fail("in-progress work must not fail the durable receipt"),
  }));
  await assert.rejects(
    handler(runnable()),
    (error) => error instanceof AwsNewsFeedsRuntimeBindingError && error.code === "RUNTIME_IN_PROGRESS",
  );
});
