import assert from "node:assert/strict";
import test from "node:test";
import { prioritizeKubernetesPosture } from "../lib/kubernetes-posture-priority.ts";
import type { KubernetesControlResult, KubernetesPostureReport } from "../lib/kubernetes-posture.ts";

function ctrl(
  controlId: string,
  subject: string,
  state: KubernetesControlResult["state"],
  severity: KubernetesControlResult["severity"],
): KubernetesControlResult {
  return { controlId, subject, state, severity, message: controlId, evidence: [`${controlId} evidence`] };
}

function report(results: readonly KubernetesControlResult[]): KubernetesPostureReport {
  return {
    schema: "sutra.kubernetes-posture.v1",
    clusterId: "kcluster_x",
    collectedAt: "2026-07-18T00:00:00.000Z",
    summary: { PASS: 0, FAIL: 0, UNKNOWN: 0 },
    results,
    disclaimer: "",
  };
}

test("an internet-exposed + privileged workload outranks a higher-severity but isolated failure", () => {
  const out = prioritizeKubernetesPosture(report([
    // Subject A: exposed (HIGH) + privileged (CRITICAL) -> toxic combination
    ctrl("K8S-SERVICE-EXPOSURE", "Deployment/prod/api", "FAIL", "HIGH"),
    ctrl("K8S-WORKLOAD-NO-PRIVILEGED", "Deployment/prod/api", "FAIL", "CRITICAL"),
    // Subject B: a single CRITICAL RBAC failure, no combination
    ctrl("K8S-RBAC-WILDCARDS", "ClusterRole/backup", "FAIL", "CRITICAL"),
  ]));
  assert.equal(out.findings[0]?.subject, "Deployment/prod/api", "the toxic-combination workload's finding ranks first");
  assert.ok(out.findings[0]!.priorityScore > 4000, "combination bonus applied");
  const api = out.workloads.find((w) => w.subject === "Deployment/prod/api");
  const backup = out.workloads.find((w) => w.subject === "ClusterRole/backup");
  assert.ok((api?.priorityScore ?? 0) > (backup?.priorityScore ?? 0), "exposed+privileged workload ranks above the isolated CRITICAL");
  assert.deepEqual([...(api?.riskFactors ?? [])].sort(), ["internet-exposed", "privileged"]);
});

test("Pod Security Standards classification from failing controls (honest 'unknown', never upgraded)", () => {
  const out = prioritizeKubernetesPosture(report([
    ctrl("K8S-WORKLOAD-NO-PRIVILEGED", "Deployment/a/priv", "FAIL", "CRITICAL"),        // baseline violation
    ctrl("K8S-WORKLOAD-RUN-AS-NON-ROOT", "Deployment/b/base", "FAIL", "HIGH"),          // restricted-only violation
    ctrl("K8S-WORKLOAD-NO-PRIVILEGED", "Deployment/c/good", "PASS", "CRITICAL"),
    ctrl("K8S-WORKLOAD-RUN-AS-NON-ROOT", "Deployment/c/good", "PASS", "HIGH"),
    ctrl("K8S-WORKLOAD-RUN-AS-NON-ROOT", "Deployment/d/unsure", "UNKNOWN", "HIGH"),
  ]));
  const pss = (subject: string) => out.workloads.find((w) => w.subject === subject)?.podSecurityStandard;
  assert.equal(pss("Deployment/a/priv"), "privileged");
  assert.equal(pss("Deployment/b/base"), "baseline");
  assert.equal(pss("Deployment/c/good"), "restricted");
  assert.equal(pss("Deployment/d/unsure"), "unknown", "an unknown control never upgrades to restricted");
});

test("UNKNOWN controls are surfaced but never scored as a pass, and never establish a risk factor", () => {
  const out = prioritizeKubernetesPosture(report([
    ctrl("K8S-WORKLOAD-NO-PRIVILEGED", "Deployment/prod/x", "UNKNOWN", "CRITICAL"), // unknown, not a FAIL
    ctrl("K8S-SERVICE-EXPOSURE", "Deployment/prod/x", "FAIL", "HIGH"),              // real exposure
  ]));
  const x = out.workloads.find((w) => w.subject === "Deployment/prod/x");
  assert.deepEqual(x?.riskFactors, ["internet-exposed"], "privileged is NOT asserted from an UNKNOWN control");
  const unknownFinding = out.findings.find((f) => f.controlId === "K8S-WORKLOAD-NO-PRIVILEGED");
  assert.equal(unknownFinding?.state, "UNKNOWN");
  // No exposed+privileged combo, so no 4000 bonus on the unknown finding.
  assert.ok((unknownFinding?.priorityScore ?? 9999) < 4000);
  assert.equal(out.summary.unknown, 1);
});

test("each finding carries CIS/NSA/SOC2 framework references and a concrete remediation", () => {
  const out = prioritizeKubernetesPosture(report([
    ctrl("K8S-WORKLOAD-RUN-AS-NON-ROOT", "Deployment/prod/api", "FAIL", "HIGH"),
  ]));
  const finding = out.findings[0];
  assert.ok(finding !== undefined);
  assert.ok(finding.frameworks.nsaCisa.length > 0 || finding.frameworks.cis.length > 0, "framework references joined from the catalog");
  assert.match(finding.remediationHint, /runAsNonRoot/u);
});

test("passing-only posture yields no findings and a restricted classification", () => {
  const out = prioritizeKubernetesPosture(report([
    ctrl("K8S-WORKLOAD-NO-PRIVILEGED", "Deployment/x/ok", "PASS", "CRITICAL"),
    ctrl("K8S-WORKLOAD-RUN-AS-NON-ROOT", "Deployment/x/ok", "PASS", "HIGH"),
  ]));
  assert.equal(out.findings.length, 0);
  assert.equal(out.summary.failing, 0);
  assert.equal(out.workloads[0]?.podSecurityStandard, "restricted");
});
