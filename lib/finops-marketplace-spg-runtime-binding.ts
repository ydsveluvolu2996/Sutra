/** ADD-05 permanent scheduler and signed-broker runtime boundary. */
import type { JobHandler, RunnableJob } from "./background-job-runner.ts";
import { canonicalJson } from "./canonical-json.ts";
import {
  AWS_MARKETPLACE_ACCOUNT_COVERAGE_IAM_ACTIONS,
  AWS_MARKETPLACE_AGREEMENT_REGION,
  AWS_MARKETPLACE_BUYER_API_OPERATIONS,
  AWS_MARKETPLACE_DISCOVERY_REGION,
  AWS_MARKETPLACE_LICENSE_MANAGER_API_OPERATIONS,
  AWS_MARKETPLACE_SPG_COLLECTION_BOUNDS,
  normalizeAwsMarketplaceSpgCapture,
  type AwsMarketplaceSpgCapture,
  type AwsMarketplaceSpgScope,
  type AwsMarketplaceSpgSnapshot,
} from "./finops-marketplace-spg.ts";
import type {
  AwsMarketplaceSpgPersistenceScope,
  StoredAwsMarketplaceSpgSnapshot,
} from "../db/finops-marketplace-spg-repository.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const JOB = /^job_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u;
const ORGANIZATION = /^o-[a-z0-9]{10,32}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const REQUEST_ID = /^mpr_[a-f0-9]{64}$/u;
const CAPTURE_ID = /^marketplace_[a-f0-9]{64}$/u;
const BILLING_GENERATION = /^fbg_[a-f0-9]{64}$/u;
const SOURCE_GENERATION = /^fss_[a-f0-9]{64}$/u;
const SNAPSHOT_GENERATION = /^mspg_[a-f0-9]{64}$/u;
const EVIDENCE_OBJECT = /^eobj_[a-f0-9]{32}$/u;
const SEALED_REFERENCE = /^fsev1\.[A-Za-z0-9_-]{26,8186}$/u;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const BROKER_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MAX_CONNECTIONS = 10_000;

export const MARKETPLACE_SPG_RUNTIME_JOB_KIND =
  "finops-marketplace-spg-daily-collect";
export const MARKETPLACE_SPG_RUNTIME_CADENCE = "rate(1 day)";
export const MARKETPLACE_SPG_RUNTIME_TIMEOUT_MS = 15 * 60 * 1_000;
export const MARKETPLACE_SPG_RUNTIME_ARCHIVE_MAX_BYTES = 11 * 1_024 * 1_024;
export const MARKETPLACE_SPG_RUNTIME_ACTIVATION_REASONS = Object.freeze({
  boundary: "MARKETPLACE_SERVER_SOURCE_BOUNDARY_NOT_CONFIGURED",
  adapter: "MARKETPLACE_SIGNED_BROKER_ADAPTER_NOT_DEPLOYED",
} as const);
export const MARKETPLACE_SPG_EVIDENCE_SOURCE_ID =
  "aws_marketplace_intelligence" as const;
export const MARKETPLACE_SPG_EVIDENCE_ACTOR_ID =
  "finops-marketplace-spg-runtime" as const;

export interface MarketplaceSpgAccountCoverageBoundary {
  readonly basis: "AWS_ORGANIZATIONS_ACTIVE_ACCOUNTS";
  readonly evidenceGenerationId: string;
  readonly contentSha256: string;
  readonly observedAt: string;
  readonly expectedAccountIds: readonly string[];
}

export interface MarketplaceSpgActiveCur2Boundary {
  readonly source: "ACTIVE_RECONCILED_CUR2_GENERATION";
  readonly generationId: string;
  readonly sourceEvidenceId: string;
  readonly manifestSha256: string;
  readonly dataThroughAt: string;
  readonly reconciliationState: "reconciled";
  readonly predicate:
    | "CUR2_BILLING_ENTITY_AWS_MARKETPLACE"
    | "CUR2_PRODUCT_FAMILY_AWS_MARKETPLACE";
  readonly allowedLinkedAccountIds: readonly string[];
  readonly rowsExhausted: true;
  readonly amountColumns: "BILLED_AND_AMORTIZED_SEPARATE";
  readonly currencyHandling: "MULTI_CURRENCY_ROW_LEVEL";
}

