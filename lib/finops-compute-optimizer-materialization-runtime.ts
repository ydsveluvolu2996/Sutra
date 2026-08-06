import { isCollectableAwsSourceKind } from "./aws-connection-source";
/**
 * Durable production boundary for the exact Compute Optimizer materializer.
 *
 * The queue owns retries and leases. This module owns strict payload parsing,
 * tenant/capability checks, reconstruction of signed exact-ID readers, and the
 * success rule: only an accepted generation (including a persisted replay) may
 * return normally to the shared background-job runner.
 */
import { canonicalJson } from "./canonical-json.ts";
import {
  COMPUTE_OPTIMIZER_MATERIALIZATION_COORDINATOR_BOUNDS,
  ComputeOptimizerMaterializationCoordinatorError,
  runComputeOptimizerPersistedPlanSetMaterialization,
  verifyComputeOptimizerMaterializationActivation,
  verifyComputeOptimizerMaterializationPlanCheckpoint,
  type ComputeOptimizerExactGenerationPersistence,
  type ComputeOptimizerPersistedPlanSetMaterializationInput,
  type ComputeOptimizerMaterializationRuntimeCheckpoint,
} from "./finops-compute-optimizer-export-coordinator.ts";
import {
  createComputeOptimizerExactDescribeReader,
  type ComputeOptimizerExactDescribeTransport,
} from "./finops-compute-optimizer-export-exact-describe-reader.ts";
import {
  createComputeOptimizerExportObjectReader,
  type ComputeOptimizerExportObjectChunkTransport,
} from "./finops-compute-optimizer-export-object-reader.ts";
import {
  COMPUTE_OPTIMIZER_EXPORT_OBJECT_SET_BOUNDS,
} from "./finops-compute-optimizer-export-object-set.ts";
import type {
  ComputeOptimizerExportGeneration,
} from "./finops-compute-optimizer-export-generation.ts";
import type {
  ComputeOptimizerExportPlanSet,
} from "./finops-compute-optimizer-export-plan.ts";
import type {
  StoredComputeOptimizerFinalizedExportEvidence,
} from "../db/finops-compute-optimizer-discovery-repository.ts";
import type { RunnableJob } from "./background-job-runner.ts";

export const FINOPS_COMPUTE_OPTIMIZER_MATERIALIZE_JOB_KIND =
  "finops-compute-optimizer-materialize";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const JOB_ID = /^job_[a-f0-9]{32}$/u;
const ACTIVATION_ID = /^comra_[a-f0-9]{64}$/u;
const CHECKPOINT_ID = /^comrp_[a-f0-9]{64}$/u;
const PLAN_SET_ID = /^copes_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DAILY_WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const MAX_QUEUE_PAYLOAD_BYTES = 240 * 1_024;
const WORKER_DEADLINE_MS = 5 * 60_000 + 30_000;

export const COMPUTE_OPTIMIZER_MATERIALIZATION_RUNTIME_BOUNDS = Object.freeze({
  maximumQueuePayloadBytes: MAX_QUEUE_PAYLOAD_BYTES,
  maximumWorkerDurationMs: WORKER_DEADLINE_MS,
  maximumConcurrentJobsPerDrain: 1,
  maximumConcurrentObjectReads:
    COMPUTE_OPTIMIZER_EXPORT_OBJECT_SET_BOUNDS.maximumConcurrency,
  maximumRegions:
    COMPUTE_OPTIMIZER_MATERIALIZATION_COORDINATOR_BOUNDS.maximumRegions,
} as const);

export interface ComputeOptimizerMaterializationRegionContracts {
  readonly region: string;
  /** Opaque compute_optimizer_organization_export source-contract identity. */
  readonly describeContractId: string;
  /** Opaque .8.5 launch-contract identity used for exact S3 reads. */
  readonly objectContractId: string;
}

export interface ComputeOptimizerMaterializationJobPayload {
  readonly schemaVersion: "sutra.compute-optimizer-materialization-job.v1";
  readonly activationId: string;
  readonly planCheckpointId: string;
  readonly scheduledWindow: string;
  readonly scope: {
    readonly organizationId: string;
    readonly customerId: string;
    readonly connectionId: string;
  };
  readonly requesterAccountId: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly planSetId: string;
  readonly planSetContentSha256: string;
  readonly regionContracts: readonly ComputeOptimizerMaterializationRegionContracts[];
}

