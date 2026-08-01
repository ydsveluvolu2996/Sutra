/**
 * Bounded discovery of AWS Compute Optimizer organization enrollment and
 * recommendation export jobs.
 *
 * This collector is intentionally read-only. It never starts an export and it
 * never follows an S3 destination returned by AWS. Reading export objects is
 * permitted only after a separate, persisted provisioning contract binds the
 * exact bucket and prefix to the tenant. Until that contract exists, this
 * runner returns partial evidence with hashed destination identities.
 */
import { createHash } from "node:crypto";
import {
  ComputeOptimizerClient,
  DescribeRecommendationExportJobsCommand,
  GetEnrollmentStatusCommand,
  GetEnrollmentStatusesForOrganizationCommand,
  type AccountEnrollmentStatus,
  type DescribeRecommendationExportJobsRequest,
  type DescribeRecommendationExportJobsResponse,
  type GetEnrollmentStatusRequest,
  type GetEnrollmentStatusResponse,
  type GetEnrollmentStatusesForOrganizationRequest,
  type GetEnrollmentStatusesForOrganizationResponse,
  type RecommendationExportJob,
} from "@aws-sdk/client-compute-optimizer";

import { workloadIdentityAwsClientConfig } from "./role-broker.js";
import type { AwsPartition, AwsTemporaryCredentials } from "./types.js";

export const COMPUTE_OPTIMIZER_EXPORT_MAX_MEMBER_PAGES = 10;
export const COMPUTE_OPTIMIZER_EXPORT_MAX_JOB_PAGES = 10;
export const COMPUTE_OPTIMIZER_EXPORT_MAX_MEMBER_ACCOUNTS = 1_000;
export const COMPUTE_OPTIMIZER_EXPORT_MAX_JOBS = 5_000;
export const COMPUTE_OPTIMIZER_EXPORT_MAX_OUTPUT_BYTES = 4 * 1_024 * 1_024;
export const COMPUTE_OPTIMIZER_EXPORT_OVERALL_DEADLINE_MS = 2 * 60_000;
export const COMPUTE_OPTIMIZER_EXPORT_COMMAND_DEADLINE_MS = 15_000;

const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const SAFE_TOKEN = /^[^\u0000-\u001f\u007f]{1,4096}$/u;
const MAX_SAFE_COUNT = 1_000_000_000;

export const COMPUTE_OPTIMIZER_EXPORT_DISCOVERY_OPERATIONS = Object.freeze([
  "compute-optimizer:GetEnrollmentStatus",
  "compute-optimizer:GetEnrollmentStatusesForOrganization",
  "compute-optimizer:DescribeRecommendationExportJobs",
] as const);

export type ComputeOptimizerExportDiscoveryOperation =
  | "GET_ENROLLMENT_STATUS"
  | "GET_ENROLLMENT_STATUSES_FOR_ORGANIZATION"
  | "DESCRIBE_RECOMMENDATION_EXPORT_JOBS";

export interface ComputeOptimizerExportDiscoveryCoverage {
  readonly operation: ComputeOptimizerExportDiscoveryOperation;
  readonly status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  readonly pagesObserved: number;
  readonly recordsObserved: number;
  readonly recordsAccepted: number;
  readonly recordsRejected: number;
  readonly recordsOmitted: number;
  readonly errorCode: string | null;
}

export interface NormalizedComputeOptimizerEnrollment {
  readonly status: "ACTIVE" | "INACTIVE" | "PENDING" | "FAILED";
  readonly reasonCode: string | null;
  readonly memberAccountsEnrolled: boolean | null;
  readonly numberOfMemberAccountsOptedIn: number | null;
  readonly lastUpdatedAt: string | null;
}

export interface NormalizedComputeOptimizerMemberEnrollment {
  readonly accountId: string;
  readonly status: NormalizedComputeOptimizerEnrollment["status"];
  readonly reasonCode: string | null;
  readonly lastUpdatedAt: string | null;
}

export interface NormalizedComputeOptimizerExportJob {
  readonly jobId: string;
  readonly resourceType: string;
  readonly status: "QUEUED" | "IN_PROGRESS" | "COMPLETE" | "FAILED";
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly failureCode: string | null;
  readonly destination: {
    readonly bucketSha256: string | null;
    readonly objectKeySha256: string | null;
    readonly metadataKeySha256: string | null;
  };
}

