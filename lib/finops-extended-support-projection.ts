/**
 * Evidence-honest AWS Extended Support inventory and projection engine.
 *
 * This module is a pure trust boundary. It accepts no credentials, performs no
 * network/database I/O, and keeps no process-global tenant state. The caller
 * supplies an immutable collector capture plus the server-pinned tenant/AWS
 * boundary. Lifecycle dates and prices are evidence inputs rather than
 * hard-coded facts because AWS can revise calendars, availability, and rates.
 *
 * "Projected incremental cost" means only the additional Extended Support
 * charge under an unchanged-resource assumption. It is never actual spend,
 * normal service cost, a quote, or a savings promise.
 */
import type { FinopsSourceScope } from "./finops-source-health.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const COLLECTION_ID = /^esp_[a-f0-9]{64}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,95}$/u;
const ARN =
  /^arn:(aws|aws-us-gov|aws-cn):[a-z0-9-]+:[a-z0-9-]+:\d{12}:.+$/u;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_MONEY = 1_000_000_000_000;

export const EXTENDED_SUPPORT_PROJECTION_BOUNDS = Object.freeze({
  maximumCaptureBytes: 32 * 1_024 * 1_024,
  maximumOutputBytes: 8 * 1_024 * 1_024,
  maximumDurationMs: 15 * 60 * 1_000,
  maximumAccounts: 1_000,
  maximumRegions: 50,
  maximumObservations: 50_000,
  maximumHistoryPerResource: 24,
  maximumHistoryAgeDays: 400,
  maximumCurrentObservationAgeHours: 48,
  maximumAuthoritativeEvidenceAgeHours: 31 * 24,
  maximumCalendarEntries: 2_000,
  maximumRates: 10_000,
  maximumObservedCharges: 100_000,
  maximumResourcesInResponse: 5_000,
  maximumTextLength: 512,
  maximumUnitsPerHour: 100_000,
} as const);

export const EXTENDED_SUPPORT_READ_OPERATIONS = Object.freeze([
  "eks:ListClusters",
  "eks:DescribeCluster",
  "eks:DescribeClusterVersions",
  "rds:DescribeDBInstances",
  "rds:DescribeDBClusters",
  "rds:DescribeDBMajorEngineVersions",
  "rds:DescribeOrderableDBInstanceOptions",
  "es:ListDomainNames",
  "es:DescribeDomain",
  "es:DescribeDomains",
  "elasticache:DescribeCacheClusters",
  "elasticache:DescribeReplicationGroups",
  "elasticache:DescribeCacheEngineVersions",
  "pricing:GetProducts",
] as const);

export type ExtendedSupportService =
  | "EKS"
  | "RDS"
  | "AURORA"
  | "OPENSEARCH"
  | "ELASTICACHE";

export type ExtendedSupportResourceType =
  | "EKS_CLUSTER"
  | "RDS_DB_INSTANCE"
  | "AURORA_DB_CLUSTER"
  | "OPENSEARCH_DOMAIN"
  | "ELASTICACHE_CACHE";

export type ExtendedSupportUnit =
  | "CLUSTER_HOUR"
  | "VCPU_HOUR"
  | "NORMALIZED_INSTANCE_HOUR"
  | "INSTANCE_HOUR";

export type ExtendedSupportEnrollment =
  | "ENABLED"
  | "DISABLED"
  | "AUTOMATIC"
  | "NOT_APPLICABLE"
  | "UNKNOWN";

export type ExtendedSupportLifecycleState =
  | "STANDARD_SUPPORT"
  | "EXTENDED_SUPPORT"
  | "END_OF_SUPPORT"
  | "DATES_NOT_ANNOUNCED"
  | "CALENDAR_REQUIRED"
  | "VERSION_REQUIRED";

export type ExtendedSupportProjectionState =
  | "COMPLETE"
  | "PARTIAL"
  | "CONFIGURATION_REQUIRED"
  | "NOT_APPLICABLE";

export type ExtendedSupportSnapshotState =
  | "READY"
  | "PARTIAL"
  | "CONFIGURATION_REQUIRED";

export type ExtendedSupportCoverageStatus =
  | "SUCCEEDED"
  | "PARTIAL"
  | "FAILED";

export type ExtendedSupportRateTier =
  | "EXTENDED"
  | "YEAR_1"
  | "YEAR_2"
  | "YEAR_3";

export type ExtendedSupportFailureCode =
  | "INVALID_INPUT"
  | "SCOPE_MISMATCH"
  | "CONFLICTING_DUPLICATE"
  | "RECORD_LIMIT_EXCEEDED"
  | "BYTE_LIMIT_EXCEEDED"
  | "TIME_LIMIT_EXCEEDED"
  | "OUTPUT_LIMIT_EXCEEDED";

export interface ExtendedSupportTenantBoundary {
  readonly scope: FinopsSourceScope;
  readonly managementAccountId: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  /** Sorted, unique accounts authorized for this exact connection. */
  readonly accountIds: readonly string[];
  /** Sorted, unique Regions authorized for this exact connection. */
  readonly regions: readonly string[];
}

export interface ExtendedSupportEvidenceReference {
  readonly id: string;
  readonly kind:
    | "AWS_API"
    | "AWS_DOCUMENTATION"
    | "AWS_PRICING"
    | "CUR2_DATA_EXPORT";
  readonly operation: string;
  readonly url: string;
  readonly retrievedAt: string;
  readonly effectiveAt: string;
  readonly sha256: string;
}

export interface ExtendedSupportProjectionBasis {
  readonly unit: ExtendedSupportUnit;
  readonly unitsPerHour: number;
  readonly observedAt: string;
  readonly evidence: readonly ExtendedSupportEvidenceReference[];
}

export interface ExtendedSupportInventoryObservation {
  readonly service: ExtendedSupportService;
  readonly resourceType: ExtendedSupportResourceType;
  readonly accountId: string;
  readonly region: string;
  readonly resourceArn: string;
  readonly resourceId: string;
  readonly engine: string;
  readonly engineVersion: string | null;
  /**
   * Exact calendar key produced from authoritative AWS evidence. The engine
   * does not guess major/minor semantics from engineVersion.
   */
  readonly supportVersionKey: string | null;
  readonly supportEnrollment: ExtendedSupportEnrollment;
  readonly observedAt: string;
  readonly source: ExtendedSupportEvidenceReference;
  readonly projectionBasis: ExtendedSupportProjectionBasis | null;
}

export interface ExtendedSupportCalendarEntry {
  readonly service: ExtendedSupportService;
  readonly engine: string;
  readonly supportVersionKey: string;
  /** A Region-specific API result wins over a GLOBAL documentation entry. */
  readonly region: string | "GLOBAL";
  readonly calendarStatus: "ANNOUNCED" | "NOT_ANNOUNCED";
  readonly standardSupportEndAt: string | null;
  readonly extendedSupportStartAt: string | null;
  readonly chargeableFromAt: string | null;
  readonly extendedSupportEndAt: string | null;
  readonly effectiveAt: string;
  readonly source: ExtendedSupportEvidenceReference;
}

export interface ExtendedSupportRate {
  readonly rateId: string;
  readonly service: ExtendedSupportService;
  readonly engine: string;
  readonly supportVersionKey: string;
  readonly region: string;
  readonly tier: ExtendedSupportRateTier;
  readonly unit: ExtendedSupportUnit;
  readonly currency: string;
  /** Additional Extended Support charge only, per billable unit-hour. */
  readonly incrementalUnitPrice: number;
  readonly pricingModel: "DIRECT_UNIT_RATE" | "ON_DEMAND_PREMIUM";
  readonly baseUnitPrice: number | null;
  readonly premiumPercent: number | null;
  readonly effectiveFromAt: string;
  readonly effectiveToAt: string | null;
  readonly source: ExtendedSupportEvidenceReference;
}

export interface ExtendedSupportObservedCharge {
  readonly chargeId: string;
  readonly service: ExtendedSupportService;
  readonly accountId: string;
  readonly region: string;
  readonly resourceArn: string;
  readonly periodStartAt: string;
  readonly periodEndAt: string;
  readonly usageUnit: ExtendedSupportUnit;
  readonly usageQuantity: number;
  /** Reconciled actual Extended Support line-item cost, not a projection. */
  readonly actualExtendedSupportCost: number;
  readonly currency: string;
  readonly source: ExtendedSupportEvidenceReference;
}

