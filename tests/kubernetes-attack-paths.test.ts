import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKubernetesAttackPaths,
  type KubernetesAttackPathProjection,
} from "../lib/kubernetes-attack-paths.ts";
import type {
  JsonValue,
  PilotFinding,
  PilotRelationship,
  PilotResource,
} from "../lib/pilot-types.ts";
import type { NormalizedFalcoRuntimeEvent } from "../lib/falco-runtime-types.ts";
import type { NormalizedHubbleFlow } from "../lib/hubble-flow-evidence.ts";
import type { KubernetesSupplyChainEvidence } from "../lib/kubernetes-supply-chain.ts";

const collectedAt = "2026-07-17T08:00:00.000Z";

function resource(input: {
  key: string;
  service: string;
  type: string;
  nativeId?: string;
  arn?: string | null;
  name?: string;
  configuration?: Readonly<Record<string, JsonValue>>;
}): PilotResource {
  return {
    resourceKey: input.key,
    service: input.service,
    resourceType: input.type,
    nativeId: input.nativeId ?? input.name ?? input.key,
    arn: input.arn ?? null,
    name: input.name ?? null,
    region: "ap-south-1",
    state: "active",
    tags: {},
    configuration: input.configuration ?? {},
    source: { api: "fixture", accountId: "505060607080", collectedAt },
    contentSha256: `sha-${input.key}`,
  };
}

function relationship(from: string, to: string, relationType: string): PilotRelationship {
  return {
    fromResourceKey: from,
    toResourceKey: to,
    relationType,
    evidence: { api: "fixture", observedAt: collectedAt },
  };
}

function finding(resourceKey: string, severity: "critical" | "high" = "critical"): PilotFinding {
  return {
    fingerprint: `finding-${resourceKey}`,
    resourceKey,
    controlKey: "CONTAINER-CVE-2026-1000",
    controlVersion: "1",
    severity,
    status: "open",
    title: "Critical container image vulnerability",
    summary: "The source scanner reported CVE-2026-1000 in the observed image.",
    remediation: "Upgrade the affected source image.",
    evidence: { scanner: "source-native" },
    evaluatedAt: collectedAt,
  };
}

function completeFixture(): {
  resources: PilotResource[];
  relationships: PilotRelationship[];
  findings: PilotFinding[];
} {
  const roleArn = "arn:aws:iam::505060607080:role/payments-api";
  return {
    resources: [
      resource({
        key: "lb",
        service: "elbv2",
        type: "aws.elbv2.loadbalancer",
        name: "public-alb",
        configuration: { scheme: "internet-facing" },
      }),
      resource({ key: "sg", service: "ec2", type: "aws.ec2.security-group", name: "public-sg" }),
      resource({
        key: "service",
        service: "kubernetes",
        type: "kubernetes.service",
        name: "payments-api",
        configuration: { apiVersion: "v1", kind: "Service", namespace: "payments", clusterName: "prod" },
      }),
      resource({
        key: "workload",
        service: "kubernetes",
        type: "kubernetes.deployment",
        name: "payments",
        configuration: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          namespace: "payments",
          clusterName: "prod",
          spec: {
            serviceAccountName: "payments-sa",
            template: { spec: { containers: [{ image: "registry.example/payments@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", securityContext: { privileged: true } }] } },
          },
        },
      }),
      resource({
        key: "sa",
        service: "kubernetes",
        type: "kubernetes.service-account",
        name: "payments-sa",
        configuration: {
          apiVersion: "v1",
          kind: "ServiceAccount",
          namespace: "payments",
          clusterName: "prod",
          metadata: { annotations: { "eks.amazonaws.com/role-arn": roleArn } },
        },
      }),
      resource({
        key: "binding",
        service: "kubernetes",
        type: "kubernetes.role-binding",
        name: "payments-admin",
        configuration: {
          apiVersion: "rbac.authorization.k8s.io/v1",
          kind: "RoleBinding",
          namespace: "payments",
          clusterName: "prod",
          roleRef: { name: "secret-admin" },
          subjects: [{ kind: "ServiceAccount", name: "payments-sa", namespace: "payments" }],
        },
      }),
      resource({
        key: "rbac-role",
        service: "kubernetes",
        type: "kubernetes.role",
        name: "secret-admin",
        configuration: {
          apiVersion: "rbac.authorization.k8s.io/v1",
          kind: "Role",
          namespace: "payments",
          clusterName: "prod",
          rules: [{ apiGroups: ["*"], resources: ["secrets"], verbs: ["*"] }],
        },
      }),
      resource({
        key: "iam-role",
        service: "iam",
        type: "aws.iam.role",
        name: "payments-api",
        nativeId: roleArn,
        arn: roleArn,
      }),
      resource({ key: "bucket", service: "s3", type: "aws.s3.bucket", name: "payments-ledger" }),
    ],
    relationships: [
      relationship("lb", "sg", "attached_security_group"),
      relationship("sg", "service", "permits_ingress_to"),
      relationship("service", "workload", "selects_workload"),
      relationship("iam-role", "bucket", "can_read"),
    ],
    findings: [finding("workload")],
  };
}

