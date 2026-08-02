"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  ComputeOptimizerExactDashboard,
  ComputeOptimizerExactDashboardFilters,
  ComputeOptimizerExactDashboardRow,
  ComputeOptimizerExactMoney,
} from "../../lib/finops-compute-optimizer-exact-dashboard";
import {
  FINOPS_COMPUTE_OPTIMIZER_OFFICIAL_DEFINITION,
  type FinopsComputeOptimizerOfficialDefinition,
} from "../../lib/finops-compute-optimizer-official-definition";
import {
  hasExactComputeOptimizerOfficialDefinition,
  parseComputeOptimizerExactApiPayload,
  type ComputeOptimizerExactApiPayload,
} from "../../lib/finops-compute-optimizer-exact-client";
import styles from "./finops-compute-optimizer-dashboard.module.css";

type Payload = ComputeOptimizerExactApiPayload;

const EMPTY: ComputeOptimizerExactDashboardFilters = {
  accountId: null, region: null, exportFamily: null, finding: null,
  tagKey: null, tagValue: null, groupByTagKey: null, search: null,
  offset: 0, limit: 100,
};

const MODULE_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  "EC2 instance": ["EC2_INSTANCE"], "Auto Scaling group": ["AUTO_SCALING_GROUP"],
  "EBS volume": ["EBS_VOLUME"], "Lambda function": ["LAMBDA_FUNCTION"],
  "RDS instance": ["RDS_DATABASE"], "RDS storage": ["RDS_DATABASE"],
  "ECS service": ["ECS_SERVICE"], License: ["LICENSE"], "Idle resource": ["IDLE_RESOURCE"],
};

export function hasComputeOptimizerOfficialDefinition(value: unknown): value is FinopsComputeOptimizerOfficialDefinition {
  return hasExactComputeOptimizerOfficialDefinition(value);
}

export function ComputeOptimizerOfficialDefinitionPanel({
  definition,
  observedFamilies = null,
}: {
  readonly definition: FinopsComputeOptimizerOfficialDefinition;
  readonly observedFamilies?: readonly string[] | null;
}) {
  const observed = observedFamilies === null ? null : new Set(observedFamilies);
  return (
    <section className={styles.definition} aria-label="Official AWS Compute Optimizer Dashboard coverage">
      <header><div><small>Immutable AWS audit · {definition.source.version}</small><h3>Published Compute Optimizer modules</h3></div><span>Template {definition.source.templateId} · {definition.source.commit.slice(0, 12)}</span></header>
      <p>{definition.quickSightDefinition.disclosure}</p>
      <div className={styles.moduleGrid}>
        {definition.publishedModuleFamilies.map((module) => {
          const present = observed === null ? null : (MODULE_FAMILIES[module] ?? []).some((family) => observed.has(family));
          return <article key={module}><strong>{module}</strong><span>{present === null ? "Accepted evidence unavailable" : present ? "Present in exact generation" : "No accepted rows"}</span></article>;
        })}
      </div>
      <details className={styles.previewInventory}><summary>Published preview visual inventory</summary><ul>{definition.documentedPreviewVisuals.map((visual) => <li key={visual}>{visual}</li>)}</ul></details>
      <small>Exact sheet/control geometry is not inferred because AWS does not publish the QuickSight definition.</small>
    </section>
  );
}

function Select({ label, value, options, onChange }: {
  readonly label: string; readonly value: string | null; readonly options: readonly string[];
  readonly onChange: (value: string | null) => void;
}) {
  return <label>{label}<select value={value ?? ""} onChange={(event) => onChange(event.target.value || null)}><option value="">All</option>{options.map((option) => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}</select></label>;
}

function formatMicros(value: string): string {
  const amount = BigInt(value);
  const negative = amount < BigInt(0);
  const absolute = (negative ? -amount : amount).toString().padStart(7, "0");
  const whole = BigInt(absolute.slice(0, -6)).toLocaleString();
  const fraction = absolute.slice(-6).replace(/0+$/u, "");
  return `${negative ? "-" : ""}${whole}${fraction.length > 0 ? `.${fraction}` : ""}`;
}

function money(values: readonly ComputeOptimizerExactMoney[]): string {
  return values.length === 0 ? "No exact estimate" : values.map((value) =>
    `${value.currency} ${formatMicros(value.amountMicros)} · ${value.scope.toLowerCase()} · ${value.includesExistingDiscounts ? "after discounts" : "before discounts"}`).join(" | ");
}

function groupName(group: { readonly key: { readonly state: string; readonly value: string | null } }): string {
  return group.key.state === "PRESENT" ? group.key.value ?? "" : group.key.state === "MISSING" ? "Missing provider value" : "Tag key not selected";
}

function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r\n]/u.test(value) ? `'${value}` : value;
  return `"${guarded.replaceAll('"', '""')}"`;
}

