const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,253}$/u;
const MAX_RESOURCES = 50_000;
const MAX_CONTAINERS = 256;
const DANGEROUS_CAPABILITIES = new Set([
  "ALL", "SYS_ADMIN", "SYS_MODULE", "SYS_PTRACE", "NET_ADMIN", "NET_RAW",
  "DAC_READ_SEARCH", "DAC_OVERRIDE", "SETUID", "SETGID", "CHOWN",
]);
const ESCALATION_VERBS = new Set(["bind", "escalate", "impersonate"]);

type TriState = boolean | null;

export interface KubernetesEvidenceSnapshot {
  readonly schema: "sutra.kubernetes-evidence.v1";
  readonly clusterId: string;
  readonly collectedAt: string;
  readonly observedKinds: readonly KubernetesEvidenceKind[];
  readonly resources: readonly KubernetesEvidence[];
}

export type KubernetesEvidenceKind =
  | "Workload"
  | "Service"
  | "Ingress"
  | "RbacRole"
  | "RbacBinding"
  | "ServiceAccount"
  | "Namespace"
  | "NetworkPolicy";

interface EvidenceBase {
  readonly kind: KubernetesEvidenceKind;
  readonly namespace: string | null;
  readonly name: string;
}

export interface KubernetesWorkloadEvidence extends EvidenceBase {
  readonly kind: "Workload";
  readonly namespace: string;
  readonly workloadKind: "Pod" | "Deployment" | "StatefulSet" | "DaemonSet" | "Job" | "CronJob";
  /** Bound ServiceAccount name; the K8s->AWS reach hop for attack paths (null when default/absent). */
  readonly serviceAccountName: string | null;
  readonly hostNetwork: TriState;
  readonly hostPid: TriState;
  readonly hostIpc: TriState;
  readonly hasHostPath: TriState;
  readonly runAsNonRoot: TriState;
  readonly seccompProfile: string | null;
  readonly containers: readonly KubernetesContainerEvidence[];
}

export interface KubernetesContainerEvidence {
  readonly name: string;
  readonly image: string | null;
  readonly privileged: TriState;
  readonly allowPrivilegeEscalation: TriState;
  readonly runAsNonRoot: TriState;
  readonly capabilitiesAdd: readonly string[] | null;
  readonly capabilitiesDrop: readonly string[] | null;
  readonly hasCpuRequest: TriState;
  readonly hasMemoryRequest: TriState;
  readonly hasCpuLimit: TriState;
  readonly hasMemoryLimit: TriState;
  readonly hasLivenessProbe: TriState;
  readonly hasReadinessProbe: TriState;
}

export interface KubernetesServiceEvidence extends EvidenceBase {
  readonly kind: "Service";
  readonly namespace: string;
  readonly serviceType: string | null;
  readonly externalAddressCount: number | null;
}

export interface KubernetesIngressEvidence extends EvidenceBase {
  readonly kind: "Ingress";
  readonly namespace: string;
  readonly ruleHosts: readonly string[] | null;
  readonly tlsHosts: readonly string[] | null;
}

export interface KubernetesRbacRoleEvidence extends EvidenceBase {
  readonly kind: "RbacRole";
  readonly clusterScoped: boolean;
  readonly rules: readonly {
    readonly verbs: readonly string[];
    readonly apiGroups: readonly string[];
    readonly resources: readonly string[];
  }[] | null;
}

export interface KubernetesRbacBindingEvidence extends EvidenceBase {
  readonly kind: "RbacBinding";
  readonly clusterScoped: boolean;
  readonly roleRefKind: string | null;
  readonly roleRefName: string | null;
  readonly subjects: readonly {
    readonly kind: string;
    readonly namespace: string | null;
    readonly name: string;
  }[];
}

export interface KubernetesServiceAccountEvidence extends EvidenceBase {
  readonly kind: "ServiceAccount";
  readonly namespace: string;
  /** IRSA IAM role ARN from the eks.amazonaws.com/role-arn annotation; null when absent. */
  readonly iamRoleArn: string | null;
}

export interface KubernetesNamespaceEvidence extends EvidenceBase {
  readonly kind: "Namespace";
  readonly namespace: null;
  readonly podSecurityEnforce: string | null;
  readonly podSecurityWarn: string | null;
  readonly podSecurityAudit: string | null;
}

