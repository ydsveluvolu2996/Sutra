import assert from "node:assert/strict";
import test from "node:test";
import { GRAVITON_SAVINGS_OFFICIAL_DEFINITION as definition } from "../lib/finops-graviton-savings-official-definition.ts";

test("ADV-05 pins the immutable Graviton Savings v3.0.2 manifest and definition", () => {
  assert.equal(definition.sourceRepository, "https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework");
  assert.equal(definition.sourceCommit, "f9e36d88c47709f10e8fa784ad11d5cc0e728021");
  assert.equal(definition.manifestPath, "dashboards/graviton-savings-dashboard/graviton_savings_dashboard.yaml");
  assert.equal(definition.manifestSha256, "a91ec6d00d530fb126c2e235a7ac2b3b69f7d1d2a72c9e86df7b6858c6178eb3");
  assert.equal(definition.definitionPath, "dashboards/graviton-savings-dashboard/graviton_savings_dashboard-definition.yaml");
  assert.equal(definition.definitionSha256, "2dd6358149ac7457de1a1ca0de9c4fcf651eaea7685f7554a27ae338df392ec8");
  assert.equal(definition.dashboardId, "graviton-savings");
  assert.equal(definition.version, "v3.0.2");
  assert.equal(definition.theme, "MIDNIGHT");
  assert.deepEqual(definition.datasets, [
    "graviton_mapping",
    "opensearch_graviton_dashboard",
    "elasticache_graviton_dashboard",
    "ec2_graviton_dashboard",
    "rds_graviton_dashboard",
  ]);
});

test("ADV-05 preserves the exact official sheet, visual, control and analysis object inventory", () => {
  assert.deepEqual(definition.totals, {
    sheets: 7,
    visuals: 122,
    parameterControls: 39,
    filterControls: 14,
    parameterDeclarations: 44,
    calculatedFields: 68,
    filterGroups: 469,
    columnConfigurations: 48,
    datasets: 5,
  });
  assert.deepEqual(definition.visualTypes, {
    KPIVisual: 37,
    BarChartVisual: 29,
    PivotTableVisual: 9,
    ComboChartVisual: 12,
    WaterfallVisual: 1,
    InsightVisual: 16,
    PieChartVisual: 17,
    TableVisual: 1,
  });
  assert.deepEqual(definition.sheets.map((sheet) => sheet.name), [
    "Summary",
    "EC2",
    "RDS",
    "ElastiCache",
    "OpenSearch",
    "Graviton Instance Mapping",
    "About",
  ]);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.visualCount, 0), 122);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.parameterControls.length, 0), 39);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.filterControls.length, 0), 14);
  const visualTypes = definition.sheets.reduce<Record<string, number>>((totals, sheet) => {
    for (const [type, count] of Object.entries(sheet.visualTypes)) {
      totals[type] = (totals[type] ?? 0) + count;
    }
    return totals;
  }, {});
  assert.deepEqual(visualTypes, definition.visualTypes);
});

test("ADV-05 sheet mappings expose native evidence limits without layout-parity claims", () => {
  const mapping = definition.sheets.find((sheet) => sheet.name === "Graviton Instance Mapping");
  assert.equal(mapping?.coverage, "MODEL_ONLY");
  assert.match(mapping?.remainingGap ?? "", /not implemented/u);
  assert.deepEqual(definition.sheets.find((sheet) => sheet.name === "EC2")?.nativeResourceTypes, [
    "EC2_INSTANCE",
    "AUTO_SCALING_GROUP",
  ]);
  for (const sheet of definition.sheets) {
    assert.ok(sheet.evidenceNote.length > 20);
    assert.ok(sheet.remainingGap.length > 20);
  }
});
