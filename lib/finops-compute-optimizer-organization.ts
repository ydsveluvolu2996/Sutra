/**
 * Evidence-honest AWS Compute Optimizer organization normalization.
 *
 * This trust-boundary module has no AWS credentials and performs no network or
 * database I/O. A signed collector transport may return the capture contract
 * below, but the app accepts it only for the server-pinned tenant, connection,
 * management account, partition, and Regions.
 *
 * Direct Get* recommendation APIs are current observations. They are never
 * represented as durable history. History is accepted only from a completed,
 * immutable, hash-addressed S3 recommendation export whose organization-wide
 * request is proven by Sutra's provisioning ledger.
 */
import type {
  FinopsSourceEvidence,
  FinopsSourceScope,
} from "./finops-source-health.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const COLLECTION_ID = /^co_[a-f0-9]{32}$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,95}$/u;
const BUCKET =
  /^(?!\d{1,3}(?:\.\d{1,3}){3}$)(?!.*\.\.)(?!.*\.-)(?!.*-\.)(?!xn--)(?!.*-s3alias$)(?!.*--ol-s3$)(?!.*\.mrap$)(?!.*--x-s3$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const ARN = /^arn:(aws|aws-us-gov|aws-cn):[a-z0-9-]+:[a-z0-9-]*:\d{12}:.+$/u;
const MAX_MONEY = 1_000_000_000_000;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;

export const COMPUTE_OPTIMIZER_COLLECTION_BOUNDS = Object.freeze({
  pageSize: 100,
  maximumConcurrency: 4,
  maximumDurationMs: 10 * 60 * 1_000,
  maximumCaptureBytes: 32 * 1_024 * 1_024,
  maximumExportBytes: 256 * 1_024 * 1_024,
  maximumRegions: 50,
  maximumAccounts: 1_000,
  maximumSequences: 5_000,
  maximumPagesPerSequence: 100,
  maximumPages: 20_000,
  maximumRecommendations: 100_000,
  maximumOptionsPerRecommendation: 10,
  maximumExportJobs: 5_000,
  maximumExportSnapshots: 2_000,
  maximumDashboardRecommendations: 500,
} as const);

export const COMPUTE_OPTIMIZER_READ_OPERATIONS = Object.freeze([
  "compute-optimizer:GetEnrollmentStatus",
  "compute-optimizer:GetEnrollmentStatusesForOrganization",
  "compute-optimizer:GetRecommendationSummaries",
  "compute-optimizer:GetEC2InstanceRecommendations",
  "compute-optimizer:GetAutoScalingGroupRecommendations",
  "compute-optimizer:GetEBSVolumeRecommendations",
  "compute-optimizer:GetLambdaFunctionRecommendations",
  "compute-optimizer:GetECSServiceRecommendations",
  "compute-optimizer:GetLicenseRecommendations",
  "compute-optimizer:GetRDSDatabaseRecommendations",
  "compute-optimizer:GetIdleRecommendations",
  "compute-optimizer:DescribeRecommendationExportJobs",
] as const);

export type AwsPartition = "aws" | "aws-us-gov" | "aws-cn";
export type ComputeOptimizerEnrollmentStatus =
  | "ACTIVE"
  | "INACTIVE"
  | "PENDING"
  | "FAILED";
export type ComputeOptimizerCollectorAccountType =
  | "MANAGEMENT"
  | "DELEGATED_ADMINISTRATOR"
  | "MEMBER";
export type ComputeOptimizerCollectionStatus =
  | "COMPLETE"
  | "PARTIAL"
  | "UNAVAILABLE";
export type ComputeOptimizerPageStatus =
  | "SUCCEEDED"
  | "PARTIAL"
  | "FAILED";
export type ComputeOptimizerExportStatus =
  | "QUEUED"
  | "IN_PROGRESS"
  | "COMPLETE"
  | "FAILED";
export type ComputeOptimizerConfigurationState =
  | "READY"
  | "ENROLLMENT_REQUIRED"
  | "ENROLLMENT_PENDING"
  | "ENROLLMENT_FAILED"
  | "ORGANIZATION_ACCESS_REQUIRED"
  | "EXPORT_CONFIGURATION_REQUIRED"
  | "EXPORT_IN_PROGRESS"
  | "EXPORT_FAILED"
  | "COLLECTION_PARTIAL"
  | "COLLECTION_UNAVAILABLE";

export type ComputeOptimizerResourceType =
  | "EC2_INSTANCE"
  | "AUTO_SCALING_GROUP"
  | "EBS_VOLUME"
  | "LAMBDA_FUNCTION"
  | "ECS_SERVICE"
  | "LICENSE"
  | "RDS_DB_INSTANCE"
  | "RDS_DB_STORAGE"
  | "AURORA_DB_CLUSTER_STORAGE"
  | "NAT_GATEWAY"
  | "DYNAMODB_TABLE"
  | "ELASTICACHE_CLUSTER"
  | "MEMORYDB_CLUSTER"
  | "DOCUMENTDB_CLUSTER"
  | "WORKSPACES"
  | "SAGEMAKER_ENDPOINT"
  | "IDLE_RESOURCE";

export type ComputeOptimizerGetOperation =
  | "GET_RECOMMENDATION_SUMMARIES"
  | "GET_EC2_INSTANCE_RECOMMENDATIONS"
  | "GET_AUTO_SCALING_GROUP_RECOMMENDATIONS"
  | "GET_EBS_VOLUME_RECOMMENDATIONS"
  | "GET_LAMBDA_FUNCTION_RECOMMENDATIONS"
  | "GET_ECS_SERVICE_RECOMMENDATIONS"
  | "GET_LICENSE_RECOMMENDATIONS"
  | "GET_RDS_DATABASE_RECOMMENDATIONS"
  | "GET_IDLE_RECOMMENDATIONS";

export interface ComputeOptimizerTenantBoundary {
  readonly scope: FinopsSourceScope;
  readonly managementAccountId: string;
  readonly partition: AwsPartition;
  readonly regions: readonly string[];
}

export interface ComputeOptimizerEnrollment {
  readonly status: ComputeOptimizerEnrollmentStatus;
  readonly lastUpdatedAt: string | null;
  readonly memberAccountsEnrolled: boolean;
  readonly numberOfMemberAccountsOptedIn: number | null;
  readonly collectorAccountType: ComputeOptimizerCollectorAccountType;
  /** Persisted authorization/configuration evidence, not an inference. */
  readonly trustedAccessEnabled: boolean | null;
  readonly readPermissionsValidated: boolean;
}

export interface ComputeOptimizerMemberEnrollment {
  readonly accountId: string;
  readonly status: ComputeOptimizerEnrollmentStatus;
  readonly lastUpdatedAt: string | null;
  /** Safe provider code only; raw statusReason is not retained. */
  readonly reasonCode: string | null;
}

export interface ComputeOptimizerSavings {
  readonly estimatedMonthlySavings: number;
  readonly percentage: number | null;
  readonly currency: string;
  readonly includesExistingDiscounts: boolean;
}

export interface ComputeOptimizerRecommendationOption {
  readonly rank: number;
  readonly targetConfiguration: string;
  readonly performanceRisk: number | null;
  readonly migrationEffort: "VERY_LOW" | "LOW" | "MEDIUM" | "HIGH" | null;
  readonly savings: ComputeOptimizerSavings | null;
}

export interface ComputeOptimizerRecommendationRecord {
  readonly accountId: string;
  readonly region: string;
  readonly resourceType: ComputeOptimizerResourceType;
  readonly resourceArn: string;
  readonly resourceId: string;
  readonly finding: string;
  readonly findingReasonCodes: readonly string[];
  readonly lastRefreshAt: string;
  readonly lookbackPeriodDays: number | null;
  readonly currentConfiguration: string | null;
  readonly currentPerformanceRisk: number | null;
  readonly options: readonly ComputeOptimizerRecommendationOption[];
}

export interface ComputeOptimizerSummaryRecord {
  readonly accountId: string;
  readonly region: string;
  readonly resourceType: ComputeOptimizerResourceType;
  readonly findingCounts: Readonly<Record<string, number>>;
  readonly savings: ComputeOptimizerSavings | null;
}

export interface ComputeOptimizerPage<T> {
  readonly request: {
    readonly accountId: string;
    readonly region: string;
    readonly maxResults: number;
    readonly nextToken: string | null;
    /** Full collection only. Filtered evidence cannot prove coverage. */
    readonly filters: readonly [];
  };
  readonly response: {
    readonly records: readonly T[];
    readonly nextToken: string | null;
  };
}

export interface ComputeOptimizerPageSequence<T> {
  readonly operation: ComputeOptimizerGetOperation;
  readonly accountId: string;
  readonly region: string;
  readonly pages: readonly ComputeOptimizerPage<T>[];
  readonly exhausted: boolean;
  readonly status: ComputeOptimizerPageStatus;
  readonly errorCode: string | null;
}

export interface ComputeOptimizerExportJobPageSequence {
  readonly region: string;
  readonly pages: readonly ComputeOptimizerPage<ComputeOptimizerExportJob>[];
  readonly exhausted: boolean;
  readonly status: ComputeOptimizerPageStatus;
  readonly errorCode: string | null;
}

export interface ComputeOptimizerExportJob {
  readonly jobId: string;
  readonly region: string;
  readonly resourceType: ComputeOptimizerResourceType;
  readonly status: ComputeOptimizerExportStatus;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly bucket: string | null;
  readonly objectKey: string | null;
  readonly metadataKey: string | null;
  readonly failureCode: string | null;
}

export interface ComputeOptimizerExportSnapshot {
  readonly jobId: string;
  readonly region: string;
  readonly resourceType: ComputeOptimizerResourceType;
  readonly bucket: string;
  readonly objectKey: string;
  readonly metadataKey: string;
  readonly objectSha256: string;
  readonly metadataSha256: string;
  readonly contentBytes: number;
  readonly parsedAt: string;
  readonly rowCount: number;
  /** Must come from Sutra's immutable export request ledger. */
  readonly organizationScopeVerified: boolean;
  readonly includeMemberAccounts: boolean;
  readonly recommendations: readonly ComputeOptimizerRecommendationRecord[];
}

export interface ComputeOptimizerExportConfiguration {
  readonly configured: boolean;
  readonly bucket: string | null;
  readonly keyPrefix: string | null;
  readonly includeMemberAccounts: boolean;
  readonly provisioningLedgerVerified: boolean;
}

export interface ComputeOptimizerOrganizationCapture {
  readonly schemaVersion: "sutra.compute-optimizer-organization.v1";
  readonly scope: FinopsSourceScope;
  readonly managementAccountId: string;
  readonly partition: AwsPartition;
  readonly regions: readonly string[];
  readonly collectionId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly maximumConcurrency: number;
  readonly enrollment: ComputeOptimizerEnrollment;
  readonly memberEnrollmentPages:
    readonly ComputeOptimizerPage<ComputeOptimizerMemberEnrollment>[];
  readonly memberEnrollmentExhausted: boolean;
  readonly summarySequences:
    readonly ComputeOptimizerPageSequence<ComputeOptimizerSummaryRecord>[];
  readonly recommendationSequences:
    readonly ComputeOptimizerPageSequence<ComputeOptimizerRecommendationRecord>[];
  readonly exportConfiguration: ComputeOptimizerExportConfiguration;
  readonly exportJobSequences: readonly ComputeOptimizerExportJobPageSequence[];
  readonly exportSnapshots: readonly ComputeOptimizerExportSnapshot[];
}

export interface NormalizedComputeOptimizerRecommendation
  extends ComputeOptimizerRecommendationRecord {
  readonly provenance: {
    readonly provider: "AWS_COMPUTE_OPTIMIZER";
    readonly evidenceKind: "DIRECT_GET_API" | "S3_EXPORT";
    readonly operation: ComputeOptimizerGetOperation | "S3_EXPORT";
    readonly exportJobId: string | null;
    readonly exportObjectSha256: string | null;
    readonly collectedAt: string;
  };
}

export interface ComputeOptimizerOrganizationSnapshot {
  readonly schemaVersion: "sutra.compute-optimizer-organization.v1";
  readonly scope: FinopsSourceScope;
  readonly managementAccountId: string;
  readonly partition: AwsPartition;
  readonly regions: readonly string[];
  readonly collectionId: string;
  readonly collectedAt: string;
  readonly collectionDurationMs: number;
  readonly status: ComputeOptimizerCollectionStatus;
  readonly configurationState: ComputeOptimizerConfigurationState;
  readonly enrollment: ComputeOptimizerEnrollment;
  readonly exportConfiguration: ComputeOptimizerExportConfiguration;
  readonly memberEnrollments: readonly ComputeOptimizerMemberEnrollment[];
  readonly summaries: readonly ComputeOptimizerSummaryRecord[];
  readonly currentRecommendations:
    readonly NormalizedComputeOptimizerRecommendation[];
  readonly historicalRecommendations:
    readonly NormalizedComputeOptimizerRecommendation[];
  readonly exportJobs: readonly ComputeOptimizerExportJob[];
  readonly exportSnapshots: readonly Omit<
    ComputeOptimizerExportSnapshot,
    "recommendations"
  >[];
  readonly evidence: {
    readonly readOperations: typeof COMPUTE_OPTIMIZER_READ_OPERATIONS;
    readonly pagesObserved: number;
    readonly recordsAccepted: number;
    readonly captureBytes: number;
    readonly exportBytes: number;
    readonly currentCoverageComplete: boolean;
    readonly organizationEnrollmentCoverageComplete: boolean;
    readonly organizationExportCoverageComplete: boolean;
    readonly localHeuristicsUsedAsAwsEvidence: false;
    readonly limitations: readonly string[];
  };
}

export type ComputeOptimizerFailureCode =
  | "INVALID_INPUT"
  | "SCOPE_MISMATCH"
  | "BYTE_LIMIT_EXCEEDED"
  | "TIME_LIMIT_EXCEEDED"
  | "PAGE_LIMIT_EXCEEDED"
  | "RECORD_LIMIT_EXCEEDED"
  | "INVALID_PAGINATION"
  | "CONFLICTING_DUPLICATE"
  | "UNVERIFIED_EXPORT";

export class ComputeOptimizerOrganizationError extends Error {
  public readonly code: ComputeOptimizerFailureCode;

  public constructor(code: ComputeOptimizerFailureCode) {
    super("AWS Compute Optimizer organization evidence was rejected");
    this.name = "ComputeOptimizerOrganizationError";
    this.code = code;
  }
}

export interface ComputeOptimizerBrokerRequest {
  readonly tenantId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly managementAccountId: string;
  readonly partition: AwsPartition;
  readonly regions: readonly string[];
  readonly collectionId: string;
  readonly maximumConcurrency: number;
}

export interface ComputeOptimizerBrokerTransport {
  collect(request: ComputeOptimizerBrokerRequest): Promise<unknown>;
}

export interface ComputeOptimizerQueryService {
  query(input: unknown): Promise<ComputeOptimizerOrganizationSnapshot>;
}

export class ComputeOptimizerQueryServiceError extends Error {
  public readonly code:
    | "INVALID_CONFIGURATION"
    | "INVALID_QUERY"
    | "COLLECTION_FAILED";

  public constructor(code: ComputeOptimizerQueryServiceError["code"]) {
    super("The AWS Compute Optimizer request could not be completed");
    this.name = "ComputeOptimizerQueryServiceError";
    this.code = code;
  }
}

const PARTITIONS = new Set<AwsPartition>(["aws", "aws-us-gov", "aws-cn"]);
const ENROLLMENT_STATUSES = new Set<ComputeOptimizerEnrollmentStatus>([
  "ACTIVE",
  "INACTIVE",
  "PENDING",
  "FAILED",
]);
const ACCOUNT_TYPES = new Set<ComputeOptimizerCollectorAccountType>([
  "MANAGEMENT",
  "DELEGATED_ADMINISTRATOR",
  "MEMBER",
]);
const PAGE_STATUSES = new Set<ComputeOptimizerPageStatus>([
  "SUCCEEDED",
  "PARTIAL",
  "FAILED",
]);
const EXPORT_STATUSES = new Set<ComputeOptimizerExportStatus>([
  "QUEUED",
  "IN_PROGRESS",
  "COMPLETE",
  "FAILED",
]);
const RESOURCE_TYPES = new Set<ComputeOptimizerResourceType>([
  "EC2_INSTANCE",
  "AUTO_SCALING_GROUP",
  "EBS_VOLUME",
  "LAMBDA_FUNCTION",
  "ECS_SERVICE",
  "LICENSE",
  "RDS_DB_INSTANCE",
  "RDS_DB_STORAGE",
  "AURORA_DB_CLUSTER_STORAGE",
  "NAT_GATEWAY",
  "DYNAMODB_TABLE",
  "ELASTICACHE_CLUSTER",
  "MEMORYDB_CLUSTER",
  "DOCUMENTDB_CLUSTER",
  "WORKSPACES",
  "SAGEMAKER_ENDPOINT",
  "IDLE_RESOURCE",
]);
const OPERATIONS = new Set<ComputeOptimizerGetOperation>([
  "GET_RECOMMENDATION_SUMMARIES",
  "GET_EC2_INSTANCE_RECOMMENDATIONS",
  "GET_AUTO_SCALING_GROUP_RECOMMENDATIONS",
  "GET_EBS_VOLUME_RECOMMENDATIONS",
  "GET_LAMBDA_FUNCTION_RECOMMENDATIONS",
  "GET_ECS_SERVICE_RECOMMENDATIONS",
  "GET_LICENSE_RECOMMENDATIONS",
  "GET_RDS_DATABASE_RECOMMENDATIONS",
  "GET_IDLE_RECOMMENDATIONS",
]);

function reject(code: ComputeOptimizerFailureCode): never {
  throw new ComputeOptimizerOrganizationError(code);
}

function rejectQuery(
  code: ComputeOptimizerQueryServiceError["code"],
): never {
  throw new ComputeOptimizerQueryServiceError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function assertNoCredentialMaterial(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
): void {
  if (depth > 32) reject("INVALID_INPUT");
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) reject("INVALID_INPUT");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertNoCredentialMaterial(entry, depth + 1, seen);
    }
  } else {
    for (const [key, entry] of Object.entries(value)) {
      if (
        /^(?:credentials|temporaryCredentials|accessKeyId|secretAccessKey|sessionToken|authorization|cookie)$/iu
          .test(key)
      ) reject("INVALID_INPUT");
      assertNoCredentialMaterial(entry, depth + 1, seen);
    }
  }
  seen.delete(value);
}

