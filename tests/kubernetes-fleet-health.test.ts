import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKubernetesFleetHealth,
  type FleetAgentInput,
  type FleetClusterInput,
} from "../lib/kubernetes-fleet-health.ts";

function cluster(id: string, name: string, status: "active" | "disabled" = "active"): FleetClusterInput {
  return { id, name, distribution: "eks", version: "1.35", status };
}

function agent(overrides: Partial<FleetAgentInput> & { clusterId: string }): FleetAgentInput {
  return {
    agentId: `agent_${overrides.clusterId}`,
    state: "online",
    agentVersion: "0.2.0",
    modules: {},
    lastHeartbeatAt: "2026-07-18T00:00:00.000Z",
    lastScanAt: "2026-07-18T00:00:00.000Z",
    ...overrides,
  };
}

test("a cluster with no live agent is not_enrolled, never assumed healthy", () => {
  const summary = buildKubernetesFleetHealth({
    clusters: [cluster("kcluster_a", "alpha")],
    agents: [],
  });
  assert.equal(summary.schema, "sutra.kubernetes-fleet-health.v1");
  assert.equal(summary.clusters.length, 1);
  assert.equal(summary.clusters[0]?.state, "not_enrolled");
  assert.equal(summary.totals.notEnrolled, 1);
  assert.match(summary.disclaimer, /never assumed healthy/u);
});

test("a revoked-only cluster counts as not_enrolled, an all-offline cluster as offline", () => {
  const summary = buildKubernetesFleetHealth({
    clusters: [cluster("kcluster_a", "alpha"), cluster("kcluster_b", "bravo")],
    agents: [
      agent({ clusterId: "kcluster_a", state: "revoked" }),
      agent({ clusterId: "kcluster_b", state: "offline" }),
    ],
  });
  const alpha = summary.clusters.find((entry) => entry.clusterId === "kcluster_a");
  const bravo = summary.clusters.find((entry) => entry.clusterId === "kcluster_b");
  assert.equal(alpha?.state, "not_enrolled");
  assert.equal(alpha?.agentCount, 0);
  assert.equal(bravo?.state, "offline");
  assert.equal(bravo?.agentCount, 1);
});

test("a degraded module or a partially-offline agent set degrades the cluster", () => {
  const summary = buildKubernetesFleetHealth({
    clusters: [cluster("kcluster_a", "alpha"), cluster("kcluster_b", "bravo")],
    agents: [
      agent({ clusterId: "kcluster_a", modules: { trivy: "AVAILABLE", falco: "DEGRADED" } }),
      agent({ agentId: "agent_b1", clusterId: "kcluster_b", state: "online" }),
      agent({ agentId: "agent_b2", clusterId: "kcluster_b", state: "offline" }),
    ],
  });
  const alpha = summary.clusters.find((entry) => entry.clusterId === "kcluster_a");
  const bravo = summary.clusters.find((entry) => entry.clusterId === "kcluster_b");
  assert.equal(alpha?.state, "degraded", "a degraded module degrades the cluster");
  assert.equal(alpha?.modules.falco, "DEGRADED");
  assert.equal(bravo?.state, "degraded", "a partially-offline agent set degrades the cluster");
  assert.equal(summary.totals.degraded, 2);
});

test("module state is the worst across online agents; offline agents do not mask it", () => {
  const summary = buildKubernetesFleetHealth({
    clusters: [cluster("kcluster_a", "alpha")],
    agents: [
      agent({ agentId: "a1", clusterId: "kcluster_a", modules: { trivy: "AVAILABLE" } }),
      agent({ agentId: "a2", clusterId: "kcluster_a", modules: { trivy: "DEGRADED" } }),
      // An offline agent claiming AVAILABLE must not override the online DEGRADED.
      agent({ agentId: "a3", clusterId: "kcluster_a", state: "offline", modules: { trivy: "AVAILABLE" } }),
    ],
  });
  assert.equal(summary.clusters[0]?.modules.trivy, "DEGRADED");
});

test("a fully-online cluster with only available modules is online", () => {
  const summary = buildKubernetesFleetHealth({
    clusters: [cluster("kcluster_a", "alpha")],
    agents: [agent({ clusterId: "kcluster_a", modules: { trivy: "AVAILABLE", kyverno: "NOT_CONFIGURED" } })],
  });
  assert.equal(summary.clusters[0]?.state, "online");
  assert.equal(summary.totals.online, 1);
  assert.equal(summary.totals.onlineAgents, 1);
});

test("disabled clusters are excluded and results are name-sorted", () => {
  const summary = buildKubernetesFleetHealth({
    clusters: [
      cluster("kcluster_z", "zulu"),
      cluster("kcluster_a", "alpha"),
      cluster("kcluster_d", "delta", "disabled"),
    ],
    agents: [agent({ clusterId: "kcluster_z" }), agent({ clusterId: "kcluster_a" })],
  });
  assert.deepEqual(summary.clusters.map((entry) => entry.clusterName), ["alpha", "zulu"]);
  assert.equal(summary.totals.clusters, 2);
});

test("latest heartbeat and scan are taken across a cluster's agents", () => {
  const summary = buildKubernetesFleetHealth({
    clusters: [cluster("kcluster_a", "alpha")],
    agents: [
      agent({ agentId: "a1", clusterId: "kcluster_a", lastHeartbeatAt: "2026-07-18T00:00:00.000Z", lastScanAt: null }),
      agent({ agentId: "a2", clusterId: "kcluster_a", lastHeartbeatAt: "2026-07-18T03:00:00.000Z", lastScanAt: "2026-07-18T02:00:00.000Z" }),
    ],
  });
  assert.equal(summary.clusters[0]?.lastHeartbeatAt, "2026-07-18T03:00:00.000Z");
  assert.equal(summary.clusters[0]?.lastScanAt, "2026-07-18T02:00:00.000Z");
});
