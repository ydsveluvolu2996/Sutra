"use client";

import { usePortfolio } from "../components/use-portfolio";
import { useSession } from "../components/use-session";
import { formatTimestamp } from "../components/use-pilot-state";
import { isAllEnabledAwsRegionSelection } from "../../lib/aws-region-selection.ts";
import {
  connectionHealth,
  evidenceSourceLabel,
  snapshotFreshness,
} from "../../lib/portfolio-presentation.ts";

function initials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  return `${words[0]?.[0] ?? "C"}${words.length > 1 ? words.at(-1)?.[0] ?? "" : words[0]?.[1] ?? ""}`.toUpperCase();
}

export function CustomersBrowser() {
  const { portfolio, loading, error, refresh } = usePortfolio();
  const { session } = useSession();
  const capabilities = new Set(session?.capabilities ?? []);
  const canOnboard = capabilities.has("customer:create") && capabilities.has("connection:manage");
  const customers = portfolio?.customers ?? [];
  const connections = customers.flatMap((customer) => customer.connections.map((connection) => ({ customer, connection })));
  const measuredAt = portfolio?.measuredAt ?? new Date(0).toISOString();
  const liveAccountCount = connections.filter(({ connection }) => connection.sourceKind === "aws_trust_role").length;
  const simulatedAccountCount = connections.length - liveAccountCount;
  const healthyAccountCount = connections.filter(({ connection }) => connectionHealth(connection, measuredAt).state === "active").length;
  const attentionAccountCount = connections.length - healthyAccountCount;

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Cross-customer operations</p><h1>MSP command center</h1><p className="page-subtitle">Prioritize authorized customer accounts using persisted connection health, complete CMDB snapshots, and current security workload.</p></div>
        <div className="heading-actions"><a className="button button-secondary" href="/controls#architecture">Review isolation model</a>{canOnboard ? <a className="button button-primary" href="/onboard">Add customer account</a> : null}</div>
      </section>

      <div className="trust-strip" role="note"><span className="trust-icon">✓</span><span><strong>Server-enforced customer scope.</strong> Inaccessible names and totals are not returned to the browser. Fresh means a complete snapshot no more than 24 hours old; aging is 24–72 hours; stale is older than 72 hours.</span><span>Measured {formatTimestamp(portfolio?.measuredAt)}</span></div>

      {error ? <div className="page-alert page-alert-error" role="alert"><strong>Customer portfolio is unavailable</strong><span>{error}</span><button type="button" onClick={() => void refresh()}>Retry</button></div> : null}
      {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading authorized customer scope…</div> : null}

      {!loading && customers.length === 0 ? <section className="panel empty-workspace"><span className="empty-workspace-icon">MSP</span><h2>No customer workspaces in your scope</h2><p>{canOnboard ? "Onboard a simulated or customer-owned account to create the first scoped workspace." : "Ask an organization owner to assign a customer workspace to this membership."}</p>{canOnboard ? <a className="button button-primary" href="/onboard">Start onboarding</a> : null}</section> : null}

      {portfolio && customers.length > 0 ? (
        <>
          <section className="summary-band">
            <div><small>Customer workspaces</small><strong>{portfolio.totals.customers}</strong><span>{portfolio.scopeMode === "all_customers" ? "Organization-wide access" : "Explicitly assigned scope"}</span></div>
            <div><small>Cloud accounts</small><strong>{portfolio.totals.connections}</strong><span>{liveAccountCount} live AWS · {simulatedAccountCount} simulated</span></div>
            <div><small>CMDB resources</small><strong>{portfolio.totals.resources.toLocaleString()}</strong><span>Latest complete projections</span></div>
            <div><small>Open findings</small><strong>{portfolio.totals.openFindings.toLocaleString()}</strong><span>Workflow-adjusted current findings</span></div>
          </section>

          <section className="finding-summary" aria-label="Account operating queue">
            <article><span className="severity-dot severity-info" /><small>Healthy accounts</small><strong>{healthyAccountCount}</strong></article>
            <article><span className="severity-dot severity-high" /><small>Need operator attention</small><strong>{attentionAccountCount}</strong></article>
            <article><span className="severity-dot severity-info" /><small>Live AWS accounts</small><strong>{liveAccountCount}</strong></article>
            <article><span className="severity-dot severity-medium" /><small>Simulated accounts</small><strong>{simulatedAccountCount}</strong></article>
            <article><span className="severity-dot severity-info" /><small>Scope measured</small><strong>{customers.length}</strong></article>
          </section>

          <section className="panel customer-directory">
            <div className="panel-heading"><div><p className="eyebrow">Authorized directory</p><h2>Managed customers</h2></div><span className="status-pill status-positive">{customers.length} visible</span></div>
            <div className="customer-directory-list">
              {customers.map((customer) => {
                const freshness = snapshotFreshness(customer.latestSnapshotAt, portfolio.measuredAt);
                const healthyConnections = customer.connections.filter((connection) => connectionHealth(connection, portfolio.measuredAt).state === "active").length;
                const firstConnection = customer.connections[0];
                return <article className="customer-directory-row" key={customer.id}>
                  <span className="customer-avatar large">{initials(customer.name)}</span>
                  <div className="customer-identity"><h3>{customer.name}</h3><p>{customer.slug} · {freshness.label} · {formatTimestamp(customer.latestSnapshotAt)}</p></div>
                  <div className="directory-stat"><small>Accounts</small><strong>{customer.connectionCount}</strong></div>
                  <div className="directory-stat"><small>Assets</small><strong>{customer.resourceCount.toLocaleString()}</strong></div>
                  <div className="directory-stat"><small>Findings</small><strong>{customer.openFindingCount.toLocaleString()}</strong></div>
                  <div className="directory-score coverage-directory"><span><strong>{healthyConnections} of {customer.connectionCount}</strong> accounts healthy</span><div><i style={{ width: customer.connectionCount === 0 ? "0%" : `${Math.round((healthyConnections / customer.connectionCount) * 100)}%` }} /></div></div>
                  {firstConnection ? <a className="text-link" aria-label={`Open ${customer.name} CMDB`} href={`/cmdb?connectionId=${encodeURIComponent(firstConnection.id)}`}>→</a> : <span className={`connection-status connection-${customer.status === "suspended" ? "disabled" : "pending"}`}>{customer.status}</span>}
                </article>;
              })}
            </div>
          </section>

          <section className="panel account-directory">
            <div className="panel-heading"><div><p className="eyebrow">Operating queue</p><h2>Customer cloud accounts</h2></div>{canOnboard ? <a href="/onboard" className="text-link">Manage trust roles →</a> : null}</div>
            <div className="data-table account-table" role="table" aria-label="Authorized cloud account connections">
              <div className="data-row data-header" role="row"><span>Health</span><span>Customer / account</span><span>Evidence source</span><span>Workload</span><span>Freshness</span></div>
              {connections.map(({ customer, connection }) => {
                const health = connectionHealth(connection, portfolio.measuredAt);
                const source = evidenceSourceLabel(connection);
                const freshness = snapshotFreshness(connection.latestSnapshotAt, portfolio.measuredAt);
                const connectionQuery = `connectionId=${encodeURIComponent(connection.id)}`;
                return <div className="data-row" role="row" key={connection.id}>
                  <span className="primary-cell"><span className={`connection-status connection-${health.state}`}>{health.label}</span><small>{health.detail}</small></span>
                  <span className="primary-cell"><a className="resource-link" href={`/cmdb?${connectionQuery}`}><strong>{customer.name}</strong><small>{connection.awsAccountId} · {connection.partition}</small></a></span>
                  <span className="primary-cell"><strong>{source.label}</strong><small>{source.detail}</small><small>{isAllEnabledAwsRegionSelection(connection.enabledRegions) ? "All enabled Regions" : `${connection.enabledRegions.length} explicit Regions`} · {connection.permissionPackVersion}</small></span>
                  <span className="primary-cell"><a className="text-link" href={`/cmdb?${connectionQuery}`}>{connection.resourceCount.toLocaleString()} assets</a><a className="text-link" href={`/findings?${connectionQuery}`}>{connection.openFindingCount.toLocaleString()} open findings</a></span>
                  <span className="primary-cell"><strong>{freshness.label}</strong><small>{formatTimestamp(connection.latestSnapshotAt)}</small></span>
                </div>;
              })}
            </div>
            <p className="panel-footnote">Health is derived only from persisted connection state and complete-snapshot age. It is an operating signal, not a security, compliance, or risk score.</p>
          </section>

          <section className="panel tenant-boundary-note"><p className="eyebrow">Isolation evidence</p><h2>Portfolio totals are computed after access scope is applied</h2><p>All-customer memberships see the organization portfolio. Assigned-customer memberships are constrained through persisted customer grants in each SQL query. The same organization, membership, and customer keys must match before resources or findings contribute to these totals.</p></section>
        </>
      ) : null}
    </>
  );
}
