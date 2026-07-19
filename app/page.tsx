import Link from "next/link";
import { CapabilityExplorer, CorrelationGraph, HeroDashboard, MspShowcase, TrustPanel } from "./components/landing-interactive";

const platformLayers = [
  { number: "01", title: "Customer cloud", copy: "A customer-owned IAM role grants only the metadata APIs in the selected collector pack." },
  { number: "02", title: "Collector plane", copy: "An AWS workload identity obtains short-lived STS credentials and performs bounded regional discovery." },
  { number: "03", title: "Normalized CMDB", copy: "Assets, relationships and evidence are validated, scoped and promoted only after a complete run." },
  { number: "04", title: "MSP control plane", copy: "Role-aware dashboards, findings, audit history and customer access operate without exposing AWS credentials." },
];

const marqueeItems = [
  "Amazon EKS", "AWS IAM & IRSA", "EKS Pod Identity", "Trivy Operator", "Falco runtime",
  "Kyverno admission", "Cilium · Hubble", "Amazon GuardDuty", "Security Hub", "Amazon Inspector",
  "SBOM & signing", "Kubernetes RBAC", "CIS Benchmarks", "KEV · EPSS", "Jenkins & GitOps gates", "Route tables & NACLs",
];

const heroStats = [
  { value: "22", unit: "per region", label: "AWS evidence collectors" },
  { value: "5", unit: "frameworks", label: "Compliance readiness mappings" },
  { value: "100%", unit: "of findings", label: "Cited to collected evidence" },
  { value: "0", unit: "stored", label: "Customer access keys" },
];

const differentiators = [
  {
    code: "01",
    title: "Evidence-honest by design",
    copy: "Every verdict is tri-state — pass, fail, or unknown. When the evidence to decide is missing, Sutra says so on the finding. It never fabricates a “safe”.",
    proof: "Tri-state verdicts · missing evidence disclosed · every edge cited",
  },
  {
    code: "02",
    title: "One identity answer, cross-plane",
    copy: "Kubernetes RBAC, IRSA annotations and EKS Pod Identity associations resolve into a single effective-permission verdict: what can this pod actually do — in the cluster and in the AWS account?",
    proof: "RBAC ∪ IRSA ∪ Pod Identity → AWS reach · unused & default-SA flags",
  },
  {
    code: "03",
    title: "Reachability, hop by hop",
    copy: "Internet exposure is a proven path, not a security-group guess: gateway route, NACL port filter, load-balancer target, DNS entry point — each hop present in the evidence or the verdict is unknown.",
    proof: "IGW route · open vs filtered ports · LB targets · DNS entry points",
  },
];

const comparisonRows = [
  { dim: "Finding confidence", them: "A severity score you have to trust", sutra: "Tri-state verdicts — unknown is disclosed, never hidden" },
  { dim: "Missing data", them: "Silently reported as passing", sutra: "Surfaced as missing evidence on the finding itself" },
  { dim: "Identity risk", them: "Cloud IAM and cluster RBAC in separate views", sutra: "One effective-permission answer: RBAC + IRSA + Pod Identity → AWS reach" },
  { dim: "Internet exposure", them: "A security-group rule check", sutra: "Full path analysis: route, NACL filter, LB target membership, DNS" },
  { dim: "Remediation", them: "Auto-applied changes or a ticket dump", sutra: "Reviewed Kyverno / kubectl fixes, patch plans, and a severity-gated CI gate" },
  { dim: "Tenancy", them: "A single-tenant console", sutra: "MSP portfolio roll-up plus per-customer scoped workspaces" },
];

