/**
 * Pure, tenant-pinned End User Computing evidence engine for Amazon
 * WorkSpaces and Amazon WorkSpaces Applications (AppStream 2.0).
 *
 * The credential-owning collector and the active CUR2 repository are outside
 * this module. The collector must remove user names, computer names, IP
 * addresses, session IDs, user IDs, instance IDs, and raw provider messages
 * before the broker boundary. This module performs no I/O, accepts no
 * credentials, and keeps no process-global tenant state.
 */
import type {
  FinopsSourceEvidence,
  FinopsSourceScope,
} from "./finops-source-health.ts";
import { FINOPS_RECONCILIATION_CURRENCIES } from "./finops-reconciliation.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const CAPTURE_ID = /^euc_[a-f0-9]{64}$/u;
const GENERATION_ID = /^fbg_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const WORKSPACE_ID = /^ws-[0-9a-z]{8,63}$/u;
const BUNDLE_ID = /^wsb-[0-9a-z]{8,63}$/u;
const APPSTREAM_ARN = /^arn:(aws|aws-us-gov|aws-cn):appstream:[a-z0-9-]+:\d{12}:(?:fleet|stack)\/.+$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/u;
const INTEGER_MICROS = /^-?(?:0|[1-9]\d{0,127})$/u;
const NON_NEGATIVE_MICROS = /^(?:0|[1-9]\d{0,127})$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

export const END_USER_COMPUTING_COLLECTION_BOUNDS = Object.freeze({
  workspacePageSize: 25,
  appStreamSessionPageSize: 50,
  generalPageSize: 25,
  cloudWatchResultPageSize: 500,
  maximumConcurrency: 4,
  maximumDurationMs: 15 * 60 * 1_000,
  maximumPages: 20_000,
  maximumAccounts: 200,
  maximumRegions: 50,
  maximumCoverageRows: 20_000,
  maximumWorkspaces: 50_000,
  maximumBundles: 10_000,
  maximumFleets: 10_000,
  maximumStacks: 10_000,
  maximumSessionAggregates: 50_000,
  maximumSessions: 1_000_000,
  maximumMetricObservations: 100_000,
  maximumCostRows: 250_000,
  maximumHistoryDays: 93,
  maximumCaptureBytes: 64 * 1_024 * 1_024,
  maximumDashboardBytes: 8 * 1_024 * 1_024,
  maximumResourcesInResponse: 5_000,
  maximumTextCharacters: 256,
  inventoryFreshnessHours: 24,
  activityFreshnessHours: 6,
  metricFreshnessHours: 6,
  costFreshnessHours: 48,
} as const);

/** Exact read-only control-plane and telemetry operations for this slice. */
export const END_USER_COMPUTING_READ_OPERATIONS = Object.freeze([
  "appstream:DescribeFleets",
  "appstream:DescribeSessions",
  "appstream:DescribeStacks",
  "appstream:ListAssociatedFleets",
  "cloudwatch:GetMetricData",
  "workspaces:DescribeWorkspaceBundles",
  "workspaces:DescribeWorkspaces",
  "workspaces:DescribeWorkspacesConnectionStatus",
] as const);

export type EndUserComputingService = "WORKSPACES" | "APPSTREAM";
export type EndUserComputingPartition = "aws" | "aws-us-gov" | "aws-cn";
export type EndUserComputingSourceStatus =
  | "COMPLETE"
  | "PARTIAL"
  | "UNAVAILABLE";
export type EndUserComputingFailureCode =
  | "ACCESS_DENIED"
  | "THROTTLED"
  | "TIMEOUT"
  | "BOUND_REACHED"
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_PAGINATION"
  | "CANONICAL_COST_UNAVAILABLE"
  | "UNKNOWN";
export type EndUserComputingState =
  | "READY"
  | "PARTIAL"
  | "STALE"
  | "UNAVAILABLE";

export interface EndUserComputingBoundary {
  readonly scope: FinopsSourceScope;
  readonly partition: EndUserComputingPartition;
  /** Sorted, unique, server-authorized AWS accounts for this connection. */
  readonly accountIds: readonly string[];
  /** Sorted, unique, server-authorized Regions for this connection. */
  readonly regions: readonly string[];
}

export interface EndUserComputingCoverage {
  readonly service: EndUserComputingService;
  readonly accountId: string;
  readonly region: string;
  readonly inventoryStatus: EndUserComputingSourceStatus;
  readonly activityStatus: EndUserComputingSourceStatus;
  readonly metricStatus: EndUserComputingSourceStatus;
  readonly costStatus: EndUserComputingSourceStatus;
  readonly inventoryObservedAt: string | null;
  readonly activityObservedAt: string | null;
  readonly metricDataThroughAt: string | null;
  readonly costDataThroughAt: string | null;
  readonly inventoryRecordCount: number;
  readonly activityRecordCount: number;
  readonly metricRecordCount: number;
  readonly costRecordCount: number;
  readonly inventoryPermissionValidated: boolean;
  readonly activityPermissionValidated: boolean;
  readonly metricPermissionValidated: boolean;
  readonly costGenerationActivated: boolean;
  /** Safe machine code only. Raw provider messages are forbidden. */
  readonly failureCode: EndUserComputingFailureCode | null;
}

export type EndUserComputingPaginatedOperation =
  | "appstream:DescribeFleets"
  | "appstream:DescribeSessions"
  | "appstream:DescribeStacks"
  | "appstream:ListAssociatedFleets"
  | "cloudwatch:GetMetricData"
  | "workspaces:DescribeWorkspaceBundles"
  | "workspaces:DescribeWorkspaces"
  | "workspaces:DescribeWorkspacesConnectionStatus";

export interface EndUserComputingPageEvidence {
  readonly requestTokenSha256: string | null;
  readonly responseNextTokenSha256: string | null;
  readonly pageSize: number;
  readonly recordCount: number;
}

export interface EndUserComputingPaginationSequence {
  readonly service: EndUserComputingService;
  readonly accountId: string;
  readonly region: string;
  readonly operation: EndUserComputingPaginatedOperation;
  /** Hash of a fleet/stack query tuple where the AWS API requires one. */
  readonly queryKeySha256: string | null;
  readonly pages: readonly EndUserComputingPageEvidence[];
  readonly exhausted: boolean;
}

export type WorkspaceState =
  | "PENDING"
  | "AVAILABLE"
  | "IMPAIRED"
  | "UNHEALTHY"
  | "REBOOTING"
  | "STARTING"
  | "REBUILDING"
  | "RESTORING"
  | "MAINTENANCE"
  | "ADMIN_MAINTENANCE"
  | "TERMINATING"
  | "TERMINATED"
  | "SUSPENDED"
  | "UPDATING"
  | "STOPPING"
  | "STOPPED"
  | "ERROR";

export interface EndUserComputingWorkspace {
  readonly accountId: string;
  readonly region: string;
  readonly workspaceId: string;
  readonly bundleId: string;
  readonly state: WorkspaceState;
  readonly runningMode: "ALWAYS_ON" | "AUTO_STOP" | "MANUAL" | "UNKNOWN";
  readonly computeType: string | null;
  readonly rootVolumeGib: number | null;
  readonly userVolumeGib: number | null;
  readonly observedAt: string;
  readonly connection: {
    readonly state: "CONNECTED" | "DISCONNECTED" | "UNKNOWN";
    readonly observedAt: string;
  } | null;
}

export interface EndUserComputingWorkspaceBundle {
  readonly accountId: string;
  readonly region: string;
  readonly bundleId: string;
  readonly owner: "AMAZON" | "ACCOUNT";
  readonly name: string;
  readonly computeType: string | null;
  readonly rootVolumeGib: number | null;
  readonly userVolumeGib: number | null;
  readonly observedAt: string;
}

export interface EndUserComputingAppStreamFleet {
  readonly accountId: string;
  readonly region: string;
  readonly fleetArn: string;
  readonly fleetName: string;
  readonly state: "STARTING" | "RUNNING" | "STOPPING" | "STOPPED";
  readonly fleetType: "ALWAYS_ON" | "ON_DEMAND" | "ELASTIC";
  readonly instanceType: string | null;
  readonly desiredCapacity: number | null;
  readonly runningCapacity: number | null;
  readonly inUseCapacity: number | null;
  readonly availableCapacity: number | null;
  readonly maxSessionsPerInstance: number | null;
  readonly observedAt: string;
}

export interface EndUserComputingAppStreamStack {
  readonly accountId: string;
  readonly region: string;
  readonly stackArn: string;
  readonly stackName: string;
  readonly associatedFleetNames: readonly string[];
  readonly observedAt: string;
}

/** Aggregated by fleet/stack before the broker. No session or user identifier. */
export interface EndUserComputingSessionAggregate {
  readonly accountId: string;
  readonly region: string;
  readonly fleetName: string;
  readonly stackName: string;
  readonly queryKeySha256: string;
  readonly observedAt: string;
  readonly active: number;
  readonly pending: number;
  readonly expired: number;
  readonly connected: number;
  readonly notConnected: number;
}

export type EndUserComputingMetricName =
  | "WORKSPACES_AVAILABLE"
  | "WORKSPACES_UNHEALTHY"
  | "WORKSPACES_CONNECTION_ATTEMPT"
  | "WORKSPACES_CONNECTION_SUCCESS"
  | "WORKSPACES_CONNECTION_FAILURE"
  | "WORKSPACES_SESSION_LAUNCH_TIME"
  | "WORKSPACES_IN_SESSION_LATENCY"
  | "WORKSPACES_SESSION_DISCONNECT"
  | "APPSTREAM_IN_USE_CAPACITY"
  | "APPSTREAM_AVAILABLE_CAPACITY"
  | "APPSTREAM_DESIRED_CAPACITY"
  | "APPSTREAM_ACTUAL_CAPACITY"
  | "APPSTREAM_CAPACITY_UTILIZATION"
  | "APPSTREAM_INSUFFICIENT_CAPACITY_ERROR"
  | "APPSTREAM_CPU_UTILIZATION_INSTANCE"
  | "APPSTREAM_MEMORY_UTILIZATION_INSTANCE"
  | "APPSTREAM_PAGING_FILE_UTILIZATION_INSTANCE"
  | "APPSTREAM_DISK_UTILIZATION_INSTANCE"
  | "APPSTREAM_CPU_UTILIZATION_SESSION"
  | "APPSTREAM_MEMORY_UTILIZATION_SESSION";

