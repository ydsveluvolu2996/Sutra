"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { postAuth, readAuthResponse, useSession } from "../components/use-session";
import { CustomerAssignments } from "./customer-assignments";

interface AssignableCustomer {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

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
  const { session } = useSession();
  const capabilities = new Set(session?.capabilities ?? []);
  // A customer administrator only holds the customer-scoped capability. Its view
  // is restricted to inviting/assigning within the customers it administers, and
  // it never sees the org-wide session administration surface.
  const customerScoped = capabilities.has("membership:manage:customer") && !capabilities.has("membership:manage");

  const [invitations, setInvitations] = useState<readonly Invitation[]>([]);
  const [sessions, setSessions] = useState<readonly ManagedSession[]>([]);
  const [customers, setCustomers] = useState<readonly AssignableCustomer[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [customerId, setCustomerId] = useState("");
  const [scopeMode, setScopeMode] = useState("assigned_customers");
  const [lifetimeHours, setLifetimeHours] = useState("24");
  const [totpCode, setTotpCode] = useState("");
  const [activationUrl, setActivationUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A customer administrator may only ever send a customer-level role; clamp the
  // form value so the select can never carry an organization role for them.
  const effectiveRole = customerScoped && role !== "customer_admin" && role !== "customer_viewer" ? "customer_viewer" : role;
  const effectiveScopeMode = customerScoped ? "assigned_customers" : scopeMode;

  const load = useCallback(async () => {
    const invitationResponse = await fetch("/api/v1/invitations", { cache: "no-store", credentials: "same-origin" });
    setInvitations((await readAuthResponse<{ invitations: readonly Invitation[] }>(invitationResponse)).invitations);
    if (customerScoped) {
      setSessions([]);
      return;
    }
    const sessionResponse = await fetch("/api/v1/sessions", { cache: "no-store", credentials: "same-origin" });
    setSessions((await readAuthResponse<{ sessions: readonly ManagedSession[] }>(sessionResponse)).sessions);
  }, [customerScoped]);

  useEffect(() => {
    let active = true;
    const invitations = fetch("/api/v1/invitations", { cache: "no-store", credentials: "same-origin" })
      .then((response) => readAuthResponse<{ invitations: readonly Invitation[] }>(response));
    const sessions = customerScoped
      ? Promise.resolve<{ sessions: readonly ManagedSession[] }>({ sessions: [] })
      : fetch("/api/v1/sessions", { cache: "no-store", credentials: "same-origin" })
        .then((response) => readAuthResponse<{ sessions: readonly ManagedSession[] }>(response));
    const customers = customerScoped
      ? fetch("/api/v1/customer-assignments", { cache: "no-store", credentials: "same-origin" })
        .then((response) => readAuthResponse<{ customers: readonly AssignableCustomer[] }>(response))
      : Promise.resolve<{ customers: readonly AssignableCustomer[] }>({ customers: [] });
    void Promise.all([invitations, sessions, customers])
      .then(([invitationBody, sessionBody, customerBody]) => {
        if (!active) return;
        setInvitations(invitationBody.invitations);
        setSessions(sessionBody.sessions);
        setCustomers(customerBody.customers);
        setCustomerId((current) => current || customerBody.customers[0]?.id || "");
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "Sutra could not load invitations");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [customerScoped]);

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
        role: effectiveRole,
        scopeMode: effectiveScopeMode,
        lifetimeHours: Number(lifetimeHours),
        ...(customerScoped ? { customerId } : {}),
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
          <p className="page-subtitle">{customerScoped ? "Invite teammates and assign their access, scoped to the customers you administer." : "Provision exact organization memberships without email-domain trust or self-service account creation."}</p>
        </div>
      </section>

      <div className="trust-strip" role="note">
        <span className="trust-icon">✓</span>
        <span><strong>Single-use activation.</strong> Sutra stores only a digest of each invitation token, requires an exact verified email match, and records immutable create, accept and revoke events.</span>
      </div>

      {error ? <div className="page-alert page-alert-error" role="alert"><strong>Access action failed</strong><span>{error}</span></div> : null}

      <CustomerAssignments />

      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">New membership</p><h2>{customerScoped ? "Invite a teammate to a customer you administer" : "Invite an operator or customer user"}</h2></div><span className="status-pill status-positive">MFA protected</span></div>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <div className="auth-field-pair">
            <label><span>Verified email</span><input type="email" maxLength={254} required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <label><span>Role</span><select value={effectiveRole} onChange={(event) => setRole(event.target.value)}>
              {customerScoped ? null : <option value="org_admin">Organization admin</option>}
              {customerScoped ? null : <option value="analyst">Analyst</option>}
              {customerScoped ? null : <option value="viewer">Viewer</option>}
              <option value="customer_admin">Customer admin</option>
              <option value="customer_viewer">Customer viewer</option>
            </select></label>
          </div>
          <div className="auth-field-pair">
            {customerScoped
              ? <label><span>Customer</span><select required value={customerId} onChange={(event) => setCustomerId(event.target.value)}>{customers.length === 0 ? <option value="">No administered customers</option> : customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>
              : <label><span>Customer scope</span><select value={scopeMode} onChange={(event) => setScopeMode(event.target.value)}><option value="assigned_customers">Assigned customers only</option><option value="all_customers">All customers</option></select></label>}
            <label><span>Expires after</span><select value={lifetimeHours} onChange={(event) => setLifetimeHours(event.target.value)}><option value="1">1 hour</option><option value="24">24 hours</option><option value="72">3 days</option><option value="168">7 days</option></select></label>
          </div>
          <label><span>Authenticator code for this privileged action</span><input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={totpCode} onChange={(event) => setTotpCode(event.target.value.replace(/\D/gu, "").slice(0, 6))} /><small>Required when your last MFA verification is more than five minutes old.</small></label>
          <button className="button button-primary" disabled={busy} type="submit">{busy ? "Creating invitation…" : "Create secure invitation"}</button>
        </form>
        {activationUrl ? <div className="page-alert"><strong>Copy this activation URL now</strong><span>The plaintext token will not be shown again.</span><input aria-label="One-time activation URL" readOnly value={activationUrl} onFocus={(event) => event.currentTarget.select()} /></div> : null}
      </section>

      {customerScoped ? null : (
      <section className="panel">
        <div className="panel-heading">
          <div><p className="eyebrow">Session administration</p><h2>Signed-in browser sessions</h2></div>
          <button className="button button-secondary button-small" disabled={busy || sessions.filter((managed) => managed.status === "active" && !managed.current).length === 0} onClick={() => void revokeOtherSessions()} type="button">Revoke all other org sessions</button>
        </div>
        <p className="limitation-note">Each row is a server-side session, not a fingerprint of a physical device. Sutra does not retain raw IP addresses or browser fingerprints. Revocation is organization-scoped, MFA-protected, and committed with hash-chained audit evidence.</p>
        {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading active sessions…</div> : (
          <div className="data-table">
            <div className="data-row data-header"><span>User / session</span><span>Identity source</span><span>Status</span><span>Last verified activity</span><span>Action</span></div>
            {sessions.map((managed) => <div className="data-row" key={managed.id}>
              <span className="primary-cell"><strong>{managed.user.displayName}{managed.current ? " · This browser" : ""}</strong><small>{managed.user.email} · {managed.id}</small></span>
              <span className="primary-cell"><strong>{managed.identitySourceLabel}</strong><small>{managed.deviceLabel} · MFA {managed.mfaVerifiedAt === null ? "not verified" : "verified"}</small></span>
              <span><span className={`connection-status connection-${managed.status === "active" ? "active" : "disabled"}`}>{managed.status}</span></span>
              <span className="primary-cell"><strong>{new Date(managed.lastSeenAt).toLocaleString()}</strong><small>Expires {new Date(managed.expiresAt).toLocaleString()}</small></span>
              <span>{managed.status === "active" ? <button className="button button-ghost" disabled={busy} onClick={() => void revokeSession(managed)} type="button">{managed.current ? "Sign out" : "Revoke"}</button> : "—"}</span>
            </div>)}
            {sessions.length === 0 ? <div className="empty-row">No organization-scoped sessions were found.</div> : null}
          </div>
        )}
      </section>
      )}

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
