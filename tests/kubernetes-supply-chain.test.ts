import assert from "node:assert/strict";
import test from "node:test";

import {
  KubernetesSupplyChainEvidenceError,
  normalizeKubernetesSupplyChainEvidence,
} from "../lib/kubernetes-supply-chain.ts";

const evidence = {
  image: {
    repository: "505060607080.dkr.ecr.ap-south-1.amazonaws.com/sutra-demo",
    digest: `sha256:${"a".repeat(64)}`,
    tag: "verified-demo",
  },
  vulnerabilityScan: {
    scannerVersion: "0.69.3",
    scannedAt: "2026-07-17T08:40:00.000Z",
    critical: 1,
    high: 3,
    medium: 5,
    low: 2,
    unknown: 0,
    fixedAvailable: 7,
    rawResults: [{ package: "must-not-survive" }],
  },
  sbom: {
    format: "CycloneDX",
    componentCount: 111,
    documentSha256: "b".repeat(64),
    components: [{ name: "must-not-survive" }],
  },
  signature: {
    state: "verified",
    issuer: "https://token.actions.githubusercontent.com",
    subject: "https://github.com/example-org/sutra/.github/workflows/security.yml@refs/heads/main",
    transparencyLogVerified: true,
    certificate: "must-not-survive",
  },
  provenance: {
    state: "verified",
    builderId: "https://github.com/actions/runner",
    sourceRepository: "https://github.com/example-org/sutra",
    commitSha: "c".repeat(40),
    statement: "must-not-survive",
  },
} as const;

test("normalizes digest-bound scanner, SBOM, signature and provenance evidence", async () => {
  const normalized = await normalizeKubernetesSupplyChainEvidence({
    clusterId: "505060607080:ap-south-1:sutra-validation",
    collectedAt: "2026-07-17T08:45:00.000Z",
    evidence,
  });

  assert.equal(normalized.image.digest, evidence.image.digest);
  assert.equal(normalized.sbom?.componentCount, 111);
  assert.equal(normalized.signature.state, "verified");
  assert.equal(normalized.priority.rating, "medium");
  assert.match(normalized.evidenceSha256, /^[a-f0-9]{64}$/u);
  const serialized = JSON.stringify(normalized);
  assert.equal(serialized.includes("rawResults"), false);
  assert.equal(serialized.includes("components"), false);
  assert.equal(serialized.includes("certificate"), false);
  assert.equal(serialized.includes("statement"), false);
});

test("raises contextual priority for vulnerable unsigned images without provenance", async () => {
  const normalized = await normalizeKubernetesSupplyChainEvidence({
    clusterId: "sutra-validation",
    collectedAt: "2026-07-17T08:45:00.000Z",
    evidence: {
      ...evidence,
      sbom: null,
      signature: { state: "failed", issuer: null, subject: null, transparencyLogVerified: false },
      provenance: { state: "not_configured", builderId: null, sourceRepository: null, commitSha: null },
      vulnerabilityScan: { ...evidence.vulnerabilityScan, critical: 8, high: 20, fixedAvailable: 15 },
    },
  });

  assert.equal(normalized.priority.rating, "critical");
  assert.equal(normalized.priority.score, 100);
  assert.ok(normalized.priority.factors.some((factor) => factor.includes("signature verification failed")));
  assert.ok(normalized.priority.factors.includes("no SBOM evidence"));
});

test("rejects mutable identity, false verified claims and invalid counts", async () => {
  await assert.rejects(
    normalizeKubernetesSupplyChainEvidence({
      clusterId: "sutra-validation",
      collectedAt: "2026-07-17T08:45:00.000Z",
      evidence: { ...evidence, image: { ...evidence.image, digest: "latest" } },
    }),
    KubernetesSupplyChainEvidenceError,
  );
  await assert.rejects(
    normalizeKubernetesSupplyChainEvidence({
      clusterId: "sutra-validation",
      collectedAt: "2026-07-17T08:45:00.000Z",
      evidence: {
        ...evidence,
        signature: { state: "verified", issuer: null, subject: null, transparencyLogVerified: false },
      },
    }),
    KubernetesSupplyChainEvidenceError,
  );
  await assert.rejects(
    normalizeKubernetesSupplyChainEvidence({
      clusterId: "sutra-validation",
      collectedAt: "2026-07-17T08:45:00.000Z",
      evidence: {
        ...evidence,
        vulnerabilityScan: { ...evidence.vulnerabilityScan, critical: -1 },
      },
    }),
    KubernetesSupplyChainEvidenceError,
  );
});
