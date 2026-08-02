/**
 * Credential-owning, exact-ID freshness transport for sealed AWS Compute
 * Optimizer exports. The public request cannot list jobs or supply provider
 * filters, and the response contains only the exact completed jobs that were
 * fixed by the immutable plan.
 */
import {
  ComputeOptimizerClient,
  DescribeRecommendationExportJobsCommand,
  type DescribeRecommendationExportJobsRequest,
  type DescribeRecommendationExportJobsResponse,
  type RecommendationExportJob,
} from "@aws-sdk/client-compute-optimizer";

import { workloadIdentityAwsClientConfig } from "./role-broker.js";
import type { AwsPartition, AwsTemporaryCredentials } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const ACCOUNT_ID = /^\d{12}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const TARGET_ID = /^coelt_[a-f0-9]{64}$/u;
const TOKEN = /^[^\u0000-\u001f\u007f]{1,4096}$/u;
const BUCKET =
  /^(?!\d{1,3}(?:\.\d{1,3}){3}$)(?!.*\.\.)(?!.*\.-)(?!.*-\.)(?!xn--)(?!.*-s3alias$)(?!.*--ol-s3$)(?!.*\.mrap$)(?!.*--x-s3$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const MAX_KEY_BYTES = 1_024;

export const COMPUTE_OPTIMIZER_EXACT_DESCRIBE_BOUNDS = Object.freeze({
  maximumPlannedJobs: 8,
  maximumPages: 8,
  maximumResultsPerPage: 1_000,
  maximumOutputBytes: 128 * 1_024,
  maximumOverallDeadlineMs: 30_000,
  maximumCommandDeadlineMs: 10_000,
  visibilityMs: 7 * DAY_MS,
  allowedClockSkewMs: 5 * 60 * 1_000,
} as const);

export type ComputeOptimizerExactDescribeExportFamily =
  | "EC2_INSTANCE"
  | "AUTO_SCALING_GROUP"
  | "EBS_VOLUME"
  | "LAMBDA_FUNCTION"
  | "ECS_SERVICE"
  | "LICENSE"
  | "RDS_DATABASE"
  | "IDLE_RESOURCE";

export type ComputeOptimizerExactDescribeProviderResourceType =
  | "Ec2Instance"
  | "AutoScalingGroup"
  | "EbsVolume"
  | "LambdaFunction"
  | "EcsService"
  | "License"
  | "RdsDBInstance"
  | "AuroraDBClusterStorage"
  | "Idle";

const RESOURCE_TYPES_BY_FAMILY: Readonly<Record<
  ComputeOptimizerExactDescribeExportFamily,
  ReadonlySet<ComputeOptimizerExactDescribeProviderResourceType>
>> = Object.freeze({
  EC2_INSTANCE: new Set<ComputeOptimizerExactDescribeProviderResourceType>(["Ec2Instance"]),
  AUTO_SCALING_GROUP: new Set<ComputeOptimizerExactDescribeProviderResourceType>(["AutoScalingGroup"]),
  EBS_VOLUME: new Set<ComputeOptimizerExactDescribeProviderResourceType>(["EbsVolume"]),
  LAMBDA_FUNCTION: new Set<ComputeOptimizerExactDescribeProviderResourceType>(["LambdaFunction"]),
  ECS_SERVICE: new Set<ComputeOptimizerExactDescribeProviderResourceType>(["EcsService"]),
  LICENSE: new Set<ComputeOptimizerExactDescribeProviderResourceType>(["License"]),
  RDS_DATABASE: new Set<ComputeOptimizerExactDescribeProviderResourceType>([
    "RdsDBInstance", "AuroraDBClusterStorage",
  ]),
  IDLE_RESOURCE: new Set<ComputeOptimizerExactDescribeProviderResourceType>(["Idle"]),
});

export interface ComputeOptimizerExactDescribePlannedJob {
  /** Immutable pre-launch target identity; distinct from the provider job ID. */
  readonly targetId: string;
  readonly plannedJobId: string;
  readonly exportFamily: ComputeOptimizerExactDescribeExportFamily;
  readonly providerResourceType: ComputeOptimizerExactDescribeProviderResourceType;
  readonly requestSha256: string;
  readonly bucket: string;
  readonly objectKey: string;
  readonly metadataKey: string;
}

export interface ComputeOptimizerExactDescribeRequest {
  readonly schema: "sutra.compute-optimizer-export-exact-describe-request.v1";
  readonly tenantId: string;
  readonly connectionId: string;
  readonly collectionJobId: string;
  readonly contractId: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly region: string;
  readonly plannedJobs: readonly ComputeOptimizerExactDescribePlannedJob[];
}

export interface ComputeOptimizerExactDescribeCompletedJob
  extends ComputeOptimizerExactDescribePlannedJob {
  readonly jobId: string;
  readonly status: "COMPLETE";
  readonly creationTimestampIso: string;
  readonly lastUpdatedTimestampIso: string;
  readonly destination: {
    readonly bucket: string;
    readonly objectKey: string;
    readonly metadataKey: string;
  };
}

export interface ComputeOptimizerExactDescribeResponse {
  readonly schema: "sutra.compute-optimizer-export-exact-describe-response.v1";
  readonly tenantId: string;
  readonly connectionId: string;
  readonly collectionJobId: string;
  readonly contractId: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly region: string;
  readonly observedAtIso: string;
  readonly jobs: readonly ComputeOptimizerExactDescribeCompletedJob[];
}

export interface ComputeOptimizerExactDescribeReader {
  describeRecommendationExportJobs(
    input: DescribeRecommendationExportJobsRequest,
    signal: AbortSignal,
  ): Promise<Pick<
    DescribeRecommendationExportJobsResponse,
    "recommendationExportJobs" | "nextToken"
  >>;
}

export interface DescribeComputeOptimizerExactExportJobsOptions {
  readonly now?: () => Date;
  readonly reader?: ComputeOptimizerExactDescribeReader;
  readonly abortSignal?: AbortSignal;
  readonly maximumPages?: number;
  readonly overallDeadlineMs?: number;
  readonly commandDeadlineMs?: number;
}

export class ComputeOptimizerExactDescribeError extends Error {
  public readonly code:
    | "INVALID_REQUEST"
    | "ABORTED"
    | "DESCRIBE_FAILED"
    | "DESCRIBE_TIMEOUT"
    | "PAGINATION_INVALID"
    | "PROVIDER_RESPONSE_INVALID"
    | "JOB_SUBSTITUTION"
    | "MISSING_JOB"
    | "DUPLICATE_JOB"
    | "EXPIRED"
    | "OUTPUT_LIMIT_EXCEEDED";

  public constructor(code: ComputeOptimizerExactDescribeError["code"]) {
    super("Compute Optimizer exact export describe request rejected");
    this.name = "ComputeOptimizerExactDescribeError";
    this.code = code;
  }
}

function reject(code: ComputeOptimizerExactDescribeError["code"]): never {
  throw new ComputeOptimizerExactDescribeError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validKey(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_KEY_BYTES
    || value.startsWith("/")
    || /[%\\*?\u0000]/u.test(value)
  ) return false;
  return !value.split("/").some((part) =>
    part.length === 0 || part === "." || part === ".."
  );
}

function regionMatchesPartition(region: string, partition: AwsPartition): boolean {
  if (partition === "aws-cn") return region.startsWith("cn-");
  if (partition === "aws-us-gov") return region.startsWith("us-gov-");
  return !region.startsWith("cn-") && !region.startsWith("us-gov-");
}

function validPlannedJob(value: unknown, region: string):
value is ComputeOptimizerExactDescribePlannedJob {
  if (!isRecord(value) || !exactKeys(value, [
    "targetId", "plannedJobId", "exportFamily", "providerResourceType", "requestSha256",
    "bucket", "objectKey", "metadataKey",
  ])) return false;
  if (
    typeof value.targetId !== "string" || !TARGET_ID.test(value.targetId)
    || typeof value.plannedJobId !== "string" || !JOB_ID.test(value.plannedJobId)
    || typeof value.exportFamily !== "string"
    || !(value.exportFamily in RESOURCE_TYPES_BY_FAMILY)
    || typeof value.providerResourceType !== "string"
    || !(RESOURCE_TYPES_BY_FAMILY[
      value.exportFamily as ComputeOptimizerExactDescribeExportFamily
    ] as ReadonlySet<string>).has(value.providerResourceType)
    || typeof value.requestSha256 !== "string" || !SHA256.test(value.requestSha256)
    || typeof value.bucket !== "string" || !BUCKET.test(value.bucket)
    || !validKey(value.objectKey) || !validKey(value.metadataKey)
  ) return false;
  const objectKey = value.objectKey;
  return objectKey.endsWith(`-${value.plannedJobId}.csv`)
    && objectKey.split("/").at(-1)?.startsWith(`${region}-`) === true
    && value.metadataKey === `${objectKey.slice(0, -4)}-metadata.json`;
}

export function parseComputeOptimizerExactDescribeRequest(
  body: string,
  pathConnectionId: string,
): ComputeOptimizerExactDescribeRequest {
  let candidate: unknown;
  try {
    candidate = JSON.parse(body) as unknown;
  } catch {
    return reject("INVALID_REQUEST");
  }
  if (!isRecord(candidate) || !exactKeys(candidate, [
    "schema", "tenantId", "connectionId", "collectionJobId", "contractId",
    "accountId", "partition", "region", "plannedJobs",
  ])) reject("INVALID_REQUEST");
  if (
    candidate.schema !== "sutra.compute-optimizer-export-exact-describe-request.v1"
    || typeof candidate.tenantId !== "string" || !IDENTIFIER.test(candidate.tenantId)
    || typeof candidate.connectionId !== "string"
    || !CONNECTION_ID.test(candidate.connectionId)
    || candidate.connectionId !== pathConnectionId
    || typeof candidate.collectionJobId !== "string"
    || !IDENTIFIER.test(candidate.collectionJobId)
    || typeof candidate.contractId !== "string" || !IDENTIFIER.test(candidate.contractId)
    || typeof candidate.accountId !== "string" || !ACCOUNT_ID.test(candidate.accountId)
    || (candidate.partition !== "aws"
      && candidate.partition !== "aws-us-gov"
      && candidate.partition !== "aws-cn")
    || typeof candidate.region !== "string" || !REGION.test(candidate.region)
    || !regionMatchesPartition(candidate.region, candidate.partition)
    || !Array.isArray(candidate.plannedJobs)
    || candidate.plannedJobs.length < 1
    || candidate.plannedJobs.length
      > COMPUTE_OPTIMIZER_EXACT_DESCRIBE_BOUNDS.maximumPlannedJobs
    || candidate.plannedJobs.some((job) => !validPlannedJob(job, candidate.region as string))
  ) reject("INVALID_REQUEST");
  const plannedJobs = candidate.plannedJobs as unknown as ComputeOptimizerExactDescribePlannedJob[];
  if (
    new Set(plannedJobs.map(({ plannedJobId }) => plannedJobId)).size
      !== plannedJobs.length
    || new Set(plannedJobs.map(({ targetId }) => targetId)).size
      !== plannedJobs.length
    || new Set(plannedJobs.map(({ exportFamily }) => exportFamily)).size
      !== plannedJobs.length
  ) reject("INVALID_REQUEST");
  return candidate as unknown as ComputeOptimizerExactDescribeRequest;
}

function safeLimit(value: number | undefined, maximum: number): number {
  const candidate = value ?? maximum;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    reject("INVALID_REQUEST");
  }
  return candidate;
}

