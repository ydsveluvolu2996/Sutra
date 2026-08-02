/** Production composition for the durable Compute Optimizer two-phase engine. */
import { env } from "cloudflare:workers";

import { appendAuditEvent } from "./pilot-repository.ts";
import {
  ComputeOptimizerActivationRepository,
  type StoredComputeOptimizerActivation,
  type StoredComputeOptimizerCapability,
} from "./finops-compute-optimizer-activation-repository.ts";
import {
  ComputeOptimizerDiscoveryRepository,
  computeOptimizerDiscoverySha256,
} from "./finops-compute-optimizer-discovery-repository.ts";
import { ComputeOptimizerExportPlanRepository } from
  "./finops-compute-optimizer-export-plan-repository.ts";
import { ComputeOptimizerExportPlanSetRepository } from
  "./finops-compute-optimizer-export-plan-set-repository.ts";
import { EvidenceRepository } from "./evidence-repository.ts";
import { JobQueueRepository } from "./job-queue-repository.ts";
import type { RunnableJob } from "../lib/background-job-runner.ts";
import { canonicalJson } from "../lib/canonical-json.ts";
import type { JsonValue } from "../lib/pilot-types.ts";
import { persistComputeOptimizerReadyPlansReadBeforeSealCore } from
  "../lib/finops-compute-optimizer-plan-persistence.ts";
import {
  createComputeOptimizerActivationBoundary,
  recoverComputeOptimizerActivations,
  runComputeOptimizerActivationLaunchJob,
  runComputeOptimizerActivationReconcileJob,
  scheduleDailyComputeOptimizerActivations,
  type ComputeOptimizerActivationBoundary,
  type ComputeOptimizerActivationJobScope,
  type ComputeOptimizerEnabledCapability,
  type ComputeOptimizerStoredActivation,
} from "../lib/finops-compute-optimizer-activation-jobs.ts";
import { createComputeOptimizerActivationProducer } from
  "../lib/finops-compute-optimizer-activation-producer.ts";
import {
  dispatchComputeOptimizerMaterializerOutbox,
  type ComputeOptimizerOutboxWork,
} from "../lib/finops-compute-optimizer-outbox-dispatcher.ts";
import {
  FINOPS_COMPUTE_OPTIMIZER_DISCOVERY_JOB_KIND,
  enqueueComputeOptimizerDiscovery,
  parseComputeOptimizerDiscoveryJobPayload,
} from "../lib/finops-compute-optimizer-discovery-job.ts";
import { runComputeOptimizerDiscoveryHandler } from
  "../lib/finops-compute-optimizer-discovery-handler.ts";
import { ComputeOptimizerExportPlanEnvelope } from
  "../lib/finops-compute-optimizer-export-plan-envelope.ts";
import { readComputeOptimizerMaterializationActivationManifest } from
  "../lib/finops-compute-optimizer-materialization-activation-reader.ts";
import { FinopsEvidenceReferenceSealer } from
  "../lib/finops-source-evidence-reference.ts";
import {
  runComputeOptimizerExportExactDescribe,
  runComputeOptimizerExportLaunch,
  runComputeOptimizerMaterializationActivationManifest,
  runFinopsSourceCollection,
} from "../lib/pilot-server.ts";
import type {
  ComputeOptimizerActivationReadyPersistenceInput,
  ComputeOptimizerActivationBlockedOutcome,
  ComputeOptimizerDiscoveryRefreshRequiredOutcome,
} from "../lib/finops-compute-optimizer-activation-producer.ts";

const MAX_CAPABILITIES_PER_TICK = 500;
const MAX_RECOVERY_PER_TICK = 500;
const MAX_OUTBOX_PER_TICK = 500;
const MAX_DISCOVERY_CYCLES = 25;

function assertBoundaryActive(boundary: ComputeOptimizerActivationBoundary): void {
  if (boundary.signal.aborted) throw new Error("compute-optimizer-boundary-aborted");
  if (Date.now() >= boundary.deadlineAtMs) {
    throw new Error("compute-optimizer-boundary-deadline-exceeded");
  }
}

