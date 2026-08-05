/** Durable daily scheduler/replay boundary for the provider-specific Azure CID. */
import type { JobHandler, RunnableJob } from "./background-job-runner.ts";
import {
  runAzureCidCollectionJob,
  type AzureCidBroker,
  type AzureCidStore,
} from "./finops-azure-cid-collector-job.ts";
import type { AzureCidScope } from "./finops-azure-cid.ts";
import type { AzureCidPersistenceScope } from "../db/finops-azure-cid-repository.ts";

export const AZURE_CID_RUNTIME_JOB_KIND = "finops-azure-cid-collect" as const;
export const AZURE_CID_RUNTIME_CADENCE = "rate(1 day)" as const;
export const AZURE_CID_RUNTIME_ACTIVATION_REASON =
  "AZURE_EXPORT_ADAPTER_NOT_DEPLOYED" as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const SOURCE = /^azsrc_[a-f0-9]{32}$/u;
const JOB = /^job_[a-f0-9]{32}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const GENERATION = /^azcg_[a-f0-9]{64}$/u;
const SOURCE_GENERATION = /^azcid_[a-f0-9]{64}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const LEASE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const MAX_SOURCES = 10_000;

export interface AzureCidRuntimeQueue {
  enqueue(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly kind: typeof AZURE_CID_RUNTIME_JOB_KIND;
    readonly payload: { readonly sourceId: string; readonly scheduledWindow: string };
    readonly maxAttempts: 5;
    readonly idempotencyKey: string;
  }): Promise<unknown>;
}

export interface AzureCidRuntimeResult {
  readonly generationId: string;
  readonly sourceGenerationId: string;
  readonly state: "READY" | "EMPTY" | "PARTIAL" | "STALE";
  readonly becameActive: boolean;
}

export type AzureCidReplayClaim =
  | { readonly state: "ACQUIRED"; readonly leaseToken: string }
  | { readonly state: "IN_PROGRESS" }
  | { readonly state: "COMPLETED"; readonly result: AzureCidRuntimeResult; readonly resultSha256: string };

export interface AzureCidReplayStore {
  claim(input: { readonly key: string; readonly jobId: string; readonly leaseDurationMs: number }): Promise<AzureCidReplayClaim>;
  complete(input: { readonly key: string; readonly jobId: string; readonly leaseToken: string; readonly result: AzureCidRuntimeResult; readonly resultSha256: string }): Promise<void>;
  fail(input: { readonly key: string; readonly jobId: string; readonly leaseToken: string; readonly failureCode: "AZURE_CID_COLLECTION_FAILED" }): Promise<void>;
}

export interface AzureCidRuntimeDependencies {
  readonly loadScope: (scope: AzureCidPersistenceScope) => Promise<AzureCidScope>;
  readonly broker: AzureCidBroker | null;
  readonly store: AzureCidStore;
  readonly replayStore: AzureCidReplayStore;
  readonly now?: () => number;
}

export type AzureCidRuntimeDisposition =
  | { readonly disposition: "EXECUTED" | "REPLAYED"; readonly result: AzureCidRuntimeResult }
  | { readonly disposition: "IN_PROGRESS" | "CONFIGURATION_REQUIRED"; readonly result: null; readonly reason: string };

export class AzureCidRuntimeBindingError extends Error {
  public readonly code: "INVALID_JOB" | "SCOPE_REJECTED" | "COLLECTION_FAILED";
  public constructor(code: AzureCidRuntimeBindingError["code"]) {
    super("Azure CID runtime collection failed");
    this.name = "AzureCidRuntimeBindingError";
    this.code = code;
  }
}