function validScope(value: unknown): value is FinopsSourceScope {
  return isRecord(value)
    && validText(value.orgId, 128)
    && IDENTIFIER.test(value.orgId)
    && validText(value.customerId, 128)
    && IDENTIFIER.test(value.customerId)
    && validText(value.connectionId, 37)
    && CONNECTION_ID.test(value.connectionId);
}

function sameBoundary(
  capture: ComputeOptimizerOrganizationCapture,
  expected: ComputeOptimizerTenantBoundary,
): boolean {
  return capture.scope.orgId === expected.scope.orgId
    && capture.scope.customerId === expected.scope.customerId
    && capture.scope.connectionId === expected.scope.connectionId
    && capture.managementAccountId === expected.managementAccountId
    && capture.partition === expected.partition
    && JSON.stringify(capture.regions) === JSON.stringify(expected.regions);
}

function timestamp(value: unknown, maximumMs: number): string {
  if (!validText(value, 40)) reject("INVALID_INPUT");
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== value
    || milliseconds > maximumMs
  ) reject("INVALID_INPUT");
  return value;
}

function nullableTimestamp(
  value: unknown,
  maximumMs: number,
): string | null {
  return value === null ? null : timestamp(value, maximumMs);
}

function safeCode(value: unknown): string {
  if (!validText(value, 96) || !SAFE_CODE.test(value)) {
    reject("INVALID_INPUT");
  }
  return value;
}

