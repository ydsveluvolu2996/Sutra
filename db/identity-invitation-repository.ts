import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import {
  LocalAuthError,
  LOCAL_IDENTITY_ISSUER,
  createSession,
  loginHostedUser,
  type AuthenticatedLocalSession,
  type HostedIdentity,
} from "./auth-repository";
import { canonicalJson } from "../lib/canonical-json";
import type { InvitationDeliveryResult } from "../lib/invitation-delivery";
import { digestSessionToken, generateSessionToken, hashPassword, validatePassword } from "../lib/local-auth-crypto";
import {
  CUSTOMER_ROLES,
  isCustomerManageableRole,
  type MembershipManagementScope,
  type OrgRole,
  type ScopeMode,
} from "../lib/auth-policy";

const INVITABLE_ROLES = new Set<OrgRole>([
  "org_admin",
  "analyst",
  "viewer",
  "customer_admin",
  "customer_viewer",
]);
// Roles that may be attached to a single customer via `customer_access` when an
// invitation targets a specific customer. Organization roles (org_admin) can
// never be pinned to one customer this way.
const CUSTOMER_ACCESS_ROLES = new Set<OrgRole>(CUSTOMER_ROLES as readonly OrgRole[]);
const CUSTOMER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const MINIMUM_INVITATION_MS = 60 * 60 * 1000;
const MAXIMUM_INVITATION_MS = 7 * 24 * 60 * 60 * 1000;
const DELIVERY_RESULT_UNKNOWN_AFTER_MS = 60_000;
const DELIVERY_IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/u;

function forbidden(message: string): never {
  throw new LocalAuthError(403, "AUTHORIZATION_DENIED", message);
}

export interface IdentityInvitationSummary {
  readonly id: string;
  readonly email: string;
  readonly role: Exclude<OrgRole, "org_owner">;
  readonly scopeMode: ScopeMode;
  readonly customerId: string | null;
  readonly expiresAt: string;
  readonly status: "pending" | "accepted" | "revoked" | "expired";
  readonly delivery: IdentityInvitationDeliveryState;
  readonly createdAt: string;
}

export interface IdentityInvitationDeliveryState {
  readonly status: "not_attempted" | "sending" | "accepted" | "failed" | "unknown";
  readonly transport: "none" | "email-api";
  readonly provider: "none" | "resend" | "sendgrid" | "generic";
  readonly attempts: number;
  readonly lastAttemptedAt: string | null;
  readonly completedAt: string | null;
  readonly errorCode: string | null;
}

interface IdentityInvitationRow {
  readonly id: string;
  readonly email: string;
  readonly role: Exclude<OrgRole, "org_owner">;
  readonly scope_mode: ScopeMode;
  readonly customer_id: string | null;
  readonly expires_at: number;
  readonly accepted_at: number | null;
  readonly revoked_at: number | null;
  readonly created_at: number;
  readonly delivery_status: IdentityInvitationDeliveryState["status"];
  readonly delivery_transport: IdentityInvitationDeliveryState["transport"];
  readonly delivery_provider: IdentityInvitationDeliveryState["provider"];
  readonly delivery_attempts: number;
  readonly delivery_last_attempted_at: number | null;
  readonly delivery_completed_at: number | null;
  readonly delivery_error_code: string | null;
  readonly delivery_idempotency_digest: string | null;
  readonly delivery_revision: number;
}

export type IdentityInvitationOperationKind = "creation" | "initial_delivery" | "resend";

export interface CreateIdentityInvitationInput {
  readonly email: string;
  readonly role: OrgRole;
  readonly scopeMode: ScopeMode;
  readonly lifetimeMs: number;
  readonly customerId?: string | null;
  /** Optional exact OIDC issuer pin for federated invitation acceptance. */
  readonly allowedIssuer?: string | null;
}

