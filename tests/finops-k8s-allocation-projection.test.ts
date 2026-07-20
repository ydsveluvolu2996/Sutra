import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "../lib/canonical-json.ts";
import {
  KubernetesEvidenceError,
  normalizeKubernetesEvidence,
  type KubernetesEvidenceSnapshot,
} from "../lib/kubernetes-posture.ts";
import {
  NODE_MONTHLY_LIST_PRICE_USD_MICROS,
  projectKubernetesAllocationInput,
} from "../lib/finops-k8s-allocation-projection.ts";
import { buildKubernetesAllocationInput } from "../lib/finops-k8s-allocation-inputs.ts";
import { buildKubernetesAllocation } from "../lib/finops-k8s-allocation.ts";

const COLLECTED_AT = "2026-07-17T12:00:00.000Z";

function container(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    image: null,
    privileged: null,
    allowPrivilegeEscalation: null,
    runAsNonRoot: null,
    capabilitiesAdd: null,
    capabilitiesDrop: null,
    hasCpuRequest: null,
    hasMemoryRequest: null,
    hasCpuLimit: null,
    hasMemoryLimit: null,
    hasLivenessProbe: null,
    hasReadinessProbe: null,
    ...over,
  };
}

function workload(namespace: string, name: string, containers: Record<string, unknown>[]): Record<string, unknown> {
  return {
    kind: "Workload",
    workloadKind: "Deployment",
    namespace,
    name,
    hostNetwork: null,
    hostPid: null,
    hostIpc: null,
    hasHostPath: null,
    runAsNonRoot: null,
    seccompProfile: null,
    containers,
  };
}

function evidence(
  resources: Record<string, unknown>[],
  nodes?: Record<string, unknown>[],
): KubernetesEvidenceSnapshot {
  return normalizeKubernetesEvidence({
    clusterId: "cluster_prod_01",
    collectedAt: COLLECTED_AT,
    observedKinds: ["Workload"],
    resources,
    ...(nodes !== undefined ? { nodes } : {}),
  });
}

function node(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    allocatableCpuMillicores: null,
    allocatableMemoryBytes: null,
    instanceType: null,
    ...over,
  };
}

// ---- Numeric-request round-trip through evidence + SHA stability ----

test("numeric container requests survive normalization when present", () => {
  const snapshot = evidence([
    workload("team-a", "api", [
      container("api", { cpuRequestMillicores: 250, memoryRequestBytes: 536_870_912 }),
    ]),
  ]);
  const wl = snapshot.resources[0];
  assert.equal(wl.kind, "Workload");
  if (wl.kind !== "Workload") return;
  assert.equal(wl.containers[0]?.cpuRequestMillicores, 250);
  assert.equal(wl.containers[0]?.memoryRequestBytes, 536_870_912);
});

test("absent numeric requests are OMITTED (never null) so evidence bytes stay stable", () => {
  const snapshot = evidence([workload("team-a", "api", [container("api")])]);
  const wl = snapshot.resources[0];
  assert.equal(wl.kind, "Workload");
  if (wl.kind !== "Workload") return;
  assert.equal("cpuRequestMillicores" in wl.containers[0], false);
  assert.equal("memoryRequestBytes" in wl.containers[0], false);
  const json = canonicalJson({ evidence: snapshot });
  assert.equal(json.includes("cpuRequestMillicores"), false);
  assert.equal(json.includes("memoryRequestBytes"), false);
  assert.equal(json.includes("nodes"), false);
  // Determinism: normalizing the same node-less input twice is byte-identical.
  assert.equal(json, canonicalJson({ evidence: evidence([workload("team-a", "api", [container("api")])]) }));
});

test("invalid numeric requests are rejected at normalization", () => {
  assert.throws(
    () => evidence([workload("team-a", "api", [container("api", { cpuRequestMillicores: -5 })])]),
    KubernetesEvidenceError,
  );
  assert.throws(
    () => evidence([workload("team-a", "api", [container("api", { memoryRequestBytes: 1.5 })])]),
    KubernetesEvidenceError,
  );
});

// ---- Node normalization ----