export interface ExtendedSupportServiceCoverage {
  readonly service: ExtendedSupportService;
  readonly status: ExtendedSupportCoverageStatus;
  readonly readPermissionsValidated: boolean;
  readonly accountIds: readonly string[];
  readonly regions: readonly string[];
  readonly recordCount: number;
  /** Safe provider/control-plane code only; never raw provider error text. */
  readonly errorCode: string | null;
}

export interface ExtendedSupportProjectionCapture {
  readonly schemaVersion: "sutra.extended-support-projection.v1";
  readonly scope: FinopsSourceScope;
  readonly managementAccountId: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly accountIds: readonly string[];
  readonly regions: readonly string[];
  readonly collectionId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly coverage: readonly ExtendedSupportServiceCoverage[];
  readonly observations: readonly ExtendedSupportInventoryObservation[];
  readonly calendars: readonly ExtendedSupportCalendarEntry[];
  readonly rates: readonly ExtendedSupportRate[];
  readonly observedCharges: readonly ExtendedSupportObservedCharge[];
}

export interface ExtendedSupportCostAmount {
  readonly currency: string;
  readonly amount: number;
}

export interface ExtendedSupportUsageAmount {
  readonly unit: ExtendedSupportUnit;
  readonly quantity: number;
}

export interface ExtendedSupportResourceHorizon {
  readonly months: 3 | 6 | 12;
  readonly windowStartAt: string;
  readonly windowEndAt: string;
  readonly supportUnitHours: number | null;
  readonly pricingCoveredUnitHours: number | null;
  readonly projectionState: ExtendedSupportProjectionState;
  readonly projectedIncrementalCost: number | null;
  readonly currency: string | null;
  readonly reasonCodes: readonly string[];
}

export interface ExtendedSupportResourceProjection {
  readonly service: ExtendedSupportService;
  readonly resourceType: ExtendedSupportResourceType;
  readonly accountId: string;
  readonly region: string;
  readonly resourceArn: string;
  readonly resourceId: string;
  readonly engine: string;
  readonly engineVersion: string | null;
  readonly supportVersionKey: string | null;
  readonly supportEnrollment: ExtendedSupportEnrollment;
  readonly lifecycleState: ExtendedSupportLifecycleState;
  readonly standardSupportEndAt: string | null;
  readonly extendedSupportStartAt: string | null;
  readonly chargeableFromAt: string | null;
  readonly extendedSupportEndAt: string | null;
  readonly calendarEffectiveAt: string | null;
  readonly calendarFreshness: "CURRENT" | "STALE" | "MISSING";
  readonly pricingRateIds: readonly string[];
  readonly pricingFreshness: "CURRENT" | "STALE" | "MISSING";
  readonly latestObservedAt: string;
  readonly observationFreshness: "CURRENT" | "STALE";
  readonly firstObservedAt: string;
  readonly historyObservationCount: number;
  readonly projectionBasis: ExtendedSupportProjectionBasis | null;
  readonly observedActualCosts: readonly ExtendedSupportCostAmount[];
  readonly observedActualUsage: readonly ExtendedSupportUsageAmount[];
  readonly horizons: readonly ExtendedSupportResourceHorizon[];
  readonly sourceReferenceIds: readonly string[];
}

export interface ExtendedSupportHorizonSummary {
  readonly months: 3 | 6 | 12;
  readonly windowStartAt: string;
  readonly windowEndAt: string;
  readonly currentlyExtendedResources: number;
  readonly enteringExtendedSupportResources: number;
  readonly endOfSupportResources: number;
  readonly completeResourceProjections: number;
  readonly partialResourceProjections: number;
  readonly configurationRequiredResources: number;
  readonly notApplicableResourceProjections: number;
  /** Totals include only COMPLETE resource projections. */
  readonly projectedIncrementalCosts: readonly ExtendedSupportCostAmount[];
}

export interface ExtendedSupportServiceSummary {
  readonly service: ExtendedSupportService;
  readonly state: ExtendedSupportSnapshotState;
  readonly coverage: ExtendedSupportServiceCoverage;
  readonly resourceCount: number;
  readonly currentlyExtendedResources: number;
  readonly endOfSupportResources: number;
  readonly configurationRequiredResources: number;
  readonly observedActualCosts: readonly ExtendedSupportCostAmount[];
  readonly observedActualUsage: readonly ExtendedSupportUsageAmount[];
  readonly horizons: readonly ExtendedSupportHorizonSummary[];
}

export interface ExtendedSupportProjectionSnapshot {
  readonly schemaVersion: "sutra.extended-support-projection.v1";
  readonly scope: FinopsSourceScope;
  readonly managementAccountId: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly accountIds: readonly string[];
  readonly regions: readonly string[];
  readonly collectionId: string;
  readonly collectedAt: string;
  readonly state: ExtendedSupportSnapshotState;
  readonly observedCostLabel: "RECONCILED_ACTUAL_EXTENDED_SUPPORT_COST";
  readonly projectionLabel:
    "PROJECTED_INCREMENTAL_EXTENDED_SUPPORT_COST_IF_UNCHANGED";
  readonly services: readonly ExtendedSupportServiceSummary[];
  readonly resources: readonly ExtendedSupportResourceProjection[];
  readonly sourceReferences: readonly ExtendedSupportEvidenceReference[];
  readonly limitations: readonly string[];
}

export class ExtendedSupportProjectionError extends Error {
  public readonly code: ExtendedSupportFailureCode;

  public constructor(code: ExtendedSupportFailureCode) {
    super("The Extended Support projection evidence is invalid");
    this.name = "ExtendedSupportProjectionError";
    this.code = code;
  }
}

const SERVICES = [
  "EKS",
  "RDS",
  "AURORA",
  "OPENSEARCH",
  "ELASTICACHE",
] as const;
const SERVICE_SET = new Set<string>(SERVICES);
const PARTITIONS = new Set(["aws", "aws-us-gov", "aws-cn"]);
const ENROLLMENTS = new Set<string>([
  "ENABLED",
  "DISABLED",
  "AUTOMATIC",
  "NOT_APPLICABLE",
  "UNKNOWN",
]);
const COVERAGE_STATUSES = new Set<string>([
  "SUCCEEDED",
  "PARTIAL",
  "FAILED",
]);
const RATE_TIERS = new Set<string>([
  "EXTENDED",
  "YEAR_1",
  "YEAR_2",
  "YEAR_3",
]);
const SOURCE_KINDS = new Set<string>([
  "AWS_API",
  "AWS_DOCUMENTATION",
  "AWS_PRICING",
  "CUR2_DATA_EXPORT",
]);
const RESOURCE_TYPE_BY_SERVICE: Readonly<
  Record<ExtendedSupportService, ExtendedSupportResourceType>
> = Object.freeze({
  EKS: "EKS_CLUSTER",
  RDS: "RDS_DB_INSTANCE",
  AURORA: "AURORA_DB_CLUSTER",
  OPENSEARCH: "OPENSEARCH_DOMAIN",
  ELASTICACHE: "ELASTICACHE_CACHE",
});
const UNIT_BY_SERVICE: Readonly<
  Record<ExtendedSupportService, ExtendedSupportUnit>
> = Object.freeze({
  EKS: "CLUSTER_HOUR",
  RDS: "VCPU_HOUR",
  AURORA: "VCPU_HOUR",
  OPENSEARCH: "NORMALIZED_INSTANCE_HOUR",
  ELASTICACHE: "INSTANCE_HOUR",
});
const INVENTORY_OPERATIONS: Readonly<
  Record<ExtendedSupportService, ReadonlySet<string>>
> = Object.freeze({
  EKS: new Set(["eks:DescribeCluster"]),
  RDS: new Set(["rds:DescribeDBInstances"]),
  AURORA: new Set(["rds:DescribeDBClusters"]),
  OPENSEARCH: new Set(["es:DescribeDomain", "es:DescribeDomains"]),
  ELASTICACHE: new Set([
    "elasticache:DescribeCacheClusters",
    "elasticache:DescribeReplicationGroups",
  ]),
});
const ARN_SERVICE_BY_SERVICE: Readonly<
  Record<ExtendedSupportService, string>
> = Object.freeze({
  EKS: "eks",
  RDS: "rds",
  AURORA: "rds",
  OPENSEARCH: "es",
  ELASTICACHE: "elasticache",
});
const CALENDAR_OPERATIONS: Readonly<
  Record<ExtendedSupportService, ReadonlySet<string>>
