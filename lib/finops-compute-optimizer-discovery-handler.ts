/**
 * Durable identities-only handler for one regional Compute Optimizer discovery.
 *
 * Provider coordinates come from a separately verified .8.5 capability. The
 * queue payload cannot supply a Region, account, permission pack, contract, or
 * AWS operation. Dependencies receive one abort/deadline boundary and must not
 * start side effects after it closes.
 */
import type { RunnableJob } from "./background-job-runner.ts";
import { canonicalJson } from "./canonical-json.ts";
import {
  FINOPS_COMPUTE_OPTIMIZER_DISCOVERY_JOB_KIND,
  parseComputeOptimizerDiscoveryJobPayload,
} from "./finops-compute-optimizer-discovery-job.ts";
import type { FinopsSourceCollectionResult } from "./pilot-server.ts";
import type {
  ComputeOptimizerCoverageEvidence,
  ComputeOptimizerDiscoveryHashInput,
  ComputeOptimizerDiscoveryScope,
  ComputeOptimizerEnrollmentEvidence,
  ComputeOptimizerExportJobEvidence,
  ComputeOptimizerMemberEvidence,
  RecordComputeOptimizerDiscoveryInput,
  StoredComputeOptimizerDiscoveryRun,
} from "../db/finops-compute-optimizer-discovery-repository.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const ACCOUNT_ID = /^[0-9]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,127}$/u;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,95}$/u;
const SEALED_REFERENCE = /^fsev1\.[A-Za-z0-9_-]{26,8186}$/u;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const MAXIMUM_DURATION_MS = 120_000;
const ENROLLMENT_STATUSES = new Set(["ACTIVE", "INACTIVE", "PENDING", "FAILED"]);
const JOB_STATUSES = new Set(["QUEUED", "IN_PROGRESS", "COMPLETE", "FAILED"]);
const COVERAGE_STATUSES = new Set(["SUCCEEDED", "PARTIAL", "FAILED"]);
const OPERATIONS = new Set([
  "GET_ENROLLMENT_STATUS", "GET_ENROLLMENT_STATUSES_FOR_ORGANIZATION",
  "DESCRIBE_RECOMMENDATION_EXPORT_JOBS",
]);
const RESOURCE_TYPES = new Set([
  "Ec2Instance", "AutoScalingGroup", "EbsVolume", "LambdaFunction", "EcsService",
  "License", "RdsDBInstance", "AuroraDBClusterStorage", "Idle", "NotApplicable",
]);

export interface ComputeOptimizerDiscoveryTrustedBoundary {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly permissionPackVersion: "standard-2026-08.5";
  readonly explicitRegions: readonly string[];
  readonly sourceContractId: string;
}

export interface ComputeOptimizerDiscoveryHandlerContext {
  readonly signal: AbortSignal;
  readonly deadlineAtMs: number;
}

export interface ComputeOptimizerDiscoveryHandlerDependencies {
  readonly repository: {
    getRun(scope: ComputeOptimizerDiscoveryScope, runId: string): Promise<StoredComputeOptimizerDiscoveryRun | null>;
    startRun(scope: ComputeOptimizerDiscoveryScope, runId: string, nowMs?: number): Promise<StoredComputeOptimizerDiscoveryRun>;
    recordDiscovery(
      scope: ComputeOptimizerDiscoveryScope,
      runId: string,
      input: RecordComputeOptimizerDiscoveryInput,
      nowMs?: number,
    ): Promise<StoredComputeOptimizerDiscoveryRun>;
  };
  readonly loadTrustedBoundary: (
    scope: ComputeOptimizerDiscoveryScope,
    context: ComputeOptimizerDiscoveryHandlerContext,
  ) => Promise<ComputeOptimizerDiscoveryTrustedBoundary | null>;
  readonly collect: (
    input: {
      readonly tenantId: string;
      readonly connectionId: string;
      readonly jobId: string;
      readonly contractId: string;
      readonly sourceId: "compute_optimizer_organization_export";
      readonly accountId: string;
      readonly partition: "aws" | "aws-us-gov" | "aws-cn";
    },
    context: ComputeOptimizerDiscoveryHandlerContext,
  ) => Promise<FinopsSourceCollectionResult>;
  /**
   * Archives the sanitized evidence and returns the same sealed reference for
   * every replay of one run/evidence hash. Random re-sealing is forbidden.
   */
  readonly sealFinalizedEvidence: (
    input: {
      readonly scope: ComputeOptimizerDiscoveryScope;
      readonly runId: string;
      readonly evidenceContentSha256: string;
      readonly evidence: Omit<ComputeOptimizerDiscoveryHashInput, "evidenceReference">;
    },
    context: ComputeOptimizerDiscoveryHandlerContext,
  ) => Promise<{ readonly ciphertext: string; readonly keyVersion: string }>;
  readonly computeContentSha256: (
    scope: ComputeOptimizerDiscoveryScope,
    evidence: ComputeOptimizerDiscoveryHashInput,
  ) => Promise<string>;
  readonly now?: () => number;
}

