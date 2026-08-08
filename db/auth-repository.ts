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
import { BROWSER_SESSION_IDLE_TTL_MS } from "../lib/browser-session-lifecycle.ts";

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
  | "IDENTITY_ISSUER_MISMATCH"
  | "IDENTITY_NOT_PROVISIONED"
  | "INVALID_CREDENTIALS"
  | "INVALID_INPUT"
  | "MFA_ALREADY_ENROLLED"
  | "MFA_CODE_INVALID"
  | "MFA_ENROLLMENT_REQUIRED"
  | "MFA_REQUIRED"
  | "MFA_RECENT_REQUIRED"
  | "LOGIN_RATE_LIMITED"
  | "PASSWORD_RESET_INVALID"
  | "PERSISTENCE_FAILED"
  | "SIGNUP_DOMAIN_NOT_ALLOWED"
  | "SIGNUP_RATE_LIMITED";

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
    /** 'trial' for self-serve signups; presentation/gating only, never authorization. */
    readonly plan: "trial" | "standard";
  };
  readonly membership: {
    readonly id: string;
    readonly role: OrgRole;
    readonly scopeMode: ScopeMode;
  };
  /**
   * Every active organization this user belongs to, for the org switcher.
   * Always includes the currently-active org. A single-org user gets one entry.
   */
  readonly availableOrganizations: readonly {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly role: OrgRole;
  }[];
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
  org_plan: "trial" | "standard";
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

// ---- Self-serve signup abuse controls (INFO-2) ----------------------------
// These apply ONLY to the self-serve create-NEW-org path
// (provisionSelfServeHostedOrg), never to invited-join or an existing-identity
// login. Deny-by-default: a rate-limit breach OR a storage error refuses.
const SIGNUP_RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_SIGNUPS_PER_SOURCE_PER_WINDOW = 10;
// A source without a trusted edge IP shares one bucket (see hostedSignupSourceKey).
const UNATTRIBUTED_SIGNUP_SOURCE = "unattributed";

/** Options controlling the self-serve signup abuse gates. All optional; every
 * default keeps the sane production behaviour, and tests override them. */
export interface SelfServeSignupOptions {
  /** Per-source rate-limit key (a trusted edge IP, or a shared bucket name). */
  readonly sourceKey?: string | null;
  /** When non-null, the verified email's domain MUST be on this list. */
  readonly allowedEmailDomains?: readonly string[] | null;
  readonly now?: number;
  readonly rateWindowMs?: number;
  readonly maxSignupsPerWindow?: number;
}