export interface EndUserComputingMetricObservation {
  readonly service: EndUserComputingService;
  readonly accountId: string;
  readonly region: string;
  readonly resourceScope: "SERVICE" | "RESOURCE" | "FLEET";
  /** WorkSpace ID or fleet name. Never an AppStream session/instance/user ID. */
  readonly resourceId: string | null;
  readonly metricName: EndUserComputingMetricName;
  readonly statistic: "SUM" | "AVERAGE" | "MAXIMUM";
  readonly unit: "COUNT" | "PERCENT" | "SECONDS" | "MILLISECONDS";
  readonly valueMicros: string;
  readonly sampleCount: number;
  readonly windowStartAt: string;
  readonly windowEndAt: string;
  readonly dataThroughAt: string;
  readonly completeWindow: boolean;
  readonly source: "CLOUDWATCH_GET_METRIC_DATA";
  readonly privacyScope:
    | "NO_USER_DIMENSION"
    | "NO_USER_SESSION_OR_INSTANCE_DIMENSION";
}

export type EndUserComputingCostBasis =
  | "unblended"
  | "net"
  | "amortized"
  | "list"
  | "contracted"
  | "public";

export interface EndUserComputingBillingEvidence {
  readonly generationId: string;
  readonly billingPeriod: string;
  readonly sourceEvidenceId: string;
  readonly manifestSha256: string;
  readonly sourceUpdatedAt: string;
  readonly committedAt: string;
  readonly sourceFormat: "aws-cur";
  readonly sourceVersion: "2.0";
  readonly reconciled: true;
  readonly activeGenerationRowCount: number;
  readonly matchedLineItemCount: number;
}

/** Privacy-minimized projection of one canonical CUR2 line. */
export interface EndUserComputingCostLine {
  readonly lineItemId: string;
  readonly service: EndUserComputingService;
  readonly accountId: string;
  readonly region: string;
  readonly resourceId: string | null;
  readonly usageStartAt: string;
  readonly usageEndAt: string | null;
  readonly currency: string;
  readonly amountsMicros: Readonly<Record<EndUserComputingCostBasis, string | null>>;
  readonly usageAmountMicros: string | null;
  readonly usageUnit: string | null;
  readonly commitmentClass:
    | "RESERVED"
    | "SAVINGS_PLAN"
    | "SPOT"
    | "ON_DEMAND"
    | "UNCLASSIFIED";
}

export interface EndUserComputingCapture {
  readonly schemaVersion: "sutra.end-user-computing.v1";
  readonly scope: FinopsSourceScope;
  readonly partition: EndUserComputingPartition;
  readonly accountIds: readonly string[];
  readonly regions: readonly string[];
  readonly captureId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly execution: {
    readonly concurrencyLimit: 4;
    readonly observedPeakConcurrency: number;
    readonly pageCount: number;
  };
  readonly coverage: readonly EndUserComputingCoverage[];
  readonly pagination: readonly EndUserComputingPaginationSequence[];
  readonly workspaces: readonly EndUserComputingWorkspace[];
  readonly workspaceBundles: readonly EndUserComputingWorkspaceBundle[];
  readonly appStreamFleets: readonly EndUserComputingAppStreamFleet[];
  readonly appStreamStacks: readonly EndUserComputingAppStreamStack[];
  readonly appStreamSessions: readonly EndUserComputingSessionAggregate[];
  readonly metrics: readonly EndUserComputingMetricObservation[];
  readonly billingEvidence: EndUserComputingBillingEvidence | null;
  readonly costs: readonly EndUserComputingCostLine[];
}

export type EndUserComputingEngineErrorCode =
  | "INVALID_INPUT"
  | "SCOPE_MISMATCH"
  | "INVALID_PAGINATION"
  | "CONFLICTING_DUPLICATE"
  | "RECORD_BOUND_EXCEEDED"
  | "BYTE_BOUND_EXCEEDED"
  | "TIME_BOUND_EXCEEDED"
  | "RESPONSE_BOUND_EXCEEDED";

export class EndUserComputingEngineError extends Error {
  public readonly code: EndUserComputingEngineErrorCode;
  public constructor(code: EndUserComputingEngineErrorCode) {
    super("The End User Computing evidence is invalid");
    this.name = "EndUserComputingEngineError";
    this.code = code;
  }
}

const SERVICES = ["APPSTREAM", "WORKSPACES"] as const;
const SERVICE_SET = new Set<string>(SERVICES);
const PARTITIONS = new Set<string>(["aws", "aws-cn", "aws-us-gov"]);
const SOURCE_STATUSES = new Set<string>(["COMPLETE", "PARTIAL", "UNAVAILABLE"]);
const FAILURE_CODES = new Set<string>([
  "ACCESS_DENIED", "THROTTLED", "TIMEOUT", "BOUND_REACHED",
  "PROVIDER_UNAVAILABLE", "INVALID_PAGINATION",
  "CANONICAL_COST_UNAVAILABLE", "UNKNOWN",
]);
const WORKSPACE_STATES = new Set<string>([
  "PENDING", "AVAILABLE", "IMPAIRED", "UNHEALTHY", "REBOOTING",
  "STARTING", "REBUILDING", "RESTORING", "MAINTENANCE",
  "ADMIN_MAINTENANCE", "TERMINATING", "TERMINATED", "SUSPENDED",
  "UPDATING", "STOPPING", "STOPPED", "ERROR",
]);
const RUNNING_MODES = new Set<string>(["ALWAYS_ON", "AUTO_STOP", "MANUAL", "UNKNOWN"]);
const APPSTREAM_STATES = new Set<string>(["STARTING", "RUNNING", "STOPPING", "STOPPED"]);
const APPSTREAM_FLEET_TYPES = new Set<string>(["ALWAYS_ON", "ON_DEMAND", "ELASTIC"]);
const METRICS_BY_SERVICE: Readonly<Record<EndUserComputingService, readonly EndUserComputingMetricName[]>> = Object.freeze({
  WORKSPACES: [
    "WORKSPACES_AVAILABLE", "WORKSPACES_UNHEALTHY",
    "WORKSPACES_CONNECTION_ATTEMPT", "WORKSPACES_CONNECTION_SUCCESS",
    "WORKSPACES_CONNECTION_FAILURE", "WORKSPACES_SESSION_LAUNCH_TIME",
    "WORKSPACES_IN_SESSION_LATENCY", "WORKSPACES_SESSION_DISCONNECT",
  ],
  APPSTREAM: [
    "APPSTREAM_IN_USE_CAPACITY", "APPSTREAM_AVAILABLE_CAPACITY",
    "APPSTREAM_DESIRED_CAPACITY", "APPSTREAM_ACTUAL_CAPACITY",
    "APPSTREAM_CAPACITY_UTILIZATION", "APPSTREAM_INSUFFICIENT_CAPACITY_ERROR",
    "APPSTREAM_CPU_UTILIZATION_INSTANCE", "APPSTREAM_MEMORY_UTILIZATION_INSTANCE",
    "APPSTREAM_PAGING_FILE_UTILIZATION_INSTANCE", "APPSTREAM_DISK_UTILIZATION_INSTANCE",
    "APPSTREAM_CPU_UTILIZATION_SESSION", "APPSTREAM_MEMORY_UTILIZATION_SESSION",
  ],
});
const ALL_METRICS = new Set<string>(Object.values(METRICS_BY_SERVICE).flat());
const PERFORMANCE_METRICS = new Set<EndUserComputingMetricName>([
  "WORKSPACES_SESSION_LAUNCH_TIME", "WORKSPACES_IN_SESSION_LATENCY",
  "APPSTREAM_CPU_UTILIZATION_INSTANCE", "APPSTREAM_MEMORY_UTILIZATION_INSTANCE",
  "APPSTREAM_PAGING_FILE_UTILIZATION_INSTANCE", "APPSTREAM_DISK_UTILIZATION_INSTANCE",
  "APPSTREAM_CPU_UTILIZATION_SESSION", "APPSTREAM_MEMORY_UTILIZATION_SESSION",
]);
const COST_BASES = ["unblended", "net", "amortized", "list", "contracted", "public"] as const;
const PAGINATION_SERVICE: Readonly<Record<EndUserComputingPaginatedOperation, EndUserComputingService | "BOTH">> = Object.freeze({
  "appstream:DescribeFleets": "APPSTREAM",
  "appstream:DescribeSessions": "APPSTREAM",
  "appstream:DescribeStacks": "APPSTREAM",
  "appstream:ListAssociatedFleets": "APPSTREAM",
  "cloudwatch:GetMetricData": "BOTH",
  "workspaces:DescribeWorkspaceBundles": "WORKSPACES",
  "workspaces:DescribeWorkspaces": "WORKSPACES",
  "workspaces:DescribeWorkspacesConnectionStatus": "WORKSPACES",
});
const PAGE_SIZE: Readonly<Record<EndUserComputingPaginatedOperation, number>> = Object.freeze({
  "appstream:DescribeFleets": 25,
  "appstream:DescribeSessions": 50,
  "appstream:DescribeStacks": 25,
  "appstream:ListAssociatedFleets": 25,
  "cloudwatch:GetMetricData": 500,
  "workspaces:DescribeWorkspaceBundles": 25,
  "workspaces:DescribeWorkspaces": 25,
  "workspaces:DescribeWorkspacesConnectionStatus": 25,
});

function reject(code: EndUserComputingEngineErrorCode): never {
  throw new EndUserComputingEngineError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) reject("INVALID_INPUT");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) reject("INVALID_INPUT");
  return value;
}

function text(
  value: unknown,
  maximum: number = END_USER_COMPUTING_COLLECTION_BOUNDS.maximumTextCharacters,
): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > maximum
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)
  ) reject("INVALID_INPUT");
  return value;
}

function timestamp(value: unknown, maximumMs: number): string {
  const result = text(value, 40);
  const milliseconds = Date.parse(result);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== result || milliseconds > maximumMs) {
    reject("INVALID_INPUT");
  }
  return result;
}

function nullableTimestamp(value: unknown, maximumMs: number): string | null {
  return value === null ? null : timestamp(value, maximumMs);
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    reject("INVALID_INPUT");
  }
  return value as number;
}