export class ComputeOptimizerDiscoveryHandlerError extends Error {
  public readonly code:
    | "INVALID_JOB"
    | "INVALID_SCOPE"
    | "BOUNDARY_UNAVAILABLE"
    | "COLLECTION_REJECTED"
    | "PERSISTENCE_REJECTED"
    | "ABORTED"
    | "DEADLINE_EXCEEDED";

  public constructor(code: ComputeOptimizerDiscoveryHandlerError["code"]) {
    super("Compute Optimizer discovery handler rejected");
    this.name = "ComputeOptimizerDiscoveryHandlerError";
    this.code = code;
  }
}

function reject(code: ComputeOptimizerDiscoveryHandlerError["code"]): never {
  throw new ComputeOptimizerDiscoveryHandlerError(code);
}

function nowMs(dependencies: ComputeOptimizerDiscoveryHandlerDependencies): number {
  const value = dependencies.now?.() ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0) reject("INVALID_JOB");
  return value;
}

function assertActive(
  context: ComputeOptimizerDiscoveryHandlerContext,
  dependencies: ComputeOptimizerDiscoveryHandlerDependencies,
): void {
  if (context.signal.aborted) reject("ABORTED");
  if (nowMs(dependencies) >= context.deadlineAtMs) reject("DEADLINE_EXCEEDED");
}

async function active<T>(
  operation: () => Promise<T>,
  context: ComputeOptimizerDiscoveryHandlerContext,
  dependencies: ComputeOptimizerDiscoveryHandlerDependencies,
): Promise<T> {
  assertActive(context, dependencies);
  return await new Promise<T>((resolve, rejectPromise) => {
    let settled = false;
    const finish = (outcome: { readonly ok: true; readonly value: T }
      | { readonly ok: false; readonly error: unknown }) => {
      if (settled) return;
      settled = true;
      context.signal.removeEventListener("abort", onAbort);
      if (outcome.ok) resolve(outcome.value); else rejectPromise(outcome.error);
    };
    const onAbort = () => finish({
      ok: false,
      error: new ComputeOptimizerDiscoveryHandlerError(
        nowMs(dependencies) >= context.deadlineAtMs
          ? "DEADLINE_EXCEEDED" : "ABORTED",
      ),
    });
    context.signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(operation).then(
      (value) => {
        try {
          assertActive(context, dependencies);
          finish({ ok: true, value });
        } catch (error) { finish({ ok: false, error }); }
      },
      (error: unknown) => finish({ ok: false, error }),
    );
  });
}

function matchesPartition(region: string, partition: string): boolean {
  if (partition === "aws-cn") return region.startsWith("cn-");
  if (partition === "aws-us-gov") return region.startsWith("us-gov-");
  return !region.startsWith("cn-") && !region.startsWith("us-gov-");
}