function enabledCapability(value: StoredComputeOptimizerCapability): ComputeOptimizerEnabledCapability {
  if (!value.enabled) throw new Error("compute-optimizer-capability-not-enabled");
  return {
    capabilityId: value.capabilityId,
    scope: value.scope,
    accountId: value.accountId,
    partition: value.partition,
    regions: value.regions,
    manifestSha256: value.manifestSha256,
    enabled: true,
  };
}

function storedActivation(value: StoredComputeOptimizerActivation): ComputeOptimizerStoredActivation {
  return value;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0")).join("");
}

async function signedManifest(
  capability: ComputeOptimizerEnabledCapability,
  requestId: string,
  boundary: ComputeOptimizerActivationBoundary,
) {
  return readComputeOptimizerMaterializationActivationManifest({
    request: {
      schema: "sutra.compute-optimizer-materialization-activation-manifest-request.v1",
      requestId,
      tenantId: capability.scope.organizationId,
      connectionId: capability.scope.connectionId,
      accountId: capability.accountId,
      partition: capability.partition,
      requiredPermissionPackVersion: "standard-2026-08.5",
    },
    enabledRegions: capability.regions,
  }, {
    readActivationManifest: (request, context) =>
      runComputeOptimizerMaterializationActivationManifest(request, {
        signal: context.signal,
        deadlineAtMs: boundary.deadlineAtMs,
      }),
  }, {
    signal: boundary.signal,
    deadlineAtMs: boundary.deadlineAtMs,
  });
}

function productionBoundary(maximumDurationMs = 330_000): ComputeOptimizerActivationBoundary {
  return createComputeOptimizerActivationBoundary({ maximumDurationMs });
}

async function discoveryJobId(
  activation: ComputeOptimizerStoredActivation,
  region: string,
): Promise<string> {
  return `coadj_${await sha256(canonicalJson({
    schemaVersion: "sutra.compute-optimizer-discovery-cycle.v1",
    scope: activation.scope,
    activationId: activation.activationId,
    region,
    cycle: activation.attempt,
  }))}`;
}

async function ensureDiscoveries(
  activation: ComputeOptimizerStoredActivation,
  boundary: ComputeOptimizerActivationBoundary,
): Promise<readonly { readonly region: string; readonly runId: string; readonly status: string;
  readonly finalizedAtIso: string | null }[]> {
  const activationRepository = new ComputeOptimizerActivationRepository();
  const capabilityValue = await activationRepository.getCurrentCapability(activation.scope);
  if (capabilityValue === null || !capabilityValue.enabled
    || capabilityValue.capabilityId !== activation.capabilityId
    || capabilityValue.accountId !== activation.accountId
    || capabilityValue.partition !== activation.partition) {
    throw new Error("compute-optimizer-capability-unavailable");
  }
  const capability = enabledCapability(capabilityValue);
  const repository = new ComputeOptimizerDiscoveryRepository();
  const queue = new JobQueueRepository();
  const results = [];
  for (const region of capability.regions) {
    if (boundary.signal.aborted || Date.now() >= boundary.deadlineAtMs) {
      throw new Error("compute-optimizer-discovery-boundary-closed");
    }
    const run = await repository.createRun(activation.scope, {
      jobId: await discoveryJobId(activation, region),
      accountId: activation.accountId,
      partition: activation.partition,
      region,
    });
    if (run.status === "pending") {
      await enqueueComputeOptimizerDiscovery(queue, activation.scope, run);
    }
    results.push({
      region,
      runId: run.runId,
      status: run.status,
      finalizedAtIso: run.finalizedAtIso,
    });
  }
  return results;
}

async function allDiscoveriesFinalized(
  activation: ComputeOptimizerStoredActivation,
  boundary: ComputeOptimizerActivationBoundary,
): Promise<boolean> {
  const runs = await ensureDiscoveries(activation, boundary);
  return runs.length > 0 && runs.every((run) => run.status === "partial"
    && run.finalizedAtIso !== null
    && Date.parse(run.finalizedAtIso) >= Date.parse(activation.sealedAtIso));
}

