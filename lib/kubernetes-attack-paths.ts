import type {
  JsonValue,
  PilotFinding,
  PilotRelationship,
  PilotResource,
} from "./pilot-types.ts";
import type { NormalizedFalcoRuntimeEvent } from "./falco-runtime-types.ts";
import type { NormalizedHubbleFlow } from "./hubble-flow-evidence.ts";
import type { KubernetesSupplyChainEvidence } from "./kubernetes-supply-chain.ts";

export type AttackPathType =
  | "cloud_to_kubernetes"
  | "rbac_privilege_escalation"
  | "vulnerable_exposed_privileged_workload"
  | "runtime_to_aws_blast_radius"
  | "observed_network_to_workload"
  | "supply_chain_to_runtime";

export type AttackNodeKind =
  | "internet"
  | "load_balancer"
  | "security_group"
  | "kubernetes_exposure"
  | "kubernetes_workload"
  | "service_account"
  | "rbac_binding"
  | "rbac_role"
  | "iam_role"
  | "aws_resource"
  | "runtime_event"
  | "container_image"
  | "other";

export interface AttackGraphNode {
  readonly key: string;
  readonly label: string;
  readonly kind: AttackNodeKind;
  readonly resourceKey: string | null;
}

export interface AttackEdgeEvidence {
  readonly source: "relationship" | "configuration" | "falco" | "hubble" | "supply_chain";
  readonly sourceResourceKey: string;
  readonly relationType: string;
  readonly fieldPath: string | null;
  readonly observedValue: JsonValue;
  readonly observedAt: string | null;
  readonly evidenceSha256: string | null;
}

export interface AttackGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: string;
  readonly evidence: AttackEdgeEvidence;
}

export interface AttackRiskFactor {
  readonly key: string;
  readonly label: string;
  readonly points: number;
  readonly evidence: string;
}

export interface AttackPathRemediation {
  readonly key: string;
  readonly title: string;
  readonly guidance: string;
  readonly breaksAt: string;
  readonly limitation: "SUGGESTION_REQUIRES_OPERATOR_VALIDATION";
}

export interface KubernetesAttackPath {
  readonly id: string;
  readonly type: AttackPathType;
  readonly title: string;
  readonly nodes: readonly AttackGraphNode[];
  readonly edges: readonly AttackGraphEdge[];
  readonly findings: readonly PilotFinding[];
  readonly factors: readonly AttackRiskFactor[];
  readonly score: number;
  readonly risk: "critical" | "high" | "medium" | "low";
  readonly blastRadius: readonly AttackGraphNode[];
  readonly observedFrom: string | null;
  readonly observedTo: string | null;
  readonly remediations: readonly AttackPathRemediation[];
}

export interface KubernetesAttackPathProjection {
  readonly paths: readonly KubernetesAttackPath[];
  readonly nodes: readonly AttackGraphNode[];
  readonly edges: readonly AttackGraphEdge[];
  readonly unknowns: readonly string[];
  readonly blastRadiusResourceCount: number;
  readonly correlatedRuntimeEventCount: number;
  readonly correlatedNetworkFlowCount: number;
  readonly correlatedSupplyChainEvidenceCount: number;
}

