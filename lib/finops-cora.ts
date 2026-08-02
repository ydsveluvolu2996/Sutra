/**
 * Evidence-honest Cost Optimization Recommended Actions (CORA) engine.
 *
 * This pure boundary performs no AWS, network, database, route, or UI I/O. The
 * credential-owning collector must deliver the exact, bounded evidence below.
 * AWS estimates, immutable CUR2 observations, and Sutra workflow assertions
 * remain separate so an estimate can never be presented as realized savings.
 */
import { toMicros } from "./finops-cur.ts";
import type {
  FinopsSourceEvidence,
  FinopsSourceScope,
} from "./finops-source-health.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const ORGANIZATION_ID = /^o-[a-z0-9]{10,32}$/u;
const CAPTURE_ID = /^cora_[a-f0-9]{64}$/u;
const GENERATION_ID = /^fbg_[a-f0-9]{64}$/u;
const TRACKING_KEY = /^cor_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const REGION = /^(?:[a-z]{2}(?:-gov)?-[a-z]+-\d|global)$/u;
const ARN = /^arn:(aws|aws-us-gov|aws-cn):[A-Za-z0-9-]+:[A-Za-z0-9-]*:[0-9]*:[A-Za-z0-9][A-Za-z0-9:_/+=,.@-]{0,2047}$/u;
const DATA_EXPORT_ARN = /^arn:(aws|aws-us-gov|aws-cn):bcm-data-exports:([a-z]{2}(?:-gov)?-[a-z]+-\d):(\d{12}):export\/([A-Za-z0-9_-]{1,128})-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f<>]{1,4096}$/u;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,95}$/u;
const INTEGER_MICROS = /^-?(?:0|[1-9]\d{0,40})$/u;
const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+\/-]{0,511}$/u;
const HOUR_MS = 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;

export const CORA_COLLECTION_BOUNDS = Object.freeze({
  maximumCaptureBytes: 192 * 1_024 * 1_024,
  maximumDashboardBytes: 24 * 1_024 * 1_024,
  maximumAccounts: 10_000,
  maximumRecommendations: 500_000,
  maximumHistoryRows: 2_000_000,
  maximumWorkflowRecords: 500_000,
  maximumAuditEvents: 5_000_000,
  maximumTagsPerRecommendation: 100,
  maximumConfigurationJsonBytes: 64 * 1_024,
  maximumSourceLineIdsPerObservation: 250,
  maximumObservedCostRows: 1_000_000,
  maximumExportObjects: 100_000,
  maximumPages: 100_000,
  recommendationFreshnessSlaHours: 48,
  cur2FreshnessSlaHours: 48,
} as const);

/** Permanent API reads. Cost Optimization Hub has no resource ARN support. */
export const CORA_PERMANENT_HUB_READ_OPERATIONS = Object.freeze([
  "cost-optimization-hub:GetPreferences",
  "cost-optimization-hub:ListEnrollmentStatuses",
] as const);

/** Exact export-health reads; pin all except ListExports to the known export ARN. */
export const CORA_PERMANENT_EXPORT_READ_OPERATIONS = Object.freeze([
  "bcm-data-exports:GetExport",
  "bcm-data-exports:GetExecution",
  "bcm-data-exports:ListExecutions",
] as const);

/** Exact-prefix reads for immutable Data Export manifests and data objects. */
export const CORA_PERMANENT_S3_READ_OPERATIONS = Object.freeze([
  "s3:GetBucketLocation",
  "s3:ListBucket",
  "s3:GetObject",
  "s3:GetObjectAttributes",
] as const);

/** Needed only when the exact-prefix objects were re-encrypted with a CMK. */
export const CORA_CONDITIONAL_KMS_READ_OPERATIONS = Object.freeze([
  "kms:Decrypt",
] as const);

/** Canonical account coverage dependency. */
export const CORA_ORGANIZATION_READ_OPERATIONS = Object.freeze([
  "organizations:DescribeOrganization",
  "organizations:ListAccounts",
] as const);

/** One-time enablement only; never place these writes on the collector role. */
export const CORA_ENROLLMENT_PROVISIONER_OPERATIONS = Object.freeze([
  "iam:CreateServiceLinkedRole",
  "iam:PutRolePolicy",
  "organizations:EnableAWSServiceAccess",
  "cost-optimization-hub:UpdateEnrollmentStatus",
] as const);

/** One-time Data Export registration against the COR table and output prefix. */
export const CORA_EXPORT_PROVISIONER_OPERATIONS = Object.freeze([
  "bcm-data-exports:CreateExport",
  "bcm-data-exports:TagResource",
  "cost-optimization-hub:GetRecommendation",
  "cost-optimization-hub:ListRecommendations",
] as const);

/** Existing hardened buckets need this only when their delivery policy lacks Data Exports. */
export const CORA_OPTIONAL_DESTINATION_PROVISIONER_OPERATIONS = Object.freeze([
  "s3:GetBucketPolicy",
  "s3:PutBucketPolicy",
] as const);

export const CORA_ACTION_TYPES = Object.freeze([
  "Rightsize",
  "Stop",
  "Upgrade",
  "PurchaseSavingsPlans",
  "PurchaseReservedInstances",
  "MigrateToGraviton",
  "Delete",
  "ScaleIn",
] as const);

export const CORA_RESOURCE_TYPES = Object.freeze([
  "Ec2Instance",
  "LambdaFunction",
  "EbsVolume",
  "EcsService",
  "Ec2AutoScalingGroup",
  "Ec2InstanceSavingsPlans",
  "ComputeSavingsPlans",
  "SageMakerSavingsPlans",
  "Ec2ReservedInstances",
  "RdsReservedInstances",
  "OpenSearchReservedInstances",
  "RedshiftReservedInstances",
  "ElastiCacheReservedInstances",
  "RdsDbInstanceStorage",
  "RdsDbInstance",
  "AuroraDbClusterStorage",
  "DynamoDbReservedCapacity",
  "MemoryDbReservedInstances",
  "NatGateway",
  "DynamoDBTable",
  "ElastiCacheCluster",
  "MemoryDBCluster",
  "DocumentDBCluster",
  "WorkSpaces",
  "SageMakerEndpoint",
] as const);

type CoraActionType = typeof CORA_ACTION_TYPES[number];
type CoraResourceType = typeof CORA_RESOURCE_TYPES[number];
type CoraPartition = "aws" | "aws-us-gov" | "aws-cn";
type CoraSourceState = "SUCCEEDED" | "PARTIAL" | "FAILED";
type CoraOptimizationClass =
  | "RESOURCE_USAGE_OPTIMIZATION"
  | "RATE_COMMITMENT_OPTIMIZATION";
export type CoraSnapshotState =
  | "READY"
  | "PARTIAL"
  | "CONFIGURATION_REQUIRED"
  | "STALE"
  | "EMPTY"
  | "ERROR";

export type CoraFailureCode =
  | "INVALID_INPUT"
  | "SCOPE_MISMATCH"
  | "LIMIT_EXCEEDED"
  | "CONFLICTING_DUPLICATE"
  | "ACCOUNT_COVERAGE_MISMATCH"
  | "WORKFLOW_AUDIT_MISMATCH"
  | "UNSAFE_CONFIGURATION_JSON";

