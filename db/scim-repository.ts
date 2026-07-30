import { LocalAuthError } from "./auth-repository";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import { canonicalJson } from "../lib/canonical-json";
import {
  SCIM_GROUP_SCHEMA,
  SCIM_USER_SCHEMA,
  ScimError,
  type ScimFilter,
  type ScimPagination,
} from "../lib/scim-protocol";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTOR_ID = /^scimc_[a-f0-9]{32}$/u;
const USER_ID = /^scimu_[a-f0-9]{32}$/u;
const GROUP_ID = /^scimg_[a-f0-9]{32}$/u;
const TOKEN_VALUE = /^sutra_scim_[a-f0-9]{64}$/u;
const TOKEN_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._:/-]{0,63}$/u;
const MAX_CONNECTORS_PER_ORG = 10;
const MAX_GROUP_MEMBERS = 100;

export const SCIM_MAPPABLE_ROLES = ["viewer", "analyst"] as const;
export type ScimMappableRole = (typeof SCIM_MAPPABLE_ROLES)[number];
export type ScimSubjectSource = "userName" | "externalId";
export type ScimRoleMappings = Readonly<Record<string, ScimMappableRole>>;

export interface ScimConnectorContext {
  readonly id: string;
  readonly orgId: string;
  readonly identityIssuer: string;
  readonly subjectSource: ScimSubjectSource;
  readonly roleMappings: ScimRoleMappings;
}

export interface ScimConnectorSummary {
  readonly id: string;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly identityIssuer: string;
  readonly subjectSource: ScimSubjectSource;
  readonly roleMappings: ScimRoleMappings;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly rotatedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface MintedScimConnector extends ScimConnectorSummary {
  /** Returned exactly once. Only its SHA-256 digest is persisted. */
  readonly token: string;
}

export interface ScimUserInput {
  readonly userName: string;
  readonly displayName: string;
  readonly externalId: string | null;
  readonly active: boolean;
}

export interface ScimGroupInput {
  readonly displayName: string;
  readonly externalId: string | null;
  readonly memberIds: readonly string[];
}

interface ConnectorRow {
  id: string;
  org_id: string;
  name: string;
  token_prefix: string;
  identity_issuer: string;
  subject_source: ScimSubjectSource;
  role_mappings_json: string;
  expires_at: number | null;
  last_used_at: number | null;
  rotated_at: number | null;
  revoked_at: number | null;
  created_by: string;
  created_at: number;
}

interface UserRow {
  id: string;
  external_id: string | null;
  version: number;
  created_at: number;
  updated_at: number;
  user_id: string;
  email: string;
  display_name: string | null;
  user_status: string;
  membership_status: string;
}

interface GroupRow {
  id: string;
  external_id: string | null;
  display_name: string;
  mapped_role: ScimMappableRole | null;
  version: number;
  created_at: number;
  updated_at: number;
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function roleMappings(value: string): ScimRoleMappings {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const accepted: Record<string, ScimMappableRole> = {};
    for (const [name, role] of Object.entries(parsed)) {
      if (
        name.length >= 1 &&
        name.length <= 128 &&
        (role === "viewer" || role === "analyst")
      ) accepted[name] = role;
    }
    return accepted;
  } catch {
    return {};
  }
}

export function validateScimRoleMappings(value: unknown): ScimRoleMappings {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LocalAuthError(400, "INVALID_INPUT", "SCIM group role mappings are invalid");
  }
  const entries = Object.entries(value);
  if (entries.length > 50) {
    throw new LocalAuthError(400, "INVALID_INPUT", "SCIM group role mappings are invalid");
  }
  const output: Record<string, ScimMappableRole> = {};
  for (const [rawName, role] of entries) {
    const name = rawName.trim();
    if (
      name.length < 1 ||
      name.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(name) ||
      (role !== "viewer" && role !== "analyst")
    ) {
      throw new LocalAuthError(
        400,
        "INVALID_INPUT",
        "SCIM role mappings may grant only viewer or analyst",
      );
    }
    output[name] = role;
  }
  return output;
}

