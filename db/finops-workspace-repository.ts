// Repository for ingested billing lines and budget definitions. An upload
// REPLACES the billing period it names (delete + insert in one batch) so a
// re-upload never double-counts; the caller is told how many rows were
// replaced. Reads are bounded and org+customer scoped. Budget definitions
// are operator configuration, validated before storage.
import type { NormalizedCurLine } from "../lib/finops-cur.ts";
import type { BudgetDefinition } from "../lib/finops-insights.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const BILLING_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/u;
const BUDGET_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._:/+-]{0,79}$/u;
const BUDGET_ID = /^fb_[a-f0-9]{32}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const MICROS = /^-?\d{1,24}$/u;
const MAX_INGEST_LINES = 20_000;
const MAX_READ_LINES = 50_000;
const MAX_BUDGETS = 100;
const BATCH_CHUNK = 400;

export interface FinopsScope {
  readonly orgId: string;
  readonly customerId: string;
}

export interface StoredBudget extends BudgetDefinition {
  readonly createdBy: string;
  readonly updatedAt: string;
}

export interface CurIngestSummary {
  readonly billingPeriod: string;
  readonly inserted: number;
  readonly replaced: number;
}

interface LineRow {
  line_item_id: string;
  usage_account_id: string;
  service: string;
  charge_category: string;
  usage_start: string;
  amount_micros: string;
  currency: string;
  tags_json: string;
}

interface BudgetRow {
  id: string;
  name: string;
  currency: string;
  limit_micros: string;
  filter_json: string | null;
  created_by: string;
  updated_at: string;
}

export class FinopsWorkspaceRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "LIMIT_EXCEEDED";

  public constructor(code: FinopsWorkspaceRepositoryError["code"]) {
    super("FinOps workspace operation rejected");
    this.name = "FinopsWorkspaceRepositoryError";
    this.code = code;
  }
}

function invalid(): never {
  throw new FinopsWorkspaceRepositoryError("INVALID_INPUT");
}

function assertScope(scope: FinopsScope, connectionId?: string): void {
  if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId)) invalid();
  if (connectionId !== undefined && !CONNECTION_ID.test(connectionId)) invalid();
}

