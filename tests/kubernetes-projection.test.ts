import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  PilotCoverageEntry,
  PilotFinding,
  PilotRelationship,
  PilotResource,
} from "../lib/pilot-types.ts";
import {
  buildKubernetesProjection,
  isNormalizedKubernetesResource,
} from "../app/kubernetes/kubernetes-projection.ts";

function resource(input: {
  readonly key: string;
  readonly service: string;
  readonly type: string;
  readonly name: string;
  readonly configuration?: PilotResource["configuration"];
}): PilotResource {
  return {
    resourceKey: input.key,
    service: input.service,
    resourceType: input.type,
    nativeId: input.key,
    arn: null,
    name: input.name,
    region: "us-east-1",
    state: "active",
    tags: {},
    configuration: input.configuration ?? {},
    source: {
      api: "normalized-test-api",
      accountId: "111122223333",
      collectedAt: "2026-07-17T10:00:00.000Z",
    },
    contentSha256: "a".repeat(64),
  };
}

const cluster = resource({
  key: "eks-cluster",
  service: "eks",
  type: "aws.eks.cluster",
  name: "production-eks",
  configuration: { clusterName: "production-eks" },
});
const namespace = resource({
  key: "k8s-namespace",
  service: "kubernetes",
  type: "kubernetes.namespace",
  name: "payments",
  configuration: {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "payments" },
  },
});
const workload = resource({
  key: "k8s-deployment",
  service: "kubernetes",
  type: "kubernetes.apps.deployment",
  name: "payments-api",
  configuration: {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "payments-api", namespace: "payments" },
  },
});
const unrelatedEc2 = resource({
  key: "ec2-instance",
  service: "ec2",
  type: "aws.ec2.instance",
  name: "worker-looking-instance",
  configuration: { platform: "linux" },
});
const relationships: readonly PilotRelationship[] = [
  {
    fromResourceKey: workload.resourceKey,
    toResourceKey: namespace.resourceKey,
    relationType: "belongs_to",
    evidence: {},
  },
  {
    fromResourceKey: namespace.resourceKey,
    toResourceKey: cluster.resourceKey,
    relationType: "belongs_to",
    evidence: {},
  },
];
const finding: PilotFinding = {
  fingerprint: "finding-k8s-public-service",
  resourceKey: workload.resourceKey,
  controlKey: "kubernetes.service.public",
  controlVersion: "1",
  severity: "high",
  status: "open",
  title: "Workload service is publicly reachable",
  summary: "The normalized service evidence reports a public endpoint.",
  remediation: "Review the intended exposure.",
  evidence: { source: "normalized finding" },
  evaluatedAt: "2026-07-17T10:00:00.000Z",
};
const accountFinding: PilotFinding = {
  ...finding,
  fingerprint: "finding-account",
  resourceKey: null,
  title: "Account finding",
};
const coverage: readonly PilotCoverageEntry[] = [
  {
    collectorKey: "eks.clusters",
    region: "us-east-1",
    status: "succeeded",
    itemsObserved: 1,
    pagesObserved: 1,
  },
  {
    collectorKey: "ec2.instances",
    region: "us-east-1",
    status: "succeeded",
    itemsObserved: 1,
    pagesObserved: 1,
  },
];

describe("Kubernetes UI projection", () => {
  it("accepts only explicitly normalized Kubernetes or EKS resource evidence", () => {
    assert.equal(isNormalizedKubernetesResource(cluster), true);
    assert.equal(isNormalizedKubernetesResource(namespace), true);
    assert.equal(isNormalizedKubernetesResource(workload), true);
    assert.equal(isNormalizedKubernetesResource(unrelatedEc2), false);
  });

  it("builds cluster, namespace, workload and relationship drilldowns from reported data", () => {
    const projection = buildKubernetesProjection({
      resources: [cluster, namespace, workload, unrelatedEc2],
      relationships,
      findings: [finding, accountFinding],
      coverage,
    });
    assert.equal(projection.records.length, 3);
    assert.deepEqual(projection.categoryCounts, {
      cluster: 1,
      namespace: 1,
      workload: 1,
      node: 0,
      network: 0,
      access: 0,
      other: 0,
    });
    assert.deepEqual(projection.clusters, ["production-eks"]);
    assert.deepEqual(projection.namespaces, ["payments"]);
    assert.equal(projection.records.find((record) => record.resource.resourceKey === "k8s-deployment")?.namespace, "payments");
    assert.equal(projection.records.find((record) => record.resource.resourceKey === "k8s-deployment")?.clusterName, "production-eks");
    assert.equal(projection.records.find((record) => record.resource.resourceKey === "k8s-namespace")?.clusterName, "production-eks");
  });

  it("passes through only resource-attached findings and never synthesizes CVEs", () => {
    const projection = buildKubernetesProjection({
      resources: [cluster, namespace, workload],
      relationships,
      findings: [finding, accountFinding],
      coverage,
    });
    assert.deepEqual(projection.findings.map((candidate) => candidate.fingerprint), [finding.fingerprint]);
    assert.equal(projection.findings.some((candidate) => /\bCVE-\d{4}-\d+\b/u.test(candidate.title)), false);
    assert.deepEqual(projection.coverage.map((entry) => entry.collectorKey), ["eks.clusters"]);
  });

  it("reports empty evidence without inferring Kubernetes from generic compute", () => {
    const projection = buildKubernetesProjection({
      resources: [unrelatedEc2],
      relationships: [],
      findings: [accountFinding],
      coverage: [coverage[1]],
    });
    assert.equal(projection.records.length, 0);
    assert.equal(projection.findings.length, 0);
    assert.equal(projection.coverage.length, 0);
  });
});
