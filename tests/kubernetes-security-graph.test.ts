import assert from "node:assert/strict";
import test from "node:test";

import { buildSecurityGraphLayout } from "../lib/kubernetes-security-graph.ts";
import type {
  AttackGraphEdge,
  AttackGraphNode,
  KubernetesAttackPath,
} from "../lib/kubernetes-attack-paths.ts";

function node(key: string, kind: AttackGraphNode["kind"], label = key): AttackGraphNode {
  return { key, label, kind, resourceKey: null };
}

function edge(from: string, to: string, relation = "connects"): AttackGraphEdge {
  return {
    from,
    to,
    relation,
    evidence: {
      source: "relationship",
      sourceResourceKey: from,
      relationType: relation,
      fieldPath: null,
      observedValue: relation,
      observedAt: null,
      evidenceSha256: null,
    },
  };
}

function path(
  id: string,
  nodes: readonly AttackGraphNode[],
  edges: readonly AttackGraphEdge[],
): KubernetesAttackPath {
  return {
    id,
    type: "cloud_to_kubernetes",
    title: id,
    nodes,
    edges,
    findings: [],
    factors: [],
    score: 50,
    risk: "medium",
    blastRadius: [],
    observedFrom: null,
    observedTo: null,
    remediations: [],
  };
}

const internet = node("internet", "internet", "Internet");
const lb = node("lb-1", "load_balancer", "Ingress ALB");
const workload = node("wl-1", "kubernetes_workload", "payments/frontend");
const role = node("iam-1", "iam_role", "sutra-app-role");
const bucket = node("s3-1", "aws_resource", "customer-data-bucket");

test("layout layers strictly follow evidenced edges and stay deterministic", () => {
  const build = () => buildSecurityGraphLayout({
    paths: [
      path("p1", [internet, lb, workload], [edge("internet", "lb-1"), edge("lb-1", "wl-1")]),
      path("p2", [workload, role, bucket], [edge("wl-1", "iam-1"), edge("iam-1", "s3-1")]),
    ],
  });
  const layout = build();
  assert.equal(layout.nodes.length, 5);
  assert.equal(layout.edges.length, 4);
  assert.equal(layout.truncatedNodeCount, 0);
  const layerOf = new Map(layout.nodes.map((entry) => [entry.node.key, entry.layer]));
  for (const entry of layout.edges) {
    assert.equal(entry.isBackEdge, false, "an acyclic graph has no back-edges");
    assert.ok(
      (layerOf.get(entry.edge.from) ?? 0) < (layerOf.get(entry.edge.to) ?? 0),
      `${entry.edge.from} must be laid out before ${entry.edge.to}`,
    );
    assert.ok(entry.fromX < entry.toX, "forward edges must point forward in the drawing");
  }
  assert.deepEqual(build(), layout, "layout must be deterministic for identical input");
  assert.ok(layout.width > 0 && layout.height > 0);
});

test("shared nodes carry the membership of every path that cites them", () => {
  const layout = buildSecurityGraphLayout({
    paths: [
      path("p1", [internet, workload], [edge("internet", "wl-1")]),
      path("p2", [workload, bucket], [edge("wl-1", "s3-1")]),
    ],
  });
  const shared = layout.nodes.find((entry) => entry.node.key === "wl-1");
  assert.ok(shared !== undefined);
  assert.deepEqual([...shared.pathIds].sort(), ["p1", "p2"]);
  const first = layout.edges.find((entry) => entry.edge.from === "internet");
  assert.deepEqual(first?.pathIds, ["p1"]);
});

test("duplicate edges across paths are drawn once and cycles cannot hang the layout", () => {
  const cycleA = node("a", "kubernetes_workload");
  const cycleB = node("b", "service_account");
  const layout = buildSecurityGraphLayout({
    paths: [
      path("p1", [cycleA, cycleB], [edge("a", "b"), edge("b", "a")]),
      path("p2", [cycleA, cycleB], [edge("a", "b")]),
    ],
  });
  assert.equal(layout.edges.filter((entry) => entry.edge.from === "a" && entry.edge.to === "b").length, 1);
  assert.equal(layout.nodes.length, 2);
  // Exactly one of the two cyclic edges closes the cycle as a back-edge,
  // whichever way the deterministic layering orders the pair.
  const backEdges = layout.edges.filter((entry) => entry.isBackEdge);
  const forwardEdges = layout.edges.filter((entry) => !entry.isBackEdge);
  assert.equal(backEdges.length, 1, "a 2-cycle yields exactly one back-edge");
  assert.equal(forwardEdges.length, 1);
  assert.ok(forwardEdges[0].fromX < forwardEdges[0].toX, "the forward edge points forward");
  assert.ok(backEdges[0].fromX >= backEdges[0].toX, "the back-edge honestly points backward, never faking a forward hop");
});

test("nodes beyond the display cap are counted once per distinct key, and their edges are dropped", () => {
  // Build more than MAX_GRAPH_NODES (400) distinct nodes across single-node paths,
  // then reference a truncated node twice to prove distinct counting.
  const paths = []
  for (let i = 0; i < 405; i += 1) {
    const only = node(`n${i}`, "kubernetes_workload")
    paths.push(path(`p${i}`, [only], []))
  }
  // Two more paths both referencing the same over-cap node key and an edge to it.
  const over = node("n999", "aws_resource")
  const anchor = node("n0", "kubernetes_workload")
  paths.push(path("pa", [anchor, over], [edge("n0", "n999")]))
  paths.push(path("pb", [anchor, over], [edge("n0", "n999")]))
  const layout = buildSecurityGraphLayout({ paths })
  assert.ok(layout.nodes.length <= 400, "node display is bounded")
  assert.equal(layout.truncatedNodeCount, 6, "5 overflow single nodes + n999 counted once each")
  assert.equal(
    layout.edges.filter((entry) => entry.edge.to === "n999").length,
    0,
    "edges to a truncated node are dropped, never dangling",
  )
})

test("an empty projection produces an empty bounded layout", () => {
  const layout = buildSecurityGraphLayout({ paths: [] });
  assert.equal(layout.nodes.length, 0);
  assert.equal(layout.edges.length, 0);
});
