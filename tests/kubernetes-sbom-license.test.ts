import assert from "node:assert/strict";
import test from "node:test";
import {
  SbomLicensePolicyError,
  evaluateSbomLicensePolicy,
  normalizeObservedLicenses,
  normalizeSbomLicensePolicy,
} from "../lib/kubernetes-sbom-license.ts";

test("normalizes exact observed identifiers without inferring license equivalence", () => {
  assert.deepEqual(
    normalizeObservedLicenses([{ id: "MIT" }, { id: "Apache-2.0" }, "MIT"]),
    ["Apache-2.0", "MIT"],
  );
  assert.throws(() => normalizeObservedLicenses(["MIT OR Apache-2.0"]), SbomLicensePolicyError);
});

test("license evaluation fails closed for denied, unknown, and non-allowlisted evidence", () => {
  const policy = normalizeSbomLicensePolicy({
    name: "Production policy",
    deniedLicenses: ["GPL-3.0-only"],
    allowedLicenses: ["Apache-2.0", "MIT"],
    requireIdentifiedLicense: true,
  });
  const evaluation = evaluateSbomLicensePolicy(policy, [
    { fingerprint: "a".repeat(64), name: "safe", version: "1", licenses: ["MIT"] },
    { fingerprint: "b".repeat(64), name: "denied", version: "2", licenses: ["GPL-3.0-only"] },
    { fingerprint: "c".repeat(64), name: "unknown", version: null, licenses: [] },
    { fingerprint: "d".repeat(64), name: "outside", version: "3", licenses: ["BSD-3-Clause"] },
  ]);
  assert.equal(evaluation.status, "fail");
  assert.deepEqual(evaluation.violations.map((item) => item.reason), [
    "DENIED_LICENSE", "UNIDENTIFIED_LICENSE", "NOT_IN_ALLOWLIST",
  ]);
  assert.equal(evaluation.claimBoundary, "OBSERVED_SBOM_LICENSE_METADATA_ONLY");
});

test("policy rejects overlapping lists and oversized evaluation input is explicit", () => {
  assert.throws(() => normalizeSbomLicensePolicy({
    name: "Conflicting policy",
    deniedLicenses: ["MIT"],
    allowedLicenses: ["mit"],
    requireIdentifiedLicense: false,
  }), SbomLicensePolicyError);
  const policy = normalizeSbomLicensePolicy({
    name: "Bounded policy",
    deniedLicenses: [],
    allowedLicenses: [],
    requireIdentifiedLicense: false,
  });
  const result = evaluateSbomLicensePolicy(policy, [
    { fingerprint: "a".repeat(64), name: "one", version: null, licenses: [] },
    { fingerprint: "b".repeat(64), name: "two", version: null, licenses: [] },
  ], 1);
  assert.equal(result.status, "fail");
  assert.equal(result.truncated, true);
});
