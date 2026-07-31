/**
 * Evidence-honest AWS Config organization compliance normalization.
 *
 * The credential-owning collector is outside this module. It must collect the
 * exact read operations declared below under server-owned tenant/account scope.
 * This pure module performs no AWS, network, database, route, or UI I/O.
 */
import type {
  FinopsSourceEvidence,
  FinopsSourceScope,
} from "./finops-source-health.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const ORGANIZATION_ID = /^o-[a-z0-9]{10,32}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const AGGREGATOR_NAME = /^[\w-]{1,256}$/u;
const CAPTURE_ID = /^config_[a-f0-9]{64}$/u;
const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+\/-]{0,511}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const NON_NEGATIVE_INTEGER = /^(?:0|[1-9]\d{0,39})$/u;
const SIGNED_INTEGER = /^-?(?:0|[1-9]\d{0,39})$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const RESOURCE_TYPE = /^AWS::[A-Za-z0-9]+(?:::[A-Za-z0-9]+)+$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f<>]{1,1024}$/u;
const CONFIG_AGGREGATOR_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):config:([a-z]{2}(?:-gov)?-[a-z]+-\d):(\d{12}):config-aggregator\/(config-aggregator-[a-z0-9]+)$/u;
const CONFIG_RULE_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):config:([a-z]{2}(?:-gov)?-[a-z]+-\d):(\d{12}):config-rule\/(config-rule-[a-z0-9]+)$/u;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

export const AWS_CONFIG_COMPLIANCE_BOUNDS = Object.freeze({
  maximumCaptureBytes: 96 * 1_024 * 1_024,
  maximumDashboardBytes: 16 * 1_024 * 1_024,
  maximumDurationMs: 20 * 60 * 1_000,
  maximumAccounts: 10_000,
  maximumRegions: 64,
  maximumAccountRegions: 100_000,
  maximumRules: 250_000,
  maximumEvaluations: 1_000_000,
  maximumConformancePacks: 100_000,
  maximumResourceCounts: 250_000,
  maximumInventoryRecords: 250_000,
  maximumActivityRows: 500_000,
  maximumCostRows: 250_000,
  maximumOperationCoverageRows: 250_000,
  maximumTextCharacters: 1_024,
  sourceFreshnessSlaHours: 48,
  activityFreshnessSlaHours: 48,
  cur2FreshnessSlaHours: 48,
} as const);

/** Calls made against the organization aggregator account and Region. */
export const AWS_CONFIG_AGGREGATOR_READ_OPERATIONS = Object.freeze([
  "config:DescribeConfigurationAggregators",
  "config:DescribeConfigurationAggregatorSourcesStatus",
  "config:DescribeAggregateComplianceByConfigRules",
  "config:GetAggregateComplianceDetailsByConfigRule",
  "config:DescribeAggregateComplianceByConformancePacks",
  "config:GetAggregateDiscoveredResourceCounts",
  "config:SelectAggregateResourceConfig",
] as const);

/** Account/Region fan-out required for rule definition and evaluation lifecycle. */
export const AWS_CONFIG_RULE_LIFECYCLE_READ_OPERATIONS = Object.freeze([
  "config:DescribeConfigRules",
  "config:DescribeConfigRuleEvaluationStatus",
] as const);

/** Account/Region fan-out proving that AWS Config is actually recording. */
export const AWS_CONFIG_RECORDER_COVERAGE_READ_OPERATIONS = Object.freeze([
  "config:DescribeConfigurationRecorders",
  "config:DescribeConfigurationRecorderStatus",
] as const);

/** Canonical organization coverage dependency. */
export const AWS_CONFIG_ORGANIZATION_READ_OPERATIONS = Object.freeze([
  "organizations:DescribeOrganization",
  "organizations:ListAccounts",
] as const);

/** Optional exact-prefix reads for AWS Config delivery activity history. */
export const AWS_CONFIG_ACTIVITY_S3_READ_OPERATIONS = Object.freeze([
  "s3:GetBucketLocation",
  "s3:GetObject",
  "s3:GetObjectAttributes",
  "s3:ListBucket",
] as const);

export const AWS_CONFIG_AGGREGATE_INVENTORY_QUERY =
  "SELECT accountId, awsRegion, resourceType, resourceId, configurationItemCaptureTime, resourceCreationTime, configurationItemStatus" as const;

export type AwsConfigPartition = "aws" | "aws-us-gov" | "aws-cn";
export type AwsConfigOperation =
  | typeof AWS_CONFIG_AGGREGATOR_READ_OPERATIONS[number]
  | typeof AWS_CONFIG_RULE_LIFECYCLE_READ_OPERATIONS[number]
  | typeof AWS_CONFIG_RECORDER_COVERAGE_READ_OPERATIONS[number]
  | typeof AWS_CONFIG_ORGANIZATION_READ_OPERATIONS[number];
export type AwsConfigOperationState =
  | "SUCCEEDED"
  | "PARTIAL"
  | "ACCESS_DENIED"
  | "CONFIGURATION_REQUIRED"
  | "UNAVAILABLE";
export type AwsConfigFailureCode =
  | "ACCESS_DENIED"
  | "EXPIRED_TOKEN"
  | "THROTTLED"
  | "TIMEOUT"
  | "BOUND_REACHED"
  | "AGGREGATOR_NOT_FOUND"
  | "PROVIDER_UNAVAILABLE"
  | "UNKNOWN";
export type AwsConfigComplianceType =
  | "COMPLIANT"
  | "NON_COMPLIANT"
  | "INSUFFICIENT_DATA"
  | "NOT_APPLICABLE";

export interface AwsConfigComplianceScope extends FinopsSourceScope {
  readonly partition: AwsConfigPartition;
  readonly aggregatorAccountId: string;
  readonly aggregatorRegion: string;
  readonly aggregatorName: string;
  readonly aggregatorArn: string;
}

export interface AwsConfigOperationCoverage {
  readonly operation: AwsConfigOperation;
  /** Null for the central aggregator/organization call; otherwise fan-out scope. */
  readonly accountId: string | null;
  readonly region: string | null;
  readonly state: AwsConfigOperationState;
  readonly pageCount: number;
  readonly recordCount: number;
  readonly exhausted: boolean;
  readonly failureCode: AwsConfigFailureCode | null;
}

export interface AwsConfigExpectedCoverage {
  readonly awsOrganizationId: string;
  readonly accountsEvidenceId: string;
  readonly accountsObservedAt: string;
  readonly activeAccountIds: readonly string[];
  /** Explicit server-owned policy; never inferred from regions with data. */
  readonly expectedRegions: readonly string[];
}

export interface AwsConfigAggregatorDefinition {
  readonly name: string;
  readonly arn: string;
  readonly id: string;
  readonly sourceType: "ORGANIZATION" | "ACCOUNT_SET";
  readonly awsOrganizationId: string | null;
  readonly allAwsRegions: boolean;
  readonly configuredRegions: readonly string[];
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
}

export interface AwsConfigAggregatorSourceStatus {
  readonly sourceType: "ACCOUNT" | "ORGANIZATION";
  readonly sourceId: string;
  /** Present for ACCOUNT sources; organization status is Region-scoped. */
  readonly accountId: string | null;
  readonly region: string;
  readonly status: "SUCCEEDED" | "FAILED" | "OUTDATED";
  readonly lastUpdatedAt: string;
  /** Provider messages are deliberately forbidden. */
  readonly failureCode: AwsConfigFailureCode | null;
}

export interface AwsConfigRecorderCoverageRecord {
  readonly accountId: string;
  readonly region: string;
  readonly recorderName: string;
  readonly recorderType: "CUSTOMER_MANAGED" | "SERVICE_LINKED";
  /** Present only as a digest so service principals are not blindly trusted. */
  readonly servicePrincipalSha256: string | null;
  readonly recording: boolean;
  readonly lastStatus: "SUCCESS" | "FAILURE" | "PENDING" | null;
  readonly lastStatusAt: string | null;
  readonly recordAllSupported: boolean;
  readonly includeGlobalResourceTypes: boolean;
  readonly resourceTypes: readonly string[];
}

export interface AwsConfigRuleInventoryRecord {
  readonly accountId: string;
  readonly region: string;
  readonly ruleName: string;
  readonly ruleId: string;
  readonly ruleArn: string;
  readonly state: "ACTIVE" | "DELETING" | "DELETING_RESULTS" | "EVALUATING";
  readonly owner: "AWS" | "CUSTOM_LAMBDA" | "CUSTOM_POLICY";
  /** A digest, never a Lambda ARN, policy body, or input-parameter document. */
  readonly sourceIdentifierSha256: string;
  readonly createdBy: string | null;
  readonly evaluationModes: readonly ("DETECTIVE" | "PROACTIVE")[];
  readonly triggerTypes: readonly (
    | "CONFIGURATION_CHANGE"
    | "SCHEDULED"
    | "SNAPSHOT_DELIVERY"
  )[];
  readonly maximumExecutionFrequency:
    | "One_Hour"
    | "Three_Hours"
    | "Six_Hours"
    | "Twelve_Hours"
    | "TwentyFour_Hours"
    | null;
  readonly resourceTypes: readonly string[];
  readonly scopeFingerprintSha256: string;
  readonly firstActivatedAt: string | null;
  readonly lastSuccessfulEvaluationAt: string | null;
  readonly lastFailedEvaluationAt: string | null;
  readonly lastErrorCode: string | null;
}

