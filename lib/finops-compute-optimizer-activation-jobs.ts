/**
 * Identities-only, two-phase durable job orchestration for Compute Optimizer.
 *
 * This module owns ordering and replay rules, not provider or database I/O:
 * daily scheduler -> ledger-backed launch -> regional discovery -> reconcile.
 * Every side-effecting boundary is injected and receives one hard deadline.
 */
import type { RunnableJob } from "./background-job-runner.ts";
import { canonicalJson } from "./canonical-json.ts";
import {
  createComputeOptimizerMaterializationActivation,
  type ComputeOptimizerMaterializationActivation,
} from "./finops-compute-optimizer-export-coordinator.ts";
import {
  createComputeOptimizerExportLaunchAttempt,
  verifyComputeOptimizerExportLaunchExecution,
  type ComputeOptimizerExportLaunchAttempt,
  type ComputeOptimizerExportLaunchExecution,
} from "./finops-compute-optimizer-export-launch.ts";
import type {
  ComputeOptimizerMaterializationActivationManifest,
} from "../services/aws-collector/src/compute-optimizer-materialization-activation-manifest.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACTIVATION_ID = /^comra_[a-f0-9]{64}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DAY_MS = 86_400_000;
const MAX_REGIONS = 50;
const MAX_CAPABILITIES = 1_000;
const MAXIMUM_HANDLER_DURATION_MS = 330_000;

export const FINOPS_COMPUTE_OPTIMIZER_ACTIVATION_LAUNCH_JOB_KIND =
  "finops-compute-optimizer-activation-launch";
export const FINOPS_COMPUTE_OPTIMIZER_ACTIVATION_RECONCILE_JOB_KIND =
  "finops-compute-optimizer-activation-reconcile";

export interface ComputeOptimizerActivationJobPayload {
  readonly customerId: string;
  readonly connectionId: string;
  readonly activationId: string;
}

export interface ComputeOptimizerActivationJobScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

type Partition = "aws" | "aws-us-gov" | "aws-cn";

export interface ComputeOptimizerEnabledCapability {
  readonly capabilityId: string;
  readonly scope: ComputeOptimizerActivationJobScope;
  readonly accountId: string;
  readonly partition: Partition;
  readonly regions: readonly string[];
  readonly manifestSha256: string;
  readonly enabled: true;
}

export interface ComputeOptimizerStoredActivation {
  readonly activationId: string;
  readonly scope: ComputeOptimizerActivationJobScope;
  readonly capabilityId: string;
  readonly accountId: string;
  readonly partition: Partition;
  readonly scheduledWindow: string;
  readonly sealedAtIso: string;
  /** Discovery/reconcile cycle. The sealed launch attempt remains in activation. */
  readonly attempt: number;
  readonly state:
    | "SEALED"
    | "RECONCILING"
    | "DISCOVERY_PENDING"
    | "MATERIALIZATION_PENDING"
    | "COMPLETE"
    | "FAILED";
  readonly activationContentSha256: string;
}

export interface ComputeOptimizerActivationBoundary {
  readonly signal: AbortSignal;
  readonly deadlineAtMs: number;
}

export interface ComputeOptimizerActivationQueue {
  enqueue(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly kind: string;
    readonly payload: ComputeOptimizerActivationJobPayload;
    readonly maxAttempts: number;
    readonly idempotencyKey: string;
  }, nowMs?: number): Promise<{ readonly id: string }>;
}

export interface ComputeOptimizerActivationSchedulerDependencies {
  readonly listEnabledCapabilities: (
    boundary: ComputeOptimizerActivationBoundary,
  ) => Promise<readonly ComputeOptimizerEnabledCapability[]>;
  readonly readSignedManifest: (
    capability: ComputeOptimizerEnabledCapability,
    requestId: string,
    boundary: ComputeOptimizerActivationBoundary,
  ) => Promise<ComputeOptimizerMaterializationActivationManifest>;
  readonly createDailyActivation: (
    scope: ComputeOptimizerActivationJobScope,
    input: {
      readonly capabilityId: string;
      readonly activation: ComputeOptimizerMaterializationActivation;
      readonly sealedAtMs: number;
      readonly attempt: number;
    },
    nowMs: number,
    boundary: ComputeOptimizerActivationBoundary,
  ) => Promise<ComputeOptimizerStoredActivation>;
  readonly queue: ComputeOptimizerActivationQueue;
  readonly now?: () => number;
}