function nullableInteger(value: unknown, minimum: number, maximum: number): number | null {
  return value === null ? null : integer(value, minimum, maximum);
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") reject("INVALID_INPUT");
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<string>): T {
  if (typeof value !== "string" || !allowed.has(value)) reject("INVALID_INPUT");
  return value as T;
}

function micros(value: unknown, allowNegative = true): string {
  const result = text(value, 129);
  if (!(allowNegative ? INTEGER_MICROS : NON_NEGATIVE_MICROS).test(result)) reject("INVALID_INPUT");
  return result;
}

function nullableMicros(value: unknown, allowNegative = true): string | null {
  return value === null ? null : micros(value, allowNegative);
}

function encodedBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    reject("INVALID_INPUT");
  }
}

function sourceScope(value: unknown): FinopsSourceScope {
  const record = exact(value, ["orgId", "customerId", "connectionId"]);
  const orgId = text(record.orgId);
  const customerId = text(record.customerId);
  const connectionId = text(record.connectionId, 37);
  if (!IDENTIFIER.test(orgId) || !IDENTIFIER.test(customerId) || !CONNECTION_ID.test(connectionId)) {
    reject("INVALID_INPUT");
  }
  return { orgId, customerId, connectionId };
}

function sortedUniqueStrings(
  value: unknown,
  maximum: number,
  validate: (entry: string) => boolean,
): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) reject("INVALID_INPUT");
  if (!value.every((entry) => typeof entry === "string" && validate(entry))) reject("INVALID_INPUT");
  const result = [...new Set(value)].sort();
  if (result.length !== value.length || JSON.stringify(result) !== JSON.stringify(value)) reject("INVALID_INPUT");
  return result;
}

function parseBoundary(value: unknown): EndUserComputingBoundary {
  const record = exact(value, ["scope", "partition", "accountIds", "regions"]);
  const partition = enumValue<EndUserComputingPartition>(record.partition, PARTITIONS);
  return {
    scope: sourceScope(record.scope),
    partition,
    accountIds: sortedUniqueStrings(record.accountIds, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumAccounts, (entry) => ACCOUNT_ID.test(entry)),
    regions: sortedUniqueStrings(record.regions, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumRegions, (entry) => REGION.test(entry)),
  };
}

function sameScope(left: FinopsSourceScope, right: FinopsSourceScope): boolean {
  return left.orgId === right.orgId && left.customerId === right.customerId && left.connectionId === right.connectionId;
}

function inBoundary(accountId: string, region: string, boundary: EndUserComputingBoundary): void {
  if (!boundary.accountIds.includes(accountId) || !boundary.regions.includes(region)) reject("SCOPE_MISMATCH");
}

function parseAccountRegion(value: Readonly<Record<string, unknown>>, boundary: EndUserComputingBoundary): { accountId: string; region: string } {
  const accountId = text(value.accountId, 12);
  const region = text(value.region, 32);
  if (!ACCOUNT_ID.test(accountId) || !REGION.test(region)) reject("INVALID_INPUT");
  inBoundary(accountId, region, boundary);
  return { accountId, region };
}

function parseStatus(value: unknown): EndUserComputingSourceStatus {
  return enumValue<EndUserComputingSourceStatus>(value, SOURCE_STATUSES);
}

function parseCoverage(value: unknown, boundary: EndUserComputingBoundary, maximumMs: number): EndUserComputingCoverage {
  const record = exact(value, [
    "service", "accountId", "region", "inventoryStatus", "activityStatus",
    "metricStatus", "costStatus", "inventoryObservedAt", "activityObservedAt",
    "metricDataThroughAt", "costDataThroughAt", "inventoryRecordCount",
    "activityRecordCount", "metricRecordCount", "costRecordCount",
    "inventoryPermissionValidated", "activityPermissionValidated",
    "metricPermissionValidated", "costGenerationActivated", "failureCode",
  ]);
  const service = enumValue<EndUserComputingService>(record.service, SERVICE_SET);
  const { accountId, region } = parseAccountRegion(record, boundary);
  const inventoryStatus = parseStatus(record.inventoryStatus);
  const activityStatus = parseStatus(record.activityStatus);
  const metricStatus = parseStatus(record.metricStatus);
  const costStatus = parseStatus(record.costStatus);
  const inventoryObservedAt = nullableTimestamp(record.inventoryObservedAt, maximumMs);
  const activityObservedAt = nullableTimestamp(record.activityObservedAt, maximumMs);
  const metricDataThroughAt = nullableTimestamp(record.metricDataThroughAt, maximumMs);
  const costDataThroughAt = nullableTimestamp(record.costDataThroughAt, maximumMs);
  const inventoryPermissionValidated = boolean(record.inventoryPermissionValidated);
  const activityPermissionValidated = boolean(record.activityPermissionValidated);
  const metricPermissionValidated = boolean(record.metricPermissionValidated);
  const costGenerationActivated = boolean(record.costGenerationActivated);
  const failureCode = record.failureCode === null
    ? null
    : enumValue<EndUserComputingFailureCode>(record.failureCode, FAILURE_CODES);
  const statuses = [inventoryStatus, activityStatus, metricStatus, costStatus];
  if (statuses.every((status) => status === "COMPLETE") && failureCode !== null) reject("INVALID_INPUT");
  if (statuses.some((status) => status !== "COMPLETE") && failureCode === null) reject("INVALID_INPUT");
  if (inventoryStatus === "COMPLETE" && (!inventoryPermissionValidated || inventoryObservedAt === null)) reject("INVALID_INPUT");
  if (activityStatus === "COMPLETE" && (!activityPermissionValidated || activityObservedAt === null)) reject("INVALID_INPUT");
  if (metricStatus === "COMPLETE" && (!metricPermissionValidated || metricDataThroughAt === null)) reject("INVALID_INPUT");
  if (costStatus === "COMPLETE" && (!costGenerationActivated || costDataThroughAt === null)) reject("INVALID_INPUT");
  return {
    service, accountId, region, inventoryStatus, activityStatus, metricStatus,
    costStatus, inventoryObservedAt, activityObservedAt, metricDataThroughAt,
    costDataThroughAt,
    inventoryRecordCount: integer(record.inventoryRecordCount, 0, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumWorkspaces + END_USER_COMPUTING_COLLECTION_BOUNDS.maximumFleets + END_USER_COMPUTING_COLLECTION_BOUNDS.maximumStacks),
    activityRecordCount: integer(record.activityRecordCount, 0, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumSessions),
    metricRecordCount: integer(record.metricRecordCount, 0, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumMetricObservations),
    costRecordCount: integer(record.costRecordCount, 0, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumCostRows),
    inventoryPermissionValidated, activityPermissionValidated,
    metricPermissionValidated, costGenerationActivated, failureCode,
  };
}

function parsePagination(value: unknown, boundary: EndUserComputingBoundary): EndUserComputingPaginationSequence {
  const record = exact(value, ["service", "accountId", "region", "operation", "queryKeySha256", "pages", "exhausted"]);
  const service = enumValue<EndUserComputingService>(record.service, SERVICE_SET);
  const { accountId, region } = parseAccountRegion(record, boundary);
  const operation = text(record.operation, 64) as EndUserComputingPaginatedOperation;
  if (!(operation in PAGINATION_SERVICE) || (PAGINATION_SERVICE[operation] !== "BOTH" && PAGINATION_SERVICE[operation] !== service)) {
    reject("INVALID_INPUT");
  }
  const queryKeySha256 = record.queryKeySha256 === null ? null : text(record.queryKeySha256, 64);
  if (queryKeySha256 !== null && !SHA256.test(queryKeySha256)) reject("INVALID_INPUT");
  if ((operation === "appstream:DescribeSessions" || operation === "appstream:ListAssociatedFleets") !== (queryKeySha256 !== null)) {
    reject("INVALID_INPUT");
  }
  if (!Array.isArray(record.pages) || record.pages.length < 1 || record.pages.length > END_USER_COMPUTING_COLLECTION_BOUNDS.maximumPages) {
    reject("INVALID_PAGINATION");
  }
  const usedRequests = new Set<string>();
  const emittedTokens = new Set<string>();
  let expected: string | null = null;
  const pages = record.pages.map((entry): EndUserComputingPageEvidence => {
    const page = exact(entry, ["requestTokenSha256", "responseNextTokenSha256", "pageSize", "recordCount"]);
    const request = page.requestTokenSha256 === null ? null : text(page.requestTokenSha256, 64);
    const next = page.responseNextTokenSha256 === null ? null : text(page.responseNextTokenSha256, 64);
    if ((request !== null && !SHA256.test(request)) || (next !== null && !SHA256.test(next)) || request !== expected) {
      reject("INVALID_PAGINATION");
    }
    if (request !== null && usedRequests.has(request)) reject("INVALID_PAGINATION");
    if (next !== null && (next === request || emittedTokens.has(next))) reject("INVALID_PAGINATION");
    if (request !== null) usedRequests.add(request);
    if (next !== null) emittedTokens.add(next);
    const pageSize = integer(page.pageSize, 1, PAGE_SIZE[operation]);
    const recordCount = integer(page.recordCount, 0, pageSize);
    expected = next;
    return { requestTokenSha256: request, responseNextTokenSha256: next, pageSize, recordCount };
  });
  const exhausted = boolean(record.exhausted);
  if (exhausted !== (expected === null)) reject("INVALID_PAGINATION");
  return { service, accountId, region, operation, queryKeySha256, pages, exhausted };
}

function nullableText(value: unknown, maximum = 128): string | null {
  return value === null ? null : text(value, maximum);
}

function parseWorkspace(value: unknown, boundary: EndUserComputingBoundary, maximumMs: number): EndUserComputingWorkspace {
  const record = exact(value, ["accountId", "region", "workspaceId", "bundleId", "state", "runningMode", "computeType", "rootVolumeGib", "userVolumeGib", "observedAt", "connection"]);
  const { accountId, region } = parseAccountRegion(record, boundary);
  const workspaceId = text(record.workspaceId, 66);
  const bundleId = text(record.bundleId, 67);
  if (!WORKSPACE_ID.test(workspaceId) || !BUNDLE_ID.test(bundleId)) reject("INVALID_INPUT");
  let connection: EndUserComputingWorkspace["connection"] = null;
  if (record.connection !== null) {
    const item = exact(record.connection, ["state", "observedAt"]);
    connection = {
      state: enumValue(item.state, new Set(["CONNECTED", "DISCONNECTED", "UNKNOWN"])),
      observedAt: timestamp(item.observedAt, maximumMs),
    };
  }
  return {
    accountId, region, workspaceId, bundleId,
    state: enumValue(record.state, WORKSPACE_STATES),
    runningMode: enumValue(record.runningMode, RUNNING_MODES),
    computeType: nullableText(record.computeType),
    rootVolumeGib: nullableInteger(record.rootVolumeGib, 0, 65_536),
    userVolumeGib: nullableInteger(record.userVolumeGib, 0, 65_536),
    observedAt: timestamp(record.observedAt, maximumMs), connection,
  };
}