function connectorSummary(row: ConnectorRow): ScimConnectorSummary {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    identityIssuer: row.identity_issuer,
    subjectSource: row.subject_source,
    roleMappings: roleMappings(row.role_mappings_json),
    expiresAt: iso(row.expires_at),
    lastUsedAt: iso(row.last_used_at),
    rotatedAt: iso(row.rotated_at),
    revokedAt: iso(row.revoked_at),
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function auditStatement(
  db: D1Database,
  input: {
    readonly orgId: string;
    readonly connectorId: string | null;
    readonly actorType: "user" | "scim_connector";
    readonly actorId: string;
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string | null;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly now: number;
    readonly requestId?: string;
  },
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO scim_audit_events
      (id, org_id, connector_id, actor_type, actor_id, action, target_type,
       target_id, outcome, request_id, metadata_json, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'allowed', ?, ?, ?)`,
  ).bind(
    `scima_${randomHex(16)}`,
    input.orgId,
    input.connectorId,
    input.actorType,
    input.actorId,
    input.action,
    input.targetType,
    input.targetId,
    input.requestId ?? `scim:${randomHex(24)}`,
    canonicalJson(input.metadata ?? {}),
    input.now,
  );
}

export class ScimConnectorRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  public async list(orgId: string): Promise<readonly ScimConnectorSummary[]> {
    if (!IDENTIFIER.test(orgId)) throw new LocalAuthError(400, "INVALID_INPUT", "The organization is invalid");
    const db = await this.ready();
    const result = await db.prepare(
      `SELECT id, org_id, name, token_prefix, identity_issuer, subject_source,
              role_mappings_json, expires_at, last_used_at, rotated_at, revoked_at,
              created_by, created_at
         FROM scim_connectors WHERE org_id = ? ORDER BY created_at DESC, id DESC`,
    ).bind(orgId).all<ConnectorRow>();
    return (result.results ?? []).map(connectorSummary);
  }

  public async mint(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly name: string;
    readonly identityIssuer: string;
    readonly subjectSource: ScimSubjectSource;
    readonly roleMappings: ScimRoleMappings;
    readonly expiresAt: string | null;
  }, now = Date.now()): Promise<MintedScimConnector> {
    if (
      !IDENTIFIER.test(input.orgId) ||
      !IDENTIFIER.test(input.actorId) ||
      !TOKEN_NAME.test(input.name) ||
      !input.identityIssuer.startsWith("https://") ||
      input.identityIssuer.length > 2048 ||
      (input.subjectSource !== "userName" && input.subjectSource !== "externalId")
    ) {
      throw new LocalAuthError(400, "INVALID_INPUT", "The SCIM connector request is invalid");
    }
    const expiry =
      input.expiresAt === null ? null : Date.parse(input.expiresAt);
    if (expiry !== null && (!Number.isSafeInteger(expiry) || expiry <= now)) {
      throw new LocalAuthError(400, "INVALID_INPUT", "The SCIM connector expiry is invalid");
    }
    const db = await this.ready();
    const count = await db.prepare(
      `SELECT COUNT(*) AS total FROM scim_connectors
        WHERE org_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
    ).bind(input.orgId, now).first<{ total: number }>();
    if (Number(count?.total ?? 0) >= MAX_CONNECTORS_PER_ORG) {
      throw new LocalAuthError(409, "INVALID_INPUT", "The active SCIM connector limit has been reached");
    }
    const id = `scimc_${randomHex(16)}`;
    const token = `sutra_scim_${randomHex(32)}`;
    const tokenPrefix = token.slice(0, 20);
    const digest = await sha256Hex(token);
    const statements = [
      db.prepare(
        `INSERT INTO scim_connectors
          (id, org_id, name, token_prefix, token_sha256, identity_issuer,
           subject_source, role_mappings_json, expires_at, created_by, created_at)
         SELECT ?, o.id, ?, ?, ?, ?, ?, ?, ?, ?, ?
           FROM organizations o
           JOIN memberships m ON m.org_id = o.id AND m.user_id = ? AND m.status = 'active'
          WHERE o.id = ? AND o.status = 'active' AND m.role IN ('org_owner', 'org_admin')`,
      ).bind(
        id,
        input.name,
        tokenPrefix,
        digest,
        input.identityIssuer,
        input.subjectSource,
        canonicalJson(input.roleMappings),
        expiry,
        input.actorId,
        now,
        input.actorId,
        input.orgId,
      ),
      auditStatement(db, {
        orgId: input.orgId,
        connectorId: id,
        actorType: "user",
        actorId: input.actorId,
        action: "scim.connector.minted",
        targetType: "scim_connector",
        targetId: id,
        metadata: { subjectSource: input.subjectSource, tokenPrefix },
        now,
      }),
    ];
    try {
      const results = await db.batch(statements);
      if (results.some((result) => Number(result.meta?.changes ?? 0) !== 1)) {
        throw new Error("SCIM connector insert rejected");
      }
    } catch {
      throw new LocalAuthError(409, "INVALID_INPUT", "The SCIM connector could not be created");
    }
    const row = await this.findAdminConnector(input.orgId, id);
    return { ...connectorSummary(row), token };
  }

  private async findAdminConnector(orgId: string, id: string): Promise<ConnectorRow> {
    if (!IDENTIFIER.test(orgId) || !CONNECTOR_ID.test(id)) {
      throw new LocalAuthError(400, "INVALID_INPUT", "The SCIM connector is invalid");
    }
    const db = await this.ready();
    const row = await db.prepare(
      `SELECT id, org_id, name, token_prefix, identity_issuer, subject_source,
              role_mappings_json, expires_at, last_used_at, rotated_at, revoked_at,
              created_by, created_at
         FROM scim_connectors WHERE id = ? AND org_id = ? LIMIT 1`,
    ).bind(id, orgId).first<ConnectorRow>();
    if (row === null) throw new LocalAuthError(404, "INVALID_INPUT", "The SCIM connector is unavailable");
    return row;
  }

  public async rotate(orgId: string, actorId: string, id: string, now = Date.now()): Promise<MintedScimConnector> {
    const current = await this.findAdminConnector(orgId, id);
    if (current.revoked_at !== null || (current.expires_at !== null && current.expires_at <= now)) {
      throw new LocalAuthError(409, "INVALID_INPUT", "Only an active SCIM connector can be rotated");
    }
    const db = await this.ready();
    const token = `sutra_scim_${randomHex(32)}`;
    const tokenPrefix = token.slice(0, 20);
    const digest = await sha256Hex(token);
    const results = await db.batch([
      db.prepare(
        `UPDATE scim_connectors SET token_prefix = ?, token_sha256 = ?, rotated_at = ?, last_used_at = NULL
          WHERE id = ? AND org_id = ? AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)`,
      ).bind(tokenPrefix, digest, now, id, orgId, now),
      auditStatement(db, {
        orgId,
        connectorId: id,
        actorType: "user",
        actorId,
        action: "scim.connector.rotated",
        targetType: "scim_connector",
        targetId: id,
        metadata: { previousTokenPrefix: current.token_prefix, tokenPrefix },
        now,
      }),
    ]);
    if (results.some((result) => Number(result.meta?.changes ?? 0) !== 1)) {
      throw new LocalAuthError(409, "INVALID_INPUT", "The SCIM connector could not be rotated");
    }
    return { ...connectorSummary(await this.findAdminConnector(orgId, id)), token };
  }

  public async revoke(orgId: string, actorId: string, id: string, now = Date.now()): Promise<boolean> {
    const current = await this.findAdminConnector(orgId, id);
    if (current.revoked_at !== null) return false;
    const db = await this.ready();
    const results = await db.batch([
      db.prepare(
        `UPDATE scim_connectors SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL`,
      ).bind(now, id, orgId),
      auditStatement(db, {
        orgId,
        connectorId: id,
        actorType: "user",
        actorId,
        action: "scim.connector.revoked",
        targetType: "scim_connector",
        targetId: id,
        metadata: { tokenPrefix: current.token_prefix },
        now,
      }),
    ]);
    if (results.some((result) => Number(result.meta?.changes ?? 0) !== 1)) {
      throw new LocalAuthError(409, "INVALID_INPUT", "The SCIM connector could not be revoked");
    }
    return true;
  }

  public async verify(token: string, now = Date.now()): Promise<ScimConnectorContext> {
    if (!TOKEN_VALUE.test(token)) throw new ScimError(401, "A valid SCIM bearer token is required");
    const db = await this.ready();
    const digest = await sha256Hex(token);
    const row = await db.prepare(
      `SELECT c.id, c.org_id, c.name, c.token_prefix, c.identity_issuer,
              c.subject_source, c.role_mappings_json, c.expires_at, c.last_used_at,
              c.rotated_at, c.revoked_at, c.created_by, c.created_at
         FROM scim_connectors c
         JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
        WHERE c.token_sha256 = ? LIMIT 1`,
    ).bind(digest).first<ConnectorRow>();
    if (
      row === null ||
      row.revoked_at !== null ||
      (row.expires_at !== null && row.expires_at <= now)
    ) {
      throw new ScimError(401, "The SCIM bearer token is invalid or inactive");
    }
    await db.prepare(
      `UPDATE scim_connectors SET last_used_at = ? WHERE id = ? AND token_sha256 = ? AND revoked_at IS NULL`,
    ).bind(now, row.id, digest).run();
    return {
      id: row.id,
      orgId: row.org_id,
      identityIssuer: row.identity_issuer,
      subjectSource: row.subject_source,
      roleMappings: roleMappings(row.role_mappings_json),
    };
  }
}

