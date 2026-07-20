// Persistence for SAVED REPORT VIEWS — the named report-builder definitions an
// operator saves and reloads. A definition is a pure, declarative shape
// (dataset + filters + columns + sort + limit); it holds NO collected evidence,
// only the query that shapes it. The rows themselves are always re-loaded live
// and tenant-scoped at run time, so a saved view can never leak stale or
// cross-tenant data.
//
// Every row is tenant-scoped (org_id + customer_id). save() is gated to an
// owned, active customer up front (the gating SELECT writes nothing otherwise)
// and upserts by (org_id, name) so re-saving a view REPLACES it rather than
// duplicating. list/get/delete are scoped to the owning org + customer. A
// stored definition that no longer validates is dropped from listings and
// treated as missing rather than run with guessed semantics. Dual D1/Postgres
// access mirrors db/finops-unit-count-repository.ts.
import { validateReportDefinition, type ReportDataset, type ReportDefinition } from "../lib/report-builder.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const REPORT_ID = /^rpt_[a-f0-9]{32}$/u;
const REPORT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._:/+-]{0,79}$/u;
const MAX_SAVED_REPORTS = 200;

export interface SavedReportScope {
  readonly orgId: string;
  readonly customerId: string;
}

export interface SavedReport {
  readonly id: string;
  readonly name: string;
  readonly dataset: ReportDataset;
  readonly definition: ReportDefinition;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface SavedReportRow {
  id: string;
  name: string;
  dataset: string;
  definition_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export class SavedReportRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "LIMIT_EXCEEDED";

  public constructor(code: SavedReportRepositoryError["code"]) {
    super("Saved-report operation rejected");
    this.name = "SavedReportRepositoryError";
    this.code = code;
  }
}

function invalid(): never {
  throw new SavedReportRepositoryError("INVALID_INPUT");
}

function assertScope(scope: SavedReportScope): void {
  if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId)) invalid();
}

/** Map a row to a SavedReport, or null if the stored definition no longer
 * validates (it is treated as missing rather than run with guessed semantics). */
function toSavedReport(row: SavedReportRow): SavedReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.definition_json);
  } catch {
    return null;
  }
  const validation = validateReportDefinition(parsed);
  if (validation.definition === null) return null;
  return {
    id: row.id,
    name: row.name,
    dataset: validation.definition.dataset,
    definition: validation.definition,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SavedReportRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  /** Create or update (by name) a saved report view. Gated to an owned active
   * customer; a repeat of the same name REPLACES the definition in place. */
  public async save(
    scope: SavedReportScope,
    name: string,
    definitionInput: unknown,
    createdBy: string,
    now = Date.now(),
  ): Promise<SavedReport> {
    assertScope(scope);
    if (!REPORT_NAME.test(name) || !IDENTIFIER.test(createdBy)) invalid();
    const validation = validateReportDefinition(definitionInput);
    if (validation.definition === null) invalid();
    const definition = validation.definition;
    const db = await this.ready();
    const countRow = await db.prepare(
      `SELECT COUNT(*) AS total FROM saved_reports WHERE org_id = ?`,
    ).bind(scope.orgId).first<{ total: number }>();
    if (Number(countRow?.total ?? 0) >= MAX_SAVED_REPORTS) throw new SavedReportRepositoryError("LIMIT_EXCEEDED");
    const id = `rpt_${crypto.randomUUID().replaceAll("-", "")}`;
    const timestamp = new Date(now).toISOString();
    const result = await db.prepare(
      `INSERT INTO saved_reports (id, org_id, customer_id, name, dataset, definition_json, created_by, created_at, updated_at)
       SELECT ?, c.org_id, c.id, ?, ?, ?, ?, ?, ?
         FROM customers c
        WHERE c.id = ? AND c.org_id = ? AND c.status IN ('active', 'trial')
       ON CONFLICT (org_id, name) DO UPDATE SET
         dataset = excluded.dataset,
         definition_json = excluded.definition_json,
         updated_at = excluded.updated_at`,
    ).bind(
      id, name, definition.dataset, JSON.stringify(definition), createdBy, timestamp, timestamp,
      scope.customerId, scope.orgId,
    ).run();
    if (Number(result.meta?.changes ?? 0) === 0) throw new SavedReportRepositoryError("SCOPE_NOT_FOUND");
    const stored = await db.prepare(
      `SELECT id, name, dataset, definition_json, created_by, created_at, updated_at
         FROM saved_reports WHERE org_id = ? AND name = ? LIMIT 1`,
    ).bind(scope.orgId, name).first<SavedReportRow>();
    if (stored === null) throw new SavedReportRepositoryError("SCOPE_NOT_FOUND");
    const mapped = toSavedReport(stored);
    if (mapped === null) throw new SavedReportRepositoryError("INVALID_INPUT");
    return mapped;
  }

  public async list(scope: SavedReportScope): Promise<readonly SavedReport[]> {
    assertScope(scope);
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT id, name, dataset, definition_json, created_by, created_at, updated_at
         FROM saved_reports WHERE org_id = ? AND customer_id = ? ORDER BY name ASC LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, MAX_SAVED_REPORTS).all<SavedReportRow>();
    return (rows.results ?? []).flatMap((row) => {
      const mapped = toSavedReport(row);
      return mapped === null ? [] : [mapped];
    });
  }

  public async get(scope: SavedReportScope, id: string): Promise<SavedReport | null> {
    assertScope(scope);
    if (!REPORT_ID.test(id)) invalid();
    const db = await this.ready();
    const row = await db.prepare(
      `SELECT id, name, dataset, definition_json, created_by, created_at, updated_at
         FROM saved_reports WHERE id = ? AND org_id = ? AND customer_id = ? LIMIT 1`,
    ).bind(id, scope.orgId, scope.customerId).first<SavedReportRow>();
    return row === null ? null : toSavedReport(row);
  }

  public async delete(scope: SavedReportScope, id: string): Promise<boolean> {
    assertScope(scope);
    if (!REPORT_ID.test(id)) invalid();
    const db = await this.ready();
    const result = await db.prepare(
      `DELETE FROM saved_reports WHERE id = ? AND org_id = ? AND customer_id = ?`,
    ).bind(id, scope.orgId, scope.customerId).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }
}
