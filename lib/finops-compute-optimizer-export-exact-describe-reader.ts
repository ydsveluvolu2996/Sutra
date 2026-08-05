/**
 * App-side adapter for the signed exact-ID Compute Optimizer describe action.
 * The injected transport is the authenticated pilot-server boundary; this
 * module additionally treats every response field as hostile before exposing
 * provider-shaped evidence to the fresh resolver.
 */
import type {
  ComputeOptimizerExportDescribePage,
  ComputeOptimizerExportDescribeReader,
  ComputeOptimizerExportDescribeRequest,
} from "./finops-compute-optimizer-export-fresh-resolver.ts";
import type {
  ComputeOptimizerExactDescribePlannedJob,
  ComputeOptimizerExactDescribeRequest,
  ComputeOptimizerExactDescribeResponse,
} from "../services/aws-collector/src/compute-optimizer-export-exact-describe.ts";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const TARGET_ID = /^coelt_[a-f0-9]{64}$/u;
const BUCKET = /^(?!\d{1,3}(?:\.\d{1,3}){3}$)(?!.*\.\.)(?!.*\.-)(?!.*-\.)(?!xn--)(?!.*-s3alias$)(?!.*--ol-s3$)(?!.*\.mrap$)(?!.*--x-s3$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAXIMUM_DURATION_MS = 35_000;
const MAX_KEY_BYTES = 1_024;

const RESOURCE_TYPES_BY_FAMILY = Object.freeze({
  EC2_INSTANCE: new Set(["Ec2Instance"]),
  AUTO_SCALING_GROUP: new Set(["AutoScalingGroup"]),
  EBS_VOLUME: new Set(["EbsVolume"]),
  LAMBDA_FUNCTION: new Set(["LambdaFunction"]),
  ECS_SERVICE: new Set(["EcsService"]),
  LICENSE: new Set(["License"]),
  RDS_DATABASE: new Set(["RdsDBInstance", "AuroraDBClusterStorage"]),
  IDLE_RESOURCE: new Set(["Idle"]),
} as const);

export interface ComputeOptimizerExactDescribeTransport {
  /** Returns only after the broker response signature has been verified. */
  describeExact(
    request: ComputeOptimizerExactDescribeRequest,
    context: {
      readonly signal: AbortSignal;
      readonly deadlineAtMs: number;
    },
  ): Promise<unknown>;
}

export interface ComputeOptimizerExactDescribeReaderOptions {
  readonly deadlineAtMs?: number;
  readonly now?: () => number;
}

export class ComputeOptimizerExactDescribeReaderError extends Error {
  public readonly code:
    | "INVALID_CONFIGURATION"
    | "INVALID_FRESH_REQUEST"
    | "BROKER_RESPONSE_INVALID"
    | "JOB_SUBSTITUTION"
    | "ABORTED"
    | "DEADLINE_EXCEEDED"
    | "TRANSPORT_FAILED";

  public constructor(code: ComputeOptimizerExactDescribeReaderError["code"]) {
    super("Compute Optimizer exact describe response rejected");
    this.name = "ComputeOptimizerExactDescribeReaderError";
    this.code = code;
  }
}

function reject(code: ComputeOptimizerExactDescribeReaderError["code"]): never {
  throw new ComputeOptimizerExactDescribeReaderError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length
    && actual.every((key, index) => key === keys[index]);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) return false;
  const epoch = Date.parse(value);
  return Number.isSafeInteger(epoch) && new Date(epoch).toISOString() === value;
}

function validKey(value: unknown): value is string {
  if (
    typeof value !== "string" || value.length === 0
    || new TextEncoder().encode(value).byteLength > MAX_KEY_BYTES
    || value.startsWith("/") || /[%\\*?\u0000]/u.test(value)
  ) return false;
  return !value.split("/").some((part) =>
    part.length === 0 || part === "." || part === ".."
  );
}

function regionMatchesPartition(region: string, partition: unknown): boolean {
  if (partition === "aws-cn") return region.startsWith("cn-");
  if (partition === "aws-us-gov") return region.startsWith("us-gov-");
  return partition === "aws"
    && !region.startsWith("cn-") && !region.startsWith("us-gov-");
}

