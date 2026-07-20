import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKubernetesAllocation,
  type ClusterAllocationInput,
  type KubernetesAllocationInput,
} from "../lib/finops-k8s-allocation.ts";

const M = (whole: number): string => String(whole * 1_000_000);

function input(clusters: readonly ClusterAllocationInput[]): KubernetesAllocationInput {
  return { clusters };
}

function ns(
  namespace: string,
  cpu: number | null,
  memory: number | null,
): { namespace: string; cpuRequestMillicores: number | null; memoryRequestBytes: number | null } {
  return { namespace, cpuRequestMillicores: cpu, memoryRequestBytes: memory };
}

test("splits two namespaces by their summed requests (cpu-memory blend)", () => {
  // Equal cpu and memory shares (a=3:1, b=1:1 balanced) so the 50/50 blend gives
  // namespace a 3/4 and namespace b 1/4 of the cost. No capacity => idle not measured.
  const report = buildKubernetesAllocation(
    input([
      {
        clusterId: "c1",
        nodeCostMicrosByCurrency: { USD: M(400) },
        namespaces: [ns("a", 300, 300), ns("b", 100, 100)],
      },
    ]),
  );
  const cluster = report.clusters[0];
  assert.equal(cluster.costAvailable, true);
  assert.equal(cluster.basis, "cpu-memory-blend");
  const usd = cluster.currencies[0];
  assert.equal(usd.currency, "USD");
  const [a, b] = usd.namespaces;
  assert.equal(a.namespace, "a");
  assert.equal(a.allocatedMicros, M(300));
  assert.equal(b.allocatedMicros, M(100));
  // Full cost spread over requests => remainder 0, disclosed as not-measured.
  assert.equal(usd.allocatedMicros, M(400));
  assert.equal(usd.unallocatedMicros, "0");
  assert.equal(usd.unallocatedBasis, "capacity-not-collected-idle-not-measured");
});

test("memory absent falls back to cpu-only basis and discloses it", () => {
  const report = buildKubernetesAllocation(
    input([
      {
        clusterId: "c1",
        nodeCostMicrosByCurrency: { USD: M(300) },
        namespaces: [ns("a", 200, null), ns("b", 100, null)],
      },
    ]),
  );
  const cluster = report.clusters[0];
  assert.equal(cluster.basis, "cpu-only");
  assert.ok(cluster.basisReason.includes("CPU_ONLY"));
  assert.equal(cluster.totalMemoryRequestBytes, null);
  const [a, b] = cluster.currencies[0].namespaces;
  assert.equal(a.allocatedMicros, M(200));
  assert.equal(b.allocatedMicros, M(100));
});

test("partial memory (some namespaces missing it) still uses cpu-only for consistency", () => {
  const report = buildKubernetesAllocation(
    input([
      {
        clusterId: "c1",
        nodeCostMicrosByCurrency: { USD: M(300) },
        namespaces: [ns("a", 200, 500), ns("b", 100, null)],
      },
    ]),
  );
  const cluster = report.clusters[0];
  assert.equal(cluster.basis, "cpu-only");
  assert.ok(cluster.basisReason.includes("PARTIALLY"));
});

test("node-cost-not-derivable => null cost, no fabricated namespace figures", () => {
  const report = buildKubernetesAllocation(
    input([
      {
        clusterId: "c1",
        nodeCostMicrosByCurrency: null,
        namespaces: [ns("a", 200, 400), ns("b", 100, 200)],
      },
    ]),
  );
  const cluster = report.clusters[0];
  assert.equal(cluster.costAvailable, false);
  assert.equal(cluster.unavailableReason, "node-cost-not-derivable");
  assert.deepEqual(cluster.currencies, []);
  // Observed request totals are still surfaced (real inputs, not fabricated cost).
  assert.equal(cluster.totalCpuRequestMillicores, 300);
  assert.equal(cluster.totalMemoryRequestBytes, 600);
});

test("empty cost map is treated as not-derivable", () => {
  const report = buildKubernetesAllocation(
    input([{ clusterId: "c1", nodeCostMicrosByCurrency: {}, namespaces: [ns("a", 100, 100)] }]),
  );
  assert.equal(report.clusters[0].costAvailable, false);
  assert.equal(report.clusters[0].unavailableReason, "node-cost-not-derivable");
});

test("idle/unallocated remainder is correct when allocatable capacity is supplied", () => {
  // Requests total 400 millicores cpu / 400 bytes mem, capacity is double that,
  // so exactly half the cost is genuine idle headroom.
  const report = buildKubernetesAllocation(
    input([
      {
        clusterId: "c1",
        nodeCostMicrosByCurrency: { USD: M(1000) },
        namespaces: [ns("a", 300, 300), ns("b", 100, 100)],
        capacity: { cpuMillicores: 800, memoryBytes: 800 },
      },
    ]),
  );
  const usd = report.clusters[0].currencies[0];
  // cpu pool 500 over capacity 800: a=300/800*500=187.5->187_500_000, b=100/800*500=62.5->62_500_000
  // mem pool 500 over capacity 800: same again. a total 375, b total 125 -> allocated 500.
  assert.equal(usd.namespaces[0].allocatedMicros, M(375));
  assert.equal(usd.namespaces[1].allocatedMicros, M(125));
  assert.equal(usd.allocatedMicros, M(500));
  assert.equal(usd.unallocatedMicros, M(500));
  assert.equal(usd.unallocatedBasis, "idle-from-allocatable-capacity");
  // Invariant: unallocated == clusterCost - allocated.
  assert.equal(
    BigInt(usd.unallocatedMicros),
    BigInt(usd.clusterCostMicros) - BigInt(usd.allocatedMicros),
  );
});

