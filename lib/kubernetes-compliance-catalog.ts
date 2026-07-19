export type KubernetesComplianceFrameworkKey =
  | "sutra-kubernetes-baseline"
  | "cis-kubernetes-readiness"
  | "nsa-cisa-kubernetes-hardening"
  | "soc-2-readiness";

export interface KubernetesComplianceFramework {
  readonly key: KubernetesComplianceFrameworkKey;
  readonly name: string;
  readonly version: string | null;
  readonly availability: "available" | "mapping-review-required" | "licensed-content-required";
  readonly claimBoundary: string;
}

export interface KubernetesComplianceMapping {
  readonly framework: Exclude<KubernetesComplianceFrameworkKey, "sutra-kubernetes-baseline">;
  readonly references: readonly string[];
  readonly relationship: "supports-readiness-review";
  readonly note: string;
}

export interface KubernetesComplianceControl {
  readonly controlId: string;
  readonly title: string;
  readonly mappings: readonly KubernetesComplianceMapping[];
}

const SUPPORTING_ONLY =
  "Informative readiness relationship only; validate applicability, implementation and operating effectiveness with the customer and its auditor.";
const CIS_LICENSED =
  "A licensed, current CIS benchmark is required to approve exact benchmark item mappings; Sutra does not redistribute benchmark text.";

function mappings(input: {
  readonly nsa: readonly string[];
  readonly soc2: readonly string[];
  readonly cisTheme: string;
}): readonly KubernetesComplianceMapping[] {
  return [
    {
      framework: "cis-kubernetes-readiness",
      references: [input.cisTheme],
      relationship: "supports-readiness-review",
      note: CIS_LICENSED,
    },
    {
      framework: "nsa-cisa-kubernetes-hardening",
      references: input.nsa,
      relationship: "supports-readiness-review",
      note: SUPPORTING_ONLY,
    },
    {
      framework: "soc-2-readiness",
      references: input.soc2,
      relationship: "supports-readiness-review",
      note: SUPPORTING_ONLY,
    },
  ];
}

export const KUBERNETES_COMPLIANCE_FRAMEWORKS: readonly KubernetesComplianceFramework[] = [
  {
    key: "sutra-kubernetes-baseline",
    name: "Sutra Kubernetes Baseline",
    version: "1.0.0",
    availability: "available",
    claimBoundary:
      "Sutra-owned deterministic configuration controls over the exact collected evidence; not a certification or audit opinion.",
  },
  {
    key: "cis-kubernetes-readiness",
    name: "CIS Kubernetes readiness mapping",
    version: null,
    availability: "licensed-content-required",
    claimBoundary:
      "Theme-level readiness relationships only until the customer supplies a licensed current benchmark and approves exact item mappings.",
  },
  {
    key: "nsa-cisa-kubernetes-hardening",
    name: "NSA/CISA Kubernetes Hardening readiness mapping",
    version: "2022-08",
    availability: "mapping-review-required",
    claimBoundary:
      "Supporting relationships to public hardening themes; they do not prove full implementation or operating effectiveness.",
  },
  {
    key: "soc-2-readiness",
    name: "SOC 2 readiness mapping",
    version: null,
    availability: "mapping-review-required",
    claimBoundary:
      "Informative links to Trust Services Criteria areas; the customer's controls, evidence period and independent auditor determine applicability.",
  },
] as const;