export interface KubernetesNetworkPolicyEvidence extends EvidenceBase {
  readonly kind: "NetworkPolicy";
  readonly namespace: string;
  /** True only when collector evidence proves the policy selects every pod. */
  readonly coversAllPods: TriState;
}

export type KubernetesEvidence =
  | KubernetesWorkloadEvidence
  | KubernetesServiceEvidence
  | KubernetesIngressEvidence
  | KubernetesRbacRoleEvidence
  | KubernetesRbacBindingEvidence
  | KubernetesServiceAccountEvidence
  | KubernetesNamespaceEvidence
  | KubernetesNetworkPolicyEvidence;

export type KubernetesControlState = "PASS" | "FAIL" | "UNKNOWN";

export interface KubernetesControlResult {
  readonly controlId: string;
  readonly state: KubernetesControlState;
  readonly severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly subject: string;
  readonly message: string;
  readonly evidence: readonly string[];
}

export interface KubernetesPostureReport {
  readonly schema: "sutra.kubernetes-posture.v1";
  readonly clusterId: string;
  readonly collectedAt: string;
  readonly summary: Readonly<Record<KubernetesControlState, number>>;
  readonly results: readonly KubernetesControlResult[];
  readonly disclaimer: string;
}

export class KubernetesEvidenceError extends Error {
  public readonly code: "INVALID_EVIDENCE" | "LIMIT_EXCEEDED" | "SECRET_REJECTED";

  public constructor(
    code: "INVALID_EVIDENCE" | "LIMIT_EXCEEDED" | "SECRET_REJECTED",
  ) {
    super("Kubernetes evidence rejected");
    this.name = "KubernetesEvidenceError";
    this.code = code;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new KubernetesEvidenceError("INVALID_EVIDENCE");
  }
  return value as Record<string, unknown>;
}

function requiredIdentifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new KubernetesEvidenceError("INVALID_EVIDENCE");
  }
  return value;
}

function nullableString(value: unknown, maximum = 1_024): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\0\r\n]/u.test(value)) {
    throw new KubernetesEvidenceError("INVALID_EVIDENCE");
  }
  return value;
}

function triState(value: unknown): TriState {
  if (value === null || typeof value === "boolean") return value;
  throw new KubernetesEvidenceError("INVALID_EVIDENCE");
}

function stringList(value: unknown, maximum = 256): readonly string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > maximum) {
    throw new KubernetesEvidenceError("INVALID_EVIDENCE");
  }
  const normalized = value.map((item) => nullableString(item, 253));
  if (normalized.some((item) => item === null)) throw new KubernetesEvidenceError("INVALID_EVIDENCE");
  return [...new Set(normalized as string[])].sort();
}

function apiGroupList(value: unknown): readonly string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 256) throw new KubernetesEvidenceError("INVALID_EVIDENCE");
  const normalized = value.map((item) => {
    if (typeof item !== "string" || item.length > 253 || /[\0\r\n]/u.test(item)) {
      throw new KubernetesEvidenceError("INVALID_EVIDENCE");
    }
    return item;
  });
  return [...new Set(normalized)].sort();
}

function container(value: unknown): KubernetesContainerEvidence {
  const item = record(value);
  return {
    name: requiredIdentifier(item.name),
    image: nullableString(item.image, 2_048),
    privileged: triState(item.privileged),
    allowPrivilegeEscalation: triState(item.allowPrivilegeEscalation),
    runAsNonRoot: triState(item.runAsNonRoot),
    capabilitiesAdd: stringList(item.capabilitiesAdd),
    capabilitiesDrop: stringList(item.capabilitiesDrop),
    hasCpuRequest: triState(item.hasCpuRequest),
    hasMemoryRequest: triState(item.hasMemoryRequest),
    hasCpuLimit: triState(item.hasCpuLimit),
    hasMemoryLimit: triState(item.hasMemoryLimit),
    hasLivenessProbe: triState(item.hasLivenessProbe),
    hasReadinessProbe: triState(item.hasReadinessProbe),
  };
}

