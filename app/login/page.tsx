"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import type { PublicLocalSession } from "../../db/auth-repository";
import {
  AuthRequestError,
  postAuth,
  readAuthResponse,
  safeReturnTo,
  useSession,
} from "../components/use-session";

type AuthMode = "checking" | "bootstrap" | "login";

interface LoginResult {
  readonly session: PublicLocalSession;
  readonly mfaEnrollmentRequired: boolean;
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/auth/bootstrap", { cache: "no-store", credentials: "same-origin" })
      .then((response) => readAuthResponse<{ bootstrapRequired: boolean }>(response))
      .then((body) => {
        if (active) setMode(body.bootstrapRequired ? "bootstrap" : "login");
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "Sutra could not check the local workspace");
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
    setBusy(true);
    setError(null);
    try {
      const result = await postAuth<LoginResult>("/api/auth/login", {
        email,
        password,
        ...(mfaRequired ? { totpCode } : {}),
      });
      redirectFor(result.session, safeReturnTo(window.location.search));
    } catch (caught) {
      if (caught instanceof AuthRequestError && caught.code === "MFA_REQUIRED") {
        setMfaRequired(true);
        setTotpCode("");
      }
      setError(caught instanceof Error ? caught.message : "Sutra could not sign in");
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
        <Link className="auth-brand" href="/" aria-label="Sutra home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>Sutra</strong><small>Cloud operations</small></span>
        </Link>
        <div className="auth-brand-copy">
          <span className="auth-eyebrow">Local private beta</span>
          <h1>Your cloud estate, operated from one trustworthy workspace.</h1>
          <p>Local identities, enforced MFA and scoped access protect every customer boundary before inventory or findings are exposed.</p>
        </div>
        <ul className="auth-assurances" aria-label="Local security properties">
          <li><span>01</span> Credentials stay on this machine</li>
          <li><span>02</span> MFA is required before workspace access</li>
          <li><span>03</span> Every server request is authorization checked</li>
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
                {error ? <p className="auth-error" role="alert">{error}</p> : null}
                <button className="button button-primary auth-submit" disabled={busy} type="submit">
                  {busy ? "Verifying…" : mfaRequired ? "Verify and sign in" : "Continue securely"}
                </button>
              </form>
            </>
          )}
          <p className="auth-local-note"><span aria-hidden="true">●</span> Local access only · external sign-in is disabled</p>
        </div>
      </section>
    </main>
  );
}
