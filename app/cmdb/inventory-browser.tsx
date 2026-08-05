"use client";

import { useMemo, useState } from "react";
import type { PilotFinding, PilotResource } from "../../lib/pilot-types";
import { compactIdentifier, formatTimestamp, postPilot, snapshotOriginLabel, usePilotState } from "../components/use-pilot-state";
import { downloadManagedEvidenceExport, type ManagedEvidenceExportFormat } from "../components/managed-evidence-export";
import { CmdbWorkspacePanels } from "./workspace-panels";

const MAX_ROWS = 200;

function isSecurityGroup(resource: PilotResource): boolean {
  const type = resource.resourceType.toLowerCase();
  return resource.nativeId.startsWith("sg-") || type.includes("securitygroup") || type.includes("security-group");
}

function resourceLabel(resource: PilotResource): string {
  return resource.name?.trim() || resource.tags.Name || resource.nativeId;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "Sutra could not run inventory collection";
}

export function InventoryBrowser() {
  const { state, health, loading, refreshing, error, refresh } = usePilotState();
  const [query, setQuery] = useState("");
  const [service, setService] = useState("all");
  const [region, setRegion] = useState("all");
  const [syncing, setSyncing] = useState(false);
  const [exporting, setExporting] = useState<ManagedEvidenceExportFormat | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const resources = useMemo(() => state?.resources ?? [], [state?.resources]);
  const relationships = useMemo(() => state?.relationships ?? [], [state?.relationships]);
  const findings = useMemo(() => state?.findings ?? [], [state?.findings]);
  const connection = state?.connection ?? null;
  const canRunAwsSync = connection?.sourceKind === "aws_trust_role";
  const services = useMemo(() => [...new Set(resources.map((resource) => resource.service))].sort(), [resources]);
  const regions = useMemo(() => [...new Set(resources.map((resource) => resource.region))].sort(), [resources]);
  const filtered = useMemo(() => resources.filter((resource) => {
    const haystack = `${resourceLabel(resource)} ${resource.nativeId} ${resource.arn ?? ""} ${resource.resourceType} ${resource.region} ${resource.service} ${Object.entries(resource.tags).flat().join(" ")}`.toLowerCase();
    return (service === "all" || resource.service === service) && (region === "all" || resource.region === region) && haystack.includes(query.toLowerCase());
  }), [query, region, resources, service]);
  const securityGroups = useMemo(() => resources.filter(isSecurityGroup), [resources]);
  const edgeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of relationships) {
      counts.set(edge.fromResourceKey, (counts.get(edge.fromResourceKey) ?? 0) + 1);
      counts.set(edge.toResourceKey, (counts.get(edge.toResourceKey) ?? 0) + 1);
    }
    return counts;
  }, [relationships]);
  const openFindingsByResourceKey = useMemo(() => {
    const map = new Map<string, PilotFinding[]>();
    for (const finding of findings) {
      if (finding.status !== "open" || finding.resourceKey === null) continue;
      const list = map.get(finding.resourceKey);
      if (list) list.push(finding);
      else map.set(finding.resourceKey, [finding]);
    }
    return map;
  }, [findings]);
  const successfulCoverage = state?.coverage.filter((entry) => entry.status === "succeeded").length ?? 0;
  const coverageTotal = state?.coverage.length ?? 0;
  const coveragePercent = coverageTotal === 0 ? 0 : Math.round((successfulCoverage / coverageTotal) * 100);
  const latestRunCoverage = state?.latestRunCoverage ?? null;
  const latestRun = latestRunCoverage === null
    ? null
    : state?.syncRuns.find((run) => run.id === latestRunCoverage.syncRunId) ?? null;

  async function runSync() {
    if (!connection) return;
    setSyncing(true);
    setActionError(null);
    try {
      await postPilot("/api/pilot/connections/sync", { connectionId: connection.id });
      await refresh();
    } catch (caught) {
      setActionError(errorMessage(caught));
      await refresh();
    } finally {
      setSyncing(false);
    }
  }

  async function exportInventory(format: ManagedEvidenceExportFormat) {
    if (!connection) return;
    setExporting(format);
    setActionError(null);
    try {
      await downloadManagedEvidenceExport(connection.id, format);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "The managed export failed");
    } finally {
      setExporting(null);
    }
  }

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Configuration management database</p><h1>AWS resource inventory</h1><p className="page-subtitle">Search the latest complete snapshot, trace relationships, and verify per-collector coverage.</p></div>
        <div className="heading-actions"><button className="button button-secondary" type="button" disabled={!connection || exporting !== null} onClick={() => void exportInventory("csv")}>{exporting === "csv" ? "Preparing…" : "Export CSV"}</button><button className="button button-secondary" type="button" disabled={!connection || exporting !== null} onClick={() => void exportInventory("json")}>{exporting === "json" ? "Preparing…" : "Export JSON"}</button>{connection && canRunAwsSync ? <button className="button button-primary" type="button" disabled={syncing || refreshing || connection.status !== "active"} onClick={() => void runSync()}>{syncing ? "Collecting…" : "Sync inventory"}</button> : !connection ? <a className="button button-primary" href="/onboard">Connect account</a> : null}</div>
      </section>
      <div className="trust-strip" role="note"><span className="trust-icon">i</span><span><strong>{state?.activeSnapshot ? `${snapshotOriginLabel(state.activeSnapshot.origin)}.` : health?.mode === "live" ? "AWS collector ready; no snapshot selected." : health?.mode === "fixture" ? "Fixture collector ready; no snapshot selected." : "Stored snapshot view."}</strong> Sutra inventories and assesses metadata only; it does not change customer resources or replace runtime threat and vulnerability engines.</span><a href="/controls">Review coverage</a></div>

      {error || actionError ? <div className="page-alert page-alert-error" role="alert"><strong>Inventory is unavailable</strong><span>{actionError ?? error}</span><button type="button" onClick={() => void refresh()}>Retry</button></div> : null}
      {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading the current CMDB projection…</div> : null}

      {!loading && !connection ? <section className="panel empty-workspace"><span className="empty-workspace-icon">AWS</span><h2>Connect an AWS account to build the CMDB</h2><p>The onboarding flow creates a scoped trust contract, validates it, and publishes inventory only after a complete collection.</p><a className="button button-primary" href="/onboard">Start secure onboarding</a></section> : null}

      {connection ? (
        <>
          <section className="inventory-stats">
            <article><small>Normalized resources</small><strong>{resources.length.toLocaleString()}</strong><span>Snapshot {formatTimestamp(state?.activeSnapshot?.collectedAt)}</span></article>
            <article><small>Relationships</small><strong>{relationships.length.toLocaleString()}</strong><span>Explicit edges in the active asset graph</span></article>
            <article><small>Resource types</small><strong>{new Set(resources.map((item) => item.resourceType)).size}</strong><span>{services.length} observed AWS services</span></article>
            <article><small>Collector coverage</small><strong>{coverageTotal > 0 ? `${coveragePercent}%` : "—"}</strong><span>{successfulCoverage} of {coverageTotal} collector-region checks succeeded</span></article>
          </section>

          {latestRunCoverage ? <section className="panel coverage-panel">
            <div className="panel-heading"><div><p className="eyebrow">Latest collection attempt</p><h2>Run-scoped collector coverage</h2></div><span className={`status-pill ${latestRun?.status === "succeeded" ? "status-positive" : "status-medium"}`}>{latestRun?.status ?? "unknown"} run</span></div>
            <p className="panel-footnote">This evidence belongs only to run <code>{compactIdentifier(latestRunCoverage.syncRunId, 24)}</code>. {state?.activeSnapshot ? "A partial or failed attempt does not replace the active complete CMDB projection shown below." : "No complete CMDB projection is active; this run evidence is not presented as authoritative inventory."}</p>
            {latestRunCoverage.entries.length > 0 ? <div className="coverage-grid">{latestRunCoverage.entries.map((entry) => <article key={`${latestRunCoverage.syncRunId}:${entry.collectorKey}:${entry.region}`} title={entry.message}><span className={`coverage-state coverage-${entry.status}`} /> <div><strong>{entry.collectorKey}</strong><small>{entry.region}{entry.message ? ` · ${entry.message}` : ` · ${entry.pagesObserved} page${entry.pagesObserved === 1 ? "" : "s"}`}</small></div><b>{entry.status}</b><span>{entry.errorCode ?? `${entry.itemsObserved} items`}</span></article>)}</div> : <div className="empty-state"><strong>No collector-region detail was recorded for this run</strong><span>The latest attempt has no coverage rows; Sutra does not reuse details from an earlier complete snapshot.</span></div>}
          </section> : null}

          {!state?.activeSnapshot ? <section className="panel empty-workspace compact-empty"><h2>No complete snapshot has been published</h2><p>{connection.sourceKind === "simulated_fixture" ? "Complete and publish a durable simulated collection to create this CMDB projection." : connection.status === "active" ? "Run inventory to collect the first authoritative CMDB projection." : "Return to onboarding and validate the customer trust role before collecting inventory."}</p><a className="button button-primary" href={connection.sourceKind === "simulated_fixture" ? "/operations" : "/onboard"}>{connection.sourceKind === "simulated_fixture" ? "Open simulations" : "Open onboarding"}</a></section> : null}

          {state?.activeSnapshot ? <section className="panel inventory-panel">
            <div className="panel-heading"><div><p className="eyebrow">Active projection</p><h2>Resources</h2></div><span className="result-count">{filtered.length} of {resources.length} resources</span></div>
            <div className="filter-bar inventory-filter-bar">
              <label className="search-field"><span className="sr-only">Search resources</span><input className="filter-control" placeholder="Search name, ARN, tag, type or region" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
              <label><span className="sr-only">Filter by service</span><select className="filter-control" value={service} onChange={(event) => setService(event.target.value)}><option value="all">All services</option>{services.map((item) => <option key={item} value={item}>{item.toUpperCase()}</option>)}</select></label>
              <label><span className="sr-only">Filter by region</span><select className="filter-control" value={region} onChange={(event) => setRegion(event.target.value)}><option value="all">All regions</option>{regions.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
              {(query || service !== "all" || region !== "all") ? <button className="button button-secondary button-small" onClick={() => { setQuery(""); setService("all"); setRegion("all"); }} type="button">Clear</button> : null}
            </div>
            <div className="data-table cmdb-table" role="table" aria-label="AWS resources">
              <div className="data-row data-header" role="row"><span>Service</span><span>Resource</span><span>Customer / account</span><span>Region</span><span>State</span><span>Graph</span></div>
              {filtered.slice(0, MAX_ROWS).map((resource) => {
                const edgeCount = edgeCounts.get(resource.resourceKey) ?? 0;
                return <div className="data-row" role="row" key={resource.resourceKey}>
                  <span><span className="service-chip">{resource.service.toUpperCase()}</span></span>
                  <span className="primary-cell"><a className="resource-link" href={`/cmdb/resource?key=${encodeURIComponent(resource.resourceKey)}`} title={`Open Resource 360 for ${resourceLabel(resource)}`}><strong>{resourceLabel(resource)}</strong><small title={resource.arn ?? resource.nativeId}>{resource.resourceType} · {compactIdentifier(resource.nativeId, 18)}</small></a></span>
                  <span className="primary-cell"><strong>{connection.customerName}</strong><small>{connection.awsAccountId}</small></span>
                  <span><code className="region-code">{resource.region}</code></span>
                  <span><span className="resource-state">{resource.lifecycleState === "retirement_pending" ? `retirement pending · ${resource.consecutiveCompleteMisses ?? 1} complete miss` : resource.state || "observed"}</span></span>
                  <span className="muted-cell">{edgeCount} edge{edgeCount === 1 ? "" : "s"}</span>
                </div>;
              })}
              {filtered.length > MAX_ROWS ? <div className="empty-state"><strong>Showing first {MAX_ROWS} of {filtered.length}</strong><span>Refine the filter to see more.</span></div> : null}
              {filtered.length === 0 ? <div className="empty-state"><strong>No matching resources</strong><span>Adjust or clear the current filters.</span></div> : null}
            </div>
          </section> : null}

          {state?.activeSnapshot ? <section className="panel security-group-panel">
            <div className="panel-heading"><div><p className="eyebrow">Network exposure context</p><h2>Security groups</h2></div><a className="text-link" href="/findings">Open related findings →</a></div>
            {securityGroups.length > 0 ? <div className="security-group-grid">
              {securityGroups.map((group) => {
                const groupFindings = openFindingsByResourceKey.get(group.resourceKey) ?? [];
                const groupEdgeCount = edgeCounts.get(group.resourceKey) ?? 0;
                return <article className="security-group-card" key={group.resourceKey}>
                  <div><span className="service-chip">EC2</span><span className={groupFindings.some((finding) => finding.severity === "critical" || finding.severity === "high") ? "exposure exposure-open" : "exposure exposure-closed"}>{groupFindings.length ? `${groupFindings.length} open finding${groupFindings.length === 1 ? "" : "s"}` : "No open finding"}</span></div>
                  <h3>{resourceLabel(group)}</h3><p>{group.nativeId} · {group.region}</p>
                  <dl><div><dt>Relationships</dt><dd>{groupEdgeCount}</dd></div><div><dt>Findings</dt><dd>{groupFindings.length}</dd></div><div><dt>Observed via</dt><dd>{group.source.api}</dd></div></dl>
                  <small>{connection.customerName} · {connection.awsAccountId}</small>
                </article>;
              })}
            </div> : <div className="empty-state"><strong>No security groups in this snapshot</strong><span>Check EC2 collector coverage before treating this as proof that none exist.</span></div>}
          </section> : null}

          {state?.activeSnapshot ? <section className="panel coverage-panel">
            <div className="panel-heading"><div><p className="eyebrow">Active snapshot evidence</p><h2>Published coverage by collector and region</h2></div><span className={`status-pill ${state.activeSnapshot.coverageState === "complete" ? "status-positive" : "status-medium"}`}>{state.activeSnapshot.coverageState} snapshot</span></div>
            <div className="coverage-grid">{state.coverage.map((entry) => <article key={`${entry.collectorKey}:${entry.region}`}><span className={`coverage-state coverage-${entry.status}`} /> <div><strong>{entry.collectorKey}</strong><small>{entry.region}</small></div><b>{entry.status}</b><span>{entry.itemsObserved} items</span></article>)}</div>
          </section> : null}
        </>
      ) : null}
      <CmdbWorkspacePanels connectionId={connection?.id ?? null} />
    </>
  );
}
