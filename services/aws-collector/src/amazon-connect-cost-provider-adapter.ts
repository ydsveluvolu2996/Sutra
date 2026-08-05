/** Credential-owning, privacy-minimizing ADD-11 Amazon Connect collector. */
import { createHmac } from "node:crypto";

export const AMAZON_CONNECT_COST_PROVIDER_ACTIONS = Object.freeze([
  "connect:DescribeInstance",
  "connect:ListPhoneNumbersV2",
  "ds:DescribeDirectories",
] as const);
export const AMAZON_CONNECT_COST_PROVIDER_SESSION_ACTIONS = Object.freeze([
  "sts:GetCallerIdentity",
  ...AMAZON_CONNECT_COST_PROVIDER_ACTIONS,
] as const);
export const AMAZON_CONNECT_COST_PROVIDER_BOUNDS = Object.freeze({
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

type Partition = "aws" | "aws-cn" | "aws-us-gov";
type Failure = "ACCESS_DENIED" | "THROTTLED" | "TIMEOUT" | "BOUND_REACHED"
  | "PROVIDER_UNAVAILABLE" | "INVALID_PAGINATION" | "UNKNOWN";
const INSTANCE = /^arn:(aws|aws-cn|aws-us-gov):connect:([a-z0-9-]+):(\d{12}):instance\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;
const SAFE = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const COUNTRY = /^[A-Z]{2}$/u;
const TOKEN = /^[A-Za-z0-9+/=_.:-]{1,8192}$/u;

export interface AmazonConnectCostProviderRequest {
  readonly schemaVersion: "sutra.amazon-connect-cost-runtime-request.v1";
  readonly requestId: string;
  readonly expectedCaptureId: string;
  readonly scheduledWindow: string;
  readonly scope: { readonly orgId: string; readonly customerId: string; readonly connectionId: string;
    readonly accountId: string; readonly partition: Partition; readonly region: string;
    readonly instanceArns: readonly string[] };
  readonly credentials: "SERVER_OWNED_TRUST_ROLE_SESSION";
  readonly operations: typeof AMAZON_CONNECT_COST_PROVIDER_ACTIONS;
  readonly permissionAttestation: Readonly<Record<string, unknown>>;
  readonly providerReads: Readonly<Record<string, unknown>>;
  readonly billing: { readonly source: "AWS_CUR2_ACTIVE_GENERATION"; readonly state: "ACTIVE_RECONCILED";
    readonly generationId: string; readonly sourceEvidenceId: string; readonly manifestSha256: string;
    readonly dataThroughAtIso: string; readonly costBasis: string; readonly currency: string;
    readonly rowsExhausted: true; readonly contactResourceIdsIncluded: boolean;
    readonly activatedSystemTags: readonly string[]; readonly predicate: string;
    readonly classificationContractVersion: string; readonly associatedServiceCoverage: "NOT_INCLUDED_SEPARATE_EVIDENCE_REQUIRED" };
  readonly privacy: { readonly rawContactRecordsAccepted: false; readonly rawPhoneNumbersAccepted: false;
    readonly rawPhoneArnsOrIdsAccepted: false; readonly rawDescriptionsAccepted: false;
    readonly rawCallerIdentityAccepted: false; readonly rawEndpointAddressesAccepted: false;
    readonly rawDirectoryDetailsAccepted: false; readonly rawProviderErrorTextAccepted: false;
    readonly tokenization: "HMAC_SHA256_TENANT_SCOPED_ROTATING";
    readonly tokenKeyVersion: string; readonly contactDrilldownEnabled: boolean };
  readonly incompleteDisposition: "PERSIST_HISTORY_NEVER_ADVANCE_HEAD";
  readonly bounds: typeof AMAZON_CONNECT_COST_PROVIDER_BOUNDS;
  readonly archiveMaximumBytes: number;
  readonly maximumDurationMs: number;
}

export interface AmazonConnectCostProviderReader {
  describeInstance(input: { readonly InstanceId: string }, signal: AbortSignal): Promise<unknown>;
  listPhoneNumbersV2(input: { readonly TargetArn: string; readonly MaxResults: 1_000;
    readonly NextToken?: string }, signal: AbortSignal): Promise<unknown>;
}

export interface AmazonConnectCostRawCur2Row {
  readonly rowId: string; readonly accountId: string; readonly region: string;
  readonly instanceArn: string | null; readonly rawContactResourceId: string | null;
  readonly rawSystemEndpoint: string | null; readonly chargePeriodStartIso: string;
  readonly chargePeriodEndIso: string; readonly service: "AMAZON_CONNECT" | "CONTACT_CENTER_TELECOM";
  readonly chargeFamily: string; readonly channel: string; readonly direction: string;
  readonly countryCode: string | null; readonly phoneNumberType: string | null;
  readonly operation: string | null; readonly usageType: string | null; readonly usageUnit: string | null;
  readonly usageQuantityMicros: string; readonly costMicros: string; readonly chargeCategory: string;
  readonly classificationBasis: string;
}
export interface AmazonConnectCostRawCur2Projection {
  readonly source: "AWS_CUR2_ACTIVE_GENERATION"; readonly generationId: string;
  readonly manifestSha256: string; readonly dataThroughAtIso: string; readonly costBasis: string;
  readonly currency: string; readonly rowsExhausted: true; readonly contactResourceIdsIncluded: boolean;
  readonly activatedSystemTags: readonly string[]; readonly rows: readonly AmazonConnectCostRawCur2Row[];
}

export class AmazonConnectCostProviderError extends Error {
  public constructor(public readonly code: "INVALID_REQUEST" | "PROVIDER_RESPONSE_INVALID"
    | "BOUND_REACHED" | "ABORTED") {
    super("Amazon Connect cost provider collection did not complete");
    this.name = "AmazonConnectCostProviderError";
  }
}
function reject(code: AmazonConnectCostProviderError["code"]): never {
  throw new AmazonConnectCostProviderError(code);
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject("PROVIDER_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 512): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
    || !SAFE.test(value) || value.trim() !== value) reject("PROVIDER_RESPONSE_INVALID");
  return value;
}
function nullableToken(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !TOKEN.test(value)) reject("PROVIDER_RESPONSE_INVALID");
  return value;
}
function failure(error: unknown, signal: AbortSignal): Failure {
  if (signal.aborted) return "TIMEOUT";
  if (error instanceof AmazonConnectCostProviderError) {
    if (error.code === "BOUND_REACHED") return "BOUND_REACHED";
    if (error.code === "ABORTED") return "TIMEOUT";
  }
  const name = typeof error === "object" && error !== null && "name" in error
    ? String((error as { readonly name: unknown }).name) : "";
  if (/accessdenied|unauthorized|notauthorized/iu.test(name)) return "ACCESS_DENIED";
  if (/throttl|toomanyrequest|requestlimit/iu.test(name)) return "THROTTLED";
  if (/timeout|abort/iu.test(name)) return "TIMEOUT";
  if (/serviceunavailable|internal|network|socket/iu.test(name)) return "PROVIDER_UNAVAILABLE";
  return "UNKNOWN";
}
function hmac(prefix: "ctk" | "epk", key: Uint8Array, request: AmazonConnectCostProviderRequest, value: string): string {
  return `${prefix}_${createHmac("sha256", key).update(JSON.stringify({
    schemaVersion: "sutra.amazon-connect-tenant-token.v1",
    tenantId: request.scope.orgId,
    customerId: request.scope.customerId,
    connectionId: request.scope.connectionId,
    keyVersion: request.privacy.tokenKeyVersion,
    kind: prefix,
    value,
  })).digest("hex")}`;
}

function sanitizeCur2(input: {
  readonly request: AmazonConnectCostProviderRequest;
  readonly projection: AmazonConnectCostRawCur2Projection;
  readonly tokenKey: Uint8Array;
}) {
  const { request, projection } = input;
  if (projection.generationId !== request.billing.generationId
    || projection.manifestSha256 !== request.billing.manifestSha256
    || projection.dataThroughAtIso !== request.billing.dataThroughAtIso
    || projection.costBasis !== request.billing.costBasis
    || projection.currency !== request.billing.currency
    || projection.rowsExhausted !== true
    || projection.contactResourceIdsIncluded !== request.billing.contactResourceIdsIncluded
    || JSON.stringify(projection.activatedSystemTags) !== JSON.stringify(request.billing.activatedSystemTags)
    || projection.rows.length > AMAZON_CONNECT_COST_PROVIDER_BOUNDS.maximumCostRows) reject("PROVIDER_RESPONSE_INVALID");
  const seen = new Set<string>();
  const rows = projection.rows.map((row) => {
    if (seen.has(row.rowId) || row.accountId !== request.scope.accountId
      || row.region !== request.scope.region
      || (row.instanceArn !== null && !request.scope.instanceArns.includes(row.instanceArn))
      || (row.rawContactResourceId !== null && (!projection.contactResourceIdsIncluded
        || !request.privacy.contactDrilldownEnabled))
      || (row.rawSystemEndpoint !== null
        && !projection.activatedSystemTags.includes("aws:connect:systemEndpoint"))) {
      reject("PROVIDER_RESPONSE_INVALID");
    }
    seen.add(row.rowId);
    const { rawContactResourceId, rawSystemEndpoint, ...safe } = row;
    return Object.freeze({
      ...safe,
      contactToken: rawContactResourceId === null ? null : hmac("ctk", input.tokenKey, request, rawContactResourceId),
      endpointToken: rawSystemEndpoint === null ? null : hmac("epk", input.tokenKey, request, rawSystemEndpoint),
    });
  }).sort((left, right) => left.rowId.localeCompare(right.rowId));
  return Object.freeze({
    source: projection.source,
    generationId: projection.generationId,
    manifestSha256: projection.manifestSha256,
    dataThroughAtIso: projection.dataThroughAtIso,
    costBasis: projection.costBasis,
    currency: projection.currency,
    rowsExhausted: true as const,
    contactResourceIdsIncluded: projection.contactResourceIdsIncluded,
    activatedSystemTags: Object.freeze([...projection.activatedSystemTags]),
    rows: Object.freeze(rows),
  });
}

async function collectInstance(input: {
  readonly request: AmazonConnectCostProviderRequest;
  readonly instanceArn: string;
  readonly reader: AmazonConnectCostProviderReader;
  readonly signal: AbortSignal;
  readonly observedAtIso: string;
  readonly takeApiCall: () => void;
  readonly takePhoneRecord: () => void;
}) {
  const match = INSTANCE.exec(input.instanceArn);
  if (match === null || match[1] !== input.request.scope.partition
    || match[2] !== input.request.scope.region || match[3] !== input.request.scope.accountId) reject("INVALID_REQUEST");
  let apiCallCount = 0;
  let phoneRecordsScanned = 0;
  try {
    if (input.signal.aborted) reject("ABORTED");
    input.takeApiCall(); apiCallCount += 1;
    const described = record(await input.reader.describeInstance({ InstanceId: match[4]! }, input.signal));
    const instance = record(described.Instance);
    const id = text(instance.Id, 36);
    const arn = text(instance.Arn, 256);
    if (id !== match[4] || arn !== input.instanceArn) reject("PROVIDER_RESPONSE_INVALID");
    const alias = text(instance.InstanceAlias, 62);
    const status = text(instance.InstanceStatus, 64);
    if (!["CREATION_IN_PROGRESS", "ACTIVE", "CREATION_FAILED"].includes(status)
      || typeof instance.InboundCallsEnabled !== "boolean"
      || typeof instance.OutboundCallsEnabled !== "boolean") reject("PROVIDER_RESPONSE_INVALID");
    const aggregates = new Map<string, { countryCode: string; phoneNumberType: string; status: string; count: number }>();
    let next: string | null = null;
    const seenTokens = new Set<string>();
    do {
      input.takeApiCall(); apiCallCount += 1;
      const page = record(await input.reader.listPhoneNumbersV2({
        TargetArn: input.instanceArn,
        MaxResults: 1_000,
        ...(next === null ? {} : { NextToken: next }),
      }, input.signal));
      if (!Array.isArray(page.ListPhoneNumbersSummaryList)
        || page.ListPhoneNumbersSummaryList.length > 1_000) reject("PROVIDER_RESPONSE_INVALID");
      for (const raw of page.ListPhoneNumbersSummaryList) {
        const item = record(raw);
        const countryCode = text(item.PhoneNumberCountryCode, 2);
        const phoneNumberType = text(item.PhoneNumberType, 64);
        const phoneStatus = text(item.PhoneNumberStatus, 64);
        if (!COUNTRY.test(countryCode)
          || !["DID", "TOLL_FREE", "UIFN", "SHARED_COST", "THIRD_PARTY"].includes(phoneNumberType)
          || !["CLAIMED", "IN_PROGRESS", "FAILED"].includes(phoneStatus)) reject("PROVIDER_RESPONSE_INVALID");
        input.takePhoneRecord(); phoneRecordsScanned += 1;
        const key = JSON.stringify([countryCode, phoneNumberType, phoneStatus]);
        const aggregate = aggregates.get(key) ?? { countryCode, phoneNumberType, status: phoneStatus, count: 0 };
        aggregate.count += 1;
        aggregates.set(key, aggregate);
      }
      const emitted = nullableToken(page.NextToken);
      if (emitted !== null && (emitted === next || seenTokens.has(emitted))) {
        throw Object.assign(new Error("pagination"), { safeCode: "INVALID_PAGINATION" });
      }
      if (emitted !== null) seenTokens.add(emitted);
      next = emitted;
    } while (next !== null);
    if (aggregates.size > AMAZON_CONNECT_COST_PROVIDER_BOUNDS.maximumPhoneAggregateRows) reject("BOUND_REACHED");
    return Object.freeze({
      instanceArn: input.instanceArn, configured: true, regionSupported: true,
      permissionsValidated: true, pagesExhausted: true, apiCallCount, phoneRecordsScanned,
      failureCode: null,
      instance: Object.freeze({ instanceArn: arn, instanceId: id, alias, status,
        inboundCallsEnabled: instance.InboundCallsEnabled,
        outboundCallsEnabled: instance.OutboundCallsEnabled, observedAtIso: input.observedAtIso }),
      phoneInventory: Object.freeze([...aggregates.values()].map((item) => Object.freeze({
        instanceArn: input.instanceArn, ...item,
      })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))),
    });
  } catch (error) {
    const safeCode = typeof error === "object" && error !== null && "safeCode" in error
      ? String((error as { readonly safeCode: unknown }).safeCode) as Failure
      : failure(error, input.signal);
    return Object.freeze({
      instanceArn: input.instanceArn, configured: true, regionSupported: true,
      permissionsValidated: safeCode !== "ACCESS_DENIED", pagesExhausted: false,
      apiCallCount: safeCode === "ACCESS_DENIED" ? 0 : apiCallCount,
      phoneRecordsScanned: 0, failureCode: safeCode, instance: null,
      phoneInventory: Object.freeze([]),
    });
  }
}

