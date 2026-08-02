/**
 * ADV-10 permanent scheduler and durable-handler boundary for ResilienceVue.
 *
 * Queue payloads contain only a scheduler-owned UTC window. Tenant, account,
 * partition, Region, and incremental cursor scope are loaded again from trusted
 * server state. The provider adapter is deliberately a port: this module owns
 * request identity, bounds, evidence archival, replay, and failure hygiene, but
 * it never accepts credentials or AWS scope from a caller-controlled payload.
 */
import type { JobHandler, RunnableJob } from "./background-job-runner.ts";
import { canonicalJson } from "./canonical-json.ts";
import {
  normalizeResilienceVueCapture,
  RESILIENCE_VUE_COLLECTION_BOUNDS,
  RESILIENCE_VUE_READ_OPERATIONS,
  type ResilienceVueCapture,
  type ResilienceVueScope,
  type ResilienceVueSnapshot,
} from "./finops-resilience-vue.ts";
import {
  RESILIENCE_VUE_JOB_KIND,
  type ResilienceVueCollectorTarget,
} from "./finops-resilience-vue-job.ts";
import type {
  ResilienceVuePersistenceScope,
  StoredResilienceVueSnapshot,
} from "../db/finops-resilience-vue-repository.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const REQUEST_ID = /^rvr_[a-f0-9]{64}$/u;
const CAPTURE_ID = /^resilience_[a-f0-9]{64}$/u;
const SNAPSHOT_GENERATION_ID = /^rvg_[a-f0-9]{64}$/u;
const EVIDENCE_GENERATION_ID = /^fss_[a-f0-9]{64}$/u;
const EVIDENCE_OBJECT_ID = /^eobj_[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SEALED_REFERENCE = /^fsev1\.[A-Za-z0-9_-]{26,8186}$/u;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const MAX_ELIGIBLE_CONNECTIONS = 10_000;
const MAX_TARGETS_PER_CONNECTION = 5_000;
const RESILIENCE_VUE_RUNTIME_MAX_EVIDENCE_BYTES = 12 * 1_024 * 1_024;

export const RESILIENCE_VUE_RUNTIME_JOB_KIND = RESILIENCE_VUE_JOB_KIND;
export const RESILIENCE_VUE_SCHEDULER_CADENCE = "rate(1 day)";
export const RESILIENCE_VUE_RUNTIME_TIMEOUT_MS =
  RESILIENCE_VUE_COLLECTION_BOUNDS.maximumDurationMs;
/** Leaves bounded envelope headroom below the production evidence-store limit. */
export const RESILIENCE_VUE_RUNTIME_MAX_CAPTURE_BYTES = 11 * 1_024 * 1_024;
export const RESILIENCE_VUE_RUNTIME_ACTIVATION_REASON =
  "RESILIENCE_VUE_AWS_ADAPTER_JOB_HANDLER_NOT_REGISTERED";
export const RESILIENCE_VUE_EVIDENCE_SOURCE_ID = "aws_resilience_hub" as const;
export const RESILIENCE_VUE_EVIDENCE_ACTOR_ID =
  "finops-resilience-vue-runtime" as const;

export interface ResilienceVueRuntimeAdapterRequest {
  readonly schemaVersion: "sutra.resilience-vue-runtime-request.v1";
  readonly requestId: string;
  readonly expectedCaptureId: string;
  readonly scheduledWindow: string;
  readonly scope: ResilienceVueScope;
  readonly incrementalAfterIso: string | null;
  readonly credentials: "SERVER_OWNED_TRUST_ROLE_SESSION";
  readonly operations: typeof RESILIENCE_VUE_READ_OPERATIONS;
  readonly pagination: {
    readonly pageSize: 100;
    readonly maximumPages: typeof RESILIENCE_VUE_COLLECTION_BOUNDS.maximumPages;
    readonly rejectTokenReplay: true;
    readonly requireExhaustionEvidence: true;
  };
  readonly bounds: Omit<typeof RESILIENCE_VUE_COLLECTION_BOUNDS, "maximumCaptureBytes"> & {
    readonly maximumCaptureBytes: typeof RESILIENCE_VUE_RUNTIME_MAX_CAPTURE_BYTES;
  };
  readonly maximumDurationMs: typeof RESILIENCE_VUE_COLLECTION_BOUNDS.maximumDurationMs;
}

export interface ResilienceVueRuntimeAwsAdapter {
  collect(
    request: ResilienceVueRuntimeAdapterRequest,
    signal: AbortSignal,
  ): Promise<ResilienceVueCapture>;
}

export interface ResilienceVueRuntimeQueue {
  enqueue(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly kind: typeof RESILIENCE_VUE_RUNTIME_JOB_KIND;
    readonly payload: { readonly scheduledWindow: string };
    readonly maxAttempts: 5;
    readonly idempotencyKey: string;
  }): Promise<unknown>;
}

