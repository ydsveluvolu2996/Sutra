/**
 * ADD-11 durable scheduler and signed Amazon Connect/CUR2 provider boundary.
 * Raw provider phone/contact data is forbidden outside the credential-owning
 * materializer. The normal application receives only aggregate inventory and
 * tenant-HMAC-tokenized CUR2 evidence.
 */
import type { JobHandler, RunnableJob } from "./background-job-runner.ts";
import { canonicalJson } from "./canonical-json.ts";
import {
  AMAZON_CONNECT_COST_INSIGHT_BOUNDS,
  AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS,
  normalizeAmazonConnectCostInsightCapture,
  type AmazonConnectCostBasis,
  type AmazonConnectCostInsightCapture,
  type AmazonConnectCostInsightSnapshot,
  type AmazonConnectScope,
} from "./finops-amazon-connect-cost-insight.ts";
import type {
  AmazonConnectCostInsightPersistenceScope,
  StoredAmazonConnectCostInsightSnapshot,
} from "../db/finops-amazon-connect-cost-insight-repository.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const SHA = /^[a-f0-9]{64}$/u;
const CUR2_GENERATION = /^fbg_[a-f0-9]{64}$/u;
const SOURCE_GENERATION = /^fss_[a-f0-9]{64}$/u;
const SNAPSHOT_GENERATION = /^acig_[a-f0-9]{64}$/u;
const REQUEST = /^acr_[a-f0-9]{64}$/u;
const CAPTURE = /^connect_[a-f0-9]{64}$/u;
const EVIDENCE_OBJECT = /^eobj_[a-f0-9]{32}$/u;
const SEALED_REFERENCE = /^fsev1\.[A-Za-z0-9_-]{26,8186}$/u;
const KEY_VERSION = /^key_[A-Za-z0-9._-]{1,63}$/u;
const SEAL_KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const MATERIALIZER_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const INSTANCE_ARN = /^arn:(aws|aws-cn|aws-us-gov):connect:([a-z0-9-]+):(\d{12}):instance\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;
const MAX_CONNECTIONS = 10_000;

export const AMAZON_CONNECT_COST_RUNTIME_JOB_KIND =
  "finops-amazon-connect-cost-insight-daily-collect";
export const AMAZON_CONNECT_COST_RUNTIME_CADENCE = "rate(1 day)";
export const AMAZON_CONNECT_COST_RUNTIME_TIMEOUT_MS =
  AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumDurationMs;
export const AMAZON_CONNECT_COST_RUNTIME_ARCHIVE_MAX_BYTES =
  AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumDashboardBytes;
export const AMAZON_CONNECT_COST_RUNTIME_ACTIVATION_REASONS = Object.freeze({
  boundary: "AMAZON_CONNECT_SERVER_PROVIDER_BOUNDARY_NOT_CONFIGURED",
  adapter: "AMAZON_CONNECT_SIGNED_MATERIALIZER_ADAPTER_NOT_DEPLOYED",
} as const);
export const AMAZON_CONNECT_COST_EVIDENCE_SOURCE_ID =
  "aws_amazon_connect_cost_insight" as const;
export const AMAZON_CONNECT_COST_EVIDENCE_ACTOR_ID =
  "finops-amazon-connect-cost-runtime" as const;

export interface AmazonConnectCur2RuntimeBoundary {
  readonly source: "AWS_CUR2_ACTIVE_GENERATION";
  readonly state: "ACTIVE_RECONCILED";
  readonly generationId: string;
  readonly sourceEvidenceId: string;
  readonly manifestSha256: string;
  readonly dataThroughAtIso: string;
  readonly costBasis: AmazonConnectCostBasis;
  readonly currency: string;
  readonly rowsExhausted: true;
  readonly contactResourceIdsIncluded: boolean;
  readonly activatedSystemTags: readonly (
    | "aws:connect:instanceId"
    | "aws:connect:systemEndpoint"
    | "aws:connect:transferredFromEndpoint"
  )[];
  readonly predicate:
    "PRODUCT_CODE_AMAZON_CONNECT_AND_CONTACT_CENTER_TELECOMMUNICATIONS";
  readonly classificationContractVersion: string;
  /** Official CID supporting-service spend needs a separate, broader plane. */
  readonly associatedServiceCoverage:
    "NOT_INCLUDED_SEPARATE_EVIDENCE_REQUIRED";
}

export interface AmazonConnectPermissionAttestation {
  readonly generationId: string;
  readonly contentSha256: string;
  readonly observedAtIso: string;
  readonly operations: typeof AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS;
  readonly resources: {
    readonly describeInstanceArns: readonly string[];
    readonly listPhoneNumbersArn: string;
    readonly directoryServiceResource: "*";
  };
  readonly denyMutationOperations: true;
}