export async function collectAmazonConnectCostProviderEvidence(input: {
  readonly request: AmazonConnectCostProviderRequest;
  readonly reader: AmazonConnectCostProviderReader;
  readonly cur2: AmazonConnectCostRawCur2Projection;
  readonly tokenKey: Uint8Array;
  readonly signal: AbortSignal;
  readonly now?: () => number;
}) {
  if (!(input.signal instanceof AbortSignal) || input.signal.aborted
    || !(input.tokenKey instanceof Uint8Array) || input.tokenKey.byteLength < 32
    || input.tokenKey.byteLength > 64 || input.request.scope.instanceArns.length < 1
    || input.request.scope.instanceArns.length > AMAZON_CONNECT_COST_PROVIDER_BOUNDS.maximumAuthorizedInstances) reject("INVALID_REQUEST");
  const now = input.now ?? Date.now;
  const startedAt = now();
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) reject("INVALID_REQUEST");
  const observedAtIso = new Date(startedAt).toISOString();
  const results = new Array<Awaited<ReturnType<typeof collectInstance>> | undefined>(
    input.request.scope.instanceArns.length,
  );
  let cursor = 0;
  let peak = 0;
  let active = 0;
  let totalApiCalls = 0;
  let totalPhoneRecords = 0;
  const takeApiCall = () => {
    totalApiCalls += 1;
    if (totalApiCalls > AMAZON_CONNECT_COST_PROVIDER_BOUNDS.maximumApiCalls) reject("BOUND_REACHED");
  };
  const takePhoneRecord = () => {
    totalPhoneRecords += 1;
    if (totalPhoneRecords > AMAZON_CONNECT_COST_PROVIDER_BOUNDS.maximumPhoneRecordsScanned) {
      reject("BOUND_REACHED");
    }
  };
  const workers = Array.from({ length: Math.min(4, input.request.scope.instanceArns.length) }, async () => {
    while (cursor < input.request.scope.instanceArns.length) {
      const index = cursor++;
      active += 1;
      peak = Math.max(peak, active);
      try {
        results[index] = await collectInstance({ request: input.request,
          instanceArn: input.request.scope.instanceArns[index]!, reader: input.reader,
          signal: input.signal, observedAtIso, takeApiCall, takePhoneRecord });
      } finally { active -= 1; }
    }
  });
  await Promise.all(workers);
  if ((results as Awaited<ReturnType<typeof collectInstance>>[])
    .reduce((sum, item) => sum + item.phoneInventory.length, 0)
      > AMAZON_CONNECT_COST_PROVIDER_BOUNDS.maximumPhoneAggregateRows) reject("BOUND_REACHED");
  const completedAt = now();
  if (!Number.isSafeInteger(completedAt) || completedAt < startedAt
    || completedAt - startedAt > AMAZON_CONNECT_COST_PROVIDER_BOUNDS.maximumDurationMs) reject("BOUND_REACHED");
  const capture = Object.freeze({
    schemaVersion: "sutra.amazon-connect-cost-insight.v1" as const,
    scope: Object.freeze({ ...input.request.scope,
      instanceArns: Object.freeze([...input.request.scope.instanceArns]) }),
    captureId: input.request.expectedCaptureId,
    startedAtIso: new Date(startedAt).toISOString(),
    completedAtIso: new Date(completedAt).toISOString(),
    execution: Object.freeze({ concurrencyLimit: 4 as const, observedPeakConcurrency: peak }),
    privacy: Object.freeze({ rawContactRecordsAccepted: false as const,
      rawPhoneNumbersAccepted: false as const,
      tokenization: "HMAC_SHA256_TENANT_SCOPED_ROTATING" as const,
      tokenKeyVersion: input.request.privacy.tokenKeyVersion,
      contactDrilldownEnabled: input.request.privacy.contactDrilldownEnabled }),
    collections: Object.freeze(results as Awaited<ReturnType<typeof collectInstance>>[]),
    costEvidence: sanitizeCur2({ request: input.request, projection: input.cur2, tokenKey: input.tokenKey }),
  });
  if (Buffer.byteLength(JSON.stringify(capture), "utf8")
    > AMAZON_CONNECT_COST_PROVIDER_BOUNDS.maximumCaptureBytes) reject("BOUND_REACHED");
  const serialized = JSON.stringify(capture);
  if (/PhoneNumber(?:Id|Arn|Description)|DirectoryId|ServiceRole|AccessUrl|rawContactResourceId|rawSystemEndpoint/iu.test(serialized)) {
    reject("PROVIDER_RESPONSE_INVALID");
  }
  return capture;
}