export interface ComputeOptimizerActivationLaunchDependencies {
  readonly getActivation: (
    scope: ComputeOptimizerActivationJobScope,
    activationId: string,
    boundary: ComputeOptimizerActivationBoundary,
  ) => Promise<ComputeOptimizerStoredActivation | null>;
  readonly getCurrentCapability: (
    scope: ComputeOptimizerActivationJobScope,
    boundary: ComputeOptimizerActivationBoundary,
  ) => Promise<ComputeOptimizerEnabledCapability | null>;
  readonly readSignedManifest: ComputeOptimizerActivationSchedulerDependencies["readSignedManifest"];
  /** Must be the authenticated collector ledger boundary. */
  readonly launchExact: (
    attempt: ComputeOptimizerExportLaunchAttempt,
    launchContractId: string,
    boundary: ComputeOptimizerActivationBoundary,
  ) => Promise<unknown>;
  readonly recordRegionalLaunchCheckpoint: (
    scope: ComputeOptimizerActivationJobScope,
    input: {
      readonly activation: ComputeOptimizerMaterializationActivation;
      readonly region: string;
      readonly execution: ComputeOptimizerExportLaunchExecution;
    },
    boundary: ComputeOptimizerActivationBoundary,
  ) => Promise<unknown>;
  readonly ensureRegionalDiscovery: (
    input: {
      readonly scope: ComputeOptimizerActivationJobScope;
      readonly activation: ComputeOptimizerStoredActivation;
      readonly region: string;
      readonly cycle: number;
    },
    boundary: ComputeOptimizerActivationBoundary,
  ) => Promise<unknown>;
  readonly finalizeLaunchCheckpoints: (
    scope: ComputeOptimizerActivationJobScope,
    input: { readonly activationId: string; readonly expectedAttempt: number },
    boundary: ComputeOptimizerActivationBoundary,
  ) => Promise<ComputeOptimizerStoredActivation>;
  readonly now?: () => number;
}

export interface ComputeOptimizerActivationRecoveryDependencies {
  readonly listRecoverableActivations: (
    boundary: ComputeOptimizerActivationBoundary,
  ) => Promise<readonly ComputeOptimizerStoredActivation[]>;
  readonly allRegionalDiscoveriesFinalized: (
    activation: ComputeOptimizerStoredActivation,
    boundary: ComputeOptimizerActivationBoundary,
  ) => Promise<boolean>;
  readonly ensureRegionalDiscoveries: (
    activation: ComputeOptimizerStoredActivation,
    boundary: ComputeOptimizerActivationBoundary,
  ) => Promise<unknown>;
  readonly queue: ComputeOptimizerActivationQueue;
  readonly now?: () => number;
}

export interface ComputeOptimizerActivationReconcileDependencies {
  readonly getActivation: (
    scope: ComputeOptimizerActivationJobScope,
    activationId: string,
    boundary: ComputeOptimizerActivationBoundary,
  ) => Promise<ComputeOptimizerStoredActivation | null>;
  readonly beginReconcile: (
    activation: ComputeOptimizerStoredActivation,
    boundary: ComputeOptimizerActivationBoundary,
  ) => Promise<ComputeOptimizerStoredActivation>;
  readonly allRegionalDiscoveriesFinalized: (
    activation: ComputeOptimizerStoredActivation,
    boundary: ComputeOptimizerActivationBoundary,
  ) => Promise<boolean>;
  /** Invokes only the replay/reconcile producer, never an initial launch path. */
  readonly reconcile: (
    activation: ComputeOptimizerStoredActivation,
    boundary: ComputeOptimizerActivationBoundary,
  ) => Promise<unknown>;
  readonly now?: () => number;
}

