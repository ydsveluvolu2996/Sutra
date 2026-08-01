/**
 * Evidence-honest AWS Graviton savings projection.
 *
 * This module is a pure tenant trust boundary: it accepts no credentials,
 * performs no I/O, retains no process-global tenant state, and never infers
 * Arm compatibility from an instance-family name. An opportunity is modeled
 * only when an explicit AWS Compute Optimizer AWS_ARM64 recommendation is
 * joined by canonical CUR2 usage, versioned AWS pricing and instance metadata,
 * and affirmative evidence for every compatibility dimension.
 */
import type { FinopsSourceScope } from "./finops-source-health.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const ARN = /^arn:(aws|aws-us-gov|aws-cn):[a-z0-9-]+:[a-z0-9-]+:\d{12}:.+$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,95}$/u;
const MONEY_MICROS = /^(?:0|[1-9]\d{0,20})$/u;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const MICROS = BigInt(1_000_000);
const ZERO = BigInt(0);
const TWO = BigInt(2);

export const GRAVITON_SAVINGS_BOUNDS = Object.freeze({
  maximumCaptureBytes: 32 * 1_024 * 1_024,
  maximumResponseBytes: 8 * 1_024 * 1_024,
  maximumDurationMs: 15 * 60 * 1_000,
  maximumAccounts: 1_000,
  maximumRegions: 50,
  maximumRecommendations: 100_000,
  maximumInventoryObservations: 100_000,
  maximumMetadataRecords: 20_000,
  maximumCompatibilityRecords: 500_000,
  maximumCostRecords: 250_000,
  maximumPricingRecords: 50_000,
  maximumRealizationRecords: 100_000,
  maximumHistoryPerResource: 24,
  maximumHistoryAgeDays: 400,
  maximumOpportunitiesInResponse: 5_000,
  maximumEvidencePerRecord: 12,
  maximumTextLength: 512,
} as const);

export const GRAVITON_SAVINGS_READ_OPERATIONS = Object.freeze([
  "compute-optimizer:GetEC2InstanceRecommendations",
  "compute-optimizer:GetAutoScalingGroupRecommendations",
  "compute-optimizer:GetRDSDatabaseRecommendations",
  "ec2:DescribeInstances",
  "ec2:DescribeImages",
  "ec2:DescribeInstanceTypes",
  "autoscaling:DescribeAutoScalingGroups",
  "rds:DescribeDBInstances",
  "rds:DescribeDBClusters",
  "opensearch:ListDomainNames",
  "opensearch:DescribeDomain",
  "elasticache:DescribeCacheClusters",
  "elasticache:DescribeReplicationGroups",
  "pricing:ListPriceLists",
  "pricing:GetPriceListFileUrl",
] as const);

export type GravitonResourceType =
  | "EC2_INSTANCE"
  | "AUTO_SCALING_GROUP"
  | "RDS_DB_INSTANCE"
  | "AURORA_DB_INSTANCE"
  | "OPENSEARCH_DOMAIN"
  | "ELASTICACHE_REPLICATION_GROUP";
export type GravitonCompatibilityDimension =
  | "ARCHITECTURE"
  | "OS_AMI"
  | "LICENSING"
  | "WORKLOAD"
  | "SERVICE_FEATURE";
export type GravitonCompatibilityStatus =
  | "COMPATIBLE"
  | "INCOMPATIBLE"
  | "REVIEW_REQUIRED";
export type GravitonOpportunityState =
  | "READY"
  | "REVIEW_REQUIRED"
  | "BLOCKED"
  | "CONFIGURATION_REQUIRED";
export type GravitonSnapshotState =
  | "COMPLETE"
  | "PARTIAL"
  | "CONFIGURATION_REQUIRED";
export type GravitonFailureCode =
  | "INVALID_INPUT"
  | "SCOPE_MISMATCH"
  | "CONFLICTING_DUPLICATE"
  | "RECORD_LIMIT_EXCEEDED"
  | "HISTORY_LIMIT_EXCEEDED"
  | "BYTE_LIMIT_EXCEEDED"
  | "TIME_LIMIT_EXCEEDED"
  | "OUTPUT_LIMIT_EXCEEDED";

export interface GravitonTenantBoundary {
  readonly scope: FinopsSourceScope;
  readonly managementAccountId: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly accountIds: readonly string[];
  readonly regions: readonly string[];
}

export interface GravitonEvidenceReference {
  readonly id: string;
  readonly kind:
    | "AWS_API"
    | "AWS_DOCUMENTATION"
    | "AWS_INSTANCE_METADATA"
    | "AWS_PRICING"
    | "CUR2_DATA_EXPORT"
    | "WORKLOAD_ATTESTATION"
    | "LICENSE_ATTESTATION";
  readonly operation: string;
  readonly url: string;
  readonly retrievedAt: string;
  readonly effectiveAt: string;
  readonly sha256: string;
}

interface ScopedResource {
  readonly accountId: string;
  readonly region: string;
  readonly resourceType: GravitonResourceType;
  readonly resourceArn: string;
  readonly resourceId: string;
}

export interface GravitonComputeOptimizerRecommendation extends ScopedResource {
  readonly recommendationId: string;
  /** Optional only for backward-compatible Compute Optimizer captures. */
  readonly recommendationAuthority?:
    | "AWS_COMPUTE_OPTIMIZER"
    | "AWS_SERVICE_INVENTORY_PRICING";
  readonly refreshedAt: string;
  readonly lookbackPeriodDays: number;
  readonly currentConfiguration: string;
  readonly targetConfiguration: string;
  /** Must be explicit in the provider request/response evidence. */
  readonly cpuVendorArchitecture: "AWS_ARM64";
  readonly migrationEffort: "VERY_LOW" | "LOW" | "MEDIUM" | "HIGH";
  readonly performanceRiskBasisPoints: number | null;
  readonly estimatedMonthlySavingsMicros: string | null;
  readonly estimatedSavingsCurrency: string | null;
  readonly inventoryObservationId: string;
  readonly targetMetadataId: string;
  readonly compatibilityEvidenceIds: readonly string[];
  readonly baselineCostRecordId: string;
  readonly currentPriceId: string;
  readonly targetPriceId: string;
  readonly realizationId: string | null;
  readonly source: GravitonEvidenceReference;
}

export interface GravitonInventoryObservation extends ScopedResource {
  readonly observationId: string;
  readonly configuration: string;
  readonly architecture: "X86_64" | "ARM64" | "UNKNOWN";
  readonly operatingSystem: "LINUX" | "WINDOWS" | "MACOS" | "UNKNOWN";
  readonly imageId: string | null;
  readonly observedAt: string;
  readonly source: GravitonEvidenceReference;
}

export interface GravitonInstanceMetadata {
  readonly metadataId: string;
  readonly resourceType: GravitonResourceType;
  readonly region: string;
  readonly configuration: string;
  readonly architecture: "ARM64" | "X86_64";
  readonly vcpu: number;
  readonly memoryMiB: number;
  readonly effectiveFromAt: string;
  readonly effectiveToAt: string | null;
  readonly source: GravitonEvidenceReference;
}

export interface GravitonCompatibilityEvidence extends ScopedResource {
  readonly compatibilityId: string;
  readonly dimension: GravitonCompatibilityDimension;
  readonly status: GravitonCompatibilityStatus;
  /** Bounded, machine-safe reason; never raw provider or customer text. */
  readonly reasonCode: string;
  readonly assessedAt: string;
  readonly sources: readonly GravitonEvidenceReference[];
}