export interface ComputeOptimizerExportDiscoveryCollection {
  readonly schemaVersion: "sutra.aws-compute-optimizer-export-discovery.v1";
  readonly source: "AWS_COMPUTE_OPTIMIZER_ORGANIZATION_EXPORT_DISCOVERY";
  readonly status: "PARTIAL" | "UNAVAILABLE";
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly region: string;
  readonly collectedAt: string;
  readonly dataThroughAt: string | null;
  readonly enrollment: NormalizedComputeOptimizerEnrollment | null;
  readonly memberEnrollments: readonly NormalizedComputeOptimizerMemberEnrollment[];
  readonly exportJobs: readonly NormalizedComputeOptimizerExportJob[];
  readonly coverage: readonly ComputeOptimizerExportDiscoveryCoverage[];
  readonly limitations: readonly string[];
}

export interface ComputeOptimizerExportDiscoveryReader {
  getEnrollmentStatus(
    input: GetEnrollmentStatusRequest,
    abortSignal?: AbortSignal,
  ): Promise<GetEnrollmentStatusResponse>;
  getEnrollmentStatusesForOrganization(
    input: GetEnrollmentStatusesForOrganizationRequest,
    abortSignal?: AbortSignal,
  ): Promise<Pick<
    GetEnrollmentStatusesForOrganizationResponse,
    "accountEnrollmentStatuses" | "nextToken"
  >>;
  describeRecommendationExportJobs(
    input: DescribeRecommendationExportJobsRequest,
    abortSignal?: AbortSignal,
  ): Promise<Pick<
    DescribeRecommendationExportJobsResponse,
    "recommendationExportJobs" | "nextToken"
  >>;
}

export interface ComputeOptimizerExportDiscoveryOptions {
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly region: string;
  readonly credentials: AwsTemporaryCredentials;
  readonly now?: () => Date;
  readonly client?: ComputeOptimizerExportDiscoveryReader;
  readonly maximumMemberPages?: number;
  readonly maximumJobPages?: number;
  readonly maximumMemberAccounts?: number;
  readonly maximumJobs?: number;
  readonly maximumOutputBytes?: number;
  readonly overallDeadlineMs?: number;
  readonly commandDeadlineMs?: number;
  readonly abortSignal?: AbortSignal;
}

interface PageCollection<T> {
  readonly records: readonly T[];
  readonly coverage: ComputeOptimizerExportDiscoveryCoverage;
}