export interface ResilienceVueEvidenceArchive {
  archive(input: {
    readonly scope: {
      readonly orgId: string;
      readonly customerId: string;
      readonly connectionId: string;
    };
    readonly runId: string;
    readonly snapshotId: string;
    readonly artifactKind: "finops_source_snapshot";
    readonly contentType: "application/json";
    readonly body: Uint8Array;
    readonly createdBy: typeof RESILIENCE_VUE_EVIDENCE_ACTOR_ID;
    readonly now: number;
  }): Promise<{
    readonly id: string;
    readonly status: "staging" | "available" | "failed";
    readonly contentSha256: string;
  }>;
}

export interface ResilienceVueEvidenceSealer {
  seal(objectId: string, context: {
    readonly organizationId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly sourceId: typeof RESILIENCE_VUE_EVIDENCE_SOURCE_ID;
    readonly generationId: string;
  }): Promise<{ readonly ciphertext: string; readonly keyVersion: string }>;
}

export interface ResilienceVueAcceptedRuntimeAttempt {
  readonly requestId: string;
  readonly scheduledWindow: string;
  readonly snapshot: StoredResilienceVueSnapshot;
  readonly evidence: {
    readonly generationId: string;
    readonly objectId: string;
    readonly contentSha256: string;
    readonly reference: { readonly ciphertext: string; readonly keyVersion: string };
  };
}

/**
 * The application-side implementation must durably bind the immutable evidence
 * reference and the ResilienceVue snapshot in one accepted attempt boundary.
 */
export interface ResilienceVueImmutableEvidenceHandoff {
  prepareAttempt(
    scope: ResilienceVuePersistenceScope,
    target: ResilienceVueScope,
    requestId: string,
    scheduledWindow: string,
  ): Promise<void>;
  getAccepted(
    scope: ResilienceVuePersistenceScope,
    target: ResilienceVueScope,
    requestId: string,
  ): Promise<ResilienceVueAcceptedRuntimeAttempt | null>;
  commit(input: {
    readonly scope: ResilienceVuePersistenceScope;
    readonly target: ResilienceVueScope;
    readonly requestId: string;
    readonly scheduledWindow: string;
    readonly capture: ResilienceVueCapture;
    readonly normalizedSnapshot: ResilienceVueSnapshot;
    readonly evidence: ResilienceVueAcceptedRuntimeAttempt["evidence"];
    readonly nowMs: number;
  }): Promise<{
    readonly accepted: ResilienceVueAcceptedRuntimeAttempt;
    readonly becameActive: boolean;
  }>;
  recordFailure(input: {
    readonly scope: ResilienceVuePersistenceScope;
    readonly target: ResilienceVueScope;
    readonly requestId: string;
    readonly scheduledWindow: string;
    readonly code: ResilienceVueRuntimeFailureCode;
    readonly completedAtMs: number;
  }): Promise<void>;
}