export interface GravitonCur2CostRecord extends ScopedResource {
  readonly costRecordId: string;
  readonly canonicalSchemaVersion: "sutra.cur2.canonical.v1";
  readonly generationId: string;
  readonly configuration: string;
  readonly architecture: "X86_64" | "ARM64";
  readonly periodStartAt: string;
  readonly periodEndAt: string;
  readonly usageUnit: "HOURS";
  /** Exact usage hours in millionths of an hour. */
  readonly usageQuantityMicros: string;
  readonly costBasis: "PUBLIC_ON_DEMAND_EQUIVALENT" | "OBSERVED_EFFECTIVE";
  readonly costMicros: string;
  readonly currency: string;
  readonly source: GravitonEvidenceReference;
}

export interface GravitonPricingRecord {
  readonly priceId: string;
  readonly resourceType: GravitonResourceType;
  readonly region: string;
  readonly configuration: string;
  readonly architecture: "X86_64" | "ARM64";
  readonly operatingSystem: string;
  readonly tenancy: string;
  readonly purchaseOption: "ON_DEMAND";
  readonly unit: "HRS";
  readonly currency: string;
  /** Exact public price in currency millionths per hour. */
  readonly unitPriceMicros: string;
  readonly priceListVersion: string;
  readonly productSku: string;
  readonly termCode: string;
  readonly dimensionCode: string;
  readonly effectiveFromAt: string;
  readonly effectiveToAt: string | null;
  readonly source: GravitonEvidenceReference;
}

export interface GravitonRealizationObservation extends ScopedResource {
  readonly realizationId: string;
  readonly migrationAt: string;
  readonly targetConfiguration: string;
  readonly targetInventoryObservationId: string;
  readonly baselineCostRecordId: string;
  readonly postMigrationCostRecordId: string;
  readonly comparableWorkloadEvidenceId: string;
  readonly source: GravitonEvidenceReference;
}

export interface GravitonSavingsCapture {
  readonly schemaVersion: "sutra.graviton-savings.capture.v1";
  readonly scope: FinopsSourceScope;
  readonly managementAccountId: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly accountIds: readonly string[];
  readonly regions: readonly string[];
  readonly collectionId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly recommendations: readonly GravitonComputeOptimizerRecommendation[];
  readonly inventory: readonly GravitonInventoryObservation[];
  readonly instanceMetadata: readonly GravitonInstanceMetadata[];
  readonly compatibility: readonly GravitonCompatibilityEvidence[];
  readonly costs: readonly GravitonCur2CostRecord[];
  readonly pricing: readonly GravitonPricingRecord[];
  readonly realizations: readonly GravitonRealizationObservation[];
}

export interface GravitonBlocker {
  readonly category:
    | "ARCHITECTURE"
    | "OS_AMI"
    | "LICENSING"
    | "WORKLOAD"
    | "SERVICE_FEATURE"
    | "EVIDENCE"
    | "ECONOMICS";
  readonly code: string;
}

export interface GravitonMoney {
  readonly amountMicros: string;
  readonly currency: string;
}

export interface GravitonPotentialSavings {
  readonly kind: "MODELED_POTENTIAL";
  readonly periodStartAt: string;
  readonly periodEndAt: string;
  readonly usageQuantityMicros: string;
  readonly currentModeledCost: GravitonMoney;
  readonly targetModeledCost: GravitonMoney;
  readonly savings: GravitonMoney;
  readonly currentUnitPriceMicros: string;
  readonly targetUnitPriceMicros: string;
  readonly pricingEffectiveAt: string;
  readonly assumptionCodes: readonly string[];
}

export interface GravitonProviderEstimate {
  readonly kind: "AWS_COMPUTE_OPTIMIZER_ESTIMATE";
  readonly period: "MONTH";
  readonly savings: GravitonMoney;
  readonly sourceId: string;
}

export interface GravitonRealizedSavings {
  readonly kind: "MEASURED_REALIZED";
  readonly baselinePeriodStartAt: string;
  readonly baselinePeriodEndAt: string;
  readonly measurementPeriodStartAt: string;
  readonly measurementPeriodEndAt: string;
  readonly baselineCost: GravitonMoney;
  readonly measuredCost: GravitonMoney;
  readonly observedSavings: GravitonMoney;
  readonly observedCostIncrease: GravitonMoney;
  readonly assumptionCodes: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface GravitonOpportunity extends ScopedResource {
  readonly recommendationId: string;
  readonly recommendationAuthority:
    | "AWS_COMPUTE_OPTIMIZER"
    | "AWS_SERVICE_INVENTORY_PRICING";
  readonly state: GravitonOpportunityState;
  readonly currentConfiguration: string;
  readonly targetConfiguration: string;
  readonly migrationEffort: GravitonComputeOptimizerRecommendation["migrationEffort"];
  readonly performanceRiskBasisPoints: number | null;
  readonly refreshedAt: string;
  readonly historyCount: number;
  readonly blockerReasons: readonly GravitonBlocker[];
  readonly providerEstimate: GravitonProviderEstimate | null;
  readonly potentialSavings: GravitonPotentialSavings | null;
  readonly realizedSavings: GravitonRealizedSavings | null;
  readonly evidenceIds: readonly string[];
}

export interface GravitonPeriodTotal {
  readonly periodStartAt: string;
  readonly periodEndAt: string;
  readonly currency: string;
  readonly amountMicros: string;
}

export interface GravitonUsagePeriod {
  readonly periodStartAt: string;
  readonly periodEndAt: string;
  readonly accountId: string;
  readonly region: string;
  readonly resourceType: GravitonResourceType;
  readonly configuration: string;
  readonly architecture: "X86_64" | "ARM64";
  readonly costBasis: GravitonCur2CostRecord["costBasis"];
  readonly currency: string;
  readonly usageQuantityMicros: string;
  readonly costMicros: string;
  readonly resourceCount: number;
}

export interface GravitonSavingsSnapshot {
  readonly schemaVersion: "sutra.graviton-savings.snapshot.v1";
  readonly scope: FinopsSourceScope;
  readonly collectionId: string;
  readonly generatedAt: string;
  readonly state: GravitonSnapshotState;
  readonly summary: {
    readonly resources: number;
    readonly ready: number;
    readonly reviewRequired: number;
    readonly blocked: number;
    readonly configurationRequired: number;
    readonly modeledPotentialByPeriod: readonly GravitonPeriodTotal[];
    readonly measuredRealizedByPeriod: readonly GravitonPeriodTotal[];
  };
  /** Canonical CUR2 usage only; ARM64 rows quantify existing Graviton usage. */
  readonly currentUsage: readonly GravitonUsagePeriod[];
  readonly opportunities: readonly GravitonOpportunity[];
}

export class GravitonSavingsError extends Error {
  readonly code: GravitonFailureCode;