export interface MarketplaceSpgServerBoundary {
  readonly scope: AwsMarketplaceSpgScope & {
    readonly partition: "aws";
    readonly awsOrganizationId: string;
  };
  readonly accountCoverage: MarketplaceSpgAccountCoverageBoundary;
  readonly licenseManager: {
    readonly collectionMode: "ORGANIZATION";
    readonly region: string;
    readonly organizationIntegrationRequired: true;
    readonly crossAccountDiscoveryRequired: true;
  };
  readonly activeCur2: MarketplaceSpgActiveCur2Boundary;
}

export interface MarketplaceSpgRuntimeBrokerRequest {
  readonly schemaVersion: "sutra.marketplace-spg-runtime-request.v1";
  readonly requestId: string;
  readonly expectedCaptureId: string;
  readonly scheduledWindow: string;
  readonly scope: MarketplaceSpgServerBoundary["scope"];
  readonly accountCoverage: MarketplaceSpgAccountCoverageBoundary;
  readonly buyerOperations: typeof AWS_MARKETPLACE_BUYER_API_OPERATIONS;
  readonly licenseOperations: typeof AWS_MARKETPLACE_LICENSE_MANAGER_API_OPERATIONS;
  readonly accountCoverageActions:
    typeof AWS_MARKETPLACE_ACCOUNT_COVERAGE_IAM_ACTIONS;
  readonly endpoints: {
    readonly agreementRegion: typeof AWS_MARKETPLACE_AGREEMENT_REGION;
    readonly discoveryRegion: typeof AWS_MARKETPLACE_DISCOVERY_REGION;
    readonly licenseManagerRegion: string;
  };
  readonly buyerParty: "Acceptor";
  readonly billing: MarketplaceSpgActiveCur2Boundary;
  readonly pagination: {
    readonly agreementPageSize: 50;
    readonly licenseManagerPageSize: 100;
    readonly maximumPagesPerSequence: 5_000;
    readonly rejectTokenReplay: true;
    readonly requireExhaustionEvidence: true;
  };
  readonly privacy: {
    readonly includeRegistrationTokens: false;
    readonly includePurchaseOrderReferences: false;
    readonly includeLegalDocumentsOrUrls: false;
    readonly includeContacts: false;
    readonly includeProviderErrorText: false;
    readonly includeTemporaryEmbedUrls: false;
  };
  readonly bounds: typeof AWS_MARKETPLACE_SPG_COLLECTION_BOUNDS;
  readonly archiveMaximumBytes: typeof MARKETPLACE_SPG_RUNTIME_ARCHIVE_MAX_BYTES;
  readonly maximumDurationMs: typeof MARKETPLACE_SPG_RUNTIME_TIMEOUT_MS;
}

export interface MarketplaceSpgVerifiedBrokerResult {
  readonly capture: AwsMarketplaceSpgCapture;
  readonly verification: {
    readonly authentication: "ED25519_RESPONSE_SIGNATURE_VERIFIED";
    readonly requestBodySha256: string;
    readonly captureBodySha256: string;
    readonly brokerKeyId: string;
  };
}

export interface MarketplaceSpgRuntimeSignedBroker {
  collect(
    request: MarketplaceSpgRuntimeBrokerRequest,
    signal: AbortSignal,
  ): Promise<MarketplaceSpgVerifiedBrokerResult>;
}

export interface MarketplaceSpgRuntimeQueue {
  enqueue(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly kind: typeof MARKETPLACE_SPG_RUNTIME_JOB_KIND;
    readonly payload: { readonly scheduledWindow: string };
    readonly maxAttempts: 5;
    readonly idempotencyKey: string;
  }): Promise<unknown>;
}

export interface MarketplaceSpgEvidenceArchive {
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
    readonly createdBy: typeof MARKETPLACE_SPG_EVIDENCE_ACTOR_ID;
    readonly now: number;
  }): Promise<{
    readonly id: string;
    readonly status: "staging" | "available" | "failed";
    readonly contentSha256: string;
  }>;
}

export interface MarketplaceSpgEvidenceSealer {
  seal(objectId: string, context: {
    readonly organizationId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly sourceId: typeof MARKETPLACE_SPG_EVIDENCE_SOURCE_ID;
    readonly generationId: string;
  }): Promise<{ readonly ciphertext: string; readonly keyVersion: string }>;
}

