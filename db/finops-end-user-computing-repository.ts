/**
 * Immutable persistence for the privacy-minimized End User Computing engine.
 * Raw WorkSpaces users, AppStream sessions, network data, and provider
 * messages are not accepted by this repository.
 */
import {
  normalizeEndUserComputingCapture,
  type EndUserComputingBoundary,
  type EndUserComputingCapture,
  type EndUserComputingSnapshot,
} from "../lib/finops-end-user-computing.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const GENERATION_ID = /^eucg_[a-f0-9]{64}$/u;
const CAPTURE_ID = /^euc_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_SNAPSHOT_BYTES = 8 * 1_024 * 1_024;
const MAX_HISTORY = 93;

export interface EndUserComputingPersistenceScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface StoredEndUserComputingSnapshot {
  readonly scope: EndUserComputingPersistenceScope;
  readonly generationId: string;
  readonly contentSha256: string;
  readonly snapshot: EndUserComputingSnapshot;
  readonly createdAtIso: string;
  readonly committedAtIso: string | null;
}

export interface EndUserComputingHistoryItem {
  readonly generationId: string;
  readonly sourceCaptureId: string;
  readonly sourceState: EndUserComputingSnapshot["state"];
  readonly observedAtIso: string;
  readonly workspaceCount: number;
  readonly fleetCount: number;
  readonly metricCount: number;
  readonly costLineCount: number;
  readonly contentSha256: string;
}

export class EndUserComputingRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "IMMUTABLE_CONFLICT" | "STORED_STATE_INVALID";

  public constructor(code: EndUserComputingRepositoryError["code"]) {
    super("End User Computing snapshot persistence operation rejected");
    this.name = "EndUserComputingRepositoryError";
    this.code = code;
  }
}

interface SnapshotRow {
  generation_id: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  partition: EndUserComputingSnapshot["partition"];
  source_capture_id: string;
  source_state: EndUserComputingSnapshot["state"];
  observed_at: string;
  content_sha256: string;
  snapshot_json: string;
  workspace_count: number | string;
  fleet_count: number | string;
  metric_count: number | string;
  cost_line_count: number | string;
  created_at: number | string;
  advanced_at?: number | string | null;
}

function reject(code: EndUserComputingRepositoryError["code"] = "INVALID_INPUT"): never {
  throw new EndUserComputingRepositoryError(code);
}