export class ComputeOptimizerActivationJobError extends Error {
  // Declared and assigned rather than a constructor parameter property: Node's default strip-only TypeScript mode
  // cannot transform parameter properties, so any test importing this module without the transform loader fails to
  // load it.
  public readonly code:
    | "INVALID_CONFIGURATION"
    | "INVALID_JOB"
    | "INVALID_SCOPE"
    | "CAPABILITY_UNAVAILABLE"
    | "ACTIVATION_UNAVAILABLE"
    | "PHASE_VIOLATION"
    | "LAUNCH_REJECTED"
    | "PERSISTENCE_REJECTED"
    | "ABORTED"
    | "DEADLINE_EXCEEDED";
  public constructor(code: ComputeOptimizerActivationJobError["code"]) {
    super("Compute Optimizer activation job rejected");
    this.name = "ComputeOptimizerActivationJobError";
    this.code = code;
  }
}

function reject(code: ComputeOptimizerActivationJobError["code"]): never {
  throw new ComputeOptimizerActivationJobError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function nowMs(clock: (() => number) | undefined): number {
  const value = clock?.() ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0) reject("INVALID_CONFIGURATION");
  return value;
}

function assertActive(
  boundary: ComputeOptimizerActivationBoundary,
  clock: (() => number) | undefined,
): void {
  if (!(boundary.signal instanceof AbortSignal)
    || !Number.isSafeInteger(boundary.deadlineAtMs)) reject("INVALID_CONFIGURATION");
  if (boundary.signal.aborted) reject("ABORTED");
  if (nowMs(clock) >= boundary.deadlineAtMs) reject("DEADLINE_EXCEEDED");
}

async function active<T>(
  operation: () => Promise<T>,
  boundary: ComputeOptimizerActivationBoundary,
  clock: (() => number) | undefined,
): Promise<T> {
  assertActive(boundary, clock);
  const remainingMs = boundary.deadlineAtMs - nowMs(clock);
  return new Promise<T>((resolve, rejectPromise) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      boundary.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => rejectPromise(
      new ComputeOptimizerActivationJobError(
        nowMs(clock) >= boundary.deadlineAtMs ? "DEADLINE_EXCEEDED" : "ABORTED",
      ),
    ));
    const timer = setTimeout(() => finish(() => rejectPromise(
      new ComputeOptimizerActivationJobError("DEADLINE_EXCEEDED"),
    )), remainingMs);
    boundary.signal.addEventListener("abort", onAbort, { once: true });
    if (boundary.signal.aborted) return onAbort();
    Promise.resolve().then(operation).then(
      (value) => {
        try {
          assertActive(boundary, clock);
          finish(() => resolve(value));
        } catch (error) { finish(() => rejectPromise(error)); }
      },
      (error: unknown) => finish(() => rejectPromise(error)),
    );
  });
}

function validRegionForPartition(region: string, partition: Partition): boolean {
  if (!REGION.test(region)) return false;
  if (partition === "aws-cn") return region.startsWith("cn-");
  if (partition === "aws-us-gov") return region.startsWith("us-gov-");
  return !region.startsWith("cn-") && !region.startsWith("us-gov-");
}

function validateScope(value: unknown): ComputeOptimizerActivationJobScope {
  if (!isRecord(value) || !exactKeys(value, [
    "organizationId", "customerId", "connectionId",
  ]) || typeof value.organizationId !== "string" || !IDENTIFIER.test(value.organizationId)
    || typeof value.customerId !== "string" || !IDENTIFIER.test(value.customerId)
    || typeof value.connectionId !== "string" || !CONNECTION_ID.test(value.connectionId)) {
    reject("INVALID_SCOPE");
  }
  return value as unknown as ComputeOptimizerActivationJobScope;
}

