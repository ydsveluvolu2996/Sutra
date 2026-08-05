import assert from "node:assert/strict";
import test from "node:test";
import type { RunnableJob } from "../lib/background-job-runner.ts";
import {
  AWS_CONFIG_COMPLIANCE_RUNTIME_ACTIVATION_REASON,
  AWS_CONFIG_COMPLIANCE_RUNTIME_BINDING,
  AWS_CONFIG_COMPLIANCE_RUNTIME_JOB_KIND,
  AwsConfigComplianceRuntimeError,
  awsConfigComplianceCollectionWindow,
  runAwsConfigComplianceRuntimeHandler,
  scheduleAwsConfigComplianceCollections,
  type AwsConfigComplianceRuntimeResult,
} from "../lib/finops-aws-config-compliance-runtime-binding.ts";
import type {
  AwsConfigComplianceCapture,
  AwsConfigComplianceScope,
} from "../lib/finops-aws-config-compliance.ts";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const WINDOW = "2026-08-01T00:00:00.000Z";
const SCOPE: AwsConfigComplianceScope = {
  orgId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: `conn_${"a".repeat(32)}`,
  partition: "aws",
  aggregatorAccountId: "111122223333",
  aggregatorRegion: "us-east-1",
  aggregatorName: "organization-aggregator",
  aggregatorArn:
    "arn:aws:config:us-east-1:111122223333:config-aggregator/config-aggregator-abc123",
};
const CAPTURE: AwsConfigComplianceCapture = {
  schemaVersion: "sutra.aws-config-compliance.v1",
  scope: SCOPE,
  captureId: `config_${"b".repeat(64)}`,
  startedAt: WINDOW,
  completedAt: "2026-08-01T00:01:00.000Z",
  prerequisites: {
    serviceConfigured: false,
    aggregatorValidated: false,
    readPermissionsValidated: false,
    organizationsAllFeaturesEnabled: true,
  },
  expectedCoverage: {
    awsOrganizationId: "o-1234567890",
    accountsEvidenceId: "organizations-ledger",
    accountsObservedAt: WINDOW,
    activeAccountIds: ["111122223333"],
    expectedRegions: ["us-east-1"],
  },
  aggregator: null,
  operationCoverage: [],
  sourceStatuses: [],
  recorders: [],
  rules: [],
  ruleCompliance: [],
  evaluations: [],
  conformancePacks: [],
  resourceCounts: [],
  inventoryQuery:
    "SELECT accountId, awsRegion, resourceType, resourceId, configurationItemCaptureTime, resourceCreationTime, configurationItemStatus",
  resourceInventory: [],
  activity: null,
  cur2: null,
};

function job(overrides: Partial<RunnableJob> = {}): RunnableJob {
  return {
    id: `job_${"c".repeat(32)}`,
    orgId: SCOPE.orgId,
    customerId: SCOPE.customerId,
    connectionId: SCOPE.connectionId,
    kind: AWS_CONFIG_COMPLIANCE_RUNTIME_JOB_KIND,
    payload: { scheduledWindow: WINDOW },
    attempt: 1,
    maxAttempts: 5,
    ...overrides,
  };
}

async function resultSha256(result: AwsConfigComplianceRuntimeResult): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(result)),
  );
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    loadScope: async () => SCOPE,
    adapter: { collect: async () => CAPTURE },
    store: {
      recordSnapshot: async (scope: {
        organizationId: string;
        customerId: string;
        connectionId: string;
      }, snapshot: import("../lib/finops-aws-config-compliance.ts").AwsConfigComplianceSnapshot) => ({
        scope,
        snapshotId: `acc_${"d".repeat(64)}`,
        contentSha256: "d".repeat(64),
        state: snapshot.state,
        capturedAt: snapshot.capturedAt,
        createdAtIso: snapshot.capturedAt,
        snapshot,
      }),
    },
    replayStore: {
      claim: async () => ({ state: "ACQUIRED" as const, leaseToken: "lease-1" }),
      complete: async () => {},
      fail: async () => {},
    },
    now: () => NOW,
    ...overrides,
  };
}

test("daily scheduler emits tenant-complete idempotent five-attempt jobs", async () => {
  const enqueued: unknown[] = [];
  const count = await scheduleAwsConfigComplianceCollections({
    scheduledWindow: awsConfigComplianceCollectionWindow(NOW),
    loadEligibleScopes: async () => [{
      organizationId: SCOPE.orgId,
      customerId: SCOPE.customerId,
      connectionId: SCOPE.connectionId,
    }],
    queue: { async enqueue(value) { enqueued.push(value); } },
  });
  assert.equal(count, 1);
  assert.deepEqual(enqueued, [{
    orgId: SCOPE.orgId,
    customerId: SCOPE.customerId,
    connectionId: SCOPE.connectionId,
    kind: AWS_CONFIG_COMPLIANCE_RUNTIME_JOB_KIND,
    payload: { scheduledWindow: WINDOW },
    maxAttempts: 5,
    idempotencyKey:
      `aws-config-compliance:${SCOPE.orgId}:${SCOPE.customerId}:${SCOPE.connectionId}:${encodeURIComponent(WINDOW)}`,
  }]);
  assert.equal(AWS_CONFIG_COMPLIANCE_RUNTIME_BINDING.registeredInSharedRuntime, false);
  assert.equal(AWS_CONFIG_COMPLIANCE_RUNTIME_ACTIVATION_REASON,
    "AWS_CONFIG_COMPLIANCE_DURABLE_RUNTIME_NOT_REGISTERED");
});

