import {
  CMDB_QUERY_DEFAULT_LIMIT,
  CMDB_QUERY_MAX_LIMIT,
  runCmdbQuery,
  validateCmdbQuery,
  type CmdbQueryPredicate,
  type CmdbQueryResource,
} from "./cmdb-query.ts";
import { safeCsvCell } from "./safe-csv.ts";

/**
 * Pure, deterministic custom-report engine for the report builder.
 *
 * A report DEFINITION names a dataset, a filter set, the selected columns, an
 * optional sort and an optional limit. `buildReport` projects already-loaded,
 * tenant-scoped rows into a flat tabular result — no eval, no dynamic code, no
 * I/O. The CMDB dataset REUSES the CMDB query engine verbatim (validateCmdbQuery
 * + runCmdbQuery); the findings dataset applies simple case-insensitive field
 * filters, an optional field sort, and a bounded limit.
 *
 * The result is evidence-honest:
 *   - No cell is ever fabricated. A missing/null source value renders as an
 *     empty string, never as a placeholder or guessed value.
 *   - `truncated` is true exactly when the limit hid rows that actually matched,
 *     and `disclaimer` spells out the empty / truncated / matched state so a
 *     reader is never misled about coverage.
 *
 * `toCsv` renders the same columns/rows as RFC-4180 CSV.
 */

export type ReportDataset = "cmdb-resources" | "findings";

export interface ReportColumn {
  readonly key: string;
  readonly label: string;
}

export type FindingsFilterOp = "eq" | "neq" | "contains" | "prefix";

export interface FindingsFieldFilter {
  readonly field: string;
  readonly op: FindingsFilterOp;
  readonly value: string;
}

export interface ReportSort {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

export interface CmdbReportFilters {
  readonly combine: "and" | "or";
  readonly predicates: readonly CmdbQueryPredicate[];
}

export type ReportDefinition =
  | {
      readonly dataset: "cmdb-resources";
      readonly filters: CmdbReportFilters;
      readonly columns: readonly string[];
      readonly sort?: ReportSort;
      readonly limit?: number;
    }
  | {
      readonly dataset: "findings";
      readonly filters: readonly FindingsFieldFilter[];
      readonly columns: readonly string[];
      readonly sort?: ReportSort;
      readonly limit?: number;
    };

export interface ReportResult {
  readonly dataset: ReportDataset;
  readonly columns: readonly ReportColumn[];
  readonly rows: readonly Record<string, string>[];
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly disclaimer: string;
}

export interface ReportDefinitionValidation {
  readonly definition: ReportDefinition | null;
  readonly errors: readonly string[];
}

export const REPORT_DATASETS: readonly ReportDataset[] = ["cmdb-resources", "findings"];
export const REPORT_MAX_LIMIT = CMDB_QUERY_MAX_LIMIT;
export const REPORT_DEFAULT_LIMIT = CMDB_QUERY_DEFAULT_LIMIT;
export const REPORT_MAX_COLUMNS = 24;
export const REPORT_MAX_FINDINGS_FILTERS = 16;
const MAX_FILTER_VALUE = 256;

// Column keys are compared against a per-dataset allowlist, but a charset guard
// is applied first so a malformed key can never reach the projection logic.
const FIELD_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
const FINDINGS_FILTER_OPS = new Set<FindingsFilterOp>(["eq", "neq", "contains", "prefix"]);

export const CMDB_RESOURCE_COLUMNS: readonly ReportColumn[] = [
  { key: "resourceKey", label: "Resource key" },
  { key: "service", label: "Service" },
  { key: "resourceType", label: "Resource type" },
  { key: "regionKey", label: "Region" },
  { key: "name", label: "Name" },
  { key: "state", label: "State" },
  { key: "arn", label: "ARN" },
  { key: "nativeId", label: "Native ID" },
  { key: "lifecycleState", label: "Lifecycle state" },
  { key: "consecutiveCompleteMisses", label: "Consecutive complete misses" },
  { key: "evidenceSnapshotId", label: "Evidence snapshot ID" },
  { key: "evidenceSnapshotSha256", label: "Evidence snapshot SHA-256" },
  { key: "contentSha256", label: "Resource content SHA-256" },
];

export const FINDINGS_COLUMNS: readonly ReportColumn[] = [
  { key: "fingerprint", label: "Fingerprint" },
  { key: "resourceKey", label: "Resource key" },
  { key: "controlKey", label: "Control" },
  { key: "controlVersion", label: "Control version" },
  { key: "severity", label: "Severity" },
  { key: "status", label: "Status" },
  { key: "title", label: "Title" },
  { key: "summary", label: "Summary" },
  { key: "remediation", label: "Remediation" },
  { key: "evaluatedAt", label: "Evaluated at" },
];

export class ReportBuilderError extends Error {
  public readonly code: "INVALID_DEFINITION";

