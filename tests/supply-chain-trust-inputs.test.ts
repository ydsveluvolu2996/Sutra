import assert from "node:assert/strict";
import test from "node:test";
import { evidenceToArtifact } from "../lib/supply-chain-trust-inputs.ts";
import { verifySupplyChainTrust } from "../lib/supply-chain-verification.ts";
import type { KubernetesSupplyChainEvidence } from "../lib/kubernetes-supply-chain.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;

function evidence(over: {
  signature?: Partial<KubernetesSupplyChainEvidence["signature"]>;
  provenance?: Partial<KubernetesSupplyChainEvidence["provenance"]>;
} = {}): KubernetesSupplyChainEvidence {
  return {
    image: { repository: "acct.dkr.ecr.ap-south-1.amazonaws.com/payments", digest: DIGEST, tag: "v1" },
    signature: { state: "verified", issuer: "https://token.actions.githubusercontent.com", subject: "repo:acme/payments", transparencyLogVerified: true, ...over.signature },
    provenance: { state: "verified", builderId: "https://github.com/acme/build/.github/workflows/release.yml", sourceRepository: "https://github.com/acme/payments", commitSha: "c".repeat(40), ...over.provenance },
  } as unknown as KubernetesSupplyChainEvidence;
}

test("a fully verified image maps to a verified/verified artifact and scores maximum trust", () => {
  const artifact = evidenceToArtifact(evidence(), "acme");
  assert.equal(artifact.imageDigest, DIGEST);
  assert.equal(artifact.signature?.present, true);
  assert.equal(artifact.signature?.verified, true);
  assert.equal(artifact.signature?.keyId, "https://token.actions.githubusercontent.com");
  const report = verifySupplyChainTrust({ artifacts: [artifact], vexStatements: [], vulnerabilities: [] });
  assert.equal(report.artifacts[0]?.signatureState, "verified");
  assert.equal(report.artifacts[0]?.provenanceState, "verified");
  assert.equal(report.artifacts[0]?.trustScore, 100);
});

test("not_configured maps to present=false (engine reports not_configured, not failed)", () => {
  const artifact = evidenceToArtifact(evidence({ signature: { state: "not_configured", issuer: null, subject: null, transparencyLogVerified: null } }));
  assert.equal(artifact.signature?.present, false);
  const report = verifySupplyChainTrust({ artifacts: [artifact], vexStatements: [], vulnerabilities: [] });
  assert.equal(report.artifacts[0]?.signatureState, "not_configured");
});

test("a failed signature maps to present=true, verified=false -> failed", () => {
  const artifact = evidenceToArtifact(evidence({ signature: { state: "failed", issuer: null, subject: null, transparencyLogVerified: null } }));
  assert.equal(artifact.signature?.present, true);
  assert.equal(artifact.signature?.verified, false);
  const report = verifySupplyChainTrust({ artifacts: [artifact], vexStatements: [], vulnerabilities: [] });
  assert.equal(report.artifacts[0]?.signatureState, "failed");
});