interface IdentityInvitationOperationRow {
  readonly id: string;
  readonly org_id: string;
  readonly operation_kind: IdentityInvitationOperationKind;
  readonly idempotency_scope_id: string;
  readonly invitation_id: string | null;
  readonly idempotency_digest: string;
  readonly request_fingerprint: string;
  readonly operation_status: "claimed" | "completed";
  readonly outcome_status: InvitationDeliveryResult["status"] | null;
  readonly delivery_transport: InvitationDeliveryResult["transport"];
  readonly delivery_provider: InvitationDeliveryResult["provider"];
  readonly delivery_error_code: string | null;
  readonly delivery_http_status: number | null;
  readonly created_at: number;
  readonly completed_at: number | null;
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

/**
 * Stable request binding shared by creation and delivery idempotency claims.
 * Callers pass plain JSON only; secrets and raw activation tokens must never be
 * included because the resulting digest is durable audit/control-plane state.
 */
export function identityInvitationOperationRequestFingerprint(
  operationKind: IdentityInvitationOperationKind,
  requestBody: unknown,
): Promise<string> {
  return sha256Hex(canonicalJson({ operationKind, requestBody }));
}

async function identityInvitationIdempotencyDigest(idempotencyKey: string): Promise<string> {
  if (!DELIVERY_IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new LocalAuthError(400, "INVALID_INPUT", "Provide a valid Idempotency-Key (16 to 128 safe characters)");
  }
  return sha256Hex(idempotencyKey);
}

function deliveryFromRow(row: IdentityInvitationRow, now: number): IdentityInvitationDeliveryState {
  const status = row.delivery_status === "sending" && row.delivery_last_attempted_at !== null
    && now - row.delivery_last_attempted_at > DELIVERY_RESULT_UNKNOWN_AFTER_MS
    ? "unknown"
    : row.delivery_status;
  return {
    status,
    transport: row.delivery_transport,
    provider: row.delivery_provider,
    attempts: row.delivery_attempts,
    lastAttemptedAt: row.delivery_last_attempted_at === null ? null : new Date(row.delivery_last_attempted_at).toISOString(),
    completedAt: row.delivery_completed_at === null ? null : new Date(row.delivery_completed_at).toISOString(),
    errorCode: row.delivery_error_code,
  };
}

function invitationFromRow(row: IdentityInvitationRow, now: number): IdentityInvitationSummary {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    scopeMode: row.scope_mode,
    customerId: row.customer_id,
    expiresAt: new Date(row.expires_at).toISOString(),
    status: row.revoked_at !== null
      ? "revoked"
      : row.accepted_at !== null
        ? "accepted"
        : row.expires_at <= now
          ? "expired"
          : "pending",
    delivery: deliveryFromRow(row, now),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const INVITATION_SUMMARY_COLUMNS = `id, email, role, scope_mode, customer_id, expires_at,
  accepted_at, revoked_at, created_at, delivery_status, delivery_transport,
  delivery_provider, delivery_attempts, delivery_last_attempted_at,
  delivery_completed_at, delivery_error_code, delivery_idempotency_digest,
  delivery_revision`;

const INVITATION_OPERATION_COLUMNS = `id, org_id, operation_kind, idempotency_scope_id,
  invitation_id, idempotency_digest, request_fingerprint, operation_status,
  outcome_status, delivery_transport, delivery_provider, delivery_error_code,
  delivery_http_status, created_at, completed_at`;

async function invitationOperationByKey(
  db: D1Database,
  orgId: string,
  invitationId: string,
  idempotencyDigest: string,
): Promise<IdentityInvitationOperationRow | null> {
  return db.prepare(
    `SELECT ${INVITATION_OPERATION_COLUMNS}
       FROM identity_invitation_operations
      WHERE org_id = ? AND invitation_id = ? AND idempotency_digest = ?
      LIMIT 1`,
  ).bind(orgId, invitationId, idempotencyDigest).first<IdentityInvitationOperationRow>();
}

async function creationOperationByKey(
  db: D1Database,
  orgId: string,
  actorId: string,
  idempotencyDigest: string,
): Promise<IdentityInvitationOperationRow | null> {
  return db.prepare(
    `SELECT ${INVITATION_OPERATION_COLUMNS}
       FROM identity_invitation_operations
      WHERE org_id = ? AND operation_kind = 'creation'
        AND idempotency_scope_id = ? AND idempotency_digest = ?
      LIMIT 1`,
  ).bind(orgId, actorId, idempotencyDigest).first<IdentityInvitationOperationRow>();
}

function assertMatchingOperationFingerprint(
  operation: IdentityInvitationOperationRow,
  requestFingerprint: string,
): void {
  if (operation.request_fingerprint !== requestFingerprint) {
    throw new LocalAuthError(
      409,
      "INVALID_INPUT",
      "This Idempotency-Key was already used with a different invitation operation",
    );
  }
}

function operationMatchesOutcome(
  operation: IdentityInvitationOperationRow,
  result: InvitationDeliveryResult,
): boolean {
  return operation.operation_status === "completed"
    && operation.outcome_status === result.status
    && operation.delivery_transport === result.transport
    && operation.delivery_provider === result.provider
    && operation.delivery_error_code === result.errorCode
    && operation.delivery_http_status === result.httpStatus;
}

async function invitationEventHash(input: {
  readonly invitationId: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly action:
    | "created"
    | "accepted"
    | "revoked"
    | "resent"
    | "delivery_started"
    | "delivery_accepted"
    | "delivery_failed"
    | "delivery_unknown";
  readonly occurredAt: number;
  readonly metadataJson: string;
  readonly previousEventHash: string | null;
}): Promise<string> {
  return sha256Hex(canonicalJson(input));
}

async function createIdentityInvitationInternal(
  authenticated: AuthenticatedLocalSession,
  scope: MembershipManagementScope,
  input: CreateIdentityInvitationInput,
  now = Date.now(),
  creationOperation?: {
    readonly idempotencyDigest: string;
    readonly requestFingerprint: string;
  },
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
  const requestedCustomerId =
    input.customerId === undefined || input.customerId === null || input.customerId === ""
      ? null
      : input.customerId;
  if (requestedCustomerId !== null && !CUSTOMER_ID.test(requestedCustomerId)) {
    throw new LocalAuthError(400, "INVALID_INPUT", "The invitation customer identifier is invalid");
  }
  // A customer id can only be attached to a role that is representable in
  // `customer_access`; an organization role is never pinned to one customer.
  if (requestedCustomerId !== null && !CUSTOMER_ACCESS_ROLES.has(input.role)) {
    throw new LocalAuthError(400, "INVALID_INPUT", "This role cannot be scoped to a single customer");
  }

  // (LOW-2) Validate and normalize the OPTIONAL issuer pin. An empty/absent value
  // leaves the invitation unpinned (accepted from any issuer, as before); a
  // present value must be a well-formed HTTPS issuer, matching how loginHostedUser
  // validates an identity's issuer.
  const allowedIssuer =
    input.allowedIssuer === undefined || input.allowedIssuer === null || input.allowedIssuer === ""
      ? null
      : input.allowedIssuer;
  if (
    allowedIssuer !== null &&
    (!allowedIssuer.startsWith("https://") || allowedIssuer.length > 2048 || /[\u0000-\u001f\u007f]/u.test(allowedIssuer))
  ) {
    throw new LocalAuthError(400, "INVALID_INPUT", "The invitation sign-in provider is invalid");
  }

  // ---- Scope enforcement (the security crux) --------------------------------
  // A customer-scoped administrator (membership:manage:customer only) may invite
  // ONLY into a customer they administer and ONLY with a customer-level role.
  const customerId = requestedCustomerId;
  if (scope.mode === "customer") {
    if (scope.customerIds.length === 0) {
      forbidden("This account does not administer any customer");
    }
    if (!isCustomerManageableRole(input.role)) {
      forbidden("A customer administrator may only invite customer_admin or customer_viewer users");
    }
    if (input.scopeMode !== "assigned_customers") {
      forbidden("A customer administrator may only invite customer-scoped members");
    }
    if (customerId === null || !scope.customerIds.includes(customerId)) {
      forbidden("The invitation must target a customer you administer");
    }
  }

  const db = await database();
  // Every attached customer must be a real, active customer in the actor's org.
  if (customerId !== null) {
    const customer = await db.prepare(
      `SELECT id FROM customers WHERE org_id = ? AND id = ? AND status != 'suspended' LIMIT 1`,
    ).bind(authenticated.subject.orgId, customerId).first<{ id: string }>();
    if (customer === null) {
      throw new LocalAuthError(400, "INVALID_INPUT", "The invitation customer is unavailable");
    }
  }

  const invitationId = opaqueId("invite");
  const eventId = opaqueId("invite_event");
  const operationId = creationOperation === undefined ? null : opaqueId("invite_operation");
  const token = generateSessionToken();
  const tokenDigest = await digestSessionToken(token);
  const expiresAt = now + input.lifetimeMs;
  // (LOW-2) The issuer pin is recorded in the invitation's IMMUTABLE created-event
  // metadata (the append-only identity_invitation_events row). It is only present
  // when the invitation is pinned, so an unpinned invitation's metadata — and its
  // event-hash chain — is byte-for-byte identical to before.
  const metadataJson = canonicalJson({
    email,
    role: input.role,
    scopeMode: input.scopeMode,
    customerId,
    expiresAt,
    ...(allowedIssuer === null ? {} : { allowedIssuer }),
  });
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
          (id, org_id, email, role, scope_mode, customer_id, token_digest, invited_by, expires_at,
           accepted_at, accepted_user_id, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
      ).bind(
        invitationId,
        authenticated.subject.orgId,
        email,
        input.role,
        input.scopeMode,
        customerId,
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
      ...(creationOperation === undefined || operationId === null ? [] : [
        db.prepare(
          `INSERT INTO identity_invitation_operations
            (id, org_id, operation_kind, idempotency_scope_id, invitation_id,
             idempotency_digest, request_fingerprint, operation_status, outcome_status,
             delivery_transport, delivery_provider, delivery_error_code,
             delivery_http_status, created_at, completed_at)
           VALUES (?, ?, 'creation', ?, ?, ?, ?, 'completed', NULL,
                   'none', 'none', NULL, NULL, ?, ?)`,
        ).bind(
          operationId,
          authenticated.subject.orgId,
          authenticated.subject.userId,
          invitationId,
          creationOperation.idempotencyDigest,
          creationOperation.requestFingerprint,
          now,
          now,
        ),
      ]),
    ]);
    if (results.some((result) => Number(result.meta?.changes ?? 0) !== 1)) throw new Error("Invitation batch was incomplete");
  } catch {
    // A uniqueness conflict on the active-email index is an actionable 409. Do
    // not classify every transaction failure that way: a database outage,
    // broken audit insert, or foreign-key failure must remain a server-side
    // persistence error so clients do not incorrectly abandon a safe retry.
    let active: { readonly id: string } | null;
    try {
      active = await db.prepare(
        `SELECT id FROM identity_invitations
          WHERE org_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL
          LIMIT 1`,
      ).bind(authenticated.subject.orgId, email).first<{ id: string }>();
    } catch {
      throw new LocalAuthError(500, "PERSISTENCE_FAILED", "The invitation could not be committed atomically");
    }
    if (active !== null) {
      throw new LocalAuthError(409, "INVALID_INPUT", "An active invitation already exists for this email address");
    }
    throw new LocalAuthError(500, "PERSISTENCE_FAILED", "The invitation could not be committed atomically");
  }
  return {
    invitation: {
      id: invitationId,
      email,
      role: input.role as Exclude<OrgRole, "org_owner">,
      scopeMode: input.scopeMode,
      customerId,
      expiresAt: new Date(expiresAt).toISOString(),
      status: "pending",
      delivery: {
        status: "not_attempted",
        transport: "none",
        provider: "none",
        attempts: 0,
        lastAttemptedAt: null,
        completedAt: null,
        errorCode: null,
      },
      createdAt: new Date(now).toISOString(),
    },
    token,
  };
}

