/**
 * Durable, replay-safe activation boundary for ADD-12 AWS Config compliance.
 *
 * Scheduler payloads contain only a server-owned daily window. The collector
 * job reloads every AWS coordinate and evidence binding from trusted tenant
 * state, while this layer prevents overlapping or forged replays from creating
 * additional provider reads.
 */
import type { JobHandler, RunnableJob } from "./background-job-runner.ts";
import {
  AWS_CONFIG_COMPLIANCE_JOB_KIND,
  runAwsConfigComplianceCollectionJob,
  type AwsConfigComplianceCollectorAdapter,
  type AwsConfigComplianceSnapshotStore,
} from "./finops-aws-config-compliance-job.ts";
import { AWS_CONFIG_COMPLIANCE_BOUNDS, type AwsConfigComplianceScope } from "./finops-aws-config-compliance.ts";
import type { AwsConfigComplianceRepositoryScope } from "../db/finops-aws-config-compliance-repository.ts";

export const AWS_CONFIG_COMPLIANCE_RUNTIME_JOB_KIND = AWS_CONFIG_COMPLIANCE_JOB_KIND;
export const AWS_CONFIG_COMPLIANCE_RUNTIME_CADENCE = "rate(1 day)" as const;
export const AWS_CONFIG_COMPLIANCE_RUNTIME_ACTIVATION_REASON =
  "AWS_CONFIG_COMPLIANCE_DURABLE_RUNTIME_NOT_REGISTERED" as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const JOB_ID = /^job_[a-f0-9]{32}$/u;
const DAILY_WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const SNAPSHOT_ID = /^acc_[a-f0-9]{64}$/u;
const CAPTURE_ID = /^config_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const LEASE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const MAX_TARGETS = 10_000;

export interface AwsConfigComplianceRuntimeQueue {
  enqueue(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly kind: typeof AWS_CONFIG_COMPLIANCE_RUNTIME_JOB_KIND;
    readonly payload: { readonly scheduledWindow: string };
    readonly maxAttempts: 5;
    readonly idempotencyKey: string;
  }): Promise<unknown>;
}

export interface AwsConfigComplianceRuntimeResult {
  readonly snapshotId: string;
  readonly state: "CONFIGURATION_REQUIRED" | "PARTIAL" | "STALE" | "FAILED" | "EMPTY" | "READY";
  readonly captureId: string;
}

export type AwsConfigComplianceReplayClaim =
  | { readonly state: "ACQUIRED"; readonly leaseToken: string }
  | { readonly state: "IN_PROGRESS" }
  | {
      readonly state: "COMPLETED";
      readonly result: AwsConfigComplianceRuntimeResult;
      readonly resultSha256: string;
    };

export interface AwsConfigComplianceReplayStore {
  claim(input: {
    readonly key: string;
    readonly jobId: string;
    readonly leaseDurationMs: number;
  }): Promise<AwsConfigComplianceReplayClaim>;
  complete(input: {
    readonly key: string;
    readonly jobId: string;
    readonly leaseToken: string;
    readonly result: AwsConfigComplianceRuntimeResult;
    readonly resultSha256: string;
  }): Promise<void>;
  fail(input: {
    readonly key: string;
    readonly jobId: string;
    readonly leaseToken: string;
    readonly failureCode: "AWS_CONFIG_COMPLIANCE_COLLECTION_FAILED";
  }): Promise<void>;
}

export interface AwsConfigComplianceRuntimeDependencies {
  readonly loadScope: (scope: AwsConfigComplianceRepositoryScope) => Promise<AwsConfigComplianceScope>;
  readonly adapter: AwsConfigComplianceCollectorAdapter;
  readonly store: AwsConfigComplianceSnapshotStore;
  readonly replayStore: AwsConfigComplianceReplayStore;
  readonly now?: () => number;
}

export type AwsConfigComplianceRuntimeDisposition =
  | { readonly disposition: "EXECUTED" | "REPLAYED"; readonly result: AwsConfigComplianceRuntimeResult }
  | { readonly disposition: "IN_PROGRESS"; readonly result: null };

export class AwsConfigComplianceRuntimeError extends Error {
  public readonly code: "INVALID_JOB" | "COLLECTION_FAILED";

  public constructor(code: AwsConfigComplianceRuntimeError["code"]) {
    super(code === "INVALID_JOB"
      ? "AWS Config compliance runtime job rejected"
      : "AWS Config compliance runtime collection failed");
    this.name = "AwsConfigComplianceRuntimeError";
    this.code = code;
  }
}

function invalid(): never {
  throw new AwsConfigComplianceRuntimeError("INVALID_JOB");
}

function failed(): never {
  throw new AwsConfigComplianceRuntimeError("COLLECTION_FAILED");
}

function validScope(scope: AwsConfigComplianceRepositoryScope): boolean {
  return ID.test(scope.organizationId) && ID.test(scope.customerId)
    && CONNECTION_ID.test(scope.connectionId);
}

function validWindow(value: string): boolean {
  return DAILY_WINDOW.test(value) && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function validResult(value: unknown): value is AwsConfigComplianceRuntimeResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return Object.keys(result).length === 3
    && ["captureId", "snapshotId", "state"].every((key) => key in result)
    && typeof result.snapshotId === "string" && SNAPSHOT_ID.test(result.snapshotId)
    && typeof result.captureId === "string" && CAPTURE_ID.test(result.captureId)
    && typeof result.state === "string"
    && ["CONFIGURATION_REQUIRED", "PARTIAL", "STALE", "FAILED", "EMPTY", "READY"]
      .includes(result.state);
}