export interface AwsConfigRuleComplianceRecord {
  readonly accountId: string;
  readonly region: string;
  readonly ruleName: string;
  readonly complianceType: "COMPLIANT" | "NON_COMPLIANT";
  readonly contributorCount: number;
  readonly contributorCountCapped: boolean;
}

export interface AwsConfigEvaluationRecord {
  readonly accountId: string;
  readonly region: string;
  readonly ruleName: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly complianceType: "COMPLIANT" | "NON_COMPLIANT";
  readonly evaluationMode: "DETECTIVE" | "PROACTIVE";
  readonly invokedAt: string;
  readonly recordedAt: string;
  readonly orderingAt: string;
  readonly resourceEvaluationId: string | null;
  /** Annotation text is never captured; only presence can be displayed. */
  readonly annotationPresent: boolean;
}

export interface AwsConfigConformancePackComplianceRecord {
  readonly accountId: string;
  readonly region: string;
  readonly packName: string;
  readonly complianceType: AwsConfigComplianceType;
  readonly compliantRuleCount: number;
  readonly nonCompliantRuleCount: number;
  readonly totalRuleCount: number;
}

export interface AwsConfigResourceCountRecord {
  readonly accountId: string;
  readonly region: string;
  readonly resourceType: string;
  readonly resourceCount: number;
}

export interface AwsConfigResourceInventoryRecord {
  readonly accountId: string;
  readonly region: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly captureTime: string;
  readonly creationTime: string | null;
  readonly itemStatus:
    | "ResourceDiscovered"
    | "ResourceNotRecorded"
    | "ResourceDeleted"
    | "ResourceDeletedNotRecorded";
}

export interface AwsConfigActivityRecord {
  readonly day: string;
  readonly accountId: string;
  readonly region: string;
  readonly ruleName: string | null;
  readonly configurationItemChanges: string;
  readonly ruleEvaluations: string;
  readonly evidenceId: string;
  readonly objectSha256: string;
}

export interface AwsConfigActivityEvidence {
  readonly source: "AWS_CONFIG_S3_DELIVERY";
  readonly configured: boolean;
  readonly exhausted: boolean;
  readonly dataThroughAt: string | null;
  readonly prefixEvidenceId: string | null;
  readonly rows: readonly AwsConfigActivityRecord[];
}

export interface AwsConfigCur2CostRecord {
  readonly billingPeriod: string;
  readonly accountId: string;
  readonly region: string;
  readonly usageType: string;
  readonly operation: string;
  readonly currency: string;
  readonly billedCostMicros: string;
  readonly amortizedCostMicros: string | null;
}

export interface AwsConfigCur2Evidence {
  readonly source: "AWS_CUR2_ACTIVE_GENERATION";
  readonly generationId: string;
  readonly sourceEvidenceId: string;
  readonly dataThroughAt: string;
  readonly reconciliationState: "reconciled" | "partial" | "failed";
  readonly predicate: "CUR2_PRODUCT_CODE_AWSCONFIG";
  readonly rows: readonly AwsConfigCur2CostRecord[];
}

export interface AwsConfigComplianceCapture {
  readonly schemaVersion: "sutra.aws-config-compliance.v1";
  readonly scope: AwsConfigComplianceScope;
  readonly captureId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly prerequisites: {
    readonly serviceConfigured: boolean;
    readonly aggregatorValidated: boolean;
    readonly readPermissionsValidated: boolean;
    readonly organizationsAllFeaturesEnabled: boolean;
  };
  readonly expectedCoverage: AwsConfigExpectedCoverage;
  readonly aggregator: AwsConfigAggregatorDefinition | null;
  readonly operationCoverage: readonly AwsConfigOperationCoverage[];
  readonly sourceStatuses: readonly AwsConfigAggregatorSourceStatus[];
  readonly recorders: readonly AwsConfigRecorderCoverageRecord[];
  readonly rules: readonly AwsConfigRuleInventoryRecord[];
  readonly ruleCompliance: readonly AwsConfigRuleComplianceRecord[];
  readonly evaluations: readonly AwsConfigEvaluationRecord[];
  readonly conformancePacks: readonly AwsConfigConformancePackComplianceRecord[];
  readonly resourceCounts: readonly AwsConfigResourceCountRecord[];
  readonly inventoryQuery: typeof AWS_CONFIG_AGGREGATE_INVENTORY_QUERY;
  readonly resourceInventory: readonly AwsConfigResourceInventoryRecord[];
  readonly activity: AwsConfigActivityEvidence | null;
  readonly cur2: AwsConfigCur2Evidence | null;
}

export type AwsConfigComplianceState =
  | "READY"
  | "EMPTY"
  | "PARTIAL"
  | "CONFIGURATION_REQUIRED"
  | "STALE"
  | "FAILED";

export interface AwsConfigRuleView extends AwsConfigRuleInventoryRecord {
  readonly complianceType: AwsConfigComplianceType | "NO_RESULTS";
  readonly contributorCount: number | null;
  readonly contributorCountCapped: boolean;
  readonly currentEvaluationCount: number;
  readonly nonCompliantEvaluationCount: number;
  readonly lifecycle:
    | "ACTIVE"
    | "EVALUATING"
    | "DELETING"
    | "DELETING_RESULTS"
    | "EVALUATION_ERROR"
    | "NEVER_EVALUATED";
  readonly duplicateSignatureCount: number;
}

export interface AwsConfigCostSummary {
  readonly currency: string;
  readonly billedCostMicros: string;
  readonly amortizedCostMicros: string | null;
  readonly rowCount: number;
}

export interface AwsConfigComplianceSnapshot {
  readonly schemaVersion: "sutra.aws-config-compliance.snapshot.v1";
  readonly scope: AwsConfigComplianceScope;
  readonly captureId: string;
  readonly capturedAt: string;
  readonly state: AwsConfigComplianceState;
  readonly channelStates: {
    readonly aggregatorCompliance: "READY" | "EMPTY" | "PARTIAL" | "FAILED" | "CONFIGURATION_REQUIRED" | "STALE";
    readonly ruleLifecycle: "READY" | "EMPTY" | "PARTIAL" | "FAILED" | "CONFIGURATION_REQUIRED" | "STALE";
    readonly configurationActivity: "READY" | "EMPTY" | "PARTIAL" | "CONFIGURATION_REQUIRED" | "STALE";
    readonly actualCost: "READY" | "EMPTY" | "PARTIAL" | "CONFIGURATION_REQUIRED" | "STALE";
  };
  readonly organizationCoverage: {
    readonly status: "COMPLETE" | "PARTIAL" | "NONE";
    readonly expectedAccountCount: number;
    readonly expectedRegionCount: number;
    readonly expectedAccountRegionCount: number;
    readonly synchronizedAccountRegionCount: number;
    readonly recordingAccountRegionCount: number;
    readonly ruleInventoryAccountRegionCount: number;
    readonly missingAccountRegions: readonly string[];
  };
  readonly freshness: {
    readonly aggregatorAgeHours: number;
    readonly activityAgeHours: number | null;
    readonly cur2AgeHours: number | null;
  };
  readonly rules: readonly AwsConfigRuleView[];
  readonly evaluations: readonly AwsConfigEvaluationRecord[];
  readonly conformancePacks: readonly AwsConfigConformancePackComplianceRecord[];
  readonly resourceCounts: readonly AwsConfigResourceCountRecord[];
  readonly resourceInventory: readonly AwsConfigResourceInventoryRecord[];
  readonly activity: {
    readonly configurationItemChanges: string;
    readonly ruleEvaluations: string;
    readonly rows: readonly AwsConfigActivityRecord[];
  };
  readonly actualCosts: readonly AwsConfigCostSummary[];
  readonly counts: {
    readonly rules: number;
    readonly compliantRules: number;
    readonly nonCompliantRules: number;
    readonly rulesWithoutResults: number;
    readonly rulesWithEvaluationErrors: number;
    readonly duplicateRuleDeployments: number;
    readonly currentEvaluations: number;
    readonly nonCompliantResources: number;
    readonly conformancePacks: number;
    readonly insufficientDataPacks: number;
    readonly discoveredResources: string;
  };
  readonly limitations: readonly string[];
}

export type AwsConfigComplianceErrorCode =
  | "INVALID_INPUT"
  | "SCOPE_MISMATCH"
  | "LIMIT_EXCEEDED"
  | "CONFLICTING_DUPLICATE"
  | "INCOMPLETE_EVIDENCE"
  | "SENSITIVE_DATA_REJECTED";

