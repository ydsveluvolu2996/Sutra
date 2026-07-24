"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";

import { postAuth } from "../components/use-session";
import TurnstileWidget from "../components/turnstile-widget";
import { TURNSTILE_ACTIONS } from "../../lib/turnstile-contract";

function tokenFromLocation(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

export default function ResetPasswordPage() {
  const [token] = useState(tokenFromLocation);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(
    token ? null : "This password reset link is invalid or expired",
  );
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileReady, setTurnstileReady] = useState(false);
  const [turnstileReset, setTurnstileReset] = useState(0);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token) return;
    if (password !== confirm) {
      setError("The two passwords do not match");
      return;
    }
    if (!turnstileReady) {
      setError("Complete the security check before changing your password");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await postAuth<{ reset: true }>("/api/auth/password-reset/complete", {
        token,
        password,
        turnstileToken: turnstileToken ?? "",
      });
      setPassword("");
      setConfirm("");
      setDone(true);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Sutra could not reset this password",
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
          <span className="auth-eyebrow">Single-use recovery</span>
          <h1 className="auth-headline">Choose a new secure password</h1>
          <p className="auth-subhead">
            Completing this reset revokes existing browser sessions. Your
            authenticator remains required on the next sign-in.
          </p>
        </div>
        <ul className="auth-assurances" aria-label="Password reset security properties">
          <li><span>✓</span> Minimum 14-character password</li>
          <li><span>✓</span> All active sessions revoked</li>
          <li><span>✓</span> MFA verification still required</li>
        </ul>
      </section>

      <section className="auth-form-panel">
        <div className="auth-form-card">
          <div className="auth-heading">
            <span>Account recovery</span>
            <h2>Reset your password</h2>
            <p>Use 14–128 characters. The reset link can be used only once.</p>
          </div>
          {done ? (
            <div className="auth-success" role="status">
              <strong>Password updated</strong>
              <p>Your existing sessions were revoked. Sign in with the new password and your authenticator code.</p>
              <Link className="button button-primary auth-submit" href="/login">Continue to sign in</Link>
            </div>
          ) : (
            <form className="auth-form" onSubmit={(event) => void submit(event)}>
              <label>
                <span>New password</span>
                <input
                  autoComplete="new-password"
                  maxLength={128}
                  minLength={14}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  type="password"
                  value={password}
                />
              </label>
              <label>
                <span>Confirm new password</span>
                <input
                  autoComplete="new-password"
                  maxLength={128}
                  minLength={14}
                  onChange={(event) => setConfirm(event.target.value)}
                  required
                  type="password"
                  value={confirm}
                />
              </label>
              {token ? (
                <TurnstileWidget
                  action={TURNSTILE_ACTIONS.passwordResetComplete}
                  resetSignal={turnstileReset}
                  onChange={(challengeToken, ready) => {
                    setTurnstileToken(challengeToken);
                    setTurnstileReady(ready);
                  }}
                />
              ) : null}
              {error ? <p className="auth-error" role="alert">{error}</p> : null}
              <button className="button button-primary auth-submit" disabled={busy || !turnstileReady || !token} type="submit">
                {busy ? "Updating securely…" : "Reset password"}
              </button>
              <p className="auth-help"><Link href="/forgot-password">Request a new reset link</Link></p>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
