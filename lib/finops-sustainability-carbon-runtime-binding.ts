/**
 * ADD-08 permanent scheduler and signed dual-plane runtime boundary.
 *
 * Durable jobs contain only a trusted connection identity and scheduler window.
 * The active reconciled CUR2 lineage and the AWS CARBON_EMISSIONS export lineage
 * are resolved independently from server state for every attempt. Resource-use
 * proxies are never converted to emissions and provider emissions are never
 * allocated to workloads beyond dimensions published by AWS.
 */
import type { JobHandler, RunnableJob } from "./background-job-runner.ts";
import { canonicalJson } from "./canonical-json.ts";
import {
  AWS_CARBON_EMISSIONS_COLUMNS,
  SUSTAINABILITY_CARBON_BOUNDS,
  normalizeSustainabilityCarbonCapture,
  type SustainabilityCarbonCapture,
  type SustainabilityCarbonSnapshot,
  type SustainabilityProxyMetric,
  type SustainabilityScope,
} from "./finops-sustainability-carbon.ts";
import {
  SUSTAINABILITY_EXPORT_READ_ACTIONS,
  SUSTAINABILITY_VERSIONED_READ_ACTIONS,
} from "./finops-sustainability-carbon-job.ts";
import type {
  StoredSustainabilitySnapshot,
  SustainabilityPersistenceScope,
} from "../db/finops-sustainability-carbon-repository.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const JOB = /^job_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const REQUEST_ID = /^scr_[a-f0-9]{64}$/u;
const CAPTURE_ID = /^sustainability_[a-f0-9]{64}$/u;
const BILLING_GENERATION = /^fbg_[a-f0-9]{64}$/u;
const SOURCE_GENERATION = /^fss_[a-f0-9]{64}$/u;
const SNAPSHOT_GENERATION = /^scg_[a-f0-9]{64}$/u;
const EVIDENCE_OBJECT = /^eobj_[a-f0-9]{32}$/u;
const SEALED_REFERENCE = /^fsev1\.[A-Za-z0-9_-]{26,8186}$/u;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const ADAPTER_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const EXPORT_NAME = /^[A-Za-z0-9_-]{1,128}$/u;
const S3_BUCKET = /^(?!\d+\.\d+\.\d+\.\d+$)(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const MAX_CONNECTIONS = 10_000;

export const SUSTAINABILITY_CARBON_RUNTIME_JOB_KIND =
  "finops-sustainability-carbon-daily-collect";
export const SUSTAINABILITY_CARBON_RUNTIME_CADENCE = "rate(1 day)";
export const SUSTAINABILITY_CARBON_RUNTIME_TIMEOUT_MS =
  SUSTAINABILITY_CARBON_BOUNDS.maximumCaptureDurationMs;
export const SUSTAINABILITY_CARBON_RUNTIME_ARCHIVE_MAX_BYTES =
  SUSTAINABILITY_CARBON_BOUNDS.maximumDashboardInputBytes;
export const SUSTAINABILITY_CARBON_RUNTIME_ACTIVATION_REASONS = Object.freeze({
  boundary: "SUSTAINABILITY_SERVER_DUAL_SOURCE_BOUNDARY_NOT_CONFIGURED",
  adapter: "SUSTAINABILITY_SIGNED_MATERIALIZER_ADAPTER_NOT_DEPLOYED",
} as const);
export const SUSTAINABILITY_CARBON_EVIDENCE_SOURCE_ID =
  "aws_sustainability_dual_plane" as const;
export const SUSTAINABILITY_CARBON_EVIDENCE_ACTOR_ID =
  "finops-sustainability-carbon-runtime" as const;

export const SUSTAINABILITY_PROXY_METRIC_CONTRACT = Object.freeze([
  "COMPUTE_VCPU_HOURS",
  "COMPUTE_MEMORY_GB_HOURS",
  "LAMBDA_GB_SECONDS",
  "STORAGE_GB_HOURS",
  "STORAGE_REQUESTS",
  "DATA_TRANSFER_GB",
  "DATABASE_VCPU_HOURS",
] as const satisfies readonly SustainabilityProxyMetric[]);

export interface SustainabilityActiveCur2Boundary {
  readonly source: "AWS_CUR2_ACTIVE_GENERATION";
  readonly state: "ACTIVE_RECONCILED";
  readonly generationId: string;
  readonly sourceEvidenceId: string;
  readonly manifestSha256: string;
  readonly dataThroughAtIso: string;
  readonly rowsExhausted: true;
  readonly metricContract: typeof SUSTAINABILITY_PROXY_METRIC_CONTRACT;
  readonly classificationContractVersion: string;
}

export interface SustainabilityCarbonExportBoundary {
  readonly source: "AWS_SUSTAINABILITY_CARBON_DATA_EXPORT";
  readonly tableName: "CARBON_EMISSIONS";
  readonly exportName: string;
  readonly exportArn: string;
  readonly exportRegion: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly expectedBucketOwner: string;
  readonly generationId: string;
  readonly manifestSha256: string;
  readonly schemaColumns: typeof AWS_CARBON_EMISSIONS_COLUMNS;
  readonly publicationKind: "MONTHLY" | "BACKFILL" | "CORRECTION";
  readonly publishedAtIso: string;
  readonly expectedUsagePeriods: readonly string[];
}

export interface SustainabilityCarbonServerBoundary {
  readonly scope: SustainabilityScope;
  readonly allowedUsageAccountIds: readonly string[];
  readonly activeCur2: SustainabilityActiveCur2Boundary;
  readonly carbonExport: SustainabilityCarbonExportBoundary;
}

export interface SustainabilityCarbonRuntimeRequest {
  readonly schemaVersion: "sutra.sustainability-carbon-runtime-request.v1";
  readonly requestId: string;
  readonly expectedCaptureId: string;
  readonly scheduledWindow: string;
  readonly scope: SustainabilityScope;
  readonly allowedUsageAccountIds: readonly string[];
  readonly credentials: "SERVER_OWNED_TRUST_ROLE_SESSION";
  readonly channels: {
    readonly proxy: SustainabilityActiveCur2Boundary & {
      readonly interpretation: "RESOURCE_USE_PROXY_NOT_CARBON";
      readonly conversionToMtco2e: false;
    };
    readonly providerCarbon: SustainabilityCarbonExportBoundary & {
      readonly interpretation: "PROVIDER_ESTIMATE_MTCO2E_NOT_WORKLOAD_ATTRIBUTION";
      readonly allocateToCur2ResourcesOrTags: false;
      readonly keepLbmAndMbmSeparate: true;
      readonly keepTotalsAndScopesSeparate: true;
    };
  };
  readonly objectReads: {
    readonly current: typeof SUSTAINABILITY_EXPORT_READ_ACTIONS;
    readonly versioned: typeof SUSTAINABILITY_VERSIONED_READ_ACTIONS;
    readonly enforceExactPrefix: true;
    readonly enforceExpectedBucketOwner: true;
  };
  readonly exhaustion: {
    readonly requireProxyRowsExhaustionEvidence: true;
    readonly requireCarbonObjectsExhaustionEvidence: true;
    readonly requireCarbonRowsExhaustionEvidence: true;
    readonly incompleteDeliveryDisposition: "PERSIST_HISTORY_NEVER_ADVANCE_HEAD";
  };
  readonly bounds: typeof SUSTAINABILITY_CARBON_BOUNDS;
  readonly archiveMaximumBytes: typeof SUSTAINABILITY_CARBON_RUNTIME_ARCHIVE_MAX_BYTES;
  readonly maximumDurationMs: typeof SUSTAINABILITY_CARBON_RUNTIME_TIMEOUT_MS;
}

export interface SustainabilityCarbonVerifiedMaterializerResult {
  readonly capture: SustainabilityCarbonCapture;
  readonly verification: {
    readonly authentication: "ED25519_RESPONSE_SIGNATURE_VERIFIED";
    readonly requestBodySha256: string;
    readonly captureBodySha256: string;
    readonly materializerKeyId: string;
  };
}

export interface SustainabilityCarbonRuntimeMaterializer {
  collect(
    request: SustainabilityCarbonRuntimeRequest,
    signal: AbortSignal,
  ): Promise<SustainabilityCarbonVerifiedMaterializerResult>;
}

export interface SustainabilityCarbonRuntimeQueue {
  enqueue(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly kind: typeof SUSTAINABILITY_CARBON_RUNTIME_JOB_KIND;
    readonly payload: { readonly scheduledWindow: string };
    readonly maxAttempts: 5;
    readonly idempotencyKey: string;
  }): Promise<unknown>;
}

