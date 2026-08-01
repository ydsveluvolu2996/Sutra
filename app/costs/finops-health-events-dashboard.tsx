"use client";

import { useEffect, useState } from "react";
import type { AwsHealthDashboardFilters } from
  "../../lib/finops-aws-health-dashboard";
import type { FinopsAwsHealthOfficialDefinition } from
  "../../lib/finops-aws-health-official-definition";
import styles from "./finops-health-events-dashboard.module.css";

type Report = ReturnType<typeof import(
  "../../lib/finops-aws-health-dashboard"
).buildAwsHealthPlanningDashboard> & {
  readonly connectionId: string;
  readonly sourceState: string;
  readonly availability: {
    readonly configurationState: string;
    readonly collectionState: string;
    readonly supportPlan: string;
    readonly eligibleSupport: boolean;
    readonly organizationsAllFeaturesEnabled: boolean;
    readonly organizationViewStatus: string;
    readonly collectorAccountType: string;
    readonly delegatedAdministratorRegistered: boolean;
    readonly initialLoadState: string;
    readonly observedAt: string;
  } | null;
  readonly officialDefinition: FinopsAwsHealthOfficialDefinition;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly collection: { readonly available: false; readonly reason: string };
};

const EMPTY: AwsHealthDashboardFilters = {
  status: null,
  category: null,
  service: null,
  accountId: null,
  region: null,
  actionability: null,
  search: null,
};

function Select({ label, value, options, onChange }: {
  readonly label: string;
  readonly value: string | null;
  readonly options: readonly string[];
  readonly onChange: (value: string | null) => void;
}) {
  return (
    <label>{label}<select value={value ?? ""} onChange={(event) => onChange(event.target.value || null)}><option value="">All</option>{options.map((option) => <option key={option}>{option.replaceAll("_", " ")}</option>)}</select></label>
  );
}

function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