export async function collectComputeOptimizerExportDiscovery(
  options: ComputeOptimizerExportDiscoveryOptions,
): Promise<ComputeOptimizerExportDiscoveryCollection> {
  const now = options.now?.() ?? new Date();
  assertInput(options, now);
  const limits = {
    memberPages: boundedLimit(
      options.maximumMemberPages,
      COMPUTE_OPTIMIZER_EXPORT_MAX_MEMBER_PAGES,
    ),
    jobPages: boundedLimit(
      options.maximumJobPages,
      COMPUTE_OPTIMIZER_EXPORT_MAX_JOB_PAGES,
    ),
    memberAccounts: boundedLimit(
      options.maximumMemberAccounts,
      COMPUTE_OPTIMIZER_EXPORT_MAX_MEMBER_ACCOUNTS,
    ),
    jobs: boundedLimit(options.maximumJobs, COMPUTE_OPTIMIZER_EXPORT_MAX_JOBS),
    outputBytes: boundedLimit(
      options.maximumOutputBytes,
      COMPUTE_OPTIMIZER_EXPORT_MAX_OUTPUT_BYTES,
    ),
    overallDeadlineMs: boundedLimit(
      options.overallDeadlineMs,
      COMPUTE_OPTIMIZER_EXPORT_OVERALL_DEADLINE_MS,
    ),
    commandDeadlineMs: boundedLimit(
      options.commandDeadlineMs,
      COMPUTE_OPTIMIZER_EXPORT_COMMAND_DEADLINE_MS,
    ),
  };
  const collectedAt = now.toISOString();
  const reader = options.client ?? createReader(
    options.credentials,
    options.partition,
    options.region,
  );
  const overall = new AbortController();
  const forwardAbort = (): void => overall.abort(options.abortSignal?.reason);
  if (options.abortSignal?.aborted === true) forwardAbort();
  else options.abortSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(
    () => overall.abort(new Error("Compute Optimizer collection deadline exceeded")),
    limits.overallDeadlineMs,
  );
  timer.unref?.();
  const cleanup = (): void => {
    clearTimeout(timer);
    options.abortSignal?.removeEventListener("abort", forwardAbort);
  };

  let enrollmentResponse: GetEnrollmentStatusResponse;
  try {
    enrollmentResponse = await withCommandDeadline(
      (signal) => reader.getEnrollmentStatus({}, signal),
      overall.signal,
      limits.commandDeadlineMs,
    );
  } catch (error) {
    cleanup();
    return unavailable(
      options,
      collectedAt,
      "GET_ENROLLMENT_STATUS",
      publicErrorCode(error, overall.signal),
    );
  }
  const enrollment = normalizeEnrollment(enrollmentResponse);
  if (enrollment === null) {
    cleanup();
    return unavailable(
      options,
      collectedAt,
      "GET_ENROLLMENT_STATUS",
      "PROVIDER_RESPONSE_INVALID",
    );
  }
  const enrollmentCoverage = successfulCoverage("GET_ENROLLMENT_STATUS", 1);

  const [members, jobs] = await Promise.all([
    collectPages({
      operation: "GET_ENROLLMENT_STATUSES_FOR_ORGANIZATION",
      maximumPages: limits.memberPages,
      maximumRecords: limits.memberAccounts,
      pageSize: 100,
      overallSignal: overall.signal,
      commandDeadlineMs: limits.commandDeadlineMs,
      read: (nextToken, signal) => reader.getEnrollmentStatusesForOrganization({
        maxResults: 100,
        ...(nextToken === undefined ? {} : { nextToken }),
      }, signal).then((response) => ({
        ...(response.accountEnrollmentStatuses === undefined
          ? {}
          : { records: response.accountEnrollmentStatuses }),
        ...(response.nextToken === undefined ? {} : { nextToken: response.nextToken }),
      })),
      normalize: normalizeMemberEnrollment,
      identity: (entry) => entry.accountId,
    }),
    collectPages({
      operation: "DESCRIBE_RECOMMENDATION_EXPORT_JOBS",
      maximumPages: limits.jobPages,
      maximumRecords: limits.jobs,
      pageSize: 1_000,
      overallSignal: overall.signal,
      commandDeadlineMs: limits.commandDeadlineMs,
      read: (nextToken, signal) => reader.describeRecommendationExportJobs({
        maxResults: 1_000,
        ...(nextToken === undefined ? {} : { nextToken }),
      }, signal).then((response) => ({
        ...(response.recommendationExportJobs === undefined
          ? {}
          : { records: response.recommendationExportJobs }),
        ...(response.nextToken === undefined ? {} : { nextToken: response.nextToken }),
      })),
      normalize: normalizeExportJob,
      identity: (entry) => entry.jobId,
    }),
  ]);
  cleanup();

  const coverage = [enrollmentCoverage, members.coverage, jobs.coverage];
  const dataThroughAt = [
    enrollment.lastUpdatedAt,
    ...members.records.map((entry) => entry.lastUpdatedAt),
    ...jobs.records.map((entry) => entry.lastUpdatedAt),
  ].flatMap((entry) => entry === null ? [] : [entry]).sort().at(-1) ?? null;
  const result: ComputeOptimizerExportDiscoveryCollection = {
    schemaVersion: "sutra.aws-compute-optimizer-export-discovery.v1",
    source: "AWS_COMPUTE_OPTIMIZER_ORGANIZATION_EXPORT_DISCOVERY",
    status: "PARTIAL",
    accountId: options.accountId,
    partition: options.partition,
    region: options.region,
    collectedAt,
    dataThroughAt,
    enrollment,
    memberEnrollments: [...members.records].sort((left, right) =>
      left.accountId.localeCompare(right.accountId)
    ),
    exportJobs: [...jobs.records].sort((left, right) => left.jobId.localeCompare(right.jobId)),
    coverage,
    limitations: [...new Set([
      "READ_ONLY_EXPORT_DISCOVERY_ONLY",
      "EXPORT_JOBS_VISIBLE_FOR_SEVEN_DAYS_ONLY",
      "EXPORT_PROVISIONING_LEDGER_REQUIRED",
      "EXPORT_OBJECTS_NOT_READ_WITHOUT_ATTESTED_BUCKET_PREFIX",
      "DIRECT_RECOMMENDATION_APIS_NOT_COLLECTED",
      ...(enrollment.status === "ACTIVE"
        ? []
        : [`ENROLLMENT_STATUS_${enrollment.status}`]),
      ...(enrollment.memberAccountsEnrolled === true
        ? []
        : ["ORGANIZATION_MEMBER_ENROLLMENT_NOT_CONFIRMED"]),
      ...(coverage.every((entry) => entry.status === "SUCCEEDED")
        ? []
        : ["SOURCE_COVERAGE_INCOMPLETE"]),
    ])],
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > limits.outputBytes) {
    return unavailable(
      options,
      collectedAt,
      "DESCRIBE_RECOMMENDATION_EXPORT_JOBS",
      "OUTPUT_SIZE_LIMIT_REACHED",
    );
  }
  return result;
}

