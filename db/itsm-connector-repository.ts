import type { ItsmConnectorType } from "../lib/itsm-sync.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTOR_ID = /^itc_[a-f0-9]{32}$/u;
const CONNECTOR_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._:/+-]{0,79}$/u;
const PROJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/u;
const MAX_SECRET_LENGTH = 512;

export interface ItsmConnectorScope {
  readonly orgId: string;
  readonly customerId: string;
}

export interface ItsmConnectorSummary {
  readonly id: string;
  readonly name: string;
  readonly connectorType: ItsmConnectorType;
  readonly baseUrl: string;
  readonly projectKey: string | null;
  readonly secretPreview: string;
  readonly enabled: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ItsmConnectorSecret extends Omit<ItsmConnectorSummary, "secretPreview"> {
  readonly orgId: string;
  readonly customerId: string;
  readonly sharedSecret: string;
}

interface ConnectorRow {
  id: string;
  org_id: string;
  customer_id: string;
  name: string;
  connector_type: ItsmConnectorType;
  base_url: string;
  project_key: string | null;
  shared_secret: string;
  enabled: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export class ItsmConnectorRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND";

  public constructor(code: ItsmConnectorRepositoryError["code"]) {
    super("ITSM connector operation rejected");
    this.name = "ItsmConnectorRepositoryError";
    this.code = code;
  }
}

function invalid(): never {
  throw new ItsmConnectorRepositoryError("INVALID_INPUT");
}

function assertScope(scope: ItsmConnectorScope): void {
  if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId)) invalid();
}

function normalizeBaseUrl(value: string): string {
  if (value.length > 2_048) invalid();
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") invalid();
    return parsed.toString();
  } catch {
    invalid();
  }
}

function toSecret(row: ConnectorRow): ItsmConnectorSecret {
  return {
    id: row.id,
    orgId: row.org_id,
    customerId: row.customer_id,
    name: row.name,
    connectorType: row.connector_type,
    baseUrl: row.base_url,
    projectKey: row.project_key,
    sharedSecret: row.shared_secret,
    enabled: row.enabled === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ItsmConnectorRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  public async save(
    scope: ItsmConnectorScope,
    input: {
      readonly name: string;
      readonly connectorType: ItsmConnectorType;
      readonly baseUrl: string;
      readonly projectKey: string | null;
      readonly sharedSecret: string;
      readonly enabled?: boolean;
    },
    createdBy: string,
    now = Date.now(),
  ): Promise<ItsmConnectorSummary> {
    assertScope(scope);
    if (
      !CONNECTOR_NAME.test(input.name) ||
      (input.connectorType !== "jira" && input.connectorType !== "servicenow") ||
      (input.projectKey !== null && !PROJECT_KEY.test(input.projectKey)) ||
      input.sharedSecret.length < 16 ||
      input.sharedSecret.length > MAX_SECRET_LENGTH ||
      /[\u0000-\u001f\u007f]/u.test(input.sharedSecret) ||
      !IDENTIFIER.test(createdBy)
    ) invalid();
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const db = await this.ready();
    const id = `itc_${crypto.randomUUID().replaceAll("-", "")}`;
    const timestamp = new Date(now).toISOString();
    // Local private-beta storage only. Move shared_secret to the managed secret
    // service before the hosted-production gate is declared closed.
    const result = await db.prepare(
      `INSERT INTO itsm_connectors
        (id, org_id, customer_id, name, connector_type, base_url, project_key, shared_secret, enabled, created_by, created_at, updated_at)
       SELECT ?, c.org_id, c.id, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM customers c
        WHERE c.id = ? AND c.org_id = ? AND c.status IN ('active', 'trial')
       ON CONFLICT (org_id, name) DO UPDATE SET
         customer_id = excluded.customer_id,
         connector_type = excluded.connector_type,
         base_url = excluded.base_url,
         project_key = excluded.project_key,
         shared_secret = excluded.shared_secret,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
    ).bind(
      id, input.name, input.connectorType, baseUrl, input.projectKey, input.sharedSecret,
      input.enabled === false ? 0 : 1, createdBy, timestamp, timestamp, scope.customerId, scope.orgId,
    ).run();
    if (Number(result.meta?.changes ?? 0) === 0) throw new ItsmConnectorRepositoryError("SCOPE_NOT_FOUND");
    const stored = await db.prepare(
      `SELECT * FROM itsm_connectors WHERE org_id = ? AND name = ? LIMIT 1`,
    ).bind(scope.orgId, input.name).first<ConnectorRow>();
    if (stored === null) throw new ItsmConnectorRepositoryError("SCOPE_NOT_FOUND");
    return this.summary(stored);
  }

  public async list(scope: ItsmConnectorScope): Promise<readonly ItsmConnectorSummary[]> {
    assertScope(scope);
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT * FROM itsm_connectors WHERE org_id = ? AND customer_id = ? ORDER BY name ASC LIMIT 100`,
    ).bind(scope.orgId, scope.customerId).all<ConnectorRow>();
    return (rows.results ?? []).map((row) => this.summary(row));
  }

  /** Secret-bearing lookup used only after an inbound connector id is presented. */
  public async getForInbound(id: string): Promise<ItsmConnectorSecret | null> {
    if (!CONNECTOR_ID.test(id)) invalid();
    const db = await this.ready();
    const row = await db.prepare(`SELECT * FROM itsm_connectors WHERE id = ? LIMIT 1`).bind(id).first<ConnectorRow>();
    return row === null ? null : toSecret(row);
  }

  /** Scoped secret-bearing lookup for an authenticated outbound dispatch. */
  public async getForDispatch(scope: ItsmConnectorScope, id: string): Promise<ItsmConnectorSecret | null> {
    assertScope(scope);
    if (!CONNECTOR_ID.test(id)) invalid();
    const db = await this.ready();
    const row = await db.prepare(
      `SELECT * FROM itsm_connectors WHERE id = ? AND org_id = ? AND customer_id = ? LIMIT 1`,
    ).bind(id, scope.orgId, scope.customerId).first<ConnectorRow>();
    return row === null ? null : toSecret(row);
  }

  public async delete(scope: ItsmConnectorScope, id: string): Promise<boolean> {
    assertScope(scope);
    if (!CONNECTOR_ID.test(id)) invalid();
    const db = await this.ready();
    const result = await db.prepare(
      `DELETE FROM itsm_connectors WHERE id = ? AND org_id = ? AND customer_id = ?`,
    ).bind(id, scope.orgId, scope.customerId).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }

  private summary(row: ConnectorRow): ItsmConnectorSummary {
    return {
      id: row.id,
      name: row.name,
      connectorType: row.connector_type,
      baseUrl: row.base_url,
      projectKey: row.project_key,
      secretPreview: `${row.shared_secret.slice(0, 4)}…`,
      enabled: row.enabled === 1,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
