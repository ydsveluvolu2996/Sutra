import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAuditExport,
  buildFrameworkReadiness,
  COMPLIANCE_FRAMEWORKS,
  COMPLIANCE_READINESS_DISCLAIMER,
  getComplianceFramework,
  UNKNOWN_READINESS_SCOPE,
  type CollectedControlResult,
  type CollectedControlState,
  type ComplianceFrameworkId,
  type ReadinessScope,
} from "../lib/compliance-frameworks.ts";

const FRAMEWORK_IDS: readonly ComplianceFrameworkId[] = [
  "pci-dss-v4",
  "hipaa-security-rule",
  "iso-27001-2022-annex-a",
  "nist-csf-2.0",
  "soc-2-tsc",
];

function result(controlId: string, state: CollectedControlState): CollectedControlResult {
  return { controlId, state };
}

function mappedIds(frameworkId: ComplianceFrameworkId): readonly string[] {
  const framework = getComplianceFramework(frameworkId);
  assert.ok(framework !== undefined);
  return [...new Set(framework.controls.flatMap((control) => control.sutraControlIds))];
}

function frameworkControl(frameworkId: ComplianceFrameworkId, controlId: string) {
  const readiness = buildFrameworkReadiness([], frameworkId);
  const control = readiness.controls.find((candidate) => candidate.controlId === controlId);
  assert.ok(control !== undefined, `${controlId} missing from ${frameworkId}`);
  return control;
}

test("every framework exposes a named, non-empty control set with a claim boundary", () => {
  assert.deepEqual(
    COMPLIANCE_FRAMEWORKS.map((framework) => framework.id),
    FRAMEWORK_IDS,
  );
  for (const framework of COMPLIANCE_FRAMEWORKS) {
    assert.ok(framework.title.length > 0);
    assert.ok(framework.controls.length > 0);
    assert.ok(framework.claimBoundary.length > 0);
    assert.ok(
      ["available", "mapping-review-required", "licensed-content-required"].includes(
        framework.availability,
      ),
    );
    for (const control of framework.controls) {
      assert.ok(control.controlId.length > 0);
      assert.ok(control.title.length > 0);
      assert.ok(control.sutraControlIds.length > 0, `${control.controlId} maps to nothing`);
    }
  }
});

test("empty evidence yields only NOT_COLLECTED controls and never a false PASS or FAIL", () => {
  for (const frameworkId of FRAMEWORK_IDS) {
    const readiness = buildFrameworkReadiness([], frameworkId);
    assert.equal(readiness.schema, "sutra.compliance-framework-readiness.v1");
    assert.equal(readiness.summary.PASS, 0);
    assert.equal(readiness.summary.FAIL, 0);
    assert.equal(readiness.summary.UNKNOWN, 0);
    assert.equal(readiness.summary.NOT_COLLECTED, readiness.controls.length);
    assert.ok(readiness.controls.every((control) => control.state === "NOT_COLLECTED"));
    assert.deepEqual(readiness.unmappedControlIds, []);
    for (const control of readiness.controls) {
      assert.ok(control.mappedEvidence.every((entry) => entry.state === "NOT_COLLECTED"));
      assert.equal(control.passCount, 0);
      assert.equal(control.failCount, 0);
      assert.equal(control.unknownCount, 0);
      assert.equal(control.notCollectedCount, control.mappedSutraControlIds.length);
    }
  }
});

test("happy path: all mapped Sutra controls PASS makes every framework control PASS", () => {
  for (const frameworkId of FRAMEWORK_IDS) {
    const evidence = mappedIds(frameworkId).map((controlId) => result(controlId, "PASS"));
    const readiness = buildFrameworkReadiness(evidence, frameworkId);
    assert.equal(readiness.summary.PASS, readiness.controls.length);
    assert.equal(readiness.summary.FAIL, 0);
    assert.equal(readiness.summary.UNKNOWN, 0);
    assert.equal(readiness.summary.NOT_COLLECTED, 0);
    assert.ok(readiness.controls.every((control) => control.state === "PASS"));
    assert.deepEqual(readiness.unmappedControlIds, []);
  }
});

test("a single mapped id: PASS -> PASS, FAIL -> FAIL, UNKNOWN -> UNKNOWN", () => {
  const cases: readonly [CollectedControlState, string][] = [
    ["PASS", "PASS"],
    ["FAIL", "FAIL"],
    ["UNKNOWN", "UNKNOWN"],
  ];
  for (const [input, expected] of cases) {
    const readiness = buildFrameworkReadiness(
      [result("SUTRA.AWS.RDS.STORAGE_ENCRYPTED", input)],
      "pci-dss-v4",
    );
    const control = readiness.controls.find((candidate) => candidate.controlId === "3.5.1");
    assert.ok(control !== undefined);
    assert.equal(control.state, expected);
  }
});

