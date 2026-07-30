import type { ItsmConnectorType } from "../lib/itsm-sync.ts";
import {
  createRuntimeItsmSecretStore,
  type ItsmManagedSecretStore,
} from "../lib/itsm-managed-secret.ts";
import { assertSafeOutboundUrl } from "../lib/ssrf-guard.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTOR_ID = /^itc_[a-f0-9]{32}$/u;
const CONNECTOR_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._:/+-]{0,79}$/u;
const PROJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/u;
const MAX_SECRET_LENGTH = 512;
export const ITSM_SECRET_CLEANUP_JOB_KIND = "itsm-secret-cleanup" as const;
const ITSM_SECRET_CLEANUP_MAX_ATTEMPTS = 10;

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
  readonly secretStorage: "local" | "managed";
  readonly enabled: boolean;
  readonly lastOutboundSuccessAt: string | null;
  readonly lastAuthenticatedInboundAt: string | null;
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
  secret_storage: "local" | "managed";
  secret_reference: string | null;
  secret_preview: string;
  enabled: number;
  last_outbound_success_at: string | null;
  last_authenticated_inbound_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export class ItsmConnectorRepositoryError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "SCOPE_NOT_FOUND"
    | "SECRET_UNAVAILABLE"
    | "PERSISTENCE_FAILED";

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
  // Block SSRF targets (loopback/private/link-local/metadata + internal
  // hostnames) at store time so a dangerous base URL can never be persisted.
  let safe: URL;
  try {
    safe = assertSafeOutboundUrl(value);
  } catch {
    invalid();
  }
  if (safe.hash !== "") invalid();
  return safe.toString();
}

