import type { Metadata } from "next";

import { SUTRA_EMAIL } from "../../lib/public-email";
import { publicPageMetadata } from "../../lib/site-seo";
import LegalShell from "../components/legal-shell";

export const metadata: Metadata = publicPageMetadata({
  path: "/privacy",
  title: "Privacy Policy",
  description: "How Sutra collects, uses and protects data — data-minimizing by design, with read-only-by-default, customer-owned AWS access and no stored access keys.",
});

export default function PrivacyPage() {
  return (
    <LegalShell
      kicker="Privacy Policy"
      title={<>Privacy, <span className="accent">by design.</span></>}
      updated="Last updated: 21 July 2026"
      lead="Sutra is a business-to-business cloud-operations platform for managed service providers. We collect the least data needed to run the service, we never store your AWS access keys, and every finding we produce is derived from metadata you explicitly authorize us to observe through a read-only-by-default, customer-owned role."
    >
      <p className="lx-legal-note">
        <em>
          This Privacy Policy explains what data Sutra, Inc. (&ldquo;Sutra&rdquo;) processes, why, and the choices
          available to you. It forms part of, and should be read together with, your Sutra service agreement.
        </em>
      </p>

      <section className="lx-legal-section">
        <h2>1. What data we collect</h2>
        <p>We collect two categories of data, and no more than we need:</p>
        <ul>
          <li>
            <b>Account information.</b> The details required to create and operate an account for your team —
            name, work email, organization and role — plus authentication metadata such as sign-in events used
            to secure access.
          </li>
          <li>
            <b>Read-only AWS metadata.</b> Configuration and posture metadata about your AWS and Amazon EKS
            environments, gathered through a customer-owned IAM role that grants only read, metadata-scoped
            permissions. A separate collector workload assumes that role with temporary STS credentials.{" "}
            <b>We do not store customer access keys</b>, and long-lived credentials never enter the browser or
            the web control plane. We collect resource inventory, relationships and evidence — not the contents
            of your workloads or data stores.
          </li>
          <li>
            <b>Agentless disk scan results — only if you enable it.</b> Agentless disk scanning is off unless you
            turn it on. When enabled, Sutra creates an EBS snapshot of a volume in your account, copies it into a
            Sutra-operated scan account, and inspects the filesystem there to find installed packages, known
            vulnerabilities, and exposed credential material. The scan therefore <b>does</b> read file contents
            inside that copy — that is the only way to see a CVE without installing an agent.
            <br />
            What Sutra keeps from it is deliberately narrow: the package name and version, the CVE, and the
            <em> path</em> at which something was found. We do not retain the file contents, and for a detected
            secret we record its location and type, never its value. The snapshot copy in the scan account is
            deleted when the scan finishes; the source snapshot in your account is removed by a lifecycle policy
            you own, because Sutra is denied the ability to delete it.
          </li>
        </ul>
        <p>
          Data minimization is a design principle, not an afterthought: collector permission packs are
          metadata-only, agentless scan results are reduced to findings rather than contents, and evidence is
          normalized and scoped before it is promoted into the platform.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>2. How we use data</h2>
        <ul>
          <li>To build your cloud CMDB, security graph and evidence-cited findings.</li>
          <li>To authenticate users, enforce tenant isolation and secure the service.</li>
          <li>To operate, maintain, debug and improve the platform.</li>
          <li>To communicate with you about your account, security matters and service changes.</li>
        </ul>
        <p>
          We do not sell personal data, and we do not use your environment metadata to train models sold to
          third parties.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>3. Legal bases for processing</h2>
        <p>
          Where the GDPR or similar laws apply, we process personal data on these bases: performance of a
          contract (to provide the service you request); our legitimate interests (to secure, operate and
          improve the service, balanced against your rights); compliance with a legal obligation; and consent
          (for optional analytics cookies, which you can withdraw at any time). Where we process personal data on
          a customer&apos;s behalf, the customer determines the purpose and basis as controller.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>4. How we share data and sub-processors</h2>
        <p>
          We do not sell personal data and share it only as needed to run the service: with a limited set of
          infrastructure and operational sub-processors (for example, cloud hosting and transactional email);
          with integrations you choose to connect; and where required by law or to protect the service and its
          users. We maintain a current list of sub-processors — including each provider, its purpose and its
          processing location — available to customers on request, and we require every sub-processor to protect
          data consistent with this policy.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>5. International data transfers</h2>
        <p>
          Sutra may process data in countries other than your own. Where personal data is transferred across
          borders, we rely on an appropriate transfer mechanism — such as the European Commission&apos;s Standard
          Contractual Clauses or an adequacy decision — and apply safeguards designed to give the data a level of
          protection consistent with this policy.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>6. Data retention</h2>
        <p>
          We retain account information for as long as your account is active and as needed to provide the
          service. Collected environment metadata is retained to power historical views, drift detection and
          audit history, and is superseded or removed according to configured retention. When an account is
          closed, associated data is deleted or anonymized within a reasonable period, except where retention is
          required by law.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>7. Security</h2>
        <p>
          Access is read-only by default and customer-owned, scoped with a unique platform-generated ExternalId, and
          validated with positive and negative trust checks. Tenant data is isolated so each customer sees only
          the workspaces explicitly granted to them. See our <a href="/security">Security</a> page for the full
          model.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>8. Your rights</h2>
        <p>
          Depending on your jurisdiction (including under GDPR and CCPA/CPRA-style frameworks), you may have the
          right to access, correct, export or delete personal data, to object to or restrict certain processing,
          and to withdraw consent. We do not discriminate against you for exercising these rights. To make a
          request, contact us through our <a href="/contact">contact page</a>. Where we act as a processor on
          behalf of a customer, we will direct applicable requests to the responsible controller.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>9. Children&apos;s privacy</h2>
        <p>
          Sutra is a business tool that is not directed to children and is not intended for anyone under 16. We
          do not knowingly collect personal data from children; if you believe a child has provided data, contact
          us and we will delete it.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>10. Controller and processor roles</h2>
        <p>
          For account information and the operation of the service, Sutra acts as a data controller. For the
          environment metadata we process on your behalf, you are the controller and Sutra is the processor,
          acting on your documented instructions; those arrangements are governed by a data processing addendum
          available as part of your agreement.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>11. Cookies</h2>
        <p>
          We use essential cookies to keep the service secure and functional, and optional analytics cookies
          only with your consent. You can review and change your choice at any time through the{" "}
          <b>Cookie Preferences</b> control in the footer of this page.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>12. Changes to this policy</h2>
        <p>
          We may update this policy as the product and legal landscape evolve. Material changes will be
          reflected by an updated date above and, where appropriate, a notice within the product.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>13. Contact</h2>
        <p>
          Questions about this policy or your data? Email{" "}
          <a href={`mailto:${SUTRA_EMAIL.privacy}`}>{SUTRA_EMAIL.privacy}</a> or use our{" "}
          <a href="/contact">contact page</a>.
        </p>
      </section>
    </LegalShell>
  );
}