async function recordAudit(input: {
  readonly action: string;
  readonly targetId: string;
  readonly scope: ComputeOptimizerActivationJobScope;
  readonly requestId: string;
  readonly metadata: Readonly<Record<string, JsonValue | readonly string[]>>;
  readonly allowed: boolean;
}): Promise<void> {
  await appendAuditEvent({
    orgId: input.scope.organizationId,
    actorType: "system",
    actorId: "system_finops_compute_optimizer_activation",
    action: input.action,
    targetType: "finops_compute_optimizer_activation",
    targetId: input.targetId,
    customerId: input.scope.customerId,
    outcome: input.allowed ? "allowed" : "failed",
    requestId: input.requestId,
    metadata: input.metadata,
  });
}

export async function persistComputeOptimizerReadyPlansReadBeforeSeal(
  input: ComputeOptimizerActivationReadyPersistenceInput,
  boundary: ComputeOptimizerActivationBoundary,
  injected?: {
    readonly planRepository: Pick<ComputeOptimizerExportPlanRepository, "getPlan" | "recordPlan">;
    readonly planSetRepository: Pick<ComputeOptimizerExportPlanSetRepository, "recordPlanSet">;
    readonly activationRepository: Pick<ComputeOptimizerActivationRepository, "stageReadyAndOutbox">;
    readonly envelope: Pick<ComputeOptimizerExportPlanEnvelope, "seal" | "open">;
  },
): Promise<void> {
  const planRepository = injected?.planRepository
    ?? new ComputeOptimizerExportPlanRepository();
  const planSetRepository = injected?.planSetRepository
    ?? new ComputeOptimizerExportPlanSetRepository();
  const activationRepository = injected?.activationRepository
    ?? new ComputeOptimizerActivationRepository();
  const envelope = injected?.envelope
    ?? await ComputeOptimizerExportPlanEnvelope.fromEnvironment(
      env as unknown as Readonly<Record<string, string | undefined>>,
    );
  await persistComputeOptimizerReadyPlansReadBeforeSealCore(input, boundary, {
    planRepository, planSetRepository, activationRepository, envelope,
  });
}

