import {
  normalizeKubernetesEvidence,
  type KubernetesEvidenceSnapshot,
} from "../../../lib/kubernetes-posture.ts";
import type {
  KubernetesContainerEvidence,
  KubernetesEvidence,
  KubernetesEvidenceKind,
  KubernetesRbacRoleEvidence,
  KubernetesWorkloadEvidence,
} from "../../../lib/kubernetes-posture.ts";
import type { KubernetesResource, KubernetesSnapshot, SafeKubernetesValue } from "./types.ts";

function objectValue(value: SafeKubernetesValue | undefined): Readonly<Record<string, SafeKubernetesValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, SafeKubernetesValue>>
    : {};
}

function nullableString(value: SafeKubernetesValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function nullableBoolean(value: SafeKubernetesValue | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function nullableStrings(value: SafeKubernetesValue | undefined): readonly string[] | null {
  if (value === null) return null;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null;
}

function numberValue(value: SafeKubernetesValue | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function workload(resource: KubernetesResource): KubernetesWorkloadEvidence | null {
  const configuration = resource.configuration;
  const workloadKind = configuration.workloadKind;
  if (
    workloadKind !== "Pod" && workloadKind !== "Deployment" && workloadKind !== "StatefulSet" &&
    workloadKind !== "DaemonSet"
  ) return null;
  const containers = Array.isArray(configuration.containers)
    ? configuration.containers.flatMap((raw): KubernetesContainerEvidence[] => {
        const item = objectValue(raw);
        const name = nullableString(item.name);
        if (name === null) return [];
        return [{
          name,
          image: nullableString(item.image),
          privileged: nullableBoolean(item.privileged),
          allowPrivilegeEscalation: nullableBoolean(item.allowPrivilegeEscalation),
          runAsNonRoot: nullableBoolean(item.runAsNonRoot),
          capabilitiesAdd: nullableStrings(item.capabilitiesAdd),
          capabilitiesDrop: nullableStrings(item.capabilitiesDrop),
          hasCpuRequest: nullableBoolean(item.hasCpuRequest),
          hasMemoryRequest: nullableBoolean(item.hasMemoryRequest),
          hasCpuLimit: nullableBoolean(item.hasCpuLimit),
          hasMemoryLimit: nullableBoolean(item.hasMemoryLimit),
          hasLivenessProbe: nullableBoolean(item.hasLivenessProbe),
          hasReadinessProbe: nullableBoolean(item.hasReadinessProbe),
        }];
      })
    : [];
  if (resource.namespace === null || containers.length === 0) return null;
  return {
    kind: "Workload",
    namespace: resource.namespace,
    name: resource.name,
    workloadKind,
    hostNetwork: nullableBoolean(configuration.hostNetwork),
    hostPid: nullableBoolean(configuration.hostPid),
    hostIpc: nullableBoolean(configuration.hostIpc),
    hasHostPath: nullableBoolean(configuration.hasHostPath),
    runAsNonRoot: nullableBoolean(configuration.runAsNonRoot),
    seccompProfile: nullableString(configuration.seccompProfile),
    containers,
  };
}

function rbacRole(resource: KubernetesResource): KubernetesRbacRoleEvidence {
  const rawRules = resource.configuration.rules;
  const rules = Array.isArray(rawRules) ? rawRules.map((raw) => {
    const rule = objectValue(raw);
    return {
      verbs: nullableStrings(rule.verbs) ?? [],
      apiGroups: nullableStrings(rule.apiGroups) ?? [],
      resources: nullableStrings(rule.resources) ?? [],
    };
  }) : null;
  const clusterScoped = resource.kind === "clusterrole";
  return {
    kind: "RbacRole",
    namespace: clusterScoped ? null : resource.namespace,
    name: resource.name,
    clusterScoped,
    rules,
  };
}

function postureResource(resource: KubernetesResource): KubernetesEvidence | null {
  if (
    resource.kind === "pod" || resource.kind === "deployment" ||
    resource.kind === "statefulset" || resource.kind === "daemonset"
  ) return workload(resource);
  if (resource.kind === "service" && resource.namespace !== null) {
    return {
      kind: "Service",
      namespace: resource.namespace,
      name: resource.name,
      serviceType: nullableString(resource.configuration.type),
      externalAddressCount: numberValue(resource.configuration.externalAddressCount),
    };
  }
  if (resource.kind === "ingress" && resource.namespace !== null) {
    return {
      kind: "Ingress",
      namespace: resource.namespace,
      name: resource.name,
      ruleHosts: nullableStrings(resource.configuration.ruleHosts),
      tlsHosts: nullableStrings(resource.configuration.tlsHosts),
    };
  }
  if (resource.kind === "role" || resource.kind === "clusterrole") return rbacRole(resource);
  if (resource.kind === "namespace") {
    return {
      kind: "Namespace",
      namespace: null,
      name: resource.name,
      podSecurityEnforce: nullableString(resource.configuration.podSecurityEnforce),
      podSecurityWarn: nullableString(resource.configuration.podSecurityWarn),
      podSecurityAudit: nullableString(resource.configuration.podSecurityAudit),
    };
  }
  if (resource.kind === "networkpolicy" && resource.namespace !== null) {
    return {
      kind: "NetworkPolicy",
      namespace: resource.namespace,
      name: resource.name,
      coversAllPods: nullableBoolean(resource.configuration.coversAllPods),
    };
  }
  return null;
}

const evidenceCollectors: Readonly<Record<KubernetesEvidenceKind, readonly string[]>> = {
  Workload: ["kubernetes.deployments", "kubernetes.statefulsets", "kubernetes.daemonsets", "kubernetes.pods"],
  Service: ["kubernetes.services"],
  Ingress: ["kubernetes.ingresses"],
  RbacRole: ["kubernetes.roles", "kubernetes.clusterroles"],
  Namespace: ["kubernetes.namespaces"],
  NetworkPolicy: ["kubernetes.networkpolicies"],
};

/** Converts credential-free collector output into the posture engine contract. */
export function toKubernetesEvidenceSnapshot(snapshot: KubernetesSnapshot): KubernetesEvidenceSnapshot {
  const successful = new Set(snapshot.coverage.filter((entry) => entry.status === "succeeded").map((entry) => entry.collectorKey));
  const observedKinds = (Object.keys(evidenceCollectors) as KubernetesEvidenceKind[]).filter((kind) =>
    evidenceCollectors[kind].some((collectorKey) => successful.has(collectorKey)),
  );
  return normalizeKubernetesEvidence({
    schema: "sutra.kubernetes-evidence.v1",
    clusterId: snapshot.clusterId,
    collectedAt: snapshot.collectedAt,
    observedKinds,
    resources: snapshot.resources.map(postureResource).filter((resource): resource is KubernetesEvidence => resource !== null),
  });
}
