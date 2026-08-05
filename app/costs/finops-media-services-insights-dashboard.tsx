"use client";

import { useEffect, useState } from "react";
import type {
  MediaServicesDashboardFilters,
  MediaServicesPortfolio,
  PortfolioTarget,
} from "../../lib/finops-media-services-dashboard";
import {
  MEDIA_SERVICES_OFFICIAL_DEFINITION,
  type MediaServicesOfficialDefinition,
} from "../../lib/finops-media-services-official-definition";
import styles from "./finops-media-services-insights-dashboard.module.css";

type SourceState = "complete" | "partial" | "stale" | "empty" | "failed" | "configuration_required";
interface MediaServicesEnvelope extends MediaServicesPortfolio {
  readonly connectionId: string;
  readonly sourceState: SourceState;
  readonly officialDefinition: MediaServicesOfficialDefinition;
  readonly freshness: { readonly dataThroughAt: string | null; readonly ageHours: number | null; readonly staleAfterHours: number };
  readonly history: readonly { readonly generationId: string; readonly completedAtIso: string; readonly accountId: string; readonly region: string; readonly state: string; readonly complete: boolean; readonly resourceCount: number; readonly costRowCount: number; readonly billingGenerationId: string }[];
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly collection: { readonly available: false; readonly reason: string };
}
interface MediaServicesUnavailableEnvelope {
  readonly connectionId: string;
  readonly sourceState: string;
  readonly dashboard: null;
  readonly officialDefinition: MediaServicesOfficialDefinition;
}

const EMPTY: MediaServicesDashboardFilters = { accountId: null, region: null, service: null, provider: null, resourceType: null, search: null };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPinnedOfficialDefinition(value: unknown): value is MediaServicesOfficialDefinition {
  if (!isRecord(value) || value.schema !== MEDIA_SERVICES_OFFICIAL_DEFINITION.schema
    || !Array.isArray(value.repositories) || !isRecord(value.repositories[0])
    || value.repositories[0].commit !== MEDIA_SERVICES_OFFICIAL_DEFINITION.repositories[0].commit
    || !Array.isArray(value.artifacts) || !isRecord(value.artifacts[1]) || !isRecord(value.artifacts[2])
    || value.artifacts[1].sha256 !== MEDIA_SERVICES_OFFICIAL_DEFINITION.artifacts[1].sha256
    || value.artifacts[2].sha256 !== MEDIA_SERVICES_OFFICIAL_DEFINITION.artifacts[2].sha256
    || !isRecord(value.totals) || value.totals.sheets !== 9 || value.totals.visuals !== 144) return false;
  return true;
}

