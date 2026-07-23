import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import {
  LOCAL_IDENTITY_ISSUER,
  LocalAuthError,
  type AuthenticatedLocalSession,
} from "./auth-repository";
import { commitAuditedStatements, type SqlExistenceGuard } from "./pilot-repository";
import { canAdministerRecovery } from "../lib/auth-policy";

// Recovery targets are always opaque ids minted by the identity stack, so the
// accepted shapes are pinned exactly. An id outside these shapes can never
// resolve a row and is rejected up front as invalid input.
const USER_ID = /^user_[a-f0-9]{32}$/u;
const MEMBERSHIP_ID = /^member_[a-f0-9]{32}$/u;
const OPERATION_ID = /^rec_[a-f0-9]{32}$/u;
// The same bounded organization-identifier shape resolveAuditInput enforces.
const ORG_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const PLATFORM_ACTOR_ID = "system_platform_recovery";

export interface RecoverMemberMfaInput {
  readonly targetUserId: string;
  readonly operationId: string;
}

export interface ProvisionOwnerInput {
  readonly targetMembershipId: string;
  readonly operationId: string;
}

export interface TransferOwnerInput {
  readonly targetMembershipId: string;
  readonly operationId: string;
}

export interface PlatformRecoverOwnerMfaInput {
  readonly orgId: string;
  readonly targetUserId: string;
  readonly operationId: string;
}

function invalid(message: string): never {
  throw new LocalAuthError(400, "INVALID_INPUT", message);
}

function ownerOnly(actor: AuthenticatedLocalSession): void {
  if (!canAdministerRecovery(actor.subject)) {
    throw new LocalAuthError(403, "AUTHORIZATION_DENIED", "Only an organization owner can administer recovery");
  }
}

async function database(): Promise<D1Database> {
  const db = getRawDb();
  await ensureRuntimeSchema(db);
  return db;
}

/**
 * The exact set of credential-reset statements a recovery performs. It NEVER
 * mints a session and NEVER verifies or bypasses MFA on anyone's behalf: it
 * only (a) removes the TOTP credential so the real user must re-enroll, (b)
 * revokes the target's live sessions in this org, and (c) clears the login
 * lockout (same UPDATE shape as {@link unlockLocalUserAccount}). The org scope
 * is bound into the session revocation so recovery can never revoke a session
 * outside the resolved organization.
 */
function credentialResetStatements(
  db: D1Database,
  orgId: string,
  targetUserId: string,
  now: number,
): readonly D1PreparedStatement[] {
  return [
    db.prepare(`DELETE FROM totp_credentials WHERE user_id = ?`).bind(targetUserId),
    db.prepare(
      `UPDATE local_sessions SET revoked_at = ?
        WHERE user_id = ? AND selected_org_id = ? AND revoked_at IS NULL`,
    ).bind(now, targetUserId, orgId),
    db.prepare(
      `UPDATE local_password_credentials
          SET failed_attempts = 0, locked_until = NULL, updated_at = ?
        WHERE user_id = ?`,
    ).bind(now, targetUserId),
  ];
}

// The recovery is committed only if the TOTP credential is provably gone; a
// false guard rolls the whole batch back with its audit row.
function totpClearedGuard(targetUserId: string): SqlExistenceGuard {
  return {
    sql: `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM totp_credentials WHERE user_id = ?)`,
    values: [targetUserId],
  };
}

/**
 * Owner-only recovery of a locked-out / MFA-lost local member. Resets the
 * member's credentials so they must re-enroll — it does not authenticate them.
 */
