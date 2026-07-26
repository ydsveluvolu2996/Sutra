// Persistence for FinOps allocation rules ("virtual tags"). Each row is a
// tenant-scoped (org_id + customer_id) rule that assigns matching billing lines
// to a customer / product / cost-center. Rules are operator configuration —
// validated before storage, bounded per tenant, and never trusting a
// caller-supplied org (the route passes the authorized scope). Dual D1/Postgres
// access mirrors finops-workspace-repository.
import type { AllocationMatch, AllocationRule, AllocationTargetKind } from "../lib/finops-allocation-rules.ts";
import { ALLOCATION_TARGET_KINDS } from "../lib/finops-allocation-rules.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const RULE_ID = /^ar_[a-f0-9]{32}$/u;
const RULE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._:/+-]{0,79}$/u;
const MATCH_ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/u;
const MATCH_TEXT_MAX = 256;
const TARGET_VALUE_MAX = 128;
const MAX_PRIORITY = 100_000;
const MAX_LIST_ROWS = 500;
const MAX_RULES = 500;

const TARGET_KINDS = new Set<string>(ALLOCATION_TARGET_KINDS);

export interface AllocationRuleScope {
  readonly orgId: string;
  readonly customerId: string;
}

export interface AllocationRuleInput {
  readonly name: string;
  readonly priority?: number;
  readonly match: AllocationMatch;
  readonly targetKind: AllocationTargetKind;
  readonly targetValue: string;
  readonly enabled?: boolean;
  readonly connectionId?: string;
}

export interface AllocationRulePatch {
  readonly name?: string;
  readonly priority?: number;
  readonly match?: AllocationMatch;
  readonly targetKind?: AllocationTargetKind;
  readonly targetValue?: string;
  readonly enabled?: boolean;
}

export interface StoredAllocationRule extends AllocationRule {
  readonly connectionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RuleRow {
  id: string;
  connection_id: string | null;
  name: string;
  priority: number;
  match_json: string;
  target_kind: string;
  target_value: string;
  enabled: number;
  created_at: string | number;
  updated_at: string | number;
}

export class AllocationRuleRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "LIMIT_EXCEEDED";

  public constructor(code: AllocationRuleRepositoryError["code"]) {
    super("Allocation-rule operation rejected");
    this.name = "AllocationRuleRepositoryError";
    this.code = code;
  }
}

function invalid(): never {
  throw new AllocationRuleRepositoryError("INVALID_INPUT");
}

function assertScope(scope: AllocationRuleScope): void {
  if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId)) invalid();
}

/** Validate + normalize the match pattern. At least one criterion is required. */
function normalizeMatch(match: AllocationMatch): AllocationMatch {
  if (typeof match !== "object" || match === null) invalid();
  const normalized: { account?: string; service?: string; tagKey?: string; tagValue?: string } = {};
  if (match.account !== undefined) {
    if (typeof match.account !== "string" || !MATCH_ACCOUNT.test(match.account)) invalid();
    normalized.account = match.account;
  }
  if (match.service !== undefined) {
    if (typeof match.service !== "string" || match.service.length === 0 || match.service.length > MATCH_TEXT_MAX) invalid();
    normalized.service = match.service;
  }
  if (match.tagKey !== undefined) {
    if (typeof match.tagKey !== "string" || match.tagKey.length === 0 || match.tagKey.length > MATCH_TEXT_MAX) invalid();
    normalized.tagKey = match.tagKey;
  }
  if (match.tagValue !== undefined) {
    if (typeof match.tagValue !== "string" || match.tagValue.length === 0 || match.tagValue.length > MATCH_TEXT_MAX) invalid();
    // tagValue is only meaningful alongside a tagKey.
    if (normalized.tagKey === undefined) invalid();
    normalized.tagValue = match.tagValue;
  }
  if (Object.keys(normalized).length === 0) invalid();
  return normalized;
}

function normalizePriority(priority: number | undefined): number {
  if (priority === undefined) return 100;
  if (!Number.isInteger(priority) || priority < 0 || priority > MAX_PRIORITY) invalid();
  return priority;
}

function assertTargetKind(value: string): asserts value is AllocationTargetKind {
  if (!TARGET_KINDS.has(value)) invalid();
}

function assertTargetValue(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > TARGET_VALUE_MAX) invalid();
}

function toIso(value: string | number): string {
  if (typeof value === "number") return new Date(value).toISOString();
  // Postgres bigint arrives as a string; a plain integer string is epoch millis.
  return /^\d+$/u.test(value) ? new Date(Number(value)).toISOString() : value;
}

