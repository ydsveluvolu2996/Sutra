/**
 * ADV-01 app-side orchestration for the standard-check organizational view.
 *
 * AWS Support Trusted Advisor standard checks are account-local and fixed to
 * us-east-1. Organization coverage is therefore an explicit fan-out over a
 * signed, server-owned AWS Organizations taxonomy capture. Priority
 * recommendations are never accepted by this boundary.
 */
import type { RunnableJob } from "./background-job-runner.ts";
import {
  enqueueTrustedAdvisorAccountCollections,
  enqueueTrustedAdvisorManifestFinalization,
  parseTrustedAdvisorAccountCollectJobPayload,
  parseTrustedAdvisorManifestFinalizeJobPayload,
  type TrustedAdvisorOrganizationQueue,
} from "./finops-trusted-advisor-organization-job.ts";
import type {
  RecordTrustedAdvisorAccountSnapshotInput,
  StoredTrustedAdvisorManifest,
  TrustedAdvisorOrganizationScope,
} from "../db/finops-trusted-advisor-organization-repository.ts";

export const FINOPS_TA_ORGANIZATION_ACTIVATE_JOB_KIND =
  "finops-ta-organization-activate";
export const TRUSTED_ADVISOR_STANDARD_SOURCE_ID =
  "trusted_advisor_standard_checks" as const;
export const TRUSTED_ADVISOR_STANDARD_CONTRACT_ID =
  "aws-trusted-advisor-standard-checks-read-v1" as const;
