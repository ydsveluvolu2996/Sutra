import type { ReactNode } from "react";
import type { NavKey } from "./navigation-config";

// Hand-drawn line icons (24px grid, 1.75 stroke, currentColor) so the product
// ships no icon-font or CDN dependency. Each nav destination maps to a glyph by
// meaning, not by its legacy two-letter code.
type IconName =
  | "dashboard" | "users" | "userPlus" | "plus" | "activity" | "pulse"
  | "server" | "history" | "hexagon" | "cube" | "folders" | "grid"
  | "layers" | "supplyChain" | "globe" | "target" | "key" | "network"
  | "shieldCheck" | "policy" | "scan" | "alert" | "bug" | "siren"
  | "wrench" | "clipboardCheck" | "listChecks" | "fileText" | "dollar"
  | "refresh" | "map" | "bell" | "alertOctagon" | "gear" | "trendUp" | "diff" | "dot";

const PATHS: Readonly<Record<IconName, ReactNode>> = {
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.3" /><rect x="14" y="3" width="7" height="5" rx="1.3" /><rect x="14" y="12" width="7" height="9" rx="1.3" /><rect x="3" y="16" width="7" height="5" rx="1.3" /></>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
  userPlus: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M22 11h-6" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  activity: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  pulse: <><path d="M3.5 12h4l2-5 4 10 2-5h5" /><path d="M20.8 8.6a4 4 0 0 0-6.3-4.8" /></>,
  server: <><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
  history: <><path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.4 2.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7.5V12l3 2" /></>,
  hexagon: <><path d="M12 2.5 3.5 7v10L12 21.5 20.5 17V7z" /><path d="M12 8l4 2.3v3.4L12 16l-4-2.3v-3.4z" /></>,
  cube: <><path d="M12 2.5 3.5 7 12 11.5 20.5 7z" /><path d="M3.5 7v10L12 21.5 20.5 17V7" /><path d="M12 11.5v10" /></>,
  folders: <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
  grid: <><rect x="3" y="3" width="8" height="8" rx="1.3" /><rect x="13" y="3" width="8" height="8" rx="1.3" /><rect x="3" y="13" width="8" height="8" rx="1.3" /><rect x="13" y="13" width="8" height="8" rx="1.3" /></>,
  layers: <><path d="m12 2.5 9 4.7-9 4.7-9-4.7z" /><path d="m3 12 9 4.7 9-4.7" /><path d="m3 16.8 9 4.7 9-4.7" /></>,
  supplyChain: <><circle cx="6" cy="18" r="2.6" /><circle cx="18" cy="6" r="2.6" /><path d="M6 15.4V8a2 2 0 0 1 2-2h7.4" /><path d="M18 8.6V16a2 2 0 0 1-2 2H8.6" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z" /></>,
  target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.2" /></>,
  key: <><circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 8-8" /><path d="m15.5 5.5 3 3" /><path d="m18 3 3 3" /></>,
  network: <><circle cx="18" cy="5" r="2.6" /><circle cx="6" cy="12" r="2.6" /><circle cx="18" cy="19" r="2.6" /><path d="m8.4 13.4 7.2 4.3M15.6 6.3 8.4 10.6" /></>,
  shieldCheck: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m8.8 12 2.2 2.2 4.2-4.4" /></>,
  policy: <><path d="M8 3h9a2 2 0 0 1 2 2v13a2 2 0 0 0 2 2H7a2 2 0 0 1-2-2V6" /><path d="M5 6a2 2 0 0 1 4 0" /><path d="M9 8.5h6.5M9 12h6.5M9 15.5h4" /></>,
  scan: <><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M3 12h18" /></>,
  alert: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4.5M12 17.5h.01" /></>,
  bug: <><path d="M12 20a6 6 0 0 0 6-6v-3a6 6 0 0 0-12 0v3a6 6 0 0 0 6 6Z" /><path d="M12 8V20M3 13h3M18 13h3M4.5 8 7 9.5M19.5 8 17 9.5M4.5 18 7 16.5M19.5 18 17 16.5" /><path d="M9 3.5 10.5 5M15 3.5 13.5 5" /></>,
  siren: <><path d="M7 18v-6a5 5 0 0 1 10 0v6" /><path d="M5 21h14" /><path d="M12 2.5v2M4.2 6.7l1.4 1.4M19.8 6.7l-1.4 1.4" /></>,
  wrench: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-2.4 2.6-2.6z" />,
  clipboardCheck: <><rect x="8" y="2.5" width="8" height="4" rx="1.2" /><path d="M16 4.5h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h2" /><path d="m9 14 2 2 4-4" /></>,
  listChecks: <><path d="M11 6h9M11 12h9M11 18h9" /><path d="m3 6 1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2" /></>,
  fileText: <><path d="M14 2.5H6a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.5z" /><path d="M14 2.5v6h6" /><path d="M9 13.5h6M9 17h6" /></>,
  dollar: <><path d="M12 2v20" /><path d="M17 6.2C17 4.4 14.8 3 12 3S7 4.4 7 6.2 9.2 9.5 12 9.5s5 1.7 5 3.5-2.2 3.3-5 3.3-5-1.5-5-3.3" /></>,
  refresh: <><path d="M21 12a9 9 0 1 1-2.6-6.4L21 8" /><path d="M21 3v5h-5" /></>,
  map: <><path d="M9 3 3 6v15l6-3 6 3 6-3V3l-6 3z" /><path d="M9 3v15M15 6v15" /></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9Z" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></>,
  alertOctagon: <><path d="M7.9 2.6 2.6 7.9a2 2 0 0 0-.6 1.4v5.4a2 2 0 0 0 .6 1.4l5.3 5.3a2 2 0 0 0 1.4.6h5.4a2 2 0 0 0 1.4-.6l5.3-5.3a2 2 0 0 0 .6-1.4V9.3a2 2 0 0 0-.6-1.4L16.1 2.6a2 2 0 0 0-1.4-.6H9.3a2 2 0 0 0-1.4.6Z" /><path d="M12 8v4.5M12 16h.01" /></>,
  trendUp: <><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></>,
  diff: <><path d="M12 3v6M9 6h6" /><path d="M5 15h14" /><path d="M8 18h8" /><rect x="3" y="3" width="18" height="18" rx="3" opacity="0" /></>,
  gear: <><circle cx="12" cy="12" r="3.2" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9.3a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></>,
  dot: <circle cx="12" cy="12" r="3.2" />,
};

