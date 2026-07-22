"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { postAuth, readAuthResponse, useSession } from "../components/use-session";
import { CustomerAssignments } from "./customer-assignments";
import { copyInvitationUrl, invitationEmailHref, shareInvitation } from "./invitation-sharing";

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
  readonly customerId: string | null;
  readonly expiresAt: string;
  readonly status: "pending" | "accepted" | "revoked" | "expired";
  readonly createdAt: string;
  readonly delivery?: InvitationDelivery;
}

interface InvitationDelivery {
  readonly status: "not_attempted" | "sending" | "accepted" | "failed" | "unknown";
  readonly transport: "none" | "email-api";
  readonly provider: "none" | "resend" | "sendgrid" | "generic";
  readonly attempts: number;
  readonly lastAttemptedAt: string | null;
  readonly completedAt: string | null;
  readonly errorCode: string | null;
}

interface CreateResult {
  readonly invitation: Invitation;
  readonly activationUrl?: string;
  readonly activationUrlShownOnce: boolean;
  readonly delivery?: InvitationDelivery;
  readonly replayed: boolean;
}

interface ResendResult {
  readonly invitation: Invitation;
  readonly delivery: InvitationDelivery;
  readonly replayed: boolean;
  readonly activationUrl?: string;
  readonly activationUrlShownOnce: boolean;
}

