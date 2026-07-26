// Persistence for governance policies and their approval gate. Two shapes live
// here, both tenant-scoped by (org_id + customer_id) exactly like
// allocation-rules-repository:
//
//   * `governance_policies` — operator configuration: a declarative condition
//     (validated and stored as JSON, interpreted only by the pure engine in
//     lib/governance-policy-engine.ts) plus the governance action it proposes.
//     No action can mutate a customer resource; Sutra's customer role is
//     read-only, so the allowed action set is pinned by the engine.
//
//   * `governance_approvals` — an APPEND-ONLY ledger. A request is one row; each
//     decision on it is a NEW row sharing the same request_id. Nothing in this
//     module ever UPDATEs or DELETEs a ledger row, so an approval record is
//     immutable once written and every step keeps the actor who took it. Two
//     separation-of-duties rules are enforced here, following the precedent set
//     by db/recovery-administration-repository.ts (which refuses self-targeting):
//       - a requester may never decide their own request, and
//       - a decided request can never be decided again.
import {
  GOVERNANCE_ACTION_KINDS,
  isGovernanceActionKind,
  type GovernanceActionKind,
  type GovernanceCondition,
  type GovernancePolicy,
} from "../lib/governance-policy-engine.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const POLICY_ID = /^gpol_[a-f0-9]{32}$/u;
const REQUEST_ID = /^greq_[a-f0-9]{32}$/u;
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const POLICY_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._:/+-]{0,79}$/u;
const TARGET_VALUE_MAX = 256;
const REASON_MIN = 8;
const REASON_MAX = 1024;
const NOTE_MAX = 512;
const CONDITION_JSON_MAX = 8192;
const EVIDENCE_JSON_MAX = 16384;
const MAX_CONDITION_DEPTH = 8;
const MAX_CONDITION_NODES = 64;
const MAX_PRIORITY = 100_000;
const MAX_EXPIRY_DAYS = 365;
const MAX_LIST_ROWS = 500;
const MAX_POLICIES = 200;
const MAX_OPEN_REQUESTS = 500;

const ACTION_KINDS = new Set<string>(GOVERNANCE_ACTION_KINDS);

export type GovernanceApprovalDecision = "requested" | "approved" | "rejected";

const DECIDED: ReadonlySet<string> = new Set<string>(["approved", "rejected"]);

export interface GovernanceScope {
  readonly orgId: string;
  readonly customerId: string;
}

export interface GovernancePolicyInput {
  readonly name: string;
  readonly priority?: number;
  readonly condition: GovernanceCondition;
  readonly actionKind: GovernanceActionKind;
  readonly actionTarget?: string | null;
  readonly actionExpiresInDays?: number | null;
  readonly actionNote?: string | null;
  readonly requiresApproval?: boolean;
  readonly enabled?: boolean;
  readonly connectionId?: string;
}

export interface GovernancePolicyPatch {
  readonly name?: string;
  readonly priority?: number;
  readonly condition?: GovernanceCondition;
  readonly actionKind?: GovernanceActionKind;
  readonly actionTarget?: string | null;
  readonly actionExpiresInDays?: number | null;
  readonly actionNote?: string | null;
  readonly requiresApproval?: boolean;
  readonly enabled?: boolean;
}

