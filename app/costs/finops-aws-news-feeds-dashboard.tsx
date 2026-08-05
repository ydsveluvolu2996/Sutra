"use client";

import { useEffect, useState } from "react";
import type { AwsNewsDashboardFilters, AwsNewsDashboardProjection } from "../../lib/finops-aws-news-dashboard";
import type { AwsNewsSourceEvidence } from "../../lib/finops-aws-news-feeds";
import type { AWS_NEWS_FEEDS_RUNTIME_CAPABILITY } from "../../lib/finops-aws-news-feeds-runtime-binding";
import type { AwsNewsOfficialDefinition } from "../../lib/finops-aws-news-official-definition";
import styles from "./finops-aws-news-feeds-dashboard.module.css";

type SourceState = "complete" | "partial" | "stale" | "empty" | "failed" | "configuration_required";
interface AwsNewsDashboardEnvelope extends AwsNewsDashboardProjection {
  readonly connectionId: string;
  readonly sourceState: SourceState;
  readonly officialDefinition: AwsNewsOfficialDefinition;
  readonly freshness: { readonly observedAt: string; readonly ageHours: number | null; readonly staleAfterHours: number };
  readonly sourceEvidence: readonly AwsNewsSourceEvidence[];
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly collection: typeof AWS_NEWS_FEEDS_RUNTIME_CAPABILITY;
  readonly disclosure: string;
}

interface AwsNewsFeedsConfigurationEnvelope {
  readonly dashboard: null;
  readonly officialDefinition: AwsNewsOfficialDefinition;
  readonly collection: typeof AWS_NEWS_FEEDS_RUNTIME_CAPABILITY;
}

const EMPTY: AwsNewsDashboardFilters = { sourceId: null, feedKind: null, serviceId: null, category: null, relevance: null, search: null };

function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

function exportCsv(report: AwsNewsDashboardEnvelope): void {
  const rows = report.items.map((item) => [item.publishedAt, item.feedKind, item.sourceLabel, item.title,
    item.matchedServices.map((service) => service.displayName).join(" | "), item.categories.join(" | "), item.canonicalUrl]
    .map(csvCell).join(","));
  const csv = [["published_at", "feed_family", "source", "title", "matched_services", "categories", "official_url"].join(","), ...rows].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = "sutra-aws-news-feeds.csv"; anchor.click(); URL.revokeObjectURL(url);
}

function status(state: SourceState): string | null {
  if (state === "complete") return null;
  if (state === "configuration_required") return "No governed AWS News Feeds collection has been persisted for this connection.";
  if (state === "partial") return "A newer collection is incomplete. The last fresh complete head is retained and incomplete source evidence remains visible.";
  if (state === "stale") return "The accepted feed evidence is older than the 48-hour freshness objective.";
  if (state === "empty") return "No announcements match the selected filters.";
  return "The latest collection failed. Failed evidence did not replace a previously accepted complete head.";
}