interface OneTimeInvitation {
  readonly invitation: Invitation;
  readonly activationUrl: string;
  readonly delivery: InvitationDelivery;
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

const EMPTY_DELIVERY: InvitationDelivery = {
  status: "not_attempted",
  transport: "none",
  provider: "none",
  attempts: 0,
  lastAttemptedAt: null,
  completedAt: null,
  errorCode: null,
};

function deliveryNotice(delivery: InvitationDelivery): string {
  switch (delivery.status) {
    case "accepted":
      return "The email provider accepted this message. This confirms provider acceptance, not inbox delivery.";
    case "sending":
      return "Email delivery is in progress. Keep the one-time link available until the delivery status is confirmed.";
    case "failed":
      return "Automatic email delivery failed. Copy or share the one-time link now, or retry delivery from the invitation list.";
    case "unknown":
      return "Email delivery could not be confirmed. Use the one-time link below as a secure fallback.";
    case "not_attempted":
      return "No automatic email was sent. Copy, securely share, or open an email draft with the one-time link below.";
  }
}

function deliveryLabel(delivery: InvitationDelivery | undefined): string {
  switch (delivery?.status ?? "not_attempted") {
    case "accepted": return "Email accepted";
    case "sending": return "Email sending";
    case "failed": return "Email failed";
    case "unknown": return "Delivery unknown";
    case "not_attempted": return "Link only";
  }
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
  const [oneTimeInvitation, setOneTimeInvitation] = useState<OneTimeInvitation | null>(null);
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const creationOperation = useRef<{ readonly key: string; readonly bodyJson: string } | null>(null);
  const resendOperations = useRef(new Map<string, string>());

  // A customer administrator may only ever send a customer-level role; clamp the
  // form value so the select can never carry an organization role for them.
  const effectiveRole = customerScoped && role !== "customer_admin" && role !== "customer_viewer" ? "customer_viewer" : role;
  const effectiveScopeMode = customerScoped ? "assigned_customers" : effectiveRole === "org_admin" ? "all_customers" : scopeMode;
  const selectedCustomerRequired = effectiveScopeMode === "assigned_customers";
  const customerNames = useMemo(
    () => new Map(customers.map((customer) => [customer.id, customer.name])),
    [customers],
  );

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
    const customers = fetch("/api/v1/customer-assignments", { cache: "no-store", credentials: "same-origin" })
      .then((response) => readAuthResponse<{ customers: readonly AssignableCustomer[] }>(response));
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
    let attemptedCreation = false;
    setBusy(true);
    setError(null);
    setNotice(null);
    setShareNotice(null);
    setOneTimeInvitation(null);
    try {
      if (totpCode.length === 6) {
        await postAuth("/api/auth/mfa/step-up", { code: totpCode });
        // A verified TOTP step is single-use. Clear it immediately so an
        // ambiguous invitation response can be retried with the sticky
        // idempotency key without first resubmitting an already-used MFA code.
        setTotpCode("");
      }
      const body = {
        email,
        role: effectiveRole,
        scopeMode: effectiveScopeMode,
        lifetimeHours: Number(lifetimeHours),
        ...(selectedCustomerRequired ? { customerId } : {}),
      };
      const bodyJson = JSON.stringify(body);
      const operation = creationOperation.current?.bodyJson === bodyJson
        ? creationOperation.current
        : { key: crypto.randomUUID(), bodyJson };
      creationOperation.current = operation;
      attemptedCreation = true;
      const response = await fetch("/api/v1/invitations", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": operation.key,
        },
        body: bodyJson,
      });
      const created = await readAuthResponse<CreateResult>(response);
      creationOperation.current = null;
      const delivery = created.delivery ?? created.invitation.delivery ?? EMPTY_DELIVERY;
      if (created.activationUrlShownOnce && created.activationUrl) {
        setOneTimeInvitation({
          invitation: created.invitation,
          activationUrl: created.activationUrl,
          delivery,
        });
        setShareNotice(deliveryNotice(delivery));
      } else {
        setNotice(created.replayed
          ? "The previous creation was confirmed without creating or emailing a duplicate. Its one-time token cannot be displayed again; use Renew or resend from the invitation list if you need a fresh link."
          : deliveryNotice(delivery));
      }
      setEmail("");
      setTotpCode("");
      try {
        await load();
      } catch (caught) {
        setError(caught instanceof Error
          ? `The delivery operation completed, but invitation history could not refresh: ${caught.message}`
          : "The delivery operation completed, but invitation history could not refresh. Reload the page to verify it.");
      }
    } catch (caught) {
      const retryGuidance = attemptedCreation
        ? "Retry this exact invitation safely; Sutra will reuse its idempotency key and will not create or email a duplicate."
        : "No invitation creation request was sent. Complete MFA and try again.";
      setError(caught instanceof Error
        ? `${caught.message}. ${retryGuidance}`
        : `Sutra could not create the invitation. ${retryGuidance}`);
      if (attemptedCreation) {
        try {
          await load();
        } catch {
          // Preserve the original actionable error. The next exact submit safely
          // reuses the same operation key even when history cannot be refreshed.
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function copyCurrentInvitation(): Promise<void> {
    if (oneTimeInvitation === null) return;
    setSharing(true);
    try {
      await copyInvitationUrl(oneTimeInvitation.activationUrl);
      setShareNotice("Activation link copied. Send it only through a channel you trust.");
    } catch (caught) {
      setShareNotice(caught instanceof Error ? caught.message : "Sutra could not copy the activation link");
    } finally {
      setSharing(false);
    }
  }

  async function shareCurrentInvitation(): Promise<void> {
    if (oneTimeInvitation === null) return;
    setSharing(true);
    try {
      const result = await shareInvitation({
        activationUrl: oneTimeInvitation.activationUrl,
        email: oneTimeInvitation.invitation.email,
        expiresAt: oneTimeInvitation.invitation.expiresAt,
      });
      if (result === "shared") setShareNotice("The secure share sheet completed.");
      if (result === "cancelled") setShareNotice("Sharing was cancelled. The one-time link remains available below.");
      if (result === "unsupported") setShareNotice("Secure sharing is unavailable in this browser. Copy the link instead.");
    } catch (caught) {
      setShareNotice(caught instanceof Error ? caught.message : "Sutra could not open the secure share sheet");
    } finally {
      setSharing(false);
    }
  }

  async function resend(invitation: Invitation): Promise<void> {
    let attemptedDelivery = false;
    setBusy(true);
    setError(null);
    setNotice(null);
    setShareNotice(null);
    // Any previously displayed token for this invitation may be invalidated by
    // a successful resend. Remove it before the request so a lost response can
    // never leave a stale activation link on screen.
    setOneTimeInvitation((current) => current?.invitation.id === invitation.id ? null : current);
    try {
      await stepUpIfProvided();
      // TOTP values are single-use. Clear a successfully consumed code before
      // entering the ambiguous delivery window so a retry can safely replay
      // the sticky invitation operation without failing MFA first.
      if (totpCode.length === 6) setTotpCode("");
      const idempotencyKey = resendOperations.current.get(invitation.id) ?? crypto.randomUUID();
      resendOperations.current.set(invitation.id, idempotencyKey);
      attemptedDelivery = true;
      const response = await fetch(`/api/v1/invitations/${encodeURIComponent(invitation.id)}/resend`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ lifetimeHours: Number(lifetimeHours) }),
      });
      const result = await readAuthResponse<ResendResult>(response);
      resendOperations.current.delete(invitation.id);
      if (result.activationUrlShownOnce && result.activationUrl) {
        setOneTimeInvitation({
          invitation: result.invitation,
          activationUrl: result.activationUrl,
          delivery: result.delivery,
        });
        setShareNotice(deliveryNotice(result.delivery));
      } else {
        setNotice(result.replayed
          ? "The previous resend operation was confirmed without sending a duplicate email. Its one-time link cannot be displayed again."
          : deliveryNotice(result.delivery));
      }
      try {
        await load();
      } catch (caught) {
        setError(caught instanceof Error
          ? `The resend completed, but invitation history could not refresh: ${caught.message}`
          : "The resend completed, but invitation history could not refresh. Reload the page to verify it.");
      }
    } catch (caught) {
      // Preserve the operation key across an ambiguous transport failure. The
      // next click safely replays the same request rather than sending twice.
      const retryGuidance = attemptedDelivery
        ? "Retry this delivery action safely; Sutra will reuse its idempotency key."
        : "No delivery request was sent. Complete MFA and try again.";
      setError(caught instanceof Error
        ? `${caught.message}. ${retryGuidance}`
        : `Sutra could not resend the invitation. ${retryGuidance}`);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(invitationId: string): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
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
      setOneTimeInvitation((current) => current?.invitation.id === invitationId ? null : current);
      setShareNotice(null);
      setNotice("Invitation revoked. Any unaccepted activation link for it is no longer valid.");
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
      {notice ? <div className="page-alert" role="status"><strong>Invitation updated</strong><span>{notice}</span><button type="button" onClick={() => setNotice(null)}>Dismiss</button></div> : null}

      <CustomerAssignments />

      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">New membership</p><h2>{customerScoped ? "Invite a teammate to a customer you administer" : "Invite an operator or customer user"}</h2></div><span className="status-pill status-positive">MFA protected</span></div>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <div className="auth-field-pair">
            <label><span>Verified email</span><input type="email" maxLength={254} required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <label><span>Role</span><select value={effectiveRole} onChange={(event) => {
              const nextRole = event.target.value;
              setRole(nextRole);
              if (nextRole === "org_admin") setScopeMode("all_customers");
            }}>
              {customerScoped ? null : <option value="org_admin">Organization admin</option>}
              {customerScoped ? null : <option value="analyst">Analyst</option>}
              {customerScoped ? null : <option value="viewer">Viewer</option>}
              <option value="customer_admin">Customer admin</option>
              <option value="customer_viewer">Customer viewer</option>
            </select></label>
          </div>
          <div className="auth-field-pair">
            <label><span>Customer scope</span><select disabled={customerScoped || effectiveRole === "org_admin"} value={effectiveScopeMode} onChange={(event) => setScopeMode(event.target.value)}><option value="assigned_customers">One assigned customer</option><option value="all_customers">All customers</option></select><small>{effectiveRole === "org_admin" ? "Organization administrators always receive organization-wide access." : customerScoped ? "Your administration rights require one explicit customer." : "Choose the smallest scope this member needs."}</small></label>
            <label><span>Expires after</span><select value={lifetimeHours} onChange={(event) => setLifetimeHours(event.target.value)}><option value="1">1 hour</option><option value="24">24 hours</option><option value="72">3 days</option><option value="168">7 days</option></select></label>
          </div>
          {selectedCustomerRequired ? <label><span>Assigned customer</span><select required value={customerId} onChange={(event) => setCustomerId(event.target.value)}>{customers.length === 0 ? <option value="">No available customers</option> : customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select><small>This invitation creates access only to the selected customer.</small></label> : null}
          <label><span>Authenticator code for this privileged action</span><input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={totpCode} onChange={(event) => setTotpCode(event.target.value.replace(/\D/gu, "").slice(0, 6))} /><small>Required when your last MFA verification is more than five minutes old.</small></label>
          <button className="button button-primary" disabled={busy || (selectedCustomerRequired && !customerId)} type="submit">{busy ? "Creating invitation…" : "Create and deliver invitation"}</button>
          <p className="limitation-note">Automatic email requires a configured transactional email provider. Sutra reports provider acceptance separately from inbox delivery and always shows the new link once for secure manual sharing.</p>
        </form>
        {oneTimeInvitation ? (
          <div className="inline-warning" role="status">
            <strong>One-time activation link for {oneTimeInvitation.invitation.email}</strong>
            <span>{shareNotice ?? deliveryNotice(oneTimeInvitation.delivery)} The plaintext token disappears when you dismiss this panel or leave the page.</span>
            <div className="copy-field"><code aria-label="One-time activation URL">{oneTimeInvitation.activationUrl}</code><button disabled={sharing} onClick={() => void copyCurrentInvitation()} type="button">{sharing ? "Working…" : "Copy link"}</button></div>
            <div className="heading-actions">
              <button className="button button-secondary button-small" disabled={sharing} onClick={() => void shareCurrentInvitation()} type="button">Secure share</button>
              <a className="button button-secondary button-small" href={invitationEmailHref({ activationUrl: oneTimeInvitation.activationUrl, email: oneTimeInvitation.invitation.email, expiresAt: oneTimeInvitation.invitation.expiresAt })}>Open email draft</a>
              <button className="button button-secondary button-small" disabled={sharing} onClick={() => { setOneTimeInvitation(null); setShareNotice(null); }} type="button">Dismiss link</button>
            </div>
          </div>
        ) : null}
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
            <div className="data-row data-header" style={{ gridTemplateColumns: "minmax(190px, 1.4fr) minmax(130px, .9fr) 80px minmax(110px, .75fr) minmax(120px, .85fr) minmax(150px, 1fr)" }}><span>Email</span><span>Role / scope</span><span>Status</span><span>Delivery</span><span>Expiry</span><span>Actions</span></div>
            {invitations.map((invitation) => <div className="data-row" style={{ gridTemplateColumns: "minmax(190px, 1.4fr) minmax(130px, .9fr) 80px minmax(110px, .75fr) minmax(120px, .85fr) minmax(150px, 1fr)" }} key={invitation.id}>
              <span className="primary-cell"><strong>{invitation.email}</strong><small>{invitation.id}</small></span>
              <span className="primary-cell"><strong>{invitation.role.replaceAll("_", " ")}</strong><small>{invitation.customerId ? customerNames.get(invitation.customerId) ?? invitation.customerId : invitation.scopeMode.replaceAll("_", " ")}</small></span>
              <span><span className={`connection-status connection-${invitation.status === "pending" ? "active" : invitation.status === "accepted" ? "active" : "disabled"}`}>{invitation.status}</span></span>
              <span className="primary-cell"><strong>{deliveryLabel(invitation.delivery)}</strong><small>{invitation.delivery?.provider && invitation.delivery.provider !== "none" ? `${invitation.delivery.provider} · ${invitation.delivery.attempts} attempt${invitation.delivery.attempts === 1 ? "" : "s"}` : "Manual sharing"}{invitation.delivery?.errorCode ? ` · ${invitation.delivery.errorCode}` : ""}</small></span>
              <span>{new Date(invitation.expiresAt).toLocaleString()}</span>
              <span className="heading-actions">{invitation.status === "pending" || invitation.status === "expired" ? <><button className="button button-secondary button-small" disabled={busy} onClick={() => void resend(invitation)} type="button">{invitation.status === "expired" ? "Renew invitation" : invitation.delivery?.status === "failed" ? "Retry email" : invitation.delivery?.status === "not_attempted" || invitation.delivery === undefined ? "Send email" : "Resend email"}</button><button className="button button-danger button-small" disabled={busy} onClick={() => void revoke(invitation.id)} type="button">Revoke</button></> : "—"}</span>
            </div>)}
            {invitations.length === 0 ? <div className="empty-row">No invitations have been created.</div> : null}
          </div>
        )}
      </section>
    </>
  );
}