function exportRows(rows: readonly ComputeOptimizerExactDashboardRow[]): void {
  const header = ["account", "region", "family", "resource_arn", "findings", "savings", "job_id", "csv_sha256"];
  const body = rows.map((row) => [row.accountId, row.region, row.exportFamily, row.resourceArn,
    row.findings.map((finding) => finding.value).join(" | "), money(row.selectedSavings),
    row.lineage.jobId, row.lineage.csvSha256].map(csvCell).join(","));
  const url = URL.createObjectURL(new Blob([[header.join(","), ...body].join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = "sutra-compute-optimizer-exact.csv"; anchor.click(); URL.revokeObjectURL(url);
}

function RowTable({ title, rows }: { readonly title: string; readonly rows: readonly ComputeOptimizerExactDashboardRow[] }) {
  return <section className={styles.section}><header><h3>{title}</h3><button type="button" onClick={() => exportRows(rows)} disabled={rows.length === 0}>Export visible evidence</button></header>
    <div className={styles.scroll} tabIndex={0} role="region" aria-label={title}><table><caption>{title}</caption><thead><tr><th>Account / Region</th><th>Resource</th><th>Finding / risk</th><th>Current / recommended</th><th>Exact savings</th><th>Lineage</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.key}><td>{row.accountId}<small>{row.region}</small></td><td>{row.exportFamily}<small>{row.resourceId}</small></td><td>{row.findings.map((finding) => finding.value).join(", ") || "No provider finding"}<small>{row.currentRisk.map((risk) => risk.raw).join(", ") || "No current-risk evidence"}</small></td><td>{row.currentConfiguration.map((field) => field.raw).join(", ") || "Unavailable"}<small>{row.recommendedConfiguration.map((field) => field.raw).join(", ") || row.rankedOptions.flatMap((option) => option.configuration.map((field) => field.raw)).join(", ") || "Unavailable"}</small></td><td>{money(row.selectedSavings)}<small>{row.unresolvedSavingsChannelCount} unresolved channels withheld</small></td><td>{row.lineage.jobId}<small>{row.lineage.csvSha256}</small></td></tr>)}</tbody></table></div>
  </section>;
}

