"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CMDB_RESOURCE_COLUMNS,
  FINDINGS_COLUMNS,
  REPORT_DEFAULT_LIMIT,
  REPORT_MAX_LIMIT,
  columnsForDataset,
  type ReportColumn,
  type ReportDataset,
  type ReportDefinition,
} from "../../lib/report-builder";
import { usePilotState } from "../components/use-pilot-state";

/* Custom report builder: pick a dataset, add filters, choose columns, then Run,
 * Save as a named view, load a saved view, Export CSV, or Print (Save as PDF).
 * Every table is loaded live and tenant-scoped by the /api/v1/reports/* routes.
 * Nothing here fabricates rows — empty, truncated, and error states are shown as
 * such, and the server-supplied disclaimer is always rendered with the result. */

type FilterOp = "eq" | "neq" | "contains" | "prefix";

const CMDB_FIELDS = CMDB_RESOURCE_COLUMNS.map((column) => column.key);
const FINDINGS_FIELDS = FINDINGS_COLUMNS.map((column) => column.key);
const FILTER_OPS: readonly FilterOp[] = ["eq", "neq", "contains", "prefix"];
const OP_LABEL: Record<FilterOp, string> = { eq: "equals", neq: "not equals", contains: "contains", prefix: "starts with" };

interface FilterDraft {
  field: string;
  op: FilterOp;
  value: string;
}

interface SavedReport {
  readonly id: string;
  readonly name: string;
  readonly dataset: ReportDataset;
  readonly definition: ReportDefinition;
}

interface ReportResultView {
  readonly dataset: ReportDataset;
  readonly columns: readonly ReportColumn[];
  readonly rows: readonly Record<string, string>[];
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly disclaimer: string;
}

function defaultFilter(dataset: ReportDataset): FilterDraft {
  return { field: dataset === "cmdb-resources" ? "service" : "severity", op: "contains", value: "" };
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { cache: "no-store", ...init });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null && "error" in payload
      ? String((payload as { error: { message?: string } }).error?.message ?? "Request rejected")
      : "Request rejected";
    throw new Error(message);
  }
  return payload as T;
}