export class CoraBoundaryError extends Error {
  readonly code: CoraFailureCode;

  constructor(code: CoraFailureCode) {
    super("CORA evidence is invalid.");
    this.name = "CoraBoundaryError";
    this.code = code;
  }
}

export interface CoraScope extends FinopsSourceScope {
  readonly partition: CoraPartition;
  readonly managementAccountId: string;
  readonly awsOrganizationId: string | null;
}

export interface CoraExpectedCoverage {
  readonly basis:
    | "AWS_ORGANIZATIONS_ACTIVE_ACCOUNTS"
    | "OPERATOR_APPROVED_ACCOUNT_SET"
    | "SINGLE_CONNECTED_ACCOUNT";
  readonly evidenceId: string;
  readonly observedAt: string;
  readonly activeAccountIds: readonly string[];
}

export interface CoraEnrollmentStatus {
  readonly accountId: string;
  readonly status: "Active" | "Inactive";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CoraPreferences {
  readonly savingsEstimationMode: "BeforeDiscounts" | "AfterDiscounts";
  readonly memberAccountDiscountVisibility: "All" | "None";
  readonly preferredCommitmentTerm: "OneYear" | "ThreeYears" | "HighestSavings";
  readonly preferredPaymentOption:
    | "NoUpfront"
    | "PartialUpfront"
    | "AllUpfront"
    | "HighestSavings";
  readonly observedAt: string;
}

export interface CoraExportEvidence {
  readonly exportArn: string;
  readonly exportName: string;
  readonly tableName: "COST_OPTIMIZATION_RECOMMENDATIONS";
  readonly executionId: string;
  readonly status: CoraSourceState;
  readonly errorCode: string | null;
  readonly includeAllRecommendations: boolean;
  readonly filterJson: string | null;
  readonly refreshCadence: "SYNCHRONOUS";
  readonly fileVersioning: "CREATE_NEW_REPORT";
  readonly fileFormat: "PARQUET" | "TEXT_OR_CSV";
  readonly compression: "PARQUET" | "GZIP";
  readonly bucketName: string;
  readonly prefix: string;
  readonly manifestObjectKey: string;
  readonly manifestSha256: string;
  readonly generatedAt: string;
  readonly dataThroughAt: string;
  readonly objectCount: number;
  readonly processedObjectCount: number;
  readonly rowCount: number;
  readonly acceptedRowCount: number;
  readonly rejectedRowCount: number;
  readonly exhausted: boolean;
}

export interface CoraRecommendationTag {
  readonly key: string;
  readonly value: string;
}

export interface CoraRecommendationCapture {
  /** Stable Sutra fingerprint; AWS recommendationId itself expires daily. */
  readonly trackingKey: string;
  readonly fingerprintSha256: string;
  readonly recommendationId: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly actionType: CoraActionType;
  readonly currencyCode: string;
  readonly currentResourceType: CoraResourceType | null;
  readonly recommendedResourceType: CoraResourceType | null;
  readonly currentResourceSummary: string | null;
  readonly recommendedResourceSummary: string | null;
  readonly currentResourceDetailsJson: string | null;
  readonly recommendedResourceDetailsJson: string | null;
  readonly estimatedMonthlyCostBeforeDiscount: string;
  readonly estimatedMonthlyCostAfterDiscount: string | null;
  readonly estimatedMonthlySavingsBeforeDiscount: string;
  readonly estimatedMonthlySavingsAfterDiscount: string | null;
  readonly estimatedSavingsPercentageBeforeDiscount: string;
  readonly estimatedSavingsPercentageAfterDiscount: string | null;
  readonly implementationEffort: "VeryLow" | "Low" | "Medium" | "High" | "VeryHigh";
  readonly lastRefreshTimestamp: string;
  readonly recommendationLookbackPeriodInDays: number;
  readonly recommendationSource: "ComputeOptimizer" | "CostExplorer";
  readonly region: string;
  readonly resourceId: string | null;
  readonly resourceArn: string | null;
  readonly restartNeeded: boolean;
  readonly rollbackPossible: boolean;
  readonly tags: readonly CoraRecommendationTag[];
  /**
   * Normalized only from the pinned CORA v0.0.11 calculated-field contract.
   * Provider adapters should populate this value, but the domain boundary
   * independently derives and verifies it so a caller cannot substitute rate
   * option dimensions or turn a summary string into invented savings.
   */
  readonly commitmentDimensions?: CoraCommitmentDimensions | null;
}

export interface CoraCommitmentDimensions {
  readonly level: "PAYER" | "LINKED" | "UNKNOWN";
  readonly term: "ONE_YEAR" | "THREE_YEARS" | "UNKNOWN";
  readonly upfront: "NO_UPFRONT" | "PARTIAL_UPFRONT" | "ALL_UPFRONT" | "UNKNOWN";
  readonly offeringType: string;
  readonly service: "EC2" | "RDS" | "OPEN_SEARCH" | "ELASTICACHE" | "REDSHIFT" | "DYNAMODB" | "MEMORYDB" | "SAGEMAKER" | "COMPUTE" | "UNKNOWN";
  readonly hourlyCommitment: string | null;
  readonly instanceType: string | null;
}

export interface CoraHistoricalRecommendation {
  readonly trackingKey: string;
  readonly fingerprintSha256: string;
  readonly recommendationId: string;
  readonly capturedAt: string;
  readonly lifecycle: "PRESENT" | "DISAPPEARED" | "REPLACED";
  readonly accountId: string;
  readonly region: string;
  readonly resourceId: string | null;
  readonly resourceArn: string | null;
  readonly currentResourceType: CoraResourceType | null;
  readonly recommendedResourceType: CoraResourceType | null;
  readonly actionType: CoraActionType;
  readonly currencyCode: string;
  readonly estimatedMonthlySavingsBeforeDiscount: string;
  readonly estimatedMonthlySavingsAfterDiscount: string | null;
  readonly sourceCaptureId: string;
}

export type CoraWorkflowStatus =
  | "NEW"
  | "TRIAGED"
  | "APPROVED"
  | "IN_PROGRESS"
  | "IMPLEMENTED"
  | "DISMISSED";

export interface CoraWorkflowAuditEvent {
  readonly revision: number;
  readonly at: string;
  readonly actorPrincipalId: string;
  readonly fromStatus: CoraWorkflowStatus | null;
  readonly toStatus: CoraWorkflowStatus;
  readonly evidenceId: string;
}

export interface CoraWorkflowControl {
  readonly trackingKey: string;
  readonly ownerPrincipalId: string | null;
  readonly status: CoraWorkflowStatus;
  readonly suppression:
    | { readonly mode: "NONE"; readonly until: null; readonly reasonCode: null }
    | {
      readonly mode: "UNTIL" | "UNTIL_MATERIAL_CHANGE" | "PERMANENT";
      readonly until: string | null;
      readonly reasonCode: string;
    };
  readonly externalTicketId: string | null;
  readonly revision: number;
  readonly updatedAt: string;
  readonly audit: readonly CoraWorkflowAuditEvent[];
}

export interface CoraCur2ObservedCost {
  readonly trackingKey: string;
  readonly observationKind: "CURRENT" | "BEFORE_ACTION" | "AFTER_ACTION";
  readonly periodStartAt: string;
  readonly periodEndAt: string;
  readonly costBasis: "BILLED" | "AMORTIZED";
  readonly amountMicros: string;
  readonly currencyCode: string;
  readonly sourceLineIds: readonly string[];
  readonly sourceLineIdsTruncated: boolean;
}

export interface CoraCur2Evidence {
  readonly generationId: string;
  readonly generationState: "ACTIVE";
  readonly sourceEvidenceId: string;
  readonly manifestSha256: string;
  readonly generatedAt: string;
  readonly dataThroughAt: string;
  readonly status: CoraSourceState;
  readonly errorCode: string | null;
  readonly payerAccountIds: readonly string[];
  readonly usageAccountIds: readonly string[];
  readonly objectCount: number;
  readonly processedObjectCount: number;
  readonly observedCosts: readonly CoraCur2ObservedCost[];
}

export interface CoraCapture {
  readonly schemaVersion: "sutra.cora.capture.v1";
  readonly scope: CoraScope;
  readonly captureId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly hubRegion: "us-east-1";
  readonly coverage: CoraExpectedCoverage;
  readonly enrollments: readonly CoraEnrollmentStatus[];
  readonly preferences: CoraPreferences | null;
  readonly export: CoraExportEvidence | null;
  readonly recommendations: readonly CoraRecommendationCapture[];
  readonly retainedHistory: readonly CoraHistoricalRecommendation[];
  readonly workflow: readonly CoraWorkflowControl[];
  readonly cur2: CoraCur2Evidence | null;
}

export interface CoraMoneyEstimate {
  readonly currencyCode: string;
  readonly monthlyCostBeforeDiscountMicros: string;
  readonly monthlyCostAfterDiscountMicros: string | null;
  readonly monthlySavingsBeforeDiscountMicros: string;
  readonly monthlySavingsAfterDiscountMicros: string | null;
  readonly meaning: "AWS_ESTIMATE_NOT_REALIZED_SAVINGS";
}

export interface CoraNormalizedRecommendation extends Omit<
  CoraRecommendationCapture,
  | "estimatedMonthlyCostBeforeDiscount"
  | "estimatedMonthlyCostAfterDiscount"
  | "estimatedMonthlySavingsBeforeDiscount"
  | "estimatedMonthlySavingsAfterDiscount"
> {
  readonly optimizationClass: CoraOptimizationClass;
  readonly estimates: CoraMoneyEstimate;
  readonly workflow: CoraWorkflowControl | {
    readonly trackingKey: string;
    readonly ownerPrincipalId: null;
    readonly status: "NEW";
    readonly suppression: { readonly mode: "NONE"; readonly until: null; readonly reasonCode: null };
    readonly externalTicketId: null;
    readonly revision: 0;
    readonly updatedAt: string;
    readonly audit: readonly [];
  };
  readonly observedCosts: readonly (CoraCur2ObservedCost & {
    readonly attribution: "OBSERVED_COST_NOT_ATTRIBUTED_SAVINGS";
  })[];
}

export interface CoraSummary {
  readonly optimizationClass: CoraOptimizationClass;
  readonly currencyCode: string;
  readonly recommendationCount: number;
  readonly estimatedMonthlyCostBeforeDiscountMicros: string;
  readonly estimatedMonthlyCostAfterDiscountMicros: string | null;
  readonly estimatedMonthlySavingsBeforeDiscountMicros: string;
  readonly estimatedMonthlySavingsAfterDiscountMicros: string | null;
  readonly aggregationMeaning: "NON_DEDUPLICATED_ROW_SUM_NOT_A_PORTFOLIO_SAVINGS_CLAIM";
}

export interface CoraSnapshot {
  readonly scope: CoraScope;
  readonly state: CoraSnapshotState;
  readonly generatedAt: string;
  readonly sourceCaptureId: string;
  readonly sourceDataThroughAt: string | null;
  readonly sourceErrorCode: string | null;
  readonly optimizationClasses: readonly CoraOptimizationClass[];
  readonly organizationCoverage: "COMPLETE" | "PARTIAL" | "SINGLE_ACCOUNT_ONLY";
  readonly coverage: {
    readonly expectedAccountCount: number;
    readonly activeEnrollmentAccountCount: number;
    readonly recommendationAccountCount: number;
    readonly missingEnrollmentAccountIds: readonly string[];
    readonly unexpectedRecommendationAccountIds: readonly string[];
    readonly exportAcceptedRows: number;
    readonly exportRejectedRows: number;
  };
  readonly channelStates: {
    readonly enrollment: "READY" | "PARTIAL" | "CONFIGURATION_REQUIRED";
    readonly recommendations: "READY" | "PARTIAL" | "EMPTY" | "CONFIGURATION_REQUIRED" | "ERROR" | "STALE";
    readonly cur2: "READY" | "PARTIAL" | "EMPTY" | "CONFIGURATION_REQUIRED" | "ERROR" | "STALE";
    readonly workflow: "READY" | "EMPTY";
  };
  readonly recommendations: readonly CoraNormalizedRecommendation[];
  readonly retainedHistory: readonly CoraHistoricalRecommendation[];
  readonly summaries: readonly CoraSummary[];
  readonly limitations: readonly string[];
}

function fail(code: CoraFailureCode): never {
  throw new CoraBoundaryError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validText(value: string, maximum = 4_096): boolean {
  return value.length <= maximum && SAFE_TEXT.test(value);
}

function time(value: string, nowMs: number): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > nowMs + CLOCK_SKEW_MS) fail("INVALID_INPUT");
  return parsed;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail("INVALID_INPUT");
  return parsed;
}

