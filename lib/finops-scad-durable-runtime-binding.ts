/** Durable daily scheduler and replay-safe handler for the SCAD CUR2 adapter. */
import type { JobHandler, RunnableJob } from "./background-job-runner.ts";
import type { ScadPersistenceScope, StoredScadSnapshot } from "../db/finops-scad-allocation-repository.ts";
import { buildScadAllocationSnapshot, type ScadCapture } from "./finops-scad-allocation.ts";
import {
  ScadCur2RuntimeAdapter,
  ScadCur2RuntimeError,
  type ScadCur2RuntimeBoundary,
  type ScadCur2RuntimeFailureCode,
} from "./finops-scad-cur2-runtime-adapter.ts";

export const SCAD_CUR2_RUNTIME_JOB_KIND = "finops.scad-cur2.materialize" as const;
export const SCAD_CUR2_RUNTIME_CADENCE = "rate(1 day)" as const;
export const SCAD_CUR2_RUNTIME_ACTIVATION_REASON =
  "SCAD_CUR2_MATERIALIZER_JOB_HANDLER_NOT_REGISTERED" as const;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const JOB = /^job_[a-f0-9]{32}$/u;
const LEASE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const GENERATION = /^scg_[a-f0-9]{64}$/u;
const ACTIVE_GENERATION = /^fbg_[a-f0-9]{64}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const FAILURE_CODES = new Set<ScadCur2RuntimeFailureCode>([
  "AUTHORIZATION_FAILED", "SOURCE_UNAVAILABLE", "THROTTLED", "TIMEOUT",
  "SCHEMA_MISMATCH", "SCOPE_MISMATCH", "OBJECT_CHANGED",
  "PAGINATION_INVALID", "LIMIT_REACHED", "INTERNAL_ERROR",
]);

export type ScadCur2RuntimeScope = ScadPersistenceScope;

export interface ScadCur2RuntimeQueue {
  enqueue(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly kind: typeof SCAD_CUR2_RUNTIME_JOB_KIND;
    readonly payload: { readonly scheduledWindow: string };
    readonly maxAttempts: 5;
    readonly idempotencyKey: string;
  }): Promise<unknown>;
}

export type ScadCur2RuntimeResult =
  | {
    readonly schemaVersion: "sutra.scad-cur2-runtime-result.v1";
    readonly sourceState: "READY" | "PARTIAL" | "STALE" | "NO_USAGE" | "CONFIGURATION_REQUIRED" | "WAITING_FIRST_DELIVERY";
    readonly generationId: string;
    readonly contentSha256: string;
    readonly activeGenerationId: string;
    readonly becameActive: boolean;
    readonly failureCodes: readonly ScadCur2RuntimeFailureCode[];
  }
  | {
    readonly schemaVersion: "sutra.scad-cur2-runtime-result.v1";
    readonly sourceState: "DUPLICATE" | "UNAVAILABLE";
    readonly generationId: null;
    readonly contentSha256: null;
    readonly activeGenerationId: string | null;
    readonly becameActive: false;
    readonly failureCodes: readonly ScadCur2RuntimeFailureCode[];
  };

export type ScadCur2ReplayClaim =
  | { readonly state: "ACQUIRED"; readonly leaseToken: string }
  | { readonly state: "IN_PROGRESS" }
  | { readonly state: "COMPLETED"; readonly result: ScadCur2RuntimeResult; readonly resultSha256: string };

export interface ScadCur2ReplayStore {
  claim(input: { readonly key: string; readonly jobId: string; readonly leaseDurationMs: 1_860_000 }): Promise<ScadCur2ReplayClaim>;
  complete(input: { readonly key: string; readonly jobId: string; readonly leaseToken: string;
    readonly result: ScadCur2RuntimeResult; readonly resultSha256: string }): Promise<void>;
  fail(input: { readonly key: string; readonly jobId: string; readonly leaseToken: string;
    readonly failureCode: "SCAD_CUR2_RUNTIME_FAILED" }): Promise<void>;
}