function validatedBoundary(
  value: ComputeOptimizerDiscoveryTrustedBoundary | null,
  scope: ComputeOptimizerDiscoveryScope,
  run: StoredComputeOptimizerDiscoveryRun,
): ComputeOptimizerDiscoveryTrustedBoundary {
  if (value === null || value.organizationId !== scope.organizationId
    || value.customerId !== scope.customerId || value.connectionId !== scope.connectionId
    || value.accountId !== run.accountId || value.partition !== run.partition
    || value.permissionPackVersion !== "standard-2026-08.5"
    || !IDENTIFIER.test(value.sourceContractId)
    || !Array.isArray(value.explicitRegions) || value.explicitRegions.length < 1
    || value.explicitRegions.length > 50
    || value.explicitRegions.some((region) => typeof region !== "string"
      || region === "all-enabled" || !REGION.test(region)
      || !matchesPartition(region, value.partition))) reject("BOUNDARY_UNAVAILABLE");
  const sorted = [...value.explicitRegions].sort();
  if (new Set(sorted).size !== sorted.length
    || JSON.stringify(sorted) !== JSON.stringify(value.explicitRegions)
    || !sorted.includes(run.region)) reject("BOUNDARY_UNAVAILABLE");
  return value;
}

function record(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("COLLECTION_REJECTED");
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if (Object.keys(candidate).sort().join("\0") !== [...keys].sort().join("\0")) {
    reject("COLLECTION_REJECTED");
  }
  return candidate;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function nullableCode(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && SAFE_CODE.test(value));
}

function enrollment(value: unknown): ComputeOptimizerEnrollmentEvidence | null {
  if (value === null) return null;
  const candidate = record(value, [
    "status", "reasonCode", "memberAccountsEnrolled",
    "numberOfMemberAccountsOptedIn", "lastUpdatedAt",
  ]);
  if (typeof candidate.status !== "string" || !ENROLLMENT_STATUSES.has(candidate.status)
    || !nullableCode(candidate.reasonCode)
    || (candidate.memberAccountsEnrolled !== null
      && typeof candidate.memberAccountsEnrolled !== "boolean")
    || (candidate.numberOfMemberAccountsOptedIn !== null
      && (typeof candidate.numberOfMemberAccountsOptedIn !== "number"
        || !Number.isSafeInteger(candidate.numberOfMemberAccountsOptedIn)
        || candidate.numberOfMemberAccountsOptedIn < 0
        || candidate.numberOfMemberAccountsOptedIn > 1_000_000_000))
    || (candidate.lastUpdatedAt !== null && !timestamp(candidate.lastUpdatedAt))) {
    reject("COLLECTION_REJECTED");
  }
  return {
    status: candidate.status as ComputeOptimizerEnrollmentEvidence["status"],
    reasonCode: candidate.reasonCode,
    memberAccountsEnrolled: candidate.memberAccountsEnrolled as boolean | null,
    numberOfMemberAccountsOptedIn: candidate.numberOfMemberAccountsOptedIn as number | null,
    lastUpdatedAt: candidate.lastUpdatedAt as string | null,
  };
}

function members(value: readonly unknown[]): readonly ComputeOptimizerMemberEvidence[] {
  if (value.length > 1_000) reject("COLLECTION_REJECTED");
  const result = value.map((entry) => {
    const candidate = record(entry, ["accountId", "status", "reasonCode", "lastUpdatedAt"]);
    if (typeof candidate.accountId !== "string" || !ACCOUNT_ID.test(candidate.accountId)
      || typeof candidate.status !== "string" || !ENROLLMENT_STATUSES.has(candidate.status)
      || !nullableCode(candidate.reasonCode)
      || (candidate.lastUpdatedAt !== null && !timestamp(candidate.lastUpdatedAt))) {
      reject("COLLECTION_REJECTED");
    }
    return {
      accountId: candidate.accountId,
      status: candidate.status as ComputeOptimizerMemberEvidence["status"],
      reasonCode: candidate.reasonCode,
      lastUpdatedAt: candidate.lastUpdatedAt as string | null,
    };
  }).sort((left, right) => left.accountId.localeCompare(right.accountId));
  if (new Set(result.map(({ accountId }) => accountId)).size !== result.length) {
    reject("COLLECTION_REJECTED");
  }
  return result;
}

