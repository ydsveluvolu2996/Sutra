import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";

export const metadata: Metadata = { title: "Control library" };

const controls = [
  ["NET-001", "Public administrative ingress", "EC2 / VPC", "Critical", "Security groups allowing SSH or RDP from 0.0.0.0/0 or ::/0."],
  ["NET-002", "Default security group in use", "EC2 / VPC", "Medium", "Default groups with ingress rules or attached network interfaces."],
  ["DATA-001", "S3 public access exposure", "Amazon S3", "Critical", "Public policy, ACL, or account/bucket public-access-block gaps."],
  ["DATA-002", "Storage encryption disabled", "EBS / RDS", "High", "Unencrypted block volumes or database instances based on collected metadata."],
  ["DATA-003", "Public database reachability", "Amazon RDS", "High", "Database instances marked publicly accessible with reachable network context."],
  ["IAM-001", "Stale access key", "AWS IAM", "Medium", "Active access keys older than the configured rotation threshold."],
  ["IAM-002", "Root MFA coverage", "AWS account", "Critical", "Root credential report indicates MFA is not enabled, or evidence is unavailable."],
  ["LOG-001", "Multi-region CloudTrail coverage", "CloudTrail", "High", "No active multi-region trail or incomplete log-delivery evidence."],
  ["DET-001", "GuardDuty coverage signal", "GuardDuty", "Info", "Shows whether AWS-native threat detection is enabled; Palisade does not emulate it."],
  ["VUL-001", "Inspector coverage signal", "Inspector", "Info", "Shows native vulnerability-scanning coverage and can ingest existing findings."],
];

export default function ControlsPage() {
  return (
    <AppShell active="controls">
      <section className="page-heading">
        <div><p className="eyebrow">Transparent by default</p><h1>Control library</h1><p className="page-subtitle">Deterministic checks with explicit evidence, versioning, and honest coverage boundaries.</p></div>
        <div className="heading-actions"><a className="button button-secondary" href="#architecture">View architecture</a><a className="button button-primary" href="/onboard">Connect account</a></div>
      </section>

      <section className="summary-band">
        <div><small>Configuration controls</small><strong>8</strong><span>Enabled in foundation pack</span></div>
        <div><small>Coverage signals</small><strong>2</strong><span>AWS-native service status</span></div>
        <div><small>Result semantics</small><strong>5</strong><span>Pass · fail · unknown · N/A · error</span></div>
        <div><small>Mutation permissions</small><strong>0</strong><span>Read-only v1 collector role</span></div>
      </section>

      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">Foundation pack · v0.1</p><h2>AWS posture and exposure checks</h2></div><span className="status-pill status-positive">Versioned</span></div>
        <div className="control-list">
          {controls.map(([id, title, service, severity, description]) => (
            <article className="control-row" key={id}>
              <code>{id}</code>
              <div><h3>{title}</h3><p>{description}</p></div>
              <span>{service}</span>
              <span className={`severity-badge severity-${severity.toLowerCase()}`}>{severity}</span>
              <span className="control-state">Enabled</span>
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
            <li><span>✓</span>Correlates AWS-native findings when customers enable them.</li>
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
        <div className="architecture-flow" aria-label="Palisade control and collector plane flow">
          <div><b>01</b><strong>MSP control plane</strong><span>Tenant-aware UI, CMDB, findings, jobs</span></div><i>→</i>
          <div><b>02</b><strong>Signed job envelope</strong><span>Scoped IDs, expiry, nonce, no role credentials</span></div><i>→</i>
          <div><b>03</b><strong>AWS collector broker</strong><span>Vendor workload IAM and short STS sessions</span></div><i>→</i>
          <div><b>04</b><strong>Customer role</strong><span>Exact principal + unique ExternalId + read-only policy</span></div>
        </div>
      </section>
    </AppShell>
  );
}
