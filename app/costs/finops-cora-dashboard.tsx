"use client";

import { useEffect, useState } from "react";
import type {
  CoraDashboardFilters,
  CoraDashboardProjection,
  CoraDashboardRow,
} from "../../lib/finops-cora-dashboard";
import type { CoraOfficialDefinition } from "../../lib/finops-cora-official-definition";
import styles from "./finops-cora-dashboard.module.css";

type SourceState = "complete" | "partial" | "stale" | "empty" | "failed" | "configuration_required";
export interface CoraDashboardEnvelope extends CoraDashboardProjection {
  readonly connectionId: string;
  readonly sourceState: SourceState;
  readonly source: string;
  readonly officialDefinition: CoraOfficialDefinition;
  readonly freshness: { readonly dataThroughAt: string | null; readonly ageHours: number | null; readonly staleAfterHours: number };
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly collection: { readonly state: "unavailable" | "collecting" | "failed" | "ready"; readonly reason: string; readonly lastAttemptAt: string | null };
  readonly disclosures: readonly string[];
}

interface CoraConfigurationEnvelope {
  readonly connectionId: string;
  readonly sourceState: "configuration_required";
  readonly officialDefinition: CoraOfficialDefinition;
  readonly dashboard: null;
  readonly collection: CoraDashboardEnvelope["collection"];
}

const EMPTY_FILTERS: CoraDashboardFilters = {
  accountId: null, optimizationClass: null, actionType: null, region: null,
  implementationEffort: null, workflowStatus: null, currencyCode: null,
  tagKey: null, tagValue: null, resourceId: null, restartNeeded: null,
  rollbackPossible: null, excludeFinopsExceptions: false,
};

function money(micros: string | null, currency: string): string {
  if (micros === null) return "Not supplied";
  const negative = micros.startsWith("-");
  const digits = negative ? micros.slice(1) : micros;
  const padded = digits.padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const fraction = padded.slice(-6).replace(/0+$/u, "");
  return `${negative ? "-" : ""}${currency} ${whole}${fraction ? `.${fraction}` : ""}`;
}

function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