async function signupSourceDigest(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Atomically reserve one unit of the per-source signup budget for the current
 * fixed window and refuse once the cap is exceeded. The counter is a durable,
 * database-executed conditional INSERT ... ON CONFLICT DO UPDATE (see migration
 * 0048 / postgres 0042), so the count is atomic across worker instances and
 * restarts. The bucket key is an OPAQUE SHA-256 of the source — no raw IP is
 * stored. Fails CLOSED: if the counter table is unavailable (e.g. the migration
 * is not yet registered by the parent) the signup is refused, never allowed.
 */
async function consumeSelfServeSignupBudget(
  db: D1Database,
  input: { readonly sourceKey: string | null; readonly now: number; readonly windowMs: number; readonly maxPerWindow: number },
): Promise<void> {
  const source = input.sourceKey && input.sourceKey.length > 0 ? input.sourceKey : UNATTRIBUTED_SIGNUP_SOURCE;
  const windowStart = Math.floor(input.now / input.windowMs) * input.windowMs;
  const expiresAt = windowStart + input.windowMs;
  const bucketKey = `${await signupSourceDigest(source)}:${windowStart}`;
  let attempts: number;
  try {
    // Sampled GC (~10%): the count keys on the current window's bucketKey, so
    // lingering expired rows never affect this window's count — they only need
    // occasional cleanup, not a DELETE on every signup.
    if (Math.random() < 0.1) {
      await db.prepare(`DELETE FROM hosted_signup_rate_limits WHERE expires_at <= ?`).bind(input.now).run();
    }
    const row = await db.prepare(
      `INSERT INTO hosted_signup_rate_limits (bucket_key, attempts, expires_at)
         VALUES (?, 1, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET attempts = hosted_signup_rate_limits.attempts + 1
       RETURNING attempts`,
    ).bind(bucketKey, expiresAt).first<{ attempts: number }>();
    attempts = Number(row?.attempts ?? 0);
  } catch {
    // Fail closed: the durable counter is unavailable. NEVER allow an unmetered
    // signup — mirrors the hosted-broker replay store, which fails closed until
    // its migration is registered.
    throw new LocalAuthError(503, "SIGNUP_RATE_LIMITED", "Self-service sign-up is temporarily unavailable");
  }
  if (attempts < 1 || attempts > input.maxPerWindow) {
    throw new LocalAuthError(429, "SIGNUP_RATE_LIMITED", "Too many sign-up attempts from this source; please try again later");
  }
}

const LOGIN_RATE_WINDOW_MS = 5 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS_PER_SOURCE = 30;
const UNATTRIBUTED_LOGIN_SOURCE = "unattributed-login-source";

/**
 * Per-source (per-IP) rate limit for credential endpoints, layered ON TOP of the
 * existing per-ACCOUNT lockout. The per-account lockout alone lets an attacker
 * who knows one email keep that account perpetually locked; a per-source cap
 * blunts distributed brute force and the lockout-DoS by throttling how many
 * attempts any single origin can make in a window. Reuses the durable
 * rate-limit table under a distinct `login:` key namespace, and FAILS CLOSED if
 * the counter store is unavailable. The source key is the caller's client IP as
 * resolved by the trusted edge (see clientSourceKey); a null/blank source is
 * bucketed together as unattributed so it is still metered.
 */
export async function consumeLoginAttemptBudget(
  input: { readonly sourceKey: string | null; readonly now: number; readonly windowMs?: number; readonly maxPerWindow?: number },
): Promise<void> {
  const db = await readyDatabase();
  const windowMs = input.windowMs ?? LOGIN_RATE_WINDOW_MS;
  const maxPerWindow = input.maxPerWindow ?? MAX_LOGIN_ATTEMPTS_PER_SOURCE;
  const source = input.sourceKey && input.sourceKey.length > 0 ? input.sourceKey : UNATTRIBUTED_LOGIN_SOURCE;
  const windowStart = Math.floor(input.now / windowMs) * windowMs;
  const expiresAt = windowStart + windowMs;
  const bucketKey = `login:${await signupSourceDigest(source)}:${windowStart}`;
  let attempts: number;
  try {
    // Sampled GC (~10%): the count keys on the current window's bucketKey, so
    // lingering expired rows never affect this window's count — they only need
    // occasional cleanup, not a DELETE on every login attempt.
    if (Math.random() < 0.1) {
      await db.prepare(`DELETE FROM hosted_signup_rate_limits WHERE expires_at <= ?`).bind(input.now).run();
    }
    const row = await db.prepare(
      `INSERT INTO hosted_signup_rate_limits (bucket_key, attempts, expires_at)
         VALUES (?, 1, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET attempts = hosted_signup_rate_limits.attempts + 1
       RETURNING attempts`,
    ).bind(bucketKey, expiresAt).first<{ attempts: number }>();
    attempts = Number(row?.attempts ?? 0);
  } catch {
    throw new LocalAuthError(503, "LOGIN_RATE_LIMITED", "Sign-in is temporarily unavailable");
  }
  if (attempts < 1 || attempts > maxPerWindow) {
    throw new LocalAuthError(429, "LOGIN_RATE_LIMITED", "Too many sign-in attempts from this source; please try again later");
  }
}

/**
 * Operator account-unlock. Clears the per-account failed-attempt counter and
 * lockout for a LOCAL password identity in the actor's own organization. This is
 * the recovery path for the lockout-DoS: only an org operator (org_owner /
 * org_admin, i.e. the capability `membership:manage`) may call it, the target
 * must be an active local member of the SAME org (verified by join, never taken
 * from the request), and it only ever relaxes state — it can never escalate a
 * role or cross an org boundary. Returns true if a locked/failed credential was
 * reset, false if the target had nothing to clear.
 */
export async function unlockLocalUserAccount(
  actor: AuthenticatedLocalSession,
  targetUserId: string,
  now = Date.now(),
): Promise<boolean> {
  if (!effectiveCapabilities(actor.subject).includes("membership:manage")) {
    throw new LocalAuthError(403, "AUTHORIZATION_DENIED", "This account cannot unlock organization members");
  }
  if (typeof targetUserId !== "string" || !/^user_[a-f0-9]{32}$/u.test(targetUserId)) {
    throw new LocalAuthError(400, "INVALID_INPUT", "The account identifier is invalid");
  }
  const db = await readyDatabase();
  // The target must be an active LOCAL member of the actor's own org. This join
  // is the isolation boundary: an id outside the org resolves to no row.
  const member = await db.prepare(
    `SELECT u.id
       FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.org_id = ? AND m.status = 'active'
      WHERE u.id = ? AND u.issuer = ?
      LIMIT 1`,
  ).bind(actor.subject.orgId, targetUserId, LOCAL_IDENTITY_ISSUER).first<{ id: string }>();
  if (member === null) {
    throw new LocalAuthError(404, "INVALID_INPUT", "No such local account in this organization");
  }
  const result = await db.prepare(
    `UPDATE local_password_credentials
        SET failed_attempts = 0, locked_until = NULL, updated_at = ?
      WHERE user_id = ? AND (failed_attempts > 0 OR locked_until IS NOT NULL)`,
  ).bind(now, targetUserId).run();
  return Number(result.meta?.changes ?? 0) === 1;
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

async function loadMemberships(
  db: D1Database,
  userId: string,
): Promise<PublicLocalSession["availableOrganizations"]> {
  const result = await db.prepare(
    `SELECT o.id, o.slug, o.name, m.role
       FROM memberships m
       JOIN organizations o ON o.id = m.org_id AND o.status = 'active'
      WHERE m.user_id = ? AND m.status = 'active'
      ORDER BY o.name, o.id`,
  ).bind(userId).all<{ id: string; slug: string; name: string; role: OrgRole }>();
  return (result.results ?? []).map((row) => ({ id: row.id, slug: row.slug, name: row.name, role: row.role }));
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

function publicSession(
  row: SessionRow,
  subject: AuthorizationSubject,
  availableOrganizations: PublicLocalSession["availableOrganizations"],
): PublicLocalSession {
  return {
    id: row.session_id,
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name ?? row.email,
    },
    organization: { id: row.org_id, slug: row.org_slug, name: row.org_name, plan: row.org_plan },
    membership: {
      id: row.membership_id,
      role: row.membership_role,
      scopeMode: row.scope_mode,
    },
    availableOrganizations,
    capabilities: effectiveCapabilities(subject),
    mfa: {
      enrolled: row.mfa_confirmed_at !== null,
      verified: row.mfa_confirmed_at !== null && row.mfa_verified_at !== null,
    },
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

async function sessionFromRow(
  db: D1Database,
  row: SessionRow,
  // `availableOrganizations` only feeds the session/org-switcher view, so the
  // extra memberships-join is loaded lazily. The generic every-request authorize
  // path (`requireApiSession`) skips it; callers that serialize the whole session
  // to the client (session view, org switch, login, MFA verify) keep it on.
  withAvailableOrganizations = true,
): Promise<AuthenticatedLocalSession> {
  const subject: AuthorizationSubject = {
    userId: row.user_id,
    orgId: row.org_id,
    membershipId: row.membership_id,
    role: row.membership_role,
    scopeMode: row.scope_mode,
    grants: await loadGrants(db, row.org_id, row.membership_id),
  };
  const availableOrganizations = withAvailableOrganizations
    ? await loadMemberships(db, row.user_id)
    : [];
  return {
    tokenDigest: row.token_digest,
    mfaVerifiedAt: row.mfa_verified_at,
    subject,
    session: publicSession(row, subject, availableOrganizations),
  };
}

export async function createSession(
  db: D1Database,
  userId: string,
  orgId: string,
  mfaVerifiedAt: number | null,
  now: number,
  expiresAt = now + LOCAL_SESSION_TTL_MS,
): Promise<{ token: string; session: AuthenticatedLocalSession }> {
  const token = generateSessionToken();
  const digest = await digestSessionToken(token);
  const sessionId = opaqueId("sess");
  await db.prepare(
    `INSERT INTO local_sessions
       (id, token_digest, user_id, selected_org_id, created_at, expires_at, last_seen_at, mfa_verified_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).bind(sessionId, digest, userId, orgId, now, expiresAt, now, mfaVerifiedAt).run();
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
  return createSession(db, userId, LOCAL_AUTH_ORG_ID, null, now);
}

export async function isLocalBootstrapRequired(): Promise<boolean> {
  const db = await readyDatabase();
  const existing = await db.prepare(
    `SELECT id FROM users WHERE issuer = ? LIMIT 1`,
  ).bind(LOCAL_IDENTITY_ISSUER).first<{ id: string }>();
  return existing === null;
}

/**
 * Computes the next throttle state after a failed login. The counter is NEVER
 * reset to 0 on lockout — resetting handed a locked-out attacker a fresh budget
 * of {@link MAX_FAILED_ATTEMPTS} the moment the window expired. Instead it keeps
 * climbing, and each failure at/beyond the threshold triggers an again-lockout
 * whose duration grows progressively (bounded), so repeated 5-fail cycles cost
 * more each time. A successful login is the only thing that clears the counter.
 *
 * NOTE: this is per-account only. A per-IP throttle (edge rate limit) is a
 * larger, ops/edge-owned follow-up and is intentionally out of scope here.
 */
export function nextLoginFailureState(
  failures: number,
  now: number,
  maxAttempts: number = MAX_FAILED_ATTEMPTS,
  lockoutMs: number = LOCKOUT_MS,
): { readonly failedAttempts: number; readonly lockedUntil: number | null } {
  const nextFailures = failures + 1;
  if (nextFailures < maxAttempts) {
    return { failedAttempts: nextFailures, lockedUntil: null };
  }
  // Progressive backoff: 1x at the threshold, +1x per extra failure, capped so
  // the stored timestamp stays bounded.
  const multiplier = Math.min(nextFailures - maxAttempts + 1, 12);
  return { failedAttempts: nextFailures, lockedUntil: now + lockoutMs * multiplier };
}

async function recordLoginFailure(db: D1Database, userId: string, now: number): Promise<void> {
  // Atomic increment. This previously read failed_attempts, computed the next
  // value in JS, and wrote an ABSOLUTE count — so N wrong-password attempts
  // fired in parallel (across the ~600k-iteration hash) all read the same
  // counter and collapsed to a single +1, letting a distributed brute force
  // sidestep the per-account lockout. Incrementing in SQL makes every attempt
  // count; the lockout timestamp is then derived from the authoritative new
  // value.
  const updated = await db.prepare(
    `UPDATE local_password_credentials
        SET failed_attempts = failed_attempts + 1, updated_at = ?
      WHERE user_id = ?
      RETURNING failed_attempts`,
  ).bind(now, userId).first<{ failed_attempts: number }>();
  if (updated === null) return;
  const { lockedUntil } = nextLoginFailureState(updated.failed_attempts - 1, now);
  if (lockedUntil !== null) {
    await db.prepare(
      `UPDATE local_password_credentials SET locked_until = ?, updated_at = ?
        WHERE user_id = ?`,
    ).bind(lockedUntil, now, userId).run();
  }
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
       JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
       JOIN organizations o ON o.id = m.org_id AND o.status = 'active'
       LEFT JOIN totp_credentials t ON t.user_id = u.id
      WHERE u.issuer = ? AND u.email = ?
      ORDER BY m.created_at, m.id
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
  const passwordDigest: PasswordDigest = {
    algorithm: row.algorithm,
    iterations: row.iterations,
    salt: row.salt,
    hash: row.password_hash,
  };
  // Membership/org active-status is now enforced in the JOIN above, so a user
  // whose EARLIEST membership is suspended but who holds another active
  // membership can still sign in (previously the earliest row was picked and
  // rejected). Only a suspended user account or an engaged lockout remains.
  if (
    row.status !== "active" ||
    (row.locked_until !== null && row.locked_until > now)
  ) {
    // Equalize response time with the active-account path: a locked or
    // suspended account previously returned BEFORE any password hash, so it
    // answered measurably faster and leaked account existence / lockout state.
    // Run the same verification before rejecting.
    await verifyPassword(input.password, passwordDigest);
    invalidCredentials();
  }
  if (!(await verifyPassword(input.password, passwordDigest))) {
    await recordLoginFailure(db, row.user_id, now);
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
      await recordLoginFailure(db, row.user_id, now);
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
  const created = await createSession(db, row.user_id, row.org_id, mfaVerified ? now : null, now);
  return { ...created, mfaEnrollmentRequired: row.mfa_confirmed_at === null };
}

export interface HostedIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string;
  readonly displayName: string;
  readonly authenticatedAt: number;
  readonly expiresAt: number;
}

/**
 * Creates a server session only for an identity provisioned into exactly one
 * active Sutra organization. Email is checked as an attribute and is never
 * used to link or authorize an otherwise unknown OIDC subject.
 */
export async function loginHostedUser(
  identity: HostedIdentity,
  now = Date.now(),
): Promise<{ token: string; session: AuthenticatedLocalSession }> {
  if (
    !identity.issuer.startsWith("https://") ||
    identity.issuer.length > 2048 ||
    !/^[^\u0000-\u001f\u007f]{1,255}$/u.test(identity.subject) ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(identity.email) ||
    identity.authenticatedAt > now + 60_000 ||
    identity.expiresAt <= now
  ) {
    throw new LocalAuthError(401, "AUTHENTICATION_REQUIRED", "The hosted identity is invalid");
  }
  const db = await readyDatabase();
  const rows = await db.prepare(
    `SELECT u.id AS user_id, m.org_id
       FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
       JOIN organizations o ON o.id = m.org_id AND o.status = 'active'
      WHERE u.issuer = ? AND u.subject = ? AND u.email = ? AND u.status = 'active'
      ORDER BY m.created_at, m.id`,
  ).bind(
    identity.issuer,
    identity.subject,
    identity.email.toLocaleLowerCase("en-US"),
  ).all<{ user_id: string; org_id: string }>();
  const memberships = rows.results ?? [];
  // A hosted identity may belong to more than one organization. Landing-org
  // selection is deterministic (earliest active membership); the user can move
  // between their organizations afterwards via the org switcher. Per-org
  // authorization is unchanged — every query still authorizes against the
  // active org. Zero memberships remains a hard IDENTITY_NOT_PROVISIONED.
  if (memberships.length === 0) {
    throw new LocalAuthError(
      403,
      "IDENTITY_NOT_PROVISIONED",
      "This identity does not have an active Sutra organization membership",
    );
  }
  const selected = memberships[0];
  return createSession(
    db,
    selected.user_id,
    selected.org_id,
    identity.authenticatedAt,
    now,
    Math.min(identity.expiresAt, now + 60 * 60 * 1000),
  );
}

function selfServeOrgName(identity: HostedIdentity): string {
  const candidate = (identity.displayName ?? "").trim().replace(/\s+/gu, " ");
  const base =
    candidate.length >= 2 && candidate.length <= 80 && !/[<>\u0000-\u001f\u007f]/u.test(candidate)
      ? candidate
      : identity.email;
  return `${base}'s organization`.slice(0, 100);
}

/**
 * Self-serve first-login provisioning. Creates a BRAND-NEW organization owned
 * solely by a verified OIDC identity, plus that identity's owner membership, and
 * issues a session scoped to the NEW org.
 *
 * Isolation invariants (all re-enforced here so they hold regardless of caller):
 *  - An existing identity is matched only by the FULL verified (issuer, subject)
 *    pair — never by email. Email is not an org key: two orgs may share an email
 *    domain, and the same address on two providers (two issuers) is two distinct
 *    identities. If that pair already exists, the request is REFUSED; it never
 *    creates a second org for it and never joins it to any existing org.
 *  - A brand-new identity only ever receives its OWN new org (a fresh org id and
 *    a single owner membership), so two distinct identities land in two distinct
 *    organizations with no shared rows.
 *  - The identity is re-validated exactly as loginHostedUser validates it.
 *
 * The OIDC callback invokes this ONLY when the separate self-serve signup switch
 * is enabled and loginHostedUser found no membership.
 */
export async function provisionSelfServeHostedOrg(
  identity: HostedIdentity,
  options: SelfServeSignupOptions = {},
): Promise<{ token: string; session: AuthenticatedLocalSession }> {
  const now = options.now ?? Date.now();
  if (
    !identity.issuer.startsWith("https://") ||
    identity.issuer.length > 2048 ||
    !/^[^\u0000-\u001f\u007f]{1,255}$/u.test(identity.subject) ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(identity.email) ||
    identity.authenticatedAt > now + 60_000 ||
    identity.expiresAt <= now
  ) {
    throw new LocalAuthError(401, "AUTHENTICATION_REQUIRED", "The hosted identity is invalid");
  }
  const email = identity.email.toLocaleLowerCase("en-US");
  const db = await readyDatabase();

  // (INFO-2a) Per-source signup rate limit FIRST, so every self-serve attempt
  // from a source is metered regardless of its outcome. Deny-by-default.
  await consumeSelfServeSignupBudget(db, {
    sourceKey: options.sourceKey ?? null,
    now,
    windowMs: options.rateWindowMs ?? SIGNUP_RATE_WINDOW_MS,
    maxPerWindow: options.maxSignupsPerWindow ?? MAX_SIGNUPS_PER_SOURCE_PER_WINDOW,
  });

  // (INFO-2b) OPTIONAL verified-email domain allowlist. Only enforced when the
  // caller passes a non-null list (from SUTRA_HOSTED_SIGNUP_ALLOWED_DOMAINS);
  // when null, no domain restriction. The domain is taken from the VERIFIED
  // OIDC email, never from anything the request supplied.
  const allowedDomains = options.allowedEmailDomains ?? null;
  if (allowedDomains !== null) {
    const domain = email.slice(email.lastIndexOf("@") + 1);
    if (domain.length === 0 || !allowedDomains.includes(domain)) {
      throw new LocalAuthError(403, "SIGNUP_DOMAIN_NOT_ALLOWED", "Self-service sign-up is not available for this email domain");
    }
  }

  const existing = await db.prepare(
    `SELECT id FROM users WHERE issuer = ? AND subject = ? LIMIT 1`,
  ).bind(identity.issuer, identity.subject).first<{ id: string }>();
  if (existing !== null) {
    // A known (issuer, subject) that reached self-serve did not resolve to one
    // active org above; self-serve must not paper over that by minting a second
    // org. Fail exactly as the invite-only path would for an unprovisioned user.
    throw new LocalAuthError(
      403,
      "IDENTITY_NOT_PROVISIONED",
      "This identity does not have one active Sutra organization membership",
    );
  }
  const orgId = opaqueId("org");
  const orgSlug = `org-${crypto.randomUUID().replaceAll("-", "")}`;
  const orgName = selfServeOrgName(identity);
  const userId = opaqueId("user");
  const membershipId = opaqueId("member");
  try {
    const results = await db.batch([
      db.prepare(
        `INSERT INTO organizations (id, slug, name, status, plan, created_at)
         VALUES (?, ?, ?, 'active', 'trial', ?)`,
      ).bind(orgId, orgSlug, orgName, now),
      db.prepare(
        `INSERT INTO users (id, issuer, subject, email, display_name, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      ).bind(userId, identity.issuer, identity.subject, email, identity.displayName, now),
      db.prepare(
        `INSERT INTO memberships (id, org_id, user_id, role, scope_mode, status, created_at)
         VALUES (?, ?, ?, 'org_owner', 'all_customers', 'active', ?)`,
      ).bind(membershipId, orgId, userId, now),
    ]);
    if (results.some((result) => Number(result.meta?.changes ?? 0) !== 1)) {
      throw new Error("Self-serve provisioning batch was incomplete");
    }
  } catch {
    // Lose the unique-index race (issuer+subject or issuer+email) rather than
    // duplicate: a concurrent first login for the same identity is refused.
    throw new LocalAuthError(409, "IDENTITY_NOT_PROVISIONED", "This identity could not be provisioned");
  }
  return createSession(
    db,
    userId,
    orgId,
    identity.authenticatedAt,
    now,
    Math.min(identity.expiresAt, now + 60 * 60 * 1000),
  );
}

export async function getLocalSession(
  token: string,
  now = Date.now(),
  options: { readonly withAvailableOrganizations?: boolean } = {},
): Promise<AuthenticatedLocalSession | null> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
  const db = await readyDatabase();
  const digest = await digestSessionToken(token);
  const row = await db.prepare(
    `SELECT s.id AS session_id, s.token_digest, s.expires_at, s.mfa_verified_at,
            u.id AS user_id, u.email, u.display_name,
            o.id AS org_id, o.slug AS org_slug, o.name AS org_name,
            o.plan AS org_plan,
            m.id AS membership_id, m.role AS membership_role, m.scope_mode,
            CASE WHEN u.issuer = ? THEN t.confirmed_at ELSE s.mfa_verified_at END AS mfa_confirmed_at
       FROM local_sessions s
       JOIN users u ON u.id = s.user_id AND u.status = 'active'
       JOIN organizations o ON o.id = s.selected_org_id AND o.status = 'active'
       JOIN memberships m ON m.user_id = u.id AND m.org_id = o.id AND m.status = 'active'
       LEFT JOIN totp_credentials t ON t.user_id = u.id
      WHERE s.token_digest = ? AND s.revoked_at IS NULL AND s.expires_at > ?
        AND s.last_seen_at > ?
      LIMIT 1`,
  ).bind(LOCAL_IDENTITY_ISSUER, digest, now, now - BROWSER_SESSION_IDLE_TTL_MS).first<SessionRow>();
  if (row === null) return null;
  await db.prepare(
    `UPDATE local_sessions SET last_seen_at = ?
      WHERE token_digest = ? AND revoked_at IS NULL AND expires_at > ?
        AND last_seen_at > ?
        AND last_seen_at < ?`,
  ).bind(now, digest, now, now - BROWSER_SESSION_IDLE_TTL_MS, now - 60_000).run();
  return sessionFromRow(db, row, options.withAvailableOrganizations ?? true);
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