export const TRUSTED_ADVISOR_STANDARD_REGION = "us-east-1" as const;
export const TRUSTED_ADVISOR_ORGANIZATIONS_TAXONOMY_OPERATIONS = Object.freeze([
  "organizations:DescribeOrganization",
  "organizations:ListAccounts",
] as const);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^[0-9]{12}$/u;
const ORGANIZATION_ID = /^o-[a-z0-9]{10,32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const GENERATION_ID = /^fss_[a-f0-9]{64}$/u;
const SEALED_REFERENCE = /^fsev1\.[A-Za-z0-9_-]{26,8186}$/u;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const SIGNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{43,8192}$/u;
const MAX_TAXONOMY_AGE_MS = 48 * 60 * 60 * 1_000;
const MAX_EVIDENCE_BYTES = 8 * 1_024 * 1_024;
const MAX_ACCOUNTS = 10_000;
const MAX_CHECKS = 512;
const MAX_RESOURCES = 25_000;
const MAX_METADATA_FIELDS = 100;

export type TrustedAdvisorTaxonomyAccountState =
  | "ACTIVE"
  | "CLOSED"
  | "PENDING_ACTIVATION"
  | "SUSPENDED"
  | "PENDING_CLOSURE";

export interface TrustedAdvisorOrganizationsTaxonomyCapture {
  readonly schemaVersion: "sutra.aws-organizations-taxonomy.signed.v1";
  readonly scope: TrustedAdvisorOrganizationScope;
  readonly partition: "aws";
  readonly managementAccountId: string;
  readonly awsOrganizationId: string;
  readonly collectedAtIso: string;
  readonly pagesExhausted: true;
  readonly operations: typeof TRUSTED_ADVISOR_ORGANIZATIONS_TAXONOMY_OPERATIONS;
  readonly accounts: readonly {
    readonly accountId: string;
    readonly state: TrustedAdvisorTaxonomyAccountState;
  }[];
  readonly contentSha256: string;
  readonly signature: {
    readonly algorithm: "AWS_KMS_RSASSA_PSS_SHA_256";
    readonly signerKeyId: string;
    readonly value: string;
  };
}

export interface TrustedAdvisorServerConnection {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly awsAccountId: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly sourceKind: string;
  readonly status: string;
}

export interface TrustedAdvisorStandardSourceEvidence {
  readonly snapshot: {
    readonly scope: TrustedAdvisorOrganizationScope;
    readonly sourceId: typeof TRUSTED_ADVISOR_STANDARD_SOURCE_ID;
    readonly generationId: string;
    readonly jobId: string;
    readonly attempt: number;
    readonly status: "complete" | "partial";
    readonly contentSha256: string;
    readonly schemaVersion: "sutra.finops-source-evidence.v2";
    readonly collectedAtIso: string;
    readonly dataThroughAtIso: string;
    readonly evidenceReference: {
      readonly ciphertext: string;
      readonly keyVersion: string;
    };
  };
  /** Bytes already opened and hash-verified from EvidenceRepository. */
  readonly verifiedBody: Uint8Array;
}

export interface TrustedAdvisorManifestPort {
  createManifest(
    scope: TrustedAdvisorOrganizationScope,
    input: {
      readonly jobId: string;
      readonly taxonomySnapshotId: string;
      readonly taxonomySha256: string;
      readonly accountSetSha256: string;
      readonly accounts: readonly {
        readonly accountId: string;
        readonly targetConnectionId: string | null;
      }[];
    },
    nowMs?: number,
  ): Promise<StoredTrustedAdvisorManifest>;
  startManifest(
    scope: TrustedAdvisorOrganizationScope,
    manifestId: string,
    nowMs?: number,
  ): Promise<StoredTrustedAdvisorManifest>;
  getManifest(
    scope: TrustedAdvisorOrganizationScope,
    manifestId: string,
  ): Promise<StoredTrustedAdvisorManifest | null>;
  startAccount(
    scope: TrustedAdvisorOrganizationScope,
    manifestId: string,
    accountId: string,
    nowMs?: number,
  ): Promise<void>;
  markAccountUnavailable(
    scope: TrustedAdvisorOrganizationScope,
    manifestId: string,
    accountId: string,
    status: "failed" | "unconfigured",
    errorCode: string,
    nowMs?: number,
  ): Promise<void>;
  recordAccountSnapshot(
    scope: TrustedAdvisorOrganizationScope,
    manifestId: string,
    input: RecordTrustedAdvisorAccountSnapshotInput,
    nowMs?: number,
  ): Promise<string>;
  finalizeManifest(
    scope: TrustedAdvisorOrganizationScope,
    manifestId: string,
    nowMs?: number,
  ): Promise<unknown>;
}

export interface TrustedAdvisorActivationDependencies {
  readonly repository: TrustedAdvisorManifestPort;
  readonly queue: TrustedAdvisorOrganizationQueue;
  readonly getAnchorConnection: (
    scope: TrustedAdvisorOrganizationScope,
  ) => Promise<TrustedAdvisorServerConnection | null>;
  readonly listCustomerConnections: (
    scope: TrustedAdvisorOrganizationScope,
  ) => Promise<readonly TrustedAdvisorServerConnection[]>;
  /** External adapter: production must implement exactly this signed contract. */
  readonly collectSignedTaxonomy: (input: {
    readonly scope: TrustedAdvisorOrganizationScope;
    readonly partition: "aws";
    readonly managementAccountId: string;
    readonly operations: typeof TRUSTED_ADVISOR_ORGANIZATIONS_TAXONOMY_OPERATIONS;
  }) => Promise<unknown>;
  readonly verifyTaxonomySignature: (input: {
    readonly algorithm: "AWS_KMS_RSASSA_PSS_SHA_256";
    readonly signerKeyId: string;
    readonly signature: string;
    readonly content: Uint8Array;
  }) => Promise<boolean>;
  readonly expectedSignerKeyId: string;
  readonly now?: () => number;
}

export interface TrustedAdvisorAccountDependencies {
  readonly repository: TrustedAdvisorManifestPort;
  readonly queue: TrustedAdvisorOrganizationQueue;
  readonly findManifest: (input: {
    readonly organizationId: string;
    readonly customerId: string;
    readonly manifestId: string;
  }) => Promise<StoredTrustedAdvisorManifest | null>;
  /**
   * Production binds this to runFinopsSourceCollectJob plus the exact persisted
   * source snapshot and EvidenceRepository read. It must never return Priority
   * recommendation evidence.
   */
  readonly collectCompletedStandardChecks: (input: {
    readonly organizationId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly accountId: string;
    readonly sourceId: typeof TRUSTED_ADVISOR_STANDARD_SOURCE_ID;
    readonly contractId: typeof TRUSTED_ADVISOR_STANDARD_CONTRACT_ID;
    readonly region: typeof TRUSTED_ADVISOR_STANDARD_REGION;
    readonly orchestrationJobId: string;
    readonly attempt: number;
  }) => Promise<TrustedAdvisorStandardSourceEvidence>;
  readonly now?: () => number;
}

export interface TrustedAdvisorFinalizeDependencies {
  readonly repository: TrustedAdvisorManifestPort;
  readonly findManifest: TrustedAdvisorAccountDependencies["findManifest"];
  readonly now?: () => number;
}

export interface TrustedAdvisorActivationQueue {
  enqueue(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly kind: typeof FINOPS_TA_ORGANIZATION_ACTIVATE_JOB_KIND;
    readonly payload: { readonly connectionId: string };
    readonly maxAttempts: number;
    readonly idempotencyKey: string;
  }, nowMs?: number): Promise<{ readonly id: string }>;
}

export class TrustedAdvisorStandardOrchestrationError extends Error {
  public readonly code:
    | "INVALID_JOB"
    | "INVALID_SCOPE"
    | "TAXONOMY_REJECTED"
    | "CONNECTION_REJECTED"
    | "MANIFEST_REJECTED"
    | "STANDARD_EVIDENCE_REJECTED"
    | "NOT_TERMINAL";

  public constructor(code: TrustedAdvisorStandardOrchestrationError["code"]) {
    super("Trusted Advisor standard-check organization orchestration rejected");
    this.name = "TrustedAdvisorStandardOrchestrationError";
    this.code = code;
  }
}