function downloadCsv(rows: readonly CoraDashboardRow[]): void {
  const header = ["account", "action", "class", "region", "effort", "currency", "estimated_monthly_savings_micros", "resource", "workflow"];
  const body = rows.map((row) => [
    row.accountId, row.actionType, row.optimizationClass, row.region,
    row.implementationEffort, row.currencyCode,
    row.estimates.monthlySavingsAfterDiscountMicros ?? row.estimates.monthlySavingsBeforeDiscountMicros,
    row.resourceArn ?? row.resourceId ?? "", row.workflow.status,
  ].map(csvCell).join(","));
  const url = URL.createObjectURL(new Blob([[header.join(","), ...body].join("\n")], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = "sutra-cora-recommendations.csv"; anchor.click();
  URL.revokeObjectURL(url);
}

function Select({ label, value, options, onChange }: {
  readonly label: string; readonly value: string | null; readonly options: readonly { value: string; label: string }[];
  readonly onChange: (value: string | null) => void;
}) {
  return <label>{label}<select value={value ?? ""} onChange={(event) => onChange(event.target.value || null)}>
    <option value="">All</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select></label>;
}

function statusMessage(state: SourceState): { text: string; tone: string } | null {
  if (state === "complete") return null;
  if (state === "configuration_required") return { text: "CORA is not configured. Enable Cost Optimization Hub and bind an unfiltered recommendations Data Export.", tone: "warning" };
  if (state === "partial") return { text: "Coverage is partial. The accepted complete head, when available, is retained while newer incomplete evidence is disclosed.", tone: "warning" };
  if (state === "stale") return { text: "The latest accepted recommendation evidence is older than the 48-hour freshness objective.", tone: "warning" };
  if (state === "empty") return { text: "No recommendations match this evidence set and filter selection.", tone: "" };
  return { text: "The latest CORA collection failed. No failed generation has replaced a previously accepted complete head.", tone: "error" };
}

function RecommendationTable({ rows, emptyMessage }: {
  readonly rows: readonly CoraDashboardRow[];
  readonly emptyMessage: string;
}) {
  if (rows.length === 0) return <p className={styles.empty}>{emptyMessage}</p>;
  return <div className={styles.scroll}><table className={styles.table}>
    <thead><tr><th>Account</th><th>Action</th><th>Resource</th><th>Region</th><th>Effort</th><th>AWS estimated monthly opportunity</th><th>Evidence</th></tr></thead>
    <tbody>{rows.map((row) => <tr key={row.trackingKey}>
      <td>{row.accountName}<br />{row.accountId}</td>
      <td><span className={styles.pill}>{row.actionType}</span><br />{row.optimizationClass.replaceAll("_", " ")}</td>
      <td>{row.currentResourceType ?? "Unknown"}<br />{row.resourceId ?? "No resource ID"}</td>
      <td>{row.region}</td><td>{row.implementationEffort}</td>
      <td className={styles.estimate}>{money(row.estimates.monthlySavingsAfterDiscountMicros ?? row.estimates.monthlySavingsBeforeDiscountMicros, row.currencyCode)}</td>
      <td><details className={styles.detail}><summary>Drill down</summary><dl className={styles.detailGrid}>
        <div><dt>Recommended state</dt><dd>{row.recommendedResourceSummary ?? row.recommendedResourceType ?? "Not supplied"}</dd></div>
        <div><dt>Current state</dt><dd>{row.currentResourceSummary ?? row.currentResourceType ?? "Not supplied"}</dd></div>
        <div><dt>Source / lookback</dt><dd>{row.recommendationSource} · {row.recommendationLookbackPeriodInDays} days</dd></div>
        <div><dt>Workflow</dt><dd>{row.workflow.status} · owner {row.workflow.ownerPrincipalId ?? "unassigned"}</dd></div>
        <div><dt>Restart / rollback</dt><dd>{row.restartNeeded ? "Restart needed" : "No restart indicated"} · {row.rollbackPossible ? "Rollback possible" : "Rollback not indicated"}</dd></div>
        <div><dt>Tags</dt><dd>{row.tags.length ? row.tags.map((tag) => `${tag.key}=${tag.value}`).join(", ") : "None exported"}</dd></div>
      </dl></details></td>
    </tr>)}</tbody>
  </table></div>;
}

function CommitmentMatrix({ report, actionType }: {
  readonly report: CoraDashboardEnvelope;
  readonly actionType: "PurchaseSavingsPlans" | "PurchaseReservedInstances";
}) {
  const rows = (report.commitmentMatrices ?? []).filter((row) => row.actionType === actionType);
  if (rows.length === 0) return <p className={styles.empty}>No normalized option matrix matches the current filters.</p>;
  return <div className={styles.scroll}><table className={styles.table}>
    <thead><tr><th>Service / offering</th><th>Level</th><th>Term</th><th>Upfront</th><th>Actions</th><th>Resource-safe monthly opportunity</th></tr></thead>
    <tbody>{rows.map((row) => <tr key={[row.actionType, row.currencyCode, row.service, row.offeringType, row.level, row.term, row.upfront].join(":")}>
      <td>{row.service}<br />{row.offeringType}</td><td>{row.level}</td><td>{row.term}</td><td>{row.upfront}</td>
      <td>{row.deduplicatedActionCount}</td><td className={styles.estimate}>{money(row.estimatedMonthlySavingsAfterDiscountMicros ?? row.estimatedMonthlySavingsBeforeDiscountMicros, row.currencyCode)}</td>
    </tr>)}</tbody>
  </table><p className={styles.evidence}>Each matrix first retains the highest recommendation per identified resource within Rate and currency. Unknown provider text remains UNKNOWN; missing resource IDs remain separate.</p></div>;
}

function OfficialDefinitionCoverage({ definition }: {
  readonly definition: CoraOfficialDefinition;
}) {
  return <details className={`${styles.section} ${styles.evidence} ${styles.definition}`}>
    <summary>Official AWS CORA definition · {definition.totals.visuals} visuals across {definition.totals.sheets} sheets</summary>
    <div className={styles.definitionBody}>
      <p><strong>Immutable source:</strong> <a href={`${definition.source.repository}/blob/${definition.source.commit}/${definition.source.definitionPath}`} rel="noreferrer" target="_blank">CORA {definition.source.version} QuickSight definition</a> at commit <code>{definition.source.commit}</code>.</p>
      <p><strong>Verified hashes:</strong> definition <code>{definition.source.definitionSha256}</code>; manifest <code>{definition.source.manifestSha256}</code>; changelog <code>{definition.source.changelogSha256}</code>; embedded <code>cora_view</code> SQL <code>{definition.source.embeddedViewSha256}</code>.</p>
      <p><strong>Exact inventory:</strong> {definition.totals.visuals} visuals, {definition.totals.parameterControls} parameter controls, {definition.totals.filterControls} filter-control placements, {definition.totals.parameterDeclarations} parameter declarations, {definition.totals.calculatedFields} calculated fields, {definition.totals.filterGroups} filter groups, {definition.totals.columnConfigurations} column configurations, and {definition.totals.datasets} dataset.</p>
      <div className={styles.definitionSheets} aria-label="Exact official CORA sheet inventory">
        {definition.sheets.map((sheet) => <details key={sheet.id} className={styles.definitionSheet}>
          <summary><strong>{sheet.name}</strong><span>{sheet.visualCount} visuals · {sheet.parameterControls.length} parameter controls · {sheet.filterControls.length} filter controls</span></summary>
          <p><strong>{sheet.coverage.replaceAll("_", " ")}</strong> · {sheet.nativeEvidence}</p>
          <p><strong>Remaining gap:</strong> {sheet.remainingGap}</p>
          <p><strong>Parameter controls:</strong> {sheet.parameterControls.join(", ") || "None"}</p>
          <p><strong>Filter controls:</strong> {sheet.filterControls.join(", ") || "None"}</p>
          {sheet.visuals.length === 0 ? <p>The pinned sheet contains no visual objects.</p> : <ul className={styles.definitionVisuals}>{sheet.visuals.map((item) => <li key={item.id}><span>{item.title}</span><small>{item.type} · <code>{item.id}</code></small></li>)}</ul>}
        </details>)}
      </div>
      <p><strong>Preserved runtime gaps:</strong> The published Athena view SQL, credential-owning bounded S3/Parquet adapter contract and strict signed route are implemented locally. The default SDK/Parquet factory, live provider reconciliation, two-tenant proof, release-SHA gate, immutable image deployment, and production acceptance remain open. No pixel, layout, interaction-tree, or QuickSight runtime parity is claimed.</p>
    </div>
  </details>;
}

export function CoraDashboardReportView({ report, filters, onFiltersChange }: {
  readonly report: CoraDashboardEnvelope;
  readonly filters: CoraDashboardFilters;
  readonly onFiltersChange: (filters: CoraDashboardFilters) => void;
}) {
  const state = statusMessage(report.sourceState);
  const set = <K extends keyof CoraDashboardFilters>(key: K, value: CoraDashboardFilters[K]) =>
    onFiltersChange({ ...filters, [key]: value });
  const usageRows = report.rows.filter((row) => row.optimizationClass === "RESOURCE_USAGE_OPTIMIZATION");
  const savingsPlanRows = report.rows.filter((row) => row.actionType === "PurchaseSavingsPlans");
  const reservedInstanceRows = report.rows.filter((row) => row.actionType === "PurchaseReservedInstances");
  return <section className={styles.root} aria-label="CORA cost optimization recommended actions">
    <div className={styles.notice}><strong>AWS recommendation estimates — not realized savings.</strong> Usage and rate opportunities are kept separate and deduplicated by resource ID within each class. Rows without a resource ID remain separate. Rate estimates are not adjusted for implementing rightsizing, stop, upgrade, or migration actions.</div>
    {state ? <div role="status" className={`${styles.state} ${state.tone === "warning" ? styles.warning : state.tone === "error" ? styles.error : ""}`}>{state.text}</div> : null}
    <OfficialDefinitionCoverage definition={report.officialDefinition} />
    <div className={styles.filters} aria-label="CORA filters">
      <Select label="Account" value={filters.accountId} options={report.filterOptions.accounts.map((item) => ({ value: item.id, label: `${item.name} · ${item.id}` }))} onChange={(value) => set("accountId", value)} />
      <Select label="Optimization class" value={filters.optimizationClass} options={report.filterOptions.optimizationClasses.map((value) => ({ value, label: value.replaceAll("_", " ") }))} onChange={(value) => set("optimizationClass", value as CoraDashboardFilters["optimizationClass"])} />
      <Select label="Action" value={filters.actionType} options={report.filterOptions.actionTypes.map((value) => ({ value, label: value }))} onChange={(value) => set("actionType", value as CoraDashboardFilters["actionType"])} />
      <Select label="Region" value={filters.region} options={report.filterOptions.regions.map((value) => ({ value, label: value }))} onChange={(value) => set("region", value)} />
      <Select label="Effort" value={filters.implementationEffort} options={report.filterOptions.implementationEfforts.map((value) => ({ value, label: value }))} onChange={(value) => set("implementationEffort", value as CoraDashboardFilters["implementationEffort"])} />
      <Select label="Workflow" value={filters.workflowStatus} options={report.filterOptions.workflowStatuses.map((value) => ({ value, label: value }))} onChange={(value) => set("workflowStatus", value as CoraDashboardFilters["workflowStatus"])} />
      <Select label="Currency" value={filters.currencyCode} options={report.filterOptions.currencies.map((value) => ({ value, label: value }))} onChange={(value) => set("currencyCode", value)} />
      <Select label="Cost allocation tag" value={filters.tagKey} options={report.filterOptions.tagKeys.map((value) => ({ value, label: value }))} onChange={(value) => onFiltersChange({ ...filters, tagKey: value, tagValue: value === null ? null : filters.tagValue })} />
      <label>Tag value<input value={filters.tagValue ?? ""} disabled={filters.tagKey === null} onChange={(event) => set("tagValue", event.target.value || null)} placeholder="Exact value" /></label>
      <label>Resource ID<input value={filters.resourceId ?? ""} onChange={(event) => set("resourceId", event.target.value || null)} placeholder="Exact resource ID" /></label>
      <Select label="Restart" value={filters.restartNeeded === null ? null : String(filters.restartNeeded)} options={[{ value: "true", label: "Required" }, { value: "false", label: "Not required" }]} onChange={(value) => set("restartNeeded", value === null ? null : value === "true")} />
      <Select label="Rollback" value={filters.rollbackPossible === null ? null : String(filters.rollbackPossible)} options={[{ value: "true", label: "Possible" }, { value: "false", label: "Not indicated" }]} onChange={(value) => set("rollbackPossible", value === null ? null : value === "true")} />
      <label className={styles.checkbox}><input type="checkbox" checked={filters.excludeFinopsExceptions} onChange={(event) => set("excludeFinopsExceptions", event.target.checked)} />Exclude FinopsException-tagged workloads</label>
    </div>
    <nav className={styles.coverage} aria-label="Official CORA sheet coverage">
      {report.officialSheetCoverage.map((item) => <article key={item.sheet} className={styles.coverageItem}>
        <strong>{item.sheet}</strong><span className={item.status === "IMPLEMENTED" ? styles.implemented : styles.partial}>{item.status}</span>
        <small>{item.localEvidence}</small>{item.limitation ? <small>{item.limitation}</small> : null}
      </article>)}
    </nav>
    <section className={styles.summarySection} aria-label="Summary">
      <header className={styles.summaryHead}><h3>Summary · Top potential savings and actions</h3><button className={styles.button} type="button" onClick={() => downloadCsv(report.rows)}>Export visible rows</button></header>
      <div className={styles.cards} aria-label="Resource-deduplicated opportunity summaries">
      {report.opportunitySummaries.map((summary) => <article className={styles.card} key={`${summary.optimizationClass}:${summary.currencyCode}`}>
        <small>{summary.optimizationClass.replaceAll("_", " ")}</small>
        <strong>{money(summary.estimatedMonthlySavingsAfterDiscountMicros ?? summary.estimatedMonthlySavingsBeforeDiscountMicros, summary.currencyCode)}</strong>
        <span>{summary.deduplicatedActionCount} actions · {summary.distinctResourceCount} identified resources · {summary.rawRecommendationCount} raw rows</span>
        {summary.recommendationsWithoutResourceId > 0 ? <span>{summary.recommendationsWithoutResourceId} rows lack a resource ID and remain separate</span> : null}
      </article>)}
      </div>
      <p className={styles.evidence}>Raw evidence contains {report.resultCount} matching recommendations. Opportunity cards retain only the greatest recommendation for an identified resource within Usage or Rate and currency; missing resource IDs are never guessed or collapsed.</p>
    </section>
    <section className={styles.section} aria-label="Usage Optimization">
      <header className={styles.sectionHead}><h3>Usage Optimization · Top actions by resource and action</h3></header>
      <RecommendationTable rows={usageRows} emptyMessage="No usage-optimization recommendations match the current filters." />
    </section>
    <section className={styles.section} aria-label="Rate Optimization - Savings Plans">
      <header className={styles.sectionHead}><h3>Rate Optimization — Savings Plans · Estimated savings</h3></header>
      <CommitmentMatrix report={report} actionType="PurchaseSavingsPlans" />
      <RecommendationTable rows={savingsPlanRows} emptyMessage="No Savings Plans recommendations match the current filters." />
    </section>
    <section className={styles.section} aria-label="Rate Optimization - Reserved Instances">
      <header className={styles.sectionHead}><h3>Rate Optimization — Reserved Instances · Potential savings</h3></header>
      <CommitmentMatrix report={report} actionType="PurchaseReservedInstances" />
      <RecommendationTable rows={reservedInstanceRows} emptyMessage="No Reserved Instance recommendations match the current filters." />
      {report.rowsTruncated ? <p className={styles.evidence}>Only the first 500 sorted rows are rendered. Refine filters before exporting.</p> : null}
    </section>
    <section className={styles.section} aria-label="Top Potential Savings Over Time"><header className={styles.sectionHead}><h3>Top Potential Savings Over Time · Daily evidence history</h3></header><div className={styles.scroll}><table className={styles.table}><thead><tr><th>Collected</th><th>Data through</th><th>State</th><th>Recommendations</th><th>Raw per-currency opportunity evidence</th></tr></thead><tbody>{report.history.map((point) => <tr key={point.generationId}><td>{point.collectedAtIso}</td><td>{point.dataThroughAtIso ?? "Unavailable"}</td><td>{point.sourceState}</td><td>{point.recommendationCount}</td><td>{point.summaries.map((summary) => `${summary.optimizationClass}: ${money(summary.estimatedMonthlySavingsAfterDiscountMicros ?? summary.estimatedMonthlySavingsBeforeDiscountMicros, summary.currencyCode)}`).join(" · ") || "No accepted recommendations"}</td></tr>)}</tbody></table></div></section>
    <details className={`${styles.section} ${styles.evidence}`}><summary>About · Evidence and coverage</summary><pre>{JSON.stringify({ freshness: report.freshness, evidence: report.evidence, collection: report.collection, disclosures: report.disclosures, officialSheetCoverage: report.officialSheetCoverage }, null, 2)}</pre></details>
    <p className={styles.footnote}>Savings Plans and Reserved Instance estimates exported by CORA do not account for the effect of first implementing usage optimization recommendations.</p>
  </section>;
}

export function FinopsCoraDashboard({ connectionId }: { readonly connectionId: string | null }) {
  const [filters, setFilters] = useState<CoraDashboardFilters>(EMPTY_FILTERS);
  const [state, setState] = useState<{
    report: CoraDashboardEnvelope | null;
    error: string | null;
    configurationRequired: boolean;
    collectionState: CoraDashboardEnvelope["collection"] | null;
    officialDefinition: CoraOfficialDefinition | null;
  }>({ report: null, error: null, configurationRequired: false, collectionState: null, officialDefinition: null });
  useEffect(() => {
    if (connectionId === null) {
      return;
    }
    const controller = new AbortController();
    const parameters = new URLSearchParams({ connectionId });
    for (const [key, value] of Object.entries(filters)) if (value !== null) parameters.set(key, String(value));
    fetch(`/api/v1/finops/cora?${parameters.toString()}`, { signal: controller.signal, headers: { Accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error("CORA dashboard request failed");
        return response.json() as Promise<CoraDashboardEnvelope | CoraConfigurationEnvelope>;
      })
      .then((report) => {
        if ("dashboard" in report && report.dashboard === null) {
          setState({ report: null, error: null, configurationRequired: true, collectionState: report.collection, officialDefinition: report.officialDefinition });
          return;
        }
        setState({
          report: report as CoraDashboardEnvelope,
          error: null,
          configurationRequired: false,
          collectionState: report.collection,
          officialDefinition: report.officialDefinition,
        });
      })
      .catch((error: unknown) => { if (!controller.signal.aborted) setState({ report: null, error: error instanceof Error ? error.message : "CORA dashboard request failed", configurationRequired: false, collectionState: null, officialDefinition: null }); });
    return () => controller.abort();
  }, [connectionId, filters]);
  if (connectionId === null) return <div role="status" className={`${styles.state} ${styles.warning}`}>Connect an active AWS trust-role account before configuring CORA.</div>;
  if (state.configurationRequired) {
    const message = state.collectionState?.state === "collecting" ? "CORA collection is in progress. The dashboard will activate only after a complete immutable export is accepted."
      : state.collectionState?.state === "failed" ? "The latest CORA collection failed. Review the sanitized collection reason and retry without replacing prior accepted history."
        : "Enable Cost Optimization Hub and bind an unfiltered COST_OPTIMIZATION_RECOMMENDATIONS Data Export before CORA can render provider evidence.";
    return <section className={styles.root}><div role="status" className={`${styles.state} ${state.collectionState?.state === "failed" ? styles.error : styles.warning}`}>{message}{state.collectionState === null ? null : <><br /><small>{state.collectionState.reason} · {state.collectionState.lastAttemptAt ?? "not started"}</small></>}</div>{state.officialDefinition === null ? null : <OfficialDefinitionCoverage definition={state.officialDefinition} />}</section>;
  }
  if (state.error !== null) return <div role="alert" className={`${styles.state} ${styles.error}`}>{state.error}</div>;
  if (state.report === null || state.report.connectionId !== connectionId) return <div role="status" className={styles.state}>Loading CORA evidence…</div>;
  return <CoraDashboardReportView report={state.report} filters={filters} onFiltersChange={setFilters} />;
}