function parseFilter(json: string | null): BudgetDefinition["filter"] {
  if (json === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const candidate = parsed as { dimension?: unknown; tagKey?: unknown; value?: unknown };
    if (
      (candidate.dimension === "account" || candidate.dimension === "service" || candidate.dimension === "tag") &&
      typeof candidate.value === "string" &&
      (candidate.tagKey === undefined || typeof candidate.tagKey === "string")
    ) {
      return { dimension: candidate.dimension, tagKey: candidate.tagKey as string | undefined, value: candidate.value };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export class FinopsWorkspaceRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  /** Replace the named billing period with the uploaded lines. */
  public async replacePeriod(
    scope: FinopsScope,
    connectionId: string,
    billingPeriod: string,
    lines: readonly NormalizedCurLine[],
    now = Date.now(),
  ): Promise<CurIngestSummary> {
    assertScope(scope, connectionId);
    if (!BILLING_PERIOD.test(billingPeriod)) invalid();
    if (!Array.isArray(lines) || lines.length === 0) invalid();
    if (lines.length > MAX_INGEST_LINES) throw new FinopsWorkspaceRepositoryError("LIMIT_EXCEEDED");
    const db = await this.ready();
    // Writes are gated to an owned customer up front (no gating subselect per
    // row — one authoritative check, then plain inserts).
    const owned = await db.prepare(
      `SELECT id FROM customers WHERE id = ? AND org_id = ? AND status IN ('active', 'trial')`,
    ).bind(scope.customerId, scope.orgId).first<{ id: string }>();
    if (owned === null || owned === undefined) throw new FinopsWorkspaceRepositoryError("SCOPE_NOT_FOUND");
    const timestamp = new Date(now).toISOString();
    const deleted = await db.prepare(
      `DELETE FROM finops_cur_lines WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND billing_period = ?`,
    ).bind(scope.orgId, scope.customerId, connectionId, billingPeriod).run();
    const insert = db.prepare(
      `INSERT INTO finops_cur_lines
         (id, org_id, customer_id, connection_id, billing_period, line_item_id, usage_account_id, service, charge_category, usage_start, amount_micros, currency, tags_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let offset = 0; offset < lines.length; offset += BATCH_CHUNK) {
      const chunk = lines.slice(offset, offset + BATCH_CHUNK).map((line) => insert.bind(
        `fl_${crypto.randomUUID().replaceAll("-", "")}`,
        scope.orgId, scope.customerId, connectionId, billingPeriod,
        line.lineItemId.slice(0, 256), line.usageAccountId.slice(0, 64), line.service.slice(0, 128),
        line.chargeCategory.slice(0, 64), line.usageStartIso, line.amountMicros, line.currency,
        JSON.stringify(line.tags), timestamp,
      ));
      await db.batch(chunk);
    }
    return {
      billingPeriod,
      inserted: lines.length,
      replaced: Number(deleted.meta?.changes ?? 0),
    };
  }

  public async listPeriods(scope: FinopsScope, connectionId: string): Promise<readonly { period: string; lineCount: number }[]> {
    assertScope(scope, connectionId);
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT billing_period AS period, COUNT(*) AS line_count
         FROM finops_cur_lines
        WHERE org_id = ? AND customer_id = ? AND connection_id = ?
        GROUP BY billing_period ORDER BY billing_period DESC`,
    ).bind(scope.orgId, scope.customerId, connectionId).all<{ period: string; line_count: number }>();
    return (rows.results ?? []).map((row) => ({ period: row.period, lineCount: Number(row.line_count) }));
  }

  public async linesForPeriod(
    scope: FinopsScope,
    connectionId: string,
    billingPeriod: string,
  ): Promise<readonly NormalizedCurLine[]> {
    assertScope(scope, connectionId);
    if (!BILLING_PERIOD.test(billingPeriod)) invalid();
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT line_item_id, usage_account_id, service, charge_category, usage_start, amount_micros, currency, tags_json
         FROM finops_cur_lines
        WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND billing_period = ?
        ORDER BY usage_start ASC, line_item_id ASC LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, connectionId, billingPeriod, MAX_READ_LINES).all<LineRow>();
    return (rows.results ?? []).flatMap((row) => {
      if (!MICROS.test(row.amount_micros) || !CURRENCY.test(row.currency)) return [];
      let tags: Record<string, string> = {};
      try {
        const parsed: unknown = JSON.parse(row.tags_json);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") tags[key] = value;
        }
      } catch {
        tags = {};
      }
      return [{
        lineItemId: row.line_item_id,
        usageAccountId: row.usage_account_id,
        service: row.service,
        chargeCategory: row.charge_category,
        usageStartIso: row.usage_start,
        amountMicros: row.amount_micros,
        currency: row.currency,
        tags,
      }];
    });
  }

  public async saveBudget(
    scope: FinopsScope,
    input: { name: string; currency: string; limitMicros: string; filter?: BudgetDefinition["filter"] },
    createdBy: string,
    now = Date.now(),
  ): Promise<StoredBudget> {
    assertScope(scope);
    if (!BUDGET_NAME.test(input.name) || !CURRENCY.test(input.currency) || !MICROS.test(input.limitMicros) || !IDENTIFIER.test(createdBy)) invalid();
    if (input.limitMicros.startsWith("-")) invalid();
    if (input.filter !== undefined) {
      const valid = (input.filter.dimension === "account" || input.filter.dimension === "service" || input.filter.dimension === "tag") &&
        typeof input.filter.value === "string" && input.filter.value.length > 0 && input.filter.value.length <= 128 &&
        (input.filter.dimension !== "tag" || (typeof input.filter.tagKey === "string" && input.filter.tagKey.length > 0));
      if (!valid) invalid();
    }
    const db = await this.ready();
    const countRow = await db.prepare(`SELECT COUNT(*) AS total FROM finops_budgets WHERE org_id = ?`).bind(scope.orgId).first<{ total: number }>();
    if (Number(countRow?.total ?? 0) >= MAX_BUDGETS) throw new FinopsWorkspaceRepositoryError("LIMIT_EXCEEDED");
    const id = `fb_${crypto.randomUUID().replaceAll("-", "")}`;
    const timestamp = new Date(now).toISOString();
    const result = await db.prepare(
      `INSERT INTO finops_budgets (id, org_id, customer_id, name, currency, limit_micros, filter_json, created_by, created_at, updated_at)
       SELECT ?, c.org_id, c.id, ?, ?, ?, ?, ?, ?, ?
         FROM customers c
        WHERE c.id = ? AND c.org_id = ? AND c.status IN ('active', 'trial')
       ON CONFLICT (org_id, name) DO UPDATE SET
         currency = excluded.currency,
         limit_micros = excluded.limit_micros,
         filter_json = excluded.filter_json,
         updated_at = excluded.updated_at`,
    ).bind(
      id, input.name, input.currency, input.limitMicros,
      input.filter === undefined ? null : JSON.stringify(input.filter),
      createdBy, timestamp, timestamp,
      scope.customerId, scope.orgId,
    ).run();
    if (Number(result.meta?.changes ?? 0) === 0) throw new FinopsWorkspaceRepositoryError("SCOPE_NOT_FOUND");
    return { id, name: input.name, currency: input.currency, limitMicros: input.limitMicros, filter: input.filter, createdBy, updatedAt: timestamp };
  }

  public async listBudgets(scope: FinopsScope): Promise<readonly StoredBudget[]> {
    assertScope(scope);
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT id, name, currency, limit_micros, filter_json, created_by, updated_at
         FROM finops_budgets WHERE org_id = ? ORDER BY name ASC`,
    ).bind(scope.orgId).all<BudgetRow>();
    return (rows.results ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      currency: row.currency,
      limitMicros: row.limit_micros,
      filter: parseFilter(row.filter_json),
      createdBy: row.created_by,
      updatedAt: row.updated_at,
    }));
  }

  public async deleteBudget(scope: FinopsScope, id: string): Promise<boolean> {
    assertScope(scope);
    if (!BUDGET_ID.test(id)) invalid();
    const db = await this.ready();
    const result = await db.prepare(`DELETE FROM finops_budgets WHERE id = ? AND org_id = ?`).bind(id, scope.orgId).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }
}
