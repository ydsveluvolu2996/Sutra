/**
 * Immutable CORA dashboard persistence.
 *
 * The repository accepts the typed collector capture, invokes the fail-closed
 * CORA boundary itself, and persists only its normalized dashboard snapshot.
 * Raw Cost Optimization Hub export objects and provider payloads are never
 * accepted here. A mutable head may point only at a proven READY generation.
 */
import {
  normalizeCoraCapture,
  type CoraCapture,
  type CoraSnapshot,
} from "../lib/finops-cora.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const GENERATION_ID = /^corg_[a-f0-9]{64}$/u;
const CAPTURE_ID = /^cora_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_SNAPSHOT_BYTES = 24 * 1_024 * 1_024;
const MAX_HISTORY = 90;

export interface CoraPersistenceScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface StoredCoraSnapshot {
  readonly scope: CoraPersistenceScope;
  readonly generationId: string;
  readonly contentSha256: string;
  readonly snapshot: CoraSnapshot;
  readonly createdAtIso: string;
  readonly committedAtIso: string | null;
}

export interface CoraSnapshotHistoryItem {
  readonly generationId: string;
  readonly sourceCaptureId: string;
  readonly sourceState: CoraSnapshot["state"];
  readonly collectedAtIso: string;
  readonly dataThroughAtIso: string | null;
  readonly organizationCoverage: CoraSnapshot["organizationCoverage"];
  readonly expectedAccountCount: number;
  readonly activeEnrollmentAccountCount: number;
  readonly recommendationCount: number;
  readonly acceptedRecordCount: number;
  readonly rejectedRecordCount: number;
  readonly contentSha256: string;
  readonly summaries: CoraSnapshot["summaries"];
}

export class CoraRepositoryError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "SCOPE_NOT_FOUND"
    | "IMMUTABLE_CONFLICT"
    | "STORED_STATE_INVALID";

  public constructor(code: CoraRepositoryError["code"]) {
    super("CORA snapshot persistence operation rejected");
    this.name = "CoraRepositoryError";
    this.code = code;
  }
}

interface SnapshotRow {
  generation_id: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  source_capture_id: string;
  source_state: CoraSnapshot["state"];
  content_sha256: string;
  snapshot_json: string;
  summary_json: string;
  collected_at: string;
  data_through_at: string | null;
  organization_coverage: CoraSnapshot["organizationCoverage"];
  enrollment_state: CoraSnapshot["channelStates"]["enrollment"];
  recommendation_state: CoraSnapshot["channelStates"]["recommendations"];
  expected_account_count: number | string;
  active_enrollment_account_count: number | string;
  recommendation_count: number | string;
  accepted_record_count: number | string;
  rejected_record_count: number | string;
  created_at: number | string;
  advanced_at?: number | string | null;
}

function reject(code: CoraRepositoryError["code"] = "INVALID_INPUT"): never {
  throw new CoraRepositoryError(code);
}

function assertScope(scope: CoraPersistenceScope): void {
  if (
    !IDENTIFIER.test(scope.organizationId)
    || !IDENTIFIER.test(scope.customerId)
    || !CONNECTION_ID.test(scope.connectionId)
  ) reject();
}

function integer(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) {
    reject("STORED_STATE_INVALID");
  }
  return parsed;
}

function iso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

async function materialize(row: SnapshotRow): Promise<StoredCoraSnapshot> {
  if (
    !GENERATION_ID.test(row.generation_id)
    || !CAPTURE_ID.test(row.source_capture_id)
    || !SHA256.test(row.content_sha256)
    || Buffer.byteLength(row.snapshot_json, "utf8") > MAX_SNAPSHOT_BYTES
  ) reject("STORED_STATE_INVALID");
  let snapshot: CoraSnapshot;
  try {
    snapshot = JSON.parse(row.snapshot_json) as CoraSnapshot;
  } catch {
    reject("STORED_STATE_INVALID");
  }
  if (
    snapshot.sourceCaptureId !== row.source_capture_id
    || snapshot.state !== row.source_state
    || snapshot.organizationCoverage !== row.organization_coverage
    || snapshot.channelStates?.enrollment !== row.enrollment_state
    || snapshot.channelStates?.recommendations !== row.recommendation_state
    || snapshot.coverage?.expectedAccountCount !== integer(row.expected_account_count)
    || snapshot.coverage?.activeEnrollmentAccountCount
      !== integer(row.active_enrollment_account_count)
    || snapshot.recommendations?.length !== integer(row.recommendation_count)
    || snapshot.coverage?.exportAcceptedRows !== integer(row.accepted_record_count)
    || snapshot.coverage?.exportRejectedRows !== integer(row.rejected_record_count)
    || snapshot.scope?.orgId !== row.org_id
    || snapshot.scope?.customerId !== row.customer_id
    || snapshot.scope?.connectionId !== row.connection_id
    || await sha256(row.snapshot_json) !== row.content_sha256
    || `corg_${row.content_sha256}` !== row.generation_id
  ) reject("STORED_STATE_INVALID");
  const createdAt = integer(row.created_at);
  const advancedAt = row.advanced_at === undefined || row.advanced_at === null
    ? null
    : integer(row.advanced_at);
  return {
    scope: {
      organizationId: row.org_id,
      customerId: row.customer_id,
      connectionId: row.connection_id,
    },
    generationId: row.generation_id,
    contentSha256: row.content_sha256,
    snapshot,
    createdAtIso: new Date(createdAt).toISOString(),
    committedAtIso: advancedAt === null ? null : new Date(advancedAt).toISOString(),
  };
}

