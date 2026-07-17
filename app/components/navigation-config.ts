import type { Capability } from "../../lib/auth-policy";
import type { KubernetesSection } from "../kubernetes/kubernetes-sections";

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
  | "access"
  | "notification_settings"
  | "kubernetes_overview"
  | "kubernetes_inventory"
  | "kubernetes_security"
  | "kubernetes_attack_paths"
  | "kubernetes_admission"
  | "kubernetes_supply_chain"
  | "kubernetes_onboard"
  | `kubernetes_${KubernetesSection}`
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
  readonly key: "overview" | "onboarding" | "cmdb" | "kubernetes" | "security" | "compliance" | "finops" | "operations" | "administration";
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
    key: "kubernetes",
    label: "Kubernetes",
    items: [
      { key: "kubernetes_overview", label: "Cluster overview", href: "/kubernetes", icon: "KO", capabilities: readConnection },
      { key: "kubernetes_onboard", label: "Onboard cluster", href: "/kubernetes/onboard", icon: "+", capabilities: ["connection:manage"] },
      { key: "kubernetes_clusters", label: "Clusters", href: "/kubernetes/clusters", icon: "CL", capabilities: readConnection },
      { key: "kubernetes_namespaces", label: "Namespaces", href: "/kubernetes/namespaces", icon: "NS", capabilities: readConnection },
      { key: "kubernetes_workloads", label: "Workloads", href: "/kubernetes/workloads", icon: "WL", capabilities: readConnection },
      { key: "kubernetes_images", label: "Images & vulnerabilities", href: "/kubernetes/images", icon: "IM", capabilities: readConnection },
      { key: "kubernetes_supply_chain", label: "Software supply chain", href: "/kubernetes/supply-chain", icon: "SC", capabilities: readConnection },
      { key: "kubernetes_exposure", label: "Exposure", href: "/kubernetes/exposure", icon: "EX", capabilities: readConnection },
      { key: "kubernetes_attack_paths", label: "Attack paths", href: "/kubernetes/attack-paths", icon: "AP", capabilities: readConnection },
      { key: "kubernetes_rbac", label: "RBAC", href: "/kubernetes/rbac", icon: "RB", capabilities: readConnection },
      { key: "kubernetes_network", label: "Network", href: "/kubernetes/network", icon: "NW", capabilities: readConnection },
      { key: "kubernetes_runtime", label: "Runtime", href: "/kubernetes/runtime", icon: "RT", capabilities: readConnection },
      { key: "kubernetes_compliance", label: "Compliance", href: "/kubernetes/compliance", icon: "CO", capabilities: readConnection },
      { key: "kubernetes_admission", label: "Admission control", href: "/kubernetes/admission", icon: "AD", capabilities: readConnection },
      { key: "kubernetes_policies", label: "Policies", href: "/kubernetes/policies", icon: "PO", capabilities: readConnection },
      { key: "kubernetes_scan-history", label: "Scan history", href: "/kubernetes/scan-history", icon: "SH", capabilities: readConnection },
      { key: "kubernetes_coverage", label: "Coverage", href: "/kubernetes/coverage", icon: "CV", capabilities: readConnection },
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
  {
    key: "administration",
    label: "Administration",
    items: [
      { key: "access", label: "Access & invitations", href: "/access", icon: "AI", capabilities: ["membership:manage"] },
      { key: "notification_settings", label: "Notification destinations", href: "/settings/notifications", icon: "NT", capabilities: readConnection },
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