export function MediaServicesOfficialDefinitionPanel({
  definition,
}: {
  readonly definition: MediaServicesOfficialDefinition;
}) {
  return <section className={styles.official} aria-label="Official Media Services Insights definition coverage">
    <header className={styles.officialHeader}>
      <div><small>AWS CID {definition.source.version} · complete public definition</small>
        <h3>{definition.totals.sheets} sheets · {definition.totals.visuals} visuals · {definition.totals.controlPlacements} control placements</h3>
        <p>Both official repository URLs resolve to <code>{definition.repositories[0].commit.slice(0,12)}…</code> and byte-identical MSIH artifacts. Counts are parsed from the definition, never inferred from screenshots.</p></div>
      <dl><div><dt>Parameters</dt><dd>{definition.totals.parameterDeclarations}</dd></div><div><dt>Calculated fields</dt><dd>{definition.totals.calculatedFields}</dd></div><div><dt>Filter groups</dt><dd>{definition.totals.filterGroups}</dd></div><div><dt>Datasets</dt><dd>{definition.totals.datasets}</dd></div></dl>
    </header>
    <div className={styles.officialArtifacts} aria-label="Published Media Services Insights artifacts">{definition.artifacts.map((artifact) => <article key={`${artifact.kind}:${artifact.path}`}><strong>{artifact.kind.replaceAll("_"," ")}</strong><code>{artifact.sha256.slice(0,16)}…</code><small>{artifact.path}</small></article>)}</div>
    <div className={styles.officialSheets}>{definition.sheets.map((sheet) => <details key={sheet.id} open={sheet.name === "Executive Summary" || sheet.name === "MediaLive Reservation & Savings"}>
      <summary><span><strong>{sheet.name}</strong><small>{sheet.visualCount} visuals · {sheet.controls.length} controls · {sheet.documentedPurposes.length} documented purposes</small></span></summary>
      <div className={styles.sheetInventory}><p><strong>Visual types:</strong> {Object.entries(sheet.visualTypes).map(([type,count]) => `${count} ${type.replace("Visual","")}`).join(" · ") || "None"}</p>
        <div className={styles.officialControls}>{sheet.controls.map((item,index) => <span key={`${item.placement}:${item.title}:${index}`} data-coverage={item.coverage}>{item.title} · {item.placement} · {item.coverage.toLocaleLowerCase().replace("_"," ")}</span>)}</div>
        <div className={styles.officialPurposes}>{sheet.documentedPurposes.map((item) => <article key={item.purpose} data-coverage={item.coverage}><div><strong>{item.purpose}</strong><span>{item.coverage.toLocaleLowerCase().replace("_"," ")}</span></div><p>{item.nativeEvidence}</p>{item.remainingGap === null ? null : <small><strong>Remaining:</strong> {item.remainingGap}</small>}</article>)}</div>
      </div>
    </details>)}</div>
    <p className={styles.officialDisclosure}>{definition.disclosures[2]} {definition.disclosures[3]}</p>
  </section>;
}

