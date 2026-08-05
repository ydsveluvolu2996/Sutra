import assert from "node:assert/strict";
import test from "node:test";
import { DATA_COLLECTION_MONITOR_OFFICIAL_DEFINITION as definition } from "../lib/finops-data-collection-monitor-official-definition.ts";

test("ADV-12 pins every published Data Collection Monitor artifact at the immutable commit", () => {
  assert.equal(definition.sourceRepository, "https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework");
  assert.equal(definition.sourceCommit, "f9e36d88c47709f10e8fa784ad11d5cc0e728021");
  assert.equal(definition.manifestPath, "dashboards/data-collection-monitor/data-collection-monitor.yaml");
  assert.equal(definition.manifestSha256, "20412bfd4552f844d866e95ebeb9e42b7586ead1df82ef6da7d97234477d8a29");
  assert.equal(definition.completeDefinitionPublished, true);
  assert.equal(definition.standaloneDefinitionPath, null);
  assert.equal(definition.changelogPath, null);
  assert.equal(definition.dashboardSpecificDeploymentTemplatePath, null);
  assert.deepEqual(definition.artifacts.map((artifact) => [artifact.kind, artifact.sha256]), [
    ["MANIFEST_CONTAINER", "20412bfd4552f844d866e95ebeb9e42b7586ead1df82ef6da7d97234477d8a29"],
    ["EMBEDDED_QUICKSIGHT_DEFINITION", "0d4f19541870585d84e1df8ec2ac9bfbed5f42199c6d19fbe6c3104fa2f3e943"],
    ["EMBEDDED_DATASET_TEMPLATE", "6e225a65e7c31a9337b8dc66256c5ab84a7035a0a863664e087c5c3956fadc10"],
    ["EMBEDDED_SQL_VIEW_QUERY", "0bc9ff20a740dc1e2085e801443ede197f2b8c400ec92824f082fa1e07e0e6c9"],
  ]);
  assert.equal(definition.dashboardId, "dc-monitor");
  assert.equal(definition.version, "v1.0.1");
});

test("ADV-12 preserves the exact embedded QuickSight object inventory", () => {
  assert.deepEqual(definition.totals, {
    sheets: 2,
    visuals: 10,
    parameterControls: 4,
    filterControls: 2,
    parameterDeclarations: 5,
    calculatedFields: 21,
    filterGroups: 15,
    columnConfigurations: 1,
    datasets: 1,
  });
  assert.deepEqual(definition.visualTypes, {
    BarChartVisual: 2,
    TableVisual: 4,
    KPIVisual: 3,
    PivotTableVisual: 1,
  });
  assert.deepEqual(definition.sheets.map((sheet) => [sheet.name, sheet.visualCount]), [
    ["Main", 10],
    ["About", 0],
  ]);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.visualCount, 0), 10);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.controls.filter((item) => item.placement === "parameter").length, 0), 4);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.controls.filter((item) => item.placement === "filter").length, 0), 2);
  assert.deepEqual(definition.parameterNames, [
    "DaysWindow",
    "AccountID",
    "StatuscodeFamily",
    "StatusCodeBinary",
    "LogLinksMode",
  ]);
});

test("ADV-12 maps exact Main control placements without weakening tenant boundaries", () => {
  const main = definition.sheets.find((sheet) => sheet.name === "Main");
  assert.deepEqual(main?.controls.map((item) => [item.placement, item.type, item.title, item.nativeState]), [
    ["parameter", "List", "Status Category", "SUPPORTED"],
    ["parameter", "List", "Log Links Mode", "SUPPORTED"],
    ["parameter", "Dropdown", "Account ID", "SERVER_PINNED"],
    ["parameter", "Slider", "Days back", "SUPPORTED"],
    ["filter", "Dropdown", "Module", "SUPPORTED"],
    ["filter", "Dropdown", "Payer ID", "SERVER_PINNED"],
  ]);
  assert.match(main?.remainingGap ?? "", /server-pinned/u);
  assert.match(main?.remainingGap ?? "", /Lambda log links/u);
  assert.match(definition.sheets[1]?.remainingGap ?? "", /no screenshot/u);
});
