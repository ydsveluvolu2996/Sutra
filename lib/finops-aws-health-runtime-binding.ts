/**
 * ADV-06 durable scheduler and runtime boundary for AWS Health Organizational
 * View. The queue payload contains only a UTC daily window. All AWS identity,
 * partition, endpoint, permissions, and collection bounds come from trusted
 * server state after the job is leased.
 */
import type { RunnableJob } from "./background-job-runner.ts";
import { canonicalJson } from "./canonical-json.ts";
import {
  AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS,
  AWS_HEALTH_ORGANIZATION_CONFIGURATION_READ_OPERATION,
  AWS_HEALTH_ORGANIZATION_READ_OPERATIONS,
  normalizeAwsHealthOrganizationCapture,
  type AwsHealthOrganizationCapture,
  type AwsHealthOrganizationScope,
  type AwsHealthOrganizationSnapshot,
} from "./finops-aws-health-organization.ts";
import { AWS_HEALTH_ORGANIZATION_JOB_KIND } from
  "./finops-aws-health-collector-job.ts";
import type {
  AwsHealthPersistenceScope,
  StoredAwsHealthSnapshot,
} from "../db/finops-aws-health-repository.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u;
const JOB = /^job_[a-f0-9]{32}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const REQUEST = /^hrr_[a-f0-9]{64}$/u;
const GENERATION = /^hhg_[a-f0-9]{64}$/u;
const CAPTURE = /^health_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_SCOPES = 10_000;

export const AWS_HEALTH_RUNTIME_JOB_KIND = AWS_HEALTH_ORGANIZATION_JOB_KIND;
export const AWS_HEALTH_RUNTIME_CADENCE = "rate(1 day)";
export const AWS_HEALTH_RUNTIME_MAX_ATTEMPTS = 5;
export const AWS_HEALTH_RUNTIME_ACTIVATION_REASON =
  "AWS_HEALTH_ORGANIZATION_JOB_HANDLER_NOT_REGISTERED";

export interface AwsHealthRuntimeQueue {
  enqueue(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly kind: typeof AWS_HEALTH_RUNTIME_JOB_KIND;
    readonly payload: { readonly scheduledWindow: string };
    readonly maxAttempts: typeof AWS_HEALTH_RUNTIME_MAX_ATTEMPTS;
    readonly idempotencyKey: string;
  }): Promise<unknown>;
}

export interface AwsHealthRuntimeAdapterRequest {
  readonly schemaVersion: "sutra.aws-health-runtime-request.v1";
  readonly requestId: string;
  readonly scheduledWindow: string;
  readonly scope: AwsHealthOrganizationScope;
  readonly credentials: "SERVER_OWNED_TRUST_ROLE_SESSION";
  readonly locale: "en";
  readonly unfilteredAvailableEvents: true;
  readonly operations: typeof AWS_HEALTH_ORGANIZATION_READ_OPERATIONS;
  readonly configurationOperation:
    typeof AWS_HEALTH_ORGANIZATION_CONFIGURATION_READ_OPERATION;
  readonly bounds: typeof AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS;
  readonly pagination: {
    readonly pageSize: 100;
    readonly detailBatchSize: 10;
    readonly rejectTokenReplay: true;
    readonly requireExhaustionEvidence: true;
  };
}

export interface AwsHealthRuntimeAdapter {
  collect(
    request: AwsHealthRuntimeAdapterRequest,
    signal: AbortSignal,
  ): Promise<AwsHealthOrganizationCapture>;
}

export interface AwsHealthAcceptedRuntimeAttempt {
  readonly scope: AwsHealthPersistenceScope;
  readonly requestId: string;
  readonly scheduledWindow: string;
  readonly snapshot: StoredAwsHealthSnapshot;
}

export type AwsHealthRuntimeFailureCode =
  | "ADAPTER_TIMEOUT"
  | "ADAPTER_UNAVAILABLE"
  | "CAPTURE_REJECTED"
  | "PERSISTENCE_REJECTED";

