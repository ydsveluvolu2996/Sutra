"use client";

import type { ReactNode } from "react";
import Link from "next/link";

import { SUTRA_EMAIL } from "../../lib/public-email";
import CookieConsent, { openCookieSettings } from "./cookie-consent";
import ThemeToggle from "./theme-toggle";

/* ================================================================== *
 * Shared standalone shell for the public legal / trust pages
 * (Privacy, Terms, Security, Status). Deliberately does NOT use
 * AppShell (which redirects to /login), so these stay reachable
 * without authentication — like the landing and contact pages.
 *
 * Reuses the landing page's `.lz` / `.lx-` aurora design (see
 * app/globals.css) and mounts the tracked cookie-consent banner. The
 * footer "Cookie Preferences" control re-opens the settings modal.
 * ================================================================== */

function Arrow() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export default function LegalShell({
  kicker,
  title,
  lead,
  updated,
  children,
}: {
  kicker: string;
  title: ReactNode;
  lead?: ReactNode;
  updated?: string;
  children: ReactNode;
}) {
  return (
    <div className="lz lx-legal">
      <div className="bg-glows" />

      <header className="head">
        <Link className="lx-brand" href="/" aria-label="Sutra home">
          <span className="mark" aria-hidden="true"><i /><i /><i /></span>
          <span><b>Sutra</b><small>Cloud security, woven together</small></span>
        </Link>
        <div className="head-actions">
          <ThemeToggle />
          <Link className="signin" href="/about">About</Link>
          <Link className="signin" href="/login">Sign in</Link>
          <Link className="btn" href="/">Back to home <Arrow /></Link>
        </div>
      </header>

      <main className="wrap lx-legal-main">
        <section className="lx-legal-hero">
          <span className="kicker"><i /> {kicker}</span>
          <h1>{title}</h1>
          {updated ? <p className="lx-legal-updated">{updated}</p> : null}
          {lead ? <p className="lead">{lead}</p> : null}
        </section>
        <div className="lx-legal-body">{children}</div>
      </main>

      <footer className="foot">
        <div className="wrap ftbottom">
          <Link className="lx-brand" href="/">
            <span className="mark" aria-hidden="true"><i /><i /><i /></span>
            <span><b>Sutra</b><small>Cloud security, woven together</small></span>
          </Link>
          <nav aria-label="Legal">
            <Link href="/">Back to home</Link>
            <Link href="/about">About</Link>
            <Link href="/status">Status</Link>
            <Link href="/privacy">Privacy Policy</Link>
            <Link href="/terms">Terms of Use</Link>
            <Link href="/security">Security</Link>
            <a href={`mailto:${SUTRA_EMAIL.support}`}>Support</a>
            <button type="button" className="lx-cookie-link" onClick={openCookieSettings}>
              Cookie Preferences
            </button>
          </nav>
        </div>
      </footer>

      <CookieConsent />
    </div>
  );
}
