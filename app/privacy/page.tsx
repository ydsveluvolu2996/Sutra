import type { Metadata } from "next";

import LegalShell from "../components/legal-shell";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How Sutra collects, uses and protects data — data-minimizing by design, with read-only, customer-owned AWS access and no stored access keys.",
};

export default function PrivacyPage() {
  return (
    <LegalShell
      kicker="Privacy Policy"
      title={<>Privacy, <span className="accent">by design.</span></>}
      updated="Last updated: 2026"
      lead="Sutra is a business-to-business cloud-operations platform for managed service providers. We collect the least data needed to run the service, we never store your AWS access keys, and every finding we produce is derived from read-only metadata you explicitly authorize us to observe."
    >
      <p className="lx-legal-note">
        <em>
          This is a template to be reviewed by your legal counsel before you rely on it. It describes how the
          product is designed to handle data and is not a substitute for a policy tailored to your jurisdiction,
          contracts and processing activities.
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
        </ul>
        <p>
          Data minimization is a design principle, not an afterthought: collector permission packs are
          metadata-only, and evidence is normalized and scoped before it is promoted into the platform.
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
        <h2>3. Sub-processors</h2>
        <p>
          We rely on a small set of infrastructure and operational sub-processors (for example, hosting and
          transactional email) to deliver the service. <em>[Placeholder: maintain a current sub-processor list
          here, with each provider, its purpose and its processing location, before publishing.]</em> We require
          sub-processors to protect data consistent with this policy.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>4. Data retention</h2>
        <p>
          We retain account information for as long as your account is active and as needed to provide the
          service. Collected environment metadata is retained to power historical views, drift detection and
          audit history, and is superseded or removed according to configured retention. When an account is
          closed, associated data is deleted or anonymized within a reasonable period, except where retention is
          required by law.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>5. Security</h2>
        <p>
          Access is read-only and customer-owned, scoped with a unique platform-generated ExternalId, and
          validated with positive and negative trust checks. Tenant data is isolated so each customer sees only
          the workspaces explicitly granted to them. See our <a href="/security">Security</a> page for the full
          model.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>6. Your rights</h2>
        <p>
          Depending on your jurisdiction (including under GDPR and CCPA/CPRA-style frameworks), you may have the
          right to access, correct, export or delete personal data, to object to or restrict certain processing,
          and to withdraw consent. To exercise these rights, contact us through our{" "}
          <a href="/contact">contact page</a>. Where we act as a processor on behalf of a customer, we will
          direct applicable requests to the responsible controller.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>7. Cookies</h2>
        <p>
          We use essential cookies to keep the service secure and functional, and optional analytics cookies
          only with your consent. You can review and change your choice at any time through the{" "}
          <b>Cookie Preferences</b> control in the footer of this page.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>8. Changes to this policy</h2>
        <p>
          We may update this policy as the product and legal landscape evolve. Material changes will be
          reflected by an updated date above and, where appropriate, a notice within the product.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>9. Contact</h2>
        <p>
          Questions about this policy or your data? Reach the Sutra team through our{" "}
          <a href="/contact">contact page</a>.
        </p>
      </section>
    </LegalShell>
  );
}