test("UNKNOWN propagates: one unknown mapped control downgrades the framework control", () => {
  // PCI 2.2.1 maps three ids; pass two and leave one UNKNOWN.
  const readiness = buildFrameworkReadiness(
    [
      result("SUTRA.AWS.EC2.IMDSV2_REQUIRED", "PASS"),
      result("K8S-WORKLOAD-NO-PRIVILEGED", "PASS"),
      result("K8S-WORKLOAD-RUN-AS-NON-ROOT", "UNKNOWN"),
    ],
    "pci-dss-v4",
  );
  const control = readiness.controls.find((candidate) => candidate.controlId === "2.2.1");
  assert.ok(control !== undefined);
  assert.equal(control.state, "UNKNOWN");
  assert.equal(control.passCount, 2);
  assert.equal(control.unknownCount, 1);
  assert.equal(control.notCollectedCount, 0);
});

test("partial evidence never becomes PASS: all-collected-PASS but a mapped id absent -> UNKNOWN", () => {
  // PCI 2.2.1 maps three ids; collect only one, PASS. The other two are absent.
  const readiness = buildFrameworkReadiness(
    [result("SUTRA.AWS.EC2.IMDSV2_REQUIRED", "PASS")],
    "pci-dss-v4",
  );
  const control = readiness.controls.find((candidate) => candidate.controlId === "2.2.1");
  assert.ok(control !== undefined);
  assert.equal(control.state, "UNKNOWN");
  assert.equal(control.passCount, 1);
  assert.equal(control.notCollectedCount, 2);
  const absent = control.mappedEvidence.filter((entry) => entry.state === "NOT_COLLECTED");
  assert.equal(absent.length, 2);
});

test("a concrete FAIL surfaces as FAIL even when other mapped ids are absent", () => {
  const readiness = buildFrameworkReadiness(
    [result("SUTRA.AWS.EC2.IMDSV2_REQUIRED", "FAIL")],
    "pci-dss-v4",
  );
  const control = readiness.controls.find((candidate) => candidate.controlId === "2.2.1");
  assert.ok(control !== undefined);
  assert.equal(control.state, "FAIL");
  assert.equal(control.failCount, 1);
  assert.equal(control.notCollectedCount, 2);
});

test("UNKNOWN outranks FAIL at the aggregate, yet the concrete FAIL is still cited in evidence", () => {
  // PCI 1.3.1 maps four ids: one FAIL, one UNKNOWN, two absent.
  const readiness = buildFrameworkReadiness(
    [
      result("SUTRA.AWS.EC2.SSH_PUBLIC", "FAIL"),
      result("SUTRA.AWS.EC2.PUBLIC_IP", "UNKNOWN"),
    ],
    "pci-dss-v4",
  );
  const control = readiness.controls.find((candidate) => candidate.controlId === "1.3.1");
  assert.ok(control !== undefined);
  assert.equal(control.state, "UNKNOWN");
  const failEvidence = control.mappedEvidence.find(
    (entry) => entry.sutraControlId === "SUTRA.AWS.EC2.SSH_PUBLIC",
  );
  assert.ok(failEvidence !== undefined);
  assert.equal(failEvidence.state, "FAIL");
});

test("duplicate collected results for one Sutra id resolve conservatively", () => {
  const asState = (states: CollectedControlState[]) => {
    const readiness = buildFrameworkReadiness(
      states.map((state) => result("SUTRA.AWS.RDS.STORAGE_ENCRYPTED", state)),
      "pci-dss-v4",
    );
    return frameworkControlFrom(readiness, "3.5.1").state;
  };
  function frameworkControlFrom(
    readiness: ReturnType<typeof buildFrameworkReadiness>,
    controlId: string,
  ) {
    const control = readiness.controls.find((candidate) => candidate.controlId === controlId);
    assert.ok(control !== undefined);
    return control;
  }
  assert.equal(asState(["PASS", "PASS"]), "PASS");
  assert.equal(asState(["PASS", "FAIL"]), "FAIL");
  assert.equal(asState(["PASS", "UNKNOWN"]), "UNKNOWN");
  assert.equal(asState(["FAIL", "UNKNOWN"]), "UNKNOWN");
});

test("collected ids that map to no framework control are surfaced as unmapped, sorted", () => {
  const readiness = buildFrameworkReadiness(
    [
      result("SUTRA.AWS.ZZZ.LAST", "PASS"),
      result("SUTRA.AWS.AAA.FIRST", "FAIL"),
      result("SUTRA.AWS.RDS.STORAGE_ENCRYPTED", "PASS"),
    ],
    "pci-dss-v4",
  );
  assert.deepEqual(readiness.unmappedControlIds, ["SUTRA.AWS.AAA.FIRST", "SUTRA.AWS.ZZZ.LAST"]);
});