export function createIdentityInvitation(
  authenticated: AuthenticatedLocalSession,
  scope: MembershipManagementScope,
  input: CreateIdentityInvitationInput,
  now = Date.now(),
): Promise<{ readonly invitation: IdentityInvitationSummary; readonly token: string }> {
  return createIdentityInvitationInternal(authenticated, scope, input, now);
}

/**
 * Creates an invitation once for an actor-scoped idempotency key. A replay can
 * return the durable invitation summary but never the plaintext bearer token;
 * the administrator must use the separately idempotent resend flow to rotate a
 * fresh token after a lost response.
 */
export async function createIdentityInvitationIdempotently(
  authenticated: AuthenticatedLocalSession,
  scope: MembershipManagementScope,
  input: CreateIdentityInvitationInput,
  idempotencyKey: string,
  now = Date.now(),
): Promise<{
  readonly invitation: IdentityInvitationSummary;
  readonly token: string | null;
  readonly replayed: boolean;
}> {
  const idempotencyDigest = await identityInvitationIdempotencyDigest(idempotencyKey);
  const normalizedRequest = {
    email: normalizedEmail(input.email),
    role: input.role,
    scopeMode: input.scopeMode,
    lifetimeMs: input.lifetimeMs,
    customerId: input.customerId === undefined || input.customerId === null || input.customerId === ""
      ? null
      : input.customerId,
    allowedIssuer: input.allowedIssuer === undefined || input.allowedIssuer === null || input.allowedIssuer === ""
      ? null
      : input.allowedIssuer,
  };
  const requestFingerprint = await identityInvitationOperationRequestFingerprint(
    "creation",
    normalizedRequest,
  );
  const db = await database();
  const replay = async (operation: IdentityInvitationOperationRow) => {
    assertMatchingOperationFingerprint(operation, requestFingerprint);
    if (operation.operation_status !== "completed" || operation.invitation_id === null) {
      throw new LocalAuthError(409, "INVALID_INPUT", "The invitation creation operation is still in progress");
    }
    return {
      invitation: invitationFromRow(
        await scopedInvitation(db, authenticated, scope, operation.invitation_id),
        now,
      ),
      token: null,
      replayed: true,
    } as const;
  };
  const prior = await creationOperationByKey(
    db,
    authenticated.subject.orgId,
    authenticated.subject.userId,
    idempotencyDigest,
  );
  if (prior !== null) return replay(prior);

  try {
    const created = await createIdentityInvitationInternal(authenticated, scope, input, now, {
      idempotencyDigest,
      requestFingerprint,
    });
    return { ...created, replayed: false };
  } catch (error) {
    const raced = await creationOperationByKey(
      db,
      authenticated.subject.orgId,
      authenticated.subject.userId,
      idempotencyDigest,
    );
    if (raced !== null) return replay(raced);
    throw error;
  }
}