export function ComputeOptimizerReportView({ payload, filters, onFiltersChange }: {
  readonly payload: Payload & { readonly dashboard: ComputeOptimizerExactDashboard };
  readonly filters: ComputeOptimizerExactDashboardFilters;
  readonly onFiltersChange: (value: ComputeOptimizerExactDashboardFilters) => void;
}) {
  const report = payload.dashboard;
  const rowByKey = new Map(report.rows.map((row) => [row.key, row]));
  const pageRows = (page: { readonly rowKeys: readonly string[] }): readonly ComputeOptimizerExactDashboardRow[] =>
    page.rowKeys.map((key) => rowByKey.get(key)).filter((row): row is ComputeOptimizerExactDashboardRow => row !== undefined);
  const set = <K extends keyof ComputeOptimizerExactDashboardFilters>(key: K, value: ComputeOptimizerExactDashboardFilters[K]) =>
    onFiltersChange({ ...filters, [key]: value, ...(key === "offset" ? {} : { offset: 0 }) });
  const maxFinding = Math.max(1, ...report.visuals.findings.map((item) => item.count));
  return <section className={styles.root} aria-label="Compute Optimizer exact organization dashboard">
    <div className={styles.disclosure}><strong>Exact organization export evidence.</strong> No discovery result or direct recommendation API is substituted; money remains integer micros.</div>
    {payload.sourceState === "STALE" ? <div role="status" className={styles.warning}>The accepted all-Region generation is older than 48 hours.</div> : null}
    <ComputeOptimizerOfficialDefinitionPanel definition={payload.officialDefinition} observedFamilies={report.generation.exportFamilies} />
    <div className={styles.filters} aria-label="Exact evidence filters">
      <Select label="Account" value={filters.accountId} options={report.filterOptions.accounts} onChange={(value) => set("accountId", value)} />
      <Select label="Region" value={filters.region} options={report.filterOptions.regions} onChange={(value) => set("region", value)} />
      <Select label="Export family" value={filters.exportFamily} options={report.filterOptions.exportFamilies} onChange={(value) => set("exportFamily", value as ComputeOptimizerExactDashboardFilters["exportFamily"])} />
      <Select label="Finding" value={filters.finding} options={report.filterOptions.findings} onChange={(value) => set("finding", value)} />
      <Select label="Tag key" value={filters.tagKey} options={report.filterOptions.tagKeys} onChange={(value) => { onFiltersChange({ ...filters, tagKey: value, tagValue: null, offset: 0 }); }} />
      <Select label="Tag value" value={filters.tagValue} options={report.filterOptions.tagValues} onChange={(value) => set("tagValue", value)} />
      <Select label="Business-unit tag" value={filters.groupByTagKey} options={report.filterOptions.tagKeys} onChange={(value) => set("groupByTagKey", value)} />
      <label>Search<input value={filters.search ?? ""} maxLength={256} onChange={(event) => set("search", event.target.value || null)} /></label>
    </div>
    <section className={styles.section}><h3>Organization optimization overview</h3><div className={styles.cards}>
      <article><span>Accepted recommendations</span><strong>{report.summary.filteredRecommendationCount}</strong><small>{report.generation.coverage.expectedTargetCount} exact targets</small></article>
      <article><span>Total EC2 instances</span><strong>{report.visuals.totalInstances}</strong></article>
      <article><span>Current risk evidence</span><strong>{report.visuals.operationalRiskFindingCount}</strong></article>
      <article><span>Selected exact savings</span><strong>{money(report.summary.selectedExactSavings)}</strong></article>
      <article><span>Maximum EC2 potential</span><strong>{report.visuals.maximumPotentialSavingsEc2.length === 0 ? "Unavailable" : money(report.visuals.maximumPotentialSavingsEc2.map((item) => item.savings))}</strong><small>{report.visuals.maximumPotentialSavingsEc2.map((item) => item.resourceArn).join(" · ")}</small></article>
      <article><span>Unresolved savings</span><strong>{report.summary.unresolvedSavingsChannelCount}</strong><small>counted, never parsed</small></article>
    </div></section>
    <section className={styles.visualGrid}>
      <article className={styles.section}><h3>Findings</h3><div className={styles.bars}>{report.visuals.findings.map((item) => <div key={`${item.key.state}:${item.key.value}`}><span>{groupName(item)}</span><b>{item.count}</b><i aria-hidden="true"><em style={{ width: `${item.count * 100 / maxFinding}%` }} /></i></div>)}</div></article>
      <article className={styles.section}><h3>Findings by date</h3>{report.visuals.findingsByDate.map((item) => <div className={styles.rank} key={`${item.key.state}:${item.key.value}`}><strong>{groupName(item)}</strong><span>{item.count}</span></div>)}</article>
      <article className={styles.section}><h3>Findings by business unit</h3>{report.visuals.findingsByBusinessUnit.map((item) => <div className={styles.rank} key={`${item.key.state}:${item.key.value}`}><strong>{groupName(item)}</strong><span>{item.count}</span></div>)}</article>
    </section>
    <section className={styles.grid3}>
      <article className={styles.section}><h3>Potential savings by date</h3>{report.visuals.potentialSavingsByDate.map((item) => <div className={styles.rank} key={`${item.key.state}:${item.key.value}`}><strong>{groupName(item)}</strong><span>{item.count}</span><small>{money(item.savings)}</small></div>)}</article>
      <article className={styles.section}><h3>Potential savings by business unit</h3>{report.visuals.potentialSavingsByBusinessUnit.map((item) => <div className={styles.rank} key={`${item.key.state}:${item.key.value}`}><strong>{groupName(item)}</strong><span>{item.count}</span><small>{money(item.savings)}</small></div>)}</article>
      <article className={styles.section}><h3>Operational risks by business unit</h3>{report.visuals.operationalRisksByBusinessUnit.map((item) => <div className={styles.rank} key={`${item.key.state}:${item.key.value}`}><strong>{groupName(item)}</strong><span>{item.count}</span></div>)}</article>
    </section>
    <section className={styles.section}><h3>Potential savings histogram</h3>{report.visuals.potentialSavingsHistogram.map((item) => <div className={styles.rank} key={`${item.currency}:${item.bucket}`}><strong>{item.currency} · {item.bucket.replaceAll("_", " ")}</strong><span>{item.count}</span></div>)}</section>
    <RowTable title="Select instance" rows={pageRows(report.visuals.selectedInstances)} />
    <RowTable title="Current versus recommended option projection" rows={pageRows(report.visuals.currentVersusRecommendedOptionProjection)} />
    <RowTable title="Recommended instance family changes" rows={pageRows(report.visuals.recommendedInstanceFamilyChanges)} />
    <RowTable title="Potential savings by instance" rows={pageRows(report.visuals.potentialSavingsByInstance)} />
    <section className={styles.section}><header><h3>Evidence page</h3><span>{report.page.rowKeys.length} of {report.page.total}</span></header><div><button type="button" disabled={filters.offset === 0} onClick={() => set("offset", Math.max(0, filters.offset - filters.limit))}>Previous</button>{" "}<button type="button" disabled={!report.page.hasMore} onClick={() => set("offset", filters.offset + filters.limit)}>Next</button></div></section>
    <details className={`${styles.section} ${styles.evidence}`}><summary>Immutable lineage, scope and limitations</summary><pre>{JSON.stringify({ scope: report.scope, generation: report.generation, freshness: payload.freshness, evidence: payload.evidence, collection: payload.collection, limitations: report.limitations }, null, 2)}</pre></details>
  </section>;
}