test("nodes normalize: validated, de-duplicated, sorted, and omitted when empty", () => {
  const snapshot = evidence(
    [workload("team-a", "api", [container("api")])],
    [
      node("node-z", { allocatableCpuMillicores: 2000, allocatableMemoryBytes: 8_000_000_000, instanceType: "m5.large" }),
      node("node-a", { allocatableCpuMillicores: 2000, instanceType: "m5.large" }),
      node("node-z", { instanceType: "duplicate-dropped" }),
    ],
  );
  assert.deepEqual(snapshot.nodes?.map((n) => n.name), ["node-a", "node-z"]);
  assert.equal(snapshot.nodes?.[0]?.allocatableMemoryBytes, null);
  assert.equal(snapshot.nodes?.[1]?.instanceType, "m5.large");

  const empty = evidence([workload("team-a", "api", [container("api")])], []);
  assert.equal("nodes" in empty, false);
});

test("invalid node allocatable values are rejected", () => {
  assert.throws(
    () => evidence([workload("team-a", "api", [container("api")])], [node("n1", { allocatableCpuMillicores: -1 })]),
    KubernetesEvidenceError,
  );
  assert.throws(
    () => evidence([workload("team-a", "api", [container("api")])], [node("n1", { allocatableMemoryBytes: 3.14 })]),
    KubernetesEvidenceError,
  );
});

// ---- Projection ----

test("projects a real two-namespace split priced from the node catalog (memory-absent path)", () => {
  const snapshot = evidence(
    [
      workload("team-a", "api", [container("api", { cpuRequestMillicores: 750 })]),
      workload("team-b", "web", [container("web", { cpuRequestMillicores: 250 })]),
    ],
    // Two m5.large: cost 2 x 70_080_000 = 140_160_000 micros; no allocatable -> capacity null.
    [node("n1", { instanceType: "m5.large" }), node("n2", { instanceType: "m5.large" })],
  );
  const projection = projectKubernetesAllocationInput(snapshot);
  assert.equal(projection.clusterCosts?.length, 1);
  assert.deepEqual(projection.clusterCosts?.[0], {
    clusterId: "cluster_prod_01",
    currency: "USD",
    amountMicros: "140160000",
  });
  assert.equal(projection.costCatalogCoverage.costDerivable, true);
  assert.equal(projection.costCatalogCoverage.nodesPriced, 2);

  const report = buildKubernetesAllocation(buildKubernetesAllocationInput(projection));
  const cluster = report.clusters[0];
  assert.equal(cluster?.costAvailable, true);
  assert.equal(cluster?.basis, "cpu-only");
  const currency = cluster?.currencies[0];
  assert.equal(currency?.currency, "USD");
  const teamA = currency?.namespaces.find((n) => n.namespace === "team-a");
  const teamB = currency?.namespaces.find((n) => n.namespace === "team-b");
  assert.equal(teamA?.allocatedMicros, "105120000"); // 140_160_000 * 750/1000
  assert.equal(teamB?.allocatedMicros, "35040000"); // 140_160_000 * 250/1000
  assert.equal(currency?.unallocatedMicros, "0");
});

test("projects a cpu+memory blend with genuine idle from allocatable capacity", () => {
  const snapshot = evidence(
    [
      workload("team-a", "api", [container("api", { cpuRequestMillicores: 1000, memoryRequestBytes: 1_000_000_000 })]),
      workload("team-b", "web", [container("web", { cpuRequestMillicores: 1000, memoryRequestBytes: 3_000_000_000 })]),
    ],
    [
      node("n1", { instanceType: "m5.large", allocatableCpuMillicores: 2000, allocatableMemoryBytes: 8_000_000_000 }),
      node("n2", { instanceType: "m5.large", allocatableCpuMillicores: 2000, allocatableMemoryBytes: 8_000_000_000 }),
    ],
  );
  const projection = projectKubernetesAllocationInput(snapshot);
  assert.deepEqual(projection.capacity?.[0], {
    clusterId: "cluster_prod_01",
    cpuMillicores: 4000,
    memoryBytes: 16_000_000_000,
  });

  const report = buildKubernetesAllocation(buildKubernetesAllocationInput(projection));
  const cluster = report.clusters[0];
  assert.equal(cluster?.basis, "cpu-memory-blend");
  assert.equal(cluster?.allocatableCpuMillicores, 4000);
  assert.equal(cluster?.allocatableMemoryBytes, 16_000_000_000);
  const currency = cluster?.currencies[0];
  const teamA = currency?.namespaces.find((n) => n.namespace === "team-a");
  const teamB = currency?.namespaces.find((n) => n.namespace === "team-b");
  // cpuPool = memPool = 70_080_000. cpu denom 4000, mem denom 16e9.
  assert.equal(teamA?.allocatedMicros, "21900000"); // 17_520_000 cpu + 4_380_000 mem
  assert.equal(teamB?.allocatedMicros, "30660000"); // 17_520_000 cpu + 13_140_000 mem
  assert.equal(currency?.unallocatedMicros, "87600000"); // idle headroom
  assert.equal(currency?.unallocatedBasis, "idle-from-allocatable-capacity");
});