function createReader(
  credentials: AwsTemporaryCredentials,
  partition: AwsPartition,
  region: string,
): ComputeOptimizerExportDiscoveryReader {
  const client = new ComputeOptimizerClient({
    ...workloadIdentityAwsClientConfig(region, 3),
    endpoint: computeOptimizerEndpoint(partition, region),
    credentials,
  });
  return {
    getEnrollmentStatus: (input, abortSignal) => client.send(
      new GetEnrollmentStatusCommand(input),
      abortSignal === undefined ? undefined : { abortSignal },
    ),
    getEnrollmentStatusesForOrganization: (input, abortSignal) => client.send(
      new GetEnrollmentStatusesForOrganizationCommand(input),
      abortSignal === undefined ? undefined : { abortSignal },
    ),
    describeRecommendationExportJobs: (input, abortSignal) => client.send(
      new DescribeRecommendationExportJobsCommand(input),
      abortSignal === undefined ? undefined : { abortSignal },
    ),
  };
}

export function computeOptimizerEndpoint(partition: AwsPartition, region: string): string {
  if (!REGION.test(region) || !regionMatchesPartition(region, partition)) {
    throw new Error("Invalid Compute Optimizer endpoint scope");
  }
  const suffix = partition === "aws-cn" ? "amazonaws.com.cn" : "amazonaws.com";
  return `https://compute-optimizer.${region}.${suffix}`;
}

async function collectPages<TProvider, TNormalized>(input: {
  readonly operation: ComputeOptimizerExportDiscoveryOperation;
  readonly maximumPages: number;
  readonly maximumRecords: number;
  readonly pageSize: number;
  readonly overallSignal: AbortSignal;
  readonly commandDeadlineMs: number;
  readonly read: (
    nextToken: string | undefined,
    signal: AbortSignal,
  ) => Promise<{ readonly records?: readonly TProvider[]; readonly nextToken?: string }>;
  readonly normalize: (value: TProvider) => TNormalized | null;
  readonly identity: (value: TNormalized) => string;
}): Promise<PageCollection<TNormalized>> {
  const accepted = new Map<string, TNormalized>();
  const tokens = new Set<string>();
  let nextToken: string | undefined;
  let pagesObserved = 0;
  let recordsObserved = 0;
  let recordsRejected = 0;
  let recordsOmitted = 0;
  let errorCode: string | null = null;

  while (pagesObserved < input.maximumPages) {
    let page: { readonly records?: readonly TProvider[]; readonly nextToken?: string };
    try {
      page = await withCommandDeadline(
        (signal) => input.read(nextToken, signal),
        input.overallSignal,
        input.commandDeadlineMs,
      );
    } catch (error) {
      errorCode = publicErrorCode(error, input.overallSignal);
      break;
    }
    pagesObserved += 1;
    if (!Array.isArray(page.records)) {
      errorCode = "PROVIDER_RESPONSE_INVALID";
      break;
    }
    recordsObserved += page.records.length;
    for (const candidate of page.records) {
      if (accepted.size >= input.maximumRecords) {
        recordsOmitted += 1;
        errorCode ??= "RECORD_LIMIT_REACHED";
        continue;
      }
      const normalized = input.normalize(candidate);
      if (normalized === null) {
        recordsRejected += 1;
        errorCode ??= "NORMALIZATION_DROPPED";
        continue;
      }
      const id = input.identity(normalized);
      const previous = accepted.get(id);
      if (previous !== undefined) {
        recordsRejected += 1;
        errorCode = sameJson(previous, normalized)
          ? "DUPLICATE_RECORD"
          : "CONFLICTING_DUPLICATE";
        continue;
      }
      accepted.set(id, normalized);
    }
    if (page.nextToken === undefined || page.nextToken === "") {
      nextToken = undefined;
      break;
    }
    if (!SAFE_TOKEN.test(page.nextToken) || tokens.has(page.nextToken)) {
      errorCode = "INVALID_PAGINATION";
      break;
    }
    tokens.add(page.nextToken);
    nextToken = page.nextToken;
  }
  if (nextToken !== undefined && pagesObserved >= input.maximumPages) {
    errorCode ??= "PAGE_LIMIT_REACHED";
  }
  const records = [...accepted.values()];
  return {
    records,
    coverage: {
      operation: input.operation,
      status: errorCode === null ? "SUCCEEDED" : records.length === 0 ? "FAILED" : "PARTIAL",
      pagesObserved,
      recordsObserved,
      recordsAccepted: records.length,
      recordsRejected,
      recordsOmitted,
      errorCode,
    },
  };
}

