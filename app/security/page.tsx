import type { Metadata } from "next";

import { SUTRA_EMAIL } from "../../lib/public-email";
import { publicPageMetadata } from "../../lib/site-seo";
import LegalShell from "../components/legal-shell";

export const metadata: Metadata = publicPageMetadata({
  path: "/security",
  title: "Security",
  description: "How Sutra secures your data — a recommended customer-owned IAM role, an optional AWS Secrets Manager-backed access-key path, tenant isolation and evidence-cited findings.",
});

export default function SecurityPage() {
  return (
    <LegalShell
      kicker="Security"
      title={<>Security is a <span className="accent">product feature.</span></>}
      lead="Sutra recommends a customer-owned, read-only-by-default IAM role with short-lived STS sessions. When role creation is impossible, an optional access-key method stores the customer-supplied credential encrypted in AWS Secrets Manager. Every finding is traced back to what was actually observed."
    >
      <section className="lx-legal-section">
        <h2>Read-only by default, customer-owned access</h2>
        <p>
          Sutra&apos;s recommended connection method uses an IAM role that you create and own from a CloudFormation
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
        <h2>Credential handling by connection method</h2>
        <p>
          With the recommended IAM Role method, the collector assumes your role using temporary AWS STS
          credentials; Sutra stores no customer access key. With the optional Access &amp; Secret Keys method, you
          submit a dedicated IAM user credential through the authenticated onboarding form. The collector stages
          that value encrypted in a versioned AWS Secrets Manager secret and promotes it only after account
          verification. The web control plane persists only a non-secret secret reference and the access-key
          identifier&apos;s last four characters; submitted values are cleared from the form and never returned.
        </p>
        <p>
          Disabling an access-key connection blocks live use but retains its secret. Offboarding blocks use and
          schedules the secret for deletion with a seven-day recovery window. Neither action revokes the IAM key
          in your AWS account; you must deactivate and delete that key separately.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>Least privilege and scoped trust</h2>
        <ul>
          <li>Metadata-only permission packs, matched to the collectors you enable.</li>
          <li>A unique, platform-generated ExternalId scopes the trust relationship to your workspace.</li>
          <li>Positive and negative trust validation confirms the role can be assumed only as intended.</li>
          <li>An exact vendor workload-role principal — not a wildcard — is authorized to assume the role.</li>
          <li>For the optional access-key method, GetCallerIdentity verifies account identity only. It does not prove least privilege; customer-managed IAM policies determine the key&apos;s effective permissions.</li>
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
