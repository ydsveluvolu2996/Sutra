import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKubernetesComplianceReadinessReport,
  type KubernetesReadinessEvidenceInput,
} from "../lib/kubernetes-compliance-readiness.ts";
import { KUBERNETES_COMPLIANCE_CONTROLS } from "../lib/kubernetes-compliance-catalog.ts";

function finding(
  controlId: string,
  state: KubernetesReadinessEvidenceInput["state"],
  subject = "default/workload-a",
): KubernetesReadinessEvidenceInput {
  return { controlId, state, severity: "HIGH", subject };
}

test("readiness report renders all three external frameworks with claim boundaries", () => {
  const report = buildKubernetesComplianceReadinessReport({ findings: [], collectedAt: null });
  assert.equal(report.schema, "sutra.kubernetes-compliance-readiness.v1");
  assert.deepEqual(
    report.frameworks.map((entry) => entry.framework.key),
    ["cis-kubernetes-readiness", "nsa-cisa-kubernetes-hardening", "soc-2-readiness"],
  );
  for (const entry of report.frameworks) {
    assert.ok(entry.framework.claimBoundary.length > 0);
    assert.ok(entry.controls.length > 0);
  }
  assert.match(report.disclaimer, /not a certification/u);
});

test("controls with no collected evidence stay NOT_COLLECTED and are never treated as passing", () => {
  const report = buildKubernetesComplianceReadinessReport({ findings: [], collectedAt: null });
  for (const entry of report.frameworks) {
    assert.equal(entry.summary.PASS, 0);
    assert.equal(entry.summary.FAIL, 0);
    assert.equal(entry.summary.UNKNOWN, 0);
    assert.equal(entry.summary.NOT_COLLECTED, entry.controls.length);
    assert.ok(entry.controls.every((control) => control.state === "NOT_COLLECTED"));
  }
});

test("a single failing subject makes the mapped control FAIL across every framework", () => {
  const report = buildKubernetesComplianceReadinessReport({
    findings: [
      finding("K8S-WORKLOAD-NO-PRIVILEGED", "PASS", "default/workload-a"),
      finding("K8S-WORKLOAD-NO-PRIVILEGED", "FAIL", "payments/workload-b"),
      finding("K8S-WORKLOAD-NO-PRIVILEGED", "UNKNOWN", "payments/workload-c"),
    ],
    collectedAt: "2026-07-17T10:00:00.000Z",
  });
  assert.equal(report.collectedAt, "2026-07-17T10:00:00.000Z");
  for (const entry of report.frameworks) {
    const control = entry.controls.find(
      (candidate) => candidate.controlId === "K8S-WORKLOAD-NO-PRIVILEGED",
    );
    assert.ok(control !== undefined);
    assert.equal(control.state, "FAIL");
    assert.equal(control.passCount, 1);
    assert.equal(control.failCount, 1);
    assert.equal(control.unknownCount, 1);
    assert.deepEqual(control.failedSubjects, ["payments/workload-b"]);
    assert.ok(control.references.length > 0);
    assert.equal(entry.summary.FAIL, 1);
  }
});

test("unknown evidence downgrades a control to UNKNOWN, and unknown never becomes PASS", () => {
  const report = buildKubernetesComplianceReadinessReport({
    findings: [
      finding("K8S-RBAC-WILDCARDS", "PASS"),
      finding("K8S-RBAC-WILDCARDS", "UNKNOWN", "kube-system/role-x"),
    ],
    collectedAt: null,
  });
  const control = report.frameworks[0]?.controls.find(
    (candidate) => candidate.controlId === "K8S-RBAC-WILDCARDS",
  );
  assert.ok(control !== undefined);
  assert.equal(control.state, "UNKNOWN");
});

test("fully passing evidence marks the control PASS with deduplicated failed subjects empty", () => {
  const report = buildKubernetesComplianceReadinessReport({
    findings: [
      finding("K8S-INGRESS-TLS", "PASS", "default/ingress-a"),
      finding("K8S-INGRESS-TLS", "PASS", "default/ingress-b"),
    ],
    collectedAt: null,
  });
  const control = report.frameworks[0]?.controls.find(
    (candidate) => candidate.controlId === "K8S-INGRESS-TLS",
  );
  assert.ok(control !== undefined);
  assert.equal(control.state, "PASS");
  assert.deepEqual(control.failedSubjects, []);
});

test("finding control ids outside the catalog are reported as unmapped, not silently dropped", () => {
  const report = buildKubernetesComplianceReadinessReport({
    findings: [finding("K8S-FUTURE-CONTROL", "FAIL")],
    collectedAt: null,
  });
  assert.deepEqual(report.unmappedControlIds, ["K8S-FUTURE-CONTROL"]);
});

test("every catalog control appears in at least one framework readiness listing", () => {
  const report = buildKubernetesComplianceReadinessReport({ findings: [], collectedAt: null });
  const listed = new Set(
    report.frameworks.flatMap((entry) => entry.controls.map((control) => control.controlId)),
  );
  for (const control of KUBERNETES_COMPLIANCE_CONTROLS) {
    assert.ok(listed.has(control.controlId), `${control.controlId} is not listed`);
  }
});
