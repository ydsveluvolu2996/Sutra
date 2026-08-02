/** Crash-safe dispatcher for the durable Compute Optimizer materializer outbox. */
import {
  FINOPS_COMPUTE_OPTIMIZER_MATERIALIZE_JOB_KIND,
  parseComputeOptimizerMaterializationJobPayload,
  type ComputeOptimizerMaterializationJobPayload,
} from "./finops-compute-optimizer-materialization-runtime.ts";
import type {
  ComputeOptimizerActivationBoundary,
  ComputeOptimizerActivationJobScope,
} from "./finops-compute-optimizer-activation-jobs.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const OUTBOX_ID = /^coob_[a-f0-9]{64}$/u;
const MAX_WORK = 1_000;
const LEASE_DURATION_MS = 5 * 60_000;

export interface ComputeOptimizerOutboxWork {
  readonly outboxId: string;
  readonly scope: ComputeOptimizerActivationJobScope;
  readonly payload: ComputeOptimizerMaterializationJobPayload;
  readonly state: "PENDING" | "LEASED" | "RECOVERABLE";
  readonly deliveryAttempt: number;
  readonly leaseExpiresAtIso: string | null;
}

export interface ComputeOptimizerOutboxDispatcherDependencies {
  readonly listWork: (
    nowMs: number,
    boundary: ComputeOptimizerActivationBoundary,
  ) => Promise<readonly ComputeOptimizerOutboxWork[]>;
  readonly markExpiredLeaseRecoverable: (
    scope: ComputeOptimizerActivationJobScope,
    input: { readonly outboxId: string; readonly nowMs: number },
    boundary: ComputeOptimizerActivationBoundary,
  ) => Promise<ComputeOptimizerOutboxWork>;
  readonly requeueRecoverable: (
    scope: ComputeOptimizerActivationJobScope,
    input: { readonly outboxId: string; readonly nowMs: number },
    boundary: ComputeOptimizerActivationBoundary,
  ) => Promise<ComputeOptimizerOutboxWork>;
  readonly lease: (
    scope: ComputeOptimizerActivationJobScope,
    input: {
      readonly outboxId: string;
      readonly leaseToken: string;
      readonly nowMs: number;
      readonly leaseDurationMs: number;
    },
    boundary: ComputeOptimizerActivationBoundary,
  ) => Promise<ComputeOptimizerOutboxWork>;
  readonly enqueue: (input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly kind: string;
    readonly payload: ComputeOptimizerMaterializationJobPayload;
    readonly maxAttempts: number;
    readonly idempotencyKey: string;
  }, nowMs?: number) => Promise<{ readonly id: string }>;
  readonly markDispatched: (
    scope: ComputeOptimizerActivationJobScope,
    input: { readonly outboxId: string; readonly leaseToken: string; readonly nowMs: number },
    boundary: ComputeOptimizerActivationBoundary,
  ) => Promise<unknown>;
  readonly now?: () => number;
  readonly createLeaseToken?: (outboxId: string, deliveryAttempt: number) => string;
}

export class ComputeOptimizerOutboxDispatcherError extends Error {
  public constructor(public readonly code:
    | "INVALID_CONFIGURATION"
    | "INVALID_WORK"
    | "ABORTED"
    | "DEADLINE_EXCEEDED"
    | "CAS_REJECTED"
    | "QUEUE_REJECTED") {
    super("Compute Optimizer materializer outbox dispatch rejected");
    this.name = "ComputeOptimizerOutboxDispatcherError";
  }
}