export interface AmazonConnectCostRuntimeBoundary {
  readonly scope: AmazonConnectScope;
  readonly activeCur2: AmazonConnectCur2RuntimeBoundary;
  readonly permissionAttestation: AmazonConnectPermissionAttestation;
  readonly privacy: {
    readonly tokenization: "HMAC_SHA256_TENANT_SCOPED_ROTATING";
    readonly tokenKeyVersion: string;
    readonly contactDrilldownEnabled: boolean;
    readonly rawProviderPayloadRetention: "FORBIDDEN";
  };
}

export interface AmazonConnectCostRuntimeRequest {
  readonly schemaVersion: "sutra.amazon-connect-cost-runtime-request.v1";
  readonly requestId: string;
  readonly expectedCaptureId: string;
  readonly scheduledWindow: string;
  readonly scope: AmazonConnectScope;
  readonly credentials: "SERVER_OWNED_TRUST_ROLE_SESSION";
  readonly operations: typeof AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS;
  readonly permissionAttestation: AmazonConnectPermissionAttestation;
  readonly providerReads: {
    readonly describeOnlyAuthorizedInstanceArns: true;
    readonly listPhoneNumbersTargetArnRequired: true;
    readonly unscopedPhoneNumberListingForbidden: true;
    readonly trafficDistributionGroupsIncluded: false;
    readonly phonePageSize: 1_000;
    readonly rejectPaginationTokenReplay: true;
    readonly requirePerInstanceExhaustionEvidence: true;
  };
  readonly billing: AmazonConnectCur2RuntimeBoundary;
  readonly privacy: {
    readonly rawContactRecordsAccepted: false;
    readonly rawPhoneNumbersAccepted: false;
    readonly rawPhoneArnsOrIdsAccepted: false;
    readonly rawDescriptionsAccepted: false;
    readonly rawCallerIdentityAccepted: false;
    readonly rawEndpointAddressesAccepted: false;
    readonly rawDirectoryDetailsAccepted: false;
    readonly rawProviderErrorTextAccepted: false;
    readonly tokenization: "HMAC_SHA256_TENANT_SCOPED_ROTATING";
    readonly tokenKeyVersion: string;
    readonly contactDrilldownEnabled: boolean;
  };
  readonly incompleteDisposition: "PERSIST_HISTORY_NEVER_ADVANCE_HEAD";
  readonly bounds: typeof AMAZON_CONNECT_COST_INSIGHT_BOUNDS;
  readonly archiveMaximumBytes: typeof AMAZON_CONNECT_COST_RUNTIME_ARCHIVE_MAX_BYTES;
  readonly maximumDurationMs: typeof AMAZON_CONNECT_COST_RUNTIME_TIMEOUT_MS;
}

export interface AmazonConnectCostVerifiedMaterializerResult {
  readonly capture: AmazonConnectCostInsightCapture;
  readonly verification: {
    readonly authentication: "ED25519_RESPONSE_SIGNATURE_VERIFIED";
    readonly requestBodySha256: string;
    readonly captureBodySha256: string;
    readonly materializerKeyId: string;
  };
}

export interface AmazonConnectCostRuntimeMaterializer {
  collect(
    request: AmazonConnectCostRuntimeRequest,
    signal: AbortSignal,
  ): Promise<AmazonConnectCostVerifiedMaterializerResult>;
}

export interface AmazonConnectCostRuntimeQueue {
  enqueue(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly kind: typeof AMAZON_CONNECT_COST_RUNTIME_JOB_KIND;
    readonly payload: { readonly scheduledWindow: string };
    readonly maxAttempts: 5;
    readonly idempotencyKey: string;
  }): Promise<unknown>;
}

export interface AmazonConnectCostEvidenceArchive {
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
    readonly createdBy: typeof AMAZON_CONNECT_COST_EVIDENCE_ACTOR_ID;
    readonly now: number;
  }): Promise<{
    readonly id: string;
    readonly status: "staging" | "available" | "failed";
    readonly contentSha256: string;
  }>;
}

export interface AmazonConnectCostEvidenceSealer {
  seal(objectId: string, context: {
    readonly organizationId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly sourceId: typeof AMAZON_CONNECT_COST_EVIDENCE_SOURCE_ID;
    readonly generationId: string;
  }): Promise<{ readonly ciphertext: string; readonly keyVersion: string }>;
}

