import assert from "node:assert/strict";
import test from "node:test";
import { hubbleFlowsToPolicyInputs } from "../lib/networkpolicy-flow-inputs.ts";
import { buildNetworkPolicies } from "../lib/kubernetes-networkpolicy-generator.ts";
import type { NormalizedHubbleFlow } from "../lib/hubble-flow-evidence.ts";

function identity(over: Partial<NormalizedHubbleFlow["source"]> = {}): NormalizedHubbleFlow["source"] {
  return { namespace: "payments", workloadKind: "Deployment", workloadName: "frontend", serviceName: null, world: false, ...over };
}

function flow(over: Partial<NormalizedHubbleFlow> = {}): NormalizedHubbleFlow {
  return {
    observedAt: "2026-07-18T00:00:00.000Z",
    source: identity({ workloadName: "client" }),
    destination: identity({ workloadName: "frontend" }),
    direction: "ingress",
    verdict: "forwarded",
    protocol: "TCP",
    destinationPort: 8080,
    observations: 3,
    evidenceSha256: "a".repeat(64),
    ...over,
  };
}

test("a forwarded pod-to-pod flow becomes an ingress + egress policy flow and two workloads", () => {
  const { workloads, flows } = hubbleFlowsToPolicyInputs([flow()]);
  assert.equal(workloads.length, 2);
  assert.equal(flows.length, 2);
  assert.deepEqual(flows.map((f) => f.direction).sort(), ["egress", "ingress"]);
  assert.equal(flows[0].destPort, 8080);
  assert.equal(flows[0].protocol, "TCP");
});

test("dropped, ICMP, world-endpoint, and portless flows are excluded (nothing guessed)", () => {
  const inputs = hubbleFlowsToPolicyInputs([
    flow({ verdict: "dropped" }),
    flow({ protocol: "ICMP" }),
    flow({ destinationPort: null }),
    flow({ destination: identity({ world: true, namespace: null, workloadName: null }) }),
  ]);
  assert.equal(inputs.flows.length, 0);
  assert.equal(inputs.workloads.length, 0);
});

test("the adapter output drives the generator to a policy reproducing the observed peer+port", () => {
  const inputs = hubbleFlowsToPolicyInputs([flow({ source: identity({ workloadName: "client" }), destination: identity({ workloadName: "frontend" }), destinationPort: 8080 })]);
  const result = buildNetworkPolicies({ workloads: inputs.workloads, flows: inputs.flows });
  const frontend = result.policies.find((p) => p.workloadRef.name === "frontend");
  const client = result.policies.find((p) => p.workloadRef.name === "client");
  assert.ok(frontend !== undefined, "a policy is generated for the destination workload");
  assert.ok(frontend.policyYaml.includes("client"), "frontend's ingress admits the observed source peer");
  // The generator records ports on egress rules; the client's egress to frontend carries the port.
  assert.ok(client?.policyYaml.includes("8080"), "the observed port is in the source workload's egress rule");
  assert.equal(result.summary.flowsAttributed > 0, true);
});