function nonNegativeInteger(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail("INVALID_INPUT");
}

function exactScope(actual: CoraScope, expected: CoraScope): void {
  if (
    actual.orgId !== expected.orgId
    || actual.customerId !== expected.customerId
    || actual.connectionId !== expected.connectionId
    || actual.partition !== expected.partition
    || actual.managementAccountId !== expected.managementAccountId
    || actual.awsOrganizationId !== expected.awsOrganizationId
  ) fail("SCOPE_MISMATCH");
}

function validateScope(scope: CoraScope): void {
  if (
    !IDENTIFIER.test(scope.orgId)
    || !IDENTIFIER.test(scope.customerId)
    || !CONNECTION_ID.test(scope.connectionId)
    || !["aws", "aws-us-gov", "aws-cn"].includes(scope.partition)
    || !ACCOUNT_ID.test(scope.managementAccountId)
    || (scope.awsOrganizationId !== null && !ORGANIZATION_ID.test(scope.awsOrganizationId))
  ) fail("INVALID_INPUT");
}

function uniqueStrings(
  values: readonly string[],
  expression: RegExp,
  maximum: number,
): readonly string[] {
  if (values.length > maximum) fail("LIMIT_EXCEEDED");
  const result = [...values];
  if (result.some((value) => !expression.test(value))) fail("INVALID_INPUT");
  if (new Set(result).size !== result.length) fail("CONFLICTING_DUPLICATE");
  return result.sort();
}

