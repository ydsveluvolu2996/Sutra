/** Permanent, credential-free runtime boundary for ADV-11 collection. */
import type { JobHandler, RunnableJob } from "./background-job-runner.ts";
import {
  END_USER_COMPUTING_COLLECTION_BOUNDS,
  END_USER_COMPUTING_READ_OPERATIONS,
  normalizeEndUserComputingCapture,
  type EndUserComputingBillingEvidence,
  type EndUserComputingBoundary,
  type EndUserComputingCapture,
} from "./finops-end-user-computing.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const JOB = /^job_[a-f0-9]{32}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/u;
const REQUEST = /^eur_[a-f0-9]{64}$/u;
const GENERATION = /^eucg_[a-f0-9]{64}$/u;
const CAPTURE = /^euc_[a-f0-9]{64}$/u;
const CUR_GENERATION = /^fbg_[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export const END_USER_COMPUTING_DURABLE_JOB_KIND = "finops.end-user-computing.collect";
export const END_USER_COMPUTING_SCHEDULER_CADENCE = "rate(6 hours)";
export const END_USER_COMPUTING_RUNTIME_TIMEOUT_MS = 5 * 60 * 1_000;
export const END_USER_COMPUTING_RUNTIME_ACTIVATION_REASON =
  "REGISTERED_LOCAL_RUNTIME";

export interface EndUserComputingCur2Lineage {
  readonly availability: "ACTIVE_RECONCILED" | "UNAVAILABLE";
  readonly generationId: string | null;
  readonly billingPeriod: string | null;
  readonly sourceEvidenceId: string | null;
  readonly manifestSha256: string | null;
  readonly sourceUpdatedAt: string | null;
  readonly committedAt: string | null;
  readonly activeGenerationRowCount: number | null;
  readonly matchedLineItemCount: number | null;
  /** Digest of the ordered privacy-minimized EUC cost projection. */
  readonly projectedCostLinesSha256: string | null;
}

export interface EndUserComputingRuntimeContext {
  readonly boundary: EndUserComputingBoundary;
  readonly cur2: EndUserComputingCur2Lineage;
}

export interface EndUserComputingRuntimeRequest {
  readonly schemaVersion: "sutra.end-user-computing-runtime-request.v1";
  readonly requestId: string;
  readonly jobId: string;
  readonly scheduledWindow: string;
  readonly boundary: EndUserComputingBoundary;
  readonly operations: typeof END_USER_COMPUTING_READ_OPERATIONS;
  readonly bounds: typeof END_USER_COMPUTING_COLLECTION_BOUNDS;
  readonly maximumDurationMs: number;
  readonly cur2: EndUserComputingCur2Lineage;
  readonly privacy: {
    readonly includeUserIdentifiers: false;
    readonly includeSessionIdentifiers: false;
    readonly includeInstanceIdentifiers: false;
    readonly includeNetworkAddresses: false;
    readonly includeRawProviderMessages: false;
  };
}

export interface VerifiedEndUserComputingBrokerResult {
  readonly capture: EndUserComputingCapture;
  readonly verification: {
    readonly requestBodySha256: string;
    readonly responseBodySha256: string;
    readonly brokerKeyId: string;
  };
}

export type EndUserComputingRuntimeFailureCode =
  | "BROKER_AUTHENTICATION_FAILED" | "BROKER_TIMEOUT" | "BROKER_UNAVAILABLE"
  | "BROKER_RESPONSE_INVALID" | "SCOPE_REJECTED" | "PRIVACY_REJECTED"
  | "CUR2_LINEAGE_REJECTED" | "EVIDENCE_REJECTED" | "PERSISTENCE_REJECTED"
  | "INTERNAL_ERROR";

export interface EndUserComputingRuntimeAttempt {
  readonly requestId: string;
  readonly jobAttempt: number;
  readonly state: "READY" | "PARTIAL" | "STALE" | "UNAVAILABLE" | "FAILED";
  readonly generationId: string | null;
  readonly captureId: string | null;
  readonly failureCode: EndUserComputingRuntimeFailureCode | null;
}

export interface EndUserComputingRuntimeAttemptStore {
  getAttempt(boundary: EndUserComputingBoundary, requestId: string, jobAttempt: number): Promise<EndUserComputingRuntimeAttempt | null>;
  recordAttempt(input: {
    readonly boundary: EndUserComputingBoundary;
    readonly requestId: string;
    readonly jobId: string;
    readonly jobAttempt: number;
    readonly scheduledWindow: string;
    readonly state: EndUserComputingRuntimeAttempt["state"];
    readonly generationId: string | null;
    readonly captureId: string | null;
    readonly cur2GenerationId: string | null;
    readonly cur2ProjectionSha256: string | null;
    readonly requestBodySha256: string | null;
    readonly responseBodySha256: string | null;
    readonly brokerKeyId: string | null;
    readonly failureCode: EndUserComputingRuntimeFailureCode | null;
    readonly completedAtMs: number;
  }): Promise<EndUserComputingRuntimeAttempt>;
}

export interface EndUserComputingScheduleResult {
  readonly schemaVersion: "sutra.end-user-computing-schedule-result.v1";
  readonly scheduledWindow: string;
  readonly connectionCount: number;
  readonly submittedCount: number;
  readonly rejectedCount: number;
}

export class EndUserComputingRuntimeError extends Error {
  public constructor(public readonly code: EndUserComputingRuntimeFailureCode | "INVALID_JOB") {
    super("End User Computing runtime collection failed");
    this.name = "EndUserComputingRuntimeError";
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function sortedUnique(values: readonly string[], pattern: RegExp, maximum: number): boolean {
  return values.length > 0 && values.length <= maximum && values.every((value) => pattern.test(value))
    && new Set(values).size === values.length
    && JSON.stringify(values) === JSON.stringify([...values].sort());
}

function validBoundary(value: EndUserComputingBoundary): boolean {
  return ID.test(value.scope.orgId) && ID.test(value.scope.customerId)
    && CONNECTION.test(value.scope.connectionId)
    && ["aws", "aws-us-gov", "aws-cn"].includes(value.partition)
    && sortedUnique(value.accountIds, ACCOUNT, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumAccounts)
    && sortedUnique(value.regions, REGION, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumRegions);
}

function sameBoundary(left: EndUserComputingBoundary, right: EndUserComputingBoundary): boolean {
  return left.scope.orgId === right.scope.orgId && left.scope.customerId === right.scope.customerId
    && left.scope.connectionId === right.scope.connectionId && left.partition === right.partition
    && JSON.stringify(left.accountIds) === JSON.stringify(right.accountIds)
    && JSON.stringify(left.regions) === JSON.stringify(right.regions);
}

function validIso(value: string | null): boolean {
  return value !== null && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function validWindow(value: string): boolean {
  return WINDOW.test(value) && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function validCur2(value: EndUserComputingCur2Lineage): boolean {
  if (value.availability === "UNAVAILABLE") return Object.entries(value)
    .filter(([key]) => key !== "availability").every(([, item]) => item === null);
  return value.generationId !== null && CUR_GENERATION.test(value.generationId)
    && value.billingPeriod !== null && PERIOD.test(value.billingPeriod)
    && value.sourceEvidenceId !== null && ID.test(value.sourceEvidenceId)
    && value.manifestSha256 !== null && SHA.test(value.manifestSha256)
    && validIso(value.sourceUpdatedAt) && validIso(value.committedAt)
    && Date.parse(value.sourceUpdatedAt!) <= Date.parse(value.committedAt!)
    && Number.isSafeInteger(value.activeGenerationRowCount) && value.activeGenerationRowCount! >= 0
    && Number.isSafeInteger(value.matchedLineItemCount) && value.matchedLineItemCount! >= 0
    && value.activeGenerationRowCount! >= value.matchedLineItemCount!
    && value.projectedCostLinesSha256 !== null && SHA.test(value.projectedCostLinesSha256);
}

function exactBilling(left: EndUserComputingBillingEvidence, right: EndUserComputingCur2Lineage): boolean {
  return right.availability === "ACTIVE_RECONCILED"
    && left.generationId === right.generationId && left.billingPeriod === right.billingPeriod
    && left.sourceEvidenceId === right.sourceEvidenceId && left.manifestSha256 === right.manifestSha256
    && left.sourceUpdatedAt === right.sourceUpdatedAt && left.committedAt === right.committedAt
    && left.activeGenerationRowCount === right.activeGenerationRowCount
    && left.matchedLineItemCount === right.matchedLineItemCount
    && left.sourceFormat === "aws-cur" && left.sourceVersion === "2.0" && left.reconciled;
}

function parseJob(job: RunnableJob): string {
  if (job.kind !== END_USER_COMPUTING_DURABLE_JOB_KIND || job.customerId === null
    || job.connectionId === null || !JOB.test(job.id) || !Number.isSafeInteger(job.attempt)
    || job.maxAttempts !== 5 || job.attempt < 1 || job.attempt > job.maxAttempts
    || typeof job.payload !== "object" || job.payload === null || Array.isArray(job.payload)) {
    throw new EndUserComputingRuntimeError("INVALID_JOB");
  }
  const payload = job.payload as Record<string, unknown>;
  if (Object.keys(payload).length !== 1 || typeof payload.scheduledWindow !== "string"
    || !validWindow(payload.scheduledWindow)) throw new EndUserComputingRuntimeError("INVALID_JOB");
  return payload.scheduledWindow;
}

function sanitize(error: unknown): EndUserComputingRuntimeFailureCode {
  if (error instanceof EndUserComputingRuntimeError && error.code !== "INVALID_JOB") return error.code;
  return "INTERNAL_ERROR";
}

export async function scheduleEndUserComputingCollectionsDetailed(input: {
  readonly scheduledWindow: string;
  readonly loadEligibleBoundaries: () => Promise<readonly EndUserComputingBoundary[]>;
  readonly enqueue: (input: { readonly orgId: string; readonly customerId: string; readonly connectionId: string; readonly kind: string; readonly payload: { readonly scheduledWindow: string }; readonly maxAttempts: 5; readonly idempotencyKey: string }) => Promise<unknown>;
}): Promise<EndUserComputingScheduleResult> {
  if (!validWindow(input.scheduledWindow)) throw new EndUserComputingRuntimeError("INVALID_JOB");
  let received: readonly EndUserComputingBoundary[];
  try { received = await input.loadEligibleBoundaries(); }
  catch { throw new EndUserComputingRuntimeError("INTERNAL_ERROR"); }
  if (!Array.isArray(received) || received.length > 10_000) throw new EndUserComputingRuntimeError("SCOPE_REJECTED");
  const boundaries = [...received].sort((a, b) => `${a.scope.orgId}|${a.scope.customerId}|${a.scope.connectionId}`
    .localeCompare(`${b.scope.orgId}|${b.scope.customerId}|${b.scope.connectionId}`));
  const seen = new Set<string>();
  for (const boundary of boundaries) {
    const key = boundary.scope.connectionId;
    if (!validBoundary(boundary) || seen.has(key)) throw new EndUserComputingRuntimeError("SCOPE_REJECTED");
    seen.add(key);
  }
  let cursor = 0;
  let submittedCount = 0;
  let rejectedCount = 0;
  await Promise.all(Array.from({ length: Math.min(8, boundaries.length) }, async () => {
    while (cursor < boundaries.length) {
      const boundary = boundaries[cursor++]!;
      try {
        await input.enqueue({ orgId: boundary.scope.orgId, customerId: boundary.scope.customerId,
          connectionId: boundary.scope.connectionId, kind: END_USER_COMPUTING_DURABLE_JOB_KIND,
          payload: { scheduledWindow: input.scheduledWindow }, maxAttempts: 5,
          idempotencyKey: `euc:${boundary.scope.connectionId}:${input.scheduledWindow}` });
        submittedCount += 1;
      } catch { rejectedCount += 1; }
    }
  }));
  return Object.freeze({ schemaVersion: "sutra.end-user-computing-schedule-result.v1",
    scheduledWindow: input.scheduledWindow, connectionCount: boundaries.length,
    submittedCount, rejectedCount });
}

/** Compatibility surface for the existing scheduler caller. */
export async function scheduleEndUserComputingCollections(
  input: Parameters<typeof scheduleEndUserComputingCollectionsDetailed>[0],
): Promise<number> {
  const result = await scheduleEndUserComputingCollectionsDetailed(input);
  if (result.rejectedCount > 0) throw new EndUserComputingRuntimeError("INTERNAL_ERROR");
  return result.submittedCount;
}

export async function runEndUserComputingRuntimeJob(job: RunnableJob, dependencies: {
  readonly loadRuntimeContext: (scope: { readonly orgId: string; readonly customerId: string; readonly connectionId: string }) => Promise<EndUserComputingRuntimeContext>;
  readonly broker: { readonly collect: (request: EndUserComputingRuntimeRequest) => Promise<VerifiedEndUserComputingBrokerResult> };
  readonly recordCapture: (boundary: EndUserComputingBoundary, capture: EndUserComputingCapture, nowMs: number) => Promise<{ readonly generation: { readonly generationId: string; readonly snapshot: { readonly captureId: string; readonly state: string } } }>;
  readonly attempts: EndUserComputingRuntimeAttemptStore;
  readonly now?: () => number;
}): Promise<{ readonly requestId: string; readonly generationId: string; readonly state: string; readonly replayed: boolean }> {
  const scheduledWindow = parseJob(job);
  const now = dependencies.now ?? Date.now;
  const startedAtMs = now();
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) throw new EndUserComputingRuntimeError("INTERNAL_ERROR");
  let context: EndUserComputingRuntimeContext;
  try { context = await dependencies.loadRuntimeContext({ orgId: job.orgId, customerId: job.customerId!, connectionId: job.connectionId! }); }
  catch { throw new EndUserComputingRuntimeError("INTERNAL_ERROR"); }
  if (!validBoundary(context.boundary) || !validCur2(context.cur2)
    || context.boundary.scope.orgId !== job.orgId || context.boundary.scope.customerId !== job.customerId
    || context.boundary.scope.connectionId !== job.connectionId) throw new EndUserComputingRuntimeError("SCOPE_REJECTED");
  context = {
    boundary: Object.freeze({ scope: Object.freeze({ ...context.boundary.scope }),
      partition: context.boundary.partition, accountIds: Object.freeze([...context.boundary.accountIds]),
      regions: Object.freeze([...context.boundary.regions]) }),
    cur2: Object.freeze({ ...context.cur2 }),
  };
  const requestId = `eur_${await sha256(JSON.stringify({ schema: "sutra.euc-request-id.v1", boundary: context.boundary, cur2: context.cur2, scheduledWindow }))}`;
  if (!REQUEST.test(requestId)) throw new EndUserComputingRuntimeError("INTERNAL_ERROR");
  let prior: EndUserComputingRuntimeAttempt | null;
  try { prior = await dependencies.attempts.getAttempt(context.boundary, requestId, job.attempt); }
  catch { throw new EndUserComputingRuntimeError("PERSISTENCE_REJECTED"); }
  if (prior !== null) {
    if (prior.failureCode !== null || prior.generationId === null) throw new EndUserComputingRuntimeError(prior.failureCode ?? "INTERNAL_ERROR");
    return { requestId, generationId: prior.generationId, state: prior.state, replayed: true };
  }
  const request: EndUserComputingRuntimeRequest = Object.freeze({
    schemaVersion: "sutra.end-user-computing-runtime-request.v1", requestId,
    jobId: job.id, scheduledWindow, boundary: context.boundary,
    operations: END_USER_COMPUTING_READ_OPERATIONS, bounds: END_USER_COMPUTING_COLLECTION_BOUNDS,
    maximumDurationMs: END_USER_COMPUTING_RUNTIME_TIMEOUT_MS, cur2: context.cur2,
    privacy: Object.freeze({ includeUserIdentifiers: false, includeSessionIdentifiers: false,
      includeInstanceIdentifiers: false, includeNetworkAddresses: false, includeRawProviderMessages: false }),
  });
  const requestSha = await sha256(JSON.stringify(request));
  try {
    const response = await dependencies.broker.collect(request);
    if (response.verification.requestBodySha256 !== requestSha
      || !SHA.test(response.verification.responseBodySha256) || !KEY.test(response.verification.brokerKeyId)) {
      throw new EndUserComputingRuntimeError("BROKER_RESPONSE_INVALID");
    }
    const supplied: EndUserComputingBoundary = { scope: response.capture.scope, partition: response.capture.partition,
      accountIds: response.capture.accountIds, regions: response.capture.regions };
    if (!sameBoundary(supplied, context.boundary)) throw new EndUserComputingRuntimeError("SCOPE_REJECTED");
    if (context.cur2.availability === "UNAVAILABLE") {
      if (response.capture.billingEvidence !== null || response.capture.costs.length !== 0) throw new EndUserComputingRuntimeError("CUR2_LINEAGE_REJECTED");
    } else if (response.capture.billingEvidence === null || !exactBilling(response.capture.billingEvidence, context.cur2)
      || await sha256(JSON.stringify(response.capture.costs)) !== context.cur2.projectedCostLinesSha256) {
      throw new EndUserComputingRuntimeError("CUR2_LINEAGE_REJECTED");
    }
    let normalized;
    try { normalized = normalizeEndUserComputingCapture(response.capture, context.boundary, now()); }
    catch { throw new EndUserComputingRuntimeError("EVIDENCE_REJECTED"); }
    let stored;
    try { stored = await dependencies.recordCapture(context.boundary, response.capture, now()); }
    catch { throw new EndUserComputingRuntimeError("PERSISTENCE_REJECTED"); }
    if (!GENERATION.test(stored.generation.generationId) || !CAPTURE.test(stored.generation.snapshot.captureId)
      || stored.generation.snapshot.captureId !== normalized.captureId
      || stored.generation.snapshot.state !== normalized.state) throw new EndUserComputingRuntimeError("PERSISTENCE_REJECTED");
    let recorded: EndUserComputingRuntimeAttempt;
    try { recorded = await dependencies.attempts.recordAttempt({ boundary: context.boundary, requestId,
        jobId: job.id, jobAttempt: job.attempt, scheduledWindow,
        state: normalized.state, generationId: stored.generation.generationId,
        captureId: stored.generation.snapshot.captureId, cur2GenerationId: context.cur2.generationId,
        cur2ProjectionSha256: context.cur2.projectedCostLinesSha256, requestBodySha256: requestSha,
        responseBodySha256: response.verification.responseBodySha256,
        brokerKeyId: response.verification.brokerKeyId, failureCode: null, completedAtMs: now() }); }
    catch { throw new EndUserComputingRuntimeError("PERSISTENCE_REJECTED"); }
    return { requestId, generationId: stored.generation.generationId, state: recorded.state, replayed: false };
  } catch (error) {
    const code = sanitize(error);
    try { await dependencies.attempts.recordAttempt({ boundary: context.boundary, requestId,
      jobId: job.id, jobAttempt: job.attempt, scheduledWindow, state: "FAILED",
      generationId: null, captureId: null, cur2GenerationId: context.cur2.generationId,
      cur2ProjectionSha256: context.cur2.projectedCostLinesSha256, requestBodySha256: requestSha,
      responseBodySha256: null, brokerKeyId: null, failureCode: code, completedAtMs: now() }); } catch { /* sanitized */ }
    throw new EndUserComputingRuntimeError(code);
  }
}

export function createEndUserComputingRuntimeHandler(dependencies: Parameters<typeof runEndUserComputingRuntimeJob>[1]): JobHandler {
  return async (job) => { await runEndUserComputingRuntimeJob(job, dependencies); };
}

export const END_USER_COMPUTING_RUNTIME_BINDING = Object.freeze({
  schemaVersion: "sutra.end-user-computing-runtime-binding.v1",
  jobKind: END_USER_COMPUTING_DURABLE_JOB_KIND,
  cadence: END_USER_COMPUTING_SCHEDULER_CADENCE,
  schedulerImplemented: true,
  schedulerFailureIsolationImplemented: true,
  handlerImplemented: true,
  signedBrokerTransportImplemented: true,
  immutableAttemptStoreImplemented: true,
  registeredInSharedRuntime: true,
  providerAdapterAvailable: true,
  activationReason: END_USER_COMPUTING_RUNTIME_ACTIVATION_REASON,
});
