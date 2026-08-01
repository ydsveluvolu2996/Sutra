import assert from "node:assert/strict";
import test from "node:test";
import type { RunnableJob } from "../lib/background-job-runner.ts";
import {
  DcfStepFunctionsAdapter,
  DcfStepFunctionsAdapterError,
  DcfStepFunctionsProviderError,
  type DcfStepFunctionsBoundary,
  type DcfStepFunctionsExecutionMetadata,
  type DcfStepFunctionsExecutionSummary,
  type DcfStepFunctionsProvider,
} from "../lib/finops-dcf-step-functions-adapter.ts";
import {
  DCF_STEP_FUNCTIONS_RUNTIME_ACTIVATION_REASON,
  DCF_STEP_FUNCTIONS_RUNTIME_BINDING,
  DCF_STEP_FUNCTIONS_RUNTIME_JOB_KIND,
  DcfStepFunctionsRuntimeError,
  dcfStepFunctionsIdempotencyKey,
  runDcfStepFunctionsRuntimeHandler,
  scheduleDcfStepFunctionsCollections,
} from "../lib/finops-dcf-durable-runtime-binding.ts";
import {
  normalizeDcfCapture,
  type DcfSnapshot,
} from "../lib/finops-dcf-execution-history.ts";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");
const SCOPE = {
  orgId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: `conn_${"a".repeat(32)}`,
  managementAccountId: "111122223333",
  partition: "aws" as const,
  region: "us-east-1",
};
const STATE_MACHINE =
  "arn:aws:states:us-east-1:111122223333:stateMachine:CID-CUR";
const EXECUTION_ONE =
  "arn:aws:states:us-east-1:111122223333:execution:CID-CUR:run-1";
const EXECUTION_TWO =
  "arn:aws:states:us-east-1:111122223333:execution:CID-CUR:run-2";

const BOUNDARY: DcfStepFunctionsBoundary = {
  schemaVersion: "sutra.dcf-step-functions-boundary.v1",
  boundaryId: `dcfb_${"b".repeat(64)}`,
  binding: "SERVER_RESOLVED_DCF_STACK",
  scope: SCOPE,
  schedulerRegistered: true,
  modules: [
    {
      moduleId: "cur",
      moduleName: "CUR collector",
      sourceId: "aws_cur2_data_export",
      enabled: true,
      expectedCadenceMinutes: 60,
      stateMachineArn: STATE_MACHINE,
    },
    {
      moduleId: "disabled-module",
      moduleName: "Disabled collector",
      sourceId: null,
      enabled: false,
      expectedCadenceMinutes: 1_440,
      stateMachineArn:
        "arn:aws:states:us-east-1:111122223333:stateMachine:CID-Disabled",
    },
  ],
};

function listed(
  executionArn: string,
  status: DcfStepFunctionsExecutionSummary["status"] = "SUCCEEDED",
): DcfStepFunctionsExecutionSummary {
  return {
    executionArn,
    stateMachineArn: STATE_MACHINE,
    status,
    startedAt: "2026-08-02T11:55:00.000Z",
    stoppedAt: status === "RUNNING" ? null : "2026-08-02T11:56:00.000Z",
  };
}

function described(
  executionArn: string,
  status: DcfStepFunctionsExecutionMetadata["status"] = "SUCCEEDED",
): DcfStepFunctionsExecutionMetadata {
  return {
    ...listed(executionArn, status),
    redriveCount: executionArn === EXECUTION_TWO ? 1 : 0,
    inputSha256: "c".repeat(64),
    acceptedRecords: 90,
    rejectedRecords: 10,
    expectedRecords: 100,
    processedBytes: 1_024,
    errorCode: status === "SUCCEEDED" || status === "RUNNING" ? null : "TIMEOUT",
  };
}

function describedMachine() {
  return {
    stateMachineArn: STATE_MACHINE,
    status: "ACTIVE" as const,
    type: "STANDARD" as const,
  };
}