export async function listIdentityInvitations(
  authenticated: AuthenticatedLocalSession,
  scope: MembershipManagementScope,
  now = Date.now(),
): Promise<readonly IdentityInvitationSummary[]> {
  // A customer-scoped administrator only ever sees invitations bound to the
  // customers they administer; org-wide invitations and other customers stay
  // invisible. An empty administered set therefore lists nothing.
  if (scope.mode === "customer" && scope.customerIds.length === 0) return [];
  const db = await database();
  const customerFilter =
    scope.mode === "customer"
      ? ` AND customer_id IN (${scope.customerIds.map(() => "?").join(", ")})`
      : "";
  const result = await db.prepare(
    `SELECT ${INVITATION_SUMMARY_COLUMNS}
       FROM identity_invitations
      WHERE org_id = ?${customerFilter}
      ORDER BY created_at DESC, id DESC
      LIMIT 200`,
  ).bind(
    authenticated.subject.orgId,
    ...(scope.mode === "customer" ? scope.customerIds : []),
  ).all<IdentityInvitationRow>();
  return (result.results ?? []).map((row) => invitationFromRow(row, now));
}

async function scopedInvitation(
  db: D1Database,
  authenticated: AuthenticatedLocalSession,
  scope: MembershipManagementScope,
  invitationId: string,
): Promise<IdentityInvitationRow> {
  if (!/^invite_[a-f0-9]{32}$/u.test(invitationId)) {
    throw new LocalAuthError(400, "INVALID_INPUT", "The invitation identifier is invalid");
  }
  const row = await db.prepare(
    `SELECT ${INVITATION_SUMMARY_COLUMNS}
       FROM identity_invitations WHERE id = ? AND org_id = ? LIMIT 1`,
  ).bind(invitationId, authenticated.subject.orgId).first<IdentityInvitationRow>();
  if (row === null) throw new LocalAuthError(404, "INVALID_INPUT", "The invitation is unavailable");
  if (
    scope.mode === "customer"
    && (row.customer_id === null || !scope.customerIds.includes(row.customer_id))
  ) {
    forbidden("This account cannot manage an invitation outside its administered customers");
  }
  return row;
}

export interface BegunIdentityInvitationDelivery {
  readonly invitation: IdentityInvitationSummary;
  /** Present only for a newly rotated resend token; never persisted. */
  readonly token: string | null;
  readonly replayed: boolean;
}

/**
 * Claims one delivery attempt. Repeating the same idempotency key never rotates
 * the invitation token and never authorizes a second send. A resend appends a
 * hash-chained `resent` event while persisting only the new token digest.
 */