export type ResilienceVueRuntimeFailureCode =
  | "ADAPTER_TIMEOUT"
  | "ADAPTER_UNAVAILABLE"
  | "CAPTURE_REJECTED"
  | "EVIDENCE_REJECTED"
  | "PERSISTENCE_REJECTED";

export class ResilienceVueRuntimeBindingError extends Error {
  public readonly code:
    | "INVALID_JOB"
    | "SCOPE_REJECTED"
    | "TARGETS_REJECTED"
    | ResilienceVueRuntimeFailureCode;

  public constructor(code: ResilienceVueRuntimeBindingError["code"]) {
    super("ResilienceVue runtime collection failed");
    this.name = "ResilienceVueRuntimeBindingError";
    this.code = code;
  }
}

export type ResilienceVueRuntimeResult =
  | {
      readonly status: "unavailable";
      readonly reason: typeof RESILIENCE_VUE_RUNTIME_ACTIVATION_REASON;
    }
  | {
      readonly status: "collected";
      readonly targetCount: number;
      readonly acceptedHeadCount: number;
      readonly incompleteCount: number;
      readonly replayedCount: number;
      readonly generations: readonly string[];
      readonly evidenceGenerations: readonly string[];
    };

export interface ResilienceVueRuntimeDependencies {
  readonly loadScope: (identity: ResilienceVuePersistenceScope) =>
    Promise<ResilienceVuePersistenceScope>;
  readonly listTargets: (scope: ResilienceVuePersistenceScope) =>
    Promise<readonly ResilienceVueCollectorTarget[]>;
  readonly adapter: ResilienceVueRuntimeAwsAdapter | null;
  readonly evidence: ResilienceVueEvidenceArchive;
  readonly sealer: ResilienceVueEvidenceSealer;
  readonly handoff: ResilienceVueImmutableEvidenceHandoff;
  readonly now?: () => number;
}

function reject(code: ResilienceVueRuntimeBindingError["code"]): never {
  throw new ResilienceVueRuntimeBindingError(code);
}

function validIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validWindow(value: unknown): value is string {
  return typeof value === "string" && WINDOW.test(value) && validIso(value);
}

function validPersistenceScope(scope: ResilienceVuePersistenceScope): boolean {
  return IDENTIFIER.test(scope.organizationId)
    && IDENTIFIER.test(scope.customerId)
    && CONNECTION_ID.test(scope.connectionId);
}

function samePersistenceScope(
  left: ResilienceVuePersistenceScope,
  right: ResilienceVuePersistenceScope,
): boolean {
  return left.organizationId === right.organizationId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId;
}

function targetScope(target: ResilienceVueCollectorTarget): ResilienceVueScope {
  return Object.freeze({
    orgId: target.orgId,
    customerId: target.customerId,
    connectionId: target.connectionId,
    accountId: target.accountId,
    partition: target.partition,
    region: target.region,
  });
}

function sameTarget(left: ResilienceVueScope, right: ResilienceVueScope): boolean {
  return left.orgId === right.orgId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId
    && left.accountId === right.accountId
    && left.partition === right.partition
    && left.region === right.region;
}

function validTarget(
  target: ResilienceVueCollectorTarget,
  scope: ResilienceVuePersistenceScope,
): boolean {
  return target.orgId === scope.organizationId
    && target.customerId === scope.customerId
    && target.connectionId === scope.connectionId
    && ACCOUNT_ID.test(target.accountId)
    && new Set(["aws", "aws-cn", "aws-us-gov"]).has(target.partition)
    && REGION.test(target.region)
    && (target.lastAcceptedCompletedAtIso === null
      || validIso(target.lastAcceptedCompletedAtIso));
}

function currentTime(now: (() => number) | undefined): number {
  const value = now?.() ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0) reject("INVALID_JOB");
  return value;
}