export interface SustainabilityCarbonEvidenceArchive {
  archive(input: {
    readonly scope: {
      readonly orgId: string;
      readonly customerId: string;
      readonly connectionId: string;
    };
    readonly runId: string;
    readonly snapshotId: string;
    readonly artifactKind: "finops_source_snapshot";
    readonly contentType: "application/json";
    readonly body: Uint8Array;
    readonly createdBy: typeof SUSTAINABILITY_CARBON_EVIDENCE_ACTOR_ID;
    readonly now: number;
  }): Promise<{
    readonly id: string;
    readonly status: "staging" | "available" | "failed";
    readonly contentSha256: string;
  }>;
}

export interface SustainabilityCarbonEvidenceSealer {
  seal(objectId: string, context: {
    readonly organizationId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly sourceId: typeof SUSTAINABILITY_CARBON_EVIDENCE_SOURCE_ID;
    readonly generationId: string;
  }): Promise<{ readonly ciphertext: string; readonly keyVersion: string }>;
}

export interface SustainabilityCarbonAcceptedRuntimeAttempt {
  readonly requestId: string;
  readonly scheduledWindow: string;
  readonly sourceBoundarySha256: string;
  readonly snapshot: StoredSustainabilitySnapshot;
  readonly evidence: {
    readonly generationId: string;
    readonly objectId: string;
    readonly contentSha256: string;
    readonly reference: { readonly ciphertext: string; readonly keyVersion: string };
  };
}

export type SustainabilityCarbonRuntimeFailureCode =
  | "MATERIALIZER_AUTHENTICATION_FAILED"
  | "MATERIALIZER_TIMEOUT"
  | "MATERIALIZER_UNAVAILABLE"
  | "CAPTURE_REJECTED"
  | "EVIDENCE_REJECTED"
  | "PERSISTENCE_REJECTED";