export async function beginIdentityInvitationDelivery(
  authenticated: AuthenticatedLocalSession,
  scope: MembershipManagementScope,
  input: {
    readonly invitationId: string;
    readonly idempotencyKey: string;
    readonly rotateToken: boolean;
    readonly lifetimeMs?: number;
  },
  now = Date.now(),
): Promise<BegunIdentityInvitationDelivery> {
  if (
    input.rotateToken
    && (!Number.isSafeInteger(input.lifetimeMs) || (input.lifetimeMs as number) < MINIMUM_INVITATION_MS
      || (input.lifetimeMs as number) > MAXIMUM_INVITATION_MS)
  ) {
    throw new LocalAuthError(400, "INVALID_INPUT", "The invitation lifetime is invalid");
  }

  const db = await database();
  const current = await scopedInvitation(db, authenticated, scope, input.invitationId);
  const operationKind: IdentityInvitationOperationKind = input.rotateToken ? "resend" : "initial_delivery";
  const idempotencyDigest = await identityInvitationIdempotencyDigest(input.idempotencyKey);
  const requestFingerprint = await identityInvitationOperationRequestFingerprint(operationKind, {
    invitationId: input.invitationId,
    ...(input.rotateToken ? { lifetimeMs: input.lifetimeMs } : {}),
  });
  const priorOperation = await invitationOperationByKey(
    db,
    authenticated.subject.orgId,
    input.invitationId,
    idempotencyDigest,
  );
  if (priorOperation !== null) {
    assertMatchingOperationFingerprint(priorOperation, requestFingerprint);
    return { invitation: invitationFromRow(current, now), token: null, replayed: true };
  }
  if (current.accepted_at !== null || current.revoked_at !== null) {
    throw new LocalAuthError(409, "INVALID_INPUT", "Only a pending or expired invitation can be sent again");
  }
  if (
    current.delivery_status === "sending"
    && current.delivery_last_attempted_at !== null
    && now - current.delivery_last_attempted_at <= DELIVERY_RESULT_UNKNOWN_AFTER_MS
  ) {
    throw new LocalAuthError(409, "INVALID_INPUT", "Another invitation delivery attempt is still in progress");
  }

  const previous = await db.prepare(
    `SELECT event_hash FROM identity_invitation_events
      WHERE invitation_id = ? AND org_id = ?
      ORDER BY occurred_at DESC, id DESC LIMIT 1`,
  ).bind(input.invitationId, authenticated.subject.orgId).first<{ event_hash: string }>();
  if (previous === null) throw new LocalAuthError(404, "INVALID_INPUT", "The invitation is unavailable");

  const expectedRevision = current.delivery_revision;
  const nextRevision = expectedRevision + 1;
  const operationId = opaqueId("invite_operation");
  const eventId = opaqueId("invite_event");
  const expiresAt = input.rotateToken ? now + (input.lifetimeMs as number) : current.expires_at;
  const eventAction = input.rotateToken ? "resent" : "delivery_started";
  const metadataJson = canonicalJson(input.rotateToken
    ? { expiresAt, deliveryIdempotencyDigest: idempotencyDigest }
    : { deliveryAttempt: current.delivery_attempts + 1, deliveryIdempotencyDigest: idempotencyDigest });
  const eventHash = await invitationEventHash({
    invitationId: input.invitationId,
    orgId: authenticated.subject.orgId,
    actorId: authenticated.subject.userId,
    action: eventAction,
    occurredAt: now,
    metadataJson,
    previousEventHash: previous.event_hash,
  });

  let token: string | null = null;
  let tokenDigest: string | null = null;
  if (input.rotateToken) {
    token = generateSessionToken();
    tokenDigest = await digestSessionToken(token);
  }

  const update = input.rotateToken
    ? db.prepare(
        `UPDATE identity_invitations
            SET token_digest = ?, expires_at = ?, delivery_status = 'sending',
                delivery_transport = 'none', delivery_provider = 'none',
                delivery_attempts = delivery_attempts + 1, delivery_last_attempted_at = ?,
                delivery_completed_at = NULL, delivery_error_code = NULL, delivery_http_status = NULL,
                delivery_idempotency_digest = ?, delivery_revision = delivery_revision + 1
          WHERE id = ? AND org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
            AND delivery_revision = ?
            AND (delivery_status != 'sending' OR delivery_last_attempted_at IS NULL
              OR delivery_last_attempted_at <= ?)`,
      ).bind(
        tokenDigest,
        expiresAt,
        now,
        idempotencyDigest,
        input.invitationId,
        authenticated.subject.orgId,
        expectedRevision,
        now - DELIVERY_RESULT_UNKNOWN_AFTER_MS,
      )
    : db.prepare(
        `UPDATE identity_invitations
            SET delivery_status = 'sending', delivery_transport = 'none', delivery_provider = 'none',
                delivery_attempts = delivery_attempts + 1, delivery_last_attempted_at = ?,
                delivery_completed_at = NULL, delivery_error_code = NULL, delivery_http_status = NULL,
                delivery_idempotency_digest = ?, delivery_revision = delivery_revision + 1
          WHERE id = ? AND org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
            AND delivery_revision = ?
            AND (delivery_status != 'sending' OR delivery_last_attempted_at IS NULL
              OR delivery_last_attempted_at <= ?)`,
      ).bind(
        now,
        idempotencyDigest,
        input.invitationId,
        authenticated.subject.orgId,
        expectedRevision,
        now - DELIVERY_RESULT_UNKNOWN_AFTER_MS,
      );

  let results: readonly D1Result<unknown>[];
  try {
    results = await db.batch([
      update,
      db.prepare(
        `INSERT INTO identity_invitation_operations
          (id, org_id, operation_kind, idempotency_scope_id, invitation_id,
           idempotency_digest, request_fingerprint, operation_status, outcome_status,
           delivery_transport, delivery_provider, delivery_error_code,
           delivery_http_status, created_at, completed_at)
         SELECT ?, org_id, ?, id, id, ?, ?, 'claimed', NULL,
                'none', 'none', NULL, NULL, ?, NULL
           FROM identity_invitations
          WHERE id = ? AND org_id = ? AND delivery_revision = ?
            AND delivery_status = 'sending' AND delivery_last_attempted_at = ?
            AND delivery_idempotency_digest = ?`,
      ).bind(
        operationId,
        operationKind,
        idempotencyDigest,
        requestFingerprint,
        now,
        input.invitationId,
        authenticated.subject.orgId,
        nextRevision,
        now,
        idempotencyDigest,
      ),
      db.prepare(
        `INSERT INTO identity_invitation_events
          (id, invitation_id, org_id, actor_id, action, occurred_at, metadata_json,
           previous_event_hash, event_hash)
         SELECT ?, id, org_id, ?, ?, ?, ?, ?, ?
           FROM identity_invitations
          WHERE id = ? AND org_id = ? AND delivery_revision = ?
            AND delivery_status = 'sending' AND delivery_last_attempted_at = ?
            AND delivery_idempotency_digest = ?`,
      ).bind(
        eventId,
        authenticated.subject.userId,
        eventAction,
        now,
        metadataJson,
        previous.event_hash,
        eventHash,
        input.invitationId,
        authenticated.subject.orgId,
        nextRevision,
        now,
        idempotencyDigest,
      ),
    ]);
  } catch {
    const racedOperation = await invitationOperationByKey(
      db,
      authenticated.subject.orgId,
      input.invitationId,
      idempotencyDigest,
    );
    if (racedOperation !== null) {
      assertMatchingOperationFingerprint(racedOperation, requestFingerprint);
      return {
        invitation: invitationFromRow(await scopedInvitation(db, authenticated, scope, input.invitationId), now),
        token: null,
        replayed: true,
      };
    }
    throw new LocalAuthError(409, "INVALID_INPUT", "The invitation changed while delivery was starting");
  }
  if (results.some((result) => Number(result.meta?.changes ?? 0) !== 1)) {
    const racedOperation = await invitationOperationByKey(
      db,
      authenticated.subject.orgId,
      input.invitationId,
      idempotencyDigest,
    );
    if (racedOperation !== null) {
      assertMatchingOperationFingerprint(racedOperation, requestFingerprint);
      return {
        invitation: invitationFromRow(await scopedInvitation(db, authenticated, scope, input.invitationId), now),
        token: null,
        replayed: true,
      };
    }
    throw new LocalAuthError(409, "INVALID_INPUT", "The invitation changed while delivery was starting");
  }
  const started = await scopedInvitation(db, authenticated, scope, input.invitationId);
  return { invitation: invitationFromRow(started, now), token, replayed: false };
}

