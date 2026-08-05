/** Immutable, tenant-scoped persistence for normalized Marketplace buyer evidence. */
import {
  normalizeAwsMarketplaceSpgCapture,
  type AwsMarketplaceSpgCapture,
  type AwsMarketplaceSpgScope,
  type AwsMarketplaceSpgSnapshot,
} from "../lib/finops-marketplace-spg.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const GENERATION_ID = /^mspg_[a-f0-9]{64}$/u;
const CAPTURE_ID = /^marketplace_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_BYTES = 24 * 1_024 * 1_024;
const MAX_HISTORY = 93;

export interface AwsMarketplaceSpgPersistenceScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface StoredAwsMarketplaceSpgSnapshot {
  readonly scope: AwsMarketplaceSpgPersistenceScope;
  readonly generationId: string;
  readonly contentSha256: string;
  readonly snapshot: AwsMarketplaceSpgSnapshot;
  readonly createdAtIso: string;
  readonly committedAtIso: string | null;
}

export interface AwsMarketplaceSpgHistoryItem {
  readonly generationId: string;
  readonly captureId: string;
  readonly state: AwsMarketplaceSpgSnapshot["state"];
  readonly capturedAt: string;
  readonly dataThroughAt: string;
  readonly agreementCount: number;
  readonly licenseCount: number;
  readonly grantCount: number;
  readonly spendRowCount: number;
  readonly spendSummaries: AwsMarketplaceSpgSnapshot["spend"]["summaries"];
}

export class AwsMarketplaceSpgRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "IMMUTABLE_CONFLICT" | "STORED_STATE_INVALID";
  public constructor(code: AwsMarketplaceSpgRepositoryError["code"]) {
    super("AWS Marketplace SPG persistence operation rejected");
    this.name = "AwsMarketplaceSpgRepositoryError";
    this.code = code;
  }
}

interface SnapshotRow {
  generation_id: string; org_id: string; customer_id: string; connection_id: string;
  account_id: string; partition: AwsMarketplaceSpgScope["partition"];
  source_capture_id: string; source_state: AwsMarketplaceSpgSnapshot["state"];
  content_sha256: string; snapshot_json: string; summary_json: string;
  captured_at: string; data_through_at: string; organization_coverage: AwsMarketplaceSpgSnapshot["organizationCoverage"];
  agreement_state: AwsMarketplaceSpgSnapshot["channelStates"]["agreements"];
  license_state: AwsMarketplaceSpgSnapshot["channelStates"]["licenses"];
  spend_state: AwsMarketplaceSpgSnapshot["channelStates"]["spend"];
  agreement_count: number | string; license_count: number | string; grant_count: number | string;
  spend_row_count: number | string; created_at: number | string; advanced_at?: number | string | null;
}

