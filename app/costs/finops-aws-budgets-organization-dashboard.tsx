"use client";

import { useEffect, useMemo, useState } from "react";
import { AWS_BUDGETS_OFFICIAL_DEFINITION, type AwsBudgetsOfficialDefinition } from "../../lib/finops-aws-budgets-official-definition";
import type { AwsBudgetsDashboard } from "../../lib/finops-aws-budgets-organization";
import styles from "./finops-aws-budgets-organization-dashboard.module.css";

type SourceState = "complete" | "partial" | "stale" | "empty" | "failed" | "configuration_required";
export interface AwsBudgetsDashboardFilters {
  readonly currency: string;
  readonly budgetType: string;
  readonly accountId: string;
  readonly budgetLevel: string;
  readonly budgetStatus: string;
  readonly namePrefix: string;
}

export interface AwsBudgetsDashboardEnvelope {
  readonly schema: "sutra.finops-aws-budgets-dashboard.v1";
  readonly connectionId: string;
  readonly source: "AWS_BUDGETS_PROVIDER";
  readonly sourceState: SourceState;
  readonly officialDefinition: AwsBudgetsOfficialDefinition;
  readonly freshness: { readonly dataThroughAt: string | null; readonly status: string; readonly ageHours: number | null; readonly staleAfterHours: number };
  readonly dashboard: AwsBudgetsDashboard;
  readonly history: readonly {
    readonly generationId: string; readonly sourceCaptureId: string; readonly state: string;
    readonly hierarchyState: string | null; readonly observedAtIso: string; readonly dataThroughAtIso: string | null;
    readonly budgetCount: number; readonly currencies: readonly string[]; readonly budgetLevels: readonly string[];
  }[];
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly separation: { readonly providerSource: string; readonly sutraInternalBudgetsIncluded: false; readonly reason: string };
  readonly collection: { readonly jobContractAvailable: true; readonly providerAdapterAvailable: false; readonly reason: string };
  readonly prerequisites: readonly string[];
}

const EMPTY_FILTERS: AwsBudgetsDashboardFilters = {
  currency: "", budgetType: "", accountId: "", budgetLevel: "", budgetStatus: "", namePrefix: "",
};

interface AwsBudgetsConfigurationEnvelope {
  readonly sourceState: "configuration_required";
  readonly dashboard: null;
  readonly officialDefinition: AwsBudgetsOfficialDefinition;
}

function hasPinnedOfficialDefinition(value: unknown): value is AwsBudgetsOfficialDefinition {
  if (typeof value !== "object" || value === null) return false;
  const definition = value as Readonly<Record<string, unknown>>;
  const source = definition.source;
  const totals = definition.totals;
  return typeof source === "object" && source !== null
    && typeof totals === "object" && totals !== null
    && (source as Readonly<Record<string, unknown>>).commit === AWS_BUDGETS_OFFICIAL_DEFINITION.source.commit
    && (source as Readonly<Record<string, unknown>>).sha256 === AWS_BUDGETS_OFFICIAL_DEFINITION.source.sha256
    && (totals as Readonly<Record<string, unknown>>).sheets === 2
    && (totals as Readonly<Record<string, unknown>>).visuals === 11
    && Array.isArray(definition.sheets) && definition.sheets.length === 2;
}

function money(micros: string | null, unit: string | null): string {
  if (micros === null || unit === null) return "Not supplied by AWS";
  const negative = micros.startsWith("-");
  const digits = negative ? micros.slice(1) : micros;
  const padded = digits.padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const fraction = padded.slice(-6).replace(/0+$/u, "");
  return `${unit} ${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function csvCell(value: string): string {
  const protectedValue = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return `"${protectedValue.replaceAll('"', '""')}"`;
}

