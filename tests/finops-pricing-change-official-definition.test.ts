import assert from "node:assert/strict";
import test from "node:test";
import { PRICING_CHANGE_OFFICIAL_DEFINITION as definition } from "../lib/finops-pricing-change-official-definition.ts";

test("ADD-13 pins every published Pricing Change Analysis artifact", () => {
  assert.equal(definition.source.commit, "f9e36d88c47709f10e8fa784ad11d5cc0e728021");
  assert.equal(definition.source.manifestPath, "dashboards/pca/pca.yaml");
  assert.equal(definition.source.dashboardId, "pricing-change-analysis");
  assert.equal(definition.source.version, "v1.1.0");
  assert.equal(definition.source.changelogVersion, "v1.0.1");
  assert.equal(definition.source.guidanceCategory, "Additional");
  assert.equal(definition.source.manifestCategory, "ADVANCED");
  assert.equal(definition.publication.completeDefinitionPublished, true);
  assert.equal(definition.publication.standaloneDefinitionPath, null);
  assert.equal(definition.publication.dashboardSpecificDeploymentTemplatePath, null);
  assert.deepEqual(definition.artifacts.map((item) => [item.kind, item.sha256]), [
    ["MANIFEST_CONTAINER", "2919c040bd1913eddac949bfcf5aceb2df14b2e2d0dd28a9e3f399001dfa2ae8"],
    ["EMBEDDED_QUICKSIGHT_DEFINITION", "b8f3c3579f4c7fe9163b5b1a4399c8ca7e40c70ed0155c9312f95eacdfca40fd"],
    ["EMBEDDED_DATASET_TEMPLATE", "dbf76e59436e60a4b855cace840d9c8823972b53ee344494b86aefab97fa3af4"],
    ["EMBEDDED_ATHENA_VIEW", "d8aa257b9655f94c2112042e57587914a7dceeb38b664209bb7591709634540f"],
    ["CHANGELOG", "8ef9302aa2f33a190c6ef84d7f069c79e99afb730cc25dd287e56193ca3122f8"],
    ["SHARED_DEPLOYMENT_TEMPLATE", "b96a47e6b53418293ec7127d0a95f96f2ffdae2781cde2b2dffcabad926a713d"],
  ]);
});

test("ADD-13 preserves the exact embedded QuickSight inventory", () => {
  assert.deepEqual(definition.totals, {
    sheets: 2,
    visuals: 11,
    parameterControls: 1,
    filterControls: 9,
    controlPlacements: 10,
    parameterDeclarations: 6,
    calculatedFields: 10,
    filterGroups: 8,
    columnConfigurations: 3,
    datasets: 1,
  });
  assert.deepEqual(definition.visualTypes, {
    BarChartVisual: 4,
    KPIVisual: 2,
    LineChartVisual: 1,
    ComboChartVisual: 1,
    PivotTableVisual: 2,
    InsightVisual: 1,
  });
  assert.deepEqual(definition.parameterNames, [
    "PreviousNMonths", "Payer", "AccountName", "LinkedAccountIDs",
    "ProductName", "CostType",
  ]);
  assert.deepEqual(definition.sheets.map((sheet) => [sheet.name, sheet.visualCount]), [
    ["Pricing Change Analysis", 10],
    ["About", 1],
  ]);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.visuals.length, 0), 11);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.controls.length, 0), 10);
  assert.equal(new Set(definition.sheets.flatMap((sheet) => sheet.visuals.map((item) => item.id))).size, 11);
});

test("ADD-13 maps only titles and controls proven by the public definition", () => {
  const main = definition.sheets[0];
  assert.deepEqual(main?.visuals.map((item) => item.title), [
    "Total Cost Difference by Region - Service SKUs Impacted by Price Change",
    "Total Cost Difference Impact by Account Name and Service",
    "Cost Difference Last month",
    "Total Cost per Month (pre- and post-price change)",
    "Monthly Cost Difference by Payer / Account Name (Drill Down Available)",
    "Total Cost Difference Impact by Payer Account",
    "Total Cost Difference Impact by Service",
    "Cost Difference 2 Months Ago",
    "Summary of Cost Differences by Service and Month",
    "Product SKUs with rate changes (Cost Type Cost)",
  ]);
  assert.deepEqual(main?.controls.map((item) => [item.placement, item.type, item.title, item.nativeState]), [
    ["parameter", "Dropdown", "Cost Type", "UNAVAILABLE"],
    ["filter", "CrossSheet", "Service Name", "SUPPORTED"],
    ["filter", "CrossSheet", "Linked Account Name", "UNAVAILABLE"],
    ["filter", "CrossSheet", "Linked Account ID", "SUPPORTED"],
    ["filter", "CrossSheet", "Payer Account ID", "SUPPORTED"],
    ["filter", "DateTimePicker", "Date Range", "SERVER_PINNED"],
  ]);
  assert.deepEqual(definition.sheets[1]?.visuals.map((item) => item.title), ["Notices"]);
  assert.equal(main?.visuals.filter((item) => item.coverage === "NATIVE_EVIDENCE_PARTIAL").length, 4);
  assert.equal(main?.visuals.filter((item) => item.coverage === "NATIVE_EVIDENCE_UNAVAILABLE").length, 6);
  assert.match(definition.disclosures.join(" "), /not represented as equivalent/iu);
  assert.match(definition.disclosures.join(" "), /production acceptance remain open/iu);
});

test("ADD-13 retains the published SPICE dataset and query boundaries", () => {
  assert.deepEqual(definition.dataset, {
    importMode: "SPICE",
    physicalTables: 2,
    pricingChangesInputColumns: 21,
    accountMapInputColumns: 2,
    logicalProjectedColumns: 25,
    dependencies: ["pricing_changes", "account_map"],
    cur1DependencyColumns: 18,
    queryLineCount: 121,
    documentedWindow: "previous 24 complete months",
  });
});
