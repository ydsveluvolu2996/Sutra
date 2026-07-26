import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import { commitAuditedStatements } from "./pilot-repository";
import type {
  ComplianceExceptionActivity,
  ComplianceExceptionRecord,
  ComplianceExceptionStatus,
  ComplianceExceptionWithActivity,
} from "../lib/compliance-exception-types";

interface ExceptionRow {
  id: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  control_key: string;
  finding_fingerprint: string;
  status: ComplianceExceptionStatus;
  owner_user_id: string;
  owner_display_name: string;
  requested_by: string;
  requested_by_display_name: string;
  reviewed_by: string | null;
  reviewed_by_display_name: string | null;
  rationale: string;
  compensating_control: string;
  review_note: string | null;
  expires_at: number;
  requested_at: number;
  reviewed_at: number | null;
  revoked_at: number | null;
  updated_at: number;
}

interface ActivityRow {
  id: string;
  exception_id: string;
  action: ComplianceExceptionActivity["action"];
  actor_id: string;
  actor_display_name: string;
  note: string | null;
  occurred_at: number;
}

export interface ComplianceExceptionOwner {
  readonly userId: string;
  readonly displayName: string;
  readonly role: string;
}

export interface ComplianceExceptionReviewer {
  readonly userId: string;
  readonly displayName: string;
  readonly role: string;
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function recordFrom(row: ExceptionRow, now = Date.now()): ComplianceExceptionRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    customerId: row.customer_id,
    connectionId: row.connection_id,
    controlKey: row.control_key,
    findingFingerprint: row.finding_fingerprint,
    status: row.status,
    effectiveStatus: row.status === "approved" && row.expires_at <= now ? "expired" : row.status,
    ownerUserId: row.owner_user_id,
    ownerDisplayName: row.owner_display_name,
    requestedBy: row.requested_by,
    requestedByDisplayName: row.requested_by_display_name,
    reviewedBy: row.reviewed_by,
    reviewedByDisplayName: row.reviewed_by_display_name,
    rationale: row.rationale,
    compensatingControl: row.compensating_control,
    reviewNote: row.review_note,
    expiresAt: new Date(Number(row.expires_at)).toISOString(),
    requestedAt: new Date(Number(row.requested_at)).toISOString(),
    reviewedAt: row.reviewed_at === null ? null : new Date(Number(row.reviewed_at)).toISOString(),
    revokedAt: row.revoked_at === null ? null : new Date(Number(row.revoked_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
  };
}

function activityFrom(row: ActivityRow): ComplianceExceptionActivity {
  return {
    id: row.id,
    exceptionId: row.exception_id,
    action: row.action,
    actorId: row.actor_id,
    actorDisplayName: row.actor_display_name,
    note: row.note,
    occurredAt: new Date(Number(row.occurred_at)).toISOString(),
  };
}

const EXCEPTION_SELECT = `
  SELECT e.id, e.org_id, e.customer_id, e.connection_id, e.control_key,
         e.finding_fingerprint, e.status, e.owner_user_id,
         COALESCE(owner.display_name, owner.email) AS owner_display_name,
         e.requested_by, COALESCE(requester.display_name, requester.email) AS requested_by_display_name,
         e.reviewed_by, COALESCE(reviewer.display_name, reviewer.email) AS reviewed_by_display_name,
         e.rationale, e.compensating_control, e.review_note, e.expires_at,
         e.requested_at, e.reviewed_at, e.revoked_at, e.updated_at
    FROM compliance_exceptions e
    JOIN users owner ON owner.id = e.owner_user_id
    JOIN users requester ON requester.id = e.requested_by
    LEFT JOIN users reviewer ON reviewer.id = e.reviewed_by`;

export async function listComplianceExceptions(input: {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
}): Promise<readonly ComplianceExceptionWithActivity[]> {
  const db = getRawDb();
  await ensureRuntimeSchema(db);
  const rows = await db.prepare(
    `${EXCEPTION_SELECT}
      WHERE e.org_id = ? AND e.customer_id = ? AND e.connection_id = ?
      ORDER BY e.requested_at DESC, e.id DESC LIMIT 500`,
  ).bind(input.orgId, input.customerId, input.connectionId).all<ExceptionRow>();
  const records = (rows.results ?? []).map((row) => recordFrom(row));
  if (records.length === 0) return [];
  const activityRows = await db.prepare(
    `SELECT a.id, a.exception_id, a.action, a.actor_id,
            COALESCE(u.display_name, u.email) AS actor_display_name,
            a.note, a.occurred_at
       FROM compliance_exception_events a
       JOIN compliance_exceptions e ON e.id = a.exception_id AND e.org_id = a.org_id
       JOIN users u ON u.id = a.actor_id
      WHERE e.org_id = ? AND e.customer_id = ? AND e.connection_id = ?
      ORDER BY a.occurred_at ASC, a.id ASC LIMIT 4000`,
  ).bind(input.orgId, input.customerId, input.connectionId).all<ActivityRow>();
  const byException = new Map<string, ComplianceExceptionActivity[]>();
  for (const row of activityRows.results ?? []) {
    const entry = activityFrom(row);
    const current = byException.get(entry.exceptionId) ?? [];
    current.push(entry);
    byException.set(entry.exceptionId, current);
  }
  return records.map((record) => ({
    ...record,
    activity: byException.get(record.id) ?? [],
  }));
}

export async function listComplianceExceptionOwners(
  orgId: string,
  customerId: string,
): Promise<readonly ComplianceExceptionOwner[]> {
  const db = getRawDb();
  await ensureRuntimeSchema(db);
  const rows = await db.prepare(
    `SELECT u.id AS user_id, COALESCE(u.display_name, u.email) AS display_name, m.role
       FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ? AND m.status = 'active' AND u.status = 'active'
        AND m.role IN ('org_owner', 'org_admin', 'analyst', 'customer_admin')
        AND (
          m.scope_mode = 'all_customers'
          OR EXISTS (
            SELECT 1 FROM customer_access ca
             WHERE ca.org_id = m.org_id AND ca.membership_id = m.id AND ca.customer_id = ?
               AND ca.role IN ('customer_admin', 'analyst')
          )
        )
      ORDER BY display_name, u.id`,
  ).bind(orgId, customerId).all<{ user_id: string; display_name: string; role: string }>();
  return (rows.results ?? []).map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    role: row.role,
  }));
}

