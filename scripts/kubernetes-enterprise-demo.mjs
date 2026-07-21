#!/usr/bin/env node
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("../tests/cloudflare-loader.mjs", import.meta.url));

const [
  { parseFalcoRuntimePayload },
  { normalizeKyvernoPolicyReport },
  { normalizeHubbleFlowBatch },
  { normalizeKubernetesSupplyChainEvidence },
] = await Promise.all([
  import("../lib/falco-runtime-boundary.ts"),
  import("../lib/kubernetes-admission.ts"),
  import("../lib/hubble-flow-evidence.ts"),
  import("../lib/kubernetes-supply-chain.ts"),
]);

const command = process.argv[2] ?? "validate";
if (!new Set(["generate", "validate"]).has(command) || process.argv.length > 3) {
  throw new Error("Usage: node scripts/kubernetes-enterprise-demo.mjs [generate|validate]");
}

const collectedAt = "2026-07-17T08:45:00.000Z";
const clusterId = `kcluster_${"d".repeat(48)}`;
const namespace = "payments";
const workload = "checkout-api";

const falcoRaw = {
  time: "2026-07-17T08:44:00.000Z",
  rule: "Terminal shell in container",
  priority: "Critical",
  source: "syscall",
  hostname: "ip-10-0-1-25.ap-south-1.compute.internal",
  output: "sensitive command line deliberately discarded",
  output_fields: {
    "k8s.ns.name": namespace,
    "k8s.pod.name": `${workload}-7d9f8c`,
    "k8s.pod.uid": "0df489b8-86b0-4ab2-8f38-852292e18f89",
    "container.id": "c".repeat(64),
    "container.name": workload,
    "container.image.repository": "505060607080.dkr.ecr.ap-south-1.amazonaws.com/checkout-api",
    "container.image.tag": "demo",
    "proc.name": "sh",
    "proc.exepath": "/bin/sh",
    "proc.pid": 3456,
    "proc.ppid": 3400,
    "user.name": "root",
    "user.uid": "0",
    "evt.type": "execve",
    "proc.cmdline": "must-not-survive",
    "container.env": "must-not-survive",
  },
};

const admissionRaw = {
  apiVersion: "wgpolicyk8s.io/v1alpha2",
  kind: "PolicyReport",
  metadata: { namespace, name: "sutra-demo-policy-report" },
  results: [{
    policy: "sutra-workload-security-audit",
    rule: "disallow-privilege-escalation",
    result: "fail",
    severity: "high",
    category: "Pod Security",
    source: "kyverno",
    timestamp: collectedAt,
    message: "sensitive raw message deliberately discarded",
    resources: [{
      apiVersion: "v1",
      kind: "Pod",
      namespace,
      name: `${workload}-7d9f8c`,
      uid: "0df489b8-86b0-4ab2-8f38-852292e18f89",
    }],
  }],
};

const networkRaw = {
  collectedAt,
  hubbleVersion: "1.19.5",
  flows: [
    {
      observedAt: "2026-07-17T08:43:00.000Z",
      source: {
        namespace, workloadKind: "Deployment", workloadName: workload,
        serviceName: workload, world: false,
      },
      destination: {
        namespace: null, workloadKind: null, workloadName: null, serviceName: null, world: true,
      },
      direction: "egress",
      verdict: "forwarded",
      protocol: "TCP",
      destinationPort: 443,
      observations: 17,
    },
    {
      observedAt: "2026-07-17T08:43:30.000Z",
      source: {
        namespace, workloadKind: "Deployment", workloadName: workload,
        serviceName: workload, world: false,
      },
      destination: {
        namespace: "data", workloadKind: "StatefulSet", workloadName: "postgres",
        serviceName: "postgres", world: false,
      },
      direction: "egress",
      verdict: "dropped",
      protocol: "TCP",
      destinationPort: 5432,
      observations: 4,
    },
  ],
};

