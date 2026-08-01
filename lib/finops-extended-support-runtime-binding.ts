/**
 * Durable, replay-safe activation boundary for ADV-04 Extended Support.
 *
 * Queue payloads contain only a server-owned daily window. Every AWS account,
 * Region, operation, calendar, pricing and CUR2 coordinate is reloaded from
 * trusted tenant state before the signed collector can run.
 */
import type { JobHandler, RunnableJob } from "./background-job-runner.ts";
import {
  runExtendedSupportCollectionJob,
  type ExtendedSupportCaptureStore,
  type ExtendedSupportSignedBroker,
} from "./finops-extended-support-collector-job.ts";
import {
  EXTENDED_SUPPORT_PROJECTION_BOUNDS,
  type ExtendedSupportTenantBoundary,
} from "./finops-extended-support-projection.ts";
import type { ExtendedSupportPersistenceScope } from "../db/finops-extended-support-repository.ts";

export const EXTENDED_SUPPORT_RUNTIME_JOB_KIND =
  "finops-extended-support-daily-collect" as const;
export const EXTENDED_SUPPORT_RUNTIME_CADENCE = "rate(1 day)" as const;
export const EXTENDED_SUPPORT_RUNTIME_ACTIVATION_REASON =
  "EXTENDED_SUPPORT_DURABLE_RUNTIME_NOT_REGISTERED" as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const JOB = /^job_[a-f0-9]{32}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const ACCOUNT = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const GENERATION = /^espg_[a-f0-9]{64}$/u;
const COLLECTION = /^esp_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const LEASE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const MAX_CONNECTIONS = 10_000;

export interface ExtendedSupportRuntimeQueue {
  enqueue(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly kind: typeof EXTENDED_SUPPORT_RUNTIME_JOB_KIND;
    readonly payload: { readonly scheduledWindow: string };
    readonly maxAttempts: 5;
    readonly idempotencyKey: string;
  }): Promise<unknown>;
}

export interface ExtendedSupportRuntimeResult {
  readonly generationId: string;
  readonly collectionId: string;
  readonly state: "READY" | "PARTIAL" | "CONFIGURATION_REQUIRED";
  readonly becameActive: boolean;
}

export type ExtendedSupportReplayClaim =
  | { readonly state: "ACQUIRED"; readonly leaseToken: string }
  | { readonly state: "IN_PROGRESS" }
  | {
      readonly state: "COMPLETED";
      readonly result: ExtendedSupportRuntimeResult;
      readonly resultSha256: string;
    };

export interface ExtendedSupportReplayStore {
  claim(input: {
    readonly key: string;
    readonly jobId: string;
    readonly leaseDurationMs: number;
  }): Promise<ExtendedSupportReplayClaim>;
  complete(input: {
    readonly key: string;
    readonly jobId: string;
    readonly leaseToken: string;
    readonly result: ExtendedSupportRuntimeResult;
    readonly resultSha256: string;
  }): Promise<void>;
  fail(input: {
    readonly key: string;
    readonly jobId: string;
    readonly leaseToken: string;
    readonly failureCode: "EXTENDED_SUPPORT_COLLECTION_FAILED";
  }): Promise<void>;
}

export interface ExtendedSupportRuntimeDependencies {
  readonly loadBoundary: (
    scope: ExtendedSupportPersistenceScope,
  ) => Promise<ExtendedSupportTenantBoundary>;
  readonly broker: ExtendedSupportSignedBroker;
  readonly store: ExtendedSupportCaptureStore;
  readonly replayStore: ExtendedSupportReplayStore;
  readonly now?: () => number;
}

export type ExtendedSupportRuntimeDisposition =
  | { readonly disposition: "EXECUTED" | "REPLAYED"; readonly result: ExtendedSupportRuntimeResult }
  | { readonly disposition: "IN_PROGRESS"; readonly result: null };

export class ExtendedSupportRuntimeError extends Error {
  public readonly code: "INVALID_JOB" | "COLLECTION_FAILED";

  public constructor(code: ExtendedSupportRuntimeError["code"]) {
    super(code === "INVALID_JOB"
      ? "Extended Support runtime job rejected"
      : "Extended Support runtime collection failed");
    this.name = "ExtendedSupportRuntimeError";
    this.code = code;
  }
}