export class AwsConfigComplianceError extends Error {
  readonly code: AwsConfigComplianceErrorCode;
  constructor(code: AwsConfigComplianceErrorCode) {
    super("AWS Config compliance evidence is invalid.");
    this.name = "AwsConfigComplianceError";
    this.code = code;
  }
}

function reject(code: AwsConfigComplianceErrorCode): never {
  throw new AwsConfigComplianceError(code);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) reject("INVALID_INPUT");
  return value as Readonly<Record<string, unknown>>;
}

function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const parsed = record(value);
  const actual = Object.keys(parsed).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) reject("SENSITIVE_DATA_REJECTED");
  return parsed;
}

function text(value: unknown, expression = SAFE_TEXT, max = 1_024): string {
  if (
    typeof value !== "string"
    || value.length > max
    || value.trim() !== value
    || !expression.test(value)
  ) reject("INVALID_INPUT");
  return value;
}

function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) reject("INVALID_INPUT");
  return value as T;
}

function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) reject("INVALID_INPUT");
  return Number(value);
}

function timestamp(value: unknown, maximumMs: number): string {
  const parsed = text(value, SAFE_TEXT, 40);
  const ms = Date.parse(parsed);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== parsed || ms > maximumMs) reject("INVALID_INPUT");
  return parsed;
}

function nullableTimestamp(value: unknown, maximumMs: number): string | null {
  return value === null ? null : timestamp(value, maximumMs);
}

function sortedUniqueStrings(
  value: unknown,
  expression: RegExp,
  maximumItems: number,
  maximumText = 1_024,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) reject("LIMIT_EXCEEDED");
  const parsed = value.map((item) => text(item, expression, maximumText));
  const sorted = [...new Set(parsed)].sort((a, b) => a.localeCompare(b));
  if (sorted.length !== parsed.length || JSON.stringify(sorted) !== JSON.stringify(parsed)) reject("INVALID_INPUT");
  return sorted;
}