> = Object.freeze({
  EKS: new Set(["eks:DescribeClusterVersions"]),
  RDS: new Set(["rds:DescribeDBMajorEngineVersions"]),
  AURORA: new Set(["rds:DescribeDBMajorEngineVersions"]),
  OPENSEARCH: new Set(["AWS_SUPPORT_CALENDAR"]),
  ELASTICACHE: new Set(["AWS_SUPPORT_CALENDAR"]),
});
const PRICING_OPERATIONS = new Set([
  "pricing:GetProducts",
  "AWS_PUBLIC_PRICING_PAGE",
]);

function reject(code: ExtendedSupportFailureCode): never {
  throw new ExtendedSupportProjectionError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) reject("INVALID_INPUT");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
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

function code(value: unknown): string {
  const result = text(value, 96);
  if (!SAFE_CODE.test(result)) reject("INVALID_INPUT");
  return result;
}

function finite(value: unknown, minimum: number, maximum: number): number {
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

function optionalTimestamp(
  value: unknown,
  maximumMs: number,
): string | null {
  return value === null ? null : timestamp(value, maximumMs);
}

function scope(value: unknown): FinopsSourceScope {
  const record = exactRecord(value, ["orgId", "customerId", "connectionId"]);
  const orgId = text(record.orgId);
  const customerId = text(record.customerId);
  const connectionId = text(record.connectionId, 37);
  if (
    !IDENTIFIER.test(orgId)
    || !IDENTIFIER.test(customerId)
    || !CONNECTION_ID.test(connectionId)
  ) reject("INVALID_INPUT");
  return { orgId, customerId, connectionId };
}

function sortedAccounts(value: unknown): readonly string[] {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > EXTENDED_SUPPORT_PROJECTION_BOUNDS.maximumAccounts
    || !value.every((entry) =>
      typeof entry === "string" && ACCOUNT_ID.test(entry)
    )
  ) reject("INVALID_INPUT");
  const result = [...new Set(value)].sort();
  if (
    result.length !== value.length
    || JSON.stringify(result) !== JSON.stringify(value)
  ) reject("INVALID_INPUT");
  return result;
}

function sortedRegions(value: unknown): readonly string[] {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > EXTENDED_SUPPORT_PROJECTION_BOUNDS.maximumRegions
    || !value.every((entry) =>
      typeof entry === "string" && REGION.test(entry)
    )
  ) reject("INVALID_INPUT");
  const result = [...new Set(value)].sort();
  if (
    result.length !== value.length
    || JSON.stringify(result) !== JSON.stringify(value)
  ) reject("INVALID_INPUT");
  return result;
}

function service(value: unknown): ExtendedSupportService {
  if (typeof value !== "string" || !SERVICE_SET.has(value)) {
    reject("INVALID_INPUT");
  }
  return value as ExtendedSupportService;
}

function validOfficialAwsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && (
        parsed.hostname === "docs.aws.amazon.com"
        || parsed.hostname === "aws.amazon.com"
      );
  } catch {
    return false;
  }
}

function evidenceReference(
  value: unknown,
  maximumMs: number,
): ExtendedSupportEvidenceReference {
  const record = exactRecord(value, [
    "id",
    "kind",
    "operation",
    "url",
    "retrievedAt",
    "effectiveAt",
    "sha256",
  ]);
  const id = text(record.id);
  const kind = text(record.kind) as ExtendedSupportEvidenceReference["kind"];
  const operation = text(record.operation);
  const url = text(record.url, 2_048);
  const retrievedAt = timestamp(record.retrievedAt, maximumMs);
  const effectiveAt = timestamp(record.effectiveAt, Date.parse(retrievedAt));
  const sha256 = text(record.sha256, 64);
  if (
    !IDENTIFIER.test(id)
    || !SOURCE_KINDS.has(kind)
    || !validOfficialAwsUrl(url)
    || !SHA256.test(sha256)
  ) reject("INVALID_INPUT");
  return {
    id,
    kind,
    operation,
    url,
    retrievedAt,
    effectiveAt,
    sha256,
  };
}

function addStable<T>(map: Map<string, T>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, value);
    return;
  }
  if (JSON.stringify(existing) !== JSON.stringify(value)) {
    reject("CONFLICTING_DUPLICATE");
  }
}

function validateBoundary(
  value: unknown,
): asserts value is ExtendedSupportTenantBoundary {
  const record = exactRecord(value, [
    "scope",
    "managementAccountId",
    "partition",
    "accountIds",
    "regions",
  ]);
  const parsedScope = scope(record.scope);
  const managementAccountId = text(record.managementAccountId, 12);
  const partition = text(record.partition);
  const accountIds = sortedAccounts(record.accountIds);
  sortedRegions(record.regions);
  if (
    !ACCOUNT_ID.test(managementAccountId)
    || !PARTITIONS.has(partition)
    || !accountIds.includes(managementAccountId)
    || parsedScope.orgId !== (value as ExtendedSupportTenantBoundary).scope.orgId
  ) reject("INVALID_INPUT");
}

function sameBoundary(
  capture: ExtendedSupportProjectionCapture,
  expected: ExtendedSupportTenantBoundary,
): boolean {
  return capture.scope.orgId === expected.scope.orgId
    && capture.scope.customerId === expected.scope.customerId
    && capture.scope.connectionId === expected.scope.connectionId
    && capture.managementAccountId === expected.managementAccountId
    && capture.partition === expected.partition
    && JSON.stringify(capture.accountIds) === JSON.stringify(expected.accountIds)
    && JSON.stringify(capture.regions) === JSON.stringify(expected.regions);
}

function projectionBasis(
  value: unknown,
  expectedService: ExtendedSupportService,
  completedAtMs: number,
): ExtendedSupportProjectionBasis | null {
  if (value === null) return null;
  const record = exactRecord(value, [
    "unit",
    "unitsPerHour",
    "observedAt",
    "evidence",
  ]);
  const unit = text(record.unit) as ExtendedSupportUnit;
  const unitsPerHour = finite(
    record.unitsPerHour,
    Number.MIN_VALUE,
    EXTENDED_SUPPORT_PROJECTION_BOUNDS.maximumUnitsPerHour,
  );
  const observedAt = timestamp(record.observedAt, completedAtMs);
  if (
    unit !== UNIT_BY_SERVICE[expectedService]
    || !Array.isArray(record.evidence)
    || record.evidence.length < 1
    || record.evidence.length > 8
  ) reject("INVALID_INPUT");
  const evidence = record.evidence.map((entry) =>
    evidenceReference(entry, completedAtMs)
  );
  const evidenceMap = new Map<string, ExtendedSupportEvidenceReference>();
  for (const item of evidence) addStable(evidenceMap, item.id, item);
  if (evidenceMap.size !== evidence.length) reject("INVALID_INPUT");
  if (expectedService === "EKS" && unitsPerHour !== 1) {
    reject("INVALID_INPUT");
  }
  return { unit, unitsPerHour, observedAt, evidence };
}

function inventoryObservation(
  value: unknown,
  boundary: ExtendedSupportTenantBoundary,
  completedAtMs: number,
): ExtendedSupportInventoryObservation {
  const record = exactRecord(value, [
    "service",
    "resourceType",
    "accountId",
    "region",
    "resourceArn",
    "resourceId",
    "engine",
    "engineVersion",
    "supportVersionKey",
    "supportEnrollment",
    "observedAt",
    "source",
    "projectionBasis",
  ]);
  const parsedService = service(record.service);
  const resourceType = text(
    record.resourceType,
  ) as ExtendedSupportResourceType;
  const accountId = text(record.accountId, 12);
  const region = text(record.region);
  const resourceArn = text(record.resourceArn, 1_024);
  const resourceId = text(record.resourceId, 256);
  const engine = text(record.engine, 128);
  const engineVersion = record.engineVersion === null
    ? null
    : text(record.engineVersion, 128);
  const supportVersionKey = record.supportVersionKey === null
    ? null
    : text(record.supportVersionKey, 128);
  const supportEnrollment = text(
    record.supportEnrollment,
  ) as ExtendedSupportEnrollment;
  const observedAt = timestamp(record.observedAt, completedAtMs);
  const source = evidenceReference(record.source, completedAtMs);
  if (
    resourceType !== RESOURCE_TYPE_BY_SERVICE[parsedService]
    || !ACCOUNT_ID.test(accountId)
    || !boundary.accountIds.includes(accountId)
    || !REGION.test(region)
    || !boundary.regions.includes(region)
    || !ARN.test(resourceArn)
    || !resourceArn.startsWith(
      `arn:${boundary.partition}:${ARN_SERVICE_BY_SERVICE[parsedService]}:`,
    )
    || !resourceArn.includes(`:${region}:${accountId}:`)
    || !ENROLLMENTS.has(supportEnrollment)
    || source.kind !== "AWS_API"
    || !INVENTORY_OPERATIONS[parsedService].has(source.operation)
  ) reject("SCOPE_MISMATCH");
  const parsedBasis = projectionBasis(
    record.projectionBasis,
    parsedService,
    completedAtMs,
  );
  if (
    parsedBasis !== null
    && Date.parse(parsedBasis.observedAt) > Date.parse(observedAt)
  ) reject("INVALID_INPUT");
  return {
    service: parsedService,
    resourceType,
    accountId,
    region,
    resourceArn,
    resourceId,
    engine,
    engineVersion,
    supportVersionKey,
    supportEnrollment,
    observedAt,
    source,
    projectionBasis: parsedBasis,
  };
}

