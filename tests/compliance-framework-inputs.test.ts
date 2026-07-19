import assert from "node:assert/strict";
import test from "node:test";
import {
  awsCollectedControlResults,
  kubernetesCollectedControlResults,
} from "../lib/compliance-framework-inputs.ts";
import type { ComplianceAssessment, ComplianceStatus } from "../lib/compliance-engine.ts";

function assessment(results: readonly { controlKey: string; status: ComplianceStatus }[]): ComplianceAssessment {
  return { results } as unknown as ComplianceAssessment;
}

test("AWS mapper carries PASS/FAIL/UNKNOWN and drops NOT_APPLICABLE + EXCEPTED (never a fabricated pass)", () => {
  const results = awsCollectedControlResults(assessment([
    { controlKey: "SUTRA.AWS.RDS.STORAGE_ENCRYPTED", status: "PASS" },
    { controlKey: "SUTRA.AWS.IAM.PASSWORD_POLICY", status: "FAIL" },
    { controlKey: "SUTRA.AWS.CLOUDTRAIL.LOGGING", status: "UNKNOWN" },
    { controlKey: "SUTRA.AWS.EC2.SSH_PUBLIC", status: "NOT_APPLICABLE" },
    { controlKey: "SUTRA.AWS.GUARDDUTY.ENABLED", status: "EXCEPTED" },
  ]));
  assert.deepEqual(results, [
    { controlId: "SUTRA.AWS.RDS.STORAGE_ENCRYPTED", state: "PASS" },
    { controlId: "SUTRA.AWS.IAM.PASSWORD_POLICY", state: "FAIL" },
    { controlId: "SUTRA.AWS.CLOUDTRAIL.LOGGING", state: "UNKNOWN" },
  ]);
});

test("K8s mapper passes through per-subject findings and drops any non PASS/FAIL/UNKNOWN state", () => {
  const results = kubernetesCollectedControlResults([
    { controlId: "K8S-RBAC-WILDCARDS", state: "FAIL" },
    { controlId: "K8S-RBAC-WILDCARDS", state: "PASS" }, // multiple subjects per control
    { controlId: "K8S-INGRESS-TLS", state: "PASS" },
    { controlId: "K8S-IMAGE-DIGEST", state: "NOT_COLLECTED" }, // not a valid collected state -> dropped
  ]);
  // Passed through as-is (engine collapses per-control); only the invalid state is dropped.
  assert.equal(results.length, 3);
  assert.deepEqual(results.filter((r) => r.controlId === "K8S-RBAC-WILDCARDS").map((r) => r.state).sort(), ["FAIL", "PASS"]);
  assert.equal(results.some((r) => r.controlId === "K8S-IMAGE-DIGEST"), false);
});
