/** Credential-owning ADD-08 dual-plane provider adapter.
 *
 * The versioned CARBON_EMISSIONS export is authoritative history. The optional
 * direct Sustainability API result is a separately typed comparator and can
 * never enter the export capture or replace an incomplete export.
 */
import { createHash } from "node:crypto";
import type { AwsTemporaryCredentials } from "./types.js";

export const SUSTAINABILITY_PROVIDER_SESSION_ACTIONS = Object.freeze([
  "sts:GetCallerIdentity",
  "bcm-data-exports:GetExport", "bcm-data-exports:GetExecution",
  "bcm-data-exports:ListExecutions", "bcm-data-exports:GetTable",
  "sustainability:GetCarbonFootprintSummary",
  "s3:GetBucketLocation", "s3:ListBucket", "s3:GetObject", "s3:GetObjectVersion",
] as const);
export const SUSTAINABILITY_DIRECT_COMPARATOR_ACTIONS = Object.freeze([
  "sustainability:GetEstimatedCarbonEmissions",
  "sustainability:GetEstimatedCarbonEmissionsDimensionValues",
] as const);
export const SUSTAINABILITY_PROVIDER_BOUNDS = Object.freeze({
  maximumProxyRows: 500_000, maximumCarbonRows: 500_000,
  maximumObjects: 20_000, maximumPeriods: 120,
  maximumBytes: 96 * 1_024 * 1_024, maximumDurationMs: 20 * 60 * 1_000,
  maximumComparatorPages: 2_000, maximumComparatorRows: 500_000,
  maximumComparatorBytes: 16 * 1_024 * 1_024,
  maximumResponseBytes: 112 * 1_024 * 1_024,
});
export const SUSTAINABILITY_CARBON_COLUMNS = Object.freeze([
  "last_refresh_timestamp", "location", "model_version", "payer_account_id",
  "product_code", "region_code", "total_lbm_emissions_unit",
  "total_lbm_emissions_value", "total_mbm_emissions_unit",
  "total_mbm_emissions_value", "total_scope_1_emissions_value",
  "total_scope_1_emissions_unit", "total_scope_2_lbm_emissions_value",
  "total_scope_2_lbm_emissions_unit", "total_scope_2_mbm_emissions_value",
  "total_scope_2_mbm_emissions_unit", "total_scope_3_lbm_emissions_value",
  "total_scope_3_lbm_emissions_unit", "total_scope_3_mbm_emissions_value",
  "total_scope_3_mbm_emissions_unit", "usage_account_id", "usage_period_end",
  "usage_period_start",
] as const);

type Partition = "aws" | "aws-cn" | "aws-us-gov";
interface Scope { readonly orgId: string; readonly customerId: string; readonly connectionId: string; readonly accountId: string; readonly partition: Partition }
export interface SustainabilityProviderRequest {
  readonly schemaVersion: "sutra.sustainability-carbon-runtime-request.v1";
  readonly requestId: string; readonly expectedCaptureId: string;
  readonly scheduledWindow: string; readonly scope: Scope;
  readonly allowedUsageAccountIds: readonly string[];
  readonly credentials: "SERVER_OWNED_TRUST_ROLE_SESSION";
  readonly channels: {
    readonly proxy: { readonly source: "AWS_CUR2_ACTIVE_GENERATION"; readonly state: "ACTIVE_RECONCILED"; readonly generationId: string; readonly manifestSha256: string; readonly dataThroughAtIso: string; readonly rowsExhausted: true; readonly interpretation: "RESOURCE_USE_PROXY_NOT_CARBON"; readonly conversionToMtco2e: false };
    readonly providerCarbon: { readonly source: "AWS_SUSTAINABILITY_CARBON_DATA_EXPORT"; readonly tableName: "CARBON_EMISSIONS"; readonly exportName: string; readonly exportArn: string; readonly exportRegion: string; readonly bucket: string; readonly prefix: string; readonly expectedBucketOwner: string; readonly generationId: string; readonly manifestSha256: string; readonly schemaColumns: readonly string[]; readonly publicationKind: "MONTHLY" | "BACKFILL" | "CORRECTION"; readonly publishedAtIso: string; readonly expectedUsagePeriods: readonly string[]; readonly interpretation: "PROVIDER_ESTIMATE_MTCO2E_NOT_WORKLOAD_ATTRIBUTION"; readonly allocateToCur2ResourcesOrTags: false; readonly keepLbmAndMbmSeparate: true; readonly keepTotalsAndScopesSeparate: true };
  };
  readonly objectReads: { readonly current: readonly string[]; readonly versioned: readonly string[]; readonly enforceExactPrefix: true; readonly enforceExpectedBucketOwner: true };
  readonly maximumDurationMs: number;
}

