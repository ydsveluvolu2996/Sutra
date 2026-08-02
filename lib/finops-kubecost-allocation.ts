/**
 * Evidence-honest Kubecost/OpenCost container allocation normalization.
 *
 * This module is deliberately pure. A separate exporter queries Kubecost or
 * OpenCost, writes a versioned manifest and data objects, and a credential-owning
 * collector reads only the tenant-pinned S3 prefix. The engine never owns cloud
 * credentials, fetches objects, writes exports, or mutates Kubernetes resources.
 *
 * Monetary values and utilization quantities are parsed as exact rationals.
 * Currencies and metric units are never combined. Kubecost allocation is an
 * attribution view over authoritative CUR2 spend: its totals are reconciled to
 * one immutable ACTIVE CUR2 generation and must never be added to that spend.
 */
import type {
  FinopsSourceEvidence,
  FinopsSourceScope,
} from "./finops-source-health.ts";
import { FINOPS_RECONCILIATION_CURRENCIES } from "./finops-reconciliation.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const CLUSTER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,255}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d$/u;
const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const CAPTURE_ID = /^kubecost_[a-f0-9]{64}$/u;
const GENERATION_ID = /^fbg_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f<>]{1,1024}$/u;
const S3_BUCKET = /^(?!\d+\.\d+\.\d+\.\d+$)(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const DECIMAL = /^-?(?:0|[1-9]\d{0,30})(?:\.\d{1,18})?$/u;
const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9]\d{0,30})(?:\.\d{1,18})?$/u;
const INTEGER_MICROS = /^-?(?:0|[1-9]\d{0,60})$/u;
const NON_NEGATIVE_INTEGER = /^(?:0|[1-9]\d{0,60})$/u;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,95}$/u;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export const KUBECOST_ALLOCATION_BOUNDS = Object.freeze({
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

/**
 * Baseline permanent collector permissions for a current-object export. The
 * bucket ARN must be prefix-constrained for ListBucket and the object ARN must
 * be constrained to the one tenant/export prefix. No write action is allowed.
 */
export const KUBECOST_RUNTIME_S3_READ_IAM_ACTIONS = Object.freeze([
  "s3:GetBucketLocation",
  "s3:ListBucket",
  "s3:GetObject",
] as const);

/** Required instead of GetObject when the collector requests a pinned versionId. */
export const KUBECOST_VERSIONED_OBJECT_READ_IAM_ACTIONS = Object.freeze([
  "s3:GetObjectVersion",
] as const);

/** Conditional, and restricted to the exact CMK, when the prefix uses SSE-KMS. */
export const KUBECOST_SSE_KMS_READ_IAM_ACTIONS = Object.freeze([
  "kms:Decrypt",
] as const);

/** Separate exporter identity only; these actions never belong to the collector. */
export const KUBECOST_EXPORTER_S3_WRITE_IAM_ACTIONS = Object.freeze([
  "s3:PutObject",
] as const);

export const KUBECOST_EXPORT_CONTRACT = Object.freeze({
  schemaName: "sutra.kubecost-opencost-allocation",
  schemaVersion: "2.0.0",
  officialAwsCca: Object.freeze({
    sourceCommit: "8a581332a70ae55d53464e52a0bb8b3dd64cb425",
    cidManifestSha256: "2bde67113c8f585d13fc43fe537c3bee3eecf3a416b81cd0f57295226b4ed45b",
    datasetSha256: "3cd36937146500be79d7cfe3f6fa78012f999378dd9729ec17a300888c7962a6",
    athenaViewQuerySha256: "2a5db62703b857a19d56a50661e5a20be4d02776aad3d1065422c7bab8b2e07c",
    exporterSha256: "48f44e9147ed57fa2252a6867473fac82fd362b612fe59041b8dc9f4df81fdf3",
    format: "SNAPPY_PARQUET",
    inputColumnCount: 62,
  }),
  query: Object.freeze({
    window: "EXPLICIT_UTC_RFC3339_PAIR",
    step: "1d",
    accumulate: false,
    rawAllocationLineage: true,
    shareIdle: false,
    splitIdle: true,
    includeSharedCostBreakdown: true,
    external: true,
  }),
  references: Object.freeze([
    "https://www.ibm.com/docs/en/kubecost/self-hosted/3.x?topic=apis-allocation-api",
    "https://opencost.dev/docs/",
    "https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html",
  ]),
} as const);

export type KubecostProvider = "KUBECOST" | "OPENCOST";
export type KubecostAllocationKind =
  | "WORKLOAD"
  | "IDLE"
  | "SHARED"
  | "EXTERNAL"
  | "UNALLOCATED"
  | "UNMOUNTED";
export type KubecostSnapshotState =
  | "CONFIGURATION_REQUIRED"
  | "WAITING_FIRST_DELIVERY"
  | "UNKNOWN"
  | "ERROR"
  | "EMPTY"
  | "PARTIAL"
  | "STALE"
  | "READY";
export type KubecostSourceStatus = "SUCCEEDED" | "PARTIAL" | "FAILED" | "UNKNOWN";
export type KubecostCostBasis =
  | "KUBECOST_ESTIMATE"
  | "OPENCOST_ESTIMATE"
  | "CLOUD_BILL_RECONCILED"
  | "CUSTOM_PRICE_SHEET";
export type KubecostEconomicCategory =
  | "WORKLOAD_ALLOCATION"
  | "IDLE"
  | "SHARED"
  | "EXTERNAL"
  | "UNALLOCATED"
  | "UNMOUNTED";
export type KubecostMetric = "CPU" | "RAM" | "GPU" | "NETWORK" | "PV";
export type KubecostCostComponent = KubecostMetric | "LOAD_BALANCER" | "SHARED" | "EXTERNAL";

export interface KubecostAllocationScope extends FinopsSourceScope {
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly billingPeriod: string;
  readonly activeCur2GenerationId: string;
  readonly awsAccountIds: readonly string[];
  readonly clusterIds: readonly string[];
}

export interface KubecostExportObjectEvidence {
  readonly objectId: string;
  readonly bucket: string;
  readonly key: string;
  readonly eTag: string;
  readonly versionId: string | null;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface KubecostExportMetadata {
  readonly provider: KubecostProvider;
  readonly exporterName: string;
  readonly exporterVersion: string;
  readonly schemaName: typeof KUBECOST_EXPORT_CONTRACT.schemaName;
  readonly schemaVersion: typeof KUBECOST_EXPORT_CONTRACT.schemaVersion;
  readonly schemaSha256: string;
  readonly manifestSha256: string;
  readonly querySha256: string;
  readonly costModelSha256: string;
  readonly format: "NDJSON" | "CSV" | "PARQUET";
  readonly costBasis: KubecostCostBasis;
  readonly query: {
    readonly windowStartIso: string;
    readonly windowEndIso: string;
    readonly step: "1d";
    readonly accumulate: false;
    readonly rawAllocationLineage: true;
    readonly shareIdle: false;
    readonly splitIdle: true;
    readonly includeSharedCostBreakdown: true;
    readonly external: true;
    readonly cloudBillReconciliationEnabled: boolean;
  };
}

export interface KubecostCollectionCoverage {
  readonly configured: boolean;
  readonly deliveryObserved: boolean;
  readonly runtimeS3PermissionsValidated: boolean;
  readonly status: KubecostSourceStatus;
  readonly expectedObjectCount: number;
  readonly processedObjectCount: number;
  readonly failedObjectCount: number;
  readonly expectedClusterIds: readonly string[];
  readonly capturedClusterIds: readonly string[];
  readonly rowsExhausted: boolean;
  readonly errorCode: string | null;
}

export interface KubecostAllocationCosts {
  readonly cpuCost: string;
  readonly ramCost: string;
  readonly gpuCost: string;
  readonly networkCost: string;
  readonly pvCost: string;
  readonly loadBalancerCost: string;
  readonly sharedCost: string;
  readonly externalCost: string;
  /** Exact source total; must equal every listed cost component. */
  readonly totalCost: string;
}

export interface KubecostAllocationMetrics {
  readonly cpuCoreRequestHours: string | null;
  readonly cpuCoreUsageHours: string | null;
  readonly ramByteRequestHours: string | null;
  readonly ramByteUsageHours: string | null;
  readonly gpuRequestHours: string | null;
  readonly gpuUsageHours: string | null;
  readonly networkTransferBytes: string | null;
  readonly networkReceiveBytes: string | null;
  /** Optional exporter enrichment; Kubecost's standard allocation API does not publish this. */
  readonly networkCapacityBytes: string | null;
  readonly pvProvisionedByteHours: string | null;
  readonly pvUsedByteHours: string | null;
}

export interface KubecostAllocationRow {
  readonly sourceRowId: string;
  readonly sourceObjectId: string;
  readonly sourceRowNumber: number;
  readonly sourceRowSha256: string;
  readonly windowStartIso: string;
  readonly windowEndIso: string;
  readonly usageAccountId: string;
  readonly region: string | null;
  readonly clusterId: string;
  readonly namespace: string | null;
  readonly controllerKind: string | null;
  readonly controller: string | null;
  readonly workload: string | null;
  readonly pod: string | null;
  readonly container: string | null;
  readonly node: string | null;
  readonly nodeInstanceType: string | null;
  readonly nodeAvailabilityZone: string | null;
  readonly nodeCapacityType: string | null;
  readonly nodeArchitecture: string | null;
  readonly nodeOs: string | null;
  readonly nodeGroup: string | null;
  readonly nodeGroupImage: string | null;
  readonly allocationKind: KubecostAllocationKind;
  readonly currency: string;
  readonly costs: KubecostAllocationCosts;
  readonly metrics: KubecostAllocationMetrics;
}

export interface KubecostCur2CurrencyTotal {
  readonly currency: string;
  /** Exact signed integer micro-units from the active CUR2 generation. */
  readonly amountMicros: string;
}

export interface KubecostCur2Evidence {
  readonly source: "AWS_CUR2_ACTIVE_GENERATION";
  readonly generationState: "ACTIVE";
  readonly generationId: string;
  readonly manifestSha256: string;
  readonly billingPeriod: string;
  readonly dataThroughAtIso: string;
  readonly payerAccountIds: readonly string[];
  readonly usageAccountIds: readonly string[];
  readonly clusterIds: readonly string[];
  readonly scopeBasis: "KUBERNETES_CLUSTER_TAGGED_COST" | "SCAD_KUBERNETES_COST";
  readonly rowsExhausted: boolean;
  readonly totals: readonly KubecostCur2CurrencyTotal[];
}

export interface KubecostAllocationCapture {
  readonly schemaVersion: "sutra.kubecost-allocation.capture.v1";
  readonly scope: KubecostAllocationScope;
  readonly captureId: string;
  readonly startedAtIso: string;
  readonly completedAtIso: string;
  readonly generatedAtIso: string;
  readonly dataThroughAtIso: string;
  readonly destination: {
    readonly bucket: string;
    /** Exact tenant/export prefix, always ending in `/`. */
    readonly prefix: string;
  };
  readonly export: KubecostExportMetadata;
  readonly coverage: KubecostCollectionCoverage;
  readonly objects: readonly KubecostExportObjectEvidence[];
  readonly rows: readonly KubecostAllocationRow[];
  readonly cur2Evidence: KubecostCur2Evidence | null;
  /** Exact non-negative integer micro-unit tolerance, default zero. */
  readonly reconciliationToleranceMicros?: string;
}

export interface KubecostExactDecimal {
  readonly numerator: string;
  readonly denominator: string;
}

export interface KubecostCategoryTotal {
  readonly category: KubecostEconomicCategory;
  readonly currency: string;
  readonly exact: KubecostExactDecimal;
  readonly rowCount: number;
}

export interface KubecostEfficiency {
  readonly metric: KubecostMetric;
  readonly unit: "core-hours" | "byte-hours" | "gpu-hours" | "bytes";
  readonly requestedOrProvisioned: KubecostExactDecimal | null;
  readonly used: KubecostExactDecimal | null;
  readonly ratio: KubecostExactDecimal | null;
  readonly state: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
  readonly evidenceBasis: "EXPLICIT_SOURCE_FIELDS" | "NOT_PUBLISHED";
}

export interface KubecostComponentCost {
  readonly component: KubecostCostComponent;
  readonly exact: KubecostExactDecimal;
}

export interface KubecostHourlyCost {
  readonly windowStartIso: string;
  readonly windowEndIso: string;
  readonly currency: string;
  readonly totalCost: KubecostExactDecimal;
  readonly componentCosts: readonly KubecostComponentCost[];
  readonly rowCount: number;
}

export interface KubecostAllocationGroup {
  readonly usageAccountId: string;
  readonly region: string | null;
  readonly clusterId: string;
  readonly namespace: string | null;
  readonly controllerKind: string | null;
  readonly controller: string | null;
  readonly workload: string | null;
  readonly pod: string | null;
  readonly container: string | null;
  readonly node: string | null;
  readonly nodeInstanceType: string | null;
  readonly nodeAvailabilityZone: string | null;
  readonly nodeCapacityType: string | null;
  readonly nodeArchitecture: string | null;
  readonly nodeOs: string | null;
  readonly nodeGroup: string | null;
  readonly nodeGroupImage: string | null;
  readonly allocationKind: KubecostAllocationKind;
  readonly currency: string;
  readonly rowCount: number;
  readonly totalCost: KubecostExactDecimal;
  readonly componentCosts: readonly KubecostComponentCost[];
  readonly hourlyCosts: readonly KubecostHourlyCost[];
  readonly efficiencies: readonly KubecostEfficiency[];
  readonly sourceRowIds: readonly string[];
  readonly sourceRowsTruncated: boolean;
}

export interface KubecostReconciliationResult {
  readonly state: "MATCHED" | "MISMATCH" | "UNAVAILABLE";
  readonly authoritativeSpendSource: "AWS_CUR2_ACTIVE_GENERATION";
  readonly presentationPolicy: "ATTRIBUTION_VIEW_ONLY_DO_NOT_ADD_TO_CUR2";
  readonly toleranceMicros: string;
  readonly currencies: readonly {
    readonly currency: string;
    readonly kubecostTotal: KubecostExactDecimal;
    readonly cur2TotalMicros: string | null;
    /** Kubecost minus CUR2, in exact currency units. */
    readonly delta: KubecostExactDecimal | null;
    readonly withinTolerance: boolean | null;
  }[];
}

export interface KubecostAllocationSnapshot {
  readonly schemaVersion: "sutra.kubecost-allocation.snapshot.v1";
  readonly scope: KubecostAllocationScope;
  readonly captureId: string;
  readonly state: KubecostSnapshotState;
  readonly complete: boolean;
  readonly generatedAtIso: string;
  readonly dataThroughAtIso: string;
  readonly ageHours: number;
  readonly exportLineage: {
    readonly provider: KubecostProvider;
    readonly exporterName: string;
    readonly exporterVersion: string;
    readonly schemaName: string;
    readonly schemaVersion: string;
    readonly schemaSha256: string;
    readonly manifestSha256: string;
    readonly querySha256: string;
    readonly costModelSha256: string;
    readonly objectCount: number;
    readonly versionPinnedObjectCount: number;
  };
  readonly coverage: {
    readonly expectedObjects: number;
    readonly processedObjects: number;
    readonly failedObjects: number;
    readonly expectedClusters: number;
    readonly capturedClusters: number;
    readonly rowsExhausted: boolean;
  };
  readonly rowCount: number;
  readonly groupCount: number;
  readonly categoryTotals: readonly KubecostCategoryTotal[];
  readonly groups: readonly KubecostAllocationGroup[];
  readonly reconciliation: KubecostReconciliationResult;
  readonly limitations: readonly string[];
}

export type KubecostAllocationErrorCode =
  | "INVALID_INPUT"
  | "SCOPE_MISMATCH"
  | "ACCOUNT_SCOPE_MISMATCH"
  | "CLUSTER_SCOPE_MISMATCH"
  | "OBJECT_SCOPE_MISMATCH"
  | "EVIDENCE_REFERENCE_MISSING"
  | "CONFLICTING_DUPLICATE"
  | "COST_TOTAL_MISMATCH"
  | "POLICY_VIOLATION"
  | "CUR2_EVIDENCE_MISMATCH"
  | "BOUND_EXCEEDED";

export class KubecostAllocationError extends Error {
  readonly code: KubecostAllocationErrorCode;

  constructor(code: KubecostAllocationErrorCode) {
    super("Kubecost allocation evidence is invalid.");
    this.name = "KubecostAllocationError";
    this.code = code;
  }
}

interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}

interface MutableGroup {
  readonly row: KubecostAllocationRow;
  readonly rows: KubecostAllocationRow[];
}

const ZERO: Rational = Object.freeze({ n: BigInt(0), d: BigInt(1) });

function fail(code: KubecostAllocationErrorCode): never {
  throw new KubecostAllocationError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < BigInt(0) ? -left : left;
  let b = right < BigInt(0) ? -right : right;
  while (b !== BigInt(0)) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a === BigInt(0) ? BigInt(1) : a;
}

function normalize(value: Rational): Rational {
  if (value.d === BigInt(0)) fail("INVALID_INPUT");
  const sign = value.d < BigInt(0) ? BigInt(-1) : BigInt(1);
  const n = value.n * sign;
  const d = value.d * sign;
  const divisor = gcd(n, d);
  return { n: n / divisor, d: d / divisor };
}

function decimal(value: unknown, nonNegative = false): Rational | null {
  if (typeof value !== "string") return null;
  if (!(nonNegative ? NON_NEGATIVE_DECIMAL : DECIMAL).test(value)) return null;
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const denominator = BigInt(10) ** BigInt(fraction.length);
  const numerator = BigInt(`${whole}${fraction}`) * (negative ? BigInt(-1) : BigInt(1));
  return normalize({ n: numerator, d: denominator });
}

function add(left: Rational, right: Rational): Rational {
  return normalize({ n: left.n * right.d + right.n * left.d, d: left.d * right.d });
}

function subtract(left: Rational, right: Rational): Rational {
  return normalize({ n: left.n * right.d - right.n * left.d, d: left.d * right.d });
}

function divide(left: Rational, right: Rational): Rational | null {
  if (right.n === BigInt(0)) return null;
  return normalize({ n: left.n * right.d, d: left.d * right.n });
}

function absolute(value: Rational): Rational {
  return value.n < BigInt(0) ? { n: -value.n, d: value.d } : value;
}

function atMost(left: Rational, right: Rational): boolean {
  return left.n * right.d <= right.n * left.d;
}

function exact(value: Rational): KubecostExactDecimal {
  const reduced = normalize(value);
  return { numerator: reduced.n.toString(), denominator: reduced.d.toString() };
}

function safeCount(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en-US"));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = sortedUnique(left);
  const b = sortedUnique(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function validScope(value: unknown): value is KubecostAllocationScope {
  if (!isRecord(value)) return false;
  const accounts = value.awsAccountIds;
  const clusters = value.clusterIds;
  return typeof value.orgId === "string" && IDENTIFIER.test(value.orgId)
    && typeof value.customerId === "string" && IDENTIFIER.test(value.customerId)
    && typeof value.connectionId === "string" && CONNECTION_ID.test(value.connectionId)
    && (value.partition === "aws" || value.partition === "aws-us-gov" || value.partition === "aws-cn")
    && typeof value.billingPeriod === "string" && PERIOD.test(value.billingPeriod)
    && typeof value.activeCur2GenerationId === "string" && GENERATION_ID.test(value.activeCur2GenerationId)
    && Array.isArray(accounts) && accounts.length > 0 && accounts.length <= KUBECOST_ALLOCATION_BOUNDS.maximumAccounts
    && accounts.every((account) => typeof account === "string" && ACCOUNT_ID.test(account))
    && sortedUnique(accounts as readonly string[]).length === accounts.length
    && Array.isArray(clusters) && clusters.length > 0 && clusters.length <= KUBECOST_ALLOCATION_BOUNDS.maximumClusters
    && clusters.every((cluster) => typeof cluster === "string" && CLUSTER_ID.test(cluster))
    && sortedUnique(clusters as readonly string[]).length === clusters.length;
}

function sameScope(left: KubecostAllocationScope, right: KubecostAllocationScope): boolean {
  return left.orgId === right.orgId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId
    && left.partition === right.partition
    && left.billingPeriod === right.billingPeriod
    && left.activeCur2GenerationId === right.activeCur2GenerationId
    && sameStrings(left.awsAccountIds, right.awsAccountIds)
    && sameStrings(left.clusterIds, right.clusterIds);
}

function nullableSafeText(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && SAFE_TEXT.test(value));
}

function validMetrics(value: unknown): value is KubecostAllocationMetrics {
  if (!isRecord(value)) return false;
  const keys: readonly (keyof KubecostAllocationMetrics)[] = [
    "cpuCoreRequestHours", "cpuCoreUsageHours", "ramByteRequestHours", "ramByteUsageHours",
    "gpuRequestHours", "gpuUsageHours", "networkTransferBytes", "networkReceiveBytes",
    "networkCapacityBytes", "pvProvisionedByteHours", "pvUsedByteHours",
  ];
  return keys.every((key) => value[key] === null || decimal(value[key], true) !== null);
}

const COST_KEYS: readonly (keyof Omit<KubecostAllocationCosts, "totalCost">)[] = [
  "cpuCost", "ramCost", "gpuCost", "networkCost", "pvCost", "loadBalancerCost",
  "sharedCost", "externalCost",
];

function validCosts(value: unknown): value is KubecostAllocationCosts {
  if (!isRecord(value) || decimal(value.totalCost) === null) return false;
  let total = ZERO;
  for (const key of COST_KEYS) {
    const part = decimal(value[key]);
    if (part === null) return false;
    total = add(total, part);
  }
  const declared = decimal(value.totalCost);
  if (declared === null || total.n * declared.d !== declared.n * total.d) fail("COST_TOTAL_MISMATCH");
  return true;
}

function validRow(row: unknown): row is KubecostAllocationRow {
  if (!isRecord(row)) return false;
  const start = typeof row.windowStartIso === "string" ? Date.parse(row.windowStartIso) : Number.NaN;
  const end = typeof row.windowEndIso === "string" ? Date.parse(row.windowEndIso) : Number.NaN;
  return typeof row.sourceRowId === "string" && IDENTIFIER.test(row.sourceRowId)
    && typeof row.sourceObjectId === "string" && IDENTIFIER.test(row.sourceObjectId)
    && safeCount(row.sourceRowNumber) && row.sourceRowNumber > 0
    && typeof row.sourceRowSha256 === "string" && SHA256.test(row.sourceRowSha256)
    && validIso(row.windowStartIso) && validIso(row.windowEndIso) && end > start && end - start <= DAY_MS
    && typeof row.usageAccountId === "string" && ACCOUNT_ID.test(row.usageAccountId)
    && (row.region === null || (typeof row.region === "string" && REGION.test(row.region)))
    && typeof row.clusterId === "string" && CLUSTER_ID.test(row.clusterId)
    && nullableSafeText(row.namespace) && nullableSafeText(row.controllerKind)
    && nullableSafeText(row.controller) && nullableSafeText(row.workload)
    && nullableSafeText(row.pod) && nullableSafeText(row.container)
    && nullableSafeText(row.node) && nullableSafeText(row.nodeInstanceType)
    && nullableSafeText(row.nodeAvailabilityZone) && nullableSafeText(row.nodeCapacityType)
    && nullableSafeText(row.nodeArchitecture) && nullableSafeText(row.nodeOs)
    && nullableSafeText(row.nodeGroup) && nullableSafeText(row.nodeGroupImage)
    && ["WORKLOAD", "IDLE", "SHARED", "EXTERNAL", "UNALLOCATED", "UNMOUNTED"].includes(String(row.allocationKind))
    && typeof row.currency === "string" && FINOPS_RECONCILIATION_CURRENCIES.has(row.currency as never)
    && validCosts(row.costs) && validMetrics(row.metrics);
}

function validateObjects(capture: KubecostAllocationCapture): ReadonlySet<string> {
  if (capture.objects.length > KUBECOST_ALLOCATION_BOUNDS.maximumObjects) fail("BOUND_EXCEEDED");
  const objectIds = new Set<string>();
  for (const object of capture.objects) {
    if (!IDENTIFIER.test(object.objectId) || !S3_BUCKET.test(object.bucket)
      || !SAFE_TEXT.test(object.key) || !object.key.startsWith(capture.destination.prefix)
      || object.bucket !== capture.destination.bucket || !SAFE_TEXT.test(object.eTag)
      || (object.versionId !== null && !SAFE_TEXT.test(object.versionId))
      || !SHA256.test(object.sha256)
      || !safeCount(object.sizeBytes, KUBECOST_ALLOCATION_BOUNDS.maximumObjectBytes)) fail("OBJECT_SCOPE_MISMATCH");
    if (objectIds.has(object.objectId)) fail("CONFLICTING_DUPLICATE");
    objectIds.add(object.objectId);
  }
  return objectIds;
}

function validateCur2(capture: KubecostAllocationCapture): void {
  const evidence = capture.cur2Evidence;
  if (evidence === null) return;
  if (evidence.source !== "AWS_CUR2_ACTIVE_GENERATION" || evidence.generationState !== "ACTIVE"
    || evidence.generationId !== capture.scope.activeCur2GenerationId
    || !SHA256.test(evidence.manifestSha256) || evidence.billingPeriod !== capture.scope.billingPeriod
    || !validIso(evidence.dataThroughAtIso) || evidence.dataThroughAtIso !== capture.dataThroughAtIso
    || !evidence.rowsExhausted
    || !sameStrings(evidence.usageAccountIds, capture.scope.awsAccountIds)
    || !sameStrings(evidence.clusterIds, capture.scope.clusterIds)
    || sortedUnique(evidence.usageAccountIds).length !== evidence.usageAccountIds.length
    || sortedUnique(evidence.clusterIds).length !== evidence.clusterIds.length
    || !Array.isArray(evidence.payerAccountIds) || evidence.payerAccountIds.length === 0
    || evidence.payerAccountIds.some((account) => !ACCOUNT_ID.test(account))
    || sortedUnique(evidence.payerAccountIds).length !== evidence.payerAccountIds.length) fail("CUR2_EVIDENCE_MISMATCH");
  const currencies = new Set<string>();
  for (const total of evidence.totals) {
    if (!FINOPS_RECONCILIATION_CURRENCIES.has(total.currency as never)
      || !INTEGER_MICROS.test(total.amountMicros) || currencies.has(total.currency)) {
      fail("CUR2_EVIDENCE_MISMATCH");
    }
    currencies.add(total.currency);
  }
}

function validateCapture(
  capture: KubecostAllocationCapture,
  expectedScope: KubecostAllocationScope,
  now: number,
): void {
  if (!validScope(expectedScope) || !validScope(capture.scope)) fail("INVALID_INPUT");
  if (!sameScope(capture.scope, expectedScope)) fail("SCOPE_MISMATCH");
  if (capture.schemaVersion !== "sutra.kubecost-allocation.capture.v1"
    || !CAPTURE_ID.test(capture.captureId) || !Number.isFinite(now)
    || !validIso(capture.startedAtIso) || !validIso(capture.completedAtIso)
    || !validIso(capture.generatedAtIso) || !validIso(capture.dataThroughAtIso)) fail("INVALID_INPUT");
  const started = Date.parse(capture.startedAtIso);
  const completed = Date.parse(capture.completedAtIso);
  const generated = Date.parse(capture.generatedAtIso);
  const through = Date.parse(capture.dataThroughAtIso);
  if (completed < started || completed - started > KUBECOST_ALLOCATION_BOUNDS.maximumCaptureDurationMs
    || generated > completed + MAX_CLOCK_SKEW_MS || through > completed + MAX_CLOCK_SKEW_MS
    || completed > now + MAX_CLOCK_SKEW_MS) fail("INVALID_INPUT");
  if (!S3_BUCKET.test(capture.destination.bucket) || !SAFE_TEXT.test(capture.destination.prefix)
    || !capture.destination.prefix.endsWith("/")) fail("INVALID_INPUT");
  const query = capture.export.query;
  if ((capture.export.provider !== "KUBECOST" && capture.export.provider !== "OPENCOST")
    || !["NDJSON", "CSV", "PARQUET"].includes(capture.export.format)
    || !["KUBECOST_ESTIMATE", "OPENCOST_ESTIMATE", "CLOUD_BILL_RECONCILED", "CUSTOM_PRICE_SHEET"]
      .includes(capture.export.costBasis)
    || capture.export.schemaName !== KUBECOST_EXPORT_CONTRACT.schemaName
    || capture.export.schemaVersion !== KUBECOST_EXPORT_CONTRACT.schemaVersion
    || !SAFE_TEXT.test(capture.export.exporterName) || !SAFE_TEXT.test(capture.export.exporterVersion)
    || !SHA256.test(capture.export.schemaSha256) || !SHA256.test(capture.export.manifestSha256)
    || !SHA256.test(capture.export.querySha256) || !SHA256.test(capture.export.costModelSha256)
    || query.step !== "1d" || query.accumulate !== false || query.rawAllocationLineage !== true
    || query.shareIdle !== false || query.splitIdle !== true
    || query.includeSharedCostBreakdown !== true || query.external !== true
    || !validIso(query.windowStartIso) || !validIso(query.windowEndIso)
    || Date.parse(query.windowStartIso) >= Date.parse(query.windowEndIso)) fail("POLICY_VIOLATION");
  if (capture.export.costBasis === "CLOUD_BILL_RECONCILED" && !query.cloudBillReconciliationEnabled) {
    fail("POLICY_VIOLATION");
  }
  if (capture.export.costBasis !== "CLOUD_BILL_RECONCILED" && query.cloudBillReconciliationEnabled) {
    fail("POLICY_VIOLATION");
  }
  const coverage = capture.coverage;
  if (typeof coverage.configured !== "boolean" || typeof coverage.deliveryObserved !== "boolean"
    || typeof coverage.runtimeS3PermissionsValidated !== "boolean"
    || !["SUCCEEDED", "PARTIAL", "FAILED", "UNKNOWN"].includes(coverage.status)
    || typeof coverage.rowsExhausted !== "boolean"
    || !safeCount(coverage.expectedObjectCount, KUBECOST_ALLOCATION_BOUNDS.maximumObjects)
    || !safeCount(coverage.processedObjectCount, KUBECOST_ALLOCATION_BOUNDS.maximumObjects)
    || !safeCount(coverage.failedObjectCount, KUBECOST_ALLOCATION_BOUNDS.maximumObjects)
    || coverage.processedObjectCount + coverage.failedObjectCount > coverage.expectedObjectCount
    || !sameStrings(coverage.expectedClusterIds, capture.scope.clusterIds)
    || coverage.capturedClusterIds.some((cluster) => !capture.scope.clusterIds.includes(cluster))
    || sortedUnique(coverage.capturedClusterIds).length !== coverage.capturedClusterIds.length
    || (coverage.errorCode !== null && !SAFE_ERROR_CODE.test(coverage.errorCode))) fail("INVALID_INPUT");
  if (capture.objects.length !== coverage.processedObjectCount) fail("INVALID_INPUT");
  if (capture.rows.length > KUBECOST_ALLOCATION_BOUNDS.maximumRows) fail("BOUND_EXCEEDED");
  if (JSON.stringify(capture).length > KUBECOST_ALLOCATION_BOUNDS.maximumCaptureBytes) fail("BOUND_EXCEEDED");
  const objectIds = validateObjects(capture);
  const rowIds = new Map<string, string>();
  const lineageWindows = new Map<string, { readonly start: number; readonly end: number }[]>();
  for (const row of capture.rows) {
    if (!validRow(row)) fail("INVALID_INPUT");
    if (!capture.scope.awsAccountIds.includes(row.usageAccountId)) fail("ACCOUNT_SCOPE_MISMATCH");
    if (!capture.scope.clusterIds.includes(row.clusterId)) fail("CLUSTER_SCOPE_MISMATCH");
    if (!objectIds.has(row.sourceObjectId)) fail("EVIDENCE_REFERENCE_MISSING");
    if (Date.parse(row.windowStartIso) < Date.parse(query.windowStartIso)
      || Date.parse(row.windowEndIso) > Date.parse(query.windowEndIso)) fail("POLICY_VIOLATION");
    const previous = rowIds.get(row.sourceRowId);
    if (previous !== undefined) fail("CONFLICTING_DUPLICATE");
    rowIds.set(row.sourceRowId, row.sourceRowSha256);
    const key = groupKey(row);
    const windows = lineageWindows.get(key) ?? [];
    windows.push({ start: Date.parse(row.windowStartIso), end: Date.parse(row.windowEndIso) });
    lineageWindows.set(key, windows);
  }
  for (const windows of lineageWindows.values()) {
    windows.sort((left, right) => left.start - right.start || left.end - right.end);
    for (let index = 1; index < windows.length; index += 1) {
      if ((windows[index]?.start ?? 0) < (windows[index - 1]?.end ?? 0)) fail("POLICY_VIOLATION");
    }
  }
  if (capture.reconciliationToleranceMicros !== undefined
    && !NON_NEGATIVE_INTEGER.test(capture.reconciliationToleranceMicros)) fail("INVALID_INPUT");
  validateCur2(capture);
}

function totalCost(row: KubecostAllocationRow): Rational {
  const value = decimal(row.costs.totalCost);
  if (value === null) fail("INVALID_INPUT");
  return value;
}

function sumRows(rows: readonly KubecostAllocationRow[], select: (row: KubecostAllocationRow) => Rational): Rational {
  return rows.reduce((sum, row) => add(sum, select(row)), ZERO);
}

const COMPONENT_COSTS: readonly { readonly component: KubecostCostComponent; readonly key: keyof KubecostAllocationCosts }[] = [
  { component: "CPU", key: "cpuCost" }, { component: "RAM", key: "ramCost" },
  { component: "GPU", key: "gpuCost" }, { component: "NETWORK", key: "networkCost" },
  { component: "PV", key: "pvCost" }, { component: "LOAD_BALANCER", key: "loadBalancerCost" },
  { component: "SHARED", key: "sharedCost" }, { component: "EXTERNAL", key: "externalCost" },
];

function componentCosts(rows: readonly KubecostAllocationRow[]): readonly KubecostComponentCost[] {
  return COMPONENT_COSTS.map(({ component, key }) => ({ component, exact: exact(sumRows(rows, (row) => {
    const amount = decimal(row.costs[key]);
    if (amount === null) fail("INVALID_INPUT");
    return amount;
  })) }));
}

function hourlyCosts(rows: readonly KubecostAllocationRow[]): readonly KubecostHourlyCost[] {
  const windows = new Map<string, KubecostAllocationRow[]>();
  for (const row of rows) {
    const key = `${row.windowStartIso}\u001f${row.windowEndIso}\u001f${row.currency}`;
    const values = windows.get(key) ?? [];
    values.push(row);
    windows.set(key, values);
  }
  return [...windows.entries()].sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([, values]) => ({ windowStartIso: values[0]!.windowStartIso,
      windowEndIso: values[0]!.windowEndIso, currency: values[0]!.currency,
      totalCost: exact(sumRows(values, totalCost)), componentCosts: componentCosts(values), rowCount: values.length }));
}

function economicParts(row: KubecostAllocationRow): Readonly<Record<KubecostEconomicCategory, Rational>> {
  const empty = (): Record<KubecostEconomicCategory, Rational> => ({
    WORKLOAD_ALLOCATION: ZERO, IDLE: ZERO, SHARED: ZERO, EXTERNAL: ZERO, UNALLOCATED: ZERO, UNMOUNTED: ZERO,
  });
  const parts = empty();
  const whole = totalCost(row);
  if (row.allocationKind !== "WORKLOAD") {
    parts[row.allocationKind] = whole;
    return parts;
  }
  const shared = decimal(row.costs.sharedCost);
  const external = decimal(row.costs.externalCost);
  if (shared === null || external === null) fail("INVALID_INPUT");
  parts.SHARED = shared;
  parts.EXTERNAL = external;
  parts.WORKLOAD_ALLOCATION = subtract(subtract(whole, shared), external);
  return parts;
}

function metricValues(row: KubecostAllocationRow, metric: KubecostMetric): { requested: Rational | null; used: Rational | null } {
  const values = row.metrics;
  switch (metric) {
    case "CPU": return { requested: decimal(values.cpuCoreRequestHours, true), used: decimal(values.cpuCoreUsageHours, true) };
    case "RAM": return { requested: decimal(values.ramByteRequestHours, true), used: decimal(values.ramByteUsageHours, true) };
    case "GPU": return { requested: decimal(values.gpuRequestHours, true), used: decimal(values.gpuUsageHours, true) };
    case "NETWORK": {
      const sent = decimal(values.networkTransferBytes, true);
      const received = decimal(values.networkReceiveBytes, true);
      return {
        requested: decimal(values.networkCapacityBytes, true),
        used: sent === null || received === null ? null : add(sent, received),
      };
    }
    case "PV": return { requested: decimal(values.pvProvisionedByteHours, true), used: decimal(values.pvUsedByteHours, true) };
  }
}

function efficiency(rows: readonly KubecostAllocationRow[], metric: KubecostMetric): KubecostEfficiency {
  const pairs = rows.map((row) => metricValues(row, metric));
  const present = pairs.filter((pair) => pair.requested !== null && pair.used !== null) as readonly {
    requested: Rational;
    used: Rational;
  }[];
  const unit = metric === "CPU" ? "core-hours"
    : metric === "GPU" ? "gpu-hours"
      : metric === "NETWORK" ? "bytes" : "byte-hours";
  if (present.length === 0) {
    return {
      metric, unit, requestedOrProvisioned: null, used: null, ratio: null,
      state: "UNAVAILABLE", evidenceBasis: "NOT_PUBLISHED",
    };
  }
  const requested = present.reduce((sum, pair) => add(sum, pair.requested), ZERO);
  const used = present.reduce((sum, pair) => add(sum, pair.used), ZERO);
  const ratio = divide(used, requested);
  return {
    metric,
    unit,
    requestedOrProvisioned: exact(requested),
    used: exact(used),
    ratio: ratio === null ? null : exact(ratio),
    state: present.length === pairs.length && ratio !== null ? "COMPLETE" : "PARTIAL",
    evidenceBasis: "EXPLICIT_SOURCE_FIELDS",
  };
}

function groupKey(row: KubecostAllocationRow): string {
  return [
    row.usageAccountId, row.region, row.clusterId, row.namespace, row.controllerKind,
    row.controller, row.workload, row.pod, row.container, row.node, row.nodeInstanceType,
    row.nodeAvailabilityZone, row.nodeCapacityType, row.nodeArchitecture, row.nodeOs,
    row.nodeGroup, row.nodeGroupImage, row.allocationKind, row.currency,
  ].map((value) => value ?? "").join("\u001f");
}

function buildGroups(rows: readonly KubecostAllocationRow[]): readonly KubecostAllocationGroup[] {
  const groups = new Map<string, MutableGroup>();
  for (const row of rows) {
    const key = groupKey(row);
    const current = groups.get(key);
    if (current === undefined) groups.set(key, { row, rows: [row] });
    else current.rows.push(row);
  }
  if (groups.size > KUBECOST_ALLOCATION_BOUNDS.maximumGroups) fail("BOUND_EXCEEDED");
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([, group]) => {
      const sourceRows = sortedUnique(group.rows.map((row) => row.sourceRowId));
      const limited = sourceRows.slice(0, KUBECOST_ALLOCATION_BOUNDS.maximumSourceRowsPerGroup);
      const row = group.row;
      return {
        usageAccountId: row.usageAccountId,
        region: row.region,
        clusterId: row.clusterId,
        namespace: row.namespace,
        controllerKind: row.controllerKind,
        controller: row.controller,
        workload: row.workload,
        pod: row.pod,
        container: row.container,
        node: row.node,
        nodeInstanceType: row.nodeInstanceType,
        nodeAvailabilityZone: row.nodeAvailabilityZone,
        nodeCapacityType: row.nodeCapacityType,
        nodeArchitecture: row.nodeArchitecture,
        nodeOs: row.nodeOs,
        nodeGroup: row.nodeGroup,
        nodeGroupImage: row.nodeGroupImage,
        allocationKind: row.allocationKind,
        currency: row.currency,
        rowCount: group.rows.length,
        totalCost: exact(sumRows(group.rows, totalCost)),
        componentCosts: componentCosts(group.rows),
        hourlyCosts: hourlyCosts(group.rows),
        efficiencies: (["CPU", "RAM", "GPU", "NETWORK", "PV"] as const).map((metric) => efficiency(group.rows, metric)),
        sourceRowIds: limited,
        sourceRowsTruncated: sourceRows.length > limited.length,
      };
    });
}

function categoryTotals(rows: readonly KubecostAllocationRow[]): readonly KubecostCategoryTotal[] {
  const values = new Map<string, { category: KubecostEconomicCategory; currency: string; value: Rational; rowCount: number }>();
  for (const row of rows) {
    const parts = economicParts(row);
    for (const category of ["WORKLOAD_ALLOCATION", "IDLE", "SHARED", "EXTERNAL", "UNALLOCATED", "UNMOUNTED"] as const) {
      const value = parts[category];
      if (value.n === BigInt(0)) continue;
      const key = `${row.currency}\u001f${category}`;
      const current = values.get(key);
      values.set(key, {
        category,
        currency: row.currency,
        value: add(current?.value ?? ZERO, value),
        rowCount: (current?.rowCount ?? 0) + 1,
      });
    }
  }
  return [...values.entries()].sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([, item]) => ({ category: item.category, currency: item.currency, exact: exact(item.value), rowCount: item.rowCount }));
}