export function ReportBuilder() {
  const { state, loading: workspaceLoading, error: workspaceError } = usePilotState();
  const connectionId = state?.connection?.id ?? null;
  const [dataset, setDataset] = useState<ReportDataset>("cmdb-resources");
  const [filters, setFilters] = useState<FilterDraft[]>([defaultFilter("cmdb-resources")]);
  const [combine, setCombine] = useState<"and" | "or">("and");
  const [selectedColumns, setSelectedColumns] = useState<string[]>(CMDB_FIELDS);
  const [sortField, setSortField] = useState<string>("");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [limit, setLimit] = useState<number>(REPORT_DEFAULT_LIMIT);

  const [result, setResult] = useState<ReportResultView | null>(null);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [saved, setSaved] = useState<SavedReport[]>([]);
  const [saveName, setSaveName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  const catalog = useMemo(() => columnsForDataset(dataset), [dataset]);
  const fieldOptions = dataset === "cmdb-resources" ? CMDB_FIELDS : FINDINGS_FIELDS;

  const loadSaved = useCallback(async () => {
    if (connectionId === null) {
      setSaved([]);
      return;
    }
    try {
      const payload = await requestJson<{ reports: SavedReport[] }>(
        `/api/v1/reports/saved?connectionId=${encodeURIComponent(connectionId)}`,
      );
      setSaved(payload.reports);
    } catch {
      setSaved([]);
    }
  }, [connectionId]);

  useEffect(() => { void (async () => { await loadSaved(); })(); }, [loadSaved]);

  function changeDataset(next: ReportDataset) {
    if (next === dataset) return;
    setDataset(next);
    setFilters([defaultFilter(next)]);
    setCombine("and");
    setSelectedColumns(columnsForDataset(next).map((column) => column.key));
    setSortField("");
    setSortDir("asc");
    setResult(null);
    setError(null);
  }

  function toggleColumn(key: string) {
    setSelectedColumns((current) => current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]);
  }

  function updateFilter(index: number, patch: Partial<FilterDraft>) {
    setFilters((current) => current.map((filter, position) => position === index ? { ...filter, ...patch } : filter));
  }

  function buildDefinition(): ReportDefinition {
    // Column order follows the catalog so the saved view is deterministic.
    const columns = catalog.map((column) => column.key).filter((key) => selectedColumns.includes(key));
    const sort = sortField ? { field: sortField, direction: sortDir } : undefined;
    const boundedLimit = Number.isInteger(limit) && limit >= 1 ? Math.min(limit, REPORT_MAX_LIMIT) : REPORT_DEFAULT_LIMIT;
    if (dataset === "cmdb-resources") {
      return {
        dataset,
        filters: { combine, predicates: filters.map((filter) => ({ kind: "field" as const, field: filter.field as never, op: filter.op, value: filter.value })) },
        columns,
        ...(sort ? { sort } : {}),
        limit: boundedLimit,
      };
    }
    return {
      dataset,
      filters: filters.filter((filter) => filter.value.length > 0).map((filter) => ({ field: filter.field, op: filter.op, value: filter.value })),
      columns,
      ...(sort ? { sort } : {}),
      limit: boundedLimit,
    };
  }

  async function run() {
    if (connectionId === null) return;
    setRunning(true);
    setError(null);
    try {
      const payload = await requestJson<{ report: ReportResultView }>(
        `/api/v1/reports/run?connectionId=${encodeURIComponent(connectionId)}`,
        {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definition: buildDefinition() }),
        },
      );
      setResult(payload.report);
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught.message : "The report could not be generated");
    } finally {
      setRunning(false);
    }
  }

  async function exportCsv() {
    if (connectionId === null) return;
    setExporting(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/reports/run?connectionId=${encodeURIComponent(connectionId)}&format=csv`,
        {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definition: buildDefinition(), format: "csv" }),
        },
      );
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const message = typeof payload === "object" && payload !== null && "error" in payload
          ? String((payload as { error: { message?: string } }).error?.message ?? "Export rejected")
          : "Export rejected";
        throw new Error(message);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "report.csv";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The report could not be exported");
    } finally {
      setExporting(false);
    }
  }

  async function saveView() {
    if (connectionId === null || saveName.trim().length === 0) return;
    setSaveError(null);
    try {
      const payload = await requestJson<{ reports: SavedReport[] }>(
        `/api/v1/reports/saved?connectionId=${encodeURIComponent(connectionId)}`,
        {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: saveName.trim(), definition: buildDefinition() }),
        },
      );
      setSaved(payload.reports);
      setSaveName("");
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "The view could not be saved");
    }
  }

  async function deleteView(id: string) {
    if (connectionId === null) return;
    try {
      const payload = await requestJson<{ reports: SavedReport[] }>(
        `/api/v1/reports/saved?connectionId=${encodeURIComponent(connectionId)}&id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      setSaved(payload.reports);
    } catch {
      await loadSaved();
    }
  }

  function loadView(report: SavedReport) {
    const definition = report.definition;
    setDataset(definition.dataset);
    if (definition.dataset === "cmdb-resources") {
      setCombine(definition.filters.combine);
      const drafts = definition.filters.predicates
        .filter((predicate) => predicate.kind === "field")
        .map((predicate) => ({ field: String(predicate.field), op: predicate.op as FilterOp, value: String(predicate.value ?? "") }));
      setFilters(drafts.length > 0 ? drafts : [defaultFilter("cmdb-resources")]);
    } else {
      setCombine("and");
      const drafts = definition.filters.map((filter) => ({ field: filter.field, op: filter.op, value: filter.value }));
      setFilters(drafts.length > 0 ? drafts : [defaultFilter("findings")]);
    }
    const catalogKeys = columnsForDataset(definition.dataset).map((column) => column.key);
    setSelectedColumns(definition.columns.length > 0 ? [...definition.columns] : catalogKeys);
    setSortField(definition.sort?.field ?? "");
    setSortDir(definition.sort?.direction ?? "asc");
    setLimit(definition.limit ?? REPORT_DEFAULT_LIMIT);
    setResult(null);
    setError(null);
  }

  const canRun = connectionId !== null && selectedColumns.length > 0;

  return (
    <>
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .report-print-area, .report-print-area * { visibility: visible; }
          .report-print-area { position: absolute; left: 0; top: 0; width: 100%; }
          .report-noprint { display: none !important; }
        }
      `}</style>

      <section className="page-heading report-noprint">
        <div>
          <p className="eyebrow">CloudAware-parity reporting</p>
          <h1>Custom report builder</h1>
          <p className="page-subtitle">Build a tabular report over your CMDB resources or configuration findings, save it as a reusable view, and export to CSV or print to PDF. Rows are loaded live and tenant-scoped every run.</p>
        </div>
        <div className="heading-actions">
          <a className="button button-secondary" href="/reports">Executive report</a>
        </div>
      </section>
      {workspaceError ? <p className="page-alert page-alert-error" role="alert">{workspaceError}</p> : null}
      {workspaceLoading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading selected workspace…</div> : null}

      {error ? <div className="page-alert page-alert-error report-noprint" role="alert"><strong>Report action needs attention</strong><span>{error}</span></div> : null}

      <section className="panel report-noprint">
        <div className="panel-heading"><div><p className="eyebrow">Definition</p><h2>Dataset, filters and columns</h2></div></div>

        <div className="cmdbq-row" style={{ marginBottom: "12px" }}>
          <label><span className="sr-only">Dataset</span>
            <select className="filter-control" value={dataset} onChange={(event) => changeDataset(event.target.value as ReportDataset)}>
              <option value="cmdb-resources">CMDB resources</option>
              <option value="findings">Security findings</option>
            </select>
          </label>
          {dataset === "cmdb-resources" ? (
            <label><span className="sr-only">Combine filters</span>
              <select className="filter-control" value={combine} onChange={(event) => setCombine(event.target.value as "and" | "or")}>
                <option value="and">match all (AND)</option>
                <option value="or">match any (OR)</option>
              </select>
            </label>
          ) : null}
        </div>

        <div className="cmdbq-rows">
          {filters.map((filter, index) => (
            <div key={index} className="cmdbq-row">
              <select className="filter-control" aria-label="Filter field" value={filter.field} onChange={(event) => updateFilter(index, { field: event.target.value })}>
                {fieldOptions.map((field) => <option key={field} value={field}>{field}</option>)}
              </select>
              <select className="filter-control" aria-label="Filter operator" value={filter.op} onChange={(event) => updateFilter(index, { op: event.target.value as FilterOp })}>
                {FILTER_OPS.map((op) => <option key={op} value={op}>{OP_LABEL[op]}</option>)}
              </select>
              <input className="filter-control" aria-label="Filter value" placeholder="value" value={filter.value} onChange={(event) => updateFilter(index, { value: event.target.value })} />
              <button className="button button-secondary button-small" type="button" onClick={() => setFilters((current) => current.length > 1 ? current.filter((_, position) => position !== index) : current)} disabled={filters.length <= 1}>Remove</button>
            </div>
          ))}
        </div>
        <div className="cmdbq-actions">
          <button className="button button-secondary button-small" type="button" onClick={() => setFilters((current) => [...current, defaultFilter(dataset)])}>Add filter</button>
          {dataset === "findings" ? <span className="cmdbq-summary">Leave all values empty to include every finding.</span> : null}
        </div>

        <fieldset style={{ border: "none", padding: 0, margin: "14px 0 0" }}>
          <legend className="eyebrow">Columns</legend>
          <div className="cmdbq-row" style={{ gap: "12px" }}>
            {catalog.map((column) => (
              <label key={column.key} style={{ minWidth: "auto", display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11.5px" }}>
                <input type="checkbox" checked={selectedColumns.includes(column.key)} onChange={() => toggleColumn(column.key)} />
                {column.label}
              </label>
            ))}
          </div>
          {selectedColumns.length === 0 ? <p className="cmdbq-error">Select at least one column to run the report.</p> : null}
        </fieldset>

        <div className="cmdbq-row" style={{ marginTop: "14px" }}>
          <label><span className="sr-only">Sort field</span>
            <select className="filter-control" value={sortField} onChange={(event) => setSortField(event.target.value)}>
              <option value="">No sort</option>
              {fieldOptions.map((field) => <option key={field} value={field}>Sort by {field}</option>)}
            </select>
          </label>
          <label><span className="sr-only">Sort direction</span>
            <select className="filter-control" value={sortDir} disabled={!sortField} onChange={(event) => setSortDir(event.target.value as "asc" | "desc")}>
              <option value="asc">ascending</option>
              <option value="desc">descending</option>
            </select>
          </label>
          <label><span className="sr-only">Row limit</span>
            <input className="filter-control" type="number" min={1} max={REPORT_MAX_LIMIT} value={limit} onChange={(event) => setLimit(Number(event.target.value))} />
          </label>
        </div>

        <div className="cmdbq-actions" style={{ marginTop: "14px" }}>
          <button className="button button-primary" type="button" disabled={!canRun || running} onClick={() => void run()}>{running ? "Running…" : "Run report"}</button>
          <button className="button button-secondary" type="button" disabled={!result || result.rows.length === 0 || exporting} onClick={() => void exportCsv()}>{exporting ? "Exporting…" : "Export CSV"}</button>
          <button className="button button-secondary" type="button" disabled={!result} onClick={() => window.print()}>Print / Save as PDF</button>
        </div>
      </section>

      <section className="panel report-noprint">
        <div className="panel-heading"><div><p className="eyebrow">Saved views</p><h2>Reusable report definitions</h2></div></div>
        <div className="cmdbq-actions">
          <input className="filter-control" aria-label="Saved view name" placeholder="Name this view" value={saveName} onChange={(event) => setSaveName(event.target.value)} />
          <button className="button button-secondary button-small" type="button" disabled={saveName.trim().length === 0} onClick={() => void saveView()}>Save view</button>
        </div>
        {saveError ? <p className="cmdbq-error" role="alert">{saveError}</p> : null}
        <div className="cmdbq-saved">
          {saved.length === 0 ? <p className="cmdbq-summary">No saved views yet. Build a report above and save it to reuse the definition later.</p> : null}
          {saved.map((report) => (
            <div key={report.id} className="cmdbq-saved-row">
              <span>{report.name} <small style={{ color: "var(--ink-faint)" }}>· {report.dataset}</small></span>
              <button className="button button-secondary button-small" type="button" onClick={() => loadView(report)}>Load</button>
              <button className="button button-secondary button-small" type="button" onClick={() => void deleteView(report.id)}>Delete</button>
            </div>
          ))}
        </div>
      </section>

      {result ? (
        <section className="panel report-print-area">
          <div className="panel-heading"><div><p className="eyebrow">Report</p><h2>{result.dataset === "cmdb-resources" ? "CMDB resources" : "Security findings"}</h2></div><span className="result-count report-noprint">{result.rowCount} row{result.rowCount === 1 ? "" : "s"}</span></div>
          <p className="cmdbq-summary">{result.disclaimer}</p>
          {result.rows.length === 0 ? (
            <div className="empty-state"><strong>No rows to display</strong><span>Adjust the filters, or connect and sync an account if the dataset is empty.</span></div>
          ) : (
            <div className="cmdbq-results" style={{ overflowX: "auto" }}>
              <table>
                <thead><tr>{result.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead>
                <tbody>
                  {result.rows.map((row, index) => (
                    <tr key={index}>{result.columns.map((column) => <td key={column.key}>{row[column.key] === "" ? <span className="cmdbq-novalue">—</span> : row[column.key]}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}
