/** Credential-side, exact-contract reader for ADD-06 official CCA Parquet exports. */
import { createHash } from "node:crypto";
import type { AwsTemporaryCredentials } from "./types.js";

export const KUBECOST_PROVIDER_ACTIONS = Object.freeze([
  "s3:GetBucketLocation",
  "s3:ListBucket",
  "s3:GetObject",
  "s3:GetObjectVersion",
] as const);
export const KUBECOST_PROVIDER_CONDITIONAL_KMS_ACTIONS = Object.freeze(["kms:Decrypt"] as const);
export const KUBECOST_PROVIDER_BOUNDS = Object.freeze({
  maximumPages: 1_000,
  maximumObjects: 20_000,
  maximumRows: 750_000,
  maximumObjectBytes: 5 * 1_024 * 1_024 * 1_024,
  maximumCaptureBytes: 128 * 1_024 * 1_024,
  maximumDurationMs: 5 * 60 * 1_000,
} as const);
export const KUBECOST_RUNTIME_REQUEST_BOUNDS = Object.freeze({
  maximumCaptureBytes: 128 * 1_024 * 1_024,
  maximumOutputBytes: 24 * 1_024 * 1_024,
  maximumRows: 750_000,
  maximumObjects: 20_000,
  maximumObjectBytes: 5 * 1_024 * 1_024 * 1_024,
  maximumAccounts: 10_000,
  maximumClusters: 5_000,
  maximumGroups: 250_000,
  maximumSourceRowsPerGroup: 50,
  maximumCaptureDurationMs: 30 * 60 * 1_000,
  freshnessSlaHours: 24,
} as const);

/** Exact physical columns in the pinned CID manifest's one SPICE dataset. */
export const KUBECOST_CCA_DATASET_COLUMNS = Object.freeze([
  "name", "window.start", "window.end", "minutes", "cpucores", "cpucorerequestaverage",
  "cpucoreusageaverage", "cpucorehours", "cpucost", "cpucostadjustment", "cpuefficiency",
  "gpucount", "gpuhours", "gpucost", "gpucostadjustment", "networktransferbytes",
  "networkreceivebytes", "networkcost", "networkcrosszonecost", "networkcrossregioncost",
  "networkinternetcost", "networkcostadjustment", "loadbalancercost",
  "loadbalancercostadjustment", "pvbytes", "pvbytehours", "pvcost", "pvcostadjustment",
  "rambytes", "rambyterequestaverage", "rambyteusageaverage", "rambytehours", "ramcost",
  "ramcostadjustment", "ramefficiency", "sharedcost", "externalcost", "totalcost",
  "totalefficiency", "properties.provider", "properties.region", "properties.cluster",
  "properties.clusterid", "properties.eksclustername", "properties.container",
  "properties.namespace", "properties.pod", "properties.node", "properties.node_instance_type",
  "properties.node_availability_zone", "properties.node_capacity_type",
  "properties.node_architecture", "properties.node_os", "properties.node_nodegroup",
  "properties.node_nodegroup_image", "properties.controller", "properties.controllerkind",
  "properties.providerid", "account_id", "region", "year", "month",
] as const);

export const KUBECOST_OFFICIAL_SOURCE = Object.freeze({
  commit: "8a581332a70ae55d53464e52a0bb8b3dd64cb425",
  manifestSha256: "2bde67113c8f585d13fc43fe537c3bee3eecf3a416b81cd0f57295226b4ed45b",
  datasetSha256: "3cd36937146500be79d7cfe3f6fa78012f999378dd9729ec17a300888c7962a6",
  athenaViewQuerySha256: "2a5db62703b857a19d56a50661e5a20be4d02776aad3d1065422c7bab8b2e07c",
  exporterSha256: "48f44e9147ed57fa2252a6867473fac82fd362b612fe59041b8dc9f4df81fdf3",
  inputColumnCount: 62,
  format: "SNAPPY_PARQUET",
  step: "1d",
} as const);