  constructor(code: GravitonFailureCode) {
    super(code);
    this.name = "GravitonSavingsError";
    this.code = code;
  }
}

const PARTITIONS = new Set(["aws", "aws-us-gov", "aws-cn"]);
const RESOURCE_TYPES = new Set<GravitonResourceType>([
  "EC2_INSTANCE",
  "AUTO_SCALING_GROUP",
  "RDS_DB_INSTANCE",
  "AURORA_DB_INSTANCE",
  "OPENSEARCH_DOMAIN",
  "ELASTICACHE_REPLICATION_GROUP",
]);
const DIMENSIONS: readonly GravitonCompatibilityDimension[] = [
  "ARCHITECTURE",
  "OS_AMI",
  "LICENSING",
  "WORKLOAD",
  "SERVICE_FEATURE",
];
const DIMENSION_SET = new Set(DIMENSIONS);
const COMPATIBILITY_STATUSES = new Set<GravitonCompatibilityStatus>([
  "COMPATIBLE",
  "INCOMPATIBLE",
  "REVIEW_REQUIRED",
]);
const SOURCE_KINDS = new Set<GravitonEvidenceReference["kind"]>([
  "AWS_API",
  "AWS_DOCUMENTATION",
  "AWS_INSTANCE_METADATA",
  "AWS_PRICING",
  "CUR2_DATA_EXPORT",
  "WORKLOAD_ATTESTATION",
  "LICENSE_ATTESTATION",
]);
const ALLOWED_COMPATIBILITY_SOURCE_KINDS = Object.freeze({
  ARCHITECTURE: new Set(["AWS_API", "AWS_INSTANCE_METADATA"]),
  OS_AMI: new Set(["AWS_API", "AWS_DOCUMENTATION", "WORKLOAD_ATTESTATION"]),
  LICENSING: new Set(["AWS_DOCUMENTATION", "LICENSE_ATTESTATION"]),
  WORKLOAD: new Set(["AWS_DOCUMENTATION", "WORKLOAD_ATTESTATION"]),
  SERVICE_FEATURE: new Set([
    "AWS_API",
    "AWS_DOCUMENTATION",
    "WORKLOAD_ATTESTATION",
  ]),
} satisfies Readonly<Record<GravitonCompatibilityDimension, ReadonlySet<string>>>);

function reject(code: GravitonFailureCode): never {
  throw new GravitonSavingsError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) reject("INVALID_INPUT");
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    reject("INVALID_INPUT");
  }
  return value;
}

function text(value: unknown, maximum = 128): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) reject("INVALID_INPUT");
  return value;
}

function identifier(value: unknown): string {
  const result = text(value);
  if (!IDENTIFIER.test(result)) reject("INVALID_INPUT");
  return result;
}

function code(value: unknown): string {
  const result = text(value, 96);
  if (!SAFE_CODE.test(result)) reject("INVALID_INPUT");
  return result;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) reject("INVALID_INPUT");
  return value as number;
}

function moneyMicros(value: unknown): string {
  const result = text(value, 21);
  if (!MONEY_MICROS.test(result)) reject("INVALID_INPUT");
  return result;
}

function timestamp(value: unknown, maximumMs: number): string {
  const result = text(value, 40);
  const milliseconds = Date.parse(result);
  if (
    !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== result
    || milliseconds > maximumMs
  ) reject("INVALID_INPUT");
  return result;
}

function optionalTimestamp(value: unknown, maximumMs: number): string | null {
  return value === null ? null : timestamp(value, maximumMs);
}

function sortedStrings(
  value: unknown,
  maximum: number,
  validator: (entry: string) => boolean,
  minimum = 1,
): readonly string[] {
  if (
    !Array.isArray(value)
    || value.length < minimum
    || value.length > maximum
    || !value.every((entry) => typeof entry === "string" && validator(entry))
  ) reject("INVALID_INPUT");
  const result = [...new Set(value)].sort();
  if (
    result.length !== value.length
    || JSON.stringify(result) !== JSON.stringify(value)
  ) reject("INVALID_INPUT");
  return result;
}

function scope(value: unknown): FinopsSourceScope {
  const record = exactRecord(value, ["orgId", "customerId", "connectionId"]);
  const orgId = identifier(record.orgId);
  const customerId = identifier(record.customerId);
  const connectionId = text(record.connectionId, 37);
  if (!CONNECTION_ID.test(connectionId)) reject("INVALID_INPUT");
  return { orgId, customerId, connectionId };
}

function validateBoundary(value: unknown): asserts value is GravitonTenantBoundary {
  const record = exactRecord(value, [
    "scope",
    "managementAccountId",
    "partition",
    "accountIds",
    "regions",
  ]);
  scope(record.scope);
  const managementAccountId = text(record.managementAccountId, 12);
  const partition = text(record.partition);
  const accountIds = sortedStrings(
    record.accountIds,
    GRAVITON_SAVINGS_BOUNDS.maximumAccounts,
    (entry) => ACCOUNT_ID.test(entry),
  );
  sortedStrings(
    record.regions,
    GRAVITON_SAVINGS_BOUNDS.maximumRegions,
    (entry) => REGION.test(entry),
  );
  if (
    !ACCOUNT_ID.test(managementAccountId)
    || !PARTITIONS.has(partition)
    || !accountIds.includes(managementAccountId)
  ) reject("INVALID_INPUT");
}

function validEvidenceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && (
        url.hostname === "docs.aws.amazon.com"
        || url.hostname === "aws.amazon.com"
        || url.hostname.endsWith(".amazonaws.com")
      );
  } catch {
    return false;
  }
}

function evidenceReference(
  value: unknown,
  completedAtMs: number,
): GravitonEvidenceReference {
  const record = exactRecord(value, [
    "id",
    "kind",
    "operation",
    "url",
    "retrievedAt",
    "effectiveAt",
    "sha256",
  ]);
  const id = identifier(record.id);
  const kind = text(record.kind) as GravitonEvidenceReference["kind"];
  const operation = text(record.operation, 256);
  const url = text(record.url, 2_048);
  const retrievedAt = timestamp(record.retrievedAt, completedAtMs);
  const effectiveAt = timestamp(record.effectiveAt, Date.parse(retrievedAt));
  const sha256 = text(record.sha256, 64);
  if (!SOURCE_KINDS.has(kind) || !validEvidenceUrl(url) || !SHA256.test(sha256)) {
    reject("INVALID_INPUT");
  }
  return { id, kind, operation, url, retrievedAt, effectiveAt, sha256 };
}

function resourceType(value: unknown): GravitonResourceType {
  if (typeof value !== "string" || !RESOURCE_TYPES.has(value as GravitonResourceType)) {
    reject("INVALID_INPUT");
  }
  return value as GravitonResourceType;
}

function scopedResource(
  record: Readonly<Record<string, unknown>>,
  boundary: GravitonTenantBoundary,
): ScopedResource {
  const accountId = text(record.accountId, 12);
  const region = text(record.region);
  const parsedResourceType = resourceType(record.resourceType);
  const resourceArn = text(record.resourceArn, 1_024);
  const resourceId = text(record.resourceId, 256);
  if (
    !boundary.accountIds.includes(accountId)
    || !boundary.regions.includes(region)
    || !ARN.test(resourceArn)
    || !resourceArn.includes(`:${region}:${accountId}:`)
  ) reject("SCOPE_MISMATCH");
  return {
    accountId,
    region,
    resourceType: parsedResourceType,
    resourceArn,
    resourceId,
  };
}

function resourceKey(value: ScopedResource): string {
  return [value.accountId, value.region, value.resourceType, value.resourceArn].join("|");
}

function addStable<T>(map: Map<string, T>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, value);
  } else if (JSON.stringify(existing) !== JSON.stringify(value)) {
    reject("CONFLICTING_DUPLICATE");
  }
}

function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    reject("RECORD_LIMIT_EXCEEDED");
  }
  return value;
}

