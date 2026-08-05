import assert from "node:assert/strict";
import test from "node:test";
import { AZURE_CID_OFFICIAL_DEFINITION as definition } from "../lib/finops-azure-cid-official-definition.ts";

test("ADD-02 pins the official Azure repository and published artifacts", () => {
  assert.equal(definition.cidFrameworkAudit.commit, "f9e36d88c47709f10e8fa784ad11d5cc0e728021");
  assert.equal(definition.cidFrameworkAudit.azureDashboardSpecificArtifactCount, 0);
  assert.equal(definition.sourceCommit, "ca870a82ce9e8fba4670af9a649df4074f931e02");
  assert.deepEqual(definition.artifacts.map((artifact) => [artifact.kind, artifact.sha256]), [
    ["README", "3d41c089cbf99c082504c01da029fcddcfc585a272af4b2e1e34ab3ede8c4b2f"],
    ["CLOUDFORMATION_TEMPLATE", "f91c63ab490f20df14434a14b945178f994ea3089fe9f07ae368b886b2e9dc00"],
    ["DASHBOARD_MANIFEST", "7da6faa098d8e56c3bc3620139e70c7a246f58df95281676a4afd734c5c52905"],
    ["EMBEDDED_SPICE_DATASET", "46ebf6e4750e4e22a266fcd49bb0f99a9d3a3b5cdbd184db320755bc49c057c9"],
    ["EMBEDDED_STANDARD_VIEW_QUERY", "77b6d8b0ceb69e95913c68bf2bb3ec00d6d751ae3ba6da8e3b2536f0bf74f3e5"],
    ["STANDARD_TRANSFORM", "1918596a83ba0a9a503d3a366531ffaf2520b1dd7b3c2a1426d02d45fb122b90"],
    ["FOCUS_1_0_TRANSFORM", "8633a21a72941e4ca7fd92c24a8793992b56c657c05c113b6ff6ce1852792be8"],
    ["STANDARD_QUERY", "3dad019cf030ec5cb8ffd2eabeba80b4168164676554eef5d10eaf37f6241b92"],
    ["FOCUS_QUERY", "c35561bd208984659be28ec06334ae35ba93de5b305c6306fe280b9d58f8f434"],
    ["FOCUS_QUERY", "27495242f53cb74ad2fce145165aec9e2ad56edf6197e17d1d89a120d4f7a6c5"],
    ["FOCUS_QUERY", "d7b1d6549abc13a7033766311895b9674ca5f5cb1dd66dc7855deaef85330fd9"],
  ]);
  assert.deepEqual(definition.publishedData, {
    manifestDatasetCount: 1,
    manifestDatasetInputColumnCount: 21,
    manifestEmbeddedViewCount: 1,
    standardTransformCount: 1,
    focusTransformCount: 1,
    standaloneStandardQueryCount: 1,
    standaloneFocusQueryCount: 3,
  });
});

test("ADD-02 keeps unpublished QuickSight object totals null", () => {
  assert.equal(definition.templateId, "cid-azure-cost");
  assert.equal(definition.quickSightDefinition.publishedInRepository, false);
  for (const key of ["sheetCount", "visualCount", "parameterControlCount", "filterControlCount", "parameterCount", "calculatedFieldCount", "filterGroupCount"] as const) {
    assert.equal(definition.quickSightDefinition[key], null, key);
  }
  assert.equal(definition.unavailableArtifacts.quickSightDefinitionPath, null);
  assert.equal(definition.unavailableArtifacts.changelogPath, null);
  assert.equal(definition.quickSightDefinition.pixelParityClaimed, false);
});

test("ADD-02 maps documented purposes without inventing provider evidence", () => {
  assert.deepEqual(definition.documentedAreas.map((area) => [area.name, area.nativeCoverage]), [
    ["Azure cost visualizations and reports", "PARTIAL"],
    ["Recurring Azure cost export", "PROVIDER_GAP"],
    ["Transformation and tag normalization", "PARTIAL"],
    ["Six-month Athena and SPICE scope", "SUPPORTED"],
    ["Detailed resource analysis", "PARTIAL"],
  ]);
  assert.match(definition.documentedAreas[1]?.remainingGap ?? "", /live Azure identity/iu);
  assert.match(definition.limitations.join(" "), /no Azure credential/iu);
  assert.match(definition.limitations.join(" "), /not realized savings/u);
});
