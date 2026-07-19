import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import {
  resolveTrustedKubernetesConnection,
  type ResolvedKubernetesConnection,
} from "./connection-boundary.ts";
import type {
  KubernetesCollectorCoverage,
  KubernetesResource,
  KubernetesResourceKind,
  KubernetesSnapshot,
  SafeKubernetesValue,
  TrivyOperatorFinding,
  TrivySbomEvidence,
  TrustedKubernetesConnection,
} from "./types.ts";
import {
  normalizeTrivyOperatorReport,
  trivyOperatorReports,
  TrivyOperatorEvidenceError,
} from "./trivy-operator.ts";

const REQUEST_TIMEOUT_MS = 10_000;
const COLLECTION_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const PAGE_LIMIT = 500;
const MAX_PAGES_PER_COLLECTOR = 20;
const MAX_TOTAL_RESOURCES = 10_000;
const TRIVY_REPORT_PAGE_LIMIT = 50;
const MAX_TRIVY_FINDINGS = 20_000;
const MAX_TRIVY_SBOM_COMPONENTS = 20_000;

export type KubernetesCollectorErrorCode =
  | "AUTHENTICATION_FAILED"
  | "AUTHORIZATION_FAILED"
  | "API_UNAVAILABLE"
  | "THROTTLED"
  | "API_REQUEST_FAILED"
  | "TLS_OR_NETWORK_FAILED"
  | "REQUEST_TIMEOUT"
  | "RESPONSE_TOO_LARGE"
  | "INVALID_API_RESPONSE"
  | "COLLECTION_LIMIT_REACHED";

export class KubernetesCollectorError extends Error {
  public readonly code: KubernetesCollectorErrorCode;

  public constructor(
    code: KubernetesCollectorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KubernetesCollectorError";
    this.code = code;
  }
}

const safeErrorMessages: Readonly<Record<KubernetesCollectorErrorCode, string>> = {
  AUTHENTICATION_FAILED: "Kubernetes rejected the collector identity",
  AUTHORIZATION_FAILED: "Kubernetes denied a required read-only metadata permission",
  API_UNAVAILABLE: "A required Kubernetes metadata API is unavailable",
  THROTTLED: "Kubernetes throttled the bounded metadata collector",
  API_REQUEST_FAILED: "Kubernetes could not complete a metadata request",
  TLS_OR_NETWORK_FAILED: "Kubernetes TLS or network connection failed",
  REQUEST_TIMEOUT: "Kubernetes metadata request timed out",
  RESPONSE_TOO_LARGE: "Kubernetes metadata response exceeded the collector limit",
  INVALID_API_RESPONSE: "Kubernetes returned an invalid metadata response",
  COLLECTION_LIMIT_REACHED: "Kubernetes metadata collection reached its bounded limit",
};

function sanitizedCollectorError(error: unknown, aborted = false): KubernetesCollectorError {
  const code = aborted
    ? "REQUEST_TIMEOUT"
    : error instanceof KubernetesCollectorError
      ? error.code
      : "API_REQUEST_FAILED";
  return new KubernetesCollectorError(code, safeErrorMessages[code]);
}

export interface KubernetesTransportRequest {
  readonly url: URL;
  readonly token: string;
  readonly certificateAuthorityPem?: string;
  readonly signal: AbortSignal;
}

export type KubernetesTransport = (request: KubernetesTransportRequest) => Promise<unknown>;

interface CollectorDefinition {
  readonly key: string;
  readonly path: string;
  readonly kind: KubernetesResourceKind;
  readonly apiVersion: string;
  readonly namespaced: boolean;
}