function reject(code: ComputeOptimizerOutboxDispatcherError["code"]): never {
  throw new ComputeOptimizerOutboxDispatcherError(code);
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
      new ComputeOptimizerOutboxDispatcherError(
        nowMs(clock) >= boundary.deadlineAtMs ? "DEADLINE_EXCEEDED" : "ABORTED",
      ),
    ));
    const timer = setTimeout(() => finish(() => rejectPromise(
      new ComputeOptimizerOutboxDispatcherError("DEADLINE_EXCEEDED"),
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

function validScope(scope: ComputeOptimizerActivationJobScope): boolean {
  return typeof scope === "object" && scope !== null
    && Object.keys(scope).sort().join("\0")
      === ["organizationId", "customerId", "connectionId"].sort().join("\0")
    && IDENTIFIER.test(scope.organizationId) && IDENTIFIER.test(scope.customerId)
    && CONNECTION_ID.test(scope.connectionId);
}

async function validatedWork(value: ComputeOptimizerOutboxWork): Promise<ComputeOptimizerOutboxWork> {
  if (typeof value !== "object" || value === null
    || Object.keys(value).sort().join("\0") !== [
      "outboxId", "scope", "payload", "state", "deliveryAttempt", "leaseExpiresAtIso",
    ].sort().join("\0") || !OUTBOX_ID.test(value.outboxId) || !validScope(value.scope)
    || !new Set(["PENDING", "LEASED", "RECOVERABLE"]).has(value.state)
    || !Number.isSafeInteger(value.deliveryAttempt) || value.deliveryAttempt < 0
    || value.deliveryAttempt > 25
    || (value.leaseExpiresAtIso !== null
      && (!Number.isFinite(Date.parse(value.leaseExpiresAtIso))
        || new Date(Date.parse(value.leaseExpiresAtIso)).toISOString()
          !== value.leaseExpiresAtIso))) reject("INVALID_WORK");
  let payload: ComputeOptimizerMaterializationJobPayload;
  try { payload = await parseComputeOptimizerMaterializationJobPayload(value.payload); }
  catch { return reject("INVALID_WORK"); }
  if (payload.scope.organizationId !== value.scope.organizationId
    || payload.scope.customerId !== value.scope.customerId
    || payload.scope.connectionId !== value.scope.connectionId) reject("INVALID_WORK");
  return Object.freeze({ ...value, scope: Object.freeze({ ...value.scope }), payload });
}

function defaultLeaseToken(): string {
  return `cood_${crypto.randomUUID()}`;
}

/**
 * At-least-once queue publication. A crash after enqueue but before dispatch
 * CAS is safe because the queue identity is always the immutable outbox id.
 */
export async function dispatchComputeOptimizerMaterializerOutbox(
  dependencies: ComputeOptimizerOutboxDispatcherDependencies,
  boundary: ComputeOptimizerActivationBoundary,
): Promise<{
  readonly examined: number;
  readonly recovered: number;
  readonly dispatched: number;
}> {
  const now = nowMs(dependencies.now);
  const raw = await active(() => dependencies.listWork(now, boundary), boundary, dependencies.now);
  if (!Array.isArray(raw) || raw.length > MAX_WORK) reject("INVALID_CONFIGURATION");
  let recovered = 0;
  let dispatched = 0;
  for (const candidate of raw) {
    let work = await validatedWork(candidate);
    if (work.state === "LEASED") {
      if (work.leaseExpiresAtIso === null || Date.parse(work.leaseExpiresAtIso) > now) {
        reject("INVALID_WORK");
      }
      try {
        work = await validatedWork(await active(() =>
          dependencies.markExpiredLeaseRecoverable(work.scope, {
            outboxId: work.outboxId, nowMs: now,
          }, boundary), boundary, dependencies.now));
      } catch (error) {
        if (error instanceof ComputeOptimizerOutboxDispatcherError) throw error;
        return reject("CAS_REJECTED");
      }
    }
    if (work.state === "RECOVERABLE") {
      try {
        work = await validatedWork(await active(() =>
          dependencies.requeueRecoverable(work.scope, {
            outboxId: work.outboxId, nowMs: now,
          }, boundary), boundary, dependencies.now));
        recovered += 1;
      } catch (error) {
        if (error instanceof ComputeOptimizerOutboxDispatcherError) throw error;
        return reject("CAS_REJECTED");
      }
    }
    if (work.state !== "PENDING") reject("INVALID_WORK");
    const leaseToken = dependencies.createLeaseToken?.(
      work.outboxId, work.deliveryAttempt + 1,
    ) ?? defaultLeaseToken();
    if (!/^[A-Za-z0-9._:@+-]{16,256}$/u.test(leaseToken)) {
      reject("INVALID_CONFIGURATION");
    }
    try {
      work = await validatedWork(await active(() => dependencies.lease(work.scope, {
        outboxId: work.outboxId,
        leaseToken,
        nowMs: now,
        leaseDurationMs: LEASE_DURATION_MS,
      }, boundary), boundary, dependencies.now));
    } catch (error) {
      if (error instanceof ComputeOptimizerOutboxDispatcherError) throw error;
      return reject("CAS_REJECTED");
    }
    if (work.state !== "LEASED") reject("CAS_REJECTED");
    let queued: { readonly id: string };
    try {
      queued = await active(() => dependencies.enqueue({
        orgId: work.scope.organizationId,
        customerId: work.scope.customerId,
        connectionId: work.scope.connectionId,
        kind: FINOPS_COMPUTE_OPTIMIZER_MATERIALIZE_JOB_KIND,
        payload: work.payload,
        maxAttempts: 12,
        idempotencyKey: `finops-compute-optimizer-materializer-outbox:${work.outboxId}`,
      }, now), boundary, dependencies.now);
    } catch {
      return reject("QUEUE_REJECTED");
    }
    if (typeof queued !== "object" || queued === null
      || typeof queued.id !== "string" || !IDENTIFIER.test(queued.id)) {
      reject("QUEUE_REJECTED");
    }
    try {
      await active(() => dependencies.markDispatched(work.scope, {
        outboxId: work.outboxId, leaseToken, nowMs: now,
      }, boundary), boundary, dependencies.now);
    } catch (error) {
      if (error instanceof ComputeOptimizerOutboxDispatcherError) throw error;
      return reject("CAS_REJECTED");
    }
    dispatched += 1;
  }
  return Object.freeze({ examined: raw.length, recovered, dispatched });
}

export const COMPUTE_OPTIMIZER_OUTBOX_DISPATCH_BOUNDS = Object.freeze({
  maximumWorkPerTick: MAX_WORK,
  leaseDurationMs: LEASE_DURATION_MS,
});