function jobs(value: readonly unknown[]): readonly ComputeOptimizerExportJobEvidence[] {
  if (value.length > 5_000) reject("COLLECTION_REJECTED");
  const result = value.map((entry) => {
    const candidate = record(entry, [
      "jobId", "resourceType", "status", "createdAt", "lastUpdatedAt", "failureCode",
      "destination",
    ]);
    const destination = record(candidate.destination, [
      "bucketSha256", "objectKeySha256", "metadataKeySha256",
    ]);
    const destinationHashes = [
      destination.bucketSha256, destination.objectKeySha256, destination.metadataKeySha256,
    ];
    if (typeof candidate.jobId !== "string" || !SAFE_VALUE.test(candidate.jobId)
      || typeof candidate.resourceType !== "string" || !RESOURCE_TYPES.has(candidate.resourceType)
      || typeof candidate.status !== "string" || !JOB_STATUSES.has(candidate.status)
      || !timestamp(candidate.createdAt) || !timestamp(candidate.lastUpdatedAt)
      || candidate.lastUpdatedAt < candidate.createdAt || !nullableCode(candidate.failureCode)
      || (candidate.status === "FAILED") !== (candidate.failureCode !== null)
      || destinationHashes.some((hash) => hash !== null
        && (typeof hash !== "string" || !SHA256.test(hash)))
      || (candidate.status === "COMPLETE" && destinationHashes.some((hash) => hash === null))) {
      reject("COLLECTION_REJECTED");
    }
    return {
      jobId: candidate.jobId,
      resourceType: candidate.resourceType,
      status: candidate.status as ComputeOptimizerExportJobEvidence["status"],
      createdAt: candidate.createdAt,
      lastUpdatedAt: candidate.lastUpdatedAt,
      failureCode: candidate.failureCode,
      destination: {
        bucketSha256: destination.bucketSha256 as string | null,
        objectKeySha256: destination.objectKeySha256 as string | null,
        metadataKeySha256: destination.metadataKeySha256 as string | null,
      },
    };
  }).sort((left, right) => left.jobId.localeCompare(right.jobId));
  if (new Set(result.map(({ jobId }) => jobId)).size !== result.length) {
    reject("COLLECTION_REJECTED");
  }
  return result;
}

function coverage(value: readonly unknown[]): readonly ComputeOptimizerCoverageEvidence[] {
  if (value.length < 1 || value.length > 3) reject("COLLECTION_REJECTED");
  const result = value.map((entry) => {
    const candidate = record(entry, [
      "operation", "status", "pagesObserved", "recordsObserved", "recordsAccepted",
      "recordsRejected", "recordsOmitted", "errorCode",
    ]);
    const counts = [
      candidate.pagesObserved, candidate.recordsObserved, candidate.recordsAccepted,
      candidate.recordsRejected, candidate.recordsOmitted,
    ];
    if (typeof candidate.operation !== "string" || !OPERATIONS.has(candidate.operation)
      || typeof candidate.status !== "string" || !COVERAGE_STATUSES.has(candidate.status)
      || counts.some((count) => typeof count !== "number" || !Number.isSafeInteger(count)
        || count < 0 || count > 1_000_000_000)
      || (candidate.pagesObserved as number) > 10 || !nullableCode(candidate.errorCode)
      || (candidate.status === "SUCCEEDED") !== (candidate.errorCode === null)) {
      reject("COLLECTION_REJECTED");
    }
    return {
      operation: candidate.operation as ComputeOptimizerCoverageEvidence["operation"],
      status: candidate.status as ComputeOptimizerCoverageEvidence["status"],
      pagesObserved: candidate.pagesObserved as number,
      recordsObserved: candidate.recordsObserved as number,
      recordsAccepted: candidate.recordsAccepted as number,
      recordsRejected: candidate.recordsRejected as number,
      recordsOmitted: candidate.recordsOmitted as number,
      errorCode: candidate.errorCode,
    };
  }).sort((left, right) => left.operation.localeCompare(right.operation));
  if (new Set(result.map(({ operation }) => operation)).size !== result.length) {
    reject("COLLECTION_REJECTED");
  }
  return result;
}

