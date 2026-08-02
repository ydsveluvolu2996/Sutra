/** Trusted scheduler, scope, target and watermark catalog for ADV-09. */
import type {
  AwsSupportCasesJobScope,
  AwsSupportCasesSnapshotWriter,
  AwsSupportCasesTargetResolver,
} from "../lib/finops-aws-support-cases-job.ts";
import type {
  AwsSupportCollectionWindow,
  AwsSupportIntendedAccount,
} from "../lib/finops-aws-support-cases-radar.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import { AwsSupportCasesRepository } from "./finops-aws-support-cases-repository.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const MAX_SCOPES = 10_000;
const MAX_ACCOUNTS = 200;
const DAY_MS = 24 * 60 * 60 * 1_000;
const INITIAL_LOOKBACK_MS = 730 * DAY_MS;
const INCREMENTAL_OVERLAP_MS = 48 * 60 * 60 * 1_000;
const INCREMENTAL_ADVANCE_MS = 29 * DAY_MS;

interface ScopeRow {
  readonly org_id: string;
  readonly customer_id: string;
  readonly connection_id: string;
  readonly partition: "aws" | "aws-us-gov";
}

interface TargetRow {
  readonly account_id: string;
  readonly connection_id: string;
  readonly permission_pack_version: string;
}

interface WatermarkRow {
  readonly data_through_at: string;
}

export class AwsSupportCasesRuntimeRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "STORED_STATE_INVALID" | "BOUND_REACHED" | "PERMISSION_PACK_UPGRADE_REQUIRED";
  public constructor(code: AwsSupportCasesRuntimeRepositoryError["code"]) {
    super("AWS Support cases trusted runtime resolution rejected");
    this.name = "AwsSupportCasesRuntimeRepositoryError";
    this.code = code;
  }
}

function reject(code: AwsSupportCasesRuntimeRepositoryError["code"]): never {
  throw new AwsSupportCasesRuntimeRepositoryError(code);
}

