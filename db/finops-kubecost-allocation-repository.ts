/** Immutable persistence for reconciled Kubecost/OpenCost attribution views. */
import {
  buildKubecostAllocationSnapshot,
  type KubecostAllocationCapture,
  type KubecostAllocationScope,
  type KubecostAllocationSnapshot,
} from "../lib/finops-kubecost-allocation.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const GENERATION_ID = /^kcg_[a-f0-9]{64}$/u;
const CAPTURE_ID = /^kubecost_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_BYTES = 24 * 1_024 * 1_024;
const MAX_HISTORY = 93;

export interface KubecostPersistenceScope { readonly organizationId: string; readonly customerId: string; readonly connectionId: string }
export interface StoredKubecostSnapshot { readonly scope: KubecostPersistenceScope; readonly generationId: string; readonly contentSha256: string; readonly snapshot: KubecostAllocationSnapshot; readonly createdAtIso: string; readonly committedAtIso: string | null }
export interface KubecostHistoryItem {
  readonly generationId: string; readonly sourceCaptureId: string; readonly sourceState: KubecostAllocationSnapshot["state"];
  readonly dataThroughAtIso: string; readonly billingPeriod: string; readonly rowCount: number; readonly groupCount: number;
  readonly reconciliationState: KubecostAllocationSnapshot["reconciliation"]["state"];
  readonly categoryTotals: KubecostAllocationSnapshot["categoryTotals"]; readonly contentSha256: string;
}

export class KubecostRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "IMMUTABLE_CONFLICT" | "STORED_STATE_INVALID";
  public constructor(code: KubecostRepositoryError["code"]) { super("Kubecost allocation persistence operation rejected"); this.name = "KubecostRepositoryError"; this.code = code; }
}

interface Row {
  generation_id: string; org_id: string; customer_id: string; connection_id: string;
  partition: KubecostAllocationScope["partition"]; billing_period: string; active_cur2_generation_id: string;
  source_capture_id: string; source_state: KubecostAllocationSnapshot["state"]; complete: number | boolean;
  data_through_at: string; content_sha256: string; snapshot_json: string;
  row_count: number | string; group_count: number | string; created_at: number | string; advanced_at?: number | string | null;
}

function reject(code: KubecostRepositoryError["code"] = "INVALID_INPUT"): never { throw new KubecostRepositoryError(code); }
function assertScope(scope: KubecostPersistenceScope): void { if (!IDENTIFIER.test(scope.organizationId) || !IDENTIFIER.test(scope.customerId) || !CONNECTION_ID.test(scope.connectionId)) reject(); }
function integer(value: unknown): number { const result = typeof value === "string" ? Number(value) : value; if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) reject("STORED_STATE_INVALID"); return result; }
async function sha256(value: string): Promise<string> { const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(result)].map((part) => part.toString(16).padStart(2, "0")).join(""); }

async function materialize(row: Row): Promise<StoredKubecostSnapshot> {
  if (!GENERATION_ID.test(row.generation_id) || !CAPTURE_ID.test(row.source_capture_id) || !SHA256.test(row.content_sha256) || new TextEncoder().encode(row.snapshot_json).byteLength > MAX_BYTES) reject("STORED_STATE_INVALID");
  let snapshot: KubecostAllocationSnapshot;
  try { snapshot = JSON.parse(row.snapshot_json) as KubecostAllocationSnapshot; } catch { reject("STORED_STATE_INVALID"); }
  const complete = row.complete === true || row.complete === 1;
  if (snapshot.scope.orgId !== row.org_id || snapshot.scope.customerId !== row.customer_id || snapshot.scope.connectionId !== row.connection_id
    || snapshot.scope.partition !== row.partition || snapshot.scope.billingPeriod !== row.billing_period
    || snapshot.scope.activeCur2GenerationId !== row.active_cur2_generation_id || snapshot.captureId !== row.source_capture_id
    || snapshot.state !== row.source_state || snapshot.complete !== complete || snapshot.dataThroughAtIso !== row.data_through_at
    || snapshot.rowCount !== integer(row.row_count) || snapshot.groupCount !== integer(row.group_count)
    || snapshot.groups.length !== snapshot.groupCount || await sha256(row.snapshot_json) !== row.content_sha256
    || row.generation_id !== `kcg_${row.content_sha256}`) reject("STORED_STATE_INVALID");
  const scope = { organizationId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id }; assertScope(scope);
  const createdAt = integer(row.created_at); const advancedAt = row.advanced_at === undefined || row.advanced_at === null ? null : integer(row.advanced_at);
  return { scope, generationId: row.generation_id, contentSha256: row.content_sha256, snapshot, createdAtIso: new Date(createdAt).toISOString(), committedAtIso: advancedAt === null ? null : new Date(advancedAt).toISOString() };
}

