"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { postAuth, readAuthResponse } from "../components/use-session";
import { CustomerAssignments } from "./customer-assignments";

interface Invitation {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly scopeMode: string;
  readonly expiresAt: string;
  readonly status: "pending" | "accepted" | "revoked" | "expired";
  readonly createdAt: string;
}

interface CreateResult {
  readonly invitation: Invitation;
  readonly activationUrl: string;
  readonly activationUrlShownOnce: true;
}

interface ManagedSession {
  readonly id: string;
  readonly user: { readonly id: string; readonly email: string; readonly displayName: string };
  readonly identitySourceLabel: string;
  readonly deviceLabel: "Browser session";
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly mfaVerifiedAt: string | null;
  readonly current: boolean;
  readonly status: "active" | "expired" | "revoked";
}

export function AccessBrowser() {
  const [invitations, setInvitations] = useState<readonly Invitation[]>([]);
  const [sessions, setSessions] = useState<readonly ManagedSession[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [scopeMode, setScopeMode] = useState("assigned_customers");
  const [lifetimeHours, setLifetimeHours] = useState("24");
  const [totpCode, setTotpCode] = useState("");
  const [activationUrl, setActivationUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [invitationResponse, sessionResponse] = await Promise.all([
      fetch("/api/v1/invitations", { cache: "no-store", credentials: "same-origin" }),
      fetch("/api/v1/sessions", { cache: "no-store", credentials: "same-origin" }),
    ]);
    const [invitationBody, sessionBody] = await Promise.all([
      readAuthResponse<{ invitations: readonly Invitation[] }>(invitationResponse),
      readAuthResponse<{ sessions: readonly ManagedSession[] }>(sessionResponse),
    ]);
    setInvitations(invitationBody.invitations);
    setSessions(sessionBody.sessions);
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([
      fetch("/api/v1/invitations", { cache: "no-store", credentials: "same-origin" })
        .then((response) => readAuthResponse<{ invitations: readonly Invitation[] }>(response)),
      fetch("/api/v1/sessions", { cache: "no-store", credentials: "same-origin" })
        .then((response) => readAuthResponse<{ sessions: readonly ManagedSession[] }>(response)),
    ])
      .then(([invitationBody, sessionBody]) => {
        if (active) {
          setInvitations(invitationBody.invitations);
          setSessions(sessionBody.sessions);
        }
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "Sutra could not load invitations");
      }).finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setActivationUrl(null);
    try {
      if (totpCode.length === 6) {
        await postAuth("/api/auth/mfa/step-up", { code: totpCode });
      }
      const created = await postAuth<CreateResult>("/api/v1/invitations", {
        email,
        role,
        scopeMode,
        lifetimeHours: Number(lifetimeHours),
      });
      setActivationUrl(created.activationUrl);
      setEmail("");
      setTotpCode("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sutra could not create the invitation");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(invitationId: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (totpCode.length === 6) await postAuth("/api/auth/mfa/step-up", { code: totpCode });
      const response = await fetch("/api/v1/invitations", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invitationId }),
      });
      await readAuthResponse<{ revoked: true }>(response);
      setTotpCode("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sutra could not revoke the invitation");
    } finally {
      setBusy(false);
    }
  }

  async function stepUpIfProvided(): Promise<void> {
    if (totpCode.length === 6) await postAuth("/api/auth/mfa/step-up", { code: totpCode });
  }

  async function revokeSession(session: ManagedSession): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await stepUpIfProvided();
      const response = await fetch("/api/v1/sessions", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: session.id }),
      });
      const result = await readAuthResponse<{ revoked: boolean; signedOut: boolean }>(response);
      setTotpCode("");
      if (result.signedOut) {
        window.location.replace("/login");
        return;
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sutra could not revoke the session");
    } finally {
      setBusy(false);
    }
  }

  async function revokeOtherSessions(): Promise<void> {
    if (!window.confirm("Revoke every other active session in your organization? Users will need to sign in again.")) return;
    setBusy(true);
    setError(null);
    try {
      await stepUpIfProvided();
      await postAuth<{ revoked: number }>("/api/v1/sessions", {
        operation: "revoke_other_sessions",
        confirmation: "REVOKE OTHER SESSIONS",
      });
      setTotpCode("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sutra could not revoke the other sessions");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Identity administration</p>
          <h1>Access & invitations</h1>
          <p className="page-subtitle">Provision exact organization memberships without email-domain trust or self-service account creation.</p>
        </div>
      </section>

      <div className="trust-strip" role="note">
        <span className="trust-icon">✓</span>
        <span><strong>Single-use activation.</strong> Sutra stores only a digest of each invitation token, requires an exact verified email match, and records immutable create, accept and revoke events.</span>
      </div>

      {error ? <div className="page-alert page-alert-error" role="alert"><strong>Access action failed</strong><span>{error}</span></div> : null}

      <CustomerAssignments />

      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">New membership</p><h2>Invite an operator or customer user</h2></div><span className="status-pill status-positive">MFA protected</span></div>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <div className="auth-field-pair">
            <label><span>Verified email</span><input type="email" maxLength={254} required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <label><span>Role</span><select value={role} onChange={(event) => setRole(event.target.value)}><option value="org_admin">Organization admin</option><option value="analyst">Analyst</option><option value="viewer">Viewer</option><option value="customer_admin">Customer admin</option><option value="customer_viewer">Customer viewer</option></select></label>
          </div>
          <div className="auth-field-pair">
            <label><span>Customer scope</span><select value={scopeMode} onChange={(event) => setScopeMode(event.target.value)}><option value="assigned_customers">Assigned customers only</option><option value="all_customers">All customers</option></select></label>
            <label><span>Expires after</span><select value={lifetimeHours} onChange={(event) => setLifetimeHours(event.target.value)}><option value="1">1 hour</option><option value="24">24 hours</option><option value="72">3 days</option><option value="168">7 days</option></select></label>
          </div>
          <label><span>Authenticator code for this privileged action</span><input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={totpCode} onChange={(event) => setTotpCode(event.target.value.replace(/\D/gu, "").slice(0, 6))} /><small>Required when your last MFA verification is more than five minutes old.</small></label>
          <button className="button button-primary" disabled={busy} type="submit">{busy ? "Creating invitation…" : "Create secure invitation"}</button>
        </form>
        {activationUrl ? <div className="page-alert"><strong>Copy this activation URL now</strong><span>The plaintext token will not be shown again.</span><input aria-label="One-time activation URL" readOnly value={activationUrl} onFocus={(event) => event.currentTarget.select()} /></div> : null}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div><p className="eyebrow">Session administration</p><h2>Signed-in browser sessions</h2></div>
          <button className="button button-secondary button-small" disabled={busy || sessions.filter((session) => session.status === "active" && !session.current).length === 0} onClick={() => void revokeOtherSessions()} type="button">Revoke all other org sessions</button>
        </div>
        <p className="limitation-note">Each row is a server-side session, not a fingerprint of a physical device. Sutra does not retain raw IP addresses or browser fingerprints. Revocation is organization-scoped, MFA-protected, and committed with hash-chained audit evidence.</p>
        {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading active sessions…</div> : (
          <div className="data-table">
            <div className="data-row data-header"><span>User / session</span><span>Identity source</span><span>Status</span><span>Last verified activity</span><span>Action</span></div>
            {sessions.map((session) => <div className="data-row" key={session.id}>
              <span className="primary-cell"><strong>{session.user.displayName}{session.current ? " · This browser" : ""}</strong><small>{session.user.email} · {session.id}</small></span>
              <span className="primary-cell"><strong>{session.identitySourceLabel}</strong><small>{session.deviceLabel} · MFA {session.mfaVerifiedAt === null ? "not verified" : "verified"}</small></span>
              <span><span className={`connection-status connection-${session.status === "active" ? "active" : "disabled"}`}>{session.status}</span></span>
              <span className="primary-cell"><strong>{new Date(session.lastSeenAt).toLocaleString()}</strong><small>Expires {new Date(session.expiresAt).toLocaleString()}</small></span>
              <span>{session.status === "active" ? <button className="button button-ghost" disabled={busy} onClick={() => void revokeSession(session)} type="button">{session.current ? "Sign out" : "Revoke"}</button> : "—"}</span>
            </div>)}
            {sessions.length === 0 ? <div className="empty-row">No organization-scoped sessions were found.</div> : null}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">Membership activation queue</p><h2>Invitations</h2></div><span className="status-pill">{invitations.length} recorded</span></div>
        {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading invitation history…</div> : (
          <div className="data-table">
            <div className="data-row data-header"><span>Email</span><span>Role / scope</span><span>Status</span><span>Expiry</span><span>Action</span></div>
            {invitations.map((invitation) => <div className="data-row" key={invitation.id}>
              <span className="primary-cell"><strong>{invitation.email}</strong><small>{invitation.id}</small></span>
              <span className="primary-cell"><strong>{invitation.role.replaceAll("_", " ")}</strong><small>{invitation.scopeMode.replaceAll("_", " ")}</small></span>
              <span><span className={`connection-status connection-${invitation.status === "pending" ? "active" : invitation.status === "accepted" ? "active" : "disabled"}`}>{invitation.status}</span></span>
              <span>{new Date(invitation.expiresAt).toLocaleString()}</span>
              <span>{invitation.status === "pending" ? <button className="button button-ghost" disabled={busy} onClick={() => void revoke(invitation.id)} type="button">Revoke</button> : "—"}</span>
            </div>)}
            {invitations.length === 0 ? <div className="empty-row">No invitations have been created.</div> : null}
          </div>
        )}
      </section>
    </>
  );
}