function validateConfigurationJson(value: string | null): void {
  if (value === null) return;
  if (/[<>]/u.test(value)) fail("UNSAFE_CONFIGURATION_JSON");
  if (Buffer.byteLength(value, "utf8") > CORA_COLLECTION_BOUNDS.maximumConfigurationJsonBytes) {
    fail("LIMIT_EXCEEDED");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    fail("UNSAFE_CONFIGURATION_JSON");
  }
  const inspect = (node: unknown, depth: number): void => {
    if (depth > 24) fail("UNSAFE_CONFIGURATION_JSON");
    if (Array.isArray(node)) {
      if (node.length > 5_000) fail("UNSAFE_CONFIGURATION_JSON");
      for (const item of node) inspect(item, depth + 1);
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        fail("UNSAFE_CONFIGURATION_JSON");
      }
      inspect(child, depth + 1);
    }
  };
  inspect(parsed, 0);
}

function money(value: string | null, required: boolean): string | null {
  if (value === null) {
    if (required) fail("INVALID_INPUT");
    return null;
  }
  const converted = toMicros(value);
  if (converted === null || !INTEGER_MICROS.test(converted)) fail("INVALID_INPUT");
  return converted;
}

function validatePercent(value: string | null, required: boolean): void {
  if (value === null) {
    if (required) fail("INVALID_INPUT");
    return;
  }
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/u.test(value)) fail("INVALID_INPUT");
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) fail("INVALID_INPUT");
}

function recommendationClass(actionType: CoraActionType): CoraOptimizationClass {
  return actionType === "PurchaseSavingsPlans" || actionType === "PurchaseReservedInstances"
    ? "RATE_COMMITMENT_OPTIMIZATION"
    : "RESOURCE_USAGE_OPTIMIZATION";
}

const RATE_DIMENSION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/u;
const HOURLY_COMMITMENT = /^(?:0|[1-9]\d{0,18})(?:\.\d{1,12})?$/u;

/**
 * Reproduces the pinned v0.0.11 CORA calculated-field semantics without fuzzy
 * provider inference. Unknown or changed provider text remains UNKNOWN/null.
 */
export function deriveCoraCommitmentDimensions(
  item: Pick<CoraRecommendationCapture,
    "actionType" | "currentResourceType" | "recommendedResourceType" | "currentResourceSummary" | "recommendedResourceSummary">,
): CoraCommitmentDimensions | null {
  if (item.actionType !== "PurchaseSavingsPlans" && item.actionType !== "PurchaseReservedInstances") return null;
  const current = item.currentResourceSummary ?? "";
  const recommended = item.recommendedResourceSummary ?? "";
  const combined = `${current} ${recommended}`;
  const level = /\bPayer\b/u.test(combined) ? "PAYER" as const
    : /\bLinked\b/u.test(combined) ? "LINKED" as const : "UNKNOWN" as const;
  const term = /\bthree years?\b/iu.test(recommended) ? "THREE_YEARS" as const
    : /\bone years?\b/iu.test(recommended) ? "ONE_YEAR" as const : "UNKNOWN" as const;
  const upfront = /\bPartialUpfront\b/u.test(recommended) ? "PARTIAL_UPFRONT" as const
    : /\bAllUpfront\b/u.test(recommended) ? "ALL_UPFRONT" as const
      : /\bNoUpfront\b/u.test(recommended) ? "NO_UPFRONT" as const : "UNKNOWN" as const;
  const type = item.recommendedResourceType ?? item.currentResourceType ?? "Unknown";
  const service = /^(?:Ec2|Compute)/u.test(type) ? (item.actionType === "PurchaseSavingsPlans" ? "COMPUTE" : "EC2")
    : /^Rds/u.test(type) ? "RDS"
      : /^OpenSearch/u.test(type) ? "OPEN_SEARCH"
        : /^ElastiCache/u.test(type) ? "ELASTICACHE"
          : /^Redshift/u.test(type) ? "REDSHIFT"
            : /^Dynamo/u.test(type) ? "DYNAMODB"
              : /^MemoryDb/u.test(type) ? "MEMORYDB"
                : /^SageMaker/u.test(type) ? "SAGEMAKER" : "UNKNOWN";
  const hourly = /^([^\s/]+)\/hour(?:\s|$)/u.exec(recommended)?.[1] ?? null;
  const afterFor = /\/hour for ([^\s]+) in /u.exec(recommended)?.[1] ?? null;
  const riInstance = item.actionType === "PurchaseReservedInstances"
    ? /^\S+\s+(\S+)/u.exec(recommended)?.[1] ?? null : null;
  return {
    level,
    term,
    upfront,
    offeringType: RATE_DIMENSION_TOKEN.test(type) ? type : "Unknown",
    service,
    hourlyCommitment: hourly !== null && HOURLY_COMMITMENT.test(hourly) ? hourly : null,
    instanceType: afterFor !== null && RATE_DIMENSION_TOKEN.test(afterFor) ? afterFor
      : riInstance !== null && RATE_DIMENSION_TOKEN.test(riInstance) ? riInstance : null,
  };
}

