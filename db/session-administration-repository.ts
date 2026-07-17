import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import { LocalAuthError, type AuthenticatedLocalSession } from "./auth-repository";
import { canonicalJson } from "../lib/canonical-json";
import {
  canAdministerSession,
  canViewOrganizationSessions,
  sessionStatus,
  type SessionAdministrationRecord,
} from "../lib/session-administration";

const SESSION_ID = /^sess_[a-f0-9]{32}$/u;

interface SessionAdminRow {
  id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  issuer: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
  mfa_verified_at: number | null;
}

interface TargetSessionRow extends SessionAdminRow {
  selected_org_id: string;
}

let revocationTail: Promise<void> = Promise.resolve();

function serializeRevocation<T>(operation: () => Promise<T>): Promise<T> {
  const task = revocationTail.catch(() => undefined).then(operation);
  revocationTail = task.then(() => undefined, () => undefined);
  return task;
}

async function database(): Promise<D1Database> {
  const db = getRawDb();
  await ensureRuntimeSchema(db);
  return db;
}

function opaqueId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function publicRecord(row: SessionAdminRow, currentSessionId: string, now: number): SessionAdministrationRecord {
  const hosted = row.issuer !== "sutra-local";
  return {
    id: row.id,
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name ?? row.email,
    },
    identitySource: hosted ? "hosted_oidc" : "local_password",
    identitySourceLabel: hosted ? "Enterprise SSO" : "Local password",
    createdAt: new Date(row.created_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
    mfaVerifiedAt: row.mfa_verified_at === null ? null : new Date(row.mfa_verified_at).toISOString(),
    current: row.id === currentSessionId,
    status: sessionStatus(row.expires_at, row.revoked_at, now),
    deviceLabel: "Browser session",
  };
}

export async function listManagedSessions(
  actor: AuthenticatedLocalSession,
  now = Date.now(),
): Promise<readonly SessionAdministrationRecord[]> {
  const db = await database();
  const organizationWide = canViewOrganizationSessions(actor);
  const result = await db.prepare(
    `SELECT s.id, s.user_id, u.email, u.display_name, u.issuer,
            s.created_at, s.last_seen_at, s.expires_at, s.revoked_at, s.mfa_verified_at
       FROM local_sessions s
       JOIN users u ON u.id = s.user_id
       JOIN memberships m ON m.user_id = s.user_id
        AND m.org_id = s.selected_org_id
      WHERE s.selected_org_id = ?
        AND (? = 1 OR s.user_id = ?)
      ORDER BY CASE WHEN s.revoked_at IS NULL AND s.expires_at > ? THEN 0 ELSE 1 END,
               s.last_seen_at DESC, s.id DESC
      LIMIT 500`,
  ).bind(
    actor.subject.orgId,
    organizationWide ? 1 : 0,
    actor.subject.userId,
    now,
  ).all<SessionAdminRow>();
  return (result.results ?? []).map((row) => publicRecord(row, actor.session.id, now));
}

async function targetSession(
  db: D1Database,
  actor: AuthenticatedLocalSession,
  sessionId: string,
): Promise<TargetSessionRow> {
  if (!SESSION_ID.test(sessionId)) {
    throw new LocalAuthError(400, "INVALID_INPUT", "The session identifier is invalid");
  }
  const row = await db.prepare(
    `SELECT s.id, s.user_id, s.selected_org_id, u.email, u.display_name, u.issuer,
            s.created_at, s.last_seen_at, s.expires_at, s.revoked_at, s.mfa_verified_at
       FROM local_sessions s
       JOIN users u ON u.id = s.user_id
       JOIN memberships m ON m.user_id = s.user_id
        AND m.org_id = s.selected_org_id
      WHERE s.id = ? AND s.selected_org_id = ?
      LIMIT 1`,
  ).bind(sessionId, actor.subject.orgId).first<TargetSessionRow>();
  if (row === null || !canAdministerSession(actor, row.user_id)) {
    throw new LocalAuthError(404, "INVALID_INPUT", "The session is unavailable");
  }
  return row;
}

async function auditAlreadyExists(
  db: D1Database,
  orgId: string,
  sessionId: string,
): Promise<boolean> {
  return await db.prepare(
    `SELECT id FROM audit_events
      WHERE org_id = ? AND request_id = ? AND action = 'auth.session.revoked'
        AND target_type = 'session' AND target_id = ?
      LIMIT 1`,
  ).bind(orgId, `auth.session.revoked:${sessionId}`, sessionId).first<{ id: string }>() !== null;
}

/**
 * Revokes one exact, organization-scoped session and appends its global audit
 * chain event in the same D1/PostgreSQL batch transaction. A chain-head race
 * fails the batch closed and is retried; a deterministic request id makes a
 * completed retry idempotent after an interrupted HTTP response.
 */
