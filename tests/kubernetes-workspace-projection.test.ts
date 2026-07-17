import assert from "node:assert/strict";
import test from "node:test";
import { projectStoredKubernetesWorkspace } from "../lib/kubernetes-workspace-projection.ts";
import type { PilotConnection } from "../lib/pilot-types.ts";
import type { KubernetesStoredWorkspace } from "../db/kubernetes-repository.ts";

const connection = {
  id: "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  customerId: "customer_demo",
  customerName: "Demo",
  sourceKind: "aws_trust_role",
  fixtureId: null,
  fixtureVersion: null,
  partition: "aws",
  awsAccountId: "738663485493",
  roleArn: "arn:aws:iam::738663485493:role/sutra/SutraLocalCollectorRole",
  status: "active",
  enabledRegions: ["ap-south-1"],
  permissionPackVersion: "2",
  lastValidatedAt: "2026-07-17T00:00:00.000Z",
  lastSuccessfulSyncAt: "2026-07-17T00:00:00.000Z",
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z",
} as const satisfies PilotConnection;

const workspace: KubernetesStoredWorkspace = {
  cluster: {
    id: `kcluster_${"b".repeat(48)}`,
    clusterUid: "738663485493:ap-south-1:demo",
    name: "demo",
    distribution: "Amazon EKS",
    version: "1.33",
    status: "active",
    latestCompleteScan: null,
  },
  scan: {
    id: "kscan_demo",
    orgId: "org_demo",
    customerId: "customer_demo",
    clusterId: `kcluster_${"b".repeat(48)}`,
    status: "complete",
    collectedAt: "2026-07-17T00:00:00.000Z",
    evidenceSha256: "c".repeat(64),
    postureSha256: "d".repeat(64),
    resourceCount: 1,
    findingCount: 1,
    coverageCount: 1,
  },
  resources: [{
    kind: "Workload",
    namespace: "payments",
    name: "api",
    workloadKind: "Deployment",
    hostNetwork: false,
    hostPid: false,
    hostIpc: false,
    hasHostPath: false,
    runAsNonRoot: true,
    seccompProfile: "RuntimeDefault",
    containers: [{
      name: "api",
      image: "registry.example/api@sha256:abc",
      privileged: false,
      allowPrivilegeEscalation: false,
      runAsNonRoot: true,
      capabilitiesAdd: [],
      capabilitiesDrop: ["ALL"],
      hasCpuRequest: true,
      hasMemoryRequest: true,
      hasCpuLimit: true,
      hasMemoryLimit: true,
      hasLivenessProbe: true,
      hasReadinessProbe: true,
    }],
  }],
  findings: [{
    controlId: "K8S-WORKLOAD-PRIVILEGED",
    subject: "Workload/payments/api",
    state: "PASS",
    severity: "CRITICAL",
    message: "Containers must not run privileged",
    evidence: ["api:privileged=false"],
  }],
  coverage: [{ evidenceKind: "Workload", state: "COMPLETE", itemsObserved: 1 }],
  scannerEvidence: { findings: [], sboms: [] },
};

test("projects durable Kubernetes evidence without inventing runtime data", () => {
  const projection = projectStoredKubernetesWorkspace(workspace, connection);
  assert.equal(projection.resources.length, 2);
  assert.equal(projection.resources[1]?.configuration.kind, "Deployment");
  assert.equal(projection.resources[1]?.configuration.namespace, "payments");
  assert.equal(projection.findings[0]?.resourceKey, projection.resources[1]?.resourceKey);
  assert.equal(projection.findings[0]?.status, "resolved");
  assert.equal(projection.coverage[0]?.status, "succeeded");
  assert.equal(projection.coverage.some((item) => /runtime|trivy|falco/iu.test(item.collectorKey)), false);
});
