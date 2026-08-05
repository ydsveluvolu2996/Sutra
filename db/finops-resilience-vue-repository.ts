/** Immutable, tenant-scoped persistence for normalized AWS Resilience Hub evidence. */
import {
  normalizeResilienceVueCapture,
  type ResilienceVueCapture,
  type ResilienceVueScope,
  type ResilienceVueSnapshot,
} from "../lib/finops-resilience-vue.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import { RESILIENCE_VUE_RUNTIME_PERMISSION_PACK_SQL } from
  "../lib/finops-permission-pack-successors.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const GENERATION_ID = /^rvg_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_BYTES = 64 * 1_024 * 1_024;

export interface ResilienceVuePersistenceScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface StoredResilienceVueSnapshot {
  readonly scope: ResilienceVuePersistenceScope;
  readonly generationId: string;
  readonly contentSha256: string;
  readonly snapshot: ResilienceVueSnapshot;
  readonly createdAtIso: string;
  readonly committedAtIso: string | null;
}

export interface ResilienceVueHistoryItem {
  readonly generationId: string;
  readonly captureId: string;
  readonly accountId: string;
  readonly partition: string;
  readonly region: string;
  readonly completedAtIso: string;
  readonly state: ResilienceVueSnapshot["state"];
  readonly complete: boolean;
  readonly applicationCount: number;
  readonly assessmentCount: number;
  readonly recommendationCount: number;
  readonly contentSha256: string;
}

interface SnapshotRow {
  generation_id: string; org_id: string; customer_id: string; connection_id: string;
  account_id: string; partition: string; region: string; capture_id: string;
  source_state: ResilienceVueSnapshot["state"]; complete: number | string | boolean;
  content_sha256: string; snapshot_json: string; completed_at: string;
  application_count: number | string; assessment_count: number | string;
  recommendation_count: number | string; created_at: number | string;
  advanced_at?: number | string | null;
}

export class ResilienceVueRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "IMMUTABLE_CONFLICT" | "STORED_STATE_INVALID";
  public constructor(code: ResilienceVueRepositoryError["code"]) {
    super("ResilienceVue snapshot persistence operation rejected");
    this.name = "ResilienceVueRepositoryError"; this.code = code;
  }
}

function reject(code: ResilienceVueRepositoryError["code"] = "INVALID_INPUT"): never {
  throw new ResilienceVueRepositoryError(code);
}
function assertScope(scope: ResilienceVuePersistenceScope): void {
  if (!IDENTIFIER.test(scope.organizationId) || !IDENTIFIER.test(scope.customerId)
    || !CONNECTION_ID.test(scope.connectionId)) reject();
}
function integer(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) reject("STORED_STATE_INVALID");
  return parsed;
}
function bool(value: unknown): boolean {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  reject("STORED_STATE_INVALID");
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}
async function materialize(row: SnapshotRow): Promise<StoredResilienceVueSnapshot> {
  if (!GENERATION_ID.test(row.generation_id) || !SHA256.test(row.content_sha256)
    || Buffer.byteLength(row.snapshot_json, "utf8") > MAX_BYTES) reject("STORED_STATE_INVALID");
  let snapshot: ResilienceVueSnapshot;
  try { snapshot = JSON.parse(row.snapshot_json) as ResilienceVueSnapshot; } catch { reject("STORED_STATE_INVALID"); }
  const complete = bool(row.complete);
  if (snapshot.schemaVersion !== "sutra.resilience-vue-snapshot.v1"
    || snapshot.scope.orgId !== row.org_id || snapshot.scope.customerId !== row.customer_id
    || snapshot.scope.connectionId !== row.connection_id || snapshot.scope.accountId !== row.account_id
    || snapshot.scope.partition !== row.partition || snapshot.scope.region !== row.region
    || snapshot.captureId !== row.capture_id || snapshot.state !== row.source_state
    || snapshot.complete !== complete || snapshot.completedAtIso !== row.completed_at
    || snapshot.applications.length !== integer(row.application_count)
    || snapshot.assessments.length !== integer(row.assessment_count)
    || snapshot.recommendations.length !== integer(row.recommendation_count)
    || await sha256(row.snapshot_json) !== row.content_sha256
    || row.generation_id !== `rvg_${row.content_sha256}`) reject("STORED_STATE_INVALID");
  const advanced = row.advanced_at === undefined || row.advanced_at === null ? null : integer(row.advanced_at);
  return {
    scope: { organizationId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id },
    generationId: row.generation_id, contentSha256: row.content_sha256, snapshot,
    createdAtIso: new Date(integer(row.created_at)).toISOString(),
    committedAtIso: advanced === null ? null : new Date(advanced).toISOString(),
  };
}
function history(row: SnapshotRow): ResilienceVueHistoryItem {
  return {
    generationId: row.generation_id, captureId: row.capture_id, accountId: row.account_id,
    partition: row.partition, region: row.region, completedAtIso: row.completed_at,
    state: row.source_state, complete: bool(row.complete), applicationCount: integer(row.application_count),
    assessmentCount: integer(row.assessment_count), recommendationCount: integer(row.recommendation_count),
    contentSha256: row.content_sha256,
  };
}

