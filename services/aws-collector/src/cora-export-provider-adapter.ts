/** Credential-owning, bounded CORA Data Exports provider boundary. */
import { createHash } from "node:crypto";
import type { AwsTemporaryCredentials } from "./types.js";

export const CORA_PROVIDER_SESSION_ACTIONS = Object.freeze([
  "sts:GetCallerIdentity",
  "bcm-data-exports:GetExport", "bcm-data-exports:GetExecution", "bcm-data-exports:ListExecutions",
  "cost-optimization-hub:GetPreferences", "cost-optimization-hub:ListEnrollmentStatuses",
  "organizations:DescribeOrganization", "organizations:ListAccounts",
  "s3:GetBucketLocation", "s3:ListBucket", "s3:GetObject", "s3:GetObjectAttributes",
] as const);

export const CORA_PROVIDER_BOUNDS = Object.freeze({
  maximumObjects: 100_000, maximumRows: 500_000, maximumBytes: 192 * 1_024 * 1_024,
  maximumManifestBytes: 8 * 1_024 * 1_024, maximumRowBytes: 96 * 1_024,
  maximumDurationMs: 15 * 60 * 1_000, maximumAccounts: 10_000, maximumRegions: 100,
  rejectPaginationTokenReplay: true, requireExhaustionEvidence: true,
} as const);

export interface CoraProviderRequest {
  readonly schemaVersion: "sutra.cora-export-provider-request.v1";
  readonly requestKey: string; readonly scheduledWindow: string;
  readonly scope: { readonly orgId: string; readonly customerId: string; readonly connectionId: string; readonly partition: "aws" | "aws-cn" | "aws-us-gov"; readonly managementAccountId: string; readonly awsOrganizationId: string | null };
  readonly target: { readonly exportArn: string; readonly exportName: string; readonly bucketName: string; readonly prefix: string; readonly partition: string; readonly tableName: "COST_OPTIMIZATION_RECOMMENDATIONS"; readonly includeAllRecommendations: true; readonly filterJson: null; readonly fileVersioning: "CREATE_NEW_REPORT"; readonly refreshCadence: "SYNCHRONOUS"; readonly fileFormat: "PARQUET" | "TEXT_OR_CSV"; readonly compression: "PARQUET" | "GZIP"; readonly exportDefinitionSha256: string; readonly querySha256: string; readonly tableConfigurationsSha256: string };
  readonly expectedAccountIds: readonly string[]; readonly expectedRegions: readonly string[];
  readonly operations: readonly string[]; readonly manifestSelection: "EXECUTION_SPECIFIC_ONLY";
  readonly rejectMutableLatestManifest: true; readonly acceptDirectApiRecommendationRows: false;
  readonly bounds: typeof CORA_PROVIDER_BOUNDS; readonly deadlineAtIso: string;
  readonly credentials: "SERVER_OWNED_TRUST_ROLE_SESSION";
}

