import assert from "node:assert/strict";
import test from "node:test";

import { runDueBackgroundJobs } from "../lib/background-job-runner.ts";
import { canonicalJson } from "../lib/canonical-json.ts";
import {
  ComputeOptimizerMaterializationCoordinatorError,
  coordinateComputeOptimizerMaterializationPlans,
  createComputeOptimizerMaterializationActivation,
  type ComputeOptimizerMaterializationRuntimeCheckpoint,
} from "../lib/finops-compute-optimizer-export-coordinator.ts";
import {
  COMPUTE_OPTIMIZER_PROVIDER_RESOURCE_TYPES_BY_EXPORT_FAMILY,
  createComputeOptimizerExportLaunchAttempt,
  type ComputeOptimizerExportLaunchAttempt,
  type ComputeOptimizerExportLaunchExecution,
  type ComputeOptimizerExportLaunchOutcome,
} from "../lib/finops-compute-optimizer-export-launch.ts";
import {
  ComputeOptimizerMaterializationRuntimeError,
  FINOPS_COMPUTE_OPTIMIZER_MATERIALIZE_JOB_KIND,
  enqueueComputeOptimizerMaterialization,
  parseComputeOptimizerMaterializationJobPayload,
  runComputeOptimizerMaterializationJob,
  type ComputeOptimizerMaterializationJobPayload,
  type ComputeOptimizerMaterializationRuntimeDependencies,
} from "../lib/finops-compute-optimizer-materialization-runtime.ts";
import type { ComputeOptimizerExportGeneration } from
  "../lib/finops-compute-optimizer-export-generation.ts";

const CONNECTION = `conn_${"a".repeat(32)}`;
const SCHEDULED = "2026-08-02T00:00:00.000Z";
const NOW = Date.parse("2026-08-02T12:20:00.000Z");

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

async function execution(
  attempt: ComputeOptimizerExportLaunchAttempt,
): Promise<ComputeOptimizerExportLaunchExecution> {
  const outcomes: ComputeOptimizerExportLaunchOutcome[] = attempt.targets.map((target, index) => {
    const jobId = `job-use1-${index + 1}`;
    const objectKey = `${target.effectivePrefix}${target.region}-2026-08-02T120000Z-${jobId}.csv`;
    return {
      targetId: target.targetId,
      exportFamily: target.exportFamily,
      operation: target.operation,
      status: "SUCCEEDED",
      jobId,
      bucket: target.bucket,
      objectKey,
      metadataKey: `${objectKey.slice(0, -4)}-metadata.json`,
      errorCode: null,
    };
  });
  const body = {
    schemaVersion: "sutra.compute-optimizer-export-launch-execution.v1" as const,
    requestBatchId: attempt.requestBatchId,
    launchAttemptId: attempt.launchAttemptId,
    status: "COMPLETE" as const,
    startedAtIso: "2026-08-02T12:10:00.000Z",
    finishedAtIso: "2026-08-02T12:11:00.000Z",
    outcomes,
  };
  const contentSha256 = await digest(canonicalJson(body));
  return { ...body, executionId: `coele_${contentSha256}`, contentSha256 };
}

