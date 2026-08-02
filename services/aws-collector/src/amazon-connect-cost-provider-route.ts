/** Strict signed-route payload boundary for ADD-11 Amazon Connect Cost Insight. */
import { createHash } from "node:crypto";
import type { AwsTemporaryCredentials } from "./types.js";
import { createAmazonConnectCostProviderReader } from
  "./amazon-connect-cost-provider-client.js";
import {
  AMAZON_CONNECT_COST_PROVIDER_ACTIONS,
  AMAZON_CONNECT_COST_PROVIDER_BOUNDS,
  AMAZON_CONNECT_COST_PROVIDER_SESSION_ACTIONS,
  AmazonConnectCostProviderError,
  collectAmazonConnectCostProviderEvidence,
  type AmazonConnectCostProviderReader,
  type AmazonConnectCostProviderRequest,
  type AmazonConnectCostRawCur2Projection,
} from "./amazon-connect-cost-provider-adapter.js";

export const AMAZON_CONNECT_COST_PROVIDER_ROUTE = "/v1/finops/amazon-connect-cost-insights/collect";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const REQUEST = /^acr_[a-f0-9]{64}$/u;
const CAPTURE = /^connect_[a-f0-9]{64}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const SHA = /^[a-f0-9]{64}$/u;
const INSTANCE = /^arn:(aws|aws-cn|aws-us-gov):connect:([a-z0-9-]+):(\d{12}):instance\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;
const MAX_BODY_BYTES = 256 * 1_024;
const PROVIDER_READS = Object.freeze({
  describeOnlyAuthorizedInstanceArns: true,
  listPhoneNumbersTargetArnRequired: true,
  unscopedPhoneNumberListingForbidden: true,
  trafficDistributionGroupsIncluded: false,
  phonePageSize: 1_000,
  rejectPaginationTokenReplay: true,
  requirePerInstanceExhaustionEvidence: true,
});

export interface AmazonConnectCostProviderRouteHeaders {
  readonly tenantId: string; readonly customerId: string;
  readonly connectionId: string; readonly requestId: string;
}
export interface AmazonConnectCostProviderRouteDependencies {
  readonly assumeReadOnlySession: (input: {
    readonly tenantId: string; readonly customerId: string; readonly connectionId: string;
    readonly requestId: string; readonly expectedAccountId: string;
    readonly partition: "aws" | "aws-cn" | "aws-us-gov"; readonly region: string;
    readonly sessionActions: typeof AMAZON_CONNECT_COST_PROVIDER_SESSION_ACTIONS;
    readonly exactInstanceArns: readonly string[]; readonly exactPhoneNumberArn: string;
    readonly signal: AbortSignal;
  }) => Promise<{ readonly accountId: string; readonly partition: "aws" | "aws-cn" | "aws-us-gov";
    readonly credentials: AwsTemporaryCredentials }>;
  readonly readerFactory?: (input: { readonly credentials: AwsTemporaryCredentials;
    readonly accountId: string; readonly partition: "aws" | "aws-cn" | "aws-us-gov";
    readonly region: string }) => AmazonConnectCostProviderReader;
  /** Canonical active CUR2 rows stay inside the collector and may contain raw resource identifiers. */
  readonly loadRawCur2Projection: (input: { readonly tenantId: string; readonly customerId: string;
    readonly connectionId: string; readonly requestId: string;
    readonly billing: AmazonConnectCostProviderRequest["billing"];
    readonly exactInstanceArns: readonly string[] }) => Promise<AmazonConnectCostRawCur2Projection>;
  readonly loadTenantTokenKey: (input: { readonly tenantId: string; readonly customerId: string;
    readonly connectionId: string; readonly keyVersion: string }) => Promise<Uint8Array>;
  readonly now?: () => number;
}

function fail(code: AmazonConnectCostProviderError["code"] = "INVALID_REQUEST"): never {
  throw new AmazonConnectCostProviderError(code);
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  const item = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(item).sort()) !== JSON.stringify([...keys].sort())) fail();
  return item;
}
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function canonicalIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