function readNow(now: (() => Date) | undefined): Date {
  let candidate: unknown;
  try {
    candidate = (now ?? (() => new Date()))();
  } catch {
    reject("INVALID_REQUEST");
  }
  if (!(candidate instanceof Date) || !Number.isSafeInteger(candidate.getTime())) {
    reject("INVALID_REQUEST");
  }
  return new Date(candidate.getTime());
}

function timestamp(value: unknown, observedAtMs: number): string {
  if (!(value instanceof Date)) reject("PROVIDER_RESPONSE_INVALID");
  const milliseconds = value.getTime();
  if (
    !Number.isSafeInteger(milliseconds)
    || milliseconds < 0
    || milliseconds > observedAtMs
      + COMPUTE_OPTIMIZER_EXACT_DESCRIBE_BOUNDS.allowedClockSkewMs
  ) reject("PROVIDER_RESPONSE_INVALID");
  return new Date(milliseconds).toISOString();
}

function normalizeJob(
  value: RecommendationExportJob,
  planned: ComputeOptimizerExactDescribePlannedJob,
  observedAtMs: number,
): ComputeOptimizerExactDescribeCompletedJob {
  if (
    value.jobId !== planned.plannedJobId
    || typeof value.resourceType !== "string"
    || !(RESOURCE_TYPES_BY_FAMILY[planned.exportFamily] as ReadonlySet<string>)
      .has(value.resourceType)
    || value.status !== "Complete"
    || (value.failureReason !== undefined && value.failureReason !== null)
    || value.destination?.s3?.bucket !== planned.bucket
    || value.destination.s3.key !== planned.objectKey
    || value.destination.s3.metadataKey !== planned.metadataKey
  ) reject("JOB_SUBSTITUTION");
  const creationTimestampIso = timestamp(value.creationTimestamp, observedAtMs);
  const lastUpdatedTimestampIso = timestamp(value.lastUpdatedTimestamp, observedAtMs);
  const creationMs = Date.parse(creationTimestampIso);
  const lastUpdatedMs = Date.parse(lastUpdatedTimestampIso);
  if (lastUpdatedMs < creationMs) reject("PROVIDER_RESPONSE_INVALID");
  if (observedAtMs - creationMs >= COMPUTE_OPTIMIZER_EXACT_DESCRIBE_BOUNDS.visibilityMs) {
    reject("EXPIRED");
  }
  return {
    ...planned,
    jobId: planned.plannedJobId,
    providerResourceType:
      value.resourceType as ComputeOptimizerExactDescribeProviderResourceType,
    status: "COMPLETE",
    creationTimestampIso,
    lastUpdatedTimestampIso,
    destination: {
      bucket: planned.bucket,
      objectKey: planned.objectKey,
      metadataKey: planned.metadataKey,
    },
  };
}

