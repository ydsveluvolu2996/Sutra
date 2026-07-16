import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import {
  effectiveCapabilities,
  type AuthorizationSubject,
  type Capability,
  type CustomerGrant,
  type OrgRole,
  type ScopeMode,
} from "../lib/auth-policy";
import {
  PASSWORD_ALGORITHM,
  digestSessionToken,
  generateSessionToken,
  generateTotpSecret,
  hashPassword,
  matchTotpCode,
  openTotpSecret,
  sealTotpSecret,
  totpUri,
  validatePassword,
  verifyPassword,
  type PasswordDigest,
} from "../lib/local-auth-crypto";
import { isRecentMfaVerification } from "../lib/recent-mfa";

export const LOCAL_IDENTITY_ISSUER = "sutra-local";
export const LOCAL_AUTH_ORG_ID = "org_local_sutra";
export const LOCAL_AUTH_ORG_SLUG = "local-sutra";
export const LOCAL_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const LOCAL_MFA_STEP_UP_TTL_MS = 5 * 60 * 1000;

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

export type LocalAuthErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "AUTHORIZATION_DENIED"
  | "BOOTSTRAP_ALREADY_COMPLETED"
  | "INVALID_CREDENTIALS"
  | "INVALID_INPUT"
  | "MFA_ALREADY_ENROLLED"
  | "MFA_CODE_INVALID"
  | "MFA_ENROLLMENT_REQUIRED"
  | "MFA_REQUIRED"
  | "MFA_RECENT_REQUIRED"
  | "PERSISTENCE_FAILED";

export class LocalAuthError extends Error {
  public readonly status: number;
  public readonly code: LocalAuthErrorCode;

  public constructor(status: number, code: LocalAuthErrorCode, message: string) {
    super(message);
    this.name = "LocalAuthError";
    this.status = status;
    this.code = code;
  }
}

export interface BootstrapLocalAdminInput {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  readonly organizationName: string;
}

export interface LocalAuthSecrets {
  readonly encryptionKey: string;
  readonly keyVersion: string;
}

export interface PublicLocalSession {
  readonly id: string;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
  };
  readonly organization: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
  };
  readonly membership: {
    readonly id: string;
    readonly role: OrgRole;
    readonly scopeMode: ScopeMode;
  };
  readonly capabilities: readonly Capability[];
  readonly mfa: {
    readonly enrolled: boolean;
    readonly verified: boolean;
  };
  readonly expiresAt: string;
}

export interface AuthenticatedLocalSession {
  readonly tokenDigest: string;
  readonly mfaVerifiedAt: number | null;
  readonly subject: AuthorizationSubject;
  readonly session: PublicLocalSession;
}

interface SessionRow {
  session_id: string;
  token_digest: string;
  expires_at: number;
  mfa_verified_at: number | null;
  user_id: string;
  email: string;
  display_name: string | null;
  org_id: string;
  org_slug: string;
  org_name: string;
  membership_id: string;
  membership_role: OrgRole;
  scope_mode: ScopeMode;
  mfa_confirmed_at: number | null;
}

interface LoginRow {
  user_id: string;
  email: string;
  display_name: string | null;
  status: "active" | "suspended";
  algorithm: typeof PASSWORD_ALGORITHM;
  iterations: number;
  salt: string;
  password_hash: string;
  failed_attempts: number;
  locked_until: number | null;
  org_id: string;
  org_slug: string;
  org_name: string;
  org_status: "active" | "suspended";
  membership_id: string;
  membership_role: OrgRole;
  scope_mode: ScopeMode;
  membership_status: "active" | "suspended";
  secret_ciphertext: string | null;
  secret_key_version: string | null;
  mfa_confirmed_at: number | null;
  last_used_step: number | null;
}

function database(): D1Database {
  return getRawDb();
}

async function readyDatabase(): Promise<D1Database> {
  const db = database();
  await ensureRuntimeSchema(db);
  return db;
}

function opaqueId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") invalidInput("Enter a valid email address");
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (
    normalized.length < 3 ||
    normalized.length > 254 ||
    /[\u0000-\u0020\u007f]/u.test(normalized) ||
    !/^[^@]+@[^@]+\.[^@]+$/u.test(normalized)
  ) {
    invalidInput("Enter a valid email address");
  }
  return normalized;
}