const KUBERNETES_MARKER = /(?:kubernetes|(?:^|[.:/_-])k8s(?:[.:/_-]|$)|(?:^|[.:/_-])eks(?:[.:/_-]|$))/iu;
const WORKLOAD_MARKER = /(?:deployment|statefulset|daemonset|replicaset|cronjob|job|pod|workload)/iu;
const EXPOSURE_MARKER = /(?:ingress|service|endpoint|loadbalancer)/iu;
const ROLE_BINDING_MARKER = /(?:clusterrolebinding|rolebinding|rbacbinding)/iu;
const RBAC_ROLE_MARKER = /(?:clusterrole|rbacrole|(?:^|\W)role(?:\W|$))/iu;
const PUBLIC_VALUE = /(?:^|[\s,["'])(?:0\.0\.0\.0\/0|::\/0|internet-facing|public)(?:$|[\s,\]"'])/iu;
const VULNERABILITY_MARKER = /(?:vulnerab|container.?image|package|\bCVE-\d{4}-\d+\b)/iu;
const PRIVILEGE_MARKER = /(?:privileged|hostNetwork|hostPID|hostIPC|allowPrivilegeEscalation|CAP_SYS_ADMIN|\broot\b)/iu;
const RBAC_ESCALATION_MARKER = /(?:\*|impersonate|escalate|bind|cluster-admin|secrets)/iu;

function object(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function string(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function flatten(value: JsonValue, prefix = "", depth = 0): readonly { path: string; value: JsonValue }[] {
  if (depth > 7 || value === null || typeof value !== "object") return [{ path: prefix, value }];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flatten(item, `${prefix}[${index}]`, depth + 1));
  }
  return Object.entries(value).flatMap(([key, child]) =>
    flatten(child, prefix.length > 0 ? `${prefix}.${key}` : key, depth + 1),
  );
}

function kindText(resource: PilotResource): string {
  const explicit = string(resource.configuration.kind) ?? string(object(resource.configuration.metadata)?.kind);
  return `${explicit ?? ""} ${resource.service} ${resource.resourceType}`;
}

function isKubernetes(resource: PilotResource): boolean {
  return KUBERNETES_MARKER.test(kindText(resource)) ||
    (string(resource.configuration.apiVersion) !== null && string(resource.configuration.kind) !== null);
}

function attackNodeKind(resource: PilotResource): AttackNodeKind {
  const value = kindText(resource);
  if (/(?:elasticloadbalancing|load.?balancer|\belb\b|\balb\b)/iu.test(value) && !isKubernetes(resource)) return "load_balancer";
  if (/(?:security.?group|AWS::EC2::SecurityGroup)/iu.test(value)) return "security_group";
  if (isKubernetes(resource) && ROLE_BINDING_MARKER.test(value)) return "rbac_binding";
  if (isKubernetes(resource) && /serviceaccount/iu.test(value)) return "service_account";
  if (isKubernetes(resource) && RBAC_ROLE_MARKER.test(value)) return "rbac_role";
  if (isKubernetes(resource) && WORKLOAD_MARKER.test(value)) return "kubernetes_workload";
  if (isKubernetes(resource) && EXPOSURE_MARKER.test(value)) return "kubernetes_exposure";
  if (/(?:^|[.:/_-])iam(?:[.:/_-]|$)/iu.test(value) && /role/iu.test(value)) return "iam_role";
  if (!isKubernetes(resource) && /(?:aws|ec2|s3|rds|dynamodb|lambda|kms|secretsmanager|sns|sqs)/iu.test(value)) return "aws_resource";
  return "other";
}

function resourceLabel(resource: PilotResource): string {
  return resource.name?.trim() || resource.tags.Name || resource.nativeId || resource.resourceKey;
}

function namespace(resource: PilotResource): string | null {
  return string(resource.configuration.namespace) ??
    string(object(resource.configuration.metadata)?.namespace);
}

function cluster(resource: PilotResource): string | null {
  return string(resource.configuration.clusterName) ??
    string(resource.configuration.cluster) ??
    resource.tags["eks:cluster-name"] ??
    null;
}

function exactIdentityMatch(left: PilotResource, right: PilotResource): boolean {
  const leftNamespace = namespace(left);
  const rightNamespace = namespace(right);
  const leftCluster = cluster(left);
  const rightCluster = cluster(right);
  return (leftNamespace === null || rightNamespace === null || leftNamespace === rightNamespace) &&
    (leftCluster === null || rightCluster === null || leftCluster === rightCluster);
}

function only<T>(values: readonly T[]): T | undefined {
  return values.length === 1 ? values[0] : undefined;
}

function evidenceEdge(
  from: string,
  to: string,
  sourceResourceKey: string,
  relation: string,
  fieldPath: string,
  observedValue: JsonValue,
): AttackGraphEdge {
  return {
    from,
    to,
    relation,
    evidence: {
      source: "configuration",
      sourceResourceKey,
      relationType: relation,
      fieldPath,
      observedValue,
      observedAt: null,
      evidenceSha256: null,
    },
  };
}

function relationshipEdges(relationships: readonly PilotRelationship[]): AttackGraphEdge[] {
  return relationships.map((relationship) => ({
    from: relationship.fromResourceKey,
    to: relationship.toResourceKey,
    relation: relationship.relationType,
    evidence: {
      source: "relationship",
      sourceResourceKey: relationship.fromResourceKey,
      relationType: relationship.relationType,
      fieldPath: null,
      observedValue: relationship.evidence,
      observedAt: string(object(relationship.evidence)?.observedAt),
      evidenceSha256: null,
    },
  }));
}

function signalEdge(input: {
  readonly from: string;
  readonly to: string;
  readonly source: "falco" | "hubble" | "supply_chain";
  readonly sourceResourceKey: string;
  readonly relation: string;
  readonly observedAt: string;
  readonly evidenceSha256: string;
  readonly observedValue: JsonValue;
}): AttackGraphEdge {
  return {
    from: input.from,
    to: input.to,
    relation: input.relation,
    evidence: {
      source: input.source,
      sourceResourceKey: input.sourceResourceKey,
      relationType: input.relation,
      fieldPath: null,
      observedValue: input.observedValue,
      observedAt: input.observedAt,
      evidenceSha256: input.evidenceSha256,
    },
  };
}

function exactWorkload(
  resources: readonly PilotResource[],
  identity: { readonly namespace: string | null; readonly name: string | null },
): PilotResource | undefined {
  if (identity.name === null) return undefined;
  return only(resources.filter((resource) =>
    attackNodeKind(resource) === "kubernetes_workload" &&
    resourceLabel(resource) === identity.name &&
    (identity.namespace === null || namespace(resource) === identity.namespace),
  ));
}

function resourceHasImage(resource: PilotResource, repository: string, digest: string): boolean {
  const serialized = JSON.stringify(resource.configuration);
  return serialized.includes(digest) &&
    (serialized.includes(`${repository}@${digest}`) || serialized.includes(repository));
}

function correlatedEvidenceEdges(input: {
  readonly resources: readonly PilotResource[];
  readonly runtimeEvents: readonly NormalizedFalcoRuntimeEvent[];
  readonly networkFlows: readonly NormalizedHubbleFlow[];
  readonly supplyChainEvidence: readonly KubernetesSupplyChainEvidence[];
  readonly nodes: Map<string, AttackGraphNode>;
}): {
  readonly edges: readonly AttackGraphEdge[];
  readonly runtimeEvents: ReadonlySet<string>;
  readonly networkFlows: ReadonlySet<string>;
  readonly supplyChainEvidence: ReadonlySet<string>;
} {
  const edges: AttackGraphEdge[] = [];
  const correlatedRuntime = new Set<string>();
  const correlatedFlows = new Set<string>();
  const correlatedSupplyChain = new Set<string>();

  for (const event of input.runtimeEvents) {
    const workload = exactWorkload(input.resources, {
      namespace: event.namespace,
      name: event.podName,
    });
    if (workload === undefined) continue;
    const eventKey = `falco:${event.eventId}`;
    input.nodes.set(eventKey, {
      key: eventKey,
      label: event.rule,
      kind: "runtime_event",
      resourceKey: null,
    });
    edges.push(signalEdge({
      from: eventKey,
      to: workload.resourceKey,
      source: "falco",
      sourceResourceKey: event.eventId,
      relation: "observed_on_exact_workload_identity",
      observedAt: event.occurredAt,
      evidenceSha256: event.evidenceSha256,
      observedValue: {
        clusterId: event.clusterId,
        namespace: event.namespace,
        podName: event.podName,
        containerImage: event.containerImage,
        priority: event.priority,
      },
    }));
    correlatedRuntime.add(event.eventId);
  }

  for (const flow of input.networkFlows) {
    if (flow.verdict !== "forwarded" && flow.verdict !== "audit") continue;
    const sourceWorkload = flow.source.world ? undefined : exactWorkload(input.resources, {
      namespace: flow.source.namespace,
      name: flow.source.workloadName,
    });
    const destinationWorkload = flow.destination.world ? undefined : exactWorkload(input.resources, {
      namespace: flow.destination.namespace,
      name: flow.destination.workloadName,
    });
    if (flow.source.world && destinationWorkload !== undefined) {
      const worldKey = `hubble:world:${flow.evidenceSha256}`;
      input.nodes.set(worldKey, { key: worldKey, label: "World (observed flow)", kind: "internet", resourceKey: null });
      edges.push(signalEdge({
        from: worldKey,
        to: destinationWorkload.resourceKey,
        source: "hubble",
        sourceResourceKey: flow.evidenceSha256,
        relation: "observed_forwarded_flow_to",
        observedAt: flow.observedAt,
        evidenceSha256: flow.evidenceSha256,
        observedValue: {
          verdict: flow.verdict,
          protocol: flow.protocol,
          destinationPort: flow.destinationPort,
          observations: flow.observations,
        },
      }));
      correlatedFlows.add(flow.evidenceSha256);
    } else if (sourceWorkload !== undefined && destinationWorkload !== undefined) {
      edges.push(signalEdge({
        from: sourceWorkload.resourceKey,
        to: destinationWorkload.resourceKey,
        source: "hubble",
        sourceResourceKey: flow.evidenceSha256,
        relation: "observed_forwarded_flow_to",
        observedAt: flow.observedAt,
        evidenceSha256: flow.evidenceSha256,
        observedValue: {
          verdict: flow.verdict,
          protocol: flow.protocol,
          destinationPort: flow.destinationPort,
          observations: flow.observations,
        },
      }));
      correlatedFlows.add(flow.evidenceSha256);
    }
  }

  for (const evidence of input.supplyChainEvidence) {
    const workloads = input.resources.filter((resource) =>
      attackNodeKind(resource) === "kubernetes_workload" &&
      resourceHasImage(resource, evidence.image.repository, evidence.image.digest),
    );
    if (workloads.length !== 1) continue;
    const imageKey = `image:${evidence.image.repository}@${evidence.image.digest}`;
    input.nodes.set(imageKey, {
      key: imageKey,
      label: `${evidence.image.repository}@${evidence.image.digest.slice(0, 19)}…`,
      kind: "container_image",
      resourceKey: null,
    });
    edges.push(signalEdge({
      from: imageKey,
      to: workloads[0]!.resourceKey,
      source: "supply_chain",
      sourceResourceKey: evidence.evidenceSha256,
      relation: "deployed_as_exact_image_digest",
      observedAt: evidence.collectedAt,
      evidenceSha256: evidence.evidenceSha256,
      observedValue: {
        repository: evidence.image.repository,
        digest: evidence.image.digest,
        signatureState: evidence.signature.state,
        provenanceState: evidence.provenance.state,
        criticalVulnerabilities: evidence.vulnerabilityScan.critical,
      },
    }));
    for (const event of input.runtimeEvents.filter((candidate) =>
      candidate.containerImage !== null &&
      candidate.containerImage.includes(evidence.image.repository) &&
      candidate.containerImage.includes(evidence.image.digest)
    )) {
      const eventKey = `falco:${event.eventId}`;
      if (!input.nodes.has(eventKey)) continue;
      edges.push(signalEdge({
        from: imageKey,
        to: eventKey,
        source: "supply_chain",
        sourceResourceKey: evidence.evidenceSha256,
        relation: "runtime_observed_exact_image_digest",
        observedAt: event.occurredAt,
        evidenceSha256: evidence.evidenceSha256,
        observedValue: {
          repository: evidence.image.repository,
          digest: evidence.image.digest,
          runtimeEventId: event.eventId,
        },
      }));
    }
    correlatedSupplyChain.add(evidence.evidenceSha256);
  }
  return {
    edges,
    runtimeEvents: correlatedRuntime,
    networkFlows: correlatedFlows,
    supplyChainEvidence: correlatedSupplyChain,
  };
}

function derivedEdges(resources: readonly PilotResource[], nodes: Map<string, AttackGraphNode>): AttackGraphEdge[] {
  const edges: AttackGraphEdge[] = [];
  const serviceAccounts = resources.filter((resource) => attackNodeKind(resource) === "service_account");
  const iamRoles = resources.filter((resource) => attackNodeKind(resource) === "iam_role");
  const rbacRoles = resources.filter((resource) => attackNodeKind(resource) === "rbac_role");
  for (const resource of resources) {
    const fields = flatten(resource.configuration);
    const publicField = fields.find((entry) =>
      /(?:cidr|source|scheme|public|external|ingress)/iu.test(entry.path) &&
      typeof entry.value === "string" &&
      PUBLIC_VALUE.test(entry.value),
    );
    if (publicField !== undefined) {
      const internetKey = `evidence:internet:${resource.resourceKey}`;
      nodes.set(internetKey, { key: internetKey, label: "Internet", kind: "internet", resourceKey: null });
      edges.push(evidenceEdge(
        internetKey,
        resource.resourceKey,
        resource.resourceKey,
        "publicly_reachable_configuration",
        publicField.path,
        publicField.value,
      ));
    }

    if (attackNodeKind(resource) === "kubernetes_workload") {
      const accountField = fields.find((entry) =>
        /(?:^|\.)serviceAccountName$/u.test(entry.path) && typeof entry.value === "string",
      );
      if (accountField !== undefined) {
        const target = only(serviceAccounts.filter((candidate) =>
          resourceLabel(candidate) === accountField.value && exactIdentityMatch(resource, candidate),
        ));
        if (target !== undefined) {
          edges.push(evidenceEdge(
            resource.resourceKey,
            target.resourceKey,
            resource.resourceKey,
            "uses_service_account",
            accountField.path,
            accountField.value,
          ));
        }
      }
    }

    if (attackNodeKind(resource) === "service_account") {
      const roleField = fields.find((entry) =>
        /(?:eks\.amazonaws\.com\/role-arn|roleArn|roleARN|iamRoleArn)$/u.test(entry.path) &&
        typeof entry.value === "string",
      );
      if (roleField !== undefined) {
        const target = only(iamRoles.filter((candidate) =>
          candidate.arn === roleField.value || candidate.nativeId === roleField.value,
        ));
        if (target !== undefined) {
          edges.push(evidenceEdge(
            resource.resourceKey,
            target.resourceKey,
            resource.resourceKey,
            "assumes_iam_role",
            roleField.path,
            roleField.value,
          ));
        }
      }
    }

    if (attackNodeKind(resource) === "rbac_binding") {
      const roleName = fields.find((entry) =>
        // Raw K8s manifests nest roleRef.name; the stored posture projection
        // flattens it to roleRefName. Accept both so bindings link to their role.
        /(?:(?:^|\.)roleRef\.name|(?:^|\.)roleRefName)$/u.test(entry.path) && typeof entry.value === "string",
      );
      if (roleName !== undefined) {
        const target = only(rbacRoles.filter((candidate) =>
          resourceLabel(candidate) === roleName.value && exactIdentityMatch(resource, candidate),
        ));
        if (target !== undefined) {
          edges.push(evidenceEdge(
            resource.resourceKey,
            target.resourceKey,
            resource.resourceKey,
            "binds_rbac_role",
            roleName.path,
            roleName.value,
          ));
        }
      }
      for (const subject of fields.filter((entry) =>
        /subjects\[\d+\]\.name$/u.test(entry.path) && typeof entry.value === "string",
      )) {
        const target = only(serviceAccounts.filter((candidate) =>
          resourceLabel(candidate) === subject.value && exactIdentityMatch(resource, candidate),
        ));
        if (target !== undefined) {
          edges.push(evidenceEdge(
            target.resourceKey,
            resource.resourceKey,
            resource.resourceKey,
            "subject_of_rbac_binding",
            subject.path,
            subject.value,
          ));
        }
      }
    }
  }
  return edges;
}

function pathRisk(
  type: AttackPathType,
  nodes: readonly AttackGraphNode[],
  edges: readonly AttackGraphEdge[],
  resourcesByKey: ReadonlyMap<string, PilotResource>,
  findings: readonly PilotFinding[],
): readonly AttackRiskFactor[] {
  const factors: AttackRiskFactor[] = [];
  if (nodes.some((node) => node.kind === "internet")) {
    factors.push({ key: "public", label: "Public reachability evidence", points: 25, evidence: "A configuration field explicitly reports a public CIDR, public scheme, or internet-facing value." });
  }
  if (nodes.some((node) => node.kind === "load_balancer")) {
    factors.push({ key: "load-balancer", label: "Cloud load balancer hop", points: 10, evidence: "The explicit path traverses a normalized cloud load balancer." });
  }
  if (nodes.some((node) => node.kind === "security_group")) {
    factors.push({ key: "security-group", label: "Security-group hop", points: 5, evidence: "The explicit path traverses a normalized security group." });
  }
  const severeVulnerability = findings.find((finding) =>
    finding.status === "open" &&
    VULNERABILITY_MARKER.test(`${finding.controlKey} ${finding.title} ${finding.summary}`) &&
    (finding.severity === "critical" || finding.severity === "high"),
  );
  if (severeVulnerability !== undefined) {
    factors.push({
      key: "vulnerability",
      label: `${severeVulnerability.severity} vulnerability finding`,
      points: severeVulnerability.severity === "critical" ? 25 : 15,
      evidence: severeVulnerability.fingerprint,
    });
  }
  const privilegeEvidence = nodes
    .map((node) => node.resourceKey === null ? null : resourcesByKey.get(node.resourceKey))
    .find((resource) => resource != null && PRIVILEGE_MARKER.test(JSON.stringify(resource.configuration)));
  if (privilegeEvidence !== undefined && privilegeEvidence !== null) {
    factors.push({ key: "privilege", label: "Privileged workload configuration", points: 20, evidence: privilegeEvidence.resourceKey });
  }
  if (type === "rbac_privilege_escalation") {
    factors.push({ key: "rbac-escalation", label: "Escalating RBAC permission", points: 20, evidence: "The bound role contains an explicit wildcard or escalation-sensitive permission." });
  }
  if (nodes.some((node) => node.kind === "iam_role")) {
    factors.push({ key: "iam-role", label: "AWS IAM identity reachable", points: 15, evidence: "The explicit path includes a normalized IAM role linked from workload identity evidence." });
  }
  if (nodes.some((node) => node.kind === "aws_resource")) {
    factors.push({ key: "aws-target", label: "AWS resource in blast radius", points: 15, evidence: "At least one normalized AWS resource is downstream through explicit relationships." });
  }
  if (nodes.some((node) => node.kind === "runtime_event")) {
    factors.push({ key: "runtime", label: "Falco runtime detection", points: 20, evidence: "A signed Falco event was correlated by exact workload identity." });
  }
  if (edges.some((edge) => edge.evidence.source === "hubble")) {
    factors.push({ key: "observed-flow", label: "Observed Hubble flow", points: 15, evidence: "A forwarded or audit flow was correlated by exact workload identity. It does not prove general reachability." });
  }
  if (nodes.some((node) => node.kind === "container_image")) {
    factors.push({ key: "supply-chain", label: "Immutable image evidence", points: 10, evidence: "Supply-chain evidence was matched to an exact deployed image digest." });
  }
  return factors;
}

function risk(score: number): KubernetesAttackPath["risk"] {
  if (score >= 80) return "critical";
  if (score >= 55) return "high";
  if (score >= 30) return "medium";
  return "low";
}

function title(type: AttackPathType): string {
  if (type === "cloud_to_kubernetes") return "Cloud exposure to AWS blast radius";
  if (type === "rbac_privilege_escalation") return "Kubernetes RBAC privilege-escalation path";
  if (type === "runtime_to_aws_blast_radius") return "Runtime detection to explicit AWS blast radius";
  if (type === "observed_network_to_workload") return "Observed network flow to workload context";
  if (type === "supply_chain_to_runtime") return "Immutable image evidence to runtime detection";
  return "Exposed vulnerable privileged workload";
}

function remediationSuggestions(
  nodes: readonly AttackGraphNode[],
  edges: readonly AttackGraphEdge[],
  factors: readonly AttackRiskFactor[],
): readonly AttackPathRemediation[] {
  const suggestions: AttackPathRemediation[] = [];
  if (factors.some((factor) => factor.key === "public" || factor.key === "observed-flow")) {
    suggestions.push({
      key: "restrict-entry",
      title: "Review and restrict the observed entry path",
      guidance: "Validate whether the public or observed network path is required, then narrow the load-balancer, security-group, ingress or NetworkPolicy rule at the cited hop.",
      breaksAt: edges.find((edge) => edge.evidence.source === "hubble" || edge.relation.includes("public"))?.relation ?? "network entry",
      limitation: "SUGGESTION_REQUIRES_OPERATOR_VALIDATION",
    });
  }
  if (nodes.some((node) => node.kind === "service_account" || node.kind === "iam_role")) {
    suggestions.push({
      key: "least-privilege",
      title: "Reduce workload identity blast radius",
      guidance: "Review the cited ServiceAccount, RBAC binding and IAM role; remove unused actions and scope resources without changing the workload until its required access is confirmed.",
      breaksAt: edges.find((edge) => edge.relation === "assumes_iam_role")?.relation ?? "workload identity",
      limitation: "SUGGESTION_REQUIRES_OPERATOR_VALIDATION",
    });
  }
  if (factors.some((factor) => factor.key === "vulnerability" || factor.key === "supply-chain")) {
    suggestions.push({
      key: "replace-image",
      title: "Rebuild and redeploy the immutable image",
      guidance: "Validate a patched base image, regenerate SBOM and provenance, sign the new digest, and promote it through admission policy before replacing the workload image.",
      breaksAt: edges.find((edge) => edge.evidence.source === "supply_chain")?.relation ?? "container image",
      limitation: "SUGGESTION_REQUIRES_OPERATOR_VALIDATION",
    });
  }
  if (nodes.some((node) => node.kind === "runtime_event")) {
    suggestions.push({
      key: "investigate-runtime",
      title: "Investigate the runtime detection",
      guidance: "Open a human-approved case, validate the Falco rule and workload owner, and choose a response only after excluding expected administrative activity. Sutra does not automatically contain workloads.",
      breaksAt: "runtime event",
      limitation: "SUGGESTION_REQUIRES_OPERATOR_VALIDATION",
    });
  }
  return suggestions;
}

function createPath(
  type: AttackPathType,
  nodeKeys: readonly string[],
  allNodes: ReadonlyMap<string, AttackGraphNode>,
  edges: readonly AttackGraphEdge[],
  resourcesByKey: ReadonlyMap<string, PilotResource>,
  findings: readonly PilotFinding[],
): KubernetesAttackPath {
  const nodes = nodeKeys.flatMap((key) => {
    const found = allNodes.get(key);
    return found === undefined ? [] : [found];
  });
  const pathFindings = findings.filter((finding) =>
    finding.resourceKey !== null && nodeKeys.includes(finding.resourceKey),
  );
  const factors = pathRisk(type, nodes, edges, resourcesByKey, pathFindings);
  const score = Math.min(100, factors.reduce((sum, factor) => sum + factor.points, 0));
  const timestamps = edges.flatMap((edge) => edge.evidence.observedAt === null ? [] : [edge.evidence.observedAt])
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return {
    id: `${type}:${nodeKeys.join(">")}`,
    type,
    title: title(type),
    nodes,
    edges,
    findings: pathFindings,
    factors,
    score,
    risk: risk(score),
    blastRadius: nodes.filter((node) => node.kind === "aws_resource"),
    observedFrom: timestamps[0] ?? null,
    observedTo: timestamps.at(-1) ?? null,
    remediations: remediationSuggestions(nodes, edges, factors),
  };
}

function enumerate(
  start: string,
  adjacency: ReadonlyMap<string, readonly AttackGraphEdge[]>,
  accept: (keys: readonly string[]) => boolean,
  maxDepth = 9,
): readonly { keys: readonly string[]; edges: readonly AttackGraphEdge[] }[] {
  const results: { keys: readonly string[]; edges: readonly AttackGraphEdge[] }[] = [];
  const visit = (keys: readonly string[], edges: readonly AttackGraphEdge[]) => {
    if (accept(keys)) {
      results.push({ keys, edges });
      return;
    }
    if (keys.length >= maxDepth) return;
    const last = keys.at(-1);
    if (last === undefined) return;
    for (const edge of adjacency.get(last) ?? []) {
      if (keys.includes(edge.to)) continue;
      visit([...keys, edge.to], [...edges, edge]);
    }
  };
  visit([start], []);
  return results;
}

function hasOrderedKinds(keys: readonly string[], nodes: ReadonlyMap<string, AttackGraphNode>, kinds: readonly AttackNodeKind[]): boolean {
  let cursor = 0;
  for (const key of keys) {
    if (nodes.get(key)?.kind === kinds[cursor]) cursor += 1;
    if (cursor === kinds.length) return true;
  }
  return false;
}

export function buildKubernetesAttackPaths(input: {
  readonly resources: readonly PilotResource[];
  readonly relationships: readonly PilotRelationship[];
  readonly findings: readonly PilotFinding[];
  readonly runtimeEvents?: readonly NormalizedFalcoRuntimeEvent[];
  readonly networkFlows?: readonly NormalizedHubbleFlow[];
  readonly supplyChainEvidence?: readonly KubernetesSupplyChainEvidence[];
}): KubernetesAttackPathProjection {
  const resourcesByKey = new Map(input.resources.map((resource) => [resource.resourceKey, resource]));
  const nodes = new Map<string, AttackGraphNode>(input.resources.map((resource) => [
    resource.resourceKey,
    {
      key: resource.resourceKey,
      label: resourceLabel(resource),
      kind: attackNodeKind(resource),
      resourceKey: resource.resourceKey,
    },
  ]));
  const correlations = correlatedEvidenceEdges({
    resources: input.resources,
    runtimeEvents: input.runtimeEvents ?? [],
    networkFlows: input.networkFlows ?? [],
    supplyChainEvidence: input.supplyChainEvidence ?? [],
    nodes,
  });
  const edges = [
    ...relationshipEdges(input.relationships).filter((edge) => nodes.has(edge.from) && nodes.has(edge.to)),
    ...derivedEdges(input.resources, nodes),
    ...correlations.edges,
  ];
  const dedupedEdges = [...new Map(edges.map((edge) => [
    `${edge.from}\n${edge.to}\n${edge.relation}\n${edge.evidence.fieldPath ?? ""}`,
    edge,
  ])).values()];
  const adjacency = new Map<string, AttackGraphEdge[]>();
  for (const edge of dedupedEdges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge]);
  }
  const candidates: KubernetesAttackPath[] = [];

  for (const node of nodes.values()) {
    if (node.kind !== "internet" && node.kind !== "load_balancer" && node.kind !== "security_group") continue;
    const cloudPaths = enumerate(node.key, adjacency, (keys) =>
      hasOrderedKinds(keys, nodes, ["kubernetes_exposure", "kubernetes_workload", "service_account", "iam_role", "aws_resource"]),
    );
    for (const path of cloudPaths) {
      candidates.push(createPath("cloud_to_kubernetes", path.keys, nodes, path.edges, resourcesByKey, input.findings));
    }
  }

  for (const node of nodes.values()) {
    if (node.kind !== "runtime_event") continue;
    const runtimePaths = enumerate(node.key, adjacency, (keys) =>
      hasOrderedKinds(keys, nodes, ["kubernetes_workload", "service_account", "iam_role", "aws_resource"]),
    );
    for (const path of runtimePaths) {
      candidates.push(createPath("runtime_to_aws_blast_radius", path.keys, nodes, path.edges, resourcesByKey, input.findings));
    }
  }

  for (const node of nodes.values()) {
    if (node.kind !== "internet") continue;
    const observedPaths = enumerate(node.key, adjacency, (keys) =>
      hasOrderedKinds(keys, nodes, ["kubernetes_workload"]) &&
      keys.some((key) => nodes.get(key)?.kind === "kubernetes_workload"),
    3).filter((path) => path.edges.some((edge) => edge.evidence.source === "hubble"));
    for (const path of observedPaths) {
      candidates.push(createPath("observed_network_to_workload", path.keys, nodes, path.edges, resourcesByKey, input.findings));
    }
  }

  for (const node of nodes.values()) {
    if (node.kind !== "container_image") continue;
    const supplyPaths = enumerate(node.key, adjacency, (keys) =>
      hasOrderedKinds(keys, nodes, ["runtime_event", "kubernetes_workload"]),
    4);
    for (const path of supplyPaths) {
      candidates.push(createPath("supply_chain_to_runtime", path.keys, nodes, path.edges, resourcesByKey, input.findings));
    }
  }

  for (const node of nodes.values()) {
    if (node.kind !== "service_account" && node.kind !== "kubernetes_workload") continue;
    const rbacPaths = enumerate(node.key, adjacency, (keys) => {
      if (!hasOrderedKinds(keys, nodes, ["rbac_binding", "rbac_role"])) return false;
      const role = keys.map((key) => resourcesByKey.get(key)).find((resource) =>
        resource !== undefined && attackNodeKind(resource) === "rbac_role",
      );
      return role !== undefined && RBAC_ESCALATION_MARKER.test(JSON.stringify(role.configuration));
    }, 5);
    for (const path of rbacPaths) {
      candidates.push(createPath("rbac_privilege_escalation", path.keys, nodes, path.edges, resourcesByKey, input.findings));
    }
  }

  for (const node of nodes.values()) {
    if (node.kind !== "internet" && node.kind !== "load_balancer" && node.kind !== "security_group") continue;
    const correlated = enumerate(node.key, adjacency, (keys) => {
      const workload = keys
        .map((key) => resourcesByKey.get(key))
        .find((resource) => resource !== undefined && attackNodeKind(resource) === "kubernetes_workload");
      if (workload === undefined) return false;
      const vulnerable = input.findings.some((finding) =>
        finding.resourceKey === workload.resourceKey &&
        finding.status === "open" &&
        VULNERABILITY_MARKER.test(`${finding.controlKey} ${finding.title} ${finding.summary}`),
      );
      return vulnerable && PRIVILEGE_MARKER.test(JSON.stringify(workload.configuration));
    }, 6);
    for (const path of correlated) {
      candidates.push(createPath("vulnerable_exposed_privileged_workload", path.keys, nodes, path.edges, resourcesByKey, input.findings));
    }
  }

  const paths = [...new Map(candidates.map((path) => [path.id, path])).values()]
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const blastRadiusKeys = new Set(paths.flatMap((path) => path.blastRadius.map((node) => node.key)));
  const unknowns: string[] = [];
  if (![...nodes.values()].some((node) => node.kind === "kubernetes_exposure")) {
    unknowns.push("No normalized Kubernetes Service or Ingress resource is available.");
  }
  if (![...nodes.values()].some((node) => node.kind === "service_account")) {
    unknowns.push("No normalized Kubernetes ServiceAccount resource is available.");
  }
  if (![...nodes.values()].some((node) => node.kind === "iam_role")) {
    unknowns.push("No normalized IAM role resource is available for IRSA or EKS Pod Identity correlation.");
  }
  if (dedupedEdges.length === 0) {
    unknowns.push("No explicit relationship or supported configuration edge is available; reachability is not inferred.");
  }
  if ((input.runtimeEvents ?? []).length === 0) {
    unknowns.push("No signed Falco runtime event is available; runtime behavior is not inferred from configuration.");
  } else if (correlations.runtimeEvents.size === 0) {
    unknowns.push("Falco events are present but none match one unambiguous workload identity.");
  }
  if ((input.networkFlows ?? []).length === 0) {
    unknowns.push("No Hubble flow evidence is available; network reachability and isolation are not inferred.");
  } else if (correlations.networkFlows.size === 0) {
    unknowns.push("Hubble flows are present but no forwarded or audit flow matches unambiguous workload identities.");
  }
  if ((input.supplyChainEvidence ?? []).length === 0) {
    unknowns.push("No immutable image evidence is available for supply-chain correlation.");
  } else if (correlations.supplyChainEvidence.size === 0) {
    unknowns.push("Supply-chain evidence is present but no exact image digest matches one workload.");
  }
  unknowns.push("Data sensitivity is not classified; an AWS resource in blast radius must not be described as sensitive without separate evidence.");
  unknowns.push("Observed Hubble flows demonstrate past metadata observations only; they do not establish general or current reachability.");
  return {
    paths,
    nodes: [...nodes.values()],
    edges: dedupedEdges,
    unknowns,
    blastRadiusResourceCount: blastRadiusKeys.size,
    correlatedRuntimeEventCount: correlations.runtimeEvents.size,
    correlatedNetworkFlowCount: correlations.networkFlows.size,
    correlatedSupplyChainEvidenceCount: correlations.supplyChainEvidence.size,
  };
}
