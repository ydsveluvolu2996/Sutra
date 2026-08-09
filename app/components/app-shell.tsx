"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { PublicLocalSession } from "../../db/auth-repository";
import { postAuth, useSession } from "./use-session";
import { snapshotOriginLabel, usePilotState } from "./use-pilot-state";
import { groupContainsActiveItem, resolveActiveNavKey, visibleNavigation, type NavGroup, type NavKey } from "./navigation-config";
import { GlyphIcon, NavGroupIcon, navGroupTone, NavIcon, navTone } from "./nav-icon";
import { AccountMenu } from "./account-menu";
import { useOnboarding } from "./use-onboarding";
import { OnboardingStrip } from "./onboarding-strip";

const NAV_RAIL_STORAGE_KEY = "sutra.nav-rail.v1";

/**
 * The rail preference lives in localStorage, which is external to React, so it
 * is read through `useSyncExternalStore` rather than seeded into state by an
 * effect. That keeps the server snapshot (expanded) authoritative during
 * hydration instead of producing markup the client immediately contradicts, and
 * it makes the preference follow the operator across tabs for free.
 *
 * Every access is guarded: private mode, a full quota or disabled storage must
 * leave the navigation working, so a failure reads as "expanded".
 */
const railListeners = new Set<() => void>();