function Select({ label, value, options, onChange }: { readonly label: string; readonly value: string | null; readonly options: readonly { value: string; label: string }[]; readonly onChange: (value: string | null) => void }) {
  return <label>{label}<select value={value ?? ""} onChange={(event) => onChange(event.target.value || null)}><option value="">All</option>{options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>;
}

function AwsNewsOfficialDefinitionPanel({ definition }: { readonly definition: AwsNewsOfficialDefinition }) {
  return <section className={styles.official} aria-label="Official AWS News Feeds definition coverage">
    <header><div><h3>Official AWS definition coverage</h3><p>{definition.totals.sheets} sheets · {definition.totals.visuals} visuals · {definition.totals.parameterControls} controls</p></div><small>{definition.source.commit.slice(0, 12)} · {definition.source.sha256.slice(0, 16)}…</small></header>
    <div className={styles.officialGrid}>{definition.sheets.map((sheet) => <article key={sheet.id}><div><strong>{sheet.name}</strong><span>{sheet.visuals.length} visuals · {sheet.controls.length} controls</span></div><small>{sheet.controls.join(" · ") || "No controls"}</small><p>{sheet.note}</p><details><summary>Exact visual objects</summary><ul>{sheet.visuals.map((visual) => <li key={visual.id}><code>{visual.id.slice(0, 8)}…</code> · {visual.type}</li>)}</ul></details></article>)}</div>
    <p className={styles.officialNote}>Definition SHA-256 {definition.source.embeddedDefinitionSha256}. Exact counts describe the pinned source tree; native charts do not claim QuickSight pixel or interaction parity.</p>
  </section>;
}

export function AwsNewsFeedsReportView({ report, filters, onFiltersChange }: { readonly report: AwsNewsDashboardEnvelope; readonly filters: AwsNewsDashboardFilters; readonly onFiltersChange: (filters: AwsNewsDashboardFilters) => void }) {
  const message = status(report.sourceState);
  const set = <K extends keyof AwsNewsDashboardFilters>(key: K, value: AwsNewsDashboardFilters[K]) => onFiltersChange({ ...filters, [key]: value });
  return <section className={styles.root} aria-label="AWS News Feeds intelligence dashboard">
    <div className={styles.notice}><strong>Context, not impact evidence.</strong> {report.disclosure}</div>
    <AwsNewsOfficialDefinitionPanel definition={report.officialDefinition} />
    {message ? <div role="status" className={`${styles.state} ${report.sourceState === "failed" ? styles.error : styles.warning}`}>{message}</div> : null}
    <div className={styles.filters} aria-label="AWS News Feeds filters">
      <Select label="AWS service" value={filters.serviceId} options={report.filterOptions.services.map((item) => ({ value: item.id, label: item.label }))} onChange={(value) => set("serviceId", value)} />
      <Select label="Feed type" value={filters.feedKind} options={report.filterOptions.feedKinds.map((value) => ({ value, label: value.replaceAll("_", " ") }))} onChange={(value) => set("feedKind", value as AwsNewsDashboardFilters["feedKind"])} />
      <Select label="Official source" value={filters.sourceId} options={report.filterOptions.sources.map((item) => ({ value: item.id, label: item.label }))} onChange={(value) => set("sourceId", value as AwsNewsDashboardFilters["sourceId"])} />
      <Select label="Category" value={filters.category} options={report.filterOptions.categories.map((value) => ({ value, label: value }))} onChange={(value) => set("category", value)} />
      <Select label="Tenant relevance" value={filters.relevance} options={[{ value: "TENANT_RELEVANT", label: "Matched enabled / observed services" }, { value: "ALL", label: "All official announcements" }]} onChange={(value) => set("relevance", value as AwsNewsDashboardFilters["relevance"])} />
      <label>Search<input value={filters.search ?? ""} maxLength={100} placeholder="Title or summary" onChange={(event) => set("search", event.target.value || null)} /></label>
    </div>
    <div className={styles.cards} aria-label="Official feed family counts">
      {report.familyCounts.map((family) => <article className={styles.card} key={family.kind}><small>{family.kind.replaceAll("_", " ")}</small><strong>{family.count}</strong><span>accepted official items</span></article>)}
    </div>
    <section className={styles.section} aria-label="Scheduled collection runtime"><header><h3>Scheduled collection runtime</h3><span>Every {report.collection.intervalMs / 3_600_000} hours</span></header><div className={styles.sourceGrid}><article className={styles.source}><strong>Scheduler</strong><span>{report.collection.schedulerImplemented ? "Implemented" : "Not implemented"}</span><span>Shared worker {report.collection.sharedWorkerRegistered ? "registered" : "not registered"}</span></article><article className={styles.source}><strong>Replay safety</strong><span>{report.collection.replayContractImplemented ? "Implemented" : "Not implemented"}</span><span>Durable adapter {report.collection.durableReplayAdapterRegistered ? "registered" : "not registered"}</span></article><article className={styles.source}><strong>Outbound collection</strong><span>{report.collection.handlerImplemented ? "Handler implemented" : "Handler not implemented"}</span><span>Gateway {report.collection.outboundGatewayRegistered ? "registered" : "not registered"}</span></article></div><small>{report.collection.reason}</small></section>
    <section className={styles.section} aria-label="Collection provenance and freshness"><header><h3>Source provenance &amp; freshness</h3><span>Observed {report.freshness.observedAt} · {report.freshness.ageHours ?? "unknown"} hours ago</span></header><div className={styles.sourceGrid}>{report.sourceEvidence.map((source) => <article key={source.sourceId} className={styles.source}><strong>{source.label}</strong><span>{source.authority.replaceAll("_", " ")} · {source.kind.replaceAll("_", " ")}</span><span>{source.status} · {source.acceptedItems} items</span><span>Fetched {source.fetchedAt}</span><span>Latest publication {source.lastPublishedAt ?? "None"}</span>{source.failureCode ? <span className={styles.errorText}>{source.failureCode}</span> : null}</article>)}</div></section>
    <section className={styles.section} aria-label="AWS announcements"><header><h3>Official announcements · {report.resultCount}</h3><button type="button" onClick={() => exportCsv(report)}>Export visible rows</button></header><div className={styles.newsGrid}>{report.items.map((item) => <article className={styles.item} key={`${item.sourceId}:${item.externalId}`}><div className={styles.itemMeta}><span>{item.feedKind.replaceAll("_", " ")}</span><time dateTime={item.publishedAt}>{item.publishedAt}</time></div><h4>{item.title}</h4><p>{item.summary || "No plain-text summary supplied by the official feed."}</p><div className={styles.chips}>{item.matchedServices.map((service) => <span key={service.serviceId}>{service.displayName} · {service.usageBasis}</span>)}{item.categories.map((category) => <span key={category}>{category}</span>)}</div><details><summary>Relevance and provenance</summary><p>Source: {item.sourceLabel}. Impact assessment: {item.impactAssessment.replaceAll("_", " ")}.</p>{item.matchedServices.length ? <ul>{item.matchedServices.map((service) => <li key={service.serviceId}>{service.displayName}: {service.reason.kind.replaceAll("_", " ")} “{service.reason.matchedAlias}” · {service.observationBasis ?? "explicitly enabled"}</li>)}</ul> : <p>No exact enabled/observed tenant-service match.</p>}</details><a href={item.canonicalUrl} target="_blank" rel="noopener noreferrer">{item.feedKind === "VIDEO" ? "Watch on the official AWS YouTube channel" : "Open the official AWS publication"}<span className={styles.srOnly}> (opens in a new tab)</span></a></article>)}</div>{report.rowsTruncated ? <p>Only the first 250 sorted items are shown. Refine filters before exporting.</p> : null}</section>
    <section className={styles.section} aria-label="Collection history"><header><h3>Immutable collection history</h3></header><div className={styles.scroll}><table><thead><tr><th>Observed</th><th>State</th><th>Coverage</th><th>Sources</th><th>Items</th><th>Tenant relevant</th></tr></thead><tbody>{report.history.map((point) => <tr key={point.generationId}><td>{point.observedAt}</td><td>{point.state}</td><td>{point.coverage}</td><td>{point.counts.sourcesSucceeded} succeeded / {point.counts.sourcesFailed} failed</td><td>{point.counts.deduplicatedItems}</td><td>{point.counts.tenantRelevantItems}</td></tr>)}</tbody></table></div></section>
    <details className={`${styles.section} ${styles.evidence}`}><summary>Evidence identifiers and limitations</summary><pre>{JSON.stringify({ freshness: report.freshness, evidence: report.evidence, collection: report.collection }, null, 2)}</pre></details>
  </section>;
}

export function FinopsAwsNewsFeedsDashboard({ connectionId }: { readonly connectionId: string | null }) {
  const [filters, setFilters] = useState<AwsNewsDashboardFilters>(EMPTY);
  const [state, setState] = useState<{ report: AwsNewsDashboardEnvelope | null; error: string | null; configuration: AwsNewsFeedsConfigurationEnvelope | null }>({ report: null, error: null, configuration: null });
  useEffect(() => {
    if (connectionId === null) return;
    const controller = new AbortController();
    const parameters = new URLSearchParams({ connectionId });
    for (const [key, value] of Object.entries(filters)) if (value !== null) parameters.set(key, value);
    fetch(`/api/v1/finops/aws-news-feeds?${parameters.toString()}`, { signal: controller.signal, headers: { Accept: "application/json" } })
      .then(async (response) => { if (!response.ok) throw new Error("AWS News Feeds dashboard request failed"); return response.json() as Promise<AwsNewsDashboardEnvelope | AwsNewsFeedsConfigurationEnvelope>; })
      .then((report) => { if ("dashboard" in report && report.dashboard === null) setState({ report: null, error: null, configuration: report }); else setState({ report: report as AwsNewsDashboardEnvelope, error: null, configuration: null }); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setState({ report: null, error: error instanceof Error ? error.message : "AWS News Feeds dashboard request failed", configuration: null }); });
    return () => controller.abort();
  }, [connectionId, filters]);
  if (connectionId === null) return <div role="status" className={`${styles.state} ${styles.warning}`}>Connect an active AWS trust-role account before collecting AWS News Feeds.</div>;
  if (state.configuration !== null) return <section className={styles.root}><div role="status" className={`${styles.state} ${styles.warning}`}>The six-hour scheduler and replay-safe handler are implemented, but the shared worker, durable replay store, and outbound gateway adapters are not registered. No governed AWS News Feeds evidence has been persisted for this connection.</div><AwsNewsOfficialDefinitionPanel definition={state.configuration.officialDefinition} /></section>;
  if (state.error !== null) return <div role="alert" className={`${styles.state} ${styles.error}`}>{state.error}</div>;
  if (state.report === null || state.report.connectionId !== connectionId) return <div role="status" className={styles.state}>Loading official AWS feed evidence…</div>;
  return <AwsNewsFeedsReportView report={state.report} filters={filters} onFiltersChange={setFilters} />;
}
