// Repository for the CMDB workspace layer: resource ownership/custom-field
// annotations, saved queries, and the head-snapshot resource read that feeds
// the pure query engine. Annotations are operator-entered metadata — they are
// never presented as collected evidence. Every write is gated to a customer
// the acting organization owns (the gating SELECT writes nothing otherwise),
// and every read is org+customer scoped so tenants never see each other.
import { validateCmdbQuery, type CmdbQuery, type CmdbQueryResource } from "../lib/cmdb-query.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const RESOURCE_KEY = /^[A-Za-z0-9][A-Za-z0-9 ._:/@#+-]{0,255}$/u;
const OWNER_TEAM = /^[\p{L}\p{N}][\p{L}\p{N} ._&/+-]{0,79}$/u;
const OWNER_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/u;
const QUERY_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._:/+-]{0,79}$/u;
const SAVED_QUERY_ID = /^sq_[a-f0-9]{32}$/u;
const MAX_CUSTOM_FIELDS = 20;
const MAX_FIELD_KEY = 64;
const MAX_FIELD_VALUE = 256;
const MAX_QUERY_RESOURCES = 20_000;
const MAX_SAVED_QUERIES = 200;

export interface CmdbWorkspaceScope {
  readonly orgId: string;
  readonly customerId: string;
}

export interface ResourceAnnotationInput {
  readonly resourceKey: string;
  readonly ownerTeam?: string | null;
  readonly ownerEmail?: string | null;
  readonly customFields?: Readonly<Record<string, string>>;
}

export interface ResourceAnnotation {
  readonly resourceKey: string;
  readonly ownerTeam: string | null;
  readonly ownerEmail: string | null;
  readonly customFields: Readonly<Record<string, string>>;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export interface SavedCmdbQuery {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly query: CmdbQuery;
  readonly createdBy: string;
  readonly updatedAt: string;
}

interface AnnotationRow {
  resource_key: string;
  owner_team: string | null;
  owner_email: string | null;
  custom_fields_json: string;
  updated_by: string;
  updated_at: string;
}

interface SavedQueryRow {
  id: string;
  name: string;
  description: string | null;
  query_json: string;
  created_by: string;
  updated_at: string;
}

interface QueryResourceRow {
  resource_key: string;
  service: string;
  resource_type: string;
  region_key: string;
  name: string | null;
  state: string | null;
  arn: string | null;
  native_id: string;
  tags_json: string | null;
  configuration_json: string | null;
}

export class CmdbWorkspaceRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "LIMIT_EXCEEDED";

  public constructor(code: CmdbWorkspaceRepositoryError["code"]) {
    super("CMDB workspace operation rejected");
    this.name = "CmdbWorkspaceRepositoryError";
    this.code = code;
  }
}

function invalid(): never {
  throw new CmdbWorkspaceRepositoryError("INVALID_INPUT");
}

function assertScope(scope: CmdbWorkspaceScope, connectionId?: string): void {
  if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId)) invalid();
  if (connectionId !== undefined && !CONNECTION_ID.test(connectionId)) invalid();
}

function normalizeCustomFields(fields: Readonly<Record<string, string>> | undefined): Record<string, string> {
  if (fields === undefined) return {};
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) invalid();
  const entries = Object.entries(fields);
  if (entries.length > MAX_CUSTOM_FIELDS) throw new CmdbWorkspaceRepositoryError("LIMIT_EXCEEDED");
  const normalized: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (typeof value !== "string" || key.length === 0 || key.length > MAX_FIELD_KEY || value.length > MAX_FIELD_VALUE) invalid();
    normalized[key] = value;
  }
  return normalized;
}

function parseRecord(json: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") out[key] = value;
    return out;
  } catch {
    return {};
  }
}

