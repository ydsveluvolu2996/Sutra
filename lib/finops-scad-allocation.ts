/**
 * Evidence-honest AWS Split Cost Allocation Data (SCAD) engine.
 *
 * This module is pure: it never owns AWS credentials, fetches S3 objects, or
 * mutates an export. A trusted collector must first validate an immutable CUR
 * 2.0 generation, preserve decimal cells as strings, and pin the Sutra tenant
 * and AWS payer boundary. The engine then validates the complete capture and
 * produces deterministic allocation groups without inventing missing lineage,
 * utilization, discounts, or historical backfill.
 */
import type {
  FinopsSourceEvidence,
  FinopsSourceScope,
} from "./finops-source-health.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/u;
const CAPTURE_ID = /^scad_[a-f0-9]{64}$/u;
const GENERATION_ID = /^fbg_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const EXPORT_ARN = /^arn:(?:aws|aws-us-gov|aws-cn):bcm-data-exports:[a-z0-9-]+:\d{12}:export\/[A-Za-z0-9_./-]+$/u;
const S3_BUCKET = /^(?!\d+\.\d+\.\d+\.\d+$)(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f<>]{1,1024}$/u;
const COLUMN = /^[a-z][a-z0-9_]{0,127}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,95}$/u;
const UNSIGNED_DECIMAL = /^(?:0|[1-9]\d{0,30})(?:\.\d{1,12})?$/u;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

/** The complete current CUR 2.0 split-line-item column group published by AWS. */
export const SCAD_CUR2_SPLIT_COLUMNS = Object.freeze([
  "split_line_item_actual_usage",
  "split_line_item_net_split_cost",
  "split_line_item_net_unused_cost",
  "split_line_item_parent_resource_id",
  "split_line_item_public_on_demand_split_cost",
  "split_line_item_public_on_demand_unused_cost",
  "split_line_item_reserved_usage",
  "split_line_item_split_cost",
  "split_line_item_split_usage",
  "split_line_item_split_usage_ratio",
  "split_line_item_unused_cost",
] as const);

/** Non-split CUR 2.0 columns required for identity, interval, unit, and tags. */
export const SCAD_CUR2_BASE_COLUMNS = Object.freeze([
  "identity_line_item_id",
  "bill_payer_account_id",
  "line_item_usage_account_id",
  "line_item_resource_id",
  "line_item_usage_start_date",
  "line_item_usage_end_date",
  "line_item_usage_type",
  "line_item_currency_code",
  "pricing_unit",
  "product_region_code",
  "resource_tags",
] as const);

/**
 * Permanent runtime collector contract. Bucket/prefix and object resources must
 * be tenant-pinned by the policy; no Billing, Cost Explorer, IAM, or write
 * permission belongs in the runtime role.
 */
export const SCAD_RUNTIME_S3_READ_IAM_ACTIONS = Object.freeze([
  "s3:GetBucketLocation",
  "s3:ListBucket",
  "s3:GetObject",
  "s3:GetObjectAttributes",
] as const);

/**
 * One-time provisioner actions. `iam:CreateServiceLinkedRole` is conditional:
 * it is needed only when opt-in creates AWSServiceRoleForSplitCostAllocationData
 * and must be constrained with iam:AWSServiceName equal to
 * split-cost-allocation-data.bcm.amazonaws.com. CUR 2.0 cannot have SCAD toggled
 * in place, so the provisioner creates a new export with the table flag TRUE.
 */
export const SCAD_ONE_TIME_PROVISIONER_IAM_ACTIONS = Object.freeze([
  "ce:UpdatePreferences",
  "ce:UpdateCostAllocationTagsStatus",
  "iam:CreateServiceLinkedRole",
  "bcm-data-exports:CreateExport",
  "cur:PutReportDefinition",
] as const);

export const SCAD_BOUNDS = Object.freeze({
  maximumCaptureBytes: 128 * 1_024 * 1_024,
  maximumRows: 750_000,
  maximumObjects: 20_000,
  maximumGroups: 100_000,
  maximumColumns: 2_000,
  maximumAccounts: 10_000,
  maximumCaptureDurationMs: 30 * 60 * 1_000,
  freshnessSlaHours: 48,
} as const);

export type ScadPartition = "aws" | "aws-us-gov" | "aws-cn";
export type ScadPlatform = "EKS" | "ECS" | "BATCH_EKS" | "BATCH_ECS";
export type ScadMetric =
  | "VCPU"
  | "MEMORY"
  | "GPU"
  | "TRAINIUM"
  | "INFERENTIA"
  | "OTHER_ACCELERATOR";
export type ScadSnapshotState =
  | "CONFIGURATION_REQUIRED"
  | "WAITING_FIRST_DELIVERY"
  | "READY"
  | "PARTIAL"
  | "STALE"
  | "NO_USAGE";
export type ScadDeliveryState =
  | "WAITING_FIRST_DELIVERY"
  | "FIRST_DELIVERY"
  | "REGULAR_DELIVERY"
  | "CORRECTED_DELIVERY";
export type ScadHistoricalCoverageState =
  | "NO_BACKFILL_BEFORE_ENABLEMENT"
  | "PARTIAL_SINCE_ENABLEMENT";