export interface SustainabilityCarbonImmutableEvidenceHandoff {
  getAccepted(
    scope: SustainabilityPersistenceScope,
    requestId: string,
  ): Promise<SustainabilityCarbonAcceptedRuntimeAttempt | null>;
  commit(input: {
    readonly scope: SustainabilityPersistenceScope;
    readonly trustedScope: SustainabilityScope;
    readonly requestId: string;
    readonly scheduledWindow: string;
    readonly sourceBoundarySha256: string;
    readonly capture: SustainabilityCarbonCapture;
    readonly normalizedSnapshot: SustainabilityCarbonSnapshot;
    readonly evidence: SustainabilityCarbonAcceptedRuntimeAttempt["evidence"];
    readonly nowMs: number;
  }): Promise<{
    readonly accepted: SustainabilityCarbonAcceptedRuntimeAttempt;
    readonly becameActive: boolean;
  }>;
  recordFailure(input: {
    readonly scope: SustainabilityPersistenceScope;
    readonly requestId: string;
    readonly scheduledWindow: string;
    readonly code: SustainabilityCarbonRuntimeFailureCode;
    readonly completedAtMs: number;
  }): Promise<void>;
}

export interface SustainabilityCarbonRuntimeDependencies {
  readonly loadBoundary: (
    scope: SustainabilityPersistenceScope,
  ) => Promise<SustainabilityCarbonServerBoundary | null>;
  readonly materializer: SustainabilityCarbonRuntimeMaterializer | null;
  readonly evidence: SustainabilityCarbonEvidenceArchive;
  readonly sealer: SustainabilityCarbonEvidenceSealer;
  readonly handoff: SustainabilityCarbonImmutableEvidenceHandoff;
  readonly now?: () => number;
}

export class SustainabilityCarbonRuntimeBindingError extends Error {
  public readonly code:
    | "INVALID_JOB"
    | "SCOPE_REJECTED"
    | "BOUNDARY_REJECTED"
    | SustainabilityCarbonRuntimeFailureCode;

  public constructor(code: SustainabilityCarbonRuntimeBindingError["code"]) {
    super("Sustainability carbon runtime collection failed");
    this.name = "SustainabilityCarbonRuntimeBindingError";
    this.code = code;
  }
}

export type SustainabilityCarbonRuntimeResult =
  | {
      readonly status: "unavailable";
      readonly reason: typeof SUSTAINABILITY_CARBON_RUNTIME_ACTIVATION_REASONS[keyof
        typeof SUSTAINABILITY_CARBON_RUNTIME_ACTIVATION_REASONS];
    }
  | {
      readonly status: "collected";
      readonly generationId: string;
      readonly evidenceGenerationId: string;
      readonly state: SustainabilityCarbonSnapshot["state"];
      readonly proxyState: SustainabilityCarbonSnapshot["proxy"]["state"];
      readonly carbonState: SustainabilityCarbonSnapshot["providerCarbon"]["state"];
      readonly becameActive: boolean;
      readonly replayed: boolean;
    };

