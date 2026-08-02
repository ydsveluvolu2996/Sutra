/** Credential-owning historical AWS Price List boundary for ADD-13. */
import type { AwsTemporaryCredentials } from "./types.js";

export const PRICING_CHANGE_PROVIDER_ACTIONS = Object.freeze([
  "pricing:ListPriceLists",
  "pricing:GetPriceListFileUrl",
] as const);
export const PRICING_CHANGE_PROVIDER_BOUNDS = Object.freeze({
  maximumRequestBytes: 52 * 1_024 * 1_024,
  maximumCaptureBytes: 64 * 1_024 * 1_024,
  maximumDurationMs: 15 * 60 * 1_000,
  maximumSourceRows: 250_000,
  maximumSelectedUsageRows: 250_000,
  maximumAxes: 40_000,
  maximumListPagesPerAxis: 2_000,
  maximumPriceListFiles: 20_000,
  maximumCatalogTerms: 500_000,
  maximumSingleFileBytes: 32 * 1_024 * 1_024,
  maximumDownloadedBytes: 64 * 1_024 * 1_024,
} as const);
export const PRICING_CHANGE_MATERIALIZATION_BOUNDS = Object.freeze({
  maximumCaptureBytes: 64 * 1_024 * 1_024, maximumResponseBytes: 8 * 1_024 * 1_024,
  maximumDurationMs: 15 * 60 * 1_000, maximumAccounts: 1_000, maximumRegions: 50,
  maximumUsageRecords: 250_000, maximumCatalogSnapshots: 20_000, maximumCatalogTerms: 500_000,
  maximumCatalogCoverageRecords: 40_000, maximumAttributes: 32, maximumGroupsInResponse: 5_000,
  maximumExclusionGroupsInResponse: 2_000, maximumTextLength: 512, maximumCur2GenerationAgeHours: 48,
  maximumCatalogRetrievalAgeHours: 31 * 24, maximumUsageHistoryDays: 400, maximumDecimalScale: 12,
} as const);

