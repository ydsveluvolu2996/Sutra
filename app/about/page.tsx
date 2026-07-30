import type { Metadata } from "next";

import { publicPageMetadata } from "../../lib/site-seo";
import LegalShell from "../components/legal-shell";

/* ================================================================== *
 * Public "About us" page. Reuses the shared LegalShell (header, footer,
 * cookie banner, theme toggle) so it stays consistent with the other
 * public marketing / trust pages and recolors with the light/dark
 * theme. `/about` is on the public allowlist in lib/deployment-security.ts.
 *
 * Copy is original and truthful: it describes what Sutra is and how it
 * behaves today. No fabricated team, history, customers or metrics.
 * ================================================================== */

export const metadata: Metadata = publicPageMetadata({
  path: "/about",
  title: "About us",
  description:
    "Sutra is the evidence-honest cloud operations and security platform for AWS MSPs — read-only by default, reachability-backed, and citing the observation behind every finding.",
});

const PRINCIPLES: Array<{ n: string; h: string; p: string }> = [
  {
    n: "01",
    h: "Prove it, or say unknown",
    p: "Every verdict is tri-state — pass, fail, or unknown. When the evidence to decide is missing, Sutra shows that on the finding instead of inventing a reassuring pass.",
  },
  {
    n: "02",
    h: "Read-only by construction",
    p: "Access is a customer-owned IAM role assumed with temporary STS credentials, and no customer access keys ever enter the browser or the control plane. The role is read-only apart from one opt-in you control: agentless disk scanning, which may create snapshots it tags itself and can never delete anything.",
  },
  {
    n: "03",
    h: "Correlation over noise",
    p: "Cloud, Kubernetes, identity, network and runtime evidence resolve into one graph, so the few provably reachable risks surface ahead of the thousands that do not.",
  },
];

export default function AboutPage() {
  return (
    <LegalShell
      kicker="About Sutra"
      title={
        <>
          No black boxes. <span className="accent">Just cited evidence.</span>
        </>
      }
      lead="Sutra is a read-only-by-default cloud operations and security platform for AWS and Amazon EKS, built for managed service providers. We started it because security tools ask you to trust a score — and we wanted a platform that shows the observation, the path, and the verdict behind every finding."
    >
      <div className="lx-about-cards">
        <section className="lx-about-card">
          <span className="lx-about-tag">Our Mission</span>
          <h2>Give MSPs a platform that proves every finding.</h2>
          <p>
            Our mission is to give managed service providers an evidence-honest, read-only-by-default cloud-operations and
            security platform for AWS and Amazon EKS — one that unifies inventory, reachability-backed security,
            cost and compliance readiness, and cites the exact observation behind every result. No agents on your
            workloads, no stored access keys, no verdict you have to take on faith.
          </p>
        </section>

        <section className="lx-about-card">
          <span className="lx-about-tag">Our Vision</span>
          <h2>Make &ldquo;prove it&rdquo; the default across a portfolio.</h2>
          <p>
            Our vision is a world where &ldquo;prove it&rdquo; is the default posture of cloud security — where
            reachability-backed evidence, never trust-me scores, decides what matters, and an MSP can run that
            same honest standard across an entire customer portfolio from a single evidence graph.
          </p>
        </section>
      </div>

      <section className="lx-legal-section">
        <h2>How we work</h2>
        <div className="lx-about-principles">
          {PRINCIPLES.map((principle) => (
            <article key={principle.n} className="lx-about-principle">
              <span className="lx-about-num">{principle.n}</span>
              <h3>{principle.h}</h3>
              <p>{principle.p}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="lx-legal-section">
        <h2>What we will not do</h2>
        <p>
          We do not invent social proof or claim capabilities the product does not have. We support AWS and Amazon
          EKS today — Azure and Google Cloud remain planned. Optional Kubernetes, scanner, billing, and delivery
          capabilities report their own configuration readiness. We map collected evidence to CIS Kubernetes, NSA/CISA
          and SOC 2 Common Criteria as an honest readiness view; that is a readiness mapping, <b>not</b> a
          certification. If you want to see how it behaves before connecting an account,{" "}
          <a href="/contact">book a walkthrough</a>.
        </p>
      </section>
    </LegalShell>
  );
}
