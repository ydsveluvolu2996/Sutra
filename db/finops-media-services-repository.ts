/** Immutable, tenant-scoped accepted-head persistence for AWS Media Services Insights. */
import {
  normalizeMediaServicesCapture,
  type MediaServicesCapture,
  type MediaServicesScope,
  type MediaServicesSnapshot,
} from "../lib/finops-media-services-insights.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/u;
const GENERATION_ID = /^msg_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_BYTES = 80 * 1_024 * 1_024;

export interface MediaServicesPersistenceScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface StoredMediaServicesSnapshot {
  readonly scope: MediaServicesPersistenceScope;
  readonly generationId: string;
  readonly contentSha256: string;
  readonly snapshot: MediaServicesSnapshot;
  readonly createdAtIso: string;
  readonly committedAtIso: string | null;
}

export interface MediaServicesHistoryItem {
  readonly generationId: string;
  readonly captureId: string;
  readonly accountId: string;
  readonly partition: string;
  readonly region: string;
  readonly state: MediaServicesSnapshot["state"];
  readonly complete: boolean;
  readonly completedAtIso: string;
  readonly dataThroughAtIso: string;
  readonly billingGenerationId: string;
  readonly providerCount: number;
  readonly resourceCount: number;
  readonly costRowCount: number;
  readonly contentSha256: string;
}

interface SnapshotRow {
  generation_id: string; org_id: string; customer_id: string; connection_id: string;
  account_id: string; partition: string; region: string; capture_id: string;
  source_state: MediaServicesSnapshot["state"]; complete: boolean | number | string;
  content_sha256: string; snapshot_json: string; completed_at: string; data_through_at: string;
  billing_generation_id: string; billing_manifest_sha256: string;
  provider_count: number | string; resource_count: number | string; cost_row_count: number | string;
  created_at: number | string; advanced_at?: number | string | null;
}

export class MediaServicesRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "IMMUTABLE_CONFLICT" | "STORED_STATE_INVALID";
  public constructor(code: MediaServicesRepositoryError["code"]) {
    super("Media Services Insights snapshot persistence operation rejected");
    this.name = "MediaServicesRepositoryError"; this.code = code;
  }
}