export interface MarketplaceSpgAcceptedRuntimeAttempt {
  readonly requestId: string;
  readonly scheduledWindow: string;
  readonly sourceBoundarySha256: string;
  readonly snapshot: StoredAwsMarketplaceSpgSnapshot;
  readonly evidence: {
    readonly generationId: string;
    readonly objectId: string;
    readonly contentSha256: string;
    readonly reference: { readonly ciphertext: string; readonly keyVersion: string };
  };
}

export type MarketplaceSpgRuntimeFailureCode =
  | "BROKER_AUTHENTICATION_FAILED"
  | "BROKER_TIMEOUT"
  | "BROKER_UNAVAILABLE"
  | "BROKER_RESPONSE_REJECTED"
  | "CAPTURE_REJECTED"
  | "EVIDENCE_REJECTED"
  | "PERSISTENCE_REJECTED";

export interface MarketplaceSpgImmutableEvidenceHandoff {
  getAccepted(
    scope: AwsMarketplaceSpgPersistenceScope,
    requestId: string,
  ): Promise<MarketplaceSpgAcceptedRuntimeAttempt | null>;
  commit(input: {
    readonly scope: AwsMarketplaceSpgPersistenceScope;
    readonly trustedScope: MarketplaceSpgServerBoundary["scope"];
    readonly requestId: string;
    readonly scheduledWindow: string;
    readonly sourceBoundarySha256: string;
    readonly capture: AwsMarketplaceSpgCapture;
    readonly normalizedSnapshot: AwsMarketplaceSpgSnapshot;
    readonly evidence: MarketplaceSpgAcceptedRuntimeAttempt["evidence"];
    readonly nowMs: number;
  }): Promise<{
    readonly accepted: MarketplaceSpgAcceptedRuntimeAttempt;
    readonly becameActive: boolean;
  }>;
  recordFailure(input: {
    readonly scope: AwsMarketplaceSpgPersistenceScope;
    readonly requestId: string;
    readonly scheduledWindow: string;
    readonly code: MarketplaceSpgRuntimeFailureCode;
    readonly completedAtMs: number;
  }): Promise<void>;
}

export interface MarketplaceSpgRuntimeDependencies {
  readonly loadBoundary: (
    scope: AwsMarketplaceSpgPersistenceScope,
  ) => Promise<MarketplaceSpgServerBoundary | null>;
  readonly broker: MarketplaceSpgRuntimeSignedBroker | null;
  readonly evidence: MarketplaceSpgEvidenceArchive;
  readonly sealer: MarketplaceSpgEvidenceSealer;
  readonly handoff: MarketplaceSpgImmutableEvidenceHandoff;
  readonly now?: () => number;
}

export class MarketplaceSpgRuntimeBindingError extends Error {
  public readonly code:
    | "INVALID_JOB"
    | "SCOPE_REJECTED"
    | "BOUNDARY_REJECTED"
    | MarketplaceSpgRuntimeFailureCode;

  public constructor(code: MarketplaceSpgRuntimeBindingError["code"]) {
    super("Marketplace SPG runtime collection failed");
    this.name = "MarketplaceSpgRuntimeBindingError";
    this.code = code;
  }
}

export type MarketplaceSpgRuntimeResult =
  | {
      readonly status: "unavailable";
      readonly reason: typeof MARKETPLACE_SPG_RUNTIME_ACTIVATION_REASONS[keyof
        typeof MARKETPLACE_SPG_RUNTIME_ACTIVATION_REASONS];
    }
  | {
      readonly status: "collected";
      readonly generationId: string;
      readonly evidenceGenerationId: string;
      readonly state: AwsMarketplaceSpgSnapshot["state"];
      readonly becameActive: boolean;
      readonly replayed: boolean;
    };

function reject(code: MarketplaceSpgRuntimeBindingError["code"]): never {
  throw new MarketplaceSpgRuntimeBindingError(code);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort())
    === JSON.stringify([...keys].sort());
}

function validIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validWindow(value: unknown): value is string {
  return typeof value === "string" && WINDOW.test(value) && validIso(value);
}

function validPersistenceScope(scope: AwsMarketplaceSpgPersistenceScope): boolean {
  return IDENTIFIER.test(scope.organizationId)
    && IDENTIFIER.test(scope.customerId)
    && CONNECTION.test(scope.connectionId);
}

