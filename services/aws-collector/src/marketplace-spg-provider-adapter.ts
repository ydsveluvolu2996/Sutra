/** Credential-owning, buyer-only ADD-05 Marketplace evidence collector. */
import { createHash } from "node:crypto";

const ACCOUNT = /^\d{12}$/u;
const REQUEST = /^mpr_[a-f0-9]{64}$/u;
const CAPTURE = /^marketplace_[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9+/=_.:-]{1,4096}$/u;
const MAX_BYTES = 96 * 1_024 * 1_024;

export const MARKETPLACE_SPG_REQUIRED_PERMISSION_PACK = "standard-2026-08.13" as const;
export const MARKETPLACE_SPG_PROVIDER_BOUNDS = Object.freeze({ agreementApiPageSize:50,licenseManagerApiPageSize:100,maximumPagesPerSequence:5_000,maximumOrganizationAccounts:10_000,maximumAgreements:50_000,maximumTermsPerAgreement:100,maximumEntitlementsPerAgreement:100,maximumChargesPerAgreement:10_000,maximumLicenses:50_000,maximumLicenseEntitlements:100,maximumGrants:250_000,maximumSpendRows:500_000,maximumCaptureBytes:96*1_024*1_024,maximumDashboardBytes:16*1_024*1_024,maximumTextCharacters:1_024,agreementFreshnessSlaHours:48,licenseFreshnessSlaHours:48,cur2FreshnessSlaHours:48} as const);
export const MARKETPLACE_SPG_PROVIDER_SESSION_ACTIONS = Object.freeze([
  "sts:GetCallerIdentity",
  "aws-marketplace:SearchAgreements", "aws-marketplace:DescribeAgreement",
  "aws-marketplace:GetAgreementTerms", "aws-marketplace:GetAgreementEntitlements",
  "aws-marketplace:ListAgreementCharges", "aws-marketplace:GetProduct",
  "license-manager:GetServiceSettings", "license-manager:ListReceivedLicenses",
  "license-manager:ListReceivedGrants", "license-manager:ListReceivedLicensesForOrganization",
  "license-manager:ListReceivedGrantsForOrganization",
] as const);

export interface MarketplaceSpgProviderScope {
  readonly orgId: string; readonly customerId: string; readonly connectionId: string;
  readonly accountId: string; readonly partition: "aws"; readonly awsOrganizationId: string;
}
export interface MarketplaceSpgProviderRequest {
  readonly schemaVersion: "sutra.marketplace-spg-provider-request.v1";
  readonly requestId: string; readonly expectedCaptureId: string; readonly scheduledWindow: string;
  readonly scope: MarketplaceSpgProviderScope;
  readonly expectedAccountIds: readonly string[];
  readonly accountCoverageEvidenceId: string; readonly accountCoverageObservedAt: string;
  readonly licenseManagerRegion: string;
  readonly approvedProductTypes: readonly { readonly productId: string; readonly type: "SOFTWARE" | "DATA" | "PROFESSIONAL_SERVICES"; readonly evidenceId: string }[];
  readonly deadlineAtIso: string;
}
export interface MarketplaceSpgPage<T> { readonly items: readonly T[]; readonly nextToken: string | null }
export interface MarketplaceSpgProviderClients {
  searchAgreements(input: { readonly accountId: string; readonly partyType: "Acceptor"; readonly agreementType: "PurchaseAgreement"; readonly maxResults: 50; readonly nextToken: string | null }, signal: AbortSignal): Promise<MarketplaceSpgPage<{ readonly agreementId: string }>>;
  describeAgreement(input: { readonly accountId: string; readonly agreementId: string }, signal: AbortSignal): Promise<Record<string, unknown>>;
  getAgreementTerms(input: { readonly accountId: string; readonly agreementId: string; readonly partyType: "Acceptor"; readonly maxResults: 50; readonly nextToken: string | null }, signal: AbortSignal): Promise<MarketplaceSpgPage<Record<string, unknown>>>;
  getAgreementEntitlements(input: { readonly accountId: string; readonly agreementId: string; readonly maxResults: 50; readonly nextToken: string | null }, signal: AbortSignal): Promise<MarketplaceSpgPage<Record<string, unknown>>>;
  listAgreementCharges(input: { readonly accountId: string; readonly agreementId: string; readonly maxResults: 50; readonly nextToken: string | null }, signal: AbortSignal): Promise<MarketplaceSpgPage<Record<string, unknown>>>;
  getProduct(input: { readonly accountId: string; readonly productId: string }, signal: AbortSignal): Promise<Record<string, unknown>>;
  getServiceSettings(input: { readonly region: string }, signal: AbortSignal): Promise<Record<string, unknown>>;
  listReceivedLicensesForOrganization(input: { readonly region: string; readonly maxResults: 100; readonly nextToken: string | null }, signal: AbortSignal): Promise<MarketplaceSpgPage<Record<string, unknown>>>;
  listReceivedGrantsForOrganization(input: { readonly region: string; readonly licenseArn: string; readonly maxResults: 100; readonly nextToken: string | null }, signal: AbortSignal): Promise<MarketplaceSpgPage<Record<string, unknown>>>;
  destroy?(): void;
}
export interface MarketplaceSpgCur2ResolverResult {
  readonly scope: MarketplaceSpgProviderScope; readonly generationId: string; readonly sourceEvidenceId: string;
  readonly dataThroughAt: string; readonly reconciliationState: "reconciled";
  readonly predicate: "CUR2_BILLING_ENTITY_AWS_MARKETPLACE" | "CUR2_PRODUCT_FAMILY_AWS_MARKETPLACE";
  readonly rows: readonly Record<string, unknown>[];
}