function endpoint(partition: AwsPartition, region: string): string {
  const suffix = partition === "aws-cn" ? "amazonaws.com.cn" : "amazonaws.com";
  return `https://compute-optimizer.${region}.${suffix}`;
}

export function createAwsComputeOptimizerExactDescribeReader(
  partition: AwsPartition,
  region: string,
  credentials: AwsTemporaryCredentials,
): ComputeOptimizerExactDescribeReader {
  if (!REGION.test(region) || !regionMatchesPartition(region, partition)) {
    reject("INVALID_REQUEST");
  }
  const client = new ComputeOptimizerClient({
    ...workloadIdentityAwsClientConfig(region, 3),
    endpoint: endpoint(partition, region),
    credentials,
  });
  return {
    describeRecommendationExportJobs: (input, signal) => client.send(
      new DescribeRecommendationExportJobsCommand(input),
      { abortSignal: signal },
    ),
  };
}

function timeoutPromise(
  controller: AbortController,
  milliseconds: number,
  code: "DESCRIBE_TIMEOUT" | "ABORTED",
): { readonly promise: Promise<never>; readonly cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, rejectPromise) => {
    timer = setTimeout(() => {
      controller.abort();
      rejectPromise(new ComputeOptimizerExactDescribeError(code));
    }, milliseconds);
  });
  return { promise, cancel: () => { if (timer !== undefined) clearTimeout(timer); } };
}