function build(fixture = completeFixture()): KubernetesAttackPathProjection {
  return buildKubernetesAttackPaths(fixture);
}

test("builds a cloud-to-Kubernetes-to-AWS path only from cited edges", () => {
  const result = build();
  const path = result.paths.find((candidate) => candidate.type === "cloud_to_kubernetes");
  assert.ok(path);
  assert.deepEqual(path.nodes.map((node) => node.kind), [
    "internet",
    "load_balancer",
    "security_group",
    "kubernetes_exposure",
    "kubernetes_workload",
    "service_account",
    "iam_role",
    "aws_resource",
  ]);
  assert.equal(path.edges.length, path.nodes.length - 1);
  assert.ok(path.edges.every((edge) =>
    edge.evidence.sourceResourceKey.length > 0 &&
    edge.evidence.relationType.length > 0 &&
    (edge.evidence.source === "relationship" || edge.evidence.fieldPath !== null),
  ));
  assert.deepEqual(path.blastRadius.map((node) => node.key), ["bucket"]);
  assert.equal(result.blastRadiusResourceCount, 1);
});

test("correlates exposure, a source vulnerability finding, and explicit privilege configuration", () => {
  const path = build().paths.find((candidate) =>
    candidate.type === "vulnerable_exposed_privileged_workload",
  );
  assert.ok(path);
  assert.equal(path.findings[0]?.fingerprint, "finding-workload");
  assert.deepEqual(path.factors.map((factor) => factor.key), [
    "public",
    "load-balancer",
    "security-group",
    "vulnerability",
    "privilege",
  ]);
  assert.equal(path.score, 85);
  assert.equal(path.risk, "critical");
});

test("builds RBAC escalation only when a binding and escalation-sensitive role are both evidenced", () => {
  const result = build();
  const path = result.paths.find((candidate) =>
    candidate.type === "rbac_privilege_escalation" && candidate.nodes[0]?.key === "sa",
  );
  assert.ok(path);
  assert.deepEqual(path.nodes.map((node) => node.key), ["sa", "binding", "rbac-role"]);
  assert.deepEqual(path.edges.map((edge) => edge.evidence.fieldPath), [
    "subjects[0].name",
    "roleRef.name",
  ]);
  assert.equal(path.factors.some((factor) => factor.key === "rbac-escalation"), true);
});

test("does not fabricate reachability when an explicit relationship is missing or reversed", () => {
  const fixture = completeFixture();
  fixture.relationships = fixture.relationships
    .filter((edge) => edge.relationType !== "selects_workload")
    .concat(relationship("workload", "service", "selected_by"));
  const result = build(fixture);
  assert.equal(result.paths.some((path) => path.type === "cloud_to_kubernetes"), false);
  assert.equal(result.paths.some((path) => path.type === "vulnerable_exposed_privileged_workload"), false);
});

test("does not correlate ambiguous service-account names without exact identity evidence", () => {
  const fixture = completeFixture();
  fixture.resources.push(resource({
    key: "sa-duplicate",
    service: "kubernetes",
    type: "kubernetes.service-account",
    name: "payments-sa",
    configuration: { apiVersion: "v1", kind: "ServiceAccount" },
  }));
  const result = build(fixture);
  assert.equal(result.edges.some((edge) =>
    edge.from === "workload" && edge.relation === "uses_service_account",
  ), false);
  assert.equal(result.paths.some((path) => path.type === "cloud_to_kubernetes"), false);
});

