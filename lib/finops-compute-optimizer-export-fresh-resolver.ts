/**
 * Fresh, exact-ID resolver for AWS Compute Optimizer recommendation exports.
 *
 * AWS documents that DescribeRecommendationExportJobs exposes jobs created in
 * the last seven days. This boundary re-describes every sealed plan job through
 * a credential-owning regional reader immediately before materialization and
 * releases raw S3 addresses only inside a short-lived verified binding.
 *
 * @see https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_DescribeRecommendationExportJobs.html
 * @see https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_RecommendationExportJob.html
 */
import type {
  StoredComputeOptimizerFinalizedExportEvidence,
} from "../db/finops-compute-optimizer-discovery-repository.ts";
import {
  verifyComputeOptimizerExportPlan,
  type ComputeOptimizerExportPlan,
  type ComputeOptimizerExportPlanTarget,
  type VerifiedComputeOptimizerExportJobBinding,
} from "./finops-compute-optimizer-export-plan.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const SHA256 = /^[a-f0-9]{64}$/u;
const RUN_ID = /^cor_[a-f0-9]{64}$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const NEXT_TOKEN = /^[^\u0000-\u001f\u007f]{1,4096}$/u;

export const COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS = Object.freeze({
  describeVisibilityMs: 7 * DAY_MS,
  minimumVisibilityRemainingMs: 15 * 60 * 1_000,
  maximumBindingLifetimeMs: 5 * 60 * 1_000,
  maximumClockSkewMs: 5 * 60 * 1_000,
  maximumDurationMs: 30_000,
  maximumPages: 8,
  maximumResultsPerPage: 1_000,
} as const);

export interface ComputeOptimizerExportDescribeRequest {
  readonly region: string;
  /** Exact sealed-plan IDs. This property is never omitted. */
  readonly jobIds: readonly string[];
  readonly maxResults: number;
  /** Omitted on page one; thereafter exactly the provider token. */
  readonly nextToken?: string;
}

export interface ComputeOptimizerExportDescribeJob {
  readonly jobId?: unknown;
  readonly resourceType?: unknown;
  readonly status?: unknown;
  readonly creationTimestamp?: unknown;
  readonly lastUpdatedTimestamp?: unknown;
  readonly destination?: unknown;
  readonly failureReason?: unknown;
}

export interface ComputeOptimizerExportDescribePage {
  readonly recommendationExportJobs?: readonly ComputeOptimizerExportDescribeJob[];
  readonly nextToken?: unknown;
}

export type ComputeOptimizerExportDescribeReader = (
  request: ComputeOptimizerExportDescribeRequest,
  signal: AbortSignal,
) => Promise<ComputeOptimizerExportDescribePage>;

export interface ComputeOptimizerExportFreshResolverLimits {
  readonly maximumPages: number;
  readonly maximumDurationMs: number;
  readonly allowedClockSkewMs: number;
  readonly minimumVisibilityRemainingMs: number;
  readonly maximumBindingLifetimeMs: number;
}

export interface ResolveFreshComputeOptimizerExportOptions {
  readonly signal?: AbortSignal;
  /** Absolute Unix epoch deadline. The built-in maximum remains authoritative. */
  readonly deadlineAtMs?: number;
  readonly limits?: Partial<ComputeOptimizerExportFreshResolverLimits>;
  readonly now?: () => number;
}

export interface FreshComputeOptimizerExportBinding {
  readonly schemaVersion: "sutra.compute-optimizer-export-fresh-binding.v1";
  readonly discoveryRunId: string;
  readonly resolvedAtIso: string;
  /** The binding must not be used at or after this safety-adjusted instant. */
  readonly expiresAtIso: string;
  readonly binding: VerifiedComputeOptimizerExportJobBinding;
  /** Plan-ordered, exact provider chronology for every completed target. */
  readonly jobChronology: readonly FreshComputeOptimizerExportJobChronology[];
}

export interface FreshComputeOptimizerExportJobChronology {
  readonly jobId: string;
  readonly creationTimestampIso: string;
  readonly lastUpdatedTimestampIso: string;
}

