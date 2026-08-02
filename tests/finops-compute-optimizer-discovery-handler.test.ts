import assert from "node:assert/strict";
import test from "node:test";

import type { RunnableJob } from "../lib/background-job-runner.ts";
import {
  ComputeOptimizerDiscoveryHandlerError,
  runComputeOptimizerDiscoveryHandler,
  type ComputeOptimizerDiscoveryHandlerDependencies,
} from "../lib/finops-compute-optimizer-discovery-handler.ts";
import { FINOPS_COMPUTE_OPTIMIZER_DISCOVERY_JOB_KIND } from
  "../lib/finops-compute-optimizer-discovery-job.ts";
import type {
  RecordComputeOptimizerDiscoveryInput,
  StoredComputeOptimizerDiscoveryRun,
} from "../db/finops-compute-optimizer-discovery-repository.ts";

const ORG = "org_discovery_handler";
const CUSTOMER = "customer_discovery_handler";
const CONNECTION = `conn_${"a".repeat(32)}`;
const RUN_ID = `cor_${"b".repeat(64)}`;
const ACCOUNT = "111122223333";
const REGION = "us-west-2";
const scope = { organizationId: ORG, customerId: CUSTOMER, connectionId: CONNECTION };

function stored(status: StoredComputeOptimizerDiscoveryRun["status"] = "pending"):
StoredComputeOptimizerDiscoveryRun {
  return {
    scope,
    runId: RUN_ID,
    jobId: "launch-window-1",
    status,
    contentSha256: status === "partial" ? "d".repeat(64) : null,
    collectedAt: status === "partial" ? "2026-08-02T00:02:00.000Z" : null,
    dataThroughAt: status === "partial" ? "2026-08-02T00:01:00.000Z" : null,
    accountId: ACCOUNT,
    partition: "aws",
    region: REGION,
    memberCount: status === "partial" ? 1 : 0,
    exportJobCount: status === "partial" ? 8 : 0,
    coverageCount: status === "partial" ? 3 : 0,
    errorCode: status === "partial" ? "EXPORT_OBJECT_BINDING_REQUIRED" : null,
    limitations: status === "partial" ? ["READ_ONLY_EXPORT_DISCOVERY_ONLY"] : [],
    createdAtIso: "2026-08-02T00:00:00.000Z",
    startedAtIso: status === "pending" ? null : "2026-08-02T00:00:01.000Z",
    finalizedAtIso: status === "partial" ? "2026-08-02T00:02:01.000Z" : null,
  };
}

function job(overrides: Partial<RunnableJob> = {}): RunnableJob {
  return {
    id: `job_${"c".repeat(32)}`,
    orgId: ORG,
    customerId: CUSTOMER,
    connectionId: CONNECTION,
    kind: FINOPS_COMPUTE_OPTIMIZER_DISCOVERY_JOB_KIND,
    payload: { runId: RUN_ID, connectionId: CONNECTION },
    attempt: 1,
    maxAttempts: 6,
    ...overrides,
  };
}

function exportJobs() {
  const types = [
    "Ec2Instance", "AutoScalingGroup", "EbsVolume", "LambdaFunction",
    "EcsService", "License", "RdsDBInstance", "Idle",
  ];
  return types.map((resourceType, index) => ({
    jobId: `provider-job-${index}`,
    resourceType,
    status: "COMPLETE" as const,
    createdAt: "2026-08-02T00:00:00.000Z",
    lastUpdatedAt: "2026-08-02T00:01:00.000Z",
    failureCode: null,
    destination: {
      bucketSha256: (index + 1).toString(16).repeat(64),
      objectKeySha256: (index + 2).toString(16).repeat(64),
      metadataKeySha256: (index + 3).toString(16).repeat(64),
    },
  }));
}