type Partition = "aws" | "aws-us-gov" | "aws-cn";
type Provider = "KUBECOST" | "OPENCOST";
interface Scope {
  readonly orgId: string; readonly customerId: string; readonly connectionId: string;
  readonly partition: Partition; readonly billingPeriod: string; readonly activeCur2GenerationId: string;
  readonly awsAccountIds: readonly string[]; readonly clusterIds: readonly string[];
}
interface Destination {
  readonly bucket: string; readonly prefix: string; readonly expectedBucketOwner: string;
  readonly requireObjectVersionIds: true; readonly kmsKeyArn: string | null;
}
interface Cur2Evidence {
  readonly source: "AWS_CUR2_ACTIVE_GENERATION"; readonly generationState: "ACTIVE";
  readonly generationId: string; readonly manifestSha256: string; readonly billingPeriod: string;
  readonly dataThroughAtIso: string; readonly payerAccountIds: readonly string[];
  readonly usageAccountIds: readonly string[]; readonly clusterIds: readonly string[];
  readonly scopeBasis: "KUBERNETES_CLUSTER_TAGGED_COST" | "SCAD_KUBERNETES_COST";
  readonly rowsExhausted: boolean; readonly totals: readonly { readonly currency: string; readonly amountMicros: string }[];
}
export interface KubecostProviderRequest {
  readonly schemaVersion: "sutra.kubecost-versioned-runtime-request.v1";
  readonly requestId: string; readonly jobId: string; readonly scheduledWindow: string;
  readonly scope: Scope; readonly destination: Destination; readonly activeCur2: Cur2Evidence;
  readonly activeCur2Sha256: string;
  readonly exportContract: Readonly<Record<string, unknown>>;
  readonly runtimeReadActions: readonly string[]; readonly versionedReadActions: readonly string[];
  readonly conditionalKmsActions: readonly string[]; readonly exporterWriteActions: readonly never[];
  readonly bounds: Readonly<Record<string, unknown>>; readonly maximumDurationMs: number;
}
export interface KubecostProviderBinding {
  readonly schemaVersion: "sutra.kubecost-provider-binding.v1";
  readonly orgId: string; readonly customerId: string; readonly connectionId: string;
  readonly permissionPackVersion: "standard-2026-08.9" | "standard-2026-08.10" |
    "standard-2026-08.11" | "standard-2026-08.12" | "standard-2026-08.13" | "standard-2026-08.14";
  readonly provider: Provider; readonly exporterName: string; readonly exporterVersion: string;
  readonly costModelSha256: string; readonly currency: string;
  readonly bucketRegion: string;
  readonly destination: Destination;
}
export interface KubecostListedObject {
  readonly key: string; readonly eTag: string; readonly sizeBytes: number; readonly lastModifiedIso: string;
}
export interface KubecostDecodedParquetObject extends KubecostListedObject {
  readonly versionId: string; readonly contentSha256: string;
  readonly columns: readonly string[]; readonly rows: readonly Readonly<Record<string, unknown>>[];
}
export interface KubecostProviderReader {
  getBucketLocation(input: { readonly bucket: string; readonly expectedBucketOwner: string }, signal: AbortSignal): Promise<string>;
  listObjects(input: { readonly bucket: string; readonly prefix: string; readonly expectedBucketOwner: string; readonly continuationToken: string | null }, signal: AbortSignal): Promise<{ readonly objects: readonly KubecostListedObject[]; readonly nextContinuationToken: string | null }>;
  /** The concrete S3 reader must pass VersionId to GetObject and decode Snappy Parquet locally. */
  readVersionedParquet(input: { readonly bucket: string; readonly key: string; readonly expectedBucketOwner: string; readonly maximumBytes: number }, signal: AbortSignal): Promise<KubecostDecodedParquetObject>;
}