function persistenceScope(scope: AwsMarketplaceSpgScope): AwsMarketplaceSpgPersistenceScope {
  return {
    organizationId: scope.orgId,
    customerId: scope.customerId,
    connectionId: scope.connectionId,
  };
}

function samePersistenceScope(
  left: AwsMarketplaceSpgPersistenceScope,
  right: AwsMarketplaceSpgPersistenceScope,
): boolean {
  return left.organizationId === right.organizationId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId;
}

function sameScope(left: AwsMarketplaceSpgScope, right: AwsMarketplaceSpgScope): boolean {
  return left.orgId === right.orgId && left.customerId === right.customerId
    && left.connectionId === right.connectionId && left.accountId === right.accountId
    && left.partition === right.partition
    && left.awsOrganizationId === right.awsOrganizationId;
}

function sortedAccounts(values: readonly string[]): boolean {
  return values.length > 0
    && values.length <= AWS_MARKETPLACE_SPG_COLLECTION_BOUNDS.maximumOrganizationAccounts
    && values.every((value) => ACCOUNT.test(value))
    && new Set(values).size === values.length
    && JSON.stringify(values) === JSON.stringify([...values].sort());
}

function validBoundary(
  value: MarketplaceSpgServerBoundary,
  expected: AwsMarketplaceSpgPersistenceScope,
): boolean {
  const scope = value.scope;
  const coverage = value.accountCoverage;
  const license = value.licenseManager;
  const cur2 = value.activeCur2;
  return exactKeys(value, ["scope", "accountCoverage", "licenseManager", "activeCur2"])
    && exactKeys(scope, [
      "orgId", "customerId", "connectionId", "accountId", "partition",
      "awsOrganizationId",
    ])
    && samePersistenceScope(persistenceScope(scope), expected)
    && IDENTIFIER.test(scope.orgId) && IDENTIFIER.test(scope.customerId)
    && CONNECTION.test(scope.connectionId) && ACCOUNT.test(scope.accountId)
    && scope.partition === "aws" && ORGANIZATION.test(scope.awsOrganizationId)
    && exactKeys(coverage, [
      "basis", "evidenceGenerationId", "contentSha256", "observedAt",
      "expectedAccountIds",
    ])
    && coverage.basis === "AWS_ORGANIZATIONS_ACTIVE_ACCOUNTS"
    && SOURCE_GENERATION.test(coverage.evidenceGenerationId)
    && SHA256.test(coverage.contentSha256) && validIso(coverage.observedAt)
    && sortedAccounts(coverage.expectedAccountIds)
    && coverage.expectedAccountIds.includes(scope.accountId)
    && exactKeys(license, [
      "collectionMode", "region", "organizationIntegrationRequired",
      "crossAccountDiscoveryRequired",
    ])
    && license.collectionMode === "ORGANIZATION" && REGION.test(license.region)
    && license.organizationIntegrationRequired === true
    && license.crossAccountDiscoveryRequired === true
    && exactKeys(cur2, [
      "source", "generationId", "sourceEvidenceId", "manifestSha256",
      "dataThroughAt", "reconciliationState", "predicate",
      "allowedLinkedAccountIds", "rowsExhausted", "amountColumns",
      "currencyHandling",
    ])
    && cur2.source === "ACTIVE_RECONCILED_CUR2_GENERATION"
    && BILLING_GENERATION.test(cur2.generationId)
    && SOURCE_GENERATION.test(cur2.sourceEvidenceId)
    && SHA256.test(cur2.manifestSha256) && validIso(cur2.dataThroughAt)
    && cur2.reconciliationState === "reconciled"
    && new Set([
      "CUR2_BILLING_ENTITY_AWS_MARKETPLACE",
      "CUR2_PRODUCT_FAMILY_AWS_MARKETPLACE",
    ]).has(cur2.predicate)
    && sortedAccounts(cur2.allowedLinkedAccountIds)
    && JSON.stringify(cur2.allowedLinkedAccountIds)
      === JSON.stringify(coverage.expectedAccountIds)
    && cur2.rowsExhausted === true
    && cur2.amountColumns === "BILLED_AND_AMORTIZED_SEPARATE"
    && cur2.currencyHandling === "MULTI_CURRENCY_ROW_LEVEL";
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
  readonly scope: AwsMarketplaceSpgPersistenceScope;
  readonly scheduledWindow: string;
} {
  if (job.kind !== MARKETPLACE_SPG_RUNTIME_JOB_KIND || job.customerId === null
    || job.connectionId === null || !JOB.test(job.id)
    || !IDENTIFIER.test(job.orgId) || !IDENTIFIER.test(job.customerId)
    || !CONNECTION.test(job.connectionId) || !Number.isSafeInteger(job.attempt)
    || job.attempt < 1 || job.attempt > 5 || job.maxAttempts !== 5
    || typeof job.payload !== "object" || job.payload === null
    || Array.isArray(job.payload)) reject("INVALID_JOB");
  const payload = job.payload as Record<string, unknown>;
  if (!exactKeys(payload, ["scheduledWindow"])
    || !validWindow(payload.scheduledWindow)) reject("INVALID_JOB");
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
  boundary: MarketplaceSpgServerBoundary,
  scheduledWindow: string,
): Promise<{
  readonly requestId: string;
  readonly expectedCaptureId: string;
  readonly sourceBoundarySha256: string;
}> {
  const sourceBoundarySha256 = await sha256(canonicalJson(boundary));
  const digest = await sha256(canonicalJson({
    schemaVersion: "sutra.marketplace-spg-runtime-identity.v1",
    scheduledWindow,
    sourceBoundarySha256,
  }));
  return {
    requestId: `mpr_${digest}`,
    expectedCaptureId: `marketplace_${digest}`,
    sourceBoundarySha256,
  };
}

