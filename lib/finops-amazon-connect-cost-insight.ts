/**
 * Evidence-honest Amazon Connect Cost Insight source and projection engine.
 *
 * The credential-owning collector and active CUR2 repository are outside this
 * pure module. Raw contact IDs, telephone numbers, phone-number descriptions,
 * endpoint addresses, contact records, recordings, transcripts, agent/user
 * identifiers, and provider error messages must be removed before the broker
 * boundary. Contact and endpoint lineage uses rotating, tenant-scoped HMAC
 * tokens only.
 */
import type {
  FinopsSourceEvidence,
  FinopsSourceScope,
} from "./finops-source-health.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const CAPTURE_ID = /^connect_[a-f0-9]{64}$/u;
const GENERATION_ID = /^fbg_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CONTACT_TOKEN = /^ctk_[a-f0-9]{64}$/u;
const ENDPOINT_TOKEN = /^epk_[a-f0-9]{64}$/u;
const KEY_VERSION = /^key_[A-Za-z0-9._-]{1,63}$/u;
const AUDIT_ID = /^audit_[a-f0-9]{32,64}$/u;
const GRANT_ID = /^grant_[a-f0-9]{32,64}$/u;
const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const INSTANCE_ARN = /^arn:(aws|aws-cn|aws-us-gov):connect:([a-z0-9-]+):(\d{12}):instance\/([0-9a-f-]{36})$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const INTEGER_MICROS = /^-?(?:0|[1-9]\d{0,29})$/u;
const COUNTRY_CODE = /^[A-Z]{2}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

export const AMAZON_CONNECT_COST_INSIGHT_BOUNDS = Object.freeze({
  maximumConcurrency: 4,
  maximumDurationMs: 15 * 60 * 1_000,
  maximumAuthorizedInstances: 100,
  maximumApiCalls: 20_000,
  maximumPhoneRecordsScanned: 250_000,
  maximumPhoneAggregateRows: 10_000,
  maximumCostRows: 500_000,
  maximumCaptureBytes: 64 * 1_024 * 1_024,
  maximumDashboardBytes: 80 * 1_024 * 1_024,
  maximumDashboardGroups: 20_000,
  maximumContactRowsPerDrilldown: 500,
  maximumTextCharacters: 512,
  sourceFreshnessHours: 48,
  maximumSensitiveGrantMinutes: 60,
} as const);

/**
 * Exact runtime API surface. Instance discovery is deliberately excluded:
 * the trusted connection configuration supplies the authorized instance ARNs.
 */
export const AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS = Object.freeze([
  "connect:DescribeInstance",
  "connect:ListPhoneNumbersV2",
  "ds:DescribeDirectories",
] as const);

export type AmazonConnectPartition = "aws" | "aws-cn" | "aws-us-gov";
export type AmazonConnectCostBasis =
  | "UNBLENDED"
  | "AMORTIZED"
  | "NET_UNBLENDED"
  | "NET_AMORTIZED";
export type AmazonConnectFailureCode =
  | "ACCESS_DENIED"
  | "THROTTLED"
  | "TIMEOUT"
  | "BOUND_REACHED"
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_PAGINATION"
  | "UNKNOWN";
export type AmazonConnectState =
  | "configuration_required"
  | "permission_required"
  | "failed"
  | "partial"
  | "empty"
  | "stale"
  | "current";
export type AmazonConnectChannel = "VOICE" | "CHAT" | "TASK" | "EMAIL" | "OTHER";
export type AmazonConnectDirection = "INBOUND" | "OUTBOUND" | "TRANSFER" | "UNKNOWN";
export type AmazonConnectPhoneNumberType =
  | "DID"
  | "TOLL_FREE"
  | "UIFN"
  | "SHARED_COST"
  | "THIRD_PARTY"
  | "UNKNOWN";
export type AmazonConnectChargeFamily =
  | "CONNECT_SERVICE"
  | "TELEPHONY_INBOUND"
  | "TELEPHONY_OUTBOUND"
  | "PHONE_NUMBER"
  | "CHAT"
  | "TASK"
  | "EMAIL"
  | "OTHER";

export interface AmazonConnectScope extends FinopsSourceScope {
  readonly accountId: string;
  readonly partition: AmazonConnectPartition;
  readonly region: string;
  /** Sorted unique instance ARNs authorized by server-side connection state. */
  readonly instanceArns: readonly string[];
}

export interface AmazonConnectInstanceObservation {
  readonly instanceArn: string;
  readonly instanceId: string;
  readonly alias: string;
  readonly status: "CREATION_IN_PROGRESS" | "ACTIVE" | "CREATION_FAILED";
  readonly inboundCallsEnabled: boolean;
  readonly outboundCallsEnabled: boolean;
  readonly observedAtIso: string;
}

/**
 * Aggregated before the broker boundary. It cannot contain a phone number,
 * phone-number ARN/ID, description, or target ARN.
 */
export interface AmazonConnectPhoneInventoryAggregate {
  readonly instanceArn: string;
  readonly countryCode: string;
  readonly phoneNumberType: AmazonConnectPhoneNumberType;
  readonly status: "CLAIMED" | "IN_PROGRESS" | "FAILED";
  readonly count: number;
}

export interface AmazonConnectInstanceCollection {
  readonly instanceArn: string;
  readonly configured: boolean;
  readonly regionSupported: boolean;
  readonly permissionsValidated: boolean;
  readonly pagesExhausted: boolean;
  readonly apiCallCount: number;
  readonly phoneRecordsScanned: number;
  readonly failureCode: AmazonConnectFailureCode | null;
  readonly instance: AmazonConnectInstanceObservation | null;
  readonly phoneInventory: readonly AmazonConnectPhoneInventoryAggregate[];
}