function validateRecommendation(
  item: CoraRecommendationCapture,
  allowedAccounts: ReadonlySet<string>,
  partition: CoraPartition,
  nowMs: number,
): CoraNormalizedRecommendation {
  if (
    !TRACKING_KEY.test(item.trackingKey)
    || !SHA256.test(item.fingerprintSha256)
    || !IDENTIFIER.test(item.recommendationId)
    || !ACCOUNT_ID.test(item.accountId)
    || !allowedAccounts.has(item.accountId)
    || !validText(item.accountName, 512)
    || !CORA_ACTION_TYPES.includes(item.actionType)
    || !CURRENCY.test(item.currencyCode)
    || (item.currentResourceType !== null && !CORA_RESOURCE_TYPES.includes(item.currentResourceType))
    || (item.recommendedResourceType !== null && !CORA_RESOURCE_TYPES.includes(item.recommendedResourceType))
    || (item.currentResourceSummary !== null && !validText(item.currentResourceSummary))
    || (item.recommendedResourceSummary !== null && !validText(item.recommendedResourceSummary))
    || !REGION.test(item.region)
    || (item.resourceId !== null && !validText(item.resourceId, 2_048))
    || (item.resourceArn !== null && !ARN.test(item.resourceArn))
    || !["VeryLow", "Low", "Medium", "High", "VeryHigh"].includes(item.implementationEffort)
    || !["ComputeOptimizer", "CostExplorer"].includes(item.recommendationSource)
    || !Number.isSafeInteger(item.recommendationLookbackPeriodInDays)
    || item.recommendationLookbackPeriodInDays < 1
    || item.recommendationLookbackPeriodInDays > 365
    || item.tags.length > CORA_COLLECTION_BOUNDS.maximumTagsPerRecommendation
  ) fail("INVALID_INPUT");
  if (item.resourceArn !== null) {
    const arnParts = item.resourceArn.split(":");
    if (arnParts[1] !== partition) fail("INVALID_INPUT");
    if (ACCOUNT_ID.test(arnParts[4] ?? "") && arnParts[4] !== item.accountId) {
      fail("ACCOUNT_COVERAGE_MISMATCH");
    }
  }
  time(item.lastRefreshTimestamp, nowMs);
  validateConfigurationJson(item.currentResourceDetailsJson);
  validateConfigurationJson(item.recommendedResourceDetailsJson);
  validatePercent(item.estimatedSavingsPercentageBeforeDiscount, true);
  validatePercent(item.estimatedSavingsPercentageAfterDiscount, false);
  const tagKeys = new Set<string>();
  for (const tag of item.tags) {
    if (!validText(tag.key, 128) || !validText(tag.value, 256)) fail("INVALID_INPUT");
    if (tagKeys.has(tag.key)) fail("CONFLICTING_DUPLICATE");
    tagKeys.add(tag.key);
  }
  const beforeCost = money(item.estimatedMonthlyCostBeforeDiscount, true);
  const afterCost = money(item.estimatedMonthlyCostAfterDiscount, false);
  const beforeSavings = money(item.estimatedMonthlySavingsBeforeDiscount, true);
  const afterSavings = money(item.estimatedMonthlySavingsAfterDiscount, false);
  const commitmentDimensions = deriveCoraCommitmentDimensions(item);
  if (item.commitmentDimensions !== undefined
    && JSON.stringify(item.commitmentDimensions) !== JSON.stringify(commitmentDimensions)) {
    fail("INVALID_INPUT");
  }
  return {
    ...item,
    commitmentDimensions,
    optimizationClass: recommendationClass(item.actionType),
    estimates: {
      currencyCode: item.currencyCode,
      monthlyCostBeforeDiscountMicros: beforeCost!,
      monthlyCostAfterDiscountMicros: afterCost,
      monthlySavingsBeforeDiscountMicros: beforeSavings!,
      monthlySavingsAfterDiscountMicros: afterSavings,
      meaning: "AWS_ESTIMATE_NOT_REALIZED_SAVINGS",
    },
    workflow: {
      trackingKey: item.trackingKey,
      ownerPrincipalId: null,
      status: "NEW",
      suppression: { mode: "NONE", until: null, reasonCode: null },
      externalTicketId: null,
      revision: 0,
      updatedAt: item.lastRefreshTimestamp,
      audit: [],
    },
    observedCosts: [],
  };
}

function validateWorkflow(record: CoraWorkflowControl, nowMs: number): void {
  if (
    !TRACKING_KEY.test(record.trackingKey)
    || (record.ownerPrincipalId !== null && !IDENTIFIER.test(record.ownerPrincipalId))
    || (record.externalTicketId !== null && !IDENTIFIER.test(record.externalTicketId))
    || !Number.isSafeInteger(record.revision)
    || record.revision < 1
    || record.audit.length !== record.revision
    || !["NEW", "TRIAGED", "APPROVED", "IN_PROGRESS", "IMPLEMENTED", "DISMISSED"].includes(
      record.status,
    )
    || !["NONE", "UNTIL", "UNTIL_MATERIAL_CHANGE", "PERMANENT"].includes(
      record.suppression.mode,
    )
  ) fail("WORKFLOW_AUDIT_MISMATCH");
  const updatedAt = time(record.updatedAt, nowMs);
  if (record.suppression.mode === "NONE") {
    if (record.suppression.until !== null || record.suppression.reasonCode !== null) {
      fail("WORKFLOW_AUDIT_MISMATCH");
    }
  } else {
    if (!SAFE_CODE.test(record.suppression.reasonCode)) fail("WORKFLOW_AUDIT_MISMATCH");
    if (record.suppression.mode === "UNTIL") {
      if (record.suppression.until === null) fail("WORKFLOW_AUDIT_MISMATCH");
      time(record.suppression.until, Number.MAX_SAFE_INTEGER - CLOCK_SKEW_MS);
    } else if (record.suppression.until !== null) {
      fail("WORKFLOW_AUDIT_MISMATCH");
    }
  }
  let prior: CoraWorkflowStatus | null = null;
  let priorAt = -Infinity;
  for (let index = 0; index < record.audit.length; index += 1) {
    const event = record.audit[index]!;
    const at = time(event.at, nowMs);
    if (
      event.revision !== index + 1
      || event.fromStatus !== prior
      || !IDENTIFIER.test(event.actorPrincipalId)
      || !EVIDENCE_ID.test(event.evidenceId)
      || !["NEW", "TRIAGED", "APPROVED", "IN_PROGRESS", "IMPLEMENTED", "DISMISSED"].includes(
        event.toStatus,
      )
      || at < priorAt
      || at > updatedAt
    ) fail("WORKFLOW_AUDIT_MISMATCH");
    prior = event.toStatus;
    priorAt = at;
  }
  if (prior !== record.status) fail("WORKFLOW_AUDIT_MISMATCH");
}

function validateObservedCost(
  row: CoraCur2ObservedCost,
  knownTrackingKeys: ReadonlySet<string>,
  nowMs: number,
): void {
  if (
    !knownTrackingKeys.has(row.trackingKey)
    || !INTEGER_MICROS.test(row.amountMicros)
    || !CURRENCY.test(row.currencyCode)
    || row.sourceLineIds.length > CORA_COLLECTION_BOUNDS.maximumSourceLineIdsPerObservation
  ) fail("INVALID_INPUT");
  const start = time(row.periodStartAt, nowMs);
  const end = timestamp(row.periodEndAt);
  if (start >= end || end - start > 400 * 24 * HOUR_MS) fail("INVALID_INPUT");
  uniqueStrings(row.sourceLineIds, EVIDENCE_ID, CORA_COLLECTION_BOUNDS.maximumSourceLineIdsPerObservation);
  if (row.sourceLineIds.length === 0 && !row.sourceLineIdsTruncated) fail("INVALID_INPUT");
}

function sum(left: string, right: string): string {
  return (BigInt(left) + BigInt(right)).toString();
}