export interface StoredGovernancePolicy extends GovernancePolicy {
  readonly connectionId: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GovernanceApprovalRecord {
  readonly id: string;
  readonly requestId: string;
  readonly policyId: string;
  readonly actionKind: string;
  readonly requestKey: string;
  readonly targetRef: string | null;
  readonly decision: GovernanceApprovalDecision;
  readonly reason: string;
  readonly actorUserId: string;
  readonly createdAt: string;
}

export interface PendingGovernanceApproval extends GovernanceApprovalRecord {
  readonly policyName: string | null;
  readonly evidence: unknown;
}

export interface RequestApprovalInput {
  readonly policyId: string;
  readonly requestKey: string;
  readonly actionKind: GovernanceActionKind;
  readonly targetRef?: string | null;
  readonly reason: string;
  readonly actorUserId: string;
  readonly evidence?: unknown;
}

export interface DecideApprovalInput {
  readonly requestId: string;
  readonly decision: "approved" | "rejected";
  readonly reason: string;
  readonly actorUserId: string;
}

interface PolicyRow {
  id: string;
  connection_id: string | null;
  name: string;
  priority: number;
  condition_json: string;
  action_kind: string;
  action_target: string | null;
  action_expires_in_days: number | null;
  action_note: string | null;
  requires_approval: number;
  enabled: number;
  created_by: string | null;
  created_at: string | number;
  updated_at: string | number;
}

interface ApprovalRow {
  id: string;
  request_id: string;
  policy_id: string;
  action_kind: string;
  request_key: string;
  target_ref: string | null;
  decision: string;
  reason: string;
  actor_user_id: string;
  evidence_json: string | null;
  created_at: string | number;
}

export class GovernancePolicyRepositoryError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "SCOPE_NOT_FOUND"
    | "LIMIT_EXCEEDED"
    | "ALREADY_DECIDED"
    | "SELF_APPROVAL_REFUSED"
    | "REQUEST_NOT_FOUND"
    | "DUPLICATE_REQUEST";

  public constructor(code: GovernancePolicyRepositoryError["code"], message?: string) {
    super(message ?? "Governance policy operation rejected");
    this.name = "GovernancePolicyRepositoryError";
    this.code = code;
  }
}

function invalid(): never {
  throw new GovernancePolicyRepositoryError("INVALID_INPUT");
}

function assertScope(scope: GovernanceScope): void {
  if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId)) invalid();
}

function assertReason(reason: string): string {
  if (typeof reason !== "string") invalid();
  const trimmed = reason.trim();
  if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) invalid();
  // Control characters would corrupt the audit trail this reason IS.
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) invalid();
  return trimmed;
}

function normalizePriority(priority: number | undefined): number {
  if (priority === undefined) return 100;
  if (!Number.isInteger(priority) || priority < 0 || priority > MAX_PRIORITY) invalid();
  return priority;
}

function assertTargetValue(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > TARGET_VALUE_MAX) invalid();
  return value;
}

function assertNote(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > NOTE_MAX) invalid();
  return value.length === 0 ? null : value;
}

function assertExpiry(value: number | null | undefined, actionKind: GovernanceActionKind): number | null {
  if (value === undefined || value === null) {
    // An accepted-risk exception without an expiry would be a permanent silent
    // suppression, so the expiry is mandatory for exactly that action.
    if (actionKind === "accept-risk-with-expiry") invalid();
    return null;
  }
  if (!Number.isInteger(value) || value < 1 || value > MAX_EXPIRY_DAYS) invalid();
  return value;
}

function assertActionKind(value: string): asserts value is GovernanceActionKind {
  if (!ACTION_KINDS.has(value)) invalid();
}

/**
 * Validate the condition tree structurally (shape, depth and node budget) so a
 * stored policy can never blow up the engine. The MEANING of each leaf is the
 * engine's business; this only guarantees a well-formed tree of known nodes.
 */