test("adapter traverses exact server-pinned state machines with bounded pagination and metadata-only descriptions", async () => {
  const listRequests: Array<Record<string, unknown>> = [];
  const machineRequests: Array<Record<string, unknown>> = [];
  const describeRequests: Array<Record<string, unknown>> = [];
  const provider: DcfStepFunctionsProvider = {
    async describeStateMachine(request) {
      machineRequests.push(request);
      return describedMachine();
    },
    async listExecutions(request) {
      listRequests.push(request);
      return request.nextToken === null
        ? { executions: [listed(EXECUTION_ONE)], nextToken: "next-page" }
        : { executions: [listed(EXECUTION_TWO, "FAILED")], nextToken: null };
    },
    async describeExecution(request) {
      describeRequests.push(request);
      return described(
        request.executionArn,
        request.executionArn === EXECUTION_TWO ? "FAILED" : "SUCCEEDED",
      );
    },
  };
  const result = await new DcfStepFunctionsAdapter({ provider, now: () => NOW })
    .collect(BOUNDARY, new AbortController().signal);
  assert.equal(result.sourceState, "READY");
  assert.deepEqual(result.failureCodes, []);
  assert.equal(result.requestCount, 5);
  assert.equal(result.retryCount, 0);
  assert.equal(result.capture.pageCount, 2);
  assert.equal(result.capture.modules[0]?.executions.length, 2);
  assert.equal(result.capture.modules[1]?.executions.length, 0);
  assert.deepEqual(listRequests.map((request) => request.nextToken), [null, "next-page"]);
  assert.ok(listRequests.every((request) => request.maxResults === 1_000));
  assert.ok(listRequests.every((request) => request.stateMachineArn === STATE_MACHINE));
  assert.deepEqual(machineRequests, [{
    scope: SCOPE,
    stateMachineArn: STATE_MACHINE,
    includedData: "METADATA_ONLY",
  }]);
  assert.ok(describeRequests.every((request) => request.includedData === "METADATA_ONLY"));
  assert.ok(describeRequests.every((request) => request.scope === SCOPE));
  const snapshot = normalizeDcfCapture(result.capture, SCOPE, NOW);
  assert.equal(snapshot.complete, true);
  assert.equal(JSON.stringify(result).includes("input\""), false);
  assert.equal(JSON.stringify(result).includes("output\""), false);
});

