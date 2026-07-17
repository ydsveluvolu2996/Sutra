import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import {
  LocalAuthError,
  loginHostedUser,
  type AuthenticatedLocalSession,
  type HostedIdentity,
} from "./auth-repository";
import { canonicalJson } from "../lib/canonical-json";
import { digestSessionToken, generateSessionToken } from "../lib/local-auth-crypto";
import type { OrgRole, ScopeMode } from "../lib/auth-policy";

const INVITABLE_ROLES = new Set<OrgRole>([
  "org_admin",
  "analyst",
  "viewer",
  "customer_admin",
  "customer_viewer",
]);
const MINIMUM_INVITATION_MS = 60 * 60 * 1000;
const MAXIMUM_INVITATION_MS = 7 * 24 * 60 * 60 * 1000;

export interface IdentityInvitationSummary {
  readonly id: string;
  readonly email: string;
  readonly role: Exclude<OrgRole, "org_owner">;
  readonly scopeMode: ScopeMode;
  readonly expiresAt: string;
  readonly status: "pending" | "accepted" | "revoked" | "expired";
  readonly createdAt: string;
}

function opaqueId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function normalizedEmail(value: string): string {
  const email = value.trim().toLocaleLowerCase("en-US");
  if (
    email.length < 3 ||
    email.length > 254 ||
    /[\u0000-\u0020\u007f]/u.test(email) ||
    !/^[^@]+@[^@]+\.[^@]+$/u.test(email)
  ) {
    throw new LocalAuthError(400, "INVALID_INPUT", "Enter a valid invitation email address");
  }
  return email;
}