export interface AmazonConnectCur2CostRow {
  readonly rowId: string;
  readonly accountId: string;
  readonly region: string;
  readonly instanceArn: string | null;
  /** Tenant-scoped HMAC of the CUR contact resource ID, never the raw ID. */
  readonly contactToken: string | null;
  /** Tenant-scoped HMAC of a system endpoint, never a phone number or ARN. */
  readonly endpointToken: string | null;
  readonly chargePeriodStartIso: string;
  readonly chargePeriodEndIso: string;
  readonly service: "AMAZON_CONNECT" | "CONTACT_CENTER_TELECOM";
  readonly chargeFamily: AmazonConnectChargeFamily;
  readonly channel: AmazonConnectChannel;
  readonly direction: AmazonConnectDirection;
  readonly countryCode: string | null;
  readonly phoneNumberType: AmazonConnectPhoneNumberType | null;
  readonly operation: string | null;
  readonly usageType: string | null;
  readonly usageUnit: string | null;
  /** Signed decimal integer micro-units. */
  readonly usageQuantityMicros: string;
  /** Signed decimal integer currency micros; credits/refunds may be negative. */
  readonly costMicros: string;
  readonly chargeCategory:
    | "USAGE"
    | "FEE"
    | "TAX"
    | "CREDIT"
    | "DISCOUNT"
    | "REFUND"
    | "SUPPORT"
    | "OTHER";
  readonly classificationBasis:
    | "AWS_CUR2_NATIVE"
    | "AWS_ACTIVATED_SYSTEM_TAGS"
    | "SUTRA_USAGE_TYPE_RULE"
    | "UNATTRIBUTED";
}

export interface AmazonConnectCur2Evidence {
  readonly source: "AWS_CUR2_ACTIVE_GENERATION";
  readonly generationId: string;
  readonly manifestSha256: string;
  readonly dataThroughAtIso: string;
  readonly costBasis: AmazonConnectCostBasis;
  readonly currency: string;
  readonly rowsExhausted: boolean;
  readonly contactResourceIdsIncluded: boolean;
  readonly activatedSystemTags: readonly (
    | "aws:connect:instanceId"
    | "aws:connect:systemEndpoint"
    | "aws:connect:transferredFromEndpoint"
  )[];
  readonly rows: readonly AmazonConnectCur2CostRow[];
}

export interface AmazonConnectPrivacyBoundary {
  readonly rawContactRecordsAccepted: false;
  readonly rawPhoneNumbersAccepted: false;
  readonly tokenization: "HMAC_SHA256_TENANT_SCOPED_ROTATING";
  readonly tokenKeyVersion: string;
  readonly contactDrilldownEnabled: boolean;
}

export interface AmazonConnectCostInsightCapture {
  readonly schemaVersion: "sutra.amazon-connect-cost-insight.v1";
  readonly scope: AmazonConnectScope;
  readonly captureId: string;
  readonly startedAtIso: string;
  readonly completedAtIso: string;
  readonly execution: {
    readonly concurrencyLimit: 4;
    readonly observedPeakConcurrency: number;
  };
  readonly privacy: AmazonConnectPrivacyBoundary;
  /** Exactly one collection for each server-authorized instance ARN. */
  readonly collections: readonly AmazonConnectInstanceCollection[];
  readonly costEvidence: AmazonConnectCur2Evidence;
}

export interface AmazonConnectCostInsightSnapshot {
  readonly schemaVersion: "sutra.amazon-connect-cost-insight-snapshot.v1";
  readonly scope: AmazonConnectScope;
  readonly captureId: string;
  readonly completedAtIso: string;
  readonly state: AmazonConnectState;
  readonly complete: boolean;
  readonly contactDetailCoverage: "NOT_ENABLED" | "TOKENIZED_PARTIAL" | "TOKENIZED_COMPLETE";
  readonly privacy: AmazonConnectPrivacyBoundary;
  readonly collections: readonly AmazonConnectInstanceCollection[];
  readonly costEvidence: AmazonConnectCur2Evidence;
  readonly limitations: readonly string[];
}

export type AmazonConnectCostInsightErrorCode =
  | "INVALID_INPUT"
  | "SCOPE_MISMATCH"
  | "BOUND_REACHED"
  | "CONFLICTING_DUPLICATE"
  | "SENSITIVE_ACCESS_DENIED";

export class AmazonConnectCostInsightError extends Error {
  public readonly code: AmazonConnectCostInsightErrorCode;
  public constructor(code: AmazonConnectCostInsightErrorCode) {
    super("The Amazon Connect cost evidence is invalid or unavailable");
    this.name = "AmazonConnectCostInsightError";
    this.code = code;
  }
}

function reject(code: AmazonConnectCostInsightErrorCode): never {
  throw new AmazonConnectCostInsightError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) reject("INVALID_INPUT");
  return value;
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function text(value: unknown, maximum: number = AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumTextCharacters): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) reject("INVALID_INPUT");
  return value;
}

function nullableText(value: unknown, maximum?: number): string | null {
  return value === null ? null : text(value, maximum);
}

function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) reject("INVALID_INPUT");
  return value as T;
}

function timestamp(value: unknown, maximumMs: number): string {
  const result = text(value, 40);
  const milliseconds = Date.parse(result);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== result || milliseconds > maximumMs) reject("INVALID_INPUT");
  return result;
}

function parseInteger(value: unknown, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > maximum) reject("BOUND_REACHED");
  return value as number;
}

function instanceArn(value: unknown, scope: Omit<AmazonConnectScope, "instanceArns">): string {
  const result = text(value, 256);
  const match = INSTANCE_ARN.exec(result);
  if (!match || match[1] !== scope.partition || match[2] !== scope.region || match[3] !== scope.accountId
    || !INSTANCE_ID.test(match[4] ?? "")) reject("SCOPE_MISMATCH");
  return result;
}

function parseScope(value: unknown): AmazonConnectScope {
  const record = exact(value, ["orgId", "customerId", "connectionId", "accountId", "partition", "region", "instanceArns"]);
  const orgId = text(record.orgId, 128);
  const customerId = text(record.customerId, 128);
  const connectionId = text(record.connectionId, 37);
  const accountId = text(record.accountId, 12);
  const partition = choice(record.partition, ["aws", "aws-cn", "aws-us-gov"] as const);
  const region = text(record.region, 32);
  if (!IDENTIFIER.test(orgId) || !IDENTIFIER.test(customerId) || !CONNECTION_ID.test(connectionId)
    || !ACCOUNT_ID.test(accountId) || !REGION.test(region) || !Array.isArray(record.instanceArns)
    || record.instanceArns.length > AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumAuthorizedInstances) reject("INVALID_INPUT");
  const base = { orgId, customerId, connectionId, accountId, partition, region };
  const instanceArns = record.instanceArns.map((entry) => instanceArn(entry, base));
  const sorted = [...instanceArns].sort();
  if (new Set(sorted).size !== sorted.length || JSON.stringify(sorted) !== JSON.stringify(instanceArns)) reject("CONFLICTING_DUPLICATE");
  return { ...base, instanceArns };
}