export class MarketplaceSpgProviderError extends Error {
  public readonly code: "INVALID_REQUEST" | "PROVIDER_RESPONSE_INVALID" | "BOUND_REACHED" | "ABORTED";
  public constructor(code: MarketplaceSpgProviderError["code"]) { super("Marketplace provider collection rejected"); this.name = "MarketplaceSpgProviderError"; this.code = code; }
}
function reject(code: MarketplaceSpgProviderError["code"]): never { throw new MarketplaceSpgProviderError(code); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject("PROVIDER_RESPONSE_INVALID");
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...keys].sort())) reject("PROVIDER_RESPONSE_INVALID");
  return record;
}
function string(value: unknown, pattern: RegExp = /^[^\0\r\n<>]{1,1024}$/u): string {
  if (typeof value !== "string" || !pattern.test(value)) reject("PROVIDER_RESPONSE_INVALID"); return value;
}
function iso(value: unknown): string {
  const result = string(value); const time = Date.parse(result);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== result) reject("PROVIDER_RESPONSE_INVALID"); return result;
}
function nullableString(value: unknown, pattern?: RegExp): string | null { return value === null ? null : string(value, pattern); }
function pageToken(value: unknown, prior: string | null, seen: Set<string>): string | null {
  if (value === null) return null;
  const next = string(value, TOKEN); if (next === prior || seen.has(next)) reject("PROVIDER_RESPONSE_INVALID"); seen.add(next); return next;
}
function failure(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return "TIMEOUT" as const;
  const name = typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "";
  if (/accessdenied|authorization|notauthorized/iu.test(name)) return "ACCESS_DENIED" as const;
  if (/expiredtoken/iu.test(name)) return "EXPIRED_TOKEN" as const;
  if (/throttl|ratelimit/iu.test(name)) return "THROTTLED" as const;
  if (/timeout|abort/iu.test(name)) return "TIMEOUT" as const;
  if (/notenabled|configuration/iu.test(name)) return "SERVICE_NOT_ENABLED" as const;
  return "PROVIDER_UNAVAILABLE" as const;
}
function coverage(operation: string, state: string, recordCount: number, pageCount: number, failureCode: string | null) {
  return Object.freeze({ operation, state, recordCount, pageCount, failureCode });
}
async function allPages<T>(read: (token: string | null) => Promise<MarketplaceSpgPage<T>>, maximum: number) {
  const values: T[] = []; const seen = new Set<string>(); let token: string | null = null; let pages = 0;
  do {
    if (pages >= 5_000) reject("BOUND_REACHED");
    const page = await read(token); if (!Array.isArray(page.items)) reject("PROVIDER_RESPONSE_INVALID");
    values.push(...page.items); if (values.length > maximum) reject("BOUND_REACHED"); pages += 1;
    token = pageToken(page.nextToken, token, seen);
  } while (token !== null);
  return { values, pages };
}
function agreement(value: Record<string, unknown>, accountId: string, terms: readonly Record<string, unknown>[], entitlements: readonly Record<string, unknown>[], charges: readonly Record<string, unknown>[], product: Record<string, unknown> | null) {
  const item = exact(value, ["agreementId","agreementType","acceptorAccountId","status","acceptanceAt","startAt","endAt","offerId","productId","estimatedCharges"]);
  if (item.agreementType !== "PurchaseAgreement" || item.acceptorAccountId !== accountId) reject("PROVIDER_RESPONSE_INVALID");
  return Object.freeze({ sourceAccountId: accountId, agreementId: string(item.agreementId), agreementType: "PurchaseAgreement" as const,
    acceptorAccountId: accountId, status: string(item.status), acceptanceAt: item.acceptanceAt === null ? null : iso(item.acceptanceAt),
    startAt: item.startAt === null ? null : iso(item.startAt), endAt: item.endAt === null ? null : iso(item.endAt),
    offerId: nullableString(item.offerId), productId: nullableString(item.productId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/u),
    estimatedCharges: item.estimatedCharges, product, terms, entitlements, charges });
}
function product(value: Record<string, unknown>, productId: string, approved: MarketplaceSpgProviderRequest["approvedProductTypes"][number] | undefined) {
  const item = exact(value, ["productId","productName","sellerDisplayName","sellerProfileId","deployedOnAws","fulfillmentTypes"]);
  if (item.productId !== productId || !Array.isArray(item.fulfillmentTypes)) reject("PROVIDER_RESPONSE_INVALID");
  return Object.freeze({ productId, productName: string(item.productName), sellerDisplayName: string(item.sellerDisplayName),
    sellerProfileId: nullableString(item.sellerProfileId), deployedOnAws: string(item.deployedOnAws),
    fulfillmentTypes: item.fulfillmentTypes.map((entry) => string(entry)),
    approvedProductType: approved?.type ?? null, approvedProductTypeEvidenceId: approved?.evidenceId ?? null });
}
function copyExact(value: Record<string, unknown>, keys: readonly string[]) { const item=exact(value,keys); return Object.freeze(Object.fromEntries(keys.map((key)=>[key,item[key]]))); }
function term(value:Record<string,unknown>){const item=exact(value,["termId","type","legalDocumentTypes","autoRenew","validity","pricingCurrency","committedAmount","dimensionCount","paymentSchedule"]);if(!Array.isArray(item.legalDocumentTypes)||!Array.isArray(item.paymentSchedule))reject("PROVIDER_RESPONSE_INVALID");return Object.freeze({...item,legalDocumentTypes:item.legalDocumentTypes.map((entry)=>string(entry)),validity:item.validity===null?null:copyExact(item.validity as Record<string,unknown>,["startAt","endAt"]),paymentSchedule:item.paymentSchedule.map((entry)=>copyExact(entry as Record<string,unknown>,["chargeAt","amount"]))})}
function entitlement(value:Record<string,unknown>){return copyExact(value,["type","status","statusReasonCode","resourceType","resourceId","licenseArn"])}
function charge(value:Record<string,unknown>){const item=exact(value,["chargeId","revision","chargeAt","money"]);return Object.freeze({...item,money:copyExact(item.money as Record<string,unknown>,["amount","currencyCode"])})}
function license(value:Record<string,unknown>){const item=exact(value,["licenseArn","beneficiaryAccountId","homeRegion","issuerName","productSku","productName","licenseName","status","receivedStatus","validity","entitlements"]);if(!Array.isArray(item.entitlements))reject("PROVIDER_RESPONSE_INVALID");return Object.freeze({...item,validity:item.validity===null?null:copyExact(item.validity as Record<string,unknown>,["startAt","endAt"]),entitlements:item.entitlements.map((entry)=>copyExact(entry as Record<string,unknown>,["name","unit","value","maxCount","overageAllowed"]))})}
function grant(value:Record<string,unknown>){const item=exact(value,["grantArn","licenseArn","granteeAccountId","homeRegion","status","version","operations","activationOverrideBehavior"]);if(!Array.isArray(item.operations))reject("PROVIDER_RESPONSE_INVALID");return Object.freeze({...item,operations:item.operations.map((entry)=>string(entry))})}

