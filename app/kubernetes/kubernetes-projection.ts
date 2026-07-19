import type {
  FindingSeverity,
  JsonValue,
  PilotCoverageEntry,
  PilotFinding,
  PilotRelationship,
  PilotResource,
} from "../../lib/pilot-types";

export type KubernetesCategory =
  | "cluster"
  | "namespace"
  | "workload"
  | "node"
  | "network"
  | "access"
  | "other";

export interface KubernetesResourceRecord {
  readonly resource: PilotResource;
  readonly category: KubernetesCategory;
  readonly kind: string;
  readonly displayName: string;
  readonly clusterName: string | null;
  readonly namespace: string | null;
  readonly findings: readonly PilotFinding[];
  readonly highestSeverity: FindingSeverity | null;
  readonly relationshipCount: number;
}

export interface KubernetesProjection {
  readonly records: readonly KubernetesResourceRecord[];
  readonly findings: readonly PilotFinding[];
  readonly coverage: readonly PilotCoverageEntry[];
  readonly clusters: readonly string[];
  readonly namespaces: readonly string[];
  readonly categoryCounts: Readonly<Record<KubernetesCategory, number>>;
}

const severityOrder: readonly FindingSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "informational",
];

const categoryDefaults: Record<KubernetesCategory, number> = {
  cluster: 0,
  namespace: 0,
  workload: 0,
  node: 0,
  network: 0,
  access: 0,
  other: 0,
};

function objectValue(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstString(
  source: Readonly<Record<string, JsonValue>>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const found = stringValue(source[key]);
    if (found !== null) return found;
  }
  return null;
}

function normalizedKind(resource: PilotResource): string {
  const explicit = firstString(resource.configuration, ["kind", "resourceKind", "kubernetesKind"]);
  if (explicit !== null) return explicit;
  const segments = resource.resourceType.split(/[.:/_-]+/u).filter(Boolean);
  return segments.at(-1) ?? resource.resourceType;
}

export function isNormalizedKubernetesResource(resource: PilotResource): boolean {
  const service = resource.service.toLocaleLowerCase("en-US");
  const type = resource.resourceType.toLocaleLowerCase("en-US");
  if (
    service === "eks" ||
    service === "kubernetes" ||
    service === "k8s" ||
    type.includes("kubernetes") ||
    /(?:^|[.:/_-])eks(?:[.:/_-]|$)/u.test(type) ||
    /(?:^|[.:/_-])k8s(?:[.:/_-]|$)/u.test(type)
  ) {
    return true;
  }
  return (
    stringValue(resource.configuration.apiVersion) !== null &&
    stringValue(resource.configuration.kind) !== null
  );
}

function resourceCategory(kind: string, resourceType: string): KubernetesCategory {
  const value = `${kind} ${resourceType}`.toLocaleLowerCase("en-US");
  if (/(?:clusterrole|rolebinding|serviceaccount|(?:^|\W)role(?:\W|$))/u.test(value)) return "access";
  if (/(?:^|\W)cluster(?:\W|$)/u.test(value)) return "cluster";
  if (/(?:^|\W)namespace(?:\W|$)/u.test(value)) return "namespace";
  if (/(?:nodegroup|(?:^|\W)node(?:\W|$))/u.test(value)) return "node";
  if (/(?:deployment|statefulset|daemonset|replicaset|cronjob|job|pod)/u.test(value)) return "workload";
  if (/(?:service|ingress|networkpolicy|endpoint|loadbalancer)/u.test(value)) return "network";
  return "other";
}

function metadata(resource: PilotResource): Readonly<Record<string, JsonValue>> {
  return objectValue(resource.configuration.metadata) ?? {};
}

function resourceDisplayName(resource: PilotResource): string {
  return resource.name?.trim() ||
    firstString(metadata(resource), ["name"]) ||
    resource.tags.Name ||
    resource.nativeId;
}

function explicitClusterName(resource: PilotResource, category: KubernetesCategory): string | null {
  const configured = firstString(resource.configuration, [
    "clusterName",
    "cluster",
    "eksClusterName",
  ]);
  if (configured !== null) return configured;
  const tagged = resource.tags["eks:cluster-name"] ?? resource.tags["alpha.eksctl.io/cluster-name"];
  if (tagged?.trim()) return tagged.trim();
  const membershipTag = Object.keys(resource.tags).find((key) => key.startsWith("kubernetes.io/cluster/"));
  if (membershipTag !== undefined) return membershipTag.slice("kubernetes.io/cluster/".length);
  return category === "cluster" ? resourceDisplayName(resource) : null;
}

function explicitNamespace(resource: PilotResource, category: KubernetesCategory): string | null {
  const configured = firstString(resource.configuration, ["namespace", "namespaceName"]);
  if (configured !== null) return configured;
  const metadataNamespace = firstString(metadata(resource), ["namespace"]);
  if (metadataNamespace !== null) return metadataNamespace;
  return category === "namespace" ? resourceDisplayName(resource) : null;
}