function parseBundle(value: unknown, boundary: EndUserComputingBoundary, maximumMs: number): EndUserComputingWorkspaceBundle {
  const record = exact(value, ["accountId", "region", "bundleId", "owner", "name", "computeType", "rootVolumeGib", "userVolumeGib", "observedAt"]);
  const { accountId, region } = parseAccountRegion(record, boundary);
  const bundleId = text(record.bundleId, 67);
  if (!BUNDLE_ID.test(bundleId)) reject("INVALID_INPUT");
  return {
    accountId, region, bundleId,
    owner: enumValue(record.owner, new Set(["AMAZON", "ACCOUNT"])),
    name: text(record.name), computeType: nullableText(record.computeType),
    rootVolumeGib: nullableInteger(record.rootVolumeGib, 0, 65_536),
    userVolumeGib: nullableInteger(record.userVolumeGib, 0, 65_536),
    observedAt: timestamp(record.observedAt, maximumMs),
  };
}

function parseFleet(value: unknown, boundary: EndUserComputingBoundary, maximumMs: number): EndUserComputingAppStreamFleet {
  const record = exact(value, ["accountId", "region", "fleetArn", "fleetName", "state", "fleetType", "instanceType", "desiredCapacity", "runningCapacity", "inUseCapacity", "availableCapacity", "maxSessionsPerInstance", "observedAt"]);
  const { accountId, region } = parseAccountRegion(record, boundary);
  const fleetArn = text(record.fleetArn, 512);
  const fleetName = text(record.fleetName, 101);
  if (!APPSTREAM_ARN.test(fleetArn) || !SAFE_NAME.test(fleetName) || !fleetArn.includes(`:${region}:${accountId}:fleet/`)) reject("INVALID_INPUT");
  return {
    accountId, region, fleetArn, fleetName,
    state: enumValue(record.state, APPSTREAM_STATES),
    fleetType: enumValue(record.fleetType, APPSTREAM_FLEET_TYPES),
    instanceType: nullableText(record.instanceType),
    desiredCapacity: nullableInteger(record.desiredCapacity, 0, 1_000_000),
    runningCapacity: nullableInteger(record.runningCapacity, 0, 1_000_000),
    inUseCapacity: nullableInteger(record.inUseCapacity, 0, 1_000_000),
    availableCapacity: nullableInteger(record.availableCapacity, 0, 1_000_000),
    maxSessionsPerInstance: nullableInteger(record.maxSessionsPerInstance, 1, 1_000),
    observedAt: timestamp(record.observedAt, maximumMs),
  };
}

function sortedNames(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 10_000 || !value.every((entry) => typeof entry === "string" && SAFE_NAME.test(entry))) reject("INVALID_INPUT");
  const result = [...new Set(value)].sort();
  if (result.length !== value.length || JSON.stringify(result) !== JSON.stringify(value)) reject("INVALID_INPUT");
  return result;
}

function parseStack(value: unknown, boundary: EndUserComputingBoundary, maximumMs: number): EndUserComputingAppStreamStack {
  const record = exact(value, ["accountId", "region", "stackArn", "stackName", "associatedFleetNames", "observedAt"]);
  const { accountId, region } = parseAccountRegion(record, boundary);
  const stackArn = text(record.stackArn, 512);
  const stackName = text(record.stackName, 101);
  if (!APPSTREAM_ARN.test(stackArn) || !SAFE_NAME.test(stackName) || !stackArn.includes(`:${region}:${accountId}:stack/`)) reject("INVALID_INPUT");
  return { accountId, region, stackArn, stackName, associatedFleetNames: sortedNames(record.associatedFleetNames), observedAt: timestamp(record.observedAt, maximumMs) };
}

function parseSessions(value: unknown, boundary: EndUserComputingBoundary, maximumMs: number): EndUserComputingSessionAggregate {
  const record = exact(value, ["accountId", "region", "fleetName", "stackName", "queryKeySha256", "observedAt", "active", "pending", "expired", "connected", "notConnected"]);
  const { accountId, region } = parseAccountRegion(record, boundary);
  const fleetName = text(record.fleetName, 101);
  const stackName = text(record.stackName, 101);
  const queryKeySha256 = text(record.queryKeySha256, 64);
  if (!SAFE_NAME.test(fleetName) || !SAFE_NAME.test(stackName) || !SHA256.test(queryKeySha256)) reject("INVALID_INPUT");
  const active = integer(record.active, 0, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumSessions);
  const pending = integer(record.pending, 0, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumSessions);
  const expired = integer(record.expired, 0, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumSessions);
  const connected = integer(record.connected, 0, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumSessions);
  const notConnected = integer(record.notConnected, 0, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumSessions);
  if (active + pending + expired !== connected + notConnected || active + pending + expired > END_USER_COMPUTING_COLLECTION_BOUNDS.maximumSessions) reject("INVALID_INPUT");
  return { accountId, region, fleetName, stackName, queryKeySha256, observedAt: timestamp(record.observedAt, maximumMs), active, pending, expired, connected, notConnected };
}

function expectedMetricUnit(metric: EndUserComputingMetricName): EndUserComputingMetricObservation["unit"] {
  if (metric.endsWith("UTILIZATION") || metric.includes("_UTILIZATION_")) return "PERCENT";
  if (metric === "WORKSPACES_SESSION_LAUNCH_TIME") return "SECONDS";
  if (metric === "WORKSPACES_IN_SESSION_LATENCY") return "MILLISECONDS";
  return "COUNT";
}

function parseMetric(value: unknown, boundary: EndUserComputingBoundary, maximumMs: number): EndUserComputingMetricObservation {
  const record = exact(value, ["service", "accountId", "region", "resourceScope", "resourceId", "metricName", "statistic", "unit", "valueMicros", "sampleCount", "windowStartAt", "windowEndAt", "dataThroughAt", "completeWindow", "source", "privacyScope"]);
  const service = enumValue<EndUserComputingService>(record.service, SERVICE_SET);
  const { accountId, region } = parseAccountRegion(record, boundary);
  const metricName = enumValue<EndUserComputingMetricName>(record.metricName, ALL_METRICS);
  if (!METRICS_BY_SERVICE[service].includes(metricName)) reject("INVALID_INPUT");
  const resourceScope = enumValue<EndUserComputingMetricObservation["resourceScope"]>(record.resourceScope, new Set(["SERVICE", "RESOURCE", "FLEET"]));
  const resourceId = nullableText(record.resourceId, 128);
  if (service === "WORKSPACES" && resourceScope === "RESOURCE" && (resourceId === null || !WORKSPACE_ID.test(resourceId))) reject("INVALID_INPUT");
  if (service === "APPSTREAM" && resourceScope === "FLEET" && (resourceId === null || !SAFE_NAME.test(resourceId))) reject("INVALID_INPUT");
  if (resourceScope === "SERVICE" && resourceId !== null) reject("INVALID_INPUT");
  if (service === "WORKSPACES" && resourceScope === "FLEET" || service === "APPSTREAM" && resourceScope === "RESOURCE") reject("INVALID_INPUT");
  const unit = enumValue<EndUserComputingMetricObservation["unit"]>(record.unit, new Set(["COUNT", "PERCENT", "SECONDS", "MILLISECONDS"]));
  if (unit !== expectedMetricUnit(metricName)) reject("INVALID_INPUT");
  const privacyScope = enumValue<EndUserComputingMetricObservation["privacyScope"]>(record.privacyScope, new Set(["NO_USER_DIMENSION", "NO_USER_SESSION_OR_INSTANCE_DIMENSION"]));
  if (service === "WORKSPACES" && privacyScope !== "NO_USER_DIMENSION" || service === "APPSTREAM" && privacyScope !== "NO_USER_SESSION_OR_INSTANCE_DIMENSION") reject("INVALID_INPUT");
  const windowStartAt = timestamp(record.windowStartAt, maximumMs);
  const windowEndAt = timestamp(record.windowEndAt, maximumMs);
  const dataThroughAt = timestamp(record.dataThroughAt, maximumMs);
  if (Date.parse(windowStartAt) >= Date.parse(windowEndAt) || Date.parse(dataThroughAt) < Date.parse(windowStartAt) || Date.parse(dataThroughAt) > Date.parse(windowEndAt)) reject("INVALID_INPUT");
  if (Date.parse(windowEndAt) - Date.parse(windowStartAt) > END_USER_COMPUTING_COLLECTION_BOUNDS.maximumHistoryDays * 24 * HOUR_MS) reject("INVALID_INPUT");
  const valueMicros = micros(record.valueMicros, false);
  const maximumMetricMicros = unit === "PERCENT"
    ? BigInt("100000000")
    : unit === "SECONDS"
    ? BigInt("86400000000")
    : unit === "MILLISECONDS"
    ? BigInt("3600000000000")
    : BigInt("1000000000000000000");
  if (BigInt(valueMicros) > maximumMetricMicros) reject("INVALID_INPUT");
  return {
    service, accountId, region, resourceScope, resourceId, metricName,
    statistic: enumValue(record.statistic, new Set(["SUM", "AVERAGE", "MAXIMUM"])),
    unit, valueMicros,
    sampleCount: integer(record.sampleCount, 1, 100_000_000),
    windowStartAt, windowEndAt, dataThroughAt,
    completeWindow: boolean(record.completeWindow),
    source: enumValue(record.source, new Set(["CLOUDWATCH_GET_METRIC_DATA"])),
    privacyScope,
  };
}