test("over-committed cluster (requests exceed capacity) reports zero idle, disclosed", () => {
  const report = buildKubernetesAllocation(
    input([
      {
        clusterId: "c1",
        nodeCostMicrosByCurrency: { USD: M(400) },
        namespaces: [ns("a", 300, 300), ns("b", 100, 100)],
        capacity: { cpuMillicores: 200, memoryBytes: 200 },
      },
    ]),
  );
  const usd = report.clusters[0].currencies[0];
  assert.equal(usd.unallocatedMicros, "0");
  assert.equal(usd.unallocatedBasis, "over-committed-no-idle");
  assert.equal(usd.allocatedMicros, M(400));
});

test("zero-request namespaces get zero allocation and are labelled", () => {
  const report = buildKubernetesAllocation(
    input([
      {
        clusterId: "c1",
        nodeCostMicrosByCurrency: { USD: M(100) },
        namespaces: [ns("busy", 100, 100), ns("idle", 0, 0)],
      },
    ]),
  );
  const usd = report.clusters[0].currencies[0];
  const idle = usd.namespaces.find((n) => n.namespace === "idle");
  assert.ok(idle !== undefined);
  assert.equal(idle.allocatedMicros, "0");
  assert.equal(idle.zeroRequests, true);
  assert.equal(usd.namespaces.find((n) => n.namespace === "busy")?.allocatedMicros, M(100));
});

test("currencies are isolated, never summed", () => {
  const report = buildKubernetesAllocation(
    input([
      {
        clusterId: "c1",
        nodeCostMicrosByCurrency: { USD: M(200), EUR: M(80) },
        namespaces: [ns("a", 100, 100), ns("b", 100, 100)],
      },
    ]),
  );
  const cluster = report.clusters[0];
  assert.deepEqual(cluster.currencies.map((c) => c.currency), ["EUR", "USD"]);
  const eur = cluster.currencies.find((c) => c.currency === "EUR");
  const usd = cluster.currencies.find((c) => c.currency === "USD");
  assert.equal(eur?.namespaces[0].allocatedMicros, M(40));
  assert.equal(usd?.namespaces[0].allocatedMicros, M(100));
});

test("empty input yields an honest empty report", () => {
  const report = buildKubernetesAllocation(input([]));
  assert.equal(report.schema, "sutra.finops-k8s-allocation.v1");
  assert.deepEqual(report.clusters, []);
  assert.equal(report.generatedAt, null);
  assert.ok(report.limitations.length > 0);
  assert.ok(report.disclaimer.length > 0);
});

test("cluster with no requests at all leaves the whole cost unallocated", () => {
  const report = buildKubernetesAllocation(
    input([{ clusterId: "c1", nodeCostMicrosByCurrency: { USD: M(500) }, namespaces: [] }]),
  );
  const cluster = report.clusters[0];
  assert.equal(cluster.basis, null);
  assert.ok(cluster.basisReason.includes("NO_NAMESPACE_REQUESTS"));
  const usd = cluster.currencies[0];
  assert.equal(usd.allocatedMicros, "0");
  assert.equal(usd.unallocatedMicros, M(500));
});

test("workload sub-allocation reconciles to the namespace total", () => {
  const report = buildKubernetesAllocation(
    input([
      {
        clusterId: "c1",
        nodeCostMicrosByCurrency: { USD: M(400) },
        namespaces: [
          {
            namespace: "a",
            cpuRequestMillicores: 300,
            memoryRequestBytes: 300,
            workloads: [
              { workload: "api", cpuRequestMillicores: 200, memoryRequestBytes: 200 },
              { workload: "worker", cpuRequestMillicores: 100, memoryRequestBytes: 100 },
            ],
          },
          ns("b", 100, 100),
        ],
      },
    ]),
    { includeWorkloads: true },
  );
  const nsA = report.clusters[0].currencies[0].namespaces.find((n) => n.namespace === "a");
  assert.ok(nsA?.workloads !== null && nsA?.workloads !== undefined);
  const sumWorkloads = (nsA.workloads ?? []).reduce((acc, wl) => acc + BigInt(wl.allocatedMicros), BigInt(0));
  assert.equal(sumWorkloads.toString(), nsA.allocatedMicros);
});

test("injected clock stamps generatedAt; absence keeps it null and pure", () => {
  const withClock = buildKubernetesAllocation(input([]), { now: () => new Date("2027-01-15T00:00:00.000Z") });
  assert.equal(withClock.generatedAt, "2027-01-15T00:00:00.000Z");
  const without = buildKubernetesAllocation(input([]));
  assert.equal(without.generatedAt, null);
});

test("is deterministic and cluster-id ordered", () => {
  const clusters: readonly ClusterAllocationInput[] = [
    { clusterId: "z", nodeCostMicrosByCurrency: { USD: M(100) }, namespaces: [ns("a", 100, 100)] },
    { clusterId: "a", nodeCostMicrosByCurrency: { USD: M(100) }, namespaces: [ns("a", 100, 100)] },
  ];
  const first = buildKubernetesAllocation(input(clusters));
  const second = buildKubernetesAllocation(input(clusters));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first.clusters.map((c) => c.clusterId), ["a", "z"]);
});