function invalid(): never {
  throw new ExtendedSupportRuntimeError("INVALID_JOB");
}

function failed(): never {
  throw new ExtendedSupportRuntimeError("COLLECTION_FAILED");
}

function validScope(scope: ExtendedSupportPersistenceScope): boolean {
  return ID.test(scope.organizationId) && ID.test(scope.customerId)
    && CONNECTION.test(scope.connectionId);
}

function validWindow(value: string): boolean {
  return WINDOW.test(value) && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function sortedUnique(values: readonly string[], pattern: RegExp, maximum: number): boolean {
  return values.length >= 1 && values.length <= maximum
    && values.every((value) => pattern.test(value))
    && JSON.stringify(values) === JSON.stringify([...new Set(values)].sort());
}

function validBoundary(
  value: ExtendedSupportTenantBoundary,
  scope: ExtendedSupportPersistenceScope,
): boolean {
  return value.scope.orgId === scope.organizationId
    && value.scope.customerId === scope.customerId
    && value.scope.connectionId === scope.connectionId
    && ACCOUNT.test(value.managementAccountId)
    && ["aws", "aws-cn", "aws-us-gov"].includes(value.partition)
    && sortedUnique(value.accountIds, ACCOUNT, EXTENDED_SUPPORT_PROJECTION_BOUNDS.maximumAccounts)
    && value.accountIds.includes(value.managementAccountId)
    && sortedUnique(value.regions, REGION, EXTENDED_SUPPORT_PROJECTION_BOUNDS.maximumRegions);
}

function validResult(value: unknown): value is ExtendedSupportRuntimeResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return Object.keys(result).length === 4
    && GENERATION.test(typeof result.generationId === "string" ? result.generationId : "")
    && COLLECTION.test(typeof result.collectionId === "string" ? result.collectionId : "")
    && ["READY", "PARTIAL", "CONFIGURATION_REQUIRED"].includes(
      typeof result.state === "string" ? result.state : "",
    )
    && typeof result.becameActive === "boolean";
}

function validClaim(value: unknown): value is ExtendedSupportReplayClaim {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  if (claim.state === "IN_PROGRESS") return Object.keys(claim).length === 1;
  if (claim.state === "ACQUIRED") {
    return Object.keys(claim).length === 2 && typeof claim.leaseToken === "string"
      && LEASE.test(claim.leaseToken);
  }
  return claim.state === "COMPLETED" && Object.keys(claim).length === 3
    && validResult(claim.result) && typeof claim.resultSha256 === "string"
    && SHA256.test(claim.resultSha256);
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function payloadFor(job: RunnableJob): { readonly scheduledWindow: string } {
  if (job.kind !== EXTENDED_SUPPORT_RUNTIME_JOB_KIND || job.customerId === null
    || job.connectionId === null || !ID.test(job.orgId) || !ID.test(job.customerId)
    || !CONNECTION.test(job.connectionId) || !JOB.test(job.id)
    || !Number.isSafeInteger(job.attempt) || job.attempt < 1 || job.attempt > 5
    || job.maxAttempts !== 5 || typeof job.payload !== "object"
    || job.payload === null || Array.isArray(job.payload)) invalid();
  const payload = job.payload as Record<string, unknown>;
  if (Object.keys(payload).length !== 1 || typeof payload.scheduledWindow !== "string"
    || !validWindow(payload.scheduledWindow)) invalid();
  return { scheduledWindow: payload.scheduledWindow };
}

export function extendedSupportCollectionWindow(nowMs = Date.now()): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) invalid();
  const date = new Date(nowMs);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
    .toISOString();
}

export function extendedSupportIdempotencyKey(
  scope: ExtendedSupportPersistenceScope,
  scheduledWindow: string,
): string {
  if (!validScope(scope) || !validWindow(scheduledWindow)) invalid();
  return `extended-support:${[
    scope.organizationId,
    scope.customerId,
    scope.connectionId,
    scheduledWindow,
  ].map(encodeURIComponent).join(":")}`;
}