  public constructor(message = "The report definition is invalid") {
    super(message);
    this.name = "ReportBuilderError";
    this.code = "INVALID_DEFINITION";
  }
}

export function isReportDataset(value: unknown): value is ReportDataset {
  return value === "cmdb-resources" || value === "findings";
}

export function columnsForDataset(dataset: ReportDataset): readonly ReportColumn[] {
  return dataset === "cmdb-resources" ? CMDB_RESOURCE_COLUMNS : FINDINGS_COLUMNS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve the selected column keys against the dataset catalog, preserving the
 * caller's order. An empty selection means "every column in the catalog". */
function resolveColumns(dataset: ReportDataset, selected: readonly string[]): readonly ReportColumn[] {
  const catalog = columnsForDataset(dataset);
  if (selected.length === 0) return catalog;
  const byKey = new Map(catalog.map((column) => [column.key, column]));
  const resolved: ReportColumn[] = [];
  for (const key of selected) {
    const column = byKey.get(key);
    if (column === undefined) throw new ReportBuilderError(`Unknown column '${key}' for dataset '${dataset}'`);
    resolved.push(column);
  }
  return resolved;
}

/** Stringify a source value for a cell. Null/undefined render empty — never a
 * placeholder — so the table never fabricates a value that was not collected. */
function cellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function matchFindingString(actual: string, op: FindingsFilterOp, expected: string): boolean {
  const a = actual.toLowerCase();
  const e = expected.toLowerCase();
  switch (op) {
    case "eq": return a === e;
    case "neq": return a !== e;
    case "contains": return a.includes(e);
    case "prefix": return a.startsWith(e);
    default: return false;
  }
}

function findingMatches(row: Record<string, unknown>, filters: readonly FindingsFieldFilter[]): boolean {
  // Filters combine with AND. A null/absent field is treated as the empty
  // string, so `neq` on a missing value matches and `eq`/`contains`/`prefix`
  // against a non-empty needle does not.
  return filters.every((filter) => matchFindingString(cellValue(row[filter.field]), filter.op, filter.value));
}

/** Stable sort by the string projection of `sort.field`. Ties keep input order
 * so the same definition over the same rows always yields the same table. */
function applySort<T extends Record<string, unknown> | CmdbQueryResource>(
  rows: readonly T[],
  sort: ReportSort | undefined,
): readonly T[] {
  if (sort === undefined) return rows;
  const decorated = rows.map((row, index) => ({ row, index, key: cellValue((row as Record<string, unknown>)[sort.field]) }));
  decorated.sort((left, right) => {
    const comparison = left.key.localeCompare(right.key, "en");
    if (comparison !== 0) return sort.direction === "desc" ? -comparison : comparison;
    return left.index - right.index;
  });
  return decorated.map((entry) => entry.row);
}

function projectRows(sources: readonly Record<string, unknown>[], columns: readonly ReportColumn[]): Record<string, string>[] {
  return sources.map((source) => {
    const row: Record<string, string> = {};
    for (const column of columns) row[column.key] = cellValue(source[column.key]);
    return row;
  });
}

function disclaimer(
  dataset: ReportDataset,
  evaluated: number,
  totalMatched: number,
  shown: number,
  limit: number,
  truncated: boolean,
): string {
  const base = dataset === "cmdb-resources"
    ? "Rows are resources from the current tenant CMDB projection. Retirement-pending rows retain and identify their last observed immutable snapshot evidence."
    : "Rows are configuration findings from the active snapshot for this tenant.";
  if (evaluated === 0) {
    const noun = dataset === "cmdb-resources" ? "resources" : "findings";
    return `${base} The dataset is empty — no ${noun} are available to report yet.`;
  }
  if (totalMatched === 0) return `${base} No rows matched the selected filters.`;
  if (truncated) {
    return `${base} Showing the first ${shown} of ${totalMatched} matching rows (limit ${limit}); refine the filters or raise the limit to export the rest.`;
  }
  return `${base} ${totalMatched} row${totalMatched === 1 ? "" : "s"} matched.`;
}

/**
 * Build a tabular report from already-loaded, tenant-scoped rows.
 *
 * @param definition A validated report definition (see validateReportDefinition).
 * @param rows       CmdbQueryResource[] for the cmdb-resources dataset, or plain
 *                   finding records for the findings dataset. The caller loads
 *                   these tenant-scoped; this function performs no I/O.
 */
export function buildReport(
  definition: ReportDefinition,
  rows: readonly CmdbQueryResource[] | readonly Record<string, unknown>[],
): ReportResult {
  const limit = clampLimit(definition.limit);
  const columns = resolveColumns(definition.dataset, definition.columns);
  const evaluated = rows.length;

  let candidates: readonly Record<string, unknown>[];
  let totalMatched: number;

  if (definition.dataset === "cmdb-resources") {
    // REUSE the CMDB query engine verbatim. Gather up to REPORT_MAX_LIMIT
    // matches in the engine's deterministic order; sort/limit are applied
    // uniformly below. totalMatched is the engine's full match count.
    const validation = validateCmdbQuery({
      combine: definition.filters.combine,
      predicates: definition.filters.predicates,
      limit: REPORT_MAX_LIMIT,
    });
    if (validation.query === null) throw new ReportBuilderError(validation.errors.join("; "));
    const result = runCmdbQuery(rows as readonly CmdbQueryResource[], validation.query);
    candidates = result.matched as readonly unknown[] as readonly Record<string, unknown>[];
    totalMatched = result.totalMatched;
  } else {
    const matched = (rows as readonly Record<string, unknown>[]).filter((row) => findingMatches(row, definition.filters));
    candidates = matched;
    totalMatched = matched.length;
  }

  const sorted = applySort(candidates, definition.sort);
  const shown = sorted.slice(0, limit);
  const truncated = totalMatched > shown.length;
  const outputRows = projectRows(shown, columns);

  return {
    dataset: definition.dataset,
    columns,
    rows: outputRows,
    rowCount: outputRows.length,
    truncated,
    disclaimer: disclaimer(definition.dataset, evaluated, totalMatched, outputRows.length, limit, truncated),
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return REPORT_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) return REPORT_DEFAULT_LIMIT;
  return Math.min(limit, REPORT_MAX_LIMIT);
}

/**
 * Validate untrusted input into a ReportDefinition. Exported so the route and
 * the repository agree on exactly what a storable/runnable definition is.
 * Returns every problem found; `definition` is null unless the input is clean.
 */
export function validateReportDefinition(input: unknown): ReportDefinitionValidation {
  const errors: string[] = [];
  if (!isRecord(input)) return { definition: null, errors: ["definition must be an object"] };

  const dataset = input.dataset;
  if (!isReportDataset(dataset)) {
    return { definition: null, errors: ["dataset must be 'cmdb-resources' or 'findings'"] };
  }
  const catalog = new Set(columnsForDataset(dataset).map((column) => column.key));

  const columns = validateColumns(input.columns, catalog, errors);
  const sort = validateSort(input.sort, catalog, errors);
  const limit = validateLimit(input.limit, errors);

  if (dataset === "cmdb-resources") {
    const filters = validateCmdbFilters(input.filters, errors);
    if (errors.length > 0 || filters === null) return { definition: null, errors };
    return {
      definition: { dataset, filters, columns, ...(sort === undefined ? {} : { sort }), ...(limit === undefined ? {} : { limit }) },
      errors: [],
    };
  }

  const filters = validateFindingsFilters(input.filters, catalog, errors);
  if (errors.length > 0 || filters === null) return { definition: null, errors };
  return {
    definition: { dataset, filters, columns, ...(sort === undefined ? {} : { sort }), ...(limit === undefined ? {} : { limit }) },
    errors: [],
  };
}

function validateColumns(value: unknown, catalog: ReadonlySet<string>, errors: string[]): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.push("columns must be an array of field keys");
    return [];
  }
  if (value.length > REPORT_MAX_COLUMNS) errors.push(`columns exceeds the maximum of ${REPORT_MAX_COLUMNS}`);
  const columns: string[] = [];
  const seen = new Set<string>();
  value.forEach((raw, index) => {
    if (typeof raw !== "string" || !FIELD_KEY.test(raw)) { errors.push(`columns[${index}] is not a valid field key`); return; }
    if (!catalog.has(raw)) { errors.push(`columns[${index}] '${raw}' is not a column of this dataset`); return; }
    if (seen.has(raw)) { errors.push(`columns[${index}] '${raw}' is duplicated`); return; }
    seen.add(raw);
    columns.push(raw);
  });
  return columns;
}

