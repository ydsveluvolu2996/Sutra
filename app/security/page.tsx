import type { Metadata } from "next";

import { SUTRA_EMAIL } from "../../lib/public-email";
import { publicPageMetadata } from "../../lib/site-seo";
import LegalShell from "../components/legal-shell";

export const metadata: Metadata = publicPageMetadata({
  path: "/security",
  title: "Security",
  description: "How Sutra secures your data — read-only-by-default, customer-owned IAM access with a unique ExternalId, one opt-in write grant that can never delete anything, no stored access keys, tenant isolation and evidence-cited findings.",
});

export default function SecurityPage() {
  return (
    <LegalShell
      kicker="Security"
      title={<>Security is a <span className="accent">product feature.</span></>}
      lead="Sutra is built so that the platform can be useful without ever holding privileged access to your cloud. Access is read-only by default and customer-owned, credentials stay in your account, and every finding is traced back to what was actually observed."
    >
      <section className="lx-legal-section">
        <h2>Read-only by default, customer-owned access</h2>
        <p>
          Sutra connects to your environment through an IAM role that you create and own from a CloudFormation
          template we provide. By default the role grants only read, metadata-scoped permission packs — no write
          permissions at all. You can inspect exactly what it allows before you deploy it, and revoke it at any
          time.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>The one exception, and its hard limit</h2>
        <p>
          There is exactly one capability in the template that can write, and it is <b>off unless you turn it
          on</b>: agentless disk scanning. Reading a volume&apos;s contents without installing an agent requires
          an EBS snapshot, so that grant allows <code>CreateSnapshot</code> and <code>CreateTags</code> — and
          nothing else.
        </p>
        <p>
          The grant is fenced in four ways, all of them enforced by IAM in <em>your</em> account rather than by
          our code:
        </p>
        <ul>
          <li>
            A snapshot can only be created when it is tagged <code>sutra-agentless=true</code> at creation, so
            Sutra can never produce a resource it cannot account for.
          </li>
          <li>
            Sharing is pinned to a single Sutra scan account, and only for snapshots carrying that tag. Your own
            snapshots and backups cannot be read, copied or shared.
          </li>
          <li>
            An explicit <code>Deny</code> covers <code>DeleteSnapshot</code>, <code>DeleteVolume</code>,{" "}
            <code>DetachVolume</code>, <code>ModifyVolume</code>, <code>TerminateInstances</code>,{" "}
            <code>StopInstances</code>, <code>RebootInstances</code>, <code>DeregisterImage</code> and{" "}
            <code>DeleteTags</code>. A deny in IAM cannot be overridden by any later grant, including by us.
          </li>
          <li>
            Because Sutra cannot delete the snapshots it creates, cleanup runs from a Data Lifecycle Manager
            policy that the same template installs in your account, under your control and pausable from your
            own console. Sutra reports what is still outstanding; it never reaps it.
          </li>
        </ul>
        <p>
          Leave the toggle off and the role is read-only in the strictest sense. Turn it on and the worst case is
          a snapshot you did not want — never a resource you lost.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>No customer access keys stored</h2>
        <p>
          A separate collector workload assumes your role using temporary AWS STS credentials and performs
          bounded, regional discovery. <b>We never store customer access keys</b>, and long-lived credentials
          never enter the browser or the web control plane. The application receives normalized, scoped evidence
          — not keys.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>Least privilege and scoped trust</h2>
        <ul>
          <li>Metadata-only permission packs, matched to the collectors you enable.</li>
          <li>A unique, platform-generated ExternalId scopes the trust relationship to your workspace.</li>
          <li>Positive and negative trust validation confirms the role can be assumed only as intended.</li>
          <li>An exact vendor workload-role principal — not a wildcard — is authorized to assume the role.</li>
        </ul>
      </section>

      <section className="lx-legal-section">
        <h2>Evidence-cited findings</h2>
        <p>
          Every verdict is tri-state — pass, fail or unknown — and cited to the specific observation behind it.
          When the evidence needed to decide is missing, Sutra says so on the finding rather than reporting a
          false &ldquo;safe.&rdquo; This keeps security decisions grounded in what was actually collected.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>Tenant isolation</h2>
        <p>
          Sutra is multi-tenant by design. Isolation is enforced at every query: each customer user sees only
          the workspaces, accounts, resources and findings explicitly granted to them, and cross-tenant access
          attempts are denied and audited.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>Data minimization</h2>
        <p>
          We collect the least data required to operate the service. Collection is metadata-only — with the
          single exception of agentless disk scanning, which inspects a snapshot copy&apos;s filesystem and keeps
          only the resulting findings and their paths, never the file contents. Evidence
          is normalized, scoped and promoted only after a complete run. See our{" "}
          <a href="/privacy">Privacy Policy</a> for how data is used and retained.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>SOC 2 readiness mapping</h2>
        <p className="lx-legal-note">
          <em>
            Sutra maps its collected evidence to SOC 2 Common Criteria as a readiness view. This is a readiness
            mapping to support your own assessments — it is <b>not a certification</b>, and we do not claim SOC 2,
            ISO 27001 or any other certification that the product does not hold.
          </em>
        </p>
        <p>
          Within the product, the same evidence-cited approach maps to CIS Kubernetes and NSA/CISA guidance as an
          honest readiness view, never a pass stamp.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>Responsible disclosure</h2>
        <p>
          If you believe you have found a security vulnerability in Sutra, we want to hear from you. Please
          report it to <a href={`mailto:${SUTRA_EMAIL.security}`}>{SUTRA_EMAIL.security}</a> with enough detail to reproduce the issue,
          and give us a reasonable opportunity to investigate and remediate before any public disclosure. We
          will not pursue action against good-faith research that respects user privacy and avoids service
          disruption or data destruction.
        </p>
      </section>
    </LegalShell>
  );
}
