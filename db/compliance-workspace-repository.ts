// Repository for the compliance workspace layer: operator-defined custom
// frameworks, per-control ownership assignments, auditor sign-off records,
// and recorded readiness trend points. Custom mappings and assignments are
// operator-entered metadata — never presented as collected evidence. Sign-offs
// are append-only: a decision is a fact about who reviewed what, so it is
// never updated or deleted. All writes are gated to a customer the acting
// organization owns; all reads are org-scoped.
import {
  validateCustomFrameworkDefinition,
  type CustomFrameworkDefinition,
} from "../lib/compliance-custom-framework.ts";
import type { ComplianceTrendPoint } from "../lib/compliance-trend.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CONTROL_ID = /^[A-Za-z0-9][A-Za-z0-9 ().:_/-]{0,127}$/u;
const OWNER_TEAM = /^[\p{L}\p{N}][\p{L}\p{N} ._&/+-]{0,79}$/u;
const OWNER_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const CUSTOM_FRAMEWORK_ID = /^cf_[a-f0-9]{32}$/u;
const MAX_CUSTOM_FRAMEWORKS = 50;
const MAX_NOTE = 500;
const MAX_TREND_POINTS = 120;

export interface ComplianceWorkspaceScope {
  readonly orgId: string;
  readonly customerId: string;
}

export interface StoredCustomFramework {
  readonly id: string;
  readonly definition: CustomFrameworkDefinition;
  readonly createdBy: string;
  readonly updatedAt: string;
}

export interface ControlAssignment {
  readonly controlId: string;
  readonly ownerTeam: string | null;
  readonly ownerEmail: string | null;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export interface ComplianceSignoff {
  readonly id: string;
  readonly connectionId: string;
  readonly reportSha256: string;
  readonly decision: "approved" | "needs-work";
  readonly note: string | null;
  readonly signedBy: string;
  readonly mfaVerified: boolean;
  readonly createdAt: string;
}

export class ComplianceWorkspaceRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "LIMIT_EXCEEDED";

  public constructor(code: ComplianceWorkspaceRepositoryError["code"]) {
    super("Compliance workspace operation rejected");
    this.name = "ComplianceWorkspaceRepositoryError";
    this.code = code;
  }
}

function invalid(): never {
  throw new ComplianceWorkspaceRepositoryError("INVALID_INPUT");
}

function assertScope(scope: ComplianceWorkspaceScope): void {
  if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId)) invalid();
}

