import assert from "node:assert/strict";
import test from "node:test";

const {
  enqueueTenantCollectionJob,
  HostedCollectorJobError,
  HOSTED_COLLECTOR_COLLECT_JOB_KIND,
  runHostedCollectorJob,
} =
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

const ACTIVE_CONNECTION = {
  id: "conn_1",
  customerId: "cust_1",
  customerName: "Customer",
  sourceKind: "aws_trust_role",
  fixtureId: null,
  fixtureVersion: null,
  partition: "aws",
  awsAccountId: "111111111111",
  roleArn: "arn:aws:iam::111111111111:role/sutra/SutraCollectorRole",
  status: "active",
  enabledRegions: ["us-east-1"],
  permissionPackVersion: "standard-2026-07.4",
  roleProvisioningMode: "sutra_template",
  expectedRolePath: "/sutra/",
  expectedRoleName: "SutraCollectorRole",
  permissionCapabilities: { grantedActions: [], missingActions: [] },
  lastValidatedAt: new Date().toISOString(),
  lastSuccessfulSyncAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function runnableJob(overrides = {}) {
  return {
    id: `job_${"1".repeat(32)}`,
    orgId: "org_1",
    customerId: "cust_1",
    connectionId: "conn_1",
    kind: HOSTED_COLLECTOR_COLLECT_JOB_KIND,
    payload: { connectionId: "conn_1", operationId: "onb_1" },
    attempt: 1,
    maxAttempts: 5,
    ...overrides,
  };
}

function hostedRunDeps(overrides = {}) {
  const calls = {
    operationScopes: [],
    creates: [],
    broker: [],
    persists: [],
    failures: [],
    attention: [],
  };
  const rawEvidenceBytes = new TextEncoder().encode('{"authenticated":true}');
  const snapshot = { schemaVersion: "sutra.inventory.v1", marker: "parsed" };
  return {
    calls,
    rawEvidenceBytes,
    deps: {
      getConnection: async () => ACTIVE_CONNECTION,
      listOperationRuns: async (input) => {
        calls.operationScopes.push(input);
        return [];
      },
      createSyncRun: async (connectionId, options) => {
        calls.creates.push({ connectionId, options });
        return "sync_1";
      },
      runCollectorSync: async (input) => {
        calls.broker.push(input);
        return { snapshot, rawEvidenceBytes };
      },
      persistSnapshot: async (input) => {
        calls.persists.push(input);
        return "snap_1";
      },
      failSyncRun: async (...args) => {
        calls.failures.push(args);
      },
      markConnectionNeedsAttention: async (...args) => {
        calls.attention.push(args);
      },
      safeFailureCode: () => "COLLECTION_FAILED",
      ...overrides,
    },
  };
}

test("runner performs scoped broker sync and archives exact authenticated bytes before completing", async () => {
  const fixture = hostedRunDeps();
  await runHostedCollectorJob(runnableJob(), fixture.deps);

  assert.equal(fixture.calls.operationScopes[0].orgId, "org_1");
  assert.equal(fixture.calls.operationScopes[0].customerId, "cust_1");
  assert.match(fixture.calls.creates[0].options.idempotencyKey, /^hosted_collector_[a-f0-9]{64}\.1$/u);
  assert.equal(fixture.calls.broker[0].jobId, fixture.calls.creates[0].options.idempotencyKey);
  assert.equal(fixture.calls.persists[0].orgId, "org_1");
  assert.equal(fixture.calls.persists[0].rawEvidenceBytes, fixture.rawEvidenceBytes);
  assert.equal(fixture.calls.failures.length, 0);
});

test("runner makes an already successful logical operation an exact no-op", async () => {
  const fixture = hostedRunDeps({
    listOperationRuns: async ({ idempotencyBase }) => [{
      id: "sync_done",
      idempotencyKey: `${idempotencyBase}.1`,
      status: "succeeded",
    }],
  });
  await runHostedCollectorJob(runnableJob({ id: `job_${"2".repeat(32)}`, attempt: 2 }), fixture.deps);
  assert.equal(fixture.calls.creates.length, 0);
  assert.equal(fixture.calls.broker.length, 0);
  assert.equal(fixture.calls.persists.length, 0);
});

test("runner resumes a running operation with the same broker job id after worker restart", async () => {
  const fixture = hostedRunDeps({
    listOperationRuns: async ({ idempotencyBase }) => [{
      id: "sync_existing",
      idempotencyKey: `${idempotencyBase}.1`,
      status: "running",
    }],
  });
  await runHostedCollectorJob(runnableJob({ attempt: 2 }), fixture.deps);
  assert.equal(fixture.calls.creates.length, 0);
  assert.match(fixture.calls.broker[0].jobId, /\.1$/u);
  assert.equal(fixture.calls.persists[0].runId, "sync_existing");
});

test("runner rejects a cross-customer durable envelope before broker access", async () => {
  const fixture = hostedRunDeps();
  await assert.rejects(
    runHostedCollectorJob(runnableJob({ customerId: "cust_foreign" }), fixture.deps),
    /scope-mismatch/u,
  );
  assert.equal(fixture.calls.broker.length, 0);
});

test("runner settles broker failure and marks trust failures for operator attention", async () => {
  const failure = Object.assign(new Error("assume denied"), { code: "ASSUME_ROLE_DENIED" });
  const fixture = hostedRunDeps({
    runCollectorSync: async () => {
      throw failure;
    },
    safeFailureCode: () => "ASSUME_ROLE_DENIED",
  });
  await assert.rejects(runHostedCollectorJob(runnableJob(), fixture.deps), (error) => error === failure);
  assert.deepEqual(fixture.calls.failures[0], [
    "sync_1", "conn_1", "system-hosted-collector", "ASSUME_ROLE_DENIED", "org_1",
  ]);
  assert.deepEqual(fixture.calls.attention[0], [
    "conn_1", "system-hosted-collector", "ASSUME_ROLE_DENIED", "org_1",
  ]);
});
