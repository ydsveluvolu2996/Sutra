import type { Capability } from "../../lib/auth-policy";
import type { KubernetesSection } from "../kubernetes/kubernetes-sections";

export type NavKey =
  | "overview"
  | "customers"
  | "cmdb"
  | "changes"
  | "findings"
  | "findings_exceptions"
  | "vulnerabilities"
  | "vulnerabilities_exploitability"
  | "network_exposure"
  | "registry_inventory"
  | "iac_scan"
  | "security_events"
  | "cloud_detections"
  | "cases_routing"
  | "cases"
  | "costs"
  | "compliance"
  | "compliance_frameworks"
  | "reports"
  | "controls"
  | "roadmap"
  | "operations"
  | "access"
  | "settings"
  | "notification_settings"
  | "kubernetes_overview"
  | "kubernetes_fleet"
  | "kubernetes_trends"
  | "kubernetes_issues"
  | "kubernetes_permissions"
  | "kubernetes_iam"
  | "kubernetes_vulnerability_updates"
  | "kubernetes_vulnerability_management"
  | "kubernetes_drift"
  | "kubernetes_inventory"
  | "kubernetes_security"
  | "kubernetes_attack_paths"
  | "kubernetes_admission"
  | "kubernetes_supply_chain"
  | "kubernetes_onboard"
  | `kubernetes_${KubernetesSection}`
  | "onboard"
  | "onboard_client"
  | "connection_health";

export interface NavItem {
  readonly key: NavKey;
  readonly label: string;
  readonly href: string;
  readonly icon: string;
  readonly capabilities: readonly Capability[];
}

export interface NavSection {
  readonly label: string;
  readonly keys: readonly NavKey[];
}