function parseBillingEvidence(value: unknown, maximumMs: number): EndUserComputingBillingEvidence | null {
  if (value === null) return null;
  const record = exact(value, ["generationId", "billingPeriod", "sourceEvidenceId", "manifestSha256", "sourceUpdatedAt", "committedAt", "sourceFormat", "sourceVersion", "reconciled", "activeGenerationRowCount", "matchedLineItemCount"]);
  const generationId = text(record.generationId, 68);
  const billingPeriod = text(record.billingPeriod, 7);
  const manifestSha256 = text(record.manifestSha256, 64);
  if (!GENERATION_ID.test(generationId) || !PERIOD.test(billingPeriod) || !SHA256.test(manifestSha256) || record.sourceFormat !== "aws-cur" || record.sourceVersion !== "2.0" || record.reconciled !== true) reject("INVALID_INPUT");
  const sourceUpdatedAt = timestamp(record.sourceUpdatedAt, maximumMs);
  const committedAt = timestamp(record.committedAt, maximumMs);
  if (Date.parse(committedAt) < Date.parse(sourceUpdatedAt)) reject("INVALID_INPUT");
  const activeGenerationRowCount = integer(record.activeGenerationRowCount, 0, 10_000_000);
  const matchedLineItemCount = integer(record.matchedLineItemCount, 0, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumCostRows);
  if (matchedLineItemCount > activeGenerationRowCount) reject("INVALID_INPUT");
  return { generationId, billingPeriod, sourceEvidenceId: text(record.sourceEvidenceId, 1_024), manifestSha256, sourceUpdatedAt, committedAt, sourceFormat: "aws-cur", sourceVersion: "2.0", reconciled: true, activeGenerationRowCount, matchedLineItemCount };
}

function parseCost(value: unknown, boundary: EndUserComputingBoundary, maximumMs: number): EndUserComputingCostLine {
  const record = exact(value, ["lineItemId", "service", "accountId", "region", "resourceId", "usageStartAt", "usageEndAt", "currency", "amountsMicros", "usageAmountMicros", "usageUnit", "commitmentClass"]);
  const service = enumValue<EndUserComputingService>(record.service, SERVICE_SET);
  const { accountId, region } = parseAccountRegion(record, boundary);
  const amountRecord = exact(record.amountsMicros, COST_BASES);
  const amountsMicros = Object.fromEntries(COST_BASES.map((basis) => [basis, nullableMicros(amountRecord[basis])])) as unknown as Record<EndUserComputingCostBasis, string | null>;
  if (amountsMicros.unblended === null) reject("INVALID_INPUT");
  const usageStartAt = timestamp(record.usageStartAt, maximumMs);
  const usageEndAt = nullableTimestamp(record.usageEndAt, maximumMs);
  if (usageEndAt !== null && Date.parse(usageEndAt) <= Date.parse(usageStartAt)) reject("INVALID_INPUT");
  if (
    maximumMs - Date.parse(usageStartAt)
      > END_USER_COMPUTING_COLLECTION_BOUNDS.maximumHistoryDays * 24 * HOUR_MS
  ) reject("INVALID_INPUT");
  const currency = text(record.currency, 3);
  if (
    !CURRENCY.test(currency)
    || !(FINOPS_RECONCILIATION_CURRENCIES as ReadonlySet<string>).has(currency)
  ) reject("INVALID_INPUT");
  const resourceId = nullableText(record.resourceId, 512);
  if (
    resourceId !== null
    && (
      service === "WORKSPACES"
        ? !WORKSPACE_ID.test(resourceId)
        : !SAFE_NAME.test(resourceId) && !APPSTREAM_ARN.test(resourceId)
    )
  ) reject("INVALID_INPUT");
  return {
    lineItemId: text(record.lineItemId, 512), service, accountId, region,
    resourceId, usageStartAt, usageEndAt, currency, amountsMicros,
    usageAmountMicros: nullableMicros(record.usageAmountMicros),
    usageUnit: nullableText(record.usageUnit),
    commitmentClass: enumValue(record.commitmentClass, new Set(["RESERVED", "SAVINGS_PLAN", "SPOT", "ON_DEMAND", "UNCLASSIFIED"])),
  };
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function dedupe<T>(values: readonly T[], key: (value: T) => string): readonly T[] {
  const output = new Map<string, T>();
  for (const value of values) {
    const identity = key(value);
    const existing = output.get(identity);
    if (existing !== undefined && stable(existing) !== stable(value)) reject("CONFLICTING_DUPLICATE");
    output.set(identity, value);
  }
  return [...output.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}

function array<T>(value: unknown, maximum: number, parse: (entry: unknown) => T): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum) reject("RECORD_BOUND_EXCEEDED");
  return value.map(parse);
}

export interface EndUserComputingFreshness {
  readonly inventory: "CURRENT" | "STALE" | "UNKNOWN";
  readonly activity: "CURRENT" | "STALE" | "UNKNOWN";
  readonly metrics: "CURRENT" | "STALE" | "UNKNOWN";
  readonly costs: "CURRENT" | "STALE" | "UNKNOWN";
}

export interface EndUserComputingSnapshot {
  readonly schemaVersion: "sutra.end-user-computing.v1";
  readonly scope: FinopsSourceScope;
  readonly partition: EndUserComputingPartition;
  readonly accountIds: readonly string[];
  readonly regions: readonly string[];
  readonly captureId: string;
  readonly observedAt: string;
  readonly state: EndUserComputingState;
  readonly freshness: EndUserComputingFreshness;
  readonly coverage: readonly EndUserComputingCoverage[];
  readonly paginationSequenceCount: number;
  readonly workspaces: readonly EndUserComputingWorkspace[];
  readonly workspaceBundles: readonly EndUserComputingWorkspaceBundle[];
  readonly appStreamFleets: readonly EndUserComputingAppStreamFleet[];
  readonly appStreamStacks: readonly EndUserComputingAppStreamStack[];
  readonly appStreamSessions: readonly EndUserComputingSessionAggregate[];
  readonly metrics: readonly EndUserComputingMetricObservation[];
  readonly billingEvidence: EndUserComputingBillingEvidence | null;
  readonly costs: readonly EndUserComputingCostLine[];
  readonly limitations: readonly string[];
}

function freshness(values: readonly (string | null)[], nowMs: number, hours: number): "CURRENT" | "STALE" | "UNKNOWN" {
  const present = values.filter((value): value is string => value !== null);
  if (present.length === 0) return "UNKNOWN";
  const oldest = Math.min(...present.map(Date.parse));
  return nowMs - oldest > hours * HOUR_MS ? "STALE" : "CURRENT";
}

function requireCompletePagination(
  coverage: readonly EndUserComputingCoverage[],
  pagination: readonly EndUserComputingPaginationSequence[],
  stacks: readonly EndUserComputingAppStreamStack[],
  sessions: readonly EndUserComputingSessionAggregate[],
): void {
  const has = (row: EndUserComputingCoverage, operation: EndUserComputingPaginatedOperation, queryKey: string | null = null) =>
    pagination.some((sequence) => sequence.service === row.service && sequence.accountId === row.accountId && sequence.region === row.region && sequence.operation === operation && sequence.queryKeySha256 === queryKey && sequence.exhausted);
  for (const row of coverage) {
    if (row.inventoryStatus === "COMPLETE") {
      const operations: EndUserComputingPaginatedOperation[] = row.service === "WORKSPACES"
        ? ["workspaces:DescribeWorkspaces", "workspaces:DescribeWorkspaceBundles"]
        : ["appstream:DescribeFleets", "appstream:DescribeStacks"];
      if (!operations.every((operation) => has(row, operation))) reject("INVALID_PAGINATION");
      if (row.service === "APPSTREAM") {
        const relevantStacks = stacks.filter((stack) => stack.accountId === row.accountId && stack.region === row.region);
        const sequences = pagination.filter((sequence) =>
          sequence.service === "APPSTREAM"
          && sequence.accountId === row.accountId
          && sequence.region === row.region
          && sequence.operation === "appstream:ListAssociatedFleets"
          && sequence.exhausted
        );
        if (sequences.length !== relevantStacks.length) {
          reject("INVALID_PAGINATION");
        }
      }
    }
    if (row.activityStatus === "COMPLETE") {
      if (row.service === "WORKSPACES" && !has(row, "workspaces:DescribeWorkspacesConnectionStatus")) reject("INVALID_PAGINATION");
      if (row.service === "APPSTREAM") {
        const aggregates = sessions.filter((item) => item.accountId === row.accountId && item.region === row.region);
        const relevantStacks = stacks.filter((item) =>
          item.accountId === row.accountId && item.region === row.region
        );
        const expectedQueries = relevantStacks.reduce(
          (sum, item) => sum + item.associatedFleetNames.length,
          0,
        );
        const querySequences = pagination.filter((sequence) =>
          sequence.service === "APPSTREAM"
          && sequence.accountId === row.accountId
          && sequence.region === row.region
          && sequence.operation === "appstream:DescribeSessions"
          && sequence.exhausted
        );
        if (querySequences.length < expectedQueries) reject("INVALID_PAGINATION");
        if (!relevantStacks.every((stack) =>
          stack.associatedFleetNames.every((fleetName) =>
            aggregates.some((item) =>
              item.stackName === stack.stackName
              && item.fleetName === fleetName
            )
          )
        )) reject("INVALID_PAGINATION");
        if (!aggregates.every((item) => has(row, "appstream:DescribeSessions", item.queryKeySha256))) reject("INVALID_PAGINATION");
      }
    }
    if (row.metricStatus === "COMPLETE" && !has(row, "cloudwatch:GetMetricData")) reject("INVALID_PAGINATION");
  }
}

