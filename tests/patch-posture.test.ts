import assert from "node:assert/strict";
import test from "node:test";
import {
  PATCH_POSTURE_GENERATED_NOT_EXECUTED_NOTICE,
  buildPatchPosture,
  type PatchInstanceInput,
  type PatchStateFacts,
} from "../lib/patch-posture.ts";

function facts(overrides: Partial<PatchStateFacts>): PatchStateFacts {
  return {
    managed: true,
    patchStateAvailable: true,
    baselineId: "pb-1",
    operation: "Scan",
    lastScanAt: "2026-07-15T04:15:00.000Z",
    installedCount: 100,
    missingCount: 0,
    failedCount: 0,
    notApplicableCount: 10,
    criticalMissingCount: 0,
    securityMissingCount: 0,
    otherNonCompliantCount: 0,
    missingPatches: [],
    ...overrides,
  };
}

function instance(overrides: Partial<PatchInstanceInput>): PatchInstanceInput {
  return {
    resourceKey: overrides.instanceId ?? "rk",
    instanceId: "i-0",
    name: null,
    region: "us-east-1",
    instanceState: "running",
    platform: "Linux/UNIX",
    patch: null,
    ...overrides,
  };
}

test("a compliant instance is compliant and generates no runbook", () => {
  const report = buildPatchPosture({
    instances: [instance({ instanceId: "i-ok", resourceKey: "i-ok", patch: facts({}) })],
  });
  assert.equal(report.instances.length, 1);
  assert.equal(report.instances[0].complianceStatus, "compliant");
  assert.equal(report.instances[0].assessed, true);
  assert.equal(report.summary.compliant, 1);
  assert.equal(report.summary.nonCompliant, 0);
  assert.equal(report.runbooks.length, 0);
});

test("a non-compliant instance counts missing patches by severity and gets a generated runbook", () => {
  const report = buildPatchPosture({
    instances: [
      instance({
        instanceId: "i-bad",
        resourceKey: "i-bad",
        name: "payments-api",
        region: "eu-west-1",
        patch: facts({
          missingCount: 7,
          failedCount: 1,
          criticalMissingCount: 2,
          securityMissingCount: 4,
          missingPatches: [
            { title: "kernel", kbId: "USN-1", classification: "Security", severity: "Critical" },
          ],
        }),
      }),
    ],
  });
  const posture = report.instances[0];
  assert.equal(posture.complianceStatus, "non-compliant");
  assert.equal(posture.missingCount, 7);
  assert.equal(posture.criticalMissingCount, 2);
  assert.equal(posture.securityMissingCount, 4);
  assert.equal(posture.missingPatches.length, 1);
  assert.equal(report.summary.nonCompliant, 1);
  assert.equal(report.summary.criticalMissingTotal, 2);
  assert.equal(report.summary.securityMissingTotal, 4);

  // Exactly one runbook, only for the non-compliant host, and it is the exact
  // customer-run command — never executed by Sutra.
  assert.equal(report.runbooks.length, 1);
  const runbook = report.runbooks[0];
  assert.equal(runbook.instanceId, "i-bad");
  assert.match(runbook.command, /aws ssm send-command/);
  assert.match(runbook.command, /AWS-RunPatchBaseline/);
  assert.match(runbook.command, /Values=i-bad/);
  assert.match(runbook.command, /--region eu-west-1/);
  assert.match(runbook.verifyCommand, /describe-instance-patch-states --instance-ids i-bad/);
  assert.equal(runbook.generatedNotExecutedNotice, PATCH_POSTURE_GENERATED_NOT_EXECUTED_NOTICE);
  assert.ok(runbook.steps.length > 0);
});

test("an instance with no SSM patch data is not-assessed, never compliant, and gets no runbook", () => {
  const report = buildPatchPosture({
    instances: [instance({ instanceId: "i-unmanaged", resourceKey: "i-unmanaged", patch: null })],
  });
  const posture = report.instances[0];
  assert.equal(posture.complianceStatus, "not-assessed");
  assert.equal(posture.assessed, false);
  assert.equal(posture.managed, false);
  assert.equal(posture.missingCount, null);
  assert.match(posture.statusReason, /NOT_ASSESSED/);
  assert.equal(report.summary.compliant, 0);
  assert.equal(report.summary.unmanaged, 1);
  assert.equal(report.summary.notAssessed, 1);
  assert.equal(report.runbooks.length, 0);
});

test("an SSM-managed instance with no reported patch state is not-assessed, never compliant", () => {
  const report = buildPatchPosture({
    instances: [
      instance({
        instanceId: "i-unscanned",
        resourceKey: "i-unscanned",
        patch: facts({ patchStateAvailable: false, installedCount: null, missingCount: null, notApplicableCount: null }),
      }),
    ],
  });
  const posture = report.instances[0];
  assert.equal(posture.complianceStatus, "not-assessed");
  assert.equal(posture.managed, true);
  assert.equal(report.summary.managedNotScanned, 1);
  assert.equal(report.summary.unmanaged, 0);
  assert.equal(report.summary.notAssessed, 1);
  assert.equal(report.summary.compliant, 0);
  assert.equal(report.runbooks.length, 0);
});

test("fleet summary counts each state and reports assessment coverage honestly", () => {
  const report = buildPatchPosture({
    instances: [
      instance({ instanceId: "i-a", resourceKey: "i-a", patch: facts({}) }),
      instance({ instanceId: "i-b", resourceKey: "i-b", patch: facts({ missingCount: 3, criticalMissingCount: 1 }) }),
      instance({ instanceId: "i-c", resourceKey: "i-c", patch: null }),
      instance({ instanceId: "i-d", resourceKey: "i-d", patch: facts({ patchStateAvailable: false }) }),
    ],
  });
  assert.equal(report.summary.fleetSize, 4);
  assert.equal(report.summary.compliant, 1);
  assert.equal(report.summary.nonCompliant, 1);
  assert.equal(report.summary.unmanaged, 1);
  assert.equal(report.summary.managedNotScanned, 1);
  assert.equal(report.summary.assessed, 2);
  assert.equal(report.summary.notAssessed, 2);
  // 2 assessed of 4 = 50%.
  assert.equal(report.summary.assessmentCoveragePercent, 50);
  // Non-compliant sorts first.
  assert.equal(report.instances[0].complianceStatus, "non-compliant");
});

test("an empty fleet is an honest empty report, not a claim of compliance", () => {
  const report = buildPatchPosture({ instances: [] });
  assert.equal(report.summary.fleetSize, 0);
  assert.equal(report.summary.compliant, 0);
  assert.equal(report.summary.assessmentCoveragePercent, null);
  assert.equal(report.runbooks.length, 0);
  assert.equal(report.schema, "sutra.patch-posture.v1");
});
