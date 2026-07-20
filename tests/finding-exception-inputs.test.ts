import assert from "node:assert/strict";
import test from "node:test";
import {
  findingToEngineFinding,
  msToDays,
  storedExceptionToEngineException,
} from "../lib/finding-exception-inputs.ts";
import { applyFindingExceptions } from "../lib/finding-exceptions.ts";
import type { StoredFindingException } from "../db/finding-exception-repository.ts";

const DAY_MS = 86_400_000;

function stored(over: Partial<StoredFindingException> = {}): StoredFindingException {
  return {
    id: "fexc_" + "a".repeat(32),
    ruleId: "aws.s3.block-public-access",
    resourceRef: null,
    justification: "accepted risk for the logs bucket",
    approvedBy: "op@sutra.dev",
    status: "active",
    createdAtMs: 10 * DAY_MS,
    expiresAtMs: null,
    ...over,
  };
}

test("a finding maps to the engine shape with its customer as tenant", () => {
  const finding = findingToEngineFinding(
    { fingerprint: "fp1", controlKey: "aws.s3.block-public-access", resourceKey: "aws:s3:bucket:logs", severity: "high" },
    "cust_a",
  );
  assert.deepEqual(finding, { id: "fp1", ruleId: "aws.s3.block-public-access", resourceRef: "aws:s3:bucket:logs", severity: "high", tenant: "cust_a" });
});

test("informational severity maps to low and a null resource key becomes an empty ref", () => {
  const finding = findingToEngineFinding(
    { fingerprint: "fp2", controlKey: "aws.iam.x", resourceKey: null, severity: "informational" },
    "cust_a",
  );
  assert.equal(finding.severity, "low");
  assert.equal(finding.resourceRef, "");
});

test("only set scope fields are emitted; ms timestamps convert to whole day counts", () => {
  const ruleOnly = storedExceptionToEngineException(stored({ resourceRef: null }));
  assert.deepEqual(ruleOnly.scope, { ruleId: "aws.s3.block-public-access" });
  assert.equal(ruleOnly.createdAtDays, 10);
  assert.equal(ruleOnly.expiresAtDays, null);

  // expiresAtDays is a count relative to createdAtDays (day 14 minus day 10 = 4).
  const withExpiry = storedExceptionToEngineException(stored({ createdAtMs: 10 * DAY_MS, expiresAtMs: 14 * DAY_MS }));
  assert.equal(withExpiry.expiresAtDays, 4);
});

test("mapped rules suppress matching findings end-to-end through the engine", () => {
  const now = 12 * DAY_MS;
  const findings = [
    findingToEngineFinding({ fingerprint: "fp1", controlKey: "aws.s3.block-public-access", resourceKey: "aws:s3:bucket:logs", severity: "high" }, "cust_a"),
    findingToEngineFinding({ fingerprint: "fp2", controlKey: "aws.iam.mfa", resourceKey: "aws:iam:user:root", severity: "critical" }, "cust_a"),
  ];
  const report = applyFindingExceptions(
    findings,
    [storedExceptionToEngineException(stored({ ruleId: "aws.s3.block-public-access", resourceRef: null }))],
    msToDays(now),
  );
  assert.equal(report.summary.suppressed, 1);
  assert.equal(report.suppressed[0]?.finding.id, "fp1");
  assert.equal(report.active[0]?.id, "fp2");
});

test("an expired mapped rule leaves its finding active (honest, not silently dropped)", () => {
  const findings = [findingToEngineFinding({ fingerprint: "fp1", controlKey: "aws.s3.block-public-access", resourceKey: null, severity: "high" }, "cust_a")];
  // Created day 10, expires 4 days later (day 14); at day 20 it has expired.
  const report = applyFindingExceptions(
    findings,
    [storedExceptionToEngineException(stored({ createdAtMs: 10 * DAY_MS, expiresAtMs: 14 * DAY_MS }))],
    20,
  );
  assert.equal(report.summary.suppressed, 0);
  assert.equal(report.summary.expiredExceptions, 1);
  assert.equal(report.active[0]?.id, "fp1");
});