function reject(code: TrustedAdvisorStandardOrchestrationError["code"]): never {
  throw new TrustedAdvisorStandardOrchestrationError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function exactRecord(value: unknown, keys: readonly string[]) {
  if (!isRecord(value)) reject("INVALID_JOB");
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    reject("INVALID_JOB");
  }
  return value;
}

function normalizedIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value
    ? value
    : null;
}

function now(dependency: (() => number) | undefined): number {
  const value = dependency?.() ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0) reject("INVALID_JOB");
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function accountSetSha256(
  accounts: readonly { readonly accountId: string; readonly targetConnectionId: string | null }[],
): Promise<string> {
  return sha256(JSON.stringify([...accounts].sort((left, right) =>
    left.accountId.localeCompare(right.accountId))));
}

async function accountSnapshotSha256(
  input: Omit<RecordTrustedAdvisorAccountSnapshotInput, "contentSha256">,
): Promise<string> {
  return sha256(JSON.stringify({
    accountId: input.accountId,
    status: input.status,
    collectedAtIso: input.collectedAtIso,
    dataThroughAtIso: input.dataThroughAtIso,
    rejectedRecordCount: input.rejectedRecordCount,
    evidenceReference: input.evidenceReference,
    checks: [...input.checks].sort((left, right) => left.checkId.localeCompare(right.checkId)),
    resources: [...input.resources].sort((left, right) =>
      left.resourceKey.localeCompare(right.resourceKey)),
  }));
}

async function resourceKey(
  manifestId: string,
  accountId: string,
  resource: Omit<RecordTrustedAdvisorAccountSnapshotInput["resources"][number], "resourceKey">,
): Promise<string> {
  return sha256(JSON.stringify({
    manifestId,
    accountId,
    checkId: resource.checkId,
    resourceId: resource.resourceId,
    region: resource.region,
    metadataSha256: resource.metadataSha256,
  }));
}

function scopeFromJob(job: RunnableJob): TrustedAdvisorOrganizationScope {
  if (
    job.customerId === null
    || job.connectionId === null
    || !IDENTIFIER.test(job.orgId)
    || !IDENTIFIER.test(job.customerId)
    || !CONNECTION_ID.test(job.connectionId)
    || !IDENTIFIER.test(job.id)
    || !Number.isSafeInteger(job.attempt)
    || job.attempt < 1
    || job.attempt > 100
  ) reject("INVALID_SCOPE");
  return {
    organizationId: job.orgId,
    customerId: job.customerId,
    connectionId: job.connectionId,
  };
}

/** Browser-safe activation edge: only a persisted connection identity crosses it. */
export async function enqueueTrustedAdvisorOrganizationActivation(
  queue: TrustedAdvisorActivationQueue,
  scope: TrustedAdvisorOrganizationScope,
  nowMs = Date.now(),
): Promise<{ readonly jobId: string }> {
  if (
    !Number.isSafeInteger(nowMs) || nowMs < 0
    || !IDENTIFIER.test(scope.organizationId)
    || !IDENTIFIER.test(scope.customerId)
    || !CONNECTION_ID.test(scope.connectionId)
  ) reject("INVALID_SCOPE");
  const window = Math.floor(nowMs / (5 * 60_000));
  const queued = await queue.enqueue({
    orgId: scope.organizationId,
    customerId: scope.customerId,
    connectionId: scope.connectionId,
    kind: FINOPS_TA_ORGANIZATION_ACTIVATE_JOB_KIND,
    payload: { connectionId: scope.connectionId },
    maxAttempts: 6,
    idempotencyKey: `finops-ta-activate:${scope.connectionId}:${window}`,
  }, nowMs);
  if (!/^job_[a-f0-9]{32}$/u.test(queued.id)) reject("INVALID_JOB");
  return { jobId: queued.id };
}

function assertConnection(
  connection: TrustedAdvisorServerConnection,
  organizationId: string,
  customerId: string,
): void {
  if (
    connection.organizationId !== organizationId
    || connection.customerId !== customerId
    || !CONNECTION_ID.test(connection.connectionId)
    || !ACCOUNT_ID.test(connection.awsAccountId)
    || connection.partition !== "aws"
    || connection.sourceKind !== "aws_trust_role"
    || connection.status !== "active"
  ) reject("CONNECTION_REJECTED");
}

function taxonomyContent(capture: Omit<TrustedAdvisorOrganizationsTaxonomyCapture,
  "contentSha256" | "signature">): string {
  return canonicalJson(capture);
}

export async function trustedAdvisorTaxonomyContentSha256(
  capture: Omit<TrustedAdvisorOrganizationsTaxonomyCapture,
    "contentSha256" | "signature">,
): Promise<string> {
  return sha256(taxonomyContent(capture));
}