function reject(code: SustainabilityCarbonRuntimeBindingError["code"]): never {
  throw new SustainabilityCarbonRuntimeBindingError(code);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function validIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validWindow(value: unknown): value is string {
  return typeof value === "string" && WINDOW.test(value) && validIso(value);
}

function validPersistenceScope(scope: SustainabilityPersistenceScope): boolean {
  return IDENTIFIER.test(scope.organizationId)
    && IDENTIFIER.test(scope.customerId)
    && CONNECTION.test(scope.connectionId);
}

function persistenceScope(scope: SustainabilityScope): SustainabilityPersistenceScope {
  return {
    organizationId: scope.orgId,
    customerId: scope.customerId,
    connectionId: scope.connectionId,
  };
}

function samePersistenceScope(
  left: SustainabilityPersistenceScope,
  right: SustainabilityPersistenceScope,
): boolean {
  return left.organizationId === right.organizationId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId;
}

function sameScope(left: SustainabilityScope, right: SustainabilityScope): boolean {
  return left.orgId === right.orgId && left.customerId === right.customerId
    && left.connectionId === right.connectionId && left.accountId === right.accountId
    && left.partition === right.partition;
}

function sortedAccounts(values: readonly string[]): boolean {
  return values.length > 0
    && values.length <= SUSTAINABILITY_CARBON_BOUNDS.maximumUsageAccounts
    && values.every((value) => ACCOUNT.test(value))
    && new Set(values).size === values.length
    && JSON.stringify(values) === JSON.stringify([...values].sort());
}

function validPrefix(value: string): boolean {
  return value.length > 0 && value.length <= 1_024 && !value.startsWith("/")
    && !value.includes("\\") && value.endsWith("/")
    && !value.split("/").some((part) => part === "." || part === "..");
}

function validBoundary(
  value: SustainabilityCarbonServerBoundary,
  expected: SustainabilityPersistenceScope,
): boolean {
  const scope = value.scope;
  const cur2 = value.activeCur2;
  const carbon = value.carbonExport;
  const expectedArn = `arn:aws:bcm-data-exports:${carbon.exportRegion}:${scope.accountId}:export/${carbon.exportName}`;
  return exactKeys(value, ["scope", "allowedUsageAccountIds", "activeCur2", "carbonExport"])
    && exactKeys(scope, ["orgId", "customerId", "connectionId", "accountId", "partition"])
    && samePersistenceScope(persistenceScope(scope), expected)
    && IDENTIFIER.test(scope.orgId) && IDENTIFIER.test(scope.customerId)
    && CONNECTION.test(scope.connectionId) && ACCOUNT.test(scope.accountId)
    && scope.partition === "aws"
    && sortedAccounts(value.allowedUsageAccountIds)
    && value.allowedUsageAccountIds.includes(scope.accountId)
    && exactKeys(cur2, [
      "source", "state", "generationId", "sourceEvidenceId", "manifestSha256",
      "dataThroughAtIso", "rowsExhausted", "metricContract",
      "classificationContractVersion",
    ])
    && cur2.source === "AWS_CUR2_ACTIVE_GENERATION"
    && cur2.state === "ACTIVE_RECONCILED"
    && BILLING_GENERATION.test(cur2.generationId)
    && SOURCE_GENERATION.test(cur2.sourceEvidenceId)
    && SHA256.test(cur2.manifestSha256) && validIso(cur2.dataThroughAtIso)
    && cur2.rowsExhausted === true
    && JSON.stringify(cur2.metricContract)
      === JSON.stringify(SUSTAINABILITY_PROXY_METRIC_CONTRACT)
    && IDENTIFIER.test(cur2.classificationContractVersion)
    && exactKeys(carbon, [
      "source", "tableName", "exportName", "exportArn", "exportRegion",
      "bucket", "prefix", "expectedBucketOwner", "generationId",
      "manifestSha256", "schemaColumns", "publicationKind", "publishedAtIso",
      "expectedUsagePeriods",
    ])
    && carbon.source === "AWS_SUSTAINABILITY_CARBON_DATA_EXPORT"
    && carbon.tableName === "CARBON_EMISSIONS"
    && EXPORT_NAME.test(carbon.exportName) && REGION.test(carbon.exportRegion)
    && carbon.exportArn === expectedArn && S3_BUCKET.test(carbon.bucket)
    && validPrefix(carbon.prefix) && ACCOUNT.test(carbon.expectedBucketOwner)
    && carbon.expectedBucketOwner === scope.accountId
    && BILLING_GENERATION.test(carbon.generationId)
    && SHA256.test(carbon.manifestSha256)
    && JSON.stringify(carbon.schemaColumns) === JSON.stringify(AWS_CARBON_EMISSIONS_COLUMNS)
    && new Set(["MONTHLY", "BACKFILL", "CORRECTION"]).has(carbon.publicationKind)
    && validIso(carbon.publishedAtIso)
    && carbon.expectedUsagePeriods.length > 0
    && carbon.expectedUsagePeriods.length
      <= SUSTAINABILITY_CARBON_BOUNDS.maximumExpectedPeriods
    && carbon.expectedUsagePeriods.every((period) => MONTH.test(period))
    && new Set(carbon.expectedUsagePeriods).size === carbon.expectedUsagePeriods.length
    && JSON.stringify(carbon.expectedUsagePeriods)
      === JSON.stringify([...carbon.expectedUsagePeriods].sort());
}

function currentTime(now: (() => number) | undefined): number {
  const value = now?.() ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0) reject("INVALID_JOB");
  return value;
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0")).join("");
}

function parseJob(job: RunnableJob): {
  readonly scope: SustainabilityPersistenceScope;
  readonly scheduledWindow: string;
} {
  if (job.kind !== SUSTAINABILITY_CARBON_RUNTIME_JOB_KIND || job.customerId === null
    || job.connectionId === null || !JOB.test(job.id)
    || !IDENTIFIER.test(job.orgId) || !IDENTIFIER.test(job.customerId)
    || !CONNECTION.test(job.connectionId) || !Number.isSafeInteger(job.attempt)
    || job.attempt < 1 || job.attempt > 5 || job.maxAttempts !== 5
    || typeof job.payload !== "object" || job.payload === null
    || Array.isArray(job.payload)) reject("INVALID_JOB");
  const payload = job.payload as Record<string, unknown>;
  if (!exactKeys(payload, ["scheduledWindow"]) || !validWindow(payload.scheduledWindow)) {
    reject("INVALID_JOB");
  }
  return {
    scope: {
      organizationId: job.orgId,
      customerId: job.customerId,
      connectionId: job.connectionId,
    },
    scheduledWindow: payload.scheduledWindow,
  };
}

async function identityFor(
  boundary: SustainabilityCarbonServerBoundary,
  scheduledWindow: string,
): Promise<{
  readonly requestId: string;
  readonly expectedCaptureId: string;
  readonly sourceBoundarySha256: string;
}> {
  const sourceBoundarySha256 = await sha256(canonicalJson(boundary));
  const digest = await sha256(canonicalJson({
    schemaVersion: "sutra.sustainability-carbon-runtime-identity.v1",
    scheduledWindow,
    sourceBoundarySha256,
  }));
  return {
    requestId: `scr_${digest}`,
    expectedCaptureId: `sustainability_${digest}`,
    sourceBoundarySha256,
  };
}

