/**
 * Immutable, tenant-scoped persistence for privacy-minimized AWS Support case
 * snapshots. Only snapshots accepted by the fail-closed engine enter storage;
 * a mutable head can advance only to a fresher complete generation.
 */
import {
  awsSupportCasesSourceEvidence,
  type AwsSupportCasesSnapshot,
} from "../lib/finops-aws-support-cases-radar.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const GENERATION_ID = /^supg_[a-f0-9]{64}$/u;
const MAX_HISTORY = 36;
const MAX_SNAPSHOT_BYTES = 64 * 1_024 * 1_024;

export interface AwsSupportCasesPersistenceScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface StoredAwsSupportCasesSnapshot {
  readonly scope: AwsSupportCasesPersistenceScope;
  readonly generationId: string;
  readonly contentSha256: string;
  readonly snapshot: AwsSupportCasesSnapshot;
  readonly createdAtIso: string;
  readonly committedAtIso: string | null;
}

export class AwsSupportCasesRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "IMMUTABLE_CONFLICT" | "STORED_STATE_INVALID";
  public constructor(code: AwsSupportCasesRepositoryError["code"]) {
    super("AWS Support cases persistence operation rejected");
    this.name = "AwsSupportCasesRepositoryError";
    this.code = code;
  }
}

interface SnapshotRow {
  generation_id: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  capture_id: string;
  content_sha256: string;
  snapshot_json: string;
  observed_at: string;
  data_through_at: string;
  configuration_state: AwsSupportCasesSnapshot["configurationState"];
  collection_state: AwsSupportCasesSnapshot["collectionState"];
  intended_account_count: number | string;
  complete_account_count: number | string;
  case_count: number | string;
  created_at: number | string;
  advanced_at?: number | string | null;
}

function reject(code: AwsSupportCasesRepositoryError["code"] = "INVALID_INPUT"): never {
  throw new AwsSupportCasesRepositoryError(code);
}

function assertScope(scope: AwsSupportCasesPersistenceScope): void {
  if (typeof scope !== "object" || scope === null
    || !IDENTIFIER.test(scope.organizationId) || !IDENTIFIER.test(scope.customerId)
    || !CONNECTION_ID.test(scope.connectionId)) reject();
}

function integer(value: unknown): number {
  const result = typeof value === "string" ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) reject("STORED_STATE_INVALID");
  return result;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

async function materialize(row: SnapshotRow): Promise<StoredAwsSupportCasesSnapshot> {
  if (!GENERATION_ID.test(row.generation_id)) reject("STORED_STATE_INVALID");
  let snapshot: AwsSupportCasesSnapshot;
  try { snapshot = JSON.parse(row.snapshot_json) as AwsSupportCasesSnapshot; } catch { reject("STORED_STATE_INVALID"); }
  const digest = await sha256(row.snapshot_json);
  try { awsSupportCasesSourceEvidence(snapshot); } catch { reject("STORED_STATE_INVALID"); }
  if (digest !== row.content_sha256 || row.generation_id !== `supg_${digest}`
    || snapshot.scope.orgId !== row.org_id || snapshot.scope.customerId !== row.customer_id
    || snapshot.scope.connectionId !== row.connection_id || snapshot.captureId !== row.capture_id
    || snapshot.observedAt !== row.observed_at || snapshot.window.nextWatermark !== row.data_through_at
    || snapshot.configurationState !== row.configuration_state || snapshot.collectionState !== row.collection_state
    || snapshot.intendedAccounts.length !== integer(row.intended_account_count)
    || snapshot.accountCoverage.filter((entry) => entry.status === "complete").length !== integer(row.complete_account_count)
    || snapshot.cases.length !== integer(row.case_count)) reject("STORED_STATE_INVALID");
  const createdAt = integer(row.created_at);
  const advancedAt = row.advanced_at === null || row.advanced_at === undefined ? null : integer(row.advanced_at);
  return {
    scope: { organizationId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id },
    generationId: row.generation_id, contentSha256: row.content_sha256, snapshot,
    createdAtIso: new Date(createdAt).toISOString(),
    committedAtIso: advancedAt === null ? null : new Date(advancedAt).toISOString(),
  };
}

const LIVE_SCOPE = `
  JOIN aws_connections c ON c.id = s.connection_id AND c.org_id = s.org_id AND c.customer_id = s.customer_id
  JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
  JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id AND cu.status = 'active'`;

export class AwsSupportCasesRepository {
  public constructor(private readonly database: D1Database = getRawDb()) {}