function sameScope(left: AmazonConnectScope, right: AmazonConnectScope): boolean {
  return left.orgId === right.orgId && left.customerId === right.customerId
    && left.connectionId === right.connectionId && left.accountId === right.accountId
    && left.partition === right.partition && left.region === right.region
    && JSON.stringify(left.instanceArns) === JSON.stringify(right.instanceArns);
}

function parsePhoneAggregate(value: unknown, expectedInstanceArn: string, scope: AmazonConnectScope): AmazonConnectPhoneInventoryAggregate {
  const record = exact(value, ["instanceArn", "countryCode", "phoneNumberType", "status", "count"]);
  const parsedInstanceArn = instanceArn(record.instanceArn, scope);
  const countryCode = text(record.countryCode, 2);
  if (parsedInstanceArn !== expectedInstanceArn || !COUNTRY_CODE.test(countryCode)) reject("SCOPE_MISMATCH");
  return {
    instanceArn: parsedInstanceArn,
    countryCode,
    phoneNumberType: choice(record.phoneNumberType, ["DID", "TOLL_FREE", "UIFN", "SHARED_COST", "THIRD_PARTY", "UNKNOWN"] as const),
    status: choice(record.status, ["CLAIMED", "IN_PROGRESS", "FAILED"] as const),
    count: parseInteger(record.count, AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumPhoneRecordsScanned),
  };
}

function parseObservation(value: unknown, expectedArn: string, scope: AmazonConnectScope, maximumMs: number): AmazonConnectInstanceObservation {
  const record = exact(value, ["instanceArn", "instanceId", "alias", "status", "inboundCallsEnabled", "outboundCallsEnabled", "observedAtIso"]);
  const parsedArn = instanceArn(record.instanceArn, scope);
  const parsedId = text(record.instanceId, 36);
  const match = INSTANCE_ARN.exec(parsedArn);
  if (parsedArn !== expectedArn || parsedId !== match?.[4] || !INSTANCE_ID.test(parsedId)) reject("SCOPE_MISMATCH");
  if (typeof record.inboundCallsEnabled !== "boolean" || typeof record.outboundCallsEnabled !== "boolean") reject("INVALID_INPUT");
  return {
    instanceArn: parsedArn,
    instanceId: parsedId,
    alias: text(record.alias, 62),
    status: choice(record.status, ["CREATION_IN_PROGRESS", "ACTIVE", "CREATION_FAILED"] as const),
    inboundCallsEnabled: record.inboundCallsEnabled,
    outboundCallsEnabled: record.outboundCallsEnabled,
    observedAtIso: timestamp(record.observedAtIso, maximumMs),
  };
}

function parseCollection(value: unknown, expectedArn: string, scope: AmazonConnectScope, maximumMs: number): AmazonConnectInstanceCollection {
  const record = exact(value, ["instanceArn", "configured", "regionSupported", "permissionsValidated", "pagesExhausted", "apiCallCount", "phoneRecordsScanned", "failureCode", "instance", "phoneInventory"]);
  const parsedArn = instanceArn(record.instanceArn, scope);
  if (parsedArn !== expectedArn || ![record.configured, record.regionSupported, record.permissionsValidated, record.pagesExhausted].every((item) => typeof item === "boolean")
    || !Array.isArray(record.phoneInventory) || record.phoneInventory.length > AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumPhoneAggregateRows) reject("INVALID_INPUT");
  const apiCallCount = parseInteger(record.apiCallCount, AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumApiCalls);
  const phoneRecordsScanned = parseInteger(record.phoneRecordsScanned, AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumPhoneRecordsScanned);
  const failureCode = record.failureCode === null ? null : choice(record.failureCode, ["ACCESS_DENIED", "THROTTLED", "TIMEOUT", "BOUND_REACHED", "PROVIDER_UNAVAILABLE", "INVALID_PAGINATION", "UNKNOWN"] as const);
  const cannotCollect = record.configured !== true || record.regionSupported !== true || record.permissionsValidated !== true;
  if (cannotCollect && (apiCallCount !== 0 || phoneRecordsScanned !== 0 || record.instance !== null || record.phoneInventory.length !== 0 || record.pagesExhausted !== false)) reject("INVALID_INPUT");
  if (record.configured === true && record.regionSupported === true && record.permissionsValidated === false && failureCode !== "ACCESS_DENIED") reject("INVALID_INPUT");
  if (record.regionSupported === false && failureCode !== null && failureCode !== "PROVIDER_UNAVAILABLE") reject("INVALID_INPUT");
  if (failureCode !== null && record.pagesExhausted === true) reject("INVALID_INPUT");
  const observation = record.instance === null ? null : parseObservation(record.instance, expectedArn, scope, maximumMs);
  const phoneInventory = record.phoneInventory.map((entry) => parsePhoneAggregate(entry, expectedArn, scope));
  const sorted = [...phoneInventory].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const keys = sorted.map((item) => JSON.stringify([item.countryCode, item.phoneNumberType, item.status]));
  if (new Set(keys).size !== keys.length || JSON.stringify(sorted) !== JSON.stringify(phoneInventory)
    || phoneInventory.reduce((sum, item) => sum + item.count, 0) !== phoneRecordsScanned) reject("CONFLICTING_DUPLICATE");
  if (record.pagesExhausted === true && observation === null) reject("INVALID_INPUT");
  return {
    instanceArn: parsedArn,
    configured: record.configured as boolean,
    regionSupported: record.regionSupported as boolean,
    permissionsValidated: record.permissionsValidated as boolean,
    pagesExhausted: record.pagesExhausted as boolean,
    apiCallCount,
    phoneRecordsScanned,
    failureCode,
    instance: observation,
    phoneInventory,
  };
}