export function parseAmazonConnectCostProviderRequest(body: string): AmazonConnectCostProviderRequest {
  if (Buffer.byteLength(body, "utf8") < 2 || Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) fail("BOUND_REACHED");
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { fail(); }
  const request = exact(parsed, ["schemaVersion", "requestId", "expectedCaptureId",
    "scheduledWindow", "scope", "credentials", "operations", "permissionAttestation",
    "providerReads", "billing", "privacy", "incompleteDisposition", "bounds",
    "archiveMaximumBytes", "maximumDurationMs"]);
  const scope = exact(request.scope, ["orgId", "customerId", "connectionId", "accountId",
    "partition", "region", "instanceArns"]);
  const billing = exact(request.billing, ["source", "state", "generationId", "sourceEvidenceId",
    "manifestSha256", "dataThroughAtIso", "costBasis", "currency", "rowsExhausted",
    "contactResourceIdsIncluded", "activatedSystemTags", "predicate",
    "classificationContractVersion", "associatedServiceCoverage"]);
  const privacy = exact(request.privacy, ["rawContactRecordsAccepted", "rawPhoneNumbersAccepted",
    "rawPhoneArnsOrIdsAccepted", "rawDescriptionsAccepted", "rawCallerIdentityAccepted",
    "rawEndpointAddressesAccepted", "rawDirectoryDetailsAccepted", "rawProviderErrorTextAccepted",
    "tokenization", "tokenKeyVersion", "contactDrilldownEnabled"]);
  const attestation = exact(request.permissionAttestation, ["generationId", "contentSha256",
    "observedAtIso", "operations", "resources", "denyMutationOperations"]);
  const resources = exact(attestation.resources,
    ["describeInstanceArns", "listPhoneNumbersArn", "directoryServiceResource"]);
  if (request.schemaVersion !== "sutra.amazon-connect-cost-runtime-request.v1"
    || typeof request.requestId !== "string" || !REQUEST.test(request.requestId)
    || typeof request.expectedCaptureId !== "string" || !CAPTURE.test(request.expectedCaptureId)
    || request.expectedCaptureId !== `connect_${request.requestId.slice(4)}`
    || typeof request.scheduledWindow !== "string" || !WINDOW.test(request.scheduledWindow)
    || new Date(Date.parse(request.scheduledWindow)).toISOString() !== request.scheduledWindow
    || typeof scope.orgId !== "string" || !ID.test(scope.orgId)
    || typeof scope.customerId !== "string" || !ID.test(scope.customerId)
    || typeof scope.connectionId !== "string" || !CONNECTION.test(scope.connectionId)
    || typeof scope.accountId !== "string" || !ACCOUNT.test(scope.accountId)
    || !["aws", "aws-cn", "aws-us-gov"].includes(String(scope.partition))
    || typeof scope.region !== "string" || !REGION.test(scope.region)
    || !Array.isArray(scope.instanceArns) || scope.instanceArns.length < 1
    || scope.instanceArns.length > AMAZON_CONNECT_COST_PROVIDER_BOUNDS.maximumAuthorizedInstances
    || !scope.instanceArns.every((arn) => typeof arn === "string" && INSTANCE.test(arn)
      && INSTANCE.exec(arn)?.[1] === scope.partition && INSTANCE.exec(arn)?.[2] === scope.region
      && INSTANCE.exec(arn)?.[3] === scope.accountId)
    || new Set(scope.instanceArns).size !== scope.instanceArns.length
    || !same(scope.instanceArns, [...scope.instanceArns].sort())
    || request.credentials !== "SERVER_OWNED_TRUST_ROLE_SESSION"
    || !same(request.operations, AMAZON_CONNECT_COST_PROVIDER_ACTIONS)
    || !same(request.providerReads, PROVIDER_READS)
    || !same(request.bounds, AMAZON_CONNECT_COST_PROVIDER_BOUNDS)
    || request.archiveMaximumBytes !== AMAZON_CONNECT_COST_PROVIDER_BOUNDS.maximumDashboardBytes
    || request.maximumDurationMs !== AMAZON_CONNECT_COST_PROVIDER_BOUNDS.maximumDurationMs
    || request.incompleteDisposition !== "PERSIST_HISTORY_NEVER_ADVANCE_HEAD"
    || billing.source !== "AWS_CUR2_ACTIVE_GENERATION" || billing.state !== "ACTIVE_RECONCILED"
    || typeof billing.generationId !== "string" || !/^fbg_[a-f0-9]{64}$/u.test(billing.generationId)
    || typeof billing.sourceEvidenceId !== "string" || !/^fss_[a-f0-9]{64}$/u.test(billing.sourceEvidenceId)
    || typeof billing.manifestSha256 !== "string" || !SHA.test(billing.manifestSha256)
    || !canonicalIso(billing.dataThroughAtIso) || !["UNBLENDED", "AMORTIZED", "NET_UNBLENDED", "NET_AMORTIZED"].includes(String(billing.costBasis))
    || typeof billing.currency !== "string" || !/^[A-Z]{3}$/u.test(billing.currency)
    || billing.rowsExhausted !== true || typeof billing.contactResourceIdsIncluded !== "boolean"
    || !Array.isArray(billing.activatedSystemTags)
    || !billing.activatedSystemTags.every((tag) => ["aws:connect:instanceId",
      "aws:connect:systemEndpoint", "aws:connect:transferredFromEndpoint"].includes(String(tag)))
    || !same(billing.activatedSystemTags, [...billing.activatedSystemTags].sort())
    || billing.predicate !== "PRODUCT_CODE_AMAZON_CONNECT_AND_CONTACT_CENTER_TELECOMMUNICATIONS"
    || typeof billing.classificationContractVersion !== "string" || !ID.test(billing.classificationContractVersion)
    || billing.associatedServiceCoverage !== "NOT_INCLUDED_SEPARATE_EVIDENCE_REQUIRED"
    || Object.entries(privacy).some(([key, value]) => key.startsWith("raw") && value !== false)
    || privacy.tokenization !== "HMAC_SHA256_TENANT_SCOPED_ROTATING"
    || typeof privacy.tokenKeyVersion !== "string" || !/^key_[A-Za-z0-9._-]{1,63}$/u.test(privacy.tokenKeyVersion)
    || typeof privacy.contactDrilldownEnabled !== "boolean"
    || typeof attestation.generationId !== "string" || !/^fss_[a-f0-9]{64}$/u.test(attestation.generationId)
    || typeof attestation.contentSha256 !== "string" || !SHA.test(attestation.contentSha256)
    || !canonicalIso(attestation.observedAtIso) || !same(attestation.operations, AMAZON_CONNECT_COST_PROVIDER_ACTIONS)
    || !same(resources.describeInstanceArns, scope.instanceArns)
    || resources.listPhoneNumbersArn !== `arn:${scope.partition}:connect:${scope.region}:${scope.accountId}:phone-number/*`
    || resources.directoryServiceResource !== "*" || attestation.denyMutationOperations !== true) fail();
  return ({ ...request, scope, billing, privacy,
    permissionAttestation: { ...attestation, resources } }
  ) as unknown as AmazonConnectCostProviderRequest;
}