async function reconcileProducer(
  job: RunnableJob,
  stored: ComputeOptimizerStoredActivation,
  boundary: ComputeOptimizerActivationBoundary,
): Promise<unknown> {
  const repository = new ComputeOptimizerActivationRepository();
  const discovery = new ComputeOptimizerDiscoveryRepository();
  const producer = createComputeOptimizerActivationProducer({
    manifestTransport: {
      readActivationManifest: (request, context) =>
        runComputeOptimizerMaterializationActivationManifest(request, {
          signal: context.signal,
          deadlineAtMs: boundary.deadlineAtMs,
        }),
    },
    launchTransport: {
      launchExact: (attempt, context) => runComputeOptimizerExportLaunch(attempt, {
        signal: context.signal,
        deadlineAtMs: context.deadlineAtMs,
      }),
    },
    describeTransport: {
      describeExact: (request, context) =>
        runComputeOptimizerExportExactDescribe(request, context),
    },
    loadMatchingFinalizedDiscoveryEvidenceReference: (input, context) =>
      discovery.getLatestFinalizedExportEvidenceMatchingLaunch(stored.scope, {
        accountId: input.requesterAccountId,
        partition: input.partition,
        region: input.region,
        finalizedAtOrAfterIso: stored.sealedAtIso,
        finalizedAtOrBeforeIso: new Date(Math.min(
          Date.parse(stored.scheduledWindow) + 24 * 60 * 60 * 1_000,
          Date.now(),
        )).toISOString(),
        expectedJobSet: input.expectedJobSet,
      }, { signal: context.signal, deadlineAtMs: context.deadlineAtMs }),
    persistReadyAndStageEnqueue: (input, context) => persistComputeOptimizerReadyPlansReadBeforeSeal(input, {
      signal: context.signal,
      deadlineAtMs: context.deadlineAtMs,
    }),
    recordBlockedOutcome: async (outcome: ComputeOptimizerActivationBlockedOutcome) => {
      await repository.transitionActivation(stored.scope, {
        activationId: stored.activationId,
        expectedState: "RECONCILING",
        nextState: "FAILED",
        expectedAttempt: stored.attempt,
        nextAttempt: stored.attempt,
        failureCode: "PLAN_SET_BLOCKED",
      });
      await recordAudit({
        action: "finops.compute_optimizer.activation.blocked",
        targetId: stored.activationId,
        scope: stored.scope,
        requestId: `finops.co.blocked:${job.id}:${job.attempt}`,
        allowed: false,
        metadata: {
          checkpointId: outcome.checkpointId,
          regionCount: outcome.regions.length,
          blockedRegionCount: outcome.regions.filter(({ state }) => state !== "PLAN_READY").length,
          attempt: stored.attempt,
        },
      });
    },
    recordDiscoveryRefreshRequired: async (
      outcome: ComputeOptimizerDiscoveryRefreshRequiredOutcome,
    ) => {
      if (stored.attempt >= MAX_DISCOVERY_CYCLES) {
        await repository.transitionActivation(stored.scope, {
          activationId: stored.activationId,
          expectedState: "RECONCILING",
          nextState: "FAILED",
          expectedAttempt: stored.attempt,
          nextAttempt: stored.attempt,
          failureCode: "DISCOVERY_REFRESH_EXHAUSTED",
        });
        return;
      }
      const pending = await repository.transitionActivation(stored.scope, {
        activationId: stored.activationId,
        expectedState: "RECONCILING",
        nextState: "DISCOVERY_PENDING",
        expectedAttempt: stored.attempt,
        nextAttempt: stored.attempt + 1,
        failureCode: null,
      });
      await ensureDiscoveries(storedActivation(pending), boundary);
      await recordAudit({
        action: "finops.compute_optimizer.discovery.refresh_required",
        targetId: stored.activationId,
        scope: stored.scope,
        requestId: `finops.co.refresh:${job.id}:${job.attempt}:${stored.attempt}`,
        allowed: false,
        metadata: {
          regionCount: outcome.regions.length,
          expectedJobSetProofCount: outcome.regions.length,
          nextDiscoveryCycle: stored.attempt + 1,
        },
      });
    },
    now: Date.now,
  });
  const capability = await repository.getCurrentCapability(stored.scope);
  if (capability === null || !capability.enabled
    || capability.capabilityId !== stored.capabilityId
    || capability.accountId !== stored.accountId
    || capability.partition !== stored.partition) {
    throw new Error("compute-optimizer-capability-unavailable");
  }
  return producer({
    scope: {
      orgId: stored.scope.organizationId,
      customerId: stored.scope.customerId,
      connectionId: stored.scope.connectionId,
    },
    requesterAccountId: stored.accountId,
    partition: stored.partition,
    scheduledWindow: stored.scheduledWindow,
    sealedAtIso: stored.sealedAtIso,
    // The immutable provider launch was sealed once. `stored.attempt` is the
    // discovery cycle and must never change the ledger attempt identity.
    attemptNumber: 1,
    enabledRegions: capability.regions,
    requestId: `coar_${job.id}_${job.attempt}`,
    jobId: job.id,
    deadlineAtMs: boundary.deadlineAtMs,
    signal: boundary.signal,
  });
}

/** Daily scheduler called by the internal jobs route. */
export async function scheduleComputeOptimizerDailyTick(
  boundary = productionBoundary(),
) {
  const repository = new ComputeOptimizerActivationRepository();
  return scheduleDailyComputeOptimizerActivations({
    listEnabledCapabilities: async () =>
      (await repository.listEnabledCapabilities(null, MAX_CAPABILITIES_PER_TICK))
        .map(enabledCapability),
    readSignedManifest: signedManifest,
    createDailyActivation: async (scope, input, nowMs) =>
      storedActivation(await repository.createDailyActivation(scope, input, nowMs)),
    queue: new JobQueueRepository(),
    now: Date.now,
  }, boundary);
}

