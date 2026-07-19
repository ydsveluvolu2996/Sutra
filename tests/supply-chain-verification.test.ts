import assert from "node:assert/strict";
import test from "node:test";
import {
  applyVex,
  verifySupplyChainTrust,
  type ArtifactInput,
  type VexStatement,
  type VexVulnerability,
} from "../lib/supply-chain-verification.ts";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

function artifact(over: Partial<ArtifactInput> = {}): ArtifactInput {
  return { imageDigest: DIGEST_A, ...over };
}

function verifyOne(over: Partial<ArtifactInput> = {}) {
  const report = verifySupplyChainTrust({ artifacts: [artifact(over)], vexStatements: [], vulnerabilities: [] });
  const only = report.artifacts[0];
  assert.ok(only !== undefined);
  return only;
}

function vulnerability(over: Partial<VexVulnerability> = {}): VexVulnerability {
  return { cveId: "CVE-2024-0001", imageDigest: DIGEST_A, ...over };
}

function vex(over: Partial<VexStatement> = {}): VexStatement {
  return {
    vulnId: "CVE-2024-0001",
    productDigest: DIGEST_A,
    status: "not_affected",
    justification: "vulnerable path not present",
    ...over,
  };
}

test("a fully attested artifact is verified on both axes with a maximum trust score", () => {
  const result = verifyOne({
    tenant: "acme",
    signature: { present: true, verified: true, keyId: "cosign-key-1" },
    provenance: { present: true, verified: true, slsaLevel: 3, builderId: "gha://build/42" },
  });
  assert.equal(result.signatureState, "verified");
  assert.equal(result.provenanceState, "verified");
  assert.equal(result.trustScore, 100);
  assert.equal(result.tenant, "acme");
  assert.equal(result.signature.verified, true);
  assert.equal(result.signature.keyId, "cosign-key-1");
  assert.equal(result.provenance.slsaLevel, 3);
  assert.equal(result.provenance.builderId, "gha://build/42");
});

test("verified requires supporting evidence: a verified signature without a keyId fails", () => {
  const result = verifyOne({ signature: { present: true, verified: true } });
  assert.equal(result.signatureState, "failed");
  assert.equal(result.signature.keyId, null);
  assert.match(result.rationale.join(" "), /keyId is absent/u);
});

test("verified requires supporting evidence: a verified provenance without a builderId fails", () => {
  const result = verifyOne({ provenance: { present: true, verified: true, slsaLevel: 4 } });
  assert.equal(result.provenanceState, "failed");
  assert.equal(result.provenance.builderId, null);
  assert.equal(result.provenance.slsaLevel, 4);
  assert.match(result.rationale.join(" "), /builderId is absent/u);
});

test("a whitespace-only keyId does not count as supporting evidence", () => {
  const result = verifyOne({ signature: { present: true, verified: true, keyId: "   " } });
  assert.equal(result.signatureState, "failed");
  assert.equal(result.signature.keyId, null);
});

test("absent signature and provenance blocks are not_configured, never failed", () => {
  const result = verifyOne();
  assert.equal(result.signatureState, "not_configured");
  assert.equal(result.provenanceState, "not_configured");
  assert.equal(result.signature.present, false);
  assert.equal(result.signature.verified, null);
  assert.equal(result.provenance.verified, null);
  assert.equal(result.provenance.slsaLevel, null);
});

test("an evidence block reporting present=false is not_configured, never failed", () => {
  const result = verifyOne({ signature: { present: false }, provenance: { present: false } });
  assert.equal(result.signatureState, "not_configured");
  assert.equal(result.provenanceState, "not_configured");
});

test("a present-but-unverified block is failed for both an explicit false and a missing result", () => {
  const explicitFalse = verifyOne({ signature: { present: true, verified: false, keyId: "k" } });
  assert.equal(explicitFalse.signatureState, "failed");

  const missingResult = verifyOne({ provenance: { present: true, builderId: "b" } });
  assert.equal(missingResult.provenanceState, "failed");
  assert.equal(missingResult.provenance.verified, null);
});