function collection() {
  const coverage = [
    "GET_ENROLLMENT_STATUS",
    "GET_ENROLLMENT_STATUSES_FOR_ORGANIZATION",
    "DESCRIBE_RECOMMENDATION_EXPORT_JOBS",
  ].map((operation) => ({
    operation,
    status: "SUCCEEDED",
    pagesObserved: 1,
    recordsObserved: 1,
    recordsAccepted: 1,
    recordsRejected: 0,
    recordsOmitted: 0,
    errorCode: null,
  }));
  return {
    schemaVersion: "sutra.finops-source-dispatch.v1" as const,
    tenantId: ORG,
    connectionId: CONNECTION,
    jobId: job().id,
    contractId: "co-discovery-us-west-2-v1",
    sourceId: "compute_optimizer_organization_export" as const,
    configured: true,
    implementationState: "IMPLEMENTED" as const,
    collectionStatus: "PARTIAL" as const,
    accountId: ACCOUNT,
    partition: "aws" as const,
    region: REGION,
    collectedAt: "2026-08-02T00:02:00.000Z",
    dataThroughAt: "2026-08-02T00:01:00.000Z",
    coverage: {
      pagesObserved: 3,
      recordsObserved: 3,
      recordsAccepted: 3,
      recordsRejected: 0,
      recordsOmitted: 0,
    },
    evidence: {
      schemaVersion: "sutra.aws-compute-optimizer-export-discovery.v1",
      source: "AWS_COMPUTE_OPTIMIZER_ORGANIZATION_EXPORT_DISCOVERY",
      enrollment: {
        status: "ACTIVE", reasonCode: null, memberAccountsEnrolled: true,
        numberOfMemberAccountsOptedIn: 1,
        lastUpdatedAt: "2026-08-02T00:00:30.000Z",
      },
      memberEnrollments: [{
        accountId: ACCOUNT, status: "ACTIVE", reasonCode: null,
        lastUpdatedAt: "2026-08-02T00:00:30.000Z",
      }],
      exportJobs: exportJobs(),
      coverage,
    },
    errorCode: "EXPORT_OBJECT_BINDING_REQUIRED",
    limitations: [
      "READ_ONLY_EXPORT_DISCOVERY_ONLY",
      "EXPORT_PROVISIONING_LEDGER_REQUIRED",
      "EXPORT_OBJECTS_NOT_READ_WITHOUT_ATTESTED_BUCKET_PREFIX",
      "DIRECT_RECOMMENDATION_APIS_NOT_COLLECTED",
    ],
  };
}

function fixture(overrides: Partial<ComputeOptimizerDiscoveryHandlerDependencies> = {}) {
  let current = stored();
  const calls = { boundary: 0, collect: 0, seal: 0, record: 0 };
  let recorded: RecordComputeOptimizerDiscoveryInput | null = null;
  const dependencies: ComputeOptimizerDiscoveryHandlerDependencies = {
    repository: {
      async getRun() { return current; },
      async startRun() { current = stored("running"); return current; },
      async recordDiscovery(receivedScope, runId, input) {
        calls.record += 1;
        assert.deepEqual(receivedScope, scope);
        assert.equal(runId, RUN_ID);
        assert.equal(input.contentSha256, "f".repeat(64));
        recorded = input;
        current = { ...stored("partial"), contentSha256: input.contentSha256 };
        return current;
      },
    },
    async loadTrustedBoundary() {
      calls.boundary += 1;
      return {
        ...scope,
        accountId: ACCOUNT,
        partition: "aws",
        permissionPackVersion: "standard-2026-08.5",
        explicitRegions: ["us-east-1", REGION],
        sourceContractId: "co-discovery-us-west-2-v1",
      };
    },
    async collect() { calls.collect += 1; return collection(); },
    async sealFinalizedEvidence(input) {
      calls.seal += 1;
      assert.equal(input.runId, RUN_ID);
      assert.match(input.evidenceContentSha256, /^[a-f0-9]{64}$/u);
      assert.equal(JSON.stringify(input).includes("raw-bucket"), false);
      return { ciphertext: `fsev1.${"A".repeat(40)}`, keyVersion: "co-evidence-v1" };
    },
    async computeContentSha256() { return "f".repeat(64); },
    now: () => Date.parse("2026-08-02T00:03:00.000Z"),
    ...overrides,
  };
  return { dependencies, calls, getRecorded: () => recorded };
}

test("handler resolves an exact .8.5 regional boundary, collects, seals, persists, and replays", async () => {
  const testFixture = fixture();
  await runComputeOptimizerDiscoveryHandler(job(), testFixture.dependencies);
  assert.deepEqual(testFixture.calls, { boundary: 1, collect: 1, seal: 1, record: 1 });
  assert.equal(testFixture.getRecorded()?.exportJobs.length, 8);
  assert.equal(testFixture.getRecorded()?.enrollment?.status, "ACTIVE");

  await runComputeOptimizerDiscoveryHandler(job({ attempt: 2 }), testFixture.dependencies);
  assert.deepEqual(testFixture.calls, { boundary: 1, collect: 1, seal: 1, record: 1 });
});