/** Reviewers must have both an administrator organization role and effective customer-admin scope. */
export async function listComplianceExceptionReviewers(
  orgId: string,
  customerId: string,
): Promise<readonly ComplianceExceptionReviewer[]> {
  const db = getRawDb();
  await ensureRuntimeSchema(db);
  const rows = await db.prepare(
    `SELECT u.id AS user_id, COALESCE(u.display_name, u.email) AS display_name, m.role
       FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ? AND m.status = 'active' AND u.status = 'active'
        AND m.role IN ('org_owner', 'org_admin', 'customer_admin')
        AND (
          m.scope_mode = 'all_customers'
          OR EXISTS (
            SELECT 1 FROM customer_access ca
             WHERE ca.org_id = m.org_id AND ca.membership_id = m.id AND ca.customer_id = ?
               AND ca.role = 'customer_admin'
          )
        )
      ORDER BY display_name, u.id`,
  ).bind(orgId, customerId).all<{ user_id: string; display_name: string; role: string }>();
  return (rows.results ?? []).map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    role: row.role,
  }));
}

export async function createComplianceException(input: {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly controlKey: string;
  readonly findingFingerprint: string;
  readonly ownerUserId: string;
  readonly requestedBy: string;
  readonly rationale: string;
  readonly compensatingControl: string;
  readonly expiresAt: number;
}): Promise<ComplianceExceptionRecord> {
  const db = getRawDb();
  await ensureRuntimeSchema(db);
  const exceptionId = id("cex");
  const eventId = id("cevt");
  const now = Date.now();
  await commitAuditedStatements({
    db,
    statements: [
      db.prepare(
        `INSERT INTO compliance_exceptions
          (id, org_id, customer_id, connection_id, control_key, finding_fingerprint,
           status, owner_user_id, requested_by, rationale, compensating_control,
           expires_at, requested_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM aws_connections c
             WHERE c.id = ? AND c.org_id = ? AND c.customer_id = ?
          ) AND EXISTS (
            SELECT 1 FROM memberships m
             WHERE m.org_id = ? AND m.user_id = ? AND m.status = 'active'
               AND m.role IN ('org_owner', 'org_admin', 'analyst', 'customer_admin')
               AND (
                 m.scope_mode = 'all_customers'
                 OR EXISTS (
                   SELECT 1 FROM customer_access ca
                    WHERE ca.org_id = m.org_id AND ca.membership_id = m.id AND ca.customer_id = ?
                      AND ca.role IN ('customer_admin', 'analyst')
                 )
               )
          ) AND EXISTS (
            SELECT 1
              FROM connection_heads h
              JOIN cmdb_findings f ON f.snapshot_id = h.snapshot_id
               AND f.org_id = h.org_id AND f.customer_id = h.customer_id
               AND f.connection_id = h.connection_id
             WHERE h.org_id = ? AND h.customer_id = ? AND h.connection_id = ?
               AND f.control_key = ? AND f.fingerprint = ?
          )`,
      ).bind(
        exceptionId, input.orgId, input.customerId, input.connectionId,
        input.controlKey, input.findingFingerprint, input.ownerUserId,
        input.requestedBy, input.rationale, input.compensatingControl,
        input.expiresAt, now, now,
        input.connectionId, input.orgId, input.customerId,
        input.orgId, input.ownerUserId, input.customerId,
        input.orgId, input.customerId, input.connectionId,
        input.controlKey, input.findingFingerprint,
      ),
      db.prepare(
        `INSERT INTO compliance_exception_events
          (id, exception_id, org_id, actor_id, action, note, occurred_at)
         SELECT ?, id, org_id, ?, 'requested', ?, ?
           FROM compliance_exceptions WHERE id = ? AND org_id = ?`,
      ).bind(eventId, input.requestedBy, input.rationale, now, exceptionId, input.orgId),
    ],
    audit: {
      actorId: input.requestedBy,
      action: "compliance.exception.requested",
      targetType: "compliance_exception",
      targetId: exceptionId,
      customerId: input.customerId,
      outcome: "allowed",
      requestId: `compliance.exception.activity:${eventId}`,
      metadata: {
        connectionId: input.connectionId,
        controlKey: input.controlKey,
        findingFingerprint: input.findingFingerprint,
        expiresAt: new Date(input.expiresAt).toISOString(),
      },
    },
    mutationGuard: {
      sql: `SELECT 1
              FROM compliance_exceptions e
              JOIN compliance_exception_events a ON a.exception_id = e.id AND a.org_id = e.org_id
             WHERE e.id = ? AND e.org_id = ? AND e.customer_id = ? AND e.connection_id = ?
               AND e.status = 'pending' AND a.id = ? AND a.action = 'requested'`,
      values: [exceptionId, input.orgId, input.customerId, input.connectionId, eventId],
    },
    persistenceMessage: "The compliance exception and its audit evidence could not be committed atomically",
  });
  const created = await getComplianceException(input.orgId, input.customerId, input.connectionId, exceptionId);
  if (created === null) throw new Error("The compliance exception was not persisted");
  return created;
}