function normalizeEnrollment(
  value: GetEnrollmentStatusResponse,
): NormalizedComputeOptimizerEnrollment | null {
  const status = normalizeEnrollmentStatus(value.status);
  const lastUpdatedAt = optionalTimestamp(value.lastUpdatedTimestamp);
  const count = value.numberOfMemberAccountsOptedIn;
  if (
    status === null || lastUpdatedAt === undefined ||
    (value.memberAccountsEnrolled !== undefined &&
      typeof value.memberAccountsEnrolled !== "boolean") ||
    (count !== undefined && (!Number.isSafeInteger(count) || count < 0 || count > MAX_SAFE_COUNT))
  ) return null;
  return {
    status,
    reasonCode: safeProviderReason(value.statusReason),
    memberAccountsEnrolled: value.memberAccountsEnrolled ?? null,
    numberOfMemberAccountsOptedIn: count ?? null,
    lastUpdatedAt,
  };
}

function normalizeMemberEnrollment(
  value: AccountEnrollmentStatus,
): NormalizedComputeOptimizerMemberEnrollment | null {
  const status = normalizeEnrollmentStatus(value.status);
  const lastUpdatedAt = optionalTimestamp(value.lastUpdatedTimestamp);
  if (!ACCOUNT_ID.test(value.accountId ?? "") || status === null || lastUpdatedAt === undefined) {
    return null;
  }
  return {
    accountId: value.accountId as string,
    status,
    reasonCode: safeProviderReason(value.statusReason),
    lastUpdatedAt,
  };
}

function normalizeExportJob(
  value: RecommendationExportJob,
): NormalizedComputeOptimizerExportJob | null {
  const status = normalizeJobStatus(value.status);
  const createdAt = requiredTimestamp(value.creationTimestamp);
  const lastUpdatedAt = requiredTimestamp(value.lastUpdatedTimestamp);
  const resourceType = normalizeResourceType(value.resourceType);
  if (
    !SAFE_ID.test(value.jobId ?? "") || status === null || resourceType === null ||
    createdAt === null || lastUpdatedAt === null || lastUpdatedAt < createdAt
  ) return null;
  const destination = value.destination?.s3;
  return {
    jobId: value.jobId as string,
    resourceType,
    status,
    createdAt,
    lastUpdatedAt,
    failureCode: status === "FAILED" ? safeProviderReason(value.failureReason)
      ?? "PROVIDER_REPORTED_FAILURE" : null,
    destination: {
      bucketSha256: hashOptionalIdentity(destination?.bucket),
      objectKeySha256: hashOptionalIdentity(destination?.key),
      metadataKeySha256: hashOptionalIdentity(destination?.metadataKey),
    },
  };
}

function normalizeEnrollmentStatus(
  value: unknown,
): NormalizedComputeOptimizerEnrollment["status"] | null {
  if (value === "Active") return "ACTIVE";
  if (value === "Inactive") return "INACTIVE";
  if (value === "Pending") return "PENDING";
  if (value === "Failed") return "FAILED";
  return null;
}

function normalizeJobStatus(
  value: unknown,
): NormalizedComputeOptimizerExportJob["status"] | null {
  if (value === "Queued") return "QUEUED";
  if (value === "InProgress") return "IN_PROGRESS";
  if (value === "Complete") return "COMPLETE";
  if (value === "Failed") return "FAILED";
  return null;
}

function normalizeResourceType(value: unknown): string | null {
  const mapping: Readonly<Record<string, string>> = {
    AuroraDBClusterStorage: "AURORA_DB_CLUSTER_STORAGE",
    AutoScalingGroup: "AUTO_SCALING_GROUP",
    EbsVolume: "EBS_VOLUME",
    Ec2Instance: "EC2_INSTANCE",
    EcsService: "ECS_SERVICE",
    Idle: "IDLE_RESOURCE",
    LambdaFunction: "LAMBDA_FUNCTION",
    License: "LICENSE",
    NotApplicable: "NOT_APPLICABLE",
    RdsDBInstance: "RDS_DB_INSTANCE",
  };
  return typeof value === "string" ? mapping[value] ?? null : null;
}