function toSecret(row: ConnectorRow, sharedSecret: string): ItsmConnectorSecret {
  return {
    id: row.id,
    orgId: row.org_id,
    customerId: row.customer_id,
    name: row.name,
    connectorType: row.connector_type,
    baseUrl: row.base_url,
    projectKey: row.project_key,
    secretStorage: row.secret_storage,
    sharedSecret,
    enabled: row.enabled === 1,
    lastOutboundSuccessAt: row.last_outbound_success_at,
    lastAuthenticatedInboundAt: row.last_authenticated_inbound_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ItsmConnectorRepository {
  private readonly database: D1Database;
  private readonly managedSecretStore: ItsmManagedSecretStore | null;

  public constructor(
    database: D1Database = getRawDb(),
    options: {
      readonly managedSecretStore?: ItsmManagedSecretStore | null;
      readonly environment?: Readonly<Record<string, string | undefined>>;
    } = {},
  ) {
    this.database = database;
    this.managedSecretStore = options.managedSecretStore === undefined
      ? createRuntimeItsmSecretStore(options.environment)
      : options.managedSecretStore;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    if (this.managedSecretStore !== null) {
      // A hosted upgrade may encounter connector rows created by the former
      // local-only implementation. They are disabled and scrubbed before this
      // repository can list, resolve, or update them. Re-entering the credential
      // through save() writes it to the managed store and re-enables the row.
      await this.database.prepare(
        `UPDATE itsm_connectors
            SET shared_secret = '', enabled = 0
          WHERE secret_storage = 'local' AND shared_secret <> ''`,
      ).run();
    }
    return this.database;
  }

  private cleanupJobPayload(connectorId: string, secretReference: string): string {
    return JSON.stringify({ connectorId, secretReference });
  }

  private cleanupJobInsertAfterConnectorVersionRemoved(
    db: D1Database,
    row: ConnectorRow,
    now: number,
  ): D1PreparedStatement {
    if (row.secret_reference === null) {
      throw new ItsmConnectorRepositoryError("SECRET_UNAVAILABLE");
    }
    return db.prepare(
      `INSERT INTO background_jobs
        (id, org_id, customer_id, kind, payload_json, status, attempt,
         max_attempts, run_after, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM itsm_connectors c
           WHERE c.id = ? AND c.org_id = ? AND c.customer_id = ?
             AND c.updated_at = ? AND c.secret_reference = ?
        )`,
    ).bind(
      `job_${crypto.randomUUID().replaceAll("-", "")}`,
      row.org_id,
      row.customer_id,
      ITSM_SECRET_CLEANUP_JOB_KIND,
      this.cleanupJobPayload(row.id, row.secret_reference),
      ITSM_SECRET_CLEANUP_MAX_ATTEMPTS,
      now,
      now,
      now,
      row.id,
      row.org_id,
      row.customer_id,
      row.updated_at,
      row.secret_reference,
    );
  }

  private async discardStagedManagedReference(
    scope: ItsmConnectorScope,
    connectorId: string,
    secretReference: string,
    now: number,
  ): Promise<void> {
    if (this.managedSecretStore === null) {
      throw new ItsmConnectorRepositoryError("SECRET_UNAVAILABLE");
    }
    try {
      await this.managedSecretStore.delete(scope, connectorId, secretReference);
      return;
    } catch {
      // If immediate cleanup is unavailable, persist a bounded retry job. If
      // even that cannot be persisted, surface failure rather than silently
      // claiming the staged secret was cleaned.
      try {
        await this.database.prepare(
          `INSERT INTO background_jobs
            (id, org_id, customer_id, kind, payload_json, status, attempt,
             max_attempts, run_after, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
        ).bind(
          `job_${crypto.randomUUID().replaceAll("-", "")}`,
          scope.orgId,
          scope.customerId,
          ITSM_SECRET_CLEANUP_JOB_KIND,
          this.cleanupJobPayload(connectorId, secretReference),
          ITSM_SECRET_CLEANUP_MAX_ATTEMPTS,
          now,
          now,
          now,
        ).run();
      } catch {
        throw new ItsmConnectorRepositoryError("PERSISTENCE_FAILED");
      }
    }
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
      !IDENTIFIER.test(createdBy) ||
      !Number.isFinite(now)
    ) invalid();
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const db = await this.ready();
    const existing = await db.prepare(
      `SELECT * FROM itsm_connectors WHERE org_id = ? AND name = ? LIMIT 1`,
    ).bind(scope.orgId, input.name).first<ConnectorRow>();
    if (existing !== null && existing.customer_id !== scope.customerId) {
      throw new ItsmConnectorRepositoryError("SCOPE_NOT_FOUND");
    }
    const id = existing?.id ?? `itc_${crypto.randomUUID().replaceAll("-", "")}`;
    const existingUpdatedAt = existing === null ? Number.NaN : Date.parse(existing.updated_at);
    if (existing !== null && !Number.isFinite(existingUpdatedAt)) {
      throw new ItsmConnectorRepositoryError("PERSISTENCE_FAILED");
    }
    const timestamp = new Date(
      existing === null ? now : Math.max(now, existingUpdatedAt + 1),
    ).toISOString();
    const managed = this.managedSecretStore !== null;
    const secretReference = managed
      ? await this.managedSecretStore.write(scope, id, input.sharedSecret)
      : null;
    let result: D1Result<unknown>;
    try {
      if (existing === null) {
        result = await db.prepare(
            `INSERT INTO itsm_connectors
              (id, org_id, customer_id, name, connector_type, base_url, project_key,
               shared_secret, secret_storage, secret_reference, secret_preview,
               enabled, created_by, created_at, updated_at)
             SELECT ?, c.org_id, c.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
               FROM customers c
              WHERE c.id = ? AND c.org_id = ? AND c.status IN ('active', 'trial')`,
          ).bind(
            id,
            input.name,
            input.connectorType,
            baseUrl,
            input.projectKey,
            managed ? "" : input.sharedSecret,
            managed ? "managed" : "local",
            secretReference,
            managed ? "managed" : "local",
            input.enabled === false ? 0 : 1,
            createdBy,
            timestamp,
            timestamp,
            scope.customerId,
            scope.orgId,
          ).run();
      } else {
        const update = db.prepare(
          `UPDATE itsm_connectors
              SET connector_type = ?, base_url = ?, project_key = ?,
                  shared_secret = ?, secret_storage = ?, secret_reference = ?,
                  secret_preview = ?, enabled = ?, updated_at = ?
            WHERE id = ? AND org_id = ? AND customer_id = ? AND updated_at = ?`,
        ).bind(
          input.connectorType,
          baseUrl,
          input.projectKey,
          managed ? "" : input.sharedSecret,
          managed ? "managed" : "local",
          secretReference,
          managed ? "managed" : "local",
          input.enabled === false ? 0 : 1,
          timestamp,
          existing.id,
          scope.orgId,
          scope.customerId,
          existing.updated_at,
        );
        const replaceManagedReference =
          existing.secret_storage === "managed" &&
          existing.secret_reference !== null &&
          managed &&
          existing.secret_reference !== secretReference;
        if (replaceManagedReference) {
          // Compare-and-swap the live reference first, then queue cleanup of the
          // old immutable version in the SAME transaction. A failed update
          // cannot expose a cleanup job for a still-live credential.
          const outcomes = await db.batch([
            update,
            this.cleanupJobInsertAfterConnectorVersionRemoved(db, existing, now),
          ]);
          result = outcomes[0] as D1Result<unknown>;
        } else {
          result = await update.run();
        }
      }
    } catch (error) {
      if (managed && secretReference !== null) {
        await this.discardStagedManagedReference(scope, id, secretReference, now);
      }
      throw error;
    }
    if (Number(result.meta?.changes ?? 0) === 0) {
      if (managed && secretReference !== null) {
        await this.discardStagedManagedReference(scope, id, secretReference, now);
      }
      throw new ItsmConnectorRepositoryError(
        existing === null ? "SCOPE_NOT_FOUND" : "PERSISTENCE_FAILED",
      );
    }
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
    return row === null ? null : this.toSecret(row);
  }

  /** Scoped secret-bearing lookup for an authenticated outbound dispatch. */
  public async getForDispatch(scope: ItsmConnectorScope, id: string): Promise<ItsmConnectorSecret | null> {
    assertScope(scope);
    if (!CONNECTOR_ID.test(id)) invalid();
    const db = await this.ready();
    const row = await db.prepare(
      `SELECT * FROM itsm_connectors WHERE id = ? AND org_id = ? AND customer_id = ? LIMIT 1`,
    ).bind(id, scope.orgId, scope.customerId).first<ConnectorRow>();
    return row === null ? null : this.toSecret(row);
  }

  public async delete(scope: ItsmConnectorScope, id: string): Promise<boolean> {
    assertScope(scope);
    if (!CONNECTOR_ID.test(id)) invalid();
    const db = await this.ready();
    const row = await db.prepare(
      `SELECT * FROM itsm_connectors WHERE id = ? AND org_id = ? AND customer_id = ? LIMIT 1`,
    ).bind(id, scope.orgId, scope.customerId).first<ConnectorRow>();
    if (row === null) return false;
    if (row.secret_storage === "managed") {
      if (row.secret_reference === null || this.managedSecretStore === null) {
        throw new ItsmConnectorRepositoryError("SECRET_UNAVAILABLE");
      }
      // The connector row is authoritative: compare-and-swap delete it first,
      // then enqueue cleanup of its immutable secret in the same transaction.
      // No Secrets Manager operation occurs while the connector is still live.
      const outcomes = await db.batch([
        db.prepare(
          `DELETE FROM itsm_connectors
            WHERE id = ? AND org_id = ? AND customer_id = ? AND updated_at = ?`,
        ).bind(id, scope.orgId, scope.customerId, row.updated_at),
        this.cleanupJobInsertAfterConnectorVersionRemoved(db, row, Date.now()),
      ]);
      return Number(outcomes[0]?.meta?.changes ?? 0) === 1;
    }
    const result = await db.prepare(
      `DELETE FROM itsm_connectors WHERE id = ? AND org_id = ? AND customer_id = ?`,
    ).bind(id, scope.orgId, scope.customerId).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }

  /** Durable background-job target for a connector version no longer referenced by live metadata. */
  public async cleanupDeletedManagedSecret(
    scope: ItsmConnectorScope,
    connectorId: string,
    secretReference: string,
  ): Promise<void> {
    assertScope(scope);
    if (!CONNECTOR_ID.test(connectorId) || secretReference.length > 512) invalid();
    if (this.managedSecretStore === null) {
      throw new ItsmConnectorRepositoryError("SECRET_UNAVAILABLE");
    }
    const db = await this.ready();
    const stillLive = await db.prepare(
      `SELECT id FROM itsm_connectors
        WHERE id = ? AND org_id = ? AND customer_id = ? AND secret_reference = ?
        LIMIT 1`,
    ).bind(connectorId, scope.orgId, scope.customerId, secretReference).first<{ id: string }>();
    if (stillLive !== null) {
      throw new ItsmConnectorRepositoryError("PERSISTENCE_FAILED");
    }
    await this.managedSecretStore.delete(scope, connectorId, secretReference);
  }

  private async recordDeliveryEvidence(
    scope: ItsmConnectorScope,
    id: string,
    column: "last_outbound_success_at" | "last_authenticated_inbound_at",
    expectedUpdatedAt: string,
    now: number,
  ): Promise<boolean> {
    assertScope(scope);
    const updatedAt = Date.parse(expectedUpdatedAt);
    if (
      !CONNECTOR_ID.test(id) ||
      !Number.isFinite(now) ||
      !Number.isFinite(updatedAt) ||
      new Date(updatedAt).toISOString() !== expectedUpdatedAt
    ) invalid();
    const db = await this.ready();
    // Strictly newer than the configuration/secret version, even when the
    // provider response lands in the same millisecond as save().
    const observedAt = new Date(Math.max(now, updatedAt + 1)).toISOString();
    const result = await db.prepare(
      `UPDATE itsm_connectors
          SET ${column} = ?
        WHERE id = ? AND org_id = ? AND customer_id = ? AND enabled = 1
          AND updated_at = ?
          AND (${column} IS NULL OR ${column} < ?)`,
    ).bind(
      observedAt,
      id,
      scope.orgId,
      scope.customerId,
      expectedUpdatedAt,
      observedAt,
    ).run();
    return Number(result.meta?.changes ?? 0) === 1;
  }

  public recordOutboundSuccess(
    scope: ItsmConnectorScope,
    id: string,
    expectedUpdatedAt: string,
    now = Date.now(),
  ): Promise<boolean> {
    return this.recordDeliveryEvidence(
      scope,
      id,
      "last_outbound_success_at",
      expectedUpdatedAt,
      now,
    );
  }

  public recordAuthenticatedInboundSuccess(
    scope: ItsmConnectorScope,
    id: string,
    expectedUpdatedAt: string,
    now = Date.now(),
  ): Promise<boolean> {
    return this.recordDeliveryEvidence(
      scope,
      id,
      "last_authenticated_inbound_at",
      expectedUpdatedAt,
      now,
    );
  }

  private summary(row: ConnectorRow): ItsmConnectorSummary {
    return {
      id: row.id,
      name: row.name,
      connectorType: row.connector_type,
      baseUrl: row.base_url,
      projectKey: row.project_key,
      secretPreview: row.secret_preview,
      secretStorage: row.secret_storage,
      enabled: row.enabled === 1,
      lastOutboundSuccessAt: row.last_outbound_success_at,
      lastAuthenticatedInboundAt: row.last_authenticated_inbound_at,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async toSecret(row: ConnectorRow): Promise<ItsmConnectorSecret> {
    if (row.secret_storage === "local") {
      if (this.managedSecretStore !== null || row.shared_secret.length < 16) {
        throw new ItsmConnectorRepositoryError("SECRET_UNAVAILABLE");
      }
      return toSecret(row, row.shared_secret);
    }
    if (row.secret_reference === null || this.managedSecretStore === null) {
      throw new ItsmConnectorRepositoryError("SECRET_UNAVAILABLE");
    }
    const sharedSecret = await this.managedSecretStore.read(
      { orgId: row.org_id, customerId: row.customer_id },
      row.id,
      row.secret_reference,
    );
    if (sharedSecret === null) throw new ItsmConnectorRepositoryError("SECRET_UNAVAILABLE");
    return toSecret(row, sharedSecret);
  }
}