const collectors: readonly CollectorDefinition[] = [
  { key: "kubernetes.namespaces", path: "/api/v1/namespaces", kind: "namespace", apiVersion: "v1", namespaced: false },
  { key: "kubernetes.deployments", path: "/apis/apps/v1/deployments", kind: "deployment", apiVersion: "apps/v1", namespaced: true },
  { key: "kubernetes.statefulsets", path: "/apis/apps/v1/statefulsets", kind: "statefulset", apiVersion: "apps/v1", namespaced: true },
  { key: "kubernetes.daemonsets", path: "/apis/apps/v1/daemonsets", kind: "daemonset", apiVersion: "apps/v1", namespaced: true },
  { key: "kubernetes.pods", path: "/api/v1/pods", kind: "pod", apiVersion: "v1", namespaced: true },
  { key: "kubernetes.services", path: "/api/v1/services", kind: "service", apiVersion: "v1", namespaced: true },
  { key: "kubernetes.ingresses", path: "/apis/networking.k8s.io/v1/ingresses", kind: "ingress", apiVersion: "networking.k8s.io/v1", namespaced: true },
  { key: "kubernetes.networkpolicies", path: "/apis/networking.k8s.io/v1/networkpolicies", kind: "networkpolicy", apiVersion: "networking.k8s.io/v1", namespaced: true },
  { key: "kubernetes.roles", path: "/apis/rbac.authorization.k8s.io/v1/roles", kind: "role", apiVersion: "rbac.authorization.k8s.io/v1", namespaced: true },
  { key: "kubernetes.rolebindings", path: "/apis/rbac.authorization.k8s.io/v1/rolebindings", kind: "rolebinding", apiVersion: "rbac.authorization.k8s.io/v1", namespaced: true },
  { key: "kubernetes.clusterroles", path: "/apis/rbac.authorization.k8s.io/v1/clusterroles", kind: "clusterrole", apiVersion: "rbac.authorization.k8s.io/v1", namespaced: false },
  { key: "kubernetes.clusterrolebindings", path: "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings", kind: "clusterrolebinding", apiVersion: "rbac.authorization.k8s.io/v1", namespaced: false },
  { key: "kubernetes.serviceaccounts", path: "/api/v1/serviceaccounts", kind: "serviceaccount", apiVersion: "v1", namespaced: true },
  { key: "kubernetes.nodes", path: "/api/v1/nodes", kind: "node", apiVersion: "v1", namespaced: false },
] as const;

function responseError(status: number): KubernetesCollectorError {
  if (status === 401) return new KubernetesCollectorError("AUTHENTICATION_FAILED", "Kubernetes rejected the collector identity");
  if (status === 403) return new KubernetesCollectorError("AUTHORIZATION_FAILED", "Kubernetes denied a required read-only metadata permission");
  if (status === 404) return new KubernetesCollectorError("API_UNAVAILABLE", "A required Kubernetes metadata API is unavailable");
  if (status === 429) return new KubernetesCollectorError("THROTTLED", "Kubernetes throttled the bounded metadata collector");
  return new KubernetesCollectorError("API_REQUEST_FAILED", "Kubernetes could not complete a metadata request");
}

function readResponse(response: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      response.destroy();
      reject(responseError(status));
      return;
    }
    const contentType = String(response.headers["content-type"] ?? "").toLocaleLowerCase("en-US");
    if (!contentType.includes("application/json")) {
      response.destroy();
      reject(new KubernetesCollectorError("INVALID_API_RESPONSE", "Kubernetes returned a non-JSON metadata response"));
      return;
    }
    const declaredLength = Number(response.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      response.destroy();
      reject(new KubernetesCollectorError("RESPONSE_TOO_LARGE", "Kubernetes metadata response exceeded the collector limit"));
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    const abort = () => response.destroy(new KubernetesCollectorError("REQUEST_TIMEOUT", "Kubernetes metadata request timed out"));
    signal.addEventListener("abort", abort, { once: true });
    response.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) {
        response.destroy(new KubernetesCollectorError("RESPONSE_TOO_LARGE", "Kubernetes metadata response exceeded the collector limit"));
        return;
      }
      chunks.push(chunk);
    });
    response.once("error", reject);
    response.once("end", () => {
      signal.removeEventListener("abort", abort);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(new KubernetesCollectorError("INVALID_API_RESPONSE", "Kubernetes returned malformed metadata JSON"));
      }
    });
  });
}

