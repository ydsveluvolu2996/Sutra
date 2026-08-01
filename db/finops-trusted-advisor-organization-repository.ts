/**
 * Server-owned Trusted Advisor organization collection persistence.
 *
 * A manifest freezes the account set before fan-out. Account/check/resource
 * snapshots and organization generations are append-only; only the accepted
 * head is mutable, and database guards permit it to advance to a fresher,
 * complete generation. This module intentionally has no HTTP payload parser.
 */
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^[0-9]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SEALED_REFERENCE = /^fsev1\.[A-Za-z0-9_-]{26,8186}$/u;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,95}$/u;
const MAX_ACCOUNTS = 10_000;
const MAX_CHECKS = 512;
const MAX_RESOURCES = 25_000;
const MAX_HISTORY = 36;
const MAX_DASHBOARD_ACCOUNTS = 200;
const MAX_DASHBOARD_CHECKS = 500;
const MAX_DASHBOARD_RESOURCES = 500;

export interface TrustedAdvisorOrganizationScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface TrustedAdvisorManifestAccountCandidate {
  readonly accountId: string;
  readonly targetConnectionId: string | null;
}

export interface CreateTrustedAdvisorManifestInput {
  readonly jobId: string;
  readonly taxonomySnapshotId: string;
  readonly taxonomySha256: string;
  readonly accountSetSha256: string;
  /** Trusted server discovery output. Never deserialize this from an API body. */
  readonly accounts: readonly TrustedAdvisorManifestAccountCandidate[];
}

export type TrustedAdvisorManifestStatus =
  | "pending" | "collecting" | "finalizing" | "complete" | "partial" | "failed";
export type TrustedAdvisorManifestAccountStatus =
  | "pending" | "running" | "accepted" | "partial" | "failed" | "unconfigured";

export interface StoredTrustedAdvisorManifestAccount {
  readonly accountId: string;
  readonly accountPosition: number;
  readonly targetConnectionId: string | null;
  readonly status: TrustedAdvisorManifestAccountStatus;
  readonly accountSnapshotId: string | null;
  readonly errorCode: string | null;
}

export interface StoredTrustedAdvisorManifest {
  readonly scope: TrustedAdvisorOrganizationScope;
  readonly manifestId: string;
  readonly jobId: string;
  readonly taxonomySnapshotId: string;
  readonly taxonomySha256: string;
  readonly accountSetSha256: string;
  readonly expectedAccountCount: number;
  readonly status: TrustedAdvisorManifestStatus;
  readonly createdAtIso: string;
  readonly startedAtIso: string | null;
  readonly finalizedAtIso: string | null;
  readonly accounts: readonly StoredTrustedAdvisorManifestAccount[];
}

export interface TrustedAdvisorCheckSnapshotInput {
  readonly checkId: string;
  readonly name: string;
  readonly category: string;
  readonly status: "ok" | "warning" | "error" | "not_available";
  readonly dataThroughAtIso: string | null;
  readonly processedCount: number;
  readonly flaggedCount: number;
  readonly ignoredCount: number;
  readonly suppressedCount: number;
  readonly contentSha256: string;
}

export interface TrustedAdvisorResourceSnapshotInput {
  readonly resourceKey: string;
  readonly checkId: string;
  readonly resourceId: string;
  readonly region: string | null;
  readonly status: "ok" | "warning" | "error";
  readonly suppressed: boolean;
  /** Canonical normalized metadata only; never a provider payload. */
  readonly metadataJson: string;
  readonly metadataSha256: string;
}

export interface TrustedAdvisorAccountSnapshotHashInput {
  readonly accountId: string;
  readonly status: "complete" | "partial";
  readonly collectedAtIso: string;
  readonly dataThroughAtIso: string | null;
  readonly rejectedRecordCount: number;
  readonly evidenceReference: { readonly ciphertext: string; readonly keyVersion: string };
  readonly checks: readonly TrustedAdvisorCheckSnapshotInput[];
  readonly resources: readonly TrustedAdvisorResourceSnapshotInput[];
}

export interface RecordTrustedAdvisorAccountSnapshotInput
  extends TrustedAdvisorAccountSnapshotHashInput {
  readonly contentSha256: string;
}

export interface StoredTrustedAdvisorOrganizationSnapshot {
  readonly scope: TrustedAdvisorOrganizationScope;
  readonly generationId: string;
  readonly manifestId: string;
  readonly status: "complete" | "partial" | "failed";
  readonly contentSha256: string;
  readonly collectedAtIso: string;
  readonly dataThroughAtIso: string | null;
  readonly expectedAccountCount: number;
  readonly acceptedAccountCount: number;
  readonly rejectedAccountCount: number;
  readonly checkCount: number;
  readonly resourceCount: number;
  readonly createdAtIso: string;
}

export interface TrustedAdvisorOrganizationDashboardFilters {
  readonly accountId: string | null;
  readonly checkId: string | null;
  readonly status: "ok" | "warning" | "error" | null;
  readonly region: string | null;
  readonly category: string | null;
  readonly suppressed: boolean | null;
}

export interface TrustedAdvisorOrganizationDashboardAccount {
  readonly accountId: string;
  readonly collectedAtIso: string;
  readonly dataThroughAtIso: string | null;
  readonly checkCount: number;
  readonly resourceCount: number;
  readonly rejectedRecordCount: number;
}

export interface TrustedAdvisorOrganizationDashboardCheck {
  readonly checkId: string;
  readonly name: string;
  readonly category: string;
  readonly status: "ok" | "warning" | "error" | "not_available";
  readonly accountCount: number;
  readonly processedCount: number;
  readonly flaggedCount: number;
  readonly ignoredCount: number;
  readonly suppressedCount: number;
}

export interface TrustedAdvisorOrganizationDashboardResource {
  readonly resourceKey: string;
  readonly accountId: string;
  readonly checkId: string;
  readonly checkName: string;
  readonly checkCategory: string;
  readonly resourceId: string;
  readonly region: string | null;
  readonly status: "ok" | "warning" | "error";
  readonly suppressed: boolean;
  readonly metadataJson: string;
  readonly metadataSha256: string;
}