/**
 * Production implementations must atomically retain the immutable attempt and
 * normalized snapshot. The injected boundary keeps replay semantics testable
 * without claiming that a credential broker or production ledger is installed.
 */
export interface AwsHealthRuntimeHandoff {
  /** Durable implementations create the request identity before claiming it. */
  prepareAttempt?(
    scope: AwsHealthPersistenceScope,
    requestId: string,
    scheduledWindow: string,
  ): Promise<void>;
  getAccepted(
    scope: AwsHealthPersistenceScope,
    requestId: string,
  ): Promise<AwsHealthAcceptedRuntimeAttempt | null>;
  commit(input: {
    readonly scope: AwsHealthPersistenceScope;
    readonly trustedScope: AwsHealthOrganizationScope;
    readonly requestId: string;
    readonly scheduledWindow: string;
    readonly capture: AwsHealthOrganizationCapture;
    readonly normalizedSnapshot: AwsHealthOrganizationSnapshot;
    readonly completedAtMs: number;
  }): Promise<{
    readonly accepted: AwsHealthAcceptedRuntimeAttempt;
    readonly becameActive: boolean;
  }>;
  recordFailure(input: {
    readonly scope: AwsHealthPersistenceScope;
    readonly requestId: string;
    readonly scheduledWindow: string;
    readonly code: AwsHealthRuntimeFailureCode;
    readonly completedAtMs: number;
  }): Promise<void>;
}

export interface AwsHealthRuntimeDependencies {
  readonly loadScope: (
    scope: AwsHealthPersistenceScope,
  ) => Promise<AwsHealthOrganizationScope>;
  readonly adapter: AwsHealthRuntimeAdapter | null;
  readonly handoff: AwsHealthRuntimeHandoff;
  readonly now?: () => number;
}

export class AwsHealthRuntimeBindingError extends Error {
  public readonly code:
    | "INVALID_JOB"
    | "SCOPE_REJECTED"
    | AwsHealthRuntimeFailureCode;

  public constructor(code: AwsHealthRuntimeBindingError["code"]) {
    super("AWS Health runtime collection failed");
    this.name = "AwsHealthRuntimeBindingError";
    this.code = code;
  }
}

export type AwsHealthRuntimeResult =
  | {
      readonly status: "unavailable";
      readonly reason: typeof AWS_HEALTH_RUNTIME_ACTIVATION_REASON;
    }
  | {
      readonly status: "accepted";
      readonly requestId: string;
      readonly generationId: string;
      readonly captureId: string;
      readonly configurationState: AwsHealthOrganizationSnapshot["configurationState"];
      readonly collectionState: AwsHealthOrganizationSnapshot["collectionState"];
      readonly becameActive: boolean;
      readonly replayed: boolean;
    };

function reject(code: AwsHealthRuntimeBindingError["code"]): never {
  throw new AwsHealthRuntimeBindingError(code);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort())
    === JSON.stringify([...expected].sort());
}

function validIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validWindow(value: unknown): value is string {
  return typeof value === "string" && WINDOW.test(value) && validIso(value);
}

function validPersistenceScope(scope: AwsHealthPersistenceScope): boolean {
  return IDENTIFIER.test(scope.organizationId)
    && IDENTIFIER.test(scope.customerId)
    && CONNECTION.test(scope.connectionId);
}

function validTrustedScope(scope: AwsHealthOrganizationScope): boolean {
  return IDENTIFIER.test(scope.orgId)
    && IDENTIFIER.test(scope.customerId)
    && CONNECTION.test(scope.connectionId)
    && ACCOUNT.test(scope.accountId)
    && (
      (scope.partition === "aws" && scope.endpointRegion === "us-east-1")
      || (
        scope.partition === "aws-us-gov"
        && scope.endpointRegion === "us-gov-west-1"
      )
    );
}

