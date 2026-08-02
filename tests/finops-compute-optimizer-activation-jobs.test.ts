import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalJson } from "../lib/canonical-json.ts";
import {
  ComputeOptimizerActivationJobError,
  FINOPS_COMPUTE_OPTIMIZER_ACTIVATION_LAUNCH_JOB_KIND,
  FINOPS_COMPUTE_OPTIMIZER_ACTIVATION_RECONCILE_JOB_KIND,
  createComputeOptimizerActivationBoundary,
  recoverComputeOptimizerActivations,
  runComputeOptimizerActivationLaunchJob,
  runComputeOptimizerActivationReconcileJob,
  scheduleDailyComputeOptimizerActivations,
  type ComputeOptimizerActivationJobScope,
  type ComputeOptimizerEnabledCapability,
  type ComputeOptimizerStoredActivation,
} from "../lib/finops-compute-optimizer-activation-jobs.ts";
import type {
  ComputeOptimizerExportLaunchAttempt,
  ComputeOptimizerExportLaunchExecution,
  ComputeOptimizerExportLaunchOutcome,
} from "../lib/finops-compute-optimizer-export-launch.ts";
import type {
  ComputeOptimizerMaterializationActivationManifest,
} from "../services/aws-collector/src/compute-optimizer-materialization-activation-manifest.ts";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");
const CONNECTION = `conn_${"a".repeat(32)}`;
const REGIONS = ["us-east-1", "us-west-2"] as const;
const SCOPE: ComputeOptimizerActivationJobScope = {
  organizationId: "org-jobs",
  customerId: "customer-jobs",
  connectionId: CONNECTION,
};

async function sha(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(canonicalJson(value)),
  );
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0")).join("");
}

function capability(): ComputeOptimizerEnabledCapability {
  return {
    capabilityId: `cocp_${"1".repeat(64)}`,
    scope: SCOPE,
    accountId: "123456789012",
    partition: "aws",
    regions: REGIONS,
    manifestSha256: "2".repeat(64),
    enabled: true,
  };
}

function manifest(requestId: string): ComputeOptimizerMaterializationActivationManifest {
  return {
    schema: "sutra.compute-optimizer-materialization-activation-manifest-response.v1",
    requestId,
    tenantId: SCOPE.organizationId,
    connectionId: CONNECTION,
    accountId: "123456789012",
    partition: "aws",
    permissionPackVersion: "standard-2026-08.5",
    regions: REGIONS.map((region, index) => ({
      region,
      describeContractId: `describe-${region}`,
      launchContractId: `launch-${region}`,
      objectReadContractId: `object-${region}`,
      bucket: `sutra-co-${index + 1}-123456789012`,
      basePrefix: "exports/",
      effectivePrefix: "exports/compute-optimizer/123456789012/",
    })),
  };
}