/** Initial launch job production handler. */
export async function runComputeOptimizerActivationLaunchProductionHandler(
  job: RunnableJob,
  boundary = productionBoundary(),
): Promise<void> {
  const repository = new ComputeOptimizerActivationRepository();
  await runComputeOptimizerActivationLaunchJob(job, {
    getActivation: async (scope, activationId) => {
      const value = await repository.getActivation(scope, activationId);
      return value === null ? null : storedActivation(value);
    },
    getCurrentCapability: async (scope) => {
      const value = await repository.getCurrentCapability(scope);
      return value === null || !value.enabled ? null : enabledCapability(value);
    },
    readSignedManifest: signedManifest,
    launchExact: (attempt, _launchContractId, context) =>
      runComputeOptimizerExportLaunch(attempt, context),
    recordRegionalLaunchCheckpoint: (scope, input) =>
      repository.recordRegionalLaunchCheckpoint(scope, input),
    ensureRegionalDiscovery: (input, context) =>
      ensureDiscoveries(input.activation, context),
    finalizeLaunchCheckpoints: async (scope, input) =>
      storedActivation(await repository.finalizeLaunchCheckpoints(scope, input)),
    now: Date.now,
  }, boundary);
}

/** Recovery sweep called before draining due jobs. */
export async function recoverComputeOptimizerActivationTick(
  boundary = productionBoundary(),
) {
  const repository = new ComputeOptimizerActivationRepository();
  return recoverComputeOptimizerActivations({
    listRecoverableActivations: async () =>
      (await repository.listRecoverableActivations(null, MAX_RECOVERY_PER_TICK))
        .map(storedActivation),
    ensureRegionalDiscoveries: ensureDiscoveries,
    allRegionalDiscoveriesFinalized: allDiscoveriesFinalized,
    queue: new JobQueueRepository(),
    now: Date.now,
  }, boundary);
}

/** Reconcile/replay job production handler. */
export async function runComputeOptimizerActivationReconcileProductionHandler(
  job: RunnableJob,
  boundary = productionBoundary(),
): Promise<void> {
  const repository = new ComputeOptimizerActivationRepository();
  await runComputeOptimizerActivationReconcileJob(job, {
    getActivation: async (scope, activationId) => {
      const value = await repository.getActivation(scope, activationId);
      return value === null ? null : storedActivation(value);
    },
    allRegionalDiscoveriesFinalized: allDiscoveriesFinalized,
    beginReconcile: async (activation) => storedActivation(
      await repository.transitionActivation(activation.scope, {
        activationId: activation.activationId,
        expectedState: "DISCOVERY_PENDING",
        nextState: "RECONCILING",
        expectedAttempt: activation.attempt,
        nextAttempt: activation.attempt,
        failureCode: null,
      }),
    ),
    reconcile: async (activation, context) => {
      const capability = await repository.getCurrentCapability(activation.scope);
      if (capability === null || !capability.enabled
        || capability.capabilityId !== activation.capabilityId) {
        throw new Error("compute-optimizer-capability-unavailable");
      }
      await reconcileProducer(job, activation, context);
    },
    now: Date.now,
  }, boundary);
}