function normalizeResource(value: unknown): KubernetesEvidence {
  const item = record(value);
  const kind = item.kind;
  // Deliberately reject before reading metadata, data or stringData.
  if (kind === "Secret") throw new KubernetesEvidenceError("SECRET_REJECTED");
  const name = requiredIdentifier(item.name);

  if (kind === "Workload") {
    if (!Array.isArray(item.containers) || item.containers.length === 0 || item.containers.length > MAX_CONTAINERS) {
      throw new KubernetesEvidenceError("INVALID_EVIDENCE");
    }
    const workloadKinds = new Set(["Pod", "Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"]);
    if (typeof item.workloadKind !== "string" || !workloadKinds.has(item.workloadKind)) {
      throw new KubernetesEvidenceError("INVALID_EVIDENCE");
    }
    return {
      kind,
      name,
      namespace: requiredIdentifier(item.namespace),
      workloadKind: item.workloadKind as KubernetesWorkloadEvidence["workloadKind"],
      serviceAccountName: nullableString(item.serviceAccountName ?? null, 253),
      hostNetwork: triState(item.hostNetwork),
      hostPid: triState(item.hostPid),
      hostIpc: triState(item.hostIpc),
      hasHostPath: triState(item.hasHostPath),
      runAsNonRoot: triState(item.runAsNonRoot),
      seccompProfile: nullableString(item.seccompProfile, 128),
      containers: item.containers.map(container).sort((left, right) => left.name.localeCompare(right.name)),
    };
  }
  if (kind === "Service") {
    const count = item.externalAddressCount;
    if (count !== null && (!Number.isSafeInteger(count) || Number(count) < 0)) {
      throw new KubernetesEvidenceError("INVALID_EVIDENCE");
    }
    return {
      kind, name, namespace: requiredIdentifier(item.namespace),
      serviceType: nullableString(item.serviceType, 64),
      externalAddressCount: count as number | null,
    };
  }
  if (kind === "Ingress") {
    return {
      kind, name, namespace: requiredIdentifier(item.namespace),
      ruleHosts: stringList(item.ruleHosts),
      tlsHosts: stringList(item.tlsHosts),
    };
  }
  if (kind === "RbacRole") {
    if (typeof item.clusterScoped !== "boolean") throw new KubernetesEvidenceError("INVALID_EVIDENCE");
    let rules: KubernetesRbacRoleEvidence["rules"] = null;
    if (item.rules !== null) {
      if (!Array.isArray(item.rules) || item.rules.length > 512) {
        throw new KubernetesEvidenceError("INVALID_EVIDENCE");
      }
      rules = item.rules.map((rawRule) => {
        const rule = record(rawRule);
        const verbs = stringList(rule.verbs);
        const apiGroups = apiGroupList(rule.apiGroups);
        const resources = stringList(rule.resources);
        if (verbs === null || apiGroups === null || resources === null) {
          throw new KubernetesEvidenceError("INVALID_EVIDENCE");
        }
        return { verbs, apiGroups, resources };
      });
    }
    return {
      kind, name, clusterScoped: item.clusterScoped,
      namespace: item.clusterScoped ? null : requiredIdentifier(item.namespace),
      rules,
    };
  }
  if (kind === "RbacBinding") {
    if (typeof item.clusterScoped !== "boolean") throw new KubernetesEvidenceError("INVALID_EVIDENCE");
    if (!Array.isArray(item.subjects) || item.subjects.length > 2_048) {
      throw new KubernetesEvidenceError("INVALID_EVIDENCE");
    }
    const subjects = item.subjects.map((rawSubject) => {
      const subject = record(rawSubject);
      const subjectName = nullableString(subject.name, 253);
      if (subjectName === null) throw new KubernetesEvidenceError("INVALID_EVIDENCE");
      return {
        kind: nullableString(subject.kind, 64) ?? "",
        namespace: nullableString(subject.namespace, 253),
        name: subjectName,
      };
    });
    return {
      kind, name, clusterScoped: item.clusterScoped,
      namespace: item.clusterScoped ? null : requiredIdentifier(item.namespace),
      roleRefKind: nullableString(item.roleRefKind, 64),
      roleRefName: nullableString(item.roleRefName, 253),
      subjects,
    };
  }
  if (kind === "ServiceAccount") {
    return {
      kind, name, namespace: requiredIdentifier(item.namespace),
      iamRoleArn: nullableString(item.iamRoleArn, 2_048),
    };
  }
  if (kind === "Namespace") {
    return {
      kind, name, namespace: null,
      podSecurityEnforce: nullableString(item.podSecurityEnforce, 32),
      podSecurityWarn: nullableString(item.podSecurityWarn, 32),
      podSecurityAudit: nullableString(item.podSecurityAudit, 32),
    };
  }
  if (kind === "NetworkPolicy") {
    return {
      kind, name, namespace: requiredIdentifier(item.namespace),
      coversAllPods: triState(item.coversAllPods),
    };
  }
  throw new KubernetesEvidenceError("INVALID_EVIDENCE");
}

