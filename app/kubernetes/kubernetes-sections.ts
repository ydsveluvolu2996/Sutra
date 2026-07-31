export const KUBERNETES_SECTION_KEYS = [
  "clusters",
  "namespaces",
  "workloads",
  "images",
  "exposure",
  "rbac",
  "network",
  "runtime",
  "compliance",
  "policies",
  "scan-history",
  "coverage",
] as const;

export type KubernetesSection = (typeof KUBERNETES_SECTION_KEYS)[number];

export interface KubernetesSectionDefinition {
  readonly key: KubernetesSection;
  readonly label: string;
  readonly title: string;
  readonly description: string;
}

export const KUBERNETES_SECTIONS: readonly KubernetesSectionDefinition[] = [
  { key: "clusters", label: "Clusters", title: "Kubernetes clusters", description: "Observed EKS and Kubernetes cluster resources from the authorized CMDB projection." },
  { key: "namespaces", label: "Namespaces", title: "Namespaces", description: "Reported namespace objects and their normalized cluster relationships." },
  { key: "workloads", label: "Workloads", title: "Workloads", description: "Reported deployments, stateful workloads, daemon workloads, jobs and pods." },
  { key: "images", label: "Images & vulnerabilities", title: "Images & vulnerabilities", description: "Only reported container image references and source-native vulnerability findings." },
  { key: "exposure", label: "Exposure", title: "Workload exposure", description: "Reported network resources and findings whose normalized evidence describes exposure." },
  { key: "rbac", label: "RBAC", title: "Kubernetes RBAC", description: "Reported roles, bindings and service accounts. Effective-permission simulation is not inferred." },
  { key: "network", label: "Network", title: "Kubernetes network", description: "Reported services, ingresses, endpoints and network policies." },
  { key: "runtime", label: "Runtime", title: "Runtime security", description: "Signed Falco heartbeat and normalized runtime evidence for enrolled clusters, with missing sensor coverage disclosed." },
  { key: "compliance", label: "Compliance", title: "Kubernetes compliance", description: "Evidence-backed Kubernetes control results, not certification or audit opinion." },
  { key: "policies", label: "Policies", title: "Policy results", description: "Observed control and admission-policy results; enforcement is reported only from collected evidence and applied through customer-controlled GitOps." },
  { key: "scan-history", label: "Scan history", title: "Kubernetes scan history", description: "Kubernetes-specific collection history when the normalized API reports it." },
  { key: "coverage", label: "Coverage", title: "Kubernetes coverage", description: "Exact collector checks and unsupported visibility boundaries." },
] as const;

export function kubernetesSection(value: string): KubernetesSectionDefinition | null {
  return KUBERNETES_SECTIONS.find((section) => section.key === value) ?? null;
}