async function payloadFixture() {
  const attempt = await createComputeOptimizerExportLaunchAttempt({
    scope: { orgId: "org_runtime", customerId: "customer_runtime", connectionId: CONNECTION },
    requesterAccountId: "111122223333",
    partition: "aws",
    region: "us-east-1",
    scheduledWindow: SCHEDULED,
    sealedAtIso: "2026-08-02T12:00:00.000Z",
    attemptNumber: 1,
    bucket: "sutra-runtime-use1",
    optionalPrefix: "organization/exports",
  });
  const terminal = await execution(attempt);
  const completedJobs = terminal.outcomes.map((outcome, index) => {
    assert.equal(outcome.status, "SUCCEEDED");
    const target = attempt.targets[index]!;
    return {
      targetId: target.targetId,
      plannedJobId: outcome.jobId,
      jobId: outcome.jobId,
      exportFamily: target.exportFamily,
      providerResourceType:
        COMPUTE_OPTIMIZER_PROVIDER_RESOURCE_TYPES_BY_EXPORT_FAMILY[target.exportFamily][0]!,
      requestSha256: target.requestSha256,
      status: "COMPLETE" as const,
      bucket: outcome.bucket,
      objectKey: outcome.objectKey,
      metadataKey: outcome.metadataKey,
      destination: {
        bucket: outcome.bucket,
        objectKey: outcome.objectKey,
        metadataKey: outcome.metadataKey,
      },
      creationTimestampIso: "2026-08-02T12:00:00.000Z",
      lastUpdatedTimestampIso: "2026-08-02T12:15:00.000Z",
    };
  });
  const activation = await createComputeOptimizerMaterializationActivation([attempt]);
  const planCheckpoint = await coordinateComputeOptimizerMaterializationPlans(activation, [{
    launchAttemptId: attempt.launchAttemptId,
    execution: terminal,
    completedJobs,
  }]);
  assert.equal(planCheckpoint.status, "PLAN_SET_READY");
  const payload = await parseComputeOptimizerMaterializationJobPayload({
    schemaVersion: "sutra.compute-optimizer-materialization-job.v1",
    activationId: activation.activationId,
    planCheckpointId: planCheckpoint.checkpointId,
    scheduledWindow: activation.scheduledWindow,
    scope: {
      organizationId: activation.scope.orgId,
      customerId: activation.scope.customerId,
      connectionId: activation.scope.connectionId,
    },
    requesterAccountId: activation.requesterAccountId,
    partition: activation.partition,
    planSetId: planCheckpoint.planSet!.planSetId,
    planSetContentSha256: planCheckpoint.planSet!.contentSha256,
    regionContracts: [{
      region: "us-east-1",
      describeContractId: "co-source-use1",
      objectContractId: "co-launch-use1",
    }],
  });
  return { payload, activation, planCheckpoint, planSet: planCheckpoint.planSet! };
}

function job(payload: ComputeOptimizerMaterializationJobPayload) {
  return {
    id: `job_${"1".repeat(32)}`,
    orgId: "org_runtime",
    customerId: "customer_runtime",
    connectionId: CONNECTION,
    kind: FINOPS_COMPUTE_OPTIMIZER_MATERIALIZE_JOB_KIND,
    payload,
    attempt: 1,
    maxAttempts: 6,
  };
}

function runtimeCheckpoint(
  fixture: Awaited<ReturnType<typeof payloadFixture>>,
  status: "FRESH_BLOCKED" | "PARTIAL_ATTEMPT_RECORDED" | "GENERATION_ACCEPTED",
): ComputeOptimizerMaterializationRuntimeCheckpoint {
  const { payload, planSet } = fixture;
  const plan = planSet.plans[0]!;
  const accepted = status === "GENERATION_ACCEPTED";
  return {
    schemaVersion: "sutra.compute-optimizer-materialization-runtime-checkpoint.v1",
    checkpointId: `comrm_${"2".repeat(64)}`,
    contentSha256: "2".repeat(64),
    activationId: payload.activationId,
    planCheckpointId: payload.planCheckpointId,
    planSetId: payload.planSetId,
    status,
    scheduledWindow: payload.scheduledWindow,
    materializedAtIso: new Date(NOW).toISOString(),
    regions: [{
      region: "us-east-1",
      planId: plan.planId,
      state: accepted ? "MAPPED" : "OBJECT_BLOCKED",
      errorCode: accepted ? null : "OBJECT_LOAD_FAILED",
      freshBindingContentSha256: accepted ? "3".repeat(64) : null,
      mappedTargetCount: accepted ? 8 : 0,
    }],
    attempt: status === "FRESH_BLOCKED" ? null : {
      attemptId: `coa_${"4".repeat(64)}`,
      contentSha256: "4".repeat(64),
      state: accepted ? "ALL_REGION_COMPLETE" : "PARTIAL",
    },
    generation: accepted ? {
      generationId: `cog_${"5".repeat(64)}`,
      contentSha256: "5".repeat(64),
      dataThroughAtIso: "2026-08-02T12:15:00.000Z",
      observedAtIso: "2026-08-02T12:20:00.000Z",
    } : null,
  };
}

