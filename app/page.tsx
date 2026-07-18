import Link from "next/link";
import { CapabilityExplorer, CorrelationGraph, HeroDashboard, MspShowcase, TrustPanel } from "./components/landing-interactive";

const platformLayers = [
  { number: "01", title: "Customer cloud", copy: "A customer-owned IAM role grants only the metadata APIs in the selected collector pack." },
  { number: "02", title: "Collector plane", copy: "An AWS workload identity obtains short-lived STS credentials and performs bounded regional discovery." },
  { number: "03", title: "Normalized CMDB", copy: "Assets, relationships and evidence are validated, scoped and promoted only after a complete run." },
  { number: "04", title: "MSP control plane", copy: "Role-aware dashboards, findings, audit history and customer access operate without exposing AWS credentials." },
];

const marqueeItems = ["Amazon EKS", "AWS IAM & IRSA", "Trivy Operator", "Falco runtime", "Kyverno admission", "Cilium · Hubble", "Amazon GuardDuty", "Security Hub", "Amazon Inspector", "SBOM & signing", "Kubernetes RBAC", "CIS Benchmarks"];

export default function LandingPage() {
  return (
    <div className="landing">
      <header className="site-header">
        <Link className="site-brand" href="/" aria-label="Sutra home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>Sutra</strong><small>Cloud security, woven together</small></span>
        </Link>
        <nav className="site-nav" aria-label="Public navigation">
          <a href="#platform">Platform</a><a href="#capabilities">Capabilities</a><a href="#msp">For MSPs</a><a href="#trust">Security model</a><Link href="/controls">Control library</Link>
        </nav>
        <div className="site-actions"><Link className="site-signin" href="/login">Sign in</Link><Link className="button button-primary" href="/dashboard">View demo workspace</Link></div>
        <details className="site-mobile-nav"><summary>Menu</summary><div><a href="#platform">Platform</a><a href="#capabilities">Capabilities</a><a href="#msp">For MSPs</a><Link href="/dashboard">Demo workspace</Link></div></details>
      </header>

      <main>
        <section className="site-hero">
          <div className="hero-bg" aria-hidden="true"><i /><i /><i /><span className="hero-grid" /></div>
          <div className="hero-copy">
            <span className="hero-kicker"><i /> EKS-first CNAPP for MSPs</span>
            <h1>Every cloud and cluster risk — <span className="hero-accent">proven</span>, prioritized, one graph.</h1>
            <p>Sutra shows managed service providers the handful of risks that are actually reachable and exploitable across AWS and Kubernetes — each one traced to cited evidence — then generates the fix. All through customer-owned, read-only access.</p>
            <div className="hero-actions"><Link className="button hero-primary" href="/dashboard">Explore the live demo</Link><Link className="button hero-secondary" href="/onboard">See account onboarding</Link></div>
            <div className="hero-assurances"><span><b>✓</b> Read-only access</span><span><b>✓</b> Every finding cited</span><span><b>✓</b> No customer access keys</span></div>
          </div>

          <HeroDashboard />
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

        <section className="final-cta"><div className="final-cta-bg" aria-hidden="true"><i /><i /></div><div data-reveal><span className="section-kicker light">Start with the working foundation</span><h2>See the MSP experience before connecting an account.</h2><p>Explore fictional demo data, inspect the control library, then review the customer-owned IAM role.</p></div><div data-reveal><Link className="button final-primary" href="/dashboard">Open demo workspace</Link><Link className="button final-secondary" href="/onboard">Review onboarding</Link></div></section>
      </main>

      <footer className="site-footer"><div><Link className="site-brand footer-brand" href="/"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span><strong>Sutra</strong><small>Cloud security, woven together</small></span></Link><p>An EKS-first, evidence-backed CNAPP for MSPs — every finding traced to what was actually observed.</p></div><div><strong>Platform</strong><Link href="/dashboard">Demo workspace</Link><Link href="/cmdb">CMDB</Link><Link href="/findings">Findings</Link><Link href="/controls">Controls</Link></div><div><strong>Trust</strong><Link href="/onboard">AWS onboarding</Link><Link href="/controls#architecture">Architecture</Link><a href="/sutra-customer-role-live-demo.yaml">CloudFormation</a></div><div><strong>Project</strong><span>Foundation preview</span><span>Fictional demo data</span><span>© 2026 Sutra</span></div></footer>
    </div>
  );
}
