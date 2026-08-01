import assert from "node:assert/strict";
import test from "node:test";
import { TRUSTED_ADVISOR_ORGANIZATIONAL_OFFICIAL_DEFINITION as definition } from "../lib/finops-trusted-advisor-organizational-official-definition.ts";

test("ADV-01 pins the immutable official TAO v4.0.1 source and complete object inventory", () => {
  assert.equal(
    definition.sourceRepository,
    "https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
  );
  assert.equal(definition.sourceCommit, "f9e36d88c47709f10e8fa784ad11d5cc0e728021");
  assert.equal(definition.manifestPath, "dashboards/tao/tao.yaml");
  assert.equal(definition.manifestSha256, "dc0168c5655e69d1d87c414e952b30b6f4303ade439cbfac43568187d0cdaf8c");
  assert.equal(definition.definitionPath, "dashboards/tao/tao-definition.yaml");
  assert.equal(definition.definitionSha256, "c2eafc68c9e40ae41d6f397b914c0a039fb39f6b487a1fefe74137dec67dcf43");
  assert.equal(definition.dashboardId, "ta-organizational-view");
  assert.equal(definition.version, "v4.0.1");
  assert.deepEqual(definition.datasets, ["ta-organizational-view", "ta_priority_org_view"]);
  assert.deepEqual(definition.totals, {
    sheets: 11,
    visuals: 147,
    parameterControls: 18,
    filterControls: 4,
    parameterDeclarations: 2,
    calculatedFields: 45,
    filterGroups: 153,
  });
  assert.deepEqual(definition.visualTypes, {
    BarChart: 70,
    ComboChart: 3,
    Insight: 18,
    KPI: 8,
    PivotTable: 5,
    Table: 43,
  });
});

test("ADV-01 maps every official sheet, visual, and control without hiding provider gaps", () => {
  assert.deepEqual(definition.sheets.map((sheet) => sheet.name), [
    "Summary",
    "TA Explorer",
    "Security",
    "Security Hub Checks",
    "Cost Optimization",
    "Fault Tolerance",
    "Performance",
    "Service Limits",
    "TA Priority",
    "Well-Architected Reviews",
    "About",
  ]);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.visualCount, 0), 147);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.parameterControls.length, 0), 18);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.filterControls.length, 0), 4);
  const visualTypes = definition.sheets.reduce<Record<string, number>>((totals, sheet) => {
    for (const [type, count] of Object.entries(sheet.visualTypes)) {
      totals[type] = (totals[type] ?? 0) + count;
    }
    return totals;
  }, {});
  assert.deepEqual(visualTypes, definition.visualTypes);
  assert.equal(definition.sheets.find((sheet) => sheet.name === "TA Priority")?.coverage, "PROVIDER_SOURCE_REQUIRED");
  assert.equal(definition.sheets.find((sheet) => sheet.name === "Well-Architected Reviews")?.coverage, "PROVIDER_SOURCE_REQUIRED");
  assert.equal(definition.sheets.find((sheet) => sheet.name === "Security Hub Checks")?.coverage, "CONDITIONAL_STANDARD_CHECKS");
});
