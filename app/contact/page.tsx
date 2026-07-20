import type { Metadata } from "next";
import Link from "next/link";

import ContactForm from "./contact-form";

/* ================================================================== *
 * Public "Contact us" page. Deliberately standalone: it does NOT use
 * AppShell (which redirects to /login), so it stays reachable without
 * authentication — like the landing page and /login. `/contact` and
 * `/api/contact` are on the public allowlist in lib/deployment-security.ts.
 *
 * It reuses the landing page's `.lz` / `.lx-` aurora design classes
 * (see app/globals.css). This is a REAL form: it POSTs to /api/contact,
 * which validates, rate-limits, persists the lead and routes it to a
 * configured recipient. There are no mail-client links or placeholder
 * email addresses here.
 * ================================================================== */

export const metadata: Metadata = {
  title: "Contact us",
  description: "Talk to the Sutra team — book a walkthrough of the evidence-backed cloud operations platform for AWS MSPs.",
};

function Arrow() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

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
            Send us a note and we&rsquo;ll set up a walkthrough of the product, then help you plan a
            read-only, customer-owned onboarding.
          </p>
        </section>

        <section className="lx-contact-grid" aria-label="Send a message">
          <ContactForm />
        </section>
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
