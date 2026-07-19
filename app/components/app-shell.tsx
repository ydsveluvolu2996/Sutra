"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import type { PublicLocalSession } from "../../db/auth-repository";
import { postAuth, useSession } from "./use-session";
import { snapshotOriginLabel, usePilotState } from "./use-pilot-state";
import { groupContainsActiveItem, visibleNavigation, type NavGroup, type NavKey } from "./navigation-config";
import { GlyphIcon, NavIcon, navTone } from "./nav-icon";
import { AccountMenu } from "./account-menu";

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
  const [navQuery, setNavQuery] = useState("");
  const capabilitySet = new Set(session.capabilities);
  const allVisibleNav = visibleNavigation(capabilitySet);
  // Live nav filter: keep only groups with items whose label matches the query.
  const query = navQuery.trim().toLocaleLowerCase("en-US");
  const visibleNav = query === ""
    ? allVisibleNav
    : allVisibleNav
        .map((group) => ({ ...group, items: group.items.filter((item) => item.label.toLocaleLowerCase("en-US").includes(query)) }))
        .filter((group) => group.items.length > 0);
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
          <span><strong>Sutra</strong><small>Cloud security, woven together.</small></span>
        </Link>
        <div className="workspace-label">{session.organization.name}</div>
        <div className="nav-search">
          <GlyphIcon className="nav-search-icon" name="search" size={13} />
          <input
            type="search"
            value={navQuery}
            onChange={(event) => setNavQuery(event.target.value)}
            placeholder="Search navigation…"
            aria-label="Search navigation"
            spellCheck={false}
            autoComplete="off"
          />
          {navQuery !== "" ? <button type="button" className="nav-search-clear" aria-label="Clear search" onClick={() => setNavQuery("")}>×</button> : null}
        </div>
        <nav className="main-nav grouped-nav" aria-label="Primary navigation">
          {visibleNav.map((group) => (
            <NavigationGroup active={active} group={group} forceOpen={query !== ""} key={group.key} openFindings={openFindings} />
          ))}
          {visibleNav.length === 0 ? <p className="nav-empty">No navigation matches &ldquo;{navQuery}&rdquo;.</p> : null}
        </nav>
        <div className="sidebar-spacer" />
        <div className={`sidebar-note collector-${connectionTone(connection?.status)}`}>
          <span className="pulse-dot" />
          <div>
            <strong>{modeLabel}</strong>
            <small>{loading ? "Checking workspace…" : connection ? `${connection.awsAccountId} · ${connection.status.replace("_", " ")}` : "No cloud account connected"}</small>
          </div>
        </div>
        {/* Account identity + sign-out live in the top-right account menu; the
            sidebar stays clean. The sign-out error still surfaces here if a
            sign-out attempt from anywhere fails. */}
        {signOutError ? <p className="sidebar-error" role="alert">{signOutError}</p> : null}
      </aside>
      <main className="main-area">
        <header className="topbar">
          <details className="mobile-nav">
            <summary aria-label="Open navigation">Menu</summary>
            <div className="mobile-nav-panel">
              {visibleNav.map((group) => (
                <section aria-labelledby={`mobile-nav-${group.key}`} key={group.key}>
                  <strong id={`mobile-nav-${group.key}`}>{group.label}</strong>
                  {group.items.map((item) => (
                    <Link aria-current={active === item.key ? "page" : undefined} href={item.href} key={`${group.key}-${item.href}`}>
                      {item.label}
                    </Link>
                  ))}
                </section>
              ))}
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
            <AccountMenu
              displayName={session.user.displayName}
              email={session.user.email}
              roleLabel={roleLabel(session.membership.role)}
              organizationName={session.organization.name}
              initials={initials}
              mfaVerified={session.mfa.verified}
              capabilities={capabilitySet}
              signingOut={signingOut}
              onSignOut={() => void signOut()}
            />
          </div>
        </header>
        <div className="content-wrap">{children}</div>
        <footer className="app-footer">
          <span>Sutra · CNAPP for managed service providers</span>
          <span>Authenticated operators · tenant-scoped access · deterministic posture checks</span>
        </footer>
      </main>
    </div>
  );
}

function NavigationGroup({
  active,
  group,
  forceOpen = false,
  openFindings,
}: {
  readonly active: NavKey;
  readonly group: NavGroup;
  readonly forceOpen?: boolean;
  readonly openFindings: number;
}) {
  const containsActive = groupContainsActiveItem(group, active);
  const [open, setOpen] = useState(containsActive || group.key === "overview");
  // While a search filter is active, every matching group is expanded.
  const isOpen = forceOpen || open;

  const renderItem = (item: NavGroup["items"][number]) => {
    const isActive = active === item.key;
    return (
      <Link
        href={item.href}
        key={`${group.key}-${item.href}`}
        className={isActive ? "active" : undefined}
        aria-current={isActive ? "page" : undefined}
      >
        <span className="nav-glyph-chip" data-tone={navTone(item.key)} aria-hidden="true"><NavIcon navKey={item.key} /></span>{item.label}
        {item.key === "findings" && openFindings > 0 ? <b aria-label={`${openFindings} open findings`}>{openFindings}</b> : null}
      </Link>
    );
  };

  // Large groups (e.g. Kubernetes) declare display-only sections so their long
  // item list reads as labelled clusters instead of one dense column.
  const sections = group.sections
    ?.map((section) => ({
      label: section.label,
      items: section.keys
        .map((key) => group.items.find((item) => item.key === key))
        .filter((item): item is NavGroup["items"][number] => item !== undefined),
    }))
    .filter((section) => section.items.length > 0);

  return (
    <details className="nav-group" open={isOpen} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span>{group.label}</span>
        {containsActive ? <i aria-hidden="true" /> : null}
        <GlyphIcon className="nav-group-chevron" name="chevron" size={13} />
      </summary>
      <div>
        {sections && sections.length > 0
          ? sections.map((section) => (
              <div className="nav-subsection" key={`${group.key}-${section.label}`}>
                <p className="nav-subsection-label">{section.label}</p>
                {section.items.map(renderItem)}
              </div>
            ))
          : group.items.map(renderItem)}
      </div>
    </details>
  );
}