export class KubecostProviderAdapterError extends Error {
  public constructor(public readonly code: "INVALID_REQUEST" | "PROVIDER_RESPONSE_INVALID" | "BOUND_REACHED" | "ABORTED") {
    super("Kubecost versioned export provider collection did not complete");
    this.name = "KubecostProviderAdapterError";
  }
}
const reject = (code: KubecostProviderAdapterError["code"]): never => { throw new KubecostProviderAdapterError(code); };
const SHA = /^[a-f0-9]{64}$/u; const ACCOUNT = /^\d{12}$/u; const SAFE = /^[^\u0000-\u001f\u007f<>]{1,1024}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u; const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const BUCKET = /^(?!\d+\.\d+\.\d+\.\d+$)(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const OBJECT_KEY = /(?:^|\/)account_id=(\d{12})\/region=([a-z0-9-]+)\/year=(\d{4})\/month=(0[1-9]|1[0-2])\/\d{4}-\d{2}-\d{2}_[A-Za-z0-9._-]+\.snappy\.parquet$/u;
const DECIMAL = /^-?(?:0|[1-9]\d{0,30})(?:\.\d{1,18})?$/u;
function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()); }
function string(value: unknown, nullable = false): string | null { if ((value === null || value === "") && nullable) return null; if (typeof value !== "string" || !SAFE.test(value)) reject("PROVIDER_RESPONSE_INVALID"); return value as string; }
function iso(value: unknown): string { const ms = typeof value === "string" ? Date.parse(value) : value instanceof Date ? value.getTime() : Number.NaN; if (!Number.isFinite(ms)) reject("PROVIDER_RESPONSE_INVALID"); return new Date(ms).toISOString(); }
function decimal(value: unknown): string { const result = typeof value === "number" ? String(value) : typeof value === "bigint" ? value.toString() : String(value); if (!DECIMAL.test(result)) reject("PROVIDER_RESPONSE_INVALID"); return result; }
interface Rational { n: bigint; d: bigint }
function rational(value: unknown): Rational { const text = decimal(value); const negative = text.startsWith("-"); const unsigned = negative ? text.slice(1) : text; const [whole = "0", fraction = ""] = unsigned.split("."); return { n: BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n), d: 10n ** BigInt(fraction.length) }; }
function gcd(a: bigint, b: bigint): bigint { let x = a < 0n ? -a : a; let y = b < 0n ? -b : b; while (y !== 0n) [x, y] = [y, x % y]; return x === 0n ? 1n : x; }
function render(value: Rational): string { const factor = gcd(value.n, value.d); const n = value.n / factor; const d = value.d / factor; if (d === 1n) return n.toString(); let scale = 1n; let digits = 0; while (scale % d !== 0n && digits <= 18) { scale *= 10n; digits += 1; } if (scale % d !== 0n) reject("PROVIDER_RESPONSE_INVALID"); const scaled = n * (scale / d); const negative = scaled < 0n; const absolute = negative ? -scaled : scaled; const base = 10n ** BigInt(digits); const fraction = (absolute % base).toString().padStart(digits, "0").replace(/0+$/u, ""); return `${negative ? "-" : ""}${absolute / base}${fraction === "" ? "" : `.${fraction}`}`; }
function add(...values: unknown[]): string { const result = values.map(rational).reduce((sum, value) => ({ n: sum.n * value.d + value.n * sum.d, d: sum.d * value.d }), { n: 0n, d: 1n }); return render(result); }
function hours(value: unknown, minutes: unknown): string { const amount = rational(value); const duration = rational(minutes); return render({ n: amount.n * duration.n, d: amount.d * duration.d * 60n }); }
function rowKind(name: string): "WORKLOAD" | "IDLE" | "SHARED" | "EXTERNAL" | "UNALLOCATED" | "UNMOUNTED" { if (/unmounted/iu.test(name)) return "UNMOUNTED"; if (/unallocated/iu.test(name)) return "UNALLOCATED"; if (/idle/iu.test(name)) return "IDLE"; if (/^__?shared/iu.test(name)) return "SHARED"; if (/^__?external/iu.test(name)) return "EXTERNAL"; return "WORKLOAD"; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (typeof value === "object" && value !== null) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); }
function regionInPartition(region: string, partition: Partition): boolean { return partition === "aws-cn" ? /^cn-[a-z]+-\d$/u.test(region) : partition === "aws-us-gov" ? /^us-gov-[a-z]+-\d$/u.test(region) : /^(?!cn-|us-gov-)[a-z]{2}-[a-z]+-\d$/u.test(region); }
function mapRow(raw: Readonly<Record<string, unknown>>, objectId: string, ordinal: number, currency: string) {
  if (!exactKeys(raw, KUBECOST_CCA_DATASET_COLUMNS)) reject("PROVIDER_RESPONSE_INVALID");
  const name = string(raw.name)!; const start = iso(raw["window.start"]); const end = iso(raw["window.end"]);
  const component = {
    cpuCost: add(raw.cpucost, raw.cpucostadjustment), ramCost: add(raw.ramcost, raw.ramcostadjustment),
    gpuCost: add(raw.gpucost, raw.gpucostadjustment), networkCost: add(raw.networkcost, raw.networkcostadjustment),
    pvCost: add(raw.pvcost, raw.pvcostadjustment), loadBalancerCost: add(raw.loadbalancercost, raw.loadbalancercostadjustment),
    sharedCost: decimal(raw.sharedcost), externalCost: decimal(raw.externalcost),
  };
  const componentTotal = add(...Object.values(component)); const declaredTotal = decimal(raw.totalcost);
  if (rational(componentTotal).n * rational(declaredTotal).d !== rational(declaredTotal).n * rational(componentTotal).d) reject("PROVIDER_RESPONSE_INVALID");
  const sourceRowSha256 = digest(canonical(raw));
  return Object.freeze({
    sourceRowId: `krow_${sourceRowSha256}`, sourceObjectId: objectId, sourceRowNumber: ordinal,
    sourceRowSha256, windowStartIso: start, windowEndIso: end, usageAccountId: string(raw.account_id)!,
    region: string(raw["properties.region"], true) ?? string(raw.region, true),
    clusterId: string(raw["properties.clusterid"])!, namespace: string(raw["properties.namespace"], true),
    controllerKind: string(raw["properties.controllerkind"], true), controller: string(raw["properties.controller"], true),
    workload: name, pod: string(raw["properties.pod"], true), container: string(raw["properties.container"], true),
    node: string(raw["properties.node"], true), nodeInstanceType: string(raw["properties.node_instance_type"], true),
    nodeAvailabilityZone: string(raw["properties.node_availability_zone"], true), nodeCapacityType: string(raw["properties.node_capacity_type"], true),
    nodeArchitecture: string(raw["properties.node_architecture"], true), nodeOs: string(raw["properties.node_os"], true),
    nodeGroup: string(raw["properties.node_nodegroup"], true), nodeGroupImage: string(raw["properties.node_nodegroup_image"], true),
    allocationKind: rowKind(name), currency, costs: { ...component, totalCost: declaredTotal },
    metrics: {
      cpuCoreRequestHours: hours(raw.cpucorerequestaverage, raw.minutes), cpuCoreUsageHours: hours(raw.cpucoreusageaverage, raw.minutes),
      ramByteRequestHours: hours(raw.rambyterequestaverage, raw.minutes), ramByteUsageHours: hours(raw.rambyteusageaverage, raw.minutes),
      gpuRequestHours: hours(raw.gpucount, raw.minutes), gpuUsageHours: null,
      networkTransferBytes: decimal(raw.networktransferbytes), networkReceiveBytes: decimal(raw.networkreceivebytes), networkCapacityBytes: null,
      pvProvisionedByteHours: decimal(raw.pvbytehours), pvUsedByteHours: null,
    },
  });
}
export function validateKubecostProviderRequest(request: KubecostProviderRequest, binding: KubecostProviderBinding): void {
  const expectedContract = request.exportContract as { readonly schemaVersion?: unknown; readonly officialAwsCca?: { readonly sourceCommit?: unknown; readonly inputColumnCount?: unknown; readonly format?: unknown }; readonly query?: { readonly step?: unknown } };
  if (request.schemaVersion !== "sutra.kubecost-versioned-runtime-request.v1" || !/^kur_[a-f0-9]{64}$/u.test(request.requestId)
    || !/^job_[a-f0-9]{32}$/u.test(request.jobId) || request.maximumDurationMs !== KUBECOST_PROVIDER_BOUNDS.maximumDurationMs
    || JSON.stringify(request.runtimeReadActions) !== JSON.stringify(KUBECOST_PROVIDER_ACTIONS.slice(0, 3))
    || JSON.stringify(request.versionedReadActions) !== JSON.stringify(["s3:GetObjectVersion"])
    || JSON.stringify(request.conditionalKmsActions) !== JSON.stringify(KUBECOST_PROVIDER_CONDITIONAL_KMS_ACTIONS)
    || request.exporterWriteActions.length !== 0 || request.destination.requireObjectVersionIds !== true
    || JSON.stringify(request.bounds) !== JSON.stringify(KUBECOST_RUNTIME_REQUEST_BOUNDS)
    || !/^\d{4}-\d{2}-\d{2}T(?:00|06|12|18):00:00\.000Z$/u.test(request.scheduledWindow)
    || !IDENTIFIER.test(request.scope.orgId) || !IDENTIFIER.test(request.scope.customerId) || !CONNECTION.test(request.scope.connectionId)
    || !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(request.scope.billingPeriod)
    || request.scope.awsAccountIds.length < 1 || request.scope.awsAccountIds.length > KUBECOST_RUNTIME_REQUEST_BOUNDS.maximumAccounts
    || request.scope.awsAccountIds.some((item) => !ACCOUNT.test(item)) || new Set(request.scope.awsAccountIds).size !== request.scope.awsAccountIds.length
    || JSON.stringify(request.scope.awsAccountIds) !== JSON.stringify([...request.scope.awsAccountIds].sort())
    || request.scope.clusterIds.length < 1 || request.scope.clusterIds.length > KUBECOST_RUNTIME_REQUEST_BOUNDS.maximumClusters
    || request.scope.clusterIds.some((item) => !SAFE.test(item)) || new Set(request.scope.clusterIds).size !== request.scope.clusterIds.length
    || JSON.stringify(request.scope.clusterIds) !== JSON.stringify([...request.scope.clusterIds].sort())
    || !BUCKET.test(request.destination.bucket) || !request.destination.prefix.endsWith("/")
    || request.destination.prefix.includes("..") || !SAFE.test(request.destination.prefix)
    || request.activeCur2Sha256 !== digest(JSON.stringify(request.activeCur2))
    || request.activeCur2.source !== "AWS_CUR2_ACTIVE_GENERATION" || request.activeCur2.generationState !== "ACTIVE"
    || request.activeCur2.generationId !== request.scope.activeCur2GenerationId || request.activeCur2.billingPeriod !== request.scope.billingPeriod
    || JSON.stringify(request.activeCur2.usageAccountIds) !== JSON.stringify(request.scope.awsAccountIds)
    || JSON.stringify(request.activeCur2.clusterIds) !== JSON.stringify(request.scope.clusterIds) || request.activeCur2.rowsExhausted !== true
    || expectedContract.schemaVersion !== "2.0.0" || expectedContract.officialAwsCca?.sourceCommit !== KUBECOST_OFFICIAL_SOURCE.commit
    || expectedContract.officialAwsCca.inputColumnCount !== 62 || expectedContract.officialAwsCca.format !== "SNAPPY_PARQUET"
    || expectedContract.query?.step !== "1d" || request.activeCur2.totals.length !== 1
    || binding.schemaVersion !== "sutra.kubecost-provider-binding.v1"
    || !new Set(["standard-2026-08.9", "standard-2026-08.10", "standard-2026-08.11", "standard-2026-08.12", "standard-2026-08.13", "standard-2026-08.14"]).has(binding.permissionPackVersion)
    || !new Set(["KUBECOST", "OPENCOST"]).has(binding.provider)
    || !SAFE.test(binding.exporterName) || !SAFE.test(binding.exporterVersion) || !/^[A-Z]{3}$/u.test(binding.currency)
    || binding.orgId !== request.scope.orgId || binding.customerId !== request.scope.customerId || binding.connectionId !== request.scope.connectionId
    || JSON.stringify(binding.destination) !== JSON.stringify(request.destination) || binding.currency !== request.activeCur2.totals[0]?.currency
    || !SHA.test(binding.costModelSha256) || !ACCOUNT.test(request.destination.expectedBucketOwner)
    || !regionInPartition(binding.bucketRegion, request.scope.partition)) reject("INVALID_REQUEST");
}

