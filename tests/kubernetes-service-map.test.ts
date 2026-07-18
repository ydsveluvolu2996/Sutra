import assert from "node:assert/strict";
import test from "node:test";
import { buildServiceMap } from "../lib/kubernetes-service-map.ts";
import type { NormalizedHubbleFlow, HubbleEndpointIdentity } from "../lib/hubble-flow-evidence.ts";

function endpoint(over: Partial<HubbleEndpointIdentity> = {}): HubbleEndpointIdentity {
  return { namespace: null, workloadKind: null, workloadName: null, serviceName: null, world: false, ...over };
}

function flow(over: Partial<NormalizedHubbleFlow> = {}): NormalizedHubbleFlow {
  return {
    observedAt: "2026-07-18T00:00:00.000Z",
    source: endpoint({ namespace: "payments", workloadName: "api", workloadKind: "Deployment" }),
    destination: endpoint({ namespace: "payments", workloadName: "db", workloadKind: "StatefulSet" }),
    direction: "egress",
    verdict: "forwarded",
    protocol: "TCP",
    destinationPort: 5432,
    observations: 3,
    evidenceSha256: "a".repeat(64),
    ...over,
  };
}

test("aggregates flows into deterministic nodes and edges", () => {
  const map = buildServiceMap({ flows: [
    flow(),
    flow({ observations: 2, destinationPort: 5432 }), // same edge, same port → merged, obs summed
    flow({ destinationPort: 6379, protocol: "TCP", destination: endpoint({ namespace: "payments", workloadName: "cache", workloadKind: "Deployment" }) }),
  ] });
  assert.equal(map.schema, "sutra.kubernetes-service-map.v1");
  assert.equal(map.summary.nodes, 3); // api, db, cache
  assert.equal(map.summary.edges, 2); // api->db, api->cache
  const apiToDb = map.edges.find((edge) => edge.source === "payments/api" && edge.destination === "payments/db");
  assert.equal(apiToDb?.observations, 5); // 3 + 2 merged
  assert.equal(apiToDb?.ports.length, 1);
  assert.equal(apiToDb?.ports[0]?.port, 5432);
});

test("flags cross-namespace and external edges and counts drops", () => {
  const map = buildServiceMap({ flows: [
    flow({ destination: endpoint({ namespace: "billing", workloadName: "ledger", workloadKind: "Deployment" }) }), // cross-ns
    flow({ verdict: "dropped", observations: 4, destination: endpoint({ world: true }) }), // external + dropped
  ] });
  const crossNs = map.edges.find((edge) => edge.destination === "billing/ledger");
  assert.equal(crossNs?.crossNamespace, true);
  assert.equal(crossNs?.involvesExternal, false);
  const external = map.edges.find((edge) => edge.destination === "world");
  assert.equal(external?.involvesExternal, true);
  assert.equal(external?.crossNamespace, true);
  assert.equal(external?.dropped, 4);
  assert.equal(map.summary.externalEdges, 1);
  assert.equal(map.summary.crossNamespaceEdges, 2);
  assert.equal(map.summary.droppedObservations, 4);
  assert.ok(map.nodes.some((node) => node.kind === "external"));
});

test("collapses conflicting directions to unknown; keeps a single agreed direction", () => {
  const agreed = buildServiceMap({ flows: [flow({ direction: "egress" }), flow({ direction: "egress", observations: 1 })] });
  assert.equal(agreed.edges[0]?.direction, "egress");
  const conflicting = buildServiceMap({ flows: [flow({ direction: "egress" }), flow({ direction: "ingress", observations: 1 })] });
  assert.equal(conflicting.edges[0]?.direction, "unknown");
});

test("empty flows yield an empty, honest map (no synthesized connectivity)", () => {
  const map = buildServiceMap({ flows: [] });
  assert.deepEqual(map.nodes, []);
  assert.deepEqual(map.edges, []);
  assert.ok(map.limitations.includes("FLOW_ABSENCE_MAY_REFLECT_SAMPLING_OR_COVERAGE"));
});

test("is deterministic regardless of flow order", () => {
  const flows = [
    flow({ destination: endpoint({ namespace: "payments", workloadName: "z", workloadKind: "Deployment" }) }),
    flow({ destination: endpoint({ namespace: "payments", workloadName: "a", workloadKind: "Deployment" }) }),
  ];
  const forward = buildServiceMap({ flows });
  const reversed = buildServiceMap({ flows: [...flows].reverse() });
  assert.equal(JSON.stringify(forward), JSON.stringify(reversed));
});