function highestSeverity(findings: readonly PilotFinding[]): FindingSeverity | null {
  return severityOrder.find((severity) => findings.some((finding) => finding.severity === severity)) ?? null;
}

export function buildKubernetesProjection(input: {
  readonly resources: readonly PilotResource[];
  readonly relationships: readonly PilotRelationship[];
  readonly findings: readonly PilotFinding[];
  readonly coverage: readonly PilotCoverageEntry[];
}): KubernetesProjection {
  const kubernetesResources = input.resources.filter(isNormalizedKubernetesResource);
  const resourceKeys = new Set(kubernetesResources.map((resource) => resource.resourceKey));
  const findingsByResource = new Map<string, PilotFinding[]>();
  for (const finding of input.findings) {
    if (finding.resourceKey === null || !resourceKeys.has(finding.resourceKey)) continue;
    const current = findingsByResource.get(finding.resourceKey) ?? [];
    current.push(finding);
    findingsByResource.set(finding.resourceKey, current);
  }
  const relationshipCounts = new Map<string, number>();
  const relatedKeys = new Map<string, string[]>();
  for (const relationship of input.relationships) {
    if (!resourceKeys.has(relationship.fromResourceKey) && !resourceKeys.has(relationship.toResourceKey)) continue;
    relationshipCounts.set(
      relationship.fromResourceKey,
      (relationshipCounts.get(relationship.fromResourceKey) ?? 0) + 1,
    );
    relationshipCounts.set(
      relationship.toResourceKey,
      (relationshipCounts.get(relationship.toResourceKey) ?? 0) + 1,
    );
    if (!/(?:belong|contain|namespace|cluster|member|owner|run)/iu.test(relationship.relationType)) {
      continue;
    }
    relatedKeys.set(relationship.fromResourceKey, [
      ...(relatedKeys.get(relationship.fromResourceKey) ?? []),
      relationship.toResourceKey,
    ]);
    relatedKeys.set(relationship.toResourceKey, [
      ...(relatedKeys.get(relationship.toResourceKey) ?? []),
      relationship.fromResourceKey,
    ]);
  }

  const preliminary: KubernetesResourceRecord[] = kubernetesResources.map((resource) => {
    const kind = normalizedKind(resource);
    const category = resourceCategory(kind, resource.resourceType);
    return {
      resource,
      category,
      kind,
      displayName: resourceDisplayName(resource),
      clusterName: explicitClusterName(resource, category),
      namespace: explicitNamespace(resource, category),
      findings: findingsByResource.get(resource.resourceKey) ?? [],
      highestSeverity: highestSeverity(findingsByResource.get(resource.resourceKey) ?? []),
      relationshipCount: relationshipCounts.get(resource.resourceKey) ?? 0,
    };
  });
  const byKey = new Map(preliminary.map((record) => [record.resource.resourceKey, record]));
  function nearestRelatedValue(
    resourceKey: string,
    select: (record: KubernetesResourceRecord) => string | null,
  ): string | null {
    const seen = new Set([resourceKey]);
    const queue = [...(relatedKeys.get(resourceKey) ?? [])];
    while (queue.length > 0) {
      const key = queue.shift();
      if (key === undefined || seen.has(key)) continue;
      seen.add(key);
      const candidate = byKey.get(key);
      if (candidate === undefined) continue;
      const selected = select(candidate);
      if (selected !== null) return selected;
      queue.push(...(relatedKeys.get(key) ?? []));
    }
    return null;
  }
  const records = preliminary.map((record) => {
    if (record.clusterName !== null && record.namespace !== null) return record;
    return {
      ...record,
      clusterName: record.clusterName ?? nearestRelatedValue(
        record.resource.resourceKey,
        (candidate) => candidate.category === "cluster" ? candidate.displayName : candidate.clusterName,
      ),
      namespace: record.category === "cluster" ? null : record.namespace ?? nearestRelatedValue(
        record.resource.resourceKey,
        (candidate) => candidate.category === "namespace" ? candidate.displayName : candidate.namespace,
      ),
    };
  });
  const categoryCounts = { ...categoryDefaults };
  for (const record of records) categoryCounts[record.category] += 1;
  const findings = records.flatMap((record) => record.findings);
  const coverage = input.coverage.filter((entry) =>
    /(?:^|[.:/_-])(?:eks|kubernetes|k8s)(?:[.:/_-]|$)/iu.test(entry.collectorKey),
  );
  return {
    records,
    findings,
    coverage,
    clusters: [...new Set(records.map((record) => record.clusterName).filter((value): value is string => value !== null))].sort(),
    namespaces: [...new Set(records.map((record) => record.namespace).filter((value): value is string => value !== null))].sort(),
    categoryCounts,
  };
}
