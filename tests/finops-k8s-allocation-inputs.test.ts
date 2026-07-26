import assert from "node:assert/strict";
import test from "node:test";
import { buildKubernetesAllocationInput } from "../lib/finops-k8s-allocation-inputs.ts";
import { buildKubernetesAllocation } from "../lib/finops-k8s-allocation.ts";
import type { NormalizedCurLine } from "../lib/finops-cur.ts";

const M = (whole: number): string => String(whole * 1_000_000);

function curLine(over: Partial<NormalizedCurLine> & { amountMicros: string; tags: Record<string, string> }): NormalizedCurLine {
  return {
    lineItemId: over.lineItemId ?? "l1",
    usageAccountId: over.usageAccountId ?? "123",
    service: over.service ?? "AmazonEC2",
    chargeCategory: over.chargeCategory ?? "Usage",
    usageStartIso: over.usageStartIso ?? "2026-07-01T00:00:00.000Z",
    amountMicros: over.amountMicros,
    currency: over.currency ?? "USD",
    region: over.region ?? null,
    amortizedMicros: over.amortizedMicros ?? null,
    commitmentType: over.commitmentType ?? null,
    commitmentId: over.commitmentId ?? null,
    commitmentExpiry: over.commitmentExpiry ?? null,
    usageType: over.usageType ?? null,
    usageAmountMicros: over.usageAmountMicros ?? null,
    usageUnit: over.usageUnit ?? null,
    tags: over.tags,
  };
}

test("buckets pod requests into namespaces and workloads, sums quantities", () => {
  const shaped = buildKubernetesAllocationInput({
    pods: [
      { clusterId: "c1", namespace: "team-a", workload: "api", cpuRequestMillicores: 100, memoryRequestBytes: 1000 },
      { clusterId: "c1", namespace: "team-a", workload: "api", cpuRequestMillicores: 100, memoryRequestBytes: 1000 },
      { clusterId: "c1", namespace: "team-a", workload: "worker", cpuRequestMillicores: 50, memoryRequestBytes: 500 },
      { clusterId: "c1", namespace: "team-b", workload: "web", cpuRequestMillicores: 250, memoryRequestBytes: 2500 },
    ],
    clusterCosts: [{ clusterId: "c1", currency: "USD", amountMicros: M(500) }],
  });
  const cluster = shaped.clusters[0];
  assert.equal(cluster.clusterId, "c1");
  const teamA = cluster.namespaces.find((n) => n.namespace === "team-a");
  assert.equal(teamA?.cpuRequestMillicores, 250); // 100+100+50
  assert.equal(teamA?.memoryRequestBytes, 2500); // 1000+1000+500
  assert.deepEqual(
    teamA?.workloads?.map((w) => [w.workload, w.cpuRequestMillicores]),
    [["api", 200], ["worker", 50]],
  );
  assert.deepEqual(cluster.nodeCostMicrosByCurrency, { USD: M(500) });

  // End-to-end weighting: team-a 250, team-b 250 => equal split of 500.
  const report = buildKubernetesAllocation(shaped);
  const usd = report.clusters[0].currencies[0];
  assert.equal(usd.namespaces.find((n) => n.namespace === "team-a")?.allocatedMicros, M(250));
  assert.equal(usd.namespaces.find((n) => n.namespace === "team-b")?.allocatedMicros, M(250));
});

test("derives per-cluster node cost from CUR compute lines by cluster tag", () => {
  const shaped = buildKubernetesAllocationInput({
    pods: [{ clusterId: "prod", namespace: "app", workload: "api", cpuRequestMillicores: 100, memoryRequestBytes: 100 }],
    curLines: [
      curLine({ amountMicros: M(120), tags: { "kubernetes.io/cluster": "prod" }, service: "AmazonEC2" }),
      curLine({ amountMicros: M(80), tags: { "kubernetes.io/cluster": "prod" }, service: "AmazonEKS" }),
      // Non-compute service (S3) is ignored.
      curLine({ amountMicros: M(999), tags: { "kubernetes.io/cluster": "prod" }, service: "AmazonS3" }),
      // Different cluster tag is bucketed separately (no requests => cost-only cluster).
      curLine({ amountMicros: M(50), tags: { "kubernetes.io/cluster": "dev" }, service: "AmazonEC2" }),
    ],
    curClusterTagKey: "kubernetes.io/cluster",
  });
  const prod = shaped.clusters.find((c) => c.clusterId === "prod");
  assert.deepEqual(prod?.nodeCostMicrosByCurrency, { USD: M(200) }); // 120 + 80, S3 excluded
  const dev = shaped.clusters.find((c) => c.clusterId === "dev");
  assert.deepEqual(dev?.nodeCostMicrosByCurrency, { USD: M(50) });
  assert.deepEqual(dev?.namespaces, []); // cost but no requests
});