function reconcile(capture: KubecostAllocationCapture): KubecostReconciliationResult {
  const toleranceMicros = capture.reconciliationToleranceMicros ?? "0";
  const tolerance: Rational = { n: BigInt(toleranceMicros), d: BigInt(1_000_000) };
  const exported = new Map<string, Rational>();
  for (const row of capture.rows) exported.set(row.currency, add(exported.get(row.currency) ?? ZERO, totalCost(row)));
  const cur2 = new Map(capture.cur2Evidence?.totals.map((value) => [value.currency, value.amountMicros]) ?? []);
  const currencies = sortedUnique([...exported.keys(), ...cur2.keys()]);
  const summaries = currencies.map((currency) => {
    const kubecost = exported.get(currency) ?? ZERO;
    const micros = cur2.get(currency) ?? null;
    const authoritative = micros === null ? null : normalize({ n: BigInt(micros), d: BigInt(1_000_000) });
    const delta = authoritative === null ? null : subtract(kubecost, authoritative);
    return {
      currency,
      kubecostTotal: exact(kubecost),
      cur2TotalMicros: micros,
      delta: delta === null ? null : exact(delta),
      withinTolerance: delta === null ? null : atMost(absolute(delta), tolerance),
    };
  });
  const state = capture.cur2Evidence === null || summaries.some((entry) => entry.withinTolerance === null)
    ? "UNAVAILABLE"
    : summaries.every((entry) => entry.withinTolerance === true) ? "MATCHED" : "MISMATCH";
  return {
    state,
    authoritativeSpendSource: "AWS_CUR2_ACTIVE_GENERATION",
    presentationPolicy: "ATTRIBUTION_VIEW_ONLY_DO_NOT_ADD_TO_CUR2",
    toleranceMicros,
    currencies: summaries,
  };
}

