/** Strict authenticated route boundary for ADD-05 Marketplace SPG. */
import { createHash } from "node:crypto";
import type { AwsTemporaryCredentials } from "./types.js";
import {
  MARKETPLACE_SPG_PROVIDER_SESSION_ACTIONS, MARKETPLACE_SPG_PROVIDER_BOUNDS,
  MarketplaceSpgProviderError,
  collectMarketplaceSpgProviderEvidence,
  type MarketplaceSpgCur2ResolverResult,
  type MarketplaceSpgProviderClients,
  type MarketplaceSpgProviderRequest,
} from "./marketplace-spg-provider-adapter.js";

export const MARKETPLACE_SPG_PROVIDER_ROUTE = "/v1/finops/marketplace-spg/collect";
const REQUEST = /^mpr_[a-f0-9]{64}$/u; const CAPTURE = /^marketplace_[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u; const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u; const ORG = /^o-[a-z0-9]{10,32}$/u; const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/u;
function same(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }
function exact(value: unknown, keys: readonly string[]) { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new MarketplaceSpgProviderError("INVALID_REQUEST"); const item = value as Record<string, unknown>; if (!same(Object.keys(item).sort(), [...keys].sort())) throw new MarketplaceSpgProviderError("INVALID_REQUEST"); return item; }
function canonicalIso(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }

export interface MarketplaceSpgProviderRouteHeaders { readonly tenantId: string; readonly customerId: string; readonly connectionId: string; readonly requestId: string }
export interface MarketplaceSpgProviderRouteDependencies {
  readonly assumeReadOnlySession: (input: { readonly tenantId: string; readonly customerId: string; readonly connectionId: string; readonly expectedAccountId: string; readonly partition: "aws"; readonly requestId: string; readonly sessionActions: typeof MARKETPLACE_SPG_PROVIDER_SESSION_ACTIONS; readonly signal: AbortSignal }) => Promise<{ readonly accountId: string; readonly partition: "aws"; readonly credentials: AwsTemporaryCredentials }>;
  readonly clientsFactory: (input: { readonly request: MarketplaceSpgProviderRequest; readonly sessionForAccount: (accountId: string, signal: AbortSignal) => Promise<AwsTemporaryCredentials> }) => MarketplaceSpgProviderClients;
  readonly loadCur2: (input: { readonly request: MarketplaceSpgProviderRequest; readonly signal: AbortSignal }) => Promise<MarketplaceSpgCur2ResolverResult>;
  readonly now?: () => number;
}

export function parseMarketplaceSpgProviderRouteRequest(body: string): MarketplaceSpgProviderRequest {
  if (Buffer.byteLength(body, "utf8") > 2 * 1_024 * 1_024) throw new MarketplaceSpgProviderError("BOUND_REACHED");
  let parsed: unknown; try { parsed = JSON.parse(body); } catch { throw new MarketplaceSpgProviderError("INVALID_REQUEST"); }
  const value = exact(parsed, ["schemaVersion","requestId","expectedCaptureId","scheduledWindow","scope","expectedAccountIds","accountCoverageEvidenceId","accountCoverageObservedAt","licenseManagerRegion","approvedProductTypes","deadlineAtIso","buyerOperations","licenseOperations","accountCoverageActions","buyerParty","credentials","privacy","bounds"]);
  const scope = exact(value.scope, ["orgId","customerId","connectionId","accountId","partition","awsOrganizationId"]);
  if (value.schemaVersion !== "sutra.marketplace-spg-provider-request.v1" || typeof value.requestId !== "string" || !REQUEST.test(value.requestId)
    || typeof value.expectedCaptureId !== "string" || !CAPTURE.test(value.expectedCaptureId)
    || !canonicalIso(value.scheduledWindow) || !canonicalIso(value.accountCoverageObservedAt) || !canonicalIso(value.deadlineAtIso)
    || typeof scope.orgId !== "string" || !IDENTIFIER.test(scope.orgId) || typeof scope.customerId !== "string" || !IDENTIFIER.test(scope.customerId)
    || typeof scope.connectionId !== "string" || !CONNECTION.test(scope.connectionId) || typeof scope.accountId !== "string" || !ACCOUNT.test(scope.accountId)
    || scope.partition !== "aws" || typeof scope.awsOrganizationId !== "string" || !ORG.test(scope.awsOrganizationId)
    || typeof value.accountCoverageEvidenceId !== "string" || !/^fss_[a-f0-9]{64}$/u.test(value.accountCoverageEvidenceId)
    || typeof value.licenseManagerRegion !== "string" || !REGION.test(value.licenseManagerRegion)
    || value.buyerParty !== "Acceptor" || value.credentials !== "SERVER_OWNED_TRUST_ROLE_SESSIONS"
    || !same(value.buyerOperations, ["SearchAgreements","DescribeAgreement","GetAgreementTerms","GetAgreementEntitlements","ListAgreementCharges","GetProduct"])
    || !same(value.licenseOperations, ["GetServiceSettings","ListReceivedLicenses","ListReceivedGrants","ListReceivedLicensesForOrganization","ListReceivedGrantsForOrganization"])
    || !same(value.accountCoverageActions, ["organizations:DescribeOrganization","organizations:ListAccounts"])
    || !same(value.privacy, { includeRegistrationTokens:false,includePurchaseOrderReferences:false,includeLegalDocumentsOrUrls:false,includeContacts:false,includeProviderErrorText:false,includeTemporaryEmbedUrls:false })
    || !same(value.bounds,MARKETPLACE_SPG_PROVIDER_BOUNDS)) throw new MarketplaceSpgProviderError("INVALID_REQUEST");
  if (!Array.isArray(value.expectedAccountIds) || value.expectedAccountIds.length < 1 || value.expectedAccountIds.length > 10_000 || value.expectedAccountIds.some((id) => typeof id !== "string" || !ACCOUNT.test(id)) || !same(value.expectedAccountIds, [...value.expectedAccountIds].sort()) || new Set(value.expectedAccountIds).size !== value.expectedAccountIds.length || !value.expectedAccountIds.includes(scope.accountId)) throw new MarketplaceSpgProviderError("INVALID_REQUEST");
  if (!Array.isArray(value.approvedProductTypes) || value.approvedProductTypes.length > 50_000) throw new MarketplaceSpgProviderError("INVALID_REQUEST");
  const approved: MarketplaceSpgProviderRequest["approvedProductTypes"] = value.approvedProductTypes.map((raw) => { const item = exact(raw, ["productId","type","evidenceId"]); if (typeof item.productId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/u.test(item.productId) || !["SOFTWARE","DATA","PROFESSIONAL_SERVICES"].includes(String(item.type)) || typeof item.evidenceId !== "string" || !/^fss_[a-f0-9]{64}$/u.test(item.evidenceId)) throw new MarketplaceSpgProviderError("INVALID_REQUEST"); return { productId: item.productId, type: item.type as "SOFTWARE" | "DATA" | "PROFESSIONAL_SERVICES", evidenceId: item.evidenceId }; });
  if (!same(approved, [...approved].sort((a,b) => String(a.productId).localeCompare(String(b.productId)))) || new Set(approved.map((item) => item.productId)).size !== approved.length) throw new MarketplaceSpgProviderError("INVALID_REQUEST");
  return { schemaVersion: "sutra.marketplace-spg-provider-request.v1", requestId: String(value.requestId), expectedCaptureId: String(value.expectedCaptureId), scheduledWindow: String(value.scheduledWindow), scope: { orgId: String(scope.orgId), customerId: String(scope.customerId), connectionId: String(scope.connectionId), accountId: String(scope.accountId), partition: "aws", awsOrganizationId: String(scope.awsOrganizationId) }, expectedAccountIds: value.expectedAccountIds.map(String), accountCoverageEvidenceId: String(value.accountCoverageEvidenceId), accountCoverageObservedAt: String(value.accountCoverageObservedAt), licenseManagerRegion: String(value.licenseManagerRegion), approvedProductTypes: approved, deadlineAtIso: String(value.deadlineAtIso) };
}

export async function runMarketplaceSpgProviderRoute(input: { readonly body: string; readonly headers: MarketplaceSpgProviderRouteHeaders; readonly signal: AbortSignal }, dependencies: MarketplaceSpgProviderRouteDependencies) {
  const request = parseMarketplaceSpgProviderRouteRequest(input.body);
  if (input.signal.aborted || input.headers.tenantId !== request.scope.orgId || input.headers.customerId !== request.scope.customerId || input.headers.connectionId !== request.scope.connectionId || input.headers.requestId !== request.requestId) throw new MarketplaceSpgProviderError("INVALID_REQUEST");
  const now = dependencies.now?.() ?? Date.now(); const remaining = Date.parse(request.deadlineAtIso) - now;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(remaining) || remaining < 1 || remaining > 900_000) throw new MarketplaceSpgProviderError("INVALID_REQUEST");
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(remaining)]);
  const sessionForAccount = async (accountId: string, targetSignal: AbortSignal) => {
    if (!request.expectedAccountIds.includes(accountId) || targetSignal.aborted) throw new MarketplaceSpgProviderError("INVALID_REQUEST");
    const session = await dependencies.assumeReadOnlySession({ tenantId: request.scope.orgId, customerId: request.scope.customerId, connectionId: request.scope.connectionId, expectedAccountId: accountId, partition: "aws", requestId: request.requestId, sessionActions: MARKETPLACE_SPG_PROVIDER_SESSION_ACTIONS, signal: targetSignal });
    if (session.accountId !== accountId || session.partition !== "aws") throw new MarketplaceSpgProviderError("INVALID_REQUEST"); return session.credentials;
  };
  const clients = dependencies.clientsFactory({ request, sessionForAccount });
  try {
    const cur2 = await dependencies.loadCur2({ request, signal });
    if (!same(cur2.scope, request.scope) || cur2.reconciliationState !== "reconciled") throw new MarketplaceSpgProviderError("INVALID_REQUEST");
    const result = await collectMarketplaceSpgProviderEvidence({ request, clients, cur2, signal, ...(dependencies.now === undefined ? {} : { now: dependencies.now }) });
    return Object.freeze({ schemaVersion: "sutra.marketplace-spg-provider-response.v1" as const, requestId: request.requestId,
      requestBodySha256: createHash("sha256").update(input.body,"utf8").digest("hex"), captureBodySha256: result.contentSha256, capture: result.capture });
  } finally { clients.destroy?.(); }
}