function decimalInteger(value: unknown, signed = false): string {
  return text(value, signed ? SIGNED_INTEGER : NON_NEGATIVE_INTEGER, 41);
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function parsedScope(value: unknown): AwsConfigComplianceScope {
  const item = exact(value, [
    "orgId", "customerId", "connectionId", "partition", "aggregatorAccountId",
    "aggregatorRegion", "aggregatorName", "aggregatorArn",
  ]);
  const parsed: AwsConfigComplianceScope = {
    orgId: text(item.orgId, IDENTIFIER, 256),
    customerId: text(item.customerId, IDENTIFIER, 256),
    connectionId: text(item.connectionId, CONNECTION_ID, 37),
    partition: choice(item.partition, ["aws", "aws-us-gov", "aws-cn"] as const),
    aggregatorAccountId: text(item.aggregatorAccountId, ACCOUNT_ID, 12),
    aggregatorRegion: text(item.aggregatorRegion, REGION, 32),
    aggregatorName: text(item.aggregatorName, AGGREGATOR_NAME, 256),
    aggregatorArn: text(item.aggregatorArn, CONFIG_AGGREGATOR_ARN, 1_024),
  };
  const arn = CONFIG_AGGREGATOR_ARN.exec(parsed.aggregatorArn);
  if (
    !arn
    || arn[1] !== parsed.partition
    || arn[2] !== parsed.aggregatorRegion
    || arn[3] !== parsed.aggregatorAccountId
  ) reject("SCOPE_MISMATCH");
  return parsed;
}

function sameScope(a: AwsConfigComplianceScope, b: AwsConfigComplianceScope): boolean {
  return a.orgId === b.orgId
    && a.customerId === b.customerId
    && a.connectionId === b.connectionId
    && a.partition === b.partition
    && a.aggregatorAccountId === b.aggregatorAccountId
    && a.aggregatorRegion === b.aggregatorRegion
    && a.aggregatorName === b.aggregatorName
    && a.aggregatorArn === b.aggregatorArn;
}

function stableAdd<T>(target: Map<string, T>, key: string, value: T): void {
  const previous = target.get(key);
  if (previous === undefined) target.set(key, value);
  else if (JSON.stringify(previous) !== JSON.stringify(value)) reject("CONFLICTING_DUPLICATE");
}

function operationCoverage(value: unknown): AwsConfigOperationCoverage {
  const item = exact(value, ["operation", "accountId", "region", "state", "pageCount", "recordCount", "exhausted", "failureCode"]);
  const operation = choice(item.operation, [
    ...AWS_CONFIG_AGGREGATOR_READ_OPERATIONS,
    ...AWS_CONFIG_RULE_LIFECYCLE_READ_OPERATIONS,
    ...AWS_CONFIG_RECORDER_COVERAGE_READ_OPERATIONS,
    ...AWS_CONFIG_ORGANIZATION_READ_OPERATIONS,
  ] as const);
  const accountId = item.accountId === null ? null : text(item.accountId, ACCOUNT_ID, 12);
  const region = item.region === null ? null : text(item.region, REGION, 32);
  if ((accountId === null) !== (region === null)) reject("INVALID_INPUT");
  const state = choice(item.state, ["SUCCEEDED", "PARTIAL", "ACCESS_DENIED", "CONFIGURATION_REQUIRED", "UNAVAILABLE"] as const);
  const failureCode = item.failureCode === null ? null : choice(item.failureCode, ["ACCESS_DENIED", "EXPIRED_TOKEN", "THROTTLED", "TIMEOUT", "BOUND_REACHED", "AGGREGATOR_NOT_FOUND", "PROVIDER_UNAVAILABLE", "UNKNOWN"] as const);
  if ((state === "SUCCEEDED") !== (failureCode === null)) reject("INVALID_INPUT");
  if (typeof item.exhausted !== "boolean") reject("INVALID_INPUT");
  return { operation, accountId, region, state, pageCount: integer(item.pageCount, 1_000_000), recordCount: integer(item.recordCount), exhausted: item.exhausted, failureCode };
}

function aggregator(value: unknown, scope: AwsConfigComplianceScope, maximumMs: number): AwsConfigAggregatorDefinition {
  const item = exact(value, ["name", "arn", "id", "sourceType", "awsOrganizationId", "allAwsRegions", "configuredRegions", "createdAt", "lastUpdatedAt"]);
  const result: AwsConfigAggregatorDefinition = {
    name: text(item.name, AGGREGATOR_NAME, 256),
    arn: text(item.arn, CONFIG_AGGREGATOR_ARN, 1_024),
    id: text(item.id, /^config-aggregator-[a-z0-9]+$/u, 256),
    sourceType: choice(item.sourceType, ["ORGANIZATION", "ACCOUNT_SET"] as const),
    awsOrganizationId: item.awsOrganizationId === null ? null : text(item.awsOrganizationId, ORGANIZATION_ID, 34),
    allAwsRegions: item.allAwsRegions === true,
    configuredRegions: sortedUniqueStrings(item.configuredRegions, REGION, AWS_CONFIG_COMPLIANCE_BOUNDS.maximumRegions, 32),
    createdAt: timestamp(item.createdAt, maximumMs),
    lastUpdatedAt: timestamp(item.lastUpdatedAt, maximumMs),
  };
  if (typeof item.allAwsRegions !== "boolean") reject("INVALID_INPUT");
  const arnMatch = CONFIG_AGGREGATOR_ARN.exec(result.arn);
  if (
    result.name !== scope.aggregatorName || result.arn !== scope.aggregatorArn
    || !arnMatch || arnMatch[4] !== result.id
  ) reject("SCOPE_MISMATCH");
  if (result.sourceType === "ORGANIZATION" && result.awsOrganizationId === null) reject("INVALID_INPUT");
  if (result.sourceType === "ACCOUNT_SET" && result.awsOrganizationId !== null) reject("INVALID_INPUT");
  return result;
}

function sourceStatus(value: unknown, maximumMs: number): AwsConfigAggregatorSourceStatus {
  const item = exact(value, ["sourceType", "sourceId", "accountId", "region", "status", "lastUpdatedAt", "failureCode"]);
  const status = choice(item.status, ["SUCCEEDED", "FAILED", "OUTDATED"] as const);
  const failureCode = item.failureCode === null ? null : choice(item.failureCode, ["ACCESS_DENIED", "EXPIRED_TOKEN", "THROTTLED", "TIMEOUT", "BOUND_REACHED", "AGGREGATOR_NOT_FOUND", "PROVIDER_UNAVAILABLE", "UNKNOWN"] as const);
  if ((status === "FAILED") !== (failureCode !== null)) reject("INVALID_INPUT");
  return {
    sourceType: choice(item.sourceType, ["ACCOUNT", "ORGANIZATION"] as const),
    sourceId: text(item.sourceId, item.sourceType === "ORGANIZATION" ? ORGANIZATION_ID : ACCOUNT_ID, 34),
    accountId: item.accountId === null ? null : text(item.accountId, ACCOUNT_ID, 12),
    region: text(item.region, REGION, 32),
    status,
    lastUpdatedAt: timestamp(item.lastUpdatedAt, maximumMs),
    failureCode,
  };
}

function recorderCoverage(value: unknown, maximumMs: number): AwsConfigRecorderCoverageRecord {
  const item = exact(value, ["accountId", "region", "recorderName", "recorderType", "servicePrincipalSha256", "recording", "lastStatus", "lastStatusAt", "recordAllSupported", "includeGlobalResourceTypes", "resourceTypes"]);
  if (typeof item.recording !== "boolean" || typeof item.recordAllSupported !== "boolean" || typeof item.includeGlobalResourceTypes !== "boolean") reject("INVALID_INPUT");
  const recorderType = choice(item.recorderType, ["CUSTOMER_MANAGED", "SERVICE_LINKED"] as const);
  const servicePrincipalSha256 = item.servicePrincipalSha256 === null ? null : text(item.servicePrincipalSha256, SHA256, 64);
  if ((recorderType === "SERVICE_LINKED") !== (servicePrincipalSha256 !== null)) reject("INVALID_INPUT");
  return {
    accountId: text(item.accountId, ACCOUNT_ID, 12), region: text(item.region, REGION, 32),
    recorderName: text(item.recorderName, SAFE_TEXT, 256), recorderType, servicePrincipalSha256,
    recording: item.recording,
    lastStatus: item.lastStatus === null ? null : choice(item.lastStatus, ["SUCCESS", "FAILURE", "PENDING"] as const),
    lastStatusAt: nullableTimestamp(item.lastStatusAt, maximumMs),
    recordAllSupported: item.recordAllSupported,
    includeGlobalResourceTypes: item.includeGlobalResourceTypes,
    resourceTypes: sortedUniqueStrings(item.resourceTypes, RESOURCE_TYPE, 1_000, 256),
  };
}

function rule(value: unknown, scope: AwsConfigComplianceScope, maximumMs: number): AwsConfigRuleInventoryRecord {
  const item = exact(value, [
    "accountId", "region", "ruleName", "ruleId", "ruleArn", "state", "owner",
    "sourceIdentifierSha256", "createdBy", "evaluationModes", "triggerTypes",
    "maximumExecutionFrequency", "resourceTypes", "scopeFingerprintSha256",
    "firstActivatedAt", "lastSuccessfulEvaluationAt", "lastFailedEvaluationAt", "lastErrorCode",
  ]);
  const accountId = text(item.accountId, ACCOUNT_ID, 12);
  const region = text(item.region, REGION, 32);
  const ruleId = text(item.ruleId, /^config-rule-[a-z0-9]+$/u, 256);
  const ruleArn = text(item.ruleArn, CONFIG_RULE_ARN, 1_024);
  const arn = CONFIG_RULE_ARN.exec(ruleArn);
  if (!arn || arn[1] !== scope.partition || arn[2] !== region || arn[3] !== accountId || arn[4] !== ruleId) reject("SCOPE_MISMATCH");
  const createdBy = item.createdBy === null ? null : text(item.createdBy, SAFE_TEXT, 256);
  const lastErrorCode = item.lastErrorCode === null ? null : text(item.lastErrorCode, /^[A-Za-z0-9._:-]{1,256}$/u, 256);
  return {
    accountId,
    region,
    ruleName: text(item.ruleName, SAFE_TEXT, 128),
    ruleId,
    ruleArn,
    state: choice(item.state, ["ACTIVE", "DELETING", "DELETING_RESULTS", "EVALUATING"] as const),
    owner: choice(item.owner, ["AWS", "CUSTOM_LAMBDA", "CUSTOM_POLICY"] as const),
    sourceIdentifierSha256: text(item.sourceIdentifierSha256, SHA256, 64),
    createdBy,
    evaluationModes: sortedUniqueStrings(item.evaluationModes, /^(?:DETECTIVE|PROACTIVE)$/u, 2) as readonly ("DETECTIVE" | "PROACTIVE")[],
    triggerTypes: sortedUniqueStrings(item.triggerTypes, /^(?:CONFIGURATION_CHANGE|SCHEDULED|SNAPSHOT_DELIVERY)$/u, 3) as readonly ("CONFIGURATION_CHANGE" | "SCHEDULED" | "SNAPSHOT_DELIVERY")[],
    maximumExecutionFrequency: item.maximumExecutionFrequency === null ? null : choice(item.maximumExecutionFrequency, ["One_Hour", "Three_Hours", "Six_Hours", "Twelve_Hours", "TwentyFour_Hours"] as const),
    resourceTypes: sortedUniqueStrings(item.resourceTypes, RESOURCE_TYPE, 100, 256),
    scopeFingerprintSha256: text(item.scopeFingerprintSha256, SHA256, 64),
    firstActivatedAt: nullableTimestamp(item.firstActivatedAt, maximumMs),
    lastSuccessfulEvaluationAt: nullableTimestamp(item.lastSuccessfulEvaluationAt, maximumMs),
    lastFailedEvaluationAt: nullableTimestamp(item.lastFailedEvaluationAt, maximumMs),
    lastErrorCode,
  };
}

function ruleCompliance(value: unknown): AwsConfigRuleComplianceRecord {
  const item = exact(value, ["accountId", "region", "ruleName", "complianceType", "contributorCount", "contributorCountCapped"]);
  if (typeof item.contributorCountCapped !== "boolean") reject("INVALID_INPUT");
  return {
    accountId: text(item.accountId, ACCOUNT_ID, 12), region: text(item.region, REGION, 32),
    ruleName: text(item.ruleName, SAFE_TEXT, 128),
    complianceType: choice(item.complianceType, ["COMPLIANT", "NON_COMPLIANT"] as const),
    contributorCount: integer(item.contributorCount), contributorCountCapped: item.contributorCountCapped,
  };
}

function evaluation(value: unknown, maximumMs: number): AwsConfigEvaluationRecord {
  const item = exact(value, ["accountId", "region", "ruleName", "resourceType", "resourceId", "complianceType", "evaluationMode", "invokedAt", "recordedAt", "orderingAt", "resourceEvaluationId", "annotationPresent"]);
  if (typeof item.annotationPresent !== "boolean") reject("INVALID_INPUT");
  return {
    accountId: text(item.accountId, ACCOUNT_ID, 12), region: text(item.region, REGION, 32),
    ruleName: text(item.ruleName, SAFE_TEXT, 128), resourceType: text(item.resourceType, RESOURCE_TYPE, 256),
    resourceId: text(item.resourceId, SAFE_TEXT, 1_024),
    complianceType: choice(item.complianceType, ["COMPLIANT", "NON_COMPLIANT"] as const),
    evaluationMode: choice(item.evaluationMode, ["DETECTIVE", "PROACTIVE"] as const),
    invokedAt: timestamp(item.invokedAt, maximumMs), recordedAt: timestamp(item.recordedAt, maximumMs),
    orderingAt: timestamp(item.orderingAt, maximumMs),
    resourceEvaluationId: item.resourceEvaluationId === null ? null : text(item.resourceEvaluationId, SAFE_TEXT, 256),
    annotationPresent: item.annotationPresent,
  };
}

function conformancePack(value: unknown): AwsConfigConformancePackComplianceRecord {
  const item = exact(value, ["accountId", "region", "packName", "complianceType", "compliantRuleCount", "nonCompliantRuleCount", "totalRuleCount"]);
  const compliantRuleCount = integer(item.compliantRuleCount);
  const nonCompliantRuleCount = integer(item.nonCompliantRuleCount);
  const totalRuleCount = integer(item.totalRuleCount);
  if (BigInt(compliantRuleCount) + BigInt(nonCompliantRuleCount) > BigInt(totalRuleCount)) reject("INVALID_INPUT");
  return {
    accountId: text(item.accountId, ACCOUNT_ID, 12), region: text(item.region, REGION, 32),
    packName: text(item.packName, SAFE_TEXT, 256),
    complianceType: choice(item.complianceType, ["COMPLIANT", "NON_COMPLIANT", "INSUFFICIENT_DATA", "NOT_APPLICABLE"] as const),
    compliantRuleCount, nonCompliantRuleCount, totalRuleCount,
  };
}

function resourceCount(value: unknown): AwsConfigResourceCountRecord {
  const item = exact(value, ["accountId", "region", "resourceType", "resourceCount"]);
  return { accountId: text(item.accountId, ACCOUNT_ID, 12), region: text(item.region, REGION, 32), resourceType: text(item.resourceType, RESOURCE_TYPE, 256), resourceCount: integer(item.resourceCount) };
}

function inventory(value: unknown, maximumMs: number): AwsConfigResourceInventoryRecord {
  const item = exact(value, ["accountId", "region", "resourceType", "resourceId", "captureTime", "creationTime", "itemStatus"]);
  return {
    accountId: text(item.accountId, ACCOUNT_ID, 12), region: text(item.region, REGION, 32),
    resourceType: text(item.resourceType, RESOURCE_TYPE, 256), resourceId: text(item.resourceId, SAFE_TEXT, 1_024),
    captureTime: timestamp(item.captureTime, maximumMs), creationTime: nullableTimestamp(item.creationTime, maximumMs),
    itemStatus: choice(item.itemStatus, ["ResourceDiscovered", "ResourceNotRecorded", "ResourceDeleted", "ResourceDeletedNotRecorded"] as const),
  };
}

function activity(value: unknown): AwsConfigActivityRecord {
  const item = exact(value, ["day", "accountId", "region", "ruleName", "configurationItemChanges", "ruleEvaluations", "evidenceId", "objectSha256"]);
  const day = text(item.day, /^\d{4}-\d{2}-\d{2}$/u, 10);
  if (new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day) reject("INVALID_INPUT");
  return {
    day, accountId: text(item.accountId, ACCOUNT_ID, 12), region: text(item.region, REGION, 32),
    ruleName: item.ruleName === null ? null : text(item.ruleName, SAFE_TEXT, 128),
    configurationItemChanges: decimalInteger(item.configurationItemChanges), ruleEvaluations: decimalInteger(item.ruleEvaluations),
    evidenceId: text(item.evidenceId, EVIDENCE_ID, 512), objectSha256: text(item.objectSha256, SHA256, 64),
  };
}

function cost(value: unknown): AwsConfigCur2CostRecord {
  const item = exact(value, ["billingPeriod", "accountId", "region", "usageType", "operation", "currency", "billedCostMicros", "amortizedCostMicros"]);
  const billingPeriod = text(item.billingPeriod, /^\d{4}-\d{2}$/u, 7);
  if (new Date(`${billingPeriod}-01T00:00:00.000Z`).toISOString().slice(0, 7) !== billingPeriod) reject("INVALID_INPUT");
  return {
    billingPeriod, accountId: text(item.accountId, ACCOUNT_ID, 12), region: text(item.region, REGION, 32),
    usageType: text(item.usageType, SAFE_TEXT, 256), operation: text(item.operation, SAFE_TEXT, 256),
    currency: text(item.currency, CURRENCY, 3), billedCostMicros: decimalInteger(item.billedCostMicros, true),
    amortizedCostMicros: item.amortizedCostMicros === null ? null : decimalInteger(item.amortizedCostMicros, true),
  };
}

function ageHours(timestampValue: string, nowMs: number): number {
  return Math.max(0, (nowMs - Date.parse(timestampValue)) / HOUR_MS);
}

function requiredCentralOperations(): readonly AwsConfigOperation[] {
  return [...AWS_CONFIG_AGGREGATOR_READ_OPERATIONS, ...AWS_CONFIG_ORGANIZATION_READ_OPERATIONS];
}

export function normalizeAwsConfigComplianceCapture(
  value: unknown,
  expectedScope: AwsConfigComplianceScope,
  nowMs = Date.now(),
): AwsConfigComplianceSnapshot {
  if (!Number.isFinite(nowMs) || jsonBytes(value) > AWS_CONFIG_COMPLIANCE_BOUNDS.maximumCaptureBytes) reject("LIMIT_EXCEEDED");
  const root = exact(value, ["schemaVersion", "scope", "captureId", "startedAt", "completedAt", "prerequisites", "expectedCoverage", "aggregator", "operationCoverage", "sourceStatuses", "recorders", "rules", "ruleCompliance", "evaluations", "conformancePacks", "resourceCounts", "inventoryQuery", "resourceInventory", "activity", "cur2"]);
  if (root.schemaVersion !== "sutra.aws-config-compliance.v1") reject("INVALID_INPUT");
  const trustedScope = parsedScope(expectedScope);
  const captureScope = parsedScope(root.scope);
  if (!sameScope(captureScope, trustedScope)) reject("SCOPE_MISMATCH");
  if (typeof root.captureId !== "string" || !CAPTURE_ID.test(root.captureId)) reject("INVALID_INPUT");
  const startedAt = timestamp(root.startedAt, nowMs + MAX_CLOCK_SKEW_MS);
  const completedAt = timestamp(root.completedAt, nowMs + MAX_CLOCK_SKEW_MS);
  if (Date.parse(completedAt) < Date.parse(startedAt) || Date.parse(completedAt) - Date.parse(startedAt) > AWS_CONFIG_COMPLIANCE_BOUNDS.maximumDurationMs) reject("LIMIT_EXCEEDED");
  const prerequisites = exact(root.prerequisites, ["serviceConfigured", "aggregatorValidated", "readPermissionsValidated", "organizationsAllFeaturesEnabled"]);
  if (![prerequisites.serviceConfigured, prerequisites.aggregatorValidated, prerequisites.readPermissionsValidated, prerequisites.organizationsAllFeaturesEnabled].every((item) => typeof item === "boolean")) reject("INVALID_INPUT");

  const coverageInput = exact(root.expectedCoverage, ["awsOrganizationId", "accountsEvidenceId", "accountsObservedAt", "activeAccountIds", "expectedRegions"]);
  const expectedCoverage: AwsConfigExpectedCoverage = {
    awsOrganizationId: text(coverageInput.awsOrganizationId, ORGANIZATION_ID, 34),
    accountsEvidenceId: text(coverageInput.accountsEvidenceId, EVIDENCE_ID, 512),
    accountsObservedAt: timestamp(coverageInput.accountsObservedAt, Date.parse(completedAt)),
    activeAccountIds: sortedUniqueStrings(coverageInput.activeAccountIds, ACCOUNT_ID, AWS_CONFIG_COMPLIANCE_BOUNDS.maximumAccounts, 12),
    expectedRegions: sortedUniqueStrings(coverageInput.expectedRegions, REGION, AWS_CONFIG_COMPLIANCE_BOUNDS.maximumRegions, 32),
  };
  if (expectedCoverage.activeAccountIds.length === 0 || expectedCoverage.expectedRegions.length === 0
    || expectedCoverage.activeAccountIds.length * expectedCoverage.expectedRegions.length > AWS_CONFIG_COMPLIANCE_BOUNDS.maximumAccountRegions) reject("LIMIT_EXCEEDED");
  const accountSet = new Set(expectedCoverage.activeAccountIds);
  const regionSet = new Set(expectedCoverage.expectedRegions);
  const assertAccountRegion = (accountId: string, region: string): void => {
    if (!accountSet.has(accountId) || !regionSet.has(region)) reject("SCOPE_MISMATCH");
  };

  const aggregatorValue = root.aggregator === null ? null : aggregator(root.aggregator, trustedScope, Date.parse(completedAt));
  if (aggregatorValue?.sourceType === "ORGANIZATION" && aggregatorValue.awsOrganizationId !== expectedCoverage.awsOrganizationId) reject("SCOPE_MISMATCH");
  if (aggregatorValue !== null && !aggregatorValue.allAwsRegions && expectedCoverage.expectedRegions.some((item) => !aggregatorValue.configuredRegions.includes(item))) reject("SCOPE_MISMATCH");

  if (!Array.isArray(root.operationCoverage) || root.operationCoverage.length > AWS_CONFIG_COMPLIANCE_BOUNDS.maximumOperationCoverageRows) reject("LIMIT_EXCEEDED");
  const operations = new Map<string, AwsConfigOperationCoverage>();
  for (const entry of root.operationCoverage) {
    const parsed = operationCoverage(entry);
    if (parsed.accountId !== null && parsed.region !== null) assertAccountRegion(parsed.accountId, parsed.region);
    stableAdd(operations, `${parsed.operation}|${parsed.accountId ?? "-"}|${parsed.region ?? "-"}`, parsed);
  }

  const parseList = <T>(input: unknown, maximum: number, parser: (item: unknown) => T): readonly T[] => {
    if (!Array.isArray(input) || input.length > maximum) reject("LIMIT_EXCEEDED");
    return input.map(parser);
  };

  const sourceStatusesMap = new Map<string, AwsConfigAggregatorSourceStatus>();
  for (const item of parseList(root.sourceStatuses, AWS_CONFIG_COMPLIANCE_BOUNDS.maximumAccountRegions, (entry) => sourceStatus(entry, Date.parse(completedAt)))) {
    if (item.accountId !== null) assertAccountRegion(item.accountId, item.region);
    else if (!regionSet.has(item.region)) reject("SCOPE_MISMATCH");
    if (item.sourceType === "ORGANIZATION" && item.sourceId !== expectedCoverage.awsOrganizationId) reject("SCOPE_MISMATCH");
    if (item.sourceType === "ORGANIZATION" && item.accountId !== null) reject("SCOPE_MISMATCH");
    if (item.sourceType === "ACCOUNT" && (item.accountId === null || item.sourceId !== item.accountId)) reject("SCOPE_MISMATCH");
    stableAdd(sourceStatusesMap, `${item.sourceType}|${item.sourceId}|${item.region}`, item);
  }

  const recorderMap = new Map<string, AwsConfigRecorderCoverageRecord>();
  for (const item of parseList(root.recorders, AWS_CONFIG_COMPLIANCE_BOUNDS.maximumAccountRegions, (entry) => recorderCoverage(entry, Date.parse(completedAt)))) {
    assertAccountRegion(item.accountId, item.region);
    stableAdd(recorderMap, `${item.accountId}|${item.region}|${item.recorderName}`, item);
  }

  const ruleMap = new Map<string, AwsConfigRuleInventoryRecord>();
  for (const item of parseList(root.rules, AWS_CONFIG_COMPLIANCE_BOUNDS.maximumRules, (entry) => rule(entry, trustedScope, Date.parse(completedAt)))) {
    assertAccountRegion(item.accountId, item.region);
    stableAdd(ruleMap, `${item.accountId}|${item.region}|${item.ruleName}`, item);
  }
  const complianceMap = new Map<string, AwsConfigRuleComplianceRecord>();
  for (const item of parseList(root.ruleCompliance, AWS_CONFIG_COMPLIANCE_BOUNDS.maximumRules, ruleCompliance)) {
    assertAccountRegion(item.accountId, item.region);
    const key = `${item.accountId}|${item.region}|${item.ruleName}`;
    if (!ruleMap.has(key)) reject("INCOMPLETE_EVIDENCE");
    stableAdd(complianceMap, key, item);
  }
  const evaluationMap = new Map<string, AwsConfigEvaluationRecord>();
  for (const item of parseList(root.evaluations, AWS_CONFIG_COMPLIANCE_BOUNDS.maximumEvaluations, (entry) => evaluation(entry, Date.parse(completedAt)))) {
    assertAccountRegion(item.accountId, item.region);
    const ruleKey = `${item.accountId}|${item.region}|${item.ruleName}`;
    if (!ruleMap.has(ruleKey)) reject("INCOMPLETE_EVIDENCE");
    stableAdd(evaluationMap, `${ruleKey}|${item.resourceType}|${item.resourceId}|${item.evaluationMode}`, item);
  }
  for (const [key, item] of complianceMap) {
    const details = [...evaluationMap.values()].filter((entry) => `${entry.accountId}|${entry.region}|${entry.ruleName}` === key && entry.complianceType === item.complianceType);
    if (!item.contributorCountCapped && details.length !== item.contributorCount) reject("INCOMPLETE_EVIDENCE");
    if (item.contributorCountCapped && details.length < item.contributorCount) reject("INCOMPLETE_EVIDENCE");
  }

  const packsMap = new Map<string, AwsConfigConformancePackComplianceRecord>();
  for (const item of parseList(root.conformancePacks, AWS_CONFIG_COMPLIANCE_BOUNDS.maximumConformancePacks, conformancePack)) {
    assertAccountRegion(item.accountId, item.region);
    stableAdd(packsMap, `${item.accountId}|${item.region}|${item.packName}`, item);
  }
  const resourceCountsMap = new Map<string, AwsConfigResourceCountRecord>();
  for (const item of parseList(root.resourceCounts, AWS_CONFIG_COMPLIANCE_BOUNDS.maximumResourceCounts, resourceCount)) {
    assertAccountRegion(item.accountId, item.region);
    stableAdd(resourceCountsMap, `${item.accountId}|${item.region}|${item.resourceType}`, item);
  }
  if (root.inventoryQuery !== AWS_CONFIG_AGGREGATE_INVENTORY_QUERY) reject("SENSITIVE_DATA_REJECTED");
  const inventoryMap = new Map<string, AwsConfigResourceInventoryRecord>();
  for (const item of parseList(root.resourceInventory, AWS_CONFIG_COMPLIANCE_BOUNDS.maximumInventoryRecords, (entry) => inventory(entry, Date.parse(completedAt)))) {
    assertAccountRegion(item.accountId, item.region);
    stableAdd(inventoryMap, `${item.accountId}|${item.region}|${item.resourceType}|${item.resourceId}`, item);
  }

  let activityValue: AwsConfigActivityEvidence | null = null;
  if (root.activity !== null) {
    const input = exact(root.activity, ["source", "configured", "exhausted", "dataThroughAt", "prefixEvidenceId", "rows"]);
    if (input.source !== "AWS_CONFIG_S3_DELIVERY" || typeof input.configured !== "boolean" || typeof input.exhausted !== "boolean") reject("INVALID_INPUT");
    const dataThroughAt = input.dataThroughAt === null ? null : timestamp(input.dataThroughAt, Date.parse(completedAt));
    const prefixEvidenceId = input.prefixEvidenceId === null ? null : text(input.prefixEvidenceId, EVIDENCE_ID, 512);
    const rowMap = new Map<string, AwsConfigActivityRecord>();
    for (const item of parseList(input.rows, AWS_CONFIG_COMPLIANCE_BOUNDS.maximumActivityRows, activity)) {
      assertAccountRegion(item.accountId, item.region);
      if (dataThroughAt !== null && item.day > dataThroughAt.slice(0, 10)) reject("INVALID_INPUT");
      stableAdd(rowMap, `${item.day}|${item.accountId}|${item.region}|${item.ruleName ?? "-"}|${item.evidenceId}`, item);
    }
    const rows = [...rowMap.values()].sort((a, b) => a.day.localeCompare(b.day) || a.accountId.localeCompare(b.accountId) || a.region.localeCompare(b.region) || (a.ruleName ?? "").localeCompare(b.ruleName ?? ""));
    if (input.configured === false && (rows.length > 0 || dataThroughAt !== null || prefixEvidenceId !== null)) reject("INVALID_INPUT");
    if (input.configured === true && (dataThroughAt === null || prefixEvidenceId === null)) reject("INCOMPLETE_EVIDENCE");
    activityValue = { source: "AWS_CONFIG_S3_DELIVERY", configured: input.configured, exhausted: input.exhausted, dataThroughAt, prefixEvidenceId, rows };
  }

  let cur2Value: AwsConfigCur2Evidence | null = null;
  if (root.cur2 !== null) {
    const input = exact(root.cur2, ["source", "generationId", "sourceEvidenceId", "dataThroughAt", "reconciliationState", "predicate", "rows"]);
    if (input.source !== "AWS_CUR2_ACTIVE_GENERATION" || input.predicate !== "CUR2_PRODUCT_CODE_AWSCONFIG") reject("INVALID_INPUT");
    const dataThroughAt = timestamp(input.dataThroughAt, Date.parse(completedAt));
    const rowMap = new Map<string, AwsConfigCur2CostRecord>();
    for (const item of parseList(input.rows, AWS_CONFIG_COMPLIANCE_BOUNDS.maximumCostRows, cost)) {
      assertAccountRegion(item.accountId, item.region);
      if (item.billingPeriod > dataThroughAt.slice(0, 7)) reject("INVALID_INPUT");
      stableAdd(rowMap, `${item.billingPeriod}|${item.accountId}|${item.region}|${item.usageType}|${item.operation}|${item.currency}`, item);
    }
    const rows = [...rowMap.values()].sort((a, b) => a.billingPeriod.localeCompare(b.billingPeriod) || a.accountId.localeCompare(b.accountId) || a.region.localeCompare(b.region) || a.usageType.localeCompare(b.usageType) || a.operation.localeCompare(b.operation) || a.currency.localeCompare(b.currency));
    cur2Value = {
      source: "AWS_CUR2_ACTIVE_GENERATION", generationId: text(input.generationId, EVIDENCE_ID, 512),
      sourceEvidenceId: text(input.sourceEvidenceId, EVIDENCE_ID, 512), dataThroughAt,
      reconciliationState: choice(input.reconciliationState, ["reconciled", "partial", "failed"] as const),
      predicate: "CUR2_PRODUCT_CODE_AWSCONFIG", rows,
    };
  }

  const expectedPairs = expectedCoverage.activeAccountIds.flatMap((accountId) => expectedCoverage.expectedRegions.map((region) => `${accountId}|${region}`));
  const successfulOrganizationRegions = new Set([...sourceStatusesMap.values()].filter((item) => item.sourceType === "ORGANIZATION" && item.status === "SUCCEEDED").map((item) => item.region));
  const successfulAccountPairs = new Set([...sourceStatusesMap.values()].filter((item) => item.sourceType === "ACCOUNT" && item.status === "SUCCEEDED" && item.accountId !== null).map((item) => `${item.accountId}|${item.region}`));
  const synchronizedPairs = new Set(expectedPairs.filter((pair) => {
    const [, region] = pair.split("|") as [string, string];
    return successfulOrganizationRegions.has(region) || successfulAccountPairs.has(pair);
  }));
  const recordingPairs = new Set(expectedPairs.filter((pair) => {
    const [accountId, region] = pair.split("|") as [string, string];
    const definition = operations.get(`config:DescribeConfigurationRecorders|${accountId}|${region}`);
    const status = operations.get(`config:DescribeConfigurationRecorderStatus|${accountId}|${region}`);
    const observed = [...recorderMap.values()].filter((item) =>
      item.accountId === accountId && item.region === region && item.recorderType === "CUSTOMER_MANAGED");
    return definition?.state === "SUCCEEDED" && definition.exhausted
      && status?.state === "SUCCEEDED" && status.exhausted
      && observed.some((item) => item.recording && item.lastStatus !== "FAILURE" && item.recordAllSupported);
  }));
  const lifecyclePairs = new Set<string>();
  for (const pair of expectedPairs) {
    const [accountId, region] = pair.split("|") as [string, string];
    const definition = operations.get(`config:DescribeConfigRules|${accountId}|${region}`);
    const status = operations.get(`config:DescribeConfigRuleEvaluationStatus|${accountId}|${region}`);
    if (definition?.state === "SUCCEEDED" && definition.exhausted && status?.state === "SUCCEEDED" && status.exhausted) lifecyclePairs.add(pair);
  }
  const missingAccountRegions = expectedPairs.filter((pair) => !synchronizedPairs.has(pair) || !recordingPairs.has(pair) || !lifecyclePairs.has(pair));
  const organizationCoverageStatus = synchronizedPairs.size === 0 && recordingPairs.size === 0 && lifecyclePairs.size === 0 ? "NONE" : missingAccountRegions.length === 0 ? "COMPLETE" : "PARTIAL";

  const configurationReady = prerequisites.serviceConfigured === true && prerequisites.aggregatorValidated === true
    && prerequisites.readPermissionsValidated === true && prerequisites.organizationsAllFeaturesEnabled === true
    && aggregatorValue !== null;
  const centralCoverage = requiredCentralOperations().map((operation) => operations.get(`${operation}|-|-`));
  const centralFailed = centralCoverage.some((item) => item !== undefined && item.state !== "SUCCEEDED");
  const centralComplete = centralCoverage.every((item) => item?.state === "SUCCEEDED" && item.exhausted);
  const aggregatorAge = ageHours(completedAt, nowMs);
  const aggregatorStale = aggregatorAge > AWS_CONFIG_COMPLIANCE_BOUNDS.sourceFreshnessSlaHours;

  let aggregatorChannel: AwsConfigComplianceSnapshot["channelStates"]["aggregatorCompliance"];
  if (!configurationReady) aggregatorChannel = "CONFIGURATION_REQUIRED";
  else if (centralFailed && ruleMap.size === 0) aggregatorChannel = "FAILED";
  else if (!centralComplete || organizationCoverageStatus !== "COMPLETE" || [...complianceMap.values()].some((item) => item.contributorCountCapped)) aggregatorChannel = "PARTIAL";
  else if (aggregatorStale) aggregatorChannel = "STALE";
  else if (ruleMap.size === 0) aggregatorChannel = "EMPTY";
  else aggregatorChannel = "READY";

  let lifecycleChannel: AwsConfigComplianceSnapshot["channelStates"]["ruleLifecycle"];
  if (!configurationReady) lifecycleChannel = "CONFIGURATION_REQUIRED";
  else if (lifecyclePairs.size === 0 && expectedPairs.length > 0) lifecycleChannel = "FAILED";
  else if (lifecyclePairs.size !== expectedPairs.length) lifecycleChannel = "PARTIAL";
  else if (aggregatorStale) lifecycleChannel = "STALE";
  else if (ruleMap.size === 0) lifecycleChannel = "EMPTY";
  else lifecycleChannel = "READY";

  let activityChannel: AwsConfigComplianceSnapshot["channelStates"]["configurationActivity"];
  const activityAge = activityValue?.dataThroughAt === null || activityValue === null ? null : ageHours(activityValue.dataThroughAt, nowMs);
  if (activityValue === null || !activityValue.configured) activityChannel = "CONFIGURATION_REQUIRED";
  else if (!activityValue.exhausted) activityChannel = "PARTIAL";
  else if (activityAge !== null && activityAge > AWS_CONFIG_COMPLIANCE_BOUNDS.activityFreshnessSlaHours) activityChannel = "STALE";
  else if (activityValue.rows.length === 0) activityChannel = "EMPTY";
  else activityChannel = "READY";

  let costChannel: AwsConfigComplianceSnapshot["channelStates"]["actualCost"];
  const cur2Age = cur2Value === null ? null : ageHours(cur2Value.dataThroughAt, nowMs);
  if (cur2Value === null) costChannel = "CONFIGURATION_REQUIRED";
  else if (cur2Value.reconciliationState !== "reconciled") costChannel = "PARTIAL";
  else if (cur2Age !== null && cur2Age > AWS_CONFIG_COMPLIANCE_BOUNDS.cur2FreshnessSlaHours) costChannel = "STALE";
  else if (cur2Value.rows.length === 0) costChannel = "EMPTY";
  else costChannel = "READY";

  const evaluationGroups = new Map<string, AwsConfigEvaluationRecord[]>();
  for (const item of evaluationMap.values()) {
    const key = `${item.accountId}|${item.region}|${item.ruleName}`;
    const values = evaluationGroups.get(key) ?? [];
    values.push(item);
    evaluationGroups.set(key, values);
  }
  const duplicateCounts = new Map<string, number>();
  for (const item of ruleMap.values()) {
    const signature = `${item.owner}|${item.sourceIdentifierSha256}|${item.scopeFingerprintSha256}|${item.evaluationModes.join(",")}|${item.triggerTypes.join(",")}`;
    duplicateCounts.set(signature, (duplicateCounts.get(signature) ?? 0) + 1);
  }
  const rules: AwsConfigRuleView[] = [...ruleMap].map(([key, item]): AwsConfigRuleView => {
    const result = complianceMap.get(key);
    const evaluations = evaluationGroups.get(key) ?? [];
    const signature = `${item.owner}|${item.sourceIdentifierSha256}|${item.scopeFingerprintSha256}|${item.evaluationModes.join(",")}|${item.triggerTypes.join(",")}`;
    let lifecycle: AwsConfigRuleView["lifecycle"] = item.state;
    if (item.lastErrorCode !== null && (item.lastSuccessfulEvaluationAt === null || (item.lastFailedEvaluationAt !== null && item.lastFailedEvaluationAt > item.lastSuccessfulEvaluationAt))) lifecycle = "EVALUATION_ERROR";
    else if (item.state === "ACTIVE" && item.lastSuccessfulEvaluationAt === null && item.lastFailedEvaluationAt === null) lifecycle = "NEVER_EVALUATED";
    return {
      ...item, complianceType: result === undefined ? "NO_RESULTS" : result.complianceType,
      contributorCount: result?.contributorCount ?? null, contributorCountCapped: result?.contributorCountCapped ?? false,
      currentEvaluationCount: evaluations.length,
      nonCompliantEvaluationCount: evaluations.filter((entry) => entry.complianceType === "NON_COMPLIANT").length,
      lifecycle, duplicateSignatureCount: duplicateCounts.get(signature) ?? 1,
    };
  }).sort((a, b) => a.accountId.localeCompare(b.accountId) || a.region.localeCompare(b.region) || a.ruleName.localeCompare(b.ruleName));

  const activityRows = activityValue?.rows ?? [];
  const totalActivity = activityRows.reduce((acc, item) => ({
    configurationItemChanges: acc.configurationItemChanges + BigInt(item.configurationItemChanges),
    ruleEvaluations: acc.ruleEvaluations + BigInt(item.ruleEvaluations),
  }), { configurationItemChanges: BigInt(0), ruleEvaluations: BigInt(0) });
  const costGroups = new Map<string, { billed: bigint; amortized: bigint; complete: boolean; rows: number }>();
  for (const item of cur2Value?.rows ?? []) {
    const group = costGroups.get(item.currency) ?? { billed: BigInt(0), amortized: BigInt(0), complete: true, rows: 0 };
    group.billed += BigInt(item.billedCostMicros);
    if (item.amortizedCostMicros === null) group.complete = false;
    else group.amortized += BigInt(item.amortizedCostMicros);
    group.rows += 1;
    costGroups.set(item.currency, group);
  }
  const actualCosts: AwsConfigCostSummary[] = [...costGroups].sort(([a], [b]) => a.localeCompare(b)).map(([currency, item]) => ({ currency, billedCostMicros: item.billed.toString(), amortizedCostMicros: item.complete ? item.amortized.toString() : null, rowCount: item.rows }));
  const discoveredResources = [...resourceCountsMap.values()].reduce((sum, item) => sum + BigInt(item.resourceCount), BigInt(0)).toString();
  const limitations = [
    "Current aggregate evaluation results are current compliance evidence, not a billable AWS Config rule-evaluation count.",
    "Actual AWS Config spend is shown only from reconciled CUR2 rows and is never allocated to individual rules without provider-backed allocation evidence.",
    "AWS Config aggregators are read-only replicated views; they do not prove that missing rules or resources are compliant.",
    "Raw configuration documents, tags, annotations, source identifiers, provider messages, and S3 object keys are excluded from this broker schema.",
  ];
  if (!configurationReady) limitations.push("AWS Config, the selected aggregator, Organizations all-features mode, and exact read permissions are not fully validated.");
  if (organizationCoverageStatus !== "COMPLETE") limitations.push("The expected active-account and Region matrix is not fully synchronized and lifecycle-collected.");
  if (!centralComplete) limitations.push("One or more required central API operations failed or stopped before pagination was exhausted.");
  if ([...complianceMap.values()].some((item) => item.contributorCountCapped)) limitations.push("At least one provider contributor count is capped; exact resource coverage is not claimed.");
  if (activityChannel === "CONFIGURATION_REQUIRED") limitations.push("Configuration-item change and historical rule-evaluation activity requires an exact-prefix AWS Config S3 delivery source.");
  if (costChannel === "CONFIGURATION_REQUIRED") limitations.push("Actual AWS Config cost requires the active, reconciled CUR2 generation.");
  if (aggregatorStale) limitations.push("The AWS Config aggregator capture is stale.");

  const states = [aggregatorChannel, lifecycleChannel, activityChannel, costChannel];
  let state: AwsConfigComplianceState;
  if (!configurationReady) state = "CONFIGURATION_REQUIRED";
  else if (aggregatorChannel === "FAILED" || lifecycleChannel === "FAILED") state = "FAILED";
  else if (states.includes("PARTIAL") || states.includes("CONFIGURATION_REQUIRED")) state = "PARTIAL";
  else if (states.includes("STALE")) state = "STALE";
  else if (states.every((item) => item === "EMPTY")) state = "EMPTY";
  else state = "READY";

  const snapshot: AwsConfigComplianceSnapshot = {
    schemaVersion: "sutra.aws-config-compliance.snapshot.v1", scope: trustedScope,
    captureId: root.captureId, capturedAt: completedAt, state,
    channelStates: { aggregatorCompliance: aggregatorChannel, ruleLifecycle: lifecycleChannel, configurationActivity: activityChannel, actualCost: costChannel },
    organizationCoverage: {
      status: organizationCoverageStatus, expectedAccountCount: expectedCoverage.activeAccountIds.length,
      expectedRegionCount: expectedCoverage.expectedRegions.length, expectedAccountRegionCount: expectedPairs.length,
      synchronizedAccountRegionCount: synchronizedPairs.size, ruleInventoryAccountRegionCount: lifecyclePairs.size,
      recordingAccountRegionCount: recordingPairs.size,
      missingAccountRegions,
    },
    freshness: { aggregatorAgeHours: aggregatorAge, activityAgeHours: activityAge, cur2AgeHours: cur2Age },
    rules, evaluations: [...evaluationMap.values()].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)),
    conformancePacks: [...packsMap.values()].sort((a, b) => a.accountId.localeCompare(b.accountId) || a.region.localeCompare(b.region) || a.packName.localeCompare(b.packName)),
    resourceCounts: [...resourceCountsMap.values()].sort((a, b) => a.accountId.localeCompare(b.accountId) || a.region.localeCompare(b.region) || a.resourceType.localeCompare(b.resourceType)),
    resourceInventory: [...inventoryMap.values()].sort((a, b) => a.accountId.localeCompare(b.accountId) || a.region.localeCompare(b.region) || a.resourceType.localeCompare(b.resourceType) || a.resourceId.localeCompare(b.resourceId)),
    activity: { configurationItemChanges: totalActivity.configurationItemChanges.toString(), ruleEvaluations: totalActivity.ruleEvaluations.toString(), rows: activityRows },
    actualCosts,
    counts: {
      rules: rules.length, compliantRules: rules.filter((item) => item.complianceType === "COMPLIANT").length,
      nonCompliantRules: rules.filter((item) => item.complianceType === "NON_COMPLIANT").length,
      rulesWithoutResults: rules.filter((item) => item.complianceType === "NO_RESULTS").length,
      rulesWithEvaluationErrors: rules.filter((item) => item.lifecycle === "EVALUATION_ERROR").length,
      duplicateRuleDeployments: rules.filter((item) => item.duplicateSignatureCount > 1).length,
      currentEvaluations: evaluationMap.size,
      nonCompliantResources: evaluationMap.size === 0 ? 0 : new Set([...evaluationMap.values()].filter((item) => item.complianceType === "NON_COMPLIANT").map((item) => `${item.accountId}|${item.region}|${item.resourceType}|${item.resourceId}`)).size,
      conformancePacks: packsMap.size,
      insufficientDataPacks: [...packsMap.values()].filter((item) => item.complianceType === "INSUFFICIENT_DATA").length,
      discoveredResources,
    },
    limitations,
  };
  if (jsonBytes(snapshot) > AWS_CONFIG_COMPLIANCE_BOUNDS.maximumDashboardBytes) reject("LIMIT_EXCEEDED");
  return snapshot;
}