function nullableCode(value: unknown): string | null {
  return value === null ? null : safeCode(value);
}

function finite(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
  ) reject("INVALID_INPUT");
  return value;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) reject("INVALID_INPUT");
  return value as number;
}

function validToken(value: unknown): value is string | null {
  return value === null
    || (
      validText(value, 4_096)
      && !/[^\u0020-\u007e]/u.test(value)
    );
}

function normalizeRegions(value: unknown): readonly string[] {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumRegions
    || !value.every((region) =>
      typeof region === "string" && REGION.test(region)
    )
  ) reject("INVALID_INPUT");
  const sorted = [...new Set(value)].sort();
  if (sorted.length !== value.length || JSON.stringify(sorted) !== JSON.stringify(value)) {
    reject("INVALID_INPUT");
  }
  return sorted;
}

function validateBoundary(value: unknown): asserts value is ComputeOptimizerTenantBoundary {
  if (
    !isRecord(value)
    || !validScope(value.scope)
    || typeof value.managementAccountId !== "string"
    || !ACCOUNT_ID.test(value.managementAccountId)
    || typeof value.partition !== "string"
    || !PARTITIONS.has(value.partition as AwsPartition)
  ) reject("INVALID_INPUT");
  normalizeRegions(value.regions);
}

/**
 * Creates a request service whose tenant and AWS scope can only come from
 * server-side configuration. The public query accepts exactly an empty object;
 * provider/transport details are collapsed to a generic client-safe error.
 */
export function createComputeOptimizerQueryService(
  boundary: ComputeOptimizerTenantBoundary,
  transport: ComputeOptimizerBrokerTransport,
  dependencies: {
    readonly now?: () => Date;
    readonly createCollectionId?: () => string;
  } = {},
): ComputeOptimizerQueryService {
  try {
    validateBoundary(boundary);
  } catch {
    return rejectQuery("INVALID_CONFIGURATION");
  }
  if (typeof transport?.collect !== "function") {
    return rejectQuery("INVALID_CONFIGURATION");
  }
  const pinned: ComputeOptimizerTenantBoundary = {
    scope: { ...boundary.scope },
    managementAccountId: boundary.managementAccountId,
    partition: boundary.partition,
    regions: [...boundary.regions],
  };
  const now = dependencies.now ?? (() => new Date());
  const createCollectionId = dependencies.createCollectionId
    ?? (() => `co_${crypto.randomUUID().replaceAll("-", "")}`);
  return {
    async query(input: unknown): Promise<ComputeOptimizerOrganizationSnapshot> {
      if (
        !isRecord(input)
        || Object.keys(input).length !== 0
      ) rejectQuery("INVALID_QUERY");
      const observedNow = now();
      if (!Number.isFinite(observedNow.getTime())) {
        rejectQuery("INVALID_CONFIGURATION");
      }
      const collectionId = createCollectionId();
      if (!COLLECTION_ID.test(collectionId)) {
        rejectQuery("INVALID_CONFIGURATION");
      }
      try {
        const response = await transport.collect({
          tenantId: pinned.scope.orgId,
          customerId: pinned.scope.customerId,
          connectionId: pinned.scope.connectionId,
          managementAccountId: pinned.managementAccountId,
          partition: pinned.partition,
          regions: [...pinned.regions],
          collectionId,
          maximumConcurrency:
            COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumConcurrency,
        });
        const snapshot = normalizeComputeOptimizerOrganizationCapture(
          response,
          pinned,
          observedNow,
        );
        if (snapshot.collectionId !== collectionId) reject("SCOPE_MISMATCH");
        return snapshot;
      } catch {
        return rejectQuery("COLLECTION_FAILED");
      }
    },
  };
}