export async function runAmazonConnectCostProviderRoute(input: {
  readonly body: string; readonly headers: AmazonConnectCostProviderRouteHeaders;
  readonly signal: AbortSignal;
}, dependencies: AmazonConnectCostProviderRouteDependencies) {
  const request = parseAmazonConnectCostProviderRequest(input.body);
  const scope = request.scope;
  if (!(input.signal instanceof AbortSignal) || input.signal.aborted
    || input.headers.tenantId !== scope.orgId || input.headers.customerId !== scope.customerId
    || input.headers.connectionId !== scope.connectionId
    || input.headers.requestId !== request.requestId) fail();
  const deadline = AbortSignal.any([input.signal, AbortSignal.timeout(request.maximumDurationMs)]);
  const session = await dependencies.assumeReadOnlySession({ tenantId: scope.orgId,
    customerId: scope.customerId, connectionId: scope.connectionId, requestId: request.requestId,
    expectedAccountId: scope.accountId, partition: scope.partition, region: scope.region,
    sessionActions: AMAZON_CONNECT_COST_PROVIDER_SESSION_ACTIONS,
    exactInstanceArns: scope.instanceArns,
    exactPhoneNumberArn: `arn:${scope.partition}:connect:${scope.region}:${scope.accountId}:phone-number/*`,
    signal: deadline });
  if (session.accountId !== scope.accountId || session.partition !== scope.partition) fail();
  const [cur2, tokenKey] = await Promise.all([
    dependencies.loadRawCur2Projection({ tenantId: scope.orgId, customerId: scope.customerId,
      connectionId: scope.connectionId, requestId: request.requestId,
      billing: request.billing, exactInstanceArns: scope.instanceArns }),
    dependencies.loadTenantTokenKey({ tenantId: scope.orgId, customerId: scope.customerId,
      connectionId: scope.connectionId, keyVersion: request.privacy.tokenKeyVersion }),
  ]);
  const capture = await collectAmazonConnectCostProviderEvidence({ request,
    reader: (dependencies.readerFactory ?? createAmazonConnectCostProviderReader)({ credentials: session.credentials, accountId: scope.accountId,
      partition: scope.partition, region: scope.region }), cur2, tokenKey, signal: deadline,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }) });
  return Object.freeze({ schemaVersion: "sutra.amazon-connect-cost-provider-response.v1" as const,
    requestId: request.requestId,
    requestBodySha256: createHash("sha256").update(input.body, "utf8").digest("hex"),
    capture });
}