export function awsConfigComplianceSourceEvidence(snapshot: AwsConfigComplianceSnapshot): FinopsSourceEvidence {
  const acceptedRecords = snapshot.rules.length + snapshot.evaluations.length + snapshot.conformancePacks.length + snapshot.resourceCounts.length + snapshot.resourceInventory.length;
  const complete = snapshot.organizationCoverage.status === "COMPLETE"
    && snapshot.channelStates.aggregatorCompliance !== "PARTIAL"
    && snapshot.channelStates.aggregatorCompliance !== "FAILED"
    && snapshot.channelStates.aggregatorCompliance !== "CONFIGURATION_REQUIRED"
    && snapshot.channelStates.ruleLifecycle !== "PARTIAL"
    && snapshot.channelStates.ruleLifecycle !== "FAILED"
    && snapshot.channelStates.ruleLifecycle !== "CONFIGURATION_REQUIRED";
  return {
    scope: snapshot.scope, sourceId: "aws_config_organization_aggregator",
    configured: snapshot.state !== "CONFIGURATION_REQUIRED", deliveryObserved: true,
    lastAttemptAt: snapshot.capturedAt,
    lastAttemptOutcome: snapshot.state === "FAILED" ? "failed" : complete ? "succeeded" : "partial",
    lastSuccessAt: complete ? snapshot.capturedAt : null, dataThroughAt: snapshot.capturedAt,
    coverage: { assessment: complete ? "complete" : "partial", acceptedRecords, expectedRecords: complete ? acceptedRecords : null, rejectedRecords: 0 },
    lastError: null,
    evidenceBasis: `Tenant-pinned AWS Config aggregator capture ${snapshot.captureId}; exact account/Region coverage and account-local rule lifecycle are retained separately.`,
    limitations: snapshot.limitations,
  };
}