export async function collectMarketplaceSpgProviderEvidence(input: {
  readonly request: MarketplaceSpgProviderRequest; readonly clients: MarketplaceSpgProviderClients;
  readonly cur2: MarketplaceSpgCur2ResolverResult; readonly signal: AbortSignal; readonly now?: () => number;
}) {
  const { request, clients, signal } = input; const startedAt = new Date(input.now?.() ?? Date.now()).toISOString();
  if (signal.aborted || !REQUEST.test(request.requestId) || !CAPTURE.test(request.expectedCaptureId)
    || request.scope.partition !== "aws" || !ACCOUNT.test(request.scope.accountId)
    || request.expectedAccountIds.length < 1 || request.expectedAccountIds.length > 10_000
    || request.expectedAccountIds.some((id) => !ACCOUNT.test(id))
    || JSON.stringify(request.expectedAccountIds) !== JSON.stringify([...request.expectedAccountIds].sort())
    || new Set(request.expectedAccountIds).size !== request.expectedAccountIds.length
    || !request.expectedAccountIds.includes(request.scope.accountId)) reject("INVALID_REQUEST");
  const operations: Record<string, unknown>[] = []; const agreements: Record<string, unknown>[] = [];
  const captured: string[] = []; let searchPages = 0; let described = 0; let termCount = 0; let entitlementCount = 0; let chargeCount = 0; let productCount = 0;
  try {
    for (const accountId of request.expectedAccountIds) {
      const found = await allPages((nextToken) => clients.searchAgreements({ accountId, partyType: "Acceptor", agreementType: "PurchaseAgreement", maxResults: 50, nextToken }, signal), 50_000);
      searchPages += found.pages; const ids = found.values.map((entry) => string(exact(entry, ["agreementId"]).agreementId));
      if (new Set(ids).size !== ids.length) reject("PROVIDER_RESPONSE_INVALID");
      for (const agreementId of ids) {
        const detail = await clients.describeAgreement({ accountId, agreementId }, signal); described += 1;
        const terms = await allPages((nextToken) => clients.getAgreementTerms({ accountId, agreementId, partyType: "Acceptor", maxResults: 50, nextToken }, signal), 100);
        const entitlements = await allPages((nextToken) => clients.getAgreementEntitlements({ accountId, agreementId, maxResults: 50, nextToken }, signal), 100);
        const charges = await allPages((nextToken) => clients.listAgreementCharges({ accountId, agreementId, maxResults: 50, nextToken }, signal), 10_000);
        termCount += terms.values.length; entitlementCount += entitlements.values.length; chargeCount += charges.values.length;
        const productId = exact(detail, ["agreementId","agreementType","acceptorAccountId","status","acceptanceAt","startAt","endAt","offerId","productId","estimatedCharges"]).productId;
        let metadata: Record<string, unknown> | null = null;
        if (productId !== null) { const id = string(productId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/u); metadata = product(await clients.getProduct({ accountId, productId: id }, signal), id, request.approvedProductTypes.find((entry) => entry.productId === id)); productCount += 1; }
        agreements.push(agreement(detail, accountId, terms.values.map(term), entitlements.values.map(entitlement), charges.values.map(charge), metadata));
      }
      captured.push(accountId);
    }
    operations.push(coverage("SearchAgreements", "SUCCEEDED", agreements.length, searchPages, null), coverage("DescribeAgreement", "SUCCEEDED", described, described, null),
      coverage("GetAgreementTerms", "SUCCEEDED", termCount, Math.max(1, termCount), null), coverage("GetAgreementEntitlements", "SUCCEEDED", entitlementCount, Math.max(1, entitlementCount), null),
      coverage("ListAgreementCharges", "SUCCEEDED", chargeCount, Math.max(1, chargeCount), null), coverage("GetProduct", "SUCCEEDED", productCount, productCount, null));
  } catch (error) {
    const code = failure(error, signal); operations.push(...["SearchAgreements","DescribeAgreement","GetAgreementTerms","GetAgreementEntitlements","ListAgreementCharges","GetProduct"].map((name) => coverage(name, agreements.length > 0 ? "PARTIAL" : "UNAVAILABLE", 0, 0, code)));
  }
  let settings: Record<string, unknown> = { organizationIntegrationEnabled: false, crossAccountDiscoveryEnabled: false };
  const licenses: Record<string, unknown>[] = []; const grants: Record<string, unknown>[] = [];
  try {
    settings = exact(await clients.getServiceSettings({ region: request.licenseManagerRegion }, signal), ["organizationIntegrationEnabled","crossAccountDiscoveryEnabled"]);
    if (settings.organizationIntegrationEnabled !== true || settings.crossAccountDiscoveryEnabled !== true) {
      operations.push(coverage("GetServiceSettings", "SUCCEEDED", 1, 1, null), coverage("ListReceivedLicensesForOrganization", "CONFIGURATION_REQUIRED", 0, 0, "SERVICE_NOT_ENABLED"), coverage("ListReceivedGrantsForOrganization", "CONFIGURATION_REQUIRED", 0, 0, "SERVICE_NOT_ENABLED"));
    } else {
      const licensePages = await allPages((nextToken) => clients.listReceivedLicensesForOrganization({ region: request.licenseManagerRegion, maxResults: 100, nextToken }, signal), 50_000);
      licenses.push(...licensePages.values.map(license));
      let grantPages = 0;
      for (const item of licenses) { const licenseArn = string(item.licenseArn); const found = await allPages((nextToken) => clients.listReceivedGrantsForOrganization({ region: request.licenseManagerRegion, licenseArn, maxResults: 100, nextToken }, signal), 250_000 - grants.length); grants.push(...found.values.map(grant)); grantPages += found.pages; }
      operations.push(coverage("GetServiceSettings", "SUCCEEDED", 1, 1, null), coverage("ListReceivedLicensesForOrganization", "SUCCEEDED", licenses.length, licensePages.pages, null), coverage("ListReceivedGrantsForOrganization", "SUCCEEDED", grants.length, grantPages, null));
    }
  } catch (error) { const code = failure(error, signal); operations.push(coverage("GetServiceSettings", "UNAVAILABLE", 0, 0, code), coverage("ListReceivedLicensesForOrganization", "UNAVAILABLE", 0, 0, code), coverage("ListReceivedGrantsForOrganization", "UNAVAILABLE", 0, 0, code)); }
  const capture = Object.freeze({ schemaVersion: "sutra.aws-marketplace-spg.v1" as const, scope: request.scope,
    captureId: request.expectedCaptureId, startedAt, completedAt: new Date(input.now?.() ?? Date.now()).toISOString(),
    agreementRegion: "us-east-1" as const, discoveryRegion: "us-east-1" as const, licenseManagerRegion: request.licenseManagerRegion,
    agreementParty: "Acceptor" as const, agreementAccountCoverage: { basis: "AWS_ORGANIZATIONS_ACTIVE_ACCOUNTS" as const,
      evidenceId: request.accountCoverageEvidenceId, observedAt: request.accountCoverageObservedAt,
      expectedAccountIds: request.expectedAccountIds, capturedAgreementAccountIds: captured }, licenseCollectionMode: "ORGANIZATION" as const,
    licenseManagerSettings: settings, operationCoverage: operations, agreements, licenses, grants, cur2: input.cur2 });
  const serialized = JSON.stringify(capture); if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES) reject("BOUND_REACHED");
  return Object.freeze({ capture, contentSha256: createHash("sha256").update(serialized).digest("hex") });
}
