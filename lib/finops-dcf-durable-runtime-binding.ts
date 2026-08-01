/** Durable scheduler/handler contract for the Data Collection Monitor. */
import type { JobHandler, RunnableJob } from "./background-job-runner.ts";
import {
  DcfStepFunctionsAdapter,
  type DcfStepFunctionsBoundary,
  type DcfStepFunctionsCollectionResult,
  type DcfStepFunctionsFailureCode,
} from "./finops-dcf-step-functions-adapter.ts";
import {
  normalizeDcfCapture,
  type DcfCapture,
  type DcfScope,
  type DcfSnapshot,
} from "./finops-dcf-execution-history.ts";

export const DCF_STEP_FUNCTIONS_RUNTIME_JOB_KIND =
  "finops.dcf-step-functions.collect" as const;
export const DCF_STEP_FUNCTIONS_RUNTIME_CADENCE = "rate(1 hour)" as const;
export const DCF_STEP_FUNCTIONS_RUNTIME_ACTIVATION_REASON =
  "DCF_STEP_FUNCTIONS_INSTRUMENTATION_NOT_REGISTERED" as const;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const JOB_ID = /^job_[a-f0-9]{32}$/u;
const LEASE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const GENERATION_ID = /^dcg_[a-f0-9]{64}$/u;
const CAPTURE_ID = /^dcf_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/u;
const FAILURE_CODES = new Set<DcfStepFunctionsFailureCode>([
  "AUTHORIZATION_FAILED",
  "SOURCE_UNAVAILABLE",
  "THROTTLED",
  "TIMEOUT",
  "SCHEMA_MISMATCH",
  "SCOPE_MISMATCH",
  "UNSUPPORTED_STATE_MACHINE",
  "LIMIT_REACHED",
  "INTERNAL_ERROR",
]);

export interface DcfStepFunctionsRuntimeScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface DcfStepFunctionsRuntimeQueue {
  enqueue(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly kind: typeof DCF_STEP_FUNCTIONS_RUNTIME_JOB_KIND;
    readonly payload: { readonly scheduledWindow: string };
    readonly maxAttempts: 5;
    readonly idempotencyKey: string;
  }): Promise<unknown>;
}

export interface DcfStepFunctionsRuntimeResult {
  readonly schemaVersion: "sutra.dcf-step-functions-runtime-result.v1";
  readonly generationId: string;
  readonly contentSha256: string;
  readonly captureId: string;
  readonly sourceState: DcfStepFunctionsCollectionResult["sourceState"];
  readonly failureCodes: readonly DcfStepFunctionsFailureCode[];
  readonly becameActive: boolean;
}

export type DcfStepFunctionsReplayClaim =
  | { readonly state: "ACQUIRED"; readonly leaseToken: string }
  | { readonly state: "IN_PROGRESS" }
  | {
    readonly state: "COMPLETED";
    readonly result: DcfStepFunctionsRuntimeResult;
    readonly resultSha256: string;
  };

export interface DcfStepFunctionsReplayStore {
  claim(input: {
    readonly key: string;
    readonly jobId: string;
    readonly leaseDurationMs: 960_000;
  }): Promise<DcfStepFunctionsReplayClaim>;
  complete(input: {
    readonly key: string;
    readonly jobId: string;
    readonly leaseToken: string;
    readonly result: DcfStepFunctionsRuntimeResult;
    readonly resultSha256: string;
  }): Promise<void>;
  fail(input: {
    readonly key: string;
    readonly jobId: string;
    readonly leaseToken: string;
    readonly failureCode: "DCF_STEP_FUNCTIONS_COLLECTION_FAILED";
  }): Promise<void>;
}

export interface DcfStepFunctionsRuntimeDependencies {
  readonly loadBoundary: (
    scope: DcfStepFunctionsRuntimeScope,
  ) => Promise<DcfStepFunctionsBoundary>;
  readonly adapter: Pick<DcfStepFunctionsAdapter, "collect">;
  readonly record: (
    scope: DcfStepFunctionsRuntimeScope,
    trusted: DcfScope,
    capture: DcfCapture,
  ) => Promise<{
    readonly generationId: string;
    readonly contentSha256: string;
    readonly snapshot: DcfSnapshot;
    readonly becameActive: boolean;
  }>;
  readonly replayStore: DcfStepFunctionsReplayStore;
}

export type DcfStepFunctionsRuntimeDisposition =
  | {
    readonly disposition: "EXECUTED" | "REPLAYED";
    readonly result: DcfStepFunctionsRuntimeResult;
  }
  | { readonly disposition: "IN_PROGRESS"; readonly result: null };

export class DcfStepFunctionsRuntimeError extends Error {
  public readonly code: "INVALID_JOB" | "COLLECTION_FAILED";

  public constructor(code: DcfStepFunctionsRuntimeError["code"]) {
    super(code === "INVALID_JOB"
      ? "Data Collection Monitor job was rejected"
      : "Data Collection Monitor collection failed");
    this.name = "DcfStepFunctionsRuntimeError";
    this.code = code;
  }
}