async function acceptTaxonomy(
  value: unknown,
  scope: TrustedAdvisorOrganizationScope,
  managementAccountId: string,
  dependencies: Pick<TrustedAdvisorActivationDependencies,
    "verifyTaxonomySignature" | "expectedSignerKeyId">,
  nowMs: number,
): Promise<TrustedAdvisorOrganizationsTaxonomyCapture> {
  if (!isRecord(value)) reject("TAXONOMY_REJECTED");
  const capture = value as unknown as TrustedAdvisorOrganizationsTaxonomyCapture;
  const collectedAtIso = normalizedIso(capture.collectedAtIso);
  if (
    !hasExactKeys(value, [
      "schemaVersion", "scope", "partition", "managementAccountId",
      "awsOrganizationId", "collectedAtIso", "pagesExhausted", "operations",
      "accounts", "contentSha256", "signature",
    ])
    || capture.schemaVersion !== "sutra.aws-organizations-taxonomy.signed.v1"
    || !isRecord(capture.scope)
    || !hasExactKeys(capture.scope, ["organizationId", "customerId", "connectionId"])
    || capture.scope.organizationId !== scope.organizationId
    || capture.scope.customerId !== scope.customerId
    || capture.scope.connectionId !== scope.connectionId
    || capture.partition !== "aws"
    || capture.managementAccountId !== managementAccountId
    || !ORGANIZATION_ID.test(capture.awsOrganizationId)
    || collectedAtIso === null
    || Date.parse(collectedAtIso) > nowMs + 5 * 60_000
    || nowMs - Date.parse(collectedAtIso) > MAX_TAXONOMY_AGE_MS
    || capture.pagesExhausted !== true
    || !Array.isArray(capture.operations)
    || capture.operations.length !== TRUSTED_ADVISOR_ORGANIZATIONS_TAXONOMY_OPERATIONS.length
    || capture.operations.some((operation, index) =>
      operation !== TRUSTED_ADVISOR_ORGANIZATIONS_TAXONOMY_OPERATIONS[index])
    || !Array.isArray(capture.accounts)
    || capture.accounts.length < 1
    || capture.accounts.length > MAX_ACCOUNTS
    || !SHA256.test(capture.contentSha256)
    || !isRecord(capture.signature)
    || !hasExactKeys(capture.signature, ["algorithm", "signerKeyId", "value"])
    || capture.signature.algorithm !== "AWS_KMS_RSASSA_PSS_SHA_256"
    || capture.signature.signerKeyId !== dependencies.expectedSignerKeyId
    || !SIGNER_ID.test(capture.signature.signerKeyId)
    || !SIGNATURE.test(capture.signature.value)
  ) reject("TAXONOMY_REJECTED");
  const accounts = [...capture.accounts].sort((left, right) =>
    left.accountId.localeCompare(right.accountId));
  if (
    accounts.some((account) =>
      !isRecord(account)
      || !hasExactKeys(account, ["accountId", "state"])
      || typeof account.accountId !== "string"
      || !ACCOUNT_ID.test(account.accountId)
      || typeof account.state !== "string"
      || !new Set([
        "ACTIVE", "CLOSED", "PENDING_ACTIVATION", "SUSPENDED", "PENDING_CLOSURE",
      ]).has(account.state))
    || new Set(accounts.map((account) => account.accountId)).size !== accounts.length
    || !accounts.some((account) =>
      account.accountId === managementAccountId && account.state === "ACTIVE")
  ) reject("TAXONOMY_REJECTED");
  const unsigned = {
    schemaVersion: capture.schemaVersion,
    scope: capture.scope,
    partition: capture.partition,
    managementAccountId: capture.managementAccountId,
    awsOrganizationId: capture.awsOrganizationId,
    collectedAtIso,
    pagesExhausted: true as const,
    operations: TRUSTED_ADVISOR_ORGANIZATIONS_TAXONOMY_OPERATIONS,
    accounts,
  };
  const content = new TextEncoder().encode(taxonomyContent(unsigned));
  if (
    await sha256(content) !== capture.contentSha256
    || !await dependencies.verifyTaxonomySignature({
      algorithm: capture.signature.algorithm,
      signerKeyId: capture.signature.signerKeyId,
      signature: capture.signature.value,
      content,
    })
  ) reject("TAXONOMY_REJECTED");
  return { ...unsigned, contentSha256: capture.contentSha256, signature: capture.signature };
}