function dependencies(
  fixture: Awaited<ReturnType<typeof payloadFixture>>,
  overrides: Partial<ComputeOptimizerMaterializationRuntimeDependencies> = {},
): ComputeOptimizerMaterializationRuntimeDependencies {
  return {
    getConnection: async () => ({
      id: CONNECTION,
      customerId: "customer_runtime",
      sourceKind: "aws_trust_role",
      status: "active",
      permissionPackVersion: "standard-2026-08.5",
      awsAccountId: "111122223333",
      partition: "aws",
    }),
    loadPersistedPlanSet: async () => ({
      planSet: fixture.planSet,
      discoveryEvidence: [{ region: "us-east-1", evidence: {} as never }],
    }),
    findAcceptedGeneration: async () => null,
    persistence: {
      recordAttempt: async () => undefined,
      recordAcceptedGeneration: async () => undefined,
    },
    describeTransport: { describeExact: async () => ({}) },
    objectTransport: { readChunk: async () => ({}) },
    recordOutcome: async () => undefined,
    now: () => NOW,
    ...overrides,
  };
}

test("enqueue is tenant-bound and deterministic over the exact activation/checkpoint", async () => {
  const fixture = await payloadFixture();
  const { payload, activation, planCheckpoint } = fixture;
  const enqueued: unknown[] = [];
  const queue = {
    enqueue: async (input: unknown) => {
      enqueued.push(input);
      return { id: `job_${"a".repeat(32)}` };
    },
  };
  const id = await enqueueComputeOptimizerMaterialization({
    queue,
    organizationId: "org_runtime",
    customerId: "customer_runtime",
    connectionId: CONNECTION,
    activation,
    planCheckpoint,
    regionContracts: payload.regionContracts,
    nowMs: NOW,
  });
  assert.equal(id, `job_${"a".repeat(32)}`);
  assert.equal(enqueued.length, 1);
  const serialized = JSON.stringify(enqueued[0]);
  assert.match(serialized, /finops-compute-optimizer-materialize/);
  assert.doesNotMatch(serialized, /sutra-runtime-use1|organization\/exports|objectKey/u);
  await assert.rejects(enqueueComputeOptimizerMaterialization({
    queue,
    organizationId: "org_other",
    customerId: "customer_runtime",
    connectionId: CONNECTION,
    activation,
    planCheckpoint,
    regionContracts: payload.regionContracts,
    nowMs: NOW,
  }), (error) => error instanceof ComputeOptimizerMaterializationRuntimeError
    && error.code === "INVALID_SCOPE");
});

test("capability gating happens before plan hydration or signed broker calls", async () => {
  const fixture = await payloadFixture();
  const { payload } = fixture;
  let hydrated = false;
  const deps = dependencies(fixture, {
    getConnection: async () => ({
      id: CONNECTION,
      customerId: "customer_runtime",
      sourceKind: "aws_trust_role",
      status: "active",
      permissionPackVersion: "standard-2026-08.4",
      awsAccountId: "111122223333",
      partition: "aws",
    }),
    loadPersistedPlanSet: async () => {
      hydrated = true;
      throw new Error("must not hydrate");
    },
  });
  await assert.rejects(runComputeOptimizerMaterializationJob(job(payload), deps),
    (error) => error instanceof ComputeOptimizerMaterializationRuntimeError
      && error.code === "CAPABILITY_UNAVAILABLE");
  assert.equal(hydrated, false);
});

test("a durable PARTIAL checkpoint is telemetered then failed through the queue runner", async () => {
  const fixture = await payloadFixture();
  const { payload } = fixture;
  const recorded: unknown[] = [];
  const leasedJob = job(payload);
  let leased = false;
  let completed = false;
  let failure = "";
  const result = await runDueBackgroundJobs({
    queue: {
      leaseNext: async () => {
        if (leased) return null;
        leased = true;
        return leasedJob;
      },
      complete: async () => { completed = true; return true; },
      fail: async (_orgId, _id, error) => { failure = error; return { status: "queued" }; },
    },
    handlers: {
      [FINOPS_COMPUTE_OPTIMIZER_MATERIALIZE_JOB_KIND]: (value) =>
        runComputeOptimizerMaterializationJob(value, dependencies(fixture, {
          materialize: async () => runtimeCheckpoint(fixture, "PARTIAL_ATTEMPT_RECORDED"),
          recordOutcome: async (value) => { recorded.push(value); },
        })),
    },
    kinds: [FINOPS_COMPUTE_OPTIMIZER_MATERIALIZE_JOB_KIND],
    maxPerKind: 1,
    now: () => NOW,
  });
  assert.equal(completed, false);
  assert.equal(result.outcomes[0]?.succeeded, 0);
  assert.equal(result.outcomes[0]?.retried, 1);
  assert.match(failure, /PARTIAL_ATTEMPT_RECORDED/u);
  assert.equal((recorded[0] as { status: string }).status, "PARTIAL_ATTEMPT_RECORDED");
  assert.doesNotMatch(JSON.stringify(recorded), /sutra-runtime-use1|organization\/exports|objectKey/u);
});