function reject(code: DcfStepFunctionsRuntimeError["code"]): never {
  throw new DcfStepFunctionsRuntimeError(code);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function validScope(scope: DcfStepFunctionsRuntimeScope): boolean {
  return IDENTIFIER.test(scope.organizationId)
    && IDENTIFIER.test(scope.customerId)
    && CONNECTION_ID.test(scope.connectionId);
}

function validWindow(value: string): boolean {
  return WINDOW.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function validResult(value: unknown): value is DcfStepFunctionsRuntimeResult {
  if (!record(value)
    || !exactKeys(value, [
      "becameActive", "captureId", "contentSha256", "failureCodes",
      "generationId", "schemaVersion", "sourceState",
    ])
    || value.schemaVersion !== "sutra.dcf-step-functions-runtime-result.v1"
    || typeof value.generationId !== "string"
    || !GENERATION_ID.test(value.generationId)
    || typeof value.contentSha256 !== "string"
    || !SHA256.test(value.contentSha256)
    || value.generationId !== `dcg_${value.contentSha256}`
    || typeof value.captureId !== "string"
    || !CAPTURE_ID.test(value.captureId)
    || !new Set(["READY", "PARTIAL", "STALE", "UNAVAILABLE"]).has(value.sourceState as string)
    || !Array.isArray(value.failureCodes)
    || value.failureCodes.some((code) => typeof code !== "string"
      || !FAILURE_CODES.has(code as DcfStepFunctionsFailureCode))
    || new Set(value.failureCodes).size !== value.failureCodes.length
    || JSON.stringify([...value.failureCodes].sort()) !== JSON.stringify(value.failureCodes)
    || typeof value.becameActive !== "boolean") {
    return false;
  }
  return (value.sourceState === "READY" || value.sourceState === "STALE")
    ? true
    : value.becameActive === false;
}

function validClaim(value: unknown): value is DcfStepFunctionsReplayClaim {
  if (!record(value) || typeof value.state !== "string") return false;
  if (value.state === "IN_PROGRESS") return exactKeys(value, ["state"]);
  if (value.state === "ACQUIRED") {
    return exactKeys(value, ["leaseToken", "state"])
      && typeof value.leaseToken === "string"
      && LEASE_TOKEN.test(value.leaseToken);
  }
  return value.state === "COMPLETED"
    && exactKeys(value, ["result", "resultSha256", "state"])
    && validResult(value.result)
    && typeof value.resultSha256 === "string"
    && SHA256.test(value.resultSha256);
}

async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(hash)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function parseJob(job: RunnableJob): {
  readonly scope: DcfStepFunctionsRuntimeScope;
  readonly scheduledWindow: string;
} {
  const unknownJob: unknown = job;
  if (!record(unknownJob)
    || !exactKeys(unknownJob, [
      "attempt", "connectionId", "customerId", "id", "kind", "maxAttempts",
      "orgId", "payload",
    ])
    || job.kind !== DCF_STEP_FUNCTIONS_RUNTIME_JOB_KIND
    || !JOB_ID.test(job.id)
    || !IDENTIFIER.test(job.orgId)
    || job.customerId === null
    || !IDENTIFIER.test(job.customerId)
    || job.connectionId === null
    || !CONNECTION_ID.test(job.connectionId)
    || !Number.isSafeInteger(job.attempt)
    || job.attempt < 1
    || job.attempt > 5
    || job.maxAttempts !== 5
    || !record(job.payload)
    || !exactKeys(job.payload, ["scheduledWindow"])
    || typeof job.payload.scheduledWindow !== "string"
    || !validWindow(job.payload.scheduledWindow)) {
    reject("INVALID_JOB");
  }
  return {
    scope: {
      organizationId: job.orgId,
      customerId: job.customerId,
      connectionId: job.connectionId,
    },
    scheduledWindow: job.payload.scheduledWindow,
  };
}

export function dcfStepFunctionsCollectionWindow(nowMs = Date.now()): string {
  if (!Number.isSafeInteger(nowMs)
    || nowMs < 0
    || nowMs > 8_640_000_000_000_000) reject("INVALID_JOB");
  return new Date(Math.floor(nowMs / 3_600_000) * 3_600_000).toISOString();
}

export function dcfStepFunctionsIdempotencyKey(
  scope: DcfStepFunctionsRuntimeScope,
  scheduledWindow: string,
): string {
  if (!validScope(scope) || !validWindow(scheduledWindow)) reject("INVALID_JOB");
  return `dcf-step-functions:${[
    scope.organizationId,
    scope.customerId,
    scope.connectionId,
    scheduledWindow,
  ].map(encodeURIComponent).join(":")}`;
}

export async function scheduleDcfStepFunctionsCollections(input: {
  readonly scheduledWindow: string;
  readonly loadEligibleScopes: () => Promise<readonly DcfStepFunctionsRuntimeScope[]>;
  readonly queue: DcfStepFunctionsRuntimeQueue;
}): Promise<{ readonly enqueued: number }> {
  if (!validWindow(input.scheduledWindow)) reject("INVALID_JOB");
  const scopes = [...await input.loadEligibleScopes()]
    .sort((left, right) => left.connectionId.localeCompare(right.connectionId));
  if (scopes.length > 10_000) reject("INVALID_JOB");
  const seen = new Set<string>();
  for (const scope of scopes) {
    const identity = JSON.stringify(scope);
    if (!validScope(scope) || seen.has(identity)) reject("INVALID_JOB");
    seen.add(identity);
    await input.queue.enqueue({
      orgId: scope.organizationId,
      customerId: scope.customerId,
      connectionId: scope.connectionId,
      kind: DCF_STEP_FUNCTIONS_RUNTIME_JOB_KIND,
      payload: Object.freeze({ scheduledWindow: input.scheduledWindow }),
      maxAttempts: 5,
      idempotencyKey: dcfStepFunctionsIdempotencyKey(scope, input.scheduledWindow),
    });
  }
  return { enqueued: scopes.length };
}

export async function runDcfStepFunctionsRuntimeHandler(
  job: RunnableJob,
  dependencies: DcfStepFunctionsRuntimeDependencies,
): Promise<DcfStepFunctionsRuntimeDisposition> {
  const parsed = parseJob(job);
  const key = dcfStepFunctionsIdempotencyKey(parsed.scope, parsed.scheduledWindow);
  let claim: DcfStepFunctionsReplayClaim;
  try {
    const received: unknown = await dependencies.replayStore.claim({
      key,
      jobId: job.id,
      leaseDurationMs: 960_000,
    });
    if (!validClaim(received)) reject("COLLECTION_FAILED");
    claim = received;
  } catch {
    reject("COLLECTION_FAILED");
  }
  if (claim.state === "COMPLETED") {
    if (await digest(claim.result) !== claim.resultSha256) reject("COLLECTION_FAILED");
    return { disposition: "REPLAYED", result: claim.result };
  }
  if (claim.state === "IN_PROGRESS") {
    return { disposition: "IN_PROGRESS", result: null };
  }

  try {
    const boundary = await dependencies.loadBoundary(parsed.scope);
    if (boundary.scope.orgId !== parsed.scope.organizationId
      || boundary.scope.customerId !== parsed.scope.customerId
      || boundary.scope.connectionId !== parsed.scope.connectionId) {
      reject("COLLECTION_FAILED");
    }
    const collected = await dependencies.adapter.collect(boundary, new AbortController().signal);
    const stored = await dependencies.record(parsed.scope, boundary.scope, collected.capture);
    const expectedSnapshot = normalizeDcfCapture(
      collected.capture,
      boundary.scope,
      Date.parse(collected.capture.completedAt),
    );
    if (!GENERATION_ID.test(stored.generationId)
      || !SHA256.test(stored.contentSha256)
      || stored.generationId !== `dcg_${stored.contentSha256}`
      || JSON.stringify(stored.snapshot) !== JSON.stringify(expectedSnapshot)
      || await digest(stored.snapshot) !== stored.contentSha256
      || stored.snapshot.captureId !== collected.capture.captureId
      || stored.snapshot.complete
        !== (collected.sourceState === "READY" || collected.sourceState === "STALE")
      || stored.becameActive
        && collected.sourceState !== "READY" && collected.sourceState !== "STALE") {
      reject("COLLECTION_FAILED");
    }
    const result: DcfStepFunctionsRuntimeResult = {
      schemaVersion: "sutra.dcf-step-functions-runtime-result.v1",
      generationId: stored.generationId,
      contentSha256: stored.contentSha256,
      captureId: collected.capture.captureId,
      sourceState: collected.sourceState,
      failureCodes: [...collected.failureCodes].sort(),
      becameActive: stored.becameActive,
    };
    if (!validResult(result)) reject("COLLECTION_FAILED");
    await dependencies.replayStore.complete({
      key,
      jobId: job.id,
      leaseToken: claim.leaseToken,
      result,
      resultSha256: await digest(result),
    });
    return { disposition: "EXECUTED", result };
  } catch {
    try {
      await dependencies.replayStore.fail({
        key,
        jobId: job.id,
        leaseToken: claim.leaseToken,
        failureCode: "DCF_STEP_FUNCTIONS_COLLECTION_FAILED",
      });
    } catch {
      // Keep secondary replay-store details out of the durable queue error.
    }
    reject("COLLECTION_FAILED");
  }
}

export function createDcfStepFunctionsRuntimeJobHandler(
  dependencies: DcfStepFunctionsRuntimeDependencies,
): JobHandler {
  return async (job) => { await runDcfStepFunctionsRuntimeHandler(job, dependencies); };
}

export const DCF_STEP_FUNCTIONS_RUNTIME_BINDING = Object.freeze({
  jobKind: DCF_STEP_FUNCTIONS_RUNTIME_JOB_KIND,
  cadence: DCF_STEP_FUNCTIONS_RUNTIME_CADENCE,
  handlerFactory: createDcfStepFunctionsRuntimeJobHandler,
  scheduler: scheduleDcfStepFunctionsCollections,
  registeredInSharedRuntime: false,
  activationReason: DCF_STEP_FUNCTIONS_RUNTIME_ACTIVATION_REASON,
});