export class CmdbWorkspaceRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  public async upsertAnnotation(
    scope: CmdbWorkspaceScope,
    connectionId: string,
    input: ResourceAnnotationInput,
    updatedBy: string,
    now = Date.now(),
  ): Promise<void> {
    assertScope(scope, connectionId);
    if (!RESOURCE_KEY.test(input.resourceKey) || !IDENTIFIER.test(updatedBy)) invalid();
    if (input.ownerTeam != null && !OWNER_TEAM.test(input.ownerTeam)) invalid();
    if (input.ownerEmail != null && !OWNER_EMAIL.test(input.ownerEmail)) invalid();
    const customFields = normalizeCustomFields(input.customFields);
    const timestamp = new Date(now).toISOString();
    const db = await this.ready();
    const result = await db.prepare(
      `INSERT INTO resource_annotations
         (id, org_id, customer_id, connection_id, resource_key, owner_team, owner_email, custom_fields_json, updated_by, created_at, updated_at)
       SELECT ?, c.org_id, c.id, ?, ?, ?, ?, ?, ?, ?, ?
         FROM customers c
        WHERE c.id = ? AND c.org_id = ? AND c.status IN ('active', 'trial')
       ON CONFLICT (org_id, connection_id, resource_key) DO UPDATE SET
         owner_team = excluded.owner_team,
         owner_email = excluded.owner_email,
         custom_fields_json = excluded.custom_fields_json,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    ).bind(
      `ra_${crypto.randomUUID().replaceAll("-", "")}`,
      connectionId,
      input.resourceKey,
      input.ownerTeam ?? null,
      input.ownerEmail ?? null,
      JSON.stringify(customFields),
      updatedBy,
      timestamp,
      timestamp,
      scope.customerId,
      scope.orgId,
    ).run();
    if (Number(result.meta?.changes ?? 0) === 0) throw new CmdbWorkspaceRepositoryError("SCOPE_NOT_FOUND");
  }

  public async annotationsForConnection(
    scope: CmdbWorkspaceScope,
    connectionId: string,
  ): Promise<readonly ResourceAnnotation[]> {
    assertScope(scope, connectionId);
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT resource_key, owner_team, owner_email, custom_fields_json, updated_by, updated_at
         FROM resource_annotations
        WHERE org_id = ? AND customer_id = ? AND connection_id = ?
        ORDER BY resource_key ASC`,
    ).bind(scope.orgId, scope.customerId, connectionId).all<AnnotationRow>();
    return (rows.results ?? []).map((row) => ({
      resourceKey: row.resource_key,
      ownerTeam: row.owner_team,
      ownerEmail: row.owner_email,
      customFields: parseRecord(row.custom_fields_json),
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    }));
  }

  /** Resources from the connection's published head snapshot, shaped for the query engine. */
  public async resourcesForQuery(
    scope: CmdbWorkspaceScope,
    connectionId: string,
  ): Promise<readonly CmdbQueryResource[]> {
    assertScope(scope, connectionId);
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT r.resource_key, r.service, r.resource_type, r.region_key, r.name, r.state,
              r.arn, r.native_id, r.tags_json, r.configuration_json
         FROM cmdb_resources r
         JOIN connection_heads h ON h.snapshot_id = r.snapshot_id
        WHERE h.connection_id = ? AND r.org_id = ? AND r.customer_id = ? AND r.connection_id = ?
        ORDER BY r.resource_key ASC LIMIT ?`,
    ).bind(connectionId, scope.orgId, scope.customerId, connectionId, MAX_QUERY_RESOURCES).all<QueryResourceRow>();
    return (rows.results ?? []).map((row) => {
      let configuration: CmdbQueryResource["configuration"] = null;
      try {
        configuration = row.configuration_json === null ? null : JSON.parse(row.configuration_json);
      } catch {
        configuration = null;
      }
      return {
        resourceKey: row.resource_key,
        service: row.service,
        resourceType: row.resource_type,
        regionKey: row.region_key,
        name: row.name,
        state: row.state,
        arn: row.arn,
        nativeId: row.native_id,
        tags: parseRecord(row.tags_json ?? "{}"),
        configuration,
      };
    });
  }

  public async saveQuery(
    scope: CmdbWorkspaceScope,
    name: string,
    description: string | null,
    queryInput: unknown,
    createdBy: string,
    now = Date.now(),
  ): Promise<SavedCmdbQuery> {
    assertScope(scope);
    if (!QUERY_NAME.test(name) || !IDENTIFIER.test(createdBy)) invalid();
    if (description !== null && (typeof description !== "string" || description.length > 256)) invalid();
    const validation = validateCmdbQuery(queryInput);
    if (validation.query === null) invalid();
    const db = await this.ready();
    const countRow = await db.prepare(
      `SELECT COUNT(*) AS total FROM cmdb_saved_queries WHERE org_id = ?`,
    ).bind(scope.orgId).first<{ total: number }>();
    if (Number(countRow?.total ?? 0) >= MAX_SAVED_QUERIES) throw new CmdbWorkspaceRepositoryError("LIMIT_EXCEEDED");
    const id = `sq_${crypto.randomUUID().replaceAll("-", "")}`;
    const timestamp = new Date(now).toISOString();
    const result = await db.prepare(
      `INSERT INTO cmdb_saved_queries (id, org_id, customer_id, name, description, query_json, created_by, created_at, updated_at)
       SELECT ?, c.org_id, c.id, ?, ?, ?, ?, ?, ?
         FROM customers c
        WHERE c.id = ? AND c.org_id = ? AND c.status IN ('active', 'trial')
       ON CONFLICT (org_id, name) DO UPDATE SET
         description = excluded.description,
         query_json = excluded.query_json,
         updated_at = excluded.updated_at`,
    ).bind(
      id, name, description, JSON.stringify(validation.query), createdBy, timestamp, timestamp,
      scope.customerId, scope.orgId,
    ).run();
    if (Number(result.meta?.changes ?? 0) === 0) throw new CmdbWorkspaceRepositoryError("SCOPE_NOT_FOUND");
    return { id, name, description, query: validation.query, createdBy, updatedAt: timestamp };
  }

  public async listQueries(scope: CmdbWorkspaceScope): Promise<readonly SavedCmdbQuery[]> {
    assertScope(scope);
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT id, name, description, query_json, created_by, updated_at
         FROM cmdb_saved_queries WHERE org_id = ? ORDER BY name ASC`,
    ).bind(scope.orgId).all<SavedQueryRow>();
    return (rows.results ?? []).flatMap((row) => {
      const validation = validateCmdbQuery(JSON.parse(row.query_json));
      // A stored query that no longer validates is dropped from listings rather
      // than executed with guessed semantics.
      if (validation.query === null) return [];
      return [{
        id: row.id,
        name: row.name,
        description: row.description,
        query: validation.query,
        createdBy: row.created_by,
        updatedAt: row.updated_at,
      }];
    });
  }

  public async deleteQuery(scope: CmdbWorkspaceScope, id: string): Promise<boolean> {
    assertScope(scope);
    if (!SAVED_QUERY_ID.test(id)) invalid();
    const db = await this.ready();
    const result = await db.prepare(
      `DELETE FROM cmdb_saved_queries WHERE id = ? AND org_id = ?`,
    ).bind(id, scope.orgId).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }
}
