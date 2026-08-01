import assert from "node:assert/strict";
import test from "node:test";
import { CORA_OFFICIAL_DEFINITION as definition } from "../lib/finops-cora-official-definition.ts";

test("ADD-01 pins the immutable CORA definition, manifest, changelog, and embedded SQL", () => {
  assert.equal(definition.source.commit, "f9e36d88c47709f10e8fa784ad11d5cc0e728021");
  assert.equal(definition.source.definitionSha256, "6486f50810f40558423cffb90c245a658678597fccdda8445e26a40e02e6a644");
  assert.equal(definition.source.manifestSha256, "54bde11bcee2ed0d333c891371eea29a5c2bfc6871e8e63d273682ace01d16bd");
  assert.equal(definition.source.changelogSha256, "c44fd6153a8f936a31664ff4207c465eef20abc9c325fe686d590d766313b57b");
  assert.equal(definition.source.embeddedViewSha256, "1e39c206cf5ae2b2ac9a5f87253935b77782c2ea46cdf3ac180f7db555c2b02e");
  assert.equal(definition.source.version, "v0.0.11");
  assert.equal(definition.source.category, "Additional");
  assert.equal(definition.source.datasetIdentifier, "cora_view");
});

test("ADD-01 preserves exact CORA object totals and visual types", () => {
  assert.deepEqual(definition.totals, {
    sheets: 5,
    visuals: 28,
    parameterControls: 11,
    filterControls: 41,
    controlPlacements: 52,
    parameterDeclarations: 8,
    calculatedFields: 48,
    filterGroups: 50,
    columnConfigurations: 16,
    datasets: 1,
  });
  assert.deepEqual(definition.visualTypes, {
    KPIVisual: 1,
    ScatterPlotVisual: 1,
    TableVisual: 5,
    SankeyDiagramVisual: 1,
    BarChartVisual: 10,
    PivotTableVisual: 8,
    PieChartVisual: 2,
  });
  assert.equal(definition.parameterDeclarations.length, 8);
});

test("ADD-01 inventories every sheet, visual, and control placement", () => {
  assert.deepEqual(definition.sheets.map((sheet) => sheet.name), [
    "Summary",
    "Usage Optimization",
    "Rate Optimization - Saving Plans",
    "Rate Optimization - Reserved Instances",
    "About",
  ]);
  assert.deepEqual(definition.sheets.map((sheet) => sheet.visualCount), [13, 6, 2, 7, 0]);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.visuals.length, 0), 28);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.parameterControls.length, 0), 11);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.filterControls.length, 0), 41);
  const ids = definition.sheets.flatMap((sheet) => sheet.visuals.map((item) => item.id));
  assert.equal(new Set(ids).size, 28);
  const types = definition.sheets.reduce<Record<string, number>>((totals, sheet) => {
    for (const [type, count] of Object.entries(sheet.visualTypes)) {
      totals[type] = (totals[type] ?? 0) + count;
    }
    return totals;
  }, {});
  assert.deepEqual(types, definition.visualTypes);
});

test("ADD-01 keeps native and provider gaps explicit for every official sheet", () => {
  assert.deepEqual(definition.sheets.map((sheet) => sheet.coverage), [
    "NATIVE_EVIDENCE_PARTIAL",
    "NATIVE_EVIDENCE_PARTIAL",
    "PROVIDER_DIMENSIONS_BLOCKED",
    "PROVIDER_DIMENSIONS_BLOCKED",
    "ABOUT_EVIDENCE",
  ]);
  for (const sheet of definition.sheets) {
    assert.ok(sheet.nativeEvidence.length > 30);
    assert.ok(sheet.remainingGap.length > 30);
  }
  assert.match(definition.disclosures.join(" "), /S3\/Parquet execution adapter/iu);
  assert.match(definition.disclosures.join(" "), /level, term, upfront and RI service/iu);
  assert.match(definition.disclosures.join(" "), /production acceptance remain open/iu);
});
