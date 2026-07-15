import { AppShell } from "../components/app-shell";

const trend = [72, 68, 70, 61, 57, 52, 47, 44, 39, 34, 31, 27];

const findings = [
  {
    severity: "Critical",
    title: "Administrative ports exposed to the internet",
    resource: "sg-0a18c2e1 · production-edge",
    customer: "Northstar Retail (Demo)",
    age: "18 min",
  },
  {
    severity: "High",
    title: "RDS instance is publicly reachable",
    resource: "orders-primary · eu-west-1",
    customer: "Northstar Retail (Demo)",
    age: "22 min",
  },
  {
    severity: "High",
    title: "CloudTrail is not enabled in all regions",
    resource: "Account 6392 1048 7715",
    customer: "Bluepeak Health (Demo)",
    age: "1 hr",
  },
  {
    severity: "Medium",
    title: "IAM access key is older than 90 days",
    resource: "deploy-bot · IAM user",
    customer: "Harbor Analytics (Demo)",
    age: "3 hr",
  },
];

const customers = [
  { name: "Northstar Retail (Demo)", accounts: 2, assets: 7, score: 62, risk: "At risk", tone: "high" },
  { name: "Bluepeak Health (Demo)", accounts: 2, assets: 6, score: 78, risk: "Watch", tone: "medium" },
  { name: "Harbor Analytics (Demo)", accounts: 1, assets: 4, score: 86, risk: "Healthy", tone: "low" },
  { name: "Evergreen Finance (Demo)", accounts: 1, assets: 3, score: 91, risk: "Healthy", tone: "low" },
];

export default function Home() {
  return (
    <AppShell active="overview">
      <section className="page-heading">
        <div>
          <p className="eyebrow">MSP portfolio</p>
          <h1>Good morning, Alex.</h1>
          <p className="page-subtitle">
            Your customers are trending safer. Three findings need attention today.
          </p>
        </div>
        <div className="heading-actions">
          <a className="button button-secondary" href="/findings">Review findings</a>
          <a className="button button-primary" href="/onboard">Onboard AWS account</a>
        </div>
      </section>

      <div className="trust-strip" role="note">
        <span className="trust-icon">✓</span>
        <span><strong>Read-only by design.</strong> Palisade inventories and assesses resources through customer-owned IAM roles. It cannot modify infrastructure.</span>
        <a href="/controls">See coverage</a>
      </div>

      <section className="metrics-grid" aria-label="Portfolio summary">
        <article className="metric-card metric-card-featured">
          <div className="metric-topline"><span>Portfolio posture</span><span className="delta delta-good">↑ 8 pts</span></div>
          <div className="score-row"><strong>82</strong><span>/100</span></div>
          <div className="score-track"><span style={{ width: "82%" }} /></div>
          <p>Across 4 customers and 6 demo AWS accounts</p>
        </article>
        <article className="metric-card">
          <div className="metric-topline"><span>Managed assets</span><span className="metric-glyph">CMDB</span></div>
          <strong className="metric-value">20</strong>
          <p>Fictional normalized resources</p>
        </article>
        <article className="metric-card">
          <div className="metric-topline"><span>Open findings</span><span className="metric-glyph metric-glyph-alert">!</span></div>
          <strong className="metric-value">22</strong>
          <p><span className="severity-dot severity-critical" /> Demo posture observations</p>
        </article>
        <article className="metric-card">
          <div className="metric-topline"><span>Assessment coverage</span><span className="metric-glyph">AWS</span></div>
          <strong className="metric-value">83%</strong>
          <p>5 of 6 demo accounts healthy</p>
        </article>
      </section>

      <section className="dashboard-grid">
        <article className="panel trend-panel">
          <div className="panel-heading">
            <div><p className="eyebrow">Last 12 weeks</p><h2>Risk is moving in the right direction</h2></div>
            <span className="status-pill status-positive">↓ 45 fewer findings</span>
          </div>
          <div className="trend-chart" aria-label="Open high and critical findings decreased from 72 to 27 over twelve weeks" role="img">
            <div className="trend-axis"><span>75</span><span>50</span><span>25</span><span>0</span></div>
            <div className="trend-bars">
              {trend.map((value, index) => (
                <div className="trend-column" key={`${value}-${index}`}>
                  <span className="trend-value">{value}</span>
                  <span className="trend-bar" style={{ height: `${Math.max(value, 8)}%` }} />
                  {index % 3 === 0 ? <span className="trend-label">W{index + 1}</span> : <span className="trend-label" />}
                </div>
              ))}
            </div>
          </div>
        </article>

        <article className="panel signal-panel">
          <div className="panel-heading">
            <div><p className="eyebrow">Coverage signals</p><h2>What Palisade checks</h2></div>
          </div>
          <div className="signal-list">
            <div><span className="signal-icon signal-green">01</span><p><strong>Configuration posture</strong><small>Encryption, exposure, logging and IAM hygiene</small></p><b>Live</b></div>
            <div><span className="signal-icon signal-blue">02</span><p><strong>Asset relationships</strong><small>Account, region, network and resource context</small></p><b>Live</b></div>
            <div><span className="signal-icon signal-amber">03</span><p><strong>Threat & CVE signals</strong><small>Optional AWS-native findings ingestion</small></p><b className="muted-status">Planned</b></div>
          </div>
          <p className="panel-footnote">Configuration findings are recommendations, not proof of compromise or package vulnerabilities.</p>
        </article>
      </section>

      <section className="panel table-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">Priority queue</p><h2>Findings requiring action</h2></div>
          <a className="text-link" href="/findings">View all findings →</a>
        </div>
        <div className="data-table" role="table" aria-label="Priority findings">
          <div className="data-row data-header" role="row">
            <span>Severity</span><span>Finding</span><span>Customer</span><span>Last seen</span><span aria-label="Actions" />
          </div>
          {findings.map((finding) => (
            <div className="data-row" role="row" key={finding.title}>
              <span><span className={`severity-badge severity-${finding.severity.toLowerCase()}`}>{finding.severity}</span></span>
              <span className="primary-cell"><strong>{finding.title}</strong><small>{finding.resource}</small></span>
              <span>{finding.customer}</span>
              <span className="muted-cell">{finding.age}</span>
              <span><a className="row-action" href="/findings" aria-label={`Open ${finding.title}`}>→</a></span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel customer-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">Customer portfolio</p><h2>Posture by customer</h2></div>
          <a className="text-link" href="/customers">Manage customers →</a>
        </div>
        <div className="customer-grid">
          {customers.map((customer) => (
            <article className="customer-card" key={customer.name}>
              <div className="customer-card-top"><span className="customer-avatar">{customer.name.slice(0, 2).toUpperCase()}</span><span className={`status-pill status-${customer.tone}`}>{customer.risk}</span></div>
              <h3>{customer.name}</h3>
              <p>{customer.accounts} accounts · {customer.assets} assets</p>
              <div className="customer-score"><span><strong>{customer.score}</strong>/100</span><div><span style={{ width: `${customer.score}%` }} /></div></div>
            </article>
          ))}
        </div>
      </section>
    </AppShell>
  );
}