export interface ScadCur2RuntimeDependencies {
  readonly loadBoundary: (scope: ScadCur2RuntimeScope) => Promise<ScadCur2RuntimeBoundary>;
  readonly adapter: Pick<ScadCur2RuntimeAdapter, "collectGeneration">;
  readonly record: (scope: ScadPersistenceScope, trusted: ScadCur2RuntimeBoundary["scope"],
    capture: ScadCapture,
    nowMs: number) => Promise<{ readonly snapshot: StoredScadSnapshot; readonly becameActive: boolean }>;
  readonly replayStore: ScadCur2ReplayStore;
  readonly now?: () => number;
}

export type ScadCur2RuntimeDisposition =
  | { readonly disposition: "EXECUTED" | "REPLAYED"; readonly result: ScadCur2RuntimeResult }
  | { readonly disposition: "IN_PROGRESS"; readonly result: null };

export class ScadCur2DurableRuntimeError extends Error {
  public readonly code: "INVALID_JOB" | "RUNTIME_FAILED";
  public constructor(code: ScadCur2DurableRuntimeError["code"]) {
    super(code === "INVALID_JOB" ? "SCAD CUR2 job was rejected" : "SCAD CUR2 runtime failed");
    this.name = "ScadCur2DurableRuntimeError";
    this.code = code;
  }
}

function reject(code: ScadCur2DurableRuntimeError["code"]): never {
  throw new ScadCur2DurableRuntimeError(code);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function validScope(value: ScadCur2RuntimeScope): boolean {
  return IDENTIFIER.test(value.organizationId) && IDENTIFIER.test(value.customerId)
    && CONNECTION.test(value.connectionId);
}
function validWindow(value: string): boolean {
  return WINDOW.test(value) && new Date(Date.parse(value)).toISOString() === value;
}
function freezeBoundary(value: ScadCur2RuntimeBoundary): ScadCur2RuntimeBoundary {
  return Object.freeze({
    ...value,
    scope: Object.freeze({
      ...value.scope,
      payerAccountIds: Object.freeze([...value.scope.payerAccountIds]),
      usageAccountIds: Object.freeze([...value.scope.usageAccountIds]),
      regions: Object.freeze([...value.scope.regions]),
    }),
    tableConfiguration: Object.freeze({ ...value.tableConfiguration }),
  });
}
async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(hash)].map((part) => part.toString(16).padStart(2, "0")).join("");
}
function validResult(value: unknown): value is ScadCur2RuntimeResult {
  if (!record(value) || !exactKeys(value, ["activeGenerationId", "becameActive", "contentSha256",
    "failureCodes", "generationId", "schemaVersion", "sourceState"])
    || value.schemaVersion !== "sutra.scad-cur2-runtime-result.v1"
    || !Array.isArray(value.failureCodes)
    || value.failureCodes.some((item) => typeof item !== "string"
      || !FAILURE_CODES.has(item as ScadCur2RuntimeFailureCode))
    || JSON.stringify([...value.failureCodes].sort()) !== JSON.stringify(value.failureCodes)
    || new Set(value.failureCodes).size !== value.failureCodes.length
    || typeof value.becameActive !== "boolean") return false;
  if (value.sourceState === "DUPLICATE") return value.generationId === null
    && value.contentSha256 === null && value.becameActive === false
    && typeof value.activeGenerationId === "string" && ACTIVE_GENERATION.test(value.activeGenerationId);
  if (value.sourceState === "UNAVAILABLE") return value.generationId === null
    && value.contentSha256 === null && value.activeGenerationId === null
    && value.becameActive === false && value.failureCodes.length === 1;
  return new Set(["READY", "PARTIAL", "STALE", "NO_USAGE", "CONFIGURATION_REQUIRED",
    "WAITING_FIRST_DELIVERY"]).has(String(value.sourceState))
    && typeof value.generationId === "string" && GENERATION.test(value.generationId)
    && typeof value.contentSha256 === "string" && SHA.test(value.contentSha256)
    && value.generationId === `scg_${value.contentSha256}`
    && typeof value.activeGenerationId === "string" && ACTIVE_GENERATION.test(value.activeGenerationId)
    && (value.becameActive === false || ["READY", "STALE", "NO_USAGE"].includes(String(value.sourceState)));
}
function validClaim(value: unknown): value is ScadCur2ReplayClaim {
  if (!record(value) || typeof value.state !== "string") return false;
  if (value.state === "IN_PROGRESS") return exactKeys(value, ["state"]);
  if (value.state === "ACQUIRED") return exactKeys(value, ["leaseToken", "state"])
    && typeof value.leaseToken === "string" && LEASE.test(value.leaseToken);
  return value.state === "COMPLETED" && exactKeys(value, ["result", "resultSha256", "state"])
    && validResult(value.result) && typeof value.resultSha256 === "string" && SHA.test(value.resultSha256);
}

