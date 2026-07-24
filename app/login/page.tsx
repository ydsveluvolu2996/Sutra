"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { PublicLocalSession } from "../../db/auth-repository";
import {
  AuthRequestError,
  postAuth,
  readAuthResponse,
  safeReturnTo,
  useSession,
} from "../components/use-session";
import TurnstileWidget from "../components/turnstile-widget";
import { TURNSTILE_ACTIONS } from "../../lib/turnstile-contract";

type AuthMode = "checking" | "bootstrap" | "login" | "hosted";

interface LoginResult {
  readonly session: PublicLocalSession;
  readonly mfaEnrollmentRequired: boolean;
}

const SHOWCASE = [
  {
    tone: "graph",
    title: "Security graph, backed by evidence",
    copy: "Explore every cloud, Kubernetes, identity and network relationship on one canvas — and every edge is a cited observation, not a guess.",
    glyph: (
      <>
        <circle cx="14" cy="34" r="6" /><circle cx="40" cy="18" r="6" /><circle cx="40" cy="50" r="6" /><circle cx="66" cy="34" r="6" />
        <path d="M20 34 34 20M20 34 34 48M46 18 60 32M46 50 60 36" />
      </>
    ),
  },
  {
    tone: "issues",
    title: "The risks that actually matter",
    copy: "Not thousands of CVEs — the handful that are internet-reachable, running, and exploitable, proven with observed network and runtime evidence.",
    glyph: (
      <>
        <path d="M40 12 66 56H14z" /><path d="M40 30v14M40 50h.02" />
      </>
    ),
  },
  {
    tone: "ciem",
    title: "What every identity can reach",
    copy: "Resolve a workload's effective permissions and follow its IRSA role into AWS — can this pod read Secrets, or delete a bucket?",
    glyph: (
      <>
        <circle cx="26" cy="42" r="12" /><path d="m34 34 26-26" /><path d="m50 8 8 8M56 4 66 14" />
      </>
    ),
  },
  {
    tone: "trends",
    title: "A score you can resell",
    copy: "Track each customer's security posture over time, catch regressions the moment they land, and export the report an MSP hands over.",
    glyph: (
      <>
        <path d="M12 52 30 34l12 10L68 16" /><path d="M52 16h16v16" />
      </>
    ),
  },
  {
    tone: "drift",
    title: "Drift and new CVEs, the moment they appear",
    copy: "See a workload that drifted from its admitted spec, or an image that gained a vulnerability since the last scan — then generate the fix.",
    glyph: (
      <>
        <path d="M40 12v20M30 22h20" /><path d="M18 42h44" /><path d="M26 52h28" />
      </>
    ),
  },
] as const;

function LoginShowcase() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % SHOWCASE.length), 4600);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="login-showcase" aria-live="polite">
      <div className="login-showcase-stage">
        {SHOWCASE.map((feature, position) => (
          <article
            key={feature.tone}
            className={`login-feature login-feature-${feature.tone}${position === index ? " is-active" : ""}`}
            aria-hidden={position !== index}
          >
            <span className="login-feature-icon">
              <svg viewBox="0 0 80 68" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {feature.glyph}
              </svg>
            </span>
            <h2>{feature.title}</h2>
            <p>{feature.copy}</p>
          </article>
        ))}
      </div>
      <div className="login-showcase-dots" role="tablist" aria-label="Sutra capabilities">
        {SHOWCASE.map((feature, position) => (
          <button
            key={feature.tone}
            type="button"
            role="tab"
            aria-selected={position === index}
            aria-label={feature.title}
            className={position === index ? "is-active" : undefined}
            onClick={() => setIndex(position)}
          />
        ))}
      </div>
    </div>
  );
}

function redirectFor(session: PublicLocalSession, returnTo: string): void {
  if (!session.mfa.enrolled || !session.mfa.verified) {
    window.location.replace(`/mfa/setup?returnTo=${encodeURIComponent(returnTo)}`);
    return;
  }
  window.location.replace(returnTo);
}