export interface ComputeOptimizerMaterializationQueue {
  enqueue(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly kind: string;
    readonly payload: ComputeOptimizerMaterializationJobPayload;
    readonly maxAttempts: number;
    readonly idempotencyKey: string;
  }, nowMs?: number): Promise<{ readonly id: string }>;
}

export interface ComputeOptimizerMaterializationRuntimeConnection {
  readonly id: string;
  readonly customerId: string;
  readonly sourceKind: string;
  readonly status: string;
  readonly permissionPackVersion: string;
  readonly awsAccountId: string;
  readonly partition: string;
}

export interface LoadedComputeOptimizerMaterializationPlanSet {
  readonly planSet: ComputeOptimizerExportPlanSet;
  readonly discoveryEvidence: readonly {
    readonly region: string;
    readonly evidence: StoredComputeOptimizerFinalizedExportEvidence;
  }[];
}

export type ComputeOptimizerMaterializationOutcomeStatus =
  | "ALREADY_ACCEPTED"
  | ComputeOptimizerMaterializationRuntimeCheckpoint["status"];

export interface ComputeOptimizerMaterializationOutcome {
  readonly jobId: string;
  readonly jobAttempt: number;
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly activationId: string;
  readonly planCheckpointId: string;
  readonly planSetId: string;
  readonly status: ComputeOptimizerMaterializationOutcomeStatus;
  readonly runtimeCheckpointId: string | null;
  readonly generationId: string | null;
  readonly generationContentSha256: string | null;
  readonly mappedRegionCount: number;
  readonly blockedRegionCount: number;
}

export interface ComputeOptimizerMaterializationRuntimeDependencies {
  readonly getConnection: (
    organizationId: string,
    connectionId: string,
  ) => Promise<ComputeOptimizerMaterializationRuntimeConnection | null>;
  readonly loadPersistedPlanSet: (input: {
    readonly organizationId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly planSetId: string;
  }) => Promise<LoadedComputeOptimizerMaterializationPlanSet>;
  readonly findAcceptedGeneration: (
    scope: { readonly organizationId: string; readonly customerId: string; readonly connectionId: string },
    planSet: ComputeOptimizerExportPlanSet,
  ) => Promise<ComputeOptimizerExportGeneration | null>;
  readonly persistence: ComputeOptimizerExactGenerationPersistence;
  readonly describeTransport: ComputeOptimizerExactDescribeTransport;
  readonly objectTransport: ComputeOptimizerExportObjectChunkTransport;
  /** Required durable, tenant-scoped telemetry sink. */
  readonly recordOutcome: (outcome: ComputeOptimizerMaterializationOutcome) => Promise<void>;
  /** Test seam; production always uses the exact coordinator imported above. */
  readonly materialize?: typeof runComputeOptimizerPersistedPlanSetMaterialization;
  /** Test seam that may only tighten the production ceiling. */
  readonly maximumDurationMs?: number;
  readonly now?: () => number;
}

export class ComputeOptimizerMaterializationRuntimeError extends Error {
  public readonly code:
    | "INVALID_JOB"
    | "INVALID_SCOPE"
    | "LIMIT_EXCEEDED"
    | "CAPABILITY_UNAVAILABLE"
    | "PERSISTED_INPUT_INVALID"
    | "DEADLINE_EXCEEDED"
    | "TELEMETRY_FAILED"
    | "FRESH_BLOCKED"
    | "PARTIAL_ATTEMPT_RECORDED";

  public constructor(code: ComputeOptimizerMaterializationRuntimeError["code"]) {
    super(`Compute Optimizer materialization runtime rejected: ${code}`);
    this.name = "ComputeOptimizerMaterializationRuntimeError";
    this.code = code;
  }
}

function reject(code: ComputeOptimizerMaterializationRuntimeError["code"]): never {
  throw new ComputeOptimizerMaterializationRuntimeError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function readNow(clock: (() => number) | undefined): number {
  let value: unknown;
  try { value = (clock ?? Date.now)(); } catch { return reject("INVALID_JOB"); }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    reject("INVALID_JOB");
  }
  return value;
}