export interface ScadScope extends FinopsSourceScope {
  readonly partition: ScadPartition;
  readonly payerAccountIds: readonly string[];
  readonly usageAccountIds: readonly string[];
  readonly regions: readonly string[];
}

export interface ScadS3ObjectEvidence {
  readonly objectId: string;
  readonly bucket: string;
  readonly key: string;
  readonly eTag: string;
  readonly versionId: string | null;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface ScadSourceCoverage {
  readonly runtimeS3PermissionsValidated: boolean;
  readonly expectedObjectCount: number;
  readonly processedObjectCount: number;
  readonly failedObjectCount: number;
  readonly rowsExhausted: boolean;
  readonly schemaColumns: readonly string[];
  readonly errorCode: string | null;
}

export interface ScadCur2Row {
  readonly lineItemId: string;
  readonly sourceObjectId: string;
  readonly sourceRowNumber: number;
  readonly payerAccountId: string;
  readonly usageAccountId: string;
  readonly region: string;
  readonly usageStartAt: string;
  readonly usageEndAt: string;
  readonly platform: ScadPlatform;
  readonly usageType: string;
  readonly metric: ScadMetric;
  readonly usageUnit: string;
  readonly currency: string;
  /** CUR 2.0 line_item_resource_id: an EKS pod or ECS task, not a container. */
  readonly resourceId: string;
  readonly parentResourceId: string | null;
  /** Exact CUR 2.0 resource_tags map; only documented keys are interpreted. */
  readonly resourceTags: Readonly<Record<string, string>>;
  readonly reservedUsage: string | null;
  readonly actualUsage: string | null;
  readonly splitUsage: string;
  readonly splitUsageRatio: string | null;
  readonly splitCost: string;
  readonly unusedCost: string;
  readonly netSplitCost: string | null;
  readonly netUnusedCost: string | null;
  readonly publicOnDemandSplitCost: string | null;
  readonly publicOnDemandUnusedCost: string | null;
}

export interface ScadCapture {
  readonly schemaVersion: "sutra.scad-allocation.capture.v1";
  readonly scope: ScadScope;
  readonly captureId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly exportName: string;
  readonly exportArn: string;
  readonly activeGenerationId: string;
  readonly correctionOfGenerationId: string | null;
  readonly manifestSha256: string;
  readonly generatedAt: string;
  readonly dataThroughAt: string;
  readonly billingPeriodStartAt: string;
  readonly billingPeriodEndAt: string;
  readonly scadEnabledAt: string;
  readonly firstDeliveryObservedAt: string | null;
  /** Zero before the first delivery; otherwise a monotonically increasing sequence. */
  readonly deliverySequence: number;
  readonly destination: {
    readonly bucket: string;
    /** Exact tenant/export prefix and always ends in `/`. */
    readonly prefix: string;
  };
  readonly tableConfiguration: {
    readonly tableName: "COST_AND_USAGE_REPORT";
    readonly timeGranularity: "HOURLY";
    readonly includeResources: "TRUE" | "FALSE";
    readonly includeSplitCostAllocationData: "TRUE" | "FALSE";
  };
  readonly coverage: ScadSourceCoverage;
  readonly objects: readonly ScadS3ObjectEvidence[];
  readonly rows: readonly ScadCur2Row[];
}

export interface ScadExactDecimal {
  readonly numerator: string;
  readonly denominator: string;
}

export interface ScadOptionalMeasure {
  readonly exact: ScadExactDecimal | null;
  readonly presentRows: number;
  readonly totalRows: number;
  readonly complete: boolean;
}

export interface ScadLineage {
  readonly payerAccountId: string;
  readonly usageAccountId: string;
  readonly region: string;
  readonly platform: ScadPlatform;
  readonly cluster: string | null;
  readonly namespace: string | null;
  readonly workloadType: string | null;
  readonly workload: string | null;
  readonly deployment: string | null;
  readonly node: string | null;
  readonly batchJobDefinition: string | null;
  readonly batchJobQueue: string | null;
  readonly batchComputeEnvironment: string | null;
  readonly podOrTaskId: string;
  readonly parentResourceId: string | null;
  /** Base SCAD publishes pod/task rows. It does not publish a container ID. */
  readonly containerId: null;
  readonly containerLineageState: "NOT_PUBLISHED_BY_CUR2_SCAD";
  readonly completeThroughPodOrTask: boolean;
}

export interface ScadAllocationGroup {
  readonly lineage: ScadLineage;
  readonly metric: ScadMetric;
  readonly usageType: string;
  readonly usageUnit: string;
  readonly currency: string;
  readonly rowCount: number;
  readonly requestedUsage: ScadOptionalMeasure;
  readonly actualUsage: ScadOptionalMeasure;
  readonly allocatedUsage: ScadExactDecimal;
  readonly actualAboveRequest: ScadOptionalMeasure;
  readonly requestedHeadroom: ScadOptionalMeasure;
  /** Sum of source ratios; deliberately not labelled as an average utilization. */
  readonly splitUsageRatioSum: ScadOptionalMeasure;
  readonly allocatedAmortizedCost: ScadExactDecimal;
  readonly attributedUnusedAmortizedCost: ScadExactDecimal;
  readonly attributedAmortizedCost: ScadExactDecimal;
  readonly netAllocatedCost: ScadOptionalMeasure;
  readonly netUnusedCost: ScadOptionalMeasure;
  readonly publicOnDemandAllocatedCost: ScadOptionalMeasure;
  readonly publicOnDemandUnusedCost: ScadOptionalMeasure;
  readonly evidenceLineItemIds: readonly string[];
}

export interface ScadAllocationSnapshot {
  readonly schemaVersion: "sutra.scad-allocation.snapshot.v1";
  readonly scope: ScadScope;
  readonly captureId: string;
  readonly activeGenerationId: string;
  readonly state: ScadSnapshotState;
  readonly deliveryState: ScadDeliveryState;
  readonly historicalCoverage: {
    readonly state: ScadHistoricalCoverageState;
    readonly beginsAt: string;
    readonly backfillAvailable: false;
    readonly disclosure: string;
  };
  readonly replacementPolicy: "REPLACE_BILLING_PERIOD_ATOMICALLY";
  readonly complete: boolean;
  readonly generatedAt: string;
  readonly dataThroughAt: string;
  readonly sourceErrorCode: string | null;
  readonly billingPeriodStartAt: string;
  readonly billingPeriodEndAt: string;
  readonly rowCount: number;
  readonly groupCount: number;
  readonly objectCoverage: {
    readonly expected: number;
    readonly processed: number;
    readonly failed: number;
  };
  readonly lineageCoverage: {
    readonly rowsCompleteThroughPodOrTask: number;
    readonly rowsMissingBusinessLineage: number;
    readonly unallocatedAmortizedCost: readonly ScadCurrencyTotal[];
    readonly containerRowsPublishedByScad: 0;
  };
  readonly totals: {
    readonly allocatedAmortizedCost: readonly ScadCurrencyTotal[];
    readonly attributedUnusedAmortizedCost: readonly ScadCurrencyTotal[];
    readonly attributedAmortizedCost: readonly ScadCurrencyTotal[];
  };
  readonly groups: readonly ScadAllocationGroup[];
  readonly limitations: readonly string[];
}

export interface ScadCurrencyTotal {
  readonly currency: string;
  readonly exact: ScadExactDecimal;
}

export type ScadAllocationErrorCode =
  | "INVALID_INPUT"
  | "SCOPE_MISMATCH"
  | "ACCOUNT_SCOPE_MISMATCH"
  | "REGION_SCOPE_MISMATCH"
  | "DUPLICATE_EVIDENCE"
  | "CONFLICTING_DUPLICATE"
  | "EVIDENCE_REFERENCE_MISSING"
  | "LIMIT_EXCEEDED"
  | "INCONSISTENT_SPLIT_USAGE";

export class ScadAllocationError extends Error {
  public readonly code: ScadAllocationErrorCode;

