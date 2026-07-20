import type { Metadata } from "next";
import Link from "next/link";

/* ================================================================== *
 * Public "Contact us" page. Deliberately standalone: it does NOT use
 * AppShell (which redirects to /login), so it stays reachable without
 * authentication — like the landing page and /login. `/contact` is on
 * the public allowlist in lib/deployment-security.ts.
 *
 * It reuses the landing page's `.lz` / `.lx-` aurora design classes
 * (see app/globals.css). HONESTY: there is no fake form here. Contact
 * runs through a real mailto: link and clearly-labeled placeholder
 * details you replace with your own before going live.
 * ================================================================== */

export const metadata: Metadata = {
  title: "Contact us",
  description: "Talk to the Sutra team — book a walkthrough of the evidence-backed cloud operations platform for AWS MSPs.",
};

/* Placeholder address — replace with your own before publishing. */
const CONTACT_EMAIL = "hello@sutra.example";

function Arrow() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

const OPTIONS = [
  {
    k: "Book a walkthrough",
    d: "See the MSP experience end to end — the CMDB, the evidence graph, reachability-proven findings and per-customer scorecards — before connecting an account.",
    tag: "email us",
    href: `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("Sutra walkthrough request")}`,
    label: CONTACT_EMAIL,
  },
  {
    k: "Talk about onboarding",
    d: "Questions about the customer-owned IAM role, read-only STS collection, or how many AWS accounts and clusters you run? We will walk you through it.",
    tag: "email us",
    href: `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("Sutra onboarding question")}`,
    label: CONTACT_EMAIL,
  },
];

export default function ContactPage() {
  return (
    <div className="lz lx-contact">
      <div className="bg-glows" />

      <header className="head">
        <Link className="lx-brand" href="/" aria-label="Sutra home">
          <span className="mark" aria-hidden="true"><i /><i /><i /></span>
          <span><b>Sutra</b><small>Cloud security, woven together</small></span>
        </Link>
        <div className="head-actions">
          <Link className="signin" href="/login">Sign in</Link>
          <Link className="btn" href="/">Back to home <Arrow /></Link>
        </div>
      </header>

      <main className="wrap lx-contact-main">
        <section className="lx-contact-hero">
          <span className="kicker"><i /> Contact the Sutra team</span>
          <h1>Let&rsquo;s prove every path <span className="accent">together.</span></h1>
          <p className="lead">
            Sutra is the evidence-backed cloud operations platform for AWS MSPs — a live CMDB,
            reachability-proven security, cloud cost and compliance readiness in one graph.
            Reach out and we&rsquo;ll set up a walkthrough of the product, then help you plan a
            read-only, customer-owned onboarding.
          </p>
        </section>

        <section className="lx-contact-grid" aria-label="Ways to reach us">
          {OPTIONS.map((o) => (
            <a key={o.k} className="lx-contact-card" href={o.href}>
              <span className="lx-contact-tag">{o.tag}</span>
              <h2>{o.k}</h2>
              <p>{o.d}</p>
              <span className="lx-contact-link">{o.label} <Arrow /></span>
            </a>
          ))}
        </section>

        <p className="lx-contact-note">
          <strong>Placeholder contact details</strong> — the address{" "}
          <code>{CONTACT_EMAIL}</code> is not monitored. Replace it (and the phone and postal
          details below) with your own before you publish. There is no auto-submitting form on
          this page; every option opens your own mail client so nothing is sent on your behalf.
        </p>

        <div className="lx-contact-details" aria-label="Placeholder direct details">
          <div><b>Email</b><span>{CONTACT_EMAIL} <em>(placeholder)</em></span></div>
          <div><b>Phone</b><span>+0 (000) 000-0000 <em>(placeholder)</em></span></div>
          <div><b>Address</b><span>Your company address here <em>(placeholder)</em></span></div>
        </div>
      </main>

      <footer className="foot">
        <div className="wrap ftbottom">
          <Link className="lx-brand" href="/">
            <span className="mark" aria-hidden="true"><i /><i /><i /></span>
            <span><b>Sutra</b><small>Cloud security, woven together</small></span>
          </Link>
          <nav aria-label="Contact page">
            <Link href="/">Back to home</Link>
            <Link href="/login">Sign in</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