function normalizeCondition(condition: GovernanceCondition): GovernanceCondition {
  let nodes = 0;
  const walk = (node: unknown, depth: number): void => {
    nodes += 1;
    if (depth > MAX_CONDITION_DEPTH || nodes > MAX_CONDITION_NODES) invalid();
    if (typeof node !== "object" || node === null || Array.isArray(node)) invalid();
    const raw = node as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(raw, "all") || Object.prototype.hasOwnProperty.call(raw, "any")) {
      const children = Object.prototype.hasOwnProperty.call(raw, "all") ? raw.all : raw.any;
      if (!Array.isArray(children) || children.length === 0) invalid();
      for (const child of children) walk(child, depth + 1);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(raw, "not")) {
      walk(raw.not, depth + 1);
      return;
    }
    if (typeof raw.signal !== "string" || raw.signal.length === 0 || raw.signal.length > 64) invalid();
    if (raw.statuses !== undefined) {
      if (!Array.isArray(raw.statuses) || raw.statuses.some((entry) => typeof entry !== "string")) invalid();
    }
    for (const key of ["comparator", "metric", "currency", "budgetId"] as const) {
      const cell = raw[key];
      if (cell === undefined) continue;
      if (typeof cell !== "string" || cell.length === 0 || cell.length > 64) invalid();
    }
    if (raw.threshold !== undefined && (typeof raw.threshold !== "number" || !Number.isFinite(raw.threshold))) invalid();
  };
  walk(condition, 0);
  const serialized = JSON.stringify(condition);
  if (typeof serialized !== "string" || serialized.length > CONDITION_JSON_MAX) invalid();
  return JSON.parse(serialized) as GovernanceCondition;
}

function toIso(value: string | number): string {
  if (typeof value === "number") return new Date(value).toISOString();
  return /^\d+$/u.test(value) ? new Date(Number(value)).toISOString() : value;
}

function parseCondition(raw: string): GovernanceCondition {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as GovernanceCondition;
  } catch {
    // A corrupt row must not crash a list; an empty `all` never matches, and the
    // engine reports it honestly as undecided rather than as a false.
  }
  return { all: [] };
}