function toStored(row: RuleRow): StoredAllocationRule {
  let match: AllocationMatch = {};
  try {
    const parsed: unknown = JSON.parse(row.match_json);
    if (typeof parsed === "object" && parsed !== null) match = parsed as AllocationMatch;
  } catch {
    match = {};
  }
  return {
    id: row.id,
    connectionId: typeof row.connection_id === "string" && row.connection_id.length > 0 ? row.connection_id : null,
    name: row.name,
    priority: Number(row.priority),
    match,
    targetKind: row.target_kind as AllocationTargetKind,
    targetValue: row.target_value,
    enabled: Number(row.enabled) === 1,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export class AllocationRuleRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  public async list(scope: AllocationRuleScope): Promise<readonly StoredAllocationRule[]> {
    assertScope(scope);
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT id, connection_id, name, priority, match_json, target_kind, target_value, enabled, created_at, updated_at
         FROM allocation_rules
        WHERE org_id = ? AND customer_id = ?
        ORDER BY priority ASC, created_at ASC, id ASC LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, MAX_LIST_ROWS).all<RuleRow>();
    return (rows.results ?? []).map(toStored);
  }

  public async create(scope: AllocationRuleScope, input: AllocationRuleInput, now = Date.now()): Promise<StoredAllocationRule> {
    assertScope(scope);
    if (!RULE_NAME.test(input.name)) invalid();
    if (input.connectionId !== undefined && !CONNECTION_ID.test(input.connectionId)) invalid();
    const match = normalizeMatch(input.match);
    const priority = normalizePriority(input.priority);
    assertTargetKind(input.targetKind);
    assertTargetValue(input.targetValue);
    const db = await this.ready();
    // Gate writes to an owned, active customer up front (one authoritative check).
    const owned = await db.prepare(
      `SELECT id FROM customers WHERE id = ? AND org_id = ? AND status IN ('active', 'trial')`,
    ).bind(scope.customerId, scope.orgId).first<{ id: string }>();
    if (owned === null || owned === undefined) throw new AllocationRuleRepositoryError("SCOPE_NOT_FOUND");
    const countRow = await db.prepare(
      `SELECT COUNT(*) AS total FROM allocation_rules WHERE org_id = ? AND customer_id = ?`,
    ).bind(scope.orgId, scope.customerId).first<{ total: number }>();
    if (Number(countRow?.total ?? 0) >= MAX_RULES) throw new AllocationRuleRepositoryError("LIMIT_EXCEEDED");
    const id = `ar_${crypto.randomUUID().replaceAll("-", "")}`;
    await db.prepare(
      `INSERT INTO allocation_rules
         (id, org_id, customer_id, connection_id, name, priority, match_json, target_kind, target_value, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, scope.orgId, scope.customerId, input.connectionId ?? null, input.name, priority,
      JSON.stringify(match), input.targetKind, input.targetValue,
      input.enabled === false ? 0 : 1, now, now,
    ).run();
    const stored = await this.get(scope, id);
    if (stored === null) throw new AllocationRuleRepositoryError("SCOPE_NOT_FOUND");
    return stored;
  }

  public async get(scope: AllocationRuleScope, id: string): Promise<StoredAllocationRule | null> {
    assertScope(scope);
    if (!RULE_ID.test(id)) invalid();
    const db = await this.ready();
    const row = await db.prepare(
      `SELECT id, connection_id, name, priority, match_json, target_kind, target_value, enabled, created_at, updated_at
         FROM allocation_rules WHERE id = ? AND org_id = ? AND customer_id = ? LIMIT 1`,
    ).bind(id, scope.orgId, scope.customerId).first<RuleRow>();
    return row === null ? null : toStored(row);
  }

  public async update(scope: AllocationRuleScope, id: string, patch: AllocationRulePatch, now = Date.now()): Promise<StoredAllocationRule | null> {
    assertScope(scope);
    if (!RULE_ID.test(id)) invalid();
    const existing = await this.get(scope, id);
    if (existing === null) return null;
    const name = patch.name ?? existing.name;
    if (!RULE_NAME.test(name)) invalid();
    const priority = patch.priority === undefined ? existing.priority : normalizePriority(patch.priority);
    const match = patch.match === undefined ? existing.match : normalizeMatch(patch.match);
    const targetKind = patch.targetKind ?? existing.targetKind;
    assertTargetKind(targetKind);
    const targetValue = patch.targetValue ?? existing.targetValue;
    assertTargetValue(targetValue);
    const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled;
    const db = await this.ready();
    await db.prepare(
      `UPDATE allocation_rules
          SET name = ?, priority = ?, match_json = ?, target_kind = ?, target_value = ?, enabled = ?, updated_at = ?
        WHERE id = ? AND org_id = ? AND customer_id = ?`,
    ).bind(
      name, priority, JSON.stringify(match), targetKind, targetValue, enabled ? 1 : 0, now,
      id, scope.orgId, scope.customerId,
    ).run();
    return this.get(scope, id);
  }

  public async delete(scope: AllocationRuleScope, id: string): Promise<boolean> {
    assertScope(scope);
    if (!RULE_ID.test(id)) invalid();
    const db = await this.ready();
    const result = await db.prepare(
      `DELETE FROM allocation_rules WHERE id = ? AND org_id = ? AND customer_id = ?`,
    ).bind(id, scope.orgId, scope.customerId).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }
}