export interface AwsConfigComplianceBrokerRequest {
  readonly schemaVersion: "sutra.aws-config-compliance-query.v1";
  readonly scope: AwsConfigComplianceScope;
  readonly aggregatorOperations: typeof AWS_CONFIG_AGGREGATOR_READ_OPERATIONS;
  readonly lifecycleOperations: typeof AWS_CONFIG_RULE_LIFECYCLE_READ_OPERATIONS;
  readonly recorderOperations: typeof AWS_CONFIG_RECORDER_COVERAGE_READ_OPERATIONS;
  readonly organizationOperations: typeof AWS_CONFIG_ORGANIZATION_READ_OPERATIONS;
  readonly inventoryQuery: typeof AWS_CONFIG_AGGREGATE_INVENTORY_QUERY;
  readonly bounds: typeof AWS_CONFIG_COMPLIANCE_BOUNDS;
}

export interface AwsConfigComplianceTransport {
  readonly collect: (request: AwsConfigComplianceBrokerRequest) => Promise<AwsConfigComplianceCapture>;
}

export class AwsConfigComplianceQueryError extends Error {
  readonly code: "SOURCE_UNAVAILABLE" | "INVALID_EVIDENCE";
  constructor(code: "SOURCE_UNAVAILABLE" | "INVALID_EVIDENCE") {
    super("AWS Config compliance evidence is unavailable.");
    this.name = "AwsConfigComplianceQueryError";
    this.code = code;
  }
}