export interface SustainabilityProviderBinding {
  readonly schemaVersion: "sutra.sustainability-provider-binding.v1";
  readonly orgId: string; readonly customerId: string; readonly connectionId: string;
  readonly permissionPackVersion: "standard-2026-08.15";
  readonly bucketRegion: string; readonly kmsKeyArn: string | null;
  readonly directApiComparator: "DISABLED" | "READ_ONLY_SEPARATE";
  readonly dimensionContractVersion: "sutra.sustainability-proxy-dimensions.v2";
  readonly regionReference: { readonly sourceUri: string; readonly sourceVersion: string; readonly sha256: string } | null;
}

export interface SustainabilityProxyArtifact {
  readonly generationId: string; readonly manifestSha256: string;
  readonly dataThroughAtIso: string; readonly rowsExhausted: boolean;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
}
export interface SustainabilityCarbonArtifact {
  readonly bucket: string; readonly prefix: string; readonly expectedBucketOwner: string;
  readonly exportArn: string; readonly generationId: string; readonly manifestSha256: string;
  readonly publishedAtIso: string; readonly objectsExhausted: boolean;
  readonly objects: readonly Readonly<Record<string, unknown>>[];
  readonly rowsExhausted: boolean; readonly periods: readonly Readonly<Record<string, unknown>>[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
}
export interface SustainabilityDirectComparatorArtifact {
  readonly source: "AWS_SUSTAINABILITY_DIRECT_API";
  readonly observedAtIso: string; readonly requestSha256: string;
  readonly pagesExhausted: boolean; readonly pageCount: number;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
}
export interface SustainabilityProviderReader {
  readActiveCur2(request: SustainabilityProviderRequest, credentials: AwsTemporaryCredentials, signal: AbortSignal): Promise<SustainabilityProxyArtifact>;
  readCarbonExport(request: SustainabilityProviderRequest, credentials: AwsTemporaryCredentials, signal: AbortSignal): Promise<SustainabilityCarbonArtifact>;
  readDirectComparator?(request: SustainabilityProviderRequest, credentials: AwsTemporaryCredentials, signal: AbortSignal): Promise<SustainabilityDirectComparatorArtifact>;
}

export class SustainabilityProviderAdapterError extends Error {
  public constructor(public readonly code: "INVALID_REQUEST" | "PROVIDER_RESPONSE_INVALID" | "BOUND_REACHED" | "ABORTED") {
    super("Sustainability provider collection did not complete");
    this.name = "SustainabilityProviderAdapterError";
  }
}
const reject = (code: SustainabilityProviderAdapterError["code"]): never => { throw new SustainabilityProviderAdapterError(code); };
const SHA = /^[a-f0-9]{64}$/u; const ACCOUNT = /^\d{12}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u; const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const BUCKET = /^(?!\d+\.\d+\.\d+\.\d+$)(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const DECIMAL = /^(?:0|[1-9]\d{0,20})(?:\.\d{1,6})?$/u;
function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (typeof value === "object" && value !== null) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`; return JSON.stringify(value); }
function sortedUnique(values: readonly string[]): boolean { return new Set(values).size === values.length && JSON.stringify(values) === JSON.stringify([...values].sort()); }
function exportArnMatches(carbon: SustainabilityProviderRequest["channels"]["providerCarbon"], accountId: string): boolean {
  const escaped = carbon.exportName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^arn:aws:bcm-data-exports:${carbon.exportRegion}:${accountId}:export/${escaped}(?:-[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})?$`, "u").test(carbon.exportArn);
}
function objectRecord(value: unknown): Readonly<Record<string, unknown>> { if (typeof value !== "object" || value === null || Array.isArray(value)) reject("PROVIDER_RESPONSE_INVALID"); return value as Readonly<Record<string, unknown>>; }
function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()); }
function validateArtifacts(request: SustainabilityProviderRequest, proxy: SustainabilityProxyArtifact, carbon: SustainabilityCarbonArtifact): void {
  for (const raw of proxy.rows) {
    const row = objectRecord(raw); if (typeof row.usageAccountId !== "string" || !request.allowedUsageAccountIds.includes(row.usageAccountId) || Object.keys(row).some((key) => /carbon|emission/iu.test(key))) reject("PROVIDER_RESPONSE_INVALID");
    if (row.dimensions !== undefined) { const dimensions = objectRecord(row.dimensions); const expected = ["processorArchitecture", "instanceFamily", "storageClass", "transferPath", "idleNetworkResource", "regionLatitudeE6", "regionLongitudeE6", "renewableEnergyClass"]; if (!exactKeys(dimensions, expected)) reject("PROVIDER_RESPONSE_INVALID"); for (const entry of Object.values(dimensions)) { const evidence = objectRecord(entry); if (!exactKeys(evidence, ["state", "value", "sourceField", "sourceVersion"]) || !["ready", "unavailable"].includes(String(evidence.state)) || (evidence.state === "ready" && [evidence.value, evidence.sourceField, evidence.sourceVersion].some((value) => typeof value !== "string")) || (evidence.state === "unavailable" && [evidence.value, evidence.sourceField, evidence.sourceVersion].some((value) => value !== null))) reject("PROVIDER_RESPONSE_INVALID"); } }
  }
  let bytes = 0; const objectKeys = new Set<string>();
  for (const raw of carbon.objects) { const object = objectRecord(raw); const key = typeof object.key === "string" ? object.key : reject("PROVIDER_RESPONSE_INVALID"); if (!exactKeys(object, ["bucket", "key", "eTag", "versionId", "sha256", "sizeBytes"]) || object.bucket !== carbon.bucket || !key.startsWith(carbon.prefix) || objectKeys.has(key) || typeof object.eTag !== "string" || (object.versionId !== null && typeof object.versionId !== "string") || typeof object.sha256 !== "string" || !SHA.test(object.sha256) || !Number.isSafeInteger(object.sizeBytes) || Number(object.sizeBytes) < 0 || Number(object.sizeBytes) > 5 * 1_024 * 1_024 * 1_024) reject("PROVIDER_RESPONSE_INVALID"); objectKeys.add(key); bytes += Number(object.sizeBytes); if (bytes > SUSTAINABILITY_PROVIDER_BOUNDS.maximumBytes) reject("BOUND_REACHED"); }
  const seenPeriods = new Set<string>();
  for (const raw of carbon.periods) { const period = objectRecord(raw); const usagePeriod = typeof period.usagePeriod === "string" ? period.usagePeriod : reject("PROVIDER_RESPONSE_INVALID"); if (!exactKeys(period, ["usagePeriod", "selectedModelVersion", "deliveryState", "objectKeys", "complete"]) || !request.channels.providerCarbon.expectedUsagePeriods.includes(usagePeriod) || seenPeriods.has(usagePeriod) || typeof period.selectedModelVersion !== "string" || !/^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(period.selectedModelVersion) || !["DELIVERED_ROWS", "DELIVERED_EMPTY"].includes(String(period.deliveryState)) || period.complete !== true && period.complete !== false || !Array.isArray(period.objectKeys) || period.objectKeys.some((key) => typeof key !== "string" || !objectKeys.has(key))) reject("PROVIDER_RESPONSE_INVALID"); seenPeriods.add(usagePeriod); }
  if (JSON.stringify([...seenPeriods].sort()) !== JSON.stringify(request.channels.providerCarbon.expectedUsagePeriods)) reject("PROVIDER_RESPONSE_INVALID");
  for (const raw of carbon.rows) { const row = objectRecord(raw); if (row.payerAccountId !== request.scope.accountId || typeof row.usageAccountId !== "string" || !request.allowedUsageAccountIds.includes(row.usageAccountId) || typeof row.usagePeriodStartIso !== "string" || !request.channels.providerCarbon.expectedUsagePeriods.includes(row.usagePeriodStartIso.slice(0, 7))) reject("PROVIDER_RESPONSE_INVALID"); for (const [key, value] of Object.entries(row)) { if (/EmissionsValue$/u.test(key) && value !== null && (typeof value !== "string" || !DECIMAL.test(value))) reject("PROVIDER_RESPONSE_INVALID"); if (/EmissionsUnit$/u.test(key) && value !== null && value !== "MTCO2e") reject("PROVIDER_RESPONSE_INVALID"); } }
}
function validRequest(request: SustainabilityProviderRequest, binding: SustainabilityProviderBinding): void {
  const carbon = request.channels.providerCarbon;
  if (request.schemaVersion !== "sutra.sustainability-carbon-runtime-request.v1"
    || !/^scr_[a-f0-9]{64}$/u.test(request.requestId) || !/^sustainability_[a-f0-9]{64}$/u.test(request.expectedCaptureId)
    || !/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u.test(request.scheduledWindow)
    || !ID.test(request.scope.orgId) || !ID.test(request.scope.customerId) || !CONNECTION.test(request.scope.connectionId)
    || !ACCOUNT.test(request.scope.accountId) || request.scope.partition !== "aws"
    || request.credentials !== "SERVER_OWNED_TRUST_ROLE_SESSION" || request.maximumDurationMs !== SUSTAINABILITY_PROVIDER_BOUNDS.maximumDurationMs
    || request.allowedUsageAccountIds.length < 1 || request.allowedUsageAccountIds.length > 10_000
    || request.allowedUsageAccountIds.some((value) => !ACCOUNT.test(value)) || !sortedUnique(request.allowedUsageAccountIds)
    || !request.allowedUsageAccountIds.includes(request.scope.accountId)
    || request.channels.proxy.interpretation !== "RESOURCE_USE_PROXY_NOT_CARBON" || request.channels.proxy.conversionToMtco2e !== false
    || carbon.interpretation !== "PROVIDER_ESTIMATE_MTCO2E_NOT_WORKLOAD_ATTRIBUTION" || carbon.allocateToCur2ResourcesOrTags !== false
    || carbon.keepLbmAndMbmSeparate !== true || carbon.keepTotalsAndScopesSeparate !== true
    || carbon.tableName !== "CARBON_EMISSIONS" || !BUCKET.test(carbon.bucket) || !carbon.prefix.endsWith("/") || carbon.prefix.includes("..")
    || JSON.stringify(carbon.schemaColumns) !== JSON.stringify(SUSTAINABILITY_CARBON_COLUMNS)
    || carbon.expectedBucketOwner !== request.scope.accountId || !exportArnMatches(carbon, request.scope.accountId)
    || !/^fbg_[a-f0-9]{64}$/u.test(request.channels.proxy.generationId) || !/^fbg_[a-f0-9]{64}$/u.test(carbon.generationId)
    || !SHA.test(request.channels.proxy.manifestSha256) || !SHA.test(carbon.manifestSha256)
    || !ISO.test(request.channels.proxy.dataThroughAtIso) || !ISO.test(carbon.publishedAtIso)
    || carbon.expectedUsagePeriods.length < 1 || carbon.expectedUsagePeriods.length > SUSTAINABILITY_PROVIDER_BOUNDS.maximumPeriods
    || carbon.expectedUsagePeriods.some((value) => !MONTH.test(value)) || !sortedUnique(carbon.expectedUsagePeriods)
    || JSON.stringify(request.objectReads.current) !== JSON.stringify(["s3:GetBucketLocation", "s3:ListBucket", "s3:GetObject"])
    || JSON.stringify(request.objectReads.versioned) !== JSON.stringify(["s3:GetObjectVersion"])
    || request.objectReads.enforceExactPrefix !== true || request.objectReads.enforceExpectedBucketOwner !== true
    || binding.schemaVersion !== "sutra.sustainability-provider-binding.v1" || binding.permissionPackVersion !== "standard-2026-08.15"
    || binding.orgId !== request.scope.orgId || binding.customerId !== request.scope.customerId || binding.connectionId !== request.scope.connectionId
    || binding.dimensionContractVersion !== "sutra.sustainability-proxy-dimensions.v2"
    || (binding.regionReference !== null && (!SHA.test(binding.regionReference.sha256) || binding.regionReference.sourceUri.length > 1024 || binding.regionReference.sourceVersion.length > 256))) reject("INVALID_REQUEST");
}

