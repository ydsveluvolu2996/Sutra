/** Immutable persistence for normalized AWS Config compliance generations. */
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import type {
  AwsConfigComplianceSnapshot,
  AwsConfigComplianceState,
} from "../lib/finops-aws-config-compliance.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const SNAPSHOT_ID = /^acc_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMPLETE_STATES = new Set<AwsConfigComplianceState>(["READY", "EMPTY"]);
const MAX_HISTORY = 36;

export interface AwsConfigComplianceRepositoryScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface StoredAwsConfigComplianceSnapshot {
  readonly scope: AwsConfigComplianceRepositoryScope;
  readonly snapshotId: string;
  readonly contentSha256: string;
  readonly state: AwsConfigComplianceState;
  readonly capturedAt: string;
  readonly createdAtIso: string;
  readonly snapshot: AwsConfigComplianceSnapshot;
}

interface SnapshotRow {
  snapshot_id: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  state: AwsConfigComplianceState;
  captured_at: string;
  content_sha256: string;
  payload_json: string;
  created_at: number | string;
}

export class AwsConfigComplianceRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "IMMUTABLE_CONFLICT" | "STORED_STATE_INVALID";
  public constructor(code: AwsConfigComplianceRepositoryError["code"]) {
    super("AWS Config compliance persistence operation rejected");
    this.name = "AwsConfigComplianceRepositoryError";
    this.code = code;
  }
}

function reject(code: AwsConfigComplianceRepositoryError["code"] = "INVALID_INPUT"): never {
  throw new AwsConfigComplianceRepositoryError(code);
}

function assertScope(scope: AwsConfigComplianceRepositoryScope): void {
  if (!IDENTIFIER.test(scope.organizationId) || !IDENTIFIER.test(scope.customerId)
    || !CONNECTION_ID.test(scope.connectionId)) reject();
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function epoch(value: number | string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0) reject("STORED_STATE_INVALID");
  return parsed;
}

function assertSnapshotScope(
  scope: AwsConfigComplianceRepositoryScope,
  snapshot: AwsConfigComplianceSnapshot,
): void {
  if (snapshot.schemaVersion !== "sutra.aws-config-compliance.snapshot.v1"
    || snapshot.scope.orgId !== scope.organizationId
    || snapshot.scope.customerId !== scope.customerId
    || snapshot.scope.connectionId !== scope.connectionId
    || !Number.isFinite(Date.parse(snapshot.capturedAt))) reject();
}