test("adapter rejects cross-account evidence and repeated pagination without retaining hostile values", async () => {
  let boundaryNetworkCalled = false;
  await assert.rejects(
    new DcfStepFunctionsAdapter({
      now: () => NOW,
      provider: {
        async describeStateMachine() {
          boundaryNetworkCalled = true;
          return describedMachine();
        },
        async listExecutions() {
          boundaryNetworkCalled = true;
          return { executions: [], nextToken: null };
        },
        async describeExecution() { throw new Error("must not run"); },
      },
    }).collect(
      { ...BOUNDARY, unexpected: true } as unknown as DcfStepFunctionsBoundary,
      new AbortController().signal,
    ),
    (error) => error instanceof DcfStepFunctionsAdapterError
      && error.code === "INVALID_BOUNDARY",
  );
  assert.equal(boundaryNetworkCalled, false);

  await assert.rejects(
    new DcfStepFunctionsAdapter({
      now: () => NOW,
      provider: {
        async describeStateMachine() { throw new Error("must not run"); },
        async listExecutions() { throw new Error("must not run"); },
        async describeExecution() { throw new Error("must not run"); },
      },
    }).collect(
      { ...BOUNDARY, modules: BOUNDARY.modules.map((moduleEntry) => ({ ...moduleEntry, enabled: false })) },
      new AbortController().signal,
    ),
    (error) => error instanceof DcfStepFunctionsAdapterError
      && error.code === "INVALID_BOUNDARY",
  );

  const attackerArn = EXECUTION_ONE.replace("111122223333", "999988887777");
  const crossScope = await new DcfStepFunctionsAdapter({
    now: () => NOW,
    provider: {
      async describeStateMachine() { return describedMachine(); },
      async listExecutions() {
        return { executions: [listed(attackerArn)], nextToken: null };
      },
      async describeExecution() {
        throw new Error("must not describe hostile ARN");
      },
    },
  }).collect(BOUNDARY, new AbortController().signal);
  assert.equal(crossScope.sourceState, "PARTIAL");
  assert.deepEqual(crossScope.failureCodes, ["SCOPE_MISMATCH"]);
  assert.equal(JSON.stringify(crossScope).includes("999988887777"), false);

  let calls = 0;
  const repeated = await new DcfStepFunctionsAdapter({
    now: () => NOW,
    provider: {
      async describeStateMachine() { return describedMachine(); },
      async listExecutions() {
        calls += 1;
        return { executions: [], nextToken: "repeated-token" };
      },
      async describeExecution() {
        throw new Error("must not run");
      },
    },
  }).collect(BOUNDARY, new AbortController().signal);
  assert.equal(calls, 2);
  assert.equal(repeated.capture.pagesExhausted, false);
  assert.deepEqual(repeated.failureCodes, ["SCHEMA_MISMATCH"]);
  assert.equal(JSON.stringify(repeated).includes("repeated-token"), false);

  const future = await new DcfStepFunctionsAdapter({
    now: () => NOW,
    provider: {
      async describeStateMachine() { return describedMachine(); },
      async listExecutions() {
        return {
          executions: [{
            ...listed(EXECUTION_ONE),
            startedAt: "2026-08-03T12:00:00.000Z",
            stoppedAt: "2026-08-03T12:01:00.000Z",
          }],
          nextToken: null,
        };
      },
      async describeExecution() { throw new Error("must not run"); },
    },
  }).collect(BOUNDARY, new AbortController().signal);
  assert.deepEqual(future.failureCodes, ["SCHEMA_MISMATCH"]);
});

test("adapter applies bounded retries and converts cancellation/provider failures to sanitized states", async () => {
  const delays: number[] = [];
  let attempts = 0;
  const recovered = await new DcfStepFunctionsAdapter({
    now: () => NOW,
    sleep: async (milliseconds) => { delays.push(milliseconds); },
    provider: {
      async describeStateMachine() { return describedMachine(); },
      async listExecutions() {
        attempts += 1;
        if (attempts < 3) {
          throw new DcfStepFunctionsProviderError("THROTTLED");
        }
        return { executions: [listed(EXECUTION_ONE)], nextToken: null };
      },
      async describeExecution() {
        return described(EXECUTION_ONE);
      },
    },
  }).collect(BOUNDARY, new AbortController().signal);
  assert.deepEqual(delays, [200, 400]);
  assert.equal(recovered.retryCount, 2);
  assert.equal(recovered.sourceState, "READY");

  const controller = new AbortController();
  controller.abort();
  let called = false;
  const cancelled = await new DcfStepFunctionsAdapter({
    now: () => NOW,
    provider: {
      async describeStateMachine() { return describedMachine(); },
      async listExecutions() {
        called = true;
        throw new Error("credential=secret");
      },
      async describeExecution() {
        throw new Error("must not run");
      },
    },
  }).collect(BOUNDARY, controller.signal);
  assert.equal(called, false);
  assert.equal(cancelled.sourceState, "UNAVAILABLE");
  assert.deepEqual(cancelled.failureCodes, ["TIMEOUT"]);
  assert.equal(JSON.stringify(cancelled).includes("secret"), false);

  const unavailable = await new DcfStepFunctionsAdapter({
    now: () => NOW,
    provider: {
      async describeStateMachine() { return describedMachine(); },
      async listExecutions() {
        throw new DcfStepFunctionsProviderError("AUTHORIZATION_FAILED");
      },
      async describeExecution() {
        throw new Error("must not run");
      },
    },
  }).collect(BOUNDARY, new AbortController().signal);
  assert.equal(unavailable.capture.providerAccess, "DISABLED");
  assert.equal(unavailable.sourceState, "UNAVAILABLE");
  assert.deepEqual(unavailable.failureCodes, ["AUTHORIZATION_FAILED"]);

  let expressListed = false;
  const express = await new DcfStepFunctionsAdapter({
    now: () => NOW,
    provider: {
      async describeStateMachine() {
        return { ...describedMachine(), type: "EXPRESS" as const };
      },
      async listExecutions() {
        expressListed = true;
        return { executions: [], nextToken: null };
      },
      async describeExecution() { throw new Error("must not run"); },
    },
  }).collect(BOUNDARY, new AbortController().signal);
  assert.equal(expressListed, false);
  assert.equal(express.sourceState, "PARTIAL");
  assert.deepEqual(express.failureCodes, ["UNSUPPORTED_STATE_MACHINE"]);
});