test("discloses unknown and unlabelled instance types and prices only known ones", () => {
  const snapshot = evidence(
    [workload("team-a", "api", [container("api", { cpuRequestMillicores: 500 })])],
    [
      node("n1", { instanceType: "m5.large" }),
      node("n2", { instanceType: "x9.mega" }),
      node("n3", { instanceType: null }),
    ],
  );
  const projection = projectKubernetesAllocationInput(snapshot);
  assert.equal(projection.costCatalogCoverage.nodesTotal, 3);
  assert.equal(projection.costCatalogCoverage.nodesPriced, 1);
  assert.equal(projection.costCatalogCoverage.nodesWithUnknownType, 1);
  assert.equal(projection.costCatalogCoverage.nodesMissingInstanceType, 1);
  assert.deepEqual(projection.costCatalogCoverage.unknownInstanceTypes, ["x9.mega"]);
  assert.equal(projection.costCatalogCoverage.monthlyCostMicros, "70080000");
  assert.equal(projection.clusterCosts?.[0]?.amountMicros, "70080000");
});

test("no nodes -> node cost is not derivable and no namespace figures are produced", () => {
  const snapshot = evidence([workload("team-a", "api", [container("api", { cpuRequestMillicores: 500 })])]);
  const projection = projectKubernetesAllocationInput(snapshot);
  assert.equal(projection.costCatalogCoverage.nodesTotal, 0);
  assert.equal(projection.costCatalogCoverage.costDerivable, false);
  assert.deepEqual(projection.clusterCosts, []);
  assert.deepEqual(projection.capacity, []);

  const report = buildKubernetesAllocation(buildKubernetesAllocationInput(projection));
  const cluster = report.clusters[0];
  assert.equal(cluster?.costAvailable, false);
  assert.equal(cluster?.unavailableReason, "node-cost-not-derivable");
  assert.deepEqual(cluster?.currencies, []);
});

test("nodes present but all unpriced -> still not derivable, capacity still surfaced", () => {
  const snapshot = evidence(
    [workload("team-a", "api", [container("api", { cpuRequestMillicores: 500 })])],
    [node("n1", { instanceType: "x9.mega", allocatableCpuMillicores: 4000 })],
  );
  const projection = projectKubernetesAllocationInput(snapshot);
  assert.equal(projection.costCatalogCoverage.costDerivable, false);
  assert.deepEqual(projection.clusterCosts, []);
  assert.equal(projection.capacity?.[0]?.cpuMillicores, 4000);

  const report = buildKubernetesAllocation(buildKubernetesAllocationInput(projection));
  assert.equal(report.clusters[0]?.costAvailable, false);
});

test("catalog is disclosed as USD micro-priced and internally positive", () => {
  for (const [type, micros] of Object.entries(NODE_MONTHLY_LIST_PRICE_USD_MICROS)) {
    assert.equal(Number.isSafeInteger(micros), true, `${type} must be an integer micro amount`);
    assert.equal(micros > 0, true, `${type} must be positive`);
  }
  assert.equal(NODE_MONTHLY_LIST_PRICE_USD_MICROS["m5.large"], 70_080_000);
});