function parseCostRow(value: unknown, scope: AmazonConnectScope, maximumMs: number): AmazonConnectCur2CostRow {
  const record = exact(value, ["rowId", "accountId", "region", "instanceArn", "contactToken", "endpointToken", "chargePeriodStartIso", "chargePeriodEndIso", "service", "chargeFamily", "channel", "direction", "countryCode", "phoneNumberType", "operation", "usageType", "usageUnit", "usageQuantityMicros", "costMicros", "chargeCategory", "classificationBasis"]);
  if (record.accountId !== scope.accountId || record.region !== scope.region) reject("SCOPE_MISMATCH");
  const parsedInstanceArn = record.instanceArn === null ? null : instanceArn(record.instanceArn, scope);
  if (parsedInstanceArn !== null && !scope.instanceArns.includes(parsedInstanceArn)) reject("SCOPE_MISMATCH");
  const contactToken = nullableText(record.contactToken, 68);
  const endpointToken = nullableText(record.endpointToken, 68);
  if ((contactToken !== null && !CONTACT_TOKEN.test(contactToken)) || (endpointToken !== null && !ENDPOINT_TOKEN.test(endpointToken))) reject("INVALID_INPUT");
  const chargePeriodStartIso = timestamp(record.chargePeriodStartIso, maximumMs);
  const chargePeriodEndIso = timestamp(record.chargePeriodEndIso, maximumMs);
  if (Date.parse(chargePeriodEndIso) <= Date.parse(chargePeriodStartIso)) reject("INVALID_INPUT");
  const usageQuantityMicros = text(record.usageQuantityMicros, 31);
  const costMicros = text(record.costMicros, 31);
  if (!INTEGER_MICROS.test(usageQuantityMicros) || !INTEGER_MICROS.test(costMicros)) reject("INVALID_INPUT");
  const countryCode = nullableText(record.countryCode, 2);
  if (countryCode !== null && !COUNTRY_CODE.test(countryCode)) reject("INVALID_INPUT");
  const classificationBasis = choice(record.classificationBasis, ["AWS_CUR2_NATIVE", "AWS_ACTIVATED_SYSTEM_TAGS", "SUTRA_USAGE_TYPE_RULE", "UNATTRIBUTED"] as const);
  if (classificationBasis === "UNATTRIBUTED" && (parsedInstanceArn !== null || contactToken !== null || endpointToken !== null)) reject("INVALID_INPUT");
  return {
    rowId: text(record.rowId, 256),
    accountId: scope.accountId,
    region: scope.region,
    instanceArn: parsedInstanceArn,
    contactToken,
    endpointToken,
    chargePeriodStartIso,
    chargePeriodEndIso,
    service: choice(record.service, ["AMAZON_CONNECT", "CONTACT_CENTER_TELECOM"] as const),
    chargeFamily: choice(record.chargeFamily, ["CONNECT_SERVICE", "TELEPHONY_INBOUND", "TELEPHONY_OUTBOUND", "PHONE_NUMBER", "CHAT", "TASK", "EMAIL", "OTHER"] as const),
    channel: choice(record.channel, ["VOICE", "CHAT", "TASK", "EMAIL", "OTHER"] as const),
    direction: choice(record.direction, ["INBOUND", "OUTBOUND", "TRANSFER", "UNKNOWN"] as const),
    countryCode,
    phoneNumberType: record.phoneNumberType === null ? null : choice(record.phoneNumberType, ["DID", "TOLL_FREE", "UIFN", "SHARED_COST", "THIRD_PARTY", "UNKNOWN"] as const),
    operation: nullableText(record.operation),
    usageType: nullableText(record.usageType),
    usageUnit: nullableText(record.usageUnit, 128),
    usageQuantityMicros,
    costMicros,
    chargeCategory: choice(record.chargeCategory, ["USAGE", "FEE", "TAX", "CREDIT", "DISCOUNT", "REFUND", "SUPPORT", "OTHER"] as const),
    classificationBasis,
  };
}

function parseCostEvidence(value: unknown, scope: AmazonConnectScope, maximumMs: number): AmazonConnectCur2Evidence {
  const record = exact(value, ["source", "generationId", "manifestSha256", "dataThroughAtIso", "costBasis", "currency", "rowsExhausted", "contactResourceIdsIncluded", "activatedSystemTags", "rows"]);
  if (record.source !== "AWS_CUR2_ACTIVE_GENERATION" || typeof record.generationId !== "string" || !GENERATION_ID.test(record.generationId)
    || typeof record.manifestSha256 !== "string" || !SHA256.test(record.manifestSha256)
    || typeof record.currency !== "string" || !CURRENCY.test(record.currency)
    || typeof record.rowsExhausted !== "boolean" || typeof record.contactResourceIdsIncluded !== "boolean"
    || !Array.isArray(record.activatedSystemTags) || !Array.isArray(record.rows)
    || record.rows.length > AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumCostRows) reject("INVALID_INPUT");
  const allowedTags = ["aws:connect:instanceId", "aws:connect:systemEndpoint", "aws:connect:transferredFromEndpoint"] as const;
  const activatedSystemTags = record.activatedSystemTags.map((item) => choice(item, allowedTags));
  const sortedTags = [...activatedSystemTags].sort();
  if (new Set(sortedTags).size !== sortedTags.length || JSON.stringify(sortedTags) !== JSON.stringify(activatedSystemTags)) reject("CONFLICTING_DUPLICATE");
  const rows = record.rows.map((item) => parseCostRow(item, scope, maximumMs));
  const unique = new Map<string, AmazonConnectCur2CostRow>();
  for (const row of rows) {
    const previous = unique.get(row.rowId);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(row)) reject("CONFLICTING_DUPLICATE");
    unique.set(row.rowId, row);
  }
  const dataThroughAtIso = timestamp(record.dataThroughAtIso, maximumMs);
  if (rows.some((row) => Date.parse(row.chargePeriodEndIso) > Date.parse(dataThroughAtIso))) reject("INVALID_INPUT");
  if (record.contactResourceIdsIncluded === false && rows.some((row) => row.contactToken !== null)) reject("INVALID_INPUT");
  if (!activatedSystemTags.includes("aws:connect:systemEndpoint") && rows.some((row) => row.endpointToken !== null)) reject("INVALID_INPUT");
  return {
    source: "AWS_CUR2_ACTIVE_GENERATION",
    generationId: record.generationId,
    manifestSha256: record.manifestSha256,
    dataThroughAtIso,
    costBasis: choice(record.costBasis, ["UNBLENDED", "AMORTIZED", "NET_UNBLENDED", "NET_AMORTIZED"] as const),
    currency: record.currency,
    rowsExhausted: record.rowsExhausted,
    contactResourceIdsIncluded: record.contactResourceIdsIncluded,
    activatedSystemTags,
    rows: [...unique.values()].sort((a, b) => a.rowId.localeCompare(b.rowId)),
  };
}