export async function runTrustedAdvisorOrganizationActivationJob(
  job: RunnableJob,
  dependencies: TrustedAdvisorActivationDependencies,
): Promise<{
  readonly manifestId: string;
  readonly accountJobIds: readonly string[];
  readonly finalizerJobId: string | null;
}> {
  if (job.kind !== FINOPS_TA_ORGANIZATION_ACTIVATE_JOB_KIND) reject("INVALID_JOB");
  const scope = scopeFromJob(job);
  const payload = exactRecord(job.payload, ["connectionId"]);
  if (payload.connectionId !== scope.connectionId) reject("INVALID_SCOPE");
  const anchor = await dependencies.getAnchorConnection(scope);
  if (anchor === null || anchor.connectionId !== scope.connectionId) {
    reject("CONNECTION_REJECTED");
  }
  assertConnection(anchor, scope.organizationId, scope.customerId);
  const nowMs = now(dependencies.now);
  const taxonomy = await acceptTaxonomy(
    await dependencies.collectSignedTaxonomy({
      scope,
      partition: "aws",
      managementAccountId: anchor.awsAccountId,
      operations: TRUSTED_ADVISOR_ORGANIZATIONS_TAXONOMY_OPERATIONS,
    }),
    scope,
    anchor.awsAccountId,
    dependencies,
    nowMs,
  );
  const connections = await dependencies.listCustomerConnections(scope);
  if (!Array.isArray(connections) || connections.length > MAX_ACCOUNTS) {
    reject("CONNECTION_REJECTED");
  }
  const byAccount = new Map<string, string>([[anchor.awsAccountId, anchor.connectionId]]);
  for (const connection of connections) {
    assertConnection(connection, scope.organizationId, scope.customerId);
    const existing = byAccount.get(connection.awsAccountId);
    if (existing !== undefined && existing !== connection.connectionId) {
      reject("CONNECTION_REJECTED");
    }
    byAccount.set(connection.awsAccountId, connection.connectionId);
  }
  const states = new Map(taxonomy.accounts.map((account) => [account.accountId, account.state]));
  const manifestAccounts = taxonomy.accounts.map((account) => ({
    accountId: account.accountId,
    targetConnectionId: account.state === "ACTIVE"
      ? byAccount.get(account.accountId) ?? null
      : null,
  }));
  const manifest = await dependencies.repository.createManifest(scope, {
    jobId: job.id,
    taxonomySnapshotId: `orgtax_${taxonomy.contentSha256}`,
    taxonomySha256: taxonomy.contentSha256,
    accountSetSha256: await accountSetSha256(manifestAccounts),
    accounts: manifestAccounts,
  }, nowMs);
  if (new Set(["complete", "partial", "failed"]).has(manifest.status)) {
    return { manifestId: manifest.manifestId, accountJobIds: [], finalizerJobId: null };
  }
  if (manifest.status === "finalizing") {
    return {
      manifestId: manifest.manifestId,
      accountJobIds: [],
      finalizerJobId: await enqueueTrustedAdvisorManifestFinalization(
        dependencies.queue,
        scope,
        manifest,
        nowMs,
      ),
    };
  }
  const collecting = await dependencies.repository.startManifest(
    scope,
    manifest.manifestId,
    nowMs,
  );
  for (const account of collecting.accounts) {
    if (account.targetConnectionId !== null || account.status !== "pending") continue;
    await dependencies.repository.markAccountUnavailable(
      scope,
      collecting.manifestId,
      account.accountId,
      "unconfigured",
      states.get(account.accountId) === "ACTIVE"
        ? "ACCOUNT_CONNECTION_MISSING"
        : "AWS_ACCOUNT_NOT_ACTIVE",
      nowMs,
    );
  }
  const refreshed = await dependencies.repository.getManifest(scope, collecting.manifestId);
  if (refreshed === null) reject("MANIFEST_REJECTED");
  const accountJobIds = await enqueueTrustedAdvisorAccountCollections(
    dependencies.queue,
    scope,
    refreshed,
    nowMs,
  );
  const finalizerJobId = accountJobIds.length === 0
    ? await enqueueTrustedAdvisorManifestFinalization(
      dependencies.queue,
      scope,
      refreshed,
      nowMs,
    )
    : null;
  return { manifestId: refreshed.manifestId, accountJobIds, finalizerJobId };
}

interface ParsedStandardEvidence {
  readonly collectionStatus: "COMPLETE" | "PARTIAL";
  readonly accountId: string;
  readonly partition: "aws";
  readonly region: "us-east-1";
  readonly collectedAt: string;
  readonly dataThroughAt: string;
  readonly coverage: {
    readonly recordsObserved: number;
    readonly recordsAccepted: number;
    readonly recordsRejected: number;
    readonly recordsOmitted: number;
  };
  readonly evidence: {
    readonly schemaVersion: "sutra.aws-trusted-advisor-standard-checks.v1";
    readonly source: "AWS_SUPPORT_TRUSTED_ADVISOR_STANDARD_CHECKS";
    readonly checks: readonly Readonly<Record<string, unknown>>[];
  };
}

function safeCount(value: unknown, maximum = 1_000_000_000): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

