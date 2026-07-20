// Persistence for FinOps UNIT COUNTS — the business-metric denominators (e.g.
// "transactions", "seats") that the pure unit-economics engine
// (lib/finops-unit-economics.ts) divides attributed spend by. Unit counts are
// NOT present in billing data, so an operator supplies them per tenant, per
// period, per label. This repository is the durable store the insights route
// reads those counts back from.
//
// Every row is tenant-scoped (org_id + customer_id) and every read/write is
// gated to an owned, active customer — a re-upsert of the same
// (org_id, customer_id, period, unit_label) key REPLACES the count rather than
// inserting a duplicate, so a corrected count never double-stores. The dual
// D1/Postgres access mirrors finops-workspace-repository: one D1Database
// interface, the Postgres adapter translates placeholders and ON CONFLICT.
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/u;
// Unit labels are short, machine-friendly metric names (e.g. "transactions",
// "active-seats", "api_requests"). A strict charset keeps a label from being
// used to smuggle arbitrary text into the store.
const UNIT_LABEL = /^[a-z][a-z0-9_-]{0,47}$/u;
// A generous but finite ceiling: a count is a whole non-negative denominator,
// never negative and never beyond a safely representable integer.
const MAX_UNIT_COUNT = 1_000_000_000_000;
const MAX_READ_ROWS = 5_000;

export interface FinopsUnitCountScope {
  readonly orgId: string;
  readonly customerId: string;
}

export interface UnitCountInput {
  readonly period: string;
  readonly unitLabel: string;
  readonly count: number;
}

export interface StoredUnitCount {
  readonly customerId: string;
  readonly period: string;
  readonly unitLabel: string;
  readonly count: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface UnitCountRow {
  customer_id: string;
  period: string;
  unit_label: string;
  unit_count: number;
  created_at: string;
  updated_at: string;
}

export class FinopsUnitCountRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND";

  public constructor(code: FinopsUnitCountRepositoryError["code"]) {
    super("FinOps unit-count operation rejected");
    this.name = "FinopsUnitCountRepositoryError";
    this.code = code;
  }
}

function invalid(): never {
  throw new FinopsUnitCountRepositoryError("INVALID_INPUT");
}

function assertScope(scope: FinopsUnitCountScope): void {
  if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId)) invalid();
}

/** Pure, exported validation so the route and the repository agree exactly. */
export function isValidUnitLabel(value: string): boolean {
  return UNIT_LABEL.test(value);
}

export function isValidPeriod(value: string): boolean {
  return PERIOD.test(value);
}

export function isValidUnitCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_UNIT_COUNT;
}

function toStored(row: UnitCountRow): StoredUnitCount {
  return {
    customerId: row.customer_id,
    period: row.period,
    unitLabel: row.unit_label,
    count: Number(row.unit_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class FinopsUnitCountRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  /**
   * Store (or replace) the unit count for one tenant/period/label. Gated to an
   * owned active customer up front; a repeat of the same key updates the count
   * and updated_at in place, preserving the original created_at.
   */
  public async upsert(scope: FinopsUnitCountScope, input: UnitCountInput, now = Date.now()): Promise<StoredUnitCount> {
    assertScope(scope);
    if (!PERIOD.test(input.period) || !UNIT_LABEL.test(input.unitLabel) || !isValidUnitCount(input.count)) invalid();
    const db = await this.ready();
    const id = `fuc_${crypto.randomUUID().replaceAll("-", "")}`;
    const timestamp = new Date(now).toISOString();
    const result = await db.prepare(
      `INSERT INTO finops_unit_counts (id, org_id, customer_id, period, unit_label, unit_count, created_at, updated_at)
       SELECT ?, c.org_id, c.id, ?, ?, ?, ?, ?
         FROM customers c
        WHERE c.id = ? AND c.org_id = ? AND c.status IN ('active', 'trial')
       ON CONFLICT (org_id, customer_id, period, unit_label) DO UPDATE SET
         unit_count = excluded.unit_count,
         updated_at = excluded.updated_at`,
    ).bind(
      id, input.period, input.unitLabel, input.count, timestamp, timestamp,
      scope.customerId, scope.orgId,
    ).run();
    if (Number(result.meta?.changes ?? 0) === 0) throw new FinopsUnitCountRepositoryError("SCOPE_NOT_FOUND");
    const stored = await db.prepare(
      `SELECT customer_id, period, unit_label, unit_count, created_at, updated_at
         FROM finops_unit_counts
        WHERE org_id = ? AND customer_id = ? AND period = ? AND unit_label = ? LIMIT 1`,
    ).bind(scope.orgId, scope.customerId, input.period, input.unitLabel).first<UnitCountRow>();
    if (stored === null) throw new FinopsUnitCountRepositoryError("SCOPE_NOT_FOUND");
    return toStored(stored);
  }

  /** List the tenant's stored unit counts, optionally filtered to one period. */
  public async list(scope: FinopsUnitCountScope, options: { readonly period?: string } = {}): Promise<readonly StoredUnitCount[]> {
    assertScope(scope);
    if (options.period !== undefined && !PERIOD.test(options.period)) invalid();
    const db = await this.ready();
    const rows = options.period === undefined
      ? await db.prepare(
        `SELECT customer_id, period, unit_label, unit_count, created_at, updated_at
           FROM finops_unit_counts
          WHERE org_id = ? AND customer_id = ?
          ORDER BY period DESC, unit_label ASC LIMIT ?`,
      ).bind(scope.orgId, scope.customerId, MAX_READ_ROWS).all<UnitCountRow>()
      : await db.prepare(
        `SELECT customer_id, period, unit_label, unit_count, created_at, updated_at
           FROM finops_unit_counts
          WHERE org_id = ? AND customer_id = ? AND period = ?
          ORDER BY unit_label ASC LIMIT ?`,
      ).bind(scope.orgId, scope.customerId, options.period, MAX_READ_ROWS).all<UnitCountRow>();
    return (rows.results ?? []).map(toStored);
  }
}