function reject(code: AwsMarketplaceSpgRepositoryError["code"] = "INVALID_INPUT"): never {
  throw new AwsMarketplaceSpgRepositoryError(code);
}
function assertScope(scope: AwsMarketplaceSpgPersistenceScope): void {
  if (!IDENTIFIER.test(scope.organizationId) || !IDENTIFIER.test(scope.customerId)
    || !CONNECTION_ID.test(scope.connectionId)) reject();
}
function integer(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) reject("STORED_STATE_INVALID");
  return parsed;
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}
function complete(snapshot: AwsMarketplaceSpgSnapshot): boolean {
  return snapshot.organizationCoverage === "COMPLETE"
    && (snapshot.state === "READY" || snapshot.state === "EMPTY")
    && [snapshot.channelStates.agreements, snapshot.channelStates.licenses, snapshot.channelStates.spend]
      .every((state) => state === "READY" || state === "EMPTY");
}
async function materialize(row: SnapshotRow): Promise<StoredAwsMarketplaceSpgSnapshot> {
  if (!GENERATION_ID.test(row.generation_id) || !CAPTURE_ID.test(row.source_capture_id)
    || !SHA256.test(row.content_sha256) || new TextEncoder().encode(row.snapshot_json).byteLength > MAX_BYTES) reject("STORED_STATE_INVALID");
  let snapshot: AwsMarketplaceSpgSnapshot;
  try { snapshot = JSON.parse(row.snapshot_json) as AwsMarketplaceSpgSnapshot; } catch { reject("STORED_STATE_INVALID"); }
  if (snapshot.scope.orgId !== row.org_id || snapshot.scope.customerId !== row.customer_id
    || snapshot.scope.connectionId !== row.connection_id || snapshot.scope.accountId !== row.account_id
    || snapshot.scope.partition !== row.partition || snapshot.captureId !== row.source_capture_id
    || snapshot.state !== row.source_state || snapshot.capturedAt !== row.captured_at
    || snapshot.freshness.dataThroughAt !== row.data_through_at
    || snapshot.organizationCoverage !== row.organization_coverage
    || snapshot.channelStates.agreements !== row.agreement_state || snapshot.channelStates.licenses !== row.license_state
    || snapshot.channelStates.spend !== row.spend_state || snapshot.counts.agreements !== integer(row.agreement_count)
    || snapshot.counts.licenses !== integer(row.license_count) || snapshot.counts.grants !== integer(row.grant_count)
    || snapshot.counts.cur2Rows !== integer(row.spend_row_count)
    || await sha256(row.snapshot_json) !== row.content_sha256 || row.generation_id !== `mspg_${row.content_sha256}`) reject("STORED_STATE_INVALID");
  const createdAt = integer(row.created_at);
  const advancedAt = row.advanced_at === null || row.advanced_at === undefined ? null : integer(row.advanced_at);
  return { scope: { organizationId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id },
    generationId: row.generation_id, contentSha256: row.content_sha256, snapshot,
    createdAtIso: new Date(createdAt).toISOString(), committedAtIso: advancedAt === null ? null : new Date(advancedAt).toISOString() };
}
function history(stored: StoredAwsMarketplaceSpgSnapshot): AwsMarketplaceSpgHistoryItem {
  const snapshot = stored.snapshot;
  return { generationId: stored.generationId, captureId: snapshot.captureId, state: snapshot.state,
    capturedAt: snapshot.capturedAt, dataThroughAt: snapshot.freshness.dataThroughAt,
    agreementCount: snapshot.counts.agreements, licenseCount: snapshot.counts.licenses,
    grantCount: snapshot.counts.grants, spendRowCount: snapshot.counts.cur2Rows,
    spendSummaries: snapshot.spend.summaries };
}
const LIVE_SCOPE = `JOIN aws_connections c ON c.id=s.connection_id AND c.org_id=s.org_id AND c.customer_id=s.customer_id
  AND c.aws_account_id=s.account_id AND c.partition=s.partition
  JOIN organizations o ON o.id=c.org_id AND o.status='active'
  JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id AND cu.status='active'`;

