import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";

export const metadata: Metadata = {
  title: "Platform coverage",
  description: "Current live coverage, configuration-dependent integrations, and planned provider expansion for Sutra.",
};

const phases = [
  {
    number: "01",
    state: "Invitation-only live",
    tone: "gate",
    title: "Hosted identity and tenant isolation",
    summary: "Invitation-only access, Zoho OIDC, mandatory authorization checks, customer assignments, and tenant-scoped repositories form the hosted control-plane boundary.",
    items: ["Owner-created profiles and invitations", "Zoho OIDC with signed ID-token verification", "Organization and assigned-customer authorization", "MFA-protected sensitive workflows and audit records"],
    evidence: "Identity, invitation, session, authorization, and cross-tenant isolation gates",
  },
  {
    number: "02",
    state: "Live for approved connections",
    tone: "gate",
    title: "AWS CMDB, posture, and collection",
    summary: "Customer-owned trust roles provide temporary read-only access for inventory, graph, change, coverage, native finding, and compliance evidence.",
    items: ["CloudFormation or customer-managed trust role", "Immutable complete snapshots and last-good projection", "Resource inventory, relationships, findings and changes", "Collector coverage and explicit partial/failure states"],
    evidence: "Template lint, permission coverage, STS trust validation, and collector contracts",
  },
  {
    number: "03",
    state: "Evidence dependent",
    tone: "gate",
    title: "Security, Kubernetes, and FinOps verticals",
    summary: "Each vertical reads its own persisted evidence and reports an empty or unavailable state until the required source is connected.",
    items: ["Cloud and Kubernetes vulnerability workflows", "Exposure, detections, cases, exceptions and reports", "Kubernetes inventory, identity, runtime and supply-chain views", "Cost Explorer, CUR-backed allocation, showback and optimization"],
    evidence: "Per-source route, repository, normalization, and input-boundary tests",
  },
  {
    number: "04",
    state: "Operator configured",
    tone: "planned",
    title: "Delivery and optional engines",
    summary: "These capabilities are live only after an administrator supplies their required destination, worker, scanner, or cluster configuration.",
    items: ["Zoho invitation and contact email delivery", "Email, Slack, Teams, webhook and PagerDuty destinations", "Agentless disk scanning infrastructure", "Kubernetes agents, runtime events, registries and external scanner imports"],
    evidence: "Readiness is shown from persisted configuration; missing integrations never report success",
  },
  {
    number: "05",
    state: "Planned",
    tone: "horizon",
    title: "Additional cloud providers",
    summary: "Azure and Google Cloud require provider-specific identity, hierarchy, collection, and evidence contracts before they can be presented as available.",
    items: ["Provider-neutral CMDB interfaces", "Azure resource and security context", "Google Cloud asset and security context", "Cross-provider portfolio reporting"],
    evidence: "Provider-specific access, tenant, data-quality, and coverage acceptance gates",
  },
] as const;

const capabilityRows = [
  ["AWS onboarding", "Approved accounts only", "Customer-owned role, External ID, validation, rotation and offboarding"],
  ["CMDB and CSPM", "Active after complete collection", "Persisted resources, graph, findings, changes, coverage and exports"],
  ["Vulnerability and exposure", "Active when evidence exists", "Native AWS, Kubernetes, registry and approved scanner inputs"],
  ["Kubernetes", "Active after enrollment", "Inventory, RBAC/CIEM, drift, runtime, supply chain and compliance"],
  ["FinOps", "Active when billing is enabled", "Cost Explorer plus optional CUR-backed allocation and showback"],
  ["Cases and governance", "Active with collected findings", "Cases, routing, exceptions, approvals, reports and audit records"],
  ["Notifications and ITSM", "Configuration dependent", "Readiness and delivery reflect configured workers and destinations"],
  ["Azure and Google Cloud", "Planned", "No provider evidence is displayed until dedicated collectors pass release gates"],
] as const;