export type PricingChangeProviderPartition = "aws" | "aws-cn" | "aws-us-gov";
export interface PricingChangeProviderScope { readonly organizationId: string; readonly customerId: string; readonly connectionId: string }
export interface PricingChangeProviderRow {
  readonly usageId: string; readonly payerAccountId: string; readonly linkedAccountId: string;
  readonly serviceCode: string; readonly region: string; readonly usageStartAt: string; readonly usageEndAt: string;
  readonly lineItemType: "USAGE" | "DISCOUNTED_USAGE" | "SAVINGS_PLAN_COVERED_USAGE";
  readonly termType: "ON_DEMAND" | "RESERVED" | "SAVINGS_PLAN"; readonly currency: string; readonly usageUnit: string;
  readonly usageQuantity: { readonly numerator: string; readonly denominator: string };
  readonly applicabilityAttributes: readonly { readonly name: string; readonly value: string }[];
}
export interface PricingChangeProviderCur2Artifact {
  readonly schemaVersion: "sutra.pricing-change.cur2-artifact.v1"; readonly scope: PricingChangeProviderScope;
  readonly exportName: string; readonly billingPeriod: string; readonly generationId: string; readonly manifestSha256: string;
  readonly generatedAtIso: string; readonly sourceFormat: "aws-cur"; readonly sourceVersion: "2.0"; readonly rowsExhausted: true;
  readonly sourceRowCount: number; readonly selectedUsageRowCount: number; readonly omittedRowCount: number;
  readonly rows: readonly PricingChangeProviderRow[];
}
export interface PricingChangeProviderRequest {
  readonly schemaVersion: "sutra.pricing-change.provider-request.v1";
  readonly requestKey: string;
  readonly materialization: {
    readonly schemaVersion: "sutra.pricing-change.materializer-request.v1";
    readonly scope: PricingChangeProviderScope; readonly collectionId: string;
    readonly activeCur2: {
      readonly source: "ACTIVE_RECONCILED_CUR2_GENERATION"; readonly scope: PricingChangeProviderScope;
      readonly partition: PricingChangeProviderPartition; readonly exportName: string; readonly billingPeriod: string;
      readonly generationId: string; readonly manifestSha256: string; readonly generatedAtIso: string;
      readonly usagePeriodStartAt: string; readonly usagePeriodEndAt: string; readonly sourceFormat: "aws-cur"; readonly sourceVersion: "2.0";
      readonly payerAccountIds: readonly string[]; readonly linkedAccountIds: readonly string[]; readonly regions: readonly string[];
      readonly coverage: { readonly readPermissionsValidated: boolean; readonly manifestObjectCount: number; readonly processedObjectCount: number; readonly acceptedRowCount: number; readonly rejectedRowCount: number };
    };
    readonly boundary: { readonly scope: { readonly orgId: string; readonly customerId: string; readonly connectionId: string };
      readonly partition: PricingChangeProviderPartition; readonly payerAccountIds: readonly string[]; readonly linkedAccountIds: readonly string[]; readonly regions: readonly string[] };
    readonly baselineEffectiveAt: string; readonly comparisonEffectiveAt: string;
    readonly historicalPriceList: { readonly source: "AWS_PRICE_LIST_BULK_API_HISTORICAL_FILES"; readonly operations: typeof PRICING_CHANGE_PROVIDER_ACTIONS;
      readonly fileFormat: "json"; readonly selectionAxes: "ACTIVE_CUR2_SERVICE_REGION_CURRENCY_ONLY"; readonly exactApplicabilityRequired: true; readonly tierAllocationRequiredForNonFlatRates: true };
    readonly bounds: typeof PRICING_CHANGE_MATERIALIZATION_BOUNDS; readonly deadlineAtIso: string;
  };
  readonly cur2: PricingChangeProviderCur2Artifact;
  readonly credentials: "SERVER_OWNED_TRUST_ROLE_SESSION";
  readonly actions: typeof PRICING_CHANGE_PROVIDER_ACTIONS;
  readonly deadlineAtIso: string;
}
export interface PricingChangeProviderBinding {
  readonly schemaVersion: "sutra.pricing-change-provider-binding.v1";
  readonly organizationId: string; readonly customerId: string; readonly connectionId: string;
  readonly accountId: string; readonly partition: PricingChangeProviderPartition;
  readonly permissionPackVersion: "standard-2026-08.17";
  readonly pricingEndpointRegion: "us-east-1";
}
export interface PricingChangeProviderReader {
  collect(input: { readonly request: PricingChangeProviderRequest; readonly credentials: AwsTemporaryCredentials; readonly signal: AbortSignal; readonly now: () => number }): Promise<unknown>;
}
export class PricingChangeProviderAdapterError extends Error {
  public readonly code: "INVALID_REQUEST" | "PROVIDER_RESPONSE_INVALID" | "BOUND_REACHED" | "ABORTED";
  public constructor(code: PricingChangeProviderAdapterError["code"]) { super("Pricing Change provider collection failed"); this.name = "PricingChangeProviderAdapterError"; this.code = code; }
}
function reject(code: PricingChangeProviderAdapterError["code"]): never { throw new PricingChangeProviderAdapterError(code); }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject("PROVIDER_RESPONSE_INVALID");
  return value as Readonly<Record<string, unknown>>;
}

