import type { Metadata } from "next";

import LegalShell from "../components/legal-shell";

export const metadata: Metadata = {
  title: "Terms of Use",
  description: "The terms governing use of Sutra — the evidence-backed cloud-operations platform for AWS managed service providers.",
};

export default function TermsPage() {
  return (
    <LegalShell
      kicker="Terms of Use"
      title={<>Terms of <span className="accent">Use.</span></>}
      updated="Last updated: 2026"
      lead="These terms govern your access to and use of Sutra, an evidence-backed cloud-operations platform for AWS and Amazon EKS. Please read them carefully."
    >
      <p className="lx-legal-note">
        <em>
          This is a template to be reviewed by your legal counsel before you rely on it. It is not a binding
          agreement as written and does not account for your specific commercial terms, jurisdiction or
          regulatory obligations.
        </em>
      </p>

      <section className="lx-legal-section">
        <h2>1. Acceptance of terms</h2>
        <p>
          By accessing or using Sutra, you agree to these Terms of Use on behalf of yourself and any
          organization you represent. If you do not agree, do not use the service.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>2. Description of the service</h2>
        <p>
          Sutra provides read-only cloud-operations, security-posture, cost and compliance-readiness tooling for
          AWS and Amazon EKS environments. Findings are derived from collected metadata and are provided for
          informational and operational purposes; they do not guarantee that an environment is secure,
          compliant or free of risk.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>3. Acceptable use</h2>
        <p>You agree not to:</p>
        <ul>
          <li>Connect environments or data you are not authorized to access or monitor.</li>
          <li>Attempt to circumvent tenant isolation, access controls or rate limits.</li>
          <li>Reverse engineer, disrupt, or overload the service or its infrastructure.</li>
          <li>Use the service to violate any applicable law or third-party right.</li>
        </ul>
      </section>

      <section className="lx-legal-section">
        <h2>4. Customer responsibilities</h2>
        <p>
          You are responsible for the AWS accounts, IAM role and permissions you grant to Sutra, for maintaining
          the confidentiality of user credentials, and for the actions taken by users under your account.
          Because Sutra is read-only, remediation and configuration changes in your environment remain your
          responsibility — Sutra generates reviewed suggestions, never automatic changes.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>5. Intellectual property</h2>
        <p>
          The Sutra platform, including its software, design, documentation and trademarks, is owned by Sutra,
          Inc. and its licensors. You retain all rights to your data. You grant us the limited rights necessary
          to process your data to provide the service.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>6. Warranties and disclaimers</h2>
        <p>
          The service is provided &ldquo;as is&rdquo; and &ldquo;as available,&rdquo; without warranties of any
          kind, whether express or implied, including implied warranties of merchantability, fitness for a
          particular purpose and non-infringement. Sutra provides an evidence-honest view — including explicit
          &ldquo;unknown&rdquo; verdicts where evidence is missing — but does not warrant that findings are
          complete or error-free.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>7. Limitation of liability</h2>
        <p>
          To the maximum extent permitted by law, Sutra, Inc. will not be liable for any indirect, incidental,
          special, consequential or punitive damages, or for any loss of profits, data or goodwill arising from
          your use of the service. <em>[Placeholder: aggregate liability caps and any exclusions should be set
          by your commercial agreement and reviewed with counsel.]</em>
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>8. Termination</h2>
        <p>
          You may stop using the service at any time. We may suspend or terminate access if these terms are
          violated or as required to protect the service or its users. On termination, your right to use the
          service ends and associated data is handled as described in our{" "}
          <a href="/privacy">Privacy Policy</a>.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>9. Governing law</h2>
        <p>
          <em>[Placeholder: specify the governing law and venue for disputes. This must be reviewed with your
          legal counsel.]</em>
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>10. Changes to these terms</h2>
        <p>
          We may update these terms from time to time. Material changes will be reflected by an updated date
          above and, where appropriate, a notice within the product. Continued use after changes take effect
          constitutes acceptance.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>11. Contact</h2>
        <p>
          Questions about these terms? Reach the Sutra team through our <a href="/contact">contact page</a>.
        </p>
      </section>
    </LegalShell>
  );
}