const RUNTIME_SCOPE = {
  organizationId: SCOPE.orgId,
  customerId: SCOPE.customerId,
  connectionId: SCOPE.connectionId,
};
const WINDOW = "2026-08-02T12:00:00.000Z";

function job(overrides: Partial<RunnableJob> = {}): RunnableJob {
  return {
    id: `job_${"d".repeat(32)}`,
    orgId: SCOPE.orgId,
    customerId: SCOPE.customerId,
    connectionId: SCOPE.connectionId,
    kind: DCF_STEP_FUNCTIONS_RUNTIME_JOB_KIND,
    payload: { scheduledWindow: WINDOW },
    attempt: 1,
    maxAttempts: 5,
    ...overrides,
  };
}

async function readyCollection() {
  return new DcfStepFunctionsAdapter({
    now: () => NOW,
    provider: {
      async describeStateMachine() { return describedMachine(); },
      async listExecutions() {
        return { executions: [listed(EXECUTION_ONE)], nextToken: null };
      },
      async describeExecution() {
        return described(EXECUTION_ONE);
      },
    },
  }).collect(BOUNDARY, new AbortController().signal);
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

test("runtime schedules sorted tenant-bound jobs and exposes an honestly unregistered binding", async () => {
  const enqueued: Array<Record<string, unknown>> = [];
  const second = { ...RUNTIME_SCOPE, connectionId: `conn_${"e".repeat(32)}` };
  const result = await scheduleDcfStepFunctionsCollections({
    scheduledWindow: WINDOW,
    loadEligibleScopes: async () => [second, RUNTIME_SCOPE],
    queue: { async enqueue(value) { enqueued.push(value); } },
  });
  assert.equal(result.enqueued, 2);
  assert.deepEqual(enqueued.map((value) => value.connectionId), [
    RUNTIME_SCOPE.connectionId,
    second.connectionId,
  ]);
  assert.equal(enqueued[0]?.idempotencyKey,
    dcfStepFunctionsIdempotencyKey(RUNTIME_SCOPE, WINDOW));
  assert.notEqual(
    dcfStepFunctionsIdempotencyKey(
      { ...RUNTIME_SCOPE, organizationId: "org:alpha", customerId: "customer" },
      WINDOW,
    ),
    dcfStepFunctionsIdempotencyKey(
      { ...RUNTIME_SCOPE, organizationId: "org", customerId: "alpha:customer" },
      WINDOW,
    ),
  );
  assert.deepEqual(enqueued[0]?.payload, { scheduledWindow: WINDOW });
  assert.equal(DCF_STEP_FUNCTIONS_RUNTIME_BINDING.registeredInSharedRuntime, false);
  assert.equal(DCF_STEP_FUNCTIONS_RUNTIME_BINDING.activationReason,
    DCF_STEP_FUNCTIONS_RUNTIME_ACTIVATION_REASON);
});

test("durable runtime executes once, seals lineage, and replays a hash-verified receipt", async () => {
  const collection = await readyCollection();
  const snapshot: DcfSnapshot = normalizeDcfCapture(collection.capture, SCOPE, NOW);
  const contentSha256 = await sha256(snapshot);
  const completed: Array<Record<string, unknown>> = [];
  let collections = 0;
  const dependencies = {
    loadBoundary: async () => BOUNDARY,
    adapter: {
      async collect() {
        collections += 1;
        return collection;
      },
    },
    record: async () => ({
      generationId: `dcg_${contentSha256}`,
      contentSha256,
      snapshot,
      becameActive: true,
    }),
    replayStore: {
      claim: async () => ({ state: "ACQUIRED" as const, leaseToken: "lease_1" }),
      complete: async (value: Record<string, unknown>) => { completed.push(value); },
      fail: async () => {},
    },
  };
  const executed = await runDcfStepFunctionsRuntimeHandler(job(), dependencies);
  assert.equal(executed.disposition, "EXECUTED");
  assert.equal(executed.result.sourceState, "READY");
  assert.equal(executed.result.captureId, collection.capture.captureId);
  assert.match(completed[0]?.resultSha256 as string, /^[a-f0-9]{64}$/u);
  assert.equal(collections, 1);

  const replayed = await runDcfStepFunctionsRuntimeHandler(job(), {
    ...dependencies,
    adapter: {
      async collect() {
        throw new Error("must not collect during replay");
      },
    },
    replayStore: {
      claim: async () => ({
        state: "COMPLETED" as const,
        result: executed.result,
        resultSha256: completed[0]!.resultSha256 as string,
      }),
      complete: async () => { throw new Error("must not complete twice"); },
      fail: async () => {},
    },
  });
  assert.equal(replayed.disposition, "REPLAYED");
  assert.deepEqual(replayed.result, executed.result);
});

test("durable runtime rejects substitution/corrupt receipts and sanitizes adapter or store failures", async () => {
  let claimed = false;
  await assert.rejects(
    runDcfStepFunctionsRuntimeHandler(job({ customerId: "attacker/customer" }), {
      loadBoundary: async () => BOUNDARY,
      adapter: { collect: async () => { throw new Error("must not run"); } },
      record: async () => { throw new Error("must not run"); },
      replayStore: {
        claim: async () => { claimed = true; return { state: "IN_PROGRESS" as const }; },
        complete: async () => {},
        fail: async () => {},
      },
    }),
    (error) => error instanceof DcfStepFunctionsRuntimeError
      && error.code === "INVALID_JOB",
  );
  assert.equal(claimed, false);

  const collection = await readyCollection();
  const snapshot = normalizeDcfCapture(collection.capture, SCOPE, NOW);
  const contentSha256 = await sha256(snapshot);
  const validResult = {
    schemaVersion: "sutra.dcf-step-functions-runtime-result.v1" as const,
    generationId: `dcg_${contentSha256}`,
    contentSha256,
    captureId: collection.capture.captureId,
    sourceState: "READY" as const,
    failureCodes: [],
    becameActive: true,
  };
  await assert.rejects(
    runDcfStepFunctionsRuntimeHandler(job(), {
      loadBoundary: async () => BOUNDARY,
      adapter: { collect: async () => collection },
      record: async () => ({
        generationId: validResult.generationId,
        contentSha256: validResult.contentSha256,
        snapshot,
        becameActive: true,
      }),
      replayStore: {
        claim: async () => ({
          state: "COMPLETED" as const,
          result: validResult,
          resultSha256: "0".repeat(64),
        }),
        complete: async () => {},
        fail: async () => {},
      },
    }),
    (error) => error instanceof DcfStepFunctionsRuntimeError
      && error.code === "COLLECTION_FAILED",
  );

  await assert.rejects(
    runDcfStepFunctionsRuntimeHandler(job(), {
      loadBoundary: async () => { throw new Error("credential=secret"); },
      adapter: { collect: async () => collection },
      record: async () => { throw new Error("database=secret"); },
      replayStore: {
        claim: async () => ({ state: "ACQUIRED" as const, leaseToken: "lease" }),
        complete: async () => {},
        fail: async () => { throw new Error("secondary=secret"); },
      },
    }),
    (error) => error instanceof DcfStepFunctionsRuntimeError
      && error.code === "COLLECTION_FAILED"
      && !error.message.includes("secret"),
  );
});