function validateSort(value: unknown, catalog: ReadonlySet<string>, errors: string[]): ReportSort | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) { errors.push("sort must be an object"); return undefined; }
  const field = value.field;
  const direction = value.direction;
  if (typeof field !== "string" || !FIELD_KEY.test(field) || !catalog.has(field)) {
    errors.push("sort.field is not a column of this dataset");
    return undefined;
  }
  if (direction !== "asc" && direction !== "desc") {
    errors.push("sort.direction must be 'asc' or 'desc'");
    return undefined;
  }
  return { field, direction };
}

function validateLimit(value: unknown, errors: string[]): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > REPORT_MAX_LIMIT) {
    errors.push(`limit must be a positive integer no greater than ${REPORT_MAX_LIMIT}`);
    return undefined;
  }
  return value;
}

function validateCmdbFilters(value: unknown, errors: string[]): CmdbReportFilters | null {
  if (!isRecord(value)) { errors.push("filters must be an object with 'combine' and 'predicates'"); return null; }
  const validation = validateCmdbQuery({ combine: value.combine, predicates: value.predicates });
  if (validation.query === null) {
    for (const error of validation.errors) errors.push(`filters.${error}`);
    return null;
  }
  return { combine: validation.query.combine, predicates: validation.query.predicates };
}