async function parseStandardEvidence(
  source: TrustedAdvisorStandardSourceEvidence,
  expected: {
    readonly scope: TrustedAdvisorOrganizationScope;
    readonly accountId: string;
    readonly jobId: string;
    readonly attempt: number;
  },
): Promise<ParsedStandardEvidence> {
  const snapshot = source.snapshot;
  if (
    snapshot.scope.organizationId !== expected.scope.organizationId
    || snapshot.scope.customerId !== expected.scope.customerId
    || snapshot.scope.connectionId !== expected.scope.connectionId
    || snapshot.sourceId !== TRUSTED_ADVISOR_STANDARD_SOURCE_ID
    || !GENERATION_ID.test(snapshot.generationId)
    || snapshot.jobId !== expected.jobId
    || snapshot.attempt !== expected.attempt
    || !new Set(["complete", "partial"]).has(snapshot.status)
    || snapshot.schemaVersion !== "sutra.finops-source-evidence.v2"
    || !SHA256.test(snapshot.contentSha256)
    || normalizedIso(snapshot.collectedAtIso) === null
    || normalizedIso(snapshot.dataThroughAtIso) === null
    || snapshot.dataThroughAtIso > snapshot.collectedAtIso
    || !SEALED_REFERENCE.test(snapshot.evidenceReference.ciphertext)
    || !KEY_VERSION.test(snapshot.evidenceReference.keyVersion)
    || !(source.verifiedBody instanceof Uint8Array)
    || source.verifiedBody.byteLength < 2
    || source.verifiedBody.byteLength > MAX_EVIDENCE_BYTES
    || await sha256(source.verifiedBody) !== snapshot.contentSha256
  ) reject("STANDARD_EVIDENCE_REJECTED");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.verifiedBody));
  } catch {
    reject("STANDARD_EVIDENCE_REJECTED");
  }
  if (!isRecord(parsed) || !isRecord(parsed.coverage) || !isRecord(parsed.evidence)) {
    reject("STANDARD_EVIDENCE_REJECTED");
  }
  const body = parsed as unknown as ParsedStandardEvidence & {
    readonly schemaVersion: string;
    readonly sourceId: string;
    readonly contractId: string;
  };
  if (
    body.schemaVersion !== "sutra.finops-source-evidence.v2"
    || body.sourceId !== TRUSTED_ADVISOR_STANDARD_SOURCE_ID
    || body.contractId !== TRUSTED_ADVISOR_STANDARD_CONTRACT_ID
    || !new Set(["COMPLETE", "PARTIAL"]).has(body.collectionStatus)
    || body.accountId !== expected.accountId
    || body.partition !== "aws"
    || body.region !== TRUSTED_ADVISOR_STANDARD_REGION
    || body.collectedAt !== snapshot.collectedAtIso
    || body.dataThroughAt !== snapshot.dataThroughAtIso
    || !safeCount(body.coverage.recordsObserved)
    || !safeCount(body.coverage.recordsAccepted)
    || !safeCount(body.coverage.recordsRejected)
    || !safeCount(body.coverage.recordsOmitted)
    || body.coverage.recordsAccepted + body.coverage.recordsRejected
      + body.coverage.recordsOmitted > body.coverage.recordsObserved
    || body.evidence.schemaVersion !== "sutra.aws-trusted-advisor-standard-checks.v1"
    || body.evidence.source !== "AWS_SUPPORT_TRUSTED_ADVISOR_STANDARD_CHECKS"
    || !Array.isArray(body.evidence.checks)
    || body.evidence.checks.length > MAX_CHECKS
    || (body.collectionStatus === "COMPLETE" && snapshot.status !== "complete")
  ) reject("STANDARD_EVIDENCE_REJECTED");
  return body;
}