function sameScope(
  trusted: AwsHealthOrganizationScope,
  scope: AwsHealthPersistenceScope,
): boolean {
  return trusted.orgId === scope.organizationId
    && trusted.customerId === scope.customerId
    && trusted.connectionId === scope.connectionId;
}

function nowValue(now: (() => number) | undefined): number {
  const value = now?.() ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0) reject("INVALID_JOB");
  return value;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0")).join("");
}

function parseJob(job: RunnableJob): {
  readonly scope: AwsHealthPersistenceScope;
  readonly scheduledWindow: string;
} {
  if (
    job.kind !== AWS_HEALTH_RUNTIME_JOB_KIND
    || job.customerId === null
    || job.connectionId === null
    || !JOB.test(job.id)
    || !IDENTIFIER.test(job.orgId)
    || !IDENTIFIER.test(job.customerId)
    || !CONNECTION.test(job.connectionId)
    || !Number.isSafeInteger(job.attempt)
    || job.attempt < 1
    || job.attempt > AWS_HEALTH_RUNTIME_MAX_ATTEMPTS
    || job.maxAttempts !== AWS_HEALTH_RUNTIME_MAX_ATTEMPTS
    || typeof job.payload !== "object"
    || job.payload === null
    || Array.isArray(job.payload)
  ) reject("INVALID_JOB");
  const payload = job.payload as Record<string, unknown>;
  if (!exactKeys(payload, ["scheduledWindow"])
    || !validWindow(payload.scheduledWindow)) reject("INVALID_JOB");
  return {
    scope: {
      organizationId: job.orgId,
      customerId: job.customerId,
      connectionId: job.connectionId,
    },
    scheduledWindow: payload.scheduledWindow,
  };
}

async function requestIdFor(
  scope: AwsHealthOrganizationScope,
  scheduledWindow: string,
): Promise<string> {
  return `hrr_${await sha256(canonicalJson({
    schemaVersion: "sutra.aws-health-runtime-identity.v1",
    scope,
    scheduledWindow,
  }))}`;
}

function validAccepted(
  accepted: AwsHealthAcceptedRuntimeAttempt,
  scope: AwsHealthPersistenceScope,
  trusted: AwsHealthOrganizationScope,
  requestId: string,
  scheduledWindow: string,
): boolean {
  const snapshotScope = accepted.snapshot.snapshot.scope;
  return validPersistenceScope(accepted.scope)
    && accepted.scope.organizationId === scope.organizationId
    && accepted.scope.customerId === scope.customerId
    && accepted.scope.connectionId === scope.connectionId
    && accepted.requestId === requestId
    && REQUEST.test(accepted.requestId)
    && accepted.scheduledWindow === scheduledWindow
    && GENERATION.test(accepted.snapshot.generationId)
    && SHA256.test(accepted.snapshot.contentSha256)
    && accepted.snapshot.generationId
      === `hhg_${accepted.snapshot.contentSha256}`
    && CAPTURE.test(accepted.snapshot.snapshot.captureId)
    && accepted.snapshot.snapshot.sourceId === "aws_health_organization"
    && validIso(accepted.snapshot.createdAtIso)
    && (
      accepted.snapshot.committedAtIso === null
      || validIso(accepted.snapshot.committedAtIso)
    )
    && accepted.snapshot.scope.organizationId === scope.organizationId
    && accepted.snapshot.scope.customerId === scope.customerId
    && accepted.snapshot.scope.connectionId === scope.connectionId
    && validTrustedScope(snapshotScope)
    && sameScope(snapshotScope, scope)
    && snapshotScope.accountId === trusted.accountId
    && snapshotScope.partition === trusted.partition
    && snapshotScope.endpointRegion === trusted.endpointRegion;
}