export interface AmazonConnectCostAcceptedRuntimeAttempt {
  readonly requestId: string;
  readonly scheduledWindow: string;
  readonly sourceBoundarySha256: string;
  readonly snapshot: StoredAmazonConnectCostInsightSnapshot;
  readonly evidence: {
    readonly generationId: string;
    readonly objectId: string;
    readonly contentSha256: string;
    readonly reference: { readonly ciphertext: string; readonly keyVersion: string };
  };
}

export type AmazonConnectCostRuntimeFailureCode =
  | "MATERIALIZER_AUTHENTICATION_FAILED"
  | "MATERIALIZER_TIMEOUT"
  | "MATERIALIZER_UNAVAILABLE"
  | "CAPTURE_REJECTED"
  | "EVIDENCE_REJECTED"
  | "PERSISTENCE_REJECTED";

export interface AmazonConnectCostImmutableEvidenceHandoff {
  getAccepted(
    scope: AmazonConnectCostInsightPersistenceScope,
    requestId: string,
  ): Promise<AmazonConnectCostAcceptedRuntimeAttempt | null>;
  commit(input: {
    readonly scope: AmazonConnectCostInsightPersistenceScope;
    readonly trustedScope: AmazonConnectScope;
    readonly requestId: string;
    readonly scheduledWindow: string;
    readonly sourceBoundarySha256: string;
    readonly capture: AmazonConnectCostInsightCapture;
    readonly normalizedSnapshot: AmazonConnectCostInsightSnapshot;
    readonly evidence: AmazonConnectCostAcceptedRuntimeAttempt["evidence"];
    readonly nowMs: number;
  }): Promise<{
    readonly accepted: AmazonConnectCostAcceptedRuntimeAttempt;
    readonly becameActive: boolean;
  }>;
  recordFailure(input: {
    readonly scope: AmazonConnectCostInsightPersistenceScope;
    readonly requestId: string;
    readonly scheduledWindow: string;
    readonly code: AmazonConnectCostRuntimeFailureCode;
    readonly completedAtMs: number;
  }): Promise<void>;
}

export interface AmazonConnectCostRuntimeDependencies {
  readonly loadBoundary: (
    scope: AmazonConnectCostInsightPersistenceScope,
  ) => Promise<AmazonConnectCostRuntimeBoundary | null>;
  readonly materializer: AmazonConnectCostRuntimeMaterializer | null;
  readonly evidence: AmazonConnectCostEvidenceArchive;
  readonly sealer: AmazonConnectCostEvidenceSealer;
  readonly handoff: AmazonConnectCostImmutableEvidenceHandoff;
  readonly now?: () => number;
}

export class AmazonConnectCostRuntimeBindingError extends Error {
  public readonly code:
    | "INVALID_JOB"
    | "SCOPE_REJECTED"
    | "BOUNDARY_REJECTED"
    | AmazonConnectCostRuntimeFailureCode;

  public constructor(code: AmazonConnectCostRuntimeBindingError["code"]) {
    super("Amazon Connect cost runtime collection failed");
    this.name = "AmazonConnectCostRuntimeBindingError";
    this.code = code;
  }
}

export type AmazonConnectCostRuntimeResult =
  | {
      readonly status: "unavailable";
      readonly reason: typeof AMAZON_CONNECT_COST_RUNTIME_ACTIVATION_REASONS[keyof
        typeof AMAZON_CONNECT_COST_RUNTIME_ACTIVATION_REASONS];
    }
  | {
      readonly status: "collected";
      readonly generationId: string;
      readonly evidenceGenerationId: string;
      readonly state: AmazonConnectCostInsightSnapshot["state"];
      readonly becameActive: boolean;
      readonly replayed: boolean;
    };