function snapshotState(
  capture: KubecostAllocationCapture,
  reconciliation: KubecostReconciliationResult,
  ageHours: number,
): KubecostSnapshotState {
  const coverage = capture.coverage;
  if (!coverage.configured || !coverage.runtimeS3PermissionsValidated || capture.cur2Evidence === null) {
    return "CONFIGURATION_REQUIRED";
  }
  if (!coverage.deliveryObserved) return "WAITING_FIRST_DELIVERY";
  if (coverage.status === "FAILED") return "ERROR";
  if (coverage.status === "UNKNOWN") return "UNKNOWN";
  const completeCoverage = coverage.status === "SUCCEEDED" && coverage.rowsExhausted
    && coverage.failedObjectCount === 0
    && coverage.expectedObjectCount === coverage.processedObjectCount
    && sameStrings(coverage.expectedClusterIds, coverage.capturedClusterIds);
  if (capture.rows.length === 0 && completeCoverage && reconciliation.state === "MATCHED") return "EMPTY";
  if (!completeCoverage || reconciliation.state !== "MATCHED") return "PARTIAL";
  if (ageHours > KUBECOST_ALLOCATION_BOUNDS.freshnessSlaHours) return "STALE";
  return "READY";
}

export function buildKubecostAllocationSnapshot(
  capture: KubecostAllocationCapture,
  expectedScope: KubecostAllocationScope,
  nowInput: Date | number,
): KubecostAllocationSnapshot {
  const now = nowInput instanceof Date ? nowInput.getTime() : nowInput;
  validateCapture(capture, expectedScope, now);
  const ageHours = Math.max(0, (now - Date.parse(capture.dataThroughAtIso)) / HOUR_MS);
  const result = reconcile(capture);
  const state = snapshotState(capture, result, ageHours);
  const groups = buildGroups(capture.rows);
  const snapshot: KubecostAllocationSnapshot = {
    schemaVersion: "sutra.kubecost-allocation.snapshot.v1",
    scope: capture.scope,
    captureId: capture.captureId,
    state,
    complete: state === "READY" || state === "EMPTY",
    generatedAtIso: capture.generatedAtIso,
    dataThroughAtIso: capture.dataThroughAtIso,
    ageHours,
    exportLineage: {
      provider: capture.export.provider,
      exporterName: capture.export.exporterName,
      exporterVersion: capture.export.exporterVersion,
      schemaName: capture.export.schemaName,
      schemaVersion: capture.export.schemaVersion,
      schemaSha256: capture.export.schemaSha256,
      manifestSha256: capture.export.manifestSha256,
      querySha256: capture.export.querySha256,
      costModelSha256: capture.export.costModelSha256,
      objectCount: capture.objects.length,
      versionPinnedObjectCount: capture.objects.filter((object) => object.versionId !== null).length,
    },
    coverage: {
      expectedObjects: capture.coverage.expectedObjectCount,
      processedObjects: capture.coverage.processedObjectCount,
      failedObjects: capture.coverage.failedObjectCount,
      expectedClusters: capture.coverage.expectedClusterIds.length,
      capturedClusters: capture.coverage.capturedClusterIds.length,
      rowsExhausted: capture.coverage.rowsExhausted,
    },
    rowCount: capture.rows.length,
    groupCount: groups.length,
    categoryTotals: categoryTotals(capture.rows),
    groups,
    reconciliation: result,
    limitations: [
      "Kubecost/OpenCost values are provider allocations, not a second spend ledger; dashboards must not add them to CUR2.",
      "CPU, RAM, GPU, network, and PV efficiency is shown only when both exact source numerator and denominator are present.",
      "The standard allocation API does not publish network capacity, so network efficiency is normally unavailable unless an exporter adds authoritative capacity evidence.",
      "Shared, external, idle, unallocated, and unmounted costs remain separate categories; none is silently redistributed.",
      "A READY result requires complete cluster/object coverage and reconciliation to the pinned ACTIVE CUR2 generation.",
    ],
  };
  if (JSON.stringify(snapshot).length > KUBECOST_ALLOCATION_BOUNDS.maximumOutputBytes) fail("BOUND_EXCEEDED");
  return snapshot;
}

