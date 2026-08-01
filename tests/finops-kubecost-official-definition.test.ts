import assert from "node:assert/strict";
import test from "node:test";
import { KUBECOST_OFFICIAL_DEFINITION as definition } from "../lib/finops-kubecost-official-definition.ts";

test("ADD-06 pins the official repositories and every published source artifact", () => {
  assert.equal(definition.cidFrameworkAudit.commit, "f9e36d88c47709f10e8fa784ad11d5cc0e728021");
  assert.equal(definition.cidFrameworkAudit.kubecostDashboardSpecificArtifactCount, 0);
  assert.equal(definition.sourceCommit, "8a581332a70ae55d53464e52a0bb8b3dd64cb425");
  assert.deepEqual(definition.artifacts.map((artifact) => [artifact.kind, artifact.sha256]), [
    ["CID_CMD_MANIFEST", "2bde67113c8f585d13fc43fe537c3bee3eecf3a416b81cd0f57295226b4ed45b"],
    ["EMBEDDED_SPICE_DATASET", "3cd36937146500be79d7cfe3f6fa78012f999378dd9729ec17a300888c7962a6"],
    ["EXTRACTED_ATHENA_VIEW_QUERY", "2a5db62703b857a19d56a50661e5a20be4d02776aad3d1065422c7bab8b2e07c"],
    ["TERRAFORM_ROOT_TEMPLATE", "44761c0335e9b87b1280473e90cc233a77d57a64ea9163df1d24d220c43f414a"],
    ["TERRAFORM_PIPELINE_TEMPLATE", "0d2aa8d88a021763a24e5939682b90f8be32763c272db149ac9682458463018c"],
    ["HELM_EXPORTER_CRON_TEMPLATE", "0d87ae307676a0fec9db1a774028b318bf9940f22e58deddb26a88a074a3d163"],
    ["KUBECOST_S3_EXPORTER", "48f44e9147ed57fa2252a6867473fac82fd362b612fe59041b8dc9f4df81fdf3"],
    ["UPDATE_INSTRUCTIONS", "f8cc13ac9d922c3063d74dd2d742faaa4267dd6301ca35043e97f9df3ca390fa"],
  ]);
  assert.deepEqual(definition.publishedData, {
    datasetCount: 1,
    datasetName: "cca_kubecost_view",
    inputColumnCount: 62,
    cidManifestViewCount: 0,
    terraformAthenaViewQueryCount: 1,
  });
});

test("ADD-06 keeps unpublished QuickSight object totals null", () => {
  assert.equal(definition.quickSightDefinition.publishedInRepository, false);
  assert.equal(definition.quickSightDefinition.serviceHostedTemplate, true);
  for (const key of ["sheetCount", "visualCount", "parameterControlCount", "filterControlCount", "parameterCount", "calculatedFieldCount", "filterGroupCount"] as const) {
    assert.equal(definition.quickSightDefinition[key], null, key);
  }
  assert.equal(definition.quickSightDefinition.pixelParityClaimed, false);
  assert.equal(definition.unavailableArtifacts.quickSightDefinitionPath, null);
  assert.equal(definition.unavailableArtifacts.changelogPath, null);
});

test("ADD-06 maps only AWS-documented purposes and isolates supplemental OpenCost", () => {
  assert.deepEqual(definition.documentedAreas.map((area) => [area.name, area.nativeCoverage]), [
    ["Executive Summary", "PARTIAL"],
    ["Workloads Explorer", "PARTIAL"],
    ["EKS Breakdown", "PARTIAL"],
  ]);
  assert.equal(definition.documentedControlTitles, null);
  assert.match(definition.documentedAreas[2]?.remainingGap ?? "", /node capacity type or instance type/u);
  assert.equal(definition.supplementalOpenCost.supportedByOfficialAwsDashboard, false);
  assert.equal(definition.supplementalOpenCost.designation, "SUPPLEMENTAL_NOT_AWS_DASHBOARD_PARITY");
  assert.match(definition.supplementalOpenCost.disclosure, /never counted as official Kubecost dashboard coverage/u);
});
