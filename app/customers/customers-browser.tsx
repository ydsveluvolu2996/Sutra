"use client";

import { formatTimestamp, usePilotState } from "../components/use-pilot-state";

export function CustomersBrowser() {
  const { state, health, loading, error, refresh } = usePilotState();
  const connection = state?.connection ?? null;
  const resources = state?.resources ?? [];
  const findings = state?.findings ?? [];
  const openFindings = findings.filter((finding) => finding.status === "open");
  const succeededCoverage = state?.coverage.filter((entry) => entry.status === "succeeded").length ?? 0;
  const coverageTotal = state?.coverage.length ?? 0;

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Tenant operations</p><h1>Customer workspace</h1><p className="page-subtitle">Connection health, account scope, inventory freshness, and posture for the local one-customer pilot.</p></div>
        <div className="heading-actions"><a className="button button-secondary" href="/controls#architecture">Review isolation model</a><a className="button button-primary" href="/onboard">{connection ? "Manage connection" : "Add AWS account"}</a></div>
      </section>

      <div className="trust-strip" role="note"><span className="trust-icon">i</span><span><strong>{health?.mode === "live" ? "Live collector workspace." : health?.mode === "fixture" ? "Fixture collector workspace." : "Collector status unavailable."}</strong> This local pilot has a single operator scope. Production MSP tenant and customer-user authorization requires deployed identity and policy enforcement.</span><a href="/controls#architecture">See architecture</a></div>

      {error ? <div className="page-alert page-alert-error" role="alert"><strong>Customer state is unavailable</strong><span>{error}</span><button type="button" onClick={() => void refresh()}>Retry</button></div> : null}
      {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading customer state…</div> : null}

      {!loading && !connection ? <section className="panel empty-workspace"><span className="empty-workspace-icon">MSP</span><h2>Create the first customer workspace</h2><p>Onboarding an AWS account creates the scoped customer record and connection together.</p><a className="button button-primary" href="/onboard">Start onboarding</a></section> : null}

      {connection ? (
        <>
          <section className="summary-band">
            <div><small>Customer workspaces</small><strong>1</strong><span>Single-account local pilot</span></div>
            <div><small>AWS accounts</small><strong>1</strong><span>{connection.status.replace("_", " ")}</span></div>
            <div><small>CMDB resources</small><strong>{resources.length.toLocaleString()}</strong><span>Latest complete projection</span></div>
            <div><small>Open findings</small><strong>{openFindings.length.toLocaleString()}</strong><span>Deterministic configuration checks</span></div>
          </section>

          <section className="panel customer-directory">
            <div className="panel-heading"><div><p className="eyebrow">Scoped workspace</p><h2>Managed customer</h2></div><span className={`status-pill ${connection.status === "active" ? "status-positive" : "status-medium"}`}>{connection.status.replace("_", " ")}</span></div>
            <div className="customer-directory-list">
              <article className="customer-directory-row">
                <span className="customer-avatar large">{connection.customerName.slice(0, 2).toUpperCase()}</span>
                <div className="customer-identity"><h3>{connection.customerName}</h3><p>Local pilot workspace · {health?.mode ?? "unknown"} collector</p></div>
                <div className="directory-stat"><small>Accounts</small><strong>1</strong></div>
                <div className="directory-stat"><small>Assets</small><strong>{resources.length}</strong></div>
                <div className="directory-stat"><small>Findings</small><strong>{openFindings.length}</strong></div>
                <div className="directory-score coverage-directory"><span><strong>{succeededCoverage}</strong>/{coverageTotal} checks</span><div><i style={{ width: `${coverageTotal ? (succeededCoverage / coverageTotal) * 100 : 0}%` }} /></div></div>
                <a className="row-action" href="/cmdb" aria-label={`Open ${connection.customerName} CMDB`}>→</a>
              </article>
            </div>
          </section>

          <section className="panel account-directory">
            <div className="panel-heading"><div><p className="eyebrow">Connection health</p><h2>Customer-owned IAM role</h2></div><a href="/onboard" className="text-link">Manage trust role →</a></div>
            <div className="data-table account-table" role="table" aria-label="AWS account connection">
              <div className="data-row data-header" role="row"><span>Status</span><span>Account</span><span>Role</span><span>Regions</span><span>Last sync</span></div>
              <div className="data-row" role="row">
                <span><span className={`connection-status connection-${connection.status}`}>{connection.status.replace("_", " ")}</span></span>
                <span className="primary-cell"><strong>{connection.awsAccountId}</strong><small>{connection.partition} · {connection.permissionPackVersion}</small></span>
                <span className="primary-cell"><strong>{connection.roleArn?.split("/").at(-1) ?? "Not registered"}</strong><small title={connection.roleArn ?? undefined}>{connection.roleArn ? connection.roleArn.replace(/^arn:[^:]+:iam::\d{12}:/u, "") : "Complete onboarding"}</small></span>
                <span>{connection.enabledRegions.length} regions</span><span className="muted-cell">{formatTimestamp(connection.lastSuccessfulSyncAt)}</span>
              </div>
            </div>
          </section>

          <section className="panel tenant-boundary-note"><p className="eyebrow">Production boundary</p><h2>Local scope is intentionally narrow</h2><p>This pilot proves one account’s onboarding, inventory, relationships, findings, workflow, and exports. It does not yet claim production MSP user provisioning, per-customer SSO, billing, multi-region control-plane failover, or hundreds of concurrent tenants.</p></section>
        </>
      ) : null}
    </>
  );
}
