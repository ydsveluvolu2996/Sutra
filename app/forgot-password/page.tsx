"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";

import { postAuth } from "../components/use-session";
import TurnstileWidget from "../components/turnstile-widget";
import { TURNSTILE_ACTIONS } from "../../lib/turnstile-contract";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileReady, setTurnstileReady] = useState(false);
  const [turnstileReset, setTurnstileReset] = useState(0);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!turnstileReady) {
      setError("Complete the security check before requesting a reset link");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await postAuth<{ accepted: true; message: string }>(
        "/api/auth/password-reset/request",
        { email, turnstileToken: turnstileToken ?? "" },
      );
      setDone(true);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Sutra could not process the password reset request",
      );
      setTurnstileToken(null);
      setTurnstileReady(false);
      setTurnstileReset((current) => current + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-brand-panel">
        <div className="auth-grid" aria-hidden="true" />
        <Link className="auth-brand" href="/" aria-label="Sutra home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>Sutra</strong><small>Cloud security, woven together</small></span>
        </Link>
        <div className="auth-brand-copy">
          <span className="auth-eyebrow">Protected account recovery</span>
          <h1 className="auth-headline">Recover access without weakening it</h1>
          <p className="auth-subhead">
            Reset links are single-use, expire after 30 minutes, and revoke every
            active session when the password changes.
          </p>
        </div>
        <ul className="auth-assurances" aria-label="Recovery security properties">
          <li><span>✓</span> Account existence is never disclosed</li>
          <li><span>✓</span> Existing MFA remains mandatory</li>
          <li><span>✓</span> Reset tokens are stored only as digests</li>
        </ul>
      </section>

      <section className="auth-form-panel">
        <div className="auth-form-card">
          <div className="auth-heading">
            <span>Account recovery</span>
            <h2>Forgot your password?</h2>
            <p>Enter your Sutra email address. If it matches an active account, we will send a secure reset link.</p>
          </div>
          {done ? (
            <div className="auth-success" role="status">
              <strong>Check your email</strong>
              <p>If an active account matches that address, a single-use reset link has been sent.</p>
              <Link className="button button-primary auth-submit" href="/login">Return to sign in</Link>
            </div>
          ) : (
            <form className="auth-form" onSubmit={(event) => void submit(event)}>
              <label>
                <span>Email</span>
                <input
                  autoComplete="username"
                  maxLength={254}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  type="email"
                  value={email}
                />
              </label>
              <TurnstileWidget
                action={TURNSTILE_ACTIONS.passwordResetRequest}
                resetSignal={turnstileReset}
                onChange={(token, ready) => {
                  setTurnstileToken(token);
                  setTurnstileReady(ready);
                  if (ready) setError(null);
                }}
              />
              {error ? <p className="auth-error" role="alert">{error}</p> : null}
              <button className="button button-primary auth-submit" disabled={busy || !turnstileReady} type="submit">
                {busy ? "Sending securely…" : "Send reset link"}
              </button>
              <p className="auth-help"><Link href="/login">Return to sign in</Link></p>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
