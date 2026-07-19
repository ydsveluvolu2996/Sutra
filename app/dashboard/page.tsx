"use client";

import { useId, useMemo, useState } from "react";
import { isAllEnabledAwsRegionSelection } from "../../lib/aws-region-selection.ts";
import { AppShell } from "../components/app-shell";
import { formatTimestamp, postPilot, snapshotOriginLabel, usePilotState } from "../components/use-pilot-state";

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "Sutra could not run inventory collection";
}

const SEVERITY_KEYS = ["critical", "high", "medium", "low"] as const;
const SLA_TARGET_DAYS: Readonly<Record<(typeof SEVERITY_KEYS)[number], number>> = {
  critical: 3, high: 30, medium: 90, low: 180,
};

function scoreBand(value: number): "good" | "warn" | "risk" {
  return value >= 80 ? "good" : value >= 55 ? "warn" : "risk";
}

// Semicircular gauge drawn with a single arc whose dash length encodes the
// fraction, so the value reads at a glance without any charting dependency.
// Healthy scores stroke with the signature aurora gradient (cyan→blue→violet);
// warn/risk bands fall back to their solid semantic colors from the stylesheet.
function ScoreGauge({ value, caption }: { readonly value: number; readonly caption: string }) {
  const gradientId = useId();
  const clamped = Math.max(0, Math.min(100, value));
  const radius = 52;
  const length = Math.PI * radius;
  const band = scoreBand(clamped);
  return (
    <div className={`score-gauge score-gauge-${band}`}>
      <svg viewBox="0 0 128 74" role="img" aria-label={`${caption}: ${clamped} out of 100`}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#22d3ee" />
            <stop offset="52%" stopColor="#3b82f6" />
            <stop offset="100%" stopColor="#8b5cf6" />
          </linearGradient>
        </defs>
        <path className="score-gauge-track" d="M 12 66 A 52 52 0 0 1 116 66" fill="none" strokeWidth="10" strokeLinecap="round" />
        <path className="score-gauge-value" d="M 12 66 A 52 52 0 0 1 116 66" fill="none" strokeWidth="10" strokeLinecap="round"
          style={band === "good" ? { stroke: `url(#${gradientId})` } : undefined}
          strokeDasharray={`${(clamped / 100) * length} ${length}`} />
        <text x="64" y="58" textAnchor="middle" className="score-gauge-number">{clamped}</text>
      </svg>
      <span className="score-gauge-caption">{caption}</span>
    </div>
  );
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
  const coveredRegions = useMemo(() => [...new Set(
    (state?.coverage ?? [])
      .map((entry) => entry.region)
      .filter((region) => region !== "global"),
  )].sort(), [state?.coverage]);
  const allEnabledRegionScope = connection
    ? isAllEnabledAwsRegionSelection(connection.enabledRegions)
    : false;
  const coveragePercent = totalCoverage ? Math.round((succeededCoverage / totalCoverage) * 100) : 0;
  const priorityFindings = openFindings.filter((finding) => finding.severity === "critical" || finding.severity === "high").slice(0, 5);
  const openBySeverity = {
    critical: openFindings.filter((finding) => finding.severity === "critical").length,
    high: openFindings.filter((finding) => finding.severity === "high").length,
    medium: openFindings.filter((finding) => finding.severity === "medium").length,
    low: openFindings.filter((finding) => finding.severity === "low").length,
  };
  const maxSeverityCount = Math.max(1, openBySeverity.critical, openBySeverity.high, openBySeverity.medium, openBySeverity.low);
  // Deterministic security score: 100 minus a bounded penalty from the open
  // finding severity mix. Purely from current evidence; trend over time arrives
  // with the posture-history work.
  const securityScore = Math.max(
    2,
    Math.round(100 - Math.min(98, openBySeverity.critical * 14 + openBySeverity.high * 6 + openBySeverity.medium * 2 + openBySeverity.low * 0.5)),
  );
  const resolvedCount = findings.filter((finding) => finding.status === "resolved" || finding.status === "suppressed").length;

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
      <section className="page-heading dashboard-hero">
        <div>
          <p className="eyebrow">MSP operations</p>
          <h1>{connection ? `${connection.customerName} cloud overview` : "Your AWS pilot workspace"}</h1>
          <p className="page-subtitle">AWS trust health, collection outcomes, active inventory coverage, asset context, and explainable security priorities.</p>
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

      {!loading && !connection ? (
        <section className="panel dbe" aria-label="Connect your first customer account">
          <div className="dbe-copy">
            <span className="dbe-kicker">Get started</span>
            <h2>Connect your first customer account</h2>
            <p>Sutra validates a customer-owned IAM role, collects selected AWS metadata with temporary STS credentials, builds the asset graph, and evaluates deterministic posture checks — read-only from the first minute.</p>
            <ol className="dbe-steps">
              <li><span>01</span><div><strong>Create the customer workspace</strong><em>Name the customer and choose a collector pack</em></div></li>
              <li><span>02</span><div><strong>Deploy the CloudFormation role</strong><em>Customer-owned, read-only, unique ExternalId</em></div></li>
              <li><span>03</span><div><strong>Run the first collection</strong><em>Assets, relationships and findings appear right here</em></div></li>
            </ol>
            <div className="dbe-actions">
              <a className="button button-primary" href="/onboard">Start secure onboarding</a>
              <a className="button button-secondary" href="/controls#architecture">Review the trust model</a>
            </div>
          </div>
          <div className="dbe-preview" aria-hidden="true">
            <div className="dbe-preview-bar"><i /><i /><i /><span>after your first collection</span></div>
            <div className="dbe-tiles">
              <div className="dbe-tile"><small>Open issues</small><b>3</b><em>1 critical · reachable</em></div>
              <div className="dbe-tile"><small>Internet-exposed</small><b>1</b><em>of 208 resources</em></div>
              <div className="dbe-tile"><small>Posture score</small><b>82</b><em>▲ +6 this month</em></div>
              <div className="dbe-tile"><small>Coverage</small><b>22</b><em>collectors per region</em></div>
            </div>
            <div className="dbe-note">Preview — populated by your customer&apos;s real evidence</div>
          </div>
        </section>
      ) : null}

      {connection ? (
        <>
          <section className="metrics-grid" aria-label="Pilot summary">
            <article className="metric-card metric-card-featured">
              <div className="metric-topline"><span>Trust health</span><span className={`status-pill ${connection.status === "active" ? "status-positive" : "status-medium"}`}>{connection.status.replace("_", " ")}</span></div>
              <strong className="connection-account">{connection.awsAccountId}</strong>
              <p>{allEnabledRegionScope ? (coveredRegions.length > 0 ? `${coveredRegions.length} AWS-discovered enabled regions` : "All account-enabled Regions") : `${connection.enabledRegions.length} explicitly selected regions`} · {connection.sourceKind === "simulated_fixture" ? `fixture ${connection.fixtureVersion ?? "not published"}` : `validated ${formatTimestamp(connection.lastValidatedAt)}`}</p>
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
              <div className="metric-topline"><span>Active snapshot coverage</span><span className="metric-glyph">AWS</span></div>
              <strong className="metric-value">{totalCoverage ? `${coveragePercent}%` : "—"}</strong>
              <p>{succeededCoverage} of {totalCoverage} checks succeeded</p>
            </article>
          </section>

          <section className="exec-cards" aria-label="Security posture summary">
            <article className="panel exec-card exec-card-score">
              <div className="panel-heading"><div><p className="eyebrow">Posture</p><h2>Security score</h2></div></div>
              <ScoreGauge value={securityScore} caption="Computed from open findings" />
              <p className="panel-footnote">100 minus a bounded penalty from the open-finding severity mix. Trend over time arrives with posture history.</p>
            </article>
            <article className="panel exec-card">
              <div className="panel-heading"><div><p className="eyebrow">Open issues</p><h2>By severity</h2></div><span className="result-count">{openFindings.length} open</span></div>
              <div className="severity-bars">
                {SEVERITY_KEYS.map((severity) => <div className="severity-bar" key={severity}>
                  <span className={`severity-badge severity-${severity}`}>{severity}</span>
                  <i><b className={`severity-fill severity-fill-${severity}`} style={{ width: `${(openBySeverity[severity] / maxSeverityCount) * 100}%` }} /></i>
                  <strong>{openBySeverity[severity]}</strong>
                </div>)}
              </div>
            </article>
            <article className="panel exec-card">
              <div className="panel-heading"><div><p className="eyebrow">Remediation</p><h2>Open vs. SLA target</h2></div></div>
              <div className="sla-list">
                {SEVERITY_KEYS.map((severity) => <div className="sla-row" key={severity}>
                  <span className={`severity-dot severity-${severity}`} />
                  <div><strong>{severity}</strong><small>SLA target {SLA_TARGET_DAYS[severity]} days</small></div>
                  <b>{openBySeverity[severity]} open</b>
                </div>)}
              </div>
              <p className="panel-footnote">Per-issue age and SLA-breach tracking arrive with posture history.</p>
            </article>
            <article className="panel exec-card">
              <div className="panel-heading"><div><p className="eyebrow">Coverage &amp; throughput</p><h2>Collection</h2></div></div>
              <ScoreGauge value={coveragePercent} caption="Collector checks succeeded" />
              <div className="throughput-row"><div><small>Open</small><strong>{openFindings.length}</strong></div><div><small>Resolved / excepted</small><strong>{resolvedCount}</strong></div></div>
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
                <div><span className="signal-icon signal-amber">03</span><p><strong>Native threat &amp; CVE services</strong><small>Import existing GuardDuty, Security Hub and Inspector findings when those services are already enabled</small></p><b className="muted-status">Read-only import</b></div>
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
              <dl><div><dt>AWS account</dt><dd>{connection.awsAccountId}</dd></div><div><dt>Region scope</dt><dd>{allEnabledRegionScope ? (coveredRegions.length > 0 ? coveredRegions.join(", ") : "All account-enabled Regions (discovered during sync)") : connection.enabledRegions.join(", ")}</dd></div><div><dt>Last successful sync</dt><dd>{formatTimestamp(connection.lastSuccessfulSyncAt)}</dd></div><div><dt>Permission pack</dt><dd>{connection.permissionPackVersion}</dd></div></dl>
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