export async function recoverMemberMfa(
  actor: AuthenticatedLocalSession,
  input: RecoverMemberMfaInput,
  now = Date.now(),
): Promise<void> {
  if (!OPERATION_ID.test(input.operationId)) invalid("The recovery operation identifier is invalid");
  if (!USER_ID.test(input.targetUserId)) invalid("The account identifier is invalid");
  ownerOnly(actor);
  if (input.targetUserId === actor.subject.userId) {
    invalid("An owner cannot run recovery against their own account");
  }
  const orgId = actor.subject.orgId;
  const db = await database();
  // Isolation boundary: the target must be an active LOCAL member of the
  // actor's own org. An id outside the org resolves to no row.
  const member = await db.prepare(
    `SELECT u.id
       FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.org_id = ? AND m.status = 'active'
      WHERE u.id = ? AND u.issuer = ?
      LIMIT 1`,
  ).bind(orgId, input.targetUserId, LOCAL_IDENTITY_ISSUER).first<{ id: string }>();
  if (member === null) {
    throw new LocalAuthError(404, "INVALID_INPUT", "No such local account in this organization");
  }
  await commitAuditedStatements({
    db,
    statements: credentialResetStatements(db, orgId, input.targetUserId, now),
    audit: {
      orgId,
      actorId: actor.subject.userId,
      action: "auth.recovery.mfa_reset",
      targetType: "user",
      targetId: input.targetUserId,
      customerId: null,
      outcome: "allowed",
      requestId: `auth.recovery.mfa_reset:${input.operationId}`,
      metadata: {
        subjectUserId: input.targetUserId,
        mfaEnrollmentCleared: true,
        sessionsRevoked: true,
        lockoutCleared: true,
      },
    },
    mutationGuard: totpClearedGuard(input.targetUserId),
    persistenceMessage: "The recovery reset and its audit evidence could not be committed atomically",
  });
}

/**
 * Owner-only (re)provisioning of an organization owner from an existing active
 * membership. This restores an org's ability to self-administer when its last
 * owner was lost. It grants a role row — it never mints a session or MFA.
 */
export async function provisionOwner(
  actor: AuthenticatedLocalSession,
  input: ProvisionOwnerInput,
  // Kept for signature parity with the credential-reset recovery operations and
  // for deterministic tests; a pure role (re)provisioning stamps no timestamp.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  now = Date.now(),
): Promise<void> {
  if (!OPERATION_ID.test(input.operationId)) invalid("The recovery operation identifier is invalid");
  if (!MEMBERSHIP_ID.test(input.targetMembershipId)) invalid("The membership identifier is invalid");
  ownerOnly(actor);
  const orgId = actor.subject.orgId;
  const db = await database();
  const target = await db.prepare(
    `SELECT id FROM memberships
      WHERE id = ? AND org_id = ? AND status = 'active' AND role != 'org_owner'
      LIMIT 1`,
  ).bind(input.targetMembershipId, orgId).first<{ id: string }>();
  if (target === null) {
    throw new LocalAuthError(404, "INVALID_INPUT", "The membership is unavailable for owner provisioning");
  }
  await commitAuditedStatements({
    db,
    statements: [
      db.prepare(
        `UPDATE memberships SET role = 'org_owner', scope_mode = 'all_customers'
          WHERE id = ? AND org_id = ? AND status = 'active' AND role != 'org_owner'`,
      ).bind(input.targetMembershipId, orgId),
      db.prepare(
        `DELETE FROM customer_access WHERE org_id = ? AND membership_id = ?`,
      ).bind(orgId, input.targetMembershipId),
    ],
    audit: {
      orgId,
      actorId: actor.subject.userId,
      action: "auth.recovery.owner_provisioned",
      targetType: "membership",
      targetId: input.targetMembershipId,
      customerId: null,
      outcome: "allowed",
      requestId: `auth.recovery.owner_provisioned:${input.operationId}`,
      metadata: { membershipId: input.targetMembershipId, grantedRole: "org_owner", scopeMode: "all_customers" },
    },
    mutationGuard: {
      sql: `SELECT 1 FROM memberships
             WHERE id = ? AND org_id = ? AND role = 'org_owner'
               AND scope_mode = 'all_customers' AND status = 'active'`,
      values: [input.targetMembershipId, orgId],
    },
    persistenceMessage: "The owner provisioning and its audit evidence could not be committed atomically",
  });
}

/**
 * Owner-only demotion of another active organization owner to org_admin. The
 * last-owner invariant is enforced twice: a pre-check refuses when the org has
 * a single active owner, and the UPDATE is additionally guarded by an in-SQL
 * EXISTS proving another active owner survives (defense-in-depth against a
 * concurrent demotion). An org can never be left without an active owner.
 */