export function normalizeEndUserComputingCapture(
  input: unknown,
  configuredBoundary: EndUserComputingBoundary,
  nowMs = Date.now(),
): EndUserComputingSnapshot {
  if (!Number.isFinite(nowMs)) reject("INVALID_INPUT");
  const boundary = parseBoundary(configuredBoundary);
  const record = exact(input, ["schemaVersion", "scope", "partition", "accountIds", "regions", "captureId", "startedAt", "completedAt", "execution", "coverage", "pagination", "workspaces", "workspaceBundles", "appStreamFleets", "appStreamStacks", "appStreamSessions", "metrics", "billingEvidence", "costs"]);
  if (record.schemaVersion !== "sutra.end-user-computing.v1") reject("INVALID_INPUT");
  const suppliedScope = sourceScope(record.scope);
  const partition = enumValue<EndUserComputingPartition>(record.partition, PARTITIONS);
  const accountIds = sortedUniqueStrings(record.accountIds, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumAccounts, (entry) => ACCOUNT_ID.test(entry));
  const regions = sortedUniqueStrings(record.regions, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumRegions, (entry) => REGION.test(entry));
  if (!sameScope(suppliedScope, boundary.scope) || partition !== boundary.partition || stable(accountIds) !== stable(boundary.accountIds) || stable(regions) !== stable(boundary.regions)) reject("SCOPE_MISMATCH");
  const maximumMs = nowMs + CLOCK_SKEW_MS;
  const startedAt = timestamp(record.startedAt, maximumMs);
  const completedAt = timestamp(record.completedAt, maximumMs);
  if (Date.parse(completedAt) < Date.parse(startedAt)) reject("INVALID_INPUT");
  if (Date.parse(completedAt) - Date.parse(startedAt) > END_USER_COMPUTING_COLLECTION_BOUNDS.maximumDurationMs) reject("TIME_BOUND_EXCEEDED");
  const execution = exact(record.execution, ["concurrencyLimit", "observedPeakConcurrency", "pageCount"]);
  if (execution.concurrencyLimit !== 4 || integer(execution.observedPeakConcurrency, 1, 4) > 4) reject("INVALID_INPUT");
  const declaredPageCount = integer(execution.pageCount, 0, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumPages);
  const coverage = dedupe(array(record.coverage, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumCoverageRows, (entry) => parseCoverage(entry, boundary, maximumMs)), (item) => `${item.service}|${item.accountId}|${item.region}`);
  const expectedCoverage = boundary.accountIds.flatMap((accountId) => boundary.regions.flatMap((region) => SERVICES.map((service) => `${service}|${accountId}|${region}`))).sort();
  if (stable(coverage.map((item) => `${item.service}|${item.accountId}|${item.region}`)) !== stable(expectedCoverage)) reject("SCOPE_MISMATCH");
  const pagination = dedupe(array(record.pagination, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumPages, (entry) => parsePagination(entry, boundary)), (item) => `${item.service}|${item.accountId}|${item.region}|${item.operation}|${item.queryKeySha256 ?? ""}`);
  const actualPageCount = pagination.reduce((sum, sequence) => sum + sequence.pages.length, 0);
  if (actualPageCount !== declaredPageCount || actualPageCount > END_USER_COMPUTING_COLLECTION_BOUNDS.maximumPages) reject("INVALID_PAGINATION");
  const workspaces = dedupe(array(record.workspaces, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumWorkspaces, (entry) => parseWorkspace(entry, boundary, maximumMs)), (item) => `${item.accountId}|${item.region}|${item.workspaceId}`);
  const workspaceBundles = dedupe(array(record.workspaceBundles, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumBundles, (entry) => parseBundle(entry, boundary, maximumMs)), (item) => `${item.accountId}|${item.region}|${item.bundleId}`);
  const appStreamFleets = dedupe(array(record.appStreamFleets, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumFleets, (entry) => parseFleet(entry, boundary, maximumMs)), (item) => `${item.accountId}|${item.region}|${item.fleetName}`);
  const appStreamStacks = dedupe(array(record.appStreamStacks, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumStacks, (entry) => parseStack(entry, boundary, maximumMs)), (item) => `${item.accountId}|${item.region}|${item.stackName}`);
  const appStreamSessions = dedupe(array(record.appStreamSessions, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumSessionAggregates, (entry) => parseSessions(entry, boundary, maximumMs)), (item) => `${item.accountId}|${item.region}|${item.fleetName}|${item.stackName}|${item.observedAt}`);
  if (
    appStreamSessions.reduce(
      (sum, item) => sum + item.active + item.pending + item.expired,
      0,
    ) > END_USER_COMPUTING_COLLECTION_BOUNDS.maximumSessions
  ) reject("RECORD_BOUND_EXCEEDED");
  const metrics = dedupe(array(record.metrics, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumMetricObservations, (entry) => parseMetric(entry, boundary, maximumMs)), (item) => `${item.service}|${item.accountId}|${item.region}|${item.resourceScope}|${item.resourceId ?? ""}|${item.metricName}|${item.statistic}|${item.windowStartAt}|${item.windowEndAt}`);
  const billingEvidence = parseBillingEvidence(record.billingEvidence, maximumMs);
  const costs = dedupe(array(record.costs, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumCostRows, (entry) => parseCost(entry, boundary, maximumMs)), (item) => item.lineItemId);
  if (
    (billingEvidence === null && costs.length > 0)
    || (billingEvidence !== null
      && billingEvidence.matchedLineItemCount !== costs.length)
  ) reject("INVALID_INPUT");
  if (billingEvidence === null && coverage.some((item) => item.costStatus === "COMPLETE")) reject("INVALID_INPUT");
  for (const workspace of workspaces) {
    if (!workspaceBundles.some((bundle) => bundle.accountId === workspace.accountId && bundle.region === workspace.region && bundle.bundleId === workspace.bundleId)) reject("INVALID_INPUT");
  }
  for (const stack of appStreamStacks) {
    if (!stack.associatedFleetNames.every((name) => appStreamFleets.some((fleet) => fleet.accountId === stack.accountId && fleet.region === stack.region && fleet.fleetName === name))) reject("INVALID_INPUT");
  }
  for (const session of appStreamSessions) {
    const stack = appStreamStacks.find((item) => item.accountId === session.accountId && item.region === session.region && item.stackName === session.stackName);
    if (stack === undefined || !stack.associatedFleetNames.includes(session.fleetName)) reject("INVALID_INPUT");
  }
  for (const metric of metrics) {
    if (
      metric.service === "WORKSPACES"
      && metric.resourceScope === "RESOURCE"
      && !workspaces.some((item) =>
        item.accountId === metric.accountId
        && item.region === metric.region
        && item.workspaceId === metric.resourceId
      )
    ) reject("INVALID_INPUT");
    if (
      metric.service === "APPSTREAM"
      && metric.resourceScope === "FLEET"
      && !appStreamFleets.some((item) =>
        item.accountId === metric.accountId
        && item.region === metric.region
        && item.fleetName === metric.resourceId
      )
    ) reject("INVALID_INPUT");
  }
  for (const row of coverage) {
    const workspacesInScope = workspaces.filter((item) =>
      row.service === "WORKSPACES"
      && item.accountId === row.accountId
      && item.region === row.region
    );
    const fleetsInScope = appStreamFleets.filter((item) =>
      row.service === "APPSTREAM"
      && item.accountId === row.accountId
      && item.region === row.region
    );
    const stacksInScope = appStreamStacks.filter((item) =>
      row.service === "APPSTREAM"
      && item.accountId === row.accountId
      && item.region === row.region
    );
    const sessionsInScope = appStreamSessions.filter((item) =>
      row.service === "APPSTREAM"
      && item.accountId === row.accountId
      && item.region === row.region
    );
    const inventoryCount = row.service === "WORKSPACES"
      ? workspacesInScope.length
      : fleetsInScope.length + stacksInScope.length;
    const activityCount = row.service === "WORKSPACES"
      ? workspacesInScope.filter((item) => item.connection !== null).length
      : sessionsInScope.reduce(
        (sum, item) => sum + item.active + item.pending + item.expired,
        0,
      );
    const metricCount = metrics.filter((item) =>
      item.service === row.service
      && item.accountId === row.accountId
      && item.region === row.region
    ).length;
    const costCount = costs.filter((item) =>
      item.service === row.service
      && item.accountId === row.accountId
      && item.region === row.region
    ).length;
    if (
      row.inventoryRecordCount !== inventoryCount
      || row.activityRecordCount !== activityCount
      || row.metricRecordCount !== metricCount
      || row.costRecordCount !== costCount
    ) reject("INVALID_INPUT");
  }
  requireCompletePagination(coverage, pagination, appStreamStacks, appStreamSessions);
  const freshnessState: EndUserComputingFreshness = {
    inventory: freshness(coverage.map((item) => item.inventoryObservedAt), nowMs, END_USER_COMPUTING_COLLECTION_BOUNDS.inventoryFreshnessHours),
    activity: freshness(coverage.map((item) => item.activityObservedAt), nowMs, END_USER_COMPUTING_COLLECTION_BOUNDS.activityFreshnessHours),
    metrics: freshness(coverage.map((item) => item.metricDataThroughAt), nowMs, END_USER_COMPUTING_COLLECTION_BOUNDS.metricFreshnessHours),
    costs: freshness(coverage.map((item) => item.costDataThroughAt), nowMs, END_USER_COMPUTING_COLLECTION_BOUNDS.costFreshnessHours),
  };
  const statuses = coverage.flatMap((item) => [item.inventoryStatus, item.activityStatus, item.metricStatus, item.costStatus]);
  const noInventory = coverage.every((item) => item.inventoryStatus === "UNAVAILABLE");
  const stale = Object.values(freshnessState).some((item) => item === "STALE");
  const partial = statuses.some((item) => item !== "COMPLETE") || metrics.some((item) => !item.completeWindow);
  const state: EndUserComputingState = noInventory ? "UNAVAILABLE" : stale ? "STALE" : partial ? "PARTIAL" : "READY";
  const snapshot: EndUserComputingSnapshot = {
    schemaVersion: "sutra.end-user-computing.v1", scope: boundary.scope,
    partition, accountIds, regions, captureId: (() => { const value = text(record.captureId, 68); if (!CAPTURE_ID.test(value)) reject("INVALID_INPUT"); return value; })(),
    observedAt: completedAt, state, freshness: freshnessState, coverage,
    paginationSequenceCount: pagination.length, workspaces, workspaceBundles,
    appStreamFleets, appStreamStacks, appStreamSessions, metrics,
    billingEvidence, costs,
    limitations: [
      "Inventory and connection/session state are point-in-time AWS control-plane evidence, not an availability SLA.",
      "CloudWatch performance and utilization remain separate evidence; an absent metric is unknown and is never converted to zero.",
      "AppStream session counts are aggregated before the broker; user IDs, session IDs, instance IDs, and contact data are not accepted or returned.",
      "Costs are reconciled canonical CUR2 evidence and do not infer performance, utilization, or user activity.",
    ],
  };
  if (encodedBytes(input) > END_USER_COMPUTING_COLLECTION_BOUNDS.maximumCaptureBytes) reject("BYTE_BOUND_EXCEEDED");
  return snapshot;
}