function recommendation(
  value: unknown,
  boundary: GravitonTenantBoundary,
  completedAtMs: number,
): GravitonComputeOptimizerRecommendation {
  const authoritySupplied = isRecord(value) && Object.hasOwn(value, "recommendationAuthority");
  const record = exactRecord(value, [
    "recommendationId", "accountId", "region", "resourceType", "resourceArn",
    "resourceId", "refreshedAt", "lookbackPeriodDays", "currentConfiguration",
    "targetConfiguration", "cpuVendorArchitecture", "migrationEffort",
    "performanceRiskBasisPoints", "estimatedMonthlySavingsMicros",
    "estimatedSavingsCurrency", "inventoryObservationId", "targetMetadataId",
    "compatibilityEvidenceIds", "baselineCostRecordId", "currentPriceId",
    "targetPriceId", "realizationId", "source",
    ...(authoritySupplied ? ["recommendationAuthority"] : []),
  ]);
  const resource = scopedResource(record, boundary);
  const recommendationId = identifier(record.recommendationId);
  const refreshedAt = timestamp(record.refreshedAt, completedAtMs);
  const lookbackPeriodDays = integer(record.lookbackPeriodDays, 1, 93);
  const currentConfiguration = text(record.currentConfiguration, 256);
  const targetConfiguration = text(record.targetConfiguration, 256);
  const migrationEffort = text(record.migrationEffort) as
    GravitonComputeOptimizerRecommendation["migrationEffort"];
  const performanceRiskBasisPoints = record.performanceRiskBasisPoints === null
    ? null
    : integer(record.performanceRiskBasisPoints, 0, 10_000);
  const estimatedMonthlySavingsMicros = record.estimatedMonthlySavingsMicros === null
    ? null
    : moneyMicros(record.estimatedMonthlySavingsMicros);
  const estimatedSavingsCurrency = record.estimatedSavingsCurrency === null
    ? null
    : text(record.estimatedSavingsCurrency, 3);
  const compatibilityEvidenceIds = sortedStrings(
    record.compatibilityEvidenceIds,
    DIMENSIONS.length,
    (entry) => IDENTIFIER.test(entry),
    0,
  );
  const source = evidenceReference(record.source, completedAtMs);
  const computeOptimizerSource = source.operation.startsWith("compute-optimizer:Get");
  const managedServiceAuthoritativeSource =
    (resource.resourceType === "OPENSEARCH_DOMAIN"
      && source.operation === "opensearch:DescribeDomain")
    || (resource.resourceType === "ELASTICACHE_REPLICATION_GROUP"
      && source.operation === "elasticache:DescribeReplicationGroups");
  const recommendationAuthority = authoritySupplied
    ? text(record.recommendationAuthority) as NonNullable<GravitonComputeOptimizerRecommendation["recommendationAuthority"]>
    : "AWS_COMPUTE_OPTIMIZER";
  if (
    record.cpuVendorArchitecture !== "AWS_ARM64"
    || !new Set(["VERY_LOW", "LOW", "MEDIUM", "HIGH"]).has(migrationEffort)
    || (estimatedMonthlySavingsMicros === null) !== (estimatedSavingsCurrency === null)
    || (estimatedSavingsCurrency !== null && !CURRENCY.test(estimatedSavingsCurrency))
    || source.kind !== "AWS_API"
    || (!computeOptimizerSource && !managedServiceAuthoritativeSource)
    || (computeOptimizerSource && recommendationAuthority !== "AWS_COMPUTE_OPTIMIZER")
    || (managedServiceAuthoritativeSource
      && recommendationAuthority !== "AWS_SERVICE_INVENTORY_PRICING")
    || (!computeOptimizerSource
      && (estimatedMonthlySavingsMicros !== null || estimatedSavingsCurrency !== null))
  ) reject("INVALID_INPUT");
  return {
    ...resource,
    recommendationId,
    recommendationAuthority,
    refreshedAt,
    lookbackPeriodDays,
    currentConfiguration,
    targetConfiguration,
    cpuVendorArchitecture: "AWS_ARM64",
    migrationEffort,
    performanceRiskBasisPoints,
    estimatedMonthlySavingsMicros,
    estimatedSavingsCurrency,
    inventoryObservationId: identifier(record.inventoryObservationId),
    targetMetadataId: identifier(record.targetMetadataId),
    compatibilityEvidenceIds,
    baselineCostRecordId: identifier(record.baselineCostRecordId),
    currentPriceId: identifier(record.currentPriceId),
    targetPriceId: identifier(record.targetPriceId),
    realizationId: record.realizationId === null ? null : identifier(record.realizationId),
    source,
  };
}

function inventoryObservation(
  value: unknown,
  boundary: GravitonTenantBoundary,
  completedAtMs: number,
): GravitonInventoryObservation {
  const record = exactRecord(value, [
    "observationId", "accountId", "region", "resourceType", "resourceArn",
    "resourceId", "configuration", "architecture", "operatingSystem",
    "imageId", "observedAt", "source",
  ]);
  const resource = scopedResource(record, boundary);
  const architecture = text(record.architecture) as GravitonInventoryObservation["architecture"];
  const operatingSystem = text(record.operatingSystem) as GravitonInventoryObservation["operatingSystem"];
  const source = evidenceReference(record.source, completedAtMs);
  if (
    !new Set(["X86_64", "ARM64", "UNKNOWN"]).has(architecture)
    || !new Set(["LINUX", "WINDOWS", "MACOS", "UNKNOWN"]).has(operatingSystem)
    || source.kind !== "AWS_API"
  ) reject("INVALID_INPUT");
  return {
    ...resource,
    observationId: identifier(record.observationId),
    configuration: text(record.configuration, 256),
    architecture,
    operatingSystem,
    imageId: record.imageId === null ? null : text(record.imageId, 256),
    observedAt: timestamp(record.observedAt, completedAtMs),
    source,
  };
}

function instanceMetadata(
  value: unknown,
  boundary: GravitonTenantBoundary,
  completedAtMs: number,
): GravitonInstanceMetadata {
  const record = exactRecord(value, [
    "metadataId", "resourceType", "region", "configuration", "architecture",
    "vcpu", "memoryMiB", "effectiveFromAt", "effectiveToAt", "source",
  ]);
  const region = text(record.region);
  const architecture = text(record.architecture) as GravitonInstanceMetadata["architecture"];
  const effectiveFromAt = timestamp(record.effectiveFromAt, completedAtMs);
  const effectiveToAt = optionalTimestamp(record.effectiveToAt, completedAtMs + 366 * DAY_MS);
  const source = evidenceReference(record.source, completedAtMs);
  if (
    !boundary.regions.includes(region)
    || !new Set(["ARM64", "X86_64"]).has(architecture)
    || (effectiveToAt !== null && Date.parse(effectiveToAt) <= Date.parse(effectiveFromAt))
    || !new Set(["AWS_API", "AWS_INSTANCE_METADATA"]).has(source.kind)
  ) reject("INVALID_INPUT");
  return {
    metadataId: identifier(record.metadataId),
    resourceType: resourceType(record.resourceType),
    region,
    configuration: text(record.configuration, 256),
    architecture,
    vcpu: integer(record.vcpu, 1, 1_024),
    memoryMiB: integer(record.memoryMiB, 1, 100_000_000),
    effectiveFromAt,
    effectiveToAt,
    source,
  };
}