export const KUBERNETES_COMPLIANCE_CONTROLS: readonly KubernetesComplianceControl[] = [
  {
    controlId: "K8S-WORKLOAD-RUN-AS-NON-ROOT",
    title: "Containers run as non-root",
    mappings: mappings({ cisTheme: "Pod and container security context", nsa: ["Pod Security"], soc2: ["CC6.1", "CC6.6"] }),
  },
  {
    controlId: "K8S-WORKLOAD-NO-PRIVILEGED",
    title: "Privileged containers are prohibited",
    mappings: mappings({ cisTheme: "Pod and container security context", nsa: ["Pod Security"], soc2: ["CC6.1", "CC6.6"] }),
  },
  {
    controlId: "K8S-WORKLOAD-NO-PRIVILEGE-ESCALATION",
    title: "Privilege escalation is disabled",
    mappings: mappings({ cisTheme: "Pod and container security context", nsa: ["Pod Security"], soc2: ["CC6.1", "CC6.6"] }),
  },
  {
    controlId: "K8S-WORKLOAD-CAPABILITIES",
    title: "Linux capabilities are minimized",
    mappings: mappings({ cisTheme: "Pod and container security context", nsa: ["Pod Security"], soc2: ["CC6.1", "CC6.6"] }),
  },
  {
    controlId: "K8S-WORKLOAD-SECCOMP",
    title: "A safe seccomp profile is selected",
    mappings: mappings({ cisTheme: "Pod and container security context", nsa: ["Pod Security"], soc2: ["CC6.6"] }),
  },
  {
    controlId: "K8S-WORKLOAD-HOST-NAMESPACES",
    title: "Host namespaces are isolated",
    mappings: mappings({ cisTheme: "Pod and container security context", nsa: ["Pod Security"], soc2: ["CC6.6"] }),
  },
  {
    controlId: "K8S-WORKLOAD-HOST-PATH",
    title: "Host filesystem mounts are restricted",
    mappings: mappings({ cisTheme: "Pod and container security context", nsa: ["Pod Security"], soc2: ["CC6.1", "CC6.6"] }),
  },
  {
    controlId: "K8S-IMAGE-DIGEST",
    title: "Images are pinned by digest",
    mappings: mappings({ cisTheme: "Workload image integrity", nsa: ["Application Practices"], soc2: ["CC7.1", "CC8.1"] }),
  },
  {
    controlId: "K8S-IMAGE-NO-LATEST",
    title: "Mutable latest image tags are avoided",
    mappings: mappings({ cisTheme: "Workload image integrity", nsa: ["Application Practices"], soc2: ["CC7.1", "CC8.1"] }),
  },
  {
    controlId: "K8S-WORKLOAD-RESOURCES",
    title: "CPU and memory requests and limits are declared",
    mappings: mappings({ cisTheme: "Workload resource governance", nsa: ["Resource Policies"], soc2: ["CC7.1"] }),
  },
  {
    controlId: "K8S-WORKLOAD-PROBES",
    title: "Workload health probes are declared",
    mappings: mappings({ cisTheme: "Workload availability", nsa: ["Application Practices"], soc2: ["A1.2", "CC7.2"] }),
  },
  {
    controlId: "K8S-SERVICE-EXPOSURE",
    title: "External service exposure is reviewed",
    mappings: mappings({ cisTheme: "Network exposure", nsa: ["Network Separation and Hardening"], soc2: ["CC6.6", "CC7.1"] }),
  },
  {
    controlId: "K8S-INGRESS-TLS",
    title: "Ingress hosts use TLS",
    mappings: mappings({ cisTheme: "Network encryption", nsa: ["Protecting Sensitive Data"], soc2: ["CC6.7"] }),
  },
  {
    controlId: "K8S-RBAC-WILDCARDS",
    title: "RBAC wildcard grants are prohibited",
    mappings: mappings({ cisTheme: "RBAC least privilege", nsa: ["Authentication and Authorization"], soc2: ["CC6.1", "CC6.3"] }),
  },
  {
    controlId: "K8S-RBAC-ESCALATION",
    title: "RBAC escalation permissions are prohibited",
    mappings: mappings({ cisTheme: "RBAC least privilege", nsa: ["Authentication and Authorization"], soc2: ["CC6.1", "CC6.3"] }),
  },
  {
    controlId: "K8S-NAMESPACE-POD-SECURITY",
    title: "Namespace Pod Security enforcement is restricted",
    mappings: mappings({ cisTheme: "Pod Security Standards", nsa: ["Pod Security"], soc2: ["CC6.1", "CC6.6"] }),
  },
  {
    controlId: "K8S-NAMESPACE-NETWORK-POLICY",
    title: "Workload namespaces have default network isolation",
    mappings: mappings({ cisTheme: "Network policies", nsa: ["Network Separation and Hardening"], soc2: ["CC6.6", "CC7.1"] }),
  },
] as const;

export function mappingsForKubernetesControl(controlId: string): readonly KubernetesComplianceMapping[] {
  return KUBERNETES_COMPLIANCE_CONTROLS.find((control) => control.controlId === controlId)?.mappings ?? [];
}