  public constructor(code: ScadAllocationErrorCode) {
    super("SCAD allocation evidence is invalid.");
    this.name = "ScadAllocationError";
    this.code = code;
  }
}

interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}

interface MutableGroup {
  readonly lineage: ScadLineage;
  readonly metric: ScadMetric;
  readonly usageType: string;
  readonly usageUnit: string;
  readonly currency: string;
  readonly rows: ScadCur2Row[];
}

function fail(code: ScadAllocationErrorCode): never {
  throw new ScadAllocationError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validScope(scope: unknown): scope is ScadScope {
  return isRecord(scope)
    && typeof scope.orgId === "string" && IDENTIFIER.test(scope.orgId)
    && typeof scope.customerId === "string" && IDENTIFIER.test(scope.customerId)
    && typeof scope.connectionId === "string" && CONNECTION_ID.test(scope.connectionId)
    && ["aws", "aws-us-gov", "aws-cn"].includes(String(scope.partition))
    && Array.isArray(scope.payerAccountIds)
    && Array.isArray(scope.usageAccountIds)
    && Array.isArray(scope.regions);
}

function sameScope(left: ScadScope, right: ScadScope): boolean {
  return left.orgId === right.orgId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId
    && left.partition === right.partition
    && JSON.stringify(left.payerAccountIds) === JSON.stringify(right.payerAccountIds)
    && JSON.stringify(left.usageAccountIds) === JSON.stringify(right.usageAccountIds)
    && JSON.stringify(left.regions) === JSON.stringify(right.regions);
}

function uniqueSorted(values: readonly string[], expression: RegExp): string[] | null {
  if (values.length === 0 || values.some((value) => !expression.test(value))) return null;
  const sorted = [...new Set(values)].sort((a, b) => a.localeCompare(b, "en-US"));
  return sorted.length === values.length ? sorted : null;
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value ? epoch : null;
}

function validMonthlyPeriod(start: number, end: number): boolean {
  const startDate = new Date(start);
  const expectedEnd = Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth() + 1,
    1,
  );
  return startDate.getUTCDate() === 1
    && startDate.getUTCHours() === 0
    && startDate.getUTCMinutes() === 0
    && startDate.getUTCSeconds() === 0
    && startDate.getUTCMilliseconds() === 0
    && end === expectedEnd;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0 ? -left : left;
  let b = right < 0 ? -right : right;
  while (b !== BigInt(0)) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a === BigInt(0) ? BigInt(1) : a;
}