function canonicalIso(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function materializeScope(row: ScopeRow): AwsSupportCasesJobScope {
  if (!IDENTIFIER.test(row.org_id) || !IDENTIFIER.test(row.customer_id)
    || !CONNECTION_ID.test(row.connection_id)
    || (row.partition !== "aws" && row.partition !== "aws-us-gov")) {
    return reject("STORED_STATE_INVALID");
  }
  return Object.freeze({
    organizationId: row.org_id,
    customerId: row.customer_id,
    parentConnectionId: row.connection_id,
    partition: row.partition,
  });
}

const LIVE_CONNECTION = `
  FROM aws_connections c
  JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
  JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
    AND cu.status IN ('active','trial')
  WHERE c.source_kind = 'aws_trust_role' AND c.status = 'active'
    AND c.partition IN ('aws','aws-us-gov')`;
const LIVE_SCOPE = `${LIVE_CONNECTION}
    AND c.permission_pack_version = 'standard-2026-08.7'`;

export class AwsSupportCasesRuntimeRepository
implements AwsSupportCasesTargetResolver, AwsSupportCasesSnapshotWriter {
  private readonly snapshots: AwsSupportCasesRepository;

  public constructor(private readonly database: D1Database = getRawDb()) {
    this.snapshots = new AwsSupportCasesRepository(database);
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  /** Daily scheduler inventory, excluding scopes already at the tick ceiling. */
  public async listEligibleScopes(
    ceilingIso: string,
    limit = MAX_SCOPES,
  ): Promise<readonly AwsSupportCasesJobScope[]> {
    if (!canonicalIso(ceilingIso) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SCOPES) {
      return reject("INVALID_INPUT");
    }
    const database = await this.ready();
    const rows = await database.prepare(
      `SELECT c.org_id, c.customer_id, c.id AS connection_id, c.partition
         ${LIVE_SCOPE}
         AND NOT EXISTS (
           SELECT 1 FROM aws_connections anchor
            WHERE anchor.org_id = c.org_id AND anchor.customer_id = c.customer_id
              AND anchor.partition = c.partition
              AND anchor.source_kind = 'aws_trust_role' AND anchor.status = 'active'
              AND anchor.permission_pack_version = 'standard-2026-08.7'
              AND (anchor.aws_account_id < c.aws_account_id
                OR (anchor.aws_account_id = c.aws_account_id AND anchor.id < c.id))
         )
         AND NOT EXISTS (
           SELECT 1 FROM finops_aws_support_case_heads h
           JOIN finops_aws_support_case_snapshots s
             ON s.generation_id = h.active_generation_id
            AND s.org_id = h.org_id AND s.customer_id = h.customer_id
            AND s.connection_id = h.connection_id
          WHERE h.org_id = c.org_id AND h.customer_id = c.customer_id
            AND h.connection_id = c.id AND s.data_through_at >= ?
         )
        ORDER BY c.id ASC LIMIT ?`,
    ).bind(ceilingIso, limit + 1).all<ScopeRow>();
    const values = rows.results ?? [];
    if (values.length > limit) return reject("BOUND_REACHED");
    return values.map(materializeScope);
  }

  /** One stable cohort anchor prevents an N-account organization from producing N² reads. */
  public async loadCanonicalScope(input: {
    readonly organizationId: string;
    readonly customerId: string;
    readonly partition: "aws" | "aws-us-gov";
  }): Promise<AwsSupportCasesJobScope> {
    if (!IDENTIFIER.test(input.organizationId) || !IDENTIFIER.test(input.customerId)
      || (input.partition !== "aws" && input.partition !== "aws-us-gov")) {
      return reject("INVALID_INPUT");
    }
    const database = await this.ready();
    const row = await database.prepare(
      `SELECT c.org_id, c.customer_id, c.id AS connection_id, c.partition
         ${LIVE_SCOPE}
          AND c.org_id = ? AND c.customer_id = ? AND c.partition = ?
        ORDER BY c.aws_account_id ASC, c.id ASC LIMIT 1`,
    ).bind(input.organizationId, input.customerId, input.partition).first<ScopeRow>();
    return row === null ? reject("SCOPE_NOT_FOUND") : materializeScope(row);
  }

  public async loadScope(input: {
    readonly organizationId: string;
    readonly customerId: string;
    readonly connectionId: string;
  }): Promise<AwsSupportCasesJobScope> {
    if (!IDENTIFIER.test(input.organizationId) || !IDENTIFIER.test(input.customerId)
      || !CONNECTION_ID.test(input.connectionId)) return reject("INVALID_INPUT");
    const database = await this.ready();
    const row = await database.prepare(
      `SELECT c.org_id, c.customer_id, c.id AS connection_id, c.partition
         ${LIVE_SCOPE}
          AND c.org_id = ? AND c.customer_id = ? AND c.id = ? LIMIT 1`,
    ).bind(input.organizationId, input.customerId, input.connectionId).first<ScopeRow>();
    return row === null ? reject("SCOPE_NOT_FOUND") : materializeScope(row);
  }

  /** Exact same-tenant and same-partition account fan-out resolved from persistence. */
  public async resolve(scope: AwsSupportCasesJobScope): Promise<readonly AwsSupportIntendedAccount[]> {
    const trusted = await this.loadScope({
      organizationId: scope.organizationId,
      customerId: scope.customerId,
      connectionId: scope.parentConnectionId,
    });
    if (trusted.partition !== scope.partition) return reject("SCOPE_NOT_FOUND");
    const database = await this.ready();
    const rows = await database.prepare(
      `SELECT c.aws_account_id AS account_id, c.id AS connection_id,
              c.permission_pack_version
         ${LIVE_CONNECTION}
          AND c.org_id = ? AND c.customer_id = ? AND c.partition = ?
        ORDER BY c.aws_account_id ASC, c.id ASC LIMIT ?`,
    ).bind(scope.organizationId, scope.customerId, scope.partition, MAX_ACCOUNTS + 1).all<TargetRow>();
    const values = rows.results ?? [];
    if (values.length < 1) return reject("SCOPE_NOT_FOUND");
    if (values.length > MAX_ACCOUNTS) return reject("BOUND_REACHED");
    const accounts = new Set<string>();
    const connections = new Set<string>();
    return values.map((row) => {
      if (row.permission_pack_version !== "standard-2026-08.7") {
        return reject("PERMISSION_PACK_UPGRADE_REQUIRED");
      }
      if (!ACCOUNT_ID.test(row.account_id) || !CONNECTION_ID.test(row.connection_id)
        || accounts.has(row.account_id) || connections.has(row.connection_id)) {
        return reject("STORED_STATE_INVALID");
      }
      accounts.add(row.account_id);
      connections.add(row.connection_id);
      return Object.freeze({ accountId: row.account_id, connectionId: row.connection_id });
    });
  }

  /** Complete-head watermark only: failed/partial attempts can never skip evidence. */
  public async resolveWindow(
    scope: AwsSupportCasesJobScope,
    ceilingIso: string,
  ): Promise<AwsSupportCollectionWindow> {
    if (!canonicalIso(ceilingIso)) return reject("INVALID_INPUT");
    await this.loadScope({
      organizationId: scope.organizationId,
      customerId: scope.customerId,
      connectionId: scope.parentConnectionId,
    });
    const database = await this.ready();
    const row = await database.prepare(
      `SELECT s.data_through_at
         FROM finops_aws_support_case_heads h
         JOIN finops_aws_support_case_snapshots s
           ON s.generation_id = h.active_generation_id
          AND s.org_id = h.org_id AND s.customer_id = h.customer_id
          AND s.connection_id = h.connection_id
        WHERE h.org_id = ? AND h.customer_id = ? AND h.connection_id = ? LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.parentConnectionId).first<WatermarkRow>();
    const ceilingMs = Date.parse(ceilingIso);
    if (row === null) {
      return Object.freeze({
        mode: "INITIAL",
        afterTime: new Date(ceilingMs - INITIAL_LOOKBACK_MS).toISOString(),
        beforeTime: ceilingIso,
        priorWatermark: null,
        nextWatermark: ceilingIso,
      });
    }
    if (!canonicalIso(row.data_through_at)) return reject("STORED_STATE_INVALID");
    const priorMs = Date.parse(row.data_through_at);
    if (priorMs >= ceilingMs) return reject("INVALID_INPUT");
    const beforeMs = Math.min(ceilingMs, priorMs + INCREMENTAL_ADVANCE_MS);
    const beforeTime = new Date(beforeMs).toISOString();
    return Object.freeze({
      mode: "INCREMENTAL",
      afterTime: new Date(priorMs - INCREMENTAL_OVERLAP_MS).toISOString(),
      beforeTime,
      priorWatermark: row.data_through_at,
      nextWatermark: beforeTime,
    });
  }

  public async record(scope: AwsSupportCasesJobScope, snapshot: Parameters<AwsSupportCasesRepository["recordSnapshot"]>[1]): Promise<void> {
    await this.snapshots.recordSnapshot({
      organizationId: scope.organizationId,
      customerId: scope.customerId,
      connectionId: scope.parentConnectionId,
    }, snapshot);
  }
}
