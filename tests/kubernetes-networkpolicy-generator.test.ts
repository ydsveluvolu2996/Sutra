import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNetworkPolicies,
  type NetworkPolicyFlow,
  type NetworkPolicyWorkload,
} from "../lib/kubernetes-networkpolicy-generator.ts";

function workload(over: Partial<NetworkPolicyWorkload> = {}): NetworkPolicyWorkload {
  return { namespace: "payments", name: "frontend", labels: { app: "frontend" }, ...over };
}

function ingressFlow(over: Partial<NetworkPolicyFlow> = {}): NetworkPolicyFlow {
  return {
    source: { namespace: "payments", name: "client", labels: { app: "client" } },
    dest: { namespace: "payments", name: "frontend", labels: { app: "frontend" } },
    destPort: 8080,
    protocol: "TCP",
    direction: "ingress",
    verdict: "forwarded",
    ...over,
  };
}

function egressFlow(over: Partial<NetworkPolicyFlow> = {}): NetworkPolicyFlow {
  return {
    source: { namespace: "payments", name: "frontend", labels: { app: "frontend" } },
    dest: { namespace: "payments", name: "backend", labels: { app: "backend" } },
    destPort: 8080,
    protocol: "TCP",
    direction: "egress",
    verdict: "forwarded",
    ...over,
  };
}

const NOTE_MARKERS = [
  /collection window/u,
  /may be INCOMPLETE/u,
  /FLOW_ABSENCE_MAY_REFLECT_SAMPLING_OR_COVERAGE/u,
  /Review before applying/u,
];

test("an observed ingress flow becomes an ingress rule from that peer; unobserved egress denies egress", () => {
  const result = buildNetworkPolicies({ workloads: [workload()], flows: [ingressFlow()] });
  assert.equal(result.policies.length, 1);
  const policy = result.policies[0];
  assert.deepEqual(policy?.workloadRef, { namespace: "payments", name: "frontend" });
  assert.equal(policy?.observedPeers, 1);

  const yaml = policy?.policyYaml ?? "";
  // podSelector is the workload's own labels.
  assert.match(yaml, /podSelector:\n {4}matchLabels:\n {6}"app": "frontend"/u);
  // ingress from the observed source peer, selected by namespace + its labels.
  assert.match(yaml, /ingress:\n {4}- from:/u);
  assert.match(yaml, /"kubernetes\.io\/metadata\.name": "payments"/u);
  assert.match(yaml, /podSelector:\n {12}matchLabels:\n {14}"app": "client"/u);
  // No egress was observed -> egress is empty and both policyTypes are set (deny egress).
  assert.match(yaml, /policyTypes:\n {4}- Ingress\n {4}- Egress/u);
  assert.match(yaml, /egress: \[\]/u);
  assert.equal(result.summary.flowsAttributed, 1);
});

test("observed egress flows become egress rules and aggregate + dedupe destination ports", () => {
  const result = buildNetworkPolicies({
    workloads: [workload()],
    flows: [
      egressFlow({ destPort: 8080, protocol: "TCP" }),
      egressFlow({ destPort: 8080, protocol: "TCP" }), // duplicate: must collapse
      egressFlow({ destPort: 5432, protocol: "TCP" }),
      egressFlow({ destPort: 53, protocol: "UDP" }),
    ],
  });
  const yaml = result.policies[0]?.policyYaml ?? "";
  assert.match(yaml, /egress:\n {4}- to:/u);
  assert.match(yaml, /"app": "backend"/u);
  // Ports are aggregated under a single peer, sorted by port, and deduped.
  assert.equal((yaml.match(/port: 8080/gu) ?? []).length, 1);
  assert.ok(yaml.indexOf("port: 53") < yaml.indexOf("port: 5432"));
  assert.ok(yaml.indexOf("port: 5432") < yaml.indexOf("port: 8080"));
  assert.match(yaml, /- protocol: UDP\n {10}port: 53/u);
  // Only egress observed -> ingress denied.
  assert.match(yaml, /ingress: \[\]/u);
  assert.equal(result.policies[0]?.observedPeers, 1);
});

test("a workload with zero observed flows yields a default-deny policy WITH the incompleteness note", () => {
  const result = buildNetworkPolicies({ workloads: [workload({ name: "orphan" })], flows: [] });
  assert.equal(result.policies.length, 1);
  const policy = result.policies[0];
  assert.equal(policy?.observedPeers, 0);

  const yaml = policy?.policyYaml ?? "";
  assert.match(yaml, /ingress: \[\]/u);
  assert.match(yaml, /egress: \[\]/u);
  assert.match(yaml, /policyTypes:\n {4}- Ingress\n {4}- Egress/u);

  // The workload is NOT dropped silently; its note explains the default-deny and incompleteness.
  assert.match(policy?.note ?? "", /No flows were observed/u);
  for (const marker of NOTE_MARKERS) assert.match(policy?.note ?? "", marker);
  assert.equal(result.summary.defaultDeny, 1);
  assert.equal(result.summary.withObservedPeers, 0);
});

test("the incompleteness note is present on EVERY policy (peered and default-deny alike)", () => {
  const result = buildNetworkPolicies({
    workloads: [workload({ name: "frontend" }), workload({ name: "idle" })],
    flows: [ingressFlow(), egressFlow()],
  });
  assert.equal(result.policies.length, 2);
  for (const policy of result.policies) {
    for (const marker of NOTE_MARKERS) assert.match(policy.note, marker);
  }
});