function encodedBytes(value: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch {
    return reject("INVALID_JOB");
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function validContract(value: unknown): value is ComputeOptimizerMaterializationRegionContracts {
  return isRecord(value)
    && exactKeys(value, ["region", "describeContractId", "objectContractId"])
    && typeof value.region === "string" && REGION.test(value.region)
    && typeof value.describeContractId === "string" && IDENTIFIER.test(value.describeContractId)
    && typeof value.objectContractId === "string" && IDENTIFIER.test(value.objectContractId);
}

export async function parseComputeOptimizerMaterializationJobPayload(
  value: unknown,
): Promise<ComputeOptimizerMaterializationJobPayload> {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "activationId", "planCheckpointId", "scheduledWindow", "scope",
    "requesterAccountId", "partition", "planSetId", "planSetContentSha256",
    "regionContracts",
  ]) || value.schemaVersion !== "sutra.compute-optimizer-materialization-job.v1"
    || typeof value.activationId !== "string" || !ACTIVATION_ID.test(value.activationId)
    || typeof value.planCheckpointId !== "string"
    || !CHECKPOINT_ID.test(value.planCheckpointId)
    || typeof value.scheduledWindow !== "string" || !DAILY_WINDOW.test(value.scheduledWindow)
    || !Number.isSafeInteger(Date.parse(value.scheduledWindow))
    || new Date(Date.parse(value.scheduledWindow)).toISOString() !== value.scheduledWindow
    || !isRecord(value.scope) || !exactKeys(value.scope, [
      "organizationId", "customerId", "connectionId",
    ])
    || typeof value.scope.organizationId !== "string"
    || !IDENTIFIER.test(value.scope.organizationId)
    || typeof value.scope.customerId !== "string" || !IDENTIFIER.test(value.scope.customerId)
    || typeof value.scope.connectionId !== "string" || !CONNECTION_ID.test(value.scope.connectionId)
    || typeof value.requesterAccountId !== "string" || !/^\d{12}$/u.test(value.requesterAccountId)
    || (value.partition !== "aws" && value.partition !== "aws-us-gov"
      && value.partition !== "aws-cn")
    || typeof value.planSetId !== "string" || !PLAN_SET_ID.test(value.planSetId)
    || typeof value.planSetContentSha256 !== "string"
    || !SHA256.test(value.planSetContentSha256)
    || !Array.isArray(value.regionContracts)
    || value.regionContracts.length < 1
    || value.regionContracts.length
      > COMPUTE_OPTIMIZER_MATERIALIZATION_RUNTIME_BOUNDS.maximumRegions
    || value.regionContracts.some((contract) => !validContract(contract))) {
    reject("INVALID_JOB");
  }
  if (encodedBytes(value) > MAX_QUEUE_PAYLOAD_BYTES) reject("LIMIT_EXCEEDED");
  const contracts = (value.regionContracts as ComputeOptimizerMaterializationRegionContracts[])
    .map((contract) => Object.freeze({ ...contract }))
    .sort((left, right) => left.region.localeCompare(right.region));
  if (contracts.length < 1
    || new Set(contracts.map(({ region }) => region)).size !== contracts.length
    || contracts.some((contract, index) => index > 0
      && contracts[index - 1]!.region.localeCompare(contract.region) >= 0)) {
    reject("INVALID_JOB");
  }
  return Object.freeze({
    schemaVersion: "sutra.compute-optimizer-materialization-job.v1",
    activationId: value.activationId,
    planCheckpointId: value.planCheckpointId,
    scheduledWindow: value.scheduledWindow,
    scope: Object.freeze({
      organizationId: value.scope.organizationId,
      customerId: value.scope.customerId,
      connectionId: value.scope.connectionId,
    }),
    requesterAccountId: value.requesterAccountId,
    partition: value.partition,
    planSetId: value.planSetId,
    planSetContentSha256: value.planSetContentSha256,
    regionContracts: Object.freeze(contracts),
  });
}

