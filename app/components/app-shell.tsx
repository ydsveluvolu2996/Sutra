"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePilotState } from "./use-pilot-state";

type NavKey = "overview" | "customers" | "cmdb" | "findings" | "controls" | "roadmap" | "onboard";

const navItems: Array<{ key: NavKey; label: string; href: string; icon: string }> = [
  { key: "overview", label: "Overview", href: "/dashboard", icon: "01" },
  { key: "customers", label: "Customers", href: "/customers", icon: "02" },
  { key: "cmdb", label: "CMDB inventory", href: "/cmdb", icon: "03" },
  { key: "findings", label: "Security findings", href: "/findings", icon: "04" },
  { key: "controls", label: "Control library", href: "/controls", icon: "05" },
  { key: "roadmap", label: "Product roadmap", href: "/roadmap", icon: "06" },
];

function connectionTone(status: string | undefined): string {
  if (status === "active") return "healthy";
  if (status === "needs_attention") return "warning";
  return "pending";
}

export function AppShell({ active, children }: { active: NavKey; children: ReactNode }) {
  const { state, health, loading } = usePilotState();
  const connection = state?.connection ?? null;
  const openFindings = state?.findings.filter((finding) => finding.status === "open").length ?? 0;
  const modeLabel = health?.mode === "live" ? "Live AWS collector" : health?.mode === "fixture" ? "Fixture collector" : "Collector offline";
  const scopeLabel = connection?.customerName ?? "Local pilot workspace";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href="/dashboard" aria-label="Sutra workspace home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>Sutra</strong><small>Cloud operations</small></span>
        </Link>
        <div className="workspace-label">Single-account pilot</div>
        <nav className="main-nav" aria-label="Primary navigation">
          {navItems.map((item) => (
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
            <small>{loading ? "Checking workspace…" : connection ? `${connection.awsAccountId} · ${connection.status.replace("_", " ")}` : "No AWS account connected"}</small>
          </div>
        </div>
        <nav className="secondary-nav" aria-label="Workspace actions">
          <Link href="/onboard" className={active === "onboard" ? "active" : undefined}><span>+</span>Onboard account</Link>
          <Link href="/controls#architecture"><span>?</span>Architecture & trust</Link>
        </nav>
        <div className="user-card">
          <span className="user-avatar">LA</span>
          <span><strong>Local administrator</strong><small>Local pilot operator</small></span>
          <b aria-hidden="true">•••</b>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <details className="mobile-nav">
            <summary aria-label="Open navigation">Menu</summary>
            <div>{navItems.map((item) => <Link href={item.href} key={item.key}>{item.label}</Link>)}</div>
          </details>
          <div className="scope-switcher">
            <span>Workspace</span>
            <strong>{scopeLabel}</strong>
          </div>
          <div className="topbar-actions">
            <span className={`demo-badge mode-${health?.mode ?? "offline"}`}><i /> {modeLabel}</span>
            <span className="topbar-avatar" aria-label="Local administrator">LA</span>
          </div>
        </header>
        <div className="content-wrap">{children}</div>
        <footer className="app-footer">
          <span>Sutra · one-account local pilot</span>
          <span>Read-only AWS metadata · complete snapshots · deterministic posture checks</span>
        </footer>
      </main>
    </div>
  );
}