function validateEnrollment(
  value: unknown,
  completedAtMs: number,
): ComputeOptimizerEnrollment {
  if (
    !isRecord(value)
    || typeof value.status !== "string"
    || !ENROLLMENT_STATUSES.has(
      value.status as ComputeOptimizerEnrollmentStatus,
    )
    || typeof value.memberAccountsEnrolled !== "boolean"
    || (
      value.numberOfMemberAccountsOptedIn !== null
      && (
        !Number.isSafeInteger(value.numberOfMemberAccountsOptedIn)
        || Number(value.numberOfMemberAccountsOptedIn) < 0
        || Number(value.numberOfMemberAccountsOptedIn)
          > COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumAccounts
      )
    )
    || typeof value.collectorAccountType !== "string"
    || !ACCOUNT_TYPES.has(
      value.collectorAccountType as ComputeOptimizerCollectorAccountType,
    )
    || (
      value.trustedAccessEnabled !== null
      && typeof value.trustedAccessEnabled !== "boolean"
    )
    || typeof value.readPermissionsValidated !== "boolean"
  ) reject("INVALID_INPUT");
  return {
    status: value.status as ComputeOptimizerEnrollmentStatus,
    lastUpdatedAt: nullableTimestamp(value.lastUpdatedAt, completedAtMs),
    memberAccountsEnrolled: value.memberAccountsEnrolled,
    numberOfMemberAccountsOptedIn:
      value.numberOfMemberAccountsOptedIn as number | null,
    collectorAccountType:
      value.collectorAccountType as ComputeOptimizerCollectorAccountType,
    trustedAccessEnabled: value.trustedAccessEnabled as boolean | null,
    readPermissionsValidated: value.readPermissionsValidated,
  };
}

function normalizeSavings(value: unknown): ComputeOptimizerSavings | null {
  if (value === null) return null;
  if (
    !isRecord(value)
    || typeof value.currency !== "string"
    || !CURRENCY.test(value.currency)
    || typeof value.includesExistingDiscounts !== "boolean"
  ) reject("INVALID_INPUT");
  return {
    estimatedMonthlySavings: finite(
      value.estimatedMonthlySavings,
      0,
      MAX_MONEY,
    ),
    percentage: value.percentage === null
      ? null
      : finite(value.percentage, 0, 100),
    currency: value.currency,
    includesExistingDiscounts: value.includesExistingDiscounts,
  };
}

function stringList(
  value: unknown,
  maximumItems: number,
  maximumText: number,
  codes = false,
): readonly string[] {
  if (
    !Array.isArray(value)
    || value.length > maximumItems
    || !value.every((entry) =>
      validText(entry, maximumText)
      && (!codes || SAFE_CODE.test(entry))
    )
  ) reject("INVALID_INPUT");
  const sorted = [...new Set(value)].sort();
  if (sorted.length !== value.length) reject("INVALID_INPUT");
  return sorted;
}

function validBucket(value: unknown): value is string {
  return typeof value === "string" && BUCKET.test(value);
}

function validObjectKey(value: unknown): value is string {
  return validText(value, 1_024)
    && !value.startsWith("/")
    && !value.includes("\\")
    && value.split("/").every((segment) =>
      segment.length > 0 && segment !== "." && segment !== ".."
    );
}

function resourceArn(
  value: unknown,
  accountId: string,
  partition: AwsPartition,
  region: string,
): string {
  if (!validText(value, 1_024) || !ARN.test(value)) reject("INVALID_INPUT");
  const match = ARN.exec(value);
  if (
    match?.[1] !== partition
    || !value.includes(`:${region}:${accountId}:`)
  ) {
    reject("SCOPE_MISMATCH");
  }
  return value;
}

function normalizeOption(value: unknown): ComputeOptimizerRecommendationOption {
  if (
    !isRecord(value)
    || (
      value.migrationEffort !== null
      && !new Set(["VERY_LOW", "LOW", "MEDIUM", "HIGH"]).has(
        value.migrationEffort as string,
      )
    )
  ) reject("INVALID_INPUT");
  return {
    rank: integer(
      value.rank,
      1,
      COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumOptionsPerRecommendation,
    ),
    targetConfiguration: validText(value.targetConfiguration, 2_048)
      ? value.targetConfiguration
      : reject("INVALID_INPUT"),
    performanceRisk: value.performanceRisk === null
      ? null
      : finite(value.performanceRisk, 0, 5),
    migrationEffort:
      value.migrationEffort as ComputeOptimizerRecommendationOption[
        "migrationEffort"
      ],
    savings: normalizeSavings(value.savings),
  };
}

function normalizeRecommendation(
  value: unknown,
  partition: AwsPartition,
  completedAtMs: number,
): ComputeOptimizerRecommendationRecord {
  if (
    !isRecord(value)
    || typeof value.accountId !== "string"
    || !ACCOUNT_ID.test(value.accountId)
    || typeof value.region !== "string"
    || !REGION.test(value.region)
    || typeof value.resourceType !== "string"
    || !RESOURCE_TYPES.has(value.resourceType as ComputeOptimizerResourceType)
    || !validText(value.resourceId, 1_024)
    || !validText(value.finding, 128)
    || (
      value.lookbackPeriodDays !== null
      && (
        typeof value.lookbackPeriodDays !== "number"
        || !Number.isFinite(value.lookbackPeriodDays)
        || value.lookbackPeriodDays < 0
        || value.lookbackPeriodDays > 366
      )
    )
    || (
      value.currentConfiguration !== null
      && !validText(value.currentConfiguration, 2_048)
    )
    || (
      value.currentPerformanceRisk !== null
      && (
        typeof value.currentPerformanceRisk !== "number"
        || !Number.isFinite(value.currentPerformanceRisk)
        || value.currentPerformanceRisk < 0
        || value.currentPerformanceRisk > 5
      )
    )
    || !Array.isArray(value.options)
    || value.options.length
      > COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumOptionsPerRecommendation
  ) reject("INVALID_INPUT");
  const options = value.options.map(normalizeOption)
    .sort((left, right) => left.rank - right.rank);
  if (
    new Set(options.map((option) => option.rank)).size !== options.length
  ) reject("CONFLICTING_DUPLICATE");
  return {
    accountId: value.accountId,
    region: value.region,
    resourceType: value.resourceType as ComputeOptimizerResourceType,
    resourceArn: resourceArn(
      value.resourceArn,
      value.accountId,
      partition,
      value.region,
    ),
    resourceId: value.resourceId,
    finding: value.finding,
    findingReasonCodes: stringList(
      value.findingReasonCodes,
      100,
      96,
      true,
    ),
    lastRefreshAt: timestamp(value.lastRefreshAt, completedAtMs + CLOCK_SKEW_MS),
    lookbackPeriodDays: value.lookbackPeriodDays as number | null,
    currentConfiguration: value.currentConfiguration as string | null,
    currentPerformanceRisk: value.currentPerformanceRisk as number | null,
    options,
  };
}

function normalizeSummary(
  value: unknown,
): ComputeOptimizerSummaryRecord {
  if (
    !isRecord(value)
    || typeof value.accountId !== "string"
    || !ACCOUNT_ID.test(value.accountId)
    || typeof value.region !== "string"
    || !REGION.test(value.region)
    || typeof value.resourceType !== "string"
    || !RESOURCE_TYPES.has(value.resourceType as ComputeOptimizerResourceType)
    || !isRecord(value.findingCounts)
    || Object.keys(value.findingCounts).length > 50
  ) reject("INVALID_INPUT");
  const counts: Record<string, number> = {};
  for (const [key, count] of Object.entries(value.findingCounts).sort()) {
    if (!validText(key, 128)) reject("INVALID_INPUT");
    counts[key] = integer(count, 0, 100_000_000);
  }
  return {
    accountId: value.accountId,
    region: value.region,
    resourceType: value.resourceType as ComputeOptimizerResourceType,
    findingCounts: counts,
    savings: normalizeSavings(value.savings),
  };
}