function requestFor(
  boundary: SustainabilityCarbonServerBoundary,
  scheduledWindow: string,
  identity: Awaited<ReturnType<typeof identityFor>>,
): SustainabilityCarbonRuntimeRequest {
  return Object.freeze({
    schemaVersion: "sutra.sustainability-carbon-runtime-request.v1",
    requestId: identity.requestId,
    expectedCaptureId: identity.expectedCaptureId,
    scheduledWindow,
    scope: Object.freeze({ ...boundary.scope }),
    allowedUsageAccountIds: Object.freeze([...boundary.allowedUsageAccountIds]),
    credentials: "SERVER_OWNED_TRUST_ROLE_SESSION",
    channels: Object.freeze({
      proxy: Object.freeze({
        ...boundary.activeCur2,
        metricContract: SUSTAINABILITY_PROXY_METRIC_CONTRACT,
        interpretation: "RESOURCE_USE_PROXY_NOT_CARBON",
        conversionToMtco2e: false,
      }),
      providerCarbon: Object.freeze({
        ...boundary.carbonExport,
        expectedUsagePeriods: Object.freeze([...boundary.carbonExport.expectedUsagePeriods]),
        schemaColumns: AWS_CARBON_EMISSIONS_COLUMNS,
        interpretation: "PROVIDER_ESTIMATE_MTCO2E_NOT_WORKLOAD_ATTRIBUTION",
        allocateToCur2ResourcesOrTags: false,
        keepLbmAndMbmSeparate: true,
        keepTotalsAndScopesSeparate: true,
      }),
    }),
    objectReads: Object.freeze({
      current: SUSTAINABILITY_EXPORT_READ_ACTIONS,
      versioned: SUSTAINABILITY_VERSIONED_READ_ACTIONS,
      enforceExactPrefix: true,
      enforceExpectedBucketOwner: true,
    }),
    exhaustion: Object.freeze({
      requireProxyRowsExhaustionEvidence: true,
      requireCarbonObjectsExhaustionEvidence: true,
      requireCarbonRowsExhaustionEvidence: true,
      incompleteDeliveryDisposition: "PERSIST_HISTORY_NEVER_ADVANCE_HEAD",
    }),
    bounds: SUSTAINABILITY_CARBON_BOUNDS,
    archiveMaximumBytes: SUSTAINABILITY_CARBON_RUNTIME_ARCHIVE_MAX_BYTES,
    maximumDurationMs: SUSTAINABILITY_CARBON_RUNTIME_TIMEOUT_MS,
  });
}

function captureMatches(
  capture: SustainabilityCarbonCapture,
  boundary: SustainabilityCarbonServerBoundary,
  expectedCaptureId: string,
): boolean {
  const proxy = capture.proxyEvidence;
  const carbon = capture.carbonEvidence;
  return capture.captureId === expectedCaptureId
    && sameScope(capture.scope, boundary.scope)
    && JSON.stringify(capture.allowedUsageAccountIds)
      === JSON.stringify(boundary.allowedUsageAccountIds)
    && capture.configuration.cur2Configured === true
    && capture.configuration.carbonExportConfigured === true
    && capture.configuration.carbonExportAccessValidated === true
    && (proxy === null || (
      proxy.source === boundary.activeCur2.source
      && proxy.generationId === boundary.activeCur2.generationId
      && proxy.manifestSha256 === boundary.activeCur2.manifestSha256
      && proxy.dataThroughAtIso === boundary.activeCur2.dataThroughAtIso
    ))
    && (carbon === null || (
      carbon.source === boundary.carbonExport.source
      && carbon.tableName === boundary.carbonExport.tableName
      && carbon.exportName === boundary.carbonExport.exportName
      && carbon.exportArn === boundary.carbonExport.exportArn
      && carbon.exportRegion === boundary.carbonExport.exportRegion
      && carbon.bucket === boundary.carbonExport.bucket
      && `${carbon.prefix.replace(/\/+$/u, "")}/` === boundary.carbonExport.prefix
      && carbon.generationId === boundary.carbonExport.generationId
      && carbon.manifestSha256 === boundary.carbonExport.manifestSha256
      && JSON.stringify(carbon.schemaColumns)
        === JSON.stringify(boundary.carbonExport.schemaColumns)
      && carbon.publicationKind === boundary.carbonExport.publicationKind
      && carbon.publishedAtIso === boundary.carbonExport.publishedAtIso
      && JSON.stringify(carbon.allowedUsageAccountIds)
        === JSON.stringify(boundary.allowedUsageAccountIds)
      && JSON.stringify(carbon.expectedUsagePeriods)
        === JSON.stringify(boundary.carbonExport.expectedUsagePeriods)
    ));
}