async function execution(
  attempt: ComputeOptimizerExportLaunchAttempt,
  partial = false,
): Promise<ComputeOptimizerExportLaunchExecution> {
  const outcomes: ComputeOptimizerExportLaunchOutcome[] = attempt.targets.map((target, index) => {
    if (partial) return {
      targetId: target.targetId,
      exportFamily: target.exportFamily,
      operation: target.operation,
      status: index === 0 ? "FAILED" : "NOT_ATTEMPTED",
      jobId: null,
      bucket: null,
      objectKey: null,
      metadataKey: null,
      errorCode: "RATE_LIMITED",
    };
    const jobId = `job-${attempt.region}-${index + 1}`;
    const objectKey = `${target.effectivePrefix}${attempt.region}-daily-${jobId}.csv`;
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
    status: partial ? "PARTIAL" as const : "COMPLETE" as const,
    startedAtIso: "2026-08-02T00:02:00.000Z",
    finishedAtIso: "2026-08-02T00:03:00.000Z",
    outcomes,
  };
  const contentSha256 = await sha(body);
  return { ...body, executionId: `coele_${contentSha256}`, contentSha256 };
}

function boundary(signal?: AbortSignal) {
  return createComputeOptimizerActivationBoundary({
    nowMs: NOW,
    maximumDurationMs: 60_000,
    ...(signal === undefined ? {} : { signal }),
  });
}

function job(activation: ComputeOptimizerStoredActivation, overrides: Record<string, unknown> = {}) {
  return {
    id: "job-activation-launch",
    orgId: activation.scope.organizationId,
    customerId: activation.scope.customerId,
    connectionId: activation.scope.connectionId,
    kind: FINOPS_COMPUTE_OPTIMIZER_ACTIVATION_LAUNCH_JOB_KIND,
    payload: {
      customerId: activation.scope.customerId,
      connectionId: activation.scope.connectionId,
      activationId: activation.activationId,
    },
    attempt: 1,
    maxAttempts: 12,
    ...overrides,
  };
}

test("daily UTC tick replays one deterministic activation and duplicate queue identity", async () => {
  const queued: Array<Readonly<Record<string, unknown>>> = [];
  let stored: ComputeOptimizerStoredActivation | undefined;
  const dependencies = {
    listEnabledCapabilities: async () => [capability()],
    readSignedManifest: async (_capability: ComputeOptimizerEnabledCapability, requestId: string) =>
      manifest(requestId),
    createDailyActivation: async (_scope: ComputeOptimizerActivationJobScope, input: {
      activation: { activationId: string; contentSha256: string };
      capabilityId: string;
    }) => {
      stored ??= {
        activationId: input.activation.activationId,
        scope: SCOPE,
        capabilityId: input.capabilityId,
        accountId: "123456789012",
        partition: "aws" as const,
        scheduledWindow: "2026-08-02T00:00:00.000Z",
        sealedAtIso: "2026-08-02T00:00:00.000Z",
        attempt: 1,
        state: "SEALED" as const,
        activationContentSha256: input.activation.contentSha256,
      };
      return stored;
    },
    queue: {
      enqueue: async (input: Readonly<Record<string, unknown>>) => {
        queued.push(structuredClone(input));
        return { id: `job_${"a".repeat(32)}` };
      },
    },
    now: () => NOW,
  };
  const first = await scheduleDailyComputeOptimizerActivations(dependencies, boundary());
  const second = await scheduleDailyComputeOptimizerActivations(dependencies, boundary());
  assert.deepEqual(first.activationIds, second.activationIds);
  assert.equal(queued.length, 2);
  assert.equal(queued[0]?.idempotencyKey, queued[1]?.idempotencyKey);
  assert.equal(queued[0]?.kind, FINOPS_COMPUTE_OPTIMIZER_ACTIVATION_LAUNCH_JOB_KIND);
  assert.deepEqual(Object.keys(queued[0]?.payload as object).sort(), [
    "activationId", "connectionId", "customerId",
  ]);
});

test("launch checkpoints every complete ledger replay before regional discovery and finalization", async () => {
  let stored: ComputeOptimizerStoredActivation | undefined;
  const scheduler = {
    listEnabledCapabilities: async () => [capability()],
    readSignedManifest: async (_capability: ComputeOptimizerEnabledCapability, requestId: string) => manifest(requestId),
    createDailyActivation: async (_scope: ComputeOptimizerActivationJobScope, input: {
      activation: { activationId: string; contentSha256: string };
      capabilityId: string;
    }) => stored = {
      activationId: input.activation.activationId,
      scope: SCOPE,
      capabilityId: input.capabilityId,
      accountId: "123456789012",
      partition: "aws" as const,
      scheduledWindow: "2026-08-02T00:00:00.000Z",
      sealedAtIso: "2026-08-02T00:00:00.000Z",
      attempt: 1,
      state: "SEALED" as const,
      activationContentSha256: input.activation.contentSha256,
    },
    queue: { enqueue: async () => ({ id: `job_${"b".repeat(32)}` }) },
    now: () => NOW,
  };
  await scheduleDailyComputeOptimizerActivations(scheduler, boundary());
  assert.ok(stored !== undefined);
  const events: string[] = [];
  await runComputeOptimizerActivationLaunchJob(job(stored), {
    getActivation: async () => stored!,
    getCurrentCapability: async () => capability(),
    readSignedManifest: async (_cap, requestId) => manifest(requestId),
    launchExact: async (attempt) => {
      events.push(`launch:${attempt.region}`);
      return execution(attempt);
    },
    recordRegionalLaunchCheckpoint: async (_scope, input) => {
      events.push(`checkpoint:${input.region}`);
    },
    ensureRegionalDiscovery: async (input) => {
      events.push(`discovery:${input.region}`);
    },
    finalizeLaunchCheckpoints: async () => {
      events.push("finalize");
      return { ...stored!, state: "DISCOVERY_PENDING" as const };
    },
    now: () => NOW,
  }, boundary());
  assert.deepEqual(events, [
    "launch:us-east-1", "checkpoint:us-east-1", "discovery:us-east-1",
    "launch:us-west-2", "checkpoint:us-west-2", "discovery:us-west-2",
    "finalize",
  ]);
});

test("partial regional launch never creates discovery or finalizes", async () => {
  let activation: ComputeOptimizerStoredActivation | undefined;
  const scheduler = {
    listEnabledCapabilities: async () => [capability()],
    readSignedManifest: async (_capability: ComputeOptimizerEnabledCapability, requestId: string) => manifest(requestId),
    createDailyActivation: async (_scope: ComputeOptimizerActivationJobScope, input: {
      activation: { activationId: string; contentSha256: string };
      capabilityId: string;
    }) => activation = {
      activationId: input.activation.activationId, scope: SCOPE, capabilityId: input.capabilityId,
      accountId: "123456789012", partition: "aws" as const,
      scheduledWindow: "2026-08-02T00:00:00.000Z", sealedAtIso: "2026-08-02T00:00:00.000Z",
      attempt: 1, state: "SEALED" as const, activationContentSha256: input.activation.contentSha256,
    },
    queue: { enqueue: async () => ({ id: `job_${"c".repeat(32)}` }) },
    now: () => NOW,
  };
  await scheduleDailyComputeOptimizerActivations(scheduler, boundary());
  let discoveries = 0;
  let finalized = 0;
  await assert.rejects(runComputeOptimizerActivationLaunchJob(job(activation!), {
    getActivation: async () => activation!,
    getCurrentCapability: async () => capability(),
    readSignedManifest: async (_cap, requestId) => manifest(requestId),
    launchExact: async (attempt) => execution(attempt, true),
    recordRegionalLaunchCheckpoint: async () => undefined,
    ensureRegionalDiscovery: async () => { discoveries += 1; },
    finalizeLaunchCheckpoints: async () => {
      finalized += 1;
      return { ...activation!, state: "DISCOVERY_PENDING" as const };
    },
    now: () => NOW,
  }, boundary()), (error) => error instanceof ComputeOptimizerActivationJobError
    && error.code === "LAUNCH_REJECTED");
  assert.equal(discoveries, 0);
  assert.equal(finalized, 0);
});

test("recovery enqueues reconcile only after all exact regional discoveries finalized", async () => {
  const base = {
    activationId: `comra_${"d".repeat(64)}`,
    scope: SCOPE,
    capabilityId: `cocp_${"1".repeat(64)}`,
    accountId: "123456789012",
    partition: "aws" as const,
    scheduledWindow: "2026-08-02T00:00:00.000Z",
    sealedAtIso: "2026-08-02T00:00:00.000Z",
    attempt: 1,
    activationContentSha256: "d".repeat(64),
  };
  const queued: string[] = [];
  const pending = { ...base, state: "DISCOVERY_PENDING" as const };
  const deps = (complete: boolean) => ({
    listRecoverableActivations: async () => [pending],
    ensureRegionalDiscoveries: async () => undefined,
    allRegionalDiscoveriesFinalized: async () => complete,
    queue: { enqueue: async (input: { kind: string }) => {
      queued.push(input.kind); return { id: `job_${"e".repeat(32)}` };
    } },
    now: () => NOW,
  });
  const incomplete = await recoverComputeOptimizerActivations(deps(false), boundary());
  assert.equal(incomplete.reconcileQueued, 0);
  const complete = await recoverComputeOptimizerActivations(deps(true), boundary());
  assert.equal(complete.reconcileQueued, 1);
  assert.deepEqual(queued, [FINOPS_COMPUTE_OPTIMIZER_ACTIVATION_RECONCILE_JOB_KIND]);
});

test("reconcile transitions from discovery pending before invoking the replay producer", async () => {
  const pending: ComputeOptimizerStoredActivation = {
    activationId: `comra_${"7".repeat(64)}`,
    scope: SCOPE,
    capabilityId: `cocp_${"1".repeat(64)}`,
    accountId: "123456789012",
    partition: "aws",
    scheduledWindow: "2026-08-02T00:00:00.000Z",
    sealedAtIso: "2026-08-02T00:00:00.000Z",
    attempt: 1,
    state: "DISCOVERY_PENDING",
    activationContentSha256: "7".repeat(64),
  };
  const events: string[] = [];
  await runComputeOptimizerActivationReconcileJob(job(pending, {
    kind: FINOPS_COMPUTE_OPTIMIZER_ACTIVATION_RECONCILE_JOB_KIND,
  }), {
    getActivation: async () => pending,
    beginReconcile: async () => {
      events.push("transition");
      return { ...pending, state: "RECONCILING" as const };
    },
    allRegionalDiscoveriesFinalized: async () => true,
    reconcile: async (activation) => {
      assert.equal(activation.state, "RECONCILING");
      events.push("producer");
    },
    now: () => NOW,
  }, boundary());
  assert.deepEqual(events, ["transition", "producer"]);
});

test("cross-tenant payload and pre-aborted boundary perform no launch side effect", async () => {
  const activation: ComputeOptimizerStoredActivation = {
    activationId: `comra_${"f".repeat(64)}`,
    scope: SCOPE,
    capabilityId: `cocp_${"1".repeat(64)}`,
    accountId: "123456789012",
    partition: "aws",
    scheduledWindow: "2026-08-02T00:00:00.000Z",
    sealedAtIso: "2026-08-02T00:00:00.000Z",
    attempt: 1,
    state: "SEALED",
    activationContentSha256: "f".repeat(64),
  };
  let loads = 0;
  const dependencies = {
    getActivation: async () => { loads += 1; return activation; },
    getCurrentCapability: async () => capability(),
    readSignedManifest: async (_cap: ComputeOptimizerEnabledCapability, requestId: string) => manifest(requestId),
    launchExact: async () => { throw new Error("must not launch"); },
    recordRegionalLaunchCheckpoint: async () => undefined,
    ensureRegionalDiscovery: async () => undefined,
    finalizeLaunchCheckpoints: async () => activation,
    now: () => NOW,
  };
  await assert.rejects(runComputeOptimizerActivationLaunchJob(job(activation, {
    customerId: "customer-other",
  }), dependencies, boundary()), (error) => error instanceof ComputeOptimizerActivationJobError
    && error.code === "INVALID_SCOPE");
  assert.equal(loads, 0);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runComputeOptimizerActivationLaunchJob(
    job(activation), dependencies, boundary(controller.signal),
  ), (error) => error instanceof ComputeOptimizerActivationJobError
    && error.code === "ABORTED");
  assert.equal(loads, 0);
});

test("absolute deadline returns even when a dependency ignores the signal", async () => {
  const startedAt = Date.now();
  await assert.rejects(scheduleDailyComputeOptimizerActivations({
    listEnabledCapabilities: async () => new Promise(() => undefined),
    readSignedManifest: async () => { throw new Error("unreachable"); },
    createDailyActivation: async () => { throw new Error("unreachable"); },
    queue: { enqueue: async () => { throw new Error("unreachable"); } },
    now: () => NOW,
  }, {
    signal: new AbortController().signal,
    deadlineAtMs: NOW + 25,
  }), (error) => error instanceof ComputeOptimizerActivationJobError
    && error.code === "DEADLINE_EXCEEDED");
  assert.ok(Date.now() - startedAt < 500);
});
