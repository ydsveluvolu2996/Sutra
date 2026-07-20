"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

/* ================================================================== *
 * Cookie consent — a real, tracked consent surface for the public
 * marketing pages. The choice is stored in localStorage AND a cookie
 * so it survives reloads and the banner never reappears once decided.
 *
 * There are currently NO third-party trackers to load: analytics is a
 * stored, honored preference only. Nothing is injected either way — we
 * simply record consent so that, if analytics is ever added, it loads
 * only when `analytics === true`.
 *
 * SSR-safe: the stored decision is read through useSyncExternalStore
 * (server snapshot = "no decision"), the banner renders only after
 * hydration, and no Date.now() runs in render — the timestamp is
 * written in event handlers.
 *
 * Styles are scoped under `.lz` in globals.css, matching the aurora
 * marketing design, so this component must be mounted inside a `.lz`
 * subtree (the landing, contact and legal shells all are).
 * ================================================================== */

const STORAGE_KEY = "sutra.cookie-consent";
const CHANGED_EVENT = "sutra:cookie-consent-changed";
const MAX_AGE = 60 * 60 * 24 * 365; // one year, in seconds

/** Fired on `window` to (re)open the preferences modal from anywhere. */
export const COOKIE_SETTINGS_EVENT = "sutra:cookie-settings";

/** Dispatch from any client component (e.g. a "Cookie Preferences" button). */
export function openCookieSettings(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(COOKIE_SETTINGS_EVENT));
  }
}

type Consent = { essential: true; analytics: boolean; ts: number };

function parseConsent(raw: string | null): Consent | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { analytics?: unknown; ts?: unknown };
    if (parsed && typeof parsed === "object" && typeof parsed.analytics === "boolean") {
      return { essential: true, analytics: parsed.analytics, ts: Number(parsed.ts) || 0 };
    }
  } catch {
    /* corrupt storage — treat as no decision */
  }
  return null;
}

function persistConsent(analytics: boolean): void {
  if (typeof window === "undefined") return;
  const serialized = JSON.stringify({ essential: true, analytics, ts: Date.now() } satisfies Consent);
  try {
    window.localStorage.setItem(STORAGE_KEY, serialized);
  } catch {
    /* storage may be disabled — the cookie below is the fallback */
  }
  try {
    document.cookie = `${STORAGE_KEY}=${encodeURIComponent(serialized)}; path=/; max-age=${MAX_AGE}; SameSite=Lax`;
  } catch {
    /* cookies may be disabled — nothing else to do */
  }
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

/* --- external store: the persisted consent decision (raw string) --- */
function subscribeConsent(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGED_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGED_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}
function getConsentSnapshot(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
function getConsentServerSnapshot(): string | null {
  return null;
}

/* Canonical "have we hydrated yet?" via useSyncExternalStore — no
 * synchronous setState in an effect, and no hydration mismatch. */
const noopSubscribe = () => () => {};

export default function CookieConsent() {
  const isHydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const rawConsent = useSyncExternalStore(subscribeConsent, getConsentSnapshot, getConsentServerSnapshot);
  const consent = useMemo(() => parseConsent(rawConsent), [rawConsent]);

  const [showModal, setShowModal] = useState(false);
  const [analytics, setAnalytics] = useState(false);

  useEffect(() => {
    const openModal = () => {
      const current = parseConsent(getConsentSnapshot());
      setAnalytics(current ? current.analytics : false);
      setShowModal(true);
    };
    window.addEventListener(COOKIE_SETTINGS_EVENT, openModal);
    return () => window.removeEventListener(COOKIE_SETTINGS_EVENT, openModal);
  }, []);

  const decide = useCallback((accepted: boolean) => {
    persistConsent(accepted);
    setAnalytics(accepted);
    setShowModal(false);
  }, []);

  const saveSettings = useCallback(() => {
    persistConsent(analytics);
    setShowModal(false);
  }, [analytics]);

  if (!isHydrated) return null;
  const showBanner = consent === null;
  if (!showBanner && !showModal) return null;

  return (
    <>
      {showBanner ? (
        <div className="lx-cookie lx-cookie-playful" role="region" aria-label="Cookie consent">
          <span className="lx-cookie-art" aria-hidden="true">
            <svg viewBox="0 0 64 64" fill="none">
              <defs>
                <linearGradient id="lx-ck-grad" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#22d3ee" />
                  <stop offset=".5" stopColor="#3b82f6" />
                  <stop offset="1" stopColor="#8b5cf6" />
                </linearGradient>
              </defs>
              {/* back cookie */}
              <circle cx="23" cy="39" r="16" fill="rgba(59,130,246,.16)" stroke="url(#lx-ck-grad)" strokeWidth="2" />
              <circle cx="18" cy="35" r="2" fill="#8b5cf6" />
              <circle cx="27" cy="43" r="2.2" fill="#22d3ee" />
              <circle cx="24" cy="31" r="1.6" fill="#3b82f6" />
              <circle cx="16" cy="44" r="1.5" fill="#22d3ee" />
              {/* front cookie with a small smiley */}
              <circle cx="43" cy="25" r="14" fill="rgba(139,92,246,.20)" stroke="url(#lx-ck-grad)" strokeWidth="2" />
              <circle cx="38" cy="21" r="1.7" fill="#22d3ee" />
              <circle cx="48" cy="21" r="1.7" fill="#22d3ee" />
              <path d="M38 28c2.4 2.6 7.6 2.6 10 0" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" />
              <circle cx="46" cy="32" r="1.6" fill="#8b5cf6" />
            </svg>
          </span>
          <div className="lx-cookie-copy">
            <strong>We use cookies</strong>
            <span>
              to give you a better experience. By using our website you agree to{" "}
              <a href="/privacy">our policies</a>.
            </span>
            <button type="button" className="lx-cookie-manage" onClick={() => openCookieSettings()}>
              Manage preferences
            </button>
          </div>
          <div className="lx-cookie-actions">
            <button type="button" className="lx-cookie-btn gold" onClick={() => decide(true)}>
              Sweet!
            </button>
            <button type="button" className="lx-cookie-btn ghost" onClick={() => decide(false)}>
              Sorry, I&apos;m on a diet
            </button>
          </div>
        </div>
      ) : null}

      {showModal ? (
        <div className="lx-cookie-scrim" role="presentation" onClick={() => setShowModal(false)}>
          <div
            className="lx-cookie-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="lx-cookie-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="lx-cookie-title">Cookie preferences</h2>
            <p className="lx-cookie-lead">
              Choose which cookies Sutra may use. Your choice is stored on this device and can be changed any
              time from the footer.
            </p>

            <div className="lx-cookie-row">
              <div>
                <b>Essential</b>
                <em>Required for security, session integrity and core functionality. Always on.</em>
              </div>
              <span className="lx-cookie-switch on disabled" aria-hidden="true">
                <i />
              </span>
            </div>

            <div className="lx-cookie-row">
              <div>
                <b>Analytics</b>
                <em>Anonymous, aggregate usage insight to improve the product. Off by default.</em>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={analytics}
                aria-label="Analytics cookies"
                className={"lx-cookie-switch" + (analytics ? " on" : "")}
                onClick={() => setAnalytics((value) => !value)}
              >
                <i />
              </button>
            </div>

            <div className="lx-cookie-modal-actions">
              <button type="button" className="lx-cookie-btn ghost" onClick={() => decide(false)}>
                Reject all
              </button>
              <button type="button" className="lx-cookie-btn solid" onClick={saveSettings}>
                Save preferences
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