const supplyChainRaw = {
  image: {
    repository: "505060607080.dkr.ecr.ap-south-1.amazonaws.com/checkout-api",
    digest: `sha256:${"a".repeat(64)}`,
    tag: "demo",
  },
  vulnerabilityScan: {
    scannerVersion: "0.69.3",
    scannedAt: "2026-07-17T08:40:00.000Z",
    critical: 1,
    high: 3,
    medium: 7,
    low: 2,
    unknown: 0,
    fixedAvailable: 9,
    rawResults: [{ package: "must-not-survive" }],
  },
  sbom: {
    format: "CycloneDX",
    componentCount: 111,
    documentSha256: "b".repeat(64),
    components: [{ name: "must-not-survive" }],
  },
  signature: {
    state: "verified",
    issuer: "https://token.actions.githubusercontent.com",
    subject: "https://github.com/example/sutra/.github/workflows/release.yml@refs/heads/main",
    transparencyLogVerified: true,
    certificate: "must-not-survive",
  },
  provenance: {
    state: "verified",
    builderId: "https://github.com/actions/runner",
    sourceRepository: "https://github.com/example/sutra",
    commitSha: "c".repeat(40),
    statement: "must-not-survive",
  },
};

async function scenario() {
  const runtime = parseFalcoRuntimePayload({
    clusterId,
    body: new TextEncoder().encode(JSON.stringify(falcoRaw)),
  });
  const [admission, network, supplyChain] = await Promise.all([
    normalizeKyvernoPolicyReport({
      clusterId,
      collectedAt,
      mode: "audit",
      report: admissionRaw,
    }),
    normalizeHubbleFlowBatch({ clusterId, value: networkRaw }),
    normalizeKubernetesSupplyChainEvidence({
      clusterId,
      collectedAt,
      evidence: supplyChainRaw,
    }),
  ]);
  return {
    schema: "sutra.kubernetes-enterprise-demo.v1",
    generatedAt: collectedAt,
    provenance: {
      mode: "deterministic-local-simulation",
      liveClusterEvidence: false,
      customerEvidence: false,
    },
    subject: { clusterId, namespace, workload },
    evidence: { runtime, admission, network, supplyChain },
    demoNarrative: [
      "Trivy identifies vulnerable packages on one immutable image digest.",
      "Syft-compatible CycloneDX evidence records the SBOM document hash and component count.",
      "Cosign identity and transparency-log verification bind the digest to the CI workflow.",
      "Kyverno audit evidence identifies a workload policy failure without blocking deployment.",
      "Hubble metadata shows external egress and a denied database connection without retaining payloads.",
      "Falco records a shell execution and discards command lines, environment variables and raw output.",
    ],
  };
}

function validate(value) {
  assert.equal(value.provenance.liveClusterEvidence, false);
  assert.equal(value.evidence.runtime.length, 1);
  assert.equal(value.evidence.runtime[0].priority, "critical");
  assert.equal(value.evidence.admission.mode, "audit");
  assert.equal(value.evidence.admission.summary.FAIL, 1);
  assert.equal(value.evidence.network.flows.length, 2);
  assert.equal(value.evidence.network.flows[1].verdict, "dropped");
  assert.equal(value.evidence.supplyChain.image.digest, supplyChainRaw.image.digest);
  assert.equal(value.evidence.supplyChain.signature.state, "verified");
  assert.equal(value.evidence.supplyChain.provenance.state, "verified");
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "must-not-survive",
    "sensitive command line",
    "sensitive raw message",
    "proc.cmdline",
    "container.env",
  ]) assert.equal(serialized.includes(forbidden), false);
  for (const hash of [
    value.evidence.runtime[0].evidenceSha256,
    value.evidence.admission.evidenceSha256,
    value.evidence.network.evidenceSha256,
    value.evidence.supplyChain.evidenceSha256,
  ]) assert.match(hash, /^[a-f0-9]{64}$/u);
}

const value = await scenario();
validate(value);
if (command === "generate") {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify({
    schema: "sutra.kubernetes-enterprise-demo-validation.v1",
    status: "passed",
    generatedAt: value.generatedAt,
    simulated: true,
    evidenceStreams: ["trivy-syft-cosign", "kyverno", "hubble", "falco"],
    checks: 14,
  }, null, 2)}\n`);
}