function normalizeMemberEnrollment(
  value: unknown,
  completedAtMs: number,
): ComputeOptimizerMemberEnrollment {
  if (
    !isRecord(value)
    || typeof value.accountId !== "string"
    || !ACCOUNT_ID.test(value.accountId)
    || typeof value.status !== "string"
    || !ENROLLMENT_STATUSES.has(
      value.status as ComputeOptimizerEnrollmentStatus,
    )
  ) reject("INVALID_INPUT");
  return {
    accountId: value.accountId,
    status: value.status as ComputeOptimizerEnrollmentStatus,
    lastUpdatedAt: nullableTimestamp(value.lastUpdatedAt, completedAtMs),
    reasonCode: nullableCode(value.reasonCode),
  };
}

function normalizeExportJob(
  value: unknown,
  completedAtMs: number,
): ComputeOptimizerExportJob {
  if (
    !isRecord(value)
    || !validText(value.jobId, 128)
    || !JOB_ID.test(value.jobId)
    || typeof value.region !== "string"
    || !REGION.test(value.region)
    || typeof value.resourceType !== "string"
    || !RESOURCE_TYPES.has(value.resourceType as ComputeOptimizerResourceType)
    || typeof value.status !== "string"
    || !EXPORT_STATUSES.has(value.status as ComputeOptimizerExportStatus)
  ) reject("INVALID_INPUT");
  const status = value.status as ComputeOptimizerExportStatus;
  const failureCode = nullableCode(value.failureCode);
  if (
    (status === "FAILED") !== (failureCode !== null)
    || (status === "COMPLETE"
      && (
        !validBucket(value.bucket)
        || !validObjectKey(value.objectKey)
        || !validObjectKey(value.metadataKey)
      ))
    || (
      status !== "COMPLETE"
      && (
        value.bucket !== null
        || value.objectKey !== null
        || value.metadataKey !== null
      )
    )
  ) reject("INVALID_INPUT");
  return {
    jobId: value.jobId,
    region: value.region,
    resourceType: value.resourceType as ComputeOptimizerResourceType,
    status,
    createdAt: timestamp(value.createdAt, completedAtMs),
    lastUpdatedAt: timestamp(value.lastUpdatedAt, completedAtMs + CLOCK_SKEW_MS),
    bucket: value.bucket as string | null,
    objectKey: value.objectKey as string | null,
    metadataKey: value.metadataKey as string | null,
    failureCode,
  };
}

interface PageContext {
  readonly expectedAccountId: string;
  readonly expectedRegion: string;
  readonly completedAtMs: number;
  readonly partition: AwsPartition;
}

function normalizePages<T>(
  pages: readonly ComputeOptimizerPage<unknown>[],
  exhausted: boolean,
  context: PageContext,
  normalize: (value: unknown) => T,
): readonly T[] {
  if (
    !Array.isArray(pages)
    || pages.length > COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumPagesPerSequence
  ) reject("PAGE_LIMIT_EXCEEDED");
  if (pages.length === 0) {
    if (exhausted) reject("INVALID_PAGINATION");
    return [];
  }
  let expectedToken: string | null = null;
  const seenTokens = new Set<string>();
  const output: T[] = [];
  for (const page of pages) {
    if (
      !isRecord(page)
      || !isRecord(page.request)
      || !isRecord(page.response)
      || page.request.accountId !== context.expectedAccountId
      || page.request.region !== context.expectedRegion
      || page.request.maxResults !== COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.pageSize
      || !Array.isArray(page.request.filters)
      || page.request.filters.length !== 0
      || !validToken(page.request.nextToken)
      || page.request.nextToken !== expectedToken
    || !Array.isArray(page.response.records)
      || page.response.records.length
        > COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.pageSize
      || !validToken(page.response.nextToken)
    ) reject("INVALID_PAGINATION");
    if (
      page.request.nextToken !== null
      && seenTokens.has(page.request.nextToken)
    ) reject("INVALID_PAGINATION");
    if (page.request.nextToken !== null) seenTokens.add(page.request.nextToken);
    if (
      page.response.nextToken !== null
      && seenTokens.has(page.response.nextToken)
    ) reject("INVALID_PAGINATION");
    output.push(...page.response.records.map(normalize));
    expectedToken = page.response.nextToken;
  }
  if (exhausted !== (expectedToken === null)) reject("INVALID_PAGINATION");
  return output;
}

function addStable<T>(
  map: Map<string, T>,
  key: string,
  value: T,
): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, value);
    return;
  }
  if (JSON.stringify(existing) !== JSON.stringify(value)) {
    reject("CONFLICTING_DUPLICATE");
  }
}

function recommendationKey(
  value: ComputeOptimizerRecommendationRecord,
): string {
  return [
    value.accountId,
    value.region,
    value.resourceType,
    value.resourceArn,
  ].join("|");
}

function resourceAllowedForOperation(
  operation: ComputeOptimizerGetOperation,
  resourceType: ComputeOptimizerResourceType,
): boolean {
  const expected: Partial<
    Record<ComputeOptimizerGetOperation, readonly ComputeOptimizerResourceType[]>
  > = {
    GET_EC2_INSTANCE_RECOMMENDATIONS: ["EC2_INSTANCE"],
    GET_AUTO_SCALING_GROUP_RECOMMENDATIONS: ["AUTO_SCALING_GROUP"],
    GET_EBS_VOLUME_RECOMMENDATIONS: ["EBS_VOLUME"],
    GET_LAMBDA_FUNCTION_RECOMMENDATIONS: ["LAMBDA_FUNCTION"],
    GET_ECS_SERVICE_RECOMMENDATIONS: ["ECS_SERVICE"],
    GET_LICENSE_RECOMMENDATIONS: ["LICENSE"],
    GET_RDS_DATABASE_RECOMMENDATIONS: [
      "RDS_DB_INSTANCE",
      "RDS_DB_STORAGE",
      "AURORA_DB_CLUSTER_STORAGE",
    ],
    GET_IDLE_RECOMMENDATIONS: ["IDLE_RESOURCE"],
  };
  return expected[operation]?.includes(resourceType) === true;
}

function normalizeExportConfiguration(
  value: unknown,
): ComputeOptimizerExportConfiguration {
  if (
    !isRecord(value)
    || typeof value.configured !== "boolean"
    || typeof value.includeMemberAccounts !== "boolean"
    || typeof value.provisioningLedgerVerified !== "boolean"
    || (
      value.configured
      && (
        !validBucket(value.bucket)
        || !validObjectKey(value.keyPrefix)
      )
    )
    || (
      !value.configured
      && (value.bucket !== null || value.keyPrefix !== null)
    )
  ) reject("INVALID_INPUT");
  return value as unknown as ComputeOptimizerExportConfiguration;
}