async function storedSnapshot(row: SnapshotRow): Promise<StoredAwsConfigComplianceSnapshot> {
  if (!SNAPSHOT_ID.test(row.snapshot_id) || !SHA256.test(row.content_sha256)) reject("STORED_STATE_INVALID");
  let value: unknown;
  try { value = JSON.parse(row.payload_json); } catch { reject("STORED_STATE_INVALID"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject("STORED_STATE_INVALID");
  const snapshot = value as AwsConfigComplianceSnapshot;
  const scope = { organizationId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id };
  assertScope(scope);
  try { assertSnapshotScope(scope, snapshot); } catch { reject("STORED_STATE_INVALID"); }
  const digest = await sha256(row.payload_json);
  if (digest !== row.content_sha256 || row.snapshot_id !== `acc_${digest}`
    || snapshot.state !== row.state || snapshot.capturedAt !== row.captured_at) reject("STORED_STATE_INVALID");
  return {
    scope,
    snapshotId: row.snapshot_id,
    contentSha256: row.content_sha256,
    state: row.state,
    capturedAt: row.captured_at,
    createdAtIso: new Date(epoch(row.created_at)).toISOString(),
    snapshot,
  };
}

export class AwsConfigComplianceRepository {
  public async recordSnapshot(
    scope: AwsConfigComplianceRepositoryScope,
    snapshot: AwsConfigComplianceSnapshot,
    nowMs = Date.now(),
  ): Promise<StoredAwsConfigComplianceSnapshot> {
    assertScope(scope);
    assertSnapshotScope(scope, snapshot);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) reject();
    const payload = JSON.stringify(snapshot);
    if (new TextEncoder().encode(payload).byteLength > 16 * 1_024 * 1_024) reject();
    const contentSha256 = await sha256(payload);
    const snapshotId = `acc_${contentSha256}`;
    const db = getRawDb();
    await ensureRuntimeSchema(db);
    await db.prepare(`INSERT INTO finops_config_compliance_snapshots (
      snapshot_id, org_id, customer_id, connection_id, capture_id, state, captured_at,
      content_sha256, payload_json, rule_count, evaluation_count, resource_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(snapshot_id) DO NOTHING`).bind(
      snapshotId, scope.organizationId, scope.customerId, scope.connectionId,
      snapshot.captureId, snapshot.state, snapshot.capturedAt, contentSha256, payload,
      snapshot.rules.length, snapshot.evaluations.length, snapshot.resourceInventory.length, nowMs,
    ).run();
    const row = await db.prepare(`SELECT snapshot_id, org_id, customer_id, connection_id, state,
      captured_at, content_sha256, payload_json, created_at
      FROM finops_config_compliance_snapshots WHERE snapshot_id = ?`).bind(snapshotId).first<SnapshotRow>();
    if (row === null) reject("STORED_STATE_INVALID");
    const stored = await storedSnapshot(row);
    if (stored.scope.organizationId !== scope.organizationId || stored.scope.customerId !== scope.customerId
      || stored.scope.connectionId !== scope.connectionId || stored.contentSha256 !== contentSha256) {
      reject("IMMUTABLE_CONFLICT");
    }
    if (COMPLETE_STATES.has(snapshot.state)) {
      await db.prepare(`INSERT INTO finops_config_compliance_heads (
        org_id, customer_id, connection_id, active_snapshot_id, advanced_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(org_id, customer_id, connection_id) DO UPDATE SET
        active_snapshot_id = excluded.active_snapshot_id, advanced_at = excluded.advanced_at
      WHERE EXISTS (
        SELECT 1 FROM finops_config_compliance_snapshots candidate
        JOIN finops_config_compliance_snapshots current
          ON current.snapshot_id = finops_config_compliance_heads.active_snapshot_id
        WHERE candidate.snapshot_id = excluded.active_snapshot_id
          AND (candidate.captured_at > current.captured_at
            OR (candidate.captured_at = current.captured_at AND candidate.snapshot_id > current.snapshot_id))
      )`).bind(scope.organizationId, scope.customerId, scope.connectionId, snapshotId, nowMs).run();
    }
    return stored;
  }

  public async getActiveSnapshot(
    scope: AwsConfigComplianceRepositoryScope,
  ): Promise<StoredAwsConfigComplianceSnapshot | null> {
    assertScope(scope);
    const db = getRawDb();
    await ensureRuntimeSchema(db);
    const row = await db.prepare(`SELECT s.snapshot_id, s.org_id, s.customer_id,
      s.connection_id, s.state, s.captured_at, s.content_sha256, s.payload_json, s.created_at
      FROM finops_config_compliance_heads h
      JOIN finops_config_compliance_snapshots s ON s.snapshot_id = h.active_snapshot_id
        AND s.org_id = h.org_id AND s.customer_id = h.customer_id AND s.connection_id = h.connection_id
      WHERE h.org_id = ? AND h.customer_id = ? AND h.connection_id = ?`)
      .bind(scope.organizationId, scope.customerId, scope.connectionId).first<SnapshotRow>();
    return row === null ? null : storedSnapshot(row);
  }

  public async getHistory(
    scope: AwsConfigComplianceRepositoryScope,
  ): Promise<readonly StoredAwsConfigComplianceSnapshot[]> {
    assertScope(scope);
    const db = getRawDb();
    await ensureRuntimeSchema(db);
    const result = await db.prepare(`SELECT snapshot_id, org_id, customer_id,
      connection_id, state, captured_at, content_sha256, payload_json, created_at
      FROM finops_config_compliance_snapshots
      WHERE org_id = ? AND customer_id = ? AND connection_id = ?
      ORDER BY captured_at DESC, snapshot_id DESC LIMIT ?`)
      .bind(scope.organizationId, scope.customerId, scope.connectionId, MAX_HISTORY).all<SnapshotRow>();
    return Promise.all((result.results ?? []).map(storedSnapshot));
  }
}
