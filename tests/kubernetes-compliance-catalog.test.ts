import assert from "node:assert/strict";
import test from "node:test";

import {
  KUBERNETES_COMPLIANCE_CONTROLS,
  KUBERNETES_COMPLIANCE_FRAMEWORKS,
  mappingsForKubernetesControl,
} from "../lib/kubernetes-compliance-catalog.ts";

const EXPECTED_CONTROLS = new Set([
  "K8S-WORKLOAD-RUN-AS-NON-ROOT",
  "K8S-WORKLOAD-NO-PRIVILEGED",
  "K8S-WORKLOAD-NO-PRIVILEGE-ESCALATION",
  "K8S-WORKLOAD-CAPABILITIES",
  "K8S-WORKLOAD-SECCOMP",
  "K8S-WORKLOAD-HOST-NAMESPACES",
  "K8S-WORKLOAD-HOST-PATH",
  "K8S-IMAGE-DIGEST",
  "K8S-IMAGE-NO-LATEST",
  "K8S-WORKLOAD-RESOURCES",
  "K8S-WORKLOAD-PROBES",
  "K8S-SERVICE-EXPOSURE",
  "K8S-INGRESS-TLS",
  "K8S-RBAC-WILDCARDS",
  "K8S-RBAC-ESCALATION",
  "K8S-NAMESPACE-POD-SECURITY",
  "K8S-NAMESPACE-NETWORK-POLICY",
]);

test("maps every implemented Kubernetes posture control to the three approved readiness frameworks", () => {
  assert.deepEqual(
    new Set(KUBERNETES_COMPLIANCE_CONTROLS.map((control) => control.controlId)),
    EXPECTED_CONTROLS,
  );
  for (const control of KUBERNETES_COMPLIANCE_CONTROLS) {
    assert.deepEqual(
      new Set(control.mappings.map((mapping) => mapping.framework)),
      new Set(["cis-kubernetes-readiness", "nsa-cisa-kubernetes-hardening", "soc-2-readiness"]),
    );
    assert.equal(control.mappings.every((mapping) => mapping.relationship === "supports-readiness-review"), true);
  }
});

test("keeps licensed and readiness mappings outside certification claims", () => {
  const cis = KUBERNETES_COMPLIANCE_FRAMEWORKS.find((framework) => framework.key === "cis-kubernetes-readiness");
  const nsa = KUBERNETES_COMPLIANCE_FRAMEWORKS.find((framework) => framework.key === "nsa-cisa-kubernetes-hardening");
  const soc2 = KUBERNETES_COMPLIANCE_FRAMEWORKS.find((framework) => framework.key === "soc-2-readiness");

  assert.equal(cis?.availability, "licensed-content-required");
  assert.match(cis?.claimBoundary ?? "", /licensed/i);
  assert.equal(nsa?.availability, "mapping-review-required");
  assert.equal(soc2?.availability, "mapping-review-required");
  assert.match(soc2?.claimBoundary ?? "", /auditor/i);
});

test("returns only known control mappings", () => {
  assert.equal(mappingsForKubernetesControl("K8S-RBAC-WILDCARDS").length, 3);
  assert.deepEqual(mappingsForKubernetesControl("UNKNOWN-CONTROL"), []);
});