export interface TrustedAdvisorOrganizationDashboardProjection {
  readonly snapshot: StoredTrustedAdvisorOrganizationSnapshot;
  readonly filters: TrustedAdvisorOrganizationDashboardFilters;
  readonly accounts: readonly TrustedAdvisorOrganizationDashboardAccount[];
  readonly accountsTruncated: boolean;
  readonly checks: readonly TrustedAdvisorOrganizationDashboardCheck[];
  readonly checksTruncated: boolean;
  readonly resources: readonly TrustedAdvisorOrganizationDashboardResource[];
  readonly resourcesTruncated: boolean;
  readonly history: readonly StoredTrustedAdvisorOrganizationSnapshot[];
}

export class TrustedAdvisorOrganizationRepositoryError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "SCOPE_NOT_FOUND"
    | "IMMUTABLE_CONFLICT"
    | "INVALID_TRANSITION"
    | "CHECKSUM_MISMATCH"
    | "NOT_TERMINAL"
    | "STORED_STATE_INVALID";

  public constructor(code: TrustedAdvisorOrganizationRepositoryError["code"]) {
    super("Trusted Advisor organization persistence operation rejected");
    this.name = "TrustedAdvisorOrganizationRepositoryError";
    this.code = code;
  }
}

interface ManifestRow {
  manifest_id: string;
  org_id: string;
  customer_id: string;
  anchor_connection_id: string;
  job_id: string;
  taxonomy_snapshot_id: string;
  taxonomy_sha256: string;
  account_set_sha256: string;
  expected_account_count: number | string;
  status: TrustedAdvisorManifestStatus;
  created_at: number | string;
  started_at: number | string | null;
  finalized_at: number | string | null;
}

interface ManifestAccountRow {
  account_id: string;
  account_position: number | string;
  target_connection_id: string | null;
  status: TrustedAdvisorManifestAccountStatus;
  account_snapshot_id: string | null;
  error_code: string | null;
}

interface OrganizationSnapshotRow {
  generation_id: string;
  manifest_id: string;
  org_id: string;
  customer_id: string;
  anchor_connection_id: string;
  status: "complete" | "partial" | "failed";
  content_sha256: string;
  collected_at: string;
  data_through_at: string | null;
  expected_account_count: number | string;
  accepted_account_count: number | string;
  rejected_account_count: number | string;
  check_count: number | string;
  resource_count: number | string;
  created_at: number | string;
}

interface DashboardAccountRow {
  account_id: string;
  collected_at: string;
  data_through_at: string | null;
  check_count: number | string;
  resource_count: number | string;
  rejected_record_count: number | string;
}

interface DashboardCheckRow {
  check_id: string;
  name: string;
  category: string;
  status: "ok" | "warning" | "error" | "not_available";
  account_count: number | string;
  processed_count: number | string;
  flagged_count: number | string;
  ignored_count: number | string;
  suppressed_count: number | string;
}

interface DashboardResourceRow {
  resource_key: string;
  account_id: string;
  check_id: string;
  check_name: string;
  check_category: string;
  resource_id: string;
  region: string | null;
  status: "ok" | "warning" | "error";
  suppressed: number | string;
  metadata_json: string;
  metadata_sha256: string;
}

function reject(
  code: TrustedAdvisorOrganizationRepositoryError["code"] = "INVALID_INPUT",
): never {
  throw new TrustedAdvisorOrganizationRepositoryError(code);
}

function safeInteger(value: unknown, stored = false): number {
  const candidate = typeof value === "string" ? Number(value) : value;
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
    reject(stored ? "STORED_STATE_INVALID" : "INVALID_INPUT");
  }
  return candidate;
}

function normalizedIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