function resultFor(
  accepted: AwsHealthAcceptedRuntimeAttempt,
  becameActive: boolean,
  replayed: boolean,
): AwsHealthRuntimeResult {
  return {
    status: "accepted",
    requestId: accepted.requestId,
    generationId: accepted.snapshot.generationId,
    captureId: accepted.snapshot.snapshot.captureId,
    configurationState: accepted.snapshot.snapshot.configurationState,
    collectionState: accepted.snapshot.snapshot.collectionState,
    becameActive,
    replayed,
  };
}

function failureCode(error: unknown): AwsHealthRuntimeFailureCode {
  if (error instanceof AwsHealthRuntimeBindingError) {
    if (error.code === "ADAPTER_TIMEOUT") return error.code;
    if (error.code === "PERSISTENCE_REJECTED") return error.code;
    if (error.code === "CAPTURE_REJECTED") return error.code;
  }
  return error instanceof DOMException && error.name === "AbortError"
    ? "ADAPTER_TIMEOUT"
    : "ADAPTER_UNAVAILABLE";
}

export async function scheduleAwsHealthOrganizationCollections(input: {
  readonly scheduledWindow: string;
  readonly loadEligibleScopes: () =>
    Promise<readonly AwsHealthPersistenceScope[]>;
  readonly queue: AwsHealthRuntimeQueue;
}): Promise<{ readonly scheduledWindow: string; readonly enqueued: number }> {
  if (!validWindow(input.scheduledWindow)) reject("INVALID_JOB");
  const scopes = await input.loadEligibleScopes();
  if (scopes.length > MAX_SCOPES) reject("SCOPE_REJECTED");
  const ordered = [...scopes].sort((left, right) =>
    left.connectionId.localeCompare(right.connectionId));
  const seen = new Set<string>();
  for (const scope of ordered) {
    if (!validPersistenceScope(scope) || seen.has(scope.connectionId)) {
      reject("SCOPE_REJECTED");
    }
    seen.add(scope.connectionId);
  }
  for (const scope of ordered) {
    await input.queue.enqueue({
      orgId: scope.organizationId,
      customerId: scope.customerId,
      connectionId: scope.connectionId,
      kind: AWS_HEALTH_RUNTIME_JOB_KIND,
      payload: { scheduledWindow: input.scheduledWindow },
      maxAttempts: AWS_HEALTH_RUNTIME_MAX_ATTEMPTS,
      idempotencyKey: [
        "aws-health-organization",
        scope.organizationId,
        scope.customerId,
        scope.connectionId,
        input.scheduledWindow,
      ].map(encodeURIComponent).join(":"),
    });
  }
  return { scheduledWindow: input.scheduledWindow, enqueued: ordered.length };
}