function history(row: SnapshotRow): CoraSnapshotHistoryItem {
  const collectedAtIso = iso(row.collected_at);
  const dataThroughAtIso = row.data_through_at === null ? null : iso(row.data_through_at);
  if (collectedAtIso === null || (row.data_through_at !== null && dataThroughAtIso === null)) {
    reject("STORED_STATE_INVALID");
  }
  let summaries: CoraSnapshot["summaries"];
  try {
    summaries = JSON.parse(row.summary_json) as CoraSnapshot["summaries"];
  } catch {
    reject("STORED_STATE_INVALID");
  }
  if (!Array.isArray(summaries) || Buffer.byteLength(row.summary_json, "utf8") > 262_144) {
    reject("STORED_STATE_INVALID");
  }
  return {
    generationId: row.generation_id,
    sourceCaptureId: row.source_capture_id,
    sourceState: row.source_state,
    collectedAtIso,
    dataThroughAtIso,
    organizationCoverage: row.organization_coverage,
    expectedAccountCount: integer(row.expected_account_count),
    activeEnrollmentAccountCount: integer(row.active_enrollment_account_count),
    recommendationCount: integer(row.recommendation_count),
    acceptedRecordCount: integer(row.accepted_record_count),
    rejectedRecordCount: integer(row.rejected_record_count),
    contentSha256: row.content_sha256,
    summaries,
  };
}

const LIVE_SCOPE = `
  JOIN aws_connections c
    ON c.id = s.connection_id AND c.org_id = s.org_id
   AND c.customer_id = s.customer_id
  JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
  JOIN customers cu
    ON cu.id = c.customer_id AND cu.org_id = c.org_id
   AND cu.status = 'active'`;