export function kubecostAllocationSourceEvidence(
  snapshot: KubecostAllocationSnapshot,
): FinopsSourceEvidence {
  const succeeded = snapshot.state === "READY" || snapshot.state === "EMPTY";
  const partial = snapshot.state === "PARTIAL" || snapshot.state === "STALE";
  return {
    scope: snapshot.scope,
    sourceId: "kubecost_allocation",
    configured: snapshot.state !== "CONFIGURATION_REQUIRED",
    deliveryObserved: snapshot.state !== "CONFIGURATION_REQUIRED" && snapshot.state !== "WAITING_FIRST_DELIVERY",
    lastAttemptAt: snapshot.generatedAtIso,
    lastAttemptOutcome: succeeded ? "succeeded"
      : partial ? "partial" : snapshot.state === "ERROR" ? "failed" : "unknown",
    lastSuccessAt: succeeded ? snapshot.generatedAtIso : null,
    dataThroughAt: snapshot.dataThroughAtIso,
    coverage: {
      assessment: succeeded ? "complete" : partial ? "partial" : "unknown",
      acceptedRecords: snapshot.rowCount,
      expectedRecords: null,
      rejectedRecords: null,
    },
    lastError: snapshot.state === "ERROR" ? {
      code: "KUBECOST_EXPORT_FAILED",
      message: "Kubecost/OpenCost export collection failed.",
      at: snapshot.generatedAtIso,
    } : null,
    evidenceBasis: `${snapshot.exportLineage.provider} schema ${snapshot.exportLineage.schemaVersion}, manifest ${snapshot.exportLineage.manifestSha256}, reconciled against active CUR2 ${snapshot.scope.activeCur2GenerationId}.`,
    limitations: snapshot.limitations,
  };
}