export async function runAwsHealthOrganizationRuntimeHandler(
  job: RunnableJob,
  dependencies: AwsHealthRuntimeDependencies,
): Promise<AwsHealthRuntimeResult> {
  const parsed = parseJob(job);
  let trusted: AwsHealthOrganizationScope;
  try {
    trusted = await dependencies.loadScope(parsed.scope);
  } catch {
    reject("SCOPE_REJECTED");
  }
  if (!validTrustedScope(trusted) || !sameScope(trusted, parsed.scope)) {
    reject("SCOPE_REJECTED");
  }
  const requestId = await requestIdFor(trusted, parsed.scheduledWindow);
  if (dependencies.handoff.prepareAttempt !== undefined) {
    try {
      await dependencies.handoff.prepareAttempt(
        parsed.scope,
        requestId,
        parsed.scheduledWindow,
      );
    } catch {
      reject("PERSISTENCE_REJECTED");
    }
  }
  let replay: AwsHealthAcceptedRuntimeAttempt | null;
  try {
    replay = await dependencies.handoff.getAccepted(parsed.scope, requestId);
  } catch {
    reject("PERSISTENCE_REJECTED");
  }
  if (replay !== null) {
    if (!validAccepted(
      replay,
      parsed.scope,
      trusted,
      requestId,
      parsed.scheduledWindow,
    )) {
      reject("PERSISTENCE_REJECTED");
    }
    return resultFor(replay, false, true);
  }
  if (dependencies.adapter === null) {
    return {
      status: "unavailable",
      reason: AWS_HEALTH_RUNTIME_ACTIVATION_REASON,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.maximumDurationMs,
  );
  try {
    const adapterPromise = dependencies.adapter.collect(Object.freeze({
      schemaVersion: "sutra.aws-health-runtime-request.v1",
      requestId,
      scheduledWindow: parsed.scheduledWindow,
      scope: Object.freeze({ ...trusted }),
      credentials: "SERVER_OWNED_TRUST_ROLE_SESSION",
      locale: "en",
      unfilteredAvailableEvents: true,
      operations: AWS_HEALTH_ORGANIZATION_READ_OPERATIONS,
      configurationOperation:
        AWS_HEALTH_ORGANIZATION_CONFIGURATION_READ_OPERATION,
      bounds: AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS,
      pagination: Object.freeze({
        pageSize: 100,
        detailBatchSize: 10,
        rejectTokenReplay: true,
        requireExhaustionEvidence: true,
      }),
    }), controller.signal);
    const capture = await new Promise<AwsHealthOrganizationCapture>((resolve, rejectPromise) => {
      const abort = () => rejectPromise(new DOMException("Collection deadline reached", "AbortError"));
      if (controller.signal.aborted) abort();
      else controller.signal.addEventListener("abort", abort, { once: true });
      adapterPromise.then(resolve, rejectPromise).finally(() => {
        controller.signal.removeEventListener("abort", abort);
      });
    });
    let normalized: AwsHealthOrganizationSnapshot;
    try {
      normalized = normalizeAwsHealthOrganizationCapture(
        capture,
        trusted,
        nowValue(dependencies.now),
      );
    } catch {
      throw new AwsHealthRuntimeBindingError("CAPTURE_REJECTED");
    }
    let committed: Awaited<ReturnType<AwsHealthRuntimeHandoff["commit"]>>;
    try {
      committed = await dependencies.handoff.commit({
        scope: parsed.scope,
        trustedScope: trusted,
        requestId,
        scheduledWindow: parsed.scheduledWindow,
        capture,
        normalizedSnapshot: normalized,
        completedAtMs: nowValue(dependencies.now),
      });
    } catch {
      throw new AwsHealthRuntimeBindingError("PERSISTENCE_REJECTED");
    }
    if (!validAccepted(
      committed.accepted,
      parsed.scope,
      trusted,
      requestId,
      parsed.scheduledWindow,
    ) || committed.accepted.snapshot.snapshot.captureId !== normalized.captureId
      || committed.accepted.snapshot.snapshot.collectionState
        !== normalized.collectionState
      || committed.accepted.snapshot.snapshot.configurationState
        !== normalized.configurationState) {
      throw new AwsHealthRuntimeBindingError("PERSISTENCE_REJECTED");
    }
    return resultFor(
      committed.accepted,
      committed.becameActive,
      false,
    );
  } catch (error) {
    const code = failureCode(error);
    try {
      await dependencies.handoff.recordFailure({
        scope: parsed.scope,
        requestId,
        scheduledWindow: parsed.scheduledWindow,
        code,
        completedAtMs: nowValue(dependencies.now),
      });
    } catch {
      reject("PERSISTENCE_REJECTED");
    }
    throw new AwsHealthRuntimeBindingError(code);
  } finally {
    clearTimeout(timeout);
  }
}

export const AWS_HEALTH_RUNTIME_BINDING = Object.freeze({
  jobKind: AWS_HEALTH_RUNTIME_JOB_KIND,
  cadence: AWS_HEALTH_RUNTIME_CADENCE,
  scheduler: scheduleAwsHealthOrganizationCollections,
  handler: runAwsHealthOrganizationRuntimeHandler,
  registeredInSharedRuntime: true,
  activationReason: AWS_HEALTH_RUNTIME_ACTIVATION_REASON,
});