function validateExportSnapshot(
  value: unknown,
  job: ComputeOptimizerExportJob | undefined,
  capture: ComputeOptimizerOrganizationCapture,
  completedAtMs: number,
): {
  readonly descriptor: Omit<ComputeOptimizerExportSnapshot, "recommendations">;
  readonly recommendations: readonly ComputeOptimizerRecommendationRecord[];
} {
  if (
    !isRecord(value)
    || job === undefined
    || job.status !== "COMPLETE"
    || value.jobId !== job.jobId
    || value.region !== job.region
    || value.resourceType !== job.resourceType
    || value.bucket !== job.bucket
    || value.objectKey !== job.objectKey
    || value.metadataKey !== job.metadataKey
    || typeof value.objectSha256 !== "string"
    || !SHA256.test(value.objectSha256)
    || typeof value.metadataSha256 !== "string"
    || !SHA256.test(value.metadataSha256)
    || typeof value.organizationScopeVerified !== "boolean"
    || typeof value.includeMemberAccounts !== "boolean"
    || !Array.isArray(value.recommendations)
  ) reject("UNVERIFIED_EXPORT");
  const contentBytes = integer(
    value.contentBytes,
    1,
    COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumExportBytes,
  );
  const rowCount = integer(
    value.rowCount,
    0,
    COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumRecommendations,
  );
  if (
    !value.organizationScopeVerified
    || !value.includeMemberAccounts
    || !capture.exportConfiguration.configured
    || !capture.exportConfiguration.includeMemberAccounts
    || !capture.exportConfiguration.provisioningLedgerVerified
    || value.bucket !== capture.exportConfiguration.bucket
    || !(value.objectKey as string).startsWith(
      `${capture.exportConfiguration.keyPrefix}/`,
    )
    || !(value.metadataKey as string).startsWith(
      `${capture.exportConfiguration.keyPrefix}/`,
    )
  ) reject("UNVERIFIED_EXPORT");
  const recommendations = value.recommendations.map((entry) =>
    normalizeRecommendation(entry, capture.partition, completedAtMs)
  );
  if (
    recommendations.length !== rowCount
    || recommendations.some((entry) =>
      entry.region !== value.region || entry.resourceType !== value.resourceType
    )
  ) reject("UNVERIFIED_EXPORT");
  return {
    descriptor: {
      jobId: value.jobId as string,
      region: value.region as string,
      resourceType: value.resourceType as ComputeOptimizerResourceType,
      bucket: value.bucket as string,
      objectKey: value.objectKey as string,
      metadataKey: value.metadataKey as string,
      objectSha256: value.objectSha256,
      metadataSha256: value.metadataSha256,
      contentBytes,
      parsedAt: timestamp(value.parsedAt, completedAtMs + CLOCK_SKEW_MS),
      rowCount,
      organizationScopeVerified: true,
      includeMemberAccounts: true,
    },
    recommendations,
  };
}

function configurationState(input: {
  readonly enrollment: ComputeOptimizerEnrollment;
  readonly exportConfiguration: ComputeOptimizerExportConfiguration;
  readonly exportJobs: readonly ComputeOptimizerExportJob[];
  readonly exportSnapshots: readonly Omit<
    ComputeOptimizerExportSnapshot,
    "recommendations"
  >[];
  readonly currentCoverageComplete: boolean;
  readonly organizationEnrollmentCoverageComplete: boolean;
  readonly readPermissionsValidated: boolean;
}): ComputeOptimizerConfigurationState {
  if (input.enrollment.status === "INACTIVE") return "ENROLLMENT_REQUIRED";
  if (input.enrollment.status === "PENDING") return "ENROLLMENT_PENDING";
  if (input.enrollment.status === "FAILED") return "ENROLLMENT_FAILED";
  if (
    input.enrollment.collectorAccountType !== "MANAGEMENT"
    || input.enrollment.trustedAccessEnabled !== true
    || !input.enrollment.memberAccountsEnrolled
    || !input.organizationEnrollmentCoverageComplete
  ) return "ORGANIZATION_ACCESS_REQUIRED";
  if (
    !input.exportConfiguration.configured
    || !input.exportConfiguration.includeMemberAccounts
    || !input.exportConfiguration.provisioningLedgerVerified
  ) return "EXPORT_CONFIGURATION_REQUIRED";
  if (
    input.exportJobs.some((job) =>
      job.status === "QUEUED" || job.status === "IN_PROGRESS"
    )
    && input.exportSnapshots.length === 0
  ) return "EXPORT_IN_PROGRESS";
  if (
    input.exportJobs.some((job) => job.status === "FAILED")
    && input.exportSnapshots.length === 0
  ) return "EXPORT_FAILED";
  if (!input.readPermissionsValidated) return "COLLECTION_UNAVAILABLE";
  if (!input.currentCoverageComplete || input.exportSnapshots.length === 0) {
    return "COLLECTION_PARTIAL";
  }
  return "READY";
}