function normalizeName(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") invalidInput(`Enter a valid ${label}`);
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (
    normalized.length < 2 ||
    normalized.length > maximum ||
    /[<>\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    invalidInput(`Enter a ${label} between 2 and ${maximum} characters`);
  }
  return normalized;
}

function invalidInput(message: string): never {
  throw new LocalAuthError(400, "INVALID_INPUT", message);
}

function grantsFrom(rows: readonly { customer_id: string; role: CustomerGrant["role"] }[]): CustomerGrant[] {
  return rows.map((row) => ({ customerId: row.customer_id, role: row.role }));
}

async function loadGrants(db: D1Database, orgId: string, membershipId: string): Promise<CustomerGrant[]> {
  const result = await db.prepare(
    `SELECT ca.customer_id, ca.role
       FROM customer_access ca
       JOIN customers c ON c.id = ca.customer_id AND c.org_id = ca.org_id
      WHERE ca.org_id = ? AND ca.membership_id = ? AND c.status != 'suspended'
      ORDER BY ca.customer_id`,
  ).bind(orgId, membershipId).all<{ customer_id: string; role: CustomerGrant["role"] }>();
  return grantsFrom(result.results ?? []);
}

function publicSession(row: SessionRow, subject: AuthorizationSubject): PublicLocalSession {
  return {
    id: row.session_id,
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name ?? row.email,
    },
    organization: { id: row.org_id, slug: row.org_slug, name: row.org_name },
    membership: {
      id: row.membership_id,
      role: row.membership_role,
      scopeMode: row.scope_mode,
    },
    capabilities: effectiveCapabilities(subject),
    mfa: {
      enrolled: row.mfa_confirmed_at !== null,
      verified: row.mfa_confirmed_at !== null && row.mfa_verified_at !== null,
    },
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

async function sessionFromRow(db: D1Database, row: SessionRow): Promise<AuthenticatedLocalSession> {
  const subject: AuthorizationSubject = {
    userId: row.user_id,
    orgId: row.org_id,
    membershipId: row.membership_id,
    role: row.membership_role,
    scopeMode: row.scope_mode,
    grants: await loadGrants(db, row.org_id, row.membership_id),
  };
  return {
    tokenDigest: row.token_digest,
    mfaVerifiedAt: row.mfa_verified_at,
    subject,
    session: publicSession(row, subject),
  };
}

async function createSession(
  db: D1Database,
  userId: string,
  orgId: string,
  mfaVerified: boolean,
  now: number,
): Promise<{ token: string; session: AuthenticatedLocalSession }> {
  const token = generateSessionToken();
  const digest = await digestSessionToken(token);
  const sessionId = opaqueId("sess");
  const expiresAt = now + LOCAL_SESSION_TTL_MS;
  await db.prepare(
    `INSERT INTO local_sessions
       (id, token_digest, user_id, selected_org_id, created_at, expires_at, last_seen_at, mfa_verified_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).bind(sessionId, digest, userId, orgId, now, expiresAt, now, mfaVerified ? now : null).run();
  const loaded = await getLocalSession(token, now);
  if (loaded === null) {
    throw new LocalAuthError(500, "PERSISTENCE_FAILED", "The local session could not be read after creation");
  }
  return { token, session: loaded };
}

export async function bootstrapLocalAdmin(
  input: BootstrapLocalAdminInput,
  now = Date.now(),
): Promise<{ token: string; session: AuthenticatedLocalSession }> {
  const db = await readyDatabase();
  const existing = await db.prepare(
    `SELECT id FROM users WHERE issuer = ? LIMIT 1`,
  ).bind(LOCAL_IDENTITY_ISSUER).first<{ id: string }>();
  if (existing !== null) {
    throw new LocalAuthError(409, "BOOTSTRAP_ALREADY_COMPLETED", "Local bootstrap has already been completed");
  }

  const email = normalizeEmail(input.email);
  const displayName = normalizeName(input.displayName, "display name", 80);
  const organizationName = normalizeName(input.organizationName, "organization name", 100);
  let password: string;
  try {
    password = validatePassword(input.password, email);
  } catch (error) {
    invalidInput(error instanceof Error ? error.message : "Enter a valid password");
  }
  const digest = await hashPassword(password);
  const userId = opaqueId("user");
  const membershipId = opaqueId("member");

  try {
    await db.batch([
      db.prepare(
        `INSERT OR IGNORE INTO organizations (id, slug, name, status, created_at)
         VALUES (?, ?, ?, 'active', ?)`,
      ).bind(LOCAL_AUTH_ORG_ID, LOCAL_AUTH_ORG_SLUG, organizationName, now),
      db.prepare(
        `INSERT INTO users (id, issuer, subject, email, display_name, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      ).bind(userId, LOCAL_IDENTITY_ISSUER, email, email, displayName, now),
      db.prepare(
        `INSERT INTO local_password_credentials
           (user_id, algorithm, iterations, salt, password_hash, failed_attempts, locked_until, changed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
      ).bind(userId, digest.algorithm, digest.iterations, digest.salt, digest.hash, now, now),
      db.prepare(
        `INSERT INTO memberships (id, org_id, user_id, role, scope_mode, status, created_at)
         VALUES (?, ?, ?, 'org_owner', 'all_customers', 'active', ?)`,
      ).bind(membershipId, LOCAL_AUTH_ORG_ID, userId, now),
    ]);
  } catch {
    throw new LocalAuthError(409, "BOOTSTRAP_ALREADY_COMPLETED", "Local bootstrap has already been completed");
  }
  return createSession(db, userId, LOCAL_AUTH_ORG_ID, false, now);
}

export async function isLocalBootstrapRequired(): Promise<boolean> {
  const db = await readyDatabase();
  const existing = await db.prepare(
    `SELECT id FROM users WHERE issuer = ? LIMIT 1`,
  ).bind(LOCAL_IDENTITY_ISSUER).first<{ id: string }>();
  return existing === null;
}

async function recordLoginFailure(db: D1Database, userId: string, failures: number, now: number): Promise<void> {
  const nextFailures = failures + 1;
  const lockedUntil = nextFailures >= MAX_FAILED_ATTEMPTS ? now + LOCKOUT_MS : null;
  await db.prepare(
    `UPDATE local_password_credentials
        SET failed_attempts = ?, locked_until = ?, updated_at = ?
      WHERE user_id = ?`,
  ).bind(nextFailures >= MAX_FAILED_ATTEMPTS ? 0 : nextFailures, lockedUntil, now, userId).run();
}

function invalidCredentials(): never {
  throw new LocalAuthError(401, "INVALID_CREDENTIALS", "The email or password is incorrect");
}

export async function loginLocalUser(
  input: { readonly email: unknown; readonly password: unknown; readonly totpCode?: unknown },
  secrets: LocalAuthSecrets,
  now = Date.now(),
): Promise<{ token: string; session: AuthenticatedLocalSession; mfaEnrollmentRequired: boolean }> {
  const db = await readyDatabase();
  let email: string;
  try {
    email = normalizeEmail(input.email);
  } catch {
    invalidCredentials();
  }
  if (typeof input.password !== "string" || input.password.length > 128) invalidCredentials();

  const row = await db.prepare(
    `SELECT u.id AS user_id, u.email, u.display_name, u.status,
            p.algorithm, p.iterations, p.salt, p.password_hash, p.failed_attempts, p.locked_until,
            o.id AS org_id, o.slug AS org_slug, o.name AS org_name, o.status AS org_status,
            m.id AS membership_id, m.role AS membership_role, m.scope_mode, m.status AS membership_status,
            t.secret_ciphertext, t.secret_key_version, t.confirmed_at AS mfa_confirmed_at,
            t.last_used_step
       FROM users u
       JOIN local_password_credentials p ON p.user_id = u.id
       JOIN memberships m ON m.user_id = u.id
       JOIN organizations o ON o.id = m.org_id
       LEFT JOIN totp_credentials t ON t.user_id = u.id
      WHERE u.issuer = ? AND u.email = ?
      ORDER BY m.created_at
      LIMIT 1`,
  ).bind(LOCAL_IDENTITY_ISSUER, email).first<LoginRow>();

  if (row === null) {
    await verifyPassword(input.password, {
      algorithm: PASSWORD_ALGORITHM,
      iterations: 600_000,
      salt: "AAAAAAAAAAAAAAAAAAAAAA",
      hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    invalidCredentials();
  }
  if (
    row.status !== "active" ||
    row.org_status !== "active" ||
    row.membership_status !== "active" ||
    (row.locked_until !== null && row.locked_until > now)
  ) {
    invalidCredentials();
  }
  const passwordDigest: PasswordDigest = {
    algorithm: row.algorithm,
    iterations: row.iterations,
    salt: row.salt,
    hash: row.password_hash,
  };
  if (!(await verifyPassword(input.password, passwordDigest))) {
    await recordLoginFailure(db, row.user_id, row.failed_attempts, now);
    invalidCredentials();
  }

  let mfaVerified = false;
  if (row.mfa_confirmed_at !== null) {
    if (input.totpCode === undefined) {
      throw new LocalAuthError(401, "MFA_REQUIRED", "Enter the current code from your authenticator app");
    }
    if (row.secret_ciphertext === null || row.secret_key_version === null) {
      throw new LocalAuthError(500, "PERSISTENCE_FAILED", "The MFA credential is incomplete");
    }
    const secret = await openTotpSecret(
      { ciphertext: row.secret_ciphertext, keyVersion: row.secret_key_version },
      secrets.encryptionKey,
      row.user_id,
    );
    const step = await matchTotpCode(secret, input.totpCode, now, row.last_used_step);
    if (step === null) {
      await recordLoginFailure(db, row.user_id, row.failed_attempts, now);
      throw new LocalAuthError(401, "MFA_CODE_INVALID", "The authenticator code is invalid or was already used");
    }
    const claimed = await db.prepare(
      `UPDATE totp_credentials SET last_used_step = ?, updated_at = ?
        WHERE user_id = ? AND confirmed_at IS NOT NULL
          AND (last_used_step IS NULL OR last_used_step < ?)`,
    ).bind(step, now, row.user_id, step).run();
    if (Number(claimed.meta?.changes ?? 0) !== 1) {
      throw new LocalAuthError(401, "MFA_CODE_INVALID", "The authenticator code is invalid or was already used");
    }
    mfaVerified = true;
  }

  await db.prepare(
    `UPDATE local_password_credentials
        SET failed_attempts = 0, locked_until = NULL, updated_at = ?
      WHERE user_id = ?`,
  ).bind(now, row.user_id).run();
  const created = await createSession(db, row.user_id, row.org_id, mfaVerified, now);
  return { ...created, mfaEnrollmentRequired: row.mfa_confirmed_at === null };
}

export async function getLocalSession(token: string, now = Date.now()): Promise<AuthenticatedLocalSession | null> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
  const db = await readyDatabase();
  const digest = await digestSessionToken(token);
  const row = await db.prepare(
    `SELECT s.id AS session_id, s.token_digest, s.expires_at, s.mfa_verified_at,
            u.id AS user_id, u.email, u.display_name,
            o.id AS org_id, o.slug AS org_slug, o.name AS org_name,
            m.id AS membership_id, m.role AS membership_role, m.scope_mode,
            t.confirmed_at AS mfa_confirmed_at
       FROM local_sessions s
       JOIN users u ON u.id = s.user_id AND u.status = 'active'
       JOIN organizations o ON o.id = s.selected_org_id AND o.status = 'active'
       JOIN memberships m ON m.user_id = u.id AND m.org_id = o.id AND m.status = 'active'
       LEFT JOIN totp_credentials t ON t.user_id = u.id
      WHERE s.token_digest = ? AND s.revoked_at IS NULL AND s.expires_at > ?
      LIMIT 1`,
  ).bind(digest, now).first<SessionRow>();
  if (row === null) return null;
  return sessionFromRow(db, row);
}

export async function beginTotpEnrollment(
  authenticated: AuthenticatedLocalSession,
  secrets: LocalAuthSecrets,
  now = Date.now(),
): Promise<{ secret: string; otpauthUri: string }> {
  const db = await readyDatabase();
  const existing = await db.prepare(
    `SELECT confirmed_at FROM totp_credentials WHERE user_id = ?`,
  ).bind(authenticated.subject.userId).first<{ confirmed_at: number | null }>();
  if (existing?.confirmed_at !== null && existing !== null) {
    throw new LocalAuthError(409, "MFA_ALREADY_ENROLLED", "MFA is already enrolled for this account");
  }
  const secret = generateTotpSecret();
  const sealed = await sealTotpSecret(
    secret,
    secrets.encryptionKey,
    secrets.keyVersion,
    authenticated.subject.userId,
  );
  await db.prepare(
    `INSERT INTO totp_credentials
       (user_id, secret_ciphertext, secret_key_version, confirmed_at, last_used_step, created_at, updated_at)
     VALUES (?, ?, ?, NULL, NULL, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       secret_ciphertext = excluded.secret_ciphertext,
       secret_key_version = excluded.secret_key_version,
       confirmed_at = NULL,
       last_used_step = NULL,
       updated_at = excluded.updated_at`,
  ).bind(authenticated.subject.userId, sealed.ciphertext, sealed.keyVersion, now, now).run();
  return {
    secret,
    otpauthUri: totpUri(secret, authenticated.session.user.email),
  };
}

export async function confirmTotpEnrollment(
  token: string,
  authenticated: AuthenticatedLocalSession,
  code: unknown,
  secrets: LocalAuthSecrets,
  now = Date.now(),
): Promise<AuthenticatedLocalSession> {
  const db = await readyDatabase();
  const row = await db.prepare(
    `SELECT secret_ciphertext, secret_key_version, confirmed_at, last_used_step
       FROM totp_credentials WHERE user_id = ?`,
  ).bind(authenticated.subject.userId).first<{
    secret_ciphertext: string;
    secret_key_version: string;
    confirmed_at: number | null;
    last_used_step: number | null;
  }>();
  if (row === null || row.confirmed_at !== null) {
    throw new LocalAuthError(409, "MFA_ENROLLMENT_REQUIRED", "Start MFA enrollment before verifying a code");
  }
  const secret = await openTotpSecret(
    { ciphertext: row.secret_ciphertext, keyVersion: row.secret_key_version },
    secrets.encryptionKey,
    authenticated.subject.userId,
  );
  const step = await matchTotpCode(secret, code, now, row.last_used_step);
  if (step === null) {
    throw new LocalAuthError(401, "MFA_CODE_INVALID", "The authenticator code is invalid or was already used");
  }
  const claimed = await db.prepare(
    `UPDATE totp_credentials
        SET confirmed_at = ?, last_used_step = ?, updated_at = ?
      WHERE user_id = ? AND confirmed_at IS NULL
        AND (last_used_step IS NULL OR last_used_step < ?)`,
  ).bind(now, step, now, authenticated.subject.userId, step).run();
  if (Number(claimed.meta?.changes ?? 0) !== 1) {
    throw new LocalAuthError(401, "MFA_CODE_INVALID", "The authenticator code is invalid or was already used");
  }
  await db.prepare(
    `UPDATE local_sessions SET mfa_verified_at = ?, last_seen_at = ?
      WHERE token_digest = ? AND revoked_at IS NULL AND expires_at > ?`,
  ).bind(now, now, authenticated.tokenDigest, now).run();
  const refreshed = await getLocalSession(token, now);
  if (refreshed === null) {
    throw new LocalAuthError(401, "AUTHENTICATION_REQUIRED", "Sign in before using the Sutra workspace");
  }
  return refreshed;
}

export async function revokeLocalSession(token: string, now = Date.now()): Promise<void> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return;
  const db = await readyDatabase();
  await db.prepare(
    `UPDATE local_sessions SET revoked_at = ? WHERE token_digest = ? AND revoked_at IS NULL`,
  ).bind(now, await digestSessionToken(token)).run();
}

let mfaStepUpTail: Promise<void> = Promise.resolve();

function serializeMfaStepUp<T>(operation: () => Promise<T>): Promise<T> {
  const task = mfaStepUpTail.catch(() => undefined).then(operation);
  mfaStepUpTail = task.then(() => undefined, () => undefined);
  return task;
}

export function verifyTotpStepUp(
  authenticated: AuthenticatedLocalSession,
  code: unknown,
  secrets: LocalAuthSecrets,
  now = Date.now(),
): Promise<void> {
  // A TOTP step is a one-time, per-user claim. Serializing the local writer
  // prevents two sessions in this single-node demo from racing on the same
  // code before the database transaction observes the first claim.
  return serializeMfaStepUp(() => verifyTotpStepUpTransaction(authenticated, code, secrets, now));
}

async function verifyTotpStepUpTransaction(
  authenticated: AuthenticatedLocalSession,
  code: unknown,
  secrets: LocalAuthSecrets,
  now: number,
): Promise<void> {
  const db = await readyDatabase();
  const row = await db.prepare(
    `SELECT secret_ciphertext, secret_key_version, confirmed_at, last_used_step, updated_at
       FROM totp_credentials WHERE user_id = ?`,
  ).bind(authenticated.subject.userId).first<{
    secret_ciphertext: string;
    secret_key_version: string;
    confirmed_at: number | null;
    last_used_step: number | null;
    updated_at: number | null;
  }>();
  if (row === null || row.confirmed_at === null) {
    throw new LocalAuthError(403, "MFA_ENROLLMENT_REQUIRED", "Enroll MFA before confirming this action");
  }
  const secret = await openTotpSecret(
    { ciphertext: row.secret_ciphertext, keyVersion: row.secret_key_version },
    secrets.encryptionKey,
    authenticated.subject.userId,
  );
  const step = await matchTotpCode(secret, code, now, row.last_used_step);
  if (step === null) {
    throw new LocalAuthError(401, "MFA_CODE_INVALID", "The authenticator code is invalid or was already used");
  }
  // `claimAt` is a transaction-local causal marker. It is strictly newer
  // than the credential row read above, even when two operations share the
  // same millisecond timestamp.
  const claimAt = Math.max(now, (row.updated_at ?? -1) + 1);
  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare(
        `UPDATE totp_credentials SET last_used_step = ?, updated_at = ?
          WHERE user_id = ? AND confirmed_at IS NOT NULL
            AND (last_used_step IS NULL OR last_used_step < ?)`,
      ).bind(step, claimAt, authenticated.subject.userId, step),
      db.prepare(
        `UPDATE local_sessions SET mfa_verified_at = ?, last_seen_at = ?
          WHERE token_digest = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?
            AND EXISTS (
              SELECT 1 FROM totp_credentials
               WHERE user_id = ? AND last_used_step = ? AND updated_at = ?
            )`,
      ).bind(
        now,
        now,
        authenticated.tokenDigest,
        authenticated.subject.userId,
        now,
        authenticated.subject.userId,
        step,
        claimAt,
      ),
      // D1 and the PostgreSQL adapter execute a batch transactionally. If
      // either mutation missed its exact row, this deliberately-invalid
      // insert raises a NOT NULL error and rolls the credential claim back.
      db.prepare(
        `INSERT INTO audit_events (id)
         SELECT NULL
          WHERE NOT EXISTS (
            SELECT 1
              FROM totp_credentials t
              JOIN local_sessions s ON s.user_id = t.user_id
             WHERE t.user_id = ? AND t.last_used_step = ? AND t.updated_at = ?
               AND s.token_digest = ? AND s.mfa_verified_at = ? AND s.last_seen_at = ?
               AND s.revoked_at IS NULL AND s.expires_at > ?
          )`,
      ).bind(
        authenticated.subject.userId,
        step,
        claimAt,
        authenticated.tokenDigest,
        now,
        now,
        now,
      ),
    ]);
  } catch {
    throw new LocalAuthError(500, "PERSISTENCE_FAILED", "The MFA step-up could not be committed atomically");
  }
  const [credential, session] = results;
  if (
    Number(credential.meta?.changes ?? 0) !== 1 ||
    Number(session.meta?.changes ?? 0) !== 1
  ) {
    throw new LocalAuthError(500, "PERSISTENCE_FAILED", "The MFA step-up could not be verified after commit");
  }
}

export function requireMfa(session: AuthenticatedLocalSession): void {
  if (!session.session.mfa.enrolled) {
    throw new LocalAuthError(403, "MFA_ENROLLMENT_REQUIRED", "Enroll MFA before using the Sutra workspace");
  }
  if (!session.session.mfa.verified) {
    throw new LocalAuthError(401, "MFA_REQUIRED", "Verify MFA before using the Sutra workspace");
  }
}

export function requireRecentMfa(
  session: AuthenticatedLocalSession,
  now = Date.now(),
  maximumAgeMs = LOCAL_MFA_STEP_UP_TTL_MS,
): void {
  requireMfa(session);
  if (!isRecentMfaVerification(session.mfaVerifiedAt, now, maximumAgeMs)) {
    throw new LocalAuthError(
      401,
      "MFA_RECENT_REQUIRED",
      "Enter a fresh authenticator code before changing AWS trust",
    );
  }
}