function parsePrivacy(value: unknown): AmazonConnectPrivacyBoundary {
  const record = exact(value, ["rawContactRecordsAccepted", "rawPhoneNumbersAccepted", "tokenization", "tokenKeyVersion", "contactDrilldownEnabled"]);
  if (record.rawContactRecordsAccepted !== false || record.rawPhoneNumbersAccepted !== false
    || record.tokenization !== "HMAC_SHA256_TENANT_SCOPED_ROTATING"
    || typeof record.contactDrilldownEnabled !== "boolean" || typeof record.tokenKeyVersion !== "string"
    || !KEY_VERSION.test(record.tokenKeyVersion)) reject("INVALID_INPUT");
  return {
    rawContactRecordsAccepted: false,
    rawPhoneNumbersAccepted: false,
    tokenization: "HMAC_SHA256_TENANT_SCOPED_ROTATING",
    tokenKeyVersion: record.tokenKeyVersion,
    contactDrilldownEnabled: record.contactDrilldownEnabled,
  };
}

export function normalizeAmazonConnectCostInsightCapture(
  input: AmazonConnectCostInsightCapture,
  expectedScope: AmazonConnectScope,
  nowMs = Date.now(),
): AmazonConnectCostInsightSnapshot {
  if (!Number.isFinite(nowMs) || jsonBytes(input) > AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumCaptureBytes) reject("BOUND_REACHED");
  const root = exact(input, ["schemaVersion", "scope", "captureId", "startedAtIso", "completedAtIso", "execution", "privacy", "collections", "costEvidence"]);
  if (root.schemaVersion !== "sutra.amazon-connect-cost-insight.v1" || typeof root.captureId !== "string" || !CAPTURE_ID.test(root.captureId)) reject("INVALID_INPUT");
  const trustedScope = parseScope(expectedScope);
  const captureScope = parseScope(root.scope);
  if (!sameScope(trustedScope, captureScope)) reject("SCOPE_MISMATCH");
  const startedAtIso = timestamp(root.startedAtIso, nowMs + MAX_CLOCK_SKEW_MS);
  const completedAtIso = timestamp(root.completedAtIso, nowMs + MAX_CLOCK_SKEW_MS);
  const duration = Date.parse(completedAtIso) - Date.parse(startedAtIso);
  if (duration < 0 || duration > AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumDurationMs) reject("BOUND_REACHED");
  const execution = exact(root.execution, ["concurrencyLimit", "observedPeakConcurrency"]);
  if (execution.concurrencyLimit !== 4 || !Number.isInteger(execution.observedPeakConcurrency)
    || (execution.observedPeakConcurrency as number) < 0 || (execution.observedPeakConcurrency as number) > 4) reject("BOUND_REACHED");
  const privacy = parsePrivacy(root.privacy);
  if (!Array.isArray(root.collections) || root.collections.length !== trustedScope.instanceArns.length) reject("INVALID_INPUT");
  const collections = root.collections.map((item, index) => parseCollection(item, trustedScope.instanceArns[index] ?? "", trustedScope, Date.parse(completedAtIso)));
  if (collections.reduce((sum, item) => sum + item.apiCallCount, 0) > AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumApiCalls
    || collections.reduce((sum, item) => sum + item.phoneRecordsScanned, 0) > AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumPhoneRecordsScanned) reject("BOUND_REACHED");
  const costEvidence = parseCostEvidence(root.costEvidence, trustedScope, Date.parse(completedAtIso));
  if (!privacy.contactDrilldownEnabled && costEvidence.rows.some((row) => row.contactToken !== null)) reject("INVALID_INPUT");

  const configurationRequired = trustedScope.instanceArns.length === 0 || collections.some((item) => !item.configured);
  const permissionRequired = collections.some((item) => item.configured && item.regionSupported && !item.permissionsValidated);
  const failed = collections.some((item) => item.failureCode !== null && item.instance === null);
  const partial = collections.some((item) => item.failureCode !== null || !item.pagesExhausted) || !costEvidence.rowsExhausted;
  const sourceFresh = nowMs - Date.parse(completedAtIso) <= AMAZON_CONNECT_COST_INSIGHT_BOUNDS.sourceFreshnessHours * HOUR_MS;
  const costFresh = nowMs - Date.parse(costEvidence.dataThroughAtIso) <= AMAZON_CONNECT_COST_INSIGHT_BOUNDS.sourceFreshnessHours * HOUR_MS;
  const stale = !sourceFresh || !costFresh || collections.some((item) => item.instance !== null
    && nowMs - Date.parse(item.instance.observedAtIso) > AMAZON_CONNECT_COST_INSIGHT_BOUNDS.sourceFreshnessHours * HOUR_MS);
  const recordCount = collections.filter((item) => item.instance !== null).length
    + collections.reduce((sum, item) => sum + item.phoneInventory.length, 0) + costEvidence.rows.length;
  let state: AmazonConnectState;
  if (configurationRequired) state = "configuration_required";
  else if (permissionRequired) state = "permission_required";
  else if (failed) state = "failed";
  else if (partial) state = "partial";
  else if (stale) state = "stale";
  else if (recordCount === 0) state = "empty";
  else state = "current";
  const limitations = [
    "Raw contact records, contact IDs, telephone numbers, phone-number descriptions, endpoint addresses, recordings, transcripts, agent identifiers, and provider messages are forbidden at the broker boundary.",
    "Contact and endpoint correlation uses rotating tenant-scoped HMAC tokens; contact-level results require a separately authorized, expiring, audited grant.",
    "CUR2 totals preserve the selected cost basis, currency, signed micros, usage type, operation, and unit; unlike units and currencies are never combined.",
    "Amazon Connect instance and phone inventory APIs prove configuration only; they do not prove call quality, customer outcomes, agent performance, or billing reconciliation.",
  ];
  if (!costEvidence.contactResourceIdsIncluded) limitations.push("CUR2 contact resource IDs are not enabled, so contact-level cost search is unavailable.");
  if (!costEvidence.activatedSystemTags.includes("aws:connect:systemEndpoint")) limitations.push("The Connect systemEndpoint allocation tag is not activated, so endpoint-level telecom attribution is unavailable.");
  if (!costEvidence.rowsExhausted || collections.some((item) => !item.pagesExhausted)) limitations.push("A source bound or interruption was reached; totals and phone inventory coverage are partial.");
  if (!sourceFresh || !costFresh) limitations.push("Control-plane or active CUR2 evidence is older than the 48-hour freshness SLA.");
  const tokenizedRows = costEvidence.rows.filter((row) => row.contactToken !== null).length;
  const contactDetailCoverage = !privacy.contactDrilldownEnabled || !costEvidence.contactResourceIdsIncluded
    ? "NOT_ENABLED"
    : tokenizedRows === costEvidence.rows.length && costEvidence.rows.length > 0
      ? "TOKENIZED_COMPLETE"
      : "TOKENIZED_PARTIAL";
  return {
    schemaVersion: "sutra.amazon-connect-cost-insight-snapshot.v1",
    scope: trustedScope,
    captureId: root.captureId,
    completedAtIso,
    state,
    complete: !configurationRequired && !permissionRequired && !failed && !partial,
    contactDetailCoverage,
    privacy,
    collections,
    costEvidence,
    limitations,
  };
}