test("scheduler rejects duplicate connection scope before any enqueue", async () => {
  let enqueues = 0;
  await assert.rejects(scheduleAwsConfigComplianceCollections({
    scheduledWindow: WINDOW,
    loadEligibleScopes: async () => [
      { organizationId: SCOPE.orgId, customerId: SCOPE.customerId, connectionId: SCOPE.connectionId },
      { organizationId: "org_other", customerId: "customer_other", connectionId: SCOPE.connectionId },
    ],
    queue: { async enqueue() { enqueues += 1; } },
  }), AwsConfigComplianceRuntimeError);
  assert.equal(enqueues, 0);
});

test("durable runtime executes once then verifies and replays the receipt", async () => {
  let completed: { result: AwsConfigComplianceRuntimeResult; resultSha256: string } | null = null;
  let providerReads = 0;
  let writes = 0;
  const deps = dependencies({
    adapter: { collect: async () => { providerReads += 1; return CAPTURE; } },
    store: {
      recordSnapshot: async (scope: {
        organizationId: string;
        customerId: string;
        connectionId: string;
      }, snapshot: import("../lib/finops-aws-config-compliance.ts").AwsConfigComplianceSnapshot) => {
        writes += 1;
        return { scope, snapshotId: `acc_${"d".repeat(64)}`, contentSha256: "d".repeat(64),
          state: snapshot.state, capturedAt: snapshot.capturedAt,
          createdAtIso: snapshot.capturedAt, snapshot };
      },
    },
    replayStore: {
      claim: async () => completed === null
        ? { state: "ACQUIRED" as const, leaseToken: "lease-1" }
        : { state: "COMPLETED" as const, ...completed },
      complete: async (input: { result: AwsConfigComplianceRuntimeResult; resultSha256: string }) => {
        completed = { result: input.result, resultSha256: input.resultSha256 };
      },
      fail: async () => {},
    },
  });
  const first = await runAwsConfigComplianceRuntimeHandler(job(), deps);
  const replay = await runAwsConfigComplianceRuntimeHandler(job(), deps);
  assert.equal(first.disposition, "EXECUTED");
  assert.equal(replay.disposition, "REPLAYED");
  assert.equal(providerReads, 1);
  assert.equal(writes, 1);
});

test("in-progress claim never calls provider or persistence", async () => {
  let touched = false;
  const output = await runAwsConfigComplianceRuntimeHandler(job(), dependencies({
    replayStore: {
      claim: async () => ({ state: "IN_PROGRESS" as const }),
      complete: async () => { touched = true; },
      fail: async () => { touched = true; },
    },
    adapter: { collect: async () => { touched = true; return CAPTURE; } },
  }));
  assert.deepEqual(output, { disposition: "IN_PROGRESS", result: null });
  assert.equal(touched, false);
});

test("forged replay digest is rejected before returning stored data", async () => {
  const result: AwsConfigComplianceRuntimeResult = {
    snapshotId: `acc_${"d".repeat(64)}`,
    captureId: CAPTURE.captureId,
    state: "CONFIGURATION_REQUIRED",
  };
  await assert.rejects(runAwsConfigComplianceRuntimeHandler(job(), dependencies({
    replayStore: {
      claim: async () => ({ state: "COMPLETED" as const, result,
        resultSha256: await resultSha256({ ...result, state: "READY" }) }),
      complete: async () => {},
      fail: async () => {},
    },
  })), (error: unknown) => error instanceof AwsConfigComplianceRuntimeError
    && error.code === "COLLECTION_FAILED");
});

test("invalid attempt and payload bounds fail before replay or provider calls", async () => {
  let touched = false;
  const deps = dependencies({
    replayStore: {
      claim: async () => { touched = true; return { state: "IN_PROGRESS" as const }; },
      complete: async () => {},
      fail: async () => {},
    },
  });
  for (const invalidJob of [
    job({ attempt: 6 }),
    job({ maxAttempts: 6 }),
    job({ payload: { scheduledWindow: WINDOW, region: "us-west-2" } }),
    job({ customerId: null }),
  ]) {
    await assert.rejects(runAwsConfigComplianceRuntimeHandler(invalidJob, deps),
      (error: unknown) => error instanceof AwsConfigComplianceRuntimeError
        && error.code === "INVALID_JOB");
  }
  assert.equal(touched, false);
});

test("provider failure is sanitized and releases the replay lease", async () => {
  const failures: unknown[] = [];
  await assert.rejects(runAwsConfigComplianceRuntimeHandler(job(), dependencies({
    adapter: { collect: async () => { throw new Error("secret-provider-token"); } },
    replayStore: {
      claim: async () => ({ state: "ACQUIRED" as const, leaseToken: "lease-1" }),
      complete: async () => {},
      fail: async (input: unknown) => { failures.push(input); },
    },
  })), (error: unknown) => error instanceof AwsConfigComplianceRuntimeError
    && error.code === "COLLECTION_FAILED" && !error.message.includes("secret-provider-token"));
  assert.deepEqual(failures, [{
    key: `aws-config-compliance:${SCOPE.orgId}:${SCOPE.customerId}:${SCOPE.connectionId}:${encodeURIComponent(WINDOW)}`,
    jobId: `job_${"c".repeat(32)}`,
    leaseToken: "lease-1",
    failureCode: "AWS_CONFIG_COMPLIANCE_COLLECTION_FAILED",
  }]);
});