test("trust score composes the two axes and is deterministic", () => {
  const verifiedSigOnly = () =>
    verifyOne({ signature: { present: true, verified: true, keyId: "k" }, provenance: { present: false } });
  // verified signature (55) + not_configured provenance (12)
  assert.equal(verifiedSigOnly().trustScore, 67);
  assert.deepEqual(verifiedSigOnly(), verifiedSigOnly());

  const failedSigVerifiedProv = verifyOne({
    signature: { present: true, verified: false },
    provenance: { present: true, verified: true, builderId: "b" },
  });
  // failed signature (0) + verified provenance (45)
  assert.equal(failedSigVerifiedProv.trustScore, 45);
});

test("trust score boundaries: both failed is 0, both verified is 100, and absent sits between", () => {
  const bothFailed = verifyOne({
    signature: { present: true, verified: false },
    provenance: { present: true, verified: false },
  });
  assert.equal(bothFailed.trustScore, 0);

  const bothVerified = verifyOne({
    signature: { present: true, verified: true, keyId: "k" },
    provenance: { present: true, verified: true, builderId: "b" },
  });
  assert.equal(bothVerified.trustScore, 100);

  const bothAbsent = verifyOne();
  assert.ok(bothAbsent.trustScore > bothFailed.trustScore);
  assert.ok(bothAbsent.trustScore < bothVerified.trustScore);
});

test("tenant scope is carried through when present and normalized to null when absent", () => {
  assert.equal(verifyOne({ tenant: "tenant-42" }).tenant, "tenant-42");
  assert.equal(verifyOne().tenant, null);
  assert.equal(verifyOne({ tenant: null }).tenant, null);
});

test("VEX not_affected with a justification suppresses the matching vulnerability", () => {
  const result = applyVex(
    [vulnerability()],
    [vex({ status: "not_affected", justification: "component not compiled in" })],
  );
  assert.equal(result.active.length, 0);
  assert.equal(result.rejectedVex.length, 0);
  assert.deepEqual(result.suppressed, [
    {
      cveId: "CVE-2024-0001",
      imageDigest: DIGEST_A,
      reason: "vex:not_affected",
      justification: "component not compiled in",
    },
  ]);
});

test("VEX fixed with a justification suppresses with reason vex:fixed", () => {
  const result = applyVex([vulnerability()], [vex({ status: "fixed", justification: "patched in 1.2.3" })]);
  assert.equal(result.active.length, 0);
  assert.equal(result.suppressed.length, 1);
  assert.equal(result.suppressed[0]?.reason, "vex:fixed");
});

test("VEX without a justification does not suppress and is recorded as rejected", () => {
  const result = applyVex([vulnerability()], [vex({ status: "not_affected", justification: undefined })]);
  assert.equal(result.suppressed.length, 0);
  assert.deepEqual(result.active, [{ cveId: "CVE-2024-0001", imageDigest: DIGEST_A }]);
  assert.deepEqual(result.rejectedVex, [
    { cveId: "CVE-2024-0001", imageDigest: DIGEST_A, status: "not_affected", reason: "vex-without-justification" },
  ]);
});

test("a whitespace-only justification is treated as missing and rejected", () => {
  const result = applyVex([vulnerability()], [vex({ status: "fixed", justification: "   " })]);
  assert.equal(result.active.length, 1);
  assert.equal(result.suppressed.length, 0);
  assert.equal(result.rejectedVex[0]?.status, "fixed");
});

test("affected never suppresses, even with a justification, and is not rejected", () => {
  const result = applyVex([vulnerability()], [vex({ status: "affected", justification: "confirmed exploitable" })]);
  assert.equal(result.active.length, 1);
  assert.equal(result.suppressed.length, 0);
  assert.equal(result.rejectedVex.length, 0);
});

test("under_investigation never suppresses and is not rejected", () => {
  const result = applyVex([vulnerability()], [vex({ status: "under_investigation", justification: "triaging" })]);
  assert.equal(result.active.length, 1);
  assert.equal(result.suppressed.length, 0);
  assert.equal(result.rejectedVex.length, 0);
});