  private async live(scope: AwsSupportCasesPersistenceScope): Promise<D1Database> {
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

  private async byGeneration(database: D1Database, scope: AwsSupportCasesPersistenceScope, generationId: string): Promise<StoredAwsSupportCasesSnapshot | null> {
    const row = await database.prepare(
      `SELECT s.* FROM finops_aws_support_case_snapshots s ${LIVE_SCOPE}
       WHERE s.org_id = ? AND s.customer_id = ? AND s.connection_id = ? AND s.generation_id = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active' LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId, generationId).first<SnapshotRow>();
    return row === null ? null : materialize(row);
  }

  public async recordSnapshot(scope: AwsSupportCasesPersistenceScope, snapshot: AwsSupportCasesSnapshot, nowMs = Date.now()): Promise<{ readonly snapshot: StoredAwsSupportCasesSnapshot; readonly becameActive: boolean }> {
    assertScope(scope);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || snapshot.scope.orgId !== scope.organizationId
      || snapshot.scope.customerId !== scope.customerId || snapshot.scope.connectionId !== scope.connectionId) reject();
    try { awsSupportCasesSourceEvidence(snapshot); } catch { reject(); }
    const snapshotJson = JSON.stringify(snapshot);
    if (Buffer.byteLength(snapshotJson, "utf8") > MAX_SNAPSHOT_BYTES) reject();
    const contentSha256 = await sha256(snapshotJson);
    const generationId = `supg_${contentSha256}`;
    const database = await this.live(scope);
    // Prove every fan-out target is a live connection in the same tenant/customer/partition.
    for (const target of snapshot.intendedAccounts) {
      const owned = await database.prepare(
        `SELECT id FROM aws_connections WHERE org_id = ? AND customer_id = ? AND id = ?
           AND aws_account_id = ? AND partition = ? AND source_kind = 'aws_trust_role' AND status = 'active' LIMIT 1`,
      ).bind(scope.organizationId, scope.customerId, target.connectionId, target.accountId, snapshot.scope.partition).first<{ id: string }>();
      if (owned === null) reject("SCOPE_NOT_FOUND");
    }
    const previous = await this.getActiveSnapshot(scope);
    const completeCount = snapshot.accountCoverage.filter((entry) => entry.status === "complete").length;
    const statements = [database.prepare(
      `INSERT INTO finops_aws_support_case_snapshots (
         generation_id, org_id, customer_id, connection_id, capture_id, content_sha256,
         snapshot_json, observed_at, data_through_at, configuration_state, collection_state,
         intended_account_count, complete_account_count, case_count, created_at
       ) SELECT ?, c.org_id, c.customer_id, c.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM aws_connections c
       JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
       JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id AND cu.status = 'active'
       WHERE c.org_id = ? AND c.customer_id = ? AND c.id = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
       ON CONFLICT DO NOTHING`,
    ).bind(generationId, snapshot.captureId, contentSha256, snapshotJson, snapshot.observedAt,
      snapshot.window.nextWatermark, snapshot.configurationState, snapshot.collectionState,
      snapshot.intendedAccounts.length, completeCount, snapshot.cases.length, nowMs,
      scope.organizationId, scope.customerId, scope.connectionId)];
    if (snapshot.configurationState === "ready" && snapshot.collectionState === "complete") {
      statements.push(database.prepare(
        `INSERT INTO finops_aws_support_case_heads (org_id, customer_id, connection_id, active_generation_id, advanced_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (org_id, customer_id, connection_id) DO UPDATE SET
           active_generation_id = excluded.active_generation_id, advanced_at = excluded.advanced_at
         WHERE excluded.active_generation_id <> finops_aws_support_case_heads.active_generation_id
           AND EXISTS (
             SELECT 1 FROM finops_aws_support_case_snapshots candidate
             JOIN finops_aws_support_case_snapshots active ON active.generation_id = finops_aws_support_case_heads.active_generation_id
             WHERE candidate.generation_id = excluded.active_generation_id
               AND candidate.org_id = finops_aws_support_case_heads.org_id
               AND candidate.customer_id = finops_aws_support_case_heads.customer_id
               AND candidate.connection_id = finops_aws_support_case_heads.connection_id
               AND (candidate.data_through_at > active.data_through_at
                 OR (candidate.data_through_at = active.data_through_at AND candidate.observed_at > active.observed_at))
           )`,
      ).bind(scope.organizationId, scope.customerId, scope.connectionId, generationId, nowMs));
    }
    await database.batch(statements);
    const stored = await this.byGeneration(database, scope, generationId);
    if (stored === null || stored.contentSha256 !== contentSha256) reject("IMMUTABLE_CONFLICT");
    const active = await this.getActiveSnapshot(scope);
    return { snapshot: stored, becameActive: active?.generationId === generationId && previous?.generationId !== generationId };
  }

  public async getActiveSnapshot(scope: AwsSupportCasesPersistenceScope): Promise<StoredAwsSupportCasesSnapshot | null> {
    const database = await this.live(scope);
    const row = await database.prepare(
      `SELECT s.*, h.advanced_at FROM finops_aws_support_case_heads h
       JOIN finops_aws_support_case_snapshots s ON s.generation_id = h.active_generation_id
         AND s.org_id = h.org_id AND s.customer_id = h.customer_id AND s.connection_id = h.connection_id
       ${LIVE_SCOPE}
       WHERE h.org_id = ? AND h.customer_id = ? AND h.connection_id = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active' LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId).first<SnapshotRow>();
    return row === null ? null : materialize(row);
  }

  public async getLatestSnapshot(scope: AwsSupportCasesPersistenceScope): Promise<StoredAwsSupportCasesSnapshot | null> {
    const database = await this.live(scope);
    const row = await database.prepare(
      `SELECT s.* FROM finops_aws_support_case_snapshots s ${LIVE_SCOPE}
       WHERE s.org_id = ? AND s.customer_id = ? AND s.connection_id = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
       ORDER BY s.observed_at DESC, s.generation_id DESC LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId).first<SnapshotRow>();
    return row === null ? null : materialize(row);
  }

  public async listHistory(scope: AwsSupportCasesPersistenceScope, limit = MAX_HISTORY): Promise<readonly StoredAwsSupportCasesSnapshot[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY) reject();
    const database = await this.live(scope);
    const rows = await database.prepare(
      `SELECT s.* FROM finops_aws_support_case_snapshots s ${LIVE_SCOPE}
       WHERE s.org_id = ? AND s.customer_id = ? AND s.connection_id = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
       ORDER BY s.observed_at DESC, s.generation_id DESC LIMIT ?`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId, limit).all<SnapshotRow>();
    return Promise.all((rows.results ?? []).map(materialize));
  }
}