export function endUserComputingSourceEvidence(snapshot: EndUserComputingSnapshot): FinopsSourceEvidence {
  const complete = snapshot.state === "READY";
  const dataTimes = snapshot.coverage.flatMap((row) => [row.inventoryObservedAt, row.activityObservedAt, row.metricDataThroughAt, row.costDataThroughAt]).filter((value): value is string => value !== null);
  const failedCoverage = snapshot.coverage.find((row) => row.failureCode !== null);
  return {
    scope: snapshot.scope,
    sourceId: "end_user_computing_telemetry",
    configured: true,
    deliveryObserved: true,
    lastAttemptAt: snapshot.observedAt,
    lastAttemptOutcome: complete ? "succeeded" : snapshot.state === "UNAVAILABLE" ? "failed" : "partial",
    lastSuccessAt: snapshot.state === "UNAVAILABLE" ? null : snapshot.observedAt,
    dataThroughAt: dataTimes.length === 0 ? null : new Date(Math.min(...dataTimes.map(Date.parse))).toISOString(),
    coverage: {
      assessment: complete ? "complete" : snapshot.state === "UNAVAILABLE" ? "unknown" : "partial",
      acceptedRecords: snapshot.workspaces.length + snapshot.appStreamFleets.length + snapshot.appStreamStacks.length + snapshot.metrics.length + snapshot.costs.length,
      expectedRecords: null,
      rejectedRecords: null,
    },
    lastError: failedCoverage === undefined ? null : {
      code: failedCoverage.failureCode!,
      message: "End User Computing source collection did not complete",
      at: snapshot.observedAt,
    },
    evidenceBasis: "Tenant-pinned WorkSpaces and AppStream control-plane reads, privacy-minimized CloudWatch evidence, and one active reconciled CUR2 generation.",
    limitations: snapshot.limitations,
  };
}

export interface EndUserComputingDashboardQuery {
  readonly services?: readonly EndUserComputingService[];
  readonly accountIds?: readonly string[];
  readonly regions?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface EndUserComputingCostTotal {
  readonly basis: EndUserComputingCostBasis;
  readonly totalMicros: string | null;
  readonly contributingLineCount: number;
  readonly missingLineCount: number;
  readonly coverage: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
}

export interface EndUserComputingCostView {
  readonly service: EndUserComputingService;
  readonly currency: string;
  readonly lineCount: number;
  readonly totals: readonly EndUserComputingCostTotal[];
  readonly usage: readonly { readonly unit: string | null; readonly quantityMicros: string; readonly lineCount: number }[];
  readonly commitments: readonly {
    readonly commitmentClass: EndUserComputingCostLine["commitmentClass"];
    readonly lineCount: number;
    readonly totals: readonly EndUserComputingCostTotal[];
  }[];
}

export interface EndUserComputingDimensionCount {
  readonly value: string;
  readonly count: number;
}

export interface EndUserComputingCostBreakdown {
  readonly service: EndUserComputingService;
  readonly currency: string;
  readonly value: string;
  readonly lineCount: number;
  readonly displayTotal: {
    readonly basis: EndUserComputingCostBasis;
    readonly totalMicros: string;
    readonly coverage: EndUserComputingCostTotal["coverage"];
  } | null;
  readonly totals: readonly EndUserComputingCostTotal[];
}

export interface EndUserComputingDashboard {
  readonly schemaVersion: "sutra.end-user-computing-dashboard.v1";
  readonly state: EndUserComputingState;
  readonly sourceEvidence: {
    readonly captureId: string;
    readonly observedAt: string;
    readonly billingGenerationId: string | null;
    readonly billingPeriod: string | null;
    readonly freshness: EndUserComputingFreshness;
  };
  readonly accountRegionCoverage: readonly EndUserComputingCoverage[];
  readonly inventory: {
    readonly workspaceCount: number;
    readonly availableWorkspaces: number;
    readonly stoppedWorkspaces: number;
    readonly otherStateWorkspaces: number;
    readonly bundleCount: number;
    readonly fleetCount: number;
    readonly runningFleets: number;
    readonly stoppedFleets: number;
    readonly otherStateFleets: number;
    readonly stackCount: number;
  };
  readonly activity: {
    readonly workspaceConnections: { readonly connected: number; readonly disconnected: number; readonly unknown: number; readonly missing: number };
    readonly appStreamSessions: { readonly active: number; readonly pending: number; readonly expired: number; readonly connected: number; readonly notConnected: number };
  };
  readonly telemetry: readonly {
    readonly service: EndUserComputingService;
    readonly metricName: EndUserComputingMetricName;
    readonly evidenceKind: "UTILIZATION" | "PERFORMANCE";
    readonly evidenceState: "OBSERVED" | "PARTIAL" | "STALE" | "UNKNOWN";
    readonly observations: readonly EndUserComputingMetricObservation[];
  }[];
  readonly costViews: readonly EndUserComputingCostView[];
  /** Complete server-side aggregates; independent of resource cursor paging. */
  readonly dimensionViews: {
    readonly workspacesByAccount: readonly EndUserComputingDimensionCount[];
    readonly workspacesByRegion: readonly EndUserComputingDimensionCount[];
    readonly workspacesByRunningMode: readonly EndUserComputingDimensionCount[];
    readonly workspacesByBundle: readonly (EndUserComputingDimensionCount & { readonly bundleName: string | null })[];
    readonly fleetsByAccount: readonly EndUserComputingDimensionCount[];
    readonly fleetsByRegion: readonly EndUserComputingDimensionCount[];
    readonly fleetsByType: readonly EndUserComputingDimensionCount[];
    readonly fleetsByState: readonly EndUserComputingDimensionCount[];
  };
  readonly costBreakdowns: {
    readonly byAccount: readonly EndUserComputingCostBreakdown[];
    readonly byRegion: readonly EndUserComputingCostBreakdown[];
  };
  readonly resources: readonly (EndUserComputingWorkspace | EndUserComputingAppStreamFleet | EndUserComputingAppStreamStack)[];
  readonly nextCursor: string | null;
  readonly separation: {
    readonly inventoryActivitySource: "AWS_CONTROL_PLANE";
    readonly performanceSource: "CLOUDWATCH_ONLY";
    readonly costSource: "ACTIVE_RECONCILED_CUR2_ONLY";
    readonly crossSourceInference: false;
  };
  readonly limitations: readonly string[];
}

function parseQuery(value: unknown, snapshot: EndUserComputingSnapshot): Required<EndUserComputingDashboardQuery> {
  if (value === undefined) return { services: [...SERVICES], accountIds: [...snapshot.accountIds], regions: [...snapshot.regions], limit: 100, cursor: "" };
  if (!isRecord(value) || Object.keys(value).some((key) => !["services", "accountIds", "regions", "limit", "cursor"].includes(key))) reject("INVALID_INPUT");
  const services = value.services === undefined ? [...SERVICES] : sortedUniqueStrings(value.services, 2, (entry) => SERVICE_SET.has(entry)) as EndUserComputingService[];
  const accountIds = value.accountIds === undefined ? [...snapshot.accountIds] : sortedUniqueStrings(value.accountIds, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumAccounts, (entry) => ACCOUNT_ID.test(entry) && snapshot.accountIds.includes(entry));
  const regions = value.regions === undefined ? [...snapshot.regions] : sortedUniqueStrings(value.regions, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumRegions, (entry) => REGION.test(entry) && snapshot.regions.includes(entry));
  const limit = value.limit === undefined ? 100 : integer(value.limit, 1, END_USER_COMPUTING_COLLECTION_BOUNDS.maximumResourcesInResponse);
  const cursor = value.cursor === undefined ? "" : text(value.cursor, 32);
  if (cursor !== "" && !/^v1:(?:0|[1-9]\d{0,7})$/u.test(cursor)) reject("INVALID_INPUT");
  return { services, accountIds, regions, limit, cursor };
}

function totals(lines: readonly EndUserComputingCostLine[]): readonly EndUserComputingCostTotal[] {
  return COST_BASES.map((basis) => {
    let sum = BigInt(0);
    let contributing = 0;
    for (const line of lines) {
      const value = line.amountsMicros[basis];
      if (value !== null) { sum += BigInt(value); contributing += 1; }
    }
    const missing = lines.length - contributing;
    return { basis, totalMicros: contributing === 0 ? null : sum.toString(), contributingLineCount: contributing, missingLineCount: missing, coverage: contributing === 0 ? "UNAVAILABLE" : missing === 0 ? "COMPLETE" : "PARTIAL" };
  });
}

function costViews(lines: readonly EndUserComputingCostLine[]): readonly EndUserComputingCostView[] {
  const groups = new Map<string, EndUserComputingCostLine[]>();
  for (const line of lines) {
    const key = `${line.service}|${line.currency}`;
    const group = groups.get(key) ?? [];
    group.push(line);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, group]) => {
    const [service, currency] = key.split("|") as [EndUserComputingService, string];
    const usageGroups = new Map<string, { sum: bigint; count: number }>();
    for (const line of group) {
      if (line.usageAmountMicros === null) continue;
      const key = line.usageUnit ?? "\u0000";
      const current = usageGroups.get(key) ?? { sum: BigInt(0), count: 0 };
      current.sum += BigInt(line.usageAmountMicros);
      current.count += 1;
      usageGroups.set(key, current);
    }
    const classes = [...new Set(group.map((line) => line.commitmentClass))].sort();
    return {
      service, currency, lineCount: group.length, totals: totals(group),
      usage: [...usageGroups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([unit, value]) => ({ unit: unit === "\u0000" ? null : unit, quantityMicros: value.sum.toString(), lineCount: value.count })),
      commitments: classes.map((commitmentClass) => { const subset = group.filter((line) => line.commitmentClass === commitmentClass); return { commitmentClass, lineCount: subset.length, totals: totals(subset) }; }),
    };
  });
}

