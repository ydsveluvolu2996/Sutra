/** Identity-only durable orchestration for Trusted Advisor organization fan-out. */
import type {
  StoredTrustedAdvisorManifest,
  TrustedAdvisorOrganizationScope,
} from "../db/finops-trusted-advisor-organization-repository.ts";

export const FINOPS_TA_ACCOUNT_COLLECT_JOB_KIND = "finops-ta-account-collect";
export const FINOPS_TA_MANIFEST_FINALIZE_JOB_KIND = "finops-ta-manifest-finalize";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const MANIFEST_ID = /^tam_[a-f0-9]{64}$/u;
const ACCOUNT_ID = /^[0-9]{12}$/u;

export interface TrustedAdvisorAccountCollectJobPayload {
  readonly manifestId: string;
  readonly accountId: string;
  readonly connectionId: string;
}

export interface TrustedAdvisorManifestFinalizeJobPayload {
  readonly manifestId: string;
  readonly connectionId: string;
}

export interface TrustedAdvisorOrganizationQueue {
  enqueue(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly kind: string;
    readonly payload: TrustedAdvisorAccountCollectJobPayload | TrustedAdvisorManifestFinalizeJobPayload;
    readonly maxAttempts: number;
    readonly idempotencyKey: string;
  }, nowMs?: number): Promise<{ readonly id: string }>;
}

export class TrustedAdvisorOrganizationJobError extends Error {
  public readonly code: "INVALID_JOB" | "INVALID_SCOPE" | "INVALID_MANIFEST" | "QUEUE_REJECTED";

  public constructor(code: TrustedAdvisorOrganizationJobError["code"]) {
    super("Trusted Advisor organization job rejected");
    this.name = "TrustedAdvisorOrganizationJobError";
    this.code = code;
  }
}

function reject(code: TrustedAdvisorOrganizationJobError["code"]): never {
  throw new TrustedAdvisorOrganizationJobError(code);
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject("INVALID_JOB");
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) {
    reject("INVALID_JOB");
  }
  return record;
}

export function parseTrustedAdvisorAccountCollectJobPayload(
  value: unknown,
): TrustedAdvisorAccountCollectJobPayload {
  const record = exactRecord(value, ["manifestId", "accountId", "connectionId"]);
  if (
    typeof record.manifestId !== "string" || !MANIFEST_ID.test(record.manifestId)
    || typeof record.accountId !== "string" || !ACCOUNT_ID.test(record.accountId)
    || typeof record.connectionId !== "string" || !CONNECTION_ID.test(record.connectionId)
  ) reject("INVALID_JOB");
  return {
    manifestId: record.manifestId,
    accountId: record.accountId,
    connectionId: record.connectionId,
  };
}

export function parseTrustedAdvisorManifestFinalizeJobPayload(
  value: unknown,
): TrustedAdvisorManifestFinalizeJobPayload {
  const record = exactRecord(value, ["manifestId", "connectionId"]);
  if (
    typeof record.manifestId !== "string" || !MANIFEST_ID.test(record.manifestId)
    || typeof record.connectionId !== "string" || !CONNECTION_ID.test(record.connectionId)
  ) reject("INVALID_JOB");
  return { manifestId: record.manifestId, connectionId: record.connectionId };
}

function assertScopeAndManifest(
  scope: TrustedAdvisorOrganizationScope,
  manifest: StoredTrustedAdvisorManifest,
): void {
  if (
    !IDENTIFIER.test(scope.organizationId)
    || !IDENTIFIER.test(scope.customerId)
    || !CONNECTION_ID.test(scope.connectionId)
    || manifest.scope.organizationId !== scope.organizationId
    || manifest.scope.customerId !== scope.customerId
    || manifest.scope.connectionId !== scope.connectionId
    || !MANIFEST_ID.test(manifest.manifestId)
    || manifest.expectedAccountCount !== manifest.accounts.length
  ) reject("INVALID_SCOPE");
}

/**
 * Fan out only the accounts already frozen by the repository. There is no
 * account-list argument, so a browser cannot add work outside the manifest.
 */
export async function enqueueTrustedAdvisorAccountCollections(
  queue: TrustedAdvisorOrganizationQueue,
  scope: TrustedAdvisorOrganizationScope,
  manifest: StoredTrustedAdvisorManifest,
  nowMs = Date.now(),
): Promise<readonly string[]> {
  assertScopeAndManifest(scope, manifest);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || manifest.status !== "collecting") {
    reject("INVALID_MANIFEST");
  }
  const jobIds: string[] = [];
  for (const account of manifest.accounts) {
    if (account.status !== "pending" || account.targetConnectionId === null) continue;
    const payload = parseTrustedAdvisorAccountCollectJobPayload({
      manifestId: manifest.manifestId,
      accountId: account.accountId,
      connectionId: account.targetConnectionId,
    });
    const queued = await queue.enqueue({
      orgId: scope.organizationId,
      customerId: scope.customerId,
      connectionId: account.targetConnectionId,
      kind: FINOPS_TA_ACCOUNT_COLLECT_JOB_KIND,
      payload,
      maxAttempts: 6,
      idempotencyKey: `finops-ta-account:${manifest.manifestId}:${account.accountId}`,
    }, nowMs);
    if (!/^job_[a-f0-9]{32}$/u.test(queued.id)) reject("QUEUE_REJECTED");
    jobIds.push(queued.id);
  }
  return jobIds;
}

export async function enqueueTrustedAdvisorManifestFinalization(
  queue: TrustedAdvisorOrganizationQueue,
  scope: TrustedAdvisorOrganizationScope,
  manifest: StoredTrustedAdvisorManifest,
  nowMs = Date.now(),
): Promise<string> {
  assertScopeAndManifest(scope, manifest);
  if (
    !Number.isSafeInteger(nowMs) || nowMs < 0
    || !new Set(["collecting", "finalizing"]).has(manifest.status)
  ) reject("INVALID_MANIFEST");
  const payload = parseTrustedAdvisorManifestFinalizeJobPayload({
    manifestId: manifest.manifestId,
    connectionId: scope.connectionId,
  });
  const queued = await queue.enqueue({
    orgId: scope.organizationId,
    customerId: scope.customerId,
    connectionId: scope.connectionId,
    kind: FINOPS_TA_MANIFEST_FINALIZE_JOB_KIND,
    payload,
    maxAttempts: 12,
    idempotencyKey: `finops-ta-finalize:${manifest.manifestId}`,
  }, nowMs);
  if (!/^job_[a-f0-9]{32}$/u.test(queued.id)) reject("QUEUE_REJECTED");
  return queued.id;
}