function requestFor(
  boundary: MarketplaceSpgServerBoundary,
  scheduledWindow: string,
  identity: Awaited<ReturnType<typeof identityFor>>,
): MarketplaceSpgRuntimeBrokerRequest {
  return Object.freeze({
    schemaVersion: "sutra.marketplace-spg-runtime-request.v1",
    requestId: identity.requestId,
    expectedCaptureId: identity.expectedCaptureId,
    scheduledWindow,
    scope: Object.freeze({ ...boundary.scope }),
    accountCoverage: Object.freeze({
      ...boundary.accountCoverage,
      expectedAccountIds: Object.freeze([...boundary.accountCoverage.expectedAccountIds]),
    }),
    buyerOperations: AWS_MARKETPLACE_BUYER_API_OPERATIONS,
    licenseOperations: AWS_MARKETPLACE_LICENSE_MANAGER_API_OPERATIONS,
    accountCoverageActions: AWS_MARKETPLACE_ACCOUNT_COVERAGE_IAM_ACTIONS,
    endpoints: Object.freeze({
      agreementRegion: AWS_MARKETPLACE_AGREEMENT_REGION,
      discoveryRegion: AWS_MARKETPLACE_DISCOVERY_REGION,
      licenseManagerRegion: boundary.licenseManager.region,
    }),
    buyerParty: "Acceptor",
    billing: Object.freeze({
      ...boundary.activeCur2,
      allowedLinkedAccountIds: Object.freeze([
        ...boundary.activeCur2.allowedLinkedAccountIds,
      ]),
    }),
    pagination: Object.freeze({
      agreementPageSize: AWS_MARKETPLACE_SPG_COLLECTION_BOUNDS.agreementApiPageSize,
      licenseManagerPageSize:
        AWS_MARKETPLACE_SPG_COLLECTION_BOUNDS.licenseManagerApiPageSize,
      maximumPagesPerSequence:
        AWS_MARKETPLACE_SPG_COLLECTION_BOUNDS.maximumPagesPerSequence,
      rejectTokenReplay: true,
      requireExhaustionEvidence: true,
    }),
    privacy: Object.freeze({
      includeRegistrationTokens: false,
      includePurchaseOrderReferences: false,
      includeLegalDocumentsOrUrls: false,
      includeContacts: false,
      includeProviderErrorText: false,
      includeTemporaryEmbedUrls: false,
    }),
    bounds: AWS_MARKETPLACE_SPG_COLLECTION_BOUNDS,
    archiveMaximumBytes: MARKETPLACE_SPG_RUNTIME_ARCHIVE_MAX_BYTES,
    maximumDurationMs: MARKETPLACE_SPG_RUNTIME_TIMEOUT_MS,
  });
}

