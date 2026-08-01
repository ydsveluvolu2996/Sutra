/**
 * Immutable provider AWS Budgets persistence.
 *
 * This repository is deliberately unrelated to finops_budgets and
 * FinopsWorkspaceRepository: those hold Sutra-authored budget guardrails.
 */
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import {
  buildAwsBudgetsOrganizationDashboard,
  normalizeAwsBudgetsCapture,
  type AwsBudgetsCapture,
  type AwsBudgetsScope,
  type AwsBudgetsSnapshot,
  type AwsOrganizationHierarchyEvidence,
} from "../lib/finops-aws-budgets-organization.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const GENERATION_ID = /^abg_[a-f0-9]{64}$/u;
const CAPTURE_ID = /^awsbudgets_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_PAYLOAD_BYTES = 16 * 1_024 * 1_024;
const MAX_HISTORY = 36;

export interface StoredAwsBudgetsGeneration {
  readonly scope: AwsBudgetsScope;
  readonly generationId: string;
  readonly contentSha256: string;
  readonly snapshot: AwsBudgetsSnapshot;
  readonly hierarchy: AwsOrganizationHierarchyEvidence | null;
  readonly createdAtIso: string;
  readonly committedAtIso: string | null;
}

export interface AwsBudgetsGenerationHistoryItem {
  readonly generationId: string;
  readonly sourceCaptureId: string;
  readonly state: AwsBudgetsSnapshot["collectionState"];
  readonly hierarchyState: AwsOrganizationHierarchyEvidence["state"] | null;
  readonly observedAtIso: string;
  readonly dataThroughAtIso: string | null;
  readonly budgetCount: number;
  readonly currencies: readonly string[];
  readonly budgetLevels: readonly string[];
  readonly contentSha256: string;
}

export class AwsBudgetsRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "IMMUTABLE_CONFLICT" | "STORED_STATE_INVALID";

  public constructor(code: AwsBudgetsRepositoryError["code"]) {
    super("AWS Budgets provider persistence operation rejected");
    this.name = "AwsBudgetsRepositoryError";
    this.code = code;
  }
}

interface GenerationRow {
  generation_id: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  account_id: string;
  partition: AwsBudgetsScope["partition"];
  source_capture_id: string;
  state: AwsBudgetsSnapshot["collectionState"];
  hierarchy_state: AwsOrganizationHierarchyEvidence["state"] | null;
  observed_at: string;
  data_through_at: string | null;
  content_sha256: string;
  payload_json: string;
  budget_count: number | string;
  created_at: number | string;
  advanced_at?: number | string | null;
}

function reject(code: AwsBudgetsRepositoryError["code"] = "INVALID_INPUT"): never {
  throw new AwsBudgetsRepositoryError(code);
}

function assertScope(scope: AwsBudgetsScope): void {
  if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId)
    || !CONNECTION_ID.test(scope.connectionId) || !ACCOUNT_ID.test(scope.accountId)
    || !["aws", "aws-us-gov", "aws-cn"].includes(scope.partition)) reject();
}

function integer(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) {
    reject("STORED_STATE_INVALID");
  }
  return parsed;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function sameScope(left: AwsBudgetsScope, right: AwsBudgetsScope): boolean {
  return left.orgId === right.orgId && left.customerId === right.customerId
    && left.connectionId === right.connectionId && left.accountId === right.accountId
    && left.partition === right.partition;
}

async function materialize(row: GenerationRow): Promise<StoredAwsBudgetsGeneration> {
  if (!GENERATION_ID.test(row.generation_id) || !CAPTURE_ID.test(row.source_capture_id)
    || !SHA256.test(row.content_sha256)
    || new TextEncoder().encode(row.payload_json).byteLength > MAX_PAYLOAD_BYTES) {
    reject("STORED_STATE_INVALID");
  }
  let payload: { snapshot?: AwsBudgetsSnapshot; hierarchy?: AwsOrganizationHierarchyEvidence | null };
  try { payload = JSON.parse(row.payload_json) as typeof payload; } catch { reject("STORED_STATE_INVALID"); }
  if (payload.snapshot === undefined || payload.hierarchy === undefined) reject("STORED_STATE_INVALID");
  const scope: AwsBudgetsScope = {
    orgId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id,
    accountId: row.account_id, partition: row.partition,
  };
  assertScope(scope);
  const snapshot = payload.snapshot;
  const hierarchy = payload.hierarchy;
  if (!sameScope(snapshot.scope, scope) || snapshot.captureId !== row.source_capture_id
    || snapshot.collectionState !== row.state || snapshot.observedAtIso !== row.observed_at
    || snapshot.dataThroughAt !== row.data_through_at || snapshot.budgets.length !== integer(row.budget_count)
    || (hierarchy?.state ?? null) !== row.hierarchy_state
    || (hierarchy !== null && (hierarchy.scope.orgId !== scope.orgId
      || hierarchy.scope.customerId !== scope.customerId
      || hierarchy.scope.connectionId !== scope.connectionId))) reject("STORED_STATE_INVALID");
  // Re-run the dependency boundary before returning stored evidence.
  buildAwsBudgetsOrganizationDashboard({ snapshot, hierarchy, taxonomy: null, nowEpochMs: Date.parse(snapshot.observedAtIso) });
  if (await sha256(row.payload_json) !== row.content_sha256
    || row.generation_id !== `abg_${row.content_sha256}`) reject("STORED_STATE_INVALID");
  const createdAt = integer(row.created_at);
  const advancedAt = row.advanced_at === undefined || row.advanced_at === null ? null : integer(row.advanced_at);
  return {
    scope, generationId: row.generation_id, contentSha256: row.content_sha256,
    snapshot, hierarchy, createdAtIso: new Date(createdAt).toISOString(),
    committedAtIso: advancedAt === null ? null : new Date(advancedAt).toISOString(),
  };
}

