import Link from "next/link";

const capabilities = [
  { code: "CMDB", title: "Unified AWS inventory", copy: "Normalize accounts, regions, networks, compute, storage, IAM and databases into a searchable customer-scoped asset graph.", state: "Foundation" },
  { code: "CSPM", title: "Configuration posture", copy: "Evaluate transparent controls for public exposure, encryption, logging, IAM hygiene and native security-service coverage.", state: "Foundation" },
  { code: "NET", title: "Security-group analysis", copy: "Find unrestricted administrative ports, default-group drift and risky ingress with the affected asset and network context.", state: "Foundation" },
  { code: "IAM", title: "Trusted-role onboarding", copy: "Connect customer accounts with an exact workload principal, unique ExternalId and temporary read-only STS sessions.", state: "Foundation" },
  { code: "NAT", title: "Native finding correlation", copy: "Correlate Security Hub, GuardDuty and Inspector findings when customers already enable those AWS services.", state: "Add-on" },
  { code: "OPS", title: "Evidence and workflows", copy: "Turn findings into customer-ready queues, assignments, exceptions, audit events and exportable evidence.", state: "Roadmap" },
];

const platformLayers = [
  { number: "01", title: "Customer cloud", copy: "A customer-owned IAM role grants only the metadata APIs in the selected collector pack." },
  { number: "02", title: "Collector plane", copy: "An AWS workload identity obtains short-lived STS credentials and performs bounded regional discovery." },
  { number: "03", title: "Normalized CMDB", copy: "Assets, relationships and evidence are validated, scoped and promoted only after a complete run." },
  { number: "04", title: "MSP control plane", copy: "Role-aware dashboards, findings, audit history and customer access operate without exposing AWS credentials." },
];

const trustPolicy = [
  "Principal:",
  "  AWS: arn:aws:iam::VENDOR:role/PalisadeCollector",
  "Action: sts:AssumeRole",
  "Condition:",
  "  StringEquals:",
  "    sts:ExternalId: psd_<unique-128-bit-value>",
  "  StringLike:",
  "    sts:RoleSessionName: palisade-*",
  "",
  "# No resource mutation",
  "# No object, secret, or database payload reads",
  "# Maximum one-hour temporary session",
].join("\n");