function reject(code: MediaServicesRepositoryError["code"] = "INVALID_INPUT"): never {
  throw new MediaServicesRepositoryError(code);
}
function assertScope(scope: MediaServicesPersistenceScope): void {
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
async function materialize(row: SnapshotRow): Promise<StoredMediaServicesSnapshot> {
  if (!GENERATION_ID.test(row.generation_id) || !SHA256.test(row.content_sha256)
    || Buffer.byteLength(row.snapshot_json, "utf8") > MAX_BYTES) reject("STORED_STATE_INVALID");
  let snapshot: MediaServicesSnapshot;
  try { snapshot = JSON.parse(row.snapshot_json) as MediaServicesSnapshot; } catch { reject("STORED_STATE_INVALID"); }
  const complete = bool(row.complete);
  if (snapshot.schemaVersion !== "sutra.media-services-insights-snapshot.v1"
    || snapshot.scope.orgId !== row.org_id || snapshot.scope.customerId !== row.customer_id
    || snapshot.scope.connectionId !== row.connection_id || snapshot.scope.accountId !== row.account_id
    || snapshot.scope.partition !== row.partition || snapshot.scope.region !== row.region
    || snapshot.captureId !== row.capture_id || snapshot.state !== row.source_state
    || snapshot.complete !== complete || snapshot.completedAtIso !== row.completed_at
    || snapshot.costEvidence.dataThroughAtIso !== row.data_through_at
    || snapshot.costEvidence.generationId !== row.billing_generation_id
    || snapshot.costEvidence.manifestSha256 !== row.billing_manifest_sha256
    || snapshot.collections.length !== integer(row.provider_count)
    || snapshot.resources.length !== integer(row.resource_count)
    || snapshot.costEvidence.rows.length !== integer(row.cost_row_count)
    || await sha256(row.snapshot_json) !== row.content_sha256
    || row.generation_id !== `msg_${row.content_sha256}`) reject("STORED_STATE_INVALID");
  const advancedAt = row.advanced_at === undefined || row.advanced_at === null ? null : integer(row.advanced_at);
  return {
    scope: { organizationId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id },
    generationId: row.generation_id, contentSha256: row.content_sha256, snapshot,
    createdAtIso: new Date(integer(row.created_at)).toISOString(),
    committedAtIso: advancedAt === null ? null : new Date(advancedAt).toISOString(),
  };
}
function history(row: SnapshotRow): MediaServicesHistoryItem {
  return {
    generationId: row.generation_id, captureId: row.capture_id, accountId: row.account_id,
    partition: row.partition, region: row.region, state: row.source_state, complete: bool(row.complete),
    completedAtIso: row.completed_at, dataThroughAtIso: row.data_through_at,
    billingGenerationId: row.billing_generation_id, providerCount: integer(row.provider_count),
    resourceCount: integer(row.resource_count), costRowCount: integer(row.cost_row_count), contentSha256: row.content_sha256,
  };
}

export class MediaServicesRepository {
  private readonly database: D1Database;
  public constructor(database: D1Database = getRawDb()) { this.database = database; }
  private async live(scope: MediaServicesPersistenceScope): Promise<D1Database> {
    assertScope(scope); await ensureRuntimeSchema(this.database);
    const row = await this.database.prepare(`SELECT c.id FROM aws_connections c
      JOIN organizations o ON o.id=c.org_id AND o.status='active'
      JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id AND cu.status='active'
      WHERE c.org_id=? AND c.customer_id=? AND c.id=? AND c.source_kind='aws_trust_role'
        AND c.status='active' LIMIT 1`).bind(scope.organizationId, scope.customerId, scope.connectionId).first();
    if (row === null) reject("SCOPE_NOT_FOUND"); return this.database;
  }
  private async byGeneration(database: D1Database, scope: MediaServicesPersistenceScope, generationId: string) {
    const row = await database.prepare(`SELECT s.* FROM finops_media_services_snapshots s
      WHERE s.org_id=? AND s.customer_id=? AND s.connection_id=? AND s.generation_id=? LIMIT 1`)
      .bind(scope.organizationId, scope.customerId, scope.connectionId, generationId).first<SnapshotRow>();
    return row === null ? null : materialize(row);
  }
  public async recordCapture(scope: MediaServicesPersistenceScope, trustedScope: MediaServicesScope,
    capture: MediaServicesCapture, nowMs = Date.now()): Promise<{ readonly snapshot: StoredMediaServicesSnapshot; readonly becameActive: boolean }> {
    assertScope(scope);
    if (trustedScope.orgId !== scope.organizationId || trustedScope.customerId !== scope.customerId
      || trustedScope.connectionId !== scope.connectionId || !Number.isSafeInteger(nowMs) || nowMs < 0) reject();
    const snapshot = normalizeMediaServicesCapture(capture, trustedScope, nowMs);
    const payload = JSON.stringify(snapshot);
    if (Buffer.byteLength(payload, "utf8") > MAX_BYTES) reject();
    const contentSha256 = await sha256(payload); const generationId = `msg_${contentSha256}`;
    const database = await this.live(scope);
    const before = await this.getActiveSnapshotForTarget(scope, trustedScope.accountId, trustedScope.partition, trustedScope.region);
    const statements = [database.prepare(`INSERT INTO finops_media_services_snapshots (
      generation_id,org_id,customer_id,connection_id,account_id,partition,region,capture_id,source_state,
      complete,content_sha256,snapshot_json,completed_at,data_through_at,billing_generation_id,
      billing_manifest_sha256,provider_count,resource_count,cost_row_count,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(
      generationId,scope.organizationId,scope.customerId,scope.connectionId,trustedScope.accountId,
      trustedScope.partition,trustedScope.region,snapshot.captureId,snapshot.state,snapshot.complete ? 1 : 0,
      contentSha256,payload,snapshot.completedAtIso,snapshot.costEvidence.dataThroughAtIso,
      snapshot.costEvidence.generationId,snapshot.costEvidence.manifestSha256,snapshot.collections.length,
      snapshot.resources.length,snapshot.costEvidence.rows.length,nowMs,
    )];
    if (snapshot.complete) statements.push(database.prepare(`INSERT INTO finops_media_services_heads
      (org_id,customer_id,connection_id,account_id,partition,region,active_generation_id,advanced_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (org_id,customer_id,connection_id,account_id,partition,region)
      DO UPDATE SET active_generation_id=excluded.active_generation_id,advanced_at=excluded.advanced_at
      WHERE excluded.active_generation_id<>finops_media_services_heads.active_generation_id AND EXISTS (
        SELECT 1 FROM finops_media_services_snapshots candidate JOIN finops_media_services_snapshots active
          ON active.generation_id=finops_media_services_heads.active_generation_id
        WHERE candidate.generation_id=excluded.active_generation_id
          AND (candidate.completed_at>active.completed_at OR
            (candidate.completed_at=active.completed_at AND candidate.generation_id>active.generation_id)))`)
      .bind(scope.organizationId,scope.customerId,scope.connectionId,trustedScope.accountId,
        trustedScope.partition,trustedScope.region,generationId,nowMs));
    await database.batch(statements);
    const stored = await this.byGeneration(database,scope,generationId);
    if (stored === null || stored.contentSha256 !== contentSha256) reject("IMMUTABLE_CONFLICT");
    const active = await this.getActiveSnapshotForTarget(scope,trustedScope.accountId,trustedScope.partition,trustedScope.region);
    return { snapshot: stored, becameActive: active?.generationId === generationId && before?.generationId !== generationId };
  }
  public async getActiveSnapshotForTarget(scope: MediaServicesPersistenceScope, accountId: string, partition: string, region: string) {
    if (!ACCOUNT_ID.test(accountId) || !["aws","aws-cn","aws-us-gov"].includes(partition) || !REGION.test(region)) reject();
    const database = await this.live(scope);
    const row = await database.prepare(`SELECT s.*,h.advanced_at FROM finops_media_services_heads h
      JOIN finops_media_services_snapshots s ON s.generation_id=h.active_generation_id
      WHERE h.org_id=? AND h.customer_id=? AND h.connection_id=? AND h.account_id=? AND h.partition=? AND h.region=? LIMIT 1`)
      .bind(scope.organizationId,scope.customerId,scope.connectionId,accountId,partition,region).first<SnapshotRow>();
    return row === null ? null : materialize(row);
  }
  public async listActiveSnapshots(scope: MediaServicesPersistenceScope): Promise<readonly StoredMediaServicesSnapshot[]> {
    const database = await this.live(scope);
    const rows = await database.prepare(`SELECT s.*,h.advanced_at FROM finops_media_services_heads h
      JOIN finops_media_services_snapshots s ON s.generation_id=h.active_generation_id
      WHERE h.org_id=? AND h.customer_id=? AND h.connection_id=? ORDER BY s.account_id,s.partition,s.region`)
      .bind(scope.organizationId,scope.customerId,scope.connectionId).all<SnapshotRow>();
    return Promise.all((rows.results ?? []).map(materialize));
  }
  public async listHistory(scope: MediaServicesPersistenceScope, limit = 180): Promise<readonly MediaServicesHistoryItem[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) reject();
    const database = await this.live(scope);
    const rows = await database.prepare(`SELECT s.* FROM finops_media_services_snapshots s
      WHERE s.org_id=? AND s.customer_id=? AND s.connection_id=?
      ORDER BY s.completed_at DESC,s.generation_id DESC LIMIT ?`)
      .bind(scope.organizationId,scope.customerId,scope.connectionId,limit).all<SnapshotRow>();
    return (rows.results ?? []).map(history);
  }
}