export async function enqueueComputeOptimizerMaterialization(input: {
  readonly queue: ComputeOptimizerMaterializationQueue;
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly activation: unknown;
  readonly planCheckpoint: unknown;
  readonly regionContracts: readonly ComputeOptimizerMaterializationRegionContracts[];
  readonly nowMs?: number;
}): Promise<string> {
  const nowMs = input.nowMs ?? Date.now();
  if (!IDENTIFIER.test(input.organizationId) || !IDENTIFIER.test(input.customerId)
    || !CONNECTION_ID.test(input.connectionId)
    || !Number.isSafeInteger(nowMs) || nowMs < 0) reject("INVALID_SCOPE");
  let activation;
  let planCheckpoint;
  try {
    activation = await verifyComputeOptimizerMaterializationActivation(
      structuredClone(input.activation),
    );
    planCheckpoint = await verifyComputeOptimizerMaterializationPlanCheckpoint(
      activation,
      structuredClone(input.planCheckpoint),
    );
  } catch { return reject("INVALID_JOB"); }
  if (planCheckpoint.status !== "PLAN_SET_READY" || planCheckpoint.planSet === null) {
    reject("INVALID_JOB");
  }
  const scope = activation.scope;
  if (scope.orgId !== input.organizationId || scope.customerId !== input.customerId
    || scope.connectionId !== input.connectionId) reject("INVALID_SCOPE");
  const payload = await parseComputeOptimizerMaterializationJobPayload({
    schemaVersion: "sutra.compute-optimizer-materialization-job.v1",
    activationId: activation.activationId,
    planCheckpointId: planCheckpoint.checkpointId,
    scheduledWindow: activation.scheduledWindow,
    scope: {
      organizationId: scope.orgId,
      customerId: scope.customerId,
      connectionId: scope.connectionId,
    },
    requesterAccountId: activation.requesterAccountId,
    partition: activation.partition,
    planSetId: planCheckpoint.planSet.planSetId,
    planSetContentSha256: planCheckpoint.planSet.contentSha256,
    regionContracts: input.regionContracts,
  });
  if (payload.regionContracts.length !== activation.regions.length
    || payload.regionContracts.some((contract, index) =>
      contract.region !== activation.regions[index])) reject("INVALID_JOB");
  const queued = await input.queue.enqueue({
    orgId: input.organizationId,
    customerId: input.customerId,
    connectionId: input.connectionId,
    kind: FINOPS_COMPUTE_OPTIMIZER_MATERIALIZE_JOB_KIND,
    payload,
    maxAttempts: 6,
    idempotencyKey:
      `${FINOPS_COMPUTE_OPTIMIZER_MATERIALIZE_JOB_KIND}:${payload.activationId}:` +
      payload.planCheckpointId,
  }, nowMs);
  if (!JOB_ID.test(queued.id)) reject("INVALID_JOB");
  return queued.id;
}

function assertJobScope(job: RunnableJob, payload: ComputeOptimizerMaterializationJobPayload): {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
} {
  if (job.customerId === null || job.connectionId === null
    || job.customerId !== payload.scope.customerId
    || job.connectionId !== payload.scope.connectionId
    || job.orgId !== payload.scope.organizationId) reject("INVALID_SCOPE");
  return {
    organizationId: job.orgId,
    customerId: job.customerId,
    connectionId: job.connectionId,
  };
}

function assertCapability(
  connection: ComputeOptimizerMaterializationRuntimeConnection | null,
  scope: { readonly customerId: string; readonly connectionId: string },
  payload: ComputeOptimizerMaterializationJobPayload,
): void {
  if (connection === null || connection.id !== scope.connectionId
    || connection.customerId !== scope.customerId
    || !isCollectableAwsSourceKind(connection.sourceKind) || connection.status !== "active"
    || connection.permissionPackVersion !== "standard-2026-08.5"
    || connection.awsAccountId !== payload.requesterAccountId
    || connection.partition !== payload.partition) reject("CAPABILITY_UNAVAILABLE");
}

function outcome(
  job: RunnableJob,
  payload: ComputeOptimizerMaterializationJobPayload,
  status: ComputeOptimizerMaterializationOutcomeStatus,
  checkpoint: ComputeOptimizerMaterializationRuntimeCheckpoint | null,
  generation: ComputeOptimizerExportGeneration | null,
): ComputeOptimizerMaterializationOutcome {
  const regions = checkpoint?.regions ?? [];
  return Object.freeze({
    jobId: job.id,
    jobAttempt: job.attempt,
    organizationId: job.orgId,
    customerId: job.customerId!,
    connectionId: job.connectionId!,
    activationId: payload.activationId,
    planCheckpointId: payload.planCheckpointId,
    planSetId: payload.planSetId,
    status,
    runtimeCheckpointId: checkpoint?.checkpointId ?? null,
    generationId: generation?.generationId ?? checkpoint?.generation?.generationId ?? null,
    generationContentSha256:
      generation?.contentSha256 ?? checkpoint?.generation?.contentSha256 ?? null,
    mappedRegionCount: regions.filter(({ state }) => state === "MAPPED").length,
    blockedRegionCount: regions.filter(({ state }) => state !== "MAPPED").length,
  });
}