function validBoundaryJob(value: unknown, region: string):
value is ComputeOptimizerExactDescribePlannedJob {
  if (!isRecord(value) || !exactKeys(value, [
    "targetId", "plannedJobId", "exportFamily", "providerResourceType",
    "requestSha256", "bucket", "objectKey", "metadataKey",
  ])) return false;
  if (
    typeof value.targetId !== "string" || !TARGET_ID.test(value.targetId)
    || typeof value.plannedJobId !== "string" || !JOB_ID.test(value.plannedJobId)
    || typeof value.exportFamily !== "string"
    || !(value.exportFamily in RESOURCE_TYPES_BY_FAMILY)
    || typeof value.providerResourceType !== "string"
    || !(RESOURCE_TYPES_BY_FAMILY[
      value.exportFamily as keyof typeof RESOURCE_TYPES_BY_FAMILY
    ] as ReadonlySet<string>).has(value.providerResourceType)
    || typeof value.requestSha256 !== "string" || !SHA256.test(value.requestSha256)
    || typeof value.bucket !== "string" || !BUCKET.test(value.bucket)
    || !validKey(value.objectKey) || !validKey(value.metadataKey)
  ) return false;
  return value.objectKey.endsWith(`-${value.plannedJobId}.csv`)
    && value.objectKey.split("/").at(-1)?.startsWith(`${region}-`) === true
    && value.metadataKey === `${value.objectKey.slice(0, -4)}-metadata.json`;
}

function validBoundary(value: unknown): value is ComputeOptimizerExactDescribeRequest {
  if (!isRecord(value) || !exactKeys(value, [
    "schema", "tenantId", "connectionId", "collectionJobId", "contractId",
    "accountId", "partition", "region", "plannedJobs",
  ])) return false;
  if (
    value.schema !== "sutra.compute-optimizer-export-exact-describe-request.v1"
    || typeof value.tenantId !== "string" || !IDENTIFIER.test(value.tenantId)
    || typeof value.connectionId !== "string" || !CONNECTION_ID.test(value.connectionId)
    || typeof value.collectionJobId !== "string" || !IDENTIFIER.test(value.collectionJobId)
    || typeof value.contractId !== "string" || !IDENTIFIER.test(value.contractId)
    || typeof value.accountId !== "string" || !ACCOUNT_ID.test(value.accountId)
    || typeof value.region !== "string" || !REGION.test(value.region)
    || !regionMatchesPartition(value.region, value.partition)
    || !Array.isArray(value.plannedJobs)
    || value.plannedJobs.length < 1 || value.plannedJobs.length > 8
    || value.plannedJobs.some((job) => !validBoundaryJob(job, value.region as string))
  ) return false;
  const jobs = value.plannedJobs as unknown as ComputeOptimizerExactDescribePlannedJob[];
  return new Set(jobs.map(({ targetId }) => targetId)).size === jobs.length
    && new Set(jobs.map(({ plannedJobId }) => plannedJobId)).size === jobs.length
    && new Set(jobs.map(({ exportFamily }) => exportFamily)).size === jobs.length;
}

function cloneBoundary(value: unknown): ComputeOptimizerExactDescribeRequest {
  let clone: unknown;
  try {
    clone = JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return reject("INVALID_CONFIGURATION");
  }
  if (!validBoundary(clone)) reject("INVALID_CONFIGURATION");
  return deepFreeze(clone);
}

function deepFreeze<T>(value: T): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function readNow(now: (() => number) | undefined): number {
  let value: unknown;
  try {
    value = (now ?? Date.now)();
  } catch {
    reject("INVALID_CONFIGURATION");
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    reject("INVALID_CONFIGURATION");
  }
  return value;
}