function abortRace(signal: AbortSignal): Promise<never> {
  return new Promise((_, rejectPromise) => {
    if (signal.aborted) {
      rejectPromise(new Error("resilience-vue-runtime-deadline"));
      return;
    }
    signal.addEventListener("abort", () => rejectPromise(
      new Error("resilience-vue-runtime-deadline"),
    ), { once: true });
  });
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function parseJob(job: RunnableJob): {
  readonly scope: ResilienceVuePersistenceScope;
  readonly scheduledWindow: string;
} {
  if (
    job.kind !== RESILIENCE_VUE_RUNTIME_JOB_KIND
    || job.customerId === null
    || job.connectionId === null
    || !IDENTIFIER.test(job.id)
    || !IDENTIFIER.test(job.orgId)
    || !IDENTIFIER.test(job.customerId)
    || !CONNECTION_ID.test(job.connectionId)
    || !Number.isSafeInteger(job.attempt)
    || job.attempt < 1
    || job.attempt > 25
    || !Number.isSafeInteger(job.maxAttempts)
    || job.maxAttempts < job.attempt
    || typeof job.payload !== "object"
    || job.payload === null
    || Array.isArray(job.payload)
  ) reject("INVALID_JOB");
  const payload = job.payload as Record<string, unknown>;
  if (
    Object.keys(payload).length !== 1
    || !validWindow(payload.scheduledWindow)
  ) reject("INVALID_JOB");
  return {
    scope: {
      organizationId: job.orgId,
      customerId: job.customerId,
      connectionId: job.connectionId,
    },
    scheduledWindow: payload.scheduledWindow,
  };
}

async function requestIdentity(input: {
  readonly scope: ResilienceVueScope;
  readonly scheduledWindow: string;
}): Promise<{ readonly requestId: string; readonly expectedCaptureId: string }> {
  const digest = await sha256(canonicalJson({
    schemaVersion: "sutra.resilience-vue-runtime-identity.v1",
    ...input,
  }));
  return { requestId: `rvr_${digest}`, expectedCaptureId: `resilience_${digest}` };
}

function adapterRequest(input: {
  readonly requestId: string;
  readonly expectedCaptureId: string;
  readonly scheduledWindow: string;
  readonly scope: ResilienceVueScope;
  readonly incrementalAfterIso: string | null;
}): ResilienceVueRuntimeAdapterRequest {
  const bounds = Object.freeze({
    ...RESILIENCE_VUE_COLLECTION_BOUNDS,
    maximumCaptureBytes: RESILIENCE_VUE_RUNTIME_MAX_CAPTURE_BYTES,
  });
  return Object.freeze({
    schemaVersion: "sutra.resilience-vue-runtime-request.v1",
    requestId: input.requestId,
    expectedCaptureId: input.expectedCaptureId,
    scheduledWindow: input.scheduledWindow,
    scope: input.scope,
    incrementalAfterIso: input.incrementalAfterIso,
    credentials: "SERVER_OWNED_TRUST_ROLE_SESSION",
    operations: RESILIENCE_VUE_READ_OPERATIONS,
    pagination: Object.freeze({
      pageSize: RESILIENCE_VUE_COLLECTION_BOUNDS.apiPageSize,
      maximumPages: RESILIENCE_VUE_COLLECTION_BOUNDS.maximumPages,
      rejectTokenReplay: true,
      requireExhaustionEvidence: true,
    }),
    bounds,
    maximumDurationMs: RESILIENCE_VUE_COLLECTION_BOUNDS.maximumDurationMs,
  });
}

function validAccepted(
  accepted: ResilienceVueAcceptedRuntimeAttempt,
  expected: {
    readonly scope: ResilienceVuePersistenceScope;
    readonly target: ResilienceVueScope;
    readonly requestId: string;
    readonly scheduledWindow: string;
    readonly captureId?: string;
    readonly evidenceGenerationId?: string;
    readonly evidenceContentSha256?: string;
    readonly evidenceObjectId?: string;
    readonly evidenceReference?: { readonly ciphertext: string; readonly keyVersion: string };
  },
): boolean {
  const snapshot = accepted.snapshot;
  return accepted.requestId === expected.requestId
    && REQUEST_ID.test(accepted.requestId)
    && accepted.scheduledWindow === expected.scheduledWindow
    && validWindow(accepted.scheduledWindow)
    && samePersistenceScope(snapshot.scope, expected.scope)
    && sameTarget(snapshot.snapshot.scope, expected.target)
    && SNAPSHOT_GENERATION_ID.test(snapshot.generationId)
    && SHA256.test(snapshot.contentSha256)
    && CAPTURE_ID.test(snapshot.snapshot.captureId)
    && (expected.captureId === undefined
      || snapshot.snapshot.captureId === expected.captureId)
    && EVIDENCE_GENERATION_ID.test(accepted.evidence.generationId)
    && EVIDENCE_OBJECT_ID.test(accepted.evidence.objectId)
    && SHA256.test(accepted.evidence.contentSha256)
    && SEALED_REFERENCE.test(accepted.evidence.reference.ciphertext)
    && KEY_VERSION.test(accepted.evidence.reference.keyVersion)
    && (expected.evidenceGenerationId === undefined
      || accepted.evidence.generationId === expected.evidenceGenerationId)
    && (expected.evidenceContentSha256 === undefined
      || accepted.evidence.contentSha256 === expected.evidenceContentSha256)
    && (expected.evidenceObjectId === undefined
      || accepted.evidence.objectId === expected.evidenceObjectId)
    && (expected.evidenceReference === undefined
      || (
        accepted.evidence.reference.ciphertext === expected.evidenceReference.ciphertext
        && accepted.evidence.reference.keyVersion === expected.evidenceReference.keyVersion
      ));
}

async function recordFailure(
  dependencies: ResilienceVueRuntimeDependencies,
  input: Parameters<ResilienceVueImmutableEvidenceHandoff["recordFailure"]>[0],
): Promise<never> {
  try {
    await dependencies.handoff.recordFailure(input);
  } catch {
    // Never replace the sanitized runtime failure with persistence diagnostics.
  }
  throw new ResilienceVueRuntimeBindingError(input.code);
}

export async function scheduleResilienceVueCollections(input: {
  /** Trusted system query; caller-supplied connection lists are forbidden. */
  readonly loadEligibleScopes: () => Promise<readonly ResilienceVuePersistenceScope[]>;
  readonly queue: ResilienceVueRuntimeQueue;
  readonly scheduledWindow: string;
}): Promise<{ readonly scheduledWindow: string; readonly enqueued: number }> {
  if (!validWindow(input.scheduledWindow)) reject("INVALID_JOB");
  let scopes: readonly ResilienceVuePersistenceScope[];
  try {
    scopes = await input.loadEligibleScopes();
  } catch {
    return reject("SCOPE_REJECTED");
  }
  if (scopes.length > MAX_ELIGIBLE_CONNECTIONS) reject("SCOPE_REJECTED");
  const ordered = [...scopes].sort((left, right) =>
    left.connectionId.localeCompare(right.connectionId));
  const seen = new Set<string>();
  for (const scope of ordered) {
    if (!validPersistenceScope(scope) || seen.has(scope.connectionId)) {
      reject("SCOPE_REJECTED");
    }
    seen.add(scope.connectionId);
    await input.queue.enqueue({
      orgId: scope.organizationId,
      customerId: scope.customerId,
      connectionId: scope.connectionId,
      kind: RESILIENCE_VUE_RUNTIME_JOB_KIND,
      payload: Object.freeze({ scheduledWindow: input.scheduledWindow }),
      maxAttempts: 5,
      idempotencyKey: `resilience-vue:${scope.connectionId}:${input.scheduledWindow}`,
    });
  }
  return { scheduledWindow: input.scheduledWindow, enqueued: ordered.length };
}

export async function runResilienceVueRuntimeHandler(
  job: RunnableJob,
  dependencies: ResilienceVueRuntimeDependencies,
): Promise<ResilienceVueRuntimeResult> {
  const parsed = parseJob(job);
  if (dependencies.adapter === null) {
    return {
      status: "unavailable",
      reason: RESILIENCE_VUE_RUNTIME_ACTIVATION_REASON,
    };
  }

  let trustedScope: ResilienceVuePersistenceScope;
  try {
    trustedScope = await dependencies.loadScope(parsed.scope);
  } catch {
    return reject("SCOPE_REJECTED");
  }
  if (!validPersistenceScope(trustedScope)
    || !samePersistenceScope(trustedScope, parsed.scope)) {
    reject("SCOPE_REJECTED");
  }

  let loadedTargets: readonly ResilienceVueCollectorTarget[];
  try {
    loadedTargets = await dependencies.listTargets(trustedScope);
  } catch {
    return reject("TARGETS_REJECTED");
  }
  if (loadedTargets.length > MAX_TARGETS_PER_CONNECTION) {
    reject("TARGETS_REJECTED");
  }
  const seenTargets = new Set<string>();
  for (const target of loadedTargets) {
    const key = `${target.accountId}\0${target.partition}\0${target.region}`;
    if (!validTarget(target, trustedScope) || seenTargets.has(key)) {
      reject("TARGETS_REJECTED");
    }
    seenTargets.add(key);
  }
  const targets = [...loadedTargets].sort((left, right) =>
    left.accountId.localeCompare(right.accountId)
      || left.partition.localeCompare(right.partition)
      || left.region.localeCompare(right.region));

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    RESILIENCE_VUE_RUNTIME_TIMEOUT_MS,
  );
  let cursor = 0;
  let acceptedHeadCount = 0;
  let incompleteCount = 0;
  let replayedCount = 0;
  const generations: string[] = [];
  const evidenceGenerations: string[] = [];

  try {
    const workers = Array.from({
      length: Math.min(
        RESILIENCE_VUE_COLLECTION_BOUNDS.maximumConcurrency,
        targets.length,
      ),
    }, async () => {
      while (cursor < targets.length && !controller.signal.aborted) {
        const target = targets[cursor++]!;
        const trustedTarget = targetScope(target);
        const identity = await requestIdentity({
          scope: trustedTarget,
          scheduledWindow: parsed.scheduledWindow,
        });
        let prior: ResilienceVueAcceptedRuntimeAttempt | null = null;
        try {
          await dependencies.handoff.prepareAttempt(
            trustedScope,
            trustedTarget,
            identity.requestId,
            parsed.scheduledWindow,
          );
          prior = await dependencies.handoff.getAccepted(
            trustedScope,
            trustedTarget,
            identity.requestId,
          );
        } catch {
          await recordFailure(dependencies, {
            scope: trustedScope,
            target: trustedTarget,
            requestId: identity.requestId,
            scheduledWindow: parsed.scheduledWindow,
            code: "PERSISTENCE_REJECTED",
            completedAtMs: currentTime(dependencies.now),
          });
          return;
        }
        if (prior !== null) {
          if (!validAccepted(prior, {
            scope: trustedScope,
            target: trustedTarget,
            requestId: identity.requestId,
            scheduledWindow: parsed.scheduledWindow,
            captureId: identity.expectedCaptureId,
          })) {
            await recordFailure(dependencies, {
              scope: trustedScope,
              target: trustedTarget,
              requestId: identity.requestId,
              scheduledWindow: parsed.scheduledWindow,
              code: "PERSISTENCE_REJECTED",
              completedAtMs: currentTime(dependencies.now),
            });
          }
          replayedCount += 1;
          if (!prior.snapshot.snapshot.complete) incompleteCount += 1;
          generations.push(prior.snapshot.generationId);
          evidenceGenerations.push(prior.evidence.generationId);
          continue;
        }

        const request = adapterRequest({
          ...identity,
          scheduledWindow: parsed.scheduledWindow,
          scope: trustedTarget,
          incrementalAfterIso: target.lastAcceptedCompletedAtIso,
        });
        let capture: ResilienceVueCapture | null = null;
        try {
          capture = await Promise.race([
            dependencies.adapter!.collect(request, controller.signal),
            abortRace(controller.signal),
          ]);
        } catch {
          const code: ResilienceVueRuntimeFailureCode = controller.signal.aborted
            ? "ADAPTER_TIMEOUT"
            : "ADAPTER_UNAVAILABLE";
          controller.abort();
          await recordFailure(dependencies, {
            scope: trustedScope,
            target: trustedTarget,
            requestId: identity.requestId,
            scheduledWindow: parsed.scheduledWindow,
            code,
            completedAtMs: currentTime(dependencies.now),
          });
          return;
        }
        if (capture === null) return;

        const normalizedAt = currentTime(dependencies.now);
        let normalizedSnapshot: ResilienceVueSnapshot | null = null;
        try {
          if (capture.captureId !== identity.expectedCaptureId) {
            throw new Error("capture-identity-mismatch");
          }
          if (new TextEncoder().encode(canonicalJson(capture)).byteLength
            > RESILIENCE_VUE_RUNTIME_MAX_CAPTURE_BYTES) {
            throw new Error("capture-runtime-byte-limit");
          }
          normalizedSnapshot = normalizeResilienceVueCapture(
            capture,
            trustedTarget,
            normalizedAt,
          );
        } catch {
          controller.abort();
          await recordFailure(dependencies, {
            scope: trustedScope,
            target: trustedTarget,
            requestId: identity.requestId,
            scheduledWindow: parsed.scheduledWindow,
            code: "CAPTURE_REJECTED",
            completedAtMs: normalizedAt,
          });
          return;
        }
        if (normalizedSnapshot === null) return;

        const evidenceBody = new TextEncoder().encode(canonicalJson({
          schemaVersion: "sutra.resilience-vue-runtime-evidence.v1",
          request,
          capture,
        }));
        if (evidenceBody.byteLength > RESILIENCE_VUE_RUNTIME_MAX_EVIDENCE_BYTES) {
          controller.abort();
          await recordFailure(dependencies, {
            scope: trustedScope,
            target: trustedTarget,
            requestId: identity.requestId,
            scheduledWindow: parsed.scheduledWindow,
            code: "EVIDENCE_REJECTED",
            completedAtMs: normalizedAt,
          });
        }
        const evidenceContentSha256 = await sha256(evidenceBody);
        const evidenceGenerationId = `fss_${await sha256(canonicalJson({
          schemaVersion: "sutra.resilience-vue-evidence-identity.v1",
          requestId: identity.requestId,
          evidenceContentSha256,
        }))}`;
        let archived: Awaited<ReturnType<ResilienceVueEvidenceArchive["archive"]>> | null = null;
        let reference: { readonly ciphertext: string; readonly keyVersion: string } | null = null;
        try {
          archived = await dependencies.evidence.archive({
            scope: {
              orgId: trustedScope.organizationId,
              customerId: trustedScope.customerId,
              connectionId: trustedScope.connectionId,
            },
            runId: identity.requestId,
            snapshotId: evidenceGenerationId,
            artifactKind: "finops_source_snapshot",
            contentType: "application/json",
            body: evidenceBody,
            createdBy: RESILIENCE_VUE_EVIDENCE_ACTOR_ID,
            now: normalizedAt,
          });
          if (archived.status !== "available"
            || !EVIDENCE_OBJECT_ID.test(archived.id)
            || archived.contentSha256 !== evidenceContentSha256) {
            throw new Error("evidence-archive-rejected");
          }
          reference = await dependencies.sealer.seal(archived.id, {
            organizationId: trustedScope.organizationId,
            customerId: trustedScope.customerId,
            connectionId: trustedScope.connectionId,
            sourceId: RESILIENCE_VUE_EVIDENCE_SOURCE_ID,
            generationId: evidenceGenerationId,
          });
          if (!SEALED_REFERENCE.test(reference.ciphertext)
            || !KEY_VERSION.test(reference.keyVersion)) {
            throw new Error("evidence-reference-rejected");
          }
        } catch {
          controller.abort();
          await recordFailure(dependencies, {
            scope: trustedScope,
            target: trustedTarget,
            requestId: identity.requestId,
            scheduledWindow: parsed.scheduledWindow,
            code: "EVIDENCE_REJECTED",
            completedAtMs: normalizedAt,
          });
          return;
        }
        if (archived === null || reference === null) return;

        const expectedEvidence = Object.freeze({
          generationId: evidenceGenerationId,
          objectId: archived.id,
          contentSha256: evidenceContentSha256,
          reference: Object.freeze({ ...reference }),
        });
        let committed: Awaited<ReturnType<ResilienceVueImmutableEvidenceHandoff["commit"]>> | null = null;
        try {
          committed = await dependencies.handoff.commit({
            scope: trustedScope,
            target: trustedTarget,
            requestId: identity.requestId,
            scheduledWindow: parsed.scheduledWindow,
            capture,
            normalizedSnapshot,
            evidence: expectedEvidence,
            nowMs: normalizedAt,
          });
          if (!validAccepted(committed.accepted, {
            scope: trustedScope,
            target: trustedTarget,
            requestId: identity.requestId,
            scheduledWindow: parsed.scheduledWindow,
            captureId: identity.expectedCaptureId,
            evidenceGenerationId,
            evidenceContentSha256,
            evidenceObjectId: archived.id,
            evidenceReference: reference,
          }) || canonicalJson(committed.accepted.snapshot.snapshot)
            !== canonicalJson(normalizedSnapshot)) {
            throw new Error("persistence-result-rejected");
          }
        } catch {
          controller.abort();
          await recordFailure(dependencies, {
            scope: trustedScope,
            target: trustedTarget,
            requestId: identity.requestId,
            scheduledWindow: parsed.scheduledWindow,
            code: "PERSISTENCE_REJECTED",
            completedAtMs: normalizedAt,
          });
          return;
        }
        if (committed === null) return;
        if (committed.becameActive) acceptedHeadCount += 1;
        if (!committed.accepted.snapshot.snapshot.complete) incompleteCount += 1;
        generations.push(committed.accepted.snapshot.generationId);
        evidenceGenerations.push(committed.accepted.evidence.generationId);
      }
    });
    await Promise.all(workers);
  } finally {
    clearTimeout(timeout);
  }

  return {
    status: "collected",
    targetCount: targets.length,
    acceptedHeadCount,
    incompleteCount,
    replayedCount,
    generations: generations.sort(),
    evidenceGenerations: evidenceGenerations.sort(),
  };
}

export function createResilienceVueRuntimeJobHandler(
  dependencies: ResilienceVueRuntimeDependencies,
): JobHandler {
  return async (job) => {
    const result = await runResilienceVueRuntimeHandler(job, dependencies);
    if (result.status === "unavailable") {
      throw new ResilienceVueRuntimeBindingError("ADAPTER_UNAVAILABLE");
    }
  };
}

export const RESILIENCE_VUE_RUNTIME_BINDING = Object.freeze({
  jobKind: RESILIENCE_VUE_RUNTIME_JOB_KIND,
  cadence: RESILIENCE_VUE_SCHEDULER_CADENCE,
  handlerFactory: createResilienceVueRuntimeJobHandler,
  registeredInSharedRuntime: false,
  activationReason: RESILIENCE_VUE_RUNTIME_ACTIVATION_REASON,
});