function validateCapability(value: unknown): ComputeOptimizerEnabledCapability {
  if (!isRecord(value) || !exactKeys(value, [
    "capabilityId", "scope", "accountId", "partition", "regions",
    "manifestSha256", "enabled",
  ]) || typeof value.capabilityId !== "string" || !IDENTIFIER.test(value.capabilityId)
    || typeof value.accountId !== "string" || !ACCOUNT_ID.test(value.accountId)
    || (value.partition !== "aws" && value.partition !== "aws-us-gov"
      && value.partition !== "aws-cn")
    || !Array.isArray(value.regions) || value.regions.length < 1
    || value.regions.length > MAX_REGIONS || typeof value.manifestSha256 !== "string"
    || !SHA256.test(value.manifestSha256) || value.enabled !== true) {
    reject("CAPABILITY_UNAVAILABLE");
  }
  const scope = validateScope(value.scope);
  const regions = [...value.regions].sort() as string[];
  if (new Set(regions).size !== regions.length
    || regions.some((region) => typeof region !== "string"
      || !validRegionForPartition(region, value.partition as Partition))) {
    reject("CAPABILITY_UNAVAILABLE");
  }
  return Object.freeze({
    capabilityId: value.capabilityId,
    scope: Object.freeze({ ...scope }),
    accountId: value.accountId,
    partition: value.partition as Partition,
    regions: Object.freeze(regions),
    manifestSha256: value.manifestSha256,
    enabled: true,
  });
}

export function parseComputeOptimizerActivationJobPayload(
  value: unknown,
): ComputeOptimizerActivationJobPayload {
  if (!isRecord(value) || !exactKeys(value, [
    "customerId", "connectionId", "activationId",
  ]) || typeof value.customerId !== "string" || !IDENTIFIER.test(value.customerId)
    || typeof value.connectionId !== "string" || !CONNECTION_ID.test(value.connectionId)
    || typeof value.activationId !== "string" || !ACTIVATION_ID.test(value.activationId)) {
    reject("INVALID_JOB");
  }
  return Object.freeze({
    customerId: value.customerId,
    connectionId: value.connectionId,
    activationId: value.activationId,
  });
}

function jobScope(job: RunnableJob, expectedKind: string): {
  readonly scope: ComputeOptimizerActivationJobScope;
  readonly payload: ComputeOptimizerActivationJobPayload;
} {
  const payload = parseComputeOptimizerActivationJobPayload(job.payload);
  if (job.kind !== expectedKind || job.customerId === null || job.connectionId === null
    || job.customerId !== payload.customerId || job.connectionId !== payload.connectionId
    || !IDENTIFIER.test(job.orgId) || !IDENTIFIER.test(job.id)
    || !Number.isSafeInteger(job.attempt) || job.attempt < 1
    || !Number.isSafeInteger(job.maxAttempts) || job.maxAttempts < job.attempt) {
    reject("INVALID_SCOPE");
  }
  return {
    scope: {
      organizationId: job.orgId,
      customerId: payload.customerId,
      connectionId: payload.connectionId,
    },
    payload,
  };
}

async function sha256Canonical(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0")).join("");
}

function optionalPrefix(basePrefix: string): string | null {
  return basePrefix === "" ? null : basePrefix.slice(0, -1);
}

function dailyWindow(now: number): { readonly iso: string; readonly milliseconds: number } {
  const date = new Date(now);
  const milliseconds = Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0,
  );
  return { iso: new Date(milliseconds).toISOString(), milliseconds };
}

async function attemptsFromManifest(
  capability: ComputeOptimizerEnabledCapability,
  manifest: ComputeOptimizerMaterializationActivationManifest,
  scheduledWindow: string,
  sealedAtIso: string,
  launchAttemptNumber: number,
): Promise<readonly ComputeOptimizerExportLaunchAttempt[]> {
  if (manifest.tenantId !== capability.scope.organizationId
    || manifest.connectionId !== capability.scope.connectionId
    || manifest.accountId !== capability.accountId
    || manifest.partition !== capability.partition
    || manifest.permissionPackVersion !== "standard-2026-08.5"
    || manifest.regions.length !== capability.regions.length) {
    reject("CAPABILITY_UNAVAILABLE");
  }
  const attempts: ComputeOptimizerExportLaunchAttempt[] = [];
  for (let index = 0; index < capability.regions.length; index += 1) {
    const expectedRegion = capability.regions[index]!;
    const row = manifest.regions[index];
    if (row === undefined || row.region !== expectedRegion) {
      reject("CAPABILITY_UNAVAILABLE");
    }
    const attempt = await createComputeOptimizerExportLaunchAttempt({
      scope: {
        orgId: capability.scope.organizationId,
        customerId: capability.scope.customerId,
        connectionId: capability.scope.connectionId,
      },
      requesterAccountId: capability.accountId,
      partition: capability.partition,
      region: row.region,
      scheduledWindow,
      sealedAtIso,
      attemptNumber: launchAttemptNumber,
      bucket: row.bucket,
      optionalPrefix: optionalPrefix(row.basePrefix),
    });
    if (attempt.targets.some(({ effectivePrefix }) => effectivePrefix !== row.effectivePrefix)) {
      reject("CAPABILITY_UNAVAILABLE");
    }
    attempts.push(attempt);
  }
  return Object.freeze(attempts);
}