function reject(code: AzureCidRuntimeBindingError["code"]): never {
  throw new AzureCidRuntimeBindingError(code);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function validWindow(value: unknown): value is string {
  return typeof value === "string" && WINDOW.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function validPersistenceScope(value: unknown): value is AzureCidPersistenceScope {
  if (!record(value) || !exact(value, ["customerId", "organizationId", "sourceId"])) return false;
  return typeof value.organizationId === "string" && ID.test(value.organizationId)
    && typeof value.customerId === "string" && ID.test(value.customerId)
    && typeof value.sourceId === "string" && SOURCE.test(value.sourceId);
}

function validBoundary(value: unknown, expected: AzureCidPersistenceScope): value is AzureCidScope {
  if (!record(value) || !exact(value, ["azureTenantId", "billingScopeHash", "billingScopeKind", "customerId", "orgId", "sourceId"])) return false;
  return value.orgId === expected.organizationId && value.customerId === expected.customerId
    && value.sourceId === expected.sourceId
    && typeof value.azureTenantId === "string" && UUID.test(value.azureTenantId)
    && typeof value.billingScopeHash === "string" && SHA256.test(value.billingScopeHash)
    && typeof value.billingScopeKind === "string"
    && ["BILLING_ACCOUNT", "BILLING_PROFILE", "MANAGEMENT_GROUP", "SUBSCRIPTION"].includes(value.billingScopeKind);
}

function validResult(value: unknown): value is AzureCidRuntimeResult {
  if (!record(value) || !exact(value, ["becameActive", "generationId", "sourceGenerationId", "state"])) return false;
  return typeof value.generationId === "string" && GENERATION.test(value.generationId)
    && typeof value.sourceGenerationId === "string" && SOURCE_GENERATION.test(value.sourceGenerationId)
    && typeof value.state === "string" && ["READY", "EMPTY", "PARTIAL", "STALE"].includes(value.state)
    && typeof value.becameActive === "boolean";
}

function validClaim(value: unknown): value is AzureCidReplayClaim {
  if (!record(value) || typeof value.state !== "string") return false;
  if (value.state === "IN_PROGRESS") return exact(value, ["state"]);
  if (value.state === "ACQUIRED") return exact(value, ["leaseToken", "state"])
    && typeof value.leaseToken === "string" && LEASE.test(value.leaseToken);
  return value.state === "COMPLETED" && exact(value, ["result", "resultSha256", "state"])
    && validResult(value.result) && typeof value.resultSha256 === "string" && SHA256.test(value.resultSha256);
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function parseJob(job: RunnableJob): { readonly scope: AzureCidPersistenceScope; readonly scheduledWindow: string } {
  if (job.kind !== AZURE_CID_RUNTIME_JOB_KIND || !JOB.test(job.id) || !ID.test(job.orgId)
    || job.customerId === null || !ID.test(job.customerId) || job.connectionId !== null
    || !Number.isSafeInteger(job.attempt) || job.attempt < 1 || job.attempt > 5 || job.maxAttempts !== 5
    || !record(job.payload) || !exact(job.payload, ["scheduledWindow", "sourceId"])
    || typeof job.payload.sourceId !== "string" || !SOURCE.test(job.payload.sourceId)
    || !validWindow(job.payload.scheduledWindow)) reject("INVALID_JOB");
  return {
    scope: { organizationId: job.orgId, customerId: job.customerId, sourceId: job.payload.sourceId },
    scheduledWindow: job.payload.scheduledWindow,
  };
}

function idempotencyKey(scope: AzureCidPersistenceScope, scheduledWindow: string): string {
  if (!validPersistenceScope(scope) || !validWindow(scheduledWindow)) reject("INVALID_JOB");
  return `azure-cid:${[scope.organizationId, scope.customerId, scope.sourceId, scheduledWindow]
    .map(encodeURIComponent).join(":")}`;
}

export function azureCidCollectionWindow(nowMs = Date.now()): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) reject("INVALID_JOB");
  const value = new Date(nowMs);
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())).toISOString();
}