export async function collectPricingChangeProviderEvidence(input: {
  readonly request: PricingChangeProviderRequest; readonly binding: PricingChangeProviderBinding;
  readonly credentials: AwsTemporaryCredentials; readonly reader: PricingChangeProviderReader;
  readonly signal: AbortSignal; readonly now?: () => number;
}): Promise<unknown> {
  const request = input.request, materialization = request.materialization, active = materialization.activeCur2, cur2 = request.cur2;
  if (!(input.signal instanceof AbortSignal) || input.signal.aborted) reject("ABORTED");
  if (input.binding.schemaVersion !== "sutra.pricing-change-provider-binding.v1" || input.binding.permissionPackVersion !== "standard-2026-08.17"
    || input.binding.organizationId !== materialization.scope.organizationId || input.binding.customerId !== materialization.scope.customerId
    || input.binding.connectionId !== materialization.scope.connectionId || input.binding.partition !== active.partition
    || input.binding.partition !== "aws" || input.binding.pricingEndpointRegion !== "us-east-1" || request.credentials !== "SERVER_OWNED_TRUST_ROLE_SESSION"
    || !same(request.actions, PRICING_CHANGE_PROVIDER_ACTIONS) || !same(materialization.historicalPriceList.operations, PRICING_CHANGE_PROVIDER_ACTIONS)
    || !same(materialization.bounds, PRICING_CHANGE_MATERIALIZATION_BOUNDS)
    || request.deadlineAtIso !== materialization.deadlineAtIso || cur2.scope.organizationId !== materialization.scope.organizationId
    || cur2.scope.customerId !== materialization.scope.customerId || cur2.scope.connectionId !== materialization.scope.connectionId
    || cur2.exportName !== active.exportName || cur2.billingPeriod !== active.billingPeriod || cur2.generationId !== active.generationId
    || cur2.manifestSha256 !== active.manifestSha256 || cur2.generatedAtIso !== active.generatedAtIso
    || cur2.sourceFormat !== "aws-cur" || cur2.sourceVersion !== "2.0" || cur2.rowsExhausted !== true
    || cur2.sourceRowCount !== active.coverage.acceptedRowCount || cur2.selectedUsageRowCount !== cur2.rows.length
    || cur2.sourceRowCount !== cur2.selectedUsageRowCount + cur2.omittedRowCount
    || cur2.sourceRowCount > PRICING_CHANGE_PROVIDER_BOUNDS.maximumSourceRows
    || cur2.rows.length > PRICING_CHANGE_PROVIDER_BOUNDS.maximumSelectedUsageRows) reject("INVALID_REQUEST");
  const now = input.now ?? Date.now, started = now(), deadline = Date.parse(request.deadlineAtIso);
  if (!Number.isSafeInteger(started) || started < 0 || !Number.isFinite(deadline) || deadline <= started
    || deadline - started > PRICING_CHANGE_PROVIDER_BOUNDS.maximumDurationMs) reject("INVALID_REQUEST");
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(deadline - started)]);
  let capture: unknown;
  try { capture = await input.reader.collect({ request, credentials: input.credentials, signal, now }); }
  catch { reject(signal.aborted ? "ABORTED" : "PROVIDER_RESPONSE_INVALID"); }
  const value = record(capture);
  if (value.schemaVersion !== "sutra.pricing-change.capture.v1" || !same(value.scope, materialization.boundary.scope)
    || value.partition !== active.partition || value.collectionId !== materialization.collectionId
    || value.activeCur2GenerationId !== active.generationId || value.activeCur2ManifestSha256 !== active.manifestSha256
    || value.activeCur2GeneratedAt !== active.generatedAtIso || value.baselineEffectiveAt !== materialization.baselineEffectiveAt
    || value.comparisonEffectiveAt !== materialization.comparisonEffectiveAt || !same(value.payerAccountIds, active.payerAccountIds)
    || !same(value.linkedAccountIds, active.linkedAccountIds) || !same(value.regions, active.regions)
    || !Array.isArray(value.usage) || value.usage.length !== cur2.rows.length
    || !Array.isArray(value.catalogSnapshots) || value.catalogSnapshots.length > PRICING_CHANGE_PROVIDER_BOUNDS.maximumPriceListFiles
    || !Array.isArray(value.catalogTerms) || value.catalogTerms.length > PRICING_CHANGE_PROVIDER_BOUNDS.maximumCatalogTerms
    || !Array.isArray(value.catalogCoverage) || value.catalogCoverage.length > PRICING_CHANGE_PROVIDER_BOUNDS.maximumAxes) reject("PROVIDER_RESPONSE_INVALID");
  if (Buffer.byteLength(JSON.stringify(capture), "utf8") > PRICING_CHANGE_PROVIDER_BOUNDS.maximumCaptureBytes) reject("BOUND_REACHED");
  return capture;
}