export class ComplianceWorkspaceRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  public async saveCustomFramework(
    scope: ComplianceWorkspaceScope,
    definitionInput: unknown,
    createdBy: string,
    now = Date.now(),
  ): Promise<StoredCustomFramework> {
    assertScope(scope);
    if (!IDENTIFIER.test(createdBy)) invalid();
    const validation = validateCustomFrameworkDefinition(definitionInput);
    if (validation.definition === null) invalid();
    const definition = validation.definition;
    const db = await this.ready();
    const countRow = await db.prepare(
      `SELECT COUNT(*) AS total FROM custom_frameworks WHERE org_id = ?`,
    ).bind(scope.orgId).first<{ total: number }>();
    if (Number(countRow?.total ?? 0) >= MAX_CUSTOM_FRAMEWORKS) {
      throw new ComplianceWorkspaceRepositoryError("LIMIT_EXCEEDED");
    }
    const id = `cf_${crypto.randomUUID().replaceAll("-", "")}`;
    const timestamp = new Date(now).toISOString();
    const result = await db.prepare(
      `INSERT INTO custom_frameworks (id, org_id, customer_id, name, title, claim_boundary, controls_json, created_by, created_at, updated_at)
       SELECT ?, c.org_id, c.id, ?, ?, ?, ?, ?, ?, ?
         FROM customers c
        WHERE c.id = ? AND c.org_id = ? AND c.status IN ('active', 'trial')
       ON CONFLICT (org_id, name) DO UPDATE SET
         title = excluded.title,
         claim_boundary = excluded.claim_boundary,
         controls_json = excluded.controls_json,
         updated_at = excluded.updated_at`,
    ).bind(
      id, definition.name, definition.title, definition.claimBoundary,
      JSON.stringify(definition.controls), createdBy, timestamp, timestamp,
      scope.customerId, scope.orgId,
    ).run();
    if (Number(result.meta?.changes ?? 0) === 0) throw new ComplianceWorkspaceRepositoryError("SCOPE_NOT_FOUND");
    return { id, definition, createdBy, updatedAt: timestamp };
  }

  public async listCustomFrameworks(scope: ComplianceWorkspaceScope): Promise<readonly StoredCustomFramework[]> {
    assertScope(scope);
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT id, name, title, claim_boundary, controls_json, created_by, updated_at
         FROM custom_frameworks WHERE org_id = ? ORDER BY name ASC`,
    ).bind(scope.orgId).all<{ id: string; name: string; title: string; claim_boundary: string; controls_json: string; created_by: string; updated_at: string }>();
    return (rows.results ?? []).flatMap((row) => {
      let controls: unknown = null;
      try {
        controls = JSON.parse(row.controls_json);
      } catch {
        controls = null;
      }
      const validation = validateCustomFrameworkDefinition({
        name: row.name,
        title: row.title,
        claimBoundary: row.claim_boundary,
        controls,
      });
      // A stored definition that no longer validates is excluded from listings
      // rather than evaluated with guessed semantics.
      if (validation.definition === null) return [];
      return [{ id: row.id, definition: validation.definition, createdBy: row.created_by, updatedAt: row.updated_at }];
    });
  }

  public async deleteCustomFramework(scope: ComplianceWorkspaceScope, id: string): Promise<boolean> {
    assertScope(scope);
    if (!CUSTOM_FRAMEWORK_ID.test(id)) invalid();
    const db = await this.ready();
    const result = await db.prepare(
      `DELETE FROM custom_frameworks WHERE id = ? AND org_id = ?`,
    ).bind(id, scope.orgId).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }

  public async assignControlOwner(
    scope: ComplianceWorkspaceScope,
    controlId: string,
    ownerTeam: string | null,
    ownerEmail: string | null,
    updatedBy: string,
    now = Date.now(),
  ): Promise<void> {
    assertScope(scope);
    if (!CONTROL_ID.test(controlId) || !IDENTIFIER.test(updatedBy)) invalid();
    if (ownerTeam !== null && !OWNER_TEAM.test(ownerTeam)) invalid();
    if (ownerEmail !== null && !OWNER_EMAIL.test(ownerEmail)) invalid();
    const timestamp = new Date(now).toISOString();
    const db = await this.ready();
    const result = await db.prepare(
      `INSERT INTO control_assignments (id, org_id, customer_id, control_id, owner_team, owner_email, updated_by, created_at, updated_at)
       SELECT ?, c.org_id, c.id, ?, ?, ?, ?, ?, ?
         FROM customers c
        WHERE c.id = ? AND c.org_id = ? AND c.status IN ('active', 'trial')
       ON CONFLICT (org_id, control_id) DO UPDATE SET
         owner_team = excluded.owner_team,
         owner_email = excluded.owner_email,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    ).bind(
      `ca_${crypto.randomUUID().replaceAll("-", "")}`,
      controlId, ownerTeam, ownerEmail, updatedBy, timestamp, timestamp,
      scope.customerId, scope.orgId,
    ).run();
    if (Number(result.meta?.changes ?? 0) === 0) throw new ComplianceWorkspaceRepositoryError("SCOPE_NOT_FOUND");
  }

  public async listControlAssignments(scope: ComplianceWorkspaceScope): Promise<readonly ControlAssignment[]> {
    assertScope(scope);
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT control_id, owner_team, owner_email, updated_by, updated_at
         FROM control_assignments WHERE org_id = ? ORDER BY control_id ASC`,
    ).bind(scope.orgId).all<{ control_id: string; owner_team: string | null; owner_email: string | null; updated_by: string; updated_at: string }>();
    return (rows.results ?? []).map((row) => ({
      controlId: row.control_id,
      ownerTeam: row.owner_team,
      ownerEmail: row.owner_email,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    }));
  }

  /** Sign-offs are append-only facts; there is intentionally no update or delete. */
  public async recordSignoff(
    scope: ComplianceWorkspaceScope,
    connectionId: string,
    reportSha256: string,
    decision: "approved" | "needs-work",
    note: string | null,
    signedBy: string,
    mfaVerified: boolean,
    now = Date.now(),
  ): Promise<ComplianceSignoff> {
    assertScope(scope);
    if (!CONNECTION_ID.test(connectionId) || !SHA256_HEX.test(reportSha256) || !IDENTIFIER.test(signedBy)) invalid();
    if (decision !== "approved" && decision !== "needs-work") invalid();
    if (note !== null && (typeof note !== "string" || note.length > MAX_NOTE)) invalid();
    const id = `cs_${crypto.randomUUID().replaceAll("-", "")}`;
    const timestamp = new Date(now).toISOString();
    const db = await this.ready();
    const result = await db.prepare(
      `INSERT INTO compliance_signoffs (id, org_id, customer_id, connection_id, report_sha256, decision, note, signed_by, mfa_verified, created_at)
       SELECT ?, c.org_id, c.id, ?, ?, ?, ?, ?, ?, ?
         FROM customers c
        WHERE c.id = ? AND c.org_id = ? AND c.status IN ('active', 'trial')`,
    ).bind(
      id, connectionId, reportSha256, decision, note, signedBy, mfaVerified ? 1 : 0, timestamp,
      scope.customerId, scope.orgId,
    ).run();
    if (Number(result.meta?.changes ?? 0) === 0) throw new ComplianceWorkspaceRepositoryError("SCOPE_NOT_FOUND");
    return { id, connectionId, reportSha256, decision, note, signedBy, mfaVerified, createdAt: timestamp };
  }

  public async listSignoffs(
    scope: ComplianceWorkspaceScope,
    connectionId: string,
    limit = 50,
  ): Promise<readonly ComplianceSignoff[]> {
    assertScope(scope);
    if (!CONNECTION_ID.test(connectionId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) invalid();
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT id, connection_id, report_sha256, decision, note, signed_by, mfa_verified, created_at
         FROM compliance_signoffs
        WHERE org_id = ? AND customer_id = ? AND connection_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, connectionId, limit).all<{
      id: string; connection_id: string; report_sha256: string; decision: string; note: string | null; signed_by: string; mfa_verified: number; created_at: string;
    }>();
    return (rows.results ?? []).flatMap((row) =>
      row.decision === "approved" || row.decision === "needs-work"
        ? [{
            id: row.id,
            connectionId: row.connection_id,
            reportSha256: row.report_sha256,
            decision: row.decision,
            note: row.note,
            signedBy: row.signed_by,
            mfaVerified: Number(row.mfa_verified) === 1,
            createdAt: row.created_at,
          }]
        : []);
  }

  /** Idempotent per (org, connection, framework, snapshot): re-evaluations do not duplicate. */
  public async recordTrendPoint(
    scope: ComplianceWorkspaceScope,
    connectionId: string,
    frameworkId: string,
    point: ComplianceTrendPoint,
    now = Date.now(),
  ): Promise<void> {
    assertScope(scope);
    if (!CONNECTION_ID.test(connectionId) || !CONTROL_ID.test(frameworkId) || !IDENTIFIER.test(point.snapshotId)) invalid();
    const counts = [point.passCount, point.failCount, point.unknownCount, point.notCollectedCount];
    if (counts.some((count) => !Number.isSafeInteger(count) || count < 0) || !Number.isSafeInteger(point.collectedAtMs)) invalid();
    const db = await this.ready();
    await db.prepare(
      `INSERT INTO compliance_trend_points
         (id, org_id, customer_id, connection_id, framework_id, snapshot_id, collected_at, pass_count, fail_count, unknown_count, not_collected_count, created_at)
       SELECT ?, c.org_id, c.id, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM customers c
        WHERE c.id = ? AND c.org_id = ? AND c.status IN ('active', 'trial')
       ON CONFLICT (org_id, connection_id, framework_id, snapshot_id) DO NOTHING`,
    ).bind(
      `ct_${crypto.randomUUID().replaceAll("-", "")}`,
      connectionId, frameworkId, point.snapshotId, point.collectedAtMs,
      point.passCount, point.failCount, point.unknownCount, point.notCollectedCount,
      new Date(now).toISOString(),
      scope.customerId, scope.orgId,
    ).run();
  }

  public async listTrendPoints(
    scope: ComplianceWorkspaceScope,
    connectionId: string,
    frameworkId: string,
  ): Promise<readonly ComplianceTrendPoint[]> {
    assertScope(scope);
    if (!CONNECTION_ID.test(connectionId) || !CONTROL_ID.test(frameworkId)) invalid();
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT snapshot_id, collected_at, pass_count, fail_count, unknown_count, not_collected_count
         FROM compliance_trend_points
        WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND framework_id = ?
        ORDER BY collected_at DESC, id DESC LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, connectionId, frameworkId, MAX_TREND_POINTS).all<{
      snapshot_id: string; collected_at: number; pass_count: number; fail_count: number; unknown_count: number; not_collected_count: number;
    }>();
    return (rows.results ?? []).map((row) => ({
      snapshotId: row.snapshot_id,
      collectedAtMs: Number(row.collected_at),
      passCount: Number(row.pass_count),
      failCount: Number(row.fail_count),
      unknownCount: Number(row.unknown_count),
      notCollectedCount: Number(row.not_collected_count),
    }));
  }
}
