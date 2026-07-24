"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import type { PublicLocalSession } from "../../db/auth-repository";
import { AuthRequestError, postAuth, readAuthResponse } from "../components/use-session";
import TurnstileWidget from "../components/turnstile-widget";
import { TURNSTILE_ACTIONS } from "../../lib/turnstile-contract";

type Phase = "checking" | "ready" | "invalid" | "done";

interface Preview {
  readonly email: string;
  readonly organizationName: string;
}

function tokenFromLocation(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

export default function AcceptInvitePage() {
  const [token] = useState(tokenFromLocation);
  const [phase, setPhase] = useState<Phase>(() => (token ? "checking" : "invalid"));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileReady, setTurnstileReady] = useState(false);
  const [turnstileReset, setTurnstileReset] = useState(0);

  useEffect(() => {
    let active = true;
    if (!token) return;
    void fetch(`/api/auth/invitations/accept?token=${encodeURIComponent(token)}`, {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then((response) => readAuthResponse<Preview>(response))
      .then((body) => {
        if (!active) return;
        setPreview(body);
        setPhase("ready");
      })
      .catch(() => {
        if (active) setPhase("invalid");
      });
    return () => {
      active = false;
    };
  }, [token]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("The two passwords do not match");
      return;
    }
    if (!turnstileReady) {
      setError("Complete the security check before accepting the invitation");
      return;
    }
    setBusy(true);
    try {
      const result = await postAuth<{ session: PublicLocalSession; mfaEnrollmentRequired: boolean }>(
        "/api/auth/invitations/accept",
        { token, password, displayName, turnstileToken: turnstileToken ?? "" },
      );
      setPhase("done");
      // A freshly accepted account has no confirmed MFA yet (mfaEnrollmentRequired
      // is always true here) — hand off to the existing enrollment flow, which is
      // mandatory before any workspace data.
      void result;
      window.location.replace(`/mfa/setup?returnTo=${encodeURIComponent("/dashboard")}`);
    } catch (caught) {
      setError(
        caught instanceof AuthRequestError || caught instanceof Error
          ? caught.message
          : "Sutra could not accept this invitation",
      );
      setBusy(false);
      setTurnstileToken(null);
      setTurnstileReady(false);
      setTurnstileReset((current) => current + 1);
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
          <span className="auth-eyebrow">You&apos;ve been invited</span>
          <h1 className="auth-headline">Set up your Sutra access</h1>
          <p className="auth-subhead">
            Choose a password, then enroll multi-factor authentication. You&apos;ll only ever see the workspace
            you were invited to.
          </p>
        </div>
        <ul className="auth-assurances" aria-label="Security properties">
          <li><span>✓</span> Credentials sent only over TLS to this workspace</li>
          <li><span>✓</span> MFA required before any workspace data</li>
          <li><span>✓</span> Scoped to your organization only</li>
        </ul>
      </section>

      <section className="auth-form-panel">
        <div className="auth-form-card">
          {phase === "checking" ? (
            <div className="auth-loading" role="status">
              <span className="auth-spinner" aria-hidden="true" />
              <p>Checking your invitation…</p>
            </div>
          ) : phase === "invalid" ? (
            <div className="auth-form-head">
              <h2>This invitation can&apos;t be used</h2>
              <p>It may have expired, already been used, or been revoked. Ask your administrator for a new one.</p>
              <p><Link href="/login">Return to sign in</Link></p>
            </div>
          ) : phase === "done" ? (
            <div className="auth-loading" role="status">
              <span className="auth-spinner" aria-hidden="true" />
              <p>Account created — setting up multi-factor authentication…</p>
            </div>
          ) : (
            <form className="auth-form" onSubmit={submit}>
              <div className="auth-form-head">
                <h2>Accept your invitation</h2>
                {preview ? (
                  <p>
                    Joining <strong>{preview.organizationName}</strong> as <strong>{preview.email}</strong>.
                  </p>
                ) : null}
              </div>
              <label className="auth-field">
                <span>Your full name</span>
                <input
                  type="text"
                  autoComplete="name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  required
                  minLength={2}
                  maxLength={80}
                />
              </label>
              <label className="auth-field">
                <span>Create a password</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={14}
                  maxLength={128}
                />
              </label>
              <label className="auth-field">
                <span>Confirm password</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  required
                  minLength={14}
                  maxLength={128}
                />
              </label>
              <p className="auth-hint">Use at least 14 characters. You&apos;ll set up an authenticator app next.</p>
              <TurnstileWidget
                action={TURNSTILE_ACTIONS.acceptInvitation}
                resetSignal={turnstileReset}
                onChange={(challengeToken, ready) => {
                  setTurnstileToken(challengeToken);
                  setTurnstileReady(ready);
                }}
              />
              {error ? <p className="auth-error" role="alert">{error}</p> : null}
              <button className="auth-submit" type="submit" disabled={busy || !turnstileReady}>
                {busy ? "Creating your account…" : "Continue securely"}
              </button>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