function historyItem(stored: StoredAwsBudgetsGeneration): AwsBudgetsGenerationHistoryItem {
  const snapshot = stored.snapshot;
  return {
    generationId: stored.generationId,
    sourceCaptureId: snapshot.captureId,
    state: snapshot.collectionState,
    hierarchyState: stored.hierarchy?.state ?? null,
    observedAtIso: snapshot.observedAtIso,
    dataThroughAtIso: snapshot.dataThroughAt,
    budgetCount: snapshot.budgets.length,
    currencies: [...new Set(snapshot.budgets.flatMap((budget) => [
      budget.budgetLimit?.currency, budget.actual?.currency, budget.forecast?.currency,
    ].filter((value): value is string => value !== null && value !== undefined)))].sort(),
    budgetLevels: [...new Set(snapshot.budgets.map((budget) => budget.hierarchyLevel)
      .filter((value): value is string => value !== null))].sort(),
    contentSha256: stored.contentSha256,
  };
}

const LIVE_SCOPE = `
  JOIN aws_connections c ON c.id = s.connection_id AND c.org_id = s.org_id
    AND c.customer_id = s.customer_id AND c.aws_account_id = s.account_id
    AND c.partition = s.partition
  JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
  JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id AND cu.status = 'active'`;

export class AwsBudgetsOrganizationRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async live(scope: AwsBudgetsScope): Promise<D1Database> {
    assertScope(scope);
    await ensureRuntimeSchema(this.database);
    const row = await this.database.prepare(
      `SELECT c.id FROM aws_connections c
       JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
       JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id AND cu.status = 'active'
       WHERE c.org_id = ? AND c.customer_id = ? AND c.id = ?
         AND c.aws_account_id = ? AND c.partition = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active' LIMIT 1`,
    ).bind(scope.orgId, scope.customerId, scope.connectionId, scope.accountId, scope.partition)
      .first<{ id: string }>();
    if (row === null) reject("SCOPE_NOT_FOUND");
    return this.database;
  }

  private async byGeneration(database: D1Database, scope: AwsBudgetsScope, generationId: string) {
    const row = await database.prepare(
      `SELECT s.* FROM finops_aws_budget_snapshots s ${LIVE_SCOPE}
       WHERE s.org_id = ? AND s.customer_id = ? AND s.connection_id = ?
         AND s.account_id = ? AND s.partition = ? AND s.generation_id = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active' LIMIT 1`,
    ).bind(scope.orgId, scope.customerId, scope.connectionId, scope.accountId, scope.partition, generationId)
      .first<GenerationRow>();
    return row === null ? null : materialize(row);
  }

  public async recordCapture(
    scope: AwsBudgetsScope,
    capture: AwsBudgetsCapture,
    hierarchy: AwsOrganizationHierarchyEvidence | null,
    nowMs = Date.now(),
  ): Promise<{ readonly generation: StoredAwsBudgetsGeneration; readonly becameActive: boolean }> {
    assertScope(scope);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) reject();
    const completedAt = Date.parse(capture.completedAtIso);
    if (!Number.isFinite(completedAt) || completedAt > nowMs + 300_000) reject();
    const snapshot = normalizeAwsBudgetsCapture(capture, scope, completedAt);
    // Validates exact hierarchy scope and bounds without requiring taxonomy.
    buildAwsBudgetsOrganizationDashboard({ snapshot, hierarchy, taxonomy: null, nowEpochMs: completedAt });
    const persistableState = snapshot.collectionState === "ready" && hierarchy?.state !== "complete"
      ? "partial" as const : snapshot.collectionState;
    const persistedSnapshot = persistableState === snapshot.collectionState
      ? snapshot : { ...snapshot, collectionState: persistableState };
    const payloadJson = JSON.stringify({ snapshot: persistedSnapshot, hierarchy });
    if (new TextEncoder().encode(payloadJson).byteLength > MAX_PAYLOAD_BYTES) reject();
    const contentSha256 = await sha256(payloadJson);
    const generationId = `abg_${contentSha256}`;
    const database = await this.live(scope);
    const previous = await this.getActiveGeneration(scope);
    await database.prepare(
      `INSERT INTO finops_aws_budget_snapshots (
        generation_id, org_id, customer_id, connection_id, account_id, partition,
        source_capture_id, state, hierarchy_state, observed_at, data_through_at,
        content_sha256, payload_json, budget_count, created_at
      ) SELECT ?, c.org_id, c.customer_id, c.id, c.aws_account_id, c.partition,
          ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM aws_connections c
        JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
        JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id AND cu.status = 'active'
       WHERE c.org_id = ? AND c.customer_id = ? AND c.id = ?
         AND c.aws_account_id = ? AND c.partition = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
       ON CONFLICT DO NOTHING`,
    ).bind(
      generationId, persistedSnapshot.captureId, persistedSnapshot.collectionState,
      hierarchy?.state ?? null, persistedSnapshot.observedAtIso, persistedSnapshot.dataThroughAt,
      contentSha256, payloadJson, persistedSnapshot.budgets.length, nowMs,
      scope.orgId, scope.customerId, scope.connectionId, scope.accountId, scope.partition,
    ).run();
    const stored = await this.byGeneration(database, scope, generationId);
    if (stored === null || stored.contentSha256 !== contentSha256) reject("IMMUTABLE_CONFLICT");
    if (persistedSnapshot.collectionState === "ready" && hierarchy?.state === "complete") {
      await database.prepare(
        `INSERT INTO finops_aws_budget_snapshot_heads
          (org_id, customer_id, connection_id, active_generation_id, advanced_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(org_id, customer_id, connection_id) DO UPDATE SET
          active_generation_id = excluded.active_generation_id, advanced_at = excluded.advanced_at
         WHERE excluded.active_generation_id <> finops_aws_budget_snapshot_heads.active_generation_id
           AND EXISTS (
             SELECT 1 FROM finops_aws_budget_snapshots candidate
             JOIN finops_aws_budget_snapshots active
               ON active.generation_id = finops_aws_budget_snapshot_heads.active_generation_id
            WHERE candidate.generation_id = excluded.active_generation_id
              AND candidate.org_id = finops_aws_budget_snapshot_heads.org_id
              AND candidate.customer_id = finops_aws_budget_snapshot_heads.customer_id
              AND candidate.connection_id = finops_aws_budget_snapshot_heads.connection_id
              AND (candidate.observed_at > active.observed_at
                OR (candidate.observed_at = active.observed_at
                  AND candidate.generation_id > active.generation_id))
           )`,
      ).bind(scope.orgId, scope.customerId, scope.connectionId, generationId, nowMs).run();
    }
    const active = await this.getActiveGeneration(scope);
    return { generation: stored, becameActive: active?.generationId === generationId
      && previous?.generationId !== generationId };
  }

  public async getActiveGeneration(scope: AwsBudgetsScope): Promise<StoredAwsBudgetsGeneration | null> {
    const database = await this.live(scope);
    const row = await database.prepare(
      `SELECT s.*, h.advanced_at FROM finops_aws_budget_snapshot_heads h
       JOIN finops_aws_budget_snapshots s ON s.generation_id = h.active_generation_id
        AND s.org_id = h.org_id AND s.customer_id = h.customer_id AND s.connection_id = h.connection_id
       ${LIVE_SCOPE}
       WHERE h.org_id = ? AND h.customer_id = ? AND h.connection_id = ?
         AND s.account_id = ? AND s.partition = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active' LIMIT 1`,
    ).bind(scope.orgId, scope.customerId, scope.connectionId, scope.accountId, scope.partition)
      .first<GenerationRow>();
    return row === null ? null : materialize(row);
  }

  public async getLatestGeneration(scope: AwsBudgetsScope): Promise<StoredAwsBudgetsGeneration | null> {
    const database = await this.live(scope);
    const row = await database.prepare(
      `SELECT s.* FROM finops_aws_budget_snapshots s ${LIVE_SCOPE}
       WHERE s.org_id = ? AND s.customer_id = ? AND s.connection_id = ?
         AND s.account_id = ? AND s.partition = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
       ORDER BY s.observed_at DESC, s.generation_id DESC LIMIT 1`,
    ).bind(scope.orgId, scope.customerId, scope.connectionId, scope.accountId, scope.partition)
      .first<GenerationRow>();
    return row === null ? null : materialize(row);
  }

  public async listHistory(scope: AwsBudgetsScope, limit = MAX_HISTORY): Promise<readonly AwsBudgetsGenerationHistoryItem[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY) reject();
    const database = await this.live(scope);
    const rows = await database.prepare(
      `SELECT s.* FROM finops_aws_budget_snapshots s ${LIVE_SCOPE}
       WHERE s.org_id = ? AND s.customer_id = ? AND s.connection_id = ?
         AND s.account_id = ? AND s.partition = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
       ORDER BY s.observed_at DESC, s.generation_id DESC LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, scope.connectionId, scope.accountId, scope.partition, limit)
      .all<GenerationRow>();
    const generations = await Promise.all((rows.results ?? []).map(materialize));
    return generations.map(historyItem);
  }
}
