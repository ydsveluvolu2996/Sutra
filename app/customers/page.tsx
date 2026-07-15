import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { awsAccounts, customers, demoFindings, resources } from "../../lib/demo-data";

export const metadata: Metadata = { title: "Customers" };

const severityWeight = { critical: 14, high: 8, medium: 4, low: 2, informational: 0 } as const;

function postureScore(customerId: string) {
  const penalty = demoFindings.filter((finding) => finding.customerId === customerId).reduce((sum, finding) => sum + severityWeight[finding.severity], 0);
  return Math.max(38, 100 - penalty);
}

export default function CustomersPage() {
  return (
    <AppShell active="customers">
      <section className="page-heading">
        <div><p className="eyebrow">Tenant operations</p><h1>Customer portfolio</h1><p className="page-subtitle">Control access, account coverage, data freshness, and security posture per managed client.</p></div>
        <div className="heading-actions"><a className="button button-secondary" href="/controls#architecture">Review isolation model</a><a className="button button-primary" href="/onboard">Add AWS account</a></div>
      </section>

      <section className="summary-band">
        <div><small>Customer workspaces</small><strong>{customers.length}</strong><span>All records are fictional demo data</span></div>
        <div><small>AWS accounts</small><strong>{awsAccounts.length}</strong><span>5 connected · 1 needs attention</span></div>
        <div><small>CMDB resources</small><strong>{resources.length}</strong><span>Across global and regional services</span></div>
        <div><small>Open findings</small><strong>{demoFindings.length}</strong><span>Deterministic configuration checks</span></div>
      </section>

      <section className="panel customer-directory">
        <div className="panel-heading"><div><p className="eyebrow">Scoped workspaces</p><h2>Managed customers</h2></div><span className="status-pill status-positive">Demo dataset</span></div>
        <div className="customer-directory-list">
          {customers.map((customer) => {
            const accounts = awsAccounts.filter((account) => account.customerId === customer.id);
            const assetCount = resources.filter((resource) => resource.customerId === customer.id).length;
            const findings = demoFindings.filter((finding) => finding.customerId === customer.id);
            const score = postureScore(customer.id);
            return (
              <article className="customer-directory-row" key={customer.id}>
                <span className="customer-avatar large">{customer.name.slice(0, 2).toUpperCase()}</span>
                <div className="customer-identity"><h3>{customer.name}</h3><p>{customer.plan} plan · {customer.status}</p></div>
                <div className="directory-stat"><small>Accounts</small><strong>{accounts.length}</strong></div>
                <div className="directory-stat"><small>Assets</small><strong>{assetCount}</strong></div>
                <div className="directory-stat"><small>Findings</small><strong>{findings.length}</strong></div>
                <div className="directory-score"><span><strong>{score}</strong>/100</span><div><i style={{ width: `${score}%` }} /></div></div>
                <a className="row-action" href={`/cmdb?customer=${customer.id}`} aria-label={`Open ${customer.name}`}>→</a>
              </article>
            );
          })}
        </div>
      </section>

      <section className="panel account-directory">
        <div className="panel-heading"><div><p className="eyebrow">Connection health</p><h2>Customer-owned IAM roles</h2></div><a href="/onboard" className="text-link">Onboard another →</a></div>
        <div className="data-table account-table" role="table" aria-label="AWS account connections">
          <div className="data-row data-header" role="row"><span>Status</span><span>Account</span><span>Customer</span><span>Regions</span><span>Last sync</span></div>
          {awsAccounts.map((account) => {
            const customer = customers.find((item) => item.id === account.customerId);
            return <div className="data-row" role="row" key={account.id}>
              <span><span className={`connection-status connection-${account.trustRole.status}`}>{account.trustRole.status.replace("-", " ")}</span></span>
              <span className="primary-cell"><strong>{account.name}</strong><small>{account.awsAccountId} · {account.environment}</small></span>
              <span>{customer?.name}</span><span>{account.regions.length} regions</span><span className="muted-cell">{new Date(account.lastSyncedAt).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })}</span>
            </div>;
          })}
        </div>
      </section>
    </AppShell>
  );
}
