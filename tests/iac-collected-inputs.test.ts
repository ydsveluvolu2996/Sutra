import assert from "node:assert/strict";
import test from "node:test";

import { buildCollectedIacInput, type CollectedClusterWorkloads } from "../lib/iac-collected-inputs.ts";
import { scanIacResources } from "../lib/iac-misconfiguration.ts";
import type { KubernetesWorkloadEvidence } from "../lib/kubernetes-posture.ts";

function container(
  overrides: Partial<KubernetesWorkloadEvidence["containers"][number]> = {},
): KubernetesWorkloadEvidence["containers"][number] {
  return {
    name: "app",
    image: `registry.example/app@sha256:${"a".repeat(64)}`,
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
    ...overrides,
  };
}

function workload(overrides: Partial<KubernetesWorkloadEvidence> = {}): KubernetesWorkloadEvidence {
  return {
    kind: "Workload",
    workloadKind: "Deployment",
    namespace: "payments",
    name: "api",
    serviceAccountName: null,
    hostNetwork: false,
    hostPid: false,
    hostIpc: false,
    hasHostPath: false,
    runAsNonRoot: true,
    seccompProfile: "RuntimeDefault",
    containers: [container()],
    ...overrides,
  };
}

function cluster(
  workloads: readonly KubernetesWorkloadEvidence[],
  overrides: Partial<CollectedClusterWorkloads> = {},
): CollectedClusterWorkloads {
  return {
    clusterId: "kcluster_" + "a".repeat(48),
    clusterName: "prod-eks",
    collectedAt: "2026-07-19T10:00:00.000Z",
    workloads,
    ...overrides,
  };
}

test("an insecure collected workload maps to kubernetes_pod evidence the scanner flags", () => {
  const insecure = workload({
    workloadKind: "DaemonSet",
    namespace: "system",
    name: "agent",
    hostNetwork: true,
    runAsNonRoot: false,
    containers: [container({
      privileged: true,
      runAsNonRoot: false,
      hasCpuLimit: false,
      hasMemoryLimit: false,
    })],
  });
  const input = buildCollectedIacInput([cluster([insecure])]);

  assert.deepEqual(input.resources, [{
    kind: "kubernetes_pod",
    name: "system/agent",
    config: { host_network: true, privileged: true, run_as_non_root: false, has_resource_limits: false },
    sourceRef: { file: "prod-eks · DaemonSet" },
  }]);
  assert.equal(input.coverage.workloads, 1);
  assert.equal(input.coverage.clustersWithScan, 1);

  const report = scanIacResources(input.resources, { tenant: "cust-1" });
  assert.equal(report.tenant, "cust-1");
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId).sort(),
    ["K8S_POD_HOST_NETWORK", "K8S_POD_MISSING_RESOURCE_LIMITS", "K8S_POD_PRIVILEGED", "K8S_POD_RUN_AS_NON_ROOT"],
  );
});

test("a hardened collected workload maps present-and-safe fields the scanner clears", () => {
  const input = buildCollectedIacInput([cluster([workload()])]);
  assert.deepEqual(input.resources[0]?.config, {
    host_network: false,
    privileged: false,
    run_as_non_root: true,
    has_resource_limits: true,
  });
  const report = scanIacResources(input.resources);
  assert.equal(report.summary.findings, 0);
  // Present-and-safe fields are evaluated, so nothing lands in not-evaluated here.
  assert.equal(report.summary.notEvaluated, 0);
});