export default function LandingPage() {
  return (
    <div className="landing">
      <header className="site-header">
        <Link className="site-brand" href="/" aria-label="Sutra home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>Sutra</strong><small>Cloud security, woven together</small></span>
        </Link>
        <nav className="site-nav" aria-label="Public navigation">
          <a href="#platform">Platform</a><a href="#capabilities">Capabilities</a><a href="#why">Why Sutra</a><a href="#trust">Security model</a><Link href="/controls">Control library</Link>
        </nav>
        <div className="site-actions"><Link className="site-signin" href="/login">Sign in</Link><Link className="button button-primary" href="/dashboard">Open live demo</Link></div>
        <details className="site-mobile-nav"><summary>Menu</summary><div><a href="#platform">Platform</a><a href="#capabilities">Capabilities</a><a href="#why">Why Sutra</a><Link href="/dashboard">Live demo</Link></div></details>
      </header>

      <main>
        <section className="site-hero">
          <div className="hero-bg" aria-hidden="true"><i /><i /><i /><span className="hero-grid" /><span className="hero-stars" /></div>
          <div className="hero-copy">
            <span className="hero-kicker"><i /> EKS-first CNAPP for managed service providers</span>
            <h1>See every risk.<br /><span className="hero-accent">Prove every path.</span></h1>
            <p>Sutra correlates every cloud and cluster risk across AWS and Kubernetes into one evidence graph — exposure, workload, identity, blast radius — and surfaces the few that are provably reachable. Every finding cites the exact observation behind it.</p>
            <div className="hero-actions"><Link className="button hero-primary" href="/dashboard">Open live demo</Link><Link className="button hero-secondary" href="/onboard">Review the trust model</Link></div>
            <div className="hero-assurances"><span><b>✓</b> Read-only access, customer-owned</span><span><b>✓</b> Every finding cited</span><span><b>✓</b> No customer access keys</span></div>
          </div>

          <div className="hero-stage">
            <HeroDashboard />
            <div className="hero-chips" aria-hidden="true">
              <span className="hero-chip hero-chip-1"><b className="hc-dot hc-red" /> Internet → api-gateway <em>path confirmed</em></span>
              <span className="hero-chip hero-chip-2"><b className="hc-dot hc-violet" /> payments-sa → s3:DeleteObject <em>via IRSA</em></span>
              <span className="hero-chip hero-chip-3"><b className="hc-dot hc-cyan" /> 443 open · 8080 filtered <em>by acl-1</em></span>
            </div>
          </div>
        </section>

        <section className="hero-statband" aria-label="Platform facts">
          {heroStats.map((stat) => (
            <article key={stat.label} data-reveal>
              <strong>{stat.value}<em>{stat.unit}</em></strong>
              <span>{stat.label}</span>
            </article>
          ))}
        </section>

        <section className="foundation-strip" aria-label="Coverage strip">
          <div className="strip-top">
            <p><span>Correlated across your estate</span> AWS + EKS · identity · network · runtime · supply chain — in one evidence graph</p>
            <div className="strip-cats"><span><strong>Cloud</strong> CMDB &amp; CSPM</span><span><strong>Kubernetes</strong> KSPM &amp; runtime</span><span><strong>Identity</strong> CIEM &amp; RBAC</span><span><strong>Supply chain</strong> SBOM &amp; signing</span></div>
          </div>
          <div className="strip-marquee" aria-hidden="true">
            <div className="marquee-track">{[...marqueeItems, ...marqueeItems].map((item, index) => <span key={index}>{item}</span>)}</div>
          </div>
        </section>

        <section className="site-section platform-section" id="platform">
          <div className="section-intro centered" data-reveal><span className="section-kicker">Correlation is the product</span><h2>One graph connects the cloud, the cluster, and the identity.</h2><p>A privileged pod, reachable from the internet, running a critical CVE, with a ServiceAccount that can reach S3 — no single tool sees that whole chain. Sutra correlates it and cites every edge.</p></div>
          <div className="orbit-reveal" data-reveal><CorrelationGraph /></div>
        </section>

        <section className="site-section capabilities-section" id="capabilities">
          <div className="section-intro" data-reveal><span className="section-kicker">One correlated suite</span><h2>Every other tool floods you with CVEs. Sutra shows what&apos;s reachable.</h2><p>Cloud, Kubernetes, identity, network, runtime and supply-chain evidence in one graph — and only the risks proven to matter surface first. Every capability below is live in the product.</p></div>
          <div className="cap-ex-wrap" data-reveal><CapabilityExplorer /></div>
        </section>

        <section className="site-section why-section" id="why">
          <div className="section-intro centered" data-reveal><span className="section-kicker">Why teams choose Sutra</span><h2>Built on proof, where others ask for trust.</h2><p>Most platforms hand you a score. Sutra hands you the observation, the path, and the verdict — including the honest &ldquo;unknown&rdquo; when the evidence isn&apos;t there.</p></div>
          <div className="why-grid" data-reveal>
            {differentiators.map((d) => (
              <article key={d.code} className="why-card">
                <span className="why-code">{d.code}</span>
                <h3>{d.title}</h3>
                <p>{d.copy}</p>
                <em>{d.proof}</em>
              </article>
            ))}
          </div>
          <div className="compare-wrap" data-reveal>
            <div className="compare-head"><span>The difference in practice</span></div>
            <div className="compare-table" role="table" aria-label="Typical CNAPP compared with Sutra">
              <div className="compare-row compare-row-head" role="row"><span role="columnheader">&nbsp;</span><span role="columnheader">Typical CNAPP</span><span role="columnheader" className="compare-sutra-head">Sutra</span></div>
              {comparisonRows.map((row) => (
                <div key={row.dim} className="compare-row" role="row">
                  <span className="compare-dim" role="cell">{row.dim}</span>
                  <span className="compare-them" role="cell">{row.them}</span>
                  <span className="compare-sutra" role="cell"><b aria-hidden="true">✓</b>{row.sutra}</span>
                </div>
              ))}
            </div>
            <p className="compare-note">&ldquo;Typical CNAPP&rdquo; describes common industry patterns, not any specific vendor. Every Sutra behavior above is live in the demo workspace.</p>
          </div>
        </section>

        <section className="trust-section" id="trust">
          <div className="trust-bg" aria-hidden="true"><i /><i /></div>
          <div className="trust-inner">
            <div className="trust-copy" data-reveal><span className="section-kicker light">Trust is a product feature</span><h2>Customer credentials never enter the browser or web control plane.</h2><p>A separate collector workload assumes the customer role with temporary STS credentials. The application receives normalized, scoped evidence—not access keys.</p><ul><li><span>01</span>Exact vendor workload-role principal</li><li><span>02</span>Unique, platform-generated ExternalId</li><li><span>03</span>Positive and negative trust validation</li><li><span>04</span>Metadata-only permission packs</li></ul><Link className="button trust-button" href="/controls#architecture">Review the security architecture</Link></div>
            <div className="trust-panel-wrap" data-reveal><TrustPanel /></div>
          </div>
        </section>

        <section className="site-section msp-section" id="msp">
          <div className="section-intro centered" data-reveal><span className="section-kicker">Designed for managed services</span><h2>Operate the portfolio. Hand each customer the right view.</h2><p>MSP teams see cross-customer health and priorities; customer users see only explicitly granted workspaces, accounts, resources and findings.</p></div>
          <div data-reveal><MspShowcase /></div>
        </section>

        <section className="site-section model-section">
          <div className="section-intro" data-reveal><span className="section-kicker">From account to action</span><h2>A production architecture, not a browser-side AWS script.</h2><p>Collection, normalization and user access live in deliberately separate trust zones.</p></div>
          <div className="layer-grid" data-reveal>{platformLayers.map((layer, index) => <article key={layer.number}><span>{layer.number}</span><h3>{layer.title}</h3><p>{layer.copy}</p>{index < platformLayers.length - 1 ? <i>→</i> : null}</article>)}</div>
        </section>

        <section className="claim-section">
          <div data-reveal><span className="section-kicker">A suite with honest boundaries</span><h2>Superior correlation and evidence — not a black box that claims certainty it can&apos;t prove.</h2></div>
          <div className="claim-columns" data-reveal><article><strong>Sutra provides</strong><ul><li>Cloud + Kubernetes CMDB, KSPM and the evidence graph</li><li>Runtime-informed, reachability-confirmed issue prioritization</li><li>Kubernetes CIEM, drift, new-CVE detection and guided fixes</li><li>Per-customer posture trends and resell-ready reporting</li></ul></article><article><strong>Your scanners and cloud still provide</strong><ul><li>Trivy image, SBOM and configuration scanning in-cluster</li><li>Falco kernel-level runtime detection</li><li>GuardDuty, Security Hub and Inspector native findings</li><li>The vulnerability databases Sutra keeps you current against</li></ul></article></div>
        </section>

        <section className="final-cta"><div className="final-cta-bg" aria-hidden="true"><i /><i /></div><div data-reveal><span className="section-kicker light">Start in minutes</span><h2>See the MSP experience before connecting an account.</h2><p>Explore the live demo workspace, inspect the control library, then review the customer-owned IAM role — read-only from the first minute.</p></div><div data-reveal><Link className="button final-primary" href="/dashboard">Open live demo</Link><Link className="button final-secondary" href="/onboard">Review onboarding</Link></div></section>
      </main>

      <footer className="site-footer">
        <div>
          <Link className="site-brand footer-brand" href="/"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span><strong>Sutra</strong><small>Cloud security, woven together</small></span></Link>
          <p>An EKS-first, evidence-backed CNAPP for managed service providers — every finding traced to what was actually observed.</p>
        </div>
        <div><strong>Platform</strong><Link href="/dashboard">Live demo</Link><Link href="/cmdb">CMDB</Link><Link href="/findings">Findings</Link><Link href="/network-exposure">Network exposure</Link><Link href="/controls">Controls</Link></div>
        <div><strong>Trust</strong><Link href="/onboard">AWS onboarding</Link><Link href="/controls#architecture">Architecture</Link><a href="/sutra-customer-role-live-demo.yaml">CloudFormation role</a></div>
        <div><strong>Company</strong><span>© 2026 Sutra</span><span>Demo workspace uses fictional data</span><Link href="/login">Sign in</Link></div>
      </footer>
    </div>
  );
}