function exactPlannedJob(
  actual: Record<string, unknown>,
  expected: ComputeOptimizerExactDescribePlannedJob,
): boolean {
  return exactKeys(actual, [
    "targetId", "plannedJobId", "jobId", "exportFamily", "providerResourceType",
    "requestSha256", "bucket", "objectKey", "metadataKey", "status",
    "creationTimestampIso", "lastUpdatedTimestampIso", "destination",
  ])
    && actual.targetId === expected.targetId
    && actual.plannedJobId === expected.plannedJobId
    && actual.jobId === expected.plannedJobId
    && actual.exportFamily === expected.exportFamily
    && typeof actual.providerResourceType === "string"
    && (
      actual.providerResourceType === expected.providerResourceType
      || (expected.exportFamily === "RDS_DATABASE"
        && (actual.providerResourceType === "RdsDBInstance"
          || actual.providerResourceType === "AuroraDBClusterStorage"))
    )
    && actual.requestSha256 === expected.requestSha256
    && typeof actual.requestSha256 === "string" && SHA256.test(actual.requestSha256)
    && typeof actual.targetId === "string" && TARGET_ID.test(actual.targetId)
    && actual.bucket === expected.bucket
    && actual.objectKey === expected.objectKey
    && actual.metadataKey === expected.metadataKey
    && actual.status === "COMPLETE"
    && canonicalTimestamp(actual.creationTimestampIso)
    && canonicalTimestamp(actual.lastUpdatedTimestampIso)
    && Date.parse(actual.lastUpdatedTimestampIso) >= Date.parse(actual.creationTimestampIso)
    && isRecord(actual.destination)
    && exactKeys(actual.destination, ["bucket", "objectKey", "metadataKey"])
    && actual.destination.bucket === expected.bucket
    && actual.destination.objectKey === expected.objectKey
    && actual.destination.metadataKey === expected.metadataKey;
}

function validateResponse(
  value: unknown,
  boundary: ComputeOptimizerExactDescribeRequest,
): ComputeOptimizerExactDescribeResponse {
  if (!isRecord(value) || !exactKeys(value, [
    "schema", "tenantId", "connectionId", "collectionJobId", "contractId",
    "accountId", "partition", "region", "observedAtIso", "jobs",
  ])) reject("BROKER_RESPONSE_INVALID");
  if (
    value.schema !== "sutra.compute-optimizer-export-exact-describe-response.v1"
    || value.tenantId !== boundary.tenantId
    || value.connectionId !== boundary.connectionId
    || value.collectionJobId !== boundary.collectionJobId
    || value.contractId !== boundary.contractId
    || value.accountId !== boundary.accountId
    || value.partition !== boundary.partition
    || value.region !== boundary.region
    || !canonicalTimestamp(value.observedAtIso)
    || !Array.isArray(value.jobs)
    || value.jobs.length !== boundary.plannedJobs.length
  ) reject("BROKER_RESPONSE_INVALID");
  const seenTargets = new Set<string>();
  const seenJobs = new Set<string>();
  for (let index = 0; index < boundary.plannedJobs.length; index += 1) {
    const expected = boundary.plannedJobs[index]!;
    const candidate = value.jobs[index];
    if (!isRecord(candidate) || !exactPlannedJob(candidate, expected)) {
      reject("JOB_SUBSTITUTION");
    }
    const targetId = candidate.targetId;
    const jobId = candidate.jobId;
    if (typeof targetId !== "string" || typeof jobId !== "string") {
      reject("JOB_SUBSTITUTION");
    }
    if (seenTargets.has(targetId) || seenJobs.has(jobId)) {
      reject("JOB_SUBSTITUTION");
    }
    seenTargets.add(targetId);
    seenJobs.add(jobId);
  }
  return value as unknown as ComputeOptimizerExactDescribeResponse;
}

function assertFreshRequest(
  request: ComputeOptimizerExportDescribeRequest,
  boundary: ComputeOptimizerExactDescribeRequest,
): void {
  if (
    !isRecord(request)
    || !exactKeys(request, ["region", "jobIds", "maxResults"])
    || request.region !== boundary.region
    || request.maxResults !== 1_000
    || !Array.isArray(request.jobIds)
    || request.jobIds.length !== boundary.plannedJobs.length
  ) reject("INVALID_FRESH_REQUEST");
  const expected = boundary.plannedJobs
    .map(({ plannedJobId }) => plannedJobId)
    .sort((left, right) => left.localeCompare(right));
  if (request.jobIds.some((value, index) => value !== expected[index])) {
    reject("INVALID_FRESH_REQUEST");
  }
}