export default function LandingPage() {
  return (
    <div className="landing">
      <header className="site-header">
        <Link className="site-brand" href="/" aria-label="Palisade Cloud home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>Palisade</strong><small>Cloud operations</small></span>
        </Link>
        <nav className="site-nav" aria-label="Public navigation">
          <a href="#platform">Platform</a><a href="#capabilities">Capabilities</a><a href="#msp">For MSPs</a><a href="#trust">Security model</a><Link href="/controls">Control library</Link>
        </nav>
        <div className="site-actions"><Link className="site-signin" href="/dashboard">Sign in</Link><Link className="button button-primary" href="/dashboard">View demo workspace</Link></div>
        <details className="site-mobile-nav"><summary>Menu</summary><div><a href="#platform">Platform</a><a href="#capabilities">Capabilities</a><a href="#msp">For MSPs</a><Link href="/dashboard">Demo workspace</Link></div></details>
      </header>

      <main>
        <section className="site-hero">
          <div className="hero-glow" aria-hidden="true" />
          <div className="hero-copy">
            <span className="hero-kicker"><i /> AWS operations platform for MSPs</span>
            <h1>One source of truth for every customer cloud.</h1>
            <p>Palisade gives managed service providers a tenant-aware AWS CMDB, configuration posture, security-group analysis and evidence-backed recommendations—through customer-owned, read-only IAM roles.</p>
            <div className="hero-actions"><Link className="button hero-primary" href="/dashboard">Explore the live demo</Link><Link className="button hero-secondary" href="/onboard">See account onboarding</Link></div>
            <div className="hero-assurances"><span><b>✓</b> Read-only permissions</span><span><b>✓</b> No customer access keys</span><span><b>✓</b> ExternalId trust binding</span></div>
          </div>

          <div className="hero-product" aria-label="Palisade multi-tenant cloud operations dashboard preview">
            <div className="product-window-bar"><div><i /><i /><i /></div><span>portfolio.palisade.cloud</span><b>DEMO</b></div>
            <div className="product-window-body">
              <aside className="product-rail"><span className="product-logo">P</span><i className="active" /><i /><i /><i /><i /><span className="product-user">AM</span></aside>
              <div className="product-canvas">
                <div className="product-topline"><div><small>MSP portfolio</small><strong>Good morning, Alex.</strong></div><span>All customers⌄</span></div>
                <div className="product-metrics"><article><small>Portfolio posture</small><strong>82<em>/100</em></strong><i><b style={{ width: "82%" }} /></i></article><article><small>Managed assets</small><strong>2,427</strong><span>+96 this week</span></article><article><small>Open findings</small><strong>46</strong><span className="risk-text">3 critical</span></article></div>
                <div className="product-middle">
                  <article className="mini-chart"><div><small>Risk trend</small><strong>45 fewer findings</strong></div><div className="mini-bars">{[88,82,76,70,64,60,53,47,40,34,29,23].map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div></article>
                  <article className="mini-coverage"><small>Customer posture</small>{[["Northstar",62],["Bluepeak",78],["Harbor",86],["Evergreen",91]].map(([name, value]) => <div key={name}><span>{name}</span><i><b style={{ width: `${value}%` }} /></i><strong>{value}</strong></div>)}</article>
                </div>
                <div className="product-queue"><div><small>Priority queue</small><span>Customer</span><span>Severity</span></div>{[["Public admin ports", "Northstar", "Critical"],["Public RDS endpoint", "Northstar", "High"],["Trail coverage gap", "Bluepeak", "High"]].map((row) => <div key={row[0]}><strong>{row[0]}</strong><span>{row[1]}</span><b className={`queue-${row[2].toLowerCase()}`}>{row[2]}</b></div>)}</div>
              </div>
            </div>
          </div>
        </section>

        <section className="foundation-strip" aria-label="Foundation preview metrics">
          <p><span>Palisade foundation preview</span> Built around AWS trust best practices and explicit product boundaries</p>
          <div><span><strong>4</strong> customer workspaces</span><span><strong>6</strong> AWS accounts</span><span><strong>20</strong> demo assets</span><span><strong>12</strong> deterministic controls</span></div>
        </section>

        <section className="site-section platform-section" id="platform">
          <div className="section-intro centered"><span className="section-kicker">The operating system for your AWS practice</span><h2>CMDB is the context layer for every cloud operation.</h2><p>Bring inventory, security posture, account coverage and customer workflows into one consistent data model. Start with visibility; add deeper operational modules without rebuilding the foundation.</p></div>
          <div className="platform-orbit">
            <div className="orbit-node orbit-cmdb"><b>CMDB</b><span>Normalized asset graph</span></div>
            <div className="orbit-line orbit-line-1" /><div className="orbit-line orbit-line-2" /><div className="orbit-line orbit-line-3" /><div className="orbit-line orbit-line-4" />
            <div className="orbit-node orbit-north"><b>CSPM</b><span>Configuration posture</span></div><div className="orbit-node orbit-east"><b>IAM</b><span>Identity hygiene</span></div><div className="orbit-node orbit-south"><b>EVIDENCE</b><span>Audit & compliance</span></div><div className="orbit-node orbit-west"><b>FINOPS</b><span>Cost signals · planned</span></div>
            <div className="orbit-customer orbit-customer-1">Customer 01</div><div className="orbit-customer orbit-customer-2">Customer 02</div><div className="orbit-customer orbit-customer-3">Customer 03</div>
          </div>
        </section>

        <section className="site-section capabilities-section" id="capabilities">
          <div className="section-intro"><span className="section-kicker">Integrated capabilities</span><h2>Build a cloud management suite around one reliable inventory.</h2><p>Palisade’s first release focuses on the AWS visibility and posture workflows an MSP can deliver honestly today. Broader modules stay clearly labeled until their data and operating controls exist.</p></div>
          <div className="capability-grid">
            {capabilities.map((item) => <article key={item.code}><div><span>{item.code}</span><b className={`module-state state-${item.state.toLowerCase().replace("-", "")}`}>{item.state}</b></div><h3>{item.title}</h3><p>{item.copy}</p><Link href={item.state === "Foundation" ? "/dashboard" : "/controls"}>Explore capability <span>→</span></Link></article>)}
          </div>
        </section>

        <section className="trust-section" id="trust">
          <div className="trust-inner">
            <div className="trust-copy"><span className="section-kicker light">Trust is a product feature</span><h2>Customer credentials never enter the browser or web control plane.</h2><p>A separate collector workload assumes the customer role with temporary STS credentials. The application receives normalized, scoped evidence—not access keys.</p><ul><li><span>01</span>Exact vendor workload-role principal</li><li><span>02</span>Unique, platform-generated ExternalId</li><li><span>03</span>Positive and negative trust validation</li><li><span>04</span>Metadata-only permission packs</li></ul><Link className="button trust-button" href="/controls#architecture">Review the security architecture</Link></div>
            <div className="trust-policy-card"><div><span>customer-role.yaml</span><b>READ ONLY</b></div><pre><code>{trustPolicy}</code></pre><p><span>✓</span> Customer can revoke access by deleting the role.</p></div>
          </div>
        </section>

        <section className="site-section msp-section" id="msp">
          <div className="section-intro centered"><span className="section-kicker">Designed for managed services</span><h2>Operate the portfolio. Hand each customer the right view.</h2><p>MSP teams see cross-customer health and priorities; customer users see only explicitly granted workspaces, accounts, resources and findings.</p></div>
          <div className="msp-showcase">
            <div className="msp-tabs"><span className="active">MSP portfolio</span><span>Customer workspace</span><span>Analyst queue</span><span>Audit view</span></div>
            <div className="msp-view">
              <aside><small>Portfolio posture</small><strong>82</strong><span>↑ 8 points this quarter</span><div className="msp-ring"><i /></div></aside>
              <div className="msp-customer-list">{[["Northstar Retail","At risk",62],["Bluepeak Health","Watch",78],["Harbor Analytics","Healthy",86],["Evergreen Finance","Healthy",91]].map(([name,status,score]) => <article key={name}><span>{String(name).slice(0,2).toUpperCase()}</span><div><strong>{name}</strong><small>Customer workspace · {Number(score) > 80 ? "fresh" : "review"}</small></div><b className={`msp-${String(status).replace(" ", "-").toLowerCase()}`}>{status}</b><em>{score}/100</em></article>)}</div>
              <div className="msp-insight"><span>Today’s focus</span><strong>3 customer-impacting risks</strong><p>Prioritized using severity, exposure and asset context—never hidden behind an unexplained score.</p><Link href="/findings">Open analyst queue →</Link></div>
            </div>
          </div>
        </section>

        <section className="site-section model-section">
          <div className="section-intro"><span className="section-kicker">From account to action</span><h2>A production architecture, not a browser-side AWS script.</h2><p>Collection, normalization and user access live in deliberately separate trust zones.</p></div>
          <div className="layer-grid">{platformLayers.map((layer, index) => <article key={layer.number}><span>{layer.number}</span><h3>{layer.title}</h3><p>{layer.copy}</p>{index < platformLayers.length - 1 ? <i>→</i> : null}</article>)}</div>
        </section>

        <section className="claim-section">
          <div><span className="section-kicker">A suite with honest boundaries</span><h2>Lower-cost posture insight without pretending deterministic rules are a threat engine.</h2></div>
          <div className="claim-columns"><article><strong>Palisade provides</strong><ul><li>Multi-tenant AWS CMDB and relationships</li><li>Configuration and exposure assessments</li><li>IAM, logging and native-service coverage signals</li><li>Customer-ready evidence and recommendations</li></ul></article><article><strong>AWS-native services still provide</strong><ul><li>Inspector package, image and Lambda vulnerability scanning</li><li>GuardDuty behavior analytics and threat intelligence</li><li>Security Hub managed standards and finding ecosystem</li><li>Service-specific remediation and delegated administration</li></ul></article></div>
        </section>

        <section className="final-cta"><div><span className="section-kicker light">Start with the working foundation</span><h2>See the MSP experience before connecting an account.</h2><p>Explore fictional demo data, inspect the control library, then review the customer-owned IAM role.</p></div><div><Link className="button final-primary" href="/dashboard">Open demo workspace</Link><Link className="button final-secondary" href="/onboard">Review onboarding</Link></div></section>
      </main>

      <footer className="site-footer"><div><Link className="site-brand footer-brand" href="/"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span><strong>Palisade</strong><small>Cloud operations for MSPs</small></span></Link><p>A production-oriented AWS CMDB and configuration posture foundation.</p></div><div><strong>Platform</strong><Link href="/dashboard">Demo workspace</Link><Link href="/cmdb">CMDB</Link><Link href="/findings">Findings</Link><Link href="/controls">Controls</Link></div><div><strong>Trust</strong><Link href="/onboard">AWS onboarding</Link><Link href="/controls#architecture">Architecture</Link><a href="/palisade-customer-role.yaml">CloudFormation</a></div><div><strong>Project</strong><span>Foundation preview</span><span>Fictional demo data</span><span>© 2026 Palisade Cloud</span></div></footer>
    </div>
  );
}
