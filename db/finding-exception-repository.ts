// Repository for tenant-scoped finding-exception rules (accepted-risk records
// that suppress posture findings from the active view). A rule is scoped to at
// least one of { ruleId, resourceRef } — the finding's control key and/or the
// resource it targets — and carries a justification + approver so the honesty
// layer treats it as an accepted-risk record, never as evidence the finding was
// fixed. A rule with no scope field would blanket-suppress every finding, so it
// is refused outright. Storage keeps absolute millisecond timestamps; the
// control plane converts them to the engine's day-based exception shape when it
// applies exceptions to a connection's findings. Every write is enforced against
// the customers table so a rule can only ever be created for a customer that
// belongs to the acting organization.
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
// A rule id is a compliance control key (e.g. aws.s3.block-public-access).
const RULE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9.:_/-]{0,127}$/u;
// A resource ref is a resource key (e.g. aws:s3:bucket:acme-logs).
const RESOURCE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9.:_/@-]{0,255}$/u;
const MAX_JUSTIFICATION = 2000;
const MAX_APPROVER = 256;

export interface FindingExceptionTenantScope {
  readonly orgId: string;
  readonly customerId: string;
}

export interface FindingExceptionInput {
  readonly ruleId?: string | null;
  readonly resourceRef?: string | null;
  readonly justification: string;
  readonly approvedBy: string;
  readonly expiresAtMs?: number | null;
}

export interface StoredFindingException {
  readonly id: string;
  readonly ruleId: string | null;
  readonly resourceRef: string | null;
  readonly justification: string;
  readonly approvedBy: string;
  readonly status: "active" | "revoked";
  readonly createdAtMs: number;
  readonly expiresAtMs: number | null;
}

interface ExceptionRow {
  id: string;
  scope_rule_id: string | null;
  scope_resource_ref: string | null;
  justification: string;
  approved_by: string;
  status: string;
  created_at: number;
  expires_at: number | null;
}

export class FindingExceptionRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND";

  public constructor(code: FindingExceptionRepositoryError["code"]) {
    super("Finding exception operation rejected");
    this.name = "FindingExceptionRepositoryError";
    this.code = code;
  }
}

function assertScope(scope: FindingExceptionTenantScope): void {
  if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId)) {
    throw new FindingExceptionRepositoryError("INVALID_INPUT");
  }
}

function optionalScopeField(value: string | null | undefined, pattern: RegExp): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!pattern.test(trimmed)) throw new FindingExceptionRepositoryError("INVALID_INPUT");
  return trimmed;
}

function mapRow(row: ExceptionRow): StoredFindingException {
  return {
    id: row.id,
    ruleId: row.scope_rule_id,
    resourceRef: row.scope_resource_ref,
    justification: row.justification,
    approvedBy: row.approved_by,
    status: row.status === "revoked" ? "revoked" : "active",
    createdAtMs: Number(row.created_at),
    expiresAtMs: row.expires_at === null ? null : Number(row.expires_at),
  };
}

const SELECT_COLUMNS =
  "id, scope_rule_id, scope_resource_ref, justification, approved_by, status, created_at, expires_at";

export class FindingExceptionRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  /** Create a finding-exception rule for a customer that belongs to the acting organization. */
  public async create(
    scope: FindingExceptionTenantScope,
    input: FindingExceptionInput,
    now = Date.now(),
  ): Promise<StoredFindingException> {
    assertScope(scope);
    const ruleId = optionalScopeField(input.ruleId, RULE_SCOPE);
    const resourceRef = optionalScopeField(input.resourceRef, RESOURCE_SCOPE);
    // A rule with no scope field would suppress every finding — refuse it outright.
    if (ruleId === null && resourceRef === null) {
      throw new FindingExceptionRepositoryError("INVALID_INPUT");
    }
    const justification = input.justification.trim();
    const approvedBy = input.approvedBy.trim();
    if (
      justification.length === 0 || justification.length > MAX_JUSTIFICATION ||
      approvedBy.length === 0 || approvedBy.length > MAX_APPROVER
    ) throw new FindingExceptionRepositoryError("INVALID_INPUT");
    let expiresAt: number | null = null;
    if (input.expiresAtMs !== undefined && input.expiresAtMs !== null) {
      if (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= now) {
        throw new FindingExceptionRepositoryError("INVALID_INPUT");
      }
      expiresAt = input.expiresAtMs;
    }
    if (!Number.isSafeInteger(now)) throw new FindingExceptionRepositoryError("INVALID_INPUT");

    const id = `fexc_${crypto.randomUUID().replaceAll("-", "")}`;
    const db = await this.ready();
    await db.prepare(
      `INSERT INTO finding_exceptions
         (id, org_id, customer_id, scope_rule_id, scope_resource_ref, justification, approved_by, status, created_at, expires_at)
       SELECT ?, c.org_id, c.id, ?, ?, ?, ?, 'active', ?, ?
         FROM customers c
        WHERE c.id = ? AND c.org_id = ? AND c.status IN ('active', 'trial')`,
    ).bind(
      id,
      ruleId,
      resourceRef,
      justification,
      approvedBy,
      now,
      expiresAt,
      scope.customerId,
      scope.orgId,
    ).run();

    const stored = await db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM finding_exceptions
        WHERE id = ? AND org_id = ? AND customer_id = ? LIMIT 1`,
    ).bind(id, scope.orgId, scope.customerId).first<ExceptionRow>();
    if (stored === null) throw new FindingExceptionRepositoryError("SCOPE_NOT_FOUND");
    return mapRow(stored);
  }

  /**
   * All active exception rules for the tenant, newest first. Expired rules stay
   * in this list (status is still 'active'); the engine reports them as expired
   * so the caller can surface them as inactive rather than silently dropping them.
   */
  public async list(scope: FindingExceptionTenantScope): Promise<readonly StoredFindingException[]> {
    assertScope(scope);
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM finding_exceptions
        WHERE org_id = ? AND customer_id = ? AND status = 'active'
        ORDER BY created_at DESC, id DESC`,
    ).bind(scope.orgId, scope.customerId).all<ExceptionRow>();
    return (rows.results ?? []).map(mapRow);
  }

  /** Revoke a rule. Returns true when the rule exists in the tenant (now revoked). */
  public async revoke(scope: FindingExceptionTenantScope, ruleId: string): Promise<boolean> {
    assertScope(scope);
    if (!/^fexc_[a-f0-9]{32}$/u.test(ruleId)) {
      throw new FindingExceptionRepositoryError("INVALID_INPUT");
    }
    const db = await this.ready();
    const existing = await db.prepare(
      `SELECT id FROM finding_exceptions
        WHERE id = ? AND org_id = ? AND customer_id = ? LIMIT 1`,
    ).bind(ruleId, scope.orgId, scope.customerId).first<{ id: string }>();
    if (existing === null) return false;
    await db.prepare(
      `UPDATE finding_exceptions SET status = 'revoked'
        WHERE id = ? AND org_id = ? AND customer_id = ?`,
    ).bind(ruleId, scope.orgId, scope.customerId).run();
    return true;
  }
}