test("empty input produces no policies and no false findings", () => {
  const result = buildNetworkPolicies({ workloads: [], flows: [] });
  assert.deepEqual(result.policies, []);
  assert.deepEqual(result.summary, {
    workloads: 0,
    policies: 0,
    defaultDeny: 0,
    withObservedPeers: 0,
    flowsConsidered: 0,
    flowsAttributed: 0,
    peersWithoutLabels: 0,
    tenant: null,
  });
  assert.ok(result.limitations.includes("FLOW_ABSENCE_MAY_REFLECT_SAMPLING_OR_COVERAGE"));
  assert.match(result.disclaimer, /operator-validated suggestions/u);
});

test("a peer observed without labels is namespace-scoped, never given a synthesized podSelector", () => {
  const result = buildNetworkPolicies({
    workloads: [workload()],
    flows: [ingressFlow({ source: { namespace: "monitoring", name: "prometheus" } })],
  });
  const yaml = result.policies[0]?.policyYaml ?? "";
  // The peer is still included (we observed its flow) but by namespace only.
  assert.match(yaml, /"kubernetes\.io\/metadata\.name": "monitoring"/u);
  assert.match(yaml, /# pod labels not observed for monitoring\/prometheus/u);
  // No podSelector matchLabels was invented for that unlabeled peer.
  assert.doesNotMatch(yaml, /"app": "prometheus"/u);
  assert.equal(result.summary.peersWithoutLabels, 1);
  assert.match(result.policies[0]?.note ?? "", /namespace-scoped/u);
});

test("flows for workloads that were not supplied never invent a policy or a peer", () => {
  const result = buildNetworkPolicies({
    workloads: [workload({ name: "frontend" })],
    flows: [
      // egress whose SOURCE is an unknown workload: contributes to nothing.
      egressFlow({ source: { namespace: "payments", name: "ghost", labels: { app: "ghost" } } }),
      // ingress whose DEST is an unknown workload: contributes to nothing.
      ingressFlow({ dest: { namespace: "payments", name: "ghost", labels: { app: "ghost" } } }),
    ],
  });
  assert.equal(result.policies.length, 1);
  assert.equal(result.policies[0]?.workloadRef.name, "frontend");
  // frontend was never a subject in these flows -> default-deny, no invented peers.
  assert.equal(result.policies[0]?.observedPeers, 0);
  assert.equal(result.summary.flowsAttributed, 0);
  assert.equal(result.summary.flowsConsidered, 2);
});

test("dropped verdicts, non-TCP/UDP protocols, and out-of-range egress ports are not attributed", () => {
  const result = buildNetworkPolicies({
    workloads: [workload()],
    flows: [
      { ...ingressFlow(), verdict: "dropped" } as unknown as NetworkPolicyFlow,
      { ...egressFlow(), protocol: "ICMP" } as unknown as NetworkPolicyFlow,
      egressFlow({ destPort: 70_000 }),
      egressFlow({ destPort: 0 }),
    ],
  });
  const policy = result.policies[0];
  assert.equal(policy?.observedPeers, 0);
  assert.equal(result.summary.flowsAttributed, 0);
  assert.match(policy?.policyYaml ?? "", /ingress: \[\]/u);
  assert.match(policy?.policyYaml ?? "", /egress: \[\]/u);
});

test("the same peer seen on ingress and egress counts once; ports still land on egress", () => {
  const result = buildNetworkPolicies({
    workloads: [workload()],
    flows: [
      ingressFlow({ source: { namespace: "payments", name: "backend", labels: { app: "backend" } } }),
      egressFlow({ dest: { namespace: "payments", name: "backend", labels: { app: "backend" } }, destPort: 9090 }),
    ],
  });
  const policy = result.policies[0];
  assert.equal(policy?.observedPeers, 1);
  const yaml = policy?.policyYaml ?? "";
  assert.match(yaml, /ingress:\n {4}- from:/u);
  assert.match(yaml, /egress:\n {4}- to:/u);
  assert.match(yaml, /port: 9090/u);
});

test("a workload with no labels selects its whole namespace via an empty podSelector", () => {
  const result = buildNetworkPolicies({ workloads: [workload({ labels: {} })], flows: [] });
  assert.match(result.policies[0]?.policyYaml ?? "", /spec:\n {2}podSelector: \{\}/u);
});

test("tenant scope is echoed honestly: passed through when given, null when absent", () => {
  const withTenant = buildNetworkPolicies({ workloads: [workload()], flows: [ingressFlow()], tenant: "acme-msp" });
  assert.equal(withTenant.summary.tenant, "acme-msp");
  const without = buildNetworkPolicies({ workloads: [workload()], flows: [ingressFlow()] });
  assert.equal(without.summary.tenant, null);
});

test("output is deterministic and workloads are emitted in a stable order", () => {
  const build = () =>
    buildNetworkPolicies({
      workloads: [workload({ name: "zeta" }), workload({ name: "alpha" }), workload({ namespace: "auth", name: "alpha" })],
      flows: [
        egressFlow({ source: { namespace: "payments", name: "zeta", labels: { app: "zeta" } }, dest: { namespace: "payments", name: "db", labels: { app: "db" } }, destPort: 5432 }),
        ingressFlow({ dest: { namespace: "payments", name: "alpha", labels: { app: "alpha" } } }),
      ],
    });
  const result = build();
  assert.deepEqual(
    result.policies.map((p) => `${p.workloadRef.namespace}/${p.workloadRef.name}`),
    ["auth/alpha", "payments/alpha", "payments/zeta"],
  );
  assert.deepEqual(build(), result);
});

test("duplicate workload entries collapse to a single policy", () => {
  const result = buildNetworkPolicies({ workloads: [workload(), workload()], flows: [ingressFlow()] });
  assert.equal(result.policies.length, 1);
  assert.equal(result.summary.workloads, 1);
});