function hashOptionalIdentity(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024 ||
      /[\u0000-\u001f\u007f]/u.test(value)) return null;
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeProviderReason(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return /^[A-Za-z][A-Za-z0-9_]{0,95}$/u.test(value)
    ? value.replace(/([a-z])([A-Z])/gu, "$1_$2").toUpperCase()
    : "PROVIDER_REPORTED_REASON";
}

function requiredTimestamp(value: unknown): string | null {
  return value instanceof Date && Number.isFinite(value.getTime())
    ? value.toISOString()
    : null;
}

function optionalTimestamp(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  return value instanceof Date && Number.isFinite(value.getTime())
    ? value.toISOString()
    : undefined;
}

function successfulCoverage(
  operation: ComputeOptimizerExportDiscoveryOperation,
  recordsAccepted: number,
): ComputeOptimizerExportDiscoveryCoverage {
  return {
    operation,
    status: "SUCCEEDED",
    pagesObserved: 1,
    recordsObserved: recordsAccepted,
    recordsAccepted,
    recordsRejected: 0,
    recordsOmitted: 0,
    errorCode: null,
  };
}

function unavailable(
  options: Pick<ComputeOptimizerExportDiscoveryOptions, "accountId" | "partition" | "region">,
  collectedAt: string,
  operation: ComputeOptimizerExportDiscoveryOperation,
  errorCode: string,
): ComputeOptimizerExportDiscoveryCollection {
  return {
    schemaVersion: "sutra.aws-compute-optimizer-export-discovery.v1",
    source: "AWS_COMPUTE_OPTIMIZER_ORGANIZATION_EXPORT_DISCOVERY",
    status: "UNAVAILABLE",
    accountId: options.accountId,
    partition: options.partition,
    region: options.region,
    collectedAt,
    dataThroughAt: null,
    enrollment: null,
    memberEnrollments: [],
    exportJobs: [],
    coverage: [{
      operation,
      status: "FAILED",
      pagesObserved: 0,
      recordsObserved: 0,
      recordsAccepted: 0,
      recordsRejected: 0,
      recordsOmitted: 0,
      errorCode,
    }],
    limitations: [errorCode, "NO_PROVIDER_DATA_RETURNED"],
  };
}

function assertInput(options: ComputeOptimizerExportDiscoveryOptions, now: Date): void {
  if (
    !ACCOUNT_ID.test(options.accountId) ||
    !REGION.test(options.region) ||
    !regionMatchesPartition(options.region, options.partition) ||
    !Number.isFinite(now.getTime())
  ) throw new Error("Invalid Compute Optimizer collection input");
}

function regionMatchesPartition(region: string, partition: AwsPartition): boolean {
  if (partition === "aws-cn") return region.startsWith("cn-");
  if (partition === "aws-us-gov") return region.startsWith("us-gov-");
  return !region.startsWith("cn-") && !region.startsWith("us-gov-");
}

function boundedLimit(value: number | undefined, ceiling: number): number {
  const resolved = value ?? ceiling;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > ceiling) {
    throw new Error("Invalid Compute Optimizer collection limit");
  }
  return resolved;
}

async function withCommandDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  overallSignal: AbortSignal,
  commandDeadlineMs: number,
): Promise<T> {
  if (overallSignal.aborted) throw overallSignal.reason;
  const command = new AbortController();
  const forwardAbort = (): void => command.abort(overallSignal.reason);
  overallSignal.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(
    () => command.abort(new Error("Compute Optimizer command deadline exceeded")),
    commandDeadlineMs,
  );
  timer.unref?.();
  try {
    return await run(command.signal);
  } finally {
    clearTimeout(timer);
    overallSignal.removeEventListener("abort", forwardAbort);
  }
}

function publicErrorCode(error: unknown, overallSignal: AbortSignal): string {
  if (overallSignal.aborted || (error instanceof Error && error.name === "AbortError")) {
    return "COLLECTION_TIMEOUT";
  }
  const name = error instanceof Error ? error.name : "";
  if (/AccessDenied|Unauthorized|UnrecognizedClient/u.test(name)) return "ACCESS_DENIED";
  if (/OptInRequired/u.test(name)) return "ENROLLMENT_REQUIRED";
  if (/Throttl|TooManyRequests|RequestLimit/u.test(name)) return "RATE_LIMITED";
  if (/Validation/u.test(name)) return "PROVIDER_REQUEST_REJECTED";
  return "PROVIDER_REQUEST_FAILED";
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