function validateFindingsFilters(value: unknown, catalog: ReadonlySet<string>, errors: string[]): readonly FindingsFieldFilter[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) { errors.push("filters must be an array of field filters"); return null; }
  if (value.length > REPORT_MAX_FINDINGS_FILTERS) errors.push(`filters exceeds the maximum of ${REPORT_MAX_FINDINGS_FILTERS}`);
  const filters: FindingsFieldFilter[] = [];
  value.forEach((raw, index) => {
    const label = `filters[${index}]`;
    if (!isRecord(raw)) { errors.push(`${label} must be an object`); return; }
    if (typeof raw.field !== "string" || !FIELD_KEY.test(raw.field) || !catalog.has(raw.field)) { errors.push(`${label}.field is not a filterable field`); return; }
    if (typeof raw.op !== "string" || !FINDINGS_FILTER_OPS.has(raw.op as FindingsFilterOp)) { errors.push(`${label}.op is not a valid filter operator`); return; }
    if (typeof raw.value !== "string" || raw.value.length > MAX_FILTER_VALUE) { errors.push(`${label}.value must be a string of at most ${MAX_FILTER_VALUE} characters`); return; }
    filters.push({ field: raw.field, op: raw.op as FindingsFilterOp, value: raw.value });
  });
  return filters;
}

/**
 * Render columns/rows as RFC-4180 CSV: a header row of column labels followed
 * by one row per record. A field containing a comma, double quote, CR or LF is
 * wrapped in double quotes and any interior double quote is doubled. Records are
 * separated by CRLF. Missing cells render empty — no value is fabricated.
 *
 * A cell that begins with = + - @ (or a tab/CR) is prefixed with a single quote
 * to neutralize spreadsheet formula injection: resource/asset names and tags are
 * attacker-influenceable, so a value like `=HYPERLINK(...)` must not execute when
 * the exported CSV is opened in Excel/Sheets. Mirrors safeSpreadsheetText used by
 * the compliance CSV exports.
 */
export function toCsv(columns: readonly ReportColumn[], rows: readonly Record<string, string>[]): string {
  const lines: string[] = [columns.map((column) => safeCsvCell(column.label)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => safeCsvCell(row[column.key] ?? "")).join(","));
  }
  return lines.join("\r\n");
}