test("unobserved (null TriState) fields are omitted so the scanner records field-absent, never a default", () => {
  const unknown = workload({
    name: "unknown",
    hostNetwork: null,
    runAsNonRoot: null,
    containers: [container({
      privileged: null,
      runAsNonRoot: null,
      hasCpuLimit: null,
      hasMemoryLimit: null,
    })],
  });
  const input = buildCollectedIacInput([cluster([unknown])]);
  // No field was observed, so nothing is synthesized into config.
  assert.deepEqual(input.resources[0]?.config, {});

  const report = scanIacResources(input.resources);
  assert.equal(report.summary.findings, 0);
  // Every kubernetes_pod rule reports field-absent rather than a manufactured pass.
  assert.deepEqual(
    report.coverage.notEvaluated.map((entry) => entry.ruleId).sort(),
    ["K8S_POD_HOST_NETWORK", "K8S_POD_MISSING_RESOURCE_LIMITS", "K8S_POD_PRIVILEGED", "K8S_POD_RUN_AS_NON_ROOT"],
  );
  assert.ok(report.coverage.notEvaluated.every((entry) => entry.reason === "field-absent"));
});

test("a partial mix maps only the observed fields and leaves the rest field-absent", () => {
  const partial = workload({
    name: "mixed",
    hostNetwork: true,          // observed -> mapped
    runAsNonRoot: null,         // unobserved at pod level
    containers: [container({
      privileged: null,         // unobserved -> privileged stays absent
      runAsNonRoot: null,       // falls back to pod-level null -> absent
      hasCpuLimit: true,        // one limit observed -> has limits true
      hasMemoryLimit: null,
    })],
  });
  const config = buildCollectedIacInput([cluster([partial])]).resources[0]?.config;
  assert.deepEqual(config, { host_network: true, has_resource_limits: true });
});

test("privileged aggregates across containers: any explicit true wins, unknown stays absent", () => {
  const anyPrivileged = workload({
    name: "multi",
    containers: [container({ privileged: false }), container({ name: "side", privileged: true })],
  });
  assert.equal(buildCollectedIacInput([cluster([anyPrivileged])]).resources[0]?.config.privileged, true);

  const oneUnknown = workload({
    name: "multi-unknown",
    containers: [container({ privileged: false }), container({ name: "side", privileged: null })],
  });
  // Not every container is explicitly false and none is true -> unknown (omitted).
  assert.equal("privileged" in (buildCollectedIacInput([cluster([oneUnknown])]).resources[0]?.config ?? {}), false);
});

test("no collected specs reports explicit zero-coverage, not an empty clean pass", () => {
  // A cluster enrolled but never collected (collectedAt null, no workloads).
  const pending = buildCollectedIacInput([cluster([], { collectedAt: null })]);
  assert.equal(pending.coverage.clusters, 1);
  assert.equal(pending.coverage.clustersWithScan, 0);
  assert.equal(pending.coverage.workloads, 0);
  assert.deepEqual(pending.resources, []);

  // No clusters at all.
  const none = buildCollectedIacInput([]);
  assert.deepEqual(none.coverage, { clusters: 0, clustersWithScan: 0, workloads: 0, clusterBreakdown: [] });

  // The scanner over zero resources is a zero-coverage report, distinguishable
  // from a real scan by summary.resources === 0.
  const report = scanIacResources(none.resources);
  assert.equal(report.summary.resources, 0);
  assert.equal(report.summary.findings, 0);
  assert.deepEqual(report.coverage.evaluatedKinds, []);
});

test("coverage aggregates workload counts across multiple clusters", () => {
  const input = buildCollectedIacInput([
    cluster([workload()], { clusterId: "kcluster_" + "a".repeat(48), clusterName: "a" }),
    cluster([workload({ name: "b1" }), workload({ name: "b2" })], { clusterId: "kcluster_" + "b".repeat(48), clusterName: "b" }),
    cluster([], { clusterId: "kcluster_" + "c".repeat(48), clusterName: "c", collectedAt: null }),
  ]);
  assert.equal(input.coverage.clusters, 3);
  assert.equal(input.coverage.clustersWithScan, 2);
  assert.equal(input.coverage.workloads, 3);
  assert.deepEqual(input.coverage.clusterBreakdown.map((entry) => entry.workloads), [1, 2, 0]);
});