/** Regional discovery production handler with crash-safe evidence sealing. */
export async function runComputeOptimizerDiscoveryProductionHandler(
  job: RunnableJob,
  boundary = createComputeOptimizerActivationBoundary({ maximumDurationMs: 120_000 }),
): Promise<void> {
  if (job.kind !== FINOPS_COMPUTE_OPTIMIZER_DISCOVERY_JOB_KIND
    || job.customerId === null || job.connectionId === null) {
    throw new Error("compute-optimizer-discovery-scope-invalid");
  }
  const payload = parseComputeOptimizerDiscoveryJobPayload(job.payload);
  if (payload.connectionId !== job.connectionId) {
    throw new Error("compute-optimizer-discovery-scope-invalid");
  }
  assertBoundaryActive(boundary);
  const scope = {
    organizationId: job.orgId,
    customerId: job.customerId,
    connectionId: job.connectionId,
  };
  const discovery = new ComputeOptimizerDiscoveryRepository();
  const activation = new ComputeOptimizerActivationRepository();
  const run = await discovery.getRun(scope, payload.runId);
  assertBoundaryActive(boundary);
  if (run === null) throw new Error("compute-optimizer-discovery-run-not-found");
  const capabilityValue = await activation.getCurrentCapability(scope);
  assertBoundaryActive(boundary);
  if (capabilityValue === null || !capabilityValue.enabled) {
    throw new Error("compute-optimizer-capability-unavailable");
  }
  const capability = enabledCapability(capabilityValue);
  const requestId = `coadm_${await sha256(canonicalJson({
    scope, runId: run.runId, capabilityId: capability.capabilityId,
  }))}`;
  const manifest = await signedManifest(capability, requestId, boundary);
  assertBoundaryActive(boundary);
  const row = manifest.regions.find(({ region }) => region === run.region);
  if (row === undefined) throw new Error("compute-optimizer-discovery-region-unavailable");
  const evidenceRepository = new EvidenceRepository();
  const sealer = await FinopsEvidenceReferenceSealer.fromEnvironment(
    env as unknown as Readonly<Record<string, string | undefined>>,
  );
  await runComputeOptimizerDiscoveryHandler(job, {
    repository: discovery,
    loadTrustedBoundary: async () => ({
      organizationId: scope.organizationId,
      customerId: scope.customerId,
      connectionId: scope.connectionId,
      accountId: capability.accountId,
      partition: capability.partition,
      permissionPackVersion: "standard-2026-08.5",
      explicitRegions: capability.regions,
      sourceContractId: row.describeContractId,
    }),
    collect: (input, context) => runFinopsSourceCollection(input, context),
    sealFinalizedEvidence: async (input) => {
      const body = new TextEncoder().encode(canonicalJson(input.evidence));
      const archived = await evidenceRepository.archive({
        scope: {
          orgId: input.scope.organizationId,
          customerId: input.scope.customerId,
          connectionId: input.scope.connectionId,
        },
        runId: input.runId,
        artifactKind: "finops_source_snapshot",
        contentType: "application/json",
        body,
        createdBy: "system_compute_optimizer_discovery",
      });
      if (archived.contentSha256 !== input.evidenceContentSha256) {
        throw new Error("compute-optimizer-evidence-archive-hash-mismatch");
      }
      const generationId = `fss_${await sha256(canonicalJson({
        scope: input.scope,
        runId: input.runId,
        evidenceContentSha256: input.evidenceContentSha256,
      }))}`;
      const sealed = await activation.getOrCreateSealedEvidenceReference(
        input.scope,
        {
          runId: input.runId,
          evidenceContentSha256: input.evidenceContentSha256,
          objectId: archived.id,
        },
        (binding) => sealer.seal(binding.objectId, {
          organizationId: binding.scope.organizationId,
          customerId: binding.scope.customerId,
          connectionId: binding.scope.connectionId,
          sourceId: "compute_optimizer_organization_export",
          generationId,
        }),
      );
      return sealed.reference;
    },
    computeContentSha256: computeOptimizerDiscoverySha256,
    now: Date.now,
  }, { signal: boundary.signal, deadlineAtMs: boundary.deadlineAtMs });
}

/** Materializer outbox dispatcher called by the internal jobs route. */
export async function dispatchComputeOptimizerOutboxTick(
  boundary = productionBoundary(),
) {
  const repository = new ComputeOptimizerActivationRepository();
  const queue = new JobQueueRepository();
  const mapWork = (value: Awaited<ReturnType<typeof repository.listOutboxWork>>[number]):
  ComputeOptimizerOutboxWork => ({
    outboxId: value.outboxId,
    scope: value.scope,
    payload: value.payload,
    state: value.state as ComputeOptimizerOutboxWork["state"],
    deliveryAttempt: value.deliveryAttempt,
    leaseExpiresAtIso: value.leaseExpiresAtIso,
  });
  return dispatchComputeOptimizerMaterializerOutbox({
    listWork: async (nowMs) =>
      (await repository.listOutboxWork(null, nowMs, MAX_OUTBOX_PER_TICK)).map(mapWork),
    markExpiredLeaseRecoverable: async (scope, input) =>
      mapWork(await repository.markExpiredLeaseRecoverable(scope, input)),
    requeueRecoverable: async (scope, input) =>
      mapWork(await repository.requeueRecoverable(scope, input)),
    lease: async (scope, input) => mapWork(await repository.leaseOutbox(scope, input)),
    enqueue: (input, nowMs) => queue.enqueue(input, nowMs),
    markDispatched: (scope, input) => repository.markOutboxDispatched(scope, input),
    now: Date.now,
  }, boundary);
}