export default function RoadmapPage() {
  return (
    <AppShell active="roadmap">
      <section className="page-heading roadmap-heading">
        <div><p className="eyebrow">Release coverage</p><h1>Live capabilities and integration readiness</h1><p className="page-subtitle">A factual view of what is live, what requires operator configuration, and what remains planned. Runtime dashboards continue to show only persisted evidence.</p></div>
        <div className="heading-actions"><a className="button button-secondary" href="/controls">Review control coverage</a><a className="button button-primary" href="/operations">Open collection runs</a></div>
      </section>

      <div className="trust-strip roadmap-trust" role="note"><span className="trust-icon">✓</span><span><strong>No screen is treated as proof of integration.</strong> A capability is labelled live only when its identity, authorization, source, persistence, and failure boundaries are wired. Unconfigured sources show unavailable or empty states rather than sample data.</span><a href="#capability-matrix">View matrix</a></div>

      <section className="roadmap-now" aria-labelledby="roadmap-now-title">
        <div className="roadmap-now-copy">
          <span className="roadmap-phase-label"><i /> Hosted release boundary</span>
          <h2 id="roadmap-now-title">Read-only collection with customer-scoped evidence.</h2>
          <p>Sutra validates a dedicated customer role, obtains temporary AWS credentials, records each collection attempt, promotes only complete snapshots, and applies the authenticated membership&apos;s customer scope before returning resources, findings, costs, cases, or reports.</p>
          <div className="roadmap-facts"><span><strong>OIDC</strong> invited identities</span><span><strong>STS</strong> temporary access</span><span><strong>SQL</strong> tenant scope</span><span><strong>0</strong> sample metrics in live dashboards</span></div>
        </div>
        <div className="roadmap-now-boundary">
          <div><p className="eyebrow">Live boundary</p><ul><li>Invitation-only Zoho identity</li><li>Customer-owned AWS trust roles</li><li>Immutable evidence snapshots</li><li>Tenant-scoped APIs and repositories</li></ul></div>
          <div><p className="eyebrow">Fail-closed behavior</p><ul><li>Missing sources remain unknown</li><li>Partial collections do not replace CMDB state</li><li>Unconfigured integrations do not claim readiness</li><li>Cross-customer access is denied server-side</li></ul></div>
        </div>
      </section>

      <section className="roadmap-section">
        <div className="roadmap-section-heading"><div><p className="eyebrow">Release layers</p><h2>Capability readiness</h2></div><p>Every layer has an evidence gate; enabled UI alone never changes its status.</p></div>
        <div className="roadmap-phase-grid">
          {phases.map((phase) => <article className="roadmap-phase-card" key={phase.number}>
            <div className="roadmap-card-top"><span>{phase.number}</span><b className={`roadmap-state roadmap-state-${phase.tone}`}>{phase.state}</b></div>
            <h3>{phase.title}</h3><p>{phase.summary}</p>
            <ul>{phase.items.map((item) => <li key={item}>{item}</li>)}</ul>
            <div className="roadmap-exit"><small>Release evidence</small><strong>{phase.evidence}</strong></div>
          </article>)}
        </div>
      </section>

      <section className="panel roadmap-matrix-panel" id="capability-matrix">
        <div className="panel-heading"><div><p className="eyebrow">Current contract</p><h2>Capability matrix</h2></div><span className="status-pill status-positive">Evidence labelled</span></div>
        <div className="roadmap-matrix" role="table" aria-label="Sutra capability coverage">
          <div className="roadmap-matrix-row roadmap-matrix-header" role="row"><span>Area</span><span>Status</span><span>Evidence boundary</span><span /></div>
          {capabilityRows.map(([area, status, boundary]) => <div className="roadmap-matrix-row" role="row" key={area}><strong>{area}</strong><span>{status}</span><span>{boundary}</span><b>{status}</b></div>)}
        </div>
      </section>

      <section className="roadmap-guardrails">
        <div><p className="eyebrow">Release rule</p><h2>Missing evidence is unknown, never a pass.</h2><p>Collectors expose coverage, preserve the last complete snapshot, and keep source identity. Optional engines and destinations remain visibly unconfigured until their own readiness checks succeed.</p></div>
        <div><a className="button button-secondary" href="/settings">Review integrations</a><a className="button button-primary" href="/onboard">Onboard AWS account</a></div>
      </section>
    </AppShell>
  );
}