function compatibilityEvidence(
  value: unknown,
  boundary: GravitonTenantBoundary,
  completedAtMs: number,
): GravitonCompatibilityEvidence {
  const record = exactRecord(value, [
    "compatibilityId", "accountId", "region", "resourceType", "resourceArn",
    "resourceId", "dimension", "status", "reasonCode", "assessedAt", "sources",
  ]);
  const resource = scopedResource(record, boundary);
  const dimension = text(record.dimension) as GravitonCompatibilityDimension;
  const status = text(record.status) as GravitonCompatibilityStatus;
  const sources = array(
    record.sources,
    GRAVITON_SAVINGS_BOUNDS.maximumEvidencePerRecord,
  ).map((entry) => evidenceReference(entry, completedAtMs));
  if (
    !DIMENSION_SET.has(dimension)
    || !COMPATIBILITY_STATUSES.has(status)
    || sources.length < 1
    || sources.some((source) => !ALLOWED_COMPATIBILITY_SOURCE_KINDS[dimension].has(source.kind))
  ) reject("INVALID_INPUT");
  const sourceMap = new Map<string, GravitonEvidenceReference>();
  for (const source of sources) addStable(sourceMap, source.id, source);
  if (sourceMap.size !== sources.length) reject("INVALID_INPUT");
  return {
    ...resource,
    compatibilityId: identifier(record.compatibilityId),
    dimension,
    status,
    reasonCode: code(record.reasonCode),
    assessedAt: timestamp(record.assessedAt, completedAtMs),
    sources: [...sourceMap.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function cur2CostRecord(
  value: unknown,
  boundary: GravitonTenantBoundary,
  completedAtMs: number,
): GravitonCur2CostRecord {
  const record = exactRecord(value, [
    "costRecordId", "canonicalSchemaVersion", "generationId", "accountId",
    "region", "resourceType", "resourceArn", "resourceId", "configuration",
    "architecture", "periodStartAt", "periodEndAt", "usageUnit",
    "usageQuantityMicros", "costBasis", "costMicros", "currency", "source",
  ]);
  const resource = scopedResource(record, boundary);
  const architecture = text(record.architecture) as GravitonCur2CostRecord["architecture"];
  const periodEndAt = timestamp(record.periodEndAt, completedAtMs);
  const periodStartAt = timestamp(record.periodStartAt, Date.parse(periodEndAt));
  const costBasis = text(record.costBasis) as GravitonCur2CostRecord["costBasis"];
  const currency = text(record.currency, 3);
  const source = evidenceReference(record.source, completedAtMs);
  if (
    record.canonicalSchemaVersion !== "sutra.cur2.canonical.v1"
    || !new Set(["X86_64", "ARM64"]).has(architecture)
    || record.usageUnit !== "HOURS"
    || !new Set(["PUBLIC_ON_DEMAND_EQUIVALENT", "OBSERVED_EFFECTIVE"]).has(costBasis)
    || !CURRENCY.test(currency)
    || source.kind !== "CUR2_DATA_EXPORT"
    || Date.parse(periodEndAt) <= Date.parse(periodStartAt)
    || Date.parse(periodEndAt) - Date.parse(periodStartAt) > 366 * DAY_MS
  ) reject("INVALID_INPUT");
  return {
    ...resource,
    costRecordId: identifier(record.costRecordId),
    canonicalSchemaVersion: "sutra.cur2.canonical.v1",
    generationId: identifier(record.generationId),
    configuration: text(record.configuration, 256),
    architecture,
    periodStartAt,
    periodEndAt,
    usageUnit: "HOURS",
    usageQuantityMicros: moneyMicros(record.usageQuantityMicros),
    costBasis,
    costMicros: moneyMicros(record.costMicros),
    currency,
    source,
  };
}

function pricingRecord(
  value: unknown,
  boundary: GravitonTenantBoundary,
  completedAtMs: number,
): GravitonPricingRecord {
  const record = exactRecord(value, [
    "priceId", "resourceType", "region", "configuration", "architecture",
    "operatingSystem", "tenancy", "purchaseOption", "unit", "currency",
    "unitPriceMicros", "priceListVersion", "productSku", "termCode",
    "dimensionCode", "effectiveFromAt", "effectiveToAt", "source",
  ]);
  const region = text(record.region);
  const architecture = text(record.architecture) as GravitonPricingRecord["architecture"];
  const currency = text(record.currency, 3);
  const effectiveFromAt = timestamp(record.effectiveFromAt, completedAtMs);
  const effectiveToAt = optionalTimestamp(record.effectiveToAt, completedAtMs + 366 * DAY_MS);
  const source = evidenceReference(record.source, completedAtMs);
  if (
    !boundary.regions.includes(region)
    || !new Set(["ARM64", "X86_64"]).has(architecture)
    || record.purchaseOption !== "ON_DEMAND"
    || record.unit !== "HRS"
    || !CURRENCY.test(currency)
    || source.kind !== "AWS_PRICING"
    || (effectiveToAt !== null && Date.parse(effectiveToAt) <= Date.parse(effectiveFromAt))
  ) reject("INVALID_INPUT");
  return {
    priceId: identifier(record.priceId),
    resourceType: resourceType(record.resourceType),
    region,
    configuration: text(record.configuration, 256),
    architecture,
    operatingSystem: text(record.operatingSystem, 128),
    tenancy: text(record.tenancy, 128),
    purchaseOption: "ON_DEMAND",
    unit: "HRS",
    currency,
    unitPriceMicros: moneyMicros(record.unitPriceMicros),
    priceListVersion: text(record.priceListVersion, 128),
    productSku: text(record.productSku, 128),
    termCode: text(record.termCode, 128),
    dimensionCode: text(record.dimensionCode, 128),
    effectiveFromAt,
    effectiveToAt,
    source,
  };
}

function realizationObservation(
  value: unknown,
  boundary: GravitonTenantBoundary,
  completedAtMs: number,
): GravitonRealizationObservation {
  const record = exactRecord(value, [
    "realizationId", "accountId", "region", "resourceType", "resourceArn",
    "resourceId", "migrationAt", "targetConfiguration",
    "targetInventoryObservationId", "baselineCostRecordId",
    "postMigrationCostRecordId", "comparableWorkloadEvidenceId", "source",
  ]);
  const resource = scopedResource(record, boundary);
  return {
    ...resource,
    realizationId: identifier(record.realizationId),
    migrationAt: timestamp(record.migrationAt, completedAtMs),
    targetConfiguration: text(record.targetConfiguration, 256),
    targetInventoryObservationId: identifier(record.targetInventoryObservationId),
    baselineCostRecordId: identifier(record.baselineCostRecordId),
    postMigrationCostRecordId: identifier(record.postMigrationCostRecordId),
    comparableWorkloadEvidenceId: identifier(record.comparableWorkloadEvidenceId),
    source: evidenceReference(record.source, completedAtMs),
  };
}

function sameResource(left: ScopedResource, right: ScopedResource): boolean {
  return resourceKey(left) === resourceKey(right) && left.resourceId === right.resourceId;
}

function blocker(
  category: GravitonBlocker["category"],
  codeValue: string,
): GravitonBlocker {
  return { category, code: codeValue };
}

function compatibilityBlocker(
  dimension: GravitonCompatibilityDimension,
  evidence: GravitonCompatibilityEvidence | undefined,
): GravitonBlocker | null {
  if (evidence === undefined) {
    return blocker(dimension, `${dimension}_EVIDENCE_REQUIRED`);
  }
  if (evidence.status === "INCOMPATIBLE") {
    return blocker(dimension, `${dimension}_INCOMPATIBLE`);
  }
  if (evidence.status === "REVIEW_REQUIRED") {
    return blocker(dimension, `${dimension}_REVIEW_REQUIRED`);
  }
  return null;
}

function multiplyMicros(quantityMicros: string, priceMicros: string): bigint {
  const numerator = BigInt(quantityMicros) * BigInt(priceMicros);
  return (numerator + MICROS / TWO) / MICROS;
}

function money(amount: bigint, currency: string): GravitonMoney {
  return { amountMicros: amount.toString(), currency };
}

function activeAt(
  effectiveFromAt: string,
  effectiveToAt: string | null,
  periodStartAt: string,
  periodEndAt: string,
): boolean {
  return Date.parse(effectiveFromAt) <= Date.parse(periodStartAt)
    && (effectiveToAt === null || Date.parse(effectiveToAt) >= Date.parse(periodEndAt));
}

function deriveRealizedSavings(
  realization: GravitonRealizationObservation | undefined,
  recommendationValue: GravitonComputeOptimizerRecommendation,
  inventory: ReadonlyMap<string, GravitonInventoryObservation>,
  costs: ReadonlyMap<string, GravitonCur2CostRecord>,
  compatibility: ReadonlyMap<string, GravitonCompatibilityEvidence>,
): GravitonRealizedSavings | null {
  if (realization === undefined || !sameResource(realization, recommendationValue)) return null;
  const targetInventory = inventory.get(realization.targetInventoryObservationId);
  const baseline = costs.get(realization.baselineCostRecordId);
  const measured = costs.get(realization.postMigrationCostRecordId);
  const workload = compatibility.get(realization.comparableWorkloadEvidenceId);
  if (
    targetInventory === undefined
    || baseline === undefined
    || measured === undefined
    || workload === undefined
    || !sameResource(targetInventory, recommendationValue)
    || !sameResource(baseline, recommendationValue)
    || !sameResource(measured, recommendationValue)
    || !sameResource(workload, recommendationValue)
    || targetInventory.architecture !== "ARM64"
    || targetInventory.configuration !== realization.targetConfiguration
    || measured.architecture !== "ARM64"
    || measured.configuration !== realization.targetConfiguration
    || baseline.costBasis !== "OBSERVED_EFFECTIVE"
    || measured.costBasis !== "OBSERVED_EFFECTIVE"
    || baseline.currency !== measured.currency
    || baseline.usageQuantityMicros !== measured.usageQuantityMicros
    || Date.parse(baseline.periodEndAt) - Date.parse(baseline.periodStartAt)
      !== Date.parse(measured.periodEndAt) - Date.parse(measured.periodStartAt)
    || Date.parse(baseline.periodEndAt) > Date.parse(realization.migrationAt)
    || Date.parse(measured.periodStartAt) < Date.parse(realization.migrationAt)
    || workload.dimension !== "WORKLOAD"
    || workload.status !== "COMPATIBLE"
  ) return null;
  const baselineAmount = BigInt(baseline.costMicros);
  const measuredAmount = BigInt(measured.costMicros);
  const delta = baselineAmount - measuredAmount;
  return {
    kind: "MEASURED_REALIZED",
    baselinePeriodStartAt: baseline.periodStartAt,
    baselinePeriodEndAt: baseline.periodEndAt,
    measurementPeriodStartAt: measured.periodStartAt,
    measurementPeriodEndAt: measured.periodEndAt,
    baselineCost: money(baselineAmount, baseline.currency),
    measuredCost: money(measuredAmount, measured.currency),
    observedSavings: money(delta > ZERO ? delta : ZERO, measured.currency),
    observedCostIncrease: money(delta < ZERO ? -delta : ZERO, measured.currency),
    assumptionCodes: [
      "EQUAL_PERIOD_DURATION",
      "EQUAL_BILLED_USAGE_HOURS",
      "COMPARABLE_WORKLOAD_ATTESTED",
      "OBSERVED_EFFECTIVE_COST_BASIS",
    ],
    evidenceIds: [
      baseline.source.id,
      measured.source.id,
      realization.source.id,
      targetInventory.source.id,
      ...workload.sources.map((source) => source.id),
    ].filter((value, index, all) => all.indexOf(value) === index).sort(),
  };
}

interface Maps {
  readonly inventory: ReadonlyMap<string, GravitonInventoryObservation>;
  readonly metadata: ReadonlyMap<string, GravitonInstanceMetadata>;
  readonly compatibility: ReadonlyMap<string, GravitonCompatibilityEvidence>;
  readonly costs: ReadonlyMap<string, GravitonCur2CostRecord>;
  readonly pricing: ReadonlyMap<string, GravitonPricingRecord>;
  readonly realizations: ReadonlyMap<string, GravitonRealizationObservation>;
}

function projectOpportunity(
  latest: GravitonComputeOptimizerRecommendation,
  historyCount: number,
  maps: Maps,
): GravitonOpportunity {
  const blockers: GravitonBlocker[] = [];
  const inventory = maps.inventory.get(latest.inventoryObservationId);
  const metadata = maps.metadata.get(latest.targetMetadataId);
  const baseline = maps.costs.get(latest.baselineCostRecordId);
  const currentPrice = maps.pricing.get(latest.currentPriceId);
  const targetPrice = maps.pricing.get(latest.targetPriceId);
  const compatibilityItems = latest.compatibilityEvidenceIds.map((id) =>
    maps.compatibility.get(id)
  );
  if (inventory === undefined || !sameResource(inventory, latest)) {
    blockers.push(blocker("EVIDENCE", "INVENTORY_EVIDENCE_REQUIRED"));
  } else if (inventory.configuration !== latest.currentConfiguration) {
    blockers.push(blocker("EVIDENCE", "INVENTORY_CONFIGURATION_MISMATCH"));
  }
  if (
    metadata === undefined
    || metadata.resourceType !== latest.resourceType
    || metadata.region !== latest.region
    || metadata.configuration !== latest.targetConfiguration
  ) {
    blockers.push(blocker("EVIDENCE", "TARGET_INSTANCE_METADATA_REQUIRED"));
  } else if (metadata.architecture !== "ARM64") {
    blockers.push(blocker("ARCHITECTURE", "TARGET_ARCHITECTURE_NOT_ARM64"));
  }
  const compatibilityByDimension = new Map<
    GravitonCompatibilityDimension,
    GravitonCompatibilityEvidence
  >();
  for (const item of compatibilityItems) {
    if (item === undefined || !sameResource(item, latest)) {
      blockers.push(blocker("EVIDENCE", "COMPATIBILITY_REFERENCE_INVALID"));
      continue;
    }
    const existing = compatibilityByDimension.get(item.dimension);
    if (existing !== undefined && existing.compatibilityId !== item.compatibilityId) {
      blockers.push(blocker("EVIDENCE", "COMPATIBILITY_DIMENSION_CONFLICT"));
    } else {
      compatibilityByDimension.set(item.dimension, item);
    }
  }
  for (const dimension of DIMENSIONS) {
    const item = compatibilityBlocker(dimension, compatibilityByDimension.get(dimension));
    if (item !== null) blockers.push(item);
  }
  if (
    baseline === undefined
    || !sameResource(baseline, latest)
    || baseline.configuration !== latest.currentConfiguration
    || baseline.costBasis !== "PUBLIC_ON_DEMAND_EQUIVALENT"
  ) blockers.push(blocker("EVIDENCE", "CUR2_PUBLIC_COST_BASELINE_REQUIRED"));
  if (
    currentPrice === undefined
    || currentPrice.resourceType !== latest.resourceType
    || currentPrice.region !== latest.region
    || currentPrice.configuration !== latest.currentConfiguration
  ) blockers.push(blocker("EVIDENCE", "CURRENT_VERSIONED_PRICING_REQUIRED"));
  if (
    targetPrice === undefined
    || targetPrice.resourceType !== latest.resourceType
    || targetPrice.region !== latest.region
    || targetPrice.configuration !== latest.targetConfiguration
  ) blockers.push(blocker("EVIDENCE", "TARGET_VERSIONED_PRICING_REQUIRED"));

  let potentialSavings: GravitonPotentialSavings | null = null;
  if (
    blockers.length === 0
    && baseline !== undefined
    && currentPrice !== undefined
    && targetPrice !== undefined
    && metadata !== undefined
  ) {
    if (
      currentPrice.architecture !== baseline.architecture
      || targetPrice.architecture !== "ARM64"
      || currentPrice.currency !== baseline.currency
      || targetPrice.currency !== baseline.currency
      || !activeAt(currentPrice.effectiveFromAt, currentPrice.effectiveToAt, baseline.periodStartAt, baseline.periodEndAt)
      || !activeAt(targetPrice.effectiveFromAt, targetPrice.effectiveToAt, baseline.periodStartAt, baseline.periodEndAt)
      || !activeAt(metadata.effectiveFromAt, metadata.effectiveToAt, baseline.periodStartAt, baseline.periodEndAt)
    ) {
      blockers.push(blocker("EVIDENCE", "PRICE_OR_METADATA_PERIOD_COVERAGE_REQUIRED"));
    } else {
      const currentModeled = multiplyMicros(
        baseline.usageQuantityMicros,
        currentPrice.unitPriceMicros,
      );
      const targetModeled = multiplyMicros(
        baseline.usageQuantityMicros,
        targetPrice.unitPriceMicros,
      );
      if (currentModeled !== BigInt(baseline.costMicros)) {
        blockers.push(blocker("EVIDENCE", "CUR2_PRICING_RECONCILIATION_REQUIRED"));
      } else if (targetModeled >= currentModeled) {
        blockers.push(blocker("ECONOMICS", "NO_POSITIVE_MODELED_SAVINGS"));
      } else {
        potentialSavings = {
          kind: "MODELED_POTENTIAL",
          periodStartAt: baseline.periodStartAt,
          periodEndAt: baseline.periodEndAt,
          usageQuantityMicros: baseline.usageQuantityMicros,
          currentModeledCost: money(currentModeled, baseline.currency),
          targetModeledCost: money(targetModeled, baseline.currency),
          savings: money(currentModeled - targetModeled, baseline.currency),
          currentUnitPriceMicros: currentPrice.unitPriceMicros,
          targetUnitPriceMicros: targetPrice.unitPriceMicros,
          pricingEffectiveAt: [currentPrice.effectiveFromAt, targetPrice.effectiveFromAt].sort().at(-1)!,
          assumptionCodes: [
            "UNCHANGED_BILLED_USAGE_HOURS",
            "PUBLIC_ON_DEMAND_PRICE_BASIS",
            "NO_MIGRATION_IMPLEMENTATION_COST",
            "NOT_A_SAVINGS_PROMISE",
          ],
        };
      }
    }
  }

  const dedupedBlockers = new Map<string, GravitonBlocker>();
  for (const item of blockers) dedupedBlockers.set(`${item.category}|${item.code}`, item);
  const blockerReasons = [...dedupedBlockers.values()].sort((left, right) =>
    left.category.localeCompare(right.category) || left.code.localeCompare(right.code)
  );
  const hasReview = blockerReasons.some((item) => item.code.endsWith("_REVIEW_REQUIRED"));
  const hasMissingEvidence = blockerReasons.some((item) =>
    item.category === "EVIDENCE" || item.code.endsWith("_EVIDENCE_REQUIRED")
  );
  const hasHardBlocker = blockerReasons.some((item) =>
    item.code.endsWith("_INCOMPATIBLE")
    || item.category === "ECONOMICS"
    || item.code === "TARGET_ARCHITECTURE_NOT_ARM64"
  );
  const state: GravitonOpportunityState = blockerReasons.length === 0
    ? "READY"
    : hasMissingEvidence
      ? "CONFIGURATION_REQUIRED"
      : hasHardBlocker
        ? "BLOCKED"
        : hasReview
          ? "REVIEW_REQUIRED"
          : "BLOCKED";
  const providerEstimate = latest.recommendationAuthority !== "AWS_COMPUTE_OPTIMIZER"
    || latest.estimatedMonthlySavingsMicros === null
    || latest.estimatedSavingsCurrency === null
    ? null
    : {
      kind: "AWS_COMPUTE_OPTIMIZER_ESTIMATE" as const,
      period: "MONTH" as const,
      savings: {
        amountMicros: latest.estimatedMonthlySavingsMicros,
        currency: latest.estimatedSavingsCurrency,
      },
      sourceId: latest.source.id,
    };
  const realization = latest.realizationId === null
    ? undefined
    : maps.realizations.get(latest.realizationId);
  const realizedSavings = deriveRealizedSavings(
    realization,
    latest,
    maps.inventory,
    maps.costs,
    maps.compatibility,
  );
  const evidenceIds = [
    latest.source.id,
    inventory?.source.id,
    metadata?.source.id,
    baseline?.source.id,
    currentPrice?.source.id,
    targetPrice?.source.id,
    ...compatibilityItems.flatMap((item) => item?.sources.map((source) => source.id) ?? []),
  ].filter((value): value is string => value !== undefined)
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort();
  return {
    accountId: latest.accountId,
    region: latest.region,
    resourceType: latest.resourceType,
    resourceArn: latest.resourceArn,
    resourceId: latest.resourceId,
    recommendationId: latest.recommendationId,
    recommendationAuthority: latest.recommendationAuthority ?? "AWS_COMPUTE_OPTIMIZER",
    state,
    currentConfiguration: latest.currentConfiguration,
    targetConfiguration: latest.targetConfiguration,
    migrationEffort: latest.migrationEffort,
    performanceRiskBasisPoints: latest.performanceRiskBasisPoints,
    refreshedAt: latest.refreshedAt,
    historyCount,
    blockerReasons,
    providerEstimate,
    potentialSavings: state === "READY" ? potentialSavings : null,
    realizedSavings,
    evidenceIds,
  };
}

function periodTotals(
  items: readonly {
    readonly start: string;
    readonly end: string;
    readonly money: GravitonMoney;
  }[],
): readonly GravitonPeriodTotal[] {
  const totals = new Map<string, bigint>();
  for (const item of items) {
    const key = [item.start, item.end, item.money.currency].join("|");
    totals.set(key, (totals.get(key) ?? ZERO) + BigInt(item.money.amountMicros));
  }
  return [...totals.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, amount]) => {
      const [periodStartAt, periodEndAt, currency] = key.split("|") as [string, string, string];
      return { periodStartAt, periodEndAt, currency, amountMicros: amount.toString() };
    });
}

function usagePeriods(costs: Iterable<GravitonCur2CostRecord>): readonly GravitonUsagePeriod[] {
  const groups = new Map<string, {
    usage: bigint; cost: bigint; resources: Set<string>; sample: GravitonCur2CostRecord;
  }>();
  for (const item of costs) {
    const key = [item.periodStartAt, item.periodEndAt, item.accountId, item.region,
      item.resourceType, item.configuration, item.architecture, item.costBasis,
      item.currency].join("|");
    const group = groups.get(key) ?? { usage: ZERO, cost: ZERO, resources: new Set<string>(), sample: item };
    group.usage += BigInt(item.usageQuantityMicros);
    group.cost += BigInt(item.costMicros);
    group.resources.add(item.resourceArn);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => ({
    periodStartAt: value.sample.periodStartAt,
    periodEndAt: value.sample.periodEndAt,
    accountId: value.sample.accountId,
    region: value.sample.region,
    resourceType: value.sample.resourceType,
    configuration: value.sample.configuration,
    architecture: value.sample.architecture,
    costBasis: value.sample.costBasis,
    currency: value.sample.currency,
    usageQuantityMicros: value.usage.toString(),
    costMicros: value.cost.toString(),
    resourceCount: value.resources.size,
  }));
}

function containsSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) =>
    /(?:secret|password|credential|sessiontoken|accesskey)/iu.test(key)
    || containsSensitiveKey(nested)
  );
}