export function FinopsComputeOptimizerDashboard({ connectionId }: { readonly connectionId: string | null }) {
  const [filters, setFilters] = useState(EMPTY);
  const [state, setState] = useState<{ readonly connectionId: string | null; readonly payload: Payload | null; readonly error: string | null }>(
    { connectionId: null, payload: null, error: null });
  const query = useMemo(() => {
    if (connectionId === null) return null;
    const parameters = new URLSearchParams({ connectionId });
    for (const [key, value] of Object.entries(filters)) if (value !== null) parameters.set(key, String(value));
    return parameters;
  }, [connectionId, filters]);
  useEffect(() => {
    if (connectionId === null || query === null) return;
    const controller = new AbortController();
    fetch(`/api/v1/finops/compute-optimizer?${query.toString()}`, { cache: "no-store", credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        const value: unknown = await response.json();
        if (!response.ok && response.status !== 503) throw new Error("Compute Optimizer exact request failed");
        return parseComputeOptimizerExactApiPayload(value, connectionId);
      }).then((payload) => setState({ connectionId, payload, error: null }))
      .catch((error: unknown) => { if (!controller.signal.aborted) setState({ connectionId, payload: null, error: error instanceof Error ? error.message : "Request failed" }); });
    return () => controller.abort();
  }, [connectionId, query]);
  if (state.connectionId === connectionId && state.payload?.dashboard !== null && state.payload !== null) {
    return <ComputeOptimizerReportView payload={state.payload as Payload & { readonly dashboard: ComputeOptimizerExactDashboard }} filters={filters} onFiltersChange={setFilters} />;
  }
  const status = connectionId === null ? "Connect an active AWS trust-role account."
    : state.connectionId === connectionId && state.error !== null ? state.error
      : state.connectionId === connectionId && state.payload?.sourceState === "EVIDENCE_KEY_UNAVAILABLE" ? "Accepted evidence exists, but this runtime cannot authenticate its encrypted regional plans."
        : state.connectionId === connectionId && state.payload?.dashboard === null ? "No accepted exact all-Region export generation exists yet."
          : "Loading exact Compute Optimizer evidence…";
  return <section className={styles.root}><div role={state.error === null ? "status" : "alert"} className={state.error === null ? styles.warning : styles.error}>{status}</div><ComputeOptimizerOfficialDefinitionPanel definition={state.payload?.officialDefinition ?? FINOPS_COMPUTE_OPTIMIZER_OFFICIAL_DEFINITION} /></section>;
}