function validClaim(value: unknown): value is AwsConfigComplianceReplayClaim {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  if (claim.state === "IN_PROGRESS") return Object.keys(claim).length === 1;
  if (claim.state === "ACQUIRED") {
    return Object.keys(claim).length === 2 && typeof claim.leaseToken === "string"
      && LEASE_TOKEN.test(claim.leaseToken);
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
  if (job.kind !== AWS_CONFIG_COMPLIANCE_RUNTIME_JOB_KIND || job.customerId === null
    || job.connectionId === null || !ID.test(job.orgId) || !ID.test(job.customerId)
    || !CONNECTION_ID.test(job.connectionId) || !JOB_ID.test(job.id)
    || !Number.isSafeInteger(job.attempt) || job.attempt < 1 || job.attempt > 5
    || job.maxAttempts !== 5
    || typeof job.payload !== "object" || job.payload === null || Array.isArray(job.payload)) invalid();
  const payload = job.payload as Record<string, unknown>;
  if (Object.keys(payload).length !== 1 || typeof payload.scheduledWindow !== "string"
    || !validWindow(payload.scheduledWindow)) invalid();
  return { scheduledWindow: payload.scheduledWindow };
}

export function awsConfigComplianceCollectionWindow(nowMs = Date.now()): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) invalid();
  const date = new Date(nowMs);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
    .toISOString();
}

export function awsConfigComplianceIdempotencyKey(
  scope: AwsConfigComplianceRepositoryScope,
  scheduledWindow: string,
): string {
  if (!validScope(scope) || !validWindow(scheduledWindow)) invalid();
  return `aws-config-compliance:${[
    scope.organizationId,
    scope.customerId,
    scope.connectionId,
    scheduledWindow,
  ].map(encodeURIComponent).join(":")}`;
}

export async function scheduleAwsConfigComplianceCollections(input: {
  readonly scheduledWindow: string;
  readonly loadEligibleScopes: () => Promise<readonly AwsConfigComplianceRepositoryScope[]>;
  readonly queue: AwsConfigComplianceRuntimeQueue;
}): Promise<number> {
  if (!validWindow(input.scheduledWindow)) invalid();
  const scopes = [...await input.loadEligibleScopes()]
    .sort((left, right) => left.connectionId.localeCompare(right.connectionId));
  if (scopes.length > MAX_TARGETS) invalid();
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
      kind: AWS_CONFIG_COMPLIANCE_RUNTIME_JOB_KIND,
      payload: Object.freeze({ scheduledWindow: input.scheduledWindow }),
      maxAttempts: 5,
      idempotencyKey: awsConfigComplianceIdempotencyKey(scope, input.scheduledWindow),
    });
  }
  return scopes.length;
}

export async function runAwsConfigComplianceRuntimeHandler(
  job: RunnableJob,
  dependencies: AwsConfigComplianceRuntimeDependencies,
): Promise<AwsConfigComplianceRuntimeDisposition> {
  const payload = payloadFor(job);
  const scope = {
    organizationId: job.orgId,
    customerId: job.customerId!,
    connectionId: job.connectionId!,
  };
  const key = awsConfigComplianceIdempotencyKey(scope, payload.scheduledWindow);
  let claim: AwsConfigComplianceReplayClaim;
  try {
    const received: unknown = await dependencies.replayStore.claim({
      key,
      jobId: job.id,
      leaseDurationMs: AWS_CONFIG_COMPLIANCE_BOUNDS.maximumDurationMs + 60_000,
    });
    if (!validClaim(received)) failed();
    claim = received;
  } catch (error) {
    if (error instanceof AwsConfigComplianceRuntimeError) throw error;
    failed();
  }
  if (claim.state === "IN_PROGRESS") return { disposition: "IN_PROGRESS", result: null };
  if (claim.state === "COMPLETED") {
    if (await sha256(claim.result) !== claim.resultSha256) failed();
    return { disposition: "REPLAYED", result: claim.result };
  }

  try {
    const result = await runAwsConfigComplianceCollectionJob(job, dependencies);
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
        failureCode: "AWS_CONFIG_COMPLIANCE_COLLECTION_FAILED",
      });
    } catch {
      // The provider-neutral primary failure is preserved.
    }
    failed();
  }
}

export function createAwsConfigComplianceRuntimeJobHandler(
  dependencies: AwsConfigComplianceRuntimeDependencies,
): JobHandler {
  return async (job) => { await runAwsConfigComplianceRuntimeHandler(job, dependencies); };
}

export const AWS_CONFIG_COMPLIANCE_RUNTIME_BINDING = Object.freeze({
  jobKind: AWS_CONFIG_COMPLIANCE_RUNTIME_JOB_KIND,
  cadence: AWS_CONFIG_COMPLIANCE_RUNTIME_CADENCE,
  handlerFactory: createAwsConfigComplianceRuntimeJobHandler,
  registeredInSharedRuntime: false,
  activationReason: AWS_CONFIG_COMPLIANCE_RUNTIME_ACTIVATION_REASON,
});