test("a VEX statement only applies when both vulnId and productDigest match", () => {
  const wrongDigest = applyVex([vulnerability()], [vex({ productDigest: DIGEST_B })]);
  assert.equal(wrongDigest.active.length, 1);
  assert.equal(wrongDigest.suppressed.length, 0);
  assert.equal(wrongDigest.rejectedVex.length, 0);

  const wrongVuln = applyVex([vulnerability()], [vex({ vulnId: "CVE-2024-9999" })]);
  assert.equal(wrongVuln.active.length, 1);
  assert.equal(wrongVuln.suppressed.length, 0);
});

test("a justified suppressor wins over an unjustified statement for the same vulnerability", () => {
  const result = applyVex(
    [vulnerability()],
    [
      vex({ status: "not_affected", justification: undefined }),
      vex({ status: "fixed", justification: "patched" }),
    ],
  );
  assert.equal(result.active.length, 0);
  assert.equal(result.rejectedVex.length, 0);
  assert.equal(result.suppressed.length, 1);
  assert.equal(result.suppressed[0]?.reason, "vex:fixed");
});

test("a suppressing VEX that matches no vulnerability produces no suppression or rejection", () => {
  const result = applyVex([], [vex({ status: "not_affected", justification: undefined })]);
  assert.deepEqual(result, { active: [], suppressed: [], rejectedVex: [] });
});

test("verifySupplyChainTrust aggregates artifact states, VEX outcomes, and honesty metadata", () => {
  const report = verifySupplyChainTrust({
    artifacts: [
      artifact({
        imageDigest: DIGEST_A,
        signature: { present: true, verified: true, keyId: "k" },
        provenance: { present: false },
      }),
      artifact({ imageDigest: DIGEST_B, signature: { present: true, verified: false } }),
    ],
    vexStatements: [
      vex({ vulnId: "CVE-1", productDigest: DIGEST_A, status: "not_affected", justification: "not reachable" }),
      vex({ vulnId: "CVE-2", productDigest: DIGEST_A, status: "fixed", justification: undefined }),
    ],
    vulnerabilities: [
      { cveId: "CVE-1", imageDigest: DIGEST_A },
      { cveId: "CVE-2", imageDigest: DIGEST_A },
      { cveId: "CVE-3", imageDigest: DIGEST_B },
    ],
  });

  assert.equal(report.schema, "sutra.supply-chain-verification.v1");
  assert.equal(report.totals.artifacts, 2);
  assert.equal(report.totals.signatureVerified, 1);
  assert.equal(report.totals.signatureFailed, 1);
  assert.equal(report.totals.signatureNotConfigured, 0);
  assert.equal(report.totals.provenanceNotConfigured, 2);
  assert.equal(report.totals.vulnerabilitiesSuppressed, 1);
  assert.equal(report.totals.vulnerabilitiesActive, 2);
  assert.equal(report.totals.vexRejected, 1);
  assert.equal(report.claimBoundary, "SUBMITTED_ATTESTATION_AND_VEX_METADATA_ONLY");
  assert.equal(report.limitations.length, 3);
  assert.match(report.limitations.join(" "), /DOES_NOT_ESTABLISH_SOURCE_CODE_SAFETY/u);
});

test("empty input yields empty outputs and zeroed totals", () => {
  const report = verifySupplyChainTrust({ artifacts: [], vexStatements: [], vulnerabilities: [] });
  assert.deepEqual(report.artifacts, []);
  assert.deepEqual(report.vex, { active: [], suppressed: [], rejectedVex: [] });
  assert.deepEqual(report.totals, {
    artifacts: 0,
    signatureVerified: 0,
    signatureFailed: 0,
    signatureNotConfigured: 0,
    provenanceVerified: 0,
    provenanceFailed: 0,
    provenanceNotConfigured: 0,
    vulnerabilitiesActive: 0,
    vulnerabilitiesSuppressed: 0,
    vexRejected: 0,
  });
});

test("the full report is deterministic for identical input", () => {
  const build = () =>
    verifySupplyChainTrust({
      artifacts: [artifact({ signature: { present: true, verified: true, keyId: "k" } })],
      vexStatements: [vex({ justification: "not reachable" })],
      vulnerabilities: [vulnerability()],
    });
  assert.deepEqual(build(), build());
});