function parseJob(job: RunnableJob): { readonly scope: ScadCur2RuntimeScope; readonly scheduledWindow: string } {
  const value: unknown = job;
  if (!record(value) || !exactKeys(value, ["attempt", "connectionId", "customerId", "id", "kind",
    "maxAttempts", "orgId", "payload"]) || job.kind !== SCAD_CUR2_RUNTIME_JOB_KIND
    || !JOB.test(job.id) || !IDENTIFIER.test(job.orgId) || job.customerId === null
    || !IDENTIFIER.test(job.customerId) || job.connectionId === null || !CONNECTION.test(job.connectionId)
    || !Number.isSafeInteger(job.attempt) || job.attempt < 1 || job.attempt > 5 || job.maxAttempts !== 5
    || !record(job.payload) || !exactKeys(job.payload, ["scheduledWindow"])
    || typeof job.payload.scheduledWindow !== "string" || !validWindow(job.payload.scheduledWindow)) reject("INVALID_JOB");
  return { scope: { organizationId: job.orgId, customerId: job.customerId,
    connectionId: job.connectionId }, scheduledWindow: job.payload.scheduledWindow };
}

export function scadCur2CollectionWindow(nowMs = Date.now()): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 8_640_000_000_000_000) reject("INVALID_JOB");
  return new Date(Math.floor(nowMs / 86_400_000) * 86_400_000).toISOString();
}
export function scadCur2IdempotencyKey(scope: ScadCur2RuntimeScope, window: string): string {
  if (!validScope(scope) || !validWindow(window)) reject("INVALID_JOB");
  return `scad-cur2:${[scope.organizationId, scope.customerId, scope.connectionId, window]
    .map(encodeURIComponent).join(":")}`;
}
export async function scheduleScadCur2Collections(input: {
  readonly scheduledWindow: string;
  readonly loadEligibleScopes: () => Promise<readonly ScadCur2RuntimeScope[]>;
  readonly queue: ScadCur2RuntimeQueue;
}): Promise<{ readonly enqueued: number }> {
  if (!validWindow(input.scheduledWindow)) reject("INVALID_JOB");
  const scopes = [...await input.loadEligibleScopes()].sort((a, b) => a.connectionId.localeCompare(b.connectionId));
  if (scopes.length > 10_000) reject("INVALID_JOB");
  const seen = new Set<string>();
  for (const scope of scopes) {
    const key = JSON.stringify(scope);
    if (!validScope(scope) || seen.has(key)) reject("INVALID_JOB");
    seen.add(key);
    await input.queue.enqueue({ orgId: scope.organizationId, customerId: scope.customerId,
      connectionId: scope.connectionId, kind: SCAD_CUR2_RUNTIME_JOB_KIND,
      payload: { scheduledWindow: input.scheduledWindow }, maxAttempts: 5,
      idempotencyKey: scadCur2IdempotencyKey(scope, input.scheduledWindow) });
  }
  return { enqueued: scopes.length };
}