export class ResilienceVueRepository {
  private readonly database: D1Database;
  public constructor(database: D1Database = getRawDb()) { this.database = database; }
  private async live(scope: ResilienceVuePersistenceScope): Promise<D1Database> {
    assertScope(scope); await ensureRuntimeSchema(this.database);
    const row = await this.database.prepare(`SELECT c.id FROM aws_connections c
      JOIN organizations o ON o.id=c.org_id AND o.status='active'
      JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id AND cu.status='active'
      WHERE c.org_id=? AND c.customer_id=? AND c.id=? AND c.source_kind='aws_trust_role'
        AND c.status='active'
        AND c.permission_pack_version IN (${RESILIENCE_VUE_RUNTIME_PERMISSION_PACK_SQL})
      LIMIT 1`).bind(scope.organizationId, scope.customerId, scope.connectionId).first();
    if (row === null) reject("SCOPE_NOT_FOUND"); return this.database;
  }
  private async byGeneration(db: D1Database, scope: ResilienceVuePersistenceScope, id: string) {
    const row = await db.prepare(`SELECT s.* FROM finops_resilience_vue_snapshots s
      WHERE s.org_id=? AND s.customer_id=? AND s.connection_id=? AND s.generation_id=? LIMIT 1`)
      .bind(scope.organizationId, scope.customerId, scope.connectionId, id).first<SnapshotRow>();
    return row === null ? null : materialize(row);
  }
  public async getSnapshotByGeneration(scope: ResilienceVuePersistenceScope, generationId: string) {
    if (!GENERATION_ID.test(generationId)) reject();
    return this.byGeneration(await this.live(scope), scope, generationId);
  }
  public async getSnapshotByCaptureId(scope: ResilienceVuePersistenceScope, captureId: string) {
    if (!/^resilience_[a-f0-9]{64}$/u.test(captureId)) reject();
    const db = await this.live(scope);
    const row = await db.prepare(`SELECT s.* FROM finops_resilience_vue_snapshots s
      WHERE s.org_id=? AND s.customer_id=? AND s.connection_id=? AND s.capture_id=? LIMIT 1`)
      .bind(scope.organizationId, scope.customerId, scope.connectionId, captureId).first<SnapshotRow>();
    return row === null ? null : materialize(row);
  }
  public async recordCapture(scope: ResilienceVuePersistenceScope, trustedScope: ResilienceVueScope,
    capture: ResilienceVueCapture, nowMs = Date.now()): Promise<{ readonly snapshot: StoredResilienceVueSnapshot; readonly becameActive: boolean }> {
    assertScope(scope);
    if (trustedScope.orgId !== scope.organizationId || trustedScope.customerId !== scope.customerId
      || trustedScope.connectionId !== scope.connectionId || !Number.isSafeInteger(nowMs) || nowMs < 0) reject();
    const snapshot = normalizeResilienceVueCapture(capture, trustedScope, nowMs);
    const payload = JSON.stringify(snapshot);
    if (Buffer.byteLength(payload, "utf8") > MAX_BYTES) reject();
    const contentSha256 = await sha256(payload); const generationId = `rvg_${contentSha256}`;
    const db = await this.live(scope); const before = await this.getActiveSnapshotForTarget(scope, trustedScope.accountId, trustedScope.partition, trustedScope.region);
    const statements = [db.prepare(`INSERT INTO finops_resilience_vue_snapshots (
      generation_id,org_id,customer_id,connection_id,account_id,partition,region,capture_id,
      source_state,complete,content_sha256,snapshot_json,completed_at,application_count,
      assessment_count,recommendation_count,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(
      generationId, scope.organizationId, scope.customerId, scope.connectionId, trustedScope.accountId,
      trustedScope.partition, trustedScope.region, snapshot.captureId, snapshot.state, snapshot.complete ? 1 : 0,
      contentSha256, payload, snapshot.completedAtIso, snapshot.applications.length,
      snapshot.assessments.length, snapshot.recommendations.length, nowMs,
    )];
    if (snapshot.complete) statements.push(db.prepare(`INSERT INTO finops_resilience_vue_heads
      (org_id,customer_id,connection_id,account_id,partition,region,active_generation_id,advanced_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (org_id,customer_id,connection_id,account_id,partition,region)
      DO UPDATE SET active_generation_id=excluded.active_generation_id, advanced_at=excluded.advanced_at
      WHERE excluded.active_generation_id <> finops_resilience_vue_heads.active_generation_id AND EXISTS (
        SELECT 1 FROM finops_resilience_vue_snapshots candidate JOIN finops_resilience_vue_snapshots active
          ON active.generation_id=finops_resilience_vue_heads.active_generation_id
        WHERE candidate.generation_id=excluded.active_generation_id
          AND (candidate.completed_at>active.completed_at OR
            (candidate.completed_at=active.completed_at AND candidate.generation_id>active.generation_id)))`)
      .bind(scope.organizationId, scope.customerId, scope.connectionId, trustedScope.accountId,
        trustedScope.partition, trustedScope.region, generationId, nowMs));
    await db.batch(statements);
    const stored = await this.byGeneration(db, scope, generationId);
    if (stored === null || stored.contentSha256 !== contentSha256) reject("IMMUTABLE_CONFLICT");
    const active = await this.getActiveSnapshotForTarget(scope, trustedScope.accountId, trustedScope.partition, trustedScope.region);
    return { snapshot: stored, becameActive: active?.generationId === generationId && before?.generationId !== generationId };
  }
  public async getActiveSnapshotForTarget(scope: ResilienceVuePersistenceScope, accountId: string, partition: string, region: string) {
    if (!/^\d{12}$/u.test(accountId) || !["aws", "aws-cn", "aws-us-gov"].includes(partition)
      || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/u.test(region)) reject();
    const db = await this.live(scope);
    const row = await db.prepare(`SELECT s.*,h.advanced_at FROM finops_resilience_vue_heads h
      JOIN finops_resilience_vue_snapshots s ON s.generation_id=h.active_generation_id
      WHERE h.org_id=? AND h.customer_id=? AND h.connection_id=? AND h.account_id=? AND h.partition=? AND h.region=? LIMIT 1`)
      .bind(scope.organizationId, scope.customerId, scope.connectionId, accountId, partition, region).first<SnapshotRow>();
    return row === null ? null : materialize(row);
  }
  public async listActiveSnapshots(scope: ResilienceVuePersistenceScope): Promise<readonly StoredResilienceVueSnapshot[]> {
    const db = await this.live(scope);
    const rows = await db.prepare(`SELECT s.*,h.advanced_at FROM finops_resilience_vue_heads h
      JOIN finops_resilience_vue_snapshots s ON s.generation_id=h.active_generation_id
      WHERE h.org_id=? AND h.customer_id=? AND h.connection_id=?
      ORDER BY s.account_id,s.partition,s.region`).bind(scope.organizationId, scope.customerId, scope.connectionId).all<SnapshotRow>();
    return Promise.all((rows.results ?? []).map(materialize));
  }
  public async listHistory(scope: ResilienceVuePersistenceScope, limit = 180): Promise<readonly ResilienceVueHistoryItem[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) reject();
    const db = await this.live(scope);
    const rows = await db.prepare(`SELECT s.* FROM finops_resilience_vue_snapshots s
      WHERE s.org_id=? AND s.customer_id=? AND s.connection_id=?
      ORDER BY s.completed_at DESC,s.generation_id DESC LIMIT ?`)
      .bind(scope.organizationId, scope.customerId, scope.connectionId, limit).all<SnapshotRow>();
    return (rows.results ?? []).map(history);
  }
}