export function normalizeComputeOptimizerOrganizationCapture(
  value: unknown,
  expectedBoundary: ComputeOptimizerTenantBoundary,
  now: Date = new Date(),
): ComputeOptimizerOrganizationSnapshot {
  validateBoundary(expectedBoundary);
  if (!isRecord(value)) reject("INVALID_INPUT");
  const capture = value as unknown as ComputeOptimizerOrganizationCapture;
  if (
    capture.schemaVersion !== "sutra.compute-optimizer-organization.v1"
    || !validScope(capture.scope)
    || typeof capture.managementAccountId !== "string"
    || !ACCOUNT_ID.test(capture.managementAccountId)
    || typeof capture.partition !== "string"
    || !PARTITIONS.has(capture.partition)
    || !COLLECTION_ID.test(capture.collectionId)
    || capture.maximumConcurrency
      !== COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumConcurrency
  ) reject("INVALID_INPUT");
  normalizeRegions(capture.regions);
  if (!sameBoundary(capture, expectedBoundary)) reject("SCOPE_MISMATCH");
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) reject("INVALID_INPUT");
  const completedAt = timestamp(capture.completedAt, nowMs + CLOCK_SKEW_MS);
  const completedAtMs = Date.parse(completedAt);
  const startedAt = timestamp(capture.startedAt, completedAtMs);
  const durationMs = completedAtMs - Date.parse(startedAt);
  if (
    durationMs < 0
    || durationMs > COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumDurationMs
  ) reject("TIME_LIMIT_EXCEEDED");
  let captureBytes: number;
  try {
    captureBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return reject("INVALID_INPUT");
  }
  if (
    captureBytes
      > COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumCaptureBytes
  ) reject("BYTE_LIMIT_EXCEEDED");
  assertNoCredentialMaterial(value);

  const enrollment = validateEnrollment(capture.enrollment, completedAtMs);
  const exportConfiguration = normalizeExportConfiguration(
    capture.exportConfiguration,
  );
  const memberEnrollments = normalizePages(
    capture.memberEnrollmentPages,
    capture.memberEnrollmentExhausted,
    {
      expectedAccountId: capture.managementAccountId,
      expectedRegion: capture.regions[0]!,
      completedAtMs,
      partition: capture.partition,
    },
    (entry) => normalizeMemberEnrollment(entry, completedAtMs),
  );
  const memberMap = new Map<string, ComputeOptimizerMemberEnrollment>();
  for (const member of memberEnrollments) {
    addStable(memberMap, member.accountId, member);
  }
  if (
    memberMap.size > COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumAccounts
  ) reject("RECORD_LIMIT_EXCEEDED");

  if (
    !Array.isArray(capture.summarySequences)
    || !Array.isArray(capture.recommendationSequences)
    || capture.summarySequences.length + capture.recommendationSequences.length
      > COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumSequences
  ) reject("RECORD_LIMIT_EXCEEDED");
  const allowedAccounts = new Set([
    capture.managementAccountId,
    ...[...memberMap.values()]
      .filter((member) => member.status === "ACTIVE")
      .map((member) => member.accountId),
  ]);
  const allowedRegions = new Set(capture.regions);
  const summaries = new Map<string, ComputeOptimizerSummaryRecord>();
  const current = new Map<string, NormalizedComputeOptimizerRecommendation>();
  let pageCount = capture.memberEnrollmentPages.length;
  let currentCoverageComplete = true;
  const observedCurrentSequences = new Set<string>();

  for (const sequence of capture.summarySequences) {
    if (
      sequence.operation !== "GET_RECOMMENDATION_SUMMARIES"
      || !allowedAccounts.has(sequence.accountId)
      || !allowedRegions.has(sequence.region)
      || !PAGE_STATUSES.has(sequence.status)
      || (sequence.status === "SUCCEEDED") !== (sequence.errorCode === null)
      || (sequence.status === "FAILED" && sequence.pages.length !== 0)
    ) reject("INVALID_INPUT");
    if (sequence.errorCode !== null) safeCode(sequence.errorCode);
    const sequenceKey = [
      sequence.operation,
      sequence.accountId,
      sequence.region,
    ].join("|");
    if (observedCurrentSequences.has(sequenceKey)) {
      reject("CONFLICTING_DUPLICATE");
    }
    observedCurrentSequences.add(sequenceKey);
    const records = normalizePages(
      sequence.pages,
      sequence.exhausted,
      {
        expectedAccountId: sequence.accountId,
        expectedRegion: sequence.region,
        completedAtMs,
        partition: capture.partition,
      },
      normalizeSummary,
    );
    pageCount += sequence.pages.length;
    if (sequence.status !== "SUCCEEDED" || !sequence.exhausted) {
      currentCoverageComplete = false;
    }
    for (const record of records) {
      if (
        record.accountId !== sequence.accountId
        || record.region !== sequence.region
      ) reject("SCOPE_MISMATCH");
      addStable(
        summaries,
        `${record.accountId}|${record.region}|${record.resourceType}`,
        record,
      );
    }
  }

  for (const sequence of capture.recommendationSequences) {
    if (
      !OPERATIONS.has(sequence.operation)
      || sequence.operation === "GET_RECOMMENDATION_SUMMARIES"
      || !allowedAccounts.has(sequence.accountId)
      || !allowedRegions.has(sequence.region)
      || !PAGE_STATUSES.has(sequence.status)
      || (sequence.status === "SUCCEEDED") !== (sequence.errorCode === null)
      || (sequence.status === "FAILED" && sequence.pages.length !== 0)
    ) reject("INVALID_INPUT");
    if (sequence.errorCode !== null) safeCode(sequence.errorCode);
    const sequenceKey = [
      sequence.operation,
      sequence.accountId,
      sequence.region,
    ].join("|");
    if (observedCurrentSequences.has(sequenceKey)) {
      reject("CONFLICTING_DUPLICATE");
    }
    observedCurrentSequences.add(sequenceKey);
    const records = normalizePages(
      sequence.pages,
      sequence.exhausted,
      {
        expectedAccountId: sequence.accountId,
        expectedRegion: sequence.region,
        completedAtMs,
        partition: capture.partition,
      },
      (entry) =>
        normalizeRecommendation(entry, capture.partition, completedAtMs),
    );
    pageCount += sequence.pages.length;
    if (sequence.status !== "SUCCEEDED" || !sequence.exhausted) {
      currentCoverageComplete = false;
    }
    for (const record of records) {
      if (
        record.accountId !== sequence.accountId
        || record.region !== sequence.region
        || !resourceAllowedForOperation(
          sequence.operation,
          record.resourceType,
        )
      ) reject("SCOPE_MISMATCH");
      addStable(current, recommendationKey(record), {
        ...record,
        provenance: {
          provider: "AWS_COMPUTE_OPTIMIZER",
          evidenceKind: "DIRECT_GET_API",
          operation: sequence.operation,
          exportJobId: null,
          exportObjectSha256: null,
          collectedAt: completedAt,
        },
      });
    }
  }

  const expectedCurrentSequenceCount =
    allowedAccounts.size * capture.regions.length * OPERATIONS.size;
  if (observedCurrentSequences.size !== expectedCurrentSequenceCount) {
    currentCoverageComplete = false;
  }
  if (
    !Array.isArray(capture.exportJobSequences)
    || !Array.isArray(capture.exportSnapshots)
    || capture.exportJobSequences.length > capture.regions.length
  ) reject("INVALID_INPUT");
  const exportJobMap = new Map<string, ComputeOptimizerExportJob>();
  const exportRegions = new Set<string>();
  let exportJobsCoverageComplete = true;
  for (const sequence of capture.exportJobSequences) {
    if (
      !allowedRegions.has(sequence.region)
      || exportRegions.has(sequence.region)
      || !PAGE_STATUSES.has(sequence.status)
      || (sequence.status === "SUCCEEDED") !== (sequence.errorCode === null)
      || (sequence.status === "FAILED" && sequence.pages.length !== 0)
    ) reject("INVALID_INPUT");
    exportRegions.add(sequence.region);
    if (sequence.errorCode !== null) safeCode(sequence.errorCode);
    const jobs = normalizePages(
      sequence.pages,
      sequence.exhausted,
      {
        expectedAccountId: capture.managementAccountId,
        expectedRegion: sequence.region,
        completedAtMs,
        partition: capture.partition,
      },
      (entry) => normalizeExportJob(entry, completedAtMs),
    );
    pageCount += sequence.pages.length;
    if (sequence.status !== "SUCCEEDED" || !sequence.exhausted) {
      exportJobsCoverageComplete = false;
    }
    for (const job of jobs) {
      if (job.region !== sequence.region) reject("SCOPE_MISMATCH");
      addStable(exportJobMap, job.jobId, job);
    }
  }
  if (exportRegions.size !== capture.regions.length) {
    exportJobsCoverageComplete = false;
  }
  const exportJobs = [...exportJobMap.values()];
  if (
    pageCount > COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumPages
    || exportJobs.length
      > COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumExportJobs
  ) reject("PAGE_LIMIT_EXCEEDED");
  const jobMap = exportJobMap;

  if (
    capture.exportSnapshots.length
      > COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumExportSnapshots
  ) reject("RECORD_LIMIT_EXCEEDED");
  const historical = new Map<string, NormalizedComputeOptimizerRecommendation>();
  const snapshotDescriptors: Omit<
    ComputeOptimizerExportSnapshot,
    "recommendations"
  >[] = [];
  let exportBytes = 0;
  for (const raw of capture.exportSnapshots) {
    const normalized = validateExportSnapshot(
      raw,
      isRecord(raw) && typeof raw.jobId === "string"
        ? jobMap.get(raw.jobId)
        : undefined,
      capture,
      completedAtMs,
    );
    exportBytes += normalized.descriptor.contentBytes;
    if (
      exportBytes > COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumExportBytes
    ) reject("BYTE_LIMIT_EXCEEDED");
    snapshotDescriptors.push(normalized.descriptor);
    for (const record of normalized.recommendations) {
      addStable(
        historical,
        `${normalized.descriptor.jobId}|${recommendationKey(record)}`,
        {
          ...record,
          provenance: {
            provider: "AWS_COMPUTE_OPTIMIZER",
            evidenceKind: "S3_EXPORT",
            operation: "S3_EXPORT",
            exportJobId: normalized.descriptor.jobId,
            exportObjectSha256: normalized.descriptor.objectSha256,
            collectedAt: normalized.descriptor.parsedAt,
          },
        },
      );
    }
  }
  if (
    current.size + historical.size
      > COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumRecommendations
  ) reject("RECORD_LIMIT_EXCEEDED");

  const organizationEnrollmentCoverageComplete =
    enrollment.status === "ACTIVE"
    && enrollment.collectorAccountType === "MANAGEMENT"
    && enrollment.trustedAccessEnabled === true
    && enrollment.memberAccountsEnrolled
    && capture.memberEnrollmentExhausted
    && [...memberMap.values()].every((member) => member.status === "ACTIVE")
    && enrollment.numberOfMemberAccountsOptedIn !== null
    && enrollment.numberOfMemberAccountsOptedIn ===
      [...memberMap.values()].filter((member) => member.status === "ACTIVE")
        .length;
  const organizationExportCoverageComplete =
    exportConfiguration.configured
    && exportConfiguration.includeMemberAccounts
    && exportConfiguration.provisioningLedgerVerified
    && exportJobsCoverageComplete
    && snapshotDescriptors.length > 0;
  const state = configurationState({
    enrollment,
    exportConfiguration,
    exportJobs,
    exportSnapshots: snapshotDescriptors,
    currentCoverageComplete,
    organizationEnrollmentCoverageComplete,
    readPermissionsValidated: enrollment.readPermissionsValidated,
  });
  const status: ComputeOptimizerCollectionStatus =
    state === "READY"
      ? "COMPLETE"
      : state === "COLLECTION_UNAVAILABLE"
          || state === "ENROLLMENT_FAILED"
        ? "UNAVAILABLE"
        : "PARTIAL";
  const limitations = [
    "DIRECT_GET_API_RECOMMENDATIONS_ARE_CURRENT_OBSERVATIONS_NOT_HISTORY",
    "HISTORY_REQUIRES_COMPLETED_HASH_ADDRESSED_S3_EXPORTS",
    "EXPORT_CREATION_IS_A_SEPARATE_APPROVAL_CONTROLLED_WRITE_OPERATION",
    "AWS_SAVINGS_REQUIRE_COST_EXPLORER_RIGHTSIZING_RECOMMENDATIONS_INTEGRATION",
    "MEMORY_METRICS_REQUIRE_A_SUPPORTED_EXTERNAL_OR_CLOUDWATCH_AGENT_SOURCE",
    "SUTRA_HEURISTICS_ARE_NOT_AWS_COMPUTE_OPTIMIZER_EVIDENCE",
    ...(state === "READY" ? [] : [`CONFIGURATION_STATE_${state}`]),
  ];
  return {
    schemaVersion: "sutra.compute-optimizer-organization.v1",
    scope: { ...capture.scope },
    managementAccountId: capture.managementAccountId,
    partition: capture.partition,
    regions: [...capture.regions],
    collectionId: capture.collectionId,
    collectedAt: completedAt,
    collectionDurationMs: durationMs,
    status,
    configurationState: state,
    enrollment,
    exportConfiguration,
    memberEnrollments: [...memberMap.values()].sort((left, right) =>
      left.accountId.localeCompare(right.accountId)
    ),
    summaries: [...summaries.values()].sort(compareSummary),
    currentRecommendations: [...current.values()].sort(compareRecommendation),
    historicalRecommendations: [...historical.values()].sort(
      compareRecommendation,
    ),
    exportJobs: [...jobMap.values()].sort((left, right) =>
      right.lastUpdatedAt.localeCompare(left.lastUpdatedAt)
        || left.jobId.localeCompare(right.jobId)
    ),
    exportSnapshots: snapshotDescriptors.sort((left, right) =>
      right.parsedAt.localeCompare(left.parsedAt)
        || left.jobId.localeCompare(right.jobId)
    ),
    evidence: {
      readOperations: COMPUTE_OPTIMIZER_READ_OPERATIONS,
      pagesObserved: pageCount,
      recordsAccepted:
        memberMap.size + summaries.size + current.size + historical.size
        + jobMap.size,
      captureBytes,
      exportBytes,
      currentCoverageComplete,
      organizationEnrollmentCoverageComplete,
      organizationExportCoverageComplete,
      localHeuristicsUsedAsAwsEvidence: false,
      limitations,
    },
  };
}

