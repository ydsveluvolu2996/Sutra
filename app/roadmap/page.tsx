import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";

export const metadata: Metadata = {
  title: "Product roadmap",
  description: "An honest delivered-versus-future roadmap for the Sutra MSP cloud operations platform.",
};

const phases = [
  {
    number: "01",
    state: "Production gate",
    tone: "gate",
    title: "Hosted security, tenancy, and jobs",
    summary: "Turn the local vertical slice into a defensible hosted control plane before onboarding production customers.",
    items: ["OIDC, MFA and tenant-scoped authorization", "Deployed AWS broker and managed keys", "Durable jobs, ingestion, retries and DLQ", "Isolation tests, backups, SLOs and incident response"],
    evidence: "P0 gates independently tested and approved",
  },
  {
    number: "02",
    state: "Planned expansion",
    tone: "planned",
    title: "AWS CMDB and posture depth",
    summary: "Broaden AWS inventory, change context, control coverage, compliance evidence, and native security finding imports.",
    items: ["More AWS resource and relationship types", "Change history, diffs, ownership and custom fields", "Reviewed controls, exceptions and standards mappings", "Inspector, GuardDuty and Security Hub finding imports"],
    evidence: "Coverage, quality and lifecycle tests per adapter",
  },
  {
    number: "03",
    state: "Planned expansion",
    tone: "planned",
    title: "FinOps",
    summary: "Build a reconciled cost foundation before presenting allocation, anomaly, commitment, or savings recommendations.",
    items: ["CUR or Data Exports ingestion", "Allocation, budgets and customer reporting", "Commitment coverage and utilization", "Measured anomaly and rightsizing recommendations"],
    evidence: "Invoice traceability and recommendation-quality metrics",
  },
  {
    number: "04",
    state: "Planned expansion",
    tone: "planned",
    title: "ITSM, SIEM, PSA, and collaboration",
    summary: "Create a reliable connector platform, then add the integrations MSP teams operate every day.",
    items: ["Versioned webhooks and public API", "ServiceNow, Jira and PSA workflows", "Splunk, Sentinel and Elastic exports", "Slack, Teams and email notifications"],
    evidence: "Tenant-safe delivery, retry, audit and redaction tests",
  },
  {
    number: "05",
    state: "Research horizon",
    tone: "horizon",
    title: "Azure, GCP, and Kubernetes",
    summary: "Add providers as independent security and data-quality programs—not shallow tag-only discovery.",
    items: ["Provider-neutral CMDB contracts", "Azure resource and Defender context", "GCP asset and SCC context", "Kubernetes workload and posture inventory"],
    evidence: "Provider-specific identity, hierarchy and coverage preserved",
  },
] as const;

const capabilityRows = [
  ["AWS onboarding", "One account; behavioral trust validation", "Organization-scale lifecycle and partitions", "Gate → expand"],
  ["CMDB", "Selected AWS inventory, graph, snapshots, exports", "Broad CI coverage, changes, history and query API", "Gate → expand"],
  ["CSPM", "9 controls + 2 native-service coverage signals", "Reviewed packs, exceptions and compliance mappings", "Gate → expand"],
  ["Native findings", "Coverage signals only; no finding import", "Inspector, GuardDuty and Security Hub correlation", "Expand"],
  ["Resource changes", "None; collector has zero write permissions", "Separate approved remediation plane", "Expand"],
  ["FinOps", "Not implemented", "Cost allocation, budgets, anomalies and optimization", "Expand"],
  ["Integrations", "JSON/CSV export only", "ITSM, SIEM, PSA, chat, webhooks and public API", "Expand"],
  ["Multi-cloud", "Not implemented", "Azure, GCP and Kubernetes collectors", "Horizon"],
] as const;