export class ComputeOptimizerExportFreshResolverError extends Error {
  // Declared and assigned rather than a constructor parameter property: Node's default strip-only TypeScript mode
  // cannot transform parameter properties, so any test importing this module without the transform loader fails to
  // load it.
  public readonly code:
    | "INVALID_INPUT"
    | "ABORTED"
    | "DEADLINE_EXCEEDED"
    | "READ_FAILED"
    | "PAGINATION_INVALID"
    | "PROVIDER_RESPONSE_INVALID"
    | "EVIDENCE_MISMATCH"
    | "JOB_SUBSTITUTION"
    | "MISSING_JOB"
    | "DUPLICATE_JOB"
    | "EXPIRED";
  public constructor(code: ComputeOptimizerExportFreshResolverError["code"]) {
    super("Compute Optimizer export freshness resolution rejected");
    this.name = "ComputeOptimizerExportFreshResolverError";
    this.code = code;
  }
}

interface EvidenceJobBinding {
  readonly bucketSha256: string;
  readonly objectKeySha256: string;
  readonly metadataKeySha256: string;
}

interface ResolvedJob {
  readonly target: ComputeOptimizerExportPlanTarget;
  readonly creationMs: number;
  readonly lastUpdatedMs: number;
}

function reject(code: ComputeOptimizerExportFreshResolverError["code"]): never {
  throw new ComputeOptimizerExportFreshResolverError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

function safeClock(now: () => number): number {
  let value: number;
  try {
    value = now();
  } catch {
    reject("INVALID_INPUT");
  }
  if (!Number.isSafeInteger(value) || value < 0) reject("INVALID_INPUT");
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) reject("INVALID_INPUT");
  return value;
}