export async function scheduleAzureCidCollections(input: {
  readonly scheduledWindow: string;
  readonly loadEligibleSources: () => Promise<readonly AzureCidPersistenceScope[]>;
  readonly queue: AzureCidRuntimeQueue;
}): Promise<number> {
  if (!validWindow(input.scheduledWindow)) reject("INVALID_JOB");
  const received = await input.loadEligibleSources();
  if (!Array.isArray(received) || received.length > MAX_SOURCES) reject("SCOPE_REJECTED");
  const sources = [...received];
  const seen = new Set<string>();
  for (const scope of sources) {
    if (!validPersistenceScope(scope) || seen.has(scope.sourceId)) reject("SCOPE_REJECTED");
    seen.add(scope.sourceId);
  }
  sources.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  for (const scope of sources) {
    await input.queue.enqueue({
      orgId: scope.organizationId,
      customerId: scope.customerId,
      kind: AZURE_CID_RUNTIME_JOB_KIND,
      payload: Object.freeze({ sourceId: scope.sourceId, scheduledWindow: input.scheduledWindow }),
      maxAttempts: 5,
      idempotencyKey: idempotencyKey(scope, input.scheduledWindow),
    });
  }
  return sources.length;
}

export async function runAzureCidRuntimeJob(
  job: RunnableJob,
  dependencies: AzureCidRuntimeDependencies,
): Promise<AzureCidRuntimeDisposition> {
  const parsed = parseJob(job);
  let boundary: AzureCidScope;
  try {
    const received: unknown = await dependencies.loadScope(parsed.scope);
    if (!validBoundary(received, parsed.scope)) reject("SCOPE_REJECTED");
    boundary = received;
  } catch (error) {
    if (error instanceof AzureCidRuntimeBindingError) throw error;
    reject("SCOPE_REJECTED");
  }
  if (dependencies.broker === null) return {
    disposition: "CONFIGURATION_REQUIRED",
    result: null,
    reason: AZURE_CID_RUNTIME_ACTIVATION_REASON,
  };
  const key = idempotencyKey(parsed.scope, parsed.scheduledWindow);
  let claim: AzureCidReplayClaim;
  try {
    const received: unknown = await dependencies.replayStore.claim({ key, jobId: job.id, leaseDurationMs: 16 * 60_000 });
    if (!validClaim(received)) reject("COLLECTION_FAILED");
    claim = received;
  } catch (error) {
    if (error instanceof AzureCidRuntimeBindingError) throw error;
    reject("COLLECTION_FAILED");
  }
  if (claim.state === "IN_PROGRESS") return { disposition: "IN_PROGRESS", result: null, reason: "AZURE_CID_COLLECTION_IN_PROGRESS" };
  if (claim.state === "COMPLETED") {
    if (await sha256(claim.result) !== claim.resultSha256) reject("COLLECTION_FAILED");
    return { disposition: "REPLAYED", result: claim.result };
  }
  try {
    const result = await runAzureCidCollectionJob({
      scope: boundary,
      broker: dependencies.broker,
      store: dependencies.store,
      nowMs: dependencies.now?.() ?? Date.now(),
    });
    if (!validResult(result)) reject("COLLECTION_FAILED");
    await dependencies.replayStore.complete({ key, jobId: job.id, leaseToken: claim.leaseToken,
      result, resultSha256: await sha256(result) });
    return { disposition: "EXECUTED", result };
  } catch {
    try {
      await dependencies.replayStore.fail({ key, jobId: job.id, leaseToken: claim.leaseToken,
        failureCode: "AZURE_CID_COLLECTION_FAILED" });
    } catch { /* Preserve the provider-neutral primary error. */ }
    reject("COLLECTION_FAILED");
  }
}

export function createAzureCidRuntimeHandler(dependencies: AzureCidRuntimeDependencies): JobHandler {
  return async (job) => {
    const result = await runAzureCidRuntimeJob(job, dependencies);
    if (result.disposition === "IN_PROGRESS") reject("COLLECTION_FAILED");
  };
}

export const AZURE_CID_RUNTIME_BINDING = Object.freeze({
  jobKind: AZURE_CID_RUNTIME_JOB_KIND,
  cadence: AZURE_CID_RUNTIME_CADENCE,
  scheduler: scheduleAzureCidCollections,
  handlerFactory: createAzureCidRuntimeHandler,
  registeredInSharedRuntime: false,
  activationReason: AZURE_CID_RUNTIME_ACTIVATION_REASON,
});
