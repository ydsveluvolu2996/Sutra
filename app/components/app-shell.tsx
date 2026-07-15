import type { ReactNode } from "react";
import Link from "next/link";

type NavKey = "overview" | "customers" | "cmdb" | "findings" | "controls" | "onboard";

const navItems: Array<{ key: NavKey; label: string; href: string; icon: string }> = [
  { key: "overview", label: "Overview", href: "/dashboard", icon: "01" },
  { key: "customers", label: "Customers", href: "/customers", icon: "02" },
  { key: "cmdb", label: "CMDB inventory", href: "/cmdb", icon: "03" },
  { key: "findings", label: "Security findings", href: "/findings", icon: "04" },
  { key: "controls", label: "Control library", href: "/controls", icon: "05" },
];

export function AppShell({ active, children }: { active: NavKey; children: ReactNode }) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href="/dashboard" aria-label="Sutra workspace home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>Sutra</strong><small>Cloud operations</small></span>
        </Link>
        <div className="workspace-label">MSP workspace</div>
        <nav className="main-nav" aria-label="Primary navigation">
          {navItems.map((item) => (
            <Link href={item.href} key={item.key} className={active === item.key ? "active" : undefined} aria-current={active === item.key ? "page" : undefined}>
              <span>{item.icon}</span>{item.label}
              {item.key === "findings" ? <b>22</b> : null}
            </Link>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-note">
          <span className="pulse-dot" />
          <div><strong>Collector preview</strong><small>5 demo accounts healthy</small></div>
        </div>
        <nav className="secondary-nav" aria-label="Workspace actions">
          <Link href="/onboard" className={active === "onboard" ? "active" : undefined}><span>+</span>Onboard account</Link>
          <Link href="/controls#architecture"><span>?</span>Architecture & trust</Link>
        </nav>
        <div className="user-card">
          <span className="user-avatar">AM</span>
          <span><strong>Alex Morgan</strong><small>MSP administrator</small></span>
          <b>•••</b>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <details className="mobile-nav">
            <summary aria-label="Open navigation">Menu</summary>
            <div>{navItems.map((item) => <Link href={item.href} key={item.key}>{item.label}</Link>)}</div>
          </details>
          <div className="scope-switcher">
            <span>Viewing</span>
            <select aria-label="Customer scope" defaultValue="portfolio">
              <option value="portfolio">All customers</option>
              <option>Northstar Retail (Demo)</option>
              <option>Bluepeak Health (Demo)</option>
              <option>Harbor Analytics (Demo)</option>
              <option>Evergreen Finance (Demo)</option>
            </select>
          </div>
          <div className="topbar-actions">
            <span className="demo-badge"><i /> Demo workspace</span>
            <button className="icon-button" aria-label="Open notifications">3</button>
            <span className="topbar-avatar">AM</span>
          </div>
        </header>
        <div className="content-wrap">{children}</div>
        <footer className="app-footer">
          <span>Sutra · production foundation preview</span>
          <span>Read-only AWS access · tenant-aware data model · evidence-backed controls</span>
        </footer>
      </main>
    </div>
  );
}