function compareSummary(
  left: ComputeOptimizerSummaryRecord,
  right: ComputeOptimizerSummaryRecord,
): number {
  return left.accountId.localeCompare(right.accountId)
    || left.region.localeCompare(right.region)
    || left.resourceType.localeCompare(right.resourceType);
}

function compareRecommendation(
  left: NormalizedComputeOptimizerRecommendation,
  right: NormalizedComputeOptimizerRecommendation,
): number {
  return right.lastRefreshAt.localeCompare(left.lastRefreshAt)
    || left.accountId.localeCompare(right.accountId)
    || left.region.localeCompare(right.region)
    || left.resourceType.localeCompare(right.resourceType)
    || left.resourceArn.localeCompare(right.resourceArn);
}

export function computeOptimizerOrganizationSourceEvidence(
  snapshot: ComputeOptimizerOrganizationSnapshot,
): FinopsSourceEvidence {
  const delivered = snapshot.currentRecommendations.length > 0
    || snapshot.historicalRecommendations.length > 0;
  const ready = snapshot.configurationState === "READY";
  return {
    scope: { ...snapshot.scope },
    sourceId: "compute_optimizer_organization_export",
    configured: snapshot.exportConfiguration.configured
      && snapshot.exportConfiguration.includeMemberAccounts
      && snapshot.exportConfiguration.provisioningLedgerVerified,
    deliveryObserved: delivered,
    lastAttemptAt: snapshot.collectedAt,
    lastAttemptOutcome: ready
      ? "succeeded"
      : snapshot.status === "UNAVAILABLE"
        ? "failed"
        : "partial",
    lastSuccessAt: delivered ? snapshot.collectedAt : null,
    dataThroughAt: [
      ...snapshot.currentRecommendations,
      ...snapshot.historicalRecommendations,
    ].map((entry) => entry.lastRefreshAt).sort().at(-1) ?? null,
    coverage: {
      assessment: ready ? "complete" : delivered ? "partial" : "unknown",
      acceptedRecords: delivered
        ? snapshot.currentRecommendations.length
          + snapshot.historicalRecommendations.length
        : null,
      expectedRecords: null,
      rejectedRecords: delivered ? 0 : null,
    },
    lastError: snapshot.status === "UNAVAILABLE"
      ? {
          code: "COMPUTE_OPTIMIZER_COLLECTION_UNAVAILABLE",
          message: "The latest AWS Compute Optimizer collection was unavailable.",
          at: snapshot.collectedAt,
        }
      : null,
    evidenceBasis:
      "Tenant-pinned read-only AWS Compute Optimizer Get* API observations "
      + "plus immutable, hash-addressed S3 exports whose organization scope "
      + `was verified; managementAccount=${snapshot.managementAccountId}.`,
    limitations: snapshot.evidence.limitations,
  };
}

export interface ComputeOptimizerDashboard {
  readonly source: "AWS_COMPUTE_OPTIMIZER";
  readonly status: ComputeOptimizerCollectionStatus;
  readonly configurationState: ComputeOptimizerConfigurationState;
  readonly totalCurrentRecommendations: number;
  readonly totalHistoricalRecommendations: number;
  readonly savingsByCurrency: Readonly<Record<string, number>>;
  readonly recommendations: readonly NormalizedComputeOptimizerRecommendation[];
  readonly disclaimer: string;
}

export function buildComputeOptimizerDashboard(input: {
  readonly snapshot: ComputeOptimizerOrganizationSnapshot;
  readonly maximumRecommendations?: number;
}): ComputeOptimizerDashboard {
  const maximum = input.maximumRecommendations
    ?? COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumDashboardRecommendations;
  if (
    !Number.isSafeInteger(maximum)
    || maximum < 1
    || maximum
      > COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumDashboardRecommendations
  ) reject("INVALID_INPUT");
  const savingsByCurrency: Record<string, number> = {};
  for (const recommendation of input.snapshot.currentRecommendations) {
    const best = recommendation.options.find((option) => option.rank === 1);
    if (best?.savings !== null && best?.savings !== undefined) {
      savingsByCurrency[best.savings.currency] =
        (savingsByCurrency[best.savings.currency] ?? 0)
        + best.savings.estimatedMonthlySavings;
    }
  }
  return {
    source: "AWS_COMPUTE_OPTIMIZER",
    status: input.snapshot.status,
    configurationState: input.snapshot.configurationState,
    totalCurrentRecommendations:
      input.snapshot.currentRecommendations.length,
    totalHistoricalRecommendations:
      input.snapshot.historicalRecommendations.length,
    savingsByCurrency: Object.fromEntries(
      Object.entries(savingsByCurrency).sort(([left], [right]) =>
        left.localeCompare(right)
      ),
    ),
    recommendations: input.snapshot.currentRecommendations.slice(0, maximum),
    disclaimer:
      "Only AWS Compute Optimizer provider recommendations are shown here. "
      + "Direct Get API observations are current-state evidence; history is "
      + "limited to verified immutable S3 exports. Sutra heuristics are not "
      + "substituted for AWS findings or savings.",
  };
}
