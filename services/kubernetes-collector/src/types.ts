export type KubernetesAuthInput =
  | {
      readonly kind: "bearer";
      readonly token: string;
      readonly certificateAuthorityPem?: string;
    }
  | {
      readonly kind: "kubeconfig";
      /** A trusted server-side parse of a kubeconfig JSON/YAML document. */
      readonly document: KubernetesKubeconfig;
      readonly contextName?: string;
    };

export interface KubernetesKubeconfig {
  readonly "current-context"?: unknown;
  readonly clusters?: unknown;
  readonly contexts?: unknown;
  readonly users?: unknown;
  readonly [key: string]: unknown;
}

/**
 * This object is a server-to-collector contract, never an HTTP request body.
 * The explicit trust marker makes accidental use of untrusted browser JSON
 * fail closed at the collector boundary.
 */
export interface TrustedKubernetesConnection {
  readonly trust: "server-side";
  readonly clusterId: string;
  readonly clusterName: string;
  readonly serverUrl?: string;
  readonly auth: KubernetesAuthInput;
}

export type KubernetesResourceKind =
  | "cluster"
  | "namespace"
  | "deployment"
  | "statefulset"
  | "daemonset"
  | "pod"
  | "service"
  | "ingress"
  | "networkpolicy"
  | "role"
  | "rolebinding"
  | "clusterrole"
  | "clusterrolebinding"
  | "node";

export type SafeKubernetesValue = string | number | boolean | null |
  readonly SafeKubernetesValue[] | { readonly [key: string]: SafeKubernetesValue };

export interface KubernetesResource {
  readonly resourceKey: string;
  readonly clusterId: string;
  readonly kind: KubernetesResourceKind;
  readonly apiVersion: string;
  readonly namespace: string | null;
  readonly name: string;
  readonly uid: string | null;
  readonly labels: Readonly<Record<string, string>>;
  readonly state: string;
  readonly configuration: Readonly<Record<string, SafeKubernetesValue>>;
  readonly provenance: {
    readonly apiPath: string;
    readonly collectedAt: string;
    readonly resourceVersion: string | null;
  };
}

export interface KubernetesCollectorCoverage {
  readonly collectorKey: string;
  readonly apiPath: string;
  readonly status: "succeeded" | "failed" | "not_configured";
  readonly itemsObserved: number;
  readonly pagesObserved: number;
  readonly errorCode?: string;
  readonly message?: string;
}

export type TrivyOperatorSource =
  | "vulnerability_report"
  | "config_audit_report"
  | "rbac_assessment_report"
  | "cluster_rbac_assessment_report";

export type TrivyOperatorSeverity = "critical" | "high" | "medium" | "low" | "unknown";

export interface TrivyScannerProvenance {
  readonly name: string;
  readonly vendor: string;
  readonly version: string;
  readonly reportUid: string;
  readonly reportResourceVersion: string | null;
  readonly reportUpdatedAt: string | null;
}

export interface TrivyOperatorFinding {
  readonly fingerprint: string;
  readonly clusterId: string;
  readonly source: TrivyOperatorSource;
  readonly severity: TrivyOperatorSeverity;
  readonly namespace: string | null;
  readonly reportName: string;
  readonly affectedResource: {
    readonly kind: string | null;
    readonly namespace: string | null;
    readonly name: string | null;
  };
  readonly title: string;
  readonly checkId: string | null;
  readonly cveId: string | null;
  readonly packageName: string | null;
  readonly packageType: string | null;
  readonly installedVersion: string | null;
  readonly fixedVersion: string | null;
  readonly target: string | null;
  readonly score: number | null;
  readonly remediation: string | null;
  readonly scanner: TrivyScannerProvenance;
}

export interface TrivySbomComponent {
  readonly fingerprint: string;
  readonly type: string | null;
  readonly name: string;
  readonly version: string | null;
  readonly packageUrl: string | null;
  /** Exact license identifiers reported by the SBOM; never inferred. */
  readonly licenses?: readonly string[];
}

export interface TrivySbomEvidence {
  readonly fingerprint: string;
  readonly clusterId: string;
  readonly namespace: string | null;
  readonly reportName: string;
  readonly affectedResource: {
    readonly kind: string | null;
    readonly namespace: string | null;
    readonly name: string | null;
  };
  readonly artifact: {
    readonly repository: string | null;
    readonly digest: string | null;
    readonly tag: string | null;
  };
  readonly bomFormat: string | null;
  readonly specVersion: string | null;
  readonly declaredComponentCount: number | null;
  readonly declaredDependencyCount: number | null;
  readonly components: readonly TrivySbomComponent[];
  readonly scanner: TrivyScannerProvenance;
}

export interface KubernetesSnapshot {
  readonly schemaVersion: "sutra.kubernetes.inventory.v1";
  readonly clusterId: string;
  readonly clusterName: string;
  readonly collectedAt: string;
  readonly resources: readonly KubernetesResource[];
  readonly coverage: readonly KubernetesCollectorCoverage[];
  /** Optional evidence imported from exact Trivy Operator report CRDs. */
  readonly trivyFindings: readonly TrivyOperatorFinding[];
  readonly trivySboms: readonly TrivySbomEvidence[];
}
