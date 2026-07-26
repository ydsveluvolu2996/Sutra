// Repository for operator-supplied external cost records (licences, support,
// third-party SaaS, managed-service fees). Modelled on the CUR repository's
// replacePeriod contract: an upload REPLACES the (source, period) pair it names
// — delete + chunked insert — so a re-upload corrects a figure instead of
// double-counting it, and the caller is told how many rows were replaced.
//
// Every read and write is org+customer scoped, writes are gated on a customer
// the org actually owns, and reads are bounded. Money stays a bigint-safe
// micro-unit decimal string end to end; currencies are never mixed in a sum.
import type { NormalizedExternalCost } from "../lib/finops-external-cost.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const MICROS = /^-?\d{1,24}$/u;
const SOURCE_LABEL = /^[\p{L}\p{N}][\p{L}\p{N} ._:/+&()-]{0,63}$/u;
const MAX_INGEST_RECORDS = 20_000;
const MAX_READ_RECORDS = 20_000;
const MAX_GROUPS = 2_000;
const BATCH_CHUNK = 400;

export interface FinopsScope {
  readonly orgId: string;
  readonly customerId: string;
}

export interface ExternalCostIngestSummary {
  readonly source: string;
  readonly period: string;
  readonly inserted: number;
  /** Rows deleted by this upload — the previous version of this (source, period). */
  readonly replaced: number;
}

export interface ExternalCostGroupTotal {
  readonly source: string;
  readonly period: string;
  readonly currency: string;
  readonly amountMicros: string;
  readonly recordCount: number;
}

export interface ExternalCostCustomerTotal {
  /** The customer this spend is attributed to (per-record attribution, else the scope customer). */
  readonly customerId: string;
  readonly currency: string;
  readonly amountMicros: string;
  readonly recordCount: number;
}

interface GroupRow {
  source: string;
  period: string;
  currency: string;
  amount_micros: string | number | null;
  record_count: string | number | null;
}

interface AttributedRow {
  attributed_customer: string | null;
  currency: string;
  amount_micros: string | number | null;
  record_count: string | number | null;
}

export class FinopsExternalCostRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "LIMIT_EXCEEDED";

  public constructor(code: FinopsExternalCostRepositoryError["code"]) {
    super("FinOps external cost operation rejected");
    this.name = "FinopsExternalCostRepositoryError";
    this.code = code;
  }
}

function invalid(): never {
  throw new FinopsExternalCostRepositoryError("INVALID_INPUT");
}

function assertScope(scope: FinopsScope, connectionId?: string): void {
  if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId)) invalid();
  if (connectionId !== undefined && !CONNECTION_ID.test(connectionId)) invalid();
}

/**
 * Coerce a bigint/integer column back to a bigint-safe decimal string. Postgres
 * returns bigint (and SUM) as a string, SQLite as a number. A malformed or null
 * value becomes "0" for a SUM — never a fabricated amount, since the grouped
 * query only produces a row when rows exist.
 */
function microsText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "0";
  const text = typeof value === "number" ? String(value) : value;
  return MICROS.test(text) ? text : "0";
}