function calendarEntry(
  value: unknown,
  boundary: ExtendedSupportTenantBoundary,
  completedAtMs: number,
): ExtendedSupportCalendarEntry {
  const record = exactRecord(value, [
    "service",
    "engine",
    "supportVersionKey",
    "region",
    "calendarStatus",
    "standardSupportEndAt",
    "extendedSupportStartAt",
    "chargeableFromAt",
    "extendedSupportEndAt",
    "effectiveAt",
    "source",
  ]);
  const parsedService = service(record.service);
  const engine = text(record.engine, 128);
  const supportVersionKey = text(record.supportVersionKey, 128);
  const region = text(record.region);
  const calendarStatus = text(record.calendarStatus) as
    ExtendedSupportCalendarEntry["calendarStatus"];
  const effectiveAt = timestamp(record.effectiveAt, completedAtMs);
  const source = evidenceReference(record.source, completedAtMs);
  if (
    (region !== "GLOBAL" && !boundary.regions.includes(region))
    || !new Set(["ANNOUNCED", "NOT_ANNOUNCED"]).has(calendarStatus)
    || Date.parse(source.effectiveAt) > Date.parse(effectiveAt)
    || !CALENDAR_OPERATIONS[parsedService].has(source.operation)
    || (
      new Set(["EKS", "RDS", "AURORA"]).has(parsedService)
      && source.kind !== "AWS_API"
    )
    || (
      new Set(["OPENSEARCH", "ELASTICACHE"]).has(parsedService)
      && source.kind !== "AWS_DOCUMENTATION"
    )
  ) reject("INVALID_INPUT");
  const maximumCalendarMs = completedAtMs + 20 * 366 * DAY_MS;
  const standardSupportEndAt = optionalTimestamp(
    record.standardSupportEndAt,
    maximumCalendarMs,
  );
  const extendedSupportStartAt = optionalTimestamp(
    record.extendedSupportStartAt,
    maximumCalendarMs,
  );
  const chargeableFromAt = optionalTimestamp(
    record.chargeableFromAt,
    maximumCalendarMs,
  );
  const extendedSupportEndAt = optionalTimestamp(
    record.extendedSupportEndAt,
    maximumCalendarMs,
  );
  if (
    (
      calendarStatus === "NOT_ANNOUNCED"
      && (
        standardSupportEndAt !== null
        || extendedSupportStartAt !== null
        || chargeableFromAt !== null
        || extendedSupportEndAt !== null
      )
    )
    || (
      calendarStatus === "ANNOUNCED"
      && (
        standardSupportEndAt === null
        || extendedSupportStartAt === null
        || chargeableFromAt === null
      )
    )
    || (
      standardSupportEndAt !== null
      && extendedSupportStartAt !== null
      && Date.parse(extendedSupportStartAt) < Date.parse(standardSupportEndAt)
    )
    || (
      extendedSupportStartAt !== null
      && chargeableFromAt !== null
      && Date.parse(chargeableFromAt) < Date.parse(extendedSupportStartAt)
    )
    || (
      chargeableFromAt !== null
      && extendedSupportEndAt !== null
      && Date.parse(extendedSupportEndAt) <= Date.parse(chargeableFromAt)
    )
  ) reject("INVALID_INPUT");
  return {
    service: parsedService,
    engine,
    supportVersionKey,
    region: region as string | "GLOBAL",
    calendarStatus,
    standardSupportEndAt,
    extendedSupportStartAt,
    chargeableFromAt,
    extendedSupportEndAt,
    effectiveAt,
    source,
  };
}

function rate(
  value: unknown,
  boundary: ExtendedSupportTenantBoundary,
  completedAtMs: number,
): ExtendedSupportRate {
  const record = exactRecord(value, [
    "rateId",
    "service",
    "engine",
    "supportVersionKey",
    "region",
    "tier",
    "unit",
    "currency",
    "incrementalUnitPrice",
    "pricingModel",
    "baseUnitPrice",
    "premiumPercent",
    "effectiveFromAt",
    "effectiveToAt",
    "source",
  ]);
  const rateId = text(record.rateId);
  const parsedService = service(record.service);
  const engine = text(record.engine, 128);
  const supportVersionKey = text(record.supportVersionKey, 128);
  const region = text(record.region);
  const tier = text(record.tier) as ExtendedSupportRateTier;
  const unit = text(record.unit) as ExtendedSupportUnit;
  const currency = text(record.currency, 3);
  const incrementalUnitPrice = finite(
    record.incrementalUnitPrice,
    Number.MIN_VALUE,
    1_000_000,
  );
  const pricingModel = text(record.pricingModel) as
    ExtendedSupportRate["pricingModel"];
  const effectiveFromAt = timestamp(
    record.effectiveFromAt,
    completedAtMs + 20 * 366 * DAY_MS,
  );
  const effectiveToAt = optionalTimestamp(
    record.effectiveToAt,
    completedAtMs + 20 * 366 * DAY_MS,
  );
  const source = evidenceReference(record.source, completedAtMs);
  const baseUnitPrice = record.baseUnitPrice === null
    ? null
    : finite(record.baseUnitPrice, 0, 1_000_000);
  const premiumPercent = record.premiumPercent === null
    ? null
    : finite(record.premiumPercent, 0, 10_000);
  if (
    !IDENTIFIER.test(rateId)
    || !boundary.regions.includes(region)
    || !RATE_TIERS.has(tier)
    || unit !== UNIT_BY_SERVICE[parsedService]
    || !CURRENCY.test(currency)
    || !new Set(["DIRECT_UNIT_RATE", "ON_DEMAND_PREMIUM"]).has(pricingModel)
    || (
      effectiveToAt !== null
      && Date.parse(effectiveToAt) <= Date.parse(effectiveFromAt)
    )
    || source.kind !== "AWS_PRICING"
    || !PRICING_OPERATIONS.has(source.operation)
  ) reject("INVALID_INPUT");
  if (
    pricingModel === "DIRECT_UNIT_RATE"
    && (baseUnitPrice !== null || premiumPercent !== null)
  ) reject("INVALID_INPUT");
  if (pricingModel === "ON_DEMAND_PREMIUM") {
    if (
      baseUnitPrice === null
      || premiumPercent === null
      || Math.abs(
        baseUnitPrice * premiumPercent / 100 - incrementalUnitPrice,
      ) > 0.000_001
    ) reject("INVALID_INPUT");
  }
  return {
    rateId,
    service: parsedService,
    engine,
    supportVersionKey,
    region,
    tier,
    unit,
    currency,
    incrementalUnitPrice,
    pricingModel,
    baseUnitPrice,
    premiumPercent,
    effectiveFromAt,
    effectiveToAt,
    source,
  };
}