/** Normalize and project one immutable, server-pinned tenant collection. */
export function buildGravitonSavingsSnapshot(
  value: unknown,
  expectedBoundary: GravitonTenantBoundary,
  now: Date = new Date(),
): GravitonSavingsSnapshot {
  validateBoundary(expectedBoundary);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || containsSensitiveKey(value)) reject("INVALID_INPUT");
  let inputBytes: number;
  try {
    inputBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return reject("INVALID_INPUT");
  }
  if (inputBytes > GRAVITON_SAVINGS_BOUNDS.maximumCaptureBytes) {
    reject("BYTE_LIMIT_EXCEEDED");
  }
  const root = exactRecord(value, [
    "schemaVersion", "scope", "managementAccountId", "partition", "accountIds",
    "regions", "collectionId", "startedAt", "completedAt", "recommendations",
    "inventory", "instanceMetadata", "compatibility", "costs", "pricing",
    "realizations",
  ]);
  const captureScope = scope(root.scope);
  const managementAccountId = text(root.managementAccountId, 12);
  const partition = text(root.partition);
  const accountIds = sortedStrings(root.accountIds, GRAVITON_SAVINGS_BOUNDS.maximumAccounts, (entry) => ACCOUNT_ID.test(entry));
  const regions = sortedStrings(root.regions, GRAVITON_SAVINGS_BOUNDS.maximumRegions, (entry) => REGION.test(entry));
  const collectionId = identifier(root.collectionId);
  const completedAt = timestamp(root.completedAt, nowMs + CLOCK_SKEW_MS);
  const startedAt = timestamp(root.startedAt, Date.parse(completedAt));
  if (
    root.schemaVersion !== "sutra.graviton-savings.capture.v1"
    || !ACCOUNT_ID.test(managementAccountId)
    || !PARTITIONS.has(partition)
    || captureScope.orgId !== expectedBoundary.scope.orgId
    || captureScope.customerId !== expectedBoundary.scope.customerId
    || captureScope.connectionId !== expectedBoundary.scope.connectionId
    || managementAccountId !== expectedBoundary.managementAccountId
    || partition !== expectedBoundary.partition
    || JSON.stringify(accountIds) !== JSON.stringify(expectedBoundary.accountIds)
    || JSON.stringify(regions) !== JSON.stringify(expectedBoundary.regions)
  ) reject("SCOPE_MISMATCH");
  if (Date.parse(completedAt) - Date.parse(startedAt) > GRAVITON_SAVINGS_BOUNDS.maximumDurationMs) {
    reject("TIME_LIMIT_EXCEEDED");
  }
  const completedAtMs = Date.parse(completedAt);
  const recommendationMap = new Map<string, GravitonComputeOptimizerRecommendation>();
  for (const entry of array(root.recommendations, GRAVITON_SAVINGS_BOUNDS.maximumRecommendations)) {
    const parsed = recommendation(entry, expectedBoundary, completedAtMs);
    addStable(recommendationMap, parsed.recommendationId, parsed);
  }
  const inventoryMap = new Map<string, GravitonInventoryObservation>();
  for (const entry of array(root.inventory, GRAVITON_SAVINGS_BOUNDS.maximumInventoryObservations)) {
    const parsed = inventoryObservation(entry, expectedBoundary, completedAtMs);
    addStable(inventoryMap, parsed.observationId, parsed);
  }
  const metadataMap = new Map<string, GravitonInstanceMetadata>();
  for (const entry of array(root.instanceMetadata, GRAVITON_SAVINGS_BOUNDS.maximumMetadataRecords)) {
    const parsed = instanceMetadata(entry, expectedBoundary, completedAtMs);
    addStable(metadataMap, parsed.metadataId, parsed);
  }
  const compatibilityMap = new Map<string, GravitonCompatibilityEvidence>();
  for (const entry of array(root.compatibility, GRAVITON_SAVINGS_BOUNDS.maximumCompatibilityRecords)) {
    const parsed = compatibilityEvidence(entry, expectedBoundary, completedAtMs);
    addStable(compatibilityMap, parsed.compatibilityId, parsed);
  }
  const costMap = new Map<string, GravitonCur2CostRecord>();
  for (const entry of array(root.costs, GRAVITON_SAVINGS_BOUNDS.maximumCostRecords)) {
    const parsed = cur2CostRecord(entry, expectedBoundary, completedAtMs);
    addStable(costMap, parsed.costRecordId, parsed);
  }
  const pricingMap = new Map<string, GravitonPricingRecord>();
  for (const entry of array(root.pricing, GRAVITON_SAVINGS_BOUNDS.maximumPricingRecords)) {
    const parsed = pricingRecord(entry, expectedBoundary, completedAtMs);
    addStable(pricingMap, parsed.priceId, parsed);
  }
  const realizationMap = new Map<string, GravitonRealizationObservation>();
  for (const entry of array(root.realizations, GRAVITON_SAVINGS_BOUNDS.maximumRealizationRecords)) {
    const parsed = realizationObservation(entry, expectedBoundary, completedAtMs);
    addStable(realizationMap, parsed.realizationId, parsed);
  }

  const histories = new Map<string, GravitonComputeOptimizerRecommendation[]>();
  for (const item of recommendationMap.values()) {
    if (completedAtMs - Date.parse(item.refreshedAt) > GRAVITON_SAVINGS_BOUNDS.maximumHistoryAgeDays * DAY_MS) {
      reject("HISTORY_LIMIT_EXCEEDED");
    }
    const key = resourceKey(item);
    const history = histories.get(key) ?? [];
    history.push(item);
    if (history.length > GRAVITON_SAVINGS_BOUNDS.maximumHistoryPerResource) {
      reject("HISTORY_LIMIT_EXCEEDED");
    }
    histories.set(key, history);
  }
  if (histories.size > GRAVITON_SAVINGS_BOUNDS.maximumOpportunitiesInResponse) {
    reject("OUTPUT_LIMIT_EXCEEDED");
  }
  const maps: Maps = {
    inventory: inventoryMap,
    metadata: metadataMap,
    compatibility: compatibilityMap,
    costs: costMap,
    pricing: pricingMap,
    realizations: realizationMap,
  };
  const opportunities = [...histories.values()].map((history) => {
    history.sort((left, right) =>
      right.refreshedAt.localeCompare(left.refreshedAt)
      || right.recommendationId.localeCompare(left.recommendationId)
    );
    return projectOpportunity(history[0]!, history.length, maps);
  }).sort((left, right) =>
    left.accountId.localeCompare(right.accountId)
    || left.region.localeCompare(right.region)
    || left.resourceType.localeCompare(right.resourceType)
    || left.resourceArn.localeCompare(right.resourceArn)
  );
  const configurationRequired = opportunities.filter((item) => item.state === "CONFIGURATION_REQUIRED").length;
  const reviewRequired = opportunities.filter((item) => item.state === "REVIEW_REQUIRED").length;
  const blocked = opportunities.filter((item) => item.state === "BLOCKED").length;
  const ready = opportunities.filter((item) => item.state === "READY").length;
  const snapshot: GravitonSavingsSnapshot = {
    schemaVersion: "sutra.graviton-savings.snapshot.v1",
    scope: captureScope,
    collectionId,
    generatedAt: now.toISOString(),
    state: recommendationMap.size === 0 || configurationRequired > 0
      ? "CONFIGURATION_REQUIRED"
      : reviewRequired > 0 || blocked > 0
        ? "PARTIAL"
        : "COMPLETE",
    summary: {
      resources: opportunities.length,
      ready,
      reviewRequired,
      blocked,
      configurationRequired,
      modeledPotentialByPeriod: periodTotals(opportunities.flatMap((item) =>
        item.potentialSavings === null ? [] : [{
          start: item.potentialSavings.periodStartAt,
          end: item.potentialSavings.periodEndAt,
          money: item.potentialSavings.savings,
        }]
      )),
      measuredRealizedByPeriod: periodTotals(opportunities.flatMap((item) =>
        item.realizedSavings === null ? [] : [{
          start: item.realizedSavings.measurementPeriodStartAt,
          end: item.realizedSavings.measurementPeriodEndAt,
          money: item.realizedSavings.observedSavings,
        }]
      )),
    },
    currentUsage: usagePeriods(costMap.values()),
    opportunities,
  };
  const outputBytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
  if (outputBytes > GRAVITON_SAVINGS_BOUNDS.maximumResponseBytes) {
    reject("OUTPUT_LIMIT_EXCEEDED");
  }
  return snapshot;
}
