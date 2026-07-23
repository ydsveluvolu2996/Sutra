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
  | "showback"
  | "compliance"
  | "compliance_frameworks"
  | "reports"
  | "report_builder"
  | "alerts"
  | "patch"
  | "cmdb_dependencies"
  | "cmdb_assets"
  | "docs"
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
  readonly capabilities: readonly Capability[];
}

export interface NavSection {
  readonly label: string;
  readonly keys: readonly NavKey[];
}

export interface NavGroup {
  readonly key: "overview" | "onboarding" | "cmdb" | "kubernetes" | "security" | "compliance" | "finops" | "operations";
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
      { key: "overview", label: "Executive dashboard", href: "/dashboard", capabilities: readWorkspace },
    ],
  },
  {
    key: "onboarding",
    label: "Onboarding",
    items: [
      { key: "onboard_client", label: "Onboard a client", href: "/onboard/client", capabilities: ["customer:create", "connection:manage"] },
      { key: "customers", label: "Customers & accounts", href: "/customers", capabilities: readWorkspace },
      { key: "onboard", label: "Add AWS account", href: "/onboard", capabilities: ["customer:create", "connection:manage"] },
      { key: "connection_health", label: "Connection health", href: "/onboard#connection-lifecycle", capabilities: readConnection },
    ],
  },
  {
    key: "cmdb",
    label: "CMDB",
    items: [
      { key: "cmdb", label: "Resource inventory", href: "/cmdb", capabilities: readConnection },
      { key: "changes", label: "Change history", href: "/changes", capabilities: readConnection },
      { key: "cmdb_dependencies", label: "Dependencies", href: "/cmdb/dependencies", capabilities: readConnection },
      { key: "cmdb_assets", label: "Custom assets", href: "/cmdb/assets", capabilities: readConnection },
    ],
  },
  {
    key: "kubernetes",
    label: "Kubernetes",
    items: [
      { key: "kubernetes_overview", label: "Cluster overview", href: "/kubernetes", capabilities: readConnection },
      { key: "kubernetes_fleet", label: "Fleet health", href: "/kubernetes/fleet", capabilities: readConnection },
      { key: "kubernetes_trends", label: "Posture trends", href: "/kubernetes/trends", capabilities: readConnection },
      { key: "kubernetes_onboard", label: "Onboard cluster", href: "/kubernetes/onboard", capabilities: ["connection:manage"] },
      { key: "kubernetes_clusters", label: "Clusters", href: "/kubernetes/clusters", capabilities: readConnection },
      { key: "kubernetes_namespaces", label: "Namespaces", href: "/kubernetes/namespaces", capabilities: readConnection },
      { key: "kubernetes_workloads", label: "Workloads", href: "/kubernetes/workloads", capabilities: readConnection },
      { key: "kubernetes_images", label: "Images & vulnerabilities", href: "/kubernetes/images", capabilities: readConnection },
      { key: "kubernetes_vulnerability_updates", label: "Vulnerability updates", href: "/kubernetes/vulnerability-updates", capabilities: readConnection },
      { key: "kubernetes_vulnerability_management", label: "Vulnerability management", href: "/kubernetes/vulnerability-management", capabilities: readConnection },
      { key: "kubernetes_supply_chain", label: "Software supply chain", href: "/kubernetes/supply-chain", capabilities: readConnection },
      { key: "kubernetes_exposure", label: "Exposure", href: "/kubernetes/exposure", capabilities: readConnection },
      { key: "kubernetes_issues", label: "Issues", href: "/kubernetes/issues", capabilities: readConnection },
      { key: "kubernetes_attack_paths", label: "Attack paths", href: "/kubernetes/attack-paths", capabilities: readConnection },
      { key: "kubernetes_rbac", label: "RBAC", href: "/kubernetes/rbac", capabilities: readConnection },
      { key: "kubernetes_permissions", label: "Effective permissions", href: "/kubernetes/permissions", capabilities: readConnection },
      { key: "kubernetes_iam", label: "AWS IAM CIEM", href: "/kubernetes/iam", capabilities: readConnection },
      { key: "kubernetes_network", label: "Network", href: "/kubernetes/network", capabilities: readConnection },
      { key: "kubernetes_runtime", label: "Runtime", href: "/kubernetes/runtime", capabilities: readConnection },
      { key: "kubernetes_drift", label: "Drift", href: "/kubernetes/drift", capabilities: readConnection },
      { key: "kubernetes_compliance", label: "Compliance", href: "/kubernetes/compliance", capabilities: readConnection },
      { key: "kubernetes_admission", label: "Admission control", href: "/kubernetes/admission", capabilities: readConnection },
      { key: "kubernetes_policies", label: "Policies", href: "/kubernetes/policies", capabilities: readConnection },
      { key: "kubernetes_scan-history", label: "Scan history", href: "/kubernetes/scan-history", capabilities: readConnection },
      { key: "kubernetes_coverage", label: "Coverage", href: "/kubernetes/coverage", capabilities: readConnection },
      { key: "kubernetes_inventory", label: "Inventory", href: "/kubernetes/inventory", capabilities: readConnection },
      { key: "kubernetes_security", label: "Security findings", href: "/kubernetes/security", capabilities: readConnection },
    ],
    sections: [
      { label: "Inventory", keys: ["kubernetes_overview", "kubernetes_clusters", "kubernetes_namespaces", "kubernetes_workloads", "kubernetes_inventory", "kubernetes_coverage", "kubernetes_scan-history"] },
      { label: "Vulnerabilities", keys: ["kubernetes_images", "kubernetes_vulnerability_updates", "kubernetes_vulnerability_management", "kubernetes_supply_chain"] },
      { label: "Posture & compliance", keys: ["kubernetes_trends", "kubernetes_compliance", "kubernetes_admission", "kubernetes_policies", "kubernetes_drift"] },
      { label: "Identity", keys: ["kubernetes_rbac", "kubernetes_permissions", "kubernetes_iam"] },
      { label: "Threats & network", keys: ["kubernetes_security", "kubernetes_issues", "kubernetes_attack_paths", "kubernetes_exposure", "kubernetes_network", "kubernetes_runtime"] },
      { label: "Fleet & setup", keys: ["kubernetes_fleet", "kubernetes_onboard"] },
    ],
  },
  {
    key: "security",
    label: "Security",
    items: [
      { key: "findings", label: "Posture findings", href: "/findings", capabilities: readConnection },
      { key: "findings_exceptions", label: "Finding exceptions", href: "/findings/exceptions", capabilities: readConnection },
      { key: "vulnerabilities", label: "Vulnerability & exposure", href: "/vulnerabilities", capabilities: readConnection },
      { key: "vulnerabilities_exploitability", label: "Exploitability ranking", href: "/vulnerabilities/exploitability", capabilities: readConnection },
      { key: "network_exposure", label: "Network exposure", href: "/network-exposure", capabilities: readConnection },
      { key: "registry_inventory", label: "Registry inventory", href: "/registry/inventory", capabilities: readConnection },
      { key: "iac_scan", label: "IaC scan", href: "/iac-scan", capabilities: readWorkspace },
      { key: "security_events", label: "Security events", href: "/security-events", capabilities: readConnection },
      { key: "cloud_detections", label: "Cloud detections", href: "/cloud-detections", capabilities: readConnection },
      { key: "cases", label: "Remediation cases", href: "/cases", capabilities: readConnection },
      { key: "cases_routing", label: "Case routing", href: "/cases/routing", capabilities: readConnection },
    ],
  },
  {
    key: "compliance",
    label: "Compliance",
    items: [
      { key: "compliance", label: "Compliance posture", href: "/compliance", capabilities: readConnection },
      { key: "compliance_frameworks", label: "Compliance frameworks", href: "/compliance-frameworks", capabilities: readConnection },
      { key: "controls", label: "Control library", href: "/controls", capabilities: readWorkspace },
      { key: "reports", label: "Executive reports", href: "/reports", capabilities: readConnection },
      { key: "report_builder", label: "Report builder", href: "/reports/builder", capabilities: readConnection },
    ],
  },
  {
    key: "finops",
    label: "FinOps",
    items: [
      { key: "costs", label: "AWS costs", href: "/costs", capabilities: readConnection },
      { key: "showback", label: "Customer showback", href: "/costs/showback", capabilities: readConnection },
    ],
  },
  {
    key: "operations",
    label: "Operations",
    items: [
      { key: "operations", label: "Collection runs", href: "/operations", capabilities: ["sync:run"] },
      { key: "alerts", label: "Alerts", href: "/alerts", capabilities: readConnection },
      { key: "patch", label: "Patch management", href: "/patch", capabilities: readConnection },
      { key: "roadmap", label: "Product roadmap", href: "/roadmap", capabilities: readWorkspace },
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