export function normalizeCoraCapture(
  capture: CoraCapture,
  expectedScope: CoraScope,
  nowMs = Date.now(),
): CoraSnapshot {
  validateScope(expectedScope);
  exactScope(capture.scope, expectedScope);
  const bytes = Buffer.byteLength(JSON.stringify(capture), "utf8");
  if (bytes > CORA_COLLECTION_BOUNDS.maximumCaptureBytes) fail("LIMIT_EXCEEDED");
  if (
    capture.schemaVersion !== "sutra.cora.capture.v1"
    || !CAPTURE_ID.test(capture.captureId)
    || capture.hubRegion !== "us-east-1"
  ) fail("INVALID_INPUT");
  const startedAt = time(capture.startedAt, nowMs);
  const completedAt = time(capture.completedAt, nowMs);
  if (startedAt > completedAt) fail("INVALID_INPUT");

  const expectedAccounts = uniqueStrings(
    capture.coverage.activeAccountIds,
    ACCOUNT_ID,
    CORA_COLLECTION_BOUNDS.maximumAccounts,
  );
  if (
    expectedAccounts.length === 0
    || !EVIDENCE_ID.test(capture.coverage.evidenceId)
    || !expectedAccounts.includes(capture.scope.managementAccountId)
    || ![
      "AWS_ORGANIZATIONS_ACTIVE_ACCOUNTS",
      "OPERATOR_APPROVED_ACCOUNT_SET",
      "SINGLE_CONNECTED_ACCOUNT",
    ].includes(capture.coverage.basis)
  ) fail("ACCOUNT_COVERAGE_MISMATCH");
  time(capture.coverage.observedAt, nowMs);
  if (
    capture.coverage.basis === "AWS_ORGANIZATIONS_ACTIVE_ACCOUNTS"
    && capture.scope.awsOrganizationId === null
  ) fail("ACCOUNT_COVERAGE_MISMATCH");
  if (
    capture.coverage.basis === "SINGLE_CONNECTED_ACCOUNT"
    && (expectedAccounts.length !== 1 || expectedAccounts[0] !== capture.scope.managementAccountId)
  ) fail("ACCOUNT_COVERAGE_MISMATCH");
  const accountSet = new Set(expectedAccounts);

  if (capture.enrollments.length > CORA_COLLECTION_BOUNDS.maximumAccounts) fail("LIMIT_EXCEEDED");
  const enrollmentByAccount = new Map<string, CoraEnrollmentStatus>();
  for (const enrollment of capture.enrollments) {
    if (
      !ACCOUNT_ID.test(enrollment.accountId)
      || !accountSet.has(enrollment.accountId)
      || !["Active", "Inactive"].includes(enrollment.status)
    ) {
      fail("ACCOUNT_COVERAGE_MISMATCH");
    }
    if (enrollmentByAccount.has(enrollment.accountId)) fail("CONFLICTING_DUPLICATE");
    const created = time(enrollment.createdAt, nowMs);
    const updated = time(enrollment.updatedAt, nowMs);
    if (created > updated) fail("INVALID_INPUT");
    enrollmentByAccount.set(enrollment.accountId, enrollment);
  }
  if (capture.preferences !== null) {
    if (
      !["BeforeDiscounts", "AfterDiscounts"].includes(capture.preferences.savingsEstimationMode)
      || !["All", "None"].includes(capture.preferences.memberAccountDiscountVisibility)
      || !["OneYear", "ThreeYears", "HighestSavings"].includes(capture.preferences.preferredCommitmentTerm)
      || !["NoUpfront", "PartialUpfront", "AllUpfront", "HighestSavings"].includes(
        capture.preferences.preferredPaymentOption,
      )
    ) fail("INVALID_INPUT");
    time(capture.preferences.observedAt, nowMs);
  }

  if (capture.recommendations.length > CORA_COLLECTION_BOUNDS.maximumRecommendations) fail("LIMIT_EXCEEDED");
  const recommendationIds = new Set<string>();
  const trackingKeys = new Set<string>();
  const recommendations = capture.recommendations.map((item) => {
    if (recommendationIds.has(item.recommendationId) || trackingKeys.has(item.trackingKey)) {
      fail("CONFLICTING_DUPLICATE");
    }
    recommendationIds.add(item.recommendationId);
    trackingKeys.add(item.trackingKey);
    return validateRecommendation(item, accountSet, capture.scope.partition, nowMs);
  });

  if (capture.retainedHistory.length > CORA_COLLECTION_BOUNDS.maximumHistoryRows) fail("LIMIT_EXCEEDED");
  const historyKeys = new Set<string>();
  for (const item of capture.retainedHistory) {
    const identity = `${item.sourceCaptureId}:${item.recommendationId}:${item.trackingKey}`;
    if (historyKeys.has(identity)) fail("CONFLICTING_DUPLICATE");
    historyKeys.add(identity);
    if (
      !TRACKING_KEY.test(item.trackingKey)
      || !SHA256.test(item.fingerprintSha256)
      || !CAPTURE_ID.test(item.sourceCaptureId)
      || !IDENTIFIER.test(item.recommendationId)
      || !accountSet.has(item.accountId)
      || !REGION.test(item.region)
      || (item.resourceId !== null && !validText(item.resourceId, 2_048))
      || (item.resourceArn !== null && !ARN.test(item.resourceArn))
      || (item.currentResourceType !== null && !CORA_RESOURCE_TYPES.includes(item.currentResourceType))
      || (item.recommendedResourceType !== null && !CORA_RESOURCE_TYPES.includes(item.recommendedResourceType))
      || !CORA_ACTION_TYPES.includes(item.actionType)
      || !CURRENCY.test(item.currencyCode)
      || !["PRESENT", "DISAPPEARED", "REPLACED"].includes(item.lifecycle)
    ) fail("INVALID_INPUT");
    if (item.resourceArn !== null) {
      const arnParts = item.resourceArn.split(":");
      if (
        arnParts[1] !== capture.scope.partition
        || (ACCOUNT_ID.test(arnParts[4] ?? "") && arnParts[4] !== item.accountId)
      ) fail("ACCOUNT_COVERAGE_MISMATCH");
    }
    time(item.capturedAt, nowMs);
    money(item.estimatedMonthlySavingsBeforeDiscount, true);
    money(item.estimatedMonthlySavingsAfterDiscount, false);
  }

  if (capture.workflow.length > CORA_COLLECTION_BOUNDS.maximumWorkflowRecords) fail("LIMIT_EXCEEDED");
  const workflowByTrackingKey = new Map<string, CoraWorkflowControl>();
  let auditCount = 0;
  for (const record of capture.workflow) {
    if (!trackingKeys.has(record.trackingKey)) fail("INVALID_INPUT");
    if (workflowByTrackingKey.has(record.trackingKey)) fail("CONFLICTING_DUPLICATE");
    auditCount += record.audit.length;
    if (auditCount > CORA_COLLECTION_BOUNDS.maximumAuditEvents) fail("LIMIT_EXCEEDED");
    validateWorkflow(record, nowMs);
    workflowByTrackingKey.set(record.trackingKey, record);
  }

  let curState: CoraSnapshot["channelStates"]["cur2"] = "CONFIGURATION_REQUIRED";
  const observedByTrackingKey = new Map<string, CoraCur2ObservedCost[]>();
  let curStale = false;
  if (capture.cur2 !== null) {
    if (
      !GENERATION_ID.test(capture.cur2.generationId)
      || !EVIDENCE_ID.test(capture.cur2.sourceEvidenceId)
      || !SHA256.test(capture.cur2.manifestSha256)
      || capture.cur2.observedCosts.length > CORA_COLLECTION_BOUNDS.maximumObservedCostRows
      || !["SUCCEEDED", "PARTIAL", "FAILED"].includes(capture.cur2.status)
      || (capture.cur2.errorCode !== null && !SAFE_CODE.test(capture.cur2.errorCode))
      || (capture.cur2.status === "FAILED") !== (capture.cur2.errorCode !== null)
    ) fail("INVALID_INPUT");
    const curGeneratedAt = time(capture.cur2.generatedAt, nowMs);
    const curThroughAt = time(capture.cur2.dataThroughAt, nowMs);
    if (curThroughAt > curGeneratedAt) fail("INVALID_INPUT");
    const payerAccounts = uniqueStrings(
      capture.cur2.payerAccountIds,
      ACCOUNT_ID,
      CORA_COLLECTION_BOUNDS.maximumAccounts,
    );
    if (!payerAccounts.includes(capture.scope.managementAccountId)) fail("ACCOUNT_COVERAGE_MISMATCH");
    const usageAccounts = uniqueStrings(
      capture.cur2.usageAccountIds,
      ACCOUNT_ID,
      CORA_COLLECTION_BOUNDS.maximumAccounts,
    );
    if (usageAccounts.some((accountId) => !accountSet.has(accountId))) {
      fail("ACCOUNT_COVERAGE_MISMATCH");
    }
    nonNegativeInteger(capture.cur2.objectCount, CORA_COLLECTION_BOUNDS.maximumExportObjects);
    nonNegativeInteger(capture.cur2.processedObjectCount, capture.cur2.objectCount);
    for (const row of capture.cur2.observedCosts) {
      validateObservedCost(row, trackingKeys, nowMs);
      const existing = observedByTrackingKey.get(row.trackingKey) ?? [];
      existing.push(row);
      observedByTrackingKey.set(row.trackingKey, existing);
    }
    curStale = nowMs - curThroughAt > CORA_COLLECTION_BOUNDS.cur2FreshnessSlaHours * HOUR_MS;
    if (capture.cur2.status === "FAILED") curState = "ERROR";
    else if (curStale) curState = "STALE";
    else if (
      capture.cur2.status === "PARTIAL"
      || capture.cur2.processedObjectCount !== capture.cur2.objectCount
    ) curState = "PARTIAL";
    else if (capture.cur2.observedCosts.length === 0) curState = "EMPTY";
    else curState = "READY";
  }

  let exportState: CoraSnapshot["channelStates"]["recommendations"] = "CONFIGURATION_REQUIRED";
  let exportStale = false;
  if (capture.export !== null) {
    const exportArnMatch = DATA_EXPORT_ARN.exec(capture.export.exportArn);
    if (
      exportArnMatch === null
      || exportArnMatch[1] !== capture.scope.partition
      || exportArnMatch[2] !== capture.hubRegion
      || exportArnMatch[3] !== capture.scope.managementAccountId
      || exportArnMatch[4] !== capture.export.exportName
      || !IDENTIFIER.test(capture.export.exportName)
      || !IDENTIFIER.test(capture.export.executionId)
      || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(capture.export.bucketName)
      || !validText(capture.export.prefix, 1_024)
      || !validText(capture.export.manifestObjectKey, 2_048)
      || !capture.export.manifestObjectKey.startsWith(
        `${capture.export.prefix}/${capture.export.exportName}/`,
      )
      || !SHA256.test(capture.export.manifestSha256)
      || !["SUCCEEDED", "PARTIAL", "FAILED"].includes(capture.export.status)
      || !["PARQUET", "TEXT_OR_CSV"].includes(capture.export.fileFormat)
      || !["PARQUET", "GZIP"].includes(capture.export.compression)
      || capture.export.refreshCadence !== "SYNCHRONOUS"
      || capture.export.fileVersioning !== "CREATE_NEW_REPORT"
      || (capture.export.fileFormat === "PARQUET") !== (capture.export.compression === "PARQUET")
      || (capture.export.errorCode !== null && !SAFE_CODE.test(capture.export.errorCode))
      || (capture.export.status === "FAILED" && capture.export.errorCode === null)
      || (capture.export.status !== "FAILED" && capture.export.errorCode !== null)
    ) fail("INVALID_INPUT");
    validateConfigurationJson(capture.export.filterJson);
    const generatedAt = time(capture.export.generatedAt, nowMs);
    const throughAt = time(capture.export.dataThroughAt, nowMs);
    if (throughAt > generatedAt) fail("INVALID_INPUT");
    nonNegativeInteger(capture.export.objectCount, CORA_COLLECTION_BOUNDS.maximumExportObjects);
    nonNegativeInteger(capture.export.processedObjectCount, capture.export.objectCount);
    nonNegativeInteger(capture.export.rowCount, CORA_COLLECTION_BOUNDS.maximumRecommendations);
    nonNegativeInteger(capture.export.acceptedRowCount, capture.export.rowCount);
    nonNegativeInteger(capture.export.rejectedRowCount, capture.export.rowCount);
    if (
      capture.export.acceptedRowCount !== capture.recommendations.length
      || capture.export.acceptedRowCount + capture.export.rejectedRowCount !== capture.export.rowCount
    ) fail("INVALID_INPUT");
    exportStale = nowMs - throughAt > CORA_COLLECTION_BOUNDS.recommendationFreshnessSlaHours * HOUR_MS;
    if (capture.export.status === "FAILED") exportState = "ERROR";
    else if (exportStale) exportState = "STALE";
    else if (
      capture.export.status === "PARTIAL"
      || !capture.export.exhausted
      || !capture.export.includeAllRecommendations
      || capture.export.filterJson !== null
      || capture.export.processedObjectCount !== capture.export.objectCount
      || capture.export.rejectedRowCount > 0
    ) exportState = "PARTIAL";
    else if (capture.recommendations.length === 0) exportState = "EMPTY";
    else exportState = "READY";
  } else if (capture.recommendations.length > 0) {
    fail("INVALID_INPUT");
  }

  const withControls = recommendations.map((recommendation) => ({
    ...recommendation,
    workflow: workflowByTrackingKey.get(recommendation.trackingKey) ?? recommendation.workflow,
    observedCosts: (observedByTrackingKey.get(recommendation.trackingKey) ?? []).map((row) => ({
      ...row,
      attribution: "OBSERVED_COST_NOT_ATTRIBUTED_SAVINGS" as const,
    })),
  })).sort((left, right) => left.trackingKey.localeCompare(right.trackingKey));

  const summaryMap = new Map<string, CoraSummary>();
  for (const recommendation of withControls) {
    const key = `${recommendation.optimizationClass}:${recommendation.currencyCode}`;
    const existing = summaryMap.get(key);
    const estimate = recommendation.estimates;
    if (existing === undefined) {
      summaryMap.set(key, {
        optimizationClass: recommendation.optimizationClass,
        currencyCode: recommendation.currencyCode,
        recommendationCount: 1,
        estimatedMonthlyCostBeforeDiscountMicros: estimate.monthlyCostBeforeDiscountMicros,
        estimatedMonthlyCostAfterDiscountMicros: estimate.monthlyCostAfterDiscountMicros,
        estimatedMonthlySavingsBeforeDiscountMicros: estimate.monthlySavingsBeforeDiscountMicros,
        estimatedMonthlySavingsAfterDiscountMicros: estimate.monthlySavingsAfterDiscountMicros,
        aggregationMeaning: "NON_DEDUPLICATED_ROW_SUM_NOT_A_PORTFOLIO_SAVINGS_CLAIM",
      });
    } else {
      summaryMap.set(key, {
        ...existing,
        recommendationCount: existing.recommendationCount + 1,
        estimatedMonthlyCostBeforeDiscountMicros: sum(
          existing.estimatedMonthlyCostBeforeDiscountMicros,
          estimate.monthlyCostBeforeDiscountMicros,
        ),
        estimatedMonthlyCostAfterDiscountMicros:
          existing.estimatedMonthlyCostAfterDiscountMicros === null
          || estimate.monthlyCostAfterDiscountMicros === null
            ? null
            : sum(existing.estimatedMonthlyCostAfterDiscountMicros, estimate.monthlyCostAfterDiscountMicros),
        estimatedMonthlySavingsBeforeDiscountMicros: sum(
          existing.estimatedMonthlySavingsBeforeDiscountMicros,
          estimate.monthlySavingsBeforeDiscountMicros,
        ),
        estimatedMonthlySavingsAfterDiscountMicros:
          existing.estimatedMonthlySavingsAfterDiscountMicros === null
          || estimate.monthlySavingsAfterDiscountMicros === null
            ? null
            : sum(existing.estimatedMonthlySavingsAfterDiscountMicros, estimate.monthlySavingsAfterDiscountMicros),
        aggregationMeaning: "NON_DEDUPLICATED_ROW_SUM_NOT_A_PORTFOLIO_SAVINGS_CLAIM",
      });
    }
  }

  const activeEnrollments = [...enrollmentByAccount.values()]
    .filter((item) => item.status === "Active")
    .map((item) => item.accountId)
    .sort();
  const missingEnrollments = expectedAccounts.filter((accountId) => !activeEnrollments.includes(accountId));
  const recommendationAccounts = [...new Set(withControls.map((item) => item.accountId))].sort();
  const unexpectedRecommendationAccounts = recommendationAccounts.filter((id) => !accountSet.has(id));
  const organizationCoverage = capture.coverage.basis === "SINGLE_CONNECTED_ACCOUNT"
    ? "SINGLE_ACCOUNT_ONLY"
    : capture.coverage.basis === "AWS_ORGANIZATIONS_ACTIVE_ACCOUNTS" && missingEnrollments.length === 0
      ? "COMPLETE"
      : "PARTIAL";
  const enrollmentState = capture.preferences === null || activeEnrollments.length === 0
    ? "CONFIGURATION_REQUIRED"
    : missingEnrollments.length > 0
      ? "PARTIAL"
      : "READY";

  const limitations = new Set<string>();
  limitations.add("AWS estimates are not realized savings or invoices.");
  limitations.add("CUR2 observations are shown without causal savings attribution.");
  if (capture.export?.includeAllRecommendations === false) {
    limitations.add("The export excludes lower-savings incompatible recommendations.");
  }
  if (capture.export?.filterJson !== null && capture.export?.filterJson !== undefined) {
    limitations.add("The export is filtered and is not complete recommendation coverage.");
  }
  if (organizationCoverage !== "COMPLETE") limitations.add("Organization coverage is not proven complete.");
  if (capture.cur2 === null) limitations.add("Immutable active CUR2 cost evidence is not configured.");

  let state: CoraSnapshotState;
  if (enrollmentState === "CONFIGURATION_REQUIRED" || capture.export === null) state = "CONFIGURATION_REQUIRED";
  else if (exportState === "ERROR") state = "ERROR";
  else if (exportState === "STALE" || curState === "STALE") state = "STALE";
  else if (
    enrollmentState === "PARTIAL"
    || exportState === "PARTIAL"
    || curState === "PARTIAL"
    || curState === "CONFIGURATION_REQUIRED"
    || curState === "ERROR"
    || organizationCoverage !== "COMPLETE"
  ) state = "PARTIAL";
  else if (exportState === "EMPTY" && enrollmentState === "READY") state = "EMPTY";
  else state = "READY";

  const snapshot: CoraSnapshot = {
    scope: capture.scope,
    state,
    generatedAt: new Date(nowMs).toISOString(),
    sourceCaptureId: capture.captureId,
    sourceDataThroughAt: capture.export?.dataThroughAt ?? null,
    sourceErrorCode: capture.export?.errorCode ?? null,
    optimizationClasses: [
      "RESOURCE_USAGE_OPTIMIZATION",
      "RATE_COMMITMENT_OPTIMIZATION",
    ],
    organizationCoverage,
    coverage: {
      expectedAccountCount: expectedAccounts.length,
      activeEnrollmentAccountCount: activeEnrollments.length,
      recommendationAccountCount: recommendationAccounts.length,
      missingEnrollmentAccountIds: missingEnrollments,
      unexpectedRecommendationAccountIds: unexpectedRecommendationAccounts,
      exportAcceptedRows: capture.export?.acceptedRowCount ?? 0,
      exportRejectedRows: capture.export?.rejectedRowCount ?? 0,
    },
    channelStates: {
      enrollment: enrollmentState,
      recommendations: exportState,
      cur2: curState,
      workflow: capture.workflow.length === 0 ? "EMPTY" : "READY",
    },
    recommendations: withControls,
    retainedHistory: [...capture.retainedHistory].sort((left, right) =>
      left.capturedAt.localeCompare(right.capturedAt) || left.trackingKey.localeCompare(right.trackingKey)
    ),
    summaries: [...summaryMap.values()].sort((left, right) =>
      left.optimizationClass.localeCompare(right.optimizationClass)
      || left.currencyCode.localeCompare(right.currencyCode)
    ),
    limitations: [...limitations],
  };
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > CORA_COLLECTION_BOUNDS.maximumDashboardBytes) {
    fail("LIMIT_EXCEEDED");
  }
  return snapshot;
}