export default function RoadmapPage() {
  return (
    <AppShell active="roadmap">
      <section className="page-heading roadmap-heading">
        <div><p className="eyebrow">Product direction</p><h1>From working AWS pilot to MSP operations platform</h1><p className="page-subtitle">A sequenced, evidence-gated roadmap toward broad cloud-operations capability—without presenting future work as delivered.</p></div>
        <div className="heading-actions"><a className="button button-secondary" href="/controls">Inspect current controls</a><a className="button button-primary" href="/cmdb">Open working CMDB</a></div>
      </section>

      <div className="trust-strip roadmap-trust" role="note"><span className="trust-icon">i</span><span><strong>This is not a Cloudaware parity claim.</strong> It distinguishes the local one-account implementation from production gates, planned expansion, and research horizons. No dates are implied.</span><a href="#capability-matrix">Compare scope</a></div>

      <section className="roadmap-now" aria-labelledby="roadmap-now-title">
        <div className="roadmap-now-copy">
          <span className="roadmap-phase-label"><i /> Delivered locally · Phase 0</span>
          <h2 id="roadmap-now-title">One complete, honest AWS vertical slice.</h2>
          <p>Sutra can create a scoped connection, hand off an ExternalId, prove the IAM trust behavior, collect selected metadata, publish a complete snapshot, browse assets and relationships, evaluate deterministic checks, update finding workflow, and export evidence.</p>
          <div className="roadmap-facts"><span><strong>1</strong> customer / account</span><span><strong>7</strong> selected AWS collectors</span><span><strong>11</strong> controls and coverage signals</span><span><strong>0</strong> mutation permissions</span></div>
        </div>
        <div className="roadmap-now-boundary">
          <div><p className="eyebrow">Delivered</p><ul><li>Fixture and disposable-sandbox live modes</li><li>Signed broker boundary and encrypted local registry</li><li>Immutable complete snapshots and last-good projection</li><li>CMDB, findings, workflows, coverage, JSON and CSV</li></ul></div>
          <div><p className="eyebrow">Not yet production</p><ul><li>Hosted identity or proven multi-tenant isolation</li><li>Durable distributed jobs and managed key service</li><li>Production SLOs, backup drills and incident operations</li><li>Broad AWS, FinOps, integrations or multi-cloud parity</li></ul></div>
        </div>
      </section>

      <section className="roadmap-section">
        <div className="roadmap-section-heading"><div><p className="eyebrow">Evidence before breadth</p><h2>Sequenced expansion</h2></div><p>Each phase earns its claims through acceptance evidence. The production foundation comes before additional product surface.</p></div>
        <div className="roadmap-phase-grid">
          {phases.map((phase) => <article className="roadmap-phase-card" key={phase.number}>
            <div className="roadmap-card-top"><span>{phase.number}</span><b className={`roadmap-state roadmap-state-${phase.tone}`}>{phase.state}</b></div>
            <h3>{phase.title}</h3><p>{phase.summary}</p>
            <ul>{phase.items.map((item) => <li key={item}>{item}</li>)}</ul>
            <div className="roadmap-exit"><small>Exit evidence</small><strong>{phase.evidence}</strong></div>
          </article>)}
        </div>
      </section>

      <section className="panel roadmap-matrix-panel" id="capability-matrix">
        <div className="panel-heading"><div><p className="eyebrow">Delivered versus future</p><h2>Capability matrix</h2></div><span className="status-pill status-medium">No hidden parity claims</span></div>
        <div className="roadmap-matrix" role="table" aria-label="Sutra capability roadmap">
          <div className="roadmap-matrix-row roadmap-matrix-header" role="row"><span>Area</span><span>Available today</span><span>Broader target</span><span>Stage</span></div>
          {capabilityRows.map(([area, today, target, stage]) => <div className="roadmap-matrix-row" role="row" key={area}><strong>{area}</strong><span>{today}</span><span>{target}</span><b>{stage}</b></div>)}
        </div>
      </section>

      <section className="roadmap-guardrails">
        <div><p className="eyebrow">Release rule</p><h2>A schema, screen, permission, or fixture is not a delivered capability.</h2><p>Every collector must expose coverage, preserve the last complete good snapshot, and treat missing evidence as unknown—not a silent pass. Native AWS findings keep their provider identity and are never relabeled as Sutra detections.</p></div>
        <div><a className="button button-secondary" href="/controls#architecture">Review product boundaries</a><a className="button button-primary" href="/onboard">Test the local pilot</a></div>
      </section>
    </AppShell>
  );
}