export const nodeKubernetesTransport: KubernetesTransport = async (input) => {
  const requestFunction = input.url.protocol === "https:" ? httpsRequest : httpRequest;
  return await new Promise<unknown>((resolve, reject) => {
    const request = requestFunction(input.url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.token}`,
        "user-agent": "sutra-kubernetes-metadata-collector/1",
      },
      signal: input.signal,
      ...(input.url.protocol === "https:"
        ? { ca: input.certificateAuthorityPem, rejectUnauthorized: true }
        : {}),
    }, (response) => void readResponse(response, input.signal).then(resolve, reject));
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new KubernetesCollectorError("REQUEST_TIMEOUT", "Kubernetes metadata request timed out"));
    });
    request.once("error", (error: Error) => {
      reject(error instanceof KubernetesCollectorError
        ? error
        : new KubernetesCollectorError("TLS_OR_NETWORK_FAILED", "Kubernetes TLS or network connection failed"));
    });
    request.end();
  });
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new KubernetesCollectorError("INVALID_API_RESPONSE", "Kubernetes returned an invalid metadata object");
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeString(value: unknown, maximum = 512): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
}

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown, maximum = 100): readonly string[] {
  return Array.isArray(value)
    ? value.slice(0, maximum).map((item) => safeString(item, 256)).filter((item): item is string => item !== null)
    : [];
}

function triBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function hasObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectedContainers(podSpec: Record<string, unknown>): readonly SafeKubernetesValue[] {
  if (!Array.isArray(podSpec.containers)) return [];
  return podSpec.containers.slice(0, 256).flatMap((rawContainer) => {
    if (!hasObject(rawContainer)) return [];
    const name = safeString(rawContainer.name, 253);
    if (name === null) return [];
    const securityContext = optionalRecord(rawContainer.securityContext);
    const capabilities = hasObject(securityContext.capabilities)
      ? securityContext.capabilities
      : null;
    const resources = optionalRecord(rawContainer.resources);
    const requests = hasObject(resources.requests) ? resources.requests : null;
    const limits = hasObject(resources.limits) ? resources.limits : null;
    return [{
      name,
      image: safeString(rawContainer.image, 2_048),
      privileged: triBoolean(securityContext.privileged),
      allowPrivilegeEscalation: triBoolean(securityContext.allowPrivilegeEscalation),
      runAsNonRoot: triBoolean(securityContext.runAsNonRoot),
      capabilitiesAdd: capabilities === null ? null : stringArray(capabilities.add, 256),
      capabilitiesDrop: capabilities === null ? null : stringArray(capabilities.drop, 256),
      hasCpuRequest: requests === null ? null : Object.hasOwn(requests, "cpu"),
      hasMemoryRequest: requests === null ? null : Object.hasOwn(requests, "memory"),
      hasCpuLimit: limits === null ? null : Object.hasOwn(limits, "cpu"),
      hasMemoryLimit: limits === null ? null : Object.hasOwn(limits, "memory"),
      hasLivenessProbe: Object.hasOwn(rawContainer, "livenessProbe"),
      hasReadinessProbe: Object.hasOwn(rawContainer, "readinessProbe"),
    }];
  });
}

function workloadSecurityConfiguration(
  kind: "pod" | "deployment" | "statefulset" | "daemonset",
  spec: Record<string, unknown>,
): Readonly<Record<string, SafeKubernetesValue>> {
  const podSpec = kind === "pod"
    ? spec
    : optionalRecord(optionalRecord(spec.template).spec);
  const podSecurityContext = optionalRecord(podSpec.securityContext);
  const seccompProfile = optionalRecord(podSecurityContext.seccompProfile);
  const volumes = Array.isArray(podSpec.volumes) ? podSpec.volumes.slice(0, 512) : null;
  const containers = projectedContainers(podSpec);
  if (containers.length === 0) {
    throw new KubernetesCollectorError("INVALID_API_RESPONSE", "Kubernetes workload omitted bounded container metadata");
  }
  return {
    workloadKind: kind === "pod" ? "Pod" : kind === "deployment" ? "Deployment" : kind === "statefulset" ? "StatefulSet" : "DaemonSet",
    serviceAccountName: safeString(podSpec.serviceAccountName, 253),
    hostNetwork: triBoolean(podSpec.hostNetwork),
    hostPid: triBoolean(podSpec.hostPID),
    hostIpc: triBoolean(podSpec.hostIPC),
    hasHostPath: volumes === null ? null : volumes.some((volume) => hasObject(volume) && hasObject(volume.hostPath)),
    runAsNonRoot: triBoolean(podSecurityContext.runAsNonRoot),
    seccompProfile: safeString(seccompProfile.type, 128),
    containers,
  };
}

function labels(value: unknown): Readonly<Record<string, string>> {
  const source = optionalRecord(value);
  return Object.fromEntries(Object.entries(source).slice(0, 128).flatMap(([key, item]) => {
    const safeKey = safeString(key, 253);
    const safeValue = safeString(item, 256);
    return safeKey !== null && safeValue !== null ? [[safeKey, safeValue]] : [];
  }));
}

// IRSA binds a Kubernetes ServiceAccount to an AWS IAM role via a single
// well-known annotation. We project only that one value (never the annotation
// map, tokens, or imagePullSecrets), so CIEM can resolve the K8s-to-AWS reach
// without collecting any secret or credential material.
function serviceAccountIamRoleArn(item: Record<string, unknown>): string | null {
  const metadataAnnotations = optionalRecord(optionalRecord(item.metadata).annotations);
  return safeString(metadataAnnotations["eks.amazonaws.com/role-arn"], 2048);
}

function configuration(kind: KubernetesResourceKind, item: Record<string, unknown>): Readonly<Record<string, SafeKubernetesValue>> {
  const spec = optionalRecord(item.spec);
  const status = optionalRecord(item.status);
  if (kind === "namespace") {
    const namespaceLabels = labels(optionalRecord(item.metadata).labels);
    return {
      phase: safeString(status.phase, 64) ?? "unknown",
      podSecurityEnforce: namespaceLabels["pod-security.kubernetes.io/enforce"] ?? null,
      podSecurityWarn: namespaceLabels["pod-security.kubernetes.io/warn"] ?? null,
      podSecurityAudit: namespaceLabels["pod-security.kubernetes.io/audit"] ?? null,
    };
  }
  if (kind === "deployment" || kind === "statefulset" || kind === "daemonset") {
    return {
      desiredReplicas: safeNumber(spec.replicas),
      readyReplicas: safeNumber(status.readyReplicas),
      availableReplicas: safeNumber(status.availableReplicas),
      updatedReplicas: safeNumber(status.updatedReplicas),
      ...workloadSecurityConfiguration(kind, spec),
    };
  }
  if (kind === "pod") {
    return {
      phase: safeString(status.phase, 64),
      nodeName: safeString(spec.nodeName, 253),
      serviceAccountName: safeString(spec.serviceAccountName, 253),
      hostNetwork: spec.hostNetwork === true,
      ...workloadSecurityConfiguration(kind, spec),
    };
  }
  if (kind === "service") {
    const ports = Array.isArray(spec.ports) ? spec.ports.slice(0, 100) : [];
    const loadBalancerIngress = optionalRecord(status.loadBalancer).ingress;
    return {
      type: safeString(spec.type, 64),
      selector: labels(spec.selector),
      ports: ports.map((port) => {
        const value = optionalRecord(port);
        return {
          name: safeString(value.name, 63),
          port: safeNumber(value.port),
          protocol: safeString(value.protocol, 16),
        };
      }),
      externallyExposed: spec.type === "LoadBalancer" || spec.type === "NodePort",
      externalAddressCount: (
        Array.isArray(spec.externalIPs) ? spec.externalIPs.length : 0
      ) + (
        Array.isArray(loadBalancerIngress)
          ? loadBalancerIngress.length
          : 0
      ),
    };
  }
  if (kind === "ingress") {
    const rules = Array.isArray(spec.rules) ? spec.rules.slice(0, 512) : null;
    const tls = Array.isArray(spec.tls) ? spec.tls.slice(0, 512) : null;
    return {
      ingressClassName: safeString(spec.ingressClassName, 253),
      ruleCount: rules?.length ?? 0,
      tlsConfigured: tls !== null && tls.length > 0,
      ruleHosts: rules === null ? null : rules.map((rule) => safeString(optionalRecord(rule).host, 253)).filter((host): host is string => host !== null),
      tlsHosts: tls === null ? null : tls.flatMap((entry) => stringArray(optionalRecord(entry).hosts, 256)),
    };
  }
  if (kind === "networkpolicy") {
    const podSelector = optionalRecord(spec.podSelector);
    const matchLabels = optionalRecord(podSelector.matchLabels);
    const matchExpressions = Array.isArray(podSelector.matchExpressions) ? podSelector.matchExpressions : null;
    return {
      policyTypes: stringArray(spec.policyTypes, 10),
      podSelector: labels(matchLabels),
      coversAllPods: Object.keys(matchLabels).length === 0 && (matchExpressions === null || matchExpressions.length === 0),
    };
  }
  if (kind === "role" || kind === "clusterrole") {
    const rules = Array.isArray(item.rules) ? item.rules.slice(0, 512) : null;
    return {
      ruleCount: rules?.length ?? 0,
      rules: rules === null ? null : rules.map((rawRule) => {
        const rule = optionalRecord(rawRule);
        return {
          verbs: stringArray(rule.verbs, 256),
          apiGroups: stringArray(rule.apiGroups, 256),
          resources: stringArray(rule.resources, 256),
        };
      }),
    };
  }
  if (kind === "rolebinding" || kind === "clusterrolebinding") {
    const roleRef = optionalRecord(item.roleRef);
    const rawSubjects = Array.isArray(item.subjects) ? item.subjects.slice(0, 256) : [];
    // Bounded RBAC identity references (kind/namespace/name) — the same class of
    // non-sensitive identifier as the role names already retained. Enables
    // subject-level effective-permission (CIEM) resolution without collecting
    // any Secret, token, or workload payload.
    return {
      roleRefKind: safeString(roleRef.kind, 64),
      roleRefName: safeString(roleRef.name, 253),
      subjectCount: Array.isArray(item.subjects) ? item.subjects.length : 0,
      subjects: rawSubjects.map((rawSubject) => {
        const subject = optionalRecord(rawSubject);
        return {
          kind: safeString(subject.kind, 64),
          namespace: safeString(subject.namespace, 253),
          name: safeString(subject.name, 253),
        };
      }),
    };
  }
  if (kind === "serviceaccount") {
    return { iamRoleArn: serviceAccountIamRoleArn(item) };
  }
  if (kind === "node") {
    const nodeInfo = optionalRecord(status.nodeInfo);
    const conditions = Array.isArray(status.conditions) ? status.conditions.slice(0, 100) : [];
    return {
      unschedulable: spec.unschedulable === true,
      kubeletVersion: safeString(nodeInfo.kubeletVersion, 128),
      operatingSystem: safeString(nodeInfo.operatingSystem, 64),
      architecture: safeString(nodeInfo.architecture, 64),
      conditions: conditions.map((condition) => {
        const value = optionalRecord(condition);
        return { type: safeString(value.type, 128), status: safeString(value.status, 32) };
      }),
    };
  }
  return {};
}

function normalizedResource(
  connection: ResolvedKubernetesConnection,
  definition: CollectorDefinition,
  value: unknown,
  collectedAt: string,
): KubernetesResource {
  const item = record(value);
  const metadata = record(item.metadata);
  const name = safeString(metadata.name, 253);
  const namespace = definition.namespaced ? safeString(metadata.namespace, 253) : null;
  if (name === null || (definition.namespaced && namespace === null)) {
    throw new KubernetesCollectorError("INVALID_API_RESPONSE", "Kubernetes metadata omitted a required resource identity");
  }
  return {
    resourceKey: `kubernetes:${connection.clusterId}:${definition.kind}:${namespace ?? "_cluster"}:${name}`,
    clusterId: connection.clusterId,
    kind: definition.kind,
    apiVersion: safeString(item.apiVersion, 128) ?? definition.apiVersion,
    namespace,
    name,
    uid: safeString(metadata.uid, 128),
    labels: labels(metadata.labels),
    state: safeString(optionalRecord(item.status).phase, 64) ?? "observed",
    configuration: configuration(definition.kind, item),
    provenance: {
      apiPath: definition.path,
      collectedAt,
      resourceVersion: safeString(metadata.resourceVersion, 128),
    },
  };
}

function listPage(value: unknown, maximumItems = PAGE_LIMIT): { readonly items: readonly unknown[]; readonly continuation: string | null } {
  const page = record(value);
  if (!Array.isArray(page.items) || page.items.length > maximumItems) {
    throw new KubernetesCollectorError("INVALID_API_RESPONSE", "Kubernetes metadata page exceeded its item contract");
  }
  const continuation = safeString(optionalRecord(page.metadata).continue, 2_048);
  return { items: page.items, continuation };
}

export class ReadOnlyKubernetesCollector {
  private readonly connection: ResolvedKubernetesConnection;
  private readonly transport: KubernetesTransport;

  public constructor(
    connection: TrustedKubernetesConnection,
    transport: KubernetesTransport = nodeKubernetesTransport,
  ) {
    this.connection = resolveTrustedKubernetesConnection(connection);
    this.transport = transport;
  }

  public async collect(now = new Date()): Promise<KubernetesSnapshot> {
    const collectedAt = now.toISOString();
    const resources: KubernetesResource[] = [{
      resourceKey: `kubernetes:${this.connection.clusterId}:cluster:_cluster:${this.connection.clusterId}`,
      clusterId: this.connection.clusterId,
      kind: "cluster",
      apiVersion: "sutra/v1",
      namespace: null,
      name: this.connection.clusterName,
      uid: null,
      labels: {},
      state: "connected",
      configuration: {},
      provenance: { apiPath: "server-side-registration", collectedAt, resourceVersion: null },
    }];
    const coverage: KubernetesCollectorCoverage[] = [];
    const trivyFindings: TrivyOperatorFinding[] = [];
    const trivySboms: TrivySbomEvidence[] = [];
    let trivySbomComponentCount = 0;
    const overall = new AbortController();
    const overallTimer = setTimeout(() => overall.abort(), COLLECTION_TIMEOUT_MS);
    try {
      for (const definition of collectors) {
        let pagesObserved = 0;
        let itemsObserved = 0;
        let continuation: string | null = null;
        try {
          do {
            if (pagesObserved >= MAX_PAGES_PER_COLLECTOR || resources.length >= MAX_TOTAL_RESOURCES) {
              throw new KubernetesCollectorError("COLLECTION_LIMIT_REACHED", "Kubernetes metadata collection reached its bounded limit");
            }
            const url = new URL(definition.path, this.connection.server);
            url.searchParams.set("limit", String(PAGE_LIMIT));
            if (continuation !== null) url.searchParams.set("continue", continuation);
            const page = listPage(await this.transport({
              url,
              token: this.connection.token,
              certificateAuthorityPem: this.connection.certificateAuthorityPem,
              signal: overall.signal,
            }));
            pagesObserved += 1;
            for (const item of page.items) {
              if (resources.length >= MAX_TOTAL_RESOURCES) {
                throw new KubernetesCollectorError("COLLECTION_LIMIT_REACHED", "Kubernetes metadata collection reached its bounded limit");
              }
              resources.push(normalizedResource(this.connection, definition, item, collectedAt));
              itemsObserved += 1;
            }
            continuation = page.continuation;
          } while (continuation !== null);
          coverage.push({
            collectorKey: definition.key,
            apiPath: definition.path,
            status: "succeeded",
            itemsObserved,
            pagesObserved,
          });
        } catch (error) {
          const safe = sanitizedCollectorError(error, overall.signal.aborted);
          coverage.push({
            collectorKey: definition.key,
            apiPath: definition.path,
            status: "failed",
            itemsObserved,
            pagesObserved,
            errorCode: safe.code,
            message: safe.message,
          });
        }
      }
      for (const definition of trivyOperatorReports) {
        let pagesObserved = 0;
        let itemsObserved = 0;
        let continuation: string | null = null;
        try {
          do {
            if (pagesObserved >= MAX_PAGES_PER_COLLECTOR) {
              throw new KubernetesCollectorError("COLLECTION_LIMIT_REACHED", "Trivy Operator report collection reached its bounded limit");
            }
            const url = new URL(definition.path, this.connection.server);
            url.searchParams.set("limit", String(TRIVY_REPORT_PAGE_LIMIT));
            if (continuation !== null) url.searchParams.set("continue", continuation);
            const page = listPage(await this.transport({
              url,
              token: this.connection.token,
              certificateAuthorityPem: this.connection.certificateAuthorityPem,
              signal: overall.signal,
            }), TRIVY_REPORT_PAGE_LIMIT);
            pagesObserved += 1;
            for (const item of page.items) {
              const normalized = normalizeTrivyOperatorReport(definition, item, this.connection.clusterId);
              const addedComponentCount = normalized.sboms.reduce((sum, sbom) => sum + sbom.components.length, 0);
              if (
                trivyFindings.length + normalized.findings.length > MAX_TRIVY_FINDINGS ||
                trivySbomComponentCount + addedComponentCount > MAX_TRIVY_SBOM_COMPONENTS
              ) {
                throw new KubernetesCollectorError("COLLECTION_LIMIT_REACHED", "Trivy Operator evidence reached its bounded limit");
              }
              trivyFindings.push(...normalized.findings);
              trivySboms.push(...normalized.sboms);
              trivySbomComponentCount += addedComponentCount;
              itemsObserved += 1;
            }
            continuation = page.continuation;
          } while (continuation !== null);
          coverage.push({
            collectorKey: definition.collectorKey,
            apiPath: definition.path,
            status: "succeeded",
            itemsObserved,
            pagesObserved,
            ...(itemsObserved === 0 ? {
              message: "Trivy Operator report API is available, but zero reports were observed; this is not a clean scan result",
            } : {}),
          });
        } catch (error) {
          const normalizedError = error instanceof TrivyOperatorEvidenceError
            ? new KubernetesCollectorError(
                error.code === "TRIVY_REPORT_LIMIT_REACHED" ? "COLLECTION_LIMIT_REACHED" : "INVALID_API_RESPONSE",
                "Trivy Operator report evidence was rejected",
              )
            : error;
          const safe = sanitizedCollectorError(normalizedError, overall.signal.aborted);
          const notConfigured = safe.code === "API_UNAVAILABLE";
          coverage.push({
            collectorKey: definition.collectorKey,
            apiPath: definition.path,
            status: notConfigured ? "not_configured" : "failed",
            itemsObserved,
            pagesObserved,
            errorCode: notConfigured ? "NOT_CONFIGURED" : safe.code,
            message: notConfigured
              ? "Trivy Operator report CRD is not installed or served; no clean result is inferred"
              : safe.message,
          });
        }
      }
    } finally {
      clearTimeout(overallTimer);
    }
    return {
      schemaVersion: "sutra.kubernetes.inventory.v1",
      clusterId: this.connection.clusterId,
      clusterName: this.connection.clusterName,
      collectedAt,
      resources,
      coverage,
      trivyFindings,
      trivySboms,
    };
  }
}