export async function collectSustainabilityProviderEvidence(input: {
  readonly request: SustainabilityProviderRequest; readonly binding: SustainabilityProviderBinding;
  readonly credentials: AwsTemporaryCredentials; readonly reader: SustainabilityProviderReader;
  readonly signal: AbortSignal; readonly now?: () => number;
}) {
  validRequest(input.request, input.binding); if (input.signal.aborted) reject("ABORTED");
  const now = input.now ?? Date.now; const started = now(); const signal = AbortSignal.any([input.signal, AbortSignal.timeout(SUSTAINABILITY_PROVIDER_BOUNDS.maximumDurationMs)]);
  const [proxy, carbon] = await Promise.all([
    input.reader.readActiveCur2(input.request, input.credentials, signal),
    input.reader.readCarbonExport(input.request, input.credentials, signal),
  ]).catch(() => reject(signal.aborted ? "ABORTED" : "PROVIDER_RESPONSE_INVALID"));
  if (proxy.generationId !== input.request.channels.proxy.generationId || proxy.manifestSha256 !== input.request.channels.proxy.manifestSha256
    || proxy.dataThroughAtIso !== input.request.channels.proxy.dataThroughAtIso || proxy.rows.length > SUSTAINABILITY_PROVIDER_BOUNDS.maximumProxyRows
    || carbon.bucket !== input.request.channels.providerCarbon.bucket || carbon.prefix !== input.request.channels.providerCarbon.prefix
    || carbon.expectedBucketOwner !== input.request.channels.providerCarbon.expectedBucketOwner || carbon.exportArn !== input.request.channels.providerCarbon.exportArn
    || carbon.generationId !== input.request.channels.providerCarbon.generationId || carbon.manifestSha256 !== input.request.channels.providerCarbon.manifestSha256
    || carbon.publishedAtIso !== input.request.channels.providerCarbon.publishedAtIso || carbon.objects.length > SUSTAINABILITY_PROVIDER_BOUNDS.maximumObjects
    || carbon.periods.length !== input.request.channels.providerCarbon.expectedUsagePeriods.length || carbon.rows.length > SUSTAINABILITY_PROVIDER_BOUNDS.maximumCarbonRows) reject("PROVIDER_RESPONSE_INVALID");
  validateArtifacts(input.request, proxy, carbon);
  const keys = carbon.objects.map((item) => item.key); if (keys.some((key) => typeof key !== "string" || !key.startsWith(carbon.prefix)) || new Set(keys).size !== keys.length || JSON.stringify(keys) !== JSON.stringify([...keys].sort())) reject("PROVIDER_RESPONSE_INVALID");
  const bytes = Buffer.byteLength(JSON.stringify({ proxy, carbon }), "utf8"); if (bytes > SUSTAINABILITY_PROVIDER_BOUNDS.maximumBytes) reject("BOUND_REACHED");
  let directApiComparator: SustainabilityDirectComparatorArtifact | null = null;
  if (input.binding.directApiComparator === "READ_ONLY_SEPARATE") {
    const readComparator: NonNullable<SustainabilityProviderReader["readDirectComparator"]> =
      input.reader.readDirectComparator ?? (() => reject("INVALID_REQUEST"));
    const comparator = await readComparator(input.request, input.credentials, signal)
      .catch(() => reject(signal.aborted ? "ABORTED" : "PROVIDER_RESPONSE_INVALID"));
    if (comparator.source !== "AWS_SUSTAINABILITY_DIRECT_API" || !ISO.test(comparator.observedAtIso)
      || !SHA.test(comparator.requestSha256) || !comparator.pagesExhausted
      || !Number.isSafeInteger(comparator.pageCount) || comparator.pageCount < 1
      || comparator.pageCount > SUSTAINABILITY_PROVIDER_BOUNDS.maximumComparatorPages
      || comparator.rows.length > SUSTAINABILITY_PROVIDER_BOUNDS.maximumComparatorRows) reject("PROVIDER_RESPONSE_INVALID");
    const comparatorBytes = Buffer.byteLength(JSON.stringify(comparator), "utf8");
    if (comparatorBytes > SUSTAINABILITY_PROVIDER_BOUNDS.maximumComparatorBytes
      || bytes + comparatorBytes > SUSTAINABILITY_PROVIDER_BOUNDS.maximumResponseBytes) reject("BOUND_REACHED");
    directApiComparator = comparator;
  }
  const completed = now(); if (!Number.isSafeInteger(started) || !Number.isSafeInteger(completed) || completed < started || completed - started > SUSTAINABILITY_PROVIDER_BOUNDS.maximumDurationMs) reject("ABORTED");
  const capture = Object.freeze({ schemaVersion: "sutra.sustainability-carbon.v1" as const, scope: input.request.scope,
    captureId: input.request.expectedCaptureId, startedAtIso: new Date(started).toISOString(), completedAtIso: new Date(completed).toISOString(),
    allowedUsageAccountIds: input.request.allowedUsageAccountIds, configuration: { cur2Configured: true, carbonExportConfigured: true, carbonExportAccessValidated: true },
    proxyEvidence: { source: "AWS_CUR2_ACTIVE_GENERATION" as const, generationId: proxy.generationId, manifestSha256: proxy.manifestSha256, dataThroughAtIso: proxy.dataThroughAtIso, rowsExhausted: proxy.rowsExhausted, rows: proxy.rows },
    carbonEvidence: { source: "AWS_SUSTAINABILITY_CARBON_DATA_EXPORT" as const, tableName: "CARBON_EMISSIONS" as const, exportName: input.request.channels.providerCarbon.exportName, exportArn: carbon.exportArn, exportRegion: input.request.channels.providerCarbon.exportRegion, bucket: carbon.bucket, prefix: carbon.prefix, generationId: carbon.generationId, manifestSha256: carbon.manifestSha256, schemaColumns: input.request.channels.providerCarbon.schemaColumns, publicationKind: input.request.channels.providerCarbon.publicationKind, publishedAtIso: carbon.publishedAtIso, allowedUsageAccountIds: input.request.allowedUsageAccountIds, expectedUsagePeriods: input.request.channels.providerCarbon.expectedUsagePeriods, objectsExhausted: carbon.objectsExhausted, objects: carbon.objects, rowsExhausted: carbon.rowsExhausted, periods: carbon.periods, rows: carbon.rows } });
  return Object.freeze({ capture, directApiComparator, separation: Object.freeze({ exportIsAuthoritativeHistory: true as const, comparatorPersistedAsExport: false as const, comparatorMayReplaceExportState: false as const, proxyConvertedToCarbon: false as const, carbonAllocatedToCur2: false as const }), captureSha256: digest(canonical(capture)) });
}