async function enqueuePhase(
  queue: ComputeOptimizerActivationQueue,
  activation: ComputeOptimizerStoredActivation,
  kind: string,
  phase: "launch" | "reconcile",
  now: number,
): Promise<string> {
  const payload = parseComputeOptimizerActivationJobPayload({
    customerId: activation.scope.customerId,
    connectionId: activation.scope.connectionId,
    activationId: activation.activationId,
  });
  const queued = await queue.enqueue({
    orgId: activation.scope.organizationId,
    customerId: activation.scope.customerId,
    connectionId: activation.scope.connectionId,
    kind,
    payload,
    maxAttempts: 12,
    idempotencyKey: `finops-compute-optimizer:${phase}:${activation.activationId}:${activation.attempt}`,
  }, now);
  if (!isRecord(queued) || typeof queued.id !== "string" || !IDENTIFIER.test(queued.id)) {
    reject("PERSISTENCE_REJECTED");
  }
  return queued.id;
}

/** Create/replay exactly one UTC-daily activation per enabled capability. */
export async function scheduleDailyComputeOptimizerActivations(
  dependencies: ComputeOptimizerActivationSchedulerDependencies,
  boundary: ComputeOptimizerActivationBoundary,
): Promise<{ readonly examined: number; readonly enqueued: number; readonly activationIds: readonly string[] }> {
  assertActive(boundary, dependencies.now);
  const tickNow = nowMs(dependencies.now);
  const window = dailyWindow(tickNow);
  const capabilities = await active(
    () => dependencies.listEnabledCapabilities(boundary),
    boundary,
    dependencies.now,
  );
  if (!Array.isArray(capabilities) || capabilities.length > MAX_CAPABILITIES) {
    reject("INVALID_CONFIGURATION");
  }
  const activationIds: string[] = [];
  let enqueued = 0;
  for (const unsafeCapability of capabilities) {
    const capability = validateCapability(unsafeCapability);
    const requestId = `coams_${await sha256Canonical({
      schema: "sutra.compute-optimizer-daily-manifest-request.v1",
      scope: capability.scope,
      capabilityId: capability.capabilityId,
      scheduledWindow: window.iso,
    })}`;
    const manifest = await active(
      () => dependencies.readSignedManifest(capability, requestId, boundary),
      boundary,
      dependencies.now,
    );
    const attempts = await attemptsFromManifest(
      capability, manifest, window.iso, window.iso, 1,
    );
    const activation = await createComputeOptimizerMaterializationActivation(attempts);
    const stored = await active(() => dependencies.createDailyActivation(
      capability.scope,
      { capabilityId: capability.capabilityId, activation, sealedAtMs: window.milliseconds, attempt: 1 },
      tickNow,
      boundary,
    ), boundary, dependencies.now);
    if (stored.activationId !== activation.activationId
      || stored.activationContentSha256 !== activation.contentSha256
      || stored.attempt < 1) {
      reject("PERSISTENCE_REJECTED");
    }
    if (stored.state === "SEALED") {
      await active(() => enqueuePhase(
        dependencies.queue, stored,
        FINOPS_COMPUTE_OPTIMIZER_ACTIVATION_LAUNCH_JOB_KIND,
        "launch", tickNow,
      ), boundary, dependencies.now);
      enqueued += 1;
    }
    activationIds.push(stored.activationId);
  }
  return Object.freeze({
    examined: capabilities.length,
    enqueued,
    activationIds: Object.freeze(activationIds),
  });
}

/**
 * Initial provider phase. It never invokes the reconcile producer. Every
 * region is ledger-replayed and checkpointed before discovery is enqueued.
 */
