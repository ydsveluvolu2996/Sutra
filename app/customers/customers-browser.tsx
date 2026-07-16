"use client";

import { usePortfolio } from "../components/use-portfolio";
import { useSession } from "../components/use-session";
import { formatTimestamp } from "../components/use-pilot-state";
import { isAllEnabledAwsRegionSelection } from "../../lib/aws-region-selection.ts";

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

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Tenant operations</p><h1>Customer portfolio</h1><p className="page-subtitle">Authorized customer workspaces, cloud accounts, current inventory, and security workload from persisted tenant-scoped queries.</p></div>
        <div className="heading-actions"><a className="button button-secondary" href="/controls#architecture">Review isolation model</a>{canOnboard ? <a className="button button-primary" href="/onboard">Add customer account</a> : null}</div>
      </section>

      <div className="trust-strip" role="note"><span className="trust-icon">✓</span><span><strong>Server-enforced customer scope.</strong> This directory is filtered inside D1 by the authenticated organization membership and customer grants; inaccessible names and totals are not returned to the browser.</span><a href="/controls#architecture">See architecture</a></div>

      {error ? <div className="page-alert page-alert-error" role="alert"><strong>Customer portfolio is unavailable</strong><span>{error}</span><button type="button" onClick={() => void refresh()}>Retry</button></div> : null}
      {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading authorized customer scope…</div> : null}

      {!loading && customers.length === 0 ? <section className="panel empty-workspace"><span className="empty-workspace-icon">MSP</span><h2>No customer workspaces in your scope</h2><p>{canOnboard ? "Onboard a simulated or customer-owned account to create the first scoped workspace." : "Ask an organization owner to assign a customer workspace to this membership."}</p>{canOnboard ? <a className="button button-primary" href="/onboard">Start onboarding</a> : null}</section> : null}

      {portfolio && customers.length > 0 ? (
        <>
          <section className="summary-band">
            <div><small>Customer workspaces</small><strong>{portfolio.totals.customers}</strong><span>{portfolio.scopeMode === "all_customers" ? "Organization-wide access" : "Explicitly assigned scope"}</span></div>
            <div><small>Cloud accounts</small><strong>{portfolio.totals.connections}</strong><span>Persisted account connections</span></div>
            <div><small>CMDB resources</small><strong>{portfolio.totals.resources.toLocaleString()}</strong><span>Latest complete projections</span></div>
            <div><small>Open findings</small><strong>{portfolio.totals.openFindings.toLocaleString()}</strong><span>Workflow-adjusted current findings</span></div>
          </section>

          <section className="panel customer-directory">
            <div className="panel-heading"><div><p className="eyebrow">Authorized directory</p><h2>Managed customers</h2></div><span className="status-pill status-positive">{customers.length} visible</span></div>
            <div className="customer-directory-list">
              {customers.map((customer) => (
                <article className="customer-directory-row" key={customer.id}>
                  <span className="customer-avatar large">{initials(customer.name)}</span>
                  <div className="customer-identity"><h3>{customer.name}</h3><p>{customer.slug} · updated {formatTimestamp(customer.latestSnapshotAt)}</p></div>
                  <div className="directory-stat"><small>Accounts</small><strong>{customer.connectionCount}</strong></div>
                  <div className="directory-stat"><small>Assets</small><strong>{customer.resourceCount.toLocaleString()}</strong></div>
                  <div className="directory-stat"><small>Findings</small><strong>{customer.openFindingCount.toLocaleString()}</strong></div>
                  <div className="directory-score coverage-directory"><span><strong>{customer.status}</strong></span><div><i style={{ width: customer.status === "suspended" ? "0%" : "100%" }} /></div></div>
                  <span className={`connection-status connection-${customer.status === "suspended" ? "disabled" : "active"}`}>{customer.status}</span>
                </article>
              ))}
            </div>
          </section>

          <section className="panel account-directory">
            <div className="panel-heading"><div><p className="eyebrow">Connection health</p><h2>Customer cloud accounts</h2></div>{canOnboard ? <a href="/onboard" className="text-link">Manage trust roles →</a> : null}</div>
            <div className="data-table account-table" role="table" aria-label="Authorized cloud account connections">
              <div className="data-row data-header" role="row"><span>Status</span><span>Customer / account</span><span>Source</span><span>Inventory</span><span>Last sync</span></div>
              {connections.map(({ customer, connection }) => (
                <div className="data-row" role="row" key={connection.id}>
                  <span><span className={`connection-status connection-${connection.status}`}>{connection.status.replace("_", " ")}</span></span>
                  <span className="primary-cell"><strong>{customer.name}</strong><small>{connection.awsAccountId} · {connection.partition}</small></span>
                  <span className="primary-cell"><strong>{connection.sourceKind === "simulated_fixture" ? "SIMULATED FIXTURE" : connection.roleArn?.split("/").at(-1) ?? "Trust role not registered"}</strong><small>{connection.sourceKind === "simulated_fixture" ? `${connection.fixtureId ?? "fixture"} · ${connection.fixtureVersion ?? "not published"}` : `${isAllEnabledAwsRegionSelection(connection.enabledRegions) ? "All enabled Regions" : `${connection.enabledRegions.length} explicit Regions`} · ${connection.permissionPackVersion}`}</small></span>
                  <span className="primary-cell"><strong>{connection.resourceCount.toLocaleString()} assets</strong><small>{connection.openFindingCount.toLocaleString()} open findings</small></span>
                  <span className="muted-cell">{formatTimestamp(connection.lastSuccessfulSyncAt)}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="panel tenant-boundary-note"><p className="eyebrow">Isolation evidence</p><h2>Portfolio totals are computed after access scope is applied</h2><p>All-customer memberships see the organization portfolio. Assigned-customer memberships are constrained through persisted customer grants in each SQL query. The same organization, membership, and customer keys must match before resources or findings contribute to these totals.</p></section>
        </>
      ) : null}
    </>
  );
}