async function acceptedMatches(
  accepted: SustainabilityCarbonAcceptedRuntimeAttempt,
  expected: {
    readonly scope: SustainabilityPersistenceScope;
    readonly boundary: SustainabilityCarbonServerBoundary;
    readonly requestId: string;
    readonly scheduledWindow: string;
    readonly sourceBoundarySha256: string;
    readonly captureId: string;
    readonly evidenceGenerationId?: string;
    readonly evidenceContentSha256?: string;
    readonly evidenceObjectId?: string;
    readonly reference?: { readonly ciphertext: string; readonly keyVersion: string };
  },
): Promise<boolean> {
  const stored = accepted.snapshot;
  const snapshotHash = await sha256(JSON.stringify(stored.snapshot));
  const expectedEvidenceGeneration = `fss_${await sha256(canonicalJson({
    schemaVersion: "sutra.sustainability-carbon-evidence-identity.v1",
    requestId: accepted.requestId,
    contentSha256: accepted.evidence.contentSha256,
  }))}`;
  return accepted.requestId === expected.requestId && REQUEST_ID.test(accepted.requestId)
    && accepted.scheduledWindow === expected.scheduledWindow
    && accepted.sourceBoundarySha256 === expected.sourceBoundarySha256
    && SHA256.test(accepted.sourceBoundarySha256)
    && samePersistenceScope(stored.scope, expected.scope)
    && sameScope(stored.snapshot.scope, expected.boundary.scope)
    && stored.snapshot.captureId === expected.captureId
    && CAPTURE_ID.test(stored.snapshot.captureId)
    && (stored.snapshot.proxy.evidence === null || (
      stored.snapshot.proxy.evidence.generationId
        === expected.boundary.activeCur2.generationId
      && stored.snapshot.proxy.evidence.manifestSha256
        === expected.boundary.activeCur2.manifestSha256
    ))
    && (stored.snapshot.providerCarbon.evidence === null || (
      stored.snapshot.providerCarbon.evidence.generationId
        === expected.boundary.carbonExport.generationId
      && stored.snapshot.providerCarbon.evidence.manifestSha256
        === expected.boundary.carbonExport.manifestSha256
      && stored.snapshot.providerCarbon.evidence.bucket
        === expected.boundary.carbonExport.bucket
      && `${stored.snapshot.providerCarbon.evidence.prefix.replace(/\/+$/u, "")}/`
        === expected.boundary.carbonExport.prefix
    ))
    && stored.contentSha256 === snapshotHash
    && stored.generationId === `scg_${snapshotHash}`
    && SNAPSHOT_GENERATION.test(stored.generationId)
    && accepted.evidence.generationId === expectedEvidenceGeneration
    && SOURCE_GENERATION.test(accepted.evidence.generationId)
    && EVIDENCE_OBJECT.test(accepted.evidence.objectId)
    && SHA256.test(accepted.evidence.contentSha256)
    && SEALED_REFERENCE.test(accepted.evidence.reference.ciphertext)
    && KEY_VERSION.test(accepted.evidence.reference.keyVersion)
    && (expected.evidenceGenerationId === undefined
      || accepted.evidence.generationId === expected.evidenceGenerationId)
    && (expected.evidenceContentSha256 === undefined
      || accepted.evidence.contentSha256 === expected.evidenceContentSha256)
    && (expected.evidenceObjectId === undefined
      || accepted.evidence.objectId === expected.evidenceObjectId)
    && (expected.reference === undefined
      || (accepted.evidence.reference.ciphertext === expected.reference.ciphertext
        && accepted.evidence.reference.keyVersion === expected.reference.keyVersion));
}

async function fail(
  dependencies: SustainabilityCarbonRuntimeDependencies,
  input: Parameters<SustainabilityCarbonImmutableEvidenceHandoff["recordFailure"]>[0],
): Promise<never> {
  try { await dependencies.handoff.recordFailure(input); } catch {
    // Raw provider and persistence diagnostics never cross the queue boundary.
  }
  throw new SustainabilityCarbonRuntimeBindingError(input.code);
}

export async function scheduleSustainabilityCarbonCollections(input: {
  readonly loadEligibleScopes: () => Promise<readonly SustainabilityPersistenceScope[]>;
  readonly queue: SustainabilityCarbonRuntimeQueue;
  readonly scheduledWindow: string;
}): Promise<{ readonly scheduledWindow: string; readonly enqueued: number }> {
  if (!validWindow(input.scheduledWindow)) reject("INVALID_JOB");
  let scopes: readonly SustainabilityPersistenceScope[];
  try { scopes = await input.loadEligibleScopes(); } catch { return reject("SCOPE_REJECTED"); }
  if (scopes.length > MAX_CONNECTIONS) reject("SCOPE_REJECTED");
  const ordered = [...scopes].sort((left, right) =>
    left.connectionId.localeCompare(right.connectionId));
  const seen = new Set<string>();
  for (const scope of ordered) {
    const key = `${scope.organizationId}\0${scope.customerId}\0${scope.connectionId}`;
    if (!validPersistenceScope(scope) || seen.has(key)) reject("SCOPE_REJECTED");
    seen.add(key);
    await input.queue.enqueue({
      orgId: scope.organizationId,
      customerId: scope.customerId,
      connectionId: scope.connectionId,
      kind: SUSTAINABILITY_CARBON_RUNTIME_JOB_KIND,
      payload: Object.freeze({ scheduledWindow: input.scheduledWindow }),
      maxAttempts: 5,
      idempotencyKey: `sustainability-carbon:${[
        scope.organizationId, scope.customerId, scope.connectionId,
        input.scheduledWindow,
      ].map(encodeURIComponent).join(":")}`,
    });
  }
  return { scheduledWindow: input.scheduledWindow, enqueued: ordered.length };
}