export async function runComputeOptimizerActivationLaunchJob(
  job: RunnableJob,
  dependencies: ComputeOptimizerActivationLaunchDependencies,
  boundary: ComputeOptimizerActivationBoundary,
): Promise<void> {
  const { scope, payload } = jobScope(
    job, FINOPS_COMPUTE_OPTIMIZER_ACTIVATION_LAUNCH_JOB_KIND,
  );
  assertActive(boundary, dependencies.now);
  const stored = await active(
    () => dependencies.getActivation(scope, payload.activationId, boundary),
    boundary, dependencies.now,
  );
  if (stored === null) reject("ACTIVATION_UNAVAILABLE");
  if (stored.state !== "SEALED" && stored.state !== "DISCOVERY_PENDING") {
    if (stored.state === "RECONCILING" || stored.state === "MATERIALIZATION_PENDING"
      || stored.state === "COMPLETE") return;
    reject("PHASE_VIOLATION");
  }
  const capabilityValue = await active(
    () => dependencies.getCurrentCapability(scope, boundary), boundary, dependencies.now,
  );
  if (capabilityValue === null) reject("CAPABILITY_UNAVAILABLE");
  const capability = validateCapability(capabilityValue);
  if (capability.capabilityId !== stored.capabilityId
    || capability.accountId !== stored.accountId
    || capability.partition !== stored.partition) reject("CAPABILITY_UNAVAILABLE");
  const requestId = `coaml_${await sha256Canonical({
    activationId: stored.activationId,
    activationContentSha256: stored.activationContentSha256,
  })}`;
  const manifest = await active(
    () => dependencies.readSignedManifest(capability, requestId, boundary),
    boundary, dependencies.now,
  );
  const launchAttemptNumber = 1;
  const attempts = await attemptsFromManifest(
    capability, manifest, stored.scheduledWindow, stored.sealedAtIso, launchAttemptNumber,
  );
  const activation = await createComputeOptimizerMaterializationActivation(attempts);
  if (activation.activationId !== stored.activationId
    || activation.contentSha256 !== stored.activationContentSha256) {
    reject("ACTIVATION_UNAVAILABLE");
  }
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]!;
    const row = manifest.regions[index]!;
    let execution: ComputeOptimizerExportLaunchExecution;
    try {
      const raw = await active(
        () => dependencies.launchExact(attempt, row.launchContractId, boundary),
        boundary, dependencies.now,
      );
      execution = await verifyComputeOptimizerExportLaunchExecution(attempt, raw);
    } catch (error) {
      if (error instanceof ComputeOptimizerActivationJobError) throw error;
      return reject("LAUNCH_REJECTED");
    }
    if (execution.status !== "COMPLETE") reject("LAUNCH_REJECTED");
    if (stored.state === "SEALED") {
      await active(() => dependencies.recordRegionalLaunchCheckpoint(scope, {
        activation,
        region: attempt.region,
        execution,
      }, boundary), boundary, dependencies.now);
    }
    await active(() => dependencies.ensureRegionalDiscovery({
      scope,
      activation: stored,
      region: attempt.region,
      cycle: stored.attempt,
    }, boundary), boundary, dependencies.now);
  }
  if (stored.state === "SEALED") {
    const finalized = await active(() => dependencies.finalizeLaunchCheckpoints(scope, {
      activationId: stored.activationId,
      expectedAttempt: stored.attempt,
    }, boundary), boundary, dependencies.now);
    if (finalized.state !== "DISCOVERY_PENDING") reject("PERSISTENCE_REJECTED");
  }
}

