import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import {
  LOCAL_IDENTITY_ISSUER,
  LocalAuthError,
} from "./auth-repository";
import { commitAuditedStatements } from "./pilot-repository";
import type { InvitationDeliveryResult } from "../lib/invitation-delivery";
import {
  digestSessionToken,
  generateSessionToken,
  hashPassword,
  validatePassword,
} from "../lib/local-auth-crypto";

const RESET_LIFETIME_MS = 30 * 60 * 1000;
const RESET_REQUEST_COOLDOWN_MS = 5 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;

export interface PasswordResetRequest {
  readonly id: string;
  readonly email: string;
  readonly token: string;
  readonly expiresAt: number;
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") {
    throw new LocalAuthError(400, "INVALID_INPUT", "Enter a valid email address");
  }
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (
    normalized.length < 3 ||
    normalized.length > 254 ||
    /[\u0000-\u0020\u007f]/u.test(normalized) ||
    !/^[^@]+@[^@]+\.[^@]+$/u.test(normalized)
  ) {
    throw new LocalAuthError(400, "INVALID_INPUT", "Enter a valid email address");
  }
  return normalized;
}

async function database(): Promise<D1Database> {
  const db = getRawDb();
  await ensureRuntimeSchema(db);
  return db;
}

/**
 * Creates a single-use reset request only for an active local member. Callers
 * must return the same public response when this returns null so account
 * existence is never disclosed. Only the SHA-256 token digest is persisted.
 */
export async function createPasswordResetRequest(
  emailValue: unknown,
  now = Date.now(),
): Promise<PasswordResetRequest | null> {
  const email = normalizeEmail(emailValue);
  const token = generateSessionToken();
  const tokenDigest = await digestSessionToken(token);
  const id = `reset_${tokenDigest.slice(0, 32)}`;
  const db = await database();
  const target = await db.prepare(
    `SELECT u.id AS user_id, u.email, m.org_id
       FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
       JOIN organizations o ON o.id = m.org_id AND o.status = 'active'
      WHERE u.issuer = ? AND u.email = ? AND u.status = 'active'
      ORDER BY m.created_at
      LIMIT 1`,
  ).bind(LOCAL_IDENTITY_ISSUER, email).first<{
    user_id: string;
    email: string;
    org_id: string;
  }>();
  if (target === null) return null;

  const recent = await db.prepare(
    `SELECT id FROM password_reset_tokens
      WHERE user_id = ? AND consumed_at IS NULL AND expires_at > ?
        AND requested_at > ?
      ORDER BY requested_at DESC
      LIMIT 1`,
  ).bind(
    target.user_id,
    now,
    now - RESET_REQUEST_COOLDOWN_MS,
  ).first<{ id: string }>();
  // Preserve the already-delivered link during the cooldown. Returning null is
  // intentionally indistinguishable from an unknown address to the public API.
  if (recent !== null) return null;

  const expiresAt = now + RESET_LIFETIME_MS;
  await db.batch([
    db.prepare(
      `UPDATE password_reset_tokens
          SET consumed_at = ?, consumed_nonce = 'superseded'
        WHERE user_id = ? AND consumed_at IS NULL`,
    ).bind(now, target.user_id),
    db.prepare(
      `INSERT INTO password_reset_tokens
         (id, user_id, org_id, token_digest, expires_at, consumed_at,
          consumed_nonce, delivery_status, delivery_error_code, requested_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, 'not_attempted', NULL, ?)`,
    ).bind(id, target.user_id, target.org_id, tokenDigest, expiresAt, now),
  ]);
  return { id, email: target.email, token, expiresAt };
}

export async function recordPasswordResetDelivery(
  id: string,
  result: InvitationDeliveryResult,
): Promise<void> {
  const db = await database();
  await db.prepare(
    `UPDATE password_reset_tokens
        SET delivery_status = ?, delivery_error_code = ?
      WHERE id = ? AND consumed_at IS NULL`,
  ).bind(result.status, result.errorCode, id).run();
}