async function persistOutcome(
  dependencies: ComputeOptimizerMaterializationRuntimeDependencies,
  value: ComputeOptimizerMaterializationOutcome,
  signal: AbortSignal,
): Promise<void> {
  try {
    await awaitWithinDeadline(signal, () => dependencies.recordOutcome(value));
  } catch (error) {
    if (error instanceof ComputeOptimizerMaterializationRuntimeError
      && error.code === "DEADLINE_EXCEEDED") throw error;
    reject("TELEMETRY_FAILED");
  }
}

function deadlineError(): ComputeOptimizerMaterializationRuntimeError {
  return new ComputeOptimizerMaterializationRuntimeError("DEADLINE_EXCEEDED");
}

/**
 * Race every asynchronous boundary against the one handler-wide signal. The
 * losing dependency remains observed so a later rejection cannot become an
 * unhandled rejection, while the queue worker is released at the deadline.
 */
async function awaitWithinDeadline<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw deadlineError();
  return new Promise<T>((resolve, rejectPromise) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => rejectPromise(deadlineError()));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => {
          if (signal.aborted
            || (error instanceof ComputeOptimizerMaterializationCoordinatorError
              && error.code === "DEADLINE_EXCEEDED")) {
            rejectPromise(deadlineError());
            return;
          }
          rejectPromise(error);
        }),
      );
  });
}

/**
 * Shared-worker handler. Returning means the durable accepted head is proven.
 * Every non-accepted coordinator checkpoint is first recorded, then thrown so
 * the queue retains retry/dead-letter state instead of claiming success.
 */
