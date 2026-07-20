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
        <div className="lx-cookie" role="region" aria-label="Cookie consent">
          <div className="lx-cookie-msg">
            <strong>We use cookies to enhance your experience.</strong>
            <span>
              Essential cookies keep Sutra secure and working. Optional analytics stay off until you turn
              them on. See our <a href="/privacy">Privacy Policy</a>.
            </span>
          </div>
          <div className="lx-cookie-actions">
            <button type="button" className="lx-cookie-btn ghost" onClick={() => setShowModal(true)}>
              Cookie settings
            </button>
            <button type="button" className="lx-cookie-btn ghost" onClick={() => decide(false)}>
              Reject all
            </button>
            <button type="button" className="lx-cookie-btn solid" onClick={() => decide(true)}>
              Accept all
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