function reject(code: AmazonConnectCostRuntimeBindingError["code"]): never {
  throw new AmazonConnectCostRuntimeBindingError(code);
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

function validPersistenceScope(scope: AmazonConnectCostInsightPersistenceScope): boolean {
  return ID.test(scope.organizationId) && ID.test(scope.customerId)
    && CONNECTION.test(scope.connectionId);
}

function persistenceScope(scope: AmazonConnectScope): AmazonConnectCostInsightPersistenceScope {
  return {
    organizationId: scope.orgId,
    customerId: scope.customerId,
    connectionId: scope.connectionId,
  };
}

function samePersistenceScope(
  left: AmazonConnectCostInsightPersistenceScope,
  right: AmazonConnectCostInsightPersistenceScope,
): boolean {
  return left.organizationId === right.organizationId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId;
}

function sameScope(left: AmazonConnectScope, right: AmazonConnectScope): boolean {
  return left.orgId === right.orgId && left.customerId === right.customerId
    && left.connectionId === right.connectionId && left.accountId === right.accountId
    && left.partition === right.partition && left.region === right.region
    && JSON.stringify(left.instanceArns) === JSON.stringify(right.instanceArns);
}

function validInstanceArns(scope: AmazonConnectScope): boolean {
  return scope.instanceArns.length >= 1
    && scope.instanceArns.length <= AMAZON_CONNECT_COST_INSIGHT_BOUNDS.maximumAuthorizedInstances
    && new Set(scope.instanceArns).size === scope.instanceArns.length
    && JSON.stringify(scope.instanceArns) === JSON.stringify([...scope.instanceArns].sort())
    && scope.instanceArns.every((arn) => {
      const match = INSTANCE_ARN.exec(arn);
      return match !== null && match[1] === scope.partition
        && match[2] === scope.region && match[3] === scope.accountId;
    });
}

function validTags(tags: AmazonConnectCur2RuntimeBoundary["activatedSystemTags"]): boolean {
  const allowed = new Set([
    "aws:connect:instanceId",
    "aws:connect:systemEndpoint",
    "aws:connect:transferredFromEndpoint",
  ]);
  return tags.every((tag) => allowed.has(tag))
    && new Set(tags).size === tags.length
    && JSON.stringify(tags) === JSON.stringify([...tags].sort());
}

function validBoundary(
  value: AmazonConnectCostRuntimeBoundary,
  expected: AmazonConnectCostInsightPersistenceScope,
): boolean {
  const scope = value.scope;
  const billing = value.activeCur2;
  const attestation = value.permissionAttestation;
  const expectedPhoneArn = `arn:${scope.partition}:connect:${scope.region}:${scope.accountId}:phone-number/*`;
  return exactKeys(value, ["scope", "activeCur2", "permissionAttestation", "privacy"])
    && exactKeys(scope, [
      "orgId", "customerId", "connectionId", "accountId", "partition", "region",
      "instanceArns",
    ])
    && samePersistenceScope(persistenceScope(scope), expected)
    && ID.test(scope.orgId) && ID.test(scope.customerId)
    && CONNECTION.test(scope.connectionId) && ACCOUNT.test(scope.accountId)
    && new Set(["aws", "aws-cn", "aws-us-gov"]).has(scope.partition)
    && REGION.test(scope.region) && validInstanceArns(scope)
    && exactKeys(billing, [
      "source", "state", "generationId", "sourceEvidenceId", "manifestSha256",
      "dataThroughAtIso", "costBasis", "currency", "rowsExhausted",
      "contactResourceIdsIncluded", "activatedSystemTags", "predicate",
      "classificationContractVersion", "associatedServiceCoverage",
    ])
    && billing.source === "AWS_CUR2_ACTIVE_GENERATION"
    && billing.state === "ACTIVE_RECONCILED"
    && CUR2_GENERATION.test(billing.generationId)
    && SOURCE_GENERATION.test(billing.sourceEvidenceId)
    && SHA.test(billing.manifestSha256) && validIso(billing.dataThroughAtIso)
    && new Set(["UNBLENDED", "AMORTIZED", "NET_UNBLENDED", "NET_AMORTIZED"])
      .has(billing.costBasis)
    && CURRENCY.test(billing.currency) && billing.rowsExhausted === true
    && typeof billing.contactResourceIdsIncluded === "boolean"
    && validTags(billing.activatedSystemTags)
    && billing.predicate
      === "PRODUCT_CODE_AMAZON_CONNECT_AND_CONTACT_CENTER_TELECOMMUNICATIONS"
    && ID.test(billing.classificationContractVersion)
    && billing.associatedServiceCoverage
      === "NOT_INCLUDED_SEPARATE_EVIDENCE_REQUIRED"
    && exactKeys(attestation, [
      "generationId", "contentSha256", "observedAtIso", "operations", "resources",
      "denyMutationOperations",
    ])
    && SOURCE_GENERATION.test(attestation.generationId)
    && SHA.test(attestation.contentSha256) && validIso(attestation.observedAtIso)
    && JSON.stringify(attestation.operations)
      === JSON.stringify(AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS)
    && exactKeys(attestation.resources, [
      "describeInstanceArns", "listPhoneNumbersArn", "directoryServiceResource",
    ])
    && JSON.stringify(attestation.resources.describeInstanceArns)
      === JSON.stringify(scope.instanceArns)
    && attestation.resources.listPhoneNumbersArn === expectedPhoneArn
    && attestation.resources.directoryServiceResource === "*"
    && attestation.denyMutationOperations === true
    && exactKeys(value.privacy, [
      "tokenization", "tokenKeyVersion", "contactDrilldownEnabled",
      "rawProviderPayloadRetention",
    ])
    && value.privacy.tokenization === "HMAC_SHA256_TENANT_SCOPED_ROTATING"
    && KEY_VERSION.test(value.privacy.tokenKeyVersion)
    && typeof value.privacy.contactDrilldownEnabled === "boolean"
    && value.privacy.rawProviderPayloadRetention === "FORBIDDEN";
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
  readonly scope: AmazonConnectCostInsightPersistenceScope;
  readonly scheduledWindow: string;
} {
  if (job.kind !== AMAZON_CONNECT_COST_RUNTIME_JOB_KIND || job.customerId === null
    || job.connectionId === null || !ID.test(job.id) || !ID.test(job.orgId)
    || !ID.test(job.customerId) || !CONNECTION.test(job.connectionId)
    || !Number.isSafeInteger(job.attempt) || job.attempt < 1 || job.attempt > 5
    || job.maxAttempts !== 5
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
  boundary: AmazonConnectCostRuntimeBoundary,
  scheduledWindow: string,
): Promise<{
  readonly requestId: string;
  readonly expectedCaptureId: string;
  readonly sourceBoundarySha256: string;
}> {
  const sourceBoundarySha256 = await sha256(canonicalJson(boundary));
  const digest = await sha256(canonicalJson({
    schemaVersion: "sutra.amazon-connect-cost-runtime-identity.v1",
    scheduledWindow,
    sourceBoundarySha256,
  }));
  return {
    requestId: `acr_${digest}`,
    expectedCaptureId: `connect_${digest}`,
    sourceBoundarySha256,
  };
}

function requestFor(
  boundary: AmazonConnectCostRuntimeBoundary,
  scheduledWindow: string,
  identity: Awaited<ReturnType<typeof identityFor>>,
): AmazonConnectCostRuntimeRequest {
  return Object.freeze({
    schemaVersion: "sutra.amazon-connect-cost-runtime-request.v1",
    requestId: identity.requestId,
    expectedCaptureId: identity.expectedCaptureId,
    scheduledWindow,
    scope: Object.freeze({
      ...boundary.scope,
      instanceArns: Object.freeze([...boundary.scope.instanceArns]),
    }),
    credentials: "SERVER_OWNED_TRUST_ROLE_SESSION",
    operations: AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS,
    permissionAttestation: Object.freeze({
      ...boundary.permissionAttestation,
      operations: AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS,
      resources: Object.freeze({
        ...boundary.permissionAttestation.resources,
        describeInstanceArns: Object.freeze([
          ...boundary.permissionAttestation.resources.describeInstanceArns,
        ]),
      }),
    }),
    providerReads: Object.freeze({
      describeOnlyAuthorizedInstanceArns: true,
      listPhoneNumbersTargetArnRequired: true,
      unscopedPhoneNumberListingForbidden: true,
      trafficDistributionGroupsIncluded: false,
      phonePageSize: 1_000,
      rejectPaginationTokenReplay: true,
      requirePerInstanceExhaustionEvidence: true,
    }),
    billing: Object.freeze({
      ...boundary.activeCur2,
      activatedSystemTags: Object.freeze([...boundary.activeCur2.activatedSystemTags]),
    }),
    privacy: Object.freeze({
      rawContactRecordsAccepted: false,
      rawPhoneNumbersAccepted: false,
      rawPhoneArnsOrIdsAccepted: false,
      rawDescriptionsAccepted: false,
      rawCallerIdentityAccepted: false,
      rawEndpointAddressesAccepted: false,
      rawDirectoryDetailsAccepted: false,
      rawProviderErrorTextAccepted: false,
      tokenization: "HMAC_SHA256_TENANT_SCOPED_ROTATING",
      tokenKeyVersion: boundary.privacy.tokenKeyVersion,
      contactDrilldownEnabled: boundary.privacy.contactDrilldownEnabled,
    }),
    incompleteDisposition: "PERSIST_HISTORY_NEVER_ADVANCE_HEAD",
    bounds: AMAZON_CONNECT_COST_INSIGHT_BOUNDS,
    archiveMaximumBytes: AMAZON_CONNECT_COST_RUNTIME_ARCHIVE_MAX_BYTES,
    maximumDurationMs: AMAZON_CONNECT_COST_RUNTIME_TIMEOUT_MS,
  });
}

function captureMatches(
  capture: AmazonConnectCostInsightCapture,
  boundary: AmazonConnectCostRuntimeBoundary,
  expectedCaptureId: string,
): boolean {
  const billing = capture.costEvidence;
  return capture.captureId === expectedCaptureId
    && sameScope(capture.scope, boundary.scope)
    && capture.privacy.rawContactRecordsAccepted === false
    && capture.privacy.rawPhoneNumbersAccepted === false
    && capture.privacy.tokenization === boundary.privacy.tokenization
    && capture.privacy.tokenKeyVersion === boundary.privacy.tokenKeyVersion
    && capture.privacy.contactDrilldownEnabled
      === boundary.privacy.contactDrilldownEnabled
    && billing.source === boundary.activeCur2.source
    && billing.generationId === boundary.activeCur2.generationId
    && billing.manifestSha256 === boundary.activeCur2.manifestSha256
    && billing.dataThroughAtIso === boundary.activeCur2.dataThroughAtIso
    && billing.costBasis === boundary.activeCur2.costBasis
    && billing.currency === boundary.activeCur2.currency
    && billing.contactResourceIdsIncluded
      === boundary.activeCur2.contactResourceIdsIncluded
    && JSON.stringify(billing.activatedSystemTags)
      === JSON.stringify(boundary.activeCur2.activatedSystemTags)
    && JSON.stringify(capture.collections.map((item) => item.instanceArn))
      === JSON.stringify(boundary.scope.instanceArns);
}

async function acceptedMatches(
  accepted: AmazonConnectCostAcceptedRuntimeAttempt,
  expected: {
    readonly scope: AmazonConnectCostInsightPersistenceScope;
    readonly boundary: AmazonConnectCostRuntimeBoundary;
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
  const billing = stored.snapshot.costEvidence;
  const snapshotHash = await sha256(JSON.stringify(stored.snapshot));
  const expectedEvidenceGeneration = `fss_${await sha256(canonicalJson({
    schemaVersion: "sutra.amazon-connect-cost-runtime-evidence-identity.v1",
    requestId: accepted.requestId,
    contentSha256: accepted.evidence.contentSha256,
  }))}`;
  return accepted.requestId === expected.requestId && REQUEST.test(accepted.requestId)
    && accepted.scheduledWindow === expected.scheduledWindow
    && accepted.sourceBoundarySha256 === expected.sourceBoundarySha256
    && SHA.test(accepted.sourceBoundarySha256)
    && samePersistenceScope(stored.scope, expected.scope)
    && sameScope(stored.snapshot.scope, expected.boundary.scope)
    && stored.snapshot.captureId === expected.captureId
    && CAPTURE.test(stored.snapshot.captureId)
    && billing.generationId === expected.boundary.activeCur2.generationId
    && billing.manifestSha256 === expected.boundary.activeCur2.manifestSha256
    && billing.dataThroughAtIso === expected.boundary.activeCur2.dataThroughAtIso
    && billing.costBasis === expected.boundary.activeCur2.costBasis
    && billing.currency === expected.boundary.activeCur2.currency
    && stored.snapshot.privacy.tokenKeyVersion
      === expected.boundary.privacy.tokenKeyVersion
    && stored.snapshot.privacy.contactDrilldownEnabled
      === expected.boundary.privacy.contactDrilldownEnabled
    && stored.contentSha256 === snapshotHash
    && stored.generationId === `acig_${snapshotHash}`
    && SNAPSHOT_GENERATION.test(stored.generationId)
    && accepted.evidence.generationId === expectedEvidenceGeneration
    && SOURCE_GENERATION.test(accepted.evidence.generationId)
    && EVIDENCE_OBJECT.test(accepted.evidence.objectId)
    && SHA.test(accepted.evidence.contentSha256)
    && SEALED_REFERENCE.test(accepted.evidence.reference.ciphertext)
    && SEAL_KEY_VERSION.test(accepted.evidence.reference.keyVersion)
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
  dependencies: AmazonConnectCostRuntimeDependencies,
  input: Parameters<AmazonConnectCostImmutableEvidenceHandoff["recordFailure"]>[0],
): Promise<never> {
  try { await dependencies.handoff.recordFailure(input); } catch {
    // Raw provider and persistence diagnostics never cross the job boundary.
  }
  throw new AmazonConnectCostRuntimeBindingError(input.code);
}

export async function scheduleAmazonConnectCostCollections(input: {
  readonly loadEligibleScopes: () =>
    Promise<readonly AmazonConnectCostInsightPersistenceScope[]>;
  readonly queue: AmazonConnectCostRuntimeQueue;
  readonly scheduledWindow: string;
}): Promise<{ readonly scheduledWindow: string; readonly enqueued: number }> {
  if (!validWindow(input.scheduledWindow)) reject("INVALID_JOB");
  let scopes: readonly AmazonConnectCostInsightPersistenceScope[];
  try { scopes = await input.loadEligibleScopes(); } catch { return reject("SCOPE_REJECTED"); }
  if (scopes.length > MAX_CONNECTIONS) reject("SCOPE_REJECTED");
  const ordered = [...scopes].sort((left, right) =>
    left.connectionId.localeCompare(right.connectionId));
  const seen = new Set<string>();
  for (const scope of ordered) {
    const key = `${scope.organizationId}\0${scope.customerId}\0${scope.connectionId}`;
    if (!validPersistenceScope(scope) || seen.has(key)) reject("SCOPE_REJECTED");
    seen.add(key);
  }
  for (const scope of ordered) {
    await input.queue.enqueue({
      orgId: scope.organizationId,
      customerId: scope.customerId,
      connectionId: scope.connectionId,
      kind: AMAZON_CONNECT_COST_RUNTIME_JOB_KIND,
      payload: Object.freeze({ scheduledWindow: input.scheduledWindow }),
      maxAttempts: 5,
      idempotencyKey: `amazon-connect-cost:${[
        scope.organizationId, scope.customerId, scope.connectionId,
        input.scheduledWindow,
      ].map(encodeURIComponent).join(":")}`,
    });
  }
  return { scheduledWindow: input.scheduledWindow, enqueued: ordered.length };
}

export async function runAmazonConnectCostRuntimeHandler(
  job: RunnableJob,
  dependencies: AmazonConnectCostRuntimeDependencies,
): Promise<AmazonConnectCostRuntimeResult> {
  const parsed = parseJob(job);
  let boundary: AmazonConnectCostRuntimeBoundary | null;
  try { boundary = await dependencies.loadBoundary(parsed.scope); } catch {
    return reject("BOUNDARY_REJECTED");
  }
  if (boundary === null) {
    return { status: "unavailable", reason: AMAZON_CONNECT_COST_RUNTIME_ACTIVATION_REASONS.boundary };
  }
  if (!validBoundary(boundary, parsed.scope)) reject("BOUNDARY_REJECTED");
  if (dependencies.materializer === null) {
    return { status: "unavailable", reason: AMAZON_CONNECT_COST_RUNTIME_ACTIVATION_REASONS.adapter };
  }
  const identity = await identityFor(boundary, parsed.scheduledWindow);
  let prior: AmazonConnectCostAcceptedRuntimeAttempt | null = null;
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
      state: prior.snapshot.snapshot.state, becameActive: false, replayed: true,
    };
  }
  const request = requestFor(boundary, parsed.scheduledWindow, identity);
  const requestHash = await sha256(canonicalJson(request));
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(), AMAZON_CONNECT_COST_RUNTIME_TIMEOUT_MS,
  );
  let result: AmazonConnectCostVerifiedMaterializerResult | null = null;
  try { result = await dependencies.materializer.collect(request, controller.signal); }
  catch {
    const code: AmazonConnectCostRuntimeFailureCode = controller.signal.aborted
      ? "MATERIALIZER_TIMEOUT" : "MATERIALIZER_UNAVAILABLE";
    await fail(dependencies, {
      scope: parsed.scope, requestId: identity.requestId,
      scheduledWindow: parsed.scheduledWindow, code,
      completedAtMs: currentTime(dependencies.now),
    });
  } finally { clearTimeout(timeout); }
  if (result === null) reject("MATERIALIZER_UNAVAILABLE");
  const captureHash = await sha256(canonicalJson(result.capture));
  if (result.verification.authentication !== "ED25519_RESPONSE_SIGNATURE_VERIFIED"
    || result.verification.requestBodySha256 !== requestHash
    || result.verification.captureBodySha256 !== captureHash
    || !MATERIALIZER_KEY.test(result.verification.materializerKeyId)) {
    await fail(dependencies, {
      scope: parsed.scope, requestId: identity.requestId,
      scheduledWindow: parsed.scheduledWindow,
      code: "MATERIALIZER_AUTHENTICATION_FAILED",
      completedAtMs: currentTime(dependencies.now),
    });
  }
  const normalizedAt = currentTime(dependencies.now);
  let snapshot: AmazonConnectCostInsightSnapshot | null = null;
  try {
    if (!captureMatches(result.capture, boundary, identity.expectedCaptureId)) {
      throw new Error("amazon-connect-runtime-lineage-mismatch");
    }
    snapshot = normalizeAmazonConnectCostInsightCapture(
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
    schemaVersion: "sutra.amazon-connect-cost-runtime-evidence.v1",
    sourceBoundary: boundary,
    request,
    verification: result.verification,
    capture: result.capture,
    privacyDisposition: {
      rawPhoneAndContactPayloads: "FORBIDDEN",
      providerErrorText: "FORBIDDEN",
      standardUiTokens: "FORBIDDEN",
    },
  }));
  if (body.byteLength > AMAZON_CONNECT_COST_RUNTIME_ARCHIVE_MAX_BYTES) {
    await fail(dependencies, {
      scope: parsed.scope, requestId: identity.requestId,
      scheduledWindow: parsed.scheduledWindow, code: "EVIDENCE_REJECTED",
      completedAtMs: normalizedAt,
    });
  }
  const contentSha256 = await sha256(body);
  const evidenceGenerationId = `fss_${await sha256(canonicalJson({
    schemaVersion: "sutra.amazon-connect-cost-runtime-evidence-identity.v1",
    requestId: identity.requestId,
    contentSha256,
  }))}`;
  let archived: Awaited<ReturnType<AmazonConnectCostEvidenceArchive["archive"]>> | null = null;
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
      createdBy: AMAZON_CONNECT_COST_EVIDENCE_ACTOR_ID,
      now: normalizedAt,
    });
    if (archived.status !== "available" || !EVIDENCE_OBJECT.test(archived.id)
      || archived.contentSha256 !== contentSha256) {
      throw new Error("amazon-connect-evidence-archive-rejected");
    }
    reference = await dependencies.sealer.seal(archived.id, {
      organizationId: parsed.scope.organizationId,
      customerId: parsed.scope.customerId,
      connectionId: parsed.scope.connectionId,
      sourceId: AMAZON_CONNECT_COST_EVIDENCE_SOURCE_ID,
      generationId: evidenceGenerationId,
    });
    if (!SEALED_REFERENCE.test(reference.ciphertext)
      || !SEAL_KEY_VERSION.test(reference.keyVersion)) {
      throw new Error("amazon-connect-evidence-reference-rejected");
    }
  } catch {
    await fail(dependencies, {
      scope: parsed.scope, requestId: identity.requestId,
      scheduledWindow: parsed.scheduledWindow, code: "EVIDENCE_REJECTED",
      completedAtMs: normalizedAt,
    });
  }
  if (archived === null || reference === null) reject("EVIDENCE_REJECTED");
  const evidence = Object.freeze({
    generationId: evidenceGenerationId, objectId: archived.id,
    contentSha256, reference: Object.freeze({ ...reference }),
  });
  let committed: Awaited<ReturnType<AmazonConnectCostImmutableEvidenceHandoff["commit"]>> | null = null;
  try {
    committed = await dependencies.handoff.commit({
      scope: parsed.scope, trustedScope: boundary.scope,
      requestId: identity.requestId, scheduledWindow: parsed.scheduledWindow,
      sourceBoundarySha256: identity.sourceBoundarySha256,
      capture: result.capture, normalizedSnapshot: snapshot,
      evidence, nowMs: normalizedAt,
    });
    if (!await acceptedMatches(committed.accepted, {
      scope: parsed.scope, boundary, requestId: identity.requestId,
      scheduledWindow: parsed.scheduledWindow,
      sourceBoundarySha256: identity.sourceBoundarySha256,
      captureId: identity.expectedCaptureId,
      evidenceGenerationId, evidenceContentSha256: contentSha256,
      evidenceObjectId: archived.id, reference,
    }) || canonicalJson(committed.accepted.snapshot.snapshot) !== canonicalJson(snapshot)) {
      throw new Error("amazon-connect-persistence-result-rejected");
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
    becameActive: committed.becameActive,
    replayed: false,
  };
}

export function createAmazonConnectCostRuntimeJobHandler(
  dependencies: AmazonConnectCostRuntimeDependencies,
): JobHandler {
  return async (job) => {
    const result = await runAmazonConnectCostRuntimeHandler(job, dependencies);
    if (result.status === "unavailable") {
      throw new AmazonConnectCostRuntimeBindingError("MATERIALIZER_UNAVAILABLE");
    }
  };
}

export const AMAZON_CONNECT_COST_RUNTIME_BINDING = Object.freeze({
  jobKind: AMAZON_CONNECT_COST_RUNTIME_JOB_KIND,
  cadence: AMAZON_CONNECT_COST_RUNTIME_CADENCE,
  handlerFactory: createAmazonConnectCostRuntimeJobHandler,
  registeredInSharedRuntime: false,
  activationReason: AMAZON_CONNECT_COST_RUNTIME_ACTIVATION_REASONS.adapter,
});