test("reports evidence gaps instead of emitting paths for unrelated assets", () => {
  const result = buildKubernetesAttackPaths({
    resources: [resource({ key: "instance", service: "ec2", type: "aws.ec2.instance" })],
    relationships: [],
    findings: [],
  });
  assert.deepEqual(result.paths, []);
  assert.ok(result.unknowns.length >= 8);
  assert.equal(result.unknowns.some((gap) => /Data sensitivity is not classified/u.test(gap)), true);
  assert.equal(result.unknowns.some((gap) => /do not establish general or current reachability/u.test(gap)), true);
});

function runtimeEvent(): NormalizedFalcoRuntimeEvent {
  return {
    schemaVersion: "sutra.falco.runtime-event.v1",
    eventId: `frte_${"1".repeat(48)}`,
    clusterId: `kcluster_${"2".repeat(48)}`,
    occurredAt: "2026-07-17T08:10:00.000Z",
    rule: "Terminal shell in container",
    priority: "warning",
    source: "syscall",
    nodeName: "node-a",
    namespace: "payments",
    podName: "payments",
    podUid: "pod-uid",
    containerId: "container-id",
    containerName: "api",
    containerImage: "registry.example/payments@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    process: {
      name: "sh", executable: "/bin/sh", pid: 12, parentPid: 1,
      userName: "app", userId: "1000", eventType: "execve",
    },
    evidenceSha256: "3".repeat(64),
  };
}

function hubbleFlow(): NormalizedHubbleFlow {
  return {
    observedAt: "2026-07-17T08:09:00.000Z",
    source: { namespace: null, workloadKind: null, workloadName: null, serviceName: null, world: true },
    destination: { namespace: "payments", workloadKind: "Deployment", workloadName: "payments", serviceName: null, world: false },
    direction: "ingress",
    verdict: "forwarded",
    protocol: "TCP",
    destinationPort: 443,
    observations: 4,
    evidenceSha256: "4".repeat(64),
  };
}

function supplyEvidence(): KubernetesSupplyChainEvidence {
  return {
    schemaVersion: "sutra.kubernetes-supply-chain.v1",
    clusterId: `kcluster_${"2".repeat(48)}`,
    collectedAt: "2026-07-17T08:05:00.000Z",
    image: {
      repository: "registry.example/payments",
      digest: `sha256:${"a".repeat(64)}`,
      tag: null,
    },
    vulnerabilityScan: {
      scanner: "Trivy", scannerVersion: "0.60.0", scannedAt: "2026-07-17T08:04:00.000Z",
      critical: 1, high: 2, medium: 0, low: 0, unknown: 0, fixedAvailable: 1,
    },
    sbom: { format: "CycloneDX", componentCount: 42, documentSha256: "5".repeat(64) },
    signature: { state: "verified", issuer: "https://token.actions.githubusercontent.com", subject: "repo:example/payments", transparencyLogVerified: true },
    provenance: { state: "verified", builderId: "github-actions", sourceRepository: "example/payments", commitSha: "6".repeat(40) },
    priority: { score: 40, rating: "medium", factors: ["1 critical package vulnerability"] },
    evidenceSha256: "7".repeat(64),
    limitations: [
      "EVIDENCE_DESCRIBES_ONE_IMMUTABLE_IMAGE_DIGEST",
      "VULNERABILITY_PRESENCE_DOES_NOT_PROVE_EXPLOITABILITY",
      "SIGNATURE_VERIFICATION_DOES_NOT_ESTABLISH_SOURCE_CODE_SAFETY",
    ],
  };
}

test("correlates timestamped Falco, Hubble and immutable image evidence without inferring reachability", () => {
  const fixture = completeFixture();
  const result = buildKubernetesAttackPaths({
    ...fixture,
    runtimeEvents: [runtimeEvent()],
    networkFlows: [hubbleFlow()],
    supplyChainEvidence: [supplyEvidence()],
  });
  assert.equal(result.correlatedRuntimeEventCount, 1);
  assert.equal(result.correlatedNetworkFlowCount, 1);
  assert.equal(result.correlatedSupplyChainEvidenceCount, 1);
  const runtime = result.paths.find((path) => path.type === "runtime_to_aws_blast_radius");
  assert.ok(runtime);
  assert.equal(runtime.nodes[0]?.kind, "runtime_event");
  assert.equal(runtime.observedFrom, "2026-07-17T08:00:00.000Z");
  assert.equal(runtime.observedTo, "2026-07-17T08:10:00.000Z");
  assert.equal(runtime.remediations.some((item) => item.key === "investigate-runtime"), true);
  assert.equal(runtime.remediations.every((item) => item.limitation === "SUGGESTION_REQUIRES_OPERATOR_VALIDATION"), true);
  assert.ok(result.paths.some((path) => path.type === "observed_network_to_workload"));
  assert.ok(result.paths.some((path) => path.type === "supply_chain_to_runtime"));
});

