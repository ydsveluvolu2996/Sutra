import type { Metadata } from "next";

import { publicPageMetadata } from "../../lib/site-seo";
import LegalShell from "../components/legal-shell";

export const metadata: Metadata = publicPageMetadata({
  path: "/terms",
  title: "Terms of Use",
  description: "The terms governing use of Sutra — the evidence-backed cloud-operations platform for AWS managed service providers.",
});

export default function TermsPage() {
  return (
    <LegalShell
      kicker="Terms of Use"
      title={<>Terms of <span className="accent">Use.</span></>}
      updated="Last updated: 21 July 2026"
      lead="These terms govern your access to and use of Sutra, an evidence-backed cloud-operations platform for AWS and Amazon EKS. Please read them carefully."
    >
      <p className="lx-legal-note">
        <em>
          These Terms of Use, together with any order form or master subscription agreement you enter into with
          Sutra, Inc. (&ldquo;Sutra&rdquo;), form the agreement between you and Sutra governing the service. If a
          signed agreement exists, it controls to the extent of any conflict.
        </em>
      </p>

      <section className="lx-legal-section">
        <h2>1. Acceptance of terms</h2>
        <p>
          By accessing or using Sutra, you agree to these Terms of Use on behalf of yourself and any
          organization you represent, and you confirm you are authorized to bind that organization. If you do not
          agree, do not use the service.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>2. Description of the service</h2>
        <p>
          Sutra provides read-only cloud-operations, security-posture, cost and compliance-readiness tooling for
          AWS and Amazon EKS environments. Findings are derived from collected metadata and are provided for
          informational and operational purposes; they do not guarantee that an environment is secure,
          compliant or free of risk. We may improve, change or discontinue features of the service, and will use
          reasonable efforts to give notice of material changes that adversely affect your use.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>3. Accounts and eligibility</h2>
        <p>
          The service is intended for business use by organizations and their authorized personnel. You are
          responsible for the accuracy of registration information, for keeping credentials confidential, for
          enabling multi-factor authentication where offered, and for all activity under your account. Notify us
          promptly of any unauthorized use.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>4. Acceptable use</h2>
        <p>You agree not to:</p>
        <ul>
          <li>Connect environments or data you are not authorized to access or monitor.</li>
          <li>Attempt to circumvent tenant isolation, access controls or rate limits.</li>
          <li>Reverse engineer, disrupt, or overload the service or its infrastructure.</li>
          <li>Resell or provide the service to third parties except as permitted by your agreement.</li>
          <li>Use the service to violate any applicable law or third-party right.</li>
        </ul>
      </section>

      <section className="lx-legal-section">
        <h2>5. Customer responsibilities</h2>
        <p>
          You are responsible for the AWS accounts, IAM role and permissions you grant to Sutra, for maintaining
          the confidentiality of user credentials, and for the actions taken by users under your account.
          Because Sutra is read-only, remediation and configuration changes in your environment remain your
          responsibility — Sutra generates reviewed suggestions, never automatic changes.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>6. Fees and payment</h2>
        <p>
          Fees, billing frequency and payment terms for paid subscriptions are set out in your order form or
          master subscription agreement. Except as required by law or expressly stated in that agreement, fees
          are non-refundable. You are responsible for applicable taxes other than taxes on Sutra&apos;s net
          income.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>7. Confidentiality</h2>
        <p>
          Each party may access the other&apos;s confidential information in connection with the service. The
          receiving party will use it only to perform under these Terms, protect it with at least reasonable
          care, and not disclose it except to personnel and contractors bound by confidentiality obligations.
          This does not apply to information that is public, independently developed, or rightfully received from
          a third party without restriction.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>8. Intellectual property</h2>
        <p>
          The Sutra platform, including its software, design, documentation and trademarks, is owned by Sutra and
          its licensors. You retain all rights to your data. You grant us the limited, non-exclusive rights
          necessary to process your data to provide, secure and improve the service. We may use aggregated,
          de-identified statistics that do not identify you or your environment.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>9. Third-party services</h2>
        <p>
          The service integrates with third-party platforms you choose to connect (for example, AWS, ticketing
          and notification providers). Your use of those services is governed by their terms, and Sutra is not
          responsible for their availability, security or content. You are responsible for the credentials and
          permissions you provide to enable an integration.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>10. Warranties and disclaimers</h2>
        <p>
          The service is provided &ldquo;as is&rdquo; and &ldquo;as available,&rdquo; without warranties of any
          kind, whether express or implied, including implied warranties of merchantability, fitness for a
          particular purpose and non-infringement. Sutra provides an evidence-honest view — including explicit
          &ldquo;unknown&rdquo; verdicts where evidence is missing — but does not warrant that findings are
          complete or error-free, or that the service will be uninterrupted.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>11. Indemnification</h2>
        <p>
          You will defend and indemnify Sutra against third-party claims arising from your data, your use of the
          service in violation of these Terms or applicable law, or environments or credentials you were not
          authorized to connect. Sutra will defend and indemnify you against third-party claims that the service,
          as provided and used in accordance with these Terms, infringes that third party&apos;s intellectual
          property rights. The indemnifying party&apos;s obligations are conditioned on prompt notice, reasonable
          cooperation and sole control of the defense.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>12. Limitation of liability</h2>
        <p>
          To the maximum extent permitted by law, neither party will be liable for any indirect, incidental,
          special, consequential or punitive damages, or for any loss of profits, data or goodwill. Each
          party&apos;s total aggregate liability arising out of or related to the service is limited to the fees
          you paid for the service in the twelve (12) months preceding the event giving rise to the claim. These
          limits do not apply to your payment obligations or to a party&apos;s indemnification obligations.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>13. Term and termination</h2>
        <p>
          You may stop using the service at any time. Either party may terminate for material breach that remains
          uncured 30 days after notice, and we may suspend access where necessary to protect the service or its
          users. On termination, your right to use the service ends and associated data is handled as described
          in our <a href="/privacy">Privacy Policy</a>. Sections that by their nature should survive
          (including confidentiality, intellectual property, disclaimers, liability limits and indemnification)
          survive termination.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>14. Governing law and disputes</h2>
        <p>
          These Terms are governed by the law, and subject to the exclusive jurisdiction, set out in your Sutra
          order form or master subscription agreement. Where no such agreement specifies otherwise, they are
          governed by the laws of, and subject to the exclusive jurisdiction of the courts of, the jurisdiction
          in which Sutra, Inc. has its principal place of business, without regard to conflict-of-laws rules.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>15. Changes to these terms</h2>
        <p>
          We may update these terms from time to time. Material changes will be reflected by an updated date
          above and, where appropriate, a notice within the product. Continued use after changes take effect
          constitutes acceptance.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>16. Miscellaneous</h2>
        <p>
          These Terms, with any order form or master subscription agreement, are the entire agreement between the
          parties regarding the service and supersede prior discussions. If any provision is held unenforceable,
          the remainder stays in effect. Neither party may assign these Terms without the other&apos;s consent,
          except to a successor in connection with a merger or sale of substantially all assets. Neither party is
          liable for delays caused by events beyond its reasonable control. A failure to enforce a provision is
          not a waiver.
        </p>
      </section>

      <section className="lx-legal-section">
        <h2>17. Contact</h2>
        <p>
          Questions about these terms? Reach the Sutra team through our <a href="/contact">contact page</a>.
        </p>
      </section>
    </LegalShell>
  );
}
