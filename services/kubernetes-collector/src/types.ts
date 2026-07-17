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
  readonly status: "succeeded" | "failed";
  readonly itemsObserved: number;
  readonly pagesObserved: number;
  readonly errorCode?: string;
  readonly message?: string;
}

export interface KubernetesSnapshot {
  readonly schemaVersion: "sutra.kubernetes.inventory.v1";
  readonly clusterId: string;
  readonly clusterName: string;
  readonly collectedAt: string;
  readonly resources: readonly KubernetesResource[];
  readonly coverage: readonly KubernetesCollectorCoverage[];
}
