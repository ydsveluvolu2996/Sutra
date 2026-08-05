/** Strict signed-route payload and credential session boundary for ADV-05. */
import { createHash } from "node:crypto";
import type { AwsTemporaryCredentials } from "./types.js";
import {
  GRAVITON_PROVIDER_BOUNDS,
  GRAVITON_PROVIDER_SESSION_ACTIONS,
  GravitonProviderAdapterError,
  collectGravitonProviderEvidence,
  type GravitonEvidenceAuthority,
  type GravitonProviderBoundary,
  type GravitonProviderReader,
  type GravitonProviderRequest,
  type GravitonProviderTarget,
} from "./graviton-savings-provider-adapter.js";

export const GRAVITON_PROVIDER_ROUTE = "/v1/finops/graviton-savings/collect";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const REQUEST = /^gvrq_[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const MAX_BODY_BYTES = 64 * 1_024;
export interface GravitonProviderRouteHeaders { readonly tenantId: string; readonly customerId: string; readonly connectionId: string; readonly requestId: string }
export interface GravitonProviderRouteDependencies {
  readonly assumeReadOnlySession: (input: {
    readonly tenantId: string; readonly customerId: string; readonly connectionId: string;
    readonly expectedAccountId: string; readonly partition: GravitonProviderBoundary["partition"];
    readonly region: string; readonly requestId: string;
    readonly sessionActions: typeof GRAVITON_PROVIDER_SESSION_ACTIONS; readonly signal: AbortSignal;
  }) => Promise<{ readonly accountId: string; readonly partition: GravitonProviderBoundary["partition"]; readonly credentials: AwsTemporaryCredentials }>;
  readonly readerFactory: (input: { readonly request: GravitonProviderRequest }) => GravitonProviderReader;
  readonly now?: () => number;
}
function reject(code: GravitonProviderAdapterError["code"] = "INVALID_REQUEST"): never { throw new GravitonProviderAdapterError(code); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) reject();
  return value as Record<string, unknown>;
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function refs(value: unknown): GravitonEvidenceAuthority {
  const root = exact(value, ["cur2", "pricing", "compatibility", "workloadAttestations", "licenseAttestations"]);
  const read = (raw: unknown, idKey: string) => {
    const item = exact(raw, [idKey, "contentSha256"]);
    if (typeof item[idKey] !== "string" || !ID.test(item[idKey] as string)
      || typeof item.contentSha256 !== "string" || !SHA.test(item.contentSha256)) reject();
    return item;
  };
  return { cur2: read(root.cur2, "generationId"), pricing: read(root.pricing, "catalogVersion"),
    compatibility: read(root.compatibility, "policyVersion"), workloadAttestations: read(root.workloadAttestations, "setId"),
    licenseAttestations: read(root.licenseAttestations, "setId") } as unknown as GravitonEvidenceAuthority;
}
export function parseGravitonProviderRouteRequest(body: string): GravitonProviderRequest {
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) reject("BOUND_REACHED");
  let parsed: unknown; try { parsed = JSON.parse(body); } catch { reject(); }
  const value = exact(parsed, ["schemaVersion", "requestKey", "scheduledWindow", "boundary", "accountTargets", "services", "operations",
    "recommendationPolicy", "evidenceAuthority", "credentials", "bounds", "deadlineAtIso"]);
  const boundary = exact(value.boundary, ["scope", "managementAccountId", "partition", "accountIds", "regions"]);
  const scope = exact(boundary.scope, ["orgId", "customerId", "connectionId"]);
  const policy = exact(value.recommendationPolicy, ["computeOptimizerAccepted", "managedServiceInventoryPricingAcceptedOnlyWithAllCompatibilityDimensions", "inferCompatibilityFromFamilyName", "inferSavingsWithoutPeriodMatchedCur2AndPricing"]);
  const accountIds = boundary.accountIds, regions = boundary.regions;
  if (!Array.isArray(value.accountTargets)) reject();
  const accountTargets = value.accountTargets.map((raw) => {
    const target = exact(raw, ["accountId", "connectionId"]);
    if (typeof target.accountId !== "string" || !ACCOUNT.test(target.accountId)
      || typeof target.connectionId !== "string" || !CONNECTION.test(target.connectionId)) reject();
    return { accountId: target.accountId, connectionId: target.connectionId };
  });
  if (value.schemaVersion !== "sutra.graviton-provider-request.v1"
    || typeof value.requestKey !== "string" || !REQUEST.test(value.requestKey)
    || typeof value.scheduledWindow !== "string" || !WINDOW.test(value.scheduledWindow)
    || typeof scope.orgId !== "string" || !ID.test(scope.orgId)
    || typeof scope.customerId !== "string" || !ID.test(scope.customerId)
    || typeof scope.connectionId !== "string" || !CONNECTION.test(scope.connectionId)
    || typeof boundary.managementAccountId !== "string" || !ACCOUNT.test(boundary.managementAccountId)
    || !["aws", "aws-cn", "aws-us-gov"].includes(String(boundary.partition))
    || !Array.isArray(accountIds) || accountIds.length < 1 || accountIds.length > GRAVITON_PROVIDER_BOUNDS.maximumAccounts
    || accountIds.some((item) => typeof item !== "string" || !ACCOUNT.test(item))
    || !same(accountIds, [...new Set(accountIds)].sort()) || !accountIds.includes(boundary.managementAccountId)
    || !same(accountTargets, [...accountTargets].sort((left, right) => left.accountId.localeCompare(right.accountId)))
    || !same(accountTargets.map((target) => target.accountId), accountIds)
    || new Set(accountTargets.map((target) => target.connectionId)).size !== accountTargets.length
    || !Array.isArray(regions) || regions.length < 1 || regions.length > GRAVITON_PROVIDER_BOUNDS.maximumRegions
    || regions.some((item) => typeof item !== "string" || !REGION.test(item)) || !same(regions, [...new Set(regions)].sort())
    || !same(value.services, ["EC2_AND_AUTO_SCALING", "RDS_AND_AURORA", "OPENSEARCH", "ELASTICACHE"])
    || !same(value.operations, GRAVITON_PROVIDER_SESSION_ACTIONS)
    || policy.computeOptimizerAccepted !== true || policy.managedServiceInventoryPricingAcceptedOnlyWithAllCompatibilityDimensions !== true
    || policy.inferCompatibilityFromFamilyName !== false || policy.inferSavingsWithoutPeriodMatchedCur2AndPricing !== false
    || value.credentials !== "SERVER_OWNED_TRUST_ROLE_SESSIONS" || !same(value.bounds, GRAVITON_PROVIDER_BOUNDS)
    || typeof value.deadlineAtIso !== "string" || !Number.isFinite(Date.parse(value.deadlineAtIso))
    || new Date(Date.parse(value.deadlineAtIso)).toISOString() !== value.deadlineAtIso) reject();
  return { ...value, boundary: { ...boundary, scope }, accountTargets, evidenceAuthority: refs(value.evidenceAuthority) } as unknown as GravitonProviderRequest;
}
export async function runGravitonProviderRoute(input: { readonly body: string; readonly headers: GravitonProviderRouteHeaders; readonly signal: AbortSignal }, dependencies: GravitonProviderRouteDependencies) {
  const request = parseGravitonProviderRouteRequest(input.body);
  if (!(input.signal instanceof AbortSignal) || input.signal.aborted || input.headers.tenantId !== request.boundary.scope.orgId
    || input.headers.customerId !== request.boundary.scope.customerId || input.headers.connectionId !== request.boundary.scope.connectionId
    || input.headers.requestId !== request.requestKey) reject();
  const now = dependencies.now?.() ?? Date.now(), remaining = Date.parse(request.deadlineAtIso) - now;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(remaining) || remaining < 1
    || remaining > GRAVITON_PROVIDER_BOUNDS.maximumDurationMs) reject();
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(remaining)]);
  const sessionForTarget = async (target: GravitonProviderTarget, targetSignal: AbortSignal) => {
    if (!request.boundary.accountIds.includes(target.accountId) || !request.boundary.regions.includes(target.region) || targetSignal.aborted) reject();
    const connectionId = request.accountTargets.find((candidate) => candidate.accountId === target.accountId)?.connectionId;
    if (connectionId === undefined) reject();
    const session = await dependencies.assumeReadOnlySession({ tenantId: request.boundary.scope.orgId,
      customerId: request.boundary.scope.customerId, connectionId, expectedAccountId: target.accountId,
      partition: request.boundary.partition, region: target.region, requestId: request.requestKey,
      sessionActions: GRAVITON_PROVIDER_SESSION_ACTIONS, signal: targetSignal });
    if (session.accountId !== target.accountId || session.partition !== request.boundary.partition) reject();
    return session.credentials;
  };
  const capture = await collectGravitonProviderEvidence({ request, reader: dependencies.readerFactory({ request }), sessionForTarget, signal });
  return Object.freeze({ schemaVersion: "sutra.graviton-provider-response.v1" as const, requestKey: request.requestKey,
    requestBodySha256: createHash("sha256").update(input.body, "utf8").digest("hex"), capture });
}