export function coraSourceEvidence(snapshot: CoraSnapshot): FinopsSourceEvidence {
  const configured = snapshot.state !== "CONFIGURATION_REQUIRED";
  const recommendations = snapshot.channelStates.recommendations;
  const failed = recommendations === "ERROR";
  const partial = snapshot.state === "PARTIAL";
  return {
    scope: snapshot.scope,
    sourceId: "cost_optimization_hub_export",
    configured,
    deliveryObserved: recommendations !== "CONFIGURATION_REQUIRED",
    lastAttemptAt: snapshot.generatedAt,
    lastAttemptOutcome: failed ? "failed" : partial ? "partial" : "succeeded",
    lastSuccessAt: failed || !configured ? null : snapshot.sourceDataThroughAt,
    dataThroughAt: failed || !configured ? null : snapshot.sourceDataThroughAt,
    coverage: {
      assessment: snapshot.organizationCoverage === "COMPLETE" && !partial ? "complete" : "partial",
      acceptedRecords: snapshot.coverage.exportAcceptedRows,
      expectedRecords: snapshot.coverage.exportAcceptedRows + snapshot.coverage.exportRejectedRows,
      rejectedRecords: snapshot.coverage.exportRejectedRows,
    },
    lastError: failed ? {
      code: snapshot.sourceErrorCode ?? "SOURCE_COLLECTION_FAILED",
      message: "AWS Cost Optimization Hub export collection failed.",
      at: snapshot.generatedAt,
    } : null,
    evidenceBasis: `${snapshot.sourceCaptureId};${snapshot.organizationCoverage};${recommendations}`,
    limitations: snapshot.limitations,
  };
}