export class CoraRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async live(scope: CoraPersistenceScope): Promise<D1Database> {
    assertScope(scope);
    await ensureRuntimeSchema(this.database);
    const connection = await this.database.prepare(
      `SELECT c.id FROM aws_connections c
       JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
       JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
         AND cu.status = 'active'
       WHERE c.org_id = ? AND c.customer_id = ? AND c.id = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
       LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId)
      .first<{ id: string }>();
    if (connection === null) reject("SCOPE_NOT_FOUND");
    return this.database;
  }

  private async byGeneration(
    database: D1Database,
    scope: CoraPersistenceScope,
    generationId: string,
  ): Promise<StoredCoraSnapshot | null> {
    const row = await database.prepare(
      `SELECT s.* FROM finops_cora_snapshots s ${LIVE_SCOPE}
       WHERE s.org_id = ? AND s.customer_id = ? AND s.connection_id = ?
         AND s.generation_id = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
       LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId, generationId)
      .first<SnapshotRow>();
    return row === null ? null : materialize(row);
  }

  public async recordCapture(
    scope: CoraPersistenceScope,
    capture: CoraCapture,
    nowMs = Date.now(),
  ): Promise<{ readonly snapshot: StoredCoraSnapshot; readonly becameActive: boolean }> {
    assertScope(scope);
    if (
      capture.scope.orgId !== scope.organizationId
      || capture.scope.customerId !== scope.customerId
      || capture.scope.connectionId !== scope.connectionId
      || !Number.isSafeInteger(nowMs)
      || nowMs < 0
    ) reject();
    const completedAtMs = Date.parse(capture.completedAt);
    if (!Number.isFinite(completedAtMs)) reject();
    // Evaluation at the immutable capture completion time makes retries
    // deterministic. Current freshness is evaluated by the read API.
    const normalized = normalizeCoraCapture(capture, capture.scope, completedAtMs);
    const snapshotJson = JSON.stringify(normalized);
    if (Buffer.byteLength(snapshotJson, "utf8") > MAX_SNAPSHOT_BYTES) reject();
    const contentSha256 = await sha256(snapshotJson);
    const generationId = `corg_${contentSha256}`;
    const database = await this.live(scope);
    const previous = await this.getActiveSnapshot(scope);
    const statements = [
      database.prepare(
        `INSERT INTO finops_cora_snapshots (
           generation_id, org_id, customer_id, connection_id, source_capture_id,
           source_state, content_sha256, snapshot_json, summary_json, collected_at,
           data_through_at, organization_coverage, enrollment_state,
           recommendation_state, expected_account_count,
           active_enrollment_account_count, recommendation_count,
           accepted_record_count, rejected_record_count, created_at
         ) SELECT ?, c.org_id, c.customer_id, c.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM aws_connections c
         JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
         JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
           AND cu.status = 'active'
         WHERE c.org_id = ? AND c.customer_id = ? AND c.id = ?
           AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
         ON CONFLICT DO NOTHING`,
      ).bind(
        generationId, normalized.sourceCaptureId, normalized.state,
        contentSha256, snapshotJson, JSON.stringify(normalized.summaries), normalized.generatedAt,
        normalized.sourceDataThroughAt, normalized.organizationCoverage,
        normalized.channelStates.enrollment, normalized.channelStates.recommendations,
        normalized.coverage.expectedAccountCount,
        normalized.coverage.activeEnrollmentAccountCount,
        normalized.recommendations.length, normalized.coverage.exportAcceptedRows,
        normalized.coverage.exportRejectedRows, nowMs,
        scope.organizationId, scope.customerId, scope.connectionId,
      ),
    ];
    if (normalized.state === "READY") {
      statements.push(database.prepare(
        `INSERT INTO finops_cora_snapshot_heads (
           org_id, customer_id, connection_id, active_generation_id, advanced_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (org_id, customer_id, connection_id) DO UPDATE SET
           active_generation_id = excluded.active_generation_id,
           advanced_at = excluded.advanced_at
         WHERE excluded.active_generation_id <> finops_cora_snapshot_heads.active_generation_id
           AND EXISTS (
             SELECT 1 FROM finops_cora_snapshots candidate
             JOIN finops_cora_snapshots active
               ON active.generation_id = finops_cora_snapshot_heads.active_generation_id
             WHERE candidate.generation_id = excluded.active_generation_id
               AND candidate.org_id = finops_cora_snapshot_heads.org_id
               AND candidate.customer_id = finops_cora_snapshot_heads.customer_id
               AND candidate.connection_id = finops_cora_snapshot_heads.connection_id
               AND (candidate.data_through_at > active.data_through_at
                 OR (candidate.data_through_at = active.data_through_at
                   AND candidate.collected_at > active.collected_at))
           )`,
      ).bind(scope.organizationId, scope.customerId, scope.connectionId, generationId, nowMs));
    }
    await database.batch(statements);
    const stored = await this.byGeneration(database, scope, generationId);
    if (stored === null || stored.contentSha256 !== contentSha256) reject("IMMUTABLE_CONFLICT");
    const active = await this.getActiveSnapshot(scope);
    return {
      snapshot: stored,
      becameActive: active?.generationId === generationId
        && previous?.generationId !== generationId,
    };
  }

  public async getActiveSnapshot(scope: CoraPersistenceScope): Promise<StoredCoraSnapshot | null> {
    const database = await this.live(scope);
    const row = await database.prepare(
      `SELECT s.*, h.advanced_at FROM finops_cora_snapshot_heads h
       JOIN finops_cora_snapshots s
         ON s.generation_id = h.active_generation_id
        AND s.org_id = h.org_id AND s.customer_id = h.customer_id
        AND s.connection_id = h.connection_id
       ${LIVE_SCOPE}
       WHERE h.org_id = ? AND h.customer_id = ? AND h.connection_id = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
       LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId)
      .first<SnapshotRow>();
    return row === null ? null : materialize(row);
  }

  public async getLatestSnapshot(scope: CoraPersistenceScope): Promise<StoredCoraSnapshot | null> {
    const database = await this.live(scope);
    const row = await database.prepare(
      `SELECT s.* FROM finops_cora_snapshots s ${LIVE_SCOPE}
       WHERE s.org_id = ? AND s.customer_id = ? AND s.connection_id = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
       ORDER BY s.collected_at DESC, s.generation_id DESC LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId)
      .first<SnapshotRow>();
    return row === null ? null : materialize(row);
  }

  public async listHistory(
    scope: CoraPersistenceScope,
    limit = 30,
  ): Promise<readonly CoraSnapshotHistoryItem[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY) reject();
    const database = await this.live(scope);
    const rows = await database.prepare(
      `SELECT s.* FROM finops_cora_snapshots s ${LIVE_SCOPE}
       WHERE s.org_id = ? AND s.customer_id = ? AND s.connection_id = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
       ORDER BY s.collected_at DESC, s.generation_id DESC LIMIT ?`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId, limit)
      .all<SnapshotRow>();
    return (rows.results ?? []).map(history);
  }
}
