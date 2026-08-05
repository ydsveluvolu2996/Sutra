/** Trusted scope catalog for the ADV-08 scheduler and durable handler. */
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import type { AwsBudgetsScope } from "../lib/finops-aws-budgets-organization.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const MAXIMUM_SCOPES = 10_000;

interface ScopeRow {
  readonly org_id: string;
  readonly customer_id: string;
  readonly connection_id: string;
  readonly account_id: string;
  readonly partition: AwsBudgetsScope["partition"];
}

export class AwsBudgetsRuntimeRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "STORED_STATE_INVALID";

  public constructor(code: AwsBudgetsRuntimeRepositoryError["code"]) {
    super("AWS Budgets runtime scope resolution rejected");
    this.name = "AwsBudgetsRuntimeRepositoryError";
    this.code = code;
  }
}

function reject(code: AwsBudgetsRuntimeRepositoryError["code"]): never {
  throw new AwsBudgetsRuntimeRepositoryError(code);
}

function materialize(row: ScopeRow): AwsBudgetsScope {
  if (!IDENTIFIER.test(row.org_id) || !IDENTIFIER.test(row.customer_id)
    || !CONNECTION_ID.test(row.connection_id) || !/^\d{12}$/u.test(row.account_id)
    || !["aws", "aws-us-gov", "aws-cn"].includes(row.partition)) {
    reject("STORED_STATE_INVALID");
  }
  return Object.freeze({
    orgId: row.org_id,
    customerId: row.customer_id,
    connectionId: row.connection_id,
    accountId: row.account_id,
    partition: row.partition,
  });
}

const ACTIVE_SCOPE = `
  FROM aws_connections c
  JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
  JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
    AND cu.status IN ('active','trial')
  WHERE c.source_kind = 'aws_trust_role' AND c.status = 'active'`;

export class AwsBudgetsRuntimeRepository {
  public constructor(private readonly database: D1Database = getRawDb()) {}

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  /** Server-owned scheduler inventory; no caller-supplied tenant list is used. */
  public async listActiveScopes(limit = MAXIMUM_SCOPES): Promise<readonly AwsBudgetsScope[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_SCOPES) {
      reject("INVALID_INPUT");
    }
    const database = await this.ready();
    const rows = await database.prepare(
      `SELECT c.org_id, c.customer_id, c.id AS connection_id,
              c.aws_account_id AS account_id, c.partition
         ${ACTIVE_SCOPE}
        ORDER BY c.id ASC LIMIT ?`,
    ).bind(limit + 1).all<ScopeRow>();
    const values = rows.results ?? [];
    if (values.length > limit) reject("STORED_STATE_INVALID");
    return values.map(materialize);
  }

  /** Exact same-tenant resolution used immediately before broker invocation. */
  public async loadScope(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
  }): Promise<AwsBudgetsScope> {
    if (!IDENTIFIER.test(input.orgId) || !IDENTIFIER.test(input.customerId)
      || !CONNECTION_ID.test(input.connectionId)) reject("INVALID_INPUT");
    const database = await this.ready();
    const row = await database.prepare(
      `SELECT c.org_id, c.customer_id, c.id AS connection_id,
              c.aws_account_id AS account_id, c.partition
         ${ACTIVE_SCOPE}
          AND c.org_id = ? AND c.customer_id = ? AND c.id = ? LIMIT 1`,
    ).bind(input.orgId, input.customerId, input.connectionId).first<ScopeRow>();
    if (row === null) reject("SCOPE_NOT_FOUND");
    return materialize(row);
  }
}