export function amazonConnectCostInsightSourceEvidence(snapshot: AmazonConnectCostInsightSnapshot): FinopsSourceEvidence {
  const acceptedRecords = snapshot.collections.filter((item) => item.instance !== null).length
    + snapshot.collections.reduce((sum, item) => sum + item.phoneInventory.length, 0)
    + snapshot.costEvidence.rows.length;
  return {
    scope: snapshot.scope,
    sourceId: "amazon_connect_telemetry",
    configured: snapshot.state !== "configuration_required",
    deliveryObserved: true,
    lastAttemptAt: snapshot.completedAtIso,
    lastAttemptOutcome: snapshot.complete ? "succeeded" : "partial",
    lastSuccessAt: snapshot.complete ? snapshot.completedAtIso : null,
    dataThroughAt: snapshot.costEvidence.dataThroughAtIso,
    coverage: {
      assessment: snapshot.complete ? "complete" : "partial",
      acceptedRecords,
      expectedRecords: snapshot.complete ? acceptedRecords : null,
      rejectedRecords: 0,
    },
    lastError: null,
    evidenceBasis: "Tenant/account/Region/instance-pinned Amazon Connect configuration and aggregated phone inventory combined with tokenized rows from one immutable active CUR2 generation.",
    limitations: snapshot.limitations,
  };
}

export interface AmazonConnectCostInsightDashboard {
  readonly schemaVersion: "sutra.amazon-connect-cost-insight-dashboard.v1";
  readonly scope: AmazonConnectScope;
  readonly generatedAtIso: string;
  readonly state: AmazonConnectState;
  readonly contactDetailCoverage: AmazonConnectCostInsightSnapshot["contactDetailCoverage"];
  readonly lineage: {
    readonly captureId: string;
    readonly billingGenerationId: string;
    readonly billingManifestSha256: string;
    readonly dataThroughAtIso: string;
    readonly costBasis: AmazonConnectCostBasis;
    readonly currency: string;
  };
  readonly overview: {
    readonly instanceCount: number;
    readonly phoneNumberCount: number;
    readonly costMicros: string;
    readonly unattributedCostMicros: string;
    readonly usageRowCount: number;
    readonly tokenizedContactCount: number;
  };
  readonly instances: readonly ({
    readonly observation: AmazonConnectInstanceObservation;
    readonly phoneNumberCount: number;
    readonly costMicros: string;
  })[];
  readonly telecom: readonly ({
    readonly countryCode: string | null;
    readonly phoneNumberType: AmazonConnectPhoneNumberType | null;
    readonly direction: AmazonConnectDirection;
    readonly costMicros: string;
    readonly quantityMicros: string;
    readonly unit: string | null;
    readonly rowCount: number;
  })[];
  readonly dailyUsage: readonly ({
    readonly day: string;
    readonly service: AmazonConnectCur2CostRow["service"];
    readonly chargeFamily: AmazonConnectChargeFamily;
    readonly channel: AmazonConnectChannel;
    readonly direction: AmazonConnectDirection;
    readonly usageType: string | null;
    readonly unit: string | null;
    readonly quantityMicros: string;
    readonly costMicros: string;
    readonly rowCount: number;
  })[];
  readonly callPatterns: readonly ({
    readonly instanceArn: string | null;
    readonly channel: AmazonConnectChannel;
    readonly direction: AmazonConnectDirection;
    readonly countryCode: string | null;
    readonly phoneNumberType: AmazonConnectPhoneNumberType | null;
    readonly contactCount: number;
    readonly costMicros: string;
    readonly quantityMicros: string;
    readonly unit: string | null;
  })[];
  readonly limitations: readonly string[];
}

interface Aggregate {
  cost: bigint;
  quantity: bigint;
  rows: number;
  contacts: Set<string>;
}

function aggregate(map: Map<string, Aggregate>, key: string, row: AmazonConnectCur2CostRow): void {
  const item = map.get(key) ?? { cost: BigInt(0), quantity: BigInt(0), rows: 0, contacts: new Set<string>() };
  item.cost += BigInt(row.costMicros);
  item.quantity += BigInt(row.usageQuantityMicros);
  item.rows += 1;
  if (row.contactToken !== null) item.contacts.add(row.contactToken);
  map.set(key, item);
}