test("handler rejects all-enabled, widened, unsorted, or non-.8.5 boundaries before collection", async () => {
  for (const boundary of [
    { permissionPackVersion: "standard-2026-08.4", explicitRegions: [REGION] },
    { permissionPackVersion: "standard-2026-08.5", explicitRegions: ["all-enabled"] },
    { permissionPackVersion: "standard-2026-08.5", explicitRegions: [REGION, "us-east-1"] },
    { permissionPackVersion: "standard-2026-08.5", explicitRegions: ["us-east-1"] },
  ]) {
    const testFixture = fixture({
      async loadTrustedBoundary() {
        testFixture.calls.boundary += 1;
        return {
          ...scope, accountId: ACCOUNT, partition: "aws",
          sourceContractId: "co-discovery-us-west-2-v1",
          ...boundary,
        } as never;
      },
    });
    await assert.rejects(
      runComputeOptimizerDiscoveryHandler(job(), testFixture.dependencies),
      (error) => error instanceof ComputeOptimizerDiscoveryHandlerError
        && error.code === "BOUNDARY_UNAVAILABLE",
    );
    assert.equal(testFixture.calls.collect, 0);
    assert.equal(testFixture.calls.seal, 0);
    assert.equal(testFixture.calls.record, 0);
  }
});

test("handler rejects payload widening and cross-scope identity before dependencies", async () => {
  for (const candidate of [
    job({ payload: { runId: RUN_ID, connectionId: CONNECTION, region: REGION } }),
    job({ connectionId: `conn_${"f".repeat(32)}` }),
    job({ kind: "finops-source-collect" }),
  ]) {
    const testFixture = fixture();
    await assert.rejects(runComputeOptimizerDiscoveryHandler(candidate, testFixture.dependencies),
      ComputeOptimizerDiscoveryHandlerError);
    assert.deepEqual(testFixture.calls, { boundary: 0, collect: 0, seal: 0, record: 0 });
  }
});

test("handler propagates abort before a subsequent external side effect", async () => {
  const controller = new AbortController();
  const testFixture = fixture({
    async loadTrustedBoundary() {
      testFixture.calls.boundary += 1;
      controller.abort();
      return {
        ...scope, accountId: ACCOUNT, partition: "aws",
        permissionPackVersion: "standard-2026-08.5",
        explicitRegions: [REGION], sourceContractId: "co-discovery-us-west-2-v1",
      };
    },
  });
  await assert.rejects(
    runComputeOptimizerDiscoveryHandler(job(), testFixture.dependencies,
      { signal: controller.signal }),
    (error) => error instanceof ComputeOptimizerDiscoveryHandlerError
      && error.code === "ABORTED",
  );
  assert.equal(testFixture.calls.collect, 0);
  assert.equal(testFixture.calls.seal, 0);
  assert.equal(testFixture.calls.record, 0);
});

test("handler sanitizes collection failures and never persists provider-controlled errors", async () => {
  const testFixture = fixture({
    async collect() {
      testFixture.calls.collect += 1;
      throw new Error("raw bucket s3://private-provider-bucket/export.csv");
    },
  });
  await assert.rejects(
    runComputeOptimizerDiscoveryHandler(job(), testFixture.dependencies),
    (error) => error instanceof ComputeOptimizerDiscoveryHandlerError
      && error.code === "COLLECTION_REJECTED"
      && !error.message.includes("private-provider-bucket"),
  );
  assert.equal(testFixture.calls.seal, 0);
  assert.equal(testFixture.calls.record, 0);
});

test("handler rejects nested provider-field widening before evidence archival", async () => {
  const testFixture = fixture({
    async collect() {
      testFixture.calls.collect += 1;
      const result = collection();
      return {
        ...result,
        evidence: {
          ...result.evidence,
          exportJobs: result.evidence.exportJobs.map((entry, index) => index === 0
            ? { ...entry, rawBucket: "private-provider-bucket" } : entry),
        },
      };
    },
  });
  await assert.rejects(
    runComputeOptimizerDiscoveryHandler(job(), testFixture.dependencies),
    (error) => error instanceof ComputeOptimizerDiscoveryHandlerError
      && error.code === "COLLECTION_REJECTED",
  );
  assert.equal(testFixture.calls.seal, 0);
  assert.equal(testFixture.calls.record, 0);
});

test("handler returns at the absolute deadline when a dependency never settles", async () => {
  const testFixture = fixture({
    now: Date.now,
    async collect(_input, context) {
      testFixture.calls.collect += 1;
      assert.ok(context.signal instanceof AbortSignal);
      return await new Promise<never>(() => undefined);
    },
  });
  const started = Date.now();
  await assert.rejects(
    runComputeOptimizerDiscoveryHandler(job(), testFixture.dependencies, {
      deadlineAtMs: started + 30,
    }),
    (error) => error instanceof ComputeOptimizerDiscoveryHandlerError
      && error.code === "DEADLINE_EXCEEDED",
  );
  assert.ok(Date.now() - started < 1_000);
  assert.equal(testFixture.calls.seal, 0);
  assert.equal(testFixture.calls.record, 0);
});
