// Persistence for MSP margin rates. One row per (org_id, customer_id): the
// markup percentage and optional fixed monthly fee this MSP applies to a
// customer's cloud cost. Operator configuration — validated before storage,
// bounded per tenant, org taken from the authorized scope (never the caller).
// Dual D1/Postgres access mirrors finops-workspace-repository.
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const MICROS = /^\d{1,24}$/u; // non-negative fee
const MAX_MARKUP_PERCENT = 1_000;
const MAX_LIST_ROWS = 1_000;

export interface CustomerMarginScope {
  readonly orgId: string;
  readonly customerId: string;
}

export interface CustomerMarginInput {
  readonly customerId: string;
  readonly markupPercent: number;
  readonly monthlyFeeMicros: string;
  readonly currency: string;
}

export interface StoredCustomerMargin {
  readonly customerId: string;
  readonly markupPercent: number;
  readonly monthlyFeeMicros: string;
  readonly currency: string;
  readonly updatedAt: string;
}

interface MarginRow {
  customer_id: string;
  markup_percent: number;
  monthly_fee_micros: string | number;
  currency: string;
  updated_at: string | number;
}

export class CustomerMarginRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND";

  public constructor(code: CustomerMarginRepositoryError["code"]) {
    super("Customer-margin operation rejected");
    this.name = "CustomerMarginRepositoryError";
    this.code = code;
  }
}

function invalid(): never {
  throw new CustomerMarginRepositoryError("INVALID_INPUT");
}

function toIso(value: string | number): string {
  if (typeof value === "number") return new Date(value).toISOString();
  return /^\d+$/u.test(value) ? new Date(Number(value)).toISOString() : value;
}

function toMicros(value: string | number): string {
  const text = typeof value === "number" ? String(Math.trunc(value)) : value;
  return MICROS.test(text) ? text : "0";
}

function toStored(row: MarginRow): StoredCustomerMargin {
  return {
    customerId: row.customer_id,
    markupPercent: Number(row.markup_percent),
    monthlyFeeMicros: toMicros(row.monthly_fee_micros),
    currency: row.currency,
    updatedAt: toIso(row.updated_at),
  };
}

export class CustomerMarginRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  public async list(orgId: string): Promise<readonly StoredCustomerMargin[]> {
    if (!IDENTIFIER.test(orgId)) invalid();
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT customer_id, markup_percent, monthly_fee_micros, currency, updated_at
         FROM customer_margin WHERE org_id = ? ORDER BY customer_id ASC LIMIT ?`,
    ).bind(orgId, MAX_LIST_ROWS).all<MarginRow>();
    return (rows.results ?? []).map(toStored);
  }

  /** Insert or replace the margin rate for one owned customer. */
  public async upsert(scope: CustomerMarginScope, input: CustomerMarginInput, now = Date.now()): Promise<StoredCustomerMargin> {
    if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId)) invalid();
    if (input.customerId !== scope.customerId) invalid();
    if (!CURRENCY.test(input.currency)) invalid();
    if (!MICROS.test(input.monthlyFeeMicros)) invalid();
    if (!Number.isFinite(input.markupPercent) || input.markupPercent < 0 || input.markupPercent > MAX_MARKUP_PERCENT) invalid();
    const db = await this.ready();
    // Gate to an owned, active customer up front.
    const owned = await db.prepare(
      `SELECT id FROM customers WHERE id = ? AND org_id = ? AND status IN ('active', 'trial')`,
    ).bind(scope.customerId, scope.orgId).first<{ id: string }>();
    if (owned === null || owned === undefined) throw new CustomerMarginRepositoryError("SCOPE_NOT_FOUND");
    const id = `cm_${crypto.randomUUID().replaceAll("-", "")}`;
    await db.prepare(
      `INSERT INTO customer_margin (id, org_id, customer_id, markup_percent, monthly_fee_micros, currency, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (org_id, customer_id) DO UPDATE SET
         markup_percent = excluded.markup_percent,
         monthly_fee_micros = excluded.monthly_fee_micros,
         currency = excluded.currency,
         updated_at = excluded.updated_at`,
    ).bind(id, scope.orgId, scope.customerId, input.markupPercent, input.monthlyFeeMicros, input.currency, now).run();
    return {
      customerId: scope.customerId,
      markupPercent: input.markupPercent,
      monthlyFeeMicros: input.monthlyFeeMicros,
      currency: input.currency,
      updatedAt: new Date(now).toISOString(),
    };
  }

  public async delete(scope: CustomerMarginScope): Promise<boolean> {
    if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId)) invalid();
    const db = await this.ready();
    const result = await db.prepare(
      `DELETE FROM customer_margin WHERE org_id = ? AND customer_id = ?`,
    ).bind(scope.orgId, scope.customerId).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }
}