export function revokeManagedSession(
  actor: AuthenticatedLocalSession,
  sessionId: string,
  now = Date.now(),
): Promise<{ readonly revoked: boolean; readonly current: boolean }> {
  return serializeRevocation(async () => {
    const db = await database();
    const target = await targetSession(db, actor, sessionId);
    const current = target.id === actor.session.id;
    if (target.revoked_at !== null) {
      return { revoked: false, current };
    }
    const requestId = `auth.session.revoked:${sessionId}`;
    const metadataJson = canonicalJson({
      identitySource: target.issuer === "sutra-local" ? "local_password" : "hosted_oidc",
      initiatedBy: target.user_id === actor.subject.userId ? "self" : "organization_administrator",
      subjectUserId: target.user_id,
    });

    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (await auditAlreadyExists(db, actor.subject.orgId, sessionId)) {
        return { revoked: false, current };
      }
      const previous = await db.prepare(
        `SELECT event_hash, occurred_at FROM audit_events
          WHERE org_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      ).bind(actor.subject.orgId).first<{ event_hash: string; occurred_at: number }>();
      const eventId = opaqueId("audit");
      const occurredAt = Math.max(now, (previous?.occurred_at ?? -1) + 1);
      const previousHash = previous?.event_hash ?? null;
      const eventHash = await sha256Hex(canonicalJson({
        eventId,
        orgId: actor.subject.orgId,
        customerId: null,
        occurredAt,
        actorId: actor.subject.userId,
        action: "auth.session.revoked",
        targetType: "session",
        targetId: sessionId,
        outcome: "allowed",
        requestId,
        metadataJson,
        previousHash,
      }));
      try {
        const results = await db.batch([
          db.prepare(
            `UPDATE local_sessions SET revoked_at = ?
              WHERE id = ? AND selected_org_id = ? AND revoked_at IS NULL`,
          ).bind(now, sessionId, actor.subject.orgId),
          db.prepare(
            `WITH chain_guard(valid) AS (
               SELECT CASE
                 WHEN CAST(? AS TEXT) IS NULL THEN CASE
                   WHEN NOT EXISTS (SELECT 1 FROM audit_events WHERE org_id = ?) THEN 1 ELSE 0 END
                 WHEN (SELECT event_hash FROM audit_events WHERE org_id = ?
                        ORDER BY occurred_at DESC, id DESC LIMIT 1) = ? THEN 1
                 ELSE 0
               END
             ), mutation_guard(valid) AS (
               SELECT CASE WHEN EXISTS (
                 SELECT 1 FROM local_sessions
                  WHERE id = ? AND selected_org_id = ? AND user_id = ? AND revoked_at = ?
               ) THEN 1 ELSE 0 END
             )
             INSERT INTO audit_events
              (id, org_id, customer_id, occurred_at, actor_type, actor_id, action,
               target_type, target_id, outcome, request_id, metadata_json,
               previous_event_hash, event_hash)
             SELECT ?, ?, NULL, ?, 'user', ?, 'auth.session.revoked',
                    'session', ?, 'allowed', ?, ?, ?, ?
               FROM chain_guard, mutation_guard
              WHERE chain_guard.valid = 1 AND mutation_guard.valid = 1
             UNION ALL
             SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                    NULL, NULL, NULL, NULL, NULL, NULL, NULL
               FROM chain_guard, mutation_guard
              WHERE chain_guard.valid = 0 OR mutation_guard.valid = 0`,
          ).bind(
            previousHash,
            actor.subject.orgId,
            actor.subject.orgId,
            previousHash,
            sessionId,
            actor.subject.orgId,
            target.user_id,
            now,
            eventId,
            actor.subject.orgId,
            occurredAt,
            actor.subject.userId,
            sessionId,
            requestId,
            metadataJson,
            previousHash,
            eventHash,
          ),
        ]);
        if (results.every((result) => Number(result.meta?.changes ?? 0) === 1)) {
          return { revoked: true, current };
        }
      } catch {
        if (await auditAlreadyExists(db, actor.subject.orgId, sessionId)) {
          return { revoked: false, current };
        }
      }
    }
    throw new LocalAuthError(500, "PERSISTENCE_FAILED", "The session revocation could not be committed with its audit evidence");
  });
}

export async function revokeOtherManagedSessions(
  actor: AuthenticatedLocalSession,
  now = Date.now(),
): Promise<number> {
  const sessions = await listManagedSessions(actor, now);
  const targets = sessions.filter((session) => session.status === "active" && !session.current && (
    canViewOrganizationSessions(actor) || session.user.id === actor.subject.userId
  ));
  let revoked = 0;
  for (const session of targets) {
    const result = await revokeManagedSession(actor, session.id, now);
    if (result.revoked) revoked += 1;
  }
  return revoked;
}