export async function scheduleExtendedSupportCollections(input: {
  readonly scheduledWindow: string;
  readonly loadEligibleScopes: () => Promise<readonly ExtendedSupportPersistenceScope[]>;
  readonly queue: ExtendedSupportRuntimeQueue;
}): Promise<number> {
  if (!validWindow(input.scheduledWindow)) invalid();
  const scopes = [...await input.loadEligibleScopes()]
    .sort((left, right) => left.connectionId.localeCompare(right.connectionId));
  if (scopes.length > MAX_CONNECTIONS) invalid();
  const seen = new Set<string>();
  for (const scope of scopes) {
    if (!validScope(scope) || seen.has(scope.connectionId)) invalid();
    seen.add(scope.connectionId);
  }
  for (const scope of scopes) {
    await input.queue.enqueue({
      orgId: scope.organizationId,
      customerId: scope.customerId,
      connectionId: scope.connectionId,
      kind: EXTENDED_SUPPORT_RUNTIME_JOB_KIND,
      payload: Object.freeze({ scheduledWindow: input.scheduledWindow }),
      maxAttempts: 5,
      idempotencyKey: extendedSupportIdempotencyKey(scope, input.scheduledWindow),
    });
  }
  return scopes.length;
}

export async function runExtendedSupportRuntimeHandler(
  job: RunnableJob,
  dependencies: ExtendedSupportRuntimeDependencies,
): Promise<ExtendedSupportRuntimeDisposition> {
  const payload = payloadFor(job);
  const scope = {
    organizationId: job.orgId,
    customerId: job.customerId!,
    connectionId: job.connectionId!,
  };
  const key = extendedSupportIdempotencyKey(scope, payload.scheduledWindow);
  let boundary: ExtendedSupportTenantBoundary;
  try {
    boundary = await dependencies.loadBoundary(scope);
    if (!validBoundary(boundary, scope)) failed();
  } catch (error) {
    if (error instanceof ExtendedSupportRuntimeError) throw error;
    failed();
  }
  let claim: ExtendedSupportReplayClaim;
  try {
    const received: unknown = await dependencies.replayStore.claim({
      key,
      jobId: job.id,
      leaseDurationMs: EXTENDED_SUPPORT_PROJECTION_BOUNDS.maximumDurationMs + 60_000,
    });
    if (!validClaim(received)) failed();
    claim = received;
  } catch (error) {
    if (error instanceof ExtendedSupportRuntimeError) throw error;
    failed();
  }
  if (claim.state === "IN_PROGRESS") return { disposition: "IN_PROGRESS", result: null };
  if (claim.state === "COMPLETED") {
    if (await sha256(claim.result) !== claim.resultSha256) failed();
    return { disposition: "REPLAYED", result: claim.result };
  }

  try {
    const result = await runExtendedSupportCollectionJob({
      boundary,
      broker: dependencies.broker,
      store: dependencies.store,
      nowMs: dependencies.now?.() ?? Date.now(),
    });
    if (!validResult(result)) failed();
    await dependencies.replayStore.complete({
      key,
      jobId: job.id,
      leaseToken: claim.leaseToken,
      result,
      resultSha256: await sha256(result),
    });
    return { disposition: "EXECUTED", result };
  } catch {
    try {
      await dependencies.replayStore.fail({
        key,
        jobId: job.id,
        leaseToken: claim.leaseToken,
        failureCode: "EXTENDED_SUPPORT_COLLECTION_FAILED",
      });
    } catch {
      // Preserve the provider-neutral primary failure.
    }
    failed();
  }
}

export function createExtendedSupportRuntimeJobHandler(
  dependencies: ExtendedSupportRuntimeDependencies,
): JobHandler {
  return async (job) => { await runExtendedSupportRuntimeHandler(job, dependencies); };
}

export const EXTENDED_SUPPORT_RUNTIME_BINDING = Object.freeze({
  jobKind: EXTENDED_SUPPORT_RUNTIME_JOB_KIND,
  cadence: EXTENDED_SUPPORT_RUNTIME_CADENCE,
  handlerFactory: createExtendedSupportRuntimeJobHandler,
  registeredInSharedRuntime: false,
  activationReason: EXTENDED_SUPPORT_RUNTIME_ACTIVATION_REASON,
});
