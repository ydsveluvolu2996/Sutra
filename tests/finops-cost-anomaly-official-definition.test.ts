import assert from "node:assert/strict";
import test from "node:test";
import {
  COST_ANOMALY_OFFICIAL_DEFINITION as definition,
} from "../lib/finops-cost-anomaly-official-definition.ts";

test("ADV-03 pins the public embedded QuickSight definition", () => {
  assert.equal(definition.source.commit, "f9e36d88c47709f10e8fa784ad11d5cc0e728021");
  assert.equal(definition.source.manifestSha256, "3676df09c3e3933987dfad923e0fc1b418c30db0562c3344d0ff2f0e54726244");
  assert.equal(definition.source.embeddedDefinitionSha256, "299b580daf221ab61cc243eb5f3fe121aee9c7fb21a88d66be58c007ab6a3b14");
  assert.equal(definition.source.changelogSha256, "5a78599be4f131feb12944e5ea6da5bb87b38d55cd8d4ae00a0a1e9f205ac104");
  assert.equal(definition.source.dashboardId, "aws-cost-anomalies");
  assert.equal(definition.source.category, "Advanced");
  assert.equal(definition.source.datasetIdentifier, "ca_summary_view");
  assert.equal(definition.source.queryArtifact, null);
});

test("ADV-03 preserves the exact sheet, visual, control, and analysis inventory", () => {
  assert.deepEqual(definition.totals, {
    sheets: 2,
    visuals: 6,
    parameterControls: 4,
    filterControls: 8,
    parameterDeclarations: 10,
    calculatedFields: 11,
    filterGroups: 9,
    datasets: 1,
  });
  assert.deepEqual(definition.visualTypes, {
    BarChartVisual: 4,
    TableVisual: 1,
    PieChartVisual: 1,
  });
  assert.deepEqual(definition.sheets.map((sheet) => sheet.name), ["AWS Cost Anomalies", "About"]);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.visualCount, 0), 6);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.parameterControls.length, 0), 4);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.filterControls.length, 0), 8);
  assert.equal(definition.parameterDeclarations.length, 10);
  assert.equal(definition.filterGroups.length, 9);
});

test("ADV-03 maps all six visuals without hiding semantic gaps", () => {
  const visuals = definition.sheets[0].visuals;
  assert.deepEqual(visuals.map((visual) => visual.name), [
    "Daily Cost Anomalies Total Impact",
    "Total Impact Cost",
    "AWS Cost Anomalies - Service (Total Cost Impact)",
    "AWS Cost Anomalies Details",
    "Total Impact Cost by Anomaly Start Date",
    "Anomalies Status",
  ]);
  assert.equal(visuals.filter((visual) => visual.coverage === "SUPPORTED").length, 2);
  assert.equal(visuals.filter((visual) => visual.coverage === "PARTIAL_SEMANTICS").length, 4);
  for (const visual of visuals) {
    assert.ok(visual.nativeEvidence.length > 20);
    assert.ok(visual.remainingGap.length > 20);
  }
  assert.match(definition.disclosures.join(" "), /no standalone SQL\/query artifact/iu);
  assert.match(definition.disclosures.join(" "), /Active\/Past/iu);
});