export async function collectKubecostVersionedExport(input: {
  readonly request: KubecostProviderRequest; readonly binding: KubecostProviderBinding;
  readonly credentials: AwsTemporaryCredentials; readonly reader: KubecostProviderReader;
  readonly signal: AbortSignal; readonly now?: () => number;
}) {
  validateKubecostProviderRequest(input.request, input.binding); if (input.signal.aborted) reject("ABORTED");
  const now = input.now ?? Date.now; const started = now(); const deadline = started + KUBECOST_PROVIDER_BOUNDS.maximumDurationMs;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(KUBECOST_PROVIDER_BOUNDS.maximumDurationMs)]);
  const location = await input.reader.getBucketLocation({ bucket: input.request.destination.bucket, expectedBucketOwner: input.request.destination.expectedBucketOwner }, signal);
  if (location !== input.binding.bucketRegion) reject("PROVIDER_RESPONSE_INVALID");
  const listed: KubecostListedObject[] = []; const tokens = new Set<string>(); let token: string | null = null; let pages = 0;
  do {
    if (signal.aborted) reject("ABORTED"); if (++pages > KUBECOST_PROVIDER_BOUNDS.maximumPages) reject("BOUND_REACHED");
    const page = await input.reader.listObjects({ bucket: input.request.destination.bucket, prefix: input.request.destination.prefix, expectedBucketOwner: input.request.destination.expectedBucketOwner, continuationToken: token }, signal);
    if (!Array.isArray(page.objects) || listed.length + page.objects.length > KUBECOST_PROVIDER_BOUNDS.maximumObjects) reject("BOUND_REACHED");
    listed.push(...page.objects); token = page.nextContinuationToken;
    if (token !== null) { if (!SAFE.test(token) || tokens.has(token)) reject("PROVIDER_RESPONSE_INVALID"); tokens.add(token); }
  } while (token !== null);
  if (JSON.stringify(listed.map((item) => item.key)) !== JSON.stringify([...listed].map((item) => item.key).sort())) reject("PROVIDER_RESPONSE_INVALID");
  const objects: Array<{ readonly objectId: string; readonly bucket: string; readonly key: string; readonly eTag: string; readonly versionId: string; readonly sha256: string; readonly sizeBytes: number }> = [];
  const rows: Array<ReturnType<typeof mapRow>> = []; const capturedClusters = new Set<string>(); let totalBytes = 0;
  for (const item of listed) {
    const match = OBJECT_KEY.exec(item.key); if (!match || !item.key.startsWith(input.request.destination.prefix)
      || match[1] === undefined || !input.request.scope.awsAccountIds.includes(match[1])
      || `${match[3]}-${match[4]}` !== input.request.scope.billingPeriod || !SAFE.test(item.eTag)
      || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0 || item.sizeBytes > KUBECOST_PROVIDER_BOUNDS.maximumObjectBytes
      || iso(item.lastModifiedIso) !== item.lastModifiedIso) reject("PROVIDER_RESPONSE_INVALID");
    if (totalBytes + item.sizeBytes > KUBECOST_PROVIDER_BOUNDS.maximumCaptureBytes) reject("BOUND_REACHED");
    const decoded = await input.reader.readVersionedParquet({ bucket: input.request.destination.bucket, key: item.key, expectedBucketOwner: input.request.destination.expectedBucketOwner, maximumBytes: item.sizeBytes }, signal);
    if (decoded.key !== item.key || decoded.eTag !== item.eTag || decoded.sizeBytes !== item.sizeBytes || !SAFE.test(decoded.versionId)
      || !SHA.test(decoded.contentSha256) || JSON.stringify(decoded.columns) !== JSON.stringify(KUBECOST_CCA_DATASET_COLUMNS)) reject("PROVIDER_RESPONSE_INVALID");
    totalBytes += decoded.sizeBytes; if (totalBytes > KUBECOST_PROVIDER_BOUNDS.maximumCaptureBytes || rows.length + decoded.rows.length > KUBECOST_PROVIDER_BOUNDS.maximumRows) reject("BOUND_REACHED");
    const objectId = `kobj_${digest(`${decoded.key}\u0000${decoded.versionId}\u0000${decoded.contentSha256}`)}`;
    objects.push(Object.freeze({ objectId, bucket: input.request.destination.bucket, key: decoded.key, eTag: decoded.eTag, versionId: decoded.versionId, sha256: decoded.contentSha256, sizeBytes: decoded.sizeBytes }));
    decoded.rows.forEach((raw, index) => { const row = mapRow(raw, objectId, index + 1, input.binding.currency); if (!input.request.scope.awsAccountIds.includes(row.usageAccountId) || !input.request.scope.clusterIds.includes(row.clusterId)) reject("PROVIDER_RESPONSE_INVALID"); capturedClusters.add(row.clusterId); rows.push(row); });
  }
  const completed = now(); if (!Number.isSafeInteger(started) || !Number.isSafeInteger(completed) || completed < started || completed > deadline) reject("ABORTED");
  const period = input.request.scope.billingPeriod.split("-"); const year = Number(period[0]); const month = Number(period[1]);
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month)) reject("INVALID_REQUEST");
  const windowStartIso = new Date(Date.UTC(year, month - 1, 1)).toISOString(); const windowEndIso = new Date(Date.UTC(year, month, 1)).toISOString();
  const manifestSha256 = digest(canonical(objects.map((item) => ({ key: item.key, versionId: item.versionId, sha256: item.sha256 }))));
  const captureBase = {
    schemaVersion: "sutra.kubecost-allocation.capture.v1" as const, scope: input.request.scope,
    startedAtIso: new Date(started).toISOString(), completedAtIso: new Date(completed).toISOString(), generatedAtIso: new Date(completed).toISOString(),
    dataThroughAtIso: input.request.activeCur2.dataThroughAtIso,
    destination: { bucket: input.request.destination.bucket, prefix: input.request.destination.prefix },
    export: { provider: input.binding.provider, exporterName: input.binding.exporterName, exporterVersion: input.binding.exporterVersion,
      schemaName: "sutra.kubecost-opencost-allocation" as const, schemaVersion: "2.0.0" as const,
      schemaSha256: KUBECOST_OFFICIAL_SOURCE.datasetSha256, manifestSha256,
      querySha256: KUBECOST_OFFICIAL_SOURCE.athenaViewQuerySha256, costModelSha256: input.binding.costModelSha256,
      format: "PARQUET" as const, costBasis: "CLOUD_BILL_RECONCILED" as const,
      query: { windowStartIso, windowEndIso, step: "1d" as const, accumulate: false as const, rawAllocationLineage: true as const,
        shareIdle: false as const, splitIdle: true as const, includeSharedCostBreakdown: true as const, external: true as const, cloudBillReconciliationEnabled: true as const } },
    coverage: { configured: true, deliveryObserved: objects.length > 0, runtimeS3PermissionsValidated: true,
      status: "SUCCEEDED" as const, expectedObjectCount: listed.length, processedObjectCount: objects.length, failedObjectCount: 0,
      expectedClusterIds: input.request.scope.clusterIds, capturedClusterIds: [...capturedClusters].sort(), rowsExhausted: true, errorCode: null },
    objects, rows, cur2Evidence: input.request.activeCur2, reconciliationToleranceMicros: "0",
  };
  if (Buffer.byteLength(JSON.stringify(captureBase), "utf8") > KUBECOST_PROVIDER_BOUNDS.maximumCaptureBytes) reject("BOUND_REACHED");
  return Object.freeze({ ...captureBase, captureId: `kubecost_${digest(canonical(captureBase))}` });
}