export class AwsMarketplaceSpgRepository {
  public constructor(private readonly database: D1Database = getRawDb()) {}
  private async live(scope: AwsMarketplaceSpgPersistenceScope): Promise<D1Database> {
    assertScope(scope); await ensureRuntimeSchema(this.database);
    const row = await this.database.prepare(`SELECT c.id FROM aws_connections c
      JOIN organizations o ON o.id=c.org_id AND o.status='active'
      JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id AND cu.status='active'
      WHERE c.org_id=? AND c.customer_id=? AND c.id=? AND c.source_kind='aws_trust_role' AND c.status='active' LIMIT 1`)
      .bind(scope.organizationId, scope.customerId, scope.connectionId).first<{ id: string }>();
    if (row === null) reject("SCOPE_NOT_FOUND"); return this.database;
  }
  private async byGeneration(database: D1Database, scope: AwsMarketplaceSpgPersistenceScope, generationId: string) {
    const row = await database.prepare(`SELECT s.* FROM finops_marketplace_spg_snapshots s ${LIVE_SCOPE}
      WHERE s.org_id=? AND s.customer_id=? AND s.connection_id=? AND s.generation_id=?
      AND c.source_kind='aws_trust_role' AND c.status='active' LIMIT 1`)
      .bind(scope.organizationId, scope.customerId, scope.connectionId, generationId).first<SnapshotRow>();
    return row === null ? null : materialize(row);
  }
  public async getSnapshotByGeneration(scope: AwsMarketplaceSpgPersistenceScope, generationId: string) {
    if (!GENERATION_ID.test(generationId)) reject();
    return this.byGeneration(await this.live(scope), scope, generationId);
  }
  public async recordCapture(expectedScope: AwsMarketplaceSpgScope, capture: AwsMarketplaceSpgCapture, nowMs = Date.now()) {
    const scope = { organizationId: expectedScope.orgId, customerId: expectedScope.customerId, connectionId: expectedScope.connectionId };
    assertScope(scope);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || Date.parse(capture.completedAt) > nowMs + 300_000) reject();
    const snapshot = normalizeAwsMarketplaceSpgCapture(capture, expectedScope, Date.parse(capture.completedAt));
    const snapshotJson = JSON.stringify(snapshot); if (new TextEncoder().encode(snapshotJson).byteLength > MAX_BYTES) reject();
    const contentSha256 = await sha256(snapshotJson); const generationId = `mspg_${contentSha256}`;
    const database = await this.live(scope); const previous = await this.getActiveSnapshot(scope);
    const statements = [database.prepare(`INSERT INTO finops_marketplace_spg_snapshots (
      generation_id,org_id,customer_id,connection_id,account_id,partition,source_capture_id,source_state,
      content_sha256,snapshot_json,summary_json,captured_at,data_through_at,organization_coverage,
      agreement_state,license_state,spend_state,agreement_count,license_count,grant_count,spend_row_count,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(
      generationId, scope.organizationId, scope.customerId, scope.connectionId, snapshot.scope.accountId,
      snapshot.scope.partition, snapshot.captureId, snapshot.state, contentSha256, snapshotJson,
      JSON.stringify(snapshot.spend.summaries), snapshot.capturedAt, snapshot.freshness.dataThroughAt,
      snapshot.organizationCoverage, snapshot.channelStates.agreements, snapshot.channelStates.licenses,
      snapshot.channelStates.spend, snapshot.counts.agreements, snapshot.counts.licenses,
      snapshot.counts.grants, snapshot.counts.cur2Rows, nowMs)];
    if (complete(snapshot)) statements.push(database.prepare(`INSERT INTO finops_marketplace_spg_heads
      (org_id,customer_id,connection_id,active_generation_id,advanced_at) VALUES (?,?,?,?,?)
      ON CONFLICT (org_id,customer_id,connection_id) DO UPDATE SET active_generation_id=excluded.active_generation_id,advanced_at=excluded.advanced_at
      WHERE excluded.active_generation_id<>finops_marketplace_spg_heads.active_generation_id AND EXISTS (
        SELECT 1 FROM finops_marketplace_spg_snapshots candidate JOIN finops_marketplace_spg_snapshots active
          ON active.generation_id=finops_marketplace_spg_heads.active_generation_id
        WHERE candidate.generation_id=excluded.active_generation_id AND candidate.org_id=finops_marketplace_spg_heads.org_id
          AND candidate.customer_id=finops_marketplace_spg_heads.customer_id AND candidate.connection_id=finops_marketplace_spg_heads.connection_id
          AND candidate.captured_at>active.captured_at)`)
      .bind(scope.organizationId, scope.customerId, scope.connectionId, generationId, nowMs));
    await database.batch(statements);
    const stored = await this.byGeneration(database, scope, generationId); if (stored === null) reject("IMMUTABLE_CONFLICT");
    const active = await this.getActiveSnapshot(scope);
    return { snapshot: stored, becameActive: active?.generationId === generationId && previous?.generationId !== generationId };
  }
  public async getActiveSnapshot(scope: AwsMarketplaceSpgPersistenceScope) {
    const database = await this.live(scope); const row = await database.prepare(`SELECT s.*,h.advanced_at FROM finops_marketplace_spg_heads h
      JOIN finops_marketplace_spg_snapshots s ON s.generation_id=h.active_generation_id AND s.org_id=h.org_id AND s.customer_id=h.customer_id AND s.connection_id=h.connection_id
      ${LIVE_SCOPE} WHERE h.org_id=? AND h.customer_id=? AND h.connection_id=? AND c.source_kind='aws_trust_role' AND c.status='active' LIMIT 1`)
      .bind(scope.organizationId, scope.customerId, scope.connectionId).first<SnapshotRow>();
    return row === null ? null : materialize(row);
  }
  public async getLatestSnapshot(scope: AwsMarketplaceSpgPersistenceScope) {
    const database = await this.live(scope); const row = await database.prepare(`SELECT s.* FROM finops_marketplace_spg_snapshots s ${LIVE_SCOPE}
      WHERE s.org_id=? AND s.customer_id=? AND s.connection_id=? AND c.source_kind='aws_trust_role' AND c.status='active'
      ORDER BY s.captured_at DESC,s.generation_id DESC LIMIT 1`).bind(scope.organizationId, scope.customerId, scope.connectionId).first<SnapshotRow>();
    return row === null ? null : materialize(row);
  }
  public async listHistory(scope: AwsMarketplaceSpgPersistenceScope, limit = 30): Promise<readonly AwsMarketplaceSpgHistoryItem[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY) reject();
    const database = await this.live(scope); const rows = await database.prepare(`SELECT s.* FROM finops_marketplace_spg_snapshots s ${LIVE_SCOPE}
      WHERE s.org_id=? AND s.customer_id=? AND s.connection_id=? AND c.source_kind='aws_trust_role' AND c.status='active'
      ORDER BY s.captured_at DESC,s.generation_id DESC LIMIT ?`).bind(scope.organizationId, scope.customerId, scope.connectionId, limit).all<SnapshotRow>();
    return Promise.all((rows.results ?? []).map(async (row) => history(await materialize(row))));
  }
}