function evidenceFrom(
  result: FinopsSourceCollectionResult,
  run: StoredComputeOptimizerDiscoveryRun,
): Omit<ComputeOptimizerDiscoveryHashInput, "evidenceReference"> {
  if (result.collectionStatus !== "PARTIAL" || result.evidence === null
    || result.sourceId !== "compute_optimizer_organization_export"
    || result.accountId !== run.accountId || result.partition !== run.partition
    || result.region !== run.region || result.errorCode === null
    || !SAFE_CODE.test(result.errorCode) || !timestamp(result.collectedAt)
    || (result.dataThroughAt !== null && (!timestamp(result.dataThroughAt)
      || result.dataThroughAt > result.collectedAt))
    || result.limitations.length < 1 || result.limitations.length > 256
    || result.limitations.some((entry) => !SAFE_CODE.test(entry))) {
    reject("COLLECTION_REJECTED");
  }
  const raw = record(result.evidence, [
    "schemaVersion", "source", "enrollment", "memberEnrollments", "exportJobs", "coverage",
  ]);
  if (raw.schemaVersion !== "sutra.aws-compute-optimizer-export-discovery.v1"
    || raw.source !== "AWS_COMPUTE_OPTIMIZER_ORGANIZATION_EXPORT_DISCOVERY"
    || !Array.isArray(raw.memberEnrollments) || !Array.isArray(raw.exportJobs)
    || !Array.isArray(raw.coverage)) reject("COLLECTION_REJECTED");
  const normalizedMembers = members(raw.memberEnrollments);
  const normalizedJobs = jobs(raw.exportJobs);
  const normalizedCoverage = coverage(raw.coverage);
  const aggregate = normalizedCoverage.reduce((total, entry) => ({
    pagesObserved: total.pagesObserved + entry.pagesObserved,
    recordsObserved: total.recordsObserved + entry.recordsObserved,
    recordsAccepted: total.recordsAccepted + entry.recordsAccepted,
    recordsRejected: total.recordsRejected + entry.recordsRejected,
    recordsOmitted: total.recordsOmitted + entry.recordsOmitted,
  }), {
    pagesObserved: 0, recordsObserved: 0, recordsAccepted: 0,
    recordsRejected: 0, recordsOmitted: 0,
  });
  if (canonicalJson(aggregate) !== canonicalJson(result.coverage)) {
    reject("COLLECTION_REJECTED");
  }
  return {
    accountId: run.accountId,
    partition: run.partition,
    region: run.region,
    status: "partial",
    collectedAt: result.collectedAt,
    dataThroughAt: result.dataThroughAt,
    enrollment: enrollment(raw.enrollment),
    memberEnrollments: normalizedMembers,
    exportJobs: normalizedJobs,
    coverage: normalizedCoverage,
    errorCode: result.errorCode,
    limitations: [...new Set(result.limitations)].sort(),
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0")).join("");
}

function scopeFor(job: RunnableJob): ComputeOptimizerDiscoveryScope {
  let payload: ReturnType<typeof parseComputeOptimizerDiscoveryJobPayload>;
  try { payload = parseComputeOptimizerDiscoveryJobPayload(job.payload); } catch {
    return reject("INVALID_JOB");
  }
  if (job.kind !== FINOPS_COMPUTE_OPTIMIZER_DISCOVERY_JOB_KIND
    || job.customerId === null || job.connectionId === null
    || job.connectionId !== payload.connectionId
    || !IDENTIFIER.test(job.id) || !IDENTIFIER.test(job.orgId)
    || !IDENTIFIER.test(job.customerId) || !CONNECTION_ID.test(job.connectionId)
    || !Number.isSafeInteger(job.attempt) || job.attempt < 1
    || !Number.isSafeInteger(job.maxAttempts) || job.maxAttempts < job.attempt) {
    reject("INVALID_SCOPE");
  }
  return {
    organizationId: job.orgId,
    customerId: job.customerId,
    connectionId: job.connectionId,
  };
}

async function execute(
  job: RunnableJob,
  dependencies: ComputeOptimizerDiscoveryHandlerDependencies,
  context: ComputeOptimizerDiscoveryHandlerContext,
): Promise<void> {
  const scope = scopeFor(job);
  const payload = parseComputeOptimizerDiscoveryJobPayload(job.payload);
  let run: StoredComputeOptimizerDiscoveryRun;
  try {
    const stored = await active(
      () => dependencies.repository.getRun(scope, payload.runId), context, dependencies,
    );
    if (stored === null) reject("INVALID_SCOPE");
    if (stored.status === "partial" || stored.status === "unavailable"
      || stored.status === "complete") return;
    run = stored;
    if (run.status !== "pending" && run.status !== "running") {
      reject("PERSISTENCE_REJECTED");
    }
  } catch (error) {
    if (error instanceof ComputeOptimizerDiscoveryHandlerError) throw error;
    return reject("PERSISTENCE_REJECTED");
  }

  let boundary: ComputeOptimizerDiscoveryTrustedBoundary;
  try {
    boundary = validatedBoundary(await active(
      () => dependencies.loadTrustedBoundary(scope, context), context, dependencies,
    ), scope, run);
  } catch (error) {
    if (error instanceof ComputeOptimizerDiscoveryHandlerError) throw error;
    return reject("BOUNDARY_UNAVAILABLE");
  }
  if (run.status === "pending") {
    try {
      run = await active(() => dependencies.repository.startRun(
        scope, run.runId, nowMs(dependencies),
      ), context, dependencies);
      if (run.status !== "running") reject("PERSISTENCE_REJECTED");
    } catch (error) {
      if (error instanceof ComputeOptimizerDiscoveryHandlerError) throw error;
      return reject("PERSISTENCE_REJECTED");
    }
  }
  let result: FinopsSourceCollectionResult;
  try {
    result = await active(() => dependencies.collect({
      tenantId: scope.organizationId,
      connectionId: scope.connectionId,
      jobId: job.id,
      contractId: boundary.sourceContractId,
      sourceId: "compute_optimizer_organization_export",
      accountId: run.accountId,
      partition: run.partition,
    }, context), context, dependencies);
  } catch (error) {
    if (error instanceof ComputeOptimizerDiscoveryHandlerError) throw error;
    return reject("COLLECTION_REJECTED");
  }
  if (result.tenantId !== scope.organizationId
    || result.connectionId !== scope.connectionId || result.jobId !== job.id
    || result.contractId !== boundary.sourceContractId) reject("COLLECTION_REJECTED");

  try {
    const evidence = evidenceFrom(result, run);
    // Hashing this secret-free body gives the archive/sealer a deterministic
    // replay key without weakening the repository's final authenticated hash.
    const evidenceContentSha256 = await sha256(canonicalJson(evidence));
    assertActive(context, dependencies);
    const evidenceReference = await active(() => dependencies.sealFinalizedEvidence({
      scope, runId: run.runId, evidenceContentSha256, evidence,
    }, context), context, dependencies);
    if (!SEALED_REFERENCE.test(evidenceReference.ciphertext)
      || !KEY_VERSION.test(evidenceReference.keyVersion)) reject("PERSISTENCE_REJECTED");
    const hashInput: ComputeOptimizerDiscoveryHashInput = {
      ...evidence,
      evidenceReference,
    };
    const contentSha256 = await active(
      () => dependencies.computeContentSha256(scope, hashInput), context, dependencies,
    );
    if (!/^[a-f0-9]{64}$/u.test(contentSha256)) reject("PERSISTENCE_REJECTED");
    assertActive(context, dependencies);
    await active(() => dependencies.repository.recordDiscovery(scope, run.runId, {
      ...hashInput,
      contentSha256,
    }, nowMs(dependencies)), context, dependencies);
  } catch (error) {
    if (error instanceof ComputeOptimizerDiscoveryHandlerError) throw error;
    return reject("PERSISTENCE_REJECTED");
  }
}

/** Runs one regional discovery with a hard two-minute maximum boundary. */
export async function runComputeOptimizerDiscoveryHandler(
  job: RunnableJob,
  dependencies: ComputeOptimizerDiscoveryHandlerDependencies,
  options: { readonly signal?: AbortSignal; readonly deadlineAtMs?: number } = {},
): Promise<void> {
  const startedAt = nowMs(dependencies);
  const deadlineAtMs = options.deadlineAtMs ?? startedAt + MAXIMUM_DURATION_MS;
  if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= startedAt
    || deadlineAtMs - startedAt > MAXIMUM_DURATION_MS
    || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
    reject("INVALID_JOB");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const remaining = Math.max(1, deadlineAtMs - startedAt);
  const timer = setTimeout(abort, remaining);
  try {
    if (options.signal?.aborted) reject("ABORTED");
    await execute(job, dependencies, { signal: controller.signal, deadlineAtMs });
    assertActive({ signal: controller.signal, deadlineAtMs }, dependencies);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