export default function LoginPage() {
  const currentSession = useSession();
  const [mode, setMode] = useState<AuthMode>("checking");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [mfaRequired, setMfaRequired] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [organizationName, setOrganizationName] = useState("Sutra MSP");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [identityMode, setIdentityMode] = useState<"local" | "password">("local");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileReady, setTurnstileReady] = useState(false);
  const [turnstileReset, setTurnstileReset] = useState(0);
  const turnstileErrorVisible = useRef(false);
  const [returnTo] = useState(() =>
    typeof window === "undefined" ? "/dashboard" : safeReturnTo(window.location.search),
  );

  useEffect(() => {
    let active = true;
    void fetch("/api/auth/bootstrap", { cache: "no-store", credentials: "same-origin" })
      .then((response) => readAuthResponse<{ bootstrapRequired: boolean; identityMode?: "local" | "password" }>(response))
      .then((body) => {
        if (!active) return;
        setIdentityMode(body.identityMode === "password" ? "password" : "local");
        setMode(body.bootstrapRequired ? "bootstrap" : "login");
      })
      .catch((caught: unknown) => {
        if (!active) return;
        if (caught instanceof AuthRequestError && caught.status === 404) {
          setMode("hosted");
          setError(null);
          return;
        }
        setError(caught instanceof Error ? caught.message : "Sutra could not check the local workspace");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (currentSession.loading || currentSession.session === null) return;
    redirectFor(currentSession.session, safeReturnTo(window.location.search));
  }, [currentSession.loading, currentSession.session]);

  async function submitLogin(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!turnstileReady) {
      turnstileErrorVisible.current = true;
      setError("Complete the security check before signing in");
      return;
    }
    setBusy(true);
    turnstileErrorVisible.current = false;
    setError(null);
    try {
      const result = await postAuth<LoginResult>("/api/auth/login", {
        email,
        password,
        turnstileToken: turnstileToken ?? "",
        ...(mfaRequired ? { totpCode } : {}),
      });
      redirectFor(result.session, safeReturnTo(window.location.search));
    } catch (caught) {
      if (caught instanceof AuthRequestError && caught.code === "MFA_REQUIRED") {
        setMfaRequired(true);
        setTotpCode("");
      }
      turnstileErrorVisible.current =
        caught instanceof AuthRequestError &&
        caught.code.startsWith("TURNSTILE_");
      setError(caught instanceof Error ? caught.message : "Sutra could not sign in");
      setTurnstileToken(null);
      setTurnstileReady(false);
      setTurnstileReset((current) => current + 1);
    } finally {
      setBusy(false);
    }
  }

  async function submitBootstrap(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await postAuth<{ session: PublicLocalSession }>(
        "/api/auth/bootstrap",
        { email, password, displayName, organizationName },
        bootstrapToken,
      );
      redirectFor(result.session, safeReturnTo(window.location.search));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sutra could not initialize the workspace");
    } finally {
      setBusy(false);
    }
  }

  const waiting = mode === "checking" || currentSession.loading;

  return (
    <main className="auth-page">
      <section className="auth-brand-panel">
        <div className="auth-grid" aria-hidden="true" />
        <Link className="auth-brand" href="/" aria-label="Sutra home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>Sutra</strong><small>Cloud security, woven together</small></span>
        </Link>
        <div className="auth-brand-copy">
          <span className="auth-eyebrow">EKS-first CNAPP for managed service providers</span>
          <LoginShowcase />
        </div>
        <ul className="auth-assurances" aria-label="Security properties">
          <li>
            <span>✓</span>{" "}
            {identityMode === "password"
              ? "Credentials sent only over TLS to this workspace"
              : "Credentials never leave this machine"}
          </li>
          <li><span>✓</span> MFA required before any workspace data</li>
          <li><span>✓</span> Every finding traced to cited evidence</li>
        </ul>
      </section>

      <section className="auth-form-panel">
        <div className="auth-form-card">
          {waiting ? (
            <div className="auth-loading" role="status">
              <span className="auth-spinner" aria-hidden="true" />
              <strong>Checking your local workspace</strong>
              <p>Sutra is verifying the encrypted identity store.</p>
            </div>
          ) : mode === "hosted" ? (
            <>
              <div className="auth-heading">
                <span>Enterprise identity</span>
                <h2>Sign in to Sutra</h2>
                <p>Continue through the organization identity service. Sutra accepts only verified, pre-provisioned memberships.</p>
              </div>
              <a
                className="button button-primary auth-submit"
                href={`/api/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`}
              >
                Continue with secure sign-in
              </a>
            </>
          ) : mode === "bootstrap" ? (
            <>
              <div className="auth-heading">
                <span>First-time setup</span>
                <h2>Create the workspace owner</h2>
                <p>This one-time action creates the first local organization, owner identity and protected session.</p>
              </div>
              <form className="auth-form" onSubmit={(event) => void submitBootstrap(event)}>
                <label>
                  <span>Setup token</span>
                  <input
                    autoComplete="off"
                    maxLength={256}
                    onChange={(event) => setBootstrapToken(event.target.value)}
                    required
                    type="password"
                    value={bootstrapToken}
                  />
                  <small>Use the one-time token generated by the local setup command.</small>
                </label>
                <div className="auth-field-pair">
                  <label>
                    <span>Your name</span>
                    <input autoComplete="name" maxLength={80} minLength={2} onChange={(event) => setDisplayName(event.target.value)} required value={displayName} />
                  </label>
                  <label>
                    <span>Organization</span>
                    <input autoComplete="organization" maxLength={100} minLength={2} onChange={(event) => setOrganizationName(event.target.value)} required value={organizationName} />
                  </label>
                </div>
                <label>
                  <span>Owner email</span>
                  <input autoComplete="username" maxLength={254} onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
                </label>
                <label>
                  <span>Password</span>
                  <input autoComplete="new-password" maxLength={128} minLength={14} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} />
                  <small>Use 14–128 characters and do not include the email address.</small>
                </label>
                {error ? <p className="auth-error" role="alert">{error}</p> : null}
                <button className="button button-primary auth-submit" disabled={busy} type="submit">
                  {busy ? "Creating protected workspace…" : "Create owner and continue"}
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="auth-heading">
                <span>Protected workspace</span>
                <h2>Sign in to Sutra</h2>
                <p>Use the local identity created for this installation.</p>
              </div>
              <form className="auth-form" onSubmit={(event) => void submitLogin(event)}>
                <label>
                  <span>Email</span>
                  <input autoComplete="username" maxLength={254} onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
                </label>
                <label>
                  <span>Password</span>
                  <input autoComplete="current-password" maxLength={128} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} />
                </label>
                {mfaRequired ? (
                  <label>
                    <span>Authenticator code</span>
                    <input
                      autoComplete="one-time-code"
                      className="auth-code-input"
                      inputMode="numeric"
                      maxLength={6}
                      minLength={6}
                      onChange={(event) => setTotpCode(event.target.value.replace(/\D/gu, "").slice(0, 6))}
                      pattern="[0-9]{6}"
                      required
                      value={totpCode}
                    />
                    <small>Enter the current six-digit code. A used code cannot be replayed.</small>
                  </label>
                ) : null}
                <TurnstileWidget
                  action={TURNSTILE_ACTIONS.login}
                  resetSignal={turnstileReset}
                  onChange={(token, ready) => {
                    setTurnstileToken(token);
                    setTurnstileReady(ready);
                    if (ready && turnstileErrorVisible.current) {
                      turnstileErrorVisible.current = false;
                      setError(null);
                    }
                  }}
                />
                {error ? <p className="auth-error" role="alert">{error}</p> : null}
                <button className="button button-primary auth-submit" disabled={busy || !turnstileReady} type="submit">
                  {busy ? "Verifying…" : mfaRequired ? "Verify and sign in" : "Continue securely"}
                </button>
              </form>
            </>
          )}
          <p className="auth-local-note">
            <span aria-hidden="true">●</span>
            {mode === "hosted"
              ? " Hosted identity · server-side membership required"
              : identityMode === "password"
                ? " Managed sign-in · password + mandatory MFA, membership provisioned by your operator"
                : " Local access only · external sign-in is disabled"}
          </p>
        </div>
      </section>
    </main>
  );
}
