import type { Metadata } from "next";
import { SUTRA_AWS_BASELINE } from "../../lib/compliance-catalog";
import { AppShell } from "../components/app-shell";

export const metadata: Metadata = { title: "Control library" };

const configurationControls = SUTRA_AWS_BASELINE.controls.filter(
  (control) => control.kind === "configuration",
).length;
const coverageControls = SUTRA_AWS_BASELINE.controls.length - configurationControls;

function compactControlKey(key: string): string {
  return key.split(".").slice(-2).join(".");
}

export default function ControlsPage() {
  return (
    <AppShell active="controls">
      <section className="page-heading">
        <div><p className="eyebrow">Transparent by default</p><h1>Control library</h1><p className="page-subtitle">Deterministic checks with explicit evidence, versioning, and honest coverage boundaries.</p></div>
        <div className="heading-actions"><a className="button button-secondary" href="/roadmap">Product roadmap</a><a className="button button-secondary" href="#architecture">View architecture</a><a className="button button-primary" href="/compliance">Open compliance</a></div>
      </section>

      <section className="summary-band">
        <div><small>Configuration controls</small><strong>{configurationControls}</strong><span>Resource and account checks</span></div>
        <div><small>Coverage controls</small><strong>{coverageControls}</strong><span>Regional service evidence</span></div>
        <div><small>Result semantics</small><strong>5</strong><span>Pass · fail · unknown · N/A · excepted</span></div>
        <div><small>Native finding sources</small><strong>3</strong><span>GuardDuty · Security Hub · Inspector</span></div>
      </section>

      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">{SUTRA_AWS_BASELINE.name} · v{SUTRA_AWS_BASELINE.version}</p><h2>AWS posture and coverage checks</h2></div><span className="status-pill status-positive">Versioned</span></div>
        <div className="control-list">
          {SUTRA_AWS_BASELINE.controls.map((control) => (
            <article className="control-row" key={control.key}>
              <code title={control.key}>{compactControlKey(control.key)}</code>
              <div><h3>{control.title}</h3><p>{control.description} {control.limitation}</p></div>
              <span>{control.service}</span>
              <span className={`severity-badge severity-${control.severity}`}>{control.severity}</span>
              <span className="control-state">{control.kind === "service-coverage" ? "Coverage" : "Enabled"}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="boundary-grid" id="architecture">
        <article className="panel boundary-primary">
          <p className="eyebrow">Product boundary</p><h2>What this first slice does</h2>
          <ul className="check-list">
            <li><span>✓</span>Inventories supported AWS resources and relationships.</li>
            <li><span>✓</span>Evaluates explainable configuration and exposure rules.</li>
            <li><span>✓</span>Preserves unknown states when evidence is missing.</li>
            <li><span>✓</span>Imports bounded GuardDuty, Security Hub, and Inspector findings.</li>
            <li><span>✓</span>Exports snapshot-pinned compliance evidence with report hashes.</li>
          </ul>
        </article>
        <article className="panel boundary-secondary">
          <p className="eyebrow">Commercial claim guardrail</p><h2>What it does not pretend to replace</h2>
          <ul className="cross-list">
            <li><span>—</span>Inspector package, container, or Lambda CVE scanning.</li>
            <li><span>—</span>GuardDuty behavioral analytics and threat intelligence.</li>
            <li><span>—</span>Security Hub managed standards and ecosystem breadth.</li>
            <li><span>—</span>Write access or unsupervised remediation.</li>
          </ul>
        </article>
      </section>

      <section className="panel architecture-panel">
        <div className="panel-heading"><div><p className="eyebrow">Two-plane trust model</p><h2>AWS credentials stay out of the web application</h2></div></div>
        <div className="architecture-flow" aria-label="Sutra control and collector plane flow">
          <div><b>01</b><strong>MSP control plane</strong><span>Tenant-aware UI, CMDB, findings, jobs</span></div><i>→</i>
          <div><b>02</b><strong>Signed job envelope</strong><span>Scoped IDs, expiry, nonce, no role credentials</span></div><i>→</i>
          <div><b>03</b><strong>AWS collector broker</strong><span>Vendor workload IAM and short STS sessions</span></div><i>→</i>
          <div><b>04</b><strong>Customer role</strong><span>Exact principal + unique ExternalId + read-only policy</span></div>
        </div>
      </section>

      <section className="roadmap-inline-callout">
        <div><p className="eyebrow">Delivered versus future</p><h2>See exactly what Sutra implements now—and what remains gated.</h2><p>The roadmap separates delivered native-finding imports and CSPM evidence from future SIEM event ingestion, correlation, hosted scale, remediation, integrations, and multi-cloud work.</p></div>
        <a className="button button-primary" href="/roadmap">Open product roadmap</a>
      </section>
    </AppShell>
  );
}