async function database(): Promise<D1Database> {
  const db = getRawDb();
  await ensureRuntimeSchema(db);
  return db;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function invitationEventHash(input: {
  readonly invitationId: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly action: "created" | "accepted" | "revoked";
  readonly occurredAt: number;
  readonly metadataJson: string;
  readonly previousEventHash: string | null;
}): Promise<string> {
  return sha256Hex(canonicalJson(input));
}

export async function createIdentityInvitation(
  authenticated: AuthenticatedLocalSession,
  input: {
    readonly email: string;
    readonly role: OrgRole;
    readonly scopeMode: ScopeMode;
    readonly lifetimeMs: number;
  },
  now = Date.now(),
): Promise<{ readonly invitation: IdentityInvitationSummary; readonly token: string }> {
  const email = normalizedEmail(input.email);
  if (
    !INVITABLE_ROLES.has(input.role) ||
    (input.scopeMode !== "all_customers" && input.scopeMode !== "assigned_customers") ||
    !Number.isSafeInteger(input.lifetimeMs) ||
    input.lifetimeMs < MINIMUM_INVITATION_MS ||
    input.lifetimeMs > MAXIMUM_INVITATION_MS
  ) {
    throw new LocalAuthError(400, "INVALID_INPUT", "The invitation scope or lifetime is invalid");
  }
  const db = await database();
  const invitationId = opaqueId("invite");
  const eventId = opaqueId("invite_event");
  const token = generateSessionToken();
  const tokenDigest = await digestSessionToken(token);
  const expiresAt = now + input.lifetimeMs;
  const metadataJson = canonicalJson({ email, role: input.role, scopeMode: input.scopeMode, expiresAt });
  const eventHash = await invitationEventHash({
    invitationId,
    orgId: authenticated.subject.orgId,
    actorId: authenticated.subject.userId,
    action: "created",
    occurredAt: now,
    metadataJson,
    previousEventHash: null,
  });
  try {
    const results = await db.batch([
      db.prepare(
        `INSERT INTO identity_invitations
          (id, org_id, email, role, scope_mode, token_digest, invited_by, expires_at,
           accepted_at, accepted_user_id, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
      ).bind(
        invitationId,
        authenticated.subject.orgId,
        email,
        input.role,
        input.scopeMode,
        tokenDigest,
        authenticated.subject.userId,
        expiresAt,
        now,
      ),
      db.prepare(
        `INSERT INTO identity_invitation_events
          (id, invitation_id, org_id, actor_id, action, occurred_at, metadata_json,
           previous_event_hash, event_hash)
         VALUES (?, ?, ?, ?, 'created', ?, ?, NULL, ?)`,
      ).bind(
        eventId,
        invitationId,
        authenticated.subject.orgId,
        authenticated.subject.userId,
        now,
        metadataJson,
        eventHash,
      ),
    ]);
    if (results.some((result) => Number(result.meta?.changes ?? 0) !== 1)) throw new Error("Invitation batch was incomplete");
  } catch {
    throw new LocalAuthError(409, "INVALID_INPUT", "An active invitation already exists for this email address");
  }
  return {
    invitation: {
      id: invitationId,
      email,
      role: input.role as Exclude<OrgRole, "org_owner">,
      scopeMode: input.scopeMode,
      expiresAt: new Date(expiresAt).toISOString(),
      status: "pending",
      createdAt: new Date(now).toISOString(),
    },
    token,
  };
}

export async function listIdentityInvitations(
  authenticated: AuthenticatedLocalSession,
  now = Date.now(),
): Promise<readonly IdentityInvitationSummary[]> {
  const db = await database();
  const result = await db.prepare(
    `SELECT id, email, role, scope_mode, expires_at, accepted_at, revoked_at, created_at
       FROM identity_invitations
      WHERE org_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 200`,
  ).bind(authenticated.subject.orgId).all<{
    id: string;
    email: string;
    role: Exclude<OrgRole, "org_owner">;
    scope_mode: ScopeMode;
    expires_at: number;
    accepted_at: number | null;
    revoked_at: number | null;
    created_at: number;
  }>();
  return (result.results ?? []).map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    scopeMode: row.scope_mode,
    expiresAt: new Date(row.expires_at).toISOString(),
    status: row.revoked_at !== null
      ? "revoked"
      : row.accepted_at !== null
        ? "accepted"
        : row.expires_at <= now
          ? "expired"
          : "pending",
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

export async function revokeIdentityInvitation(
  authenticated: AuthenticatedLocalSession,
  invitationId: string,
  now = Date.now(),
): Promise<void> {
  if (!/^invite_[a-f0-9]{32}$/u.test(invitationId)) {
    throw new LocalAuthError(400, "INVALID_INPUT", "The invitation identifier is invalid");
  }
  const db = await database();
  const previous = await db.prepare(
    `SELECT event_hash FROM identity_invitation_events
      WHERE invitation_id = ? AND org_id = ?
      ORDER BY occurred_at DESC, id DESC LIMIT 1`,
  ).bind(invitationId, authenticated.subject.orgId).first<{ event_hash: string }>();
  if (previous === null) throw new LocalAuthError(404, "INVALID_INPUT", "The invitation is unavailable");
  const eventId = opaqueId("invite_event");
  const metadataJson = "{}";
  const eventHash = await invitationEventHash({
    invitationId,
    orgId: authenticated.subject.orgId,
    actorId: authenticated.subject.userId,
    action: "revoked",
    occurredAt: now,
    metadataJson,
    previousEventHash: previous.event_hash,
  });
  const results = await db.batch([
    db.prepare(
      `UPDATE identity_invitations SET revoked_at = ?
        WHERE id = ? AND org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
    ).bind(now, invitationId, authenticated.subject.orgId),
    db.prepare(
      `INSERT INTO identity_invitation_events
        (id, invitation_id, org_id, actor_id, action, occurred_at, metadata_json,
         previous_event_hash, event_hash)
       SELECT ?, id, org_id, ?, 'revoked', ?, ?, ?, ?
         FROM identity_invitations
        WHERE id = ? AND org_id = ? AND revoked_at = ?`,
    ).bind(
      eventId,
      authenticated.subject.userId,
      now,
      metadataJson,
      previous.event_hash,
      eventHash,
      invitationId,
      authenticated.subject.orgId,
      now,
    ),
  ]);
  if (results.some((result) => Number(result.meta?.changes ?? 0) !== 1)) {
    throw new LocalAuthError(409, "INVALID_INPUT", "Only a pending invitation can be revoked");
  }
}

export async function acceptIdentityInvitation(
  identity: HostedIdentity,
  token: string,
  now = Date.now(),
): Promise<Awaited<ReturnType<typeof loginHostedUser>>> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new LocalAuthError(401, "AUTHENTICATION_REQUIRED", "The invitation is invalid");
  }
  const db = await database();
  const tokenDigest = await digestSessionToken(token);
  const email = normalizedEmail(identity.email);
  const invitation = await db.prepare(
    `SELECT i.id, i.org_id, i.role, i.scope_mode, e.event_hash
       FROM identity_invitations i
       JOIN identity_invitation_events e ON e.invitation_id = i.id
      WHERE i.token_digest = ? AND i.email = ? AND i.accepted_at IS NULL
        AND i.revoked_at IS NULL AND i.expires_at > ?
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT 1`,
  ).bind(tokenDigest, email, now).first<{
    id: string;
    org_id: string;
    role: OrgRole;
    scope_mode: ScopeMode;
    event_hash: string;
  }>();
  if (invitation === null) {
    throw new LocalAuthError(401, "AUTHENTICATION_REQUIRED", "The invitation is invalid, expired, or already used");
  }
  const userId = opaqueId("user");
  const membershipId = opaqueId("member");
  const eventId = opaqueId("invite_event");
  const metadataJson = canonicalJson({ issuer: identity.issuer, subject: identity.subject });
  const eventHash = await invitationEventHash({
    invitationId: invitation.id,
    orgId: invitation.org_id,
    actorId: userId,
    action: "accepted",
    occurredAt: now,
    metadataJson,
    previousEventHash: invitation.event_hash,
  });
  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare(
        `UPDATE identity_invitations
            SET accepted_at = ?, accepted_user_id = ?
          WHERE id = ? AND token_digest = ? AND email = ? AND accepted_at IS NULL
            AND accepted_user_id IS NULL AND revoked_at IS NULL AND expires_at > ?`,
      ).bind(now, userId, invitation.id, tokenDigest, email, now),
      db.prepare(
        `INSERT INTO users (id, issuer, subject, email, display_name, status, created_at)
         SELECT ?, ?, ?, email, ?, 'active', ?
           FROM identity_invitations
          WHERE id = ? AND accepted_at = ? AND accepted_user_id = ?`,
      ).bind(userId, identity.issuer, identity.subject, identity.displayName, now, invitation.id, now, userId),
      db.prepare(
        `INSERT INTO memberships (id, org_id, user_id, role, scope_mode, status, created_at)
         SELECT ?, org_id, ?, role, scope_mode, 'active', ?
           FROM identity_invitations
          WHERE id = ? AND accepted_at = ? AND accepted_user_id = ?`,
      ).bind(membershipId, userId, now, invitation.id, now, userId),
      db.prepare(
        `INSERT INTO identity_invitation_events
          (id, invitation_id, org_id, actor_id, action, occurred_at, metadata_json,
           previous_event_hash, event_hash)
         SELECT ?, id, org_id, ?, 'accepted', ?, ?, ?, ?
           FROM identity_invitations
          WHERE id = ? AND accepted_at = ? AND accepted_user_id = ?`,
      ).bind(
        eventId,
        userId,
        now,
        metadataJson,
        invitation.event_hash,
        eventHash,
        invitation.id,
        now,
        userId,
      ),
    ]);
  } catch {
    throw new LocalAuthError(409, "IDENTITY_NOT_PROVISIONED", "The invited identity could not be activated");
  }
  if (results.some((result) => Number(result.meta?.changes ?? 0) !== 1)) {
    throw new LocalAuthError(401, "AUTHENTICATION_REQUIRED", "The invitation was already used or revoked");
  }
  return loginHostedUser(identity, now);
}