function exportVisible(report: AwsBudgetsDashboardEnvelope): void {
  const header = ["budget_name", "cid_budget_level", "budget_type", "time_unit", "currency", "budgeted_micros", "actual_micros", "forecast_micros", "targeting", "accounts", "provider_last_updated"];
  const rows = report.dashboard.budgets.map(({ budget, targeting, accountMappings }) => [
    budget.budgetName, budget.hierarchyLevel ?? "", budget.budgetType, budget.timeUnit,
    budget.budgetLimit?.currency ?? budget.actual?.currency ?? budget.forecast?.currency ?? "",
    budget.budgetLimit?.amountMicros ?? "", budget.actual?.amountMicros ?? "", budget.forecast?.amountMicros ?? "",
    targeting, accountMappings.map((item) => item.accountId).join("|"), budget.lastUpdatedAt ?? "",
  ].map(csvCell).join(","));
  const url = URL.createObjectURL(new Blob([[header.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = "sutra-aws-budgets-provider.csv"; anchor.click();
  URL.revokeObjectURL(url);
}

function stateMessage(state: SourceState): string | null {
  if (state === "complete") return null;
  if (state === "configuration_required") return "AWS Budgets evidence is not configured or the read-only provider prerequisites are incomplete.";
  if (state === "partial") return "Coverage is partial. A newer incomplete attempt cannot replace the accepted complete generation.";
  if (state === "stale") return "The accepted AWS-calculated spend evidence is older than the 24-hour freshness objective.";
  if (state === "empty") return "AWS returned no provider budgets for this evidence set and filter selection.";
  return "The latest provider collection is unavailable. Previously accepted evidence, when present, remains immutable.";
}

function sums(report: AwsBudgetsDashboardEnvelope) {
  const map = new Map<string, { budgeted: bigint; actual: bigint; forecast: bigint; budgetedCount: number; actualCount: number; forecastCount: number }>();
  for (const row of report.dashboard.budgets) {
    const budget = row.budget;
    const currency = budget.budgetLimit?.currency ?? budget.actual?.currency ?? budget.forecast?.currency;
    if (currency === null || currency === undefined) continue;
    const current = map.get(currency) ?? { budgeted: BigInt(0), actual: BigInt(0), forecast: BigInt(0), budgetedCount: 0, actualCount: 0, forecastCount: 0 };
    if (budget.budgetLimit !== null) { current.budgeted += BigInt(budget.budgetLimit.amountMicros); current.budgetedCount += 1; }
    if (budget.actual !== null) { current.actual += BigInt(budget.actual.amountMicros); current.actualCount += 1; }
    if (budget.forecast !== null) { current.forecast += BigInt(budget.forecast.amountMicros); current.forecastCount += 1; }
    map.set(currency, current);
  }
  return [...map.entries()].sort(([left], [right]) => left.localeCompare(right));
}

export function AwsBudgetsOfficialDefinitionPanel({ definition }: { readonly definition: AwsBudgetsOfficialDefinition }) {
  return <section className={styles.official} aria-label="Official AWS Budgets definition coverage">
    <header className={styles.panelHead}>
      <div><h3>Official AWS definition coverage</h3><p>{definition.totals.sheets} sheets · {definition.totals.visuals} visuals · {definition.totals.parameterControls + definition.totals.filterControls} controls</p></div>
      <small>Definition {definition.source.commit.slice(0, 12)} · {definition.source.sha256.slice(0, 16)}…</small>
    </header>
    <div className={styles.officialSheets}>{definition.sheets.map((sheet) => <article key={sheet.id}><header><strong>{sheet.name}</strong><span>{sheet.visualCount} visuals</span></header><p>{sheet.parameterControls.length} parameter controls · {sheet.filterControls.length} filter controls</p><small>{[...sheet.parameterControls, ...sheet.filterControls].join(" · ") || "Source and limitation evidence"}</small>{sheet.visuals.length === 0 ? <p>Immutable source, semantics, freshness and limitations are exposed independently of provider delivery.</p> : <ul>{sheet.visuals.map((visual) => <li key={`${visual.name}:${visual.type}`} data-coverage={visual.coverage}><strong>{visual.name}</strong><span>{visual.type} · {visual.coverage.replaceAll("_", " ")}</span><small>{visual.note}</small></li>)}</ul>}</article>)}</div>
    <p>Frozen source identity remains visible without a provider report. Native views do not claim QuickSight pixel, geometry, or interaction parity.</p>
  </section>;
}

export function FinopsAwsBudgetsOrganizationReportView({ report, filters, onFiltersChange }: {
  readonly report: AwsBudgetsDashboardEnvelope;
  readonly filters: AwsBudgetsDashboardFilters;
  readonly onFiltersChange: (filters: AwsBudgetsDashboardFilters) => void;
}) {
  const message = stateMessage(report.sourceState);
  const currencySums = useMemo(() => sums(report), [report]);
  const accounts = [...new Map(report.dashboard.budgets.flatMap((row) => row.accountMappings)
    .map((account) => [account.accountId, account] as const)).values()];
  const budgetTypes = [...new Set(report.dashboard.budgets.map((row) => row.budget.budgetType))].sort();
  const set = (key: keyof AwsBudgetsDashboardFilters, value: string) => onFiltersChange({ ...filters, [key]: value });
  return <section className={styles.root} aria-label="AWS Budgets provider dashboard">
    <div className={styles.separation} role="note">
      <strong>AWS Budgets provider evidence</strong>
      <span>This dashboard never includes or merges Sutra-authored budget guardrails. {report.separation.reason}</span>
    </div>
    <AwsBudgetsOfficialDefinitionPanel definition={report.officialDefinition} />
    {message ? <div role={report.sourceState === "failed" ? "alert" : "status"} className={`${styles.state} ${report.sourceState === "failed" ? styles.error : styles.warning}`}>{message}</div> : null}
    <div className={styles.filters} aria-label="AWS Budgets hierarchy and grouping filters">
      <label>Currency<select value={filters.currency} onChange={(event) => set("currency", event.target.value)}><option value="">All currencies</option>{report.dashboard.coverage.currencies.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>Budget type<select value={filters.budgetType} onChange={(event) => set("budgetType", event.target.value)}><option value="">All types</option>{budgetTypes.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>Account<select value={filters.accountId} onChange={(event) => set("accountId", event.target.value)}><option value="">All accounts</option>{accounts.map((account) => <option key={account.accountId} value={account.accountId}>{account.accountName ?? account.accountId} · {account.accountId}</option>)}</select></label>
      <label>cid:budget-level<select value={filters.budgetLevel} onChange={(event) => set("budgetLevel", event.target.value)}><option value="">All hierarchy levels</option>{report.dashboard.coverage.budgetLevels.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>Budget status<select value={filters.budgetStatus} onChange={(event) => set("budgetStatus", event.target.value)}><option value="">All budgets</option><option value="HEALTHY">Healthy budgets</option><option value="UNHEALTHY">Unhealthy budgets</option><option value="FORECASTED_UNHEALTHY">Forecasted unhealthy budgets</option><option value="UNCLASSIFIED">Unclassified evidence</option></select></label>
      <label>Budget name starts with<input value={filters.namePrefix} maxLength={100} onChange={(event) => set("namePrefix", event.target.value)} /></label>
    </div>
    <div className={styles.cards} aria-label="Official AWS Budget health status">
      <article className={styles.card}><small>Healthy budgets</small><strong>{report.dashboard.coverage.healthStatusCounts.HEALTHY}</strong><span>Actual spend is below the budgeted amount</span></article>
      <article className={styles.card}><small>Unhealthy budgets</small><strong>{report.dashboard.coverage.healthStatusCounts.UNHEALTHY}</strong><span>Actual spend is above the budgeted amount</span></article>
      <article className={styles.card}><small>Forecasted unhealthy budgets</small><strong>{report.dashboard.coverage.healthStatusCounts.FORECASTED_UNHEALTHY}</strong><span>Actual is below budget while forecast is above it</span></article>
      <article className={styles.card}><small>Unclassified evidence</small><strong>{report.dashboard.coverage.healthStatusCounts.UNCLASSIFIED}</strong><span>Missing, equal, or currency-incompatible evidence is not guessed</span></article>
    </div>
    <div className={styles.cards} aria-label="Budgeted forecast and actual spend by currency">
      {currencySums.flatMap(([currency, item]) => [
        <article className={styles.card} key={`${currency}:budgeted`}><small>Budgeted · {currency}</small><strong>{item.budgetedCount ? money(item.budgeted.toString(), currency) : "Unavailable"}</strong><span>{item.budgetedCount} provider budgets</span></article>,
        <article className={styles.card} key={`${currency}:actual`}><small>Actual spend · {currency}</small><strong>{item.actualCount ? money(item.actual.toString(), currency) : "Unavailable"}</strong><span>AWS-calculated, not real-time</span></article>,
        <article className={styles.card} key={`${currency}:forecast`}><small>Forecasted spend · {currency}</small><strong>{item.forecastCount ? money(item.forecast.toString(), currency) : "Unavailable"}</strong><span>Missing forecast is not zero</span></article>,
      ])}
    </div>
    <section className={styles.panel} aria-label="AWS Budget hierarchy status and drilldown">
      <header className={styles.panelHead}><div><h3>Provider budget hierarchy</h3><p>Grouped only by the exact AWS tag <code>cid:budget-level</code>.</p></div><button type="button" onClick={() => exportVisible(report)}>Export visible rows</button></header>
      <div className={styles.scroll}><table><thead><tr><th>Hierarchy</th><th>Provider budget</th><th>Budgeted</th><th>Actual</th><th>Forecast</th><th>Provider status</th><th>Accounts / ownership</th></tr></thead><tbody>
        {report.dashboard.budgets.map((row) => {
          const { budget, targeting, accountMappings, mappingCoverage } = row;
          const unit = budget.budgetLimit?.unit ?? budget.actual?.unit ?? budget.forecast?.unit ?? null;
          return <tr key={budget.budgetName}><td><span className={styles.pill}>{budget.hierarchyLevel ?? "Tag missing"}</span></td><td><strong>{budget.budgetName}</strong><br />{budget.budgetType} · {budget.timeUnit}</td><td>{money(budget.budgetLimit?.amountMicros ?? null, unit)}</td><td>{money(budget.actual?.amountMicros ?? null, unit)}<br /><small>{budget.coverage.actual}</small></td><td>{money(budget.forecast?.amountMicros ?? null, unit)}<br /><small>{budget.coverage.forecast}</small></td><td><span className={styles.pill}>{row.health.statuses.map((status) => status.replaceAll("_", " ")).join(" · ")}</span><br />Updated {budget.lastUpdatedAt ?? "not supplied"}<br />{budget.notifications.length} notifications · {budget.actions.length} read-only actions</td><td><details><summary>{targeting.replaceAll("_", " ")} · {mappingCoverage}</summary>{accountMappings.length ? <ul>{accountMappings.map((account) => <li key={account.accountId}>{account.accountName ?? "Unknown account"} · {account.accountId}<br />{account.ouPath.join(" / ") || "OU unavailable"} · {account.businessUnit ?? account.costCenter ?? "taxonomy unavailable"}</li>)}</ul> : <p>No evidenced account mapping.</p>}</details></td></tr>;
        })}
      </tbody></table></div>
    </section>
    <section className={styles.panel} aria-label="AWS Budget performance history">
      <header className={styles.panelHead}><div><h3>Budget performance history</h3><p>Provider budgeted, actual and forecast values are shown separately.</p></div></header>
      {report.dashboard.budgets.map(({ budget }) => <details className={styles.historyDetail} key={`history:${budget.budgetName}`}><summary>{budget.budgetName} · {budget.history.length} periods · {budget.coverage.history}</summary>{budget.history.length ? <div className={styles.scroll}><table><thead><tr><th>Period</th><th>Budgeted</th><th>Actual</th><th>Forecast</th></tr></thead><tbody>{budget.history.map((point) => <tr key={`${budget.budgetName}:${point.periodStart}`}><td>{point.periodStart}<br />to {point.periodEnd}</td><td>{money(point.budgeted.amountMicros, point.budgeted.unit)}</td><td>{money(point.actual?.amountMicros ?? null, point.actual?.unit ?? null)}</td><td>{money(point.forecast?.amountMicros ?? null, point.forecast?.unit ?? null)}</td></tr>)}</tbody></table></div> : <p>No provider history was supplied for this budget and time unit.</p>}</details>)}
    </section>
    <section className={styles.panel} aria-label="Immutable collection generation history"><header className={styles.panelHead}><div><h3>Collection evidence history</h3><p>Immutable accepted and incomplete provider generations.</p></div></header><div className={styles.scroll}><table><thead><tr><th>Observed</th><th>Data through</th><th>State</th><th>Hierarchy evidence</th><th>Budgets</th><th>Levels / currencies</th></tr></thead><tbody>{report.history.map((item) => <tr key={item.generationId}><td>{item.observedAtIso}</td><td>{item.dataThroughAtIso ?? "Unknown"}</td><td>{item.state}</td><td>{item.hierarchyState ?? "Not supplied"}</td><td>{item.budgetCount}</td><td>{item.budgetLevels.join(", ") || "No cid level"}<br />{item.currencies.join(", ") || "No currency"}</td></tr>)}</tbody></table></div></section>
    <details className={styles.evidence}><summary>Generation evidence, prerequisites and limitations</summary><pre>{JSON.stringify({ freshness: report.freshness, evidence: report.evidence, collection: report.collection, prerequisites: report.prerequisites, limitations: report.dashboard.limitations }, null, 2)}</pre></details>
    <p className={styles.footnote}>AWS Budgets status is updated several times per day. Values are provider evidence, not invoice reconciliation and not Sutra budget evaluations.</p>
  </section>;
}

export function FinopsAwsBudgetsOrganizationDashboard({ connectionId }: { readonly connectionId: string | null }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [state, setState] = useState<{ view: "loading" | "configuration_required" | "partial" | "stale" | "failed" | "empty" | "complete"; report: AwsBudgetsDashboardEnvelope | null; officialDefinition: AwsBudgetsOfficialDefinition }>({ view: "loading", report: null, officialDefinition: AWS_BUDGETS_OFFICIAL_DEFINITION });
  useEffect(() => {
    if (connectionId === null) return;
    const controller = new AbortController();
    const parameters = new URLSearchParams({ connectionId });
    for (const [key, value] of Object.entries(filters)) if (value !== "") parameters.set(key, value);
    fetch(`/api/v1/finops/aws-budgets-organization?${parameters.toString()}`, { signal: controller.signal, credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error("AWS Budgets provider request failed");
        return response.json() as Promise<AwsBudgetsDashboardEnvelope | AwsBudgetsConfigurationEnvelope>;
      })
      .then((report) => {
        if (!hasPinnedOfficialDefinition(report.officialDefinition)) throw new Error("Sutra returned an unrecognized AWS Budgets official definition");
        if (report.dashboard === null) { setState({ view: "configuration_required", report: null, officialDefinition: report.officialDefinition }); return; }
        const typed = report as AwsBudgetsDashboardEnvelope;
        setState({ view: typed.sourceState, report: typed, officialDefinition: typed.officialDefinition });
      })
      .catch(() => { if (!controller.signal.aborted) setState((current) => ({ view: "failed", report: null, officialDefinition: current.officialDefinition })); });
    return () => controller.abort();
  }, [connectionId, filters]);
  if (state.report !== null && state.report.connectionId === connectionId) return <FinopsAwsBudgetsOrganizationReportView report={state.report} filters={filters} onFiltersChange={setFilters} />;
  const status = connectionId === null ? <div role="status" className={`${styles.state} ${styles.warning}`}>Connect an active AWS trust-role account before collecting provider AWS Budgets.</div> : state.view === "configuration_required" ? <div role="status" className={`${styles.state} ${styles.warning}`}>AWS Budgets + Organizations evidence is not available. The permanent signed-broker adapter and cid:budget-level tags are required.</div> : state.view === "failed" ? <div role="alert" className={`${styles.state} ${styles.error}`}>The AWS Budgets provider dashboard could not be loaded.</div> : <div role="status" className={styles.state}>Loading provider AWS Budgets evidence…</div>;
  return <section className={styles.root}>{status}<AwsBudgetsOfficialDefinitionPanel definition={state.officialDefinition} /></section>;
}