async function materializeAccountSnapshot(
  manifestId: string,
  parsed: ParsedStandardEvidence,
  reference: TrustedAdvisorStandardSourceEvidence["snapshot"]["evidenceReference"],
): Promise<RecordTrustedAdvisorAccountSnapshotInput> {
  const checks: RecordTrustedAdvisorAccountSnapshotInput["checks"][number][] = [];
  const resources: RecordTrustedAdvisorAccountSnapshotInput["resources"][number][] = [];
  const checkIds = new Set<string>();
  for (const value of parsed.evidence.checks) {
    if (!isRecord(value) || !isRecord(value.resourcesSummary) || !Array.isArray(value.flaggedResources)) {
      reject("STANDARD_EVIDENCE_REJECTED");
    }
    const checkId = value.checkId;
    const name = value.name;
    const category = value.category;
    const status = value.status;
    const dataThroughAtIso = value.dataThroughAt;
    const summary = value.resourcesSummary;
    if (
      typeof checkId !== "string" || !IDENTIFIER.test(checkId) || checkIds.has(checkId)
      || typeof name !== "string" || name.length < 1 || name.length > 512
      || typeof category !== "string" || category.length < 1 || category.length > 128
      || !new Set(["ok", "warning", "error", "not_available"]).has(String(status))
      || (dataThroughAtIso !== null && normalizedIso(dataThroughAtIso) === null)
      || !safeCount(summary.processed)
      || !safeCount(summary.flagged, MAX_RESOURCES)
      || !safeCount(summary.ignored)
      || !safeCount(summary.suppressed)
      || value.flaggedResources.length > MAX_RESOURCES - resources.length
    ) reject("STANDARD_EVIDENCE_REJECTED");
    checkIds.add(checkId);
    const checkCanonical = canonicalJson({
      checkId,
      name,
      category,
      status,
      dataThroughAtIso,
      summary,
    });
    checks.push({
      checkId,
      name,
      category,
      status: status as "ok" | "warning" | "error" | "not_available",
      dataThroughAtIso: dataThroughAtIso as string | null,
      processedCount: summary.processed as number,
      flaggedCount: summary.flagged as number,
      ignoredCount: summary.ignored as number,
      suppressedCount: summary.suppressed as number,
      contentSha256: await sha256(checkCanonical),
    });
    for (const resourceValue of value.flaggedResources) {
      if (!isRecord(resourceValue) || !Array.isArray(resourceValue.metadata)) {
        reject("STANDARD_EVIDENCE_REJECTED");
      }
      if (
        typeof resourceValue.resourceId !== "string"
        || resourceValue.resourceId.length < 1
        || resourceValue.resourceId.length > 2_048
        || (resourceValue.region !== null
          && (typeof resourceValue.region !== "string"
            || resourceValue.region.length < 1
            || resourceValue.region.length > 128))
        || !new Set(["ok", "warning", "error"]).has(String(resourceValue.status))
        || typeof resourceValue.suppressed !== "boolean"
        || resourceValue.metadata.length > MAX_METADATA_FIELDS
      ) reject("STANDARD_EVIDENCE_REJECTED");
      const metadata = resourceValue.metadata.map((entry) => {
        if (
          !isRecord(entry)
          || typeof entry.name !== "string"
          || entry.name.length < 1
          || entry.name.length > 256
          || typeof entry.value !== "string"
          || entry.value.length > 4_096
        ) reject("STANDARD_EVIDENCE_REJECTED");
        return { name: entry.name, value: entry.value };
      }).sort((left, right) => left.name.localeCompare(right.name));
      if (new Set(metadata.map((entry) => entry.name)).size !== metadata.length) {
        reject("STANDARD_EVIDENCE_REJECTED");
      }
      const metadataJson = canonicalJson(metadata);
      const metadataSha256 = await sha256(metadataJson);
      const withoutKey = {
        checkId,
        resourceId: resourceValue.resourceId,
        region: resourceValue.region as string | null,
        status: resourceValue.status as "ok" | "warning" | "error",
        suppressed: resourceValue.suppressed,
        metadataJson,
        metadataSha256,
      };
      resources.push({
        ...withoutKey,
        resourceKey: await resourceKey(
          manifestId,
          parsed.accountId,
          withoutKey,
        ),
      });
    }
  }
  const rejectedRecordCount = parsed.coverage.recordsRejected
    + parsed.coverage.recordsOmitted;
  if (rejectedRecordCount > MAX_RESOURCES) reject("STANDARD_EVIDENCE_REJECTED");
  const status = parsed.collectionStatus === "COMPLETE"
    && rejectedRecordCount === 0 ? "complete" as const : "partial" as const;
  const input = {
    accountId: parsed.accountId,
    status,
    collectedAtIso: parsed.collectedAt,
    dataThroughAtIso: parsed.dataThroughAt,
    rejectedRecordCount,
    evidenceReference: reference,
    checks,
    resources,
  };
  return {
    ...input,
    contentSha256: await accountSnapshotSha256(input),
  };
}

function assertManifestJobMember(
  job: RunnableJob,
  manifest: StoredTrustedAdvisorManifest,
  manifestId: string,
  accountId: string,
  targetConnectionId: string,
): TrustedAdvisorOrganizationScope {
  if (
    job.customerId === null
    || manifest.manifestId !== manifestId
    || manifest.scope.organizationId !== job.orgId
    || manifest.scope.customerId !== job.customerId
    || manifest.expectedAccountCount !== manifest.accounts.length
  ) reject("INVALID_SCOPE");
  const member = manifest.accounts.find((account) => account.accountId === accountId);
  if (member === undefined || member.targetConnectionId !== targetConnectionId) {
    reject("MANIFEST_REJECTED");
  }
  return manifest.scope;
}