function observedCharge(
  value: unknown,
  boundary: ExtendedSupportTenantBoundary,
  completedAtMs: number,
): ExtendedSupportObservedCharge {
  const record = exactRecord(value, [
    "chargeId",
    "service",
    "accountId",
    "region",
    "resourceArn",
    "periodStartAt",
    "periodEndAt",
    "usageUnit",
    "usageQuantity",
    "actualExtendedSupportCost",
    "currency",
    "source",
  ]);
  const chargeId = text(record.chargeId);
  const parsedService = service(record.service);
  const accountId = text(record.accountId, 12);
  const region = text(record.region);
  const resourceArn = text(record.resourceArn, 1_024);
  const periodEndAt = timestamp(record.periodEndAt, completedAtMs);
  const periodStartAt = timestamp(record.periodStartAt, Date.parse(periodEndAt));
  const usageUnit = text(record.usageUnit) as ExtendedSupportUnit;
  const usageQuantity = finite(record.usageQuantity, 0, MAX_MONEY);
  const actualExtendedSupportCost = finite(
    record.actualExtendedSupportCost,
    -MAX_MONEY,
    MAX_MONEY,
  );
  const currency = text(record.currency, 3);
  const source = evidenceReference(record.source, completedAtMs);
  if (
    !IDENTIFIER.test(chargeId)
    || !boundary.accountIds.includes(accountId)
    || !boundary.regions.includes(region)
    || !ARN.test(resourceArn)
    || !resourceArn.startsWith(
      `arn:${boundary.partition}:${ARN_SERVICE_BY_SERVICE[parsedService]}:`,
    )
    || !resourceArn.includes(`:${region}:${accountId}:`)
    || usageUnit !== UNIT_BY_SERVICE[parsedService]
    || !CURRENCY.test(currency)
    || source.kind !== "CUR2_DATA_EXPORT"
    || source.operation !== "CUR2_DATA_EXPORT"
    || Date.parse(periodEndAt) <= Date.parse(periodStartAt)
    || Date.parse(periodEndAt) - Date.parse(periodStartAt)
      > EXTENDED_SUPPORT_PROJECTION_BOUNDS.maximumHistoryAgeDays * DAY_MS
  ) reject("SCOPE_MISMATCH");
  return {
    chargeId,
    service: parsedService,
    accountId,
    region,
    resourceArn,
    periodStartAt,
    periodEndAt,
    usageUnit,
    usageQuantity,
    actualExtendedSupportCost,
    currency,
    source,
  };
}

function serviceCoverage(
  value: unknown,
  boundary: ExtendedSupportTenantBoundary,
): ExtendedSupportServiceCoverage {
  const record = exactRecord(value, [
    "service",
    "status",
    "readPermissionsValidated",
    "accountIds",
    "regions",
    "recordCount",
    "errorCode",
  ]);
  const parsedService = service(record.service);
  const status = text(record.status) as ExtendedSupportCoverageStatus;
  const accountIds = sortedAccounts(record.accountIds);
  const regions = sortedRegions(record.regions);
  const recordCount = integer(
    record.recordCount,
    0,
    EXTENDED_SUPPORT_PROJECTION_BOUNDS.maximumObservations,
  );
  const errorCode = record.errorCode === null ? null : code(record.errorCode);
  if (
    !COVERAGE_STATUSES.has(status)
    || typeof record.readPermissionsValidated !== "boolean"
    || JSON.stringify(accountIds) !== JSON.stringify(boundary.accountIds)
    || JSON.stringify(regions) !== JSON.stringify(boundary.regions)
    || (
      status === "SUCCEEDED"
      && (!record.readPermissionsValidated || errorCode !== null)
    )
    || (
      status === "FAILED"
      && (
        record.readPermissionsValidated
        || errorCode === null
        || recordCount !== 0
      )
    )
    || (
      status === "PARTIAL"
      && errorCode === null
    )
  ) reject("SCOPE_MISMATCH");
  return {
    service: parsedService,
    status,
    readPermissionsValidated: record.readPermissionsValidated,
    accountIds,
    regions,
    recordCount,
    errorCode,
  };
}

function calendarKey(
  item: Pick<
    ExtendedSupportCalendarEntry,
    "service" | "engine" | "supportVersionKey" | "region"
  >,
): string {
  return [
    item.service,
    item.engine,
    item.supportVersionKey,
    item.region,
  ].join("|");
}

function resourceKey(
  item: Pick<
    ExtendedSupportInventoryObservation,
    "service" | "accountId" | "region" | "resourceArn"
  >,
): string {
  return [
    item.service,
    item.accountId,
    item.region,
    item.resourceArn,
  ].join("|");
}

function findCalendar(
  item: ExtendedSupportInventoryObservation,
  calendars: ReadonlyMap<string, ExtendedSupportCalendarEntry>,
): ExtendedSupportCalendarEntry | null {
  if (item.supportVersionKey === null) return null;
  return calendars.get(calendarKey({
    service: item.service,
    engine: item.engine,
    supportVersionKey: item.supportVersionKey,
    region: item.region,
  })) ?? calendars.get(calendarKey({
    service: item.service,
    engine: item.engine,
    supportVersionKey: item.supportVersionKey,
    region: "GLOBAL",
  })) ?? null;
}

function lifecycleState(
  observation: ExtendedSupportInventoryObservation,
  calendar: ExtendedSupportCalendarEntry | null,
  nowMs: number,
): ExtendedSupportLifecycleState {
  if (observation.supportVersionKey === null) return "VERSION_REQUIRED";
  if (calendar === null) return "CALENDAR_REQUIRED";
  if (
    calendar.calendarStatus === "NOT_ANNOUNCED"
    || calendar.standardSupportEndAt === null
    || calendar.extendedSupportStartAt === null
  ) return "DATES_NOT_ANNOUNCED";
  if (nowMs < Date.parse(calendar.standardSupportEndAt)) {
    return "STANDARD_SUPPORT";
  }
  if (
    calendar.extendedSupportEndAt !== null
    && nowMs >= Date.parse(calendar.extendedSupportEndAt)
  ) return "END_OF_SUPPORT";
  return "EXTENDED_SUPPORT";
}

function addUtcMonths(value: Date, months: 3 | 6 | 12): Date {
  const year = value.getUTCFullYear();
  const month = value.getUTCMonth() + months;
  const day = value.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    year,
    month,
    Math.min(day, lastDay),
    value.getUTCHours(),
    value.getUTCMinutes(),
    value.getUTCSeconds(),
    value.getUTCMilliseconds(),
  ));
}