export async function runComputeOptimizerMaterializationJob(
  job: RunnableJob,
  dependencies: ComputeOptimizerMaterializationRuntimeDependencies,
): Promise<void> {
  if (job.kind !== FINOPS_COMPUTE_OPTIMIZER_MATERIALIZE_JOB_KIND) reject("INVALID_JOB");
  const payload = await parseComputeOptimizerMaterializationJobPayload(job.payload);
  const scope = assertJobScope(job, payload);
  const startedAtMs = readNow(dependencies.now);
  const maximumDurationMs = dependencies.maximumDurationMs ?? WORKER_DEADLINE_MS;
  if (!Number.isSafeInteger(maximumDurationMs) || maximumDurationMs < 1
    || maximumDurationMs > WORKER_DEADLINE_MS) reject("INVALID_JOB");
  const deadlineAtMs = startedAtMs + maximumDurationMs;
  if (!Number.isSafeInteger(deadlineAtMs)) reject("INVALID_JOB");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), maximumDurationMs);
  // Freeze evidence timestamps to the attempt start. Real wall-clock enforcement
  // is the abort timer plus absolute deadlines in the signed pilot transports.
  const attemptClock = (): number => startedAtMs;
  try {
    const connection = await awaitWithinDeadline(controller.signal, () =>
      dependencies.getConnection(job.orgId, scope.connectionId));
    assertCapability(connection, scope, payload);
    const loaded = await awaitWithinDeadline(controller.signal, () =>
      dependencies.loadPersistedPlanSet({
        ...scope,
        planSetId: payload.planSetId,
      }));
    const planSet = loaded.planSet;
    if (planSet.planSetId !== payload.planSetId
      || planSet.contentSha256 !== payload.planSetContentSha256
      || planSet.scope.orgId !== scope.organizationId
      || planSet.scope.customerId !== scope.customerId
      || planSet.scope.connectionId !== scope.connectionId
      || planSet.requesterAccountId !== payload.requesterAccountId
      || planSet.partition !== payload.partition
      || planSet.regions.length !== payload.regionContracts.length
      || planSet.regions.some((region, index) =>
        region !== payload.regionContracts[index]?.region)
      || loaded.discoveryEvidence.length !== planSet.regions.length) {
      reject("PERSISTED_INPUT_INVALID");
    }
    const evidenceByRegion = new Map(loaded.discoveryEvidence.map((entry) => [
      entry.region,
      entry.evidence,
    ]));
    if (evidenceByRegion.size !== planSet.regions.length
      || planSet.regions.some((region) => !evidenceByRegion.has(region))) {
      reject("PERSISTED_INPUT_INVALID");
    }

    const accepted = await awaitWithinDeadline(controller.signal, () =>
      dependencies.findAcceptedGeneration(scope, planSet));
    if (accepted !== null) {
      await persistOutcome(
        dependencies,
        outcome(job, payload, "ALREADY_ACCEPTED", null, accepted),
        controller.signal,
      );
      return;
    }

    const contractsByRegion = new Map(payload.regionContracts.map((contract) => [
      contract.region,
      contract,
    ]));
    const runtimes = await awaitWithinDeadline(controller.signal, () =>
      Promise.all(planSet.plans.map(async (plan) => {
      const region = plan.regions[0]!;
      const contract = contractsByRegion.get(region) ?? reject("INVALID_JOB");
      const plannedJobs = await Promise.all(plan.targets.map(async (target) => {
        const launchRequestSha256 = await sha256(canonicalJson(target.request));
        const targetId = `coelt_${await sha256(canonicalJson({
          exportFamily: target.exportFamily,
          operation: target.request.operation,
          region: target.region,
          requestSha256: launchRequestSha256,
        }))}`;
        return {
          targetId,
          plannedJobId: target.expectedJob.jobId,
          exportFamily: target.exportFamily,
          providerResourceType: target.expectedJob.providerResourceType,
          requestSha256: target.requestSha256,
          bucket: target.expectedJob.bucket,
          objectKey: target.expectedJob.objectKey,
          metadataKey: target.expectedJob.metadataKey,
        };
      }));
      const describeReader = createComputeOptimizerExactDescribeReader({
        schema: "sutra.compute-optimizer-export-exact-describe-request.v1",
        tenantId: job.orgId,
        connectionId: scope.connectionId,
        collectionJobId: job.id,
        contractId: contract.describeContractId,
        accountId: payload.requesterAccountId,
        partition: payload.partition,
        region,
        plannedJobs,
      }, dependencies.describeTransport, { deadlineAtMs, now: attemptClock });
      const objectBoundaries = plan.targets.flatMap((target) => [
        target.expectedJob.objectKey,
        target.expectedJob.metadataKey,
      ].map((key) => ({
        tenantId: job.orgId,
        connectionId: scope.connectionId,
        jobId: job.id,
        contractId: contract.objectContractId,
        plannedJobId: target.expectedJob.jobId,
        region,
        bucket: target.expectedJob.bucket,
        key,
      })));
      return {
        region,
        discoveryEvidence: evidenceByRegion.get(region)!,
        describeReader,
        objectReader: createComputeOptimizerExportObjectReader(
          objectBoundaries,
          dependencies.objectTransport,
          { deadlineAtMs, now: attemptClock },
        ),
      };
      })));
    let checkpoint: ComputeOptimizerMaterializationRuntimeCheckpoint;
    try {
      const lineage: ComputeOptimizerPersistedPlanSetMaterializationInput = {
        schemaVersion: "sutra.compute-optimizer-persisted-plan-materialization.v1",
        activationId: payload.activationId,
        planCheckpointId: payload.planCheckpointId,
        scheduledWindow: payload.scheduledWindow,
        scope: {
          orgId: scope.organizationId,
          customerId: scope.customerId,
          connectionId: scope.connectionId,
        },
        requesterAccountId: payload.requesterAccountId,
        partition: payload.partition,
        planSetId: payload.planSetId,
        planSetContentSha256: payload.planSetContentSha256,
      };
      checkpoint = await awaitWithinDeadline(controller.signal, () =>
        (dependencies.materialize
          ?? runComputeOptimizerPersistedPlanSetMaterialization)(
          lineage,
          planSet,
          runtimes,
          {
            materializedAtMs: startedAtMs,
            deadlineAtMs,
            persistence: dependencies.persistence,
            signal: controller.signal,
            now: attemptClock,
          },
        ));
    } catch (error) {
      if (controller.signal.aborted
        || (error instanceof ComputeOptimizerMaterializationCoordinatorError
          && error.code === "DEADLINE_EXCEEDED")) reject("DEADLINE_EXCEEDED");
      throw error;
    }
    await persistOutcome(
      dependencies,
      outcome(job, payload, checkpoint.status, checkpoint, null),
      controller.signal,
    );
    if (checkpoint.status === "GENERATION_ACCEPTED") return;
    if (checkpoint.status === "FRESH_BLOCKED") reject("FRESH_BLOCKED");
    reject("PARTIAL_ATTEMPT_RECORDED");
  } finally {
    clearTimeout(timer);
  }
}
