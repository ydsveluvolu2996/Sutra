"use client";

import Link from "next/link";
import { useState } from "react";
import { formatTimestamp, usePilotState } from "../components/use-pilot-state";
import { postAuth, useSession } from "../components/use-session";
import { ApiTokensPanel } from "./api-tokens-panel";
import { EnterpriseReadinessPanel } from "./enterprise-readiness-panel";
import { ItsmConnectorsPanel } from "./itsm-connectors-panel";
import GovernancePoliciesPanel from "./governance-policies-panel";
import { ScimConnectorsPanel } from "./scim-connectors-panel";

function roleLabel(role: string): string {
  return role.split("_").map((part) => `${part[0]?.toLocaleUpperCase("en-US") ?? ""}${part.slice(1)}`).join(" ");
}

export function SettingsBrowser() {
  const { session, loading, error, refresh } = useSession();
  const { state, loading: workspaceLoading, error: workspaceError } = usePilotState();
  const connectionId = state?.connection?.id ?? null;
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  async function signOut(): Promise<void> {
    setSigningOut(true);
    setSignOutError(null);
    try {
      await postAuth<{ signedOut: true }>("/api/auth/logout");
      window.location.replace("/login");
    } catch (caught) {
      setSignOutError(caught instanceof Error ? caught.message : "Sutra could not sign out");
      setSigningOut(false);
    }
  }

  if (loading) return <div className="loading-state" role="status"><span className="loading-spinner" />Loading settings…</div>;
  if (error || session === null) {
    return <div className="page-alert page-alert-error" role="alert"><strong>Settings unavailable</strong><span>{error ?? "No active session."}</span><button onClick={() => void refresh()} type="button">Retry</button></div>;
  }

  const canManageMembers = session.capabilities.includes("membership:manage");
  const canManageConnections = session.capabilities.includes("connection:manage");

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Workspace</p><h1>Settings</h1><p className="page-subtitle">Manage your profile, security, workspace, and where Sutra sends evidence. Sutra shows only the settings this build actually supports.</p></div>
      </section>

      <div className="settings-grid">
        <section className="panel settings-card">
          <div className="panel-heading"><div><p className="eyebrow">Account</p><h2>Profile</h2></div></div>
          <dl className="settings-list">
            <div><dt>Name</dt><dd>{session.user.displayName}</dd></div>
            <div><dt>Email</dt><dd>{session.user.email}</dd></div>
            <div><dt>Role</dt><dd>{roleLabel(session.membership.role)}</dd></div>
            <div><dt>Scope</dt><dd>{session.membership.scopeMode.replaceAll("_", " ")}</dd></div>
          </dl>
          <p className="panel-footnote">Profile identity is governed by your organization&apos;s identity policy and cannot be edited here.</p>
        </section>

        <section className="panel settings-card">
          <div className="panel-heading"><div><p className="eyebrow">Account</p><h2>Security</h2></div></div>
          <dl className="settings-list">
            <div><dt>Multi-factor auth</dt><dd><span className={`settings-pill ${session.mfa.verified ? "is-good" : "is-risk"}`}>{session.mfa.verified ? "Verified" : session.mfa.enrolled ? "Enrolled · verify" : "Not enrolled"}</span></dd></div>
            <div><dt>Session expires</dt><dd>{formatTimestamp(session.expiresAt)}</dd></div>
          </dl>
          <div className="settings-actions">
            {!session.mfa.enrolled ? <Link className="button button-secondary" href="/mfa/setup">Set up MFA</Link> : null}
            <button className="button button-secondary settings-danger" disabled={signingOut} onClick={() => void signOut()} type="button">{signingOut ? "Signing out…" : "Sign out"}</button>
          </div>
          {signOutError ? <p className="page-alert page-alert-error" role="alert">{signOutError}</p> : null}
        </section>

        <section className="panel settings-card">
          <div className="panel-heading"><div><p className="eyebrow">Organization</p><h2>Workspace</h2></div></div>
          <dl className="settings-list">
            <div><dt>Name</dt><dd>{session.organization.name}</dd></div>
            <div><dt>Identifier</dt><dd>{session.organization.slug}</dd></div>
            <div><dt>Release</dt><dd><span className="settings-pill">Controlled enterprise release</span></dd></div>
          </dl>
        </section>

        <section className="panel settings-card">
          <div className="panel-heading"><div><p className="eyebrow">Delivery</p><h2>Notifications</h2></div></div>
          <p>Configure the email, Slack, and Teams destinations Sutra uses for runtime cases and alerts, and review delivery health, retries, and the dead-letter queue.</p>
          <div className="settings-actions"><Link className="button button-primary" href="/settings/notifications">Manage notification destinations</Link></div>
        </section>

        <section className="panel settings-card">
          <div className="panel-heading"><div><p className="eyebrow">Access</p><h2>Members &amp; connections</h2></div></div>
          <p>{canManageMembers ? "Invite operators, manage roles, and review access." : "Members and roles are managed by a workspace administrator."} {canManageConnections ? "Connect or review AWS accounts and clusters." : ""}</p>
          <div className="settings-actions">
            {canManageMembers ? <Link className="button button-secondary" href="/access">Access &amp; invitations</Link> : null}
            {canManageConnections ? <Link className="button button-secondary" href="/onboard">AWS accounts</Link> : null}
            <Link className="button button-secondary" href="/controls#architecture">Architecture &amp; trust</Link>
          </div>
        </section>
      </div>
      {workspaceError ? <p className="page-alert page-alert-error" role="alert">{workspaceError}</p> : null}
      {workspaceLoading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading selected workspace…</div> : null}
      <EnterpriseReadinessPanel connectionId={connectionId} />
      {canManageMembers ? <ScimConnectorsPanel /> : null}
      <ApiTokensPanel connectionId={connectionId} />
      <ItsmConnectorsPanel connectionId={connectionId} />
      <GovernancePoliciesPanel connectionId={connectionId} />
    </>
  );
}