function subscribeRailPreference(onStoreChange: () => void): () => void {
  railListeners.add(onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    railListeners.delete(onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

function readRailPreference(): boolean {
  try {
    return window.localStorage.getItem(NAV_RAIL_STORAGE_KEY) === "collapsed";
  } catch {
    return false;
  }
}

function writeRailPreference(collapsed: boolean): void {
  try {
    window.localStorage.setItem(NAV_RAIL_STORAGE_KEY, collapsed ? "collapsed" : "expanded");
  } catch { /* the preference simply does not persist */ }
  // `storage` does not fire in the tab that wrote, so this tab is told directly.
  for (const listener of [...railListeners]) listener();
}

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

function scopedWorkspaceHref(href: string, connectionId: string | null): string {
  if (connectionId === null) return href;
  const url = new URL(href, "https://www.sutracmdb.com");
  url.searchParams.set("connectionId", connectionId);
  return `${url.pathname}${url.search}${url.hash}`;
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
        <h1>{sessionView.error ? "Secure access is unavailable" : "Opening your protected workspace"}</h1>
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
  // Guided onboarding applies only to trial workspaces; for everyone else the
  // hook stays disabled and fetches nothing. Null progress renders nothing --
  // unknown is never presented as complete or incomplete.
  const onboarding = useOnboarding(session.organization.plan === "trial");
  const onboardingGuiding = session.organization.plan === "trial"
    && onboarding.progress !== null
    && !onboarding.progress.completed;
  const { state, health, loading } = usePilotState();
  // FinOps dashboard routes all declare `active="costs"`; the exact rail
  // destination is resolved from the path so the open dashboard is the one
  // marked `aria-current="page"`.
  const activeKey = resolveActiveNavKey(active, usePathname());
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [navQuery, setNavQuery] = useState("");
  const railMode = useSyncExternalStore(subscribeRailPreference, readRailPreference, () => false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mobileNavToggleRef = useRef<HTMLButtonElement>(null);
  const mobileNavPanelRef = useRef<HTMLDivElement>(null);
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
  const modeLabel = snapshotOrigin?.kind === "aws_live"
    ? snapshotOriginLabel(snapshotOrigin)
    : health?.mode === "live" ? "AWS collector ready" : "Collector unavailable";
  const modeKind = snapshotOrigin?.kind === "aws_live" || health?.mode === "live"
    ? "live"
    : "offline";
  const scopeLabel = connection?.customerName ?? session.organization.name;
  const initials = userInitials(session);
  const selectedConnectionId = connection?.id ?? null;

  // Closing the mobile drawer always returns focus to the toggle that opened
  // it, so a keyboard or screen-reader user is never dropped at the top of the
  // document.
  const closeMobileNav = useCallback((returnFocus: boolean) => {
    setMobileNavOpen(false);
    if (returnFocus) mobileNavToggleRef.current?.focus();
  }, []);

  const setRail = useCallback((collapsed: boolean) => writeRailPreference(collapsed), []);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMobileNav(true);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (mobileNavPanelRef.current?.contains(target) === true) return;
      if (mobileNavToggleRef.current?.contains(target) === true) return;
      closeMobileNav(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [closeMobileNav, mobileNavOpen]);

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
    <div className="app-shell" data-nav={railMode ? "rail" : "expanded"}>
      {onboardingGuiding ? (
        <aside className="sidebar sidebar-onboarding">
          <Link className="brand" href={scopedWorkspaceHref("/dashboard", selectedConnectionId)} aria-label="Sutra workspace home">
            <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
            <span><strong>Sutra</strong><small>Cloud security, woven together.</small></span>
          </Link>
          {/* While a trial workspace is onboarding, the sidebar offers Home and
              nothing else -- the guided flow owns the journey, and a hundred
              destinations before the first connection is noise, not product.
              Capability gating is untouched: this narrows presentation only,
              and every route stays server-authorized. */}
          <nav aria-label="Primary navigation" className="nav-groups nav-groups-onboarding">
            <Link
              aria-current={activeKey === "overview" ? "page" : undefined}
              className="nav-item"
              href={scopedWorkspaceHref("/dashboard", selectedConnectionId)}
            >
              Home
            </Link>
          </nav>
          <div className="sidebar-spacer" />
        </aside>
      ) : railMode ? (
        <aside className="sidebar sidebar-collapsed">
          <Link className="brand brand-compact" href={scopedWorkspaceHref("/dashboard", selectedConnectionId)} aria-label="Sutra workspace home">
            <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          </Link>
          <NavigationRail
            active={activeKey}
            connectionId={selectedConnectionId}
            groups={allVisibleNav}
            onExpand={() => setRail(false)}
            openFindings={openFindings}
          />
          <div className="sidebar-spacer" />
          <span
            className={`nav-rail-status collector-${connectionTone(connection?.status)}`}
            title={modeLabel}
          >
            <span className="pulse-dot" />
            <span className="sr-only">{modeLabel}</span>
          </span>
        </aside>
      ) : (
      <aside className="sidebar">
        <Link className="brand" href={scopedWorkspaceHref("/dashboard", selectedConnectionId)} aria-label="Sutra workspace home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>Sutra</strong><small>Cloud security, woven together.</small></span>
        </Link>
        <button className="nav-collapse" onClick={() => setRail(true)} type="button" title="Collapse navigation to icons">
          <GlyphIcon name="chevron" size={13} />
          <span className="sr-only">Collapse navigation to icons</span>
        </button>
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
            <NavigationGroup
              active={activeKey}
              connectionId={selectedConnectionId}
              group={group}
              forceOpen={query !== ""}
              key={group.key}
              openFindings={openFindings}
            />
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
      </aside>
      )}
      <main className="main-area">
        <header className="topbar">
          <div className="mobile-nav">
            <button
              aria-controls="mobile-nav-panel"
              aria-expanded={mobileNavOpen}
              className="mobile-nav-toggle"
              onClick={() => (mobileNavOpen ? closeMobileNav(false) : setMobileNavOpen(true))}
              ref={mobileNavToggleRef}
              type="button"
            >
              <span aria-hidden="true" className="mobile-nav-bars"><i /><i /><i /></span>
              Menu
            </button>
            <div className="mobile-nav-panel" hidden={!mobileNavOpen} id="mobile-nav-panel" ref={mobileNavPanelRef}>
              <nav aria-label="Primary navigation (mobile)">
                {visibleNav.map((group) => (
                  <section aria-labelledby={`mobile-nav-${group.key}`} key={group.key}>
                    <strong id={`mobile-nav-${group.key}`}>{group.label}</strong>
                    {group.items.map((item) => (
                      <Link
                        aria-current={activeKey === item.key ? "page" : undefined}
                        href={scopedWorkspaceHref(item.href, selectedConnectionId)}
                        key={`${group.key}-${item.href}`}
                        onClick={() => closeMobileNav(false)}
                      >
                        {item.label}
                      </Link>
                    ))}
                  </section>
                ))}
              </nav>
              <button disabled={signingOut} onClick={() => void signOut()} type="button">Sign out</button>
            </div>
          </div>
          <div className="scope-switcher">
            <span>Workspace</span>
            <strong>{scopeLabel}</strong>
          </div>
          {onboardingGuiding && onboarding.progress !== null
            ? <OnboardingStrip progress={onboarding.progress} />
            : null}
          <div className="topbar-actions">
            <span className="mfa-badge"><i /> MFA verified</span>
            <span className={`demo-badge mode-${modeKind}`}><i /> {modeLabel}</span>
            <AccountMenu
              displayName={session.user.displayName}
              email={session.user.email}
              roleLabel={roleLabel(session.membership.role)}
              organizationName={session.organization.name}
              organizationPlan={session.organization.plan}
              initials={initials}
              mfaVerified={session.mfa.verified}
              capabilities={capabilitySet}
              signingOut={signingOut}
              onSignOut={() => void signOut()}
            />
          </div>
        </header>
        {/* Account identity + sign-out live in the top-right account menu. This
            alert belongs to the main area, not the sidebar: a failed sign-out
            must be visible in every navigation mode, and the collapsed rail
            renders no sidebar body to carry it. Silence here would leave the
            operator believing they had signed out while the session is live. */}
        {signOutError ? <p className="shell-error" role="alert">{signOutError}</p> : null}
        <div className="content-wrap">{children}</div>
        <footer className="app-footer">
          <span>Sutra · CNAPP for managed service providers</span>
          <span>Authenticated operators · tenant-scoped access · deterministic posture checks</span>
        </footer>
      </main>
    </div>
  );
}

/**
 * One nav destination.
 *
 * Extracted so the expanded rail and the collapsed rail's flyout render the
 * identical link — same active marking, same glyph chip, same tone. A second
 * copy would be free to drift, and the drift an operator would notice least is
 * a flyout that stops marking the current page.
 */
function NavItemLink({
  active,
  connectionId,
  item,
  onNavigate,
  openFindings,
}: {
  readonly active: NavKey;
  readonly connectionId: string | null;
  readonly item: NavGroup["items"][number];
  readonly onNavigate?: () => void;
  readonly openFindings: number;
}) {
  const isActive = active === item.key;
  return (
    <Link
      href={scopedWorkspaceHref(item.href, connectionId)}
      className={isActive ? "active" : undefined}
      aria-current={isActive ? "page" : undefined}
      onClick={onNavigate}
    >
      <span className="nav-glyph-chip" data-tone={navTone(item.key)} aria-hidden="true"><NavIcon navKey={item.key} /></span>{item.label}
      {item.key === "findings" && openFindings > 0 ? <b aria-label={`${openFindings} open findings`}>{openFindings}</b> : null}
    </Link>
  );
}

/**
 * The collapsed icon rail: one glyph per group, with the group's destinations in
 * a flyout.
 *
 * This is a *mode* of the grouped nav, never a replacement for it. Sutra has
 * over a hundred destinations across eight groups where the reference console
 * has about nine top-level entries, so a rail that stood alone would have to
 * hide most of the product. Every destination stays reachable: the flyout lists
 * a group's full item set, and the expand control restores the text nav.
 */
function NavigationRail({
  active,
  connectionId,
  groups,
  onExpand,
  openFindings,
}: {
  readonly active: NavKey;
  readonly connectionId: string | null;
  readonly groups: readonly NavGroup[];
  readonly onExpand: () => void;
  readonly openFindings: number;
}) {
  const [openGroup, setOpenGroup] = useState<NavGroup["key"] | null>(null);
  const open = groups.find((group) => group.key === openGroup) ?? null;
  const wrapRef = useRef<HTMLElement | null>(null);

  // Escape closes the flyout rather than trapping a keyboard user inside it, and
  // a pointer landing outside dismisses it. Without the second handler the
  // 258px overlay sits on top of the page with no obvious way to dismiss it --
  // the mobile drawer already does both, and the rail owes the same.
  useEffect(() => {
    if (open === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenGroup(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpenGroup(null);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <nav aria-label="Primary navigation" className="nav-rail-wrap" ref={wrapRef}>
      <div className="nav-rail">
        {groups.map((group) => {
          const containsActive = groupContainsActiveItem(group, active);
          return (
            <button
              aria-expanded={openGroup === group.key}
              className="nav-rail-button"
              data-active={containsActive ? "true" : undefined}
              data-open={openGroup === group.key ? "true" : undefined}
              data-tone={navGroupTone(group.key)}
              key={group.key}
              onClick={() => setOpenGroup(openGroup === group.key ? null : group.key)}
              type="button"
            >
              <span className="nav-rail-glyph" aria-hidden="true"><NavGroupIcon groupKey={group.key} /></span>
              <span className="nav-rail-label">{group.label}</span>
              <em>{group.items.length}</em>
            </button>
          );
        })}
        <button className="nav-rail-expand" onClick={onExpand} type="button" title="Expand navigation">
          <GlyphIcon name="chevron" size={13} />
          <span className="sr-only">Expand navigation</span>
        </button>
      </div>
      {open === null ? null : (
        <div className="nav-rail-flyout">
          <div className="nav-rail-flyout-head">
            <strong>{open.label}</strong>
            <button aria-label="Close group" onClick={() => setOpenGroup(null)} type="button">×</button>
          </div>
          <div className="nav-rail-flyout-items">
            {open.items.map((item) => (
              <NavItemLink
                active={active}
                connectionId={connectionId}
                item={item}
                key={`rail-${open.key}-${item.href}`}
                // Client-side navigation does not unmount the rail, so without
                // this the overlay stays open over the page just navigated to.
                onNavigate={() => setOpenGroup(null)}
                openFindings={openFindings}
              />
            ))}
          </div>
        </div>
      )}
    </nav>
  );
}

/**
 * A collapsed sub-list inside a nav group. Native `<details>`/`<summary>` keeps
 * it keyboard operable with no custom key handling, and the count is the only
 * metadata shown — delivery maturity is never implied here.
 */
function NavigationSubsection({
  children,
  containsActive,
  count,
  forceOpen,
  label,
}: {
  readonly children: ReactNode;
  readonly containsActive: boolean;
  readonly count: number;
  readonly forceOpen: boolean;
  readonly label: string;
}) {
  const [open, setOpen] = useState(containsActive);

  return (
    <details
      className="nav-subsection nav-subsection-collapsible"
      open={forceOpen || open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="nav-subsection-label">
        <span>{label}</span>
        <em>{count}</em>
        <GlyphIcon className="nav-group-chevron" name="chevron" size={11} />
      </summary>
      <div>{children}</div>
    </details>
  );
}

function NavigationGroup({
  active,
  connectionId,
  group,
  forceOpen = false,
  openFindings,
}: {
  readonly active: NavKey;
  readonly connectionId: string | null;
  readonly group: NavGroup;
  readonly forceOpen?: boolean;
  readonly openFindings: number;
}) {
  const containsActive = groupContainsActiveItem(group, active);
  const [open, setOpen] = useState(containsActive || group.key === "overview");
  // While a search filter is active, every matching group is expanded.
  const isOpen = forceOpen || open;

  const renderItem = (item: NavGroup["items"][number]) => (
    <NavItemLink
      active={active}
      connectionId={connectionId}
      item={item}
      key={`${group.key}-${item.href}`}
      openFindings={openFindings}
    />
  );

  // Large groups (e.g. Kubernetes) declare display-only sections so their long
  // item list reads as labelled clusters instead of one dense column.
  const sections = group.sections
    ?.map((section) => ({
      label: section.label,
      collapsible: section.collapsible === true,
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
          ? sections.map((section) => section.collapsible
            ? (
              <NavigationSubsection
                containsActive={section.items.some((item) => item.key === active)}
                count={section.items.length}
                forceOpen={forceOpen}
                key={`${group.key}-${section.label}`}
                label={section.label}
              >
                {section.items.map(renderItem)}
              </NavigationSubsection>
            )
            : (
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