const KEY_ICON: Partial<Record<NavKey, IconName>> = {
  overview: "dashboard",
  customers: "users",
  onboard: "plus",
  connection_health: "pulse",
  cmdb: "server",
  changes: "history",
  kubernetes_overview: "hexagon",
  kubernetes_fleet: "pulse",
  kubernetes_trends: "trendUp",
  kubernetes_issues: "alertOctagon",
  kubernetes_onboard: "plus",
  kubernetes_clusters: "cube",
  kubernetes_namespaces: "folders",
  kubernetes_workloads: "grid",
  kubernetes_images: "layers",
  kubernetes_vulnerability_updates: "bug",
  kubernetes_supply_chain: "supplyChain",
  kubernetes_exposure: "globe",
  kubernetes_attack_paths: "target",
  kubernetes_rbac: "key",
  kubernetes_permissions: "key",
  kubernetes_network: "network",
  kubernetes_runtime: "activity",
  kubernetes_drift: "diff",
  kubernetes_compliance: "shieldCheck",
  kubernetes_admission: "shieldCheck",
  kubernetes_policies: "policy",
  "kubernetes_scan-history": "history",
  kubernetes_coverage: "scan",
  findings: "alert",
  vulnerabilities: "bug",
  security_events: "siren",
  cases: "wrench",
  compliance: "clipboardCheck",
  controls: "listChecks",
  reports: "fileText",
  costs: "dollar",
  operations: "refresh",
  roadmap: "map",
  access: "userPlus",
  settings: "gear",
  notification_settings: "bell",
};

// Feature colors, Wiz-style: each destination carries a semantic hue so the
// sidebar reads as a colorful, scannable map. Security is red, governance is
// green, discovery is blue, supply chain is violet, cost/ops is amber, and so
// on. The tone drives the icon chip color in globals.css via a data attribute.
export type NavTone =
  | "blue" | "indigo" | "cyan" | "teal" | "green"
  | "amber" | "orange" | "red" | "violet" | "slate";

const KEY_TONE: Partial<Record<NavKey, NavTone>> = {
  overview: "cyan",
  customers: "blue",
  onboard: "green",
  connection_health: "teal",
  cmdb: "indigo",
  changes: "slate",
  kubernetes_overview: "blue",
  kubernetes_fleet: "teal",
  kubernetes_trends: "green",
  kubernetes_issues: "red",
  kubernetes_onboard: "green",
  kubernetes_clusters: "blue",
  kubernetes_namespaces: "amber",
  kubernetes_workloads: "indigo",
  kubernetes_images: "violet",
  kubernetes_vulnerability_updates: "red",
  kubernetes_supply_chain: "violet",
  kubernetes_exposure: "orange",
  kubernetes_attack_paths: "red",
  kubernetes_rbac: "amber",
  kubernetes_permissions: "amber",
  kubernetes_network: "cyan",
  kubernetes_runtime: "red",
  kubernetes_drift: "orange",
  kubernetes_compliance: "green",
  kubernetes_admission: "green",
  kubernetes_policies: "blue",
  "kubernetes_scan-history": "slate",
  kubernetes_coverage: "teal",
  findings: "orange",
  vulnerabilities: "red",
  security_events: "red",
  cases: "amber",
  compliance: "green",
  controls: "blue",
  reports: "violet",
  costs: "amber",
  operations: "cyan",
  roadmap: "violet",
  access: "blue",
  settings: "slate",
  notification_settings: "amber",
};

export function navTone(navKey: NavKey): NavTone {
  return KEY_TONE[navKey] ?? "slate";
}

export function NavIcon({ navKey }: { readonly navKey: NavKey }) {
  const name = KEY_ICON[navKey] ?? "dot";
  return (
    <svg
      className="nav-glyph"
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