function dimensionCounts<T>(values: readonly T[], select: (value: T) => string): readonly EndUserComputingDimensionCount[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = select(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function displayTotal(values: readonly EndUserComputingCostTotal[]): EndUserComputingCostBreakdown["displayTotal"] {
  for (const basis of ["net", "amortized", "unblended", "contracted", "list", "public"] as const) {
    const total = values.find((item) => item.basis === basis);
    if (total?.totalMicros !== null && total !== undefined) {
      return { basis, totalMicros: total.totalMicros, coverage: total.coverage };
    }
  }
  return null;
}

function costBreakdowns(
  lines: readonly EndUserComputingCostLine[],
  select: (line: EndUserComputingCostLine) => string,
): readonly EndUserComputingCostBreakdown[] {
  const groups = new Map<string, EndUserComputingCostLine[]>();
  for (const line of lines) {
    const value = select(line);
    const key = `${line.service}|${line.currency}|${value}`;
    const group = groups.get(key) ?? [];
    group.push(line);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => {
    const [service, currency, value] = key.split("|") as [EndUserComputingService, string, string];
    const values = totals(group);
    return { service, currency, value, lineCount: group.length, displayTotal: displayTotal(values), totals: values };
  }).sort((left, right) => {
    const scope = `${left.service}|${left.currency}`.localeCompare(`${right.service}|${right.currency}`);
    if (scope !== 0) return scope;
    if (left.displayTotal !== null && right.displayTotal !== null
      && left.displayTotal.basis === right.displayTotal.basis) {
      const leftAmount = BigInt(left.displayTotal.totalMicros);
      const rightAmount = BigInt(right.displayTotal.totalMicros);
      if (leftAmount !== rightAmount) return leftAmount > rightAmount ? -1 : 1;
    }
    if (left.displayTotal === null && right.displayTotal !== null) return 1;
    if (left.displayTotal !== null && right.displayTotal === null) return -1;
    return left.value.localeCompare(right.value);
  });
}

export function buildEndUserComputingDashboard(
  snapshot: EndUserComputingSnapshot,
  query?: EndUserComputingDashboardQuery,
): EndUserComputingDashboard {
  const parsed = parseQuery(query, snapshot);
  const included = (service: EndUserComputingService, accountId: string, region: string) => parsed.services.includes(service) && parsed.accountIds.includes(accountId) && parsed.regions.includes(region);
  const workspaces = snapshot.workspaces.filter((item) => included("WORKSPACES", item.accountId, item.region));
  const bundles = snapshot.workspaceBundles.filter((item) => included("WORKSPACES", item.accountId, item.region));
  const fleets = snapshot.appStreamFleets.filter((item) => included("APPSTREAM", item.accountId, item.region));
  const stacks = snapshot.appStreamStacks.filter((item) => included("APPSTREAM", item.accountId, item.region));
  const sessions = snapshot.appStreamSessions.filter((item) => included("APPSTREAM", item.accountId, item.region));
  const metrics = snapshot.metrics.filter((item) => included(item.service, item.accountId, item.region));
  const costs = snapshot.costs.filter((item) => included(item.service, item.accountId, item.region));
  const bundleNames = new Map<string, string | null>();
  for (const bundle of bundles) {
    const current = bundleNames.get(bundle.bundleId);
    bundleNames.set(bundle.bundleId, current === undefined || current === bundle.name ? bundle.name : null);
  }
  const workspaceBundles = dimensionCounts(workspaces, (item) => item.bundleId)
    .map((item) => ({ ...item, bundleName: bundleNames.get(item.value) ?? null }));
  const allResources = [...workspaces, ...fleets, ...stacks].sort((left, right) => stable(left).localeCompare(stable(right)));
  const offset = parsed.cursor === "" ? 0 : Number(parsed.cursor.slice(3));
  if (!Number.isSafeInteger(offset) || offset > allResources.length) reject("INVALID_INPUT");
  const resources = allResources.slice(offset, offset + parsed.limit);
  const nextCursor = offset + resources.length < allResources.length ? `v1:${offset + resources.length}` : null;
  const telemetry = parsed.services.flatMap((service) => METRICS_BY_SERVICE[service].map((metricName) => {
    const observations = metrics.filter((item) => item.metricName === metricName);
    const freshnessState = service === "APPSTREAM" || service === "WORKSPACES" ? snapshot.freshness.metrics : "UNKNOWN";
    const evidenceState = observations.length === 0 ? "UNKNOWN" as const : freshnessState === "STALE" ? "STALE" as const : observations.some((item) => !item.completeWindow) ? "PARTIAL" as const : "OBSERVED" as const;
    return {
      service,
      metricName,
      evidenceKind: PERFORMANCE_METRICS.has(metricName)
        ? "PERFORMANCE" as const
        : "UTILIZATION" as const,
      evidenceState,
      observations,
    };
  }));
  const dashboard: EndUserComputingDashboard = {
    schemaVersion: "sutra.end-user-computing-dashboard.v1", state: snapshot.state,
    sourceEvidence: { captureId: snapshot.captureId, observedAt: snapshot.observedAt, billingGenerationId: snapshot.billingEvidence?.generationId ?? null, billingPeriod: snapshot.billingEvidence?.billingPeriod ?? null, freshness: snapshot.freshness },
    accountRegionCoverage: snapshot.coverage.filter((item) => included(item.service, item.accountId, item.region)),
    inventory: {
      workspaceCount: workspaces.length,
      availableWorkspaces: workspaces.filter((item) => item.state === "AVAILABLE").length,
      stoppedWorkspaces: workspaces.filter((item) => item.state === "STOPPED").length,
      otherStateWorkspaces: workspaces.filter((item) => item.state !== "AVAILABLE" && item.state !== "STOPPED").length,
      bundleCount: bundles.length, fleetCount: fleets.length,
      runningFleets: fleets.filter((item) => item.state === "RUNNING").length,
      stoppedFleets: fleets.filter((item) => item.state === "STOPPED").length,
      otherStateFleets: fleets.filter((item) => item.state !== "RUNNING" && item.state !== "STOPPED").length,
      stackCount: stacks.length,
    },
    activity: {
      workspaceConnections: {
        connected: workspaces.filter((item) => item.connection?.state === "CONNECTED").length,
        disconnected: workspaces.filter((item) => item.connection?.state === "DISCONNECTED").length,
        unknown: workspaces.filter((item) => item.connection?.state === "UNKNOWN").length,
        missing: workspaces.filter((item) => item.connection === null).length,
      },
      appStreamSessions: sessions.reduce((sum, item) => ({ active: sum.active + item.active, pending: sum.pending + item.pending, expired: sum.expired + item.expired, connected: sum.connected + item.connected, notConnected: sum.notConnected + item.notConnected }), { active: 0, pending: 0, expired: 0, connected: 0, notConnected: 0 }),
    },
    telemetry, costViews: costViews(costs),
    dimensionViews: {
      workspacesByAccount: dimensionCounts(workspaces, (item) => item.accountId),
      workspacesByRegion: dimensionCounts(workspaces, (item) => item.region),
      workspacesByRunningMode: dimensionCounts(workspaces, (item) => item.runningMode),
      workspacesByBundle: workspaceBundles,
      fleetsByAccount: dimensionCounts(fleets, (item) => item.accountId),
      fleetsByRegion: dimensionCounts(fleets, (item) => item.region),
      fleetsByType: dimensionCounts(fleets, (item) => item.fleetType),
      fleetsByState: dimensionCounts(fleets, (item) => item.state),
    },
    costBreakdowns: {
      byAccount: costBreakdowns(costs, (item) => item.accountId),
      byRegion: costBreakdowns(costs, (item) => item.region),
    },
    resources, nextCursor,
    separation: { inventoryActivitySource: "AWS_CONTROL_PLANE", performanceSource: "CLOUDWATCH_ONLY", costSource: "ACTIVE_RECONCILED_CUR2_ONLY", crossSourceInference: false },
    limitations: [...snapshot.limitations, "Telemetry entries marked UNKNOWN have no authoritative observation and must render as unknown/partial, never as 0."],
  };
  if (encodedBytes(dashboard) > END_USER_COMPUTING_COLLECTION_BOUNDS.maximumDashboardBytes) reject("RESPONSE_BOUND_EXCEEDED");
  return dashboard;
}

export interface EndUserComputingBrokerRequest {
  readonly schemaVersion: "sutra.end-user-computing-query.v1";
  readonly boundary: EndUserComputingBoundary;
  readonly operations: typeof END_USER_COMPUTING_READ_OPERATIONS;
  readonly bounds: typeof END_USER_COMPUTING_COLLECTION_BOUNDS;
  readonly canonicalBillingSource: "ACTIVE_RECONCILED_CUR2_GENERATION";
  readonly sanitizeBeforeBroker: true;
  readonly includeUserIdentifiers: false;
  readonly includeSessionIdentifiers: false;
  readonly includeInstanceIdentifiers: false;
  readonly includeNetworkAddresses: false;
  readonly includeRawProviderMessages: false;
  readonly includeRawPaginationTokens: false;
}

export interface EndUserComputingTransport {
  readonly collect: (request: EndUserComputingBrokerRequest) => Promise<unknown>;
}

export class EndUserComputingQueryError extends Error {
  public readonly code: "SOURCE_UNAVAILABLE" | "INVALID_EVIDENCE";
  public constructor(code: "SOURCE_UNAVAILABLE" | "INVALID_EVIDENCE") {
    super("End User Computing evidence is unavailable");
    this.name = "EndUserComputingQueryError";
    this.code = code;
  }
}

export function createEndUserComputingQueryService(
  configuredBoundary: EndUserComputingBoundary,
  transport: EndUserComputingTransport,
  now: () => number = Date.now,
): { readonly query: (filters?: EndUserComputingDashboardQuery) => Promise<EndUserComputingDashboard> } {
  const boundary = parseBoundary(configuredBoundary);
  return {
    async query(filters?: EndUserComputingDashboardQuery): Promise<EndUserComputingDashboard> {
      let capture: unknown;
      try {
        capture = await transport.collect({
          schemaVersion: "sutra.end-user-computing-query.v1", boundary,
          operations: END_USER_COMPUTING_READ_OPERATIONS,
          bounds: END_USER_COMPUTING_COLLECTION_BOUNDS,
          canonicalBillingSource: "ACTIVE_RECONCILED_CUR2_GENERATION",
          sanitizeBeforeBroker: true, includeUserIdentifiers: false,
          includeSessionIdentifiers: false, includeInstanceIdentifiers: false,
          includeNetworkAddresses: false, includeRawProviderMessages: false,
          includeRawPaginationTokens: false,
        });
      } catch {
        throw new EndUserComputingQueryError("SOURCE_UNAVAILABLE");
      }
      try {
        return buildEndUserComputingDashboard(normalizeEndUserComputingCapture(capture, boundary, now()), filters);
      } catch {
        throw new EndUserComputingQueryError("INVALID_EVIDENCE");
      }
    },
  };
}