function limits(
  value: ResolveFreshComputeOptimizerExportOptions["limits"],
): ComputeOptimizerExportFreshResolverLimits {
  return {
    maximumPages: boundedInteger(
      value?.maximumPages
        ?? COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS.maximumPages,
      1,
      COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS.maximumPages,
    ),
    maximumDurationMs: boundedInteger(
      value?.maximumDurationMs
        ?? COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS.maximumDurationMs,
      1,
      COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS.maximumDurationMs,
    ),
    allowedClockSkewMs: boundedInteger(
      value?.allowedClockSkewMs
        ?? COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS.maximumClockSkewMs,
      0,
      COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS.maximumClockSkewMs,
    ),
    minimumVisibilityRemainingMs: boundedInteger(
      value?.minimumVisibilityRemainingMs
        ?? COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS.minimumVisibilityRemainingMs,
      COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS.minimumVisibilityRemainingMs,
      DAY_MS,
    ),
    maximumBindingLifetimeMs: boundedInteger(
      value?.maximumBindingLifetimeMs
        ?? COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS.maximumBindingLifetimeMs,
      1,
      COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS.maximumBindingLifetimeMs,
    ),
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalTimestamp(value: unknown): number {
  if (value instanceof Date) {
    const epoch = value.getTime();
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
      reject("PROVIDER_RESPONSE_INVALID");
    }
    return epoch;
  }
  if (typeof value !== "string") reject("PROVIDER_RESPONSE_INVALID");
  const epoch = Date.parse(value);
  if (
    !Number.isSafeInteger(epoch)
    || epoch < 0
    || new Date(epoch).toISOString() !== value
  ) reject("PROVIDER_RESPONSE_INVALID");
  return epoch;
}

async function expectedEvidence(
  plan: ComputeOptimizerExportPlan,
  evidence: StoredComputeOptimizerFinalizedExportEvidence,
): Promise<ReadonlyMap<string, EvidenceJobBinding>> {
  if (
    !isRecord(evidence)
    || !isRecord(evidence.run)
    || !Array.isArray(evidence.exportJobs)
    || evidence.run.scope === null
    || !isRecord(evidence.run.scope)
    || evidence.run.scope.organizationId !== plan.scope.orgId
    || evidence.run.scope.customerId !== plan.scope.customerId
    || evidence.run.scope.connectionId !== plan.scope.connectionId
    || evidence.run.accountId !== plan.requesterAccountId
    || evidence.run.partition !== plan.partition
    || evidence.run.region !== plan.regions[0]
    || (evidence.run.status !== "partial" && evidence.run.status !== "unavailable")
    || typeof evidence.run.runId !== "string"
    || !RUN_ID.test(evidence.run.runId)
    || typeof evidence.run.contentSha256 !== "string"
    || !SHA256.test(evidence.run.contentSha256)
    || evidence.run.finalizedAtIso === null
    || canonicalTimestamp(evidence.run.finalizedAtIso) < 0
    || evidence.run.exportJobCount !== evidence.exportJobs.length
  ) reject("EVIDENCE_MISMATCH");

  const planned = new Map(plan.targets.map((target) => [
    target.expectedJob.jobId,
    target,
  ]));
  const selected = new Map<string, EvidenceJobBinding>();
  for (const candidate of evidence.exportJobs) {
    if (!isRecord(candidate) || typeof candidate.jobId !== "string") {
      reject("EVIDENCE_MISMATCH");
    }
    const target = planned.get(candidate.jobId);
    if (target === undefined) continue;
    if (selected.has(candidate.jobId)) reject("DUPLICATE_JOB");
    if (
      candidate.status !== "COMPLETE"
      || candidate.resourceType !== target.expectedJob.providerResourceType
      || !isRecord(candidate.destination)
      || typeof candidate.destination.bucketSha256 !== "string"
      || typeof candidate.destination.objectKeySha256 !== "string"
      || typeof candidate.destination.metadataKeySha256 !== "string"
      || !SHA256.test(candidate.destination.bucketSha256)
      || !SHA256.test(candidate.destination.objectKeySha256)
      || !SHA256.test(candidate.destination.metadataKeySha256)
    ) reject("EVIDENCE_MISMATCH");
    selected.set(candidate.jobId, {
      bucketSha256: candidate.destination.bucketSha256,
      objectKeySha256: candidate.destination.objectKeySha256,
      metadataKeySha256: candidate.destination.metadataKeySha256,
    });
  }
  if (selected.size !== planned.size) reject("MISSING_JOB");
  await Promise.all(plan.targets.map(async (target) => {
    const hashes = selected.get(target.expectedJob.jobId) ?? reject("MISSING_JOB");
    const [bucketSha256, objectKeySha256, metadataKeySha256] = await Promise.all([
      sha256(target.expectedJob.bucket),
      sha256(target.expectedJob.objectKey),
      sha256(target.expectedJob.metadataKey),
    ]);
    if (
      hashes.bucketSha256 !== bucketSha256
      || hashes.objectKeySha256 !== objectKeySha256
      || hashes.metadataKeySha256 !== metadataKeySha256
    ) reject("EVIDENCE_MISMATCH");
  }));
  return selected;
}

function validateDestination(
  candidate: unknown,
  target: ComputeOptimizerExportPlanTarget,
): void {
  if (
    !isRecord(candidate)
    || !isRecord(candidate.s3)
    || candidate.s3.bucket !== target.expectedJob.bucket
    || candidate.s3.key !== target.expectedJob.objectKey
    || candidate.s3.metadataKey !== target.expectedJob.metadataKey
  ) reject("JOB_SUBSTITUTION");
}

async function resolveJob(
  candidate: Readonly<Record<string, unknown>>,
  target: ComputeOptimizerExportPlanTarget,
  evidence: EvidenceJobBinding,
  observedAtMs: number,
  configuration: ComputeOptimizerExportFreshResolverLimits,
): Promise<ResolvedJob> {
  if (
    candidate.status !== "Complete"
    || candidate.resourceType !== target.expectedJob.providerResourceType
    || (candidate.failureReason !== undefined && candidate.failureReason !== null)
  ) reject("JOB_SUBSTITUTION");
  validateDestination(candidate.destination, target);
  const [bucketSha256, objectKeySha256, metadataKeySha256] = await Promise.all([
    sha256(target.expectedJob.bucket),
    sha256(target.expectedJob.objectKey),
    sha256(target.expectedJob.metadataKey),
  ]);
  if (
    evidence.bucketSha256 !== bucketSha256
    || evidence.objectKeySha256 !== objectKeySha256
    || evidence.metadataKeySha256 !== metadataKeySha256
  ) reject("EVIDENCE_MISMATCH");

  const creationMs = canonicalTimestamp(candidate.creationTimestamp);
  const lastUpdatedMs = canonicalTimestamp(candidate.lastUpdatedTimestamp);
  if (
    creationMs > observedAtMs + configuration.allowedClockSkewMs
    || lastUpdatedMs < creationMs
    || lastUpdatedMs > observedAtMs + configuration.allowedClockSkewMs
  ) reject("PROVIDER_RESPONSE_INVALID");
  const safeExpiry = creationMs
    + COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS.describeVisibilityMs
    - configuration.minimumVisibilityRemainingMs;
  if (observedAtMs >= safeExpiry) reject("EXPIRED");
  return { target, creationMs, lastUpdatedMs };
}

function requestFor(
  region: string,
  jobIds: readonly string[],
  nextToken: string | null,
): ComputeOptimizerExportDescribeRequest {
  const value: ComputeOptimizerExportDescribeRequest = nextToken === null
    ? {
      region,
      jobIds: [...jobIds],
      maxResults:
        COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS.maximumResultsPerPage,
    }
    : {
      region,
      jobIds: [...jobIds],
      maxResults:
        COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS.maximumResultsPerPage,
      nextToken,
    };
  return deepFreeze(value);
}

export async function resolveFreshComputeOptimizerExportBinding(
  unsafePlan: ComputeOptimizerExportPlan,
  evidence: StoredComputeOptimizerFinalizedExportEvidence,
  reader: ComputeOptimizerExportDescribeReader,
  options: ResolveFreshComputeOptimizerExportOptions = {},
): Promise<FreshComputeOptimizerExportBinding> {
  if (
    typeof reader !== "function"
    || typeof options !== "object"
    || options === null
    || Array.isArray(options)
  ) reject("INVALID_INPUT");
  let plan: ComputeOptimizerExportPlan;
  try {
    plan = await verifyComputeOptimizerExportPlan(unsafePlan);
  } catch {
    reject("INVALID_INPUT");
  }
  if (plan.regions.length !== 1 || plan.targets.length < 1) reject("INVALID_INPUT");
  const configuration = limits(options.limits);
  const clock = options.now ?? Date.now;
  if (typeof clock !== "function") reject("INVALID_INPUT");
  const startedAt = safeClock(clock);
  const requestedDeadline = options.deadlineAtMs ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(requestedDeadline) || requestedDeadline < 0) {
    reject("INVALID_INPUT");
  }
  const deadlineAt = Math.min(
    requestedDeadline,
    startedAt + configuration.maximumDurationMs,
  );
  if (deadlineAt <= startedAt) reject("DEADLINE_EXCEEDED");
  if (
    options.signal !== undefined
    && (!(options.signal instanceof AbortSignal) || options.signal.aborted)
  ) {
    if (options.signal?.aborted === true) reject("ABORTED");
    reject("INVALID_INPUT");
  }

  const evidenceByJob = await expectedEvidence(plan, evidence);
  const targets = new Map(plan.targets.map((target) => [
    target.expectedJob.jobId,
    target,
  ]));
  const jobIds = [...targets.keys()].sort((left, right) => left.localeCompare(right));
  if (
    jobIds.length !== targets.size
    || jobIds.some((jobId) => !JOB_ID.test(jobId))
  ) reject("INVALID_INPUT");

  const controller = new AbortController();
  let boundaryCode: "ABORTED" | "DEADLINE_EXCEEDED" | null = null;
  let rejectBoundary: ((error: ComputeOptimizerExportFreshResolverError) => void)
    | null = null;
  const boundary = new Promise<never>((_resolve, rejectPromise) => {
    rejectBoundary = rejectPromise;
  });
  // Boundary rejection can precede the first provider race by one microtask.
  // Keep it observed while preserving the original rejecting promise for races.
  void boundary.catch(() => undefined);
  const stop = (code: "ABORTED" | "DEADLINE_EXCEEDED"): void => {
    if (boundaryCode !== null) return;
    boundaryCode = code;
    controller.abort();
    rejectBoundary?.(new ComputeOptimizerExportFreshResolverError(code));
  };
  const onExternalAbort = (): void => stop("ABORTED");
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (options.signal?.aborted === true) stop("ABORTED");
  const timer = setTimeout(
    () => stop("DEADLINE_EXCEEDED"),
    deadlineAt - startedAt,
  );

  try {
    const resolved = new Map<string, ResolvedJob>();
    const seenTokens = new Set<string>();
    let nextToken: string | null = null;
    for (let pageNumber = 1; pageNumber <= configuration.maximumPages; pageNumber += 1) {
      const beforeRead = safeClock(clock);
      if (beforeRead < startedAt) reject("INVALID_INPUT");
      if (beforeRead >= deadlineAt) reject("DEADLINE_EXCEEDED");
      if (boundaryCode !== null) reject(boundaryCode);
      let page: ComputeOptimizerExportDescribePage;
      try {
        page = await Promise.race([
          Promise.resolve().then(() => reader(
            requestFor(plan.regions[0]!, jobIds, nextToken),
            controller.signal,
          )),
          boundary,
        ]);
      } catch (error) {
        if (error instanceof ComputeOptimizerExportFreshResolverError) throw error;
        if (boundaryCode !== null) reject(boundaryCode);
        reject("READ_FAILED");
      }
      if (!isRecord(page)) reject("PROVIDER_RESPONSE_INVALID");
      const jobs = page.recommendationExportJobs ?? [];
      if (
        !Array.isArray(jobs)
        || jobs.length
          > COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS.maximumResultsPerPage
      ) reject("PROVIDER_RESPONSE_INVALID");
      const observedAt = safeClock(clock);
      if (observedAt < beforeRead) reject("INVALID_INPUT");
      for (const candidate of jobs) {
        if (!isRecord(candidate) || typeof candidate.jobId !== "string") {
          reject("PROVIDER_RESPONSE_INVALID");
        }
        const target = targets.get(candidate.jobId);
        if (target === undefined) continue;
        if (resolved.has(candidate.jobId)) reject("DUPLICATE_JOB");
        resolved.set(candidate.jobId, await resolveJob(
          candidate,
          target,
          evidenceByJob.get(candidate.jobId) ?? reject("EVIDENCE_MISMATCH"),
          observedAt,
          configuration,
        ));
      }

      const rawNextToken = page.nextToken;
      if (rawNextToken === undefined || rawNextToken === null) {
        nextToken = null;
        break;
      }
      if (
        typeof rawNextToken !== "string"
        || !NEXT_TOKEN.test(rawNextToken)
        || seenTokens.has(rawNextToken)
        || pageNumber === configuration.maximumPages
      ) reject("PAGINATION_INVALID");
      seenTokens.add(rawNextToken);
      nextToken = rawNextToken;
    }
    if (nextToken !== null) reject("PAGINATION_INVALID");
    if (resolved.size !== targets.size) reject("MISSING_JOB");

    const finishedAt = safeClock(clock);
    if (finishedAt < startedAt) reject("INVALID_INPUT");
    if (boundaryCode !== null) reject(boundaryCode);
    if (finishedAt >= deadlineAt) reject("DEADLINE_EXCEEDED");
    let expiresAt = finishedAt + configuration.maximumBindingLifetimeMs;
    for (const value of resolved.values()) {
      expiresAt = Math.min(
        expiresAt,
        value.creationMs
          + COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS.describeVisibilityMs
          - configuration.minimumVisibilityRemainingMs,
      );
    }
    if (finishedAt >= expiresAt) reject("EXPIRED");
    const binding: VerifiedComputeOptimizerExportJobBinding = {
      planId: plan.planId,
      contentSha256: plan.contentSha256,
      targets: plan.targets.map((target) => ({
        region: target.region,
        exportFamily: target.exportFamily,
        providerResourceType: target.expectedJob.providerResourceType,
        requestSha256: target.requestSha256,
        jobId: target.expectedJob.jobId,
        bucket: target.expectedJob.bucket,
        objectKey: target.expectedJob.objectKey,
        metadataKey: target.expectedJob.metadataKey,
      })),
    };
    const jobChronology = plan.targets.map((target) => {
      const chronology = resolved.get(target.expectedJob.jobId) ?? reject("MISSING_JOB");
      return {
        jobId: target.expectedJob.jobId,
        creationTimestampIso: new Date(chronology.creationMs).toISOString(),
        lastUpdatedTimestampIso: new Date(chronology.lastUpdatedMs).toISOString(),
      };
    });
    return deepFreeze({
      schemaVersion: "sutra.compute-optimizer-export-fresh-binding.v1",
      discoveryRunId: evidence.run.runId,
      resolvedAtIso: new Date(finishedAt).toISOString(),
      expiresAtIso: new Date(expiresAt).toISOString(),
      binding,
      jobChronology,
    });
  } catch (error) {
    if (error instanceof ComputeOptimizerExportFreshResolverError) throw error;
    return reject("PROVIDER_RESPONSE_INVALID");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
    controller.abort();
  }
}