function userSelect(): string {
  return `SELECT l.id, l.external_id, l.version, l.created_at, l.updated_at,
                 l.user_id, u.email, u.display_name, u.status AS user_status,
                 m.status AS membership_status
            FROM scim_user_links l
            JOIN users u ON u.id = l.user_id
            JOIN memberships m ON m.user_id = u.id AND m.org_id = l.org_id
           WHERE l.org_id = ? AND l.connector_id = ?`;
}

function groupSelect(): string {
  return `SELECT id, external_id, display_name, mapped_role, version, created_at, updated_at
            FROM scim_groups
           WHERE org_id = ? AND connector_id = ? AND deleted_at IS NULL`;
}

export class ScimResourceRepository {
  private readonly context: ScimConnectorContext;
  private readonly database: D1Database;

  public constructor(
    context: ScimConnectorContext,
    database: D1Database = getRawDb(),
  ) {
    this.context = context;
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  private async userGroups(db: D1Database, id: string): Promise<readonly { value: string; display: string }[]> {
    const rows = await db.prepare(
      `SELECT g.id AS value, g.display_name AS display
         FROM scim_group_members gm
         JOIN scim_groups g ON g.id = gm.group_id
          AND g.org_id = gm.org_id AND g.connector_id = gm.connector_id
        WHERE gm.org_id = ? AND gm.connector_id = ? AND gm.scim_user_id = ?
          AND g.deleted_at IS NULL
        ORDER BY g.display_name, g.id`,
    ).bind(this.context.orgId, this.context.id, id).all<{ value: string; display: string }>();
    return rows.results ?? [];
  }

  private async publicUser(db: D1Database, row: UserRow): Promise<Record<string, unknown>> {
    return {
      schemas: [SCIM_USER_SCHEMA],
      id: row.id,
      ...(row.external_id === null ? {} : { externalId: row.external_id }),
      userName: row.email,
      displayName: row.display_name ?? row.email,
      active: row.membership_status === "active" && row.user_status === "active",
      emails: [{ value: row.email, type: "work", primary: true }],
      groups: await this.userGroups(db, row.id),
      meta: {
        resourceType: "User",
        created: new Date(row.created_at).toISOString(),
        lastModified: new Date(row.updated_at).toISOString(),
        version: `W/"${row.version}"`,
      },
    };
  }

  public async getUser(id: string): Promise<Record<string, unknown>> {
    if (!USER_ID.test(id)) throw new ScimError(404, "The SCIM user was not found");
    const db = await this.ready();
    const row = await db.prepare(`${userSelect()} AND l.id = ? LIMIT 1`)
      .bind(this.context.orgId, this.context.id, id).first<UserRow>();
    if (row === null) throw new ScimError(404, "The SCIM user was not found");
    return this.publicUser(db, row);
  }

  public async listUsers(
    pagination: ScimPagination,
    filter: ScimFilter | null,
  ): Promise<{ readonly resources: readonly Record<string, unknown>[]; readonly total: number }> {
    const db = await this.ready();
    let clause = "";
    const values: unknown[] = [];
    if (filter !== null) {
      if (filter.attribute === "id") clause = " AND l.id = ?";
      else if (filter.attribute === "userName") clause = " AND u.email = ?";
      else if (filter.attribute === "externalId") clause = " AND l.external_id = ?";
      else if (filter.attribute === "active") {
        clause = filter.value === true
          ? " AND u.status = 'active' AND m.status = 'active'"
          : " AND (u.status <> 'active' OR m.status <> 'active')";
      } else {
        throw new ScimError(400, "The user filter is unsupported", "invalidFilter");
      }
      if (filter.attribute !== "active") {
        values.push(
          filter.attribute === "userName" && typeof filter.value === "string"
            ? filter.value.toLocaleLowerCase("en-US")
            : filter.value,
        );
      }
    }
    const baseValues = [this.context.orgId, this.context.id, ...values];
    const count = await db.prepare(
      `SELECT COUNT(*) AS total FROM (${userSelect()}${clause}) scoped`,
    ).bind(...baseValues).first<{ total: number }>();
    if (pagination.count === 0) return { resources: [], total: Number(count?.total ?? 0) };
    const rows = await db.prepare(
      `${userSelect()}${clause} ORDER BY l.id LIMIT ? OFFSET ?`,
    ).bind(...baseValues, pagination.count, pagination.startIndex - 1).all<UserRow>();
    return {
      resources: await Promise.all((rows.results ?? []).map((row) => this.publicUser(db, row))),
      total: Number(count?.total ?? 0),
    };
  }

  public async createUser(input: ScimUserInput, now = Date.now()): Promise<Record<string, unknown>> {
    const db = await this.ready();
    if (this.context.subjectSource === "externalId" && input.externalId === null) {
      throw new ScimError(400, "externalId is required by this connector", "invalidValue");
    }
    const id = `scimu_${randomHex(16)}`;
    const userId = `user_${randomHex(16)}`;
    const membershipId = `member_${randomHex(16)}`;
    const nonce = `scimn_${randomHex(16)}`;
    const subject = this.context.subjectSource === "externalId" ? input.externalId : input.userName;
    const status = input.active ? "active" : "suspended";
    try {
      const results = await db.batch([
        db.prepare(
          `INSERT INTO users (id, issuer, subject, email, display_name, status, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?
             FROM organizations WHERE id = ? AND status = 'active'`,
        ).bind(
          userId,
          this.context.identityIssuer,
          subject,
          input.userName,
          input.displayName,
          status,
          now,
          this.context.orgId,
        ),
        db.prepare(
          `INSERT INTO memberships (id, org_id, user_id, role, scope_mode, status, created_at)
           SELECT ?, ?, ?, 'viewer', 'assigned_customers', ?, ?
             FROM users WHERE id = ? AND issuer = ?`,
        ).bind(
          membershipId,
          this.context.orgId,
          userId,
          status,
          now,
          userId,
          this.context.identityIssuer,
        ),
        db.prepare(
          `INSERT INTO scim_user_links
            (id, org_id, connector_id, user_id, external_id, version, mutation_nonce, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, 1, ?, ?, ?
             FROM memberships WHERE id = ? AND org_id = ? AND user_id = ?`,
        ).bind(
          id,
          this.context.orgId,
          this.context.id,
          userId,
          input.externalId,
          nonce,
          now,
          now,
          membershipId,
          this.context.orgId,
          userId,
        ),
        auditStatement(db, {
          orgId: this.context.orgId,
          connectorId: this.context.id,
          actorType: "scim_connector",
          actorId: this.context.id,
          action: "scim.user.created",
          targetType: "user",
          targetId: id,
          metadata: { active: input.active, externalIdPresent: input.externalId !== null },
          now,
        }),
      ]);
      if (results.some((result) => Number(result.meta?.changes ?? 0) !== 1)) throw new Error("incomplete");
    } catch {
      throw new ScimError(409, "The SCIM userName, subject, or externalId already exists", "uniqueness");
    }
    return this.getUser(id);
  }

  public async replaceUser(
    id: string,
    expectedVersion: number,
    input: ScimUserInput,
    now = Date.now(),
  ): Promise<Record<string, unknown>> {
    if (!USER_ID.test(id)) throw new ScimError(404, "The SCIM user was not found");
    if (this.context.subjectSource === "externalId" && input.externalId === null) {
      throw new ScimError(400, "externalId is required by this connector", "invalidValue");
    }
    const db = await this.ready();
    const current = await db.prepare(`${userSelect()} AND l.id = ? LIMIT 1`)
      .bind(this.context.orgId, this.context.id, id).first<UserRow>();
    if (current === null) throw new ScimError(404, "The SCIM user was not found");
    if (current.version !== expectedVersion) {
      throw new ScimError(412, "The SCIM user changed since it was read", "mutability");
    }
    const nonce = `scimn_${randomHex(16)}`;
    const subject = this.context.subjectSource === "externalId" ? input.externalId : input.userName;
    const status = input.active ? "active" : "suspended";
    try {
      const results = await db.batch([
        db.prepare(
          `UPDATE scim_user_links
              SET external_id = ?, version = version + 1, mutation_nonce = ?, updated_at = ?
            WHERE id = ? AND org_id = ? AND connector_id = ? AND version = ?`,
        ).bind(input.externalId, nonce, now, id, this.context.orgId, this.context.id, expectedVersion),
        db.prepare(
          `UPDATE memberships SET status = ?
            WHERE org_id = ? AND user_id = ?
              AND EXISTS (SELECT 1 FROM scim_user_links
                           WHERE id = ? AND org_id = ? AND connector_id = ? AND mutation_nonce = ?)`,
        ).bind(
          status,
          this.context.orgId,
          current.user_id,
          id,
          this.context.orgId,
          this.context.id,
          nonce,
        ),
        db.prepare(
          `UPDATE users
              SET email = ?, display_name = ?, subject = ?,
                  status = CASE
                    WHEN ? = 1 THEN 'active'
                    WHEN NOT EXISTS (
                      SELECT 1 FROM memberships
                       WHERE user_id = ? AND status = 'active'
                    ) THEN 'suspended'
                    ELSE status
                  END
            WHERE id = ?
              AND EXISTS (SELECT 1 FROM scim_user_links
                           WHERE id = ? AND org_id = ? AND connector_id = ? AND mutation_nonce = ?)`,
        ).bind(
          input.userName,
          input.displayName,
          subject,
          input.active ? 1 : 0,
          current.user_id,
          current.user_id,
          id,
          this.context.orgId,
          this.context.id,
          nonce,
        ),
        db.prepare(
          `UPDATE local_sessions SET revoked_at = COALESCE(revoked_at, ?)
            WHERE user_id = ? AND selected_org_id = ? AND ? = 0
              AND EXISTS (SELECT 1 FROM scim_user_links
                           WHERE id = ? AND org_id = ? AND connector_id = ? AND mutation_nonce = ?)`,
        ).bind(
          now,
          current.user_id,
          this.context.orgId,
          input.active ? 1 : 0,
          id,
          this.context.orgId,
          this.context.id,
          nonce,
        ),
        auditStatement(db, {
          orgId: this.context.orgId,
          connectorId: this.context.id,
          actorType: "scim_connector",
          actorId: this.context.id,
          action: input.active ? "scim.user.replaced" : "scim.user.deactivated",
          targetType: "user",
          targetId: id,
          metadata: { active: input.active, sessionsRevoked: !input.active },
          now,
        }),
      ]);
      if (
        Number(results[0]?.meta?.changes ?? 0) !== 1 ||
        Number(results[1]?.meta?.changes ?? 0) !== 1 ||
        Number(results[2]?.meta?.changes ?? 0) !== 1 ||
        Number(results[4]?.meta?.changes ?? 0) !== 1
      ) throw new Error("incomplete");
    } catch (error) {
      if (error instanceof ScimError) throw error;
      throw new ScimError(409, "The SCIM user update conflicts with an existing identity", "uniqueness");
    }
    return this.getUser(id);
  }

  public async deactivateUser(id: string, expectedVersion: number, now = Date.now()): Promise<void> {
    const current = await this.getUser(id);
    await this.replaceUser(id, expectedVersion, {
      userName: String(current.userName),
      displayName: String(current.displayName ?? current.userName),
      externalId: typeof current.externalId === "string" ? current.externalId : null,
      active: false,
    }, now);
  }

  private async groupMembers(db: D1Database, id: string): Promise<readonly { value: string; display: string }[]> {
    const rows = await db.prepare(
      `SELECT l.id AS value, u.email AS display
         FROM scim_group_members gm
         JOIN scim_user_links l ON l.id = gm.scim_user_id
          AND l.org_id = gm.org_id AND l.connector_id = gm.connector_id
         JOIN users u ON u.id = l.user_id
        WHERE gm.org_id = ? AND gm.connector_id = ? AND gm.group_id = ?
        ORDER BY l.id`,
    ).bind(this.context.orgId, this.context.id, id).all<{ value: string; display: string }>();
    return rows.results ?? [];
  }

  private async publicGroup(db: D1Database, row: GroupRow): Promise<Record<string, unknown>> {
    return {
      schemas: [SCIM_GROUP_SCHEMA],
      id: row.id,
      ...(row.external_id === null ? {} : { externalId: row.external_id }),
      displayName: row.display_name,
      members: await this.groupMembers(db, row.id),
      meta: {
        resourceType: "Group",
        created: new Date(row.created_at).toISOString(),
        lastModified: new Date(row.updated_at).toISOString(),
        version: `W/"${row.version}"`,
      },
    };
  }

  public async getGroup(id: string): Promise<Record<string, unknown>> {
    if (!GROUP_ID.test(id)) throw new ScimError(404, "The SCIM group was not found");
    const db = await this.ready();
    const row = await db.prepare(`${groupSelect()} AND id = ? LIMIT 1`)
      .bind(this.context.orgId, this.context.id, id).first<GroupRow>();
    if (row === null) throw new ScimError(404, "The SCIM group was not found");
    return this.publicGroup(db, row);
  }

  public async listGroups(
    pagination: ScimPagination,
    filter: ScimFilter | null,
  ): Promise<{ readonly resources: readonly Record<string, unknown>[]; readonly total: number }> {
    const db = await this.ready();
    let clause = "";
    const values: unknown[] = [];
    if (filter !== null) {
      if (filter.attribute === "id") clause = " AND id = ?";
      else if (filter.attribute === "displayName") clause = " AND display_name = ?";
      else if (filter.attribute === "externalId") clause = " AND external_id = ?";
      else throw new ScimError(400, "The group filter is unsupported", "invalidFilter");
      values.push(filter.value);
    }
    const baseValues = [this.context.orgId, this.context.id, ...values];
    const count = await db.prepare(
      `SELECT COUNT(*) AS total FROM (${groupSelect()}${clause}) scoped`,
    ).bind(...baseValues).first<{ total: number }>();
    if (pagination.count === 0) return { resources: [], total: Number(count?.total ?? 0) };
    const rows = await db.prepare(
      `${groupSelect()}${clause} ORDER BY id LIMIT ? OFFSET ?`,
    ).bind(...baseValues, pagination.count, pagination.startIndex - 1).all<GroupRow>();
    return {
      resources: await Promise.all((rows.results ?? []).map((row) => this.publicGroup(db, row))),
      total: Number(count?.total ?? 0),
    };
  }

  private async assertMembers(db: D1Database, ids: readonly string[]): Promise<readonly string[]> {
    const unique = [...new Set(ids)];
    if (
      unique.length > MAX_GROUP_MEMBERS ||
      unique.some((id) => !USER_ID.test(id))
    ) throw new ScimError(400, "A SCIM group member is invalid", "invalidValue");
    if (unique.length === 0) return unique;
    const placeholders = unique.map(() => "?").join(", ");
    const row = await db.prepare(
      `SELECT COUNT(*) AS total FROM scim_user_links
        WHERE org_id = ? AND connector_id = ? AND id IN (${placeholders})`,
    ).bind(this.context.orgId, this.context.id, ...unique).first<{ total: number }>();
    if (Number(row?.total ?? 0) !== unique.length) {
      throw new ScimError(400, "Every group member must be a user from this SCIM connector", "invalidValue");
    }
    return unique;
  }

  private roleUpdate(db: D1Database, scimUserId: string): D1PreparedStatement {
    return db.prepare(
      `UPDATE memberships
          SET role = CASE
            WHEN EXISTS (
              SELECT 1 FROM scim_group_members gm
              JOIN scim_groups g ON g.id = gm.group_id
               AND g.org_id = gm.org_id AND g.connector_id = gm.connector_id
             WHERE gm.org_id = ? AND gm.connector_id = ?
               AND gm.scim_user_id = ? AND g.deleted_at IS NULL
               AND g.mapped_role = 'analyst'
            ) THEN 'analyst'
            ELSE 'viewer'
          END
        WHERE org_id = ?
          AND user_id = (
            SELECT user_id FROM scim_user_links
             WHERE id = ? AND org_id = ? AND connector_id = ?
          )
          AND role IN ('viewer', 'analyst')`,
    ).bind(
      this.context.orgId,
      this.context.id,
      scimUserId,
      this.context.orgId,
      scimUserId,
      this.context.orgId,
      this.context.id,
    );
  }

  public async createGroup(input: ScimGroupInput, now = Date.now()): Promise<Record<string, unknown>> {
    const db = await this.ready();
    const members = await this.assertMembers(db, input.memberIds);
    const id = `scimg_${randomHex(16)}`;
    const nonce = `scimn_${randomHex(16)}`;
    const mappedRole = this.context.roleMappings[input.displayName] ?? null;
    const statements: D1PreparedStatement[] = [
      db.prepare(
        `INSERT INTO scim_groups
          (id, org_id, connector_id, external_id, display_name, mapped_role,
           version, mutation_nonce, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).bind(
        id,
        this.context.orgId,
        this.context.id,
        input.externalId,
        input.displayName,
        mappedRole,
        nonce,
        now,
        now,
      ),
      ...members.map((memberId) => db.prepare(
        `INSERT INTO scim_group_members (org_id, connector_id, group_id, scim_user_id, created_at)
         SELECT ?, ?, ?, l.id, ? FROM scim_user_links l
          WHERE l.id = ? AND l.org_id = ? AND l.connector_id = ?`,
      ).bind(
        this.context.orgId,
        this.context.id,
        id,
        now,
        memberId,
        this.context.orgId,
        this.context.id,
      )),
      ...members.map((memberId) => this.roleUpdate(db, memberId)),
      auditStatement(db, {
        orgId: this.context.orgId,
        connectorId: this.context.id,
        actorType: "scim_connector",
        actorId: this.context.id,
        action: "scim.group.created",
        targetType: "group",
        targetId: id,
        metadata: { mappedRole, memberCount: members.length },
        now,
      }),
    ];
    try {
      const results = await db.batch(statements);
      if (
        Number(results[0]?.meta?.changes ?? 0) !== 1 ||
        members.some((_, index) => Number(results[index + 1]?.meta?.changes ?? 0) !== 1) ||
        Number(results.at(-1)?.meta?.changes ?? 0) !== 1
      ) throw new Error("incomplete");
    } catch {
      throw new ScimError(409, "The SCIM group externalId already exists", "uniqueness");
    }
    return this.getGroup(id);
  }

  public async replaceGroup(
    id: string,
    expectedVersion: number,
    input: ScimGroupInput,
    now = Date.now(),
  ): Promise<Record<string, unknown>> {
    if (!GROUP_ID.test(id)) throw new ScimError(404, "The SCIM group was not found");
    const db = await this.ready();
    const current = await db.prepare(`${groupSelect()} AND id = ? LIMIT 1`)
      .bind(this.context.orgId, this.context.id, id).first<GroupRow>();
    if (current === null) throw new ScimError(404, "The SCIM group was not found");
    if (current.version !== expectedVersion) {
      throw new ScimError(412, "The SCIM group changed since it was read", "mutability");
    }
    const members = await this.assertMembers(db, input.memberIds);
    const oldMembers = (await this.groupMembers(db, id)).map((member) => member.value);
    const affected = [...new Set([...oldMembers, ...members])];
    const nonce = `scimn_${randomHex(16)}`;
    const mappedRole = this.context.roleMappings[input.displayName] ?? null;
    const statements: D1PreparedStatement[] = [
      db.prepare(
        `UPDATE scim_groups
            SET external_id = ?, display_name = ?, mapped_role = ?,
                version = version + 1, mutation_nonce = ?, updated_at = ?
          WHERE id = ? AND org_id = ? AND connector_id = ? AND deleted_at IS NULL AND version = ?`,
      ).bind(
        input.externalId,
        input.displayName,
        mappedRole,
        nonce,
        now,
        id,
        this.context.orgId,
        this.context.id,
        expectedVersion,
      ),
      db.prepare(
        `DELETE FROM scim_group_members
          WHERE group_id = ? AND org_id = ? AND connector_id = ?
            AND EXISTS (SELECT 1 FROM scim_groups
                         WHERE id = ? AND org_id = ? AND connector_id = ? AND mutation_nonce = ?)`,
      ).bind(
        id,
        this.context.orgId,
        this.context.id,
        id,
        this.context.orgId,
        this.context.id,
        nonce,
      ),
      ...members.map((memberId) => db.prepare(
        `INSERT INTO scim_group_members (org_id, connector_id, group_id, scim_user_id, created_at)
         SELECT ?, ?, g.id, l.id, ?
           FROM scim_groups g
           JOIN scim_user_links l ON l.org_id = g.org_id AND l.connector_id = g.connector_id
          WHERE g.id = ? AND g.org_id = ? AND g.connector_id = ? AND g.mutation_nonce = ?
            AND l.id = ?`,
      ).bind(
        this.context.orgId,
        this.context.id,
        now,
        id,
        this.context.orgId,
        this.context.id,
        nonce,
        memberId,
      )),
      ...affected.map((memberId) => this.roleUpdate(db, memberId)),
      auditStatement(db, {
        orgId: this.context.orgId,
        connectorId: this.context.id,
        actorType: "scim_connector",
        actorId: this.context.id,
        action: "scim.group.replaced",
        targetType: "group",
        targetId: id,
        metadata: { mappedRole, memberCount: members.length },
        now,
      }),
    ];
    try {
      const results = await db.batch(statements);
      if (
        Number(results[0]?.meta?.changes ?? 0) !== 1 ||
        members.some((_, index) => Number(results[index + 2]?.meta?.changes ?? 0) !== 1) ||
        Number(results.at(-1)?.meta?.changes ?? 0) !== 1
      ) throw new Error("incomplete");
    } catch {
      throw new ScimError(409, "The SCIM group update conflicts with an existing group", "uniqueness");
    }
    return this.getGroup(id);
  }

  public async deleteGroup(id: string, expectedVersion: number, now = Date.now()): Promise<void> {
    if (!GROUP_ID.test(id)) throw new ScimError(404, "The SCIM group was not found");
    const db = await this.ready();
    const current = await db.prepare(`${groupSelect()} AND id = ? LIMIT 1`)
      .bind(this.context.orgId, this.context.id, id).first<GroupRow>();
    if (current === null) throw new ScimError(404, "The SCIM group was not found");
    if (current.version !== expectedVersion) {
      throw new ScimError(412, "The SCIM group changed since it was read", "mutability");
    }
    const affected = (await this.groupMembers(db, id)).map((member) => member.value);
    const nonce = `scimn_${randomHex(16)}`;
    const results = await db.batch([
      db.prepare(
        `UPDATE scim_groups
            SET deleted_at = ?, version = version + 1, mutation_nonce = ?, updated_at = ?
          WHERE id = ? AND org_id = ? AND connector_id = ? AND deleted_at IS NULL AND version = ?`,
      ).bind(now, nonce, now, id, this.context.orgId, this.context.id, expectedVersion),
      db.prepare(
        `DELETE FROM scim_group_members
          WHERE group_id = ? AND org_id = ? AND connector_id = ?
            AND EXISTS (SELECT 1 FROM scim_groups
                         WHERE id = ? AND org_id = ? AND connector_id = ? AND mutation_nonce = ?)`,
      ).bind(
        id,
        this.context.orgId,
        this.context.id,
        id,
        this.context.orgId,
        this.context.id,
        nonce,
      ),
      ...affected.map((memberId) => this.roleUpdate(db, memberId)),
      auditStatement(db, {
        orgId: this.context.orgId,
        connectorId: this.context.id,
        actorType: "scim_connector",
        actorId: this.context.id,
        action: "scim.group.deleted",
        targetType: "group",
        targetId: id,
        metadata: { formerMemberCount: affected.length },
        now,
      }),
    ]);
    if (
      Number(results[0]?.meta?.changes ?? 0) !== 1 ||
      Number(results.at(-1)?.meta?.changes ?? 0) !== 1
    ) throw new ScimError(409, "The SCIM group could not be deleted", "mutability");
  }
}