function captureMatches(
  capture: AwsMarketplaceSpgCapture,
  boundary: MarketplaceSpgServerBoundary,
  expectedCaptureId: string,
): boolean {
  const cur2 = capture.cur2;
  return capture.captureId === expectedCaptureId
    && sameScope(capture.scope, boundary.scope)
    && capture.agreementAccountCoverage.basis
      === boundary.accountCoverage.basis
    && capture.agreementAccountCoverage.evidenceId
      === boundary.accountCoverage.evidenceGenerationId
    && capture.agreementAccountCoverage.observedAt
      === boundary.accountCoverage.observedAt
    && JSON.stringify(capture.agreementAccountCoverage.expectedAccountIds)
      === JSON.stringify(boundary.accountCoverage.expectedAccountIds)
    && capture.agreementAccountCoverage.capturedAgreementAccountIds.every(
      (account) => boundary.accountCoverage.expectedAccountIds.includes(account),
    )
    && capture.licenseCollectionMode === boundary.licenseManager.collectionMode
    && capture.licenseManagerRegion === boundary.licenseManager.region
    && capture.licenseManagerSettings.organizationIntegrationEnabled === true
    && capture.licenseManagerSettings.crossAccountDiscoveryEnabled === true
    && cur2 !== null && sameScope(cur2.scope, boundary.scope)
    && cur2.generationId === boundary.activeCur2.generationId
    && cur2.sourceEvidenceId === boundary.activeCur2.sourceEvidenceId
    && cur2.dataThroughAt === boundary.activeCur2.dataThroughAt
    && cur2.reconciliationState === boundary.activeCur2.reconciliationState
    && cur2.predicate === boundary.activeCur2.predicate
    && cur2.rows.every((row) =>
      boundary.activeCur2.allowedLinkedAccountIds.includes(row.linkedAccountId));
}