function rational(value: string): Rational | null {
  if (!UNSIGNED_DECIMAL.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const denominator = BigInt(10) ** BigInt(fraction.length);
  const numerator = BigInt(whole) * denominator + BigInt(fraction || "0");
  const divisor = gcd(numerator, denominator);
  return { n: numerator / divisor, d: denominator / divisor };
}

function add(left: Rational, right: Rational): Rational {
  const numerator = left.n * right.d + right.n * left.d;
  const denominator = left.d * right.d;
  const divisor = gcd(numerator, denominator);
  return { n: numerator / divisor, d: denominator / divisor };
}

function subtractNonNegative(left: Rational, right: Rational): Rational {
  return compare(left, right) >= 0
    ? normalize(left.n * right.d - right.n * left.d, left.d * right.d)
    : { n: BigInt(0), d: BigInt(1) };
}

function normalize(numerator: bigint, denominator: bigint): Rational {
  const divisor = gcd(numerator, denominator);
  return { n: numerator / divisor, d: denominator / divisor };
}

function compare(left: Rational, right: Rational): number {
  const difference = left.n * right.d - right.n * left.d;
  return difference < 0 ? -1 : difference > 0 ? 1 : 0;
}

function exact(value: Rational): ScadExactDecimal {
  return { numerator: value.n.toString(), denominator: value.d.toString() };
}

function sumRequired(rows: readonly ScadCur2Row[], select: (row: ScadCur2Row) => string): Rational {
  let total: Rational = { n: BigInt(0), d: BigInt(1) };
  for (const row of rows) {
    const value = rational(select(row));
    if (value === null) fail("INVALID_INPUT");
    total = add(total, value);
  }
  return total;
}

function optionalMeasure(
  rows: readonly ScadCur2Row[],
  select: (row: ScadCur2Row) => string | null,
): ScadOptionalMeasure {
  let total: Rational = { n: BigInt(0), d: BigInt(1) };
  let presentRows = 0;
  for (const row of rows) {
    const raw = select(row);
    if (raw === null) continue;
    const value = rational(raw);
    if (value === null) fail("INVALID_INPUT");
    total = add(total, value);
    presentRows += 1;
  }
  const complete = presentRows === rows.length;
  return {
    exact: complete ? exact(total) : null,
    presentRows,
    totalRows: rows.length,
    complete,
  };
}

function deltaMeasure(
  rows: readonly ScadCur2Row[],
  left: (row: ScadCur2Row) => string | null,
  right: (row: ScadCur2Row) => string | null,
): ScadOptionalMeasure {
  let total: Rational = { n: BigInt(0), d: BigInt(1) };
  let presentRows = 0;
  for (const row of rows) {
    const leftRaw = left(row);
    const rightRaw = right(row);
    if (leftRaw === null || rightRaw === null) continue;
    const leftValue = rational(leftRaw);
    const rightValue = rational(rightRaw);
    if (leftValue === null || rightValue === null) fail("INVALID_INPUT");
    total = add(total, subtractNonNegative(leftValue, rightValue));
    presentRows += 1;
  }
  const complete = presentRows === rows.length;
  return {
    exact: complete ? exact(total) : null,
    presentRows,
    totalRows: rows.length,
    complete,
  };
}

function tag(tags: Readonly<Record<string, string>>, key: string): string | null {
  const value = tags[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function lineage(row: ScadCur2Row): ScadLineage {
  const eks = row.platform === "EKS" || row.platform === "BATCH_EKS";
  const batch = row.platform === "BATCH_EKS" || row.platform === "BATCH_ECS";
  const cluster = eks
    ? tag(row.resourceTags, "aws_eks_cluster_name")
    : tag(row.resourceTags, "aws_ecs_cluster_name");
  const namespace = eks ? tag(row.resourceTags, "aws_eks_namespace") : null;
  const batchJobDefinition = batch
    ? tag(row.resourceTags, "aws_batch_job_definition") : null;
  const batchJobQueue = batch ? tag(row.resourceTags, "aws_batch_job_queue") : null;
  const batchComputeEnvironment = batch
    ? tag(row.resourceTags, "aws_batch_compute_environment") : null;
  const service = tag(row.resourceTags, "aws_ecs_service_name");
  const eksWorkload = tag(row.resourceTags, "aws_eks_workload_name");
  const workloadType = batch && batchJobDefinition !== null
    ? "AWS_BATCH_JOB_DEFINITION"
    : eks
      ? tag(row.resourceTags, "aws_eks_workload_type")
      : service === null ? null : "ECS_SERVICE";
  const workload = batch && batchJobDefinition !== null
    ? batchJobDefinition
    : eks ? eksWorkload : service;
  const deployment = eks ? tag(row.resourceTags, "aws_eks_deployment") : null;
  const node = eks ? tag(row.resourceTags, "aws_eks_node") : null;
  return {
    payerAccountId: row.payerAccountId,
    usageAccountId: row.usageAccountId,
    region: row.region,
    platform: row.platform,
    cluster,
    namespace,
    workloadType,
    workload,
    deployment,
    node,
    batchJobDefinition,
    batchJobQueue,
    batchComputeEnvironment,
    podOrTaskId: row.resourceId,
    parentResourceId: row.parentResourceId,
    containerId: null,
    containerLineageState: "NOT_PUBLISHED_BY_CUR2_SCAD",
    completeThroughPodOrTask: cluster !== null
      && row.resourceId.length > 0
      && (eks ? namespace !== null : true),
  };
}

function validateRow(
  row: ScadCur2Row,
  scope: ScadScope,
  objectIds: ReadonlySet<string>,
  periodStart: number,
  periodEnd: number,
): void {
  if (!objectIds.has(row.sourceObjectId)) fail("EVIDENCE_REFERENCE_MISSING");
  if (!scope.payerAccountIds.includes(row.payerAccountId)) fail("ACCOUNT_SCOPE_MISMATCH");
  if (!scope.usageAccountIds.includes(row.usageAccountId)) fail("ACCOUNT_SCOPE_MISMATCH");
  if (!scope.regions.includes(row.region)) fail("REGION_SCOPE_MISMATCH");
  const start = parseTime(row.usageStartAt);
  const end = parseTime(row.usageEndAt);
  const stringFields = [
    row.lineItemId, row.sourceObjectId, row.usageType, row.usageUnit,
    row.currency, row.resourceId,
  ];
  if (
    stringFields.some((value) => !SAFE_TEXT.test(value))
    || !ACCOUNT_ID.test(row.payerAccountId)
    || !ACCOUNT_ID.test(row.usageAccountId)
    || !REGION.test(row.region)
    || !Number.isSafeInteger(row.sourceRowNumber)
    || row.sourceRowNumber < 2
    || start === null || end === null || end <= start
    || start < periodStart || end > periodEnd
    || !["EKS", "ECS", "BATCH_EKS", "BATCH_ECS"].includes(row.platform)
    || !["VCPU", "MEMORY", "GPU", "TRAINIUM", "INFERENTIA", "OTHER_ACCELERATOR"].includes(row.metric)
    || !/^[A-Z]{3}$/u.test(row.currency)
    || (row.parentResourceId !== null && !SAFE_TEXT.test(row.parentResourceId))
  ) fail("INVALID_INPUT");
  for (const [key, value] of Object.entries(row.resourceTags)) {
    if (!SAFE_TEXT.test(key) || !SAFE_TEXT.test(value)) fail("INVALID_INPUT");
  }
  const required = [row.splitUsage, row.splitCost, row.unusedCost];
  const optional = [
    row.reservedUsage, row.actualUsage, row.splitUsageRatio,
    row.netSplitCost, row.netUnusedCost, row.publicOnDemandSplitCost,
    row.publicOnDemandUnusedCost,
  ];
  if (required.some((value) => rational(value) === null)
    || optional.some((value) => value !== null && rational(value) === null)) {
    fail("INVALID_INPUT");
  }
  if (row.splitUsageRatio !== null) {
    const ratio = rational(row.splitUsageRatio);
    if (ratio === null || compare(ratio, { n: BigInt(1), d: BigInt(1) }) > 0) {
      fail("INVALID_INPUT");
    }
  }
  const split = rational(row.splitUsage);
  const reserved = row.reservedUsage === null ? null : rational(row.reservedUsage);
  const actual = row.actualUsage === null ? null : rational(row.actualUsage);
  if (split === null) fail("INVALID_INPUT");
  if (reserved !== null && actual !== null) {
    const maximum = compare(reserved, actual) >= 0 ? reserved : actual;
    if (compare(split, maximum) !== 0) fail("INCONSISTENT_SPLIT_USAGE");
  } else if (reserved !== null && compare(split, reserved) !== 0) {
    fail("INCONSISTENT_SPLIT_USAGE");
  }
}

function validateCapture(capture: ScadCapture, expectedScope: ScadScope, now: number): void {
  if (!validScope(expectedScope) || !validScope(capture.scope)) fail("INVALID_INPUT");
  if (!sameScope(capture.scope, expectedScope)) fail("SCOPE_MISMATCH");
  const payerIds = uniqueSorted(capture.scope.payerAccountIds, ACCOUNT_ID);
  const usageIds = uniqueSorted(capture.scope.usageAccountIds, ACCOUNT_ID);
  const regions = uniqueSorted(capture.scope.regions, REGION);
  const started = parseTime(capture.startedAt);
  const completed = parseTime(capture.completedAt);
  const generated = parseTime(capture.generatedAt);
  const through = parseTime(capture.dataThroughAt);
  const periodStart = parseTime(capture.billingPeriodStartAt);
  const periodEnd = parseTime(capture.billingPeriodEndAt);
  const enabled = parseTime(capture.scadEnabledAt);
  const firstDelivery = capture.firstDeliveryObservedAt === null
    ? null : parseTime(capture.firstDeliveryObservedAt);
  const exportArnAccount = capture.exportArn.split(":")[4] ?? "";
  if (
    capture.schemaVersion !== "sutra.scad-allocation.capture.v1"
    || payerIds === null || usageIds === null || regions === null
    || JSON.stringify(payerIds) !== JSON.stringify(capture.scope.payerAccountIds)
    || JSON.stringify(usageIds) !== JSON.stringify(capture.scope.usageAccountIds)
    || JSON.stringify(regions) !== JSON.stringify(capture.scope.regions)
    || !CAPTURE_ID.test(capture.captureId)
    || !SAFE_TEXT.test(capture.exportName)
    || !EXPORT_ARN.test(capture.exportArn)
    || !capture.scope.payerAccountIds.includes(exportArnAccount)
    || !GENERATION_ID.test(capture.activeGenerationId)
    || (capture.correctionOfGenerationId !== null
      && (!GENERATION_ID.test(capture.correctionOfGenerationId)
        || capture.correctionOfGenerationId === capture.activeGenerationId))
    || !SHA256.test(capture.manifestSha256)
    || started === null || completed === null || generated === null || through === null
    || periodStart === null || periodEnd === null || enabled === null
    || (capture.firstDeliveryObservedAt !== null && firstDelivery === null)
    || completed < started || completed - started > SCAD_BOUNDS.maximumCaptureDurationMs
    || completed > now + CLOCK_SKEW_MS || generated > completed + CLOCK_SKEW_MS
    || through > completed + CLOCK_SKEW_MS || periodEnd <= periodStart
    || !validMonthlyPeriod(periodStart, periodEnd)
    || enabled > completed + CLOCK_SKEW_MS
    || !Number.isSafeInteger(capture.deliverySequence)
    || capture.deliverySequence < 0
    || (capture.firstDeliveryObservedAt === null && capture.deliverySequence !== 0)
    || (capture.firstDeliveryObservedAt !== null && capture.deliverySequence === 0)
    || (capture.correctionOfGenerationId !== null && capture.deliverySequence < 2)
    || (firstDelivery !== null && (firstDelivery < enabled || firstDelivery > completed + CLOCK_SKEW_MS))
    || !S3_BUCKET.test(capture.destination.bucket)
    || !SAFE_TEXT.test(capture.destination.prefix)
    || !capture.destination.prefix.endsWith("/")
    || capture.destination.prefix.startsWith("/")
    || capture.destination.prefix.includes("\\")
    || capture.destination.prefix.split("/").some((part) => part === "." || part === "..")
    || capture.tableConfiguration.tableName !== "COST_AND_USAGE_REPORT"
    || capture.tableConfiguration.timeGranularity !== "HOURLY"
    || capture.coverage.schemaColumns.length > SCAD_BOUNDS.maximumColumns
    || capture.coverage.schemaColumns.some((column) => !COLUMN.test(column))
    || new Set(capture.coverage.schemaColumns).size !== capture.coverage.schemaColumns.length
    || capture.scope.usageAccountIds.length > SCAD_BOUNDS.maximumAccounts
    || capture.coverage.expectedObjectCount < 0
    || capture.coverage.processedObjectCount < 0
    || capture.coverage.failedObjectCount < 0
    || !Number.isSafeInteger(capture.coverage.expectedObjectCount)
    || !Number.isSafeInteger(capture.coverage.processedObjectCount)
    || !Number.isSafeInteger(capture.coverage.failedObjectCount)
    || capture.coverage.processedObjectCount !== capture.objects.length
    || capture.coverage.processedObjectCount + capture.coverage.failedObjectCount
      > capture.coverage.expectedObjectCount
    || (capture.coverage.errorCode !== null && !ERROR_CODE.test(capture.coverage.errorCode))
  ) fail("INVALID_INPUT");
  if (capture.rows.length > SCAD_BOUNDS.maximumRows
    || capture.objects.length > SCAD_BOUNDS.maximumObjects
    || Buffer.byteLength(JSON.stringify(capture), "utf8") > SCAD_BOUNDS.maximumCaptureBytes) {
    fail("LIMIT_EXCEEDED");
  }
  const objectIds = new Set<string>();
  const objectKeys = new Set<string>();
  for (const object of capture.objects) {
    if (!IDENTIFIER.test(object.objectId)
      || !S3_BUCKET.test(object.bucket)
      || object.bucket !== capture.destination.bucket
      || !SAFE_TEXT.test(object.key)
      || !object.key.startsWith(capture.destination.prefix)
      || object.key.length === capture.destination.prefix.length
      || object.key.startsWith("/") || object.key.includes("\\")
      || object.key.split("/").some((part) => part === "." || part === "..")
      || !SAFE_TEXT.test(object.eTag)
      || (object.versionId !== null && !SAFE_TEXT.test(object.versionId))
      || !SHA256.test(object.sha256)
      || !Number.isSafeInteger(object.sizeBytes) || object.sizeBytes < 0) {
      fail("INVALID_INPUT");
    }
    if (objectIds.has(object.objectId) || objectKeys.has(`${object.bucket}/${object.key}`)) {
      fail("DUPLICATE_EVIDENCE");
    }
    objectIds.add(object.objectId);
    objectKeys.add(`${object.bucket}/${object.key}`);
  }
  const lineIds = new Set<string>();
  for (const row of capture.rows) {
    validateRow(row, capture.scope, objectIds, periodStart, periodEnd);
    if (lineIds.has(row.lineItemId)) fail("CONFLICTING_DUPLICATE");
    lineIds.add(row.lineItemId);
  }
}

function configurationComplete(capture: ScadCapture): boolean {
  const columns = new Set(capture.coverage.schemaColumns);
  return capture.tableConfiguration.includeResources === "TRUE"
    && capture.tableConfiguration.includeSplitCostAllocationData === "TRUE"
    && capture.coverage.runtimeS3PermissionsValidated
    && [...SCAD_CUR2_BASE_COLUMNS, ...SCAD_CUR2_SPLIT_COLUMNS]
      .every((column) => columns.has(column));
}

function captureComplete(capture: ScadCapture): boolean {
  return capture.coverage.rowsExhausted
    && capture.coverage.failedObjectCount === 0
    && capture.coverage.processedObjectCount === capture.coverage.expectedObjectCount
    && capture.coverage.processedObjectCount === capture.objects.length
    && capture.coverage.errorCode === null;
}

function snapshotState(capture: ScadCapture, now: number): ScadSnapshotState {
  if (!configurationComplete(capture)) return "CONFIGURATION_REQUIRED";
  if (capture.firstDeliveryObservedAt === null && capture.rows.length === 0
    && capture.coverage.processedObjectCount === 0) return "WAITING_FIRST_DELIVERY";
  if (!captureComplete(capture)) return "PARTIAL";
  if (now - Date.parse(capture.dataThroughAt) > SCAD_BOUNDS.freshnessSlaHours * HOUR_MS) {
    return "STALE";
  }
  return capture.rows.length === 0 ? "NO_USAGE" : "READY";
}

function deliveryState(capture: ScadCapture): ScadDeliveryState {
  if (capture.firstDeliveryObservedAt === null) return "WAITING_FIRST_DELIVERY";
  if (capture.correctionOfGenerationId !== null) return "CORRECTED_DELIVERY";
  return capture.deliverySequence === 1 ? "FIRST_DELIVERY" : "REGULAR_DELIVERY";
}

function groupKey(row: ScadCur2Row, value: ScadLineage): string {
  return JSON.stringify([
    value.payerAccountId, value.usageAccountId, value.region, value.platform,
    value.cluster, value.namespace, value.workloadType, value.workload,
    value.deployment, value.node, value.batchJobDefinition, value.batchJobQueue,
    value.batchComputeEnvironment, value.podOrTaskId, value.parentResourceId,
    row.metric, row.usageType, row.usageUnit, row.currency,
  ]);
}

function buildGroup(group: MutableGroup): ScadAllocationGroup {
  const allocated = sumRequired(group.rows, (row) => row.splitCost);
  const unused = sumRequired(group.rows, (row) => row.unusedCost);
  return {
    lineage: group.lineage,
    metric: group.metric,
    usageType: group.usageType,
    usageUnit: group.usageUnit,
    currency: group.currency,
    rowCount: group.rows.length,
    requestedUsage: optionalMeasure(group.rows, (row) => row.reservedUsage),
    actualUsage: optionalMeasure(group.rows, (row) => row.actualUsage),
    allocatedUsage: exact(sumRequired(group.rows, (row) => row.splitUsage)),
    actualAboveRequest: deltaMeasure(group.rows, (row) => row.actualUsage, (row) => row.reservedUsage),
    requestedHeadroom: deltaMeasure(group.rows, (row) => row.reservedUsage, (row) => row.actualUsage),
    splitUsageRatioSum: optionalMeasure(group.rows, (row) => row.splitUsageRatio),
    allocatedAmortizedCost: exact(allocated),
    attributedUnusedAmortizedCost: exact(unused),
    attributedAmortizedCost: exact(add(allocated, unused)),
    netAllocatedCost: optionalMeasure(group.rows, (row) => row.netSplitCost),
    netUnusedCost: optionalMeasure(group.rows, (row) => row.netUnusedCost),
    publicOnDemandAllocatedCost: optionalMeasure(group.rows, (row) => row.publicOnDemandSplitCost),
    publicOnDemandUnusedCost: optionalMeasure(group.rows, (row) => row.publicOnDemandUnusedCost),
    evidenceLineItemIds: group.rows.map((row) => row.lineItemId)
      .sort((a, b) => a.localeCompare(b, "en-US")),
  };
}

function currencyTotals(
  rows: readonly ScadCur2Row[],
  select: (row: ScadCur2Row) => Rational,
): ScadCurrencyTotal[] {
  const totals = new Map<string, Rational>();
  for (const row of rows) {
    totals.set(row.currency, add(
      totals.get(row.currency) ?? { n: BigInt(0), d: BigInt(1) },
      select(row),
    ));
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([currency, value]) => ({ currency, exact: exact(value) }));
}

export function buildScadAllocationSnapshot(
  capture: ScadCapture,
  expectedScope: ScadScope,
  nowInput: Date | number,
): ScadAllocationSnapshot {
  const now = nowInput instanceof Date ? nowInput.getTime() : nowInput;
  if (!Number.isFinite(now)) fail("INVALID_INPUT");
  validateCapture(capture, expectedScope, now);

  const groups = new Map<string, MutableGroup>();
  let completeLineageRows = 0;
  let missingBusinessLineageRows = 0;
  const unallocatedRows: ScadCur2Row[] = [];
  for (const row of capture.rows) {
    const value = lineage(row);
    if (value.completeThroughPodOrTask) completeLineageRows += 1;
    else {
      missingBusinessLineageRows += 1;
      const allocated = rational(row.splitCost);
      const unused = rational(row.unusedCost);
      if (allocated === null || unused === null) fail("INVALID_INPUT");
      unallocatedRows.push(row);
    }
    const key = groupKey(row, value);
    const current = groups.get(key);
    if (current === undefined) {
      groups.set(key, {
        lineage: value,
        metric: row.metric,
        usageType: row.usageType,
        usageUnit: row.usageUnit,
        currency: row.currency,
        rows: [row],
      });
    } else current.rows.push(row);
  }
  if (groups.size > SCAD_BOUNDS.maximumGroups) fail("LIMIT_EXCEEDED");
  const projectedGroups = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([, group]) => buildGroup(group));
  const state = snapshotState(capture, now);
  const complete = state === "READY" || state === "NO_USAGE";
  const partialHistory = !captureComplete(capture);

  return {
    schemaVersion: "sutra.scad-allocation.snapshot.v1",
    scope: capture.scope,
    captureId: capture.captureId,
    activeGenerationId: capture.activeGenerationId,
    state,
    deliveryState: deliveryState(capture),
    historicalCoverage: {
      state: partialHistory
        ? "PARTIAL_SINCE_ENABLEMENT"
        : "NO_BACKFILL_BEFORE_ENABLEMENT",
      beginsAt: capture.scadEnabledAt,
      backfillAvailable: false,
      disclosure: "AWS SCAD begins collecting for the current month after opt-in; fields are not backfilled for periods before enablement.",
    },
    replacementPolicy: "REPLACE_BILLING_PERIOD_ATOMICALLY",
    complete,
    generatedAt: capture.generatedAt,
    dataThroughAt: capture.dataThroughAt,
    sourceErrorCode: capture.coverage.errorCode,
    billingPeriodStartAt: capture.billingPeriodStartAt,
    billingPeriodEndAt: capture.billingPeriodEndAt,
    rowCount: capture.rows.length,
    groupCount: projectedGroups.length,
    objectCoverage: {
      expected: capture.coverage.expectedObjectCount,
      processed: capture.coverage.processedObjectCount,
      failed: capture.coverage.failedObjectCount,
    },
    lineageCoverage: {
      rowsCompleteThroughPodOrTask: completeLineageRows,
      rowsMissingBusinessLineage: missingBusinessLineageRows,
      unallocatedAmortizedCost: currencyTotals(unallocatedRows, (row) => {
        const allocated = rational(row.splitCost);
        const unused = rational(row.unusedCost);
        if (allocated === null || unused === null) fail("INVALID_INPUT");
        return add(allocated, unused);
      }),
      containerRowsPublishedByScad: 0,
    },
    totals: {
      allocatedAmortizedCost: currencyTotals(capture.rows, (row) => {
        const value = rational(row.splitCost);
        if (value === null) fail("INVALID_INPUT");
        return value;
      }),
      attributedUnusedAmortizedCost: currencyTotals(capture.rows, (row) => {
        const value = rational(row.unusedCost);
        if (value === null) fail("INVALID_INPUT");
        return value;
      }),
      attributedAmortizedCost: currencyTotals(capture.rows, (row) => {
        const allocated = rational(row.splitCost);
        const unused = rational(row.unusedCost);
        if (allocated === null || unused === null) fail("INVALID_INPUT");
        return add(allocated, unused);
      }),
    },
    groups: projectedGroups,
    limitations: [
      "SCAD publishes EKS pod and ECS task line items; it does not publish container identifiers, so container lineage is explicitly unavailable.",
      "Actual usage is null when the selected SCAD measurement mode publishes resource requests only; null is never converted to zero.",
      "Unused cost is AWS-attributed unused capacity cost. Unallocated cost here means cost on rows missing business lineage, not undiscovered parent capacity.",
      "Net cost remains null unless every contributing row carries the conditional net split columns.",
    ],
  };
}

export function scadAllocationSourceEvidence(
  snapshot: ScadAllocationSnapshot,
): FinopsSourceEvidence {
  const succeeded = snapshot.state === "READY" || snapshot.state === "NO_USAGE";
  const partial = snapshot.state === "PARTIAL" || snapshot.state === "STALE";
  return {
    scope: snapshot.scope,
    sourceId: "scad_allocation",
    configured: snapshot.state !== "CONFIGURATION_REQUIRED",
    deliveryObserved: snapshot.deliveryState !== "WAITING_FIRST_DELIVERY",
    lastAttemptAt: snapshot.generatedAt,
    lastAttemptOutcome: succeeded ? "succeeded" : partial ? "partial" : "unknown",
    lastSuccessAt: succeeded ? snapshot.generatedAt : null,
    dataThroughAt: snapshot.dataThroughAt,
    coverage: {
      assessment: succeeded ? "complete" : partial ? "partial" : "unknown",
      acceptedRecords: snapshot.rowCount,
      expectedRecords: null,
      rejectedRecords: 0,
    },
    lastError: snapshot.sourceErrorCode === null ? null : {
      code: snapshot.sourceErrorCode,
      message: "The SCAD CUR 2.0 object set was not collected completely.",
      at: snapshot.generatedAt,
    },
    evidenceBasis: `Immutable CUR 2.0 SCAD generation ${snapshot.activeGenerationId}; ${snapshot.objectCoverage.processed}/${snapshot.objectCoverage.expected} S3 objects processed.`,
    limitations: snapshot.limitations,
  };
}
