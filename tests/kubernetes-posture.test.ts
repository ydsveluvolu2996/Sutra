import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateKubernetesPosture,
  KubernetesEvidenceError,
  normalizeKubernetesEvidence,
} from "../lib/kubernetes-posture.ts";

const collectedAt = "2026-07-17T12:00:00.000Z";

function secureContainer(overrides: Record<string, unknown> = {}) {
  return {
    name: "api",
    image: `registry.example/sutra/api@sha256:${"a".repeat(64)}`,
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

function snapshot(resources: unknown[], observedKinds = [
  "Workload", "Service", "Ingress", "RbacRole", "Namespace", "NetworkPolicy",
]) {
  return normalizeKubernetesEvidence({
    clusterId: "cluster_prod_01",
    collectedAt,
    observedKinds,
    resources,
  });
}

function secureResources() {
  return [
    {
      kind: "Namespace", name: "payments",
      podSecurityEnforce: "restricted", podSecurityWarn: "restricted", podSecurityAudit: "restricted",
    },
    {
      kind: "Workload", workloadKind: "Deployment", namespace: "payments", name: "api",
      hostNetwork: false, hostPid: false, hostIpc: false, hasHostPath: false,
      runAsNonRoot: true, seccompProfile: "RuntimeDefault",
      containers: [secureContainer()],
    },
    {
      kind: "Service", namespace: "payments", name: "api",
      serviceType: "ClusterIP", externalAddressCount: 0,
    },
    {
      kind: "Ingress", namespace: "payments", name: "api",
      ruleHosts: ["api.example.com"], tlsHosts: ["api.example.com"],
    },
    {
      kind: "RbacRole", namespace: "payments", name: "reader", clusterScoped: false,
      rules: [{ verbs: ["get", "list"], apiGroups: [""], resources: ["pods"] }],
    },
    { kind: "NetworkPolicy", namespace: "payments", name: "default-deny", coversAllPods: true },
  ];
}

test("normalizes a safe allowlist deterministically and produces passing posture", () => {
  const first = snapshot(secureResources());
  const second = snapshot([...secureResources()].reverse());
  assert.deepEqual(first, second);
  const report = evaluateKubernetesPosture(first);
  assert.equal(report.summary.FAIL, 0);
  assert.equal(report.summary.UNKNOWN, 0);
  assert.equal(report.summary.PASS, 17);
  assert.match(report.disclaimer, /never reads Secret data/u);
  assert.match(report.disclaimer, /does not .* CVE/u);
  assert.deepEqual(
    report.results.map((item) => `${item.controlId}:${item.subject}`),
    [...report.results.map((item) => `${item.controlId}:${item.subject}`)].sort(),
  );
});

test("detects workload privilege, host access, mutable images, missing resources and probes", () => {
  const report = evaluateKubernetesPosture(snapshot([
    {
      kind: "Workload", workloadKind: "DaemonSet", namespace: "system", name: "agent",
      hostNetwork: true, hostPid: true, hostIpc: false, hasHostPath: true,
      runAsNonRoot: false, seccompProfile: "Unconfined",
      containers: [secureContainer({
        image: "registry.example/agent:latest",
        privileged: true,
        allowPrivilegeEscalation: true,
        runAsNonRoot: false,
        capabilitiesAdd: ["SYS_ADMIN"],
        capabilitiesDrop: [],
        hasCpuRequest: false,
        hasMemoryRequest: false,
        hasCpuLimit: false,
        hasMemoryLimit: false,
        hasLivenessProbe: false,
        hasReadinessProbe: false,
      })],
    },
  ], ["Workload"]));
  const workloadResults = report.results.filter((item) => item.subject === "Workload/system/agent");
  assert.equal(workloadResults.length, 11);
  assert.ok(workloadResults.every((item) => item.state === "FAIL"));
});

test("detects externally exposed services, incomplete ingress TLS and RBAC escalation", () => {
  const report = evaluateKubernetesPosture(snapshot([
    {
      kind: "Service", namespace: "payments", name: "admin",
      serviceType: "LoadBalancer", externalAddressCount: 1,
    },
    {
      kind: "Ingress", namespace: "payments", name: "public",
      ruleHosts: ["a.example.com", "b.example.com"], tlsHosts: ["a.example.com"],
    },
    {
      kind: "RbacRole", namespace: null, name: "danger", clusterScoped: true,
      rules: [{ verbs: ["*", "bind"], apiGroups: ["*"], resources: ["*"] }],
    },
  ], ["Service", "Ingress", "RbacRole"]));
  for (const controlId of [
    "K8S-SERVICE-EXPOSURE", "K8S-INGRESS-TLS", "K8S-RBAC-WILDCARDS", "K8S-RBAC-ESCALATION",
  ]) {
    assert.equal(report.results.find((item) => item.controlId === controlId)?.state, "FAIL");
  }
});

test("evaluates Pod Security labels and NetworkPolicy coverage per namespace", () => {
  const report = evaluateKubernetesPosture(snapshot([
    {
      kind: "Namespace", name: "covered",
      podSecurityEnforce: "restricted", podSecurityWarn: null, podSecurityAudit: null,
    },
    {
      kind: "Namespace", name: "open",
      podSecurityEnforce: "baseline", podSecurityWarn: null, podSecurityAudit: null,
    },
    { kind: "NetworkPolicy", namespace: "covered", name: "default-deny", coversAllPods: true },
  ], ["Namespace", "NetworkPolicy"]));
  assert.equal(report.results.find((item) => item.subject === "Namespace/covered" &&
    item.controlId === "K8S-NAMESPACE-NETWORK-POLICY")?.state, "PASS");
  assert.equal(report.results.find((item) => item.subject === "Namespace/open" &&
    item.controlId === "K8S-NAMESPACE-NETWORK-POLICY")?.state, "FAIL");
  assert.equal(report.results.find((item) => item.subject === "Namespace/open" &&
    item.controlId === "K8S-NAMESPACE-POD-SECURITY")?.state, "FAIL");
});

test("missing fields and uncollected resource kinds remain UNKNOWN", () => {
  const report = evaluateKubernetesPosture(snapshot([
    {
      kind: "Workload", workloadKind: "Pod", namespace: "payments", name: "unknown",
      hostNetwork: null, hostPid: null, hostIpc: null, hasHostPath: null,
      runAsNonRoot: null, seccompProfile: null,
      containers: [secureContainer({
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
      })],
    },
  ], ["Workload"]));
  assert.equal(report.results.filter((item) => item.subject === "Workload/payments/unknown").length, 11);
  assert.ok(report.results.filter((item) => item.subject === "Workload/payments/unknown")
    .every((item) => item.state === "UNKNOWN"));
  assert.equal(report.results.find((item) => item.controlId === "K8S-SERVICE-EXPOSURE")?.state, "UNKNOWN");
  assert.equal(report.results.find((item) => item.controlId === "K8S-NAMESPACE-NETWORK-POLICY")?.state, "UNKNOWN");
});

test("rejects Secret evidence without touching secret payload fields", () => {
  let payloadRead = false;
  const secret: Record<string, unknown> = { kind: "Secret" };
  Object.defineProperty(secret, "data", {
    enumerable: true,
    get() {
      payloadRead = true;
      throw new Error("secret data must never be read");
    },
  });
  assert.throws(
    () => snapshot([secret], []),
    (error: unknown) => error instanceof KubernetesEvidenceError &&
      error.code === "SECRET_REJECTED" &&
      error.message === "Kubernetes evidence rejected",
  );
  assert.equal(payloadRead, false);
});

test("rejects malformed or unbounded evidence instead of coercing it", () => {
  assert.throws(
    () => normalizeKubernetesEvidence({
      clusterId: "cluster_prod_01", collectedAt, observedKinds: ["Workload"],
      resources: [{ kind: "Workload", name: "api", namespace: "payments", containers: [] }],
    }),
    KubernetesEvidenceError,
  );
  assert.throws(
    () => normalizeKubernetesEvidence({
      clusterId: "cluster_prod_01", collectedAt, observedKinds: ["Secret"], resources: [],
    }),
    KubernetesEvidenceError,
  );
});