async function withCommandDeadline<T>(
  read: (signal: AbortSignal) => Promise<T>,
  overallSignal: AbortSignal,
  deadlineMs: number,
): Promise<T> {
  if (overallSignal.aborted) reject("ABORTED");
  const controller = new AbortController();
  let rejectParent: ((error: ComputeOptimizerExactDescribeError) => void) | undefined;
  const parentBoundary = new Promise<never>((_resolve, rejectPromise) => {
    rejectParent = rejectPromise;
  });
  void parentBoundary.catch(() => undefined);
  const onAbort = (): void => {
    controller.abort(overallSignal.reason);
    rejectParent?.(new ComputeOptimizerExactDescribeError("DESCRIBE_TIMEOUT"));
  };
  overallSignal.addEventListener("abort", onAbort, { once: true });
  const deadline = timeoutPromise(controller, deadlineMs, "DESCRIBE_TIMEOUT");
  try {
    return await Promise.race([
      Promise.resolve().then(() => read(controller.signal)),
      deadline.promise,
      parentBoundary,
    ]);
  } finally {
    deadline.cancel();
    overallSignal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

export async function describeComputeOptimizerExactExportJobs(
  unsafeRequest: ComputeOptimizerExactDescribeRequest,
  credentials: AwsTemporaryCredentials,
  options: DescribeComputeOptimizerExactExportJobsOptions = {},
): Promise<ComputeOptimizerExactDescribeResponse> {
  const request = parseComputeOptimizerExactDescribeRequest(
    JSON.stringify(unsafeRequest),
    unsafeRequest.connectionId,
  );
  const observedAt = readNow(options.now);
  const maximumPages = safeLimit(
    options.maximumPages,
    COMPUTE_OPTIMIZER_EXACT_DESCRIBE_BOUNDS.maximumPages,
  );
  const overallDeadlineMs = safeLimit(
    options.overallDeadlineMs,
    COMPUTE_OPTIMIZER_EXACT_DESCRIBE_BOUNDS.maximumOverallDeadlineMs,
  );
  const commandDeadlineMs = safeLimit(
    options.commandDeadlineMs,
    COMPUTE_OPTIMIZER_EXACT_DESCRIBE_BOUNDS.maximumCommandDeadlineMs,
  );
  if (options.abortSignal !== undefined && !(options.abortSignal instanceof AbortSignal)) {
    reject("INVALID_REQUEST");
  }
  const reader = options.reader ?? createAwsComputeOptimizerExactDescribeReader(
    request.partition,
    request.region,
    credentials,
  );
  const overall = new AbortController();
  let externallyAborted = false;
  let rejectOverall: ((error: ComputeOptimizerExactDescribeError) => void) | undefined;
  let boundarySettled = false;
  const overallBoundary = new Promise<never>((_resolve, rejectPromise) => {
    rejectOverall = rejectPromise;
  });
  // An abort can precede the first provider race by one microtask.
  void overallBoundary.catch(() => undefined);
  const stopOverall = (code: "ABORTED" | "DESCRIBE_TIMEOUT"): void => {
    if (boundarySettled) return;
    boundarySettled = true;
    overall.abort();
    rejectOverall?.(new ComputeOptimizerExactDescribeError(code));
  };
  const onExternalAbort = (): void => {
    externallyAborted = true;
    stopOverall("ABORTED");
  };
  if (options.abortSignal?.aborted === true) return reject("ABORTED");
  options.abortSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const overallTimer = setTimeout(
    () => stopOverall("DESCRIBE_TIMEOUT"),
    overallDeadlineMs,
  );

  const planned = new Map(request.plannedJobs.map((job) => [job.plannedJobId, job]));
  const accepted = new Map<string, ComputeOptimizerExactDescribeCompletedJob>();
  const tokens = new Set<string>();
  let nextToken: string | undefined;
  try {
    for (let page = 1; page <= maximumPages; page += 1) {
      let response: Pick<
        DescribeRecommendationExportJobsResponse,
        "recommendationExportJobs" | "nextToken"
      >;
      try {
        response = await Promise.race([
          withCommandDeadline(
            (signal) => reader.describeRecommendationExportJobs({
              jobIds: [...planned.keys()].sort(),
              maxResults:
                COMPUTE_OPTIMIZER_EXACT_DESCRIBE_BOUNDS.maximumResultsPerPage,
              ...(nextToken === undefined ? {} : { nextToken }),
            }, signal),
            overall.signal,
            commandDeadlineMs,
          ),
          overallBoundary,
        ]);
      } catch (error) {
        if (error instanceof ComputeOptimizerExactDescribeError) throw error;
        if (overall.signal.aborted) {
          reject(externallyAborted ? "ABORTED" : "DESCRIBE_TIMEOUT");
        }
        reject("DESCRIBE_FAILED");
      }
      if (!isRecord(response) || !Array.isArray(response.recommendationExportJobs)) {
        reject("PROVIDER_RESPONSE_INVALID");
      }
      if (response.recommendationExportJobs.length
        > COMPUTE_OPTIMIZER_EXACT_DESCRIBE_BOUNDS.maximumResultsPerPage) {
        reject("PROVIDER_RESPONSE_INVALID");
      }
      for (const providerJob of response.recommendationExportJobs) {
        if (!isRecord(providerJob) || typeof providerJob.jobId !== "string") {
          reject("PROVIDER_RESPONSE_INVALID");
        }
        const expected = planned.get(providerJob.jobId);
        if (expected === undefined) reject("JOB_SUBSTITUTION");
        if (accepted.has(providerJob.jobId)) reject("DUPLICATE_JOB");
        accepted.set(
          providerJob.jobId,
          normalizeJob(providerJob, expected, observedAt.getTime()),
        );
      }
      const token = response.nextToken;
      if (token === undefined || token === "") {
        nextToken = undefined;
        break;
      }
      if (
        typeof token !== "string"
        || !TOKEN.test(token)
        || tokens.has(token)
        || page === maximumPages
      ) reject("PAGINATION_INVALID");
      tokens.add(token);
      nextToken = token;
    }
    if (nextToken !== undefined) reject("PAGINATION_INVALID");
    if (accepted.size !== planned.size) reject("MISSING_JOB");
    const result: ComputeOptimizerExactDescribeResponse = {
      schema: "sutra.compute-optimizer-export-exact-describe-response.v1",
      tenantId: request.tenantId,
      connectionId: request.connectionId,
      collectionJobId: request.collectionJobId,
      contractId: request.contractId,
      accountId: request.accountId,
      partition: request.partition,
      region: request.region,
      observedAtIso: observedAt.toISOString(),
      jobs: request.plannedJobs.map((job) =>
        accepted.get(job.plannedJobId) ?? reject("MISSING_JOB")
      ),
    };
    if (Buffer.byteLength(JSON.stringify(result), "utf8")
      > COMPUTE_OPTIMIZER_EXACT_DESCRIBE_BOUNDS.maximumOutputBytes) {
      reject("OUTPUT_LIMIT_EXCEEDED");
    }
    return result;
  } catch (error) {
    if (error instanceof ComputeOptimizerExactDescribeError) throw error;
    return reject("PROVIDER_RESPONSE_INVALID");
  } finally {
    clearTimeout(overallTimer);
    boundarySettled = true;
    options.abortSignal?.removeEventListener("abort", onExternalAbort);
    overall.abort();
  }
}