test("mapped evidence records NOT_COLLECTED per absent id and cites collected states", () => {
  const control = frameworkControl("hipaa-security-rule", "164.308(a)(1)(ii)(D)");
  assert.deepEqual(control.mappedSutraControlIds, [
    "SUTRA.AWS.GUARDDUTY.ENABLED",
    "SUTRA.AWS.SECURITYHUB.ENABLED",
  ]);
  const readiness = buildFrameworkReadiness(
    [result("SUTRA.AWS.GUARDDUTY.ENABLED", "PASS")],
    "hipaa-security-rule",
  );
  const evaluated = readiness.controls.find(
    (candidate) => candidate.controlId === "164.308(a)(1)(ii)(D)",
  );
  assert.ok(evaluated !== undefined);
  assert.deepEqual(evaluated.mappedEvidence, [
    { sutraControlId: "SUTRA.AWS.GUARDDUTY.ENABLED", state: "PASS" },
    { sutraControlId: "SUTRA.AWS.SECURITYHUB.ENABLED", state: "NOT_COLLECTED" },
  ]);
  assert.equal(evaluated.state, "UNKNOWN");
});

test("scope defaults to an all-unknown scope and no clock value is synthesized", () => {
  const readiness = buildFrameworkReadiness([], "soc-2-tsc");
  assert.deepEqual(readiness.scope, UNKNOWN_READINESS_SCOPE);
  assert.equal(readiness.scope.tenantId, null);
  assert.equal(readiness.scope.collectionId, null);
  assert.equal(readiness.scope.collectedAt, null);
});

test("scope is passed through unchanged for MSP tenant provenance", () => {
  const scope: ReadinessScope = {
    tenantId: "tenant-acme",
    collectionId: "collection-2026-07-17",
    collectedAt: "2026-07-17T10:00:00.000Z",
  };
  const readiness = buildFrameworkReadiness([], "soc-2-tsc", scope);
  assert.deepEqual(readiness.scope, scope);
  const auditExport = buildAuditExport(readiness);
  assert.deepEqual(auditExport.scope, scope);
});

test("readiness disclaimer states this is not a certification", () => {
  const readiness = buildFrameworkReadiness([], "iso-27001-2022-annex-a");
  assert.equal(readiness.disclaimer, COMPLIANCE_READINESS_DISCLAIMER);
  assert.match(readiness.disclaimer, /not a certification/u);
  assert.match(readiness.disclaimer, /point-in-time/u);
});

test("audit export mirrors readiness rows and carries the non-certification disclaimer", () => {
  const evidence = mappedIds("soc-2-tsc").map((controlId) => result(controlId, "PASS"));
  const readiness = buildFrameworkReadiness(evidence, "soc-2-tsc");
  const auditExport = buildAuditExport(readiness);

  assert.equal(auditExport.schema, "sutra.compliance-audit-export.v1");
  assert.deepEqual(auditExport.framework, readiness.framework);
  assert.deepEqual(auditExport.generatedFromCounts, readiness.summary);
  assert.equal(auditExport.rows.length, readiness.controls.length);
  assert.match(auditExport.disclaimer, /not a certification/u);
  for (let index = 0; index < auditExport.rows.length; index += 1) {
    const row = auditExport.rows[index];
    const control = readiness.controls[index];
    assert.ok(row !== undefined && control !== undefined);
    assert.equal(row.controlId, control.controlId);
    assert.equal(row.title, control.title);
    assert.equal(row.state, control.state);
    assert.deepEqual(row.mappedEvidence, control.mappedEvidence);
    assert.match(row.disclaimer, /not a certification/u);
  }
});

test("engine is deterministic: identical inputs produce identical output", () => {
  const evidence = [
    result("SUTRA.AWS.RDS.STORAGE_ENCRYPTED", "PASS"),
    result("K8S-INGRESS-TLS", "FAIL"),
    result("SUTRA.AWS.GUARDDUTY.ENABLED", "UNKNOWN"),
  ];
  const first = buildFrameworkReadiness(evidence, "nist-csf-2.0");
  const second = buildFrameworkReadiness(evidence, "nist-csf-2.0");
  assert.deepEqual(first, second);
  assert.deepEqual(buildAuditExport(first), buildAuditExport(second));
});

test("an unknown framework id is rejected rather than silently defaulted", () => {
  assert.throws(
    () => buildFrameworkReadiness([], "not-a-framework" as ComplianceFrameworkId),
    /not in the catalog/u,
  );
});
