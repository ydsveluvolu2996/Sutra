import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";

export const metadata: Metadata = { title: "Control library" };

const controls = [
  ["EC2-001", "Public SSH ingress candidate", "EC2 / VPC", "High", "Security groups allowing TCP/22 from a public IPv4 range; full network reachability is not claimed."],
  ["EC2-002", "Instance public IP", "Amazon EC2", "Medium", "Instances with a directly assigned public IPv4 address."],
  ["EC2-003", "IMDSv2 not required", "Amazon EC2", "High", "Instance metadata settings where HttpTokens is not required."],
  ["EC2-004", "Subnet auto-assigns public IPs", "EC2 / VPC", "Medium", "Subnets whose MapPublicIpOnLaunch setting is enabled."],
  ["S3-001", "S3 Public Access Block gaps", "Amazon S3", "High", "Buckets missing one or more Public Access Block protections."],
  ["RDS-001", "RDS storage encryption disabled", "Amazon RDS", "High", "Database instances whose StorageEncrypted setting is false."],
  ["RDS-002", "RDS public-accessibility flag", "Amazon RDS", "Critical", "Database instances whose PubliclyAccessible setting is enabled; full network reachability is not claimed."],
  ["LOG-001", "CloudTrail logging stopped", "CloudTrail", "Critical", "Configured trails that are not currently delivering management events."],
  ["IAM-001", "IAM password baseline", "AWS IAM", "Medium", "Account password policy is missing or below the local pilot baseline."],
  ["DET-001", "GuardDuty coverage signal", "GuardDuty", "High", "Shows whether AWS-native threat detection is enabled; Sutra does not emulate it."],
  ["HUB-001", "Security Hub coverage signal", "Security Hub", "Medium", "Shows whether native finding aggregation is enabled in the observed Region."],
];

export default function ControlsPage() {
  return (
    <AppShell active="controls">
      <section className="page-heading">
        <div><p className="eyebrow">Transparent by default</p><h1>Control library</h1><p className="page-subtitle">Deterministic checks with explicit evidence, versioning, and honest coverage boundaries.</p></div>
        <div className="heading-actions"><a className="button button-secondary" href="/roadmap">Product roadmap</a><a className="button button-secondary" href="#architecture">View architecture</a><a className="button button-primary" href="/onboard">Connect account</a></div>
      </section>

      <section className="summary-band">
        <div><small>Configuration controls</small><strong>9</strong><span>Enabled in local pilot pack</span></div>
        <div><small>Coverage signals</small><strong>2</strong><span>AWS-native service status</span></div>
        <div><small>Result semantics</small><strong>5</strong><span>Pass · fail · unknown · N/A · error</span></div>
        <div><small>Mutation permissions</small><strong>0</strong><span>Read-only v1 collector role</span></div>
      </section>

      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">Local pilot pack · v1.0</p><h2>AWS posture and exposure checks</h2></div><span className="status-pill status-positive">Versioned</span></div>
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
            <li><span>✓</span>Reports GuardDuty and Security Hub enablement as coverage signals.</li>
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
        <div><p className="eyebrow">Delivered versus future</p><h2>See exactly what Sutra implements now—and what remains gated.</h2><p>The roadmap separates this local AWS pilot from hosted multitenancy, broader AWS coverage, native finding imports, FinOps, integrations, remediation, and multi-cloud work.</p></div>
        <a className="button button-primary" href="/roadmap">Open product roadmap</a>
      </section>
    </AppShell>
  );
}