function assertScope(scope: TrustedAdvisorOrganizationScope): void {
  if (
    typeof scope !== "object" || scope === null
    || !IDENTIFIER.test(scope.organizationId)
    || !IDENTIFIER.test(scope.customerId)
    || !CONNECTION_ID.test(scope.connectionId)
  ) reject();
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalAccounts(
  accounts: readonly TrustedAdvisorManifestAccountCandidate[],
): TrustedAdvisorManifestAccountCandidate[] {
  if (!Array.isArray(accounts) || accounts.length < 1 || accounts.length > MAX_ACCOUNTS) reject();
  const normalized = accounts.map((account) => {
    if (
      typeof account !== "object" || account === null
      || !ACCOUNT_ID.test(account.accountId)
      || (account.targetConnectionId !== null && !CONNECTION_ID.test(account.targetConnectionId))
    ) reject();
    return { accountId: account.accountId, targetConnectionId: account.targetConnectionId };
  }).sort((left, right) => left.accountId.localeCompare(right.accountId));
  if (new Set(normalized.map((account) => account.accountId)).size !== normalized.length) reject();
  return normalized;
}

export async function trustedAdvisorAccountSetSha256(
  accounts: readonly TrustedAdvisorManifestAccountCandidate[],
): Promise<string> {
  return sha256(JSON.stringify(canonicalAccounts(accounts)));
}

function canonicalAccountSnapshot(input: TrustedAdvisorAccountSnapshotHashInput): string {
  const checks = [...input.checks].sort((left, right) => left.checkId.localeCompare(right.checkId));
  const resources = [...input.resources].sort((left, right) => left.resourceKey.localeCompare(right.resourceKey));
  return JSON.stringify({
    accountId: input.accountId,
    status: input.status,
    collectedAtIso: input.collectedAtIso,
    dataThroughAtIso: input.dataThroughAtIso,
    rejectedRecordCount: input.rejectedRecordCount,
    evidenceReference: input.evidenceReference,
    checks,
    resources,
  });
}

export async function trustedAdvisorAccountSnapshotSha256(
  input: TrustedAdvisorAccountSnapshotHashInput,
): Promise<string> {
  return sha256(canonicalAccountSnapshot(input));
}

export async function trustedAdvisorResourceKey(
  manifestId: string,
  accountId: string,
  resource: Omit<TrustedAdvisorResourceSnapshotInput, "resourceKey">,
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

function storedManifest(row: ManifestRow, accounts: readonly ManifestAccountRow[]): StoredTrustedAdvisorManifest {
  const createdAt = safeInteger(row.created_at, true);
  const startedAt = row.started_at === null ? null : safeInteger(row.started_at, true);
  const finalizedAt = row.finalized_at === null ? null : safeInteger(row.finalized_at, true);
  return {
    scope: {
      organizationId: row.org_id,
      customerId: row.customer_id,
      connectionId: row.anchor_connection_id,
    },
    manifestId: row.manifest_id,
    jobId: row.job_id,
    taxonomySnapshotId: row.taxonomy_snapshot_id,
    taxonomySha256: row.taxonomy_sha256,
    accountSetSha256: row.account_set_sha256,
    expectedAccountCount: safeInteger(row.expected_account_count, true),
    status: row.status,
    createdAtIso: new Date(createdAt).toISOString(),
    startedAtIso: startedAt === null ? null : new Date(startedAt).toISOString(),
    finalizedAtIso: finalizedAt === null ? null : new Date(finalizedAt).toISOString(),
    accounts: accounts.map((account) => ({
      accountId: account.account_id,
      accountPosition: safeInteger(account.account_position, true),
      targetConnectionId: account.target_connection_id,
      status: account.status,
      accountSnapshotId: account.account_snapshot_id,
      errorCode: account.error_code,
    })),
  };
}

function storedOrganizationSnapshot(row: OrganizationSnapshotRow): StoredTrustedAdvisorOrganizationSnapshot {
  return {
    scope: {
      organizationId: row.org_id,
      customerId: row.customer_id,
      connectionId: row.anchor_connection_id,
    },
    generationId: row.generation_id,
    manifestId: row.manifest_id,
    status: row.status,
    contentSha256: row.content_sha256,
    collectedAtIso: row.collected_at,
    dataThroughAtIso: row.data_through_at,
    expectedAccountCount: safeInteger(row.expected_account_count, true),
    acceptedAccountCount: safeInteger(row.accepted_account_count, true),
    rejectedAccountCount: safeInteger(row.rejected_account_count, true),
    checkCount: safeInteger(row.check_count, true),
    resourceCount: safeInteger(row.resource_count, true),
    createdAtIso: new Date(safeInteger(row.created_at, true)).toISOString(),
  };
}

export class TrustedAdvisorOrganizationRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  private async assertLiveScope(scope: TrustedAdvisorOrganizationScope): Promise<D1Database> {
    assertScope(scope);
    const database = await this.ready();
    const row = await database.prepare(
      `SELECT c.id FROM aws_connections c
       JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
       JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id AND cu.status = 'active'
       WHERE c.org_id = ? AND c.customer_id = ? AND c.id = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active' LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId).first<{ id: string }>();
    if (row === null) reject("SCOPE_NOT_FOUND");
    return database;
  }

  private async readManifest(
    database: D1Database,
    scope: TrustedAdvisorOrganizationScope,
    manifestId: string,
  ): Promise<StoredTrustedAdvisorManifest | null> {
    const row = await database.prepare(
      `SELECT * FROM finops_ta_collection_manifests
       WHERE org_id = ? AND customer_id = ? AND anchor_connection_id = ? AND manifest_id = ? LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId, manifestId).first<ManifestRow>();
    if (row === null) return null;
    const accountRows = await database.prepare(
      `SELECT account_id, account_position, target_connection_id, status, account_snapshot_id, error_code
       FROM finops_ta_manifest_accounts
       WHERE manifest_id = ? AND org_id = ? AND customer_id = ? AND anchor_connection_id = ?
       ORDER BY account_position ASC`,
    ).bind(
      manifestId,
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
    ).all<ManifestAccountRow>();
    return storedManifest(row, accountRows.results ?? []);
  }

  public async createManifest(
    scope: TrustedAdvisorOrganizationScope,
    input: CreateTrustedAdvisorManifestInput,
    nowMs = Date.now(),
  ): Promise<StoredTrustedAdvisorManifest> {
    if (
      typeof input !== "object" || input === null
      || !IDENTIFIER.test(input.jobId)
      || !IDENTIFIER.test(input.taxonomySnapshotId)
      || !SHA256.test(input.taxonomySha256)
      || !SHA256.test(input.accountSetSha256)
      || !Number.isSafeInteger(nowMs) || nowMs < 0
    ) reject();
    const accounts = canonicalAccounts(input.accounts);
    if (await trustedAdvisorAccountSetSha256(accounts) !== input.accountSetSha256) {
      reject("CHECKSUM_MISMATCH");
    }
    const database = await this.assertLiveScope(scope);
    const available = await database.prepare(
      `SELECT id, aws_account_id FROM aws_connections
       WHERE org_id = ? AND customer_id = ? AND source_kind = 'aws_trust_role' AND status = 'active'
       LIMIT 10001`,
    ).bind(scope.organizationId, scope.customerId).all<{ id: string; aws_account_id: string }>();
    const byConnection = new Map((available.results ?? []).map((row) => [row.id, row.aws_account_id]));
    for (const account of accounts) {
      if (
        account.targetConnectionId !== null
        && byConnection.get(account.targetConnectionId) !== account.accountId
      ) reject("SCOPE_NOT_FOUND");
    }
    const manifestDigest = await sha256(JSON.stringify({
      scope,
      jobId: input.jobId,
      taxonomySnapshotId: input.taxonomySnapshotId,
      taxonomySha256: input.taxonomySha256,
      accountSetSha256: input.accountSetSha256,
    }));
    const manifestId = `tam_${manifestDigest}`;
    const existing = await this.readManifest(database, scope, manifestId);
    if (existing !== null) {
      if (
        existing.jobId !== input.jobId
        || existing.taxonomySnapshotId !== input.taxonomySnapshotId
        || existing.taxonomySha256 !== input.taxonomySha256
        || existing.accountSetSha256 !== input.accountSetSha256
        || existing.expectedAccountCount !== accounts.length
      ) reject("IMMUTABLE_CONFLICT");
      return existing;
    }

    const statements: D1PreparedStatement[] = [database.prepare(
      `INSERT INTO finops_ta_collection_manifests (
         manifest_id, org_id, customer_id, anchor_connection_id, job_id,
         taxonomy_snapshot_id, taxonomy_sha256, account_set_sha256,
         expected_account_count, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).bind(
      manifestId, scope.organizationId, scope.customerId, scope.connectionId, input.jobId,
      input.taxonomySnapshotId, input.taxonomySha256, input.accountSetSha256, accounts.length, nowMs,
    )];
    accounts.forEach((account, position) => statements.push(database.prepare(
      `INSERT INTO finops_ta_manifest_accounts (
         manifest_id, org_id, customer_id, anchor_connection_id, account_id,
         account_position, target_connection_id, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    ).bind(
      manifestId, scope.organizationId, scope.customerId, scope.connectionId,
      account.accountId, position, account.targetConnectionId,
    )));
    try {
      await database.batch(statements);
    } catch {
      const raced = await this.readManifest(database, scope, manifestId);
      if (raced !== null && raced.accountSetSha256 === input.accountSetSha256) return raced;
      reject("IMMUTABLE_CONFLICT");
    }
    return await this.readManifest(database, scope, manifestId) ?? reject("STORED_STATE_INVALID");
  }

  public async getManifest(
    scope: TrustedAdvisorOrganizationScope,
    manifestId: string,
  ): Promise<StoredTrustedAdvisorManifest | null> {
    if (!/^tam_[a-f0-9]{64}$/u.test(manifestId)) reject();
    const database = await this.assertLiveScope(scope);
    return this.readManifest(database, scope, manifestId);
  }

  public async getLatestManifest(
    scope: TrustedAdvisorOrganizationScope,
  ): Promise<StoredTrustedAdvisorManifest | null> {
    const database = await this.assertLiveScope(scope);
    const row = await database.prepare(
      `SELECT manifest_id FROM finops_ta_collection_manifests
       WHERE org_id = ? AND customer_id = ? AND anchor_connection_id = ?
       ORDER BY created_at DESC, manifest_id DESC LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId)
      .first<{ manifest_id: string }>();
    return row === null ? null : this.readManifest(database, scope, row.manifest_id);
  }

  public async startManifest(
    scope: TrustedAdvisorOrganizationScope,
    manifestId: string,
    nowMs = Date.now(),
  ): Promise<StoredTrustedAdvisorManifest> {
    if (!/^tam_[a-f0-9]{64}$/u.test(manifestId) || !Number.isSafeInteger(nowMs) || nowMs < 0) reject();
    const database = await this.assertLiveScope(scope);
    await database.prepare(
      `UPDATE finops_ta_collection_manifests SET status = 'collecting', started_at = ?
       WHERE org_id = ? AND customer_id = ? AND anchor_connection_id = ?
         AND manifest_id = ? AND status = 'pending'`,
    ).bind(nowMs, scope.organizationId, scope.customerId, scope.connectionId, manifestId).run();
    const stored = await this.readManifest(database, scope, manifestId);
    if (stored === null || !new Set(["collecting", "finalizing"]).has(stored.status)) {
      reject("INVALID_TRANSITION");
    }
    return stored;
  }

  public async startAccount(
    scope: TrustedAdvisorOrganizationScope,
    manifestId: string,
    accountId: string,
    nowMs = Date.now(),
  ): Promise<void> {
    if (!/^tam_[a-f0-9]{64}$/u.test(manifestId) || !ACCOUNT_ID.test(accountId) || !Number.isSafeInteger(nowMs) || nowMs < 0) reject();
    const database = await this.assertLiveScope(scope);
    const result = await database.prepare(
      `UPDATE finops_ta_manifest_accounts SET status = 'running', started_at = ?
       WHERE manifest_id = ? AND org_id = ? AND customer_id = ? AND anchor_connection_id = ?
         AND account_id = ? AND target_connection_id IS NOT NULL AND status = 'pending'`,
    ).bind(nowMs, manifestId, scope.organizationId, scope.customerId, scope.connectionId, accountId).run();
    if ((result.meta?.changes ?? 0) === 1) return;
    const existing = await database.prepare(
      `SELECT status FROM finops_ta_manifest_accounts
       WHERE manifest_id = ? AND org_id = ? AND customer_id = ? AND anchor_connection_id = ?
         AND account_id = ? AND target_connection_id IS NOT NULL LIMIT 1`,
    ).bind(manifestId, scope.organizationId, scope.customerId, scope.connectionId, accountId)
      .first<{ status: string }>();
    if (existing?.status !== "running") reject("INVALID_TRANSITION");
  }

  public async markAccountUnavailable(
    scope: TrustedAdvisorOrganizationScope,
    manifestId: string,
    accountId: string,
    status: "failed" | "unconfigured",
    errorCode: string,
    nowMs = Date.now(),
  ): Promise<void> {
    if (
      !/^tam_[a-f0-9]{64}$/u.test(manifestId) || !ACCOUNT_ID.test(accountId)
      || !ERROR_CODE.test(errorCode) || !Number.isSafeInteger(nowMs) || nowMs < 0
    ) reject();
    const database = await this.assertLiveScope(scope);
    const result = await database.prepare(
      status === "unconfigured"
        ? `UPDATE finops_ta_manifest_accounts SET status = 'unconfigured', error_code = ?, finished_at = ?
           WHERE manifest_id = ? AND org_id = ? AND customer_id = ? AND anchor_connection_id = ?
             AND account_id = ? AND target_connection_id IS NULL AND status = 'pending'`
        : `UPDATE finops_ta_manifest_accounts SET status = 'failed', error_code = ?,
             started_at = COALESCE(started_at, ?), finished_at = ?
           WHERE manifest_id = ? AND org_id = ? AND customer_id = ? AND anchor_connection_id = ?
             AND account_id = ? AND status IN ('pending', 'running')`,
    ).bind(...(status === "unconfigured"
      ? [errorCode, nowMs, manifestId, scope.organizationId, scope.customerId, scope.connectionId, accountId]
      : [errorCode, nowMs, nowMs, manifestId, scope.organizationId, scope.customerId, scope.connectionId, accountId]
    )).run();
    if ((result.meta?.changes ?? 0) === 1) return;
    const existing = await database.prepare(
      `SELECT status, error_code FROM finops_ta_manifest_accounts
       WHERE manifest_id = ? AND org_id = ? AND customer_id = ? AND anchor_connection_id = ?
         AND account_id = ? LIMIT 1`,
    ).bind(manifestId, scope.organizationId, scope.customerId, scope.connectionId, accountId)
      .first<{ status: string; error_code: string | null }>();
    if (existing?.status !== status || existing.error_code !== errorCode) reject("INVALID_TRANSITION");
  }

  public async recordAccountSnapshot(
    scope: TrustedAdvisorOrganizationScope,
    manifestId: string,
    input: RecordTrustedAdvisorAccountSnapshotInput,
    nowMs = Date.now(),
  ): Promise<string> {
    if (!/^tam_[a-f0-9]{64}$/u.test(manifestId) || !Number.isSafeInteger(nowMs) || nowMs < 0) reject();
    const normalizedCollected = normalizedIso(input.collectedAtIso);
    const normalizedDataThrough = input.dataThroughAtIso === null ? null : normalizedIso(input.dataThroughAtIso);
    if (
      !ACCOUNT_ID.test(input.accountId) || !new Set(["complete", "partial"]).has(input.status)
      || normalizedCollected === null || (input.dataThroughAtIso !== null && normalizedDataThrough === null)
      || (normalizedDataThrough !== null && normalizedDataThrough > normalizedCollected)
      || !SHA256.test(input.contentSha256)
      || !Number.isSafeInteger(input.rejectedRecordCount) || input.rejectedRecordCount < 0
      || input.rejectedRecordCount > MAX_RESOURCES
      || !SEALED_REFERENCE.test(input.evidenceReference.ciphertext)
      || !KEY_VERSION.test(input.evidenceReference.keyVersion)
      || !Array.isArray(input.checks) || input.checks.length > MAX_CHECKS
      || !Array.isArray(input.resources) || input.resources.length > MAX_RESOURCES
      || (input.status === "complete" && (normalizedDataThrough === null || input.rejectedRecordCount !== 0))
    ) reject();
    const checks = [...input.checks].sort((left, right) => left.checkId.localeCompare(right.checkId));
    const checkIds = new Set<string>();
    for (const check of checks) {
      if (
        !IDENTIFIER.test(check.checkId) || checkIds.has(check.checkId)
        || typeof check.name !== "string" || check.name.length < 1 || check.name.length > 512
        || typeof check.category !== "string" || check.category.length < 1 || check.category.length > 128
        || !new Set(["ok", "warning", "error", "not_available"]).has(check.status)
        || (check.dataThroughAtIso !== null && normalizedIso(check.dataThroughAtIso) === null)
        || ![check.processedCount, check.flaggedCount, check.ignoredCount, check.suppressedCount]
          .every((count) => Number.isSafeInteger(count) && count >= 0)
        || !SHA256.test(check.contentSha256)
      ) reject();
      checkIds.add(check.checkId);
    }
    const resources = [...input.resources].sort((left, right) => left.resourceKey.localeCompare(right.resourceKey));
    const resourceKeys = new Set<string>();
    const accountSnapshotId = `tas_${await sha256(`${manifestId}\0${input.accountId}\0${input.contentSha256}`)}`;
    for (const resource of resources) {
      if (
        !SHA256.test(resource.resourceKey) || resourceKeys.has(resource.resourceKey)
        || !checkIds.has(resource.checkId)
        || typeof resource.resourceId !== "string" || resource.resourceId.length < 1 || resource.resourceId.length > 2048
        || (resource.region !== null && (resource.region.length < 1 || resource.region.length > 128))
        || !new Set(["ok", "warning", "error"]).has(resource.status)
        || typeof resource.suppressed !== "boolean"
        || typeof resource.metadataJson !== "string" || resource.metadataJson.length < 2
        || resource.metadataJson.length > 1_048_576 || !SHA256.test(resource.metadataSha256)
        || await sha256(resource.metadataJson) !== resource.metadataSha256
        || await trustedAdvisorResourceKey(manifestId, input.accountId, resource) !== resource.resourceKey
      ) reject("CHECKSUM_MISMATCH");
      resourceKeys.add(resource.resourceKey);
    }
    const normalizedHashInput: TrustedAdvisorAccountSnapshotHashInput = {
      ...input,
      collectedAtIso: normalizedCollected,
      dataThroughAtIso: normalizedDataThrough,
      checks,
      resources,
    };
    if (await trustedAdvisorAccountSnapshotSha256(normalizedHashInput) !== input.contentSha256) {
      reject("CHECKSUM_MISMATCH");
    }
    const database = await this.assertLiveScope(scope);
    const prior = await database.prepare(
      `SELECT s.account_snapshot_id, s.content_sha256, a.status AS account_status
       FROM finops_ta_account_snapshots s
       JOIN finops_ta_manifest_accounts a
         ON a.manifest_id = s.manifest_id AND a.account_id = s.account_id
       WHERE s.manifest_id = ? AND s.org_id = ? AND s.customer_id = ?
         AND s.anchor_connection_id = ? AND s.account_id = ? LIMIT 1`,
    ).bind(manifestId, scope.organizationId, scope.customerId, scope.connectionId, input.accountId)
      .first<{ account_snapshot_id: string; content_sha256: string; account_status: string }>();
    if (prior !== null) {
      if (
        prior.content_sha256 === input.contentSha256
        && prior.account_snapshot_id === accountSnapshotId
        && prior.account_status === (input.status === "complete" ? "accepted" : "partial")
      ) return prior.account_snapshot_id;
      reject("IMMUTABLE_CONFLICT");
    }
    const member = await database.prepare(
      `SELECT status FROM finops_ta_manifest_accounts
       WHERE manifest_id = ? AND org_id = ? AND customer_id = ? AND anchor_connection_id = ?
         AND account_id = ? LIMIT 1`,
    ).bind(manifestId, scope.organizationId, scope.customerId, scope.connectionId, input.accountId)
      .first<{ status: string }>();
    if (member?.status !== "running") reject("INVALID_TRANSITION");

    const statements: D1PreparedStatement[] = [database.prepare(
      `INSERT INTO finops_ta_account_snapshots (
         account_snapshot_id, manifest_id, org_id, customer_id, anchor_connection_id,
         account_id, status, content_sha256, collected_at, data_through_at,
         check_count, resource_count, rejected_record_count,
         evidence_reference_ciphertext, evidence_reference_key_version, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      accountSnapshotId, manifestId, scope.organizationId, scope.customerId, scope.connectionId,
      input.accountId, input.status, input.contentSha256, normalizedCollected, normalizedDataThrough,
      checks.length, resources.length, input.rejectedRecordCount,
      input.evidenceReference.ciphertext, input.evidenceReference.keyVersion, nowMs,
    )];
    for (const check of checks) statements.push(database.prepare(
      `INSERT INTO finops_ta_check_snapshots (
         account_snapshot_id, check_id, name, category, status, data_through_at,
         processed_count, flagged_count, ignored_count, suppressed_count, content_sha256
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      accountSnapshotId, check.checkId, check.name, check.category, check.status,
      check.dataThroughAtIso === null ? null : normalizedIso(check.dataThroughAtIso),
      check.processedCount, check.flaggedCount, check.ignoredCount, check.suppressedCount, check.contentSha256,
    ));
    for (const resource of resources) statements.push(database.prepare(
      `INSERT INTO finops_ta_resource_snapshots (
         resource_key, account_snapshot_id, check_id, resource_id, region,
         status, suppressed, metadata_json, metadata_sha256
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      resource.resourceKey, accountSnapshotId, resource.checkId, resource.resourceId,
      resource.region, resource.status, resource.suppressed ? 1 : 0,
      resource.metadataJson, resource.metadataSha256,
    ));
    statements.push(database.prepare(
      `UPDATE finops_ta_manifest_accounts
       SET status = ?, account_snapshot_id = ?, error_code = ?, finished_at = ?
       WHERE manifest_id = ? AND org_id = ? AND customer_id = ? AND anchor_connection_id = ?
         AND account_id = ? AND status = 'running'`,
    ).bind(
      input.status === "complete" ? "accepted" : "partial",
      accountSnapshotId,
      input.status === "complete" ? null : "SOURCE_COVERAGE_INCOMPLETE",
      nowMs, manifestId, scope.organizationId, scope.customerId, scope.connectionId, input.accountId,
    ));
    try {
      await database.batch(statements);
    } catch {
      reject("IMMUTABLE_CONFLICT");
    }
    return accountSnapshotId;
  }

  public async finalizeManifest(
    scope: TrustedAdvisorOrganizationScope,
    manifestId: string,
    nowMs = Date.now(),
  ): Promise<StoredTrustedAdvisorOrganizationSnapshot> {
    if (!/^tam_[a-f0-9]{64}$/u.test(manifestId) || !Number.isSafeInteger(nowMs) || nowMs < 0) reject();
    const database = await this.assertLiveScope(scope);
    const existing = await database.prepare(
      `SELECT * FROM finops_ta_organization_snapshots WHERE manifest_id = ?
       AND org_id = ? AND customer_id = ? AND anchor_connection_id = ? LIMIT 1`,
    ).bind(manifestId, scope.organizationId, scope.customerId, scope.connectionId)
      .first<OrganizationSnapshotRow>();
    if (existing !== null) return storedOrganizationSnapshot(existing);
    let manifest = await this.readManifest(database, scope, manifestId);
    if (manifest === null || !new Set(["collecting", "finalizing"]).has(manifest.status)) {
      reject("INVALID_TRANSITION");
    }
    if (manifest.accounts.some((account) => new Set(["pending", "running"]).has(account.status))) {
      reject("NOT_TERMINAL");
    }
    if (manifest.status === "collecting") {
      await database.prepare(
        `UPDATE finops_ta_collection_manifests SET status = 'finalizing'
         WHERE manifest_id = ? AND org_id = ? AND customer_id = ? AND anchor_connection_id = ?
           AND status = 'collecting'`,
      ).bind(manifestId, scope.organizationId, scope.customerId, scope.connectionId).run();
      manifest = await this.readManifest(database, scope, manifestId) ?? reject("STORED_STATE_INVALID");
      if (manifest.status !== "finalizing") reject("INVALID_TRANSITION");
    }
    const acceptedAccountCount = manifest.accounts.filter((account) => account.status === "accepted").length;
    const terminalStatus = acceptedAccountCount === manifest.expectedAccountCount
      ? "complete" as const
      : acceptedAccountCount === 0 ? "failed" as const : "partial" as const;
    const aggregate = await database.prepare(
      `SELECT COALESCE(SUM(check_count), 0) AS check_count,
              COALESCE(SUM(resource_count), 0) AS resource_count,
              MIN(data_through_at) AS data_through_at,
              MAX(collected_at) AS collected_at
       FROM finops_ta_account_snapshots
       WHERE manifest_id = ? AND org_id = ? AND customer_id = ?
         AND anchor_connection_id = ? AND status = 'complete'`,
    ).bind(
      manifestId,
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
    ).first<{
      check_count: number | string;
      resource_count: number | string;
      data_through_at: string | null;
      collected_at: string | null;
    }>();
    if (aggregate === null) reject("STORED_STATE_INVALID");
    const collectedAtIso = aggregate.collected_at ?? new Date(nowMs).toISOString();
    const dataThroughAtIso = aggregate.data_through_at;
    const checkCount = safeInteger(aggregate.check_count, true);
    const resourceCount = safeInteger(aggregate.resource_count, true);
    const digest = await sha256(JSON.stringify({
      manifestId,
      accountSetSha256: manifest.accountSetSha256,
      status: terminalStatus,
      collectedAtIso,
      dataThroughAtIso,
      expectedAccountCount: manifest.expectedAccountCount,
      acceptedAccountCount,
      checkCount,
      resourceCount,
      accounts: manifest.accounts.map((account) => ({
        accountId: account.accountId,
        status: account.status,
        accountSnapshotId: account.accountSnapshotId,
        errorCode: account.errorCode,
      })),
    }));
    const generationId = `tao_${digest}`;
    const statements: D1PreparedStatement[] = [database.prepare(
      `INSERT INTO finops_ta_organization_snapshots (
         generation_id, manifest_id, org_id, customer_id, anchor_connection_id,
         status, content_sha256, collected_at, data_through_at,
         expected_account_count, accepted_account_count, rejected_account_count,
         check_count, resource_count, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      generationId, manifestId, scope.organizationId, scope.customerId, scope.connectionId,
      terminalStatus, digest, collectedAtIso, dataThroughAtIso,
      manifest.expectedAccountCount, acceptedAccountCount,
      manifest.expectedAccountCount - acceptedAccountCount, checkCount, resourceCount, nowMs,
    ), database.prepare(
      `UPDATE finops_ta_collection_manifests SET status = ?, finalized_at = ?
       WHERE manifest_id = ? AND org_id = ? AND customer_id = ? AND anchor_connection_id = ?
         AND status = 'finalizing'`,
    ).bind(terminalStatus, nowMs, manifestId, scope.organizationId, scope.customerId, scope.connectionId)];
    if (terminalStatus === "complete") statements.push(database.prepare(
      `INSERT INTO finops_ta_organization_snapshot_heads (
         org_id, customer_id, anchor_connection_id, active_generation_id, advanced_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (org_id, customer_id, anchor_connection_id) DO UPDATE SET
         active_generation_id = excluded.active_generation_id,
         advanced_at = excluded.advanced_at
       WHERE EXISTS (
         SELECT 1 FROM finops_ta_organization_snapshots candidate
         JOIN finops_ta_organization_snapshots active
           ON active.generation_id = finops_ta_organization_snapshot_heads.active_generation_id
         WHERE candidate.generation_id = excluded.active_generation_id
           AND (candidate.data_through_at > active.data_through_at
             OR (candidate.data_through_at = active.data_through_at
               AND candidate.collected_at > active.collected_at))
       )`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId, generationId, nowMs));
    try {
      await database.batch(statements);
    } catch {
      reject("IMMUTABLE_CONFLICT");
    }
    return storedOrganizationSnapshot(await database.prepare(
      `SELECT * FROM finops_ta_organization_snapshots WHERE generation_id = ? LIMIT 1`,
    ).bind(generationId).first<OrganizationSnapshotRow>() ?? reject("STORED_STATE_INVALID"));
  }

  public async getActiveSnapshot(
    scope: TrustedAdvisorOrganizationScope,
  ): Promise<StoredTrustedAdvisorOrganizationSnapshot | null> {
    const database = await this.assertLiveScope(scope);
    const row = await database.prepare(
      `SELECT s.* FROM finops_ta_organization_snapshot_heads h
       JOIN finops_ta_organization_snapshots s ON s.generation_id = h.active_generation_id
       WHERE h.org_id = ? AND h.customer_id = ? AND h.anchor_connection_id = ?
         AND s.status = 'complete' LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId)
      .first<OrganizationSnapshotRow>();
    return row === null ? null : storedOrganizationSnapshot(row);
  }

  /**
   * Read a bounded projection from the immutable active standard-check
   * generation. Priority recommendation tables are intentionally not queried.
   */
  public async getActiveDashboard(
    scope: TrustedAdvisorOrganizationScope,
    filters: TrustedAdvisorOrganizationDashboardFilters,
  ): Promise<TrustedAdvisorOrganizationDashboardProjection | null> {
    if (
      typeof filters !== "object" || filters === null
      || (filters.accountId !== null && !ACCOUNT_ID.test(filters.accountId))
      || (filters.checkId !== null && !IDENTIFIER.test(filters.checkId))
      || (filters.status !== null && !new Set(["ok", "warning", "error"]).has(filters.status))
      || (filters.region !== null && !/^[a-z0-9-]{1,128}$/u.test(filters.region))
      || (filters.category !== null && !/^[a-z][a-z0-9_]{0,63}$/u.test(filters.category))
      || (filters.suppressed !== null && typeof filters.suppressed !== "boolean")
    ) reject();
    const database = await this.assertLiveScope(scope);
    const snapshotRow = await database.prepare(
      `SELECT s.* FROM finops_ta_organization_snapshot_heads h
       JOIN finops_ta_organization_snapshots s ON s.generation_id = h.active_generation_id
       WHERE h.org_id = ? AND h.customer_id = ? AND h.anchor_connection_id = ?
         AND s.status = 'complete' LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId)
      .first<OrganizationSnapshotRow>();
    if (snapshotRow === null) return null;
    const snapshot = storedOrganizationSnapshot(snapshotRow);

    const accountBindings: unknown[] = [
      snapshot.manifestId,
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
    ];
    accountBindings.push(MAX_DASHBOARD_ACCOUNTS + 1);
    const accountRows = await database.prepare(
      `SELECT a.account_id, a.collected_at, a.data_through_at, a.check_count,
              a.resource_count, a.rejected_record_count
       FROM finops_ta_account_snapshots a
       WHERE a.manifest_id = ? AND a.org_id = ? AND a.customer_id = ?
         AND a.anchor_connection_id = ? AND a.status = 'complete'
       ORDER BY a.account_id ASC LIMIT ?`,
    ).bind(...accountBindings).all<DashboardAccountRow>();

    const checkBindings: unknown[] = [
      snapshot.manifestId,
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
    ];
    const checkClauses: string[] = [];
    if (filters.accountId !== null) {
      checkClauses.push("a.account_id = ?");
      checkBindings.push(filters.accountId);
    }
    if (filters.checkId !== null) {
      checkClauses.push("c.check_id = ?");
      checkBindings.push(filters.checkId);
    }
    if (filters.status !== null) {
      checkClauses.push("c.status = ?");
      checkBindings.push(filters.status);
    }
    if (filters.category !== null) {
      checkClauses.push("c.category = ?");
      checkBindings.push(filters.category);
    }
    if (filters.suppressed !== null) {
      checkClauses.push(`EXISTS (
        SELECT 1 FROM finops_ta_resource_snapshots rf
        WHERE rf.account_snapshot_id = c.account_snapshot_id
          AND rf.check_id = c.check_id AND rf.suppressed = ?
      )`);
      checkBindings.push(filters.suppressed ? 1 : 0);
    }
    checkBindings.push(MAX_DASHBOARD_CHECKS + 1);
    const checkWhere = checkClauses.length === 0 ? "" : ` AND ${checkClauses.join(" AND ")}`;
    const checkRows = await database.prepare(
      `SELECT c.check_id, c.name, c.category, c.status,
              COUNT(DISTINCT a.account_id) AS account_count,
              SUM(c.processed_count) AS processed_count,
              SUM(c.flagged_count) AS flagged_count,
              SUM(c.ignored_count) AS ignored_count,
              SUM(c.suppressed_count) AS suppressed_count
       FROM finops_ta_account_snapshots a
       JOIN finops_ta_check_snapshots c ON c.account_snapshot_id = a.account_snapshot_id
       WHERE a.manifest_id = ? AND a.org_id = ? AND a.customer_id = ?
         AND a.anchor_connection_id = ? AND a.status = 'complete'${checkWhere}
       GROUP BY c.check_id, c.name, c.category, c.status
       ORDER BY flagged_count DESC, c.name ASC, c.check_id ASC LIMIT ?`,
    ).bind(...checkBindings).all<DashboardCheckRow>();

    const resourceBindings: unknown[] = [
      snapshot.manifestId,
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
    ];
    const resourceClauses: string[] = [];
    if (filters.accountId !== null) {
      resourceClauses.push("a.account_id = ?");
      resourceBindings.push(filters.accountId);
    }
    if (filters.checkId !== null) {
      resourceClauses.push("r.check_id = ?");
      resourceBindings.push(filters.checkId);
    }
    if (filters.status !== null) {
      resourceClauses.push("r.status = ?");
      resourceBindings.push(filters.status);
    }
    if (filters.region !== null) {
      resourceClauses.push("r.region = ?");
      resourceBindings.push(filters.region);
    }
    if (filters.category !== null) {
      resourceClauses.push("c.category = ?");
      resourceBindings.push(filters.category);
    }
    if (filters.suppressed !== null) {
      resourceClauses.push("r.suppressed = ?");
      resourceBindings.push(filters.suppressed ? 1 : 0);
    }
    resourceBindings.push(MAX_DASHBOARD_RESOURCES + 1);
    const resourceWhere = resourceClauses.length === 0 ? "" : ` AND ${resourceClauses.join(" AND ")}`;
    const resourceRows = await database.prepare(
      `SELECT r.resource_key, a.account_id, r.check_id, c.name AS check_name,
              c.category AS check_category,
              r.resource_id, r.region, r.status, r.suppressed,
              r.metadata_json, r.metadata_sha256
       FROM finops_ta_account_snapshots a
       JOIN finops_ta_check_snapshots c ON c.account_snapshot_id = a.account_snapshot_id
       JOIN finops_ta_resource_snapshots r
         ON r.account_snapshot_id = c.account_snapshot_id AND r.check_id = c.check_id
       WHERE a.manifest_id = ? AND a.org_id = ? AND a.customer_id = ?
         AND a.anchor_connection_id = ? AND a.status = 'complete'${resourceWhere}
       ORDER BY CASE r.status WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                a.account_id ASC, c.name ASC, r.resource_key ASC LIMIT ?`,
    ).bind(...resourceBindings).all<DashboardResourceRow>();

    const historyRows = await database.prepare(
      `SELECT * FROM finops_ta_organization_snapshots
       WHERE org_id = ? AND customer_id = ? AND anchor_connection_id = ?
       ORDER BY collected_at DESC, generation_id DESC LIMIT 12`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId)
      .all<OrganizationSnapshotRow>();
    const accounts = accountRows.results ?? [];
    const checks = checkRows.results ?? [];
    const resources = resourceRows.results ?? [];
    return {
      snapshot,
      filters: { ...filters },
      accounts: accounts.slice(0, MAX_DASHBOARD_ACCOUNTS).map((row) => ({
        accountId: row.account_id,
        collectedAtIso: row.collected_at,
        dataThroughAtIso: row.data_through_at,
        checkCount: safeInteger(row.check_count, true),
        resourceCount: safeInteger(row.resource_count, true),
        rejectedRecordCount: safeInteger(row.rejected_record_count, true),
      })),
      accountsTruncated: accounts.length > MAX_DASHBOARD_ACCOUNTS,
      checks: checks.slice(0, MAX_DASHBOARD_CHECKS).map((row) => ({
        checkId: row.check_id,
        name: row.name,
        category: row.category,
        status: row.status,
        accountCount: safeInteger(row.account_count, true),
        processedCount: safeInteger(row.processed_count, true),
        flaggedCount: safeInteger(row.flagged_count, true),
        ignoredCount: safeInteger(row.ignored_count, true),
        suppressedCount: safeInteger(row.suppressed_count, true),
      })),
      checksTruncated: checks.length > MAX_DASHBOARD_CHECKS,
      resources: resources.slice(0, MAX_DASHBOARD_RESOURCES).map((row) => ({
        resourceKey: row.resource_key,
        accountId: row.account_id,
        checkId: row.check_id,
        checkName: row.check_name,
        checkCategory: row.check_category,
        resourceId: row.resource_id,
        region: row.region,
        status: row.status,
        suppressed: safeInteger(row.suppressed, true) === 1,
        metadataJson: row.metadata_json,
        metadataSha256: row.metadata_sha256,
      })),
      resourcesTruncated: resources.length > MAX_DASHBOARD_RESOURCES,
      history: (historyRows.results ?? []).map(storedOrganizationSnapshot),
    };
  }

  public async listHistory(
    scope: TrustedAdvisorOrganizationScope,
    limit = 12,
  ): Promise<readonly StoredTrustedAdvisorOrganizationSnapshot[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY) reject();
    const database = await this.assertLiveScope(scope);
    const rows = await database.prepare(
      `SELECT * FROM finops_ta_organization_snapshots
       WHERE org_id = ? AND customer_id = ? AND anchor_connection_id = ?
       ORDER BY collected_at DESC, generation_id DESC LIMIT ?`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId, limit)
      .all<OrganizationSnapshotRow>();
    return (rows.results ?? []).map(storedOrganizationSnapshot);
  }
}