export function createAwsConfigComplianceQueryService(
  configuredScope: AwsConfigComplianceScope,
  transport: AwsConfigComplianceTransport,
  now: () => number = Date.now,
): { readonly query: () => Promise<AwsConfigComplianceSnapshot> } {
  const trustedScope = parsedScope(configuredScope);
  return {
    async query(): Promise<AwsConfigComplianceSnapshot> {
      let capture: AwsConfigComplianceCapture;
      try {
        capture = await transport.collect({
          schemaVersion: "sutra.aws-config-compliance-query.v1", scope: trustedScope,
          aggregatorOperations: AWS_CONFIG_AGGREGATOR_READ_OPERATIONS,
          lifecycleOperations: AWS_CONFIG_RULE_LIFECYCLE_READ_OPERATIONS,
          recorderOperations: AWS_CONFIG_RECORDER_COVERAGE_READ_OPERATIONS,
          organizationOperations: AWS_CONFIG_ORGANIZATION_READ_OPERATIONS,
          inventoryQuery: AWS_CONFIG_AGGREGATE_INVENTORY_QUERY,
          bounds: AWS_CONFIG_COMPLIANCE_BOUNDS,
        });
      } catch {
        throw new AwsConfigComplianceQueryError("SOURCE_UNAVAILABLE");
      }
      try {
        return normalizeAwsConfigComplianceCapture(capture, trustedScope, now());
      } catch {
        throw new AwsConfigComplianceQueryError("INVALID_EVIDENCE");
      }
    },
  };
}
