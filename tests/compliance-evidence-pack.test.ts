import assert from "node:assert/strict";
import test from "node:test";
import { buildComplianceEvidencePack } from "../lib/compliance-evidence-pack.ts";
import type { ComplianceAssessmentWithExceptions } from "../lib/compliance-exception-types.ts";
import type { FrameworkReadiness } from "../lib/compliance-frameworks.ts";
import { buildKubernetesComplianceReadinessReport } from "../lib/kubernetes-compliance-readiness.ts";

function awsAssessment(over: Partial<ComplianceAssessmentWithExceptions> = {}): ComplianceAssessmentWithExceptions {
  return {
    assessmentId: "snap-1:sutra-aws-baseline:1",
    catalog: { key: "sutra-aws-baseline", name: "Sutra AWS Baseline", version: "1.0.0", claimBoundary: "cb" },
    provenance: {
      connectionId: "conn", customerId: "cust", awsAccountId: "111122223333",
      sourceKind: "aws_trust_role", snapshotId: "snap-1", snapshotSha256: "a".repeat(64),
      snapshotCollectedAt: "2026-07-17T10:00:00.000Z", snapshotCoverageState: "complete",
    },
    summary: { total: 11, pass: 6, fail: 2, unknown: 2, notApplicable: 0, excepted: 1, scoredControls: 8, scorePercent: 75 },
    results: [],
    disclaimer: "aws disclaimer",
    ...over,
  } as ComplianceAssessmentWithExceptions;
}

function framework(id: string): FrameworkReadiness {
  return {
    schema: "sutra.compliance-framework-readiness.v1",
    framework: { id: id as FrameworkReadiness["framework"]["id"], title: id, availability: "mapping-review-required", claimBoundary: "cb" },
    scope: {} as FrameworkReadiness["scope"],
    controls: [],
    summary: { PASS: 0, FAIL: 0, UNKNOWN: 0, NOT_COLLECTED: 0 },
    unmappedControlIds: [],
    disclaimer: "fw",
  };
}

const readiness = buildKubernetesComplianceReadinessReport({
  collectedAt: "2026-07-17T11:00:00.000Z",
  findings: [
    { controlId: "K8S-WORKLOAD-NO-PRIVILEGED", state: "FAIL", severity: "CRITICAL", subject: "Workload/payments/api", evidence: ["privileged=true"] },
    { controlId: "K8S-RBAC-WILDCARDS", state: "PASS", severity: "CRITICAL", subject: "RbacRole/payments/reader" },
  ],
});

test("assembles AWS + Kubernetes + frameworks with merged provenance and a roll-up summary", () => {
  const pack = buildComplianceEvidencePack({
    aws: awsAssessment(),
    kubernetes: readiness,
    frameworks: [framework("soc-2"), framework("pci-dss")],
    kubernetesScanSha256: "b".repeat(64),
  });
  assert.equal(pack.schema, "sutra.compliance-evidence-pack.v1");
  assert.equal(pack.summary.awsScorePercent, 75);
  assert.equal(pack.summary.aws.fail, 2);
  assert.equal(pack.summary.aws.excepted, 1);
  assert.equal(pack.summary.frameworkCount, 2);
  // Merged provenance names both the AWS snapshot and the K8s scan.
  assert.equal(pack.provenance.awsSnapshotSha256, "a".repeat(64));
  assert.equal(pack.provenance.kubernetesScanSha256, "b".repeat(64));
  assert.equal(pack.provenance.kubernetesCollectedAt, "2026-07-17T11:00:00.000Z");
  assert.equal(pack.provenance.awsCatalog.version, "1.0.0");
  // Frameworks embedded in deterministic id order regardless of input order.
  assert.deepEqual(pack.frameworks.map((f) => f.framework.id), ["pci-dss", "soc-2"]);
});

test("Kubernetes roll-up takes the worst state per distinct control across frameworks", () => {
  const pack = buildComplianceEvidencePack({ aws: awsAssessment(), kubernetes: readiness, frameworks: [] });
  // The privileged control fails; the RBAC control passes; every other catalog
  // control has no evidence -> NOT_COLLECTED. Distinct controls, worst-state wins.
  assert.equal(pack.summary.kubernetes.FAIL, 1);
  assert.equal(pack.summary.kubernetes.PASS, 1);
  assert.ok(pack.summary.kubernetes.NOT_COLLECTED > 0);
});

test("preserves the readiness evidence trail (failed-subject evidence + remediation) end to end", () => {
  const pack = buildComplianceEvidencePack({ aws: awsAssessment(), kubernetes: readiness, frameworks: [] });
  const failing = pack.kubernetes.frameworks
    .flatMap((f) => f.controls)
    .find((c) => c.controlId === "K8S-WORKLOAD-NO-PRIVILEGED" && c.state === "FAIL");
  assert.ok(failing !== undefined);
  assert.equal(failing.severity, "CRITICAL");
  assert.deepEqual(failing.failedSubjectEvidence[0]?.evidence, ["privileged=true"]);
  assert.match(failing.remediation, /privileg/iu);
});

test("is deterministic — identical inputs yield byte-identical JSON", () => {
  const build = () => buildComplianceEvidencePack({
    aws: awsAssessment(), kubernetes: readiness, frameworks: [framework("soc-2"), framework("pci-dss")],
  });
  assert.equal(JSON.stringify(build()), JSON.stringify(build()));
});