export async function transferOwner(
  actor: AuthenticatedLocalSession,
  input: TransferOwnerInput,
  // Kept for signature parity with the credential-reset recovery operations and
  // for deterministic tests; a pure role demotion stamps no timestamp.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  now = Date.now(),
): Promise<void> {
  if (!OPERATION_ID.test(input.operationId)) invalid("The recovery operation identifier is invalid");
  if (!MEMBERSHIP_ID.test(input.targetMembershipId)) invalid("The membership identifier is invalid");
  ownerOnly(actor);
  if (input.targetMembershipId === actor.subject.membershipId) {
    invalid("An owner cannot transfer their own ownership through recovery");
  }
  const orgId = actor.subject.orgId;
  const db = await database();
  const owners = await db.prepare(
    `SELECT COUNT(*) AS count FROM memberships
      WHERE org_id = ? AND status = 'active' AND role = 'org_owner'`,
  ).bind(orgId).first<{ count: number }>();
  if (Number(owners?.count ?? 0) <= 1) {
    throw new LocalAuthError(
      409,
      "INVALID_INPUT",
      "Cannot remove the last organization owner without a replacement",
    );
  }
  const target = await db.prepare(
    `SELECT id FROM memberships
      WHERE id = ? AND org_id = ? AND status = 'active' AND role = 'org_owner'
      LIMIT 1`,
  ).bind(input.targetMembershipId, orgId).first<{ id: string }>();
  if (target === null) {
    throw new LocalAuthError(404, "INVALID_INPUT", "The membership is not an active organization owner");
  }
  await commitAuditedStatements({
    db,
    statements: [
      db.prepare(
        `UPDATE memberships SET role = 'org_admin'
          WHERE id = ? AND org_id = ? AND status = 'active' AND role = 'org_owner'
            AND EXISTS (
              SELECT 1 FROM memberships
               WHERE org_id = ? AND status = 'active' AND role = 'org_owner' AND id != ?
            )`,
      ).bind(input.targetMembershipId, orgId, orgId, input.targetMembershipId),
    ],
    audit: {
      orgId,
      actorId: actor.subject.userId,
      action: "auth.recovery.owner_transferred",
      targetType: "membership",
      targetId: input.targetMembershipId,
      customerId: null,
      outcome: "allowed",
      requestId: `auth.recovery.owner_transferred:${input.operationId}`,
      metadata: { membershipId: input.targetMembershipId, demotedTo: "org_admin" },
    },
    mutationGuard: {
      sql: `SELECT 1 FROM memberships
             WHERE id = ? AND org_id = ? AND role = 'org_admin' AND status = 'active'`,
      values: [input.targetMembershipId, orgId],
    },
    persistenceMessage: "The owner transfer and its audit evidence could not be committed atomically",
  });
}

/**
 * The host-local platform cold path: recover an organization owner's MFA when
 * NO owner can authenticate to run {@link recoverMemberMfa}. It has NO actor —
 * the route gates it behind loopback + a bootstrap token — and it strictly
 * resolves the target by the passed orgId, the local issuer, and an active
 * org_owner membership. It performs the identical credential resets and records
 * a system-attributed audit event. It never mints a session or MFA.
 */
export async function platformRecoverOwnerMfa(
  input: PlatformRecoverOwnerMfaInput,
  now = Date.now(),
): Promise<void> {
  if (!OPERATION_ID.test(input.operationId)) invalid("The recovery operation identifier is invalid");
  if (!USER_ID.test(input.targetUserId)) invalid("The account identifier is invalid");
  if (!ORG_ID.test(input.orgId)) invalid("The organization identifier is invalid");
  const db = await database();
  const owner = await db.prepare(
    `SELECT u.id
       FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.org_id = ?
        AND m.status = 'active' AND m.role = 'org_owner'
      WHERE u.id = ? AND u.issuer = ?
      LIMIT 1`,
  ).bind(input.orgId, input.targetUserId, LOCAL_IDENTITY_ISSUER).first<{ id: string }>();
  if (owner === null) {
    throw new LocalAuthError(404, "INVALID_INPUT", "No such local organization owner");
  }
  await commitAuditedStatements({
    db,
    statements: credentialResetStatements(db, input.orgId, input.targetUserId, now),
    audit: {
      orgId: input.orgId,
      actorType: "system",
      actorId: PLATFORM_ACTOR_ID,
      action: "auth.recovery.platform_mfa_reset",
      targetType: "user",
      targetId: input.targetUserId,
      customerId: null,
      outcome: "allowed",
      requestId: `auth.recovery.platform_mfa_reset:${input.operationId}`,
      metadata: {
        subjectUserId: input.targetUserId,
        mfaEnrollmentCleared: true,
        sessionsRevoked: true,
        lockoutCleared: true,
        coldPath: true,
      },
    },
    mutationGuard: totpClearedGuard(input.targetUserId),
    persistenceMessage: "The platform recovery reset and its audit evidence could not be committed atomically",
  });
}
