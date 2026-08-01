import assert from "node:assert/strict";
import test from "node:test";
import { RESILIENCE_VUE_OFFICIAL_DEFINITION as definition } from "../lib/finops-resilience-vue-official-definition.ts";

test("ADV-10 pins the immutable ResilienceVue v1.0.0 manifest and definition", () => {
  assert.equal(definition.sourceRepository, "https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework");
  assert.equal(definition.sourceCommit, "f9e36d88c47709f10e8fa784ad11d5cc0e728021");
  assert.equal(definition.manifestPath, "dashboards/resilience-vue/resilience-vue.yaml");
  assert.equal(definition.manifestSha256, "9478243fd9da03b4be2813993c98bd3f99970865443b9b11d8b0346de54d380c");
  assert.equal(definition.definitionPath, "dashboards/resilience-vue/resilience-vue-definition.yaml");
  assert.equal(definition.definitionSha256, "c0fe7edf8648327ca13a3ad14372ae382b4b9bf42b428aacd0223f8a5575b63b");
  assert.equal(definition.dashboardId, "resiliencevue");
  assert.equal(definition.name, "Resilience Vue");
  assert.equal(definition.version, "v1.0.0");
  assert.equal(definition.theme, "MIDNIGHT");
});

test("ADV-10 preserves the exact official analysis and per-sheet object inventory", () => {
  assert.deepEqual(definition.totals, {
    sheets: 4,
    visuals: 47,
    parameterControls: 2,
    filterControls: 7,
    parameterDeclarations: 4,
    calculatedFields: 37,
    filterGroups: 15,
    columnConfigurations: 7,
    datasets: 9,
  });
  assert.deepEqual(definition.visualTypes, {
    SankeyDiagramVisual: 1,
    BarChartVisual: 4,
    TableVisual: 15,
    KPIVisual: 9,
    PieChartVisual: 6,
    WordCloudVisual: 10,
    GaugeChartVisual: 1,
    LineChartVisual: 1,
  });
  assert.deepEqual(definition.sheets.map((sheet) => sheet.name), [
    "Organizational Summary",
    "Application Resiliency",
    "Recommendations",
    "About",
  ]);
  assert.deepEqual(definition.sheets.map((sheet) => sheet.visualCount), [23, 17, 7, 0]);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.visualCount, 0), 47);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.controls.filter((control) => control.placement === "parameter").length, 0), 2);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.controls.filter((control) => control.placement === "filter").length, 0), 7);
  const visualTypes = definition.sheets.reduce<Record<string, number>>((totals, sheet) => {
    for (const [type, count] of Object.entries(sheet.visualTypes)) {
      totals[type] = (totals[type] ?? 0) + count;
    }
    return totals;
  }, {});
  assert.deepEqual(visualTypes, definition.visualTypes);
  assert.equal(definition.datasets.length, 9);
});

test("ADV-10 maps every official control placement and preserves schema/provider gaps", () => {
  const summary = definition.sheets.find((sheet) => sheet.name === "Organizational Summary");
  assert.deepEqual(summary?.controls.map((control) => [control.placement, control.type, control.title]), [
    ["filter", "DateTimePicker", "Last Assessment Time between"],
    ["filter", "Dropdown", "Region"],
    ["filter", "Dropdown", "Management Account"],
    ["filter", "Dropdown", "Resiliency Status"],
  ]);
  const recommendations = definition.sheets.find((sheet) => sheet.name === "Recommendations");
  assert.equal(recommendations?.coverage, "VERSIONED_SCHEMA_REQUIRED");
  assert.deepEqual(recommendations?.controls.map((control) => [control.placement, control.title, control.nativeState]), [
    ["parameter", "Availability Architecture", "UNAVAILABLE"],
    ["parameter", "Optimization Type", "UNAVAILABLE"],
    ["filter", "App Component", "UNAVAILABLE"],
    ["filter", "Application Name", "SUPPORTED"],
  ]);
  assert.match(recommendations?.remainingGap ?? "", /Estimated cost/u);
  for (const sheet of definition.sheets) {
    assert.ok(sheet.evidenceNote.length > 20);
    assert.ok(sheet.remainingGap.length > 20);
  }
});