export function normalizeKubernetesEvidence(input: unknown): KubernetesEvidenceSnapshot {
  const source = record(input);
  const clusterId = requiredIdentifier(source.clusterId);
  if (typeof source.collectedAt !== "string" || !Number.isFinite(Date.parse(source.collectedAt))) {
    throw new KubernetesEvidenceError("INVALID_EVIDENCE");
  }
  if (!Array.isArray(source.observedKinds) || !Array.isArray(source.resources)) {
    throw new KubernetesEvidenceError("INVALID_EVIDENCE");
  }
  if (source.resources.length > MAX_RESOURCES) throw new KubernetesEvidenceError("LIMIT_EXCEEDED");
  const validKinds = new Set<KubernetesEvidenceKind>([
    "Workload", "Service", "Ingress", "RbacRole", "RbacBinding", "ServiceAccount", "Namespace", "NetworkPolicy",
  ]);
  const observedKinds = source.observedKinds.map((kind) => {
    if (typeof kind !== "string" || !validKinds.has(kind as KubernetesEvidenceKind)) {
      throw new KubernetesEvidenceError("INVALID_EVIDENCE");
    }
    return kind as KubernetesEvidenceKind;
  });
  const observed = new Set(observedKinds);
  const resources = source.resources.map(normalizeResource);
  if (resources.some((resource) => !observed.has(resource.kind))) {
    throw new KubernetesEvidenceError("INVALID_EVIDENCE");
  }
  return {
    schema: "sutra.kubernetes-evidence.v1",
    clusterId,
    collectedAt: new Date(source.collectedAt).toISOString(),
    observedKinds: [...new Set(observedKinds)].sort(),
    resources: resources.sort((left, right) =>
      `${left.kind}\0${left.namespace ?? ""}\0${left.name}`
        .localeCompare(`${right.kind}\0${right.namespace ?? ""}\0${right.name}`)),
  };
}

function subject(resource: KubernetesEvidence): string {
  return `${resource.kind}/${resource.namespace === null ? "" : `${resource.namespace}/`}${resource.name}`;
}

function result(
  controlId: string,
  state: KubernetesControlState,
  severity: KubernetesControlResult["severity"],
  item: KubernetesEvidence | KubernetesEvidenceSnapshot,
  message: string,
  evidence: readonly string[] = [],
): KubernetesControlResult {
  return {
    controlId, state, severity,
    subject: "kind" in item ? subject(item) : `Cluster/${item.clusterId}`,
    message,
    evidence: [...evidence].sort(),
  };
}

function aggregateBooleans(values: readonly TriState[]): KubernetesControlState {
  if (values.some((value) => value === false)) return "FAIL";
  if (values.some((value) => value === null)) return "UNKNOWN";
  return "PASS";
}