export async function runSustainabilityCarbonRuntimeHandler(
  job: RunnableJob,
  dependencies: SustainabilityCarbonRuntimeDependencies,
): Promise<SustainabilityCarbonRuntimeResult> {
  const parsed = parseJob(job);
  let boundary: SustainabilityCarbonServerBoundary | null;
  try { boundary = await dependencies.loadBoundary(parsed.scope); } catch {
    return reject("BOUNDARY_REJECTED");
  }
  if (boundary === null) {
    return { status: "unavailable", reason: SUSTAINABILITY_CARBON_RUNTIME_ACTIVATION_REASONS.boundary };
  }
  if (!validBoundary(boundary, parsed.scope)) reject("BOUNDARY_REJECTED");
  if (dependencies.materializer === null) {
    return { status: "unavailable", reason: SUSTAINABILITY_CARBON_RUNTIME_ACTIVATION_REASONS.adapter };
  }
  const identity = await identityFor(boundary, parsed.scheduledWindow);
  let prior: SustainabilityCarbonAcceptedRuntimeAttempt | null = null;
  try { prior = await dependencies.handoff.getAccepted(parsed.scope, identity.requestId); }
  catch {
    await fail(dependencies, {
      scope: parsed.scope, requestId: identity.requestId,
      scheduledWindow: parsed.scheduledWindow, code: "PERSISTENCE_REJECTED",
      completedAtMs: currentTime(dependencies.now),
    });
  }
  if (prior !== null) {
    if (!await acceptedMatches(prior, {
      scope: parsed.scope, boundary, requestId: identity.requestId,
      scheduledWindow: parsed.scheduledWindow,
      sourceBoundarySha256: identity.sourceBoundarySha256,
      captureId: identity.expectedCaptureId,
    })) reject("PERSISTENCE_REJECTED");
    return {
      status: "collected", generationId: prior.snapshot.generationId,
      evidenceGenerationId: prior.evidence.generationId,
      state: prior.snapshot.snapshot.state,
      proxyState: prior.snapshot.snapshot.proxy.state,
      carbonState: prior.snapshot.snapshot.providerCarbon.state,
      becameActive: false, replayed: true,
    };
  }
  const request = requestFor(boundary, parsed.scheduledWindow, identity);
  const requestBodySha256 = await sha256(canonicalJson(request));
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(), SUSTAINABILITY_CARBON_RUNTIME_TIMEOUT_MS,
  );
  let result: SustainabilityCarbonVerifiedMaterializerResult | null = null;
  try { result = await dependencies.materializer.collect(request, controller.signal); }
  catch {
    const code: SustainabilityCarbonRuntimeFailureCode = controller.signal.aborted
      ? "MATERIALIZER_TIMEOUT" : "MATERIALIZER_UNAVAILABLE";
    await fail(dependencies, {
      scope: parsed.scope, requestId: identity.requestId,
      scheduledWindow: parsed.scheduledWindow, code,
      completedAtMs: currentTime(dependencies.now),
    });
  } finally { clearTimeout(timeout); }
  if (result === null) reject("MATERIALIZER_UNAVAILABLE");
  const captureBodySha256 = await sha256(canonicalJson(result.capture));
  if (result.verification.authentication !== "ED25519_RESPONSE_SIGNATURE_VERIFIED"
    || result.verification.requestBodySha256 !== requestBodySha256
    || result.verification.captureBodySha256 !== captureBodySha256
    || !ADAPTER_KEY.test(result.verification.materializerKeyId)) {
    await fail(dependencies, {
      scope: parsed.scope, requestId: identity.requestId,
      scheduledWindow: parsed.scheduledWindow, code: "MATERIALIZER_AUTHENTICATION_FAILED",
      completedAtMs: currentTime(dependencies.now),
    });
  }
  const normalizedAt = currentTime(dependencies.now);
  let snapshot: SustainabilityCarbonSnapshot | null = null;
  try {
    if (!captureMatches(result.capture, boundary, identity.expectedCaptureId)) {
      throw new Error("sustainability-lineage-substitution");
    }
    snapshot = normalizeSustainabilityCarbonCapture(
      result.capture, boundary.scope, normalizedAt,
    );
  } catch {
    await fail(dependencies, {
      scope: parsed.scope, requestId: identity.requestId,
      scheduledWindow: parsed.scheduledWindow, code: "CAPTURE_REJECTED",
      completedAtMs: normalizedAt,
    });
  }
  if (snapshot === null) reject("CAPTURE_REJECTED");
  const body = new TextEncoder().encode(canonicalJson({
    schemaVersion: "sutra.sustainability-carbon-runtime-evidence.v1",
    separation: {
      proxy: "RESOURCE_USE_PROXY_NOT_CARBON",
      providerCarbon: "PROVIDER_ESTIMATE_MTCO2E_NOT_WORKLOAD_ATTRIBUTION",
      proxyToCarbonConversion: "FORBIDDEN",
      providerCarbonWorkloadAllocation: "FORBIDDEN",
    },
    sourceBoundary: boundary,
    request,
    verification: result.verification,
    capture: result.capture,
  }));
  if (body.byteLength > SUSTAINABILITY_CARBON_RUNTIME_ARCHIVE_MAX_BYTES) {
    await fail(dependencies, {
      scope: parsed.scope, requestId: identity.requestId,
      scheduledWindow: parsed.scheduledWindow, code: "EVIDENCE_REJECTED",
      completedAtMs: normalizedAt,
    });
  }
  const contentSha256 = await sha256(body);
  const evidenceGenerationId = `fss_${await sha256(canonicalJson({
    schemaVersion: "sutra.sustainability-carbon-evidence-identity.v1",
    requestId: identity.requestId,
    contentSha256,
  }))}`;
  let archived: Awaited<ReturnType<SustainabilityCarbonEvidenceArchive["archive"]>> | null = null;
  let reference: { readonly ciphertext: string; readonly keyVersion: string } | null = null;
  try {
    archived = await dependencies.evidence.archive({
      scope: {
        orgId: parsed.scope.organizationId,
        customerId: parsed.scope.customerId,
        connectionId: parsed.scope.connectionId,
      },
      runId: identity.requestId,
      snapshotId: evidenceGenerationId,
      artifactKind: "finops_source_snapshot",
      contentType: "application/json",
      body,
      createdBy: SUSTAINABILITY_CARBON_EVIDENCE_ACTOR_ID,
      now: normalizedAt,
    });
    if (archived.status !== "available" || !EVIDENCE_OBJECT.test(archived.id)
      || archived.contentSha256 !== contentSha256) {
      throw new Error("sustainability-evidence-archive-rejected");
    }
    reference = await dependencies.sealer.seal(archived.id, {
      organizationId: parsed.scope.organizationId,
      customerId: parsed.scope.customerId,
      connectionId: parsed.scope.connectionId,
      sourceId: SUSTAINABILITY_CARBON_EVIDENCE_SOURCE_ID,
      generationId: evidenceGenerationId,
    });
    if (!SEALED_REFERENCE.test(reference.ciphertext)
      || !KEY_VERSION.test(reference.keyVersion)) {
      throw new Error("sustainability-evidence-reference-rejected");
    }
  } catch {
    await fail(dependencies, {
      scope: parsed.scope, requestId: identity.requestId,
      scheduledWindow: parsed.scheduledWindow, code: "EVIDENCE_REJECTED",
      completedAtMs: normalizedAt,
    });
  }
  if (archived === null || reference === null) reject("EVIDENCE_REJECTED");
  const expectedEvidence = Object.freeze({
    generationId: evidenceGenerationId,
    objectId: archived.id,
    contentSha256,
    reference: Object.freeze({ ...reference }),
  });
  let committed: Awaited<ReturnType<SustainabilityCarbonImmutableEvidenceHandoff["commit"]>> | null = null;
  try {
    committed = await dependencies.handoff.commit({
      scope: parsed.scope, trustedScope: boundary.scope,
      requestId: identity.requestId, scheduledWindow: parsed.scheduledWindow,
      sourceBoundarySha256: identity.sourceBoundarySha256,
      capture: result.capture, normalizedSnapshot: snapshot,
      evidence: expectedEvidence, nowMs: normalizedAt,
    });
    if (!await acceptedMatches(committed.accepted, {
      scope: parsed.scope, boundary, requestId: identity.requestId,
      scheduledWindow: parsed.scheduledWindow,
      sourceBoundarySha256: identity.sourceBoundarySha256,
      captureId: identity.expectedCaptureId,
      evidenceGenerationId, evidenceContentSha256: contentSha256,
      evidenceObjectId: archived.id, reference,
    }) || canonicalJson(committed.accepted.snapshot.snapshot) !== canonicalJson(snapshot)) {
      throw new Error("sustainability-persistence-result-rejected");
    }
  } catch {
    await fail(dependencies, {
      scope: parsed.scope, requestId: identity.requestId,
      scheduledWindow: parsed.scheduledWindow, code: "PERSISTENCE_REJECTED",
      completedAtMs: normalizedAt,
    });
  }
  if (committed === null) reject("PERSISTENCE_REJECTED");
  return {
    status: "collected",
    generationId: committed.accepted.snapshot.generationId,
    evidenceGenerationId: committed.accepted.evidence.generationId,
    state: committed.accepted.snapshot.snapshot.state,
    proxyState: committed.accepted.snapshot.snapshot.proxy.state,
    carbonState: committed.accepted.snapshot.snapshot.providerCarbon.state,
    becameActive: committed.becameActive,
    replayed: false,
  };
}

export function createSustainabilityCarbonRuntimeJobHandler(
  dependencies: SustainabilityCarbonRuntimeDependencies,
): JobHandler {
  return async (job) => {
    const result = await runSustainabilityCarbonRuntimeHandler(job, dependencies);
    if (result.status === "unavailable") {
      throw new SustainabilityCarbonRuntimeBindingError("MATERIALIZER_UNAVAILABLE");
    }
  };
}

export const SUSTAINABILITY_CARBON_RUNTIME_BINDING = Object.freeze({
  jobKind: SUSTAINABILITY_CARBON_RUNTIME_JOB_KIND,
  cadence: SUSTAINABILITY_CARBON_RUNTIME_CADENCE,
  handlerFactory: createSustainabilityCarbonRuntimeJobHandler,
  registeredInSharedRuntime: false,
  activationReason: SUSTAINABILITY_CARBON_RUNTIME_ACTIVATION_REASONS.adapter,
});