export interface NavGroup {
  readonly key: "overview" | "onboarding" | "cmdb" | "kubernetes" | "security" | "compliance" | "finops" | "operations" | "administration";
  readonly label: string;
  readonly items: readonly NavItem[];
  /**
   * Optional display-only sub-sectioning for large groups. `items` stays the
   * authoritative, capability-filtered list; sections only regroup those items
   * under labels for rendering. Every visible item must appear in exactly one
   * section (enforced by tests) so nothing is hidden.
   */
  readonly sections?: readonly NavSection[];
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
      { key: "onboard_client", label: "Onboard a client", href: "/onboard/client", icon: "OC", capabilities: ["customer:create", "connection:manage"] },
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
      { key: "kubernetes_fleet", label: "Fleet health", href: "/kubernetes/fleet", icon: "FH", capabilities: readConnection },
      { key: "kubernetes_trends", label: "Posture trends", href: "/kubernetes/trends", icon: "TR", capabilities: readConnection },
      { key: "kubernetes_onboard", label: "Onboard cluster", href: "/kubernetes/onboard", icon: "+", capabilities: ["connection:manage"] },
      { key: "kubernetes_clusters", label: "Clusters", href: "/kubernetes/clusters", icon: "CL", capabilities: readConnection },
      { key: "kubernetes_namespaces", label: "Namespaces", href: "/kubernetes/namespaces", icon: "NS", capabilities: readConnection },
      { key: "kubernetes_workloads", label: "Workloads", href: "/kubernetes/workloads", icon: "WL", capabilities: readConnection },
      { key: "kubernetes_images", label: "Images & vulnerabilities", href: "/kubernetes/images", icon: "IM", capabilities: readConnection },
      { key: "kubernetes_vulnerability_updates", label: "Vulnerability updates", href: "/kubernetes/vulnerability-updates", icon: "VU", capabilities: readConnection },
      { key: "kubernetes_vulnerability_management", label: "Vulnerability management", href: "/kubernetes/vulnerability-management", icon: "VM", capabilities: readConnection },
      { key: "kubernetes_supply_chain", label: "Software supply chain", href: "/kubernetes/supply-chain", icon: "SC", capabilities: readConnection },
      { key: "kubernetes_exposure", label: "Exposure", href: "/kubernetes/exposure", icon: "EX", capabilities: readConnection },
      { key: "kubernetes_issues", label: "Issues", href: "/kubernetes/issues", icon: "IS", capabilities: readConnection },
      { key: "kubernetes_attack_paths", label: "Attack paths", href: "/kubernetes/attack-paths", icon: "AP", capabilities: readConnection },
      { key: "kubernetes_rbac", label: "RBAC", href: "/kubernetes/rbac", icon: "RB", capabilities: readConnection },
      { key: "kubernetes_permissions", label: "Effective permissions", href: "/kubernetes/permissions", icon: "EP", capabilities: readConnection },
      { key: "kubernetes_iam", label: "AWS IAM CIEM", href: "/kubernetes/iam", icon: "IA", capabilities: readConnection },
      { key: "kubernetes_network", label: "Network", href: "/kubernetes/network", icon: "NW", capabilities: readConnection },
      { key: "kubernetes_runtime", label: "Runtime", href: "/kubernetes/runtime", icon: "RT", capabilities: readConnection },
      { key: "kubernetes_drift", label: "Drift", href: "/kubernetes/drift", icon: "DR", capabilities: readConnection },
      { key: "kubernetes_compliance", label: "Compliance", href: "/kubernetes/compliance", icon: "CO", capabilities: readConnection },
      { key: "kubernetes_admission", label: "Admission control", href: "/kubernetes/admission", icon: "AD", capabilities: readConnection },
      { key: "kubernetes_policies", label: "Policies", href: "/kubernetes/policies", icon: "PO", capabilities: readConnection },
      { key: "kubernetes_scan-history", label: "Scan history", href: "/kubernetes/scan-history", icon: "SH", capabilities: readConnection },
      { key: "kubernetes_coverage", label: "Coverage", href: "/kubernetes/coverage", icon: "CV", capabilities: readConnection },
    ],
    sections: [
      { label: "Inventory", keys: ["kubernetes_overview", "kubernetes_clusters", "kubernetes_namespaces", "kubernetes_workloads", "kubernetes_coverage", "kubernetes_scan-history"] },
      { label: "Vulnerabilities", keys: ["kubernetes_images", "kubernetes_vulnerability_updates", "kubernetes_vulnerability_management", "kubernetes_supply_chain"] },
      { label: "Posture & compliance", keys: ["kubernetes_trends", "kubernetes_compliance", "kubernetes_admission", "kubernetes_policies", "kubernetes_drift"] },
      { label: "Identity", keys: ["kubernetes_rbac", "kubernetes_permissions", "kubernetes_iam"] },
      { label: "Threats & network", keys: ["kubernetes_issues", "kubernetes_attack_paths", "kubernetes_exposure", "kubernetes_network", "kubernetes_runtime"] },
      { label: "Fleet & setup", keys: ["kubernetes_fleet", "kubernetes_onboard"] },
    ],
  },
  {
    key: "security",
    label: "Security",
    items: [
      { key: "findings", label: "Posture findings", href: "/findings", icon: "PF", capabilities: readConnection },
      { key: "findings_exceptions", label: "Finding exceptions", href: "/findings/exceptions", icon: "FE", capabilities: readConnection },
      { key: "vulnerabilities", label: "Vulnerability & exposure", href: "/vulnerabilities", icon: "VX", capabilities: readConnection },
      { key: "vulnerabilities_exploitability", label: "Exploitability ranking", href: "/vulnerabilities/exploitability", icon: "XP", capabilities: readConnection },
      { key: "network_exposure", label: "Network exposure", href: "/network-exposure", icon: "NX", capabilities: readConnection },
      { key: "registry_inventory", label: "Registry inventory", href: "/registry/inventory", icon: "RG", capabilities: readConnection },
      { key: "iac_scan", label: "IaC scan", href: "/iac-scan", icon: "IA", capabilities: readWorkspace },
      { key: "security_events", label: "Security events", href: "/security-events", icon: "SE", capabilities: readConnection },
      { key: "cloud_detections", label: "Cloud detections", href: "/cloud-detections", icon: "CD", capabilities: readConnection },
      { key: "cases", label: "Remediation cases", href: "/cases", icon: "RC", capabilities: readConnection },
      { key: "cases_routing", label: "Case routing", href: "/cases/routing", icon: "CR", capabilities: readConnection },
    ],
  },
  {
    key: "compliance",
    label: "Compliance",
    items: [
      { key: "compliance", label: "Compliance posture", href: "/compliance", icon: "CP", capabilities: readConnection },
      { key: "compliance_frameworks", label: "Compliance frameworks", href: "/compliance-frameworks", icon: "CF", capabilities: readConnection },
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
      { key: "settings", label: "Settings", href: "/settings", icon: "SG", capabilities: readWorkspace },
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
