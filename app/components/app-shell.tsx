"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import type { PublicLocalSession } from "../../db/auth-repository";
import type { Capability } from "../../lib/auth-policy";
import { postAuth, useSession } from "./use-session";
import { snapshotOriginLabel, usePilotState } from "./use-pilot-state";

type NavKey = "overview" | "customers" | "cmdb" | "changes" | "findings" | "security_events" | "cases" | "costs" | "compliance" | "reports" | "controls" | "roadmap" | "operations" | "onboard";

interface NavItem {
  readonly key: Exclude<NavKey, "onboard">;
  readonly label: string;
  readonly href: string;
  readonly icon: string;
  readonly capability: Capability;
}

const navItems: readonly NavItem[] = [
  { key: "overview", label: "Overview", href: "/dashboard", icon: "01", capability: "workspace:read" },
  { key: "customers", label: "Customers", href: "/customers", icon: "02", capability: "workspace:read" },
  { key: "cmdb", label: "CMDB inventory", href: "/cmdb", icon: "03", capability: "connection:read" },
  { key: "changes", label: "Change history", href: "/changes", icon: "04", capability: "connection:read" },
  { key: "findings", label: "Security findings", href: "/findings", icon: "05", capability: "connection:read" },
  { key: "security_events", label: "Security events", href: "/security-events", icon: "06", capability: "connection:read" },
  { key: "cases", label: "Finding cases", href: "/cases", icon: "07", capability: "connection:read" },
  { key: "costs", label: "Cost & FinOps", href: "/costs", icon: "08", capability: "connection:read" },
  { key: "compliance", label: "Compliance posture", href: "/compliance", icon: "09", capability: "connection:read" },
  { key: "reports", label: "Executive reports", href: "/reports", icon: "10", capability: "connection:read" },
  { key: "controls", label: "Control library", href: "/controls", icon: "11", capability: "workspace:read" },
  { key: "roadmap", label: "Product roadmap", href: "/roadmap", icon: "12", capability: "workspace:read" },
  { key: "operations", label: "Simulation runs", href: "/operations", icon: "13", capability: "sync:run" },
];

function connectionTone(status: string | undefined): string {
  if (status === "active") return "healthy";
  if (status === "needs_attention") return "warning";
  return "pending";
}

function userInitials(session: PublicLocalSession): string {
  const words = session.user.displayName.trim().split(/\s+/u).filter(Boolean);
  const value = words.length > 1
    ? `${words[0]?.[0] ?? ""}${words.at(-1)?.[0] ?? ""}`
    : (words[0] ?? session.user.email).slice(0, 2);
  return value.toLocaleUpperCase("en-US");
}

function roleLabel(role: PublicLocalSession["membership"]["role"]): string {
  return role.split("_").map((part) => `${part[0]?.toLocaleUpperCase("en-US") ?? ""}${part.slice(1)}`).join(" ");
}

export function AppShell({ active, children }: { active: NavKey; children: ReactNode }) {
  const sessionView = useSession();

  useEffect(() => {
    if (sessionView.loading || sessionView.error !== null) return;
    if (sessionView.session === null) {
      const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.location.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }
    if (!sessionView.session.mfa.enrolled || !sessionView.session.mfa.verified) {
      const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.location.replace(`/mfa/setup?returnTo=${encodeURIComponent(returnTo)}`);
    }
  }, [sessionView.error, sessionView.loading, sessionView.session]);

  if (sessionView.loading || sessionView.session === null) {
    return (
      <main className="workspace-auth-gate">
        <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
        <h1>{sessionView.error ? "Local access is unavailable" : "Opening your protected workspace"}</h1>
        <p>{sessionView.error ?? "Sutra is verifying your session and MFA state."}</p>
        {sessionView.error ? (
          <button className="button button-secondary" onClick={() => void sessionView.refresh()} type="button">Try again</button>
        ) : <span className="auth-spinner" aria-hidden="true" />}
      </main>
    );
  }

  if (!sessionView.session.mfa.enrolled || !sessionView.session.mfa.verified) {
    return (
      <main className="workspace-auth-gate">
        <span className="auth-spinner" aria-hidden="true" />
        <h1>Completing MFA setup</h1>
        <p>Sutra requires MFA before protected workspace data is loaded.</p>
      </main>
    );
  }

  return <AuthenticatedAppShell active={active} session={sessionView.session}>{children}</AuthenticatedAppShell>;
}