function exportCsv(report: Report): void {
  const rows = report.events.flatMap(({ event }) =>
    event.affectedEntities.length > 0
      ? event.affectedEntities.map((entity) => [
          event.status, event.category, event.service ?? "", event.region ?? "",
          event.eventTypeCode, event.startAt ?? "", event.endAt ?? "",
          event.actionability ?? "", entity.accountId ?? "",
          entity.entityValue ?? "", entity.status ?? "",
          event.details.find((detail) => detail.accountId === entity.accountId)?.description ?? "",
        ].map((value) => csvCell(value)).join(","))
      : [[
          event.status, event.category, event.service ?? "", event.region ?? "",
          event.eventTypeCode, event.startAt ?? "", event.endAt ?? "",
          event.actionability ?? "", "", "", "", event.details[0]?.description ?? "",
        ].map((value) => csvCell(value)).join(",")]);
  const header = "status,category,service,region,event_type,start,end,actionability,account,affected_entity,entity_status,description";
  const url = URL.createObjectURL(new Blob(
    [[header, ...rows].join("\n")],
    { type: "text/csv;charset=utf-8" },
  ));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "sutra-health-events-planning.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

function OfficialDefinition({ definition }: {
  readonly definition: FinopsAwsHealthOfficialDefinition;
}) {
  return (
    <section className={styles.official} aria-label="Official AWS Health Events dashboard definition">
      <header>
        <div><small>Immutable AWS definition · {definition.source.version}</small><h3>Official sheet and control inventory</h3></div>
        <span>{definition.totals.sheets} sheets · {definition.totals.visuals} visuals · {definition.totals.parameterControls + definition.totals.filterControls} controls</span>
      </header>
      <div className={styles.sheetGrid}>
        {definition.sheets.map((sheet) => (
          <article key={sheet.id}>
            <header><strong>{sheet.name}</strong><span>{sheet.visualCount} visuals</span></header>
            <dl><div><dt>Parameters</dt><dd>{sheet.parameterControls.length}</dd></div><div><dt>Filters</dt><dd>{sheet.filterControls.length}</dd></div><div><dt>Native parity</dt><dd>{sheet.nativeCoverage.toLowerCase()}</dd></div></dl>
            {[...sheet.parameterControls, ...sheet.filterControls].length === 0 ? <p>No interactive controls.</p> : <details><summary>Every official control</summary><p>{[...sheet.parameterControls, ...sheet.filterControls].join(" · ")}</p></details>}
            {sheet.gaps.map((gap) => <small key={gap}>{gap}</small>)}
          </article>
        ))}
      </div>
      <p className={styles.officialWarning}>Daily planning data can lag by 48 hours or more. This is not a real-time monitoring surface; use AWS Health Notifications and incident tooling for current response.</p>
    </section>
  );
}

export function HealthEventsReportView({ report, filters, onFiltersChange }: {
  readonly report: Report;
  readonly filters: AwsHealthDashboardFilters;
  readonly onFiltersChange: (filters: AwsHealthDashboardFilters) => void;
}) {
  const set = <K extends keyof AwsHealthDashboardFilters>(key: K, value: AwsHealthDashboardFilters[K]) => onFiltersChange({ ...filters, [key]: value });
  return (
    <section className={styles.root} aria-label="AWS Health Events planning dashboard">
      <div role="status" className={styles.lag}><strong>Planning view — not real time.</strong> AWS Health organization data can lag by 48 hours or more. Use AWS Health and your incident tooling for current response.</div>
      <div className={styles.privacy}><strong>Tenant-private evidence.</strong> Event descriptions, account IDs, affected entities and metadata are visible only to authenticated users authorized for this connection.</div>
      <OfficialDefinition definition={report.officialDefinition} />
      <section className={styles.prereq}>
        <article><span>Eligible support / API entitlement</span><strong>{report.availability?.eligibleSupport ? "Validated" : "Not validated"}</strong><small>{report.availability?.supportPlan ?? "Unknown plan"}</small></article>
        <article><span>AWS Organizations access</span><strong>{report.availability?.organizationsAllFeaturesEnabled ? "All features enabled" : "Not proven"}</strong><small>{report.availability?.collectorAccountType ?? "Unknown collector"}</small></article>
        <article><span>Organizational View provider state</span><strong>{report.availability?.organizationViewStatus ?? "UNKNOWN"}</strong><small>{report.availability?.initialLoadState ?? "UNKNOWN"} initial load</small></article>
      </section>
      <div className={styles.filters} aria-label="AWS Health planning filters">
        <Select label="Past / current / upcoming" value={filters.status} options={report.filterOptions.statuses} onChange={(value) => set("status", value as AwsHealthDashboardFilters["status"])} />
        <Select label="Category" value={filters.category} options={report.filterOptions.categories} onChange={(value) => set("category", value as AwsHealthDashboardFilters["category"])} />
        <Select label="Service" value={filters.service} options={report.filterOptions.services} onChange={(value) => set("service", value)} />
        <Select label="Affected account" value={filters.accountId} options={report.filterOptions.accounts} onChange={(value) => set("accountId", value)} />
        <Select label="Region" value={filters.region} options={report.filterOptions.regions} onChange={(value) => set("region", value)} />
        <Select label="Actionability" value={filters.actionability} options={report.filterOptions.actionabilities} onChange={(value) => set("actionability", value as AwsHealthDashboardFilters["actionability"])} />
        <label>Search<input value={filters.search ?? ""} maxLength={128} onChange={(event) => set("search", event.target.value || null)} /></label>
      </div>
      <section className={styles.section}>
        <header><h3>Organization Health planning summary</h3><button onClick={() => exportCsv(report)} type="button">Export visible evidence</button></header>
        <div className={styles.cards}>
          <article><span>Past / closed</span><strong>{report.summary.pastCount}</strong></article><article><span>Current / open</span><strong>{report.summary.currentCount}</strong></article><article><span>Upcoming</span><strong>{report.summary.upcomingCount}</strong></article><article><span>Action required</span><strong>{report.summary.actionRequiredCount}</strong></article><article><span>Affected accounts</span><strong>{report.summary.affectedAccountCount}</strong></article><article><span>Affected entities</span><strong>{report.summary.affectedEntityCount}</strong></article>
        </div>
      </section>
      <section className={styles.section}>
        <header><h3>Upcoming impact timeline</h3><span>{report.upcomingTimelineTruncated ? "First 500 dated events" : "Complete selected dated view"}</span></header>
        {report.upcomingTimeline.length === 0 ? <p>No open or upcoming event with an explicit provider start date is available.</p> : <div className={styles.scroll} tabIndex={0} role="region" aria-label="Scrollable upcoming impact timeline"><table><caption>Upcoming AWS Health impact timeline</caption><thead><tr><th>Start</th><th>Event</th><th>Service / Region</th><th>Status</th><th>Affected</th></tr></thead><tbody>{report.upcomingTimeline.map((item) => <tr key={item.arn}><td>{item.startAt}</td><th>{item.eventTypeCode}</th><td>{item.service ?? "Unknown service"} · {item.region ?? "Global"}</td><td>{item.status}</td><td>{item.affectedAccountCount} accounts · {item.affectedEntityCount} resources</td></tr>)}</tbody></table></div>}
      </section>
      <section className={styles.section}>
        <header><h3>Deprecating versions</h3><span>Explicit metadata only</span></header>
        {report.deprecatingVersions.status === "unavailable" ? <p role="status">Deprecation tracking is unavailable because explicit deprecated_versions event-detail metadata was not returned. Sutra does not infer versions from descriptions.</p> : <div className={styles.scroll}><table><caption>Explicit AWS Health deprecation metadata</caption><thead><tr><th>Start</th><th>Service</th><th>Deprecated versions</th><th>Event</th></tr></thead><tbody>{report.deprecatingVersions.items.map((item) => <tr key={`${item.arn}:${item.deprecatedVersions}`}><td>{item.startAt ?? "No start supplied"}</td><td>{item.service ?? "Unknown service"}</td><td>{item.deprecatedVersions}</td><td>{item.eventTypeCode}</td></tr>)}</tbody></table></div>}
      </section>
      <section className={styles.section}>
        <header><h3>Events, affected entities &amp; details</h3><span>{report.eventsTruncated ? "First 500 rows" : "Complete selected view"}</span></header>
        <div className={styles.events}>{report.events.map(({ event, generationId, observedAt }) => <details key={event.arn}><summary><span className={`${styles.badge} ${styles[event.status]}`}>{event.status}</span><strong>{event.eventTypeCode}</strong><span>{event.service ?? "Unknown service"} · {event.region ?? "Global"}</span><time>{event.startAt ?? "No start supplied"}</time></summary><div className={styles.eventBody}><p><strong>{event.actionability ?? "Actionability unavailable"}</strong> · {event.category} · {event.scope}</p><p>{event.details.map((detail) => detail.description).filter(Boolean).join(" ") || "No accepted event description."}</p><h4>Affected accounts and entities</h4>{event.affectedEntities.length > 0 ? <div className={styles.scroll}><table><caption>Affected AWS accounts and resources</caption><thead><tr><th>Account</th><th>Entity</th><th>Status</th><th>Last updated</th><th>Metadata</th></tr></thead><tbody>{event.affectedEntities.map((entity, index) => <tr key={`${entity.accountId}:${entity.entityArn}:${entity.entityValue}:${index}`}><td>{entity.accountId ?? "Public event"}</td><td>{entity.entityValue ?? entity.entityArn ?? "Not supplied"}</td><td>{entity.status ?? "Unknown"}</td><td>{entity.lastUpdatedAt ?? "Unknown"}</td><td>{entity.metadata.map((item) => `${item.key}=${item.value}`).join(" · ")}</td></tr>)}</tbody></table></div> : <p>No affected entity was returned for this event.</p>}<small>Accepted {observedAt} · generation {generationId} · provider failures {event.evidence.providerFailures.join(", ") || "none"}</small></div></details>)}</div>
      </section>
      <section className={styles.section}><header><h3>Immutable event history</h3><span>{report.summary.historyGenerationCount} accepted snapshots</span></header>{report.eventHistory.map((item) => <article className={styles.timeline} key={item.arn}><strong>{item.eventTypeCode}</strong><div>{item.points.map((point) => <span key={`${point.observedAt}:${point.status}`}>{point.observedAt.slice(0, 10)} · {point.status}</span>)}</div></article>)}</section>
      <details className={`${styles.section} ${styles.evidence}`}><summary>Capture hashes, coverage and limitations</summary><pre>{JSON.stringify({ officialDefinition: report.officialDefinition, planningSemantics: report.planningSemantics, freshness: report.freshness, lineage: report.lineage, evidence: report.evidence, collection: report.collection, limitations: report.limitations }, null, 2)}</pre></details>
    </section>
  );
}

export function FinopsHealthEventsDashboard({ connectionId }: { readonly connectionId: string | null }) {
  const [filters, setFilters] = useState(EMPTY);
  const [state, setState] = useState<{ readonly report: Report | null; readonly error: string | null; readonly availability: Report["availability"] }>({ report: null, error: null, availability: null });
  useEffect(() => {
    if (connectionId === null) return;
    const controller = new AbortController();
    const parameters = new URLSearchParams({ connectionId });
    for (const [key, value] of Object.entries(filters)) if (value !== null) parameters.set(key, value);
    fetch(`/api/v1/finops/health-events?${parameters.toString()}`, { cache: "no-store", credentials: "same-origin", signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error("Health Events request failed"); return response.json(); })
      .then((value) => value.dashboard === null ? setState({ report: null, error: null, availability: value.availability }) : setState({ report: value as Report, error: null, availability: value.availability }))
      .catch((error: unknown) => { if (!controller.signal.aborted) setState({ report: null, error: error instanceof Error ? error.message : "Request failed", availability: null }); });
    return () => controller.abort();
  }, [connectionId, filters]);
  if (connectionId === null) return <div role="status" className={styles.warning}>Connect an active AWS trust-role account.</div>;
  if (state.error !== null) return <div role="alert" className={styles.error}>{state.error}</div>;
  if (state.report === null) {
    const reason = state.availability?.eligibleSupport === false ? "Eligible AWS support/API entitlement is not validated." : state.availability?.organizationViewStatus === "DISABLED" ? "AWS Health Organizational View is disabled." : state.availability?.organizationsAllFeaturesEnabled === false ? "AWS Organizations all-features access is not enabled." : "No complete organization Health snapshot has been accepted.";
    return <div role="status" className={styles.warning}><strong>Planning view unavailable.</strong> {reason} Data can lag by 48 hours or more and discovery is not real-time.</div>;
  }
  return <HealthEventsReportView report={state.report} filters={filters} onFiltersChange={setFilters} />;
}
