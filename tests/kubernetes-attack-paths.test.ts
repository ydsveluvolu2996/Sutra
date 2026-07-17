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
    source: { api: "fixture", accountId: "738663485493", collectedAt },
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
  const roleArn = "arn:aws:iam::738663485493:role/payments-api";
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
            template: { spec: { containers: [{ securityContext: { privileged: true } }] } },
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
  assert.equal(result.unknowns.length, 4);
  assert.match(result.unknowns.at(-1) ?? "", /reachability is not inferred/u);
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