function money(micros: string, currency: string): string {
  const amount = BigInt(micros); const negative = amount < BigInt(0); const absolute = negative ? -amount : amount;
  const whole = absolute / BigInt(1_000_000); const fraction = (absolute % BigInt(1_000_000)).toString().padStart(6,"0").replace(/0+$/u,"");
  return `${negative ? "−" : ""}${currency} ${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"','""')}"`;
}
function exportResources(report: MediaServicesEnvelope): void {
  const rows = report.targets.flatMap((target) => target.resources.map((row) => [target.accountId,target.region,
    row.observation.service,row.observation.provider,row.observation.resourceType,row.observation.name,
    row.observation.resourceId,row.observation.state,row.exactArnCostMicros,target.lineage.currency,target.lineage.costBasis,
    target.generationId,target.lineage.billingGenerationId].map((value) => csvCell(String(value))).join(",")));
  const header = ["account_id","region","service","provider","resource_type","name","resource_id","state",
    "exact_arn_cost_micros","currency","cost_basis","accepted_generation","billing_generation"].join(",");
  const url = URL.createObjectURL(new Blob([[header,...rows].join("\n")],{ type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a"); anchor.href=url; anchor.download="sutra-media-services-insights.csv";
  anchor.click(); URL.revokeObjectURL(url);
}
function message(state: SourceState): string | null {
  if (state === "complete") return null;
  if (state === "configuration_required") return "No complete governed Media Services collection has been accepted for this connection.";
  if (state === "partial") return "A newer target collection is incomplete. The last accepted complete head remains active.";
  if (state === "stale") return "The accepted inventory or active-CUR2 evidence is older than the 48-hour freshness objective.";
  if (state === "empty") return "No resources or CUR2 media-service rows match the selected scope.";
  return "The latest collection failed; failed evidence did not replace an accepted complete head.";
}
function Select({ label,value,options,onChange }: { readonly label: string; readonly value: string | null; readonly options: readonly string[]; readonly onChange: (value: string | null) => void }) {
  return <label>{label}<select value={value ?? ""} onChange={(event) => onChange(event.target.value || null)}><option value="">All</option>{options.map((item) => <option value={item} key={item}>{item.replaceAll("_"," ")}</option>)}</select></label>;
}
function TargetDrilldown({ target }: { readonly target: PortfolioTarget }) {
  return <details className={styles.target}><summary><strong>{target.accountId} · {target.region}</strong><span>{target.resources.length} resources · {target.state}</span></summary>
    <div className={styles.lineage}><span>Accepted generation {target.generationId}</span><span>Capture {target.captureId}</span><span>CUR2 {target.lineage.billingGenerationId}</span><span>Manifest {target.lineage.billingManifestSha256}</span><span>{target.lineage.costBasis} · {target.lineage.currency}</span></div>
    <h4>Provider coverage</h4><div className={styles.coverage}>{target.providerCoverage.map((item) => <article key={item.provider}><strong>{item.provider.replaceAll("_"," ")}</strong><span>{item.state}</span><span>{item.resourceCount} resources · {item.apiCallCount} calls</span>{item.failureCode ? <span>{item.failureCode}</span> : null}</article>)}</div>
    <h4>Workflow resource drilldown</h4><div className={styles.scroll}><table><thead><tr><th>Service</th><th>Type</th><th>Name</th><th>State</th><th>Exact ARN cost</th><th>Tags / signals</th></tr></thead><tbody>{target.resources.map((row) => <tr key={row.observation.resourceArn}><td>{row.observation.service}</td><td>{row.observation.resourceType}</td><td><strong>{row.observation.name}</strong><small>{row.observation.resourceId}</small></td><td>{row.observation.state}</td><td>{money(row.exactArnCostMicros,target.lineage.currency)}</td><td>{[...row.observation.tags.map((tag) => `${tag.key}=${tag.value}`),...row.observation.attributes.map((attribute) => `${attribute.key}=${attribute.value}`)].join(" · ") || "No accepted attributes"}</td></tr>)}</tbody></table></div>
    <h4>Usage and processing dimensions</h4><div className={styles.scroll}><table><thead><tr><th>Service</th><th>Operation</th><th>Usage type</th><th>Quantity micros / unit</th><th>Cost</th></tr></thead><tbody>{target.usage.map((row,index) => <tr key={`${row.service}:${row.operation}:${row.usageType}:${row.unit}:${index}`}><td>{row.service}</td><td>{row.operation ?? "Unspecified"}</td><td>{row.usageType ?? "Unspecified"}</td><td>{row.quantityMicros} {row.unit ?? "unit not supplied"}</td><td>{money(row.costMicros,target.lineage.currency)}</td></tr>)}</tbody></table></div>
  </details>;
}

export function MediaServicesInsightsReportView({ report,filters,onFiltersChange }: { readonly report: MediaServicesEnvelope; readonly filters: MediaServicesDashboardFilters; readonly onFiltersChange: (filters: MediaServicesDashboardFilters) => void }) {
  const notice = message(report.sourceState); const set = <K extends keyof MediaServicesDashboardFilters>(key: K,value: MediaServicesDashboardFilters[K]) => onFiltersChange({ ...filters,[key]: value });
  return <section className={styles.root} aria-label="AWS Media Services Insights dashboard">
    <div className={styles.disclosure}><strong>Evidence boundary.</strong> Costs are active-CUR2 facts. Forecasts are labeled Sutra projections; budgets and MediaLive savings remain unavailable without governed evidence.</div>
    {notice ? <div role="status" className={`${styles.state} ${report.sourceState === "failed" ? styles.error : styles.warning}`}>{notice}</div> : null}
    <div className={styles.filters} aria-label="Media Services filters"><Select label="Account / payer scope" value={filters.accountId} options={report.filterOptions.accounts} onChange={(value) => set("accountId",value)} /><Select label="Region" value={filters.region} options={report.filterOptions.regions} onChange={(value) => set("region",value)} /><Select label="Media service" value={filters.service} options={report.filterOptions.services} onChange={(value) => set("service",value as MediaServicesDashboardFilters["service"])} /><Select label="Provider API" value={filters.provider} options={report.filterOptions.providers} onChange={(value) => set("provider",value as MediaServicesDashboardFilters["provider"])} /><Select label="Resource type" value={filters.resourceType} options={report.filterOptions.resourceTypes} onChange={(value) => set("resourceType",value as MediaServicesDashboardFilters["resourceType"])} /><label>Workflow search<input value={filters.search ?? ""} maxLength={100} placeholder="Name, ARN, operation, usage" onChange={(event) => set("search",event.target.value || null)} /></label></div>
    <section className={styles.section} aria-label="Executive summary"><header><div><small>CUR2-backed</small><h3>Executive summary</h3></div><button type="button" onClick={() => exportResources(report)}>Export visible rows</button></header><div className={styles.cards}><article><span>Accounts</span><strong>{report.executiveSummary.accountCount}</strong><small>{report.executiveSummary.regionCount} Regions</small></article><article><span>Accepted targets</span><strong>{report.executiveSummary.targetCount}</strong><small>complete immutable heads</small></article><article><span>Resources</span><strong>{report.executiveSummary.resourceCount}</strong><small>{report.executiveSummary.costRowCount} CUR2 rows</small></article>{report.executiveSummary.costGroups.map((group) => <article key={`${group.currency}:${group.costBasis}`}><span>{group.currency} · {group.costBasis.replaceAll("_"," ")}</span><strong>{money(group.costMicros,group.currency)}</strong><small>signed CUR2 cost</small></article>)}</div></section>
    <section className={styles.section} aria-label="Media workflow summary"><header><div><small>Operational lenses</small><h3>Media workflows</h3></div></header><div className={styles.workflows}>{report.workflows.map((workflow) => <article key={workflow.id}><span>{workflow.id.replaceAll("_"," ")}</span><h4>{workflow.label}</h4><strong>{workflow.resourceCount} resources</strong>{workflow.costGroups.map((group) => <p key={`${group.currency}:${group.costBasis}`}>{money(group.costMicros,group.currency)} · {group.costBasis.replaceAll("_"," ")}</p>)}<small>{workflow.signals.length ? `Accepted signals: ${workflow.signals.join(", ")}` : "No accepted inventory signals in this selection"}</small></article>)}</div></section>
    <section className={styles.section} aria-label="Cost trends and forecast"><header><div><small>Monthly evidence</small><h3>Trends &amp; visibly labeled forecast</h3></div><span>Data through {report.freshness.dataThroughAt ?? "unavailable"} · {report.freshness.ageHours ?? "unknown"}h old</span></header><div className={styles.trends}>{report.trends.map((point) => <div className={styles.trend} key={`${point.period}:${point.service}:${point.currency}:${point.costBasis}`}><time>{point.period}</time><strong>{point.service}</strong><span>{money(point.costMicros,point.currency)}</span><small>{point.costBasis.replaceAll("_"," ")} · {point.rowCount} rows</small></div>)}</div><div className={styles.forecasts}>{report.forecast.length ? report.forecast.map((point) => <article key={`${point.period}:${point.service}:${point.currency}:${point.costBasis}`}><span>SUTRA projection · {point.period}</span><strong>{point.service} · {money(point.costMicros,point.currency)}</strong><small>Trailing mean of {point.observedPeriodCount} accepted monthly periods; not an AWS forecast or commitment.</small></article>) : <p>At least two accepted monthly periods are required before a forecast is shown.</p>}</div></section>
    <section className={styles.twoColumn}><article className={styles.section}><header><h3>MediaLive reservations &amp; savings</h3></header><div className={styles.miniCards}><span><strong>{report.reservations.channelCount}</strong> channels</span><span><strong>{report.reservations.reservationCount}</strong> reservations</span><span><strong>{report.reservations.offeringCount}</strong> offerings</span></div><p><strong>Savings unavailable:</strong> {report.reservations.reason}</p></article><article className={styles.section}><header><h3>Budget guardrail</h3></header><p><strong>Not configured from this evidence:</strong> {report.budget.reason}</p></article></section>
    <section className={styles.section} aria-label="Account Region workflow drilldowns"><header><div><small>Accepted heads</small><h3>Account / Region drilldowns</h3></div></header>{report.targets.map((target) => <TargetDrilldown target={target} key={target.generationId} />)}</section>
    <section className={styles.section} aria-label="Immutable collection history"><header><h3>Collection history</h3></header><div className={styles.scroll}><table><thead><tr><th>Completed</th><th>Account / Region</th><th>State</th><th>Inventory</th><th>CUR2 rows</th><th>Billing generation</th></tr></thead><tbody>{report.history.map((item) => <tr key={item.generationId}><td>{item.completedAtIso}</td><td>{item.accountId} · {item.region}</td><td>{item.state} · {item.complete ? "accepted eligible" : "not promoted"}</td><td>{item.resourceCount}</td><td>{item.costRowCount}</td><td>{item.billingGenerationId}</td></tr>)}</tbody></table></div></section>
    <details className={`${styles.section} ${styles.evidence}`}><summary>Evidence identifiers, collector status &amp; limitations</summary><pre>{JSON.stringify({ freshness: report.freshness,evidence: report.evidence,collection: report.collection,limitations: report.limitations },null,2)}</pre></details>
  </section>;
}

export function FinopsMediaServicesInsightsDashboard({ connectionId }: { readonly connectionId: string | null }) {
  const [filters,setFilters] = useState<MediaServicesDashboardFilters>(EMPTY);
  const [state,setState] = useState<{ report: MediaServicesEnvelope | null; officialDefinition: MediaServicesOfficialDefinition; error: string | null; configurationRequired: boolean }>({ report:null,officialDefinition:MEDIA_SERVICES_OFFICIAL_DEFINITION,error:null,configurationRequired:false });
  useEffect(() => {
    if (connectionId === null) return; const controller = new AbortController(); const parameters = new URLSearchParams({ connectionId });
    for (const [key,value] of Object.entries(filters)) if (value !== null) parameters.set(key,value);
    fetch(`/api/v1/finops/media-services-insights?${parameters.toString()}`,{ signal: controller.signal,headers: { Accept: "application/json" } })
      .then(async (response) => { if (!response.ok) throw new Error("Media Services Insights request failed"); return response.json() as Promise<MediaServicesEnvelope | MediaServicesUnavailableEnvelope>; })
      .then((report) => { if (!hasPinnedOfficialDefinition(report.officialDefinition)) throw new Error("Sutra returned an unrecognized Media Services Insights definition"); if ("dashboard" in report && report.dashboard === null) setState({ report:null,officialDefinition:report.officialDefinition,error:null,configurationRequired:true }); else setState({ report:report as MediaServicesEnvelope,officialDefinition:report.officialDefinition,error:null,configurationRequired:false }); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setState((current) => ({ report:null,officialDefinition:current.officialDefinition,error:error instanceof Error ? error.message : "Media Services Insights request failed",configurationRequired:false })); });
    return () => controller.abort();
  },[connectionId,filters]);
  const content = connectionId === null
    ? <div role="status" className={`${styles.state} ${styles.warning}`}>Connect an active AWS trust-role account before collecting Media Services evidence.</div>
    : state.configurationRequired
      ? <div role="status" className={`${styles.state} ${styles.warning}`}>The governed Media Services collector has not persisted a complete accepted head for this connection.</div>
      : state.error !== null
        ? <div role="alert" className={`${styles.state} ${styles.error}`}>{state.error}</div>
        : state.report === null || state.report.connectionId !== connectionId
          ? <div role="status" className={styles.state}>Loading Media Services and CUR2 evidence…</div>
          : <MediaServicesInsightsReportView report={state.report} filters={filters} onFiltersChange={setFilters} />;
  return <section className={styles.root}>
    <MediaServicesOfficialDefinitionPanel definition={state.report?.officialDefinition ?? state.officialDefinition} />
    {content}
  </section>;
}