function overlapHours(
  leftStartMs: number,
  leftEndMs: number,
  rightStartMs: number,
  rightEndMs: number,
): number {
  return Math.max(
    0,
    Math.min(leftEndMs, rightEndMs) - Math.max(leftStartMs, rightStartMs),
  ) / HOUR_MS;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function projectHorizon(
  observation: ExtendedSupportInventoryObservation,
  calendar: ExtendedSupportCalendarEntry | null,
  matchingRates: readonly ExtendedSupportRate[],
  now: Date,
  months: 3 | 6 | 12,
): ExtendedSupportResourceHorizon {
  const windowStartAt = now.toISOString();
  const windowEndAt = addUtcMonths(now, months).toISOString();
  const base = {
    months,
    windowStartAt,
    windowEndAt,
  } as const;
  if (observation.supportVersionKey === null) {
    return {
      ...base,
      supportUnitHours: null,
      pricingCoveredUnitHours: null,
      projectionState: "CONFIGURATION_REQUIRED",
      projectedIncrementalCost: null,
      currency: null,
      reasonCodes: ["VERSION_REQUIRED"],
    };
  }
  if (calendar === null) {
    return {
      ...base,
      supportUnitHours: null,
      pricingCoveredUnitHours: null,
      projectionState: "CONFIGURATION_REQUIRED",
      projectedIncrementalCost: null,
      currency: null,
      reasonCodes: ["CALENDAR_REQUIRED"],
    };
  }
  if (
    calendar.calendarStatus === "NOT_ANNOUNCED"
    || calendar.chargeableFromAt === null
    || calendar.extendedSupportEndAt === null
  ) {
    return {
      ...base,
      supportUnitHours: null,
      pricingCoveredUnitHours: null,
      projectionState: "PARTIAL",
      projectedIncrementalCost: null,
      currency: null,
      reasonCodes: ["SUPPORT_DATES_NOT_FULLY_ANNOUNCED"],
    };
  }
  if (
    now.getTime() - Date.parse(calendar.source.retrievedAt)
      > EXTENDED_SUPPORT_PROJECTION_BOUNDS
        .maximumAuthoritativeEvidenceAgeHours * HOUR_MS
  ) {
    return {
      ...base,
      supportUnitHours: null,
      pricingCoveredUnitHours: null,
      projectionState: "PARTIAL",
      projectedIncrementalCost: null,
      currency: null,
      reasonCodes: ["CALENDAR_EVIDENCE_STALE"],
    };
  }
  if (
    observation.supportEnrollment === "DISABLED"
    || observation.supportEnrollment === "NOT_APPLICABLE"
  ) {
    return {
      ...base,
      supportUnitHours: null,
      pricingCoveredUnitHours: null,
      projectionState: "NOT_APPLICABLE",
      projectedIncrementalCost: null,
      currency: null,
      reasonCodes: ["EXTENDED_SUPPORT_NOT_ENABLED"],
    };
  }
  if (now.getTime() >= Date.parse(calendar.extendedSupportEndAt)) {
    return {
      ...base,
      supportUnitHours: null,
      pricingCoveredUnitHours: null,
      projectionState: "NOT_APPLICABLE",
      projectedIncrementalCost: null,
      currency: null,
      reasonCodes: ["PAST_EXTENDED_SUPPORT_NO_COST_PROJECTION"],
    };
  }
  if (observation.supportEnrollment === "UNKNOWN") {
    return {
      ...base,
      supportUnitHours: null,
      pricingCoveredUnitHours: null,
      projectionState: "CONFIGURATION_REQUIRED",
      projectedIncrementalCost: null,
      currency: null,
      reasonCodes: ["ENROLLMENT_EVIDENCE_REQUIRED"],
    };
  }
  const basis = observation.projectionBasis;
  if (basis === null) {
    return {
      ...base,
      supportUnitHours: null,
      pricingCoveredUnitHours: null,
      projectionState: "CONFIGURATION_REQUIRED",
      projectedIncrementalCost: null,
      currency: null,
      reasonCodes: ["USAGE_BASIS_REQUIRED"],
    };
  }
  const supportStartMs = Math.max(
    now.getTime(),
    Date.parse(calendar.chargeableFromAt),
  );
  const supportEndMs = Math.min(
    Date.parse(windowEndAt),
    Date.parse(calendar.extendedSupportEndAt),
  );
  if (supportEndMs <= supportStartMs) {
    return {
      ...base,
      supportUnitHours: 0,
      pricingCoveredUnitHours: 0,
      projectionState: "COMPLETE",
      projectedIncrementalCost: 0,
      currency: null,
      reasonCodes: ["NO_CHARGEABLE_EXTENDED_SUPPORT_IN_WINDOW"],
    };
  }
  const supportHours = (supportEndMs - supportStartMs) / HOUR_MS;
  const supportUnitHours = supportHours * basis.unitsPerHour;
  const sortedRates = [...matchingRates].sort((left, right) =>
    left.effectiveFromAt.localeCompare(right.effectiveFromAt)
      || left.rateId.localeCompare(right.rateId)
  );
  let coveredHours = 0;
  let cost = 0;
  let currency: string | null = null;
  for (const item of sortedRates) {
    const rateStartMs = Date.parse(item.effectiveFromAt);
    const rateEndMs = item.effectiveToAt === null
      ? Number.POSITIVE_INFINITY
      : Date.parse(item.effectiveToAt);
    const hours = overlapHours(
      supportStartMs,
      supportEndMs,
      rateStartMs,
      rateEndMs,
    );
    if (hours === 0) continue;
    if (
      now.getTime() - Date.parse(item.source.retrievedAt)
        > EXTENDED_SUPPORT_PROJECTION_BOUNDS
          .maximumAuthoritativeEvidenceAgeHours * HOUR_MS
    ) {
      return {
        ...base,
        supportUnitHours,
        pricingCoveredUnitHours: coveredHours * basis.unitsPerHour,
        projectionState: "PARTIAL",
        projectedIncrementalCost: null,
        currency,
        reasonCodes: ["PRICING_EVIDENCE_STALE"],
      };
    }
    if (currency !== null && currency !== item.currency) {
      return {
        ...base,
        supportUnitHours,
        pricingCoveredUnitHours: coveredHours * basis.unitsPerHour,
        projectionState: "CONFIGURATION_REQUIRED",
        projectedIncrementalCost: null,
        currency: null,
        reasonCodes: ["CURRENCY_CONFIGURATION_CONFLICT"],
      };
    }
    currency = item.currency;
    coveredHours += hours;
    cost += hours * basis.unitsPerHour * item.incrementalUnitPrice;
  }
  if (!Number.isFinite(cost) || cost > MAX_MONEY) {
    reject("OUTPUT_LIMIT_EXCEEDED");
  }
  const coveredUnitHours = coveredHours * basis.unitsPerHour;
  if (Math.abs(coveredHours - supportHours) > 1 / 3_600) {
    return {
      ...base,
      supportUnitHours,
      pricingCoveredUnitHours: coveredUnitHours,
      projectionState: "PARTIAL",
      projectedIncrementalCost: null,
      currency,
      reasonCodes: ["PRICING_COVERAGE_REQUIRED"],
    };
  }
  return {
    ...base,
    supportUnitHours,
    pricingCoveredUnitHours: coveredUnitHours,
    projectionState: "COMPLETE",
    projectedIncrementalCost: roundMoney(cost),
    currency,
    reasonCodes: ["UNCHANGED_RESOURCE_CONFIGURATION_ASSUMED"],
  };
}

function sumCosts(
  values: readonly { readonly currency: string; readonly amount: number }[],
): readonly ExtendedSupportCostAmount[] {
  const totals = new Map<string, number>();
  for (const value of values) {
    const amount = (totals.get(value.currency) ?? 0) + value.amount;
    if (!Number.isFinite(amount) || Math.abs(amount) > MAX_MONEY) {
      reject("OUTPUT_LIMIT_EXCEEDED");
    }
    totals.set(value.currency, amount);
  }
  return [...totals]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => ({ currency, amount: roundMoney(amount) }));
}

function sumUsage(
  values: readonly {
    readonly unit: ExtendedSupportUnit;
    readonly quantity: number;
  }[],
): readonly ExtendedSupportUsageAmount[] {
  const totals = new Map<ExtendedSupportUnit, number>();
  for (const value of values) {
    const quantity = (totals.get(value.unit) ?? 0) + value.quantity;
    if (!Number.isFinite(quantity) || quantity > MAX_MONEY) {
      reject("OUTPUT_LIMIT_EXCEEDED");
    }
    totals.set(value.unit, quantity);
  }
  return [...totals]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([unit, quantity]) => ({
      unit,
      quantity: roundMoney(quantity),
    }));
}

function sourceIds(
  history: readonly ExtendedSupportInventoryObservation[],
  calendar: ExtendedSupportCalendarEntry | null,
  rates: readonly ExtendedSupportRate[],
  charges: readonly ExtendedSupportObservedCharge[],
): readonly string[] {
  return [
    ...history.flatMap((observation) => [
      observation.source.id,
      ...(observation.projectionBasis?.evidence.map((item) => item.id) ?? []),
    ]),
    ...(calendar === null ? [] : [calendar.source.id]),
    ...rates.map((item) => item.source.id),
    ...charges.map((item) => item.source.id),
  ].filter((value, index, all) => all.indexOf(value) === index).sort();
}

function stateRank(value: ExtendedSupportLifecycleState): number {
  return {
    END_OF_SUPPORT: 0,
    EXTENDED_SUPPORT: 1,
    CALENDAR_REQUIRED: 2,
    VERSION_REQUIRED: 3,
    DATES_NOT_ANNOUNCED: 4,
    STANDARD_SUPPORT: 5,
  }[value];
}

function projectionNeedsConfiguration(
  item: ExtendedSupportResourceProjection,
): boolean {
  return item.horizons.some((horizon) =>
    horizon.projectionState === "CONFIGURATION_REQUIRED"
  );
}

function summarizeHorizon(
  serviceResources: readonly ExtendedSupportResourceProjection[],
  months: 3 | 6 | 12,
  now: Date,
): ExtendedSupportHorizonSummary {
  const horizonRows = serviceResources.map((resource) => ({
    resource,
    horizon: resource.horizons.find((entry) => entry.months === months)!,
  }));
  const first = horizonRows[0]?.horizon;
  const windowStartAt = first?.windowStartAt ?? now.toISOString();
  const windowEndAt = first?.windowEndAt ?? addUtcMonths(now, months).toISOString();
  const nowMs = Date.parse(windowStartAt);
  const endMs = Date.parse(windowEndAt);
  return {
    months,
    windowStartAt,
    windowEndAt,
    currentlyExtendedResources: serviceResources.filter((resource) =>
      resource.lifecycleState === "EXTENDED_SUPPORT"
    ).length,
    enteringExtendedSupportResources: serviceResources.filter((resource) =>
      resource.lifecycleState === "STANDARD_SUPPORT"
      && resource.extendedSupportStartAt !== null
      && Date.parse(resource.extendedSupportStartAt) >= nowMs
      && Date.parse(resource.extendedSupportStartAt) < endMs
    ).length,
    endOfSupportResources: serviceResources.filter((resource) =>
      resource.lifecycleState === "END_OF_SUPPORT"
      || (
        resource.extendedSupportEndAt !== null
        && Date.parse(resource.extendedSupportEndAt) >= nowMs
        && Date.parse(resource.extendedSupportEndAt) < endMs
      )
    ).length,
    completeResourceProjections: horizonRows.filter(({ horizon }) =>
      horizon.projectionState === "COMPLETE"
    ).length,
    partialResourceProjections: horizonRows.filter(({ horizon }) =>
      horizon.projectionState === "PARTIAL"
      || horizon.projectionState === "NOT_APPLICABLE"
    ).length,
    configurationRequiredResources: horizonRows.filter(({ horizon }) =>
      horizon.projectionState === "CONFIGURATION_REQUIRED"
    ).length,
    notApplicableResourceProjections: horizonRows.filter(({ horizon }) =>
      horizon.projectionState === "NOT_APPLICABLE"
    ).length,
    projectedIncrementalCosts: sumCosts(horizonRows.flatMap(({ horizon }) =>
      horizon.projectionState === "COMPLETE"
        && horizon.currency !== null
        && horizon.projectedIncrementalCost !== null
        ? [{
          currency: horizon.currency,
          amount: horizon.projectedIncrementalCost,
        }]
        : []
    )),
  };
}