function workloadResults(workload: KubernetesWorkloadEvidence): KubernetesControlResult[] {
  const containerRunAsNonRoot = workload.containers.map((item) => item.runAsNonRoot ?? workload.runAsNonRoot);
  const privilege = aggregateBooleans(workload.containers.map((item) =>
    item.privileged === null ? null : !item.privileged));
  const escalation = aggregateBooleans(workload.containers.map((item) =>
    item.allowPrivilegeEscalation === null ? null : !item.allowPrivilegeEscalation));
  const capabilities = workload.containers.map((item): KubernetesControlState => {
    if (item.capabilitiesAdd === null || item.capabilitiesDrop === null) return "UNKNOWN";
    if (item.capabilitiesAdd.some((capability) => DANGEROUS_CAPABILITIES.has(capability.toUpperCase()))) return "FAIL";
    return item.capabilitiesDrop.some((capability) => capability.toUpperCase() === "ALL") ? "PASS" : "FAIL";
  });
  const capabilityState = capabilities.includes("FAIL") ? "FAIL" : capabilities.includes("UNKNOWN") ? "UNKNOWN" : "PASS";
  const seccompState = workload.seccompProfile === null
    ? "UNKNOWN"
    : new Set(["RuntimeDefault", "Localhost"]).has(workload.seccompProfile) ? "PASS" : "FAIL";
  const hostNamespaceState = aggregateBooleans([workload.hostNetwork, workload.hostPid, workload.hostIpc]
    .map((value) => value === null ? null : !value));
  const hostPathState = workload.hasHostPath === null ? "UNKNOWN" : workload.hasHostPath ? "FAIL" : "PASS";
  const immutableImageStates = workload.containers.map((item): KubernetesControlState => {
    if (item.image === null) return "UNKNOWN";
    return /@sha256:[a-f0-9]{64}$/u.test(item.image) ? "PASS" : "FAIL";
  });
  const imageState = immutableImageStates.includes("FAIL") ? "FAIL" :
    immutableImageStates.includes("UNKNOWN") ? "UNKNOWN" : "PASS";
  const imageTagStates = workload.containers.map((item): KubernetesControlState => {
    if (item.image === null) return "UNKNOWN";
    if (/@sha256:[a-f0-9]{64}$/u.test(item.image)) return "PASS";
    const lastSegment = item.image.slice(item.image.lastIndexOf("/") + 1);
    const separator = lastSegment.lastIndexOf(":");
    if (separator < 1) return "FAIL";
    return lastSegment.slice(separator + 1).toLowerCase() === "latest" ? "FAIL" : "PASS";
  });
  const imageTagState = imageTagStates.includes("FAIL") ? "FAIL" :
    imageTagStates.includes("UNKNOWN") ? "UNKNOWN" : "PASS";
  const resourceState = aggregateBooleans(workload.containers.flatMap((item) => [
    item.hasCpuRequest, item.hasMemoryRequest, item.hasCpuLimit, item.hasMemoryLimit,
  ]));
  const probeState = aggregateBooleans(workload.containers.flatMap((item) => [
    item.hasLivenessProbe, item.hasReadinessProbe,
  ]));
  return [
    result("K8S-WORKLOAD-RUN-AS-NON-ROOT", aggregateBooleans(containerRunAsNonRoot), "HIGH", workload,
      "Workload and container runAsNonRoot evidence"),
    result("K8S-WORKLOAD-NO-PRIVILEGED", privilege, "CRITICAL", workload,
      "Containers must not run privileged"),
    result("K8S-WORKLOAD-NO-PRIVILEGE-ESCALATION", escalation, "HIGH", workload,
      "Containers must disable privilege escalation"),
    result("K8S-WORKLOAD-CAPABILITIES", capabilityState, "HIGH", workload,
      "Containers must drop ALL capabilities and not add dangerous capabilities"),
    result("K8S-WORKLOAD-SECCOMP", seccompState, "MEDIUM", workload,
      "Pod seccomp profile must be RuntimeDefault or Localhost"),
    result("K8S-WORKLOAD-HOST-NAMESPACES", hostNamespaceState, "CRITICAL", workload,
      "Workloads must not share host network, PID or IPC namespaces"),
    result("K8S-WORKLOAD-HOST-PATH", hostPathState, "HIGH", workload,
      "Workloads must not mount hostPath volumes"),
    result("K8S-IMAGE-DIGEST", imageState, "MEDIUM", workload,
      "Container images must be pinned by sha256 digest"),
    result("K8S-IMAGE-NO-LATEST", imageTagState, "MEDIUM", workload,
      "Container images must use an explicit non-latest tag or sha256 digest"),
    result("K8S-WORKLOAD-RESOURCES", resourceState, "MEDIUM", workload,
      "Every container must declare CPU and memory requests and limits"),
    result("K8S-WORKLOAD-PROBES", probeState, "LOW", workload,
      "Every container must declare liveness and readiness probes"),
  ];
}

