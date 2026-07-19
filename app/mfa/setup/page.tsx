"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import type { PublicLocalSession } from "../../../db/auth-repository";
import { postAuth, safeReturnTo, useSession } from "../../components/use-session";

interface Enrollment {
  readonly secret: string;
  readonly otpauthUri: string;
}

export default function MfaSetupPage() {
  const { session, loading, error: sessionError } = useSession();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (session === null) {
      const returnTo = `/mfa/setup?returnTo=${encodeURIComponent(safeReturnTo(window.location.search))}`;
      window.location.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }
    if (session.mfa.enrolled && session.mfa.verified) {
      window.location.replace(safeReturnTo(window.location.search));
    }
  }, [loading, session]);

  async function startEnrollment(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await postAuth<{ enrollment: Enrollment }>("/api/auth/mfa/enroll");
      setEnrollment(result.enrollment);
      setCode("");
      setCopied(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sutra could not start MFA enrollment");
    } finally {
      setBusy(false);
    }
  }

  async function copySecret(): Promise<void> {
    if (enrollment === null) return;
    try {
      await navigator.clipboard.writeText(enrollment.secret);
      setCopied(true);
    } catch {
      setError("Copy is unavailable in this browser. Select the key and copy it manually.");
    }
  }

  async function verifyEnrollment(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await postAuth<{ session: PublicLocalSession }>("/api/auth/mfa/verify", { code });
      if (!result.session.mfa.verified) throw new Error("Sutra could not verify this authenticator");
      window.location.replace(safeReturnTo(window.location.search));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sutra could not verify the authenticator code");
    } finally {
      setBusy(false);
    }
  }

  if (loading || session === null || (session.mfa.enrolled && session.mfa.verified)) {
    return (
      <main className="auth-page auth-page-compact">
        <section className="auth-form-panel">
          <div className="auth-form-card">
            <div className="auth-loading" role="status">
              <span className="auth-spinner" aria-hidden="true" />
              <strong>Protecting your session</strong>
              <p>{sessionError ?? "Sutra is checking the MFA state."}</p>
            </div>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <section className="auth-brand-panel mfa-brand-panel">
        <Link className="auth-brand" href="/" aria-label="Sutra home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>Sutra</strong><small>Cloud security</small></span>
        </Link>
        <div className="auth-brand-copy">
          <span className="auth-eyebrow">Required protection</span>
          <h1>Make every operator session two-factor secure.</h1>
          <p>Sutra requires a time-based one-time password before the CMDB, customer inventory or security findings can be opened.</p>
        </div>
        <div className="mfa-steps" aria-label="MFA setup steps">
          <span className="active"><b>1</b> Generate key</span>
          <i aria-hidden="true" />
          <span className={enrollment ? "active" : undefined}><b>2</b> Add to app</span>
          <i aria-hidden="true" />
          <span><b>3</b> Verify code</span>
        </div>
      </section>

      <section className="auth-form-panel">
        <div className="auth-form-card mfa-card">
          <div className="auth-heading">
            <span>Authenticator setup</span>
            <h2>Enable multi-factor authentication</h2>
            <p>Use any authenticator that supports standard TOTP codes. The secret is encrypted before it is stored.</p>
          </div>

          {enrollment === null ? (
            <div className="mfa-start">
              <div className="mfa-lock" aria-hidden="true"><span /></div>
              <h3>Ready to secure {session.user.email}</h3>
              <p>Generating a new key invalidates any unfinished enrollment for this account.</p>
              {error || sessionError ? <p className="auth-error" role="alert">{error ?? sessionError}</p> : null}
              <button className="button button-primary auth-submit" disabled={busy} onClick={() => void startEnrollment()} type="button">
                {busy ? "Generating encrypted key…" : "Generate authenticator key"}
              </button>
            </div>
          ) : (
            <form className="auth-form" onSubmit={(event) => void verifyEnrollment(event)}>
              <div className="mfa-secret-block">
                <span>Manual setup key</span>
                <code>{enrollment.secret}</code>
                <button className="button button-secondary button-small" onClick={() => void copySecret()} type="button">
                  {copied ? "Copied" : "Copy key"}
                </button>
              </div>
              <a className="mfa-deep-link" href={enrollment.otpauthUri}>Open this key in a compatible authenticator</a>
              <ol className="mfa-instructions">
                <li>Add a new time-based account in your authenticator app.</li>
                <li>Enter the key above or use the compatible-app link.</li>
                <li>Enter the current six-digit code below to finish.</li>
              </ol>
              <label>
                <span>Six-digit authenticator code</span>
                <input
                  autoComplete="one-time-code"
                  autoFocus
                  className="auth-code-input"
                  inputMode="numeric"
                  maxLength={6}
                  minLength={6}
                  onChange={(event) => setCode(event.target.value.replace(/\D/gu, "").slice(0, 6))}
                  pattern="[0-9]{6}"
                  required
                  value={code}
                />
              </label>
              {error ? <p className="auth-error" role="alert">{error}</p> : null}
              <button className="button button-primary auth-submit" disabled={busy || code.length !== 6} type="submit">
                {busy ? "Verifying code…" : "Verify MFA and enter workspace"}
              </button>
            </form>
          )}
          <p className="auth-local-note"><span aria-hidden="true">●</span> Your MFA secret is encrypted at rest on this machine</p>
        </div>
      </section>
    </main>
  );
}
