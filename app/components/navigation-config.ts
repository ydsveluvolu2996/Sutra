import type { Capability } from "../../lib/auth-policy";

export type NavKey =
  | "overview"
  | "customers"
  | "cmdb"
  | "changes"
  | "findings"
  | "vulnerabilities"
  | "security_events"
  | "cases"
  | "costs"
  | "compliance"
  | "reports"
  | "controls"
  | "roadmap"
  | "operations"
  | "onboard"
  | "connection_health";

export interface NavItem {
  readonly key: NavKey;
  readonly label: string;
  readonly href: string;
  readonly icon: string;
  readonly capabilities: readonly Capability[];
}

export interface NavGroup {
  readonly key: "overview" | "onboarding" | "cmdb" | "security" | "compliance" | "finops" | "operations";
  readonly label: string;
  readonly items: readonly NavItem[];
}

const readWorkspace = ["workspace:read"] as const;
const readConnection = ["connection:read"] as const;

export const navGroups: readonly NavGroup[] = [
  {
    key: "overview",
    label: "Overview",
    items: [
      { key: "overview", label: "Executive dashboard", href: "/dashboard", icon: "OV", capabilities: readWorkspace },
    ],
  },
  {
    key: "onboarding",
    label: "Onboarding",
    items: [
      { key: "customers", label: "Customers & accounts", href: "/customers", icon: "CU", capabilities: readWorkspace },
      { key: "onboard", label: "Add AWS account", href: "/onboard", icon: "+", capabilities: ["customer:create", "connection:manage"] },
      { key: "connection_health", label: "Connection health", href: "/onboard#connection-lifecycle", icon: "CH", capabilities: readConnection },
    ],
  },
  {
    key: "cmdb",
    label: "CMDB",
    items: [
      { key: "cmdb", label: "Resource inventory", href: "/cmdb", icon: "RI", capabilities: readConnection },
      { key: "changes", label: "Change history", href: "/changes", icon: "CH", capabilities: readConnection },
    ],
  },
  {
    key: "security",
    label: "Security",
    items: [
      { key: "findings", label: "Posture findings", href: "/findings", icon: "PF", capabilities: readConnection },
      { key: "vulnerabilities", label: "Vulnerability & exposure", href: "/vulnerabilities", icon: "VX", capabilities: readConnection },
      { key: "security_events", label: "Security events", href: "/security-events", icon: "SE", capabilities: readConnection },
      { key: "cases", label: "Remediation cases", href: "/cases", icon: "RC", capabilities: readConnection },
    ],
  },
  {
    key: "compliance",
    label: "Compliance",
    items: [
      { key: "compliance", label: "Compliance posture", href: "/compliance", icon: "CP", capabilities: readConnection },
      { key: "controls", label: "Control library", href: "/controls", icon: "CL", capabilities: readWorkspace },
      { key: "reports", label: "Executive reports", href: "/reports", icon: "ER", capabilities: readConnection },
    ],
  },
  {
    key: "finops",
    label: "FinOps",
    items: [
      { key: "costs", label: "AWS costs", href: "/costs", icon: "$", capabilities: readConnection },
    ],
  },
  {
    key: "operations",
    label: "Operations",
    items: [
      { key: "operations", label: "Collection runs", href: "/operations", icon: "CR", capabilities: ["sync:run"] },
      { key: "roadmap", label: "Product roadmap", href: "/roadmap", icon: "PR", capabilities: readWorkspace },
    ],
  },
] as const;

export function visibleNavigation(capabilities: ReadonlySet<Capability>): readonly NavGroup[] {
  return navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => item.capabilities.every((capability) => capabilities.has(capability))),
    }))
    .filter((group) => group.items.length > 0);
}

export function groupContainsActiveItem(group: NavGroup, active: NavKey): boolean {
  return group.items.some((item) => item.key === active);
}