async function acceptedMatches(
  accepted: MarketplaceSpgAcceptedRuntimeAttempt,
  expected: {
    readonly scope: AwsMarketplaceSpgPersistenceScope;
    readonly requestId: string;
    readonly scheduledWindow: string;
    readonly sourceBoundarySha256: string;
    readonly captureId: string;
    readonly boundary: MarketplaceSpgServerBoundary;
    readonly evidenceGenerationId?: string;
    readonly evidenceContentSha256?: string;
    readonly evidenceObjectId?: string;
    readonly reference?: { readonly ciphertext: string; readonly keyVersion: string };
  },
): Promise<boolean> {
  const stored = accepted.snapshot;
  const storedContentSha256 = await sha256(JSON.stringify(stored.snapshot));
  const expectedEvidenceGenerationId = `fss_${await sha256(canonicalJson({
    schemaVersion: "sutra.marketplace-spg-evidence-identity.v1",
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
    && stored.snapshot.spend.generationId === expected.boundary.activeCur2.generationId
    && stored.snapshot.spend.sourceEvidenceId
      === expected.boundary.activeCur2.sourceEvidenceId
    && stored.snapshot.spend.predicate === expected.boundary.activeCur2.predicate
    && stored.contentSha256 === storedContentSha256
    && stored.generationId === `mspg_${storedContentSha256}`
    && SNAPSHOT_GENERATION.test(stored.generationId)
    && SOURCE_GENERATION.test(accepted.evidence.generationId)
    && accepted.evidence.generationId === expectedEvidenceGenerationId
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
  dependencies: MarketplaceSpgRuntimeDependencies,
  input: Parameters<MarketplaceSpgImmutableEvidenceHandoff["recordFailure"]>[0],
): Promise<never> {
  try { await dependencies.handoff.recordFailure(input); } catch {
    // Never expose provider or persistence diagnostics through the queue.
  }
  throw new MarketplaceSpgRuntimeBindingError(input.code);
}

export async function scheduleMarketplaceSpgCollections(input: {
  readonly loadEligibleScopes: () =>
    Promise<readonly AwsMarketplaceSpgPersistenceScope[]>;
  readonly queue: MarketplaceSpgRuntimeQueue;
  readonly scheduledWindow: string;
}): Promise<{ readonly scheduledWindow: string; readonly enqueued: number }> {
  if (!validWindow(input.scheduledWindow)) reject("INVALID_JOB");
  let scopes: readonly AwsMarketplaceSpgPersistenceScope[];
  try { scopes = await input.loadEligibleScopes(); } catch {
    return reject("SCOPE_REJECTED");
  }
  if (scopes.length > MAX_CONNECTIONS) reject("SCOPE_REJECTED");
  const ordered = [...scopes].sort((left, right) =>
    left.connectionId.localeCompare(right.connectionId));
  const seen = new Set<string>();
  for (const scope of ordered) {
    if (!validPersistenceScope(scope) || seen.has(scope.connectionId)) {
      reject("SCOPE_REJECTED");
    }
    seen.add(scope.connectionId);
  }
  // Validate the complete resolver result before producing any queue side effect.
  // A corrupt late entry must not leave a partially scheduled tenant set.
  for (const scope of ordered) {
    await input.queue.enqueue({
      orgId: scope.organizationId,
      customerId: scope.customerId,
      connectionId: scope.connectionId,
      kind: MARKETPLACE_SPG_RUNTIME_JOB_KIND,
      payload: Object.freeze({ scheduledWindow: input.scheduledWindow }),
      maxAttempts: 5,
      idempotencyKey: `marketplace-spg:${[
        scope.organizationId, scope.customerId, scope.connectionId,
        input.scheduledWindow,
      ].map(encodeURIComponent).join(":")}`,
    });
  }
  return { scheduledWindow: input.scheduledWindow, enqueued: ordered.length };
}

export async function runMarketplaceSpgRuntimeHandler(
  job: RunnableJob,
  dependencies: MarketplaceSpgRuntimeDependencies,
): Promise<MarketplaceSpgRuntimeResult> {
  const parsed = parseJob(job);
  let boundary: MarketplaceSpgServerBoundary | null;
  try { boundary = await dependencies.loadBoundary(parsed.scope); } catch {
    return reject("BOUNDARY_REJECTED");
  }
  if (boundary === null) {
    return {
      status: "unavailable",
      reason: MARKETPLACE_SPG_RUNTIME_ACTIVATION_REASONS.boundary,
    };
  }
  if (!validBoundary(boundary, parsed.scope)) reject("BOUNDARY_REJECTED");
  if (dependencies.broker === null) {
    return {
      status: "unavailable",
      reason: MARKETPLACE_SPG_RUNTIME_ACTIVATION_REASONS.adapter,
    };
  }
  const identity = await identityFor(boundary, parsed.scheduledWindow);
  let prior: MarketplaceSpgAcceptedRuntimeAttempt | null = null;
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
      scope: parsed.scope, requestId: identity.requestId,
      scheduledWindow: parsed.scheduledWindow,
      sourceBoundarySha256: identity.sourceBoundarySha256,
      captureId: identity.expectedCaptureId, boundary,
    })) reject("PERSISTENCE_REJECTED");
    return {
      status: "collected", generationId: prior.snapshot.generationId,
      evidenceGenerationId: prior.evidence.generationId,
      state: prior.snapshot.snapshot.state, becameActive: false, replayed: true,
    };
  }
  const request = requestFor(boundary, parsed.scheduledWindow, identity);
  const requestBodySha256 = await sha256(canonicalJson(request));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MARKETPLACE_SPG_RUNTIME_TIMEOUT_MS);
  let result: MarketplaceSpgVerifiedBrokerResult | null = null;
  try { result = await dependencies.broker.collect(request, controller.signal); }
  catch {
    const code = controller.signal.aborted ? "BROKER_TIMEOUT" : "BROKER_UNAVAILABLE";
    await fail(dependencies, {
      scope: parsed.scope, requestId: identity.requestId,
      scheduledWindow: parsed.scheduledWindow, code,
      completedAtMs: currentTime(dependencies.now),
    });
  } finally { clearTimeout(timeout); }
  if (result === null) reject("BROKER_UNAVAILABLE");
  const captureBodySha256 = await sha256(canonicalJson(result.capture));
  if (result.verification.authentication !== "ED25519_RESPONSE_SIGNATURE_VERIFIED"
    || result.verification.requestBodySha256 !== requestBodySha256
    || result.verification.captureBodySha256 !== captureBodySha256
    || !BROKER_KEY.test(result.verification.brokerKeyId)) {
    await fail(dependencies, {
      scope: parsed.scope, requestId: identity.requestId,
      scheduledWindow: parsed.scheduledWindow,
      code: "BROKER_AUTHENTICATION_FAILED",
      completedAtMs: currentTime(dependencies.now),
    });
  }
  const normalizedAt = currentTime(dependencies.now);
  let snapshot: AwsMarketplaceSpgSnapshot | null = null;
  try {
    if (!captureMatches(result.capture, boundary, identity.expectedCaptureId)) {
      throw new Error("marketplace-capture-boundary-mismatch");
    }
    snapshot = normalizeAwsMarketplaceSpgCapture(
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
    schemaVersion: "sutra.marketplace-spg-runtime-evidence.v1",
    sourceBoundary: boundary,
    request,
    verification: result.verification,
    capture: result.capture,
  }));
  if (body.byteLength > MARKETPLACE_SPG_RUNTIME_ARCHIVE_MAX_BYTES) {
    await fail(dependencies, {
      scope: parsed.scope, requestId: identity.requestId,
      scheduledWindow: parsed.scheduledWindow, code: "EVIDENCE_REJECTED",
      completedAtMs: normalizedAt,
    });
  }
  const contentSha256 = await sha256(body);
  const evidenceGenerationId = `fss_${await sha256(canonicalJson({
    schemaVersion: "sutra.marketplace-spg-evidence-identity.v1",
    requestId: identity.requestId,
    contentSha256,
  }))}`;
  let archived: Awaited<ReturnType<MarketplaceSpgEvidenceArchive["archive"]>> | null = null;
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
      createdBy: MARKETPLACE_SPG_EVIDENCE_ACTOR_ID,
      now: normalizedAt,
    });
    if (archived.status !== "available" || !EVIDENCE_OBJECT.test(archived.id)
      || archived.contentSha256 !== contentSha256) {
      throw new Error("marketplace-evidence-archive-rejected");
    }
    reference = await dependencies.sealer.seal(archived.id, {
      organizationId: parsed.scope.organizationId,
      customerId: parsed.scope.customerId,
      connectionId: parsed.scope.connectionId,
      sourceId: MARKETPLACE_SPG_EVIDENCE_SOURCE_ID,
      generationId: evidenceGenerationId,
    });
    if (!SEALED_REFERENCE.test(reference.ciphertext)
      || !KEY_VERSION.test(reference.keyVersion)) {
      throw new Error("marketplace-evidence-reference-rejected");
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
  let committed: Awaited<ReturnType<MarketplaceSpgImmutableEvidenceHandoff["commit"]>> | null = null;
  try {
    committed = await dependencies.handoff.commit({
      scope: parsed.scope, trustedScope: boundary.scope,
      requestId: identity.requestId, scheduledWindow: parsed.scheduledWindow,
      sourceBoundarySha256: identity.sourceBoundarySha256,
      capture: result.capture, normalizedSnapshot: snapshot,
      evidence: expectedEvidence, nowMs: normalizedAt,
    });
    if (!await acceptedMatches(committed.accepted, {
      scope: parsed.scope, requestId: identity.requestId,
      scheduledWindow: parsed.scheduledWindow,
      sourceBoundarySha256: identity.sourceBoundarySha256,
      captureId: identity.expectedCaptureId, boundary,
      evidenceGenerationId, evidenceContentSha256: contentSha256,
      evidenceObjectId: archived.id, reference,
    }) || canonicalJson(committed.accepted.snapshot.snapshot)
      !== canonicalJson(snapshot)) {
      throw new Error("marketplace-persistence-result-rejected");
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

export function createMarketplaceSpgRuntimeJobHandler(
  dependencies: MarketplaceSpgRuntimeDependencies,
): JobHandler {
  return async (job) => {
    const result = await runMarketplaceSpgRuntimeHandler(job, dependencies);
    if (result.status === "unavailable") {
      throw new MarketplaceSpgRuntimeBindingError("BROKER_UNAVAILABLE");
    }
  };
}

export const MARKETPLACE_SPG_RUNTIME_BINDING = Object.freeze({
  jobKind: MARKETPLACE_SPG_RUNTIME_JOB_KIND,
  cadence: MARKETPLACE_SPG_RUNTIME_CADENCE,
  handlerFactory: createMarketplaceSpgRuntimeJobHandler,
  registeredInSharedRuntime: false,
  activationReason: MARKETPLACE_SPG_RUNTIME_ACTIVATION_REASONS.adapter,
});