function countOf(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class FinopsExternalCostRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  /**
   * Replace the named (source, period) pair with the uploaded records. The
   * delete is scoped to exactly that pair, so uploading July's "Microsoft 365"
   * bill twice leaves one copy, and never disturbs another source or month.
   */
  public async replaceSourcePeriod(
    scope: FinopsScope,
    connectionId: string,
    source: string,
    period: string,
    records: readonly NormalizedExternalCost[],
    now = Date.now(),
  ): Promise<ExternalCostIngestSummary> {
    assertScope(scope, connectionId);
    if (!SOURCE_LABEL.test(source) || !PERIOD.test(period)) invalid();
    if (!Array.isArray(records) || records.length === 0) invalid();
    if (records.length > MAX_INGEST_RECORDS) throw new FinopsExternalCostRepositoryError("LIMIT_EXCEEDED");
    // Every record must belong to the pair being replaced; a mixed batch would
    // make the delete scope wrong and could double-count another pair.
    for (const record of records) {
      if (record.source !== source || record.period !== period) invalid();
      if (!MICROS.test(record.amountMicros) || !CURRENCY.test(record.currency)) invalid();
    }
    const db = await this.ready();
    // One authoritative ownership check up front, then plain inserts.
    const owned = await db.prepare(
      `SELECT id FROM customers WHERE id = ? AND org_id = ? AND status IN ('active', 'trial')`,
    ).bind(scope.customerId, scope.orgId).first<{ id: string }>();
    if (owned === null || owned === undefined) throw new FinopsExternalCostRepositoryError("SCOPE_NOT_FOUND");
    const deleted = await db.prepare(
      `DELETE FROM finops_external_costs
        WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND source = ? AND period = ?`,
    ).bind(scope.orgId, scope.customerId, connectionId, source, period).run();
    const insert = db.prepare(
      `INSERT INTO finops_external_costs
         (id, org_id, customer_id, connection_id, source, period, amount_micros, currency, attributed_customer, category, vendor, tags_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let offset = 0; offset < records.length; offset += BATCH_CHUNK) {
      const chunk = records.slice(offset, offset + BATCH_CHUNK).map((record) => insert.bind(
        `fx_${crypto.randomUUID().replaceAll("-", "")}`,
        scope.orgId, scope.customerId, connectionId,
        record.source.slice(0, 64), record.period, record.amountMicros, record.currency,
        typeof record.attributedCustomer === "string" ? record.attributedCustomer.slice(0, 128) : null,
        typeof record.category === "string" ? record.category.slice(0, 128) : null,
        typeof record.vendor === "string" ? record.vendor.slice(0, 128) : null,
        JSON.stringify(record.tags), now,
      ));
      await db.batch(chunk);
    }
    return { source, period, inserted: records.length, replaced: countOf(deleted.meta?.changes) };
  }

  /** Per-(source, period, currency) totals for a connection. Bounded group count. */
  public async groupTotals(scope: FinopsScope, connectionId: string): Promise<readonly ExternalCostGroupTotal[]> {
    assertScope(scope, connectionId);
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT source, period, currency, SUM(amount_micros) AS amount_micros, COUNT(*) AS record_count
         FROM finops_external_costs
        WHERE org_id = ? AND customer_id = ? AND connection_id = ?
        GROUP BY source, period, currency
        ORDER BY period DESC, source ASC, currency ASC
        LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, connectionId, MAX_GROUPS).all<GroupRow>();
    return (rows.results ?? []).flatMap((row) => (
      PERIOD.test(row.period) && CURRENCY.test(row.currency)
        ? [{
          source: row.source,
          period: row.period,
          currency: row.currency,
          amountMicros: microsText(row.amount_micros),
          recordCount: countOf(row.record_count),
        }]
        : []));
  }

  /**
   * Per-(attributed customer, currency) totals for one period, across the whole
   * org+customer scope. Per-record attribution wins when present; otherwise the
   * cost belongs to the scope customer that uploaded it. This is what the margin
   * path consumes, and it is why external cost can be broken out per customer.
   */
  public async customerTotalsForPeriod(
    scope: FinopsScope,
    connectionId: string,
    period: string,
  ): Promise<readonly ExternalCostCustomerTotal[]> {
    assertScope(scope, connectionId);
    if (!PERIOD.test(period)) invalid();
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT attributed_customer, currency, SUM(amount_micros) AS amount_micros, COUNT(*) AS record_count
         FROM finops_external_costs
        WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND period = ?
        GROUP BY attributed_customer, currency
        ORDER BY currency ASC
        LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, connectionId, period, MAX_GROUPS).all<AttributedRow>();
    return (rows.results ?? []).flatMap((row) => {
      if (!CURRENCY.test(row.currency)) return [];
      const attributed = typeof row.attributed_customer === "string" && IDENTIFIER.test(row.attributed_customer)
        ? row.attributed_customer
        : scope.customerId;
      return [{
        customerId: attributed,
        currency: row.currency,
        amountMicros: microsText(row.amount_micros),
        recordCount: countOf(row.record_count),
      }];
    });
  }

  /** Bounded record listing for one (source, period), for operator inspection. */
  public async recordsForSourcePeriod(
    scope: FinopsScope,
    connectionId: string,
    source: string,
    period: string,
  ): Promise<readonly NormalizedExternalCost[]> {
    assertScope(scope, connectionId);
    if (!SOURCE_LABEL.test(source) || !PERIOD.test(period)) invalid();
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT source, period, amount_micros, currency, attributed_customer, category, vendor, tags_json
         FROM finops_external_costs
        WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND source = ? AND period = ?
        ORDER BY id ASC LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, connectionId, source, period, MAX_READ_RECORDS).all<{
      source: string; period: string; amount_micros: string | number | null; currency: string;
      attributed_customer: string | null; category: string | null; vendor: string | null; tags_json: string;
    }>();
    return (rows.results ?? []).flatMap((row) => {
      if (!CURRENCY.test(row.currency) || !PERIOD.test(row.period)) return [];
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
        source: row.source,
        period: row.period,
        amountMicros: microsText(row.amount_micros),
        currency: row.currency,
        attributedCustomer: typeof row.attributed_customer === "string" && row.attributed_customer.length > 0 ? row.attributed_customer : null,
        category: typeof row.category === "string" && row.category.length > 0 ? row.category : null,
        vendor: typeof row.vendor === "string" && row.vendor.length > 0 ? row.vendor : null,
        tags,
      }];
    });
  }

  /** Delete one (source, period). Returns the number of records removed. */
  public async deleteSourcePeriod(
    scope: FinopsScope,
    connectionId: string,
    source: string,
    period: string,
  ): Promise<number> {
    assertScope(scope, connectionId);
    if (!SOURCE_LABEL.test(source) || !PERIOD.test(period)) invalid();
    const db = await this.ready();
    const result = await db.prepare(
      `DELETE FROM finops_external_costs
        WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND source = ? AND period = ?`,
    ).bind(scope.orgId, scope.customerId, connectionId, source, period).run();
    return countOf(result.meta?.changes);
  }
}
