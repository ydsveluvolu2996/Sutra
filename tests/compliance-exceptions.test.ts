import assert from "node:assert/strict";
import test from "node:test";
import {
  applyComplianceExceptions,
  type ComplianceExceptionRecord,
} from "../lib/compliance-exception-types.ts";
import type { ComplianceAssessment } from "../lib/compliance-engine.ts";

const assessment: ComplianceAssessment = {
  assessmentId: "snap_1:sutra:1",
  catalog: { key: "sutra", name: "Sutra", version: "1", claimBoundary: "test" },
  provenance: {
    connectionId: "conn_1", customerId: "cust_1", awsAccountId: "123456789012",
    sourceKind: "aws_trust_role", snapshotId: "snap_1", snapshotSha256: "a".repeat(64),
    snapshotCollectedAt: "2026-07-16T00:00:00.000Z", snapshotCoverageState: "complete",
  },
  summary: { total: 1, pass: 0, fail: 1, unknown: 0, notApplicable: 0, excepted: 0, scoredControls: 1, scorePercent: 0 },
  results: [{
    controlKey: "sutra.aws.s3.public-access", controlVersion: "1", title: "S3 access", description: "test",
    service: "S3", severity: "high", scope: "resource", status: "FAIL", reason: "one failure",
    remediation: "fix", limitation: "test", frameworkMappings: [],
    evidence: {
      applicableResourceCount: 1, coverage: [], matchingFindings: [{
        fingerprint: "finding-one", resourceKey: "aws:s3:bucket", controlVersion: "1",
        severity: "high", status: "open", evaluatedAt: "2026-07-16T00:00:00.000Z",
      }],
    },
  }],
  disclaimer: "test",
};

function exception(overrides: Partial<ComplianceExceptionRecord> = {}): ComplianceExceptionRecord {
  return {
    id: "cex_1", orgId: "org_1", customerId: "cust_1", connectionId: "conn_1",
    controlKey: "sutra.aws.s3.public-access", findingFingerprint: "finding-one",
    status: "approved", effectiveStatus: "approved", ownerUserId: "usr_owner", ownerDisplayName: "Owner",
    requestedBy: "usr_requester", requestedByDisplayName: "Requester", reviewedBy: "usr_reviewer",
    reviewedByDisplayName: "Reviewer", rationale: "Accepted for migration window",
    compensatingControl: "Alerts and restrictive network policy", reviewNote: "Approved",
    expiresAt: "2026-08-01T00:00:00.000Z", requestedAt: "2026-07-15T00:00:00.000Z",
    reviewedAt: "2026-07-15T01:00:00.000Z", revokedAt: null, updatedAt: "2026-07-15T01:00:00.000Z",
    ...overrides,
  };
}

test("approved unexpired exact exception changes FAIL to EXCEPTED, never PASS", () => {
  const result = applyComplianceExceptions(assessment, [exception()], Date.parse("2026-07-16T00:00:00.000Z"));
  assert.equal(result.results[0].status, "EXCEPTED");
  assert.equal(result.results[0].approvedExceptions[0].exceptionId, "cex_1");
  assert.deepEqual(result.summary, {
    total: 1, pass: 0, fail: 0, unknown: 0, notApplicable: 0, excepted: 1,
    scoredControls: 0, scorePercent: null,
  });
});

test("expired, pending, and mismatched exceptions do not change the control conclusion", () => {
  for (const candidate of [
    exception({ expiresAt: "2026-07-15T00:00:00.000Z" }),
    exception({ status: "pending", effectiveStatus: "pending" }),
    exception({ findingFingerprint: "different-finding" }),
  ]) {
    const result = applyComplianceExceptions(assessment, [candidate], Date.parse("2026-07-16T00:00:00.000Z"));
    assert.equal(result.results[0].status, "FAIL");
    assert.equal(result.summary.fail, 1);
  }
});
