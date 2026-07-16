"use client";

import { useMemo, useState } from "react";
import { AppShell } from "../components/app-shell";
import { formatTimestamp, postPilot, snapshotOriginLabel, usePilotState } from "../components/use-pilot-state";

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "Sutra could not run inventory collection";
}

export default function Home() {
  const { state, health, loading, refreshing, error, refresh } = usePilotState();
  const [syncing, setSyncing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const connection = state?.connection ?? null;
  const canRunAwsSync = connection?.sourceKind === "aws_trust_role";
  const cmdbHref = connection ? `/cmdb?connectionId=${encodeURIComponent(connection.id)}` : "/onboard";
  const resources = useMemo(() => state?.resources ?? [], [state?.resources]);
  const findings = useMemo(() => state?.findings ?? [], [state?.findings]);
  const openFindings = findings.filter((finding) => finding.status === "open");
  const resourceMap = useMemo(() => new Map(resources.map((resource) => [resource.resourceKey, resource])), [resources]);
  const serviceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const resource of resources) counts.set(resource.service, (counts.get(resource.service) ?? 0) + 1);
    return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 7);
  }, [resources]);
  const maxServiceCount = Math.max(...serviceCounts.map(([, count]) => count), 1);
  const succeededCoverage = state?.coverage.filter((entry) => entry.status === "succeeded").length ?? 0;
  const totalCoverage = state?.coverage.length ?? 0;
  const coveragePercent = totalCoverage ? Math.round((succeededCoverage / totalCoverage) * 100) : 0;
  const priorityFindings = openFindings.filter((finding) => finding.severity === "critical" || finding.severity === "high").slice(0, 5);

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

  return (
    <AppShell active="overview">
      <section className="page-heading">
        <div>
          <p className="eyebrow">MSP operations</p>
          <h1>{connection ? `${connection.customerName} cloud overview` : "Your AWS pilot workspace"}</h1>
          <p className="page-subtitle">Current connection health, inventory coverage, asset context, and explainable security priorities.</p>
        </div>
        <div className="heading-actions">
          {connection && canRunAwsSync ? <button className="button button-secondary" type="button" disabled={syncing || refreshing || connection.status !== "active"} onClick={() => void runSync()}>{syncing ? "Collecting…" : "Sync now"}</button> : null}
          {connection && !canRunAwsSync ? <a className="button button-secondary" href="/operations">Run another simulation</a> : null}
          <a className="button button-primary" href={cmdbHref}>{connection ? "Open CMDB" : "Onboard AWS account"}</a>
        </div>
      </section>

      <div className="trust-strip" role="note">
        <span className="trust-icon">✓</span>
        <span><strong>{state?.activeSnapshot ? `${snapshotOriginLabel(state.activeSnapshot.origin)}.` : health?.mode === "live" ? "AWS collector ready." : health?.mode === "fixture" ? "Fixture collector ready." : "Collector status unavailable."}</strong> Customer infrastructure is never modified, and only a complete collection can replace the active CMDB projection.</span>
        <a href="/controls">See boundaries</a>
      </div>

      {error || actionError ? <div className="page-alert page-alert-error" role="alert"><strong>Workspace needs attention</strong><span>{actionError ?? error}</span><button type="button" onClick={() => void refresh()}>Retry</button></div> : null}
      {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading the pilot workspace…</div> : null}

      {!loading && !connection ? <section className="panel empty-workspace dashboard-empty"><span className="empty-workspace-icon">AWS</span><h2>Start with one customer account</h2><p>Sutra will validate a customer-owned IAM role, collect selected AWS metadata, build the asset graph, and evaluate deterministic posture checks.</p><a className="button button-primary" href="/onboard">Start secure onboarding</a></section> : null}

      {connection ? (
        <>
          <section className="metrics-grid" aria-label="Pilot summary">
            <article className="metric-card metric-card-featured">
              <div className="metric-topline"><span>Connection health</span><span className={`status-pill ${connection.status === "active" ? "status-positive" : "status-medium"}`}>{connection.status.replace("_", " ")}</span></div>
              <strong className="connection-account">{connection.awsAccountId}</strong>
              <p>{connection.enabledRegions.length} enabled regions · {connection.sourceKind === "simulated_fixture" ? `fixture ${connection.fixtureVersion ?? "not published"}` : `validated ${formatTimestamp(connection.lastValidatedAt)}`}</p>
            </article>
            <article className="metric-card">
              <div className="metric-topline"><span>Managed assets</span><span className="metric-glyph">CMDB</span></div>
              <strong className="metric-value">{resources.length.toLocaleString()}</strong>
              <p>From the latest complete snapshot</p>
            </article>
            <article className="metric-card">
              <div className="metric-topline"><span>Open findings</span><span className="metric-glyph metric-glyph-alert">!</span></div>
              <strong className="metric-value">{openFindings.length.toLocaleString()}</strong>
              <p><span className="severity-dot severity-critical" /> {openFindings.filter((finding) => finding.severity === "critical" || finding.severity === "high").length} critical or high</p>
            </article>
            <article className="metric-card">
              <div className="metric-topline"><span>Collector coverage</span><span className="metric-glyph">AWS</span></div>
              <strong className="metric-value">{totalCoverage ? `${coveragePercent}%` : "—"}</strong>
              <p>{succeededCoverage} of {totalCoverage} checks succeeded</p>
            </article>
          </section>

          <section className="dashboard-grid">
            <article className="panel asset-mix-panel">
              <div className="panel-heading"><div><p className="eyebrow">Active snapshot</p><h2>Observed assets by service</h2></div><span className="status-pill status-positive">{state?.activeSnapshot ? formatTimestamp(state.activeSnapshot.collectedAt) : "No snapshot"}</span></div>
              {serviceCounts.length ? <div className="asset-mix-list">{serviceCounts.map(([service, count]) => <div key={service}><span>{service.toUpperCase()}</span><i><b style={{ width: `${Math.max(6, (count / maxServiceCount) * 100)}%` }} /></i><strong>{count}</strong></div>)}</div> : <div className="empty-state"><strong>No inventory published</strong><span>Validate the trust role and run the first complete sync.</span></div>}
            </article>

            <article className="panel signal-panel">
              <div className="panel-heading"><div><p className="eyebrow">Current capabilities</p><h2>What this pilot checks</h2></div></div>
              <div className="signal-list">
                <div><span className="signal-icon signal-green">01</span><p><strong>Configuration posture</strong><small>Exposure, encryption, logging, IAM and native-service coverage</small></p><b>Included</b></div>
                <div><span className="signal-icon signal-blue">02</span><p><strong>Asset relationships</strong><small>Account, region, network, identity and service context</small></p><b>Included</b></div>
                <div><span className="signal-icon signal-amber">03</span><p><strong>Native threat &amp; CVE services</strong><small>Show GuardDuty and Security Hub enablement only; native finding import is planned</small></p><b className="muted-status">Coverage only</b></div>
              </div>
              <p className="panel-footnote">Sutra’s deterministic recommendations are not runtime behavior analytics or package vulnerability scanning.</p>
            </article>
          </section>

          <section className="panel table-panel">
            <div className="panel-heading"><div><p className="eyebrow">Priority queue</p><h2>Critical and high findings</h2></div><a className="text-link" href="/findings">View all findings →</a></div>
            <div className="data-table" role="table" aria-label="Priority findings">
              <div className="data-row data-header" role="row"><span>Severity</span><span>Finding</span><span>Resource</span><span>Status</span><span aria-label="Actions" /></div>
              {priorityFindings.map((finding) => {
                const resource = finding.resourceKey ? resourceMap.get(finding.resourceKey) : null;
                return <div className="data-row" role="row" key={finding.fingerprint}>
                  <span><span className={`severity-badge severity-${finding.severity}`}>{finding.severity}</span></span>
                  <span className="primary-cell"><strong>{finding.title}</strong><small>{finding.controlKey}</small></span>
                  <span className="primary-cell"><strong>{resource?.name ?? resource?.nativeId ?? "Account level"}</strong><small>{resource?.region ?? connection.awsAccountId}</small></span>
                  <span className="muted-cell">{finding.status}</span>
                  <span><a className="row-action" href="/findings" aria-label={`Open ${finding.title}`}>→</a></span>
                </div>;
              })}
              {priorityFindings.length === 0 ? <div className="empty-state"><strong>No open critical or high findings</strong><span>This reflects the active snapshot and configured control coverage only.</span></div> : null}
            </div>
          </section>

          <section className="dashboard-bottom-grid">
            <article className="panel customer-live-card">
              <div className="panel-heading"><div><p className="eyebrow">Managed customer</p><h2>{connection.customerName}</h2></div><span className="customer-avatar large">{connection.customerName.slice(0, 2).toUpperCase()}</span></div>
              <dl><div><dt>AWS account</dt><dd>{connection.awsAccountId}</dd></div><div><dt>Regions</dt><dd>{connection.enabledRegions.join(", ")}</dd></div><div><dt>Last successful sync</dt><dd>{formatTimestamp(connection.lastSuccessfulSyncAt)}</dd></div><div><dt>Permission pack</dt><dd>{connection.permissionPackVersion}</dd></div></dl>
              <a className="text-link" href="/customers">Open customer workspace →</a>
            </article>
            <article className="panel sync-history-card">
              <div className="panel-heading"><div><p className="eyebrow">Collection history</p><h2>Recent runs</h2></div></div>
              <div className="sync-run-list">{(state?.syncRuns ?? []).slice(0, 5).map((run) => <div key={run.id}><span className={`coverage-state coverage-${run.status === "succeeded" ? "succeeded" : run.status === "partial" ? "partial" : "failed"}`} /><p><strong>{run.status}</strong><small>{formatTimestamp(run.finishedAt ?? run.createdAt)}</small></p><b>{run.coverageState}</b></div>)}{(state?.syncRuns.length ?? 0) === 0 ? <div className="empty-state"><strong>No sync runs yet</strong><span>Run the first inventory collection from onboarding.</span></div> : null}</div>
            </article>
          </section>
        </>
      ) : null}
    </AppShell>
  );
}