function AuthenticatedAppShell({
  active,
  children,
  session,
}: {
  readonly active: NavKey;
  readonly children: ReactNode;
  readonly session: PublicLocalSession;
}) {
  const { state, health, loading } = usePilotState();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const capabilitySet = new Set(session.capabilities);
  const visibleNav = navItems.filter((item) => capabilitySet.has(item.capability));
  const canOnboard = capabilitySet.has("customer:create") && capabilitySet.has("connection:manage");
  const connection = state?.connection ?? null;
  const openFindings = state?.findings.filter((finding) => finding.status === "open").length ?? 0;
  const snapshotOrigin = state?.activeSnapshot?.origin;
  const modeLabel = state?.activeSnapshot
    ? snapshotOriginLabel(snapshotOrigin)
    : health?.mode === "live" ? "AWS collector ready" : health?.mode === "fixture" ? "Fixture collector ready" : "Collector offline";
  const modeKind = snapshotOrigin?.kind === "simulated_fixture"
    ? "fixture"
    : snapshotOrigin?.kind === "aws_sandbox" ? "live" : health?.mode ?? "offline";
  const scopeLabel = connection?.customerName ?? session.organization.name;
  const initials = userInitials(session);

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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href="/dashboard" aria-label="Sutra workspace home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>Sutra</strong><small>Cloud operations</small></span>
        </Link>
        <div className="workspace-label">{session.organization.name}</div>
        <nav className="main-nav" aria-label="Primary navigation">
          {visibleNav.map((item) => (
            <Link href={item.href} key={item.key} className={active === item.key ? "active" : undefined} aria-current={active === item.key ? "page" : undefined}>
              <span>{item.icon}</span>{item.label}
              {item.key === "findings" && openFindings > 0 ? <b>{openFindings}</b> : null}
            </Link>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <div className={`sidebar-note collector-${connectionTone(connection?.status)}`}>
          <span className="pulse-dot" />
          <div>
            <strong>{modeLabel}</strong>
            <small>{loading ? "Checking workspace…" : connection ? `${connection.awsAccountId} · ${connection.status.replace("_", " ")}` : "No cloud account connected"}</small>
          </div>
        </div>
        <nav className="secondary-nav" aria-label="Workspace actions">
          {canOnboard ? (
            <Link href="/onboard" className={active === "onboard" ? "active" : undefined}><span>+</span>Onboard account</Link>
          ) : null}
          {capabilitySet.has("workspace:read") ? <Link href="/controls#architecture"><span>?</span>Architecture & trust</Link> : null}
        </nav>
        <div className="user-card">
          <span className="user-avatar">{initials}</span>
          <span><strong>{session.user.displayName}</strong><small>{roleLabel(session.membership.role)} · MFA verified</small></span>
          <button aria-label="Sign out" disabled={signingOut} onClick={() => void signOut()} title="Sign out" type="button">↗</button>
        </div>
        {signOutError ? <p className="sidebar-error" role="alert">{signOutError}</p> : null}
      </aside>
      <main className="main-area">
        <header className="topbar">
          <details className="mobile-nav">
            <summary aria-label="Open navigation">Menu</summary>
            <div>
              {visibleNav.map((item) => <Link href={item.href} key={item.key}>{item.label}</Link>)}
              {canOnboard ? <Link href="/onboard">Onboard account</Link> : null}
              <button disabled={signingOut} onClick={() => void signOut()} type="button">Sign out</button>
            </div>
          </details>
          <div className="scope-switcher">
            <span>Workspace</span>
            <strong>{scopeLabel}</strong>
          </div>
          <div className="topbar-actions">
            <span className="mfa-badge"><i /> MFA verified</span>
            <span className={`demo-badge mode-${modeKind}`}><i /> {modeLabel}</span>
            <span className="topbar-avatar" aria-label={session.user.displayName}>{initials}</span>
          </div>
        </header>
        <div className="content-wrap">{children}</div>
        <footer className="app-footer">
          <span>Sutra · local MSP private beta</span>
          <span>Authenticated operators · tenant-scoped access · deterministic posture checks</span>
        </footer>
      </main>
    </div>
  );
}
