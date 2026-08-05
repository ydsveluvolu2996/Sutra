/** Bounded provider operations for one server-sealed SCAD CUR2 export. */
import type { AwsTemporaryCredentials, AwsPartition } from "./types.js";

export const SCAD_CUR2_PROVIDER_ACTIONS = Object.freeze([
  "s3:GetBucketLocation", "s3:ListBucket", "s3:GetObject", "s3:GetObjectAttributes",
] as const);
export const SCAD_CUR2_PROVIDER_BOUNDS = Object.freeze({ maximumDurationMs: 1_800_000,
  maximumObjects: 20_000, pageSize: 1_000, maximumResponseBytes: 12 * 1_024 * 1_024 } as const);
export type ScadCur2ProviderPack = "standard-2026-08.1" | "standard-2026-08.2"
  | "standard-2026-08.3" | "standard-2026-08.4" | "standard-2026-08.5"
  | "standard-2026-08.6" | "standard-2026-08.7" | "standard-2026-08.8"
  | "standard-2026-08.9" | "standard-2026-08.10" | "standard-2026-08.11"
  | "standard-2026-08.12" | "standard-2026-08.13" | "standard-2026-08.14";
export interface ScadCur2ProviderBinding {
  readonly schemaVersion: "sutra.scad-cur2-provider-binding.v1";
  readonly tenantId: string; readonly customerId: string; readonly connectionId: string;
  readonly accountId: string; readonly partition: AwsPartition; readonly region: string;
  readonly permissionPackVersion: ScadCur2ProviderPack;
  readonly contractId: "foundational-cur2-export-v1";
  readonly policyName: "SutraFoundationalCur2ReadV1";
  readonly exportTable: "COST_AND_USAGE_REPORT";
  readonly exportName: string; readonly exportArn: string; readonly bucket: string; readonly prefix: string;
}
export interface ScadCur2ProviderBoundary {
  readonly schemaVersion: "sutra.scad-cur2-runtime-boundary.v1";
  readonly binding: "SERVER_RESOLVED_SCAD_CUR2_EXPORT";
  readonly scope: { readonly orgId: string; readonly customerId: string; readonly connectionId: string;
    readonly partition: AwsPartition; readonly payerAccountIds: readonly string[];
    readonly usageAccountIds: readonly string[]; readonly regions: readonly string[] };
  readonly exportName: string; readonly exportArn: string; readonly bucket: string; readonly prefix: string;
  readonly billingPeriodStartAt: string; readonly billingPeriodEndAt: string; readonly scadEnabledAt: string;
  readonly firstDeliveryObservedAt: string | null; readonly priorDeliverySequence: number;
  readonly lastAcceptedGenerationId: string | null;
  readonly tableConfiguration: { readonly tableName: "COST_AND_USAGE_REPORT"; readonly timeGranularity: "HOURLY";
    readonly includeResources: "TRUE" | "FALSE"; readonly includeSplitCostAllocationData: "TRUE" | "FALSE" };
}
export interface ScadCur2ProviderRequest {
  readonly schemaVersion: "sutra.scad-cur2-provider-request.v1"; readonly requestId: string;
  readonly jobId: string; readonly scheduledWindow: string; readonly boundary: ScadCur2ProviderBoundary;
  readonly operation:
    | { readonly kind: "GET_MANIFEST" }
    | { readonly kind: "LIST_OBJECTS"; readonly manifestSha256: string; readonly pageSize: 1000; readonly token: string | null }
    | { readonly kind: "READ_ROWS"; readonly manifestSha256: string; readonly pageSize: 1000;
      readonly token: string | null; readonly object: { readonly key: string; readonly eTag: string;
        readonly versionId: string | null; readonly sha256: string; readonly sizeBytes: number } };
}
export interface ScadCur2ProviderReader {
  getManifest(boundary: ScadCur2ProviderBoundary, signal: AbortSignal): Promise<unknown>;
  listManifestObjects(input: { readonly boundary: ScadCur2ProviderBoundary; readonly manifestSha256: string;
    readonly pageSize: 1000; readonly token: string | null }, signal: AbortSignal): Promise<unknown>;
  readObjectRows(input: { readonly boundary: ScadCur2ProviderBoundary; readonly manifestSha256: string;
    readonly pageSize: 1000; readonly token: string | null; readonly object: Extract<ScadCur2ProviderRequest["operation"],
    { readonly kind: "READ_ROWS" }>["object"] }, signal: AbortSignal): Promise<unknown>;
}
export class ScadCur2ProviderAdapterError extends Error {
  public constructor(public readonly code: "INVALID_REQUEST" | "PROVIDER_RESPONSE_INVALID" | "ABORTED") {
    super("SCAD CUR2 provider request rejected"); this.name = "ScadCur2ProviderAdapterError";
  }
}
const SAFE = /^[^\u0000-\u001f\u007f<>]{1,1024}$/u; const ACCOUNT = /^\d{12}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u; const SHA = /^[a-f0-9]{64}$/u;
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/u; const PACK = /^standard-2026-08\.(?:[1-9]|1[0-4])$/u;
const reject = (code: ScadCur2ProviderAdapterError["code"]): never => { throw new ScadCur2ProviderAdapterError(code); };
function exact(value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function validToken(value: unknown): value is string | null { return value === null || typeof value === "string" && SAFE.test(value); }
function sameBoundary(request: ScadCur2ProviderRequest, binding: ScadCur2ProviderBinding): boolean {
  const boundary = request.boundary; const scope = boundary.scope;
  return binding.schemaVersion === "sutra.scad-cur2-provider-binding.v1"
    && binding.tenantId === scope.orgId && binding.customerId === scope.customerId
    && binding.connectionId === scope.connectionId && binding.partition === scope.partition
    && boundary.binding === "SERVER_RESOLVED_SCAD_CUR2_EXPORT" && boundary.exportName === binding.exportName
    && boundary.exportArn === binding.exportArn && boundary.bucket === binding.bucket && boundary.prefix === binding.prefix
    && binding.contractId === "foundational-cur2-export-v1" && binding.policyName === "SutraFoundationalCur2ReadV1"
    && binding.exportTable === "COST_AND_USAGE_REPORT" && scope.payerAccountIds.includes(binding.accountId)
    && PACK.test(binding.permissionPackVersion) && ACCOUNT.test(binding.accountId) && REGION.test(binding.region)
    && boundary.tableConfiguration.tableName === "COST_AND_USAGE_REPORT"
    && boundary.tableConfiguration.timeGranularity === "HOURLY"
    && boundary.tableConfiguration.includeResources === "TRUE"
    && boundary.tableConfiguration.includeSplitCostAllocationData === "TRUE";
}
export function validateScadCur2ProviderRequest(request: ScadCur2ProviderRequest,
  binding: ScadCur2ProviderBinding): void {
  const boundary = request?.boundary; const scope = boundary?.scope; const table = boundary?.tableConfiguration;
  const operation = request?.operation;
  if (!exact(request, ["boundary", "jobId", "operation", "requestId", "scheduledWindow", "schemaVersion"])
    || !exact(boundary, ["billingPeriodEndAt", "billingPeriodStartAt", "binding", "bucket", "exportArn",
      "exportName", "firstDeliveryObservedAt", "lastAcceptedGenerationId", "prefix", "priorDeliverySequence",
      "scadEnabledAt", "schemaVersion", "scope", "tableConfiguration"])
    || !exact(scope, ["connectionId", "customerId", "orgId", "partition", "payerAccountIds", "regions", "usageAccountIds"])
    || !exact(table, ["includeResources", "includeSplitCostAllocationData", "tableName", "timeGranularity"])
    || !exact(operation, operation?.kind === "GET_MANIFEST" ? ["kind"]
      : operation?.kind === "LIST_OBJECTS" ? ["kind", "manifestSha256", "pageSize", "token"]
        : ["kind", "manifestSha256", "object", "pageSize", "token"])
    || request.schemaVersion !== "sutra.scad-cur2-provider-request.v1"
    || !/^scr_[a-f0-9]{64}$/u.test(request.requestId) || !/^job_[a-f0-9]{32}$/u.test(request.jobId)
    || !/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u.test(request.scheduledWindow)
    || !sameBoundary(request, binding) || !CONNECTION.test(request.boundary.scope.connectionId)
    || !SAFE.test(request.boundary.scope.orgId) || !SAFE.test(request.boundary.scope.customerId)
    || !Array.isArray(scope.payerAccountIds) || scope.payerAccountIds.length < 1
    || scope.payerAccountIds.some((item) => typeof item !== "string" || !ACCOUNT.test(item))
    || !Array.isArray(scope.usageAccountIds) || scope.usageAccountIds.length < 1
    || scope.usageAccountIds.some((item) => typeof item !== "string" || !ACCOUNT.test(item))
    || !Array.isArray(scope.regions) || scope.regions.length < 1
    || scope.regions.some((item) => typeof item !== "string" || !REGION.test(item))
    || new Set(scope.payerAccountIds).size !== scope.payerAccountIds.length
    || new Set(scope.usageAccountIds).size !== scope.usageAccountIds.length
    || new Set(scope.regions).size !== scope.regions.length) reject("INVALID_REQUEST");
  if (operation.kind === "GET_MANIFEST") return;
  if (!SHA.test(operation.manifestSha256) || operation.pageSize !== SCAD_CUR2_PROVIDER_BOUNDS.pageSize
    || !validToken(operation.token)) reject("INVALID_REQUEST");
  if (operation.kind === "READ_ROWS" && (!SAFE.test(operation.object.key)
    || !operation.object.key.startsWith(binding.prefix) || operation.object.key === binding.prefix
    || !SAFE.test(operation.object.eTag) || operation.object.versionId !== null && !SAFE.test(operation.object.versionId)
    || !SHA.test(operation.object.sha256) || !Number.isSafeInteger(operation.object.sizeBytes)
    || operation.object.sizeBytes < 0)) reject("INVALID_REQUEST");
}
function validateResponse(request: ScadCur2ProviderRequest, response: unknown): void {
  if (Buffer.byteLength(JSON.stringify(response), "utf8") > SCAD_CUR2_PROVIDER_BOUNDS.maximumResponseBytes) reject("PROVIDER_RESPONSE_INVALID");
  if (request.operation.kind === "GET_MANIFEST") {
    if (!exact(response, ["activeGenerationId", "billingPeriodEndAt", "billingPeriodStartAt", "bucket", "dataThroughAt",
      "expectedObjectCount", "exportArn", "generatedAt", "manifestSha256", "prefix", "runtimeS3PermissionsValidated",
      "schemaColumns", "schemaVersion", "scope"])) reject("PROVIDER_RESPONSE_INVALID");
  } else if (request.operation.kind === "LIST_OBJECTS") {
    if (!exact(response, ["nextToken", "objects"]) || !Array.isArray(response.objects)
      || response.objects.length > SCAD_CUR2_PROVIDER_BOUNDS.pageSize || !validToken(response.nextToken)) reject("PROVIDER_RESPONSE_INVALID");
  } else if (!exact(response, ["nextToken", "object", "rows"]) || !Array.isArray(response.rows)
    || response.rows.length > SCAD_CUR2_PROVIDER_BOUNDS.pageSize || !validToken(response.nextToken)) reject("PROVIDER_RESPONSE_INVALID");
}
export async function runScadCur2ProviderOperation(input: { readonly request: ScadCur2ProviderRequest;
  readonly binding: ScadCur2ProviderBinding; readonly credentials: AwsTemporaryCredentials;
  readonly reader: ScadCur2ProviderReader; readonly signal: AbortSignal }): Promise<unknown> {
  validateScadCur2ProviderRequest(input.request, input.binding);
  if (!(input.signal instanceof AbortSignal) || input.signal.aborted) reject("ABORTED");
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(SCAD_CUR2_PROVIDER_BOUNDS.maximumDurationMs)]);
  let response: unknown; const operation = input.request.operation;
  if (operation.kind === "GET_MANIFEST") response = await input.reader.getManifest(input.request.boundary, signal);
  else if (operation.kind === "LIST_OBJECTS") response = await input.reader.listManifestObjects({ boundary: input.request.boundary,
    manifestSha256: operation.manifestSha256, pageSize: operation.pageSize, token: operation.token }, signal);
  else response = await input.reader.readObjectRows({ boundary: input.request.boundary,
    manifestSha256: operation.manifestSha256, pageSize: operation.pageSize, token: operation.token,
    object: operation.object }, signal);
  validateResponse(input.request, response); return Object.freeze(response);
}