export async function runScadCur2RuntimeHandler(job: RunnableJob,
  dependencies: ScadCur2RuntimeDependencies): Promise<ScadCur2RuntimeDisposition> {
  const parsed = parseJob(job);
  const key = scadCur2IdempotencyKey(parsed.scope, parsed.scheduledWindow);
  let claim: ScadCur2ReplayClaim;
  try {
    const received: unknown = await dependencies.replayStore.claim({ key, jobId: job.id, leaseDurationMs: 1_860_000 });
    if (!validClaim(received)) reject("RUNTIME_FAILED");
    claim = received;
  } catch { reject("RUNTIME_FAILED"); }
  if (claim.state === "IN_PROGRESS") return { disposition: "IN_PROGRESS", result: null };
  if (claim.state === "COMPLETED") {
    if (await digest(claim.result) !== claim.resultSha256) reject("RUNTIME_FAILED");
    return { disposition: "REPLAYED", result: claim.result };
  }
  try {
    const loadedBoundary = await dependencies.loadBoundary(parsed.scope);
    if (loadedBoundary.scope.orgId !== parsed.scope.organizationId
      || loadedBoundary.scope.customerId !== parsed.scope.customerId
      || loadedBoundary.scope.connectionId !== parsed.scope.connectionId) reject("RUNTIME_FAILED");
    const boundary = freezeBoundary(loadedBoundary);
    let result: ScadCur2RuntimeResult;
    try {
      const collected = await dependencies.adapter.collectGeneration(boundary, new AbortController().signal);
      if (collected.disposition === "DUPLICATE") {
        result = { schemaVersion: "sutra.scad-cur2-runtime-result.v1", sourceState: "DUPLICATE",
          generationId: null, contentSha256: null, activeGenerationId: collected.activeGenerationId,
          becameActive: false, failureCodes: [] };
      } else {
        const nowMs = dependencies.now?.() ?? Date.parse(collected.capture.completedAt);
        const stored = await dependencies.record(parsed.scope, boundary.scope, collected.capture, nowMs);
        const expected = buildScadAllocationSnapshot(collected.capture, boundary.scope, nowMs);
        if (JSON.stringify(stored.snapshot.snapshot) !== JSON.stringify(expected)
          || await digest(stored.snapshot.snapshot) !== stored.snapshot.contentSha256
          || stored.snapshot.generationId !== `scg_${stored.snapshot.contentSha256}`
          || stored.becameActive && !expected.complete) reject("RUNTIME_FAILED");
        result = { schemaVersion: "sutra.scad-cur2-runtime-result.v1", sourceState: expected.state,
          generationId: stored.snapshot.generationId, contentSha256: stored.snapshot.contentSha256,
          activeGenerationId: collected.capture.activeGenerationId,
          becameActive: stored.becameActive, failureCodes: [...collected.failureCodes].sort() };
      }
    } catch (error) {
      if (!(error instanceof ScadCur2RuntimeError) || error.code === "INVALID_BOUNDARY"
        || error.code === "DUPLICATE_GENERATION") throw error;
      result = { schemaVersion: "sutra.scad-cur2-runtime-result.v1", sourceState: "UNAVAILABLE",
        generationId: null, contentSha256: null, activeGenerationId: null,
        becameActive: false, failureCodes: [error.code] };
    }
    if (!validResult(result)) reject("RUNTIME_FAILED");
    await dependencies.replayStore.complete({ key, jobId: job.id, leaseToken: claim.leaseToken,
      result, resultSha256: await digest(result) });
    return { disposition: "EXECUTED", result };
  } catch {
    try { await dependencies.replayStore.fail({ key, jobId: job.id, leaseToken: claim.leaseToken,
      failureCode: "SCAD_CUR2_RUNTIME_FAILED" }); } catch { /* preserve the primary failure */ }
    reject("RUNTIME_FAILED");
  }
}

export function createScadCur2RuntimeJobHandler(dependencies: ScadCur2RuntimeDependencies): JobHandler {
  return async (job) => { await runScadCur2RuntimeHandler(job, dependencies); };
}
export const SCAD_CUR2_RUNTIME_BINDING = Object.freeze({ jobKind: SCAD_CUR2_RUNTIME_JOB_KIND,
  cadence: SCAD_CUR2_RUNTIME_CADENCE, scheduler: scheduleScadCur2Collections,
  handlerFactory: createScadCur2RuntimeJobHandler, registeredInSharedRuntime: false,
  activationReason: SCAD_CUR2_RUNTIME_ACTIVATION_REASON });
