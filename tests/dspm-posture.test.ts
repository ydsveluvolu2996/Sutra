import assert from "node:assert/strict";
import test from "node:test";
import {
  DspmInputError,
  assessDspmAsset,
  dspmEvidenceSha256,
  parseDspmPublishRequest,
} from "../lib/dspm-posture.ts";

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connectionId: `conn_${"a".repeat(32)}`,
    source: "aws-macie",
    idempotencyKey: "macie-2026-07-30T00:00Z",
    collectedAt: "2026-07-30T00:00:00.000Z",
    coverage: {
      status: "COMPLETE",
      resourcesDiscovered: 1,
      resourcesClassified: 1,
      limitations: [],
    },
    assets: [{
      resourceKey: "arn:aws:s3:::customer-records",
      resourceType: "s3-bucket",
      region: "ap-south-1",
      classification: "restricted",
      categories: ["personal", "payment-card"],
      ownerRef: "data-platform",
      encrypted: true,
      publicAccess: true,
      crossAccountAccess: false,
      externalSharing: false,
      credentialsDetected: false,
      dataSizeBytes: 1024,
    }],
    ...overrides,
  };
}

test("strictly parses normalized metadata and produces stable evidence digests", async () => {
  const now = Date.parse("2026-07-30T01:00:00.000Z");
  const first = parseDspmPublishRequest(request(), now);
  const second = parseDspmPublishRequest(request(), now);
  assert.equal(first.coverage.status, "COMPLETE");
  assert.deepEqual(first.assets[0]?.categories, ["payment-card", "personal"]);
  assert.equal(await dspmEvidenceSha256(first), await dspmEvidenceSha256(second));
});

test("rejects unknown keys so scanner samples and matched values cannot be persisted", () => {
  const raw = request();
  raw.assets = [{ ...(raw.assets as Record<string, unknown>[])[0], matchedValue: "4111111111111111" }];
  assert.throws(
    () => parseDspmPublishRequest(raw, Date.parse("2026-07-30T01:00:00.000Z")),
    (error) => error instanceof DspmInputError && error.code === "INVALID_INPUT",
  );
});

test("rejects dishonest complete coverage and duplicate resource evidence", () => {
  assert.throws(() => parseDspmPublishRequest(request({
    coverage: {
      status: "COMPLETE",
      resourcesDiscovered: 1,
      resourcesClassified: 1,
      limitations: ["CLASSIFICATION_PARTIAL"],
    },
  }), Date.parse("2026-07-30T01:00:00.000Z")));
  const raw = request();
  raw.assets = [structuredClone((raw.assets as unknown[])[0]), structuredClone((raw.assets as unknown[])[0])];
  raw.coverage = { status: "PARTIAL", resourcesDiscovered: 2, resourcesClassified: 2, limitations: ["ACCESS_EVIDENCE_PARTIAL"] };
  assert.throws(() => parseDspmPublishRequest(raw, Date.parse("2026-07-30T01:00:00.000Z")));
});

test("risk scoring is deterministic, capped and explainable", () => {
  const asset = parseDspmPublishRequest(request(), Date.parse("2026-07-30T01:00:00.000Z")).assets[0]!;
  const risk = assessDspmAsset({
    ...asset,
    encrypted: false,
    crossAccountAccess: true,
    externalSharing: true,
    credentialsDetected: true,
  });
  assert.equal(risk.score, 100);
  assert.equal(risk.severity, "critical");
  assert.equal(risk.title, "Sensitive data store has public access");
  assert.ok(risk.factors.includes("public-access"));
  assert.ok(risk.factors.includes("credentials-detected"));
  assert.ok(risk.recommendations.some((entry) => entry.includes("Rotate")));
});

test("rejects a future timestamp that could pin the current evidence head", () => {
  assert.throws(() => parseDspmPublishRequest(
    request({ collectedAt: "2026-07-31T00:00:00.000Z" }),
    Date.parse("2026-07-30T00:00:00.000Z"),
  ));
});