export async function completePasswordReset(
  token: unknown,
  passwordValue: unknown,
  now = Date.now(),
): Promise<void> {
  if (typeof token !== "string" || !TOKEN.test(token)) {
    throw new LocalAuthError(
      400,
      "PASSWORD_RESET_INVALID",
      "This password reset link is invalid or expired",
    );
  }
  const tokenDigest = await digestSessionToken(token);
  const db = await database();
  const reset = await db.prepare(
    `SELECT r.id, r.user_id, r.org_id, u.email
       FROM password_reset_tokens r
       JOIN users u ON u.id = r.user_id AND u.issuer = ? AND u.status = 'active'
      WHERE r.token_digest = ? AND r.consumed_at IS NULL AND r.expires_at > ?
      LIMIT 1`,
  ).bind(LOCAL_IDENTITY_ISSUER, tokenDigest, now).first<{
    id: string;
    user_id: string;
    org_id: string;
    email: string;
  }>();
  if (reset === null) {
    throw new LocalAuthError(
      400,
      "PASSWORD_RESET_INVALID",
      "This password reset link is invalid or expired",
    );
  }

  let password: string;
  try {
    password = validatePassword(passwordValue, reset.email);
  } catch (error) {
    throw new LocalAuthError(
      400,
      "INVALID_INPUT",
      error instanceof Error ? error.message : "Enter a valid password",
    );
  }
  const digest = await hashPassword(password);
  const completionNonce = `reset_complete_${generateSessionToken().slice(0, 24)}`;

  await commitAuditedStatements({
    db,
    statements: [
      db.prepare(
        `UPDATE password_reset_tokens
            SET consumed_at = ?, consumed_nonce = ?
          WHERE id = ? AND token_digest = ? AND consumed_at IS NULL AND expires_at > ?`,
      ).bind(now, completionNonce, reset.id, tokenDigest, now),
      db.prepare(
        `UPDATE local_password_credentials
            SET algorithm = ?, iterations = ?, salt = ?, password_hash = ?,
                failed_attempts = 0, locked_until = NULL, changed_at = ?, updated_at = ?
          WHERE user_id = ?
            AND EXISTS (
              SELECT 1 FROM password_reset_tokens
               WHERE id = ? AND consumed_nonce = ? AND consumed_at = ?
            )`,
      ).bind(
        digest.algorithm,
        digest.iterations,
        digest.salt,
        digest.hash,
        now,
        now,
        reset.user_id,
        reset.id,
        completionNonce,
        now,
      ),
      db.prepare(
        `UPDATE local_sessions SET revoked_at = ?
          WHERE user_id = ? AND revoked_at IS NULL
            AND EXISTS (
              SELECT 1 FROM password_reset_tokens
               WHERE id = ? AND consumed_nonce = ? AND consumed_at = ?
            )`,
      ).bind(now, reset.user_id, reset.id, completionNonce, now),
    ],
    audit: {
      orgId: reset.org_id,
      actorId: reset.user_id,
      action: "auth.password_reset.completed",
      targetType: "user",
      targetId: reset.user_id,
      customerId: null,
      outcome: "allowed",
      requestId: `auth.password_reset.completed:${reset.id}`,
      metadata: {
        resetId: reset.id,
        allSessionsRevoked: true,
        mfaCredentialPreserved: true,
      },
    },
    mutationGuard: {
      sql: `SELECT 1
              FROM password_reset_tokens r
              JOIN local_password_credentials p ON p.user_id = r.user_id
             WHERE r.id = ? AND r.consumed_nonce = ? AND r.consumed_at = ?
               AND p.changed_at = ?`,
      values: [reset.id, completionNonce, now, now],
    },
    persistenceMessage:
      "The password reset and its audit evidence could not be committed atomically",
  });
}