function unknownForMissingSubjects(
  snapshot: KubernetesEvidenceSnapshot,
  controlIds: readonly [string, KubernetesControlResult["severity"], string][],
): KubernetesControlResult[] {
  return controlIds.map(([controlId, severity, message]) =>
    result(controlId, "UNKNOWN", severity, snapshot, message));
}

export function evaluateKubernetesPosture(
  snapshot: KubernetesEvidenceSnapshot,
): KubernetesPostureReport {
  const results: KubernetesControlResult[] = [];
  const workloads = snapshot.resources.filter((item): item is KubernetesWorkloadEvidence => item.kind === "Workload");
  for (const workload of workloads) results.push(...workloadResults(workload));
  if (workloads.length === 0) {
    results.push(...unknownForMissingSubjects(snapshot, [
      ["K8S-WORKLOAD-RUN-AS-NON-ROOT", "HIGH", "Workload security-context evidence was not collected"],
      ["K8S-WORKLOAD-NO-PRIVILEGED", "CRITICAL", "Workload privileged-mode evidence was not collected"],
      ["K8S-WORKLOAD-NO-PRIVILEGE-ESCALATION", "HIGH", "Privilege-escalation evidence was not collected"],
      ["K8S-WORKLOAD-CAPABILITIES", "HIGH", "Linux capability evidence was not collected"],
      ["K8S-WORKLOAD-SECCOMP", "MEDIUM", "Seccomp evidence was not collected"],
      ["K8S-WORKLOAD-HOST-NAMESPACES", "CRITICAL", "Host namespace evidence was not collected"],
      ["K8S-WORKLOAD-HOST-PATH", "HIGH", "Host-path evidence was not collected"],
      ["K8S-IMAGE-DIGEST", "MEDIUM", "Container image reference evidence was not collected"],
      ["K8S-IMAGE-NO-LATEST", "MEDIUM", "Container image tag evidence was not collected"],
      ["K8S-WORKLOAD-RESOURCES", "MEDIUM", "Resource request and limit evidence was not collected"],
      ["K8S-WORKLOAD-PROBES", "LOW", "Container probe evidence was not collected"],
    ]));
  }

  const services = snapshot.resources.filter((item): item is KubernetesServiceEvidence => item.kind === "Service");
  for (const service of services) {
    const state = service.serviceType === null || service.externalAddressCount === null ? "UNKNOWN" :
      service.serviceType === "NodePort" || service.serviceType === "LoadBalancer" || service.externalAddressCount > 0
        ? "FAIL" : "PASS";
    results.push(result("K8S-SERVICE-EXPOSURE", state, "HIGH", service,
      "Services must not expose nodes or external addresses without explicit review",
      service.serviceType === null ? [] : [`type=${service.serviceType}`]));
  }
  if (services.length === 0) {
    results.push(...unknownForMissingSubjects(snapshot, [
      ["K8S-SERVICE-EXPOSURE", "HIGH", "No Service subject evidence is available"],
    ]));
  }

  const ingresses = snapshot.resources.filter((item): item is KubernetesIngressEvidence => item.kind === "Ingress");
  for (const ingress of ingresses) {
    let state: KubernetesControlState = "UNKNOWN";
    if (ingress.ruleHosts !== null && ingress.tlsHosts !== null) {
      state = ingress.ruleHosts.length > 0 &&
        ingress.ruleHosts.every((host) => ingress.tlsHosts?.includes(host)) ? "PASS" : "FAIL";
    }
    results.push(result("K8S-INGRESS-TLS", state, "HIGH", ingress,
      "Every ingress host must be covered by TLS"));
  }
  if (ingresses.length === 0) {
    results.push(...unknownForMissingSubjects(snapshot, [
      ["K8S-INGRESS-TLS", "HIGH", "No Ingress subject evidence is available"],
    ]));
  }

  const roles = snapshot.resources.filter((item): item is KubernetesRbacRoleEvidence => item.kind === "RbacRole");
  for (const role of roles) {
    let wildcard: KubernetesControlState = "UNKNOWN";
    let escalation: KubernetesControlState = "UNKNOWN";
    if (role.rules !== null) {
      wildcard = role.rules.some((rule) =>
        rule.verbs.includes("*") || rule.apiGroups.includes("*") || rule.resources.includes("*")) ? "FAIL" : "PASS";
      escalation = role.rules.some((rule) =>
        rule.verbs.some((verb) => ESCALATION_VERBS.has(verb.toLowerCase()))) ? "FAIL" : "PASS";
    }
    results.push(
      result("K8S-RBAC-WILDCARDS", wildcard, "CRITICAL", role,
        "RBAC roles must not grant wildcard verbs or resources"),
      result("K8S-RBAC-ESCALATION", escalation, "CRITICAL", role,
        "RBAC roles must not grant bind, escalate or impersonate"),
    );
  }
  if (roles.length === 0) {
    results.push(...unknownForMissingSubjects(snapshot, [
      ["K8S-RBAC-WILDCARDS", "CRITICAL", "No RBAC role subject evidence is available"],
      ["K8S-RBAC-ESCALATION", "CRITICAL", "No RBAC role subject evidence is available"],
    ]));
  }

  const namespaces = snapshot.resources.filter((item): item is KubernetesNamespaceEvidence => item.kind === "Namespace");
  for (const namespace of namespaces) {
    const state = namespace.podSecurityEnforce === null ? "UNKNOWN" :
      namespace.podSecurityEnforce === "restricted" ? "PASS" : "FAIL";
    results.push(result("K8S-NAMESPACE-POD-SECURITY", state, "HIGH", namespace,
      "Namespace Pod Security enforce label must be restricted",
      namespace.podSecurityEnforce === null ? [] : [`enforce=${namespace.podSecurityEnforce}`]));
  }
  if (namespaces.length === 0) {
    results.push(...unknownForMissingSubjects(snapshot, [
      ["K8S-NAMESPACE-POD-SECURITY", "HIGH", "No Namespace subject evidence is available"],
    ]));
  }

  const policies = snapshot.resources.filter((item): item is KubernetesNetworkPolicyEvidence =>
    item.kind === "NetworkPolicy");
  const policiesByNamespace = new Map<string, KubernetesNetworkPolicyEvidence[]>();
  for (const policy of policies) {
    const existing = policiesByNamespace.get(policy.namespace) ?? [];
    existing.push(policy);
    policiesByNamespace.set(policy.namespace, existing);
  }
  const knownNamespaceNames = new Set([
    ...namespaces.map((namespace) => namespace.name),
    ...workloads.map((workload) => workload.namespace),
  ]);
  if (!snapshot.observedKinds.includes("NetworkPolicy")) {
    results.push(result("K8S-NAMESPACE-NETWORK-POLICY", "UNKNOWN", "HIGH", snapshot,
      "NetworkPolicy evidence was not collected"));
  } else if (knownNamespaceNames.size === 0) {
    results.push(result("K8S-NAMESPACE-NETWORK-POLICY", "UNKNOWN", "HIGH", snapshot,
      "No namespace evidence exists to assess NetworkPolicy coverage"));
  } else {
    for (const namespace of [...knownNamespaceNames].sort()) {
      const namespacePolicies = policiesByNamespace.get(namespace) ?? [];
      const state: KubernetesControlState = namespacePolicies.length === 0 ? "FAIL" :
        namespacePolicies.some((policy) => policy.coversAllPods === true) ? "PASS" :
          namespacePolicies.some((policy) => policy.coversAllPods === null) ? "UNKNOWN" : "FAIL";
      results.push({
        controlId: "K8S-NAMESPACE-NETWORK-POLICY",
        state,
        severity: "HIGH",
        subject: `Namespace/${namespace}`,
        message: "Every workload namespace must have a NetworkPolicy proven to select all pods",
        evidence: namespacePolicies.map((policy) =>
          `${policy.name}:coversAllPods=${String(policy.coversAllPods)}`).sort(),
      });
    }
  }

  results.sort((left, right) =>
    `${left.controlId}\0${left.subject}`.localeCompare(`${right.controlId}\0${right.subject}`));
  const summary = { PASS: 0, FAIL: 0, UNKNOWN: 0 };
  for (const item of results) summary[item.state] += 1;
  return {
    schema: "sutra.kubernetes-posture.v1",
    clusterId: snapshot.clusterId,
    collectedAt: snapshot.collectedAt,
    summary,
    results,
    disclaimer:
      "Sutra evaluates Kubernetes configuration evidence only. It never reads Secret data and does not perform package, image, runtime or CVE vulnerability scanning.",
  };
}