export interface CoraProviderObjectArtifact { readonly key: string; readonly versionId: string | null; readonly eTag: string; readonly contentSha256: string; readonly sizeBytes: number; readonly rows: readonly unknown[]; }
export interface CoraProviderExecutionArtifact {
  readonly executionId: string; readonly status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  readonly statusObservedAt: string; readonly generatedAt: string | null; readonly dataThroughAt: string | null;
  readonly errorCode: string | null; readonly getExecutionSha256: string;
  readonly manifest: null | { readonly key: string; readonly versionId: string | null; readonly eTag: string; readonly contentSha256: string; readonly sizeBytes: number; readonly executionId: string; readonly dataObjectKeys: readonly string[]; readonly schemaSha256: string };
  readonly objects: readonly CoraProviderObjectArtifact[];
  readonly coveredAccountIds: readonly string[]; readonly coveredRegions: readonly string[];
  readonly listExecutionsExhausted: boolean; readonly objectListingExhausted: boolean;
}
export interface CoraProviderReader {
  /** SDK/Parquet implementation must hash bytes before decode and never return raw object bodies. */
  readExecution(request: CoraProviderRequest, credentials: AwsTemporaryCredentials, signal: AbortSignal): Promise<CoraProviderExecutionArtifact>;
}
export class CoraProviderError extends Error { public readonly code: "INVALID_REQUEST" | "PROVIDER_RESPONSE_INVALID" | "BOUND_REACHED" | "ABORTED"; public constructor(code: CoraProviderError["code"]) { super("CORA provider collection rejected"); this.name = "CoraProviderError"; this.code = code; } }
function reject(code: CoraProviderError["code"]): never { throw new CoraProviderError(code); }
const SHA = /^[a-f0-9]{64}$/u; const ACCOUNT = /^\d{12}$/u; const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ACTIONS = new Set(["Rightsize", "Stop", "Upgrade", "PurchaseSavingsPlans", "PurchaseReservedInstances", "MigrateToGraviton", "Delete", "ScaleIn"]);
const RESOURCES = new Set(["Ec2Instance", "LambdaFunction", "EbsVolume", "EcsService", "Ec2AutoScalingGroup", "Ec2InstanceSavingsPlans", "ComputeSavingsPlans", "SageMakerSavingsPlans", "Ec2ReservedInstances", "RdsReservedInstances", "OpenSearchReservedInstances", "RedshiftReservedInstances", "ElastiCacheReservedInstances", "RdsDbInstanceStorage", "RdsDbInstance", "AuroraDbClusterStorage", "DynamoDbReservedCapacity", "MemoryDbReservedInstances", "NatGateway", "DynamoDBTable", "ElastiCacheCluster", "MemoryDBCluster", "DocumentDBCluster", "WorkSpaces", "SageMakerEndpoint"]);
const ROW_KEYS = ["account_id", "account_name", "action_type", "currency_code", "current_resource_details", "current_resource_summary", "current_resource_type", "estimated_monthly_cost_after_discount", "estimated_monthly_cost_before_discount", "estimated_monthly_savings_after_discount", "estimated_monthly_savings_before_discount", "estimated_savings_percentage_after_discount", "estimated_savings_percentage_before_discount", "implementation_effort", "last_refresh_timestamp", "recommendation_id", "recommendation_lookback_period_in_days", "recommendation_source", "recommended_resource_details", "recommended_resource_summary", "recommended_resource_type", "region", "resource_arn", "resource_id", "restart_needed", "rollback_possible", "tags"] as const;
function record(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) reject("PROVIDER_RESPONSE_INVALID"); return value as Record<string, unknown>; }
function string(value: unknown, nullable = false): string | null { if (value === null && nullable) return null; if (typeof value !== "string") reject("PROVIDER_RESPONSE_INVALID"); if (value.length > 65_536 || /[\u0000]/u.test(value)) reject("PROVIDER_RESPONSE_INVALID"); return value; }
function decimal(value: unknown, nullable = false): string | null { if (value === null && nullable) return null; const result = typeof value === "number" ? String(value) : string(value); if (result === null || !/^-?(?:0|[1-9]\d{0,30})(?:\.\d{1,12})?$/u.test(result)) reject("PROVIDER_RESPONSE_INVALID"); return result; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (typeof value === "object" && value !== null) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`; return JSON.stringify(value); }
function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function configuration(value: unknown): string | null { if (value === null) return null; let parsed: unknown = value; if (typeof value === "string") { try { parsed = JSON.parse(value); } catch { reject("PROVIDER_RESPONSE_INVALID"); } } return canonical(parsed); }
function tags(value: unknown): readonly { readonly key: string; readonly value: string }[] { if (value === null) return []; const map = record(value); const entries = Object.entries(map); if (entries.length > 100) reject("BOUND_REACHED"); return entries.map(([key, child]) => { const tag = string(child); if (tag === null) reject("PROVIDER_RESPONSE_INVALID"); if (key.length < 1 || key.length > 128 || tag.length > 256) reject("PROVIDER_RESPONSE_INVALID"); return { key, value: tag }; }).sort((a, b) => a.key.localeCompare(b.key)); }
function normalizeRow(value: unknown) {
  const row = record(value); if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify([...ROW_KEYS].sort())) reject("PROVIDER_RESPONSE_INVALID");
  const accountId = string(row.account_id); const actionType = string(row.action_type); const currentType = string(row.current_resource_type, true); const recommendedType = string(row.recommended_resource_type, true);
  if (accountId === null || !ACCOUNT.test(accountId) || actionType === null || !ACTIONS.has(actionType) || (currentType !== null && !RESOURCES.has(currentType)) || (recommendedType !== null && !RESOURCES.has(recommendedType))) reject("PROVIDER_RESPONSE_INVALID");
  const recommendationId = string(row.recommendation_id); const fingerprint = digest(canonical(row)); const trackingIdentity = canonical({ accountId, actionType, currentType, recommendedType, region: row.region, resourceArn: row.resource_arn, resourceId: row.resource_id, recommendedResourceSummary: row.recommended_resource_summary });
  if (typeof row.recommendation_lookback_period_in_days !== "number" || !Number.isSafeInteger(row.recommendation_lookback_period_in_days)
    || row.recommendation_lookback_period_in_days < 1 || row.recommendation_lookback_period_in_days > 365
    || typeof row.restart_needed !== "boolean" || typeof row.rollback_possible !== "boolean"
    || typeof row.last_refresh_timestamp !== "string" || !ISO.test(row.last_refresh_timestamp)) reject("PROVIDER_RESPONSE_INVALID");
  return { trackingKey: `cor_${digest(trackingIdentity)}`, fingerprintSha256: fingerprint, recommendationId,
    accountId, accountName: string(row.account_name), actionType, currencyCode: string(row.currency_code),
    currentResourceType: currentType, recommendedResourceType: recommendedType,
    currentResourceSummary: string(row.current_resource_summary, true), recommendedResourceSummary: string(row.recommended_resource_summary, true),
    currentResourceDetailsJson: configuration(row.current_resource_details),
    recommendedResourceDetailsJson: configuration(row.recommended_resource_details),
    estimatedMonthlyCostBeforeDiscount: decimal(row.estimated_monthly_cost_before_discount), estimatedMonthlyCostAfterDiscount: decimal(row.estimated_monthly_cost_after_discount, true),
    estimatedMonthlySavingsBeforeDiscount: decimal(row.estimated_monthly_savings_before_discount), estimatedMonthlySavingsAfterDiscount: decimal(row.estimated_monthly_savings_after_discount, true),
    estimatedSavingsPercentageBeforeDiscount: decimal(row.estimated_savings_percentage_before_discount), estimatedSavingsPercentageAfterDiscount: decimal(row.estimated_savings_percentage_after_discount, true),
    implementationEffort: string(row.implementation_effort), lastRefreshTimestamp: string(row.last_refresh_timestamp),
    recommendationLookbackPeriodInDays: row.recommendation_lookback_period_in_days, recommendationSource: string(row.recommendation_source),
    region: row.region === null ? "global" : string(row.region), resourceId: string(row.resource_id, true), resourceArn: string(row.resource_arn, true),
    restartNeeded: row.restart_needed, rollbackPossible: row.rollback_possible, tags: tags(row.tags) };
}
function exactRequest(request: CoraProviderRequest): void {
  const deadline = Date.parse(request.deadlineAtIso);
  if (request.schemaVersion !== "sutra.cora-export-provider-request.v1" || !/^corarq_[a-f0-9]{64}$/u.test(request.requestKey)
    || !/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u.test(request.scheduledWindow) || !Number.isFinite(deadline)
    || request.credentials !== "SERVER_OWNED_TRUST_ROLE_SESSION" || request.manifestSelection !== "EXECUTION_SPECIFIC_ONLY"
    || request.rejectMutableLatestManifest !== true || request.acceptDirectApiRecommendationRows !== false
    || JSON.stringify(request.bounds) !== JSON.stringify(CORA_PROVIDER_BOUNDS)
    || JSON.stringify(request.operations) !== JSON.stringify(CORA_PROVIDER_SESSION_ACTIONS.slice(1))) reject("INVALID_REQUEST");
}
export async function collectCoraProviderEvidence(input: { readonly request: CoraProviderRequest; readonly credentials: AwsTemporaryCredentials; readonly reader: CoraProviderReader; readonly signal: AbortSignal; readonly now?: () => number }) {
  exactRequest(input.request); if (input.signal.aborted) reject("ABORTED"); const started = input.now?.() ?? Date.now();
  const artifact: CoraProviderExecutionArtifact = await input.reader.readExecution(input.request, input.credentials, input.signal).catch(() => reject(input.signal.aborted ? "ABORTED" : "PROVIDER_RESPONSE_INVALID"));
  if (!artifact.listExecutionsExhausted || !artifact.objectListingExhausted || artifact.objects.length > CORA_PROVIDER_BOUNDS.maximumObjects) reject("BOUND_REACHED");
  if (!ISO.test(artifact.statusObservedAt) || !SHA.test(artifact.getExecutionSha256)
    || (artifact.generatedAt !== null && !ISO.test(artifact.generatedAt)) || (artifact.dataThroughAt !== null && !ISO.test(artifact.dataThroughAt))
    || (artifact.status === "FAILED") !== (artifact.errorCode !== null)) reject("PROVIDER_RESPONSE_INVALID");
  const prefix = `${input.request.target.prefix}/${input.request.target.exportName}/data/${input.request.target.partition}/`; let bytes = 0; let rowCount = 0; const rows: unknown[] = [];
  const sorted = [...artifact.objects].sort((a, b) => a.key.localeCompare(b.key)); if (JSON.stringify(sorted.map((item) => item.key)) !== JSON.stringify(artifact.objects.map((item) => item.key))) reject("PROVIDER_RESPONSE_INVALID");
  if (new Set(artifact.objects.map((item) => item.key)).size !== artifact.objects.length) reject("PROVIDER_RESPONSE_INVALID");
  if (artifact.manifest !== null) {
    const manifestPrefix = `${input.request.target.prefix}/${input.request.target.exportName}/metadata/${input.request.target.partition}/`;
    if (!artifact.manifest.key.startsWith(manifestPrefix) || !artifact.manifest.key.endsWith(`-${artifact.executionId}/Manifest.json`)
      || artifact.manifest.executionId !== artifact.executionId || !SHA.test(artifact.manifest.contentSha256) || !SHA.test(artifact.manifest.schemaSha256)
      || artifact.manifest.sizeBytes < 1 || artifact.manifest.sizeBytes > CORA_PROVIDER_BOUNDS.maximumManifestBytes
      || JSON.stringify(artifact.manifest.dataObjectKeys) !== JSON.stringify(artifact.objects.map((item) => item.key))) reject("PROVIDER_RESPONSE_INVALID");
  } else if (artifact.status === "SUCCEEDED") reject("PROVIDER_RESPONSE_INVALID");
  for (const object of artifact.objects) { if (!object.key.startsWith(prefix) || !SHA.test(object.contentSha256) || object.sizeBytes < 0 || !Number.isSafeInteger(object.sizeBytes)) reject("PROVIDER_RESPONSE_INVALID"); bytes += object.sizeBytes; rowCount += object.rows.length; if (bytes > CORA_PROVIDER_BOUNDS.maximumBytes || rowCount > CORA_PROVIDER_BOUNDS.maximumRows) reject("BOUND_REACHED"); object.rows.forEach((row, ordinal) => { if (Buffer.byteLength(JSON.stringify(row), "utf8") > CORA_PROVIDER_BOUNDS.maximumRowBytes) reject("BOUND_REACHED"); rows.push({ sourceObjectKey: object.key, sourceObjectSha256: object.contentSha256, rowOrdinal: ordinal + 1, recommendation: normalizeRow(row) }); }); }
  const completed = input.now?.() ?? Date.now(); if (!Number.isSafeInteger(started) || !Number.isSafeInteger(completed) || completed < started) reject("PROVIDER_RESPONSE_INVALID");
  const materializationBasis = canonical({ requestKey: input.request.requestKey, executionId: artifact.executionId, objectDigests: artifact.objects.map((item) => item.contentSha256) }); const materializationHash = digest(materializationBasis);
  return { schemaVersion: "sutra.cora-export-object-materialization.v1" as const, scope: input.request.scope, requestKey: input.request.requestKey, materializationId: `coram_${materializationHash}`, captureId: `cora_${materializationHash}`, scheduledWindow: input.request.scheduledWindow, startedAt: new Date(started).toISOString(), completedAt: new Date(completed).toISOString(), directApiRecommendationRowsAccepted: false as const, target: input.request.target,
    execution: { executionId: artifact.executionId, status: artifact.status, statusObservedAt: artifact.statusObservedAt, generatedAt: artifact.generatedAt, dataThroughAt: artifact.dataThroughAt, errorCode: artifact.errorCode, getExecutionSha256: artifact.getExecutionSha256 }, manifest: artifact.manifest,
    objects: artifact.objects.map((object) => ({ key: object.key, versionId: object.versionId, eTag: object.eTag, contentSha256: object.contentSha256, sizeBytes: object.sizeBytes, rowCount: object.rows.length, processed: true })), rows,
    coverage: { coveredAccountIds: [...artifact.coveredAccountIds].sort(), coveredRegions: [...artifact.coveredRegions].sort() }, reconciliation: { manifestObjectCount: artifact.manifest?.dataObjectKeys.length ?? 0, processedObjectCount: artifact.objects.length, manifestRowCount: rowCount, parsedRowCount: rowCount, acceptedRowCount: rows.length, rejectedRowCount: 0, duplicateRowCount: 0, pagesExhausted: true, parserSchemaVersion: "aws.cost-optimization-recommendations.v1" as const } };
}