/** Persists only a bounded outcome classification; provider bodies and tokens are never stored. */
export async function completeIdentityInvitationDelivery(
  authenticated: AuthenticatedLocalSession,
  scope: MembershipManagementScope,
  invitationId: string,
  idempotencyKey: string,
  result: InvitationDeliveryResult,
  now = Date.now(),
): Promise<IdentityInvitationSummary> {
  const db = await database();
  const current = await scopedInvitation(db, authenticated, scope, invitationId);
  const digest = await identityInvitationIdempotencyDigest(idempotencyKey);
  const operation = await invitationOperationByKey(
    db,
    authenticated.subject.orgId,
    invitationId,
    digest,
  );
  if (operation === null) {
    throw new LocalAuthError(409, "INVALID_INPUT", "The invitation delivery operation is unavailable");
  }
  if (operation.operation_status === "completed") {
    if (!operationMatchesOutcome(operation, result)) {
      throw new LocalAuthError(409, "INVALID_INPUT", "The invitation delivery operation already has a different outcome");
    }
    return invitationFromRow(current, now);
  }
  if (current.delivery_status !== "sending" || current.delivery_idempotency_digest !== digest) {
    throw new LocalAuthError(409, "INVALID_INPUT", "A newer invitation delivery attempt is active");
  }
  const previous = await db.prepare(
    `SELECT event_hash FROM identity_invitation_events
      WHERE invitation_id = ? AND org_id = ?
      ORDER BY occurred_at DESC, id DESC LIMIT 1`,
  ).bind(invitationId, authenticated.subject.orgId).first<{ event_hash: string }>();
  if (previous === null) throw new LocalAuthError(404, "INVALID_INPUT", "The invitation is unavailable");
  const eventId = opaqueId("invite_event");
  const action = `delivery_${result.status}` as
    "delivery_accepted" | "delivery_failed" | "delivery_unknown";
  const metadataJson = canonicalJson({
    deliveryIdempotencyDigest: digest,
    status: result.status,
    transport: result.transport,
    provider: result.provider,
    errorCode: result.errorCode,
    httpStatus: result.httpStatus,
  });
  const eventHash = await invitationEventHash({
    invitationId,
    orgId: authenticated.subject.orgId,
    actorId: authenticated.subject.userId,
    action,
    occurredAt: now,
    metadataJson,
    previousEventHash: previous.event_hash,
  });
  const nextRevision = current.delivery_revision + 1;
  let results: readonly D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare(
        `UPDATE identity_invitations
            SET delivery_status = ?, delivery_transport = ?, delivery_provider = ?,
                delivery_completed_at = ?, delivery_error_code = ?, delivery_http_status = ?,
                delivery_revision = delivery_revision + 1
          WHERE id = ? AND org_id = ? AND delivery_status = 'sending'
            AND delivery_idempotency_digest = ? AND delivery_revision = ?`,
      ).bind(
        result.status,
        result.transport,
        result.provider,
        now,
        result.errorCode,
        result.httpStatus,
        invitationId,
        authenticated.subject.orgId,
        digest,
        current.delivery_revision,
      ),
      db.prepare(
        `UPDATE identity_invitation_operations
            SET operation_status = 'completed', outcome_status = ?,
                delivery_transport = ?, delivery_provider = ?, delivery_error_code = ?,
                delivery_http_status = ?, completed_at = ?
          WHERE id = ? AND org_id = ? AND invitation_id = ?
            AND idempotency_digest = ? AND operation_status = 'claimed'`,
      ).bind(
        result.status,
        result.transport,
        result.provider,
        result.errorCode,
        result.httpStatus,
        now,
        operation.id,
        authenticated.subject.orgId,
        invitationId,
        digest,
      ),
      db.prepare(
        `INSERT INTO identity_invitation_events
          (id, invitation_id, org_id, actor_id, action, occurred_at, metadata_json,
           previous_event_hash, event_hash)
         SELECT ?, i.id, i.org_id, ?, ?, ?, ?, ?, ?
           FROM identity_invitations i
           JOIN identity_invitation_operations operation
             ON operation.id = ? AND operation.org_id = i.org_id
            AND operation.invitation_id = i.id
          WHERE i.id = ? AND i.org_id = ? AND i.delivery_status = ?
            AND i.delivery_completed_at = ? AND i.delivery_idempotency_digest = ?
            AND i.delivery_revision = ? AND operation.operation_status = 'completed'
            AND operation.outcome_status = ?`,
      ).bind(
        eventId,
        authenticated.subject.userId,
        action,
        now,
        metadataJson,
        previous.event_hash,
        eventHash,
        operation.id,
        invitationId,
        authenticated.subject.orgId,
        result.status,
        now,
        digest,
        nextRevision,
        result.status,
      ),
    ]);
  } catch {
    const afterFailure = await invitationOperationByKey(
      db,
      authenticated.subject.orgId,
      invitationId,
      digest,
    );
    if (afterFailure !== null && operationMatchesOutcome(afterFailure, result)) {
      return invitationFromRow(await scopedInvitation(db, authenticated, scope, invitationId), now);
    }
    throw new LocalAuthError(409, "INVALID_INPUT", "The invitation changed while delivery was completing");
  }
  if (results.some((updated) => Number(updated.meta?.changes ?? 0) !== 1)) {
    const afterRace = await invitationOperationByKey(
      db,
      authenticated.subject.orgId,
      invitationId,
      digest,
    );
    if (afterRace !== null && operationMatchesOutcome(afterRace, result)) {
      return invitationFromRow(await scopedInvitation(db, authenticated, scope, invitationId), now);
    }
    throw new LocalAuthError(409, "INVALID_INPUT", "The invitation changed while delivery was completing");
  }
  return invitationFromRow(await scopedInvitation(db, authenticated, scope, invitationId), now);
}