test("accepted and already-accepted replays are the only normal return paths", async () => {
  const fixture = await payloadFixture();
  const { payload } = fixture;
  const statuses: string[] = [];
  await runComputeOptimizerMaterializationJob(job(payload), dependencies(fixture, {
    materialize: async () => runtimeCheckpoint(fixture, "GENERATION_ACCEPTED"),
    recordOutcome: async (value) => { statuses.push(value.status); },
  }));
  let materialized = false;
  const accepted = {
    generationId: `cog_${"6".repeat(64)}`,
    contentSha256: "6".repeat(64),
  } as unknown as ComputeOptimizerExportGeneration;
  await runComputeOptimizerMaterializationJob(job(payload), dependencies(fixture, {
    findAcceptedGeneration: async () => accepted,
    materialize: async () => { materialized = true; return runtimeCheckpoint(fixture, "GENERATION_ACCEPTED"); },
    recordOutcome: async (value) => { statuses.push(value.status); },
  }));
  assert.deepEqual(statuses, ["GENERATION_ACCEPTED", "ALREADY_ACCEPTED"]);
  assert.equal(materialized, false);
});

test("the worker deadline aborts a stuck coordinator and cannot complete the job", async () => {
  const fixture = await payloadFixture();
  const { payload } = fixture;
  await assert.rejects(runComputeOptimizerMaterializationJob(job(payload), dependencies(fixture, {
    maximumDurationMs: 5,
    materialize: async (_activation, _checkpoint, _runtimes, options) =>
      new Promise((_resolve, rejectPromise) => {
        options.signal!.addEventListener("abort", () => rejectPromise(
          new ComputeOptimizerMaterializationCoordinatorError("ABORTED"),
        ), { once: true });
      }),
  })), (error) => error instanceof ComputeOptimizerMaterializationRuntimeError
    && error.code === "DEADLINE_EXCEEDED");
});

test("the handler-wide deadline rejects stuck connection and plan hydration", async () => {
  const fixture = await payloadFixture();
  const { payload } = fixture;
  const never = async (): Promise<never> => new Promise(() => undefined);
  await assert.rejects(runComputeOptimizerMaterializationJob(job(payload), dependencies(fixture, {
    maximumDurationMs: 5,
    getConnection: never,
  })), (error) => error instanceof ComputeOptimizerMaterializationRuntimeError
    && error.code === "DEADLINE_EXCEEDED");
  await assert.rejects(runComputeOptimizerMaterializationJob(job(payload), dependencies(fixture, {
    maximumDurationMs: 5,
    loadPersistedPlanSet: never,
  })), (error) => error instanceof ComputeOptimizerMaterializationRuntimeError
    && error.code === "DEADLINE_EXCEEDED");
});

test("the handler-wide deadline rejects stuck replay lookup and replay telemetry", async () => {
  const fixture = await payloadFixture();
  const { payload } = fixture;
  const accepted = {
    generationId: `cog_${"7".repeat(64)}`,
    contentSha256: "7".repeat(64),
  } as unknown as ComputeOptimizerExportGeneration;
  const never = async (): Promise<never> => new Promise(() => undefined);
  await assert.rejects(runComputeOptimizerMaterializationJob(job(payload), dependencies(fixture, {
    maximumDurationMs: 5,
    findAcceptedGeneration: never,
  })), (error) => error instanceof ComputeOptimizerMaterializationRuntimeError
    && error.code === "DEADLINE_EXCEEDED");
  await assert.rejects(runComputeOptimizerMaterializationJob(job(payload), dependencies(fixture, {
    maximumDurationMs: 5,
    findAcceptedGeneration: async () => accepted,
    recordOutcome: never,
  })), (error) => error instanceof ComputeOptimizerMaterializationRuntimeError
    && error.code === "DEADLINE_EXCEEDED");
});