function assertScope(scope: EndUserComputingPersistenceScope): void {
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

async function materialize(row: SnapshotRow): Promise<StoredEndUserComputingSnapshot> {
  if (!GENERATION_ID.test(row.generation_id) || !CAPTURE_ID.test(row.source_capture_id)
    || !SHA256.test(row.content_sha256)
    || new TextEncoder().encode(row.snapshot_json).byteLength > MAX_SNAPSHOT_BYTES) reject("STORED_STATE_INVALID");
  let snapshot: EndUserComputingSnapshot;
  try { snapshot = JSON.parse(row.snapshot_json) as EndUserComputingSnapshot; } catch { reject("STORED_STATE_INVALID"); }
  const scope = { organizationId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id };
  assertScope(scope);
  if (snapshot.scope.orgId !== row.org_id || snapshot.scope.customerId !== row.customer_id
    || snapshot.scope.connectionId !== row.connection_id || snapshot.partition !== row.partition
    || snapshot.captureId !== row.source_capture_id || snapshot.state !== row.source_state
    || snapshot.observedAt !== row.observed_at || snapshot.workspaces.length !== integer(row.workspace_count)
    || snapshot.appStreamFleets.length !== integer(row.fleet_count)
    || snapshot.metrics.length !== integer(row.metric_count) || snapshot.costs.length !== integer(row.cost_line_count)
    || await sha256(row.snapshot_json) !== row.content_sha256
    || row.generation_id !== `eucg_${row.content_sha256}`) reject("STORED_STATE_INVALID");
  const createdAt = integer(row.created_at);
  const advancedAt = row.advanced_at === undefined || row.advanced_at === null ? null : integer(row.advanced_at);
  return { scope, generationId: row.generation_id, contentSha256: row.content_sha256, snapshot,
    createdAtIso: new Date(createdAt).toISOString(), committedAtIso: advancedAt === null ? null : new Date(advancedAt).toISOString() };
}

function history(stored: StoredEndUserComputingSnapshot): EndUserComputingHistoryItem {
  return {
    generationId: stored.generationId, sourceCaptureId: stored.snapshot.captureId,
    sourceState: stored.snapshot.state, observedAtIso: stored.snapshot.observedAt,
    workspaceCount: stored.snapshot.workspaces.length,
    fleetCount: stored.snapshot.appStreamFleets.length,
    metricCount: stored.snapshot.metrics.length,
    costLineCount: stored.snapshot.costs.length, contentSha256: stored.contentSha256,
  };
}

const LIVE_SCOPE = `
  JOIN aws_connections c ON c.id = s.connection_id AND c.org_id = s.org_id
    AND c.customer_id = s.customer_id AND c.partition = s.partition
  JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
  JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id AND cu.status = 'active'`;

export class EndUserComputingRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) { this.database = database; }

  private async live(scope: EndUserComputingPersistenceScope): Promise<D1Database> {
    assertScope(scope);
    await ensureRuntimeSchema(this.database);
    const row = await this.database.prepare(
      `SELECT c.id FROM aws_connections c
       JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
       JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id AND cu.status = 'active'
       WHERE c.org_id = ? AND c.customer_id = ? AND c.id = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active' LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId).first<{ id: string }>();
    if (row === null) reject("SCOPE_NOT_FOUND");
    return this.database;
  }

  private async byGeneration(database: D1Database, scope: EndUserComputingPersistenceScope, generationId: string) {
    const row = await database.prepare(
      `SELECT s.* FROM finops_euc_snapshots s ${LIVE_SCOPE}
       WHERE s.org_id = ? AND s.customer_id = ? AND s.connection_id = ? AND s.generation_id = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active' LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId, generationId).first<SnapshotRow>();
    return row === null ? null : materialize(row);
  }

  public async recordCapture(
    boundary: EndUserComputingBoundary,
    capture: EndUserComputingCapture,
    nowMs = Date.now(),
  ): Promise<{ readonly generation: StoredEndUserComputingSnapshot; readonly becameActive: boolean }> {
    const scope = { organizationId: boundary.scope.orgId, customerId: boundary.scope.customerId, connectionId: boundary.scope.connectionId };
    assertScope(scope);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) reject();
    const completedAt = Date.parse(capture.completedAt);
    if (!Number.isFinite(completedAt) || completedAt > nowMs + 300_000) reject();
    const snapshot = normalizeEndUserComputingCapture(capture, boundary, completedAt);
    const snapshotJson = JSON.stringify(snapshot);
    if (new TextEncoder().encode(snapshotJson).byteLength > MAX_SNAPSHOT_BYTES) reject();
    const contentSha256 = await sha256(snapshotJson);
    const generationId = `eucg_${contentSha256}`;
    const database = await this.live(scope);
    const previous = await this.getActiveSnapshot(scope);
    const statements = [database.prepare(
      `INSERT INTO finops_euc_snapshots (
        generation_id, org_id, customer_id, connection_id, partition, source_capture_id,
        source_state, observed_at, content_sha256, snapshot_json, workspace_count,
        fleet_count, metric_count, cost_line_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING`,
    ).bind(generationId, scope.organizationId, scope.customerId, scope.connectionId,
      snapshot.partition, snapshot.captureId, snapshot.state, snapshot.observedAt,
      contentSha256, snapshotJson, snapshot.workspaces.length, snapshot.appStreamFleets.length,
      snapshot.metrics.length, snapshot.costs.length, nowMs)];
    if (snapshot.state === "READY") statements.push(database.prepare(
      `INSERT INTO finops_euc_snapshot_heads (org_id, customer_id, connection_id, active_generation_id, advanced_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (org_id, customer_id, connection_id) DO UPDATE SET
         active_generation_id = excluded.active_generation_id, advanced_at = excluded.advanced_at
       WHERE excluded.active_generation_id <> finops_euc_snapshot_heads.active_generation_id
         AND EXISTS (
           SELECT 1 FROM finops_euc_snapshots candidate JOIN finops_euc_snapshots active
             ON active.generation_id = finops_euc_snapshot_heads.active_generation_id
           WHERE candidate.generation_id = excluded.active_generation_id
             AND candidate.org_id = finops_euc_snapshot_heads.org_id
             AND candidate.customer_id = finops_euc_snapshot_heads.customer_id
             AND candidate.connection_id = finops_euc_snapshot_heads.connection_id
             AND candidate.observed_at > active.observed_at
         )`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId, generationId, nowMs));
    await database.batch(statements);
    const stored = await this.byGeneration(database, scope, generationId);
    if (stored === null || stored.contentSha256 !== contentSha256) reject("IMMUTABLE_CONFLICT");
    const active = await this.getActiveSnapshot(scope);
    return { generation: stored, becameActive: active?.generationId === generationId && previous?.generationId !== generationId };
  }

  public async getActiveSnapshot(scope: EndUserComputingPersistenceScope): Promise<StoredEndUserComputingSnapshot | null> {
    const database = await this.live(scope);
    const row = await database.prepare(
      `SELECT s.*, h.advanced_at FROM finops_euc_snapshot_heads h
       JOIN finops_euc_snapshots s ON s.generation_id = h.active_generation_id
         AND s.org_id = h.org_id AND s.customer_id = h.customer_id AND s.connection_id = h.connection_id
       ${LIVE_SCOPE}
       WHERE h.org_id = ? AND h.customer_id = ? AND h.connection_id = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active' LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId).first<SnapshotRow>();
    return row === null ? null : materialize(row);
  }

  public async getLatestSnapshot(scope: EndUserComputingPersistenceScope): Promise<StoredEndUserComputingSnapshot | null> {
    const database = await this.live(scope);
    const row = await database.prepare(
      `SELECT s.* FROM finops_euc_snapshots s ${LIVE_SCOPE}
       WHERE s.org_id = ? AND s.customer_id = ? AND s.connection_id = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
       ORDER BY s.observed_at DESC, s.generation_id DESC LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId).first<SnapshotRow>();
    return row === null ? null : materialize(row);
  }

  public async listHistory(scope: EndUserComputingPersistenceScope, limit = 30): Promise<readonly EndUserComputingHistoryItem[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY) reject();
    const database = await this.live(scope);
    const rows = await database.prepare(
      `SELECT s.* FROM finops_euc_snapshots s ${LIVE_SCOPE}
       WHERE s.org_id = ? AND s.customer_id = ? AND s.connection_id = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
       ORDER BY s.observed_at DESC, s.generation_id DESC LIMIT ?`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId, limit).all<SnapshotRow>();
    return Promise.all((rows.results ?? []).map(async (row) => history(await materialize(row))));
  }
}