const LIVE_SCOPE = `JOIN aws_connections c ON c.id=s.connection_id AND c.org_id=s.org_id AND c.customer_id=s.customer_id AND c.partition=s.partition JOIN organizations o ON o.id=c.org_id AND o.status='active' JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id AND cu.status='active'`;

export class KubecostAllocationRepository {
  private readonly database: D1Database;
  public constructor(database: D1Database = getRawDb()) { this.database = database; }
  private async live(scope: KubecostPersistenceScope): Promise<D1Database> {
    assertScope(scope); await ensureRuntimeSchema(this.database);
    const row = await this.database.prepare(`SELECT c.id FROM aws_connections c JOIN organizations o ON o.id=c.org_id AND o.status='active' JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id AND cu.status='active' WHERE c.org_id=? AND c.customer_id=? AND c.id=? AND c.source_kind='aws_trust_role' AND c.status='active' LIMIT 1`).bind(scope.organizationId, scope.customerId, scope.connectionId).first<{ id: string }>();
    if (row === null) reject("SCOPE_NOT_FOUND"); return this.database;
  }
  private async byGeneration(database: D1Database, scope: KubecostPersistenceScope, generationId: string) {
    const row = await database.prepare(`SELECT s.* FROM finops_kubecost_snapshots s ${LIVE_SCOPE} WHERE s.org_id=? AND s.customer_id=? AND s.connection_id=? AND s.generation_id=? AND c.source_kind='aws_trust_role' AND c.status='active' LIMIT 1`).bind(scope.organizationId, scope.customerId, scope.connectionId, generationId).first<Row>();
    return row === null ? null : materialize(row);
  }
  public async recordCapture(expectedScope: KubecostAllocationScope, capture: KubecostAllocationCapture, nowMs = Date.now()): Promise<{ readonly generation: StoredKubecostSnapshot; readonly becameActive: boolean }> {
    const scope = { organizationId: expectedScope.orgId, customerId: expectedScope.customerId, connectionId: expectedScope.connectionId }; assertScope(scope);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) reject();
    const completedAt = Date.parse(capture.completedAtIso); if (!Number.isFinite(completedAt) || completedAt > nowMs + 300_000) reject();
    const snapshot = buildKubecostAllocationSnapshot(capture, expectedScope, completedAt);
    const snapshotJson = JSON.stringify(snapshot); if (new TextEncoder().encode(snapshotJson).byteLength > MAX_BYTES) reject();
    const contentSha256 = await sha256(snapshotJson); const generationId = `kcg_${contentSha256}`;
    const database = await this.live(scope); const previous = await this.getActiveSnapshot(scope);
    const statements = [database.prepare(`INSERT INTO finops_kubecost_snapshots (generation_id,org_id,customer_id,connection_id,partition,billing_period,active_cur2_generation_id,source_capture_id,source_state,complete,data_through_at,content_sha256,snapshot_json,row_count,group_count,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(generationId, scope.organizationId, scope.customerId, scope.connectionId, snapshot.scope.partition, snapshot.scope.billingPeriod, snapshot.scope.activeCur2GenerationId, snapshot.captureId, snapshot.state, snapshot.complete ? 1 : 0, snapshot.dataThroughAtIso, contentSha256, snapshotJson, snapshot.rowCount, snapshot.groupCount, nowMs)];
    if (snapshot.complete && (snapshot.state === "READY" || snapshot.state === "EMPTY")) statements.push(database.prepare(`INSERT INTO finops_kubecost_snapshot_heads (org_id,customer_id,connection_id,active_generation_id,advanced_at) VALUES (?,?,?,?,?) ON CONFLICT (org_id,customer_id,connection_id) DO UPDATE SET active_generation_id=excluded.active_generation_id,advanced_at=excluded.advanced_at WHERE excluded.active_generation_id<>finops_kubecost_snapshot_heads.active_generation_id AND EXISTS (SELECT 1 FROM finops_kubecost_snapshots candidate JOIN finops_kubecost_snapshots active ON active.generation_id=finops_kubecost_snapshot_heads.active_generation_id WHERE candidate.generation_id=excluded.active_generation_id AND candidate.org_id=finops_kubecost_snapshot_heads.org_id AND candidate.customer_id=finops_kubecost_snapshot_heads.customer_id AND candidate.connection_id=finops_kubecost_snapshot_heads.connection_id AND candidate.data_through_at>active.data_through_at)`).bind(scope.organizationId, scope.customerId, scope.connectionId, generationId, nowMs));
    await database.batch(statements);
    const stored = await this.byGeneration(database, scope, generationId); if (stored === null || stored.contentSha256 !== contentSha256) reject("IMMUTABLE_CONFLICT");
    const active = await this.getActiveSnapshot(scope); return { generation: stored, becameActive: active?.generationId === generationId && previous?.generationId !== generationId };
  }
  public async getActiveSnapshot(scope: KubecostPersistenceScope): Promise<StoredKubecostSnapshot | null> {
    const database = await this.live(scope); const row = await database.prepare(`SELECT s.*,h.advanced_at FROM finops_kubecost_snapshot_heads h JOIN finops_kubecost_snapshots s ON s.generation_id=h.active_generation_id AND s.org_id=h.org_id AND s.customer_id=h.customer_id AND s.connection_id=h.connection_id ${LIVE_SCOPE} WHERE h.org_id=? AND h.customer_id=? AND h.connection_id=? AND c.source_kind='aws_trust_role' AND c.status='active' LIMIT 1`).bind(scope.organizationId, scope.customerId, scope.connectionId).first<Row>();
    return row === null ? null : materialize(row);
  }
  public async getLatestSnapshot(scope: KubecostPersistenceScope): Promise<StoredKubecostSnapshot | null> {
    const database = await this.live(scope); const row = await database.prepare(`SELECT s.* FROM finops_kubecost_snapshots s ${LIVE_SCOPE} WHERE s.org_id=? AND s.customer_id=? AND s.connection_id=? AND c.source_kind='aws_trust_role' AND c.status='active' ORDER BY s.data_through_at DESC,s.generation_id DESC LIMIT 1`).bind(scope.organizationId, scope.customerId, scope.connectionId).first<Row>();
    return row === null ? null : materialize(row);
  }
  public async listHistory(scope: KubecostPersistenceScope, limit = 30): Promise<readonly KubecostHistoryItem[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY) reject();
    const database = await this.live(scope); const rows = await database.prepare(`SELECT s.* FROM finops_kubecost_snapshots s ${LIVE_SCOPE} WHERE s.org_id=? AND s.customer_id=? AND s.connection_id=? AND c.source_kind='aws_trust_role' AND c.status='active' ORDER BY s.data_through_at DESC,s.generation_id DESC LIMIT ?`).bind(scope.organizationId, scope.customerId, scope.connectionId, limit).all<Row>();
    return Promise.all((rows.results ?? []).map(async (row) => { const stored = await materialize(row); return { generationId: stored.generationId, sourceCaptureId: stored.snapshot.captureId, sourceState: stored.snapshot.state, dataThroughAtIso: stored.snapshot.dataThroughAtIso, billingPeriod: stored.snapshot.scope.billingPeriod, rowCount: stored.snapshot.rowCount, groupCount: stored.snapshot.groupCount, reconciliationState: stored.snapshot.reconciliation.state, categoryTotals: stored.snapshot.categoryTotals, contentSha256: stored.contentSha256 }; }));
  }
}