test("does not treat dropped Hubble evidence as a reachable path", () => {
  const fixture = completeFixture();
  const result = buildKubernetesAttackPaths({
    ...fixture,
    networkFlows: [{ ...hubbleFlow(), verdict: "dropped" }],
  });
  assert.equal(result.correlatedNetworkFlowCount, 0);
  assert.equal(result.paths.some((path) => path.type === "observed_network_to_workload"), false);
});

test("scoring is deterministic and finding severity changes only the documented factor", () => {
  const critical = build();
  const fixture = completeFixture();
  fixture.findings = [finding("workload", "high")];
  const high = build(fixture);
  const criticalPath = critical.paths.find((path) => path.type === "vulnerable_exposed_privileged_workload");
  const highPath = high.paths.find((path) => path.type === "vulnerable_exposed_privileged_workload");
  assert.equal(criticalPath?.score, 85);
  assert.equal(highPath?.score, 75);
  assert.equal(build().paths.find((path) => path.type === "vulnerable_exposed_privileged_workload")?.score, 85);
});

test("derives the cross-plane RBAC/IRSA chain from the stored posture projection shape", () => {
  // Exactly what projectStoredKubernetesWorkspace emits: configuration.kind is the
  // evidence kind, roleRef is flattened to roleRefName, and the SA carries a flat
  // iamRoleArn. Before the CIEM wiring + attack-path classification fix, none of
  // these K8s->AWS edges materialized.
  const projection = buildKubernetesAttackPaths({
    relationships: [],
    findings: [],
    resources: [
      resource({
        key: "k8s:wl", service: "kubernetes", type: "kubernetes.deployment", name: "checkout-api",
        configuration: { kind: "Deployment", namespace: "payments", clusterName: "prod", serviceAccountName: "checkout" },
      }),
      resource({
        key: "k8s:sa", service: "kubernetes", type: "kubernetes.serviceaccount", name: "checkout",
        configuration: { kind: "ServiceAccount", namespace: "payments", clusterName: "prod", iamRoleArn: "arn:aws:iam::111122223333:role/checkout" },
      }),
      resource({
        key: "k8s:rb", service: "kubernetes", type: "kubernetes.rbacbinding", name: "checkout-binding",
        configuration: {
          kind: "RbacBinding", namespace: "payments", clusterName: "prod",
          roleRefKind: "Role", roleRefName: "reader",
          subjects: [{ kind: "ServiceAccount", namespace: "payments", name: "checkout" }],
        },
      }),
      resource({
        key: "k8s:role", service: "kubernetes", type: "kubernetes.rbacrole", name: "reader",
        configuration: { kind: "RbacRole", clusterScoped: false, namespace: "payments", clusterName: "prod", rules: [{ verbs: ["get"], apiGroups: [""], resources: ["secrets"] }] },
      }),
      resource({
        key: "aws:iam", service: "iam", type: "aws.iam.role", name: "checkout",
        arn: "arn:aws:iam::111122223333:role/checkout",
        configuration: { policyDocument: { Statement: [{ Effect: "Allow", Action: ["s3:PutObject"], Resource: ["*"] }] } },
      }),
    ],
  });
  const relationOf = (from: string, to: string) =>
    projection.edges.find((edge) => edge.from === from && edge.to === to)?.relation;
  assert.equal(relationOf("k8s:wl", "k8s:sa"), "uses_service_account");
  assert.equal(relationOf("k8s:sa", "aws:iam"), "assumes_iam_role");
  assert.equal(relationOf("k8s:rb", "k8s:role"), "binds_rbac_role");
  assert.equal(relationOf("k8s:sa", "k8s:rb"), "subject_of_rbac_binding");
  // The IAM role is reachable from the workload through the SA hop.
  assert.equal(projection.nodes.find((node) => node.key === "aws:iam")?.kind, "iam_role");
  assert.equal(projection.nodes.find((node) => node.key === "k8s:rb")?.kind, "rbac_binding");
});