function hardBoundary<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
  deadlineAtMs: number,
  now: (() => number) | undefined,
): Promise<T> {
  return new Promise<T>((resolve, rejectPromise) => {
    const controller = new AbortController();
    let settled = false;
    const timer: { current?: ReturnType<typeof setTimeout> } = {};
    const finish = (value:
      | { readonly ok: true; readonly result: T }
      | { readonly ok: false; readonly error: unknown }): void => {
      if (settled) return;
      settled = true;
      if (timer.current !== undefined) clearTimeout(timer.current);
      parentSignal.removeEventListener("abort", onAbort);
      if (!value.ok) controller.abort();
      if (value.ok) resolve(value.result);
      else rejectPromise(value.error);
    };
    const onAbort = (): void => finish({
      ok: false,
      error: new ComputeOptimizerExactDescribeReaderError("ABORTED"),
    });
    if (parentSignal.aborted) return onAbort();
    const remaining = deadlineAtMs - readNow(now);
    if (remaining <= 0) return finish({
      ok: false,
      error: new ComputeOptimizerExactDescribeReaderError("DEADLINE_EXCEEDED"),
    });
    parentSignal.addEventListener("abort", onAbort, { once: true });
    timer.current = setTimeout(() => finish({
      ok: false,
      error: new ComputeOptimizerExactDescribeReaderError("DEADLINE_EXCEEDED"),
    }), remaining);
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (result) => finish({ ok: true, result }),
        (error: unknown) => finish({ ok: false, error }),
      );
  });
}

export function createComputeOptimizerExactDescribeReader(
  unsafeBoundary: ComputeOptimizerExactDescribeRequest,
  transport: ComputeOptimizerExactDescribeTransport,
  options: ComputeOptimizerExactDescribeReaderOptions = {},
): ComputeOptimizerExportDescribeReader {
  if (
    (typeof transport !== "object" && typeof transport !== "function")
    || transport === null
    || typeof transport.describeExact !== "function"
    || typeof options !== "object"
    || options === null
    || Array.isArray(options)
  ) reject("INVALID_CONFIGURATION");
  const boundary = cloneBoundary(unsafeBoundary);
  if (!CONNECTION_ID.test(boundary.connectionId)) reject("INVALID_CONFIGURATION");
  const startedAt = readNow(options.now);
  const requestedDeadline = options.deadlineAtMs ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(requestedDeadline) || requestedDeadline < 0) {
    reject("INVALID_CONFIGURATION");
  }
  const deadlineAtMs = Math.min(
    requestedDeadline,
    startedAt + MAXIMUM_DURATION_MS,
  );
  if (deadlineAtMs <= startedAt) reject("DEADLINE_EXCEEDED");
  let used = false;
  return async (
    request: ComputeOptimizerExportDescribeRequest,
    signal: AbortSignal,
  ): Promise<ComputeOptimizerExportDescribePage> => {
    if (!(signal instanceof AbortSignal)) reject("INVALID_FRESH_REQUEST");
    if (used) reject("INVALID_FRESH_REQUEST");
    assertFreshRequest(request, boundary);
    used = true;
    let value: unknown;
    try {
      value = await hardBoundary(
        (boundedSignal) => transport.describeExact(boundary, {
          signal: boundedSignal,
          deadlineAtMs,
        }),
        signal,
        deadlineAtMs,
        options.now,
      );
    } catch (error) {
      if (error instanceof ComputeOptimizerExactDescribeReaderError) throw error;
      reject("TRANSPORT_FAILED");
    }
    let response: ComputeOptimizerExactDescribeResponse;
    try {
      response = validateResponse(value, boundary);
    } catch (error) {
      if (error instanceof ComputeOptimizerExactDescribeReaderError) throw error;
      return reject("BROKER_RESPONSE_INVALID");
    }
    return {
      recommendationExportJobs: response.jobs.map((job) => ({
        jobId: job.jobId,
        resourceType: job.providerResourceType,
        status: "Complete",
        creationTimestamp: job.creationTimestampIso,
        lastUpdatedTimestamp: job.lastUpdatedTimestampIso,
        destination: {
          s3: {
            bucket: job.destination.bucket,
            key: job.destination.objectKey,
            metadataKey: job.destination.metadataKey,
          },
        },
      })),
    };
  };
}