export async function reviewComplianceException(input: {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly exceptionId: string;
  readonly actorId: string;
  readonly action: "approved" | "rejected" | "revoked";
  readonly reviewNote: string;
  readonly selfReviewed: boolean;
}): Promise<ComplianceExceptionRecord> {
  const db = getRawDb();
  await ensureRuntimeSchema(db);
  const now = Date.now();
  const requiredStatus = input.action === "revoked" ? "approved" : "pending";
  const eventId = id("cevt");
  await commitAuditedStatements({
    db,
    statements: [
      db.prepare(
        `UPDATE compliance_exceptions
          SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = ?,
              revoked_at = CASE WHEN ? = 'revoked' THEN ? ELSE revoked_at END,
              updated_at = ?
        WHERE id = ? AND org_id = ? AND customer_id = ? AND connection_id = ?
          AND status = ?`,
      ).bind(
        input.action, input.actorId, input.reviewNote, now,
        input.action, now, now, input.exceptionId, input.orgId,
        input.customerId, input.connectionId, requiredStatus,
      ),
      db.prepare(
        `INSERT INTO compliance_exception_events
        (id, exception_id, org_id, actor_id, action, note, occurred_at)
       SELECT ?, id, org_id, ?, ?, ?, ?
         FROM compliance_exceptions
        WHERE id = ? AND org_id = ? AND customer_id = ? AND connection_id = ?
          AND status = ? AND updated_at = ?`,
      ).bind(
        eventId, input.actorId, input.action, input.reviewNote, now,
        input.exceptionId, input.orgId, input.customerId, input.connectionId,
        input.action, now,
      ),
    ],
    audit: {
      actorId: input.actorId,
      action: `compliance.exception.${input.action}`,
      targetType: "compliance_exception",
      targetId: input.exceptionId,
      customerId: input.customerId,
      outcome: "allowed",
      requestId: `compliance.exception.activity:${eventId}`,
      metadata: { connectionId: input.connectionId, status: input.action, selfReviewed: input.selfReviewed },
    },
    mutationGuard: {
      sql: `SELECT 1
              FROM compliance_exceptions e
              JOIN compliance_exception_events a ON a.exception_id = e.id AND a.org_id = e.org_id
             WHERE e.id = ? AND e.org_id = ? AND e.customer_id = ? AND e.connection_id = ?
               AND e.status = ? AND e.updated_at = ? AND a.id = ? AND a.action = ?`,
      values: [
        input.exceptionId, input.orgId, input.customerId, input.connectionId,
        input.action, now, eventId, input.action,
      ],
    },
    persistenceMessage: "The exception review and its audit evidence could not be committed atomically",
  });
  const updated = await getComplianceException(input.orgId, input.customerId, input.connectionId, input.exceptionId);
  if (updated === null) throw new Error("The reviewed compliance exception is unavailable");
  return updated;
}

async function getComplianceException(
  orgId: string,
  customerId: string,
  connectionId: string,
  exceptionId: string,
): Promise<ComplianceExceptionRecord | null> {
  const row = await getRawDb().prepare(
    `${EXCEPTION_SELECT}
      WHERE e.id = ? AND e.org_id = ? AND e.customer_id = ? AND e.connection_id = ?
      LIMIT 1`,
  ).bind(exceptionId, orgId, customerId, connectionId).first<ExceptionRow>();
  return row === null ? null : recordFrom(row);
}