export async function revokeIdentityInvitation(
  authenticated: AuthenticatedLocalSession,
  scope: MembershipManagementScope,
  invitationId: string,
  now = Date.now(),
): Promise<void> {
  if (!/^invite_[a-f0-9]{32}$/u.test(invitationId)) {
    throw new LocalAuthError(400, "INVALID_INPUT", "The invitation identifier is invalid");
  }
  const db = await database();
  // A customer-scoped administrator may only revoke invitations bound to a
  // customer they administer. Resolve the target's customer first and fail
  // closed on anything outside the administered set.
  if (scope.mode === "customer") {
    const target = await db.prepare(
      `SELECT customer_id FROM identity_invitations WHERE id = ? AND org_id = ? LIMIT 1`,
    ).bind(invitationId, authenticated.subject.orgId).first<{ customer_id: string | null }>();
    if (target === null) throw new LocalAuthError(404, "INVALID_INPUT", "The invitation is unavailable");
    if (target.customer_id === null || !scope.customerIds.includes(target.customer_id)) {
      forbidden("This account cannot revoke an invitation outside its administered customers");
    }
  }
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
    `SELECT i.id, i.org_id, i.role, i.scope_mode, i.customer_id, e.event_hash,
            (SELECT created.metadata_json FROM identity_invitation_events created
              WHERE created.invitation_id = i.id AND created.action = 'created'
              ORDER BY created.occurred_at ASC, created.id ASC LIMIT 1) AS metadata_json
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
    customer_id: string | null;
    event_hash: string;
    metadata_json: string;
  }>();
  if (invitation === null) {
    throw new LocalAuthError(401, "AUTHENTICATION_REQUIRED", "The invitation is invalid, expired, or already used");
  }

  // (LOW-2) If the invitation was pinned to a specific issuer/provider at create
  // time, require the VERIFIED identity's issuer to match EXACTLY. A token from a
  // different federated IdP — even with the right invitation token and email —
  // cannot accept a pinned invitation. Unpinned invitations (no allowedIssuer in
  // the created-event metadata) behave exactly as before.
  let pinnedIssuer: string | null = null;
  try {
    const parsed = JSON.parse(invitation.metadata_json) as { readonly allowedIssuer?: unknown };
    if (typeof parsed.allowedIssuer === "string" && parsed.allowedIssuer.length > 0) {
      pinnedIssuer = parsed.allowedIssuer;
    }
  } catch {
    pinnedIssuer = null;
  }
  if (pinnedIssuer !== null && identity.issuer !== pinnedIssuer) {
    throw new LocalAuthError(401, "IDENTITY_ISSUER_MISMATCH", "This invitation is bound to a different sign-in provider");
  }
  const userId = opaqueId("user");
  const membershipId = opaqueId("member");
  const eventId = opaqueId("invite_event");
  // A customer-scoped invitation materializes exactly one `customer_access`
  // grant on the accepted membership so the invited user lands scoped to the
  // customer the invitation named — nothing broader.
  const grantsCustomerAccess =
    invitation.customer_id !== null && CUSTOMER_ACCESS_ROLES.has(invitation.role);
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
  const statements: D1PreparedStatement[] = [
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
  ];
  if (grantsCustomerAccess) {
    statements.push(
      db.prepare(
        `INSERT INTO customer_access (id, org_id, customer_id, membership_id, role, created_at)
         SELECT ?, i.org_id, i.customer_id, ?, i.role, ?
           FROM identity_invitations i
          WHERE i.id = ? AND i.accepted_at = ? AND i.accepted_user_id = ? AND i.customer_id IS NOT NULL`,
      ).bind(`access_${crypto.randomUUID().replaceAll("-", "")}`, membershipId, now, invitation.id, now, userId),
    );
  }
  let results: D1Result<unknown>[];
  try {
    results = await db.batch(statements);
  } catch {
    throw new LocalAuthError(409, "IDENTITY_NOT_PROVISIONED", "The invited identity could not be activated");
  }
  if (results.some((result) => Number(result.meta?.changes ?? 0) !== 1)) {
    throw new LocalAuthError(401, "AUTHENTICATION_REQUIRED", "The invitation was already used or revoked");
  }
  return loginHostedUser(identity, now);
}

export interface PasswordInvitationPreview {
  readonly email: string;
  readonly organizationName: string;
}

/**
 * Reads the (email, org) an invitation is for, so the accept-invite page can
 * greet the invitee. The token itself is the bearer secret; an invalid, used,
 * revoked or expired token returns null (the route maps that to a 404) and never
 * discloses whether the token merely expired versus never existed.
 */
export async function previewPasswordInvitation(
  token: string,
  now = Date.now(),
): Promise<PasswordInvitationPreview | null> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
  const db = await database();
  const tokenDigest = await digestSessionToken(token);
  const row = await db.prepare(
    `SELECT i.email, o.name AS org_name
       FROM identity_invitations i
       JOIN organizations o ON o.id = i.org_id AND o.status = 'active'
      WHERE i.token_digest = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?
      LIMIT 1`,
  ).bind(tokenDigest, now).first<{ email: string; org_name: string }>().catch(() => null);
  if (row === null || row === undefined) return null;
  return { email: row.email, organizationName: row.org_name };
}

/**
 * Accepts an invitation as a LOCAL PASSWORD identity — the network-reachable
 * counterpart to {@link acceptIdentityInvitation} (which provisions federated
 * OIDC identities). The invitee proves possession of the one-time invitation
 * token, chooses their own password (verified only over TLS), and is provisioned
 * into EXACTLY the org, role, and single customer the invitation named — the
 * same isolation mapping as the OIDC path, re-enforced here.
 *
 * Security properties:
 *  - The whole provision is gated on winning the atomic accept race (the same
 *    UPDATE ... WHERE accepted_at IS NULL / INSERT ... SELECT WHERE accepted_at
 *    pattern as the OIDC path), so a token can be redeemed at most once.
 *  - An invitation PINNED to an OIDC issuer is refused here: it is meant for a
 *    federated provider and must not be redeemable with a password.
 *  - The new session is issued with NO confirmed MFA (`mfaVerifiedAt = null`);
 *    `requireMfa` therefore blocks every workspace/data route until the invitee
 *    enrolls and verifies a second factor, so a password identity is never
 *    usable on the network with a single factor.
 */
export async function acceptPasswordInvitation(
  token: string,
  input: { readonly password: unknown; readonly displayName: unknown },
  now = Date.now(),
): Promise<{ token: string; session: AuthenticatedLocalSession; mfaEnrollmentRequired: boolean }> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new LocalAuthError(401, "AUTHENTICATION_REQUIRED", "The invitation is invalid");
  }
  if (
    typeof input.displayName !== "string" ||
    input.displayName.trim().length < 2 ||
    input.displayName.trim().length > 80 ||
    /[<>\u0000-\u001f\u007f]/u.test(input.displayName)
  ) {
    throw new LocalAuthError(400, "INVALID_INPUT", "Enter your full name (2 to 80 characters)");
  }
  const displayName = input.displayName.trim().replace(/\s+/gu, " ");
  const db = await database();
  const tokenDigest = await digestSessionToken(token);
  const invitation = await db.prepare(
    `SELECT i.id, i.org_id, i.email, i.role, i.scope_mode, i.customer_id, e.event_hash,
            (SELECT created.metadata_json FROM identity_invitation_events created
              WHERE created.invitation_id = i.id AND created.action = 'created'
              ORDER BY created.occurred_at ASC, created.id ASC LIMIT 1) AS metadata_json
       FROM identity_invitations i
       JOIN identity_invitation_events e ON e.invitation_id = i.id
      WHERE i.token_digest = ? AND i.accepted_at IS NULL
        AND i.revoked_at IS NULL AND i.expires_at > ?
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT 1`,
  ).bind(tokenDigest, now).first<{
    id: string;
    org_id: string;
    email: string;
    role: OrgRole;
    scope_mode: ScopeMode;
    customer_id: string | null;
    event_hash: string;
    metadata_json: string;
  }>();
  if (invitation === null) {
    throw new LocalAuthError(401, "AUTHENTICATION_REQUIRED", "The invitation is invalid, expired, or already used");
  }

  // An invitation pinned to a specific OIDC issuer is federated-only; it must
  // never be redeemable with a password (that would bypass the provider pin).
  try {
    const parsed = JSON.parse(invitation.metadata_json) as { readonly allowedIssuer?: unknown };
    if (typeof parsed.allowedIssuer === "string" && parsed.allowedIssuer.length > 0) {
      throw new LocalAuthError(401, "IDENTITY_ISSUER_MISMATCH", "This invitation must be accepted with its sign-in provider");
    }
  } catch (error) {
    if (error instanceof LocalAuthError) throw error;
    // Malformed metadata falls through to unpinned; the accept race + hash chain
    // below still protect integrity.
  }

  const email = invitation.email;
  let password: string;
  try {
    password = validatePassword(input.password, email);
  } catch (error) {
    throw new LocalAuthError(400, "INVALID_INPUT", error instanceof Error ? error.message : "Enter a valid password");
  }
  // Refuse if a local identity already exists for this email (a re-used invite
  // email or a second accept attempt). The unique index is the ultimate guard;
  // this returns a clean error before the expensive hash.
  const existing = await db.prepare(
    `SELECT id FROM users WHERE issuer = ? AND email = ? LIMIT 1`,
  ).bind(LOCAL_IDENTITY_ISSUER, email).first<{ id: string }>();
  if (existing !== null) {
    throw new LocalAuthError(409, "INVALID_INPUT", "An account for this invitation already exists");
  }
  const digest = await hashPassword(password);

  const userId = opaqueId("user");
  const membershipId = opaqueId("member");
  const eventId = opaqueId("invite_event");
  const grantsCustomerAccess =
    invitation.customer_id !== null && CUSTOMER_ACCESS_ROLES.has(invitation.role);
  const metadataJson = canonicalJson({ issuer: LOCAL_IDENTITY_ISSUER, subject: email });
  const eventHash = await invitationEventHash({
    invitationId: invitation.id,
    orgId: invitation.org_id,
    actorId: userId,
    action: "accepted",
    occurredAt: now,
    metadataJson,
    previousEventHash: invitation.event_hash,
  });
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `UPDATE identity_invitations
          SET accepted_at = ?, accepted_user_id = ?
        WHERE id = ? AND token_digest = ? AND accepted_at IS NULL
          AND accepted_user_id IS NULL AND revoked_at IS NULL AND expires_at > ?`,
    ).bind(now, userId, invitation.id, tokenDigest, now),
    db.prepare(
      `INSERT INTO users (id, issuer, subject, email, display_name, status, created_at)
       SELECT ?, ?, email, email, ?, 'active', ?
         FROM identity_invitations
        WHERE id = ? AND accepted_at = ? AND accepted_user_id = ?`,
    ).bind(userId, LOCAL_IDENTITY_ISSUER, displayName, now, invitation.id, now, userId),
    db.prepare(
      `INSERT INTO local_password_credentials
         (user_id, algorithm, iterations, salt, password_hash, failed_attempts, locked_until, changed_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 0, NULL, ?, ?
         FROM identity_invitations
        WHERE id = ? AND accepted_at = ? AND accepted_user_id = ?`,
    ).bind(userId, digest.algorithm, digest.iterations, digest.salt, digest.hash, now, now, invitation.id, now, userId),
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
    ).bind(eventId, userId, now, metadataJson, invitation.event_hash, eventHash, invitation.id, now, userId),
  ];
  if (grantsCustomerAccess) {
    statements.push(
      db.prepare(
        `INSERT INTO customer_access (id, org_id, customer_id, membership_id, role, created_at)
         SELECT ?, i.org_id, i.customer_id, ?, i.role, ?
           FROM identity_invitations i
          WHERE i.id = ? AND i.accepted_at = ? AND i.accepted_user_id = ? AND i.customer_id IS NOT NULL`,
      ).bind(`access_${crypto.randomUUID().replaceAll("-", "")}`, membershipId, now, invitation.id, now, userId),
    );
  }
  let results: D1Result<unknown>[];
  try {
    results = await db.batch(statements);
  } catch {
    throw new LocalAuthError(409, "IDENTITY_NOT_PROVISIONED", "The invited account could not be activated");
  }
  if (results.some((result) => Number(result.meta?.changes ?? 0) !== 1)) {
    throw new LocalAuthError(401, "AUTHENTICATION_REQUIRED", "The invitation was already used or revoked");
  }
  // No confirmed MFA yet -> enrollment-required session. requireMfa gates all
  // workspace/data access until the invitee enrolls and verifies a second factor.
  const created = await createSession(db, userId, invitation.org_id, null, now);
  return { ...created, mfaEnrollmentRequired: true };
}
