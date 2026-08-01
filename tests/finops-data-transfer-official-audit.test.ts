import assert from "node:assert/strict";
import test from "node:test";
import { DATA_TRANSFER_OFFICIAL_AUDIT as audit } from "../lib/finops-data-transfer-official-audit.ts";

test("ADD-10 pins every public dashboard-specific artifact at the immutable commit", () => {
  assert.equal(audit.source.commit, "f9e36d88c47709f10e8fa784ad11d5cc0e728021");
  assert.equal(audit.source.manifestSha256, "85826c34fcd4f9f63599cdb257894eb4afa11bf014c903aad83427fc2704d698");
  assert.equal(audit.source.embeddedQuerySha256, "37c210858303233c2f328cb5484f0031756dff5281696da97715edba5bd954f9");
  assert.equal(audit.source.externalTemplateId, "data-transfer-aga-cost-analysis-template-enhanced-v6");
  assert.equal(audit.source.datasetIdentifier, "data_transfer_view");
  assert.equal(audit.publishedArtifacts.manifest.published, true);
  assert.equal(audit.publishedArtifacts.query.published, true);
});

test("ADD-10 leaves every exact QuickSight object total null when the definition is unpublished", () => {
  assert.deepEqual(audit.publishedArtifacts.quickSightDefinition, {
    published: false,
    path: null,
    sha256: null,
  });
  assert.deepEqual(audit.publishedArtifacts.templateBody, {
    published: false,
    path: null,
    sha256: null,
  });
  assert.deepEqual(audit.publishedArtifacts.changelog, {
    published: false,
    path: null,
    sha256: null,
  });
  for (const total of Object.values(audit.exactObjectTotals)) assert.equal(total, null);
  assert.deepEqual(audit.documentedControlPurposes, []);
  assert.equal(audit.controlPurposeEvidence, "NOT_ENUMERATED_BY_GUIDANCE_OR_PUBLIC_ARTIFACT");
});

test("ADD-10 maps only the five purposes documented by current AWS guidance", () => {
  assert.deepEqual(audit.documentedVisualPurposes.map((item) => item.purpose), [
    "Data Transfer Summary",
    "Internet data transfer and AWS Global Accelerator cost estimation details",
    "Regional data transfer details",
    "Data transfer Availability Zone details",
    "CloudFront cost and usage analysis",
  ]);
  for (const item of audit.documentedVisualPurposes) {
    assert.equal(item.coverage, "NATIVE_PURPOSE_COVERED");
    assert.ok(item.nativeEvidence.length > 40);
    assert.ok(item.remainingGap.length > 40);
  }
  assert.equal(audit.publicDatasetFields.length, 28);
  assert.match(audit.disclosures.join(" "), /not proof of five QuickSight visual objects/iu);
  assert.match(audit.disclosures.join(" "), /rematerialization/iu);
});