/**
 * Normalizes a tenant-pinned collection and builds 3/6/12 month projections.
 *
 * Exact duplicates are collapsed. Conflicting duplicates, scope changes,
 * unbounded history, malformed timestamps, overlapping rates, and oversized
 * input/output all fail closed with a generic error.
 */
export function buildExtendedSupportProjection(
  value: unknown,
  expectedBoundary: ExtendedSupportTenantBoundary,
  now: Date = new Date(),
): ExtendedSupportProjectionSnapshot {
  validateBoundary(expectedBoundary);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) reject("INVALID_INPUT");
  let captureBytes: number;
  try {
    captureBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return reject("INVALID_INPUT");
  }
  if (
    captureBytes > EXTENDED_SUPPORT_PROJECTION_BOUNDS.maximumCaptureBytes
  ) reject("BYTE_LIMIT_EXCEEDED");
  const root = exactRecord(value, [
    "schemaVersion",
    "scope",
    "managementAccountId",
    "partition",
    "accountIds",
    "regions",
    "collectionId",
    "startedAt",
    "completedAt",
    "coverage",
    "observations",
    "calendars",
    "rates",
    "observedCharges",
  ]);
  const captureScope = scope(root.scope);
  const managementAccountId = text(root.managementAccountId, 12);
  const partition = text(root.partition) as
    ExtendedSupportProjectionCapture["partition"];
  const accountIds = sortedAccounts(root.accountIds);
  const regions = sortedRegions(root.regions);
  const collectionId = text(root.collectionId, 68);
  if (
    root.schemaVersion !== "sutra.extended-support-projection.v1"
    || !ACCOUNT_ID.test(managementAccountId)
    || !PARTITIONS.has(partition)
    || !COLLECTION_ID.test(collectionId)
  ) reject("INVALID_INPUT");
  const completedAt = timestamp(root.completedAt, nowMs + CLOCK_SKEW_MS);
  const completedAtMs = Date.parse(completedAt);
  const startedAt = timestamp(root.startedAt, completedAtMs);
  if (
    completedAtMs - Date.parse(startedAt)
      > EXTENDED_SUPPORT_PROJECTION_BOUNDS.maximumDurationMs
  ) reject("TIME_LIMIT_EXCEEDED");
  const captureBoundary: ExtendedSupportProjectionCapture = {
    schemaVersion: "sutra.extended-support-projection.v1",
    scope: captureScope,
    managementAccountId,
    partition,
    accountIds,
    regions,
    collectionId,
    startedAt,
    completedAt,
    coverage: [],
    observations: [],
    calendars: [],
    rates: [],
    observedCharges: [],
  };
  if (!sameBoundary(captureBoundary, expectedBoundary)) {
    reject("SCOPE_MISMATCH");
  }
  if (
    !Array.isArray(root.coverage)
    || root.coverage.length !== SERVICES.length
    || !Array.isArray(root.observations)
    || root.observations.length
      > EXTENDED_SUPPORT_PROJECTION_BOUNDS.maximumObservations
    || !Array.isArray(root.calendars)
    || root.calendars.length
      > EXTENDED_SUPPORT_PROJECTION_BOUNDS.maximumCalendarEntries
    || !Array.isArray(root.rates)
    || root.rates.length > EXTENDED_SUPPORT_PROJECTION_BOUNDS.maximumRates
    || !Array.isArray(root.observedCharges)
    || root.observedCharges.length
      > EXTENDED_SUPPORT_PROJECTION_BOUNDS.maximumObservedCharges
  ) reject("RECORD_LIMIT_EXCEEDED");

  const coverageMap = new Map<
    ExtendedSupportService,
    ExtendedSupportServiceCoverage
  >();
  for (const item of root.coverage) {
    const parsed = serviceCoverage(item, expectedBoundary);
    addStable(coverageMap, parsed.service, parsed);
  }
  if (
    coverageMap.size !== SERVICES.length
    || SERVICES.some((item) => !coverageMap.has(item))
  ) reject("INVALID_INPUT");

  const observations = root.observations.map((item) =>
    inventoryObservation(item, expectedBoundary, completedAtMs)
  );
  for (const item of SERVICES) {
    if (
      coverageMap.get(item)!.recordCount
        !== observations.filter((entry) => entry.service === item).length
    ) reject("INVALID_INPUT");
  }
  const observationMap = new Map<string, ExtendedSupportInventoryObservation>();
  for (const item of observations) {
    addStable(
      observationMap,
      `${resourceKey(item)}|${item.observedAt}`,
      item,
    );
  }
  const observationHistory = new Map<
    string,
    ExtendedSupportInventoryObservation[]
  >();
  for (const item of observationMap.values()) {
    const key = resourceKey(item);
    const history = observationHistory.get(key) ?? [];
    history.push(item);
    observationHistory.set(key, history);
  }
  for (const history of observationHistory.values()) {
    history.sort((left, right) =>
      left.observedAt.localeCompare(right.observedAt)
    );
    if (
      history.length
        > EXTENDED_SUPPORT_PROJECTION_BOUNDS.maximumHistoryPerResource
      || completedAtMs - Date.parse(history[0]!.observedAt)
        > EXTENDED_SUPPORT_PROJECTION_BOUNDS.maximumHistoryAgeDays * DAY_MS
    ) reject("RECORD_LIMIT_EXCEEDED");
    const identity = history[0]!;
    if (history.some((item) =>
      item.resourceId !== identity.resourceId
      || item.resourceType !== identity.resourceType
    )) reject("CONFLICTING_DUPLICATE");
  }
  if (
    observationHistory.size
      > EXTENDED_SUPPORT_PROJECTION_BOUNDS.maximumResourcesInResponse
  ) reject("OUTPUT_LIMIT_EXCEEDED");

  const calendarMap = new Map<string, ExtendedSupportCalendarEntry>();
  for (const item of root.calendars) {
    const parsed = calendarEntry(item, expectedBoundary, completedAtMs);
    addStable(calendarMap, calendarKey(parsed), parsed);
  }
  const rates = new Map<string, ExtendedSupportRate>();
  for (const item of root.rates) {
    const parsed = rate(item, expectedBoundary, completedAtMs);
    addStable(rates, parsed.rateId, parsed);
  }
  const groupedRates = new Map<string, ExtendedSupportRate[]>();
  for (const item of rates.values()) {
    const key = [
      item.service,
      item.engine,
      item.supportVersionKey,
      item.region,
      item.unit,
    ].join("|");
    const group = groupedRates.get(key) ?? [];
    group.push(item);
    groupedRates.set(key, group);
  }
  for (const group of groupedRates.values()) {
    group.sort((left, right) =>
      left.effectiveFromAt.localeCompare(right.effectiveFromAt)
    );
    for (let index = 1; index < group.length; index += 1) {
      const previous = group[index - 1]!;
      const current = group[index]!;
      if (
        previous.effectiveToAt === null
        || Date.parse(previous.effectiveToAt)
          > Date.parse(current.effectiveFromAt)
      ) reject("CONFLICTING_DUPLICATE");
    }
  }
  const charges = new Map<string, ExtendedSupportObservedCharge>();
  for (const item of root.observedCharges) {
    const parsed = observedCharge(item, expectedBoundary, completedAtMs);
    addStable(charges, parsed.chargeId, parsed);
  }
  const knownResourceKeys = new Set(observationHistory.keys());
  if ([...charges.values()].some((item) =>
    !knownResourceKeys.has([
      item.service,
      item.accountId,
      item.region,
      item.resourceArn,
    ].join("|"))
  )) reject("SCOPE_MISMATCH");

  const evidenceIdentityMap = new Map<
    string,
    ExtendedSupportEvidenceReference
  >();
  for (const item of observationMap.values()) {
    addStable(evidenceIdentityMap, item.source.id, item.source);
    for (const reference of item.projectionBasis?.evidence ?? []) {
      addStable(evidenceIdentityMap, reference.id, reference);
    }
  }
  for (const item of calendarMap.values()) {
    addStable(evidenceIdentityMap, item.source.id, item.source);
  }
  for (const item of rates.values()) {
    addStable(evidenceIdentityMap, item.source.id, item.source);
  }
  for (const item of charges.values()) {
    addStable(evidenceIdentityMap, item.source.id, item.source);
  }

  const sourceMap = new Map<string, ExtendedSupportEvidenceReference>();
  const resources: ExtendedSupportResourceProjection[] = [];
  for (const history of observationHistory.values()) {
    const latest = history.at(-1)!;
    const calendar = findCalendar(latest, calendarMap);
    const rateKey = [
      latest.service,
      latest.engine,
      latest.supportVersionKey ?? "",
      latest.region,
      UNIT_BY_SERVICE[latest.service],
    ].join("|");
    const matchingRates = groupedRates.get(rateKey) ?? [];
    const matchingCharges = [...charges.values()].filter((item) =>
      resourceKey(item) === resourceKey(latest)
    );
    for (const observation of history) {
      addStable(sourceMap, observation.source.id, observation.source);
      for (const reference of observation.projectionBasis?.evidence ?? []) {
        addStable(sourceMap, reference.id, reference);
      }
    }
    if (calendar !== null) {
      addStable(sourceMap, calendar.source.id, calendar.source);
    }
    for (const item of matchingRates) {
      addStable(sourceMap, item.source.id, item.source);
    }
    for (const item of matchingCharges) {
      addStable(sourceMap, item.source.id, item.source);
    }
    resources.push({
      service: latest.service,
      resourceType: latest.resourceType,
      accountId: latest.accountId,
      region: latest.region,
      resourceArn: latest.resourceArn,
      resourceId: latest.resourceId,
      engine: latest.engine,
      engineVersion: latest.engineVersion,
      supportVersionKey: latest.supportVersionKey,
      supportEnrollment: latest.supportEnrollment,
      lifecycleState: lifecycleState(latest, calendar, nowMs),
      standardSupportEndAt: calendar?.standardSupportEndAt ?? null,
      extendedSupportStartAt: calendar?.extendedSupportStartAt ?? null,
      chargeableFromAt: calendar?.chargeableFromAt ?? null,
      extendedSupportEndAt: calendar?.extendedSupportEndAt ?? null,
      calendarEffectiveAt: calendar?.effectiveAt ?? null,
      calendarFreshness: calendar === null
        ? "MISSING"
        : nowMs - Date.parse(calendar.source.retrievedAt)
            <= EXTENDED_SUPPORT_PROJECTION_BOUNDS
              .maximumAuthoritativeEvidenceAgeHours * HOUR_MS
          ? "CURRENT"
          : "STALE",
      pricingRateIds: matchingRates.map((item) => item.rateId).sort(),
      pricingFreshness: matchingRates.length === 0
        ? "MISSING"
        : matchingRates.every((item) =>
            nowMs - Date.parse(item.source.retrievedAt)
              <= EXTENDED_SUPPORT_PROJECTION_BOUNDS
                .maximumAuthoritativeEvidenceAgeHours * HOUR_MS
          )
          ? "CURRENT"
          : "STALE",
      latestObservedAt: latest.observedAt,
      observationFreshness:
        nowMs - Date.parse(latest.observedAt)
          <= EXTENDED_SUPPORT_PROJECTION_BOUNDS
            .maximumCurrentObservationAgeHours * HOUR_MS
          ? "CURRENT"
          : "STALE",
      firstObservedAt: history[0]!.observedAt,
      historyObservationCount: history.length,
      projectionBasis: latest.projectionBasis,
      observedActualCosts: sumCosts(matchingCharges.map((item) => ({
        currency: item.currency,
        amount: item.actualExtendedSupportCost,
      }))),
      observedActualUsage: sumUsage(matchingCharges.map((item) => ({
        unit: item.usageUnit,
        quantity: item.usageQuantity,
      }))),
      horizons: ([3, 6, 12] as const).map((months) =>
        projectHorizon(latest, calendar, matchingRates, now, months)
      ),
      sourceReferenceIds: sourceIds(
        history,
        calendar,
        matchingRates,
        matchingCharges,
      ),
    });
  }
  resources.sort((left, right) =>
    stateRank(left.lifecycleState) - stateRank(right.lifecycleState)
      || left.service.localeCompare(right.service)
      || left.accountId.localeCompare(right.accountId)
      || left.region.localeCompare(right.region)
      || left.resourceArn.localeCompare(right.resourceArn)
  );
  for (const item of charges.values()) {
    addStable(sourceMap, item.source.id, item.source);
  }

  const services: ExtendedSupportServiceSummary[] = SERVICES.map(
    (itemService) => {
      const serviceResources = resources.filter((item) =>
        item.service === itemService
      );
      const coverage = coverageMap.get(itemService)!;
      const configurationRequiredResources = serviceResources.filter(
        projectionNeedsConfiguration,
      ).length;
      const state: ExtendedSupportSnapshotState =
        coverage.status === "FAILED" || !coverage.readPermissionsValidated
          ? "CONFIGURATION_REQUIRED"
          : coverage.status === "PARTIAL"
              || configurationRequiredResources > 0
              || serviceResources.some((item) =>
                item.horizons.some((horizon) =>
                  horizon.projectionState === "PARTIAL"
                )
              )
              || serviceResources.some((item) =>
                item.observationFreshness === "STALE"
              )
            ? "PARTIAL"
            : "READY";
      return {
        service: itemService,
        state,
        coverage,
        resourceCount: serviceResources.length,
        currentlyExtendedResources: serviceResources.filter((item) =>
          item.lifecycleState === "EXTENDED_SUPPORT"
        ).length,
        endOfSupportResources: serviceResources.filter((item) =>
          item.lifecycleState === "END_OF_SUPPORT"
        ).length,
        configurationRequiredResources,
        observedActualCosts: sumCosts([...charges.values()]
          .filter((item) => item.service === itemService)
          .map((item) => ({
            currency: item.currency,
            amount: item.actualExtendedSupportCost,
          }))),
        observedActualUsage: sumUsage([...charges.values()]
          .filter((item) => item.service === itemService)
          .map((item) => ({
            unit: item.usageUnit,
            quantity: item.usageQuantity,
          }))),
        horizons: ([3, 6, 12] as const).map((months) =>
          summarizeHorizon(serviceResources, months, now)
        ),
      };
    },
  );
  const state: ExtendedSupportSnapshotState = services.some((item) =>
    item.state === "CONFIGURATION_REQUIRED"
  )
    ? "CONFIGURATION_REQUIRED"
    : services.some((item) => item.state === "PARTIAL")
      ? "PARTIAL"
      : "READY";
  const limitations = [
    "PROJECTION_IS_INCREMENTAL_EXTENDED_SUPPORT_ONLY",
    "PROJECTION_ASSUMES_RESOURCE_CONFIGURATION_AND_ENROLLMENT_DO_NOT_CHANGE",
    "ACTUAL_COST_REQUIRES_RECONCILED_CUR2_LINE_ITEMS",
    "CALENDARS_AND_PRICES_REQUIRE_PERIODIC_AUTHORITATIVE_REFRESH",
    "OPENSEARCH_NORMALIZED_INSTANCE_HOURS_REQUIRE_INSTANCE_SIZE_FACTORS",
    "ELASTICACHE_PREMIUM_REQUIRES_REGION_AND_DATE_SPECIFIC_ON_DEMAND_PRICE",
  ] as const;
  const result: ExtendedSupportProjectionSnapshot = {
    schemaVersion: "sutra.extended-support-projection.v1",
    scope: { ...captureScope },
    managementAccountId,
    partition,
    accountIds: [...accountIds],
    regions: [...regions],
    collectionId,
    collectedAt: completedAt,
    state,
    observedCostLabel: "RECONCILED_ACTUAL_EXTENDED_SUPPORT_COST",
    projectionLabel:
      "PROJECTED_INCREMENTAL_EXTENDED_SUPPORT_COST_IF_UNCHANGED",
    services,
    resources,
    sourceReferences: [...sourceMap.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
    limitations,
  };
  let outputBytes: number;
  try {
    outputBytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  } catch {
    return reject("INVALID_INPUT");
  }
  if (
    outputBytes > EXTENDED_SUPPORT_PROJECTION_BOUNDS.maximumOutputBytes
  ) reject("OUTPUT_LIMIT_EXCEEDED");
  return result;
}