export async function runTrustedAdvisorAccountCollectionJob(
  job: RunnableJob,
  dependencies: TrustedAdvisorAccountDependencies,
): Promise<{ readonly status: "accepted" | "partial" | "failed" | "replayed" } > {
  const payload = parseTrustedAdvisorAccountCollectJobPayload(job.payload);
  if (
    job.kind !== "finops-ta-account-collect"
    || job.customerId === null
    || job.connectionId !== payload.connectionId
    || !IDENTIFIER.test(job.id)
    || !Number.isSafeInteger(job.attempt)
    || job.attempt < 1
    || job.attempt > 100
  ) reject("INVALID_JOB");
  const manifest = await dependencies.findManifest({
    organizationId: job.orgId,
    customerId: job.customerId,
    manifestId: payload.manifestId,
  });
  if (manifest === null) reject("MANIFEST_REJECTED");
  const scope = assertManifestJobMember(
    job,
    manifest,
    payload.manifestId,
    payload.accountId,
    payload.connectionId,
  );
  const member = manifest.accounts.find((account) => account.accountId === payload.accountId)!;
  const enqueueFinalizerWhenTerminal = async (): Promise<void> => {
    const refreshed = await dependencies.repository.getManifest(scope, manifest.manifestId);
    if (
      refreshed !== null
      && refreshed.accounts.every((account) =>
        !new Set(["pending", "running"]).has(account.status))
    ) {
      await enqueueTrustedAdvisorManifestFinalization(
        dependencies.queue,
        scope,
        refreshed,
        now(dependencies.now),
      );
    }
  };
  if (new Set(["accepted", "partial", "failed"]).has(member.status)) {
    await enqueueFinalizerWhenTerminal();
    return { status: "replayed" };
  }
  if (member.status !== "pending" && member.status !== "running") {
    reject("MANIFEST_REJECTED");
  }
  const nowMs = now(dependencies.now);
  if (member.status === "pending") {
    await dependencies.repository.startAccount(scope, manifest.manifestId, member.accountId, nowMs);
  }
  let source: TrustedAdvisorStandardSourceEvidence;
  try {
    source = await dependencies.collectCompletedStandardChecks({
      organizationId: scope.organizationId,
      customerId: scope.customerId,
      connectionId: payload.connectionId,
      accountId: payload.accountId,
      sourceId: TRUSTED_ADVISOR_STANDARD_SOURCE_ID,
      contractId: TRUSTED_ADVISOR_STANDARD_CONTRACT_ID,
      region: TRUSTED_ADVISOR_STANDARD_REGION,
      orchestrationJobId: job.id,
      attempt: job.attempt,
    });
  } catch (error) {
    if (job.attempt < job.maxAttempts) throw error;
    await dependencies.repository.markAccountUnavailable(
      scope,
      manifest.manifestId,
      member.accountId,
      "failed",
      "STANDARD_CHECK_COLLECTION_FAILED",
      nowMs,
    );
    await enqueueFinalizerWhenTerminal();
    return { status: "failed" };
  }
  let snapshot: RecordTrustedAdvisorAccountSnapshotInput;
  try {
    const parsed = await parseStandardEvidence(source, {
      scope: { ...scope, connectionId: payload.connectionId },
      accountId: payload.accountId,
      jobId: job.id,
      attempt: job.attempt,
    });
    snapshot = await materializeAccountSnapshot(
      manifest.manifestId,
      parsed,
      source.snapshot.evidenceReference,
    );
  } catch {
    await dependencies.repository.markAccountUnavailable(
      scope,
      manifest.manifestId,
      member.accountId,
      "failed",
      "STANDARD_CHECK_EVIDENCE_REJECTED",
      nowMs,
    );
    return { status: "failed" };
  }
  await dependencies.repository.recordAccountSnapshot(
    scope,
    manifest.manifestId,
    snapshot,
    nowMs,
  );
  await enqueueFinalizerWhenTerminal();
  return { status: snapshot.status === "complete" ? "accepted" : "partial" };
}

export async function runTrustedAdvisorManifestFinalizeJob(
  job: RunnableJob,
  dependencies: TrustedAdvisorFinalizeDependencies,
): Promise<unknown> {
  const payload = parseTrustedAdvisorManifestFinalizeJobPayload(job.payload);
  const scope = scopeFromJob(job);
  if (
    job.kind !== "finops-ta-manifest-finalize"
    || payload.connectionId !== scope.connectionId
  ) reject("INVALID_JOB");
  const manifest = await dependencies.findManifest({
    organizationId: scope.organizationId,
    customerId: scope.customerId,
    manifestId: payload.manifestId,
  });
  if (
    manifest === null
    || manifest.manifestId !== payload.manifestId
    || manifest.scope.organizationId !== scope.organizationId
    || manifest.scope.customerId !== scope.customerId
    || manifest.scope.connectionId !== scope.connectionId
  ) reject("MANIFEST_REJECTED");
  if (manifest.accounts.some((account) =>
    account.status === "pending" || account.status === "running")) {
    reject("NOT_TERMINAL");
  }
  return dependencies.repository.finalizeManifest(
    scope,
    manifest.manifestId,
    now(dependencies.now),
  );
}