test("cluster with pods but no cost maps to null (engine discloses not-derivable)", () => {
  const shaped = buildKubernetesAllocationInput({
    pods: [{ clusterId: "c1", namespace: "app", workload: "api", cpuRequestMillicores: 100, memoryRequestBytes: 100 }],
  });
  assert.equal(shaped.clusters[0].nodeCostMicrosByCurrency, null);
  const report = buildKubernetesAllocation(shaped);
  assert.equal(report.clusters[0].costAvailable, false);
  assert.equal(report.clusters[0].unavailableReason, "node-cost-not-derivable");
});

test("edge: a namespace whose pods carry no requests yields null request totals", () => {
  const shaped = buildKubernetesAllocationInput({
    pods: [
      { clusterId: "c1", namespace: "unset", workload: "job", cpuRequestMillicores: null, memoryRequestBytes: null },
      { clusterId: "c1", namespace: "sized", workload: "api", cpuRequestMillicores: 100, memoryRequestBytes: 200 },
    ],
    clusterCosts: [{ clusterId: "c1", currency: "USD", amountMicros: M(100) }],
  });
  const unset = shaped.clusters[0].namespaces.find((n) => n.namespace === "unset");
  assert.equal(unset?.cpuRequestMillicores, null);
  assert.equal(unset?.memoryRequestBytes, null);

  // The unset namespace gets zero allocation; the sized one absorbs the cost.
  const report = buildKubernetesAllocation(shaped);
  const usd = report.clusters[0].currencies[0];
  assert.equal(usd.namespaces.find((n) => n.namespace === "unset")?.allocatedMicros, "0");
  assert.equal(usd.namespaces.find((n) => n.namespace === "unset")?.zeroRequests, true);
  assert.equal(usd.namespaces.find((n) => n.namespace === "sized")?.allocatedMicros, M(100));
});

test("direct cluster cost wins over a CUR-derived value for the same currency", () => {
  const shaped = buildKubernetesAllocationInput({
    pods: [{ clusterId: "c1", namespace: "app", workload: "api", cpuRequestMillicores: 100, memoryRequestBytes: 100 }],
    clusterCosts: [{ clusterId: "c1", currency: "USD", amountMicros: M(300) }],
    curLines: [curLine({ amountMicros: M(999), tags: { cluster: "c1" }, service: "AmazonEC2" })],
    curClusterTagKey: "cluster",
  });
  assert.deepEqual(shaped.clusters[0].nodeCostMicrosByCurrency, { USD: M(300) });
});

test("multi-currency CUR lines for one cluster stay separate", () => {
  const shaped = buildKubernetesAllocationInput({
    pods: [{ clusterId: "c1", namespace: "app", workload: "api", cpuRequestMillicores: 100, memoryRequestBytes: 100 }],
    curLines: [
      curLine({ amountMicros: M(100), currency: "USD", tags: { cluster: "c1" } }),
      curLine({ amountMicros: M(40), currency: "EUR", tags: { cluster: "c1" } }),
    ],
    curClusterTagKey: "cluster",
  });
  assert.deepEqual(shaped.clusters[0].nodeCostMicrosByCurrency, { EUR: M(40), USD: M(100) });
});

test("capacity is passed through per cluster", () => {
  const shaped = buildKubernetesAllocationInput({
    pods: [{ clusterId: "c1", namespace: "app", workload: "api", cpuRequestMillicores: 100, memoryRequestBytes: 100 }],
    clusterCosts: [{ clusterId: "c1", currency: "USD", amountMicros: M(100) }],
    capacity: [{ clusterId: "c1", cpuMillicores: 400, memoryBytes: 400 }],
  });
  assert.deepEqual(shaped.clusters[0].capacity, { cpuMillicores: 400, memoryBytes: 400 });
});