export function buildAmazonConnectCostInsightDashboard(
  snapshot: AmazonConnectCostInsightSnapshot,
  nowMs = Date.now(),
): AmazonConnectCostInsightDashboard {
  if (!Number.isFinite(nowMs) || jsonBytes(snapshot) > AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumDashboardBytes) reject("BOUND_REACHED");
  const costsByInstance = new Map<string, bigint>();
  let unattributedCost = BigInt(0);
  let totalCost = BigInt(0);
  const tokens = new Set<string>();
  const telecom = new Map<string, Aggregate>();
  const daily = new Map<string, Aggregate>();
  const patterns = new Map<string, Aggregate>();
  for (const row of snapshot.costEvidence.rows) {
    const cost = BigInt(row.costMicros);
    totalCost += cost;
    if (row.instanceArn === null) unattributedCost += cost;
    else costsByInstance.set(row.instanceArn, (costsByInstance.get(row.instanceArn) ?? BigInt(0)) + cost);
    if (row.contactToken !== null) tokens.add(row.contactToken);
    if (row.service === "CONTACT_CENTER_TELECOM" || row.chargeFamily.startsWith("TELEPHONY_") || row.chargeFamily === "PHONE_NUMBER") {
      aggregate(telecom, JSON.stringify([row.countryCode, row.phoneNumberType, row.direction, row.usageUnit]), row);
    }
    const day = row.chargePeriodStartIso.slice(0, 10);
    if (!DAY.test(day)) reject("INVALID_INPUT");
    aggregate(daily, JSON.stringify([day, row.service, row.chargeFamily, row.channel, row.direction, row.usageType, row.usageUnit]), row);
    aggregate(patterns, JSON.stringify([row.instanceArn, row.channel, row.direction, row.countryCode, row.phoneNumberType, row.usageUnit]), row);
  }
  if (telecom.size > AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumDashboardGroups
    || daily.size > AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumDashboardGroups
    || patterns.size > AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumDashboardGroups) reject("BOUND_REACHED");
  const phoneNumberCount = snapshot.collections.reduce((sum, collection) => sum
    + collection.phoneInventory.reduce((inner, item) => inner + item.count, 0), 0);
  return {
    schemaVersion: "sutra.amazon-connect-cost-insight-dashboard.v1",
    scope: snapshot.scope,
    generatedAtIso: new Date(nowMs).toISOString(),
    state: snapshot.state,
    contactDetailCoverage: snapshot.contactDetailCoverage,
    lineage: {
      captureId: snapshot.captureId,
      billingGenerationId: snapshot.costEvidence.generationId,
      billingManifestSha256: snapshot.costEvidence.manifestSha256,
      dataThroughAtIso: snapshot.costEvidence.dataThroughAtIso,
      costBasis: snapshot.costEvidence.costBasis,
      currency: snapshot.costEvidence.currency,
    },
    overview: {
      instanceCount: snapshot.collections.filter((item) => item.instance !== null).length,
      phoneNumberCount,
      costMicros: totalCost.toString(),
      unattributedCostMicros: unattributedCost.toString(),
      usageRowCount: snapshot.costEvidence.rows.length,
      tokenizedContactCount: tokens.size,
    },
    instances: snapshot.collections.flatMap((collection) => collection.instance === null ? [] : [{
      observation: collection.instance,
      phoneNumberCount: collection.phoneRecordsScanned,
      costMicros: (costsByInstance.get(collection.instanceArn) ?? BigInt(0)).toString(),
    }]),
    telecom: [...telecom.entries()].map(([key, value]) => {
      const [countryCode, phoneNumberType, direction, unit] = JSON.parse(key) as [string | null, AmazonConnectPhoneNumberType | null, AmazonConnectDirection, string | null];
      return { countryCode, phoneNumberType, direction, costMicros: value.cost.toString(), quantityMicros: value.quantity.toString(), unit, rowCount: value.rows };
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    dailyUsage: [...daily.entries()].map(([key, value]) => {
      const [day, service, chargeFamily, channel, direction, usageType, unit] = JSON.parse(key) as [string, AmazonConnectCur2CostRow["service"], AmazonConnectChargeFamily, AmazonConnectChannel, AmazonConnectDirection, string | null, string | null];
      return { day, service, chargeFamily, channel, direction, usageType, unit, quantityMicros: value.quantity.toString(), costMicros: value.cost.toString(), rowCount: value.rows };
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    callPatterns: [...patterns.entries()].map(([key, value]) => {
      const [parsedInstanceArn, channel, direction, countryCode, phoneNumberType, unit] = JSON.parse(key) as [string | null, AmazonConnectChannel, AmazonConnectDirection, string | null, AmazonConnectPhoneNumberType | null, string | null];
      return { instanceArn: parsedInstanceArn, channel, direction, countryCode, phoneNumberType, contactCount: value.contacts.size, costMicros: value.cost.toString(), quantityMicros: value.quantity.toString(), unit };
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    limitations: snapshot.limitations,
  };
}

export interface AmazonConnectSensitiveDrilldownGrant {
  readonly schemaVersion: "sutra.amazon-connect-sensitive-grant.v1";
  readonly grantId: string;
  readonly auditEventId: string;
  readonly scope: AmazonConnectScope;
  /** SHA-256/HMAC of the requesting principal, never an email or user name. */
  readonly subjectHash: string;
  readonly purposeCode: "FINOPS_COST_INVESTIGATION" | "TELECOM_RECONCILIATION";
  readonly issuedAtIso: string;
  readonly expiresAtIso: string;
  readonly allowTokenizedContactDrilldown: true;
}

export interface AmazonConnectContactDrilldown {
  readonly schemaVersion: "sutra.amazon-connect-contact-drilldown.v1";
  readonly displayContactToken: string;
  readonly auditEventId: string;
  readonly billingGenerationId: string;
  readonly currency: string;
  readonly costBasis: AmazonConnectCostBasis;
  readonly rows: readonly Omit<AmazonConnectCur2CostRow, "contactToken" | "endpointToken">[];
  readonly totalCostMicros: string;
}

function withoutSensitiveTokens(
  row: AmazonConnectCur2CostRow,
): Omit<AmazonConnectCur2CostRow, "contactToken" | "endpointToken"> {
  const safeRow: { -readonly [Key in keyof AmazonConnectCur2CostRow]?: AmazonConnectCur2CostRow[Key] } = { ...row };
  delete safeRow.contactToken;
  delete safeRow.endpointToken;
  return safeRow as Omit<AmazonConnectCur2CostRow, "contactToken" | "endpointToken">;
}

/**
 * Returns only token-correlated billing facts. It never reveals the raw AWS
 * contact ID, endpoint token, phone number, contact record, or transcript.
 */
export function buildAmazonConnectContactDrilldown(
  snapshot: AmazonConnectCostInsightSnapshot,
  contactToken: string,
  grant: AmazonConnectSensitiveDrilldownGrant,
  nowMs = Date.now(),
): AmazonConnectContactDrilldown {
  if (!snapshot.privacy.contactDrilldownEnabled || !CONTACT_TOKEN.test(contactToken)) reject("SENSITIVE_ACCESS_DENIED");
  const record = exact(grant, ["schemaVersion", "grantId", "auditEventId", "scope", "subjectHash", "purposeCode", "issuedAtIso", "expiresAtIso", "allowTokenizedContactDrilldown"]);
  if (record.schemaVersion !== "sutra.amazon-connect-sensitive-grant.v1" || typeof record.grantId !== "string" || !GRANT_ID.test(record.grantId)
    || typeof record.auditEventId !== "string" || !AUDIT_ID.test(record.auditEventId)
    || typeof record.subjectHash !== "string" || !SHA256.test(record.subjectHash)
    || record.allowTokenizedContactDrilldown !== true) reject("SENSITIVE_ACCESS_DENIED");
  const grantScope = parseScope(record.scope);
  if (!sameScope(snapshot.scope, grantScope)) reject("SENSITIVE_ACCESS_DENIED");
  choice(record.purposeCode, ["FINOPS_COST_INVESTIGATION", "TELECOM_RECONCILIATION"] as const);
  const issuedAtIso = timestamp(record.issuedAtIso, nowMs);
  const expiresAtIso = timestamp(record.expiresAtIso, nowMs + AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumSensitiveGrantMinutes * 60_000);
  if (Date.parse(expiresAtIso) <= nowMs || Date.parse(expiresAtIso) <= Date.parse(issuedAtIso)
    || Date.parse(expiresAtIso) - Date.parse(issuedAtIso) > AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumSensitiveGrantMinutes * 60_000) reject("SENSITIVE_ACCESS_DENIED");
  const matches = snapshot.costEvidence.rows.filter((row) => row.contactToken === contactToken);
  if (matches.length === 0 || matches.length > AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumContactRowsPerDrilldown) reject("SENSITIVE_ACCESS_DENIED");
  let total = BigInt(0);
  const rows = matches.map((row) => {
    total += BigInt(row.costMicros);
    return withoutSensitiveTokens(row);
  });
  return {
    schemaVersion: "sutra.amazon-connect-contact-drilldown.v1",
    displayContactToken: `contact-${contactToken.slice(4, 16)}`,
    auditEventId: record.auditEventId,
    billingGenerationId: snapshot.costEvidence.generationId,
    currency: snapshot.costEvidence.currency,
    costBasis: snapshot.costEvidence.costBasis,
    rows,
    totalCostMicros: total.toString(),
  };
}

export interface AmazonConnectCostInsightBrokerRequest {
  readonly schemaVersion: "sutra.amazon-connect-cost-insight-query.v1";
  readonly scope: AmazonConnectScope;
  readonly operations: typeof AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS;
  readonly requiredBillingSource: "AWS_CUR2_ACTIVE_GENERATION";
  readonly bounds: typeof AMAZON_CONNECT_COST_INSIGHT_BOUNDS;
  readonly privacy: {
    readonly rawContactRecordsAccepted: false;
    readonly rawPhoneNumbersAccepted: false;
    readonly requiredTokenization: "HMAC_SHA256_TENANT_SCOPED_ROTATING";
  };
}

export interface AmazonConnectCostInsightTransport {
  readonly collect: (request: AmazonConnectCostInsightBrokerRequest) => Promise<AmazonConnectCostInsightCapture>;
}

export class AmazonConnectCostInsightQueryError extends Error {
  public readonly code: "SOURCE_UNAVAILABLE" | "INVALID_EVIDENCE";
  public constructor(code: "SOURCE_UNAVAILABLE" | "INVALID_EVIDENCE") {
    super("Amazon Connect cost evidence is unavailable");
    this.name = "AmazonConnectCostInsightQueryError";
    this.code = code;
  }
}

export function createAmazonConnectCostInsightQueryService(
  configuredScope: AmazonConnectScope,
  transport: AmazonConnectCostInsightTransport,
  now: () => number = Date.now,
): { readonly query: () => Promise<AmazonConnectCostInsightDashboard> } {
  const trustedScope = parseScope(configuredScope);
  return {
    async query(): Promise<AmazonConnectCostInsightDashboard> {
      let capture: AmazonConnectCostInsightCapture;
      try {
        capture = await transport.collect({
          schemaVersion: "sutra.amazon-connect-cost-insight-query.v1",
          scope: trustedScope,
          operations: AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS,
          requiredBillingSource: "AWS_CUR2_ACTIVE_GENERATION",
          bounds: AMAZON_CONNECT_COST_INSIGHT_BOUNDS,
          privacy: {
            rawContactRecordsAccepted: false,
            rawPhoneNumbersAccepted: false,
            requiredTokenization: "HMAC_SHA256_TENANT_SCOPED_ROTATING",
          },
        });
      } catch {
        throw new AmazonConnectCostInsightQueryError("SOURCE_UNAVAILABLE");
      }
      try {
        const currentTime = now();
        return buildAmazonConnectCostInsightDashboard(normalizeAmazonConnectCostInsightCapture(capture, trustedScope, currentTime), currentTime);
      } catch {
        throw new AmazonConnectCostInsightQueryError("INVALID_EVIDENCE");
      }
    },
  };
}