function toStoredPolicy(row: PolicyRow, scope: GovernanceScope): StoredGovernancePolicy {
  const actionKind = isGovernanceActionKind(row.action_kind) ? row.action_kind : "notify-destination";
  return {
    id: row.id,
    name: row.name,
    enabled: Number(row.enabled) === 1,
    priority: Number(row.priority),
    scope: {
      customerId: scope.customerId,
      connectionId: typeof row.connection_id === "string" && row.connection_id.length > 0 ? row.connection_id : null,
    },
    condition: parseCondition(row.condition_json),
    action: {
      kind: actionKind,
      target: row.action_target,
      expiresInDays: row.action_expires_in_days === null ? null : Number(row.action_expires_in_days),
      note: row.action_note,
    },
    requiresApproval: Number(row.requires_approval) === 1,
    connectionId: typeof row.connection_id === "string" && row.connection_id.length > 0 ? row.connection_id : null,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toApprovalRecord(row: ApprovalRow): GovernanceApprovalRecord {
  const decision: GovernanceApprovalDecision =
    row.decision === "approved" || row.decision === "rejected" ? row.decision : "requested";
  return {
    id: row.id,
    requestId: row.request_id,
    policyId: row.policy_id,
    actionKind: row.action_kind,
    requestKey: row.request_key,
    targetRef: row.target_ref,
    decision,
    reason: row.reason,
    actorUserId: row.actor_user_id,
    createdAt: toIso(row.created_at),
  };
}

function parseEvidence(raw: string | null): unknown {
  if (raw === null || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export class GovernancePolicyRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  /** One authoritative ownership check: the customer must be owned by the org. */
  private async assertOwnedScope(db: D1Database, scope: GovernanceScope): Promise<void> {
    const owned = await db.prepare(
      `SELECT id FROM customers WHERE id = ? AND org_id = ? AND status IN ('active', 'trial')`,
    ).bind(scope.customerId, scope.orgId).first<{ id: string }>();
    if (owned === null || owned === undefined) throw new GovernancePolicyRepositoryError("SCOPE_NOT_FOUND");
  }

  // --- policies ---

  public async list(scope: GovernanceScope): Promise<readonly StoredGovernancePolicy[]> {
    assertScope(scope);
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT id, connection_id, name, priority, condition_json, action_kind, action_target,
              action_expires_in_days, action_note, requires_approval, enabled, created_by, created_at, updated_at
         FROM governance_policies
        WHERE org_id = ? AND customer_id = ?
        ORDER BY priority ASC, created_at ASC, id ASC LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, MAX_LIST_ROWS).all<PolicyRow>();
    return (rows.results ?? []).map((row) => toStoredPolicy(row, scope));
  }

  public async get(scope: GovernanceScope, id: string): Promise<StoredGovernancePolicy | null> {
    assertScope(scope);
    if (!POLICY_ID.test(id)) invalid();
    const db = await this.ready();
    const row = await db.prepare(
      `SELECT id, connection_id, name, priority, condition_json, action_kind, action_target,
              action_expires_in_days, action_note, requires_approval, enabled, created_by, created_at, updated_at
         FROM governance_policies WHERE id = ? AND org_id = ? AND customer_id = ? LIMIT 1`,
    ).bind(id, scope.orgId, scope.customerId).first<PolicyRow>();
    return row === null ? null : toStoredPolicy(row, scope);
  }

  public async create(
    scope: GovernanceScope,
    input: GovernancePolicyInput,
    createdBy: string,
    now = Date.now(),
  ): Promise<StoredGovernancePolicy> {
    assertScope(scope);
    if (!POLICY_NAME.test(input.name)) invalid();
    if (!USER_ID.test(createdBy)) invalid();
    if (input.connectionId !== undefined && !CONNECTION_ID.test(input.connectionId)) invalid();
    assertActionKind(input.actionKind);
    const condition = normalizeCondition(input.condition);
    const priority = normalizePriority(input.priority);
    const actionTarget = assertTargetValue(input.actionTarget);
    const expiresInDays = assertExpiry(input.actionExpiresInDays, input.actionKind);
    const note = assertNote(input.actionNote);
    const db = await this.ready();
    await this.assertOwnedScope(db, scope);
    const countRow = await db.prepare(
      `SELECT COUNT(*) AS total FROM governance_policies WHERE org_id = ? AND customer_id = ?`,
    ).bind(scope.orgId, scope.customerId).first<{ total: number }>();
    if (Number(countRow?.total ?? 0) >= MAX_POLICIES) throw new GovernancePolicyRepositoryError("LIMIT_EXCEEDED");
    const id = `gpol_${crypto.randomUUID().replaceAll("-", "")}`;
    await db.prepare(
      `INSERT INTO governance_policies
         (id, org_id, customer_id, connection_id, name, priority, condition_json, action_kind, action_target,
          action_expires_in_days, action_note, requires_approval, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, scope.orgId, scope.customerId, input.connectionId ?? null, input.name, priority,
      JSON.stringify(condition), input.actionKind, actionTarget, expiresInDays, note,
      input.requiresApproval === false ? 0 : 1,
      input.enabled === false ? 0 : 1,
      createdBy, now, now,
    ).run();
    const stored = await this.get(scope, id);
    if (stored === null) throw new GovernancePolicyRepositoryError("SCOPE_NOT_FOUND");
    return stored;
  }

  public async update(
    scope: GovernanceScope,
    id: string,
    patch: GovernancePolicyPatch,
    now = Date.now(),
  ): Promise<StoredGovernancePolicy | null> {
    assertScope(scope);
    if (!POLICY_ID.test(id)) invalid();
    const existing = await this.get(scope, id);
    if (existing === null) return null;
    const name = patch.name ?? existing.name;
    if (!POLICY_NAME.test(name)) invalid();
    const priority = patch.priority === undefined ? existing.priority : normalizePriority(patch.priority);
    const condition = patch.condition === undefined ? existing.condition : normalizeCondition(patch.condition);
    const actionKind = patch.actionKind ?? existing.action.kind;
    assertActionKind(actionKind);
    const actionTarget = patch.actionTarget === undefined
      ? existing.action.target ?? null
      : assertTargetValue(patch.actionTarget);
    const expiresInDays = assertExpiry(
      patch.actionExpiresInDays === undefined ? existing.action.expiresInDays ?? null : patch.actionExpiresInDays,
      actionKind,
    );
    const note = patch.actionNote === undefined ? existing.action.note ?? null : assertNote(patch.actionNote);
    const requiresApproval = patch.requiresApproval ?? existing.requiresApproval;
    const enabled = patch.enabled ?? existing.enabled;
    const db = await this.ready();
    await db.prepare(
      `UPDATE governance_policies
          SET name = ?, priority = ?, condition_json = ?, action_kind = ?, action_target = ?,
              action_expires_in_days = ?, action_note = ?, requires_approval = ?, enabled = ?, updated_at = ?
        WHERE id = ? AND org_id = ? AND customer_id = ?`,
    ).bind(
      name, priority, JSON.stringify(condition), actionKind, actionTarget, expiresInDays, note,
      requiresApproval ? 1 : 0, enabled ? 1 : 0, now, id, scope.orgId, scope.customerId,
    ).run();
    return this.get(scope, id);
  }

  public async delete(scope: GovernanceScope, id: string): Promise<boolean> {
    assertScope(scope);
    if (!POLICY_ID.test(id)) invalid();
    const db = await this.ready();
    // Only the policy definition is removable. The approval ledger is NEVER
    // deleted: its rows are the audit trail of what a human authorized.
    const result = await db.prepare(
      `DELETE FROM governance_policies WHERE id = ? AND org_id = ? AND customer_id = ?`,
    ).bind(id, scope.orgId, scope.customerId).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }

  // --- approvals (append-only) ---

  /**
   * Record a request for approval of a matched policy's action. One OPEN request
   * per request key: a second request for the same key, while the first is still
   * undecided, is refused rather than queued twice.
   */
  public async requestApproval(
    scope: GovernanceScope,
    input: RequestApprovalInput,
    now = Date.now(),
  ): Promise<GovernanceApprovalRecord> {
    assertScope(scope);
    if (!POLICY_ID.test(input.policyId)) invalid();
    if (!USER_ID.test(input.actorUserId)) invalid();
    if (typeof input.requestKey !== "string" || input.requestKey.length === 0 || input.requestKey.length > 512) invalid();
    assertActionKind(input.actionKind);
    const reason = assertReason(input.reason);
    const targetRef = assertTargetValue(input.targetRef);
    let evidenceJson: string | null = null;
    if (input.evidence !== undefined && input.evidence !== null) {
      const serialized = JSON.stringify(input.evidence);
      if (typeof serialized !== "string" || serialized.length > EVIDENCE_JSON_MAX) invalid();
      evidenceJson = serialized;
    }
    const db = await this.ready();
    await this.assertOwnedScope(db, scope);
    const policy = await this.get(scope, input.policyId);
    if (policy === null) throw new GovernancePolicyRepositoryError("SCOPE_NOT_FOUND");
    const open = await db.prepare(
      `SELECT r.request_id
         FROM governance_approvals r
        WHERE r.org_id = ? AND r.customer_id = ? AND r.request_key = ? AND r.decision = 'requested'
          AND NOT EXISTS (
            SELECT 1 FROM governance_approvals d
             WHERE d.org_id = r.org_id AND d.customer_id = r.customer_id
               AND d.request_id = r.request_id AND d.decision IN ('approved', 'rejected')
          )
        LIMIT 1`,
    ).bind(scope.orgId, scope.customerId, input.requestKey).first<{ request_id: string }>();
    if (open !== null && open !== undefined) throw new GovernancePolicyRepositoryError("DUPLICATE_REQUEST");
    const openCount = await db.prepare(
      `SELECT COUNT(*) AS total FROM governance_approvals
        WHERE org_id = ? AND customer_id = ? AND decision = 'requested'`,
    ).bind(scope.orgId, scope.customerId).first<{ total: number }>();
    if (Number(openCount?.total ?? 0) >= MAX_OPEN_REQUESTS) throw new GovernancePolicyRepositoryError("LIMIT_EXCEEDED");
    const requestId = `greq_${crypto.randomUUID().replaceAll("-", "")}`;
    const id = `gapp_${crypto.randomUUID().replaceAll("-", "")}`;
    await db.prepare(
      `INSERT INTO governance_approvals
         (id, org_id, customer_id, request_id, policy_id, action_kind, request_key, target_ref,
          decision, reason, actor_user_id, evidence_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?)`,
    ).bind(
      id, scope.orgId, scope.customerId, requestId, input.policyId, input.actionKind, input.requestKey,
      targetRef, reason, input.actorUserId, evidenceJson, now,
    ).run();
    const record = await this.getApprovalRow(db, scope, id);
    if (record === null) throw new GovernancePolicyRepositoryError("SCOPE_NOT_FOUND");
    return record;
  }

  private async getApprovalRow(
    db: D1Database,
    scope: GovernanceScope,
    id: string,
  ): Promise<GovernanceApprovalRecord | null> {
    const row = await db.prepare(
      `SELECT id, request_id, policy_id, action_kind, request_key, target_ref, decision, reason,
              actor_user_id, evidence_json, created_at
         FROM governance_approvals WHERE id = ? AND org_id = ? AND customer_id = ? LIMIT 1`,
    ).bind(id, scope.orgId, scope.customerId).first<ApprovalRow>();
    return row === null ? null : toApprovalRecord(row);
  }

  /** Requests with no decision row yet, oldest first, with the policy name. */
  public async listPendingApprovals(scope: GovernanceScope): Promise<readonly PendingGovernanceApproval[]> {
    assertScope(scope);
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT r.id, r.request_id, r.policy_id, r.action_kind, r.request_key, r.target_ref, r.decision,
              r.reason, r.actor_user_id, r.evidence_json, r.created_at, p.name AS policy_name
         FROM governance_approvals r
         LEFT JOIN governance_policies p
                ON p.id = r.policy_id AND p.org_id = r.org_id AND p.customer_id = r.customer_id
        WHERE r.org_id = ? AND r.customer_id = ? AND r.decision = 'requested'
          AND NOT EXISTS (
            SELECT 1 FROM governance_approvals d
             WHERE d.org_id = r.org_id AND d.customer_id = r.customer_id
               AND d.request_id = r.request_id AND d.decision IN ('approved', 'rejected')
          )
        ORDER BY r.created_at ASC, r.id ASC LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, MAX_LIST_ROWS).all<ApprovalRow & { policy_name: string | null }>();
    return (rows.results ?? []).map((row) => ({
      ...toApprovalRecord(row),
      policyName: row.policy_name,
      evidence: parseEvidence(row.evidence_json),
    }));
  }

  /** The full append-only history for one request, oldest first. */
  public async listApprovalHistory(
    scope: GovernanceScope,
    requestId: string,
  ): Promise<readonly GovernanceApprovalRecord[]> {
    assertScope(scope);
    if (!REQUEST_ID.test(requestId)) invalid();
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT id, request_id, policy_id, action_kind, request_key, target_ref, decision, reason,
              actor_user_id, evidence_json, created_at
         FROM governance_approvals
        WHERE org_id = ? AND customer_id = ? AND request_id = ?
        ORDER BY created_at ASC, id ASC LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, requestId, MAX_LIST_ROWS).all<ApprovalRow>();
    return (rows.results ?? []).map(toApprovalRecord);
  }

  /** Recent ledger rows (requests and decisions), newest first. */
  public async listApprovalLedger(
    scope: GovernanceScope,
    limit = 100,
  ): Promise<readonly GovernanceApprovalRecord[]> {
    assertScope(scope);
    const bounded = Number.isInteger(limit) && limit > 0 && limit <= MAX_LIST_ROWS ? limit : 100;
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT id, request_id, policy_id, action_kind, request_key, target_ref, decision, reason,
              actor_user_id, evidence_json, created_at
         FROM governance_approvals
        WHERE org_id = ? AND customer_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, bounded).all<ApprovalRow>();
    return (rows.results ?? []).map(toApprovalRecord);
  }

  /**
   * Decide an open request by APPENDING a decision row — the request row and any
   * earlier rows are never modified, so history is immutable. Two refusals,
   * both deliberate:
   *  - SELF_APPROVAL_REFUSED: the actor who raised the request cannot decide it
   *    (the separation-of-duties precedent set by recovery administration,
   *    which likewise refuses self-targeting).
   *  - ALREADY_DECIDED: a request carrying a decision can never be re-decided.
   */
  public async decideApproval(
    scope: GovernanceScope,
    input: DecideApprovalInput,
    now = Date.now(),
  ): Promise<readonly GovernanceApprovalRecord[]> {
    assertScope(scope);
    if (!REQUEST_ID.test(input.requestId)) invalid();
    if (!USER_ID.test(input.actorUserId)) invalid();
    if (input.decision !== "approved" && input.decision !== "rejected") invalid();
    const reason = assertReason(input.reason);
    const db = await this.ready();
    const history = await this.listApprovalHistory(scope, input.requestId);
    const request = history.find((entry) => entry.decision === "requested") ?? null;
    if (request === null) throw new GovernancePolicyRepositoryError("REQUEST_NOT_FOUND");
    if (history.some((entry) => DECIDED.has(entry.decision))) {
      throw new GovernancePolicyRepositoryError(
        "ALREADY_DECIDED",
        "This approval request has already been decided and its record is immutable",
      );
    }
    if (request.actorUserId === input.actorUserId) {
      throw new GovernancePolicyRepositoryError(
        "SELF_APPROVAL_REFUSED",
        "The account that requested this action cannot decide its own request",
      );
    }
    const id = `gapp_${crypto.randomUUID().replaceAll("-", "")}`;
    await db.prepare(
      `INSERT INTO governance_approvals
         (id, org_id, customer_id, request_id, policy_id, action_kind, request_key, target_ref,
          decision, reason, actor_user_id, evidence_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).bind(
      id, scope.orgId, scope.customerId, input.requestId, request.policyId, request.actionKind,
      request.requestKey, request.targetRef, input.decision, reason, input.actorUserId, now,
    ).run();
    return this.listApprovalHistory(scope, input.requestId);
  }
}

/**
 * Translate a repository error into the shape `errorResponse` can surface
 * publicly (a safe code + an HTTP status). Anything else is returned unchanged
 * so it keeps falling through to the generic 500 path.
 */
export function governancePublicError(error: unknown): unknown {
  if (!(error instanceof GovernancePolicyRepositoryError)) return error;
  switch (error.code) {
    case "SCOPE_NOT_FOUND":
      return Object.assign(new Error("The governance scope was not found"), { code: "NOT_FOUND", status: 404 });
    case "REQUEST_NOT_FOUND":
      return Object.assign(new Error("The approval request was not found"), { code: "NOT_FOUND", status: 404 });
    case "LIMIT_EXCEEDED":
      return Object.assign(new Error("This tenant has reached its governance limit"), { code: "INVALID_STATE", status: 409 });
    case "ALREADY_DECIDED":
      return Object.assign(new Error(error.message), { code: "CONFLICT", status: 409 });
    case "DUPLICATE_REQUEST":
      return Object.assign(new Error("An approval request for this action is already open"), { code: "CONFLICT", status: 409 });
    case "SELF_APPROVAL_REFUSED":
      return Object.assign(new Error(error.message), { code: "AUTHORIZATION_DENIED", status: 403 });
    default:
      return Object.assign(new Error("The governance request is invalid"), { code: "INVALID_INPUT", status: 400 });
  }
}