/** Recovery never skips discovery: reconcile is queued only after every region finalized. */
export async function recoverComputeOptimizerActivations(
  dependencies: ComputeOptimizerActivationRecoveryDependencies,
  boundary: ComputeOptimizerActivationBoundary,
): Promise<{ readonly examined: number; readonly launchQueued: number; readonly reconcileQueued: number }> {
  const now = nowMs(dependencies.now);
  const activations = await active(
    () => dependencies.listRecoverableActivations(boundary), boundary, dependencies.now,
  );
  if (!Array.isArray(activations) || activations.length > MAX_CAPABILITIES) {
    reject("INVALID_CONFIGURATION");
  }
  let launchQueued = 0;
  let reconcileQueued = 0;
  for (const activation of activations) {
    validateScope(activation.scope);
    if (!ACTIVATION_ID.test(activation.activationId)
      || !Number.isSafeInteger(activation.attempt) || activation.attempt < 1) {
      reject("PERSISTENCE_REJECTED");
    }
    if (activation.state === "SEALED") {
      await active(() => enqueuePhase(
        dependencies.queue, activation,
        FINOPS_COMPUTE_OPTIMIZER_ACTIVATION_LAUNCH_JOB_KIND,
        "launch", now,
      ), boundary, dependencies.now);
      launchQueued += 1;
      continue;
    }
    if (activation.state !== "DISCOVERY_PENDING") continue;
    await active(
      () => dependencies.ensureRegionalDiscoveries(activation, boundary),
      boundary, dependencies.now,
    );
    const complete = await active(
      () => dependencies.allRegionalDiscoveriesFinalized(activation, boundary),
      boundary, dependencies.now,
    );
    if (!complete) continue;
    await active(() => enqueuePhase(
      dependencies.queue, activation,
      FINOPS_COMPUTE_OPTIMIZER_ACTIVATION_RECONCILE_JOB_KIND,
      "reconcile", now,
    ), boundary, dependencies.now);
    reconcileQueued += 1;
  }
  return Object.freeze({ examined: activations.length, launchQueued, reconcileQueued });
}

/** Enter the reconcile phase only from finalized discovery, then invoke C. */
export async function runComputeOptimizerActivationReconcileJob(
  job: RunnableJob,
  dependencies: ComputeOptimizerActivationReconcileDependencies,
  boundary: ComputeOptimizerActivationBoundary,
): Promise<void> {
  const { scope, payload } = jobScope(
    job, FINOPS_COMPUTE_OPTIMIZER_ACTIVATION_RECONCILE_JOB_KIND,
  );
  assertActive(boundary, dependencies.now);
  let activation = await active(
    () => dependencies.getActivation(scope, payload.activationId, boundary),
    boundary, dependencies.now,
  );
  if (activation === null) reject("ACTIVATION_UNAVAILABLE");
  if (activation.state === "MATERIALIZATION_PENDING" || activation.state === "COMPLETE") {
    return;
  }
  if (activation.state === "DISCOVERY_PENDING") {
    const complete = await active(
      () => dependencies.allRegionalDiscoveriesFinalized(activation!, boundary),
      boundary, dependencies.now,
    );
    if (!complete) reject("PHASE_VIOLATION");
    activation = await active(
      () => dependencies.beginReconcile(activation!, boundary),
      boundary, dependencies.now,
    );
  }
  if (activation.state !== "RECONCILING") reject("PHASE_VIOLATION");
  await active(() => dependencies.reconcile(activation!, boundary), boundary, dependencies.now);
}

/** Build a hard deadline accepted by every public orchestration entry point. */
export function createComputeOptimizerActivationBoundary(
  options: { readonly signal?: AbortSignal; readonly nowMs?: number; readonly maximumDurationMs?: number } = {},
): ComputeOptimizerActivationBoundary {
  const startedAt = options.nowMs ?? Date.now();
  const duration = options.maximumDurationMs ?? MAXIMUM_HANDLER_DURATION_MS;
  if (!Number.isSafeInteger(startedAt) || startedAt < 0
    || !Number.isSafeInteger(duration) || duration < 1
    || duration > MAXIMUM_HANDLER_DURATION_MS
    || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
    reject("INVALID_CONFIGURATION");
  }
  return Object.freeze({
    signal: options.signal === undefined
      ? AbortSignal.timeout(duration)
      : AbortSignal.any([options.signal, AbortSignal.timeout(duration)]),
    deadlineAtMs: startedAt + duration,
  });
}

export const COMPUTE_OPTIMIZER_ACTIVATION_JOB_BOUNDS = Object.freeze({
  maximumRegions: MAX_REGIONS,
  maximumCapabilitiesPerTick: MAX_CAPABILITIES,
  maximumHandlerDurationMs: MAXIMUM_HANDLER_DURATION_MS,
  dailyWindowMs: DAY_MS,
});
