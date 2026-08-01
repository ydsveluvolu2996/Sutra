import assert from "node:assert/strict";
import test from "node:test";
import { AWS_BUDGETS_OFFICIAL_DEFINITION as definition } from "../lib/finops-aws-budgets-official-definition.ts";

test("ADV-08 pins the complete AWS Budgets definition inventory", () => {
  assert.equal(
    definition.source.sha256,
    "9a9e2229e551332334363656ab4d1310fd3d73049bdce2eada46bd61c5a52de9",
  );
  assert.deepEqual(definition.totals, {
    sheets: 2,
    visuals: 11,
    parameterControls: 2,
    filterControls: 5,
    parameterDeclarations: 3,
    calculatedFields: 11,
    filterGroups: 9,
    datasets: 1,
  });
  assert.deepEqual(definition.visualTypes, {
    PivotTableVisual: 2,
    GaugeChartVisual: 4,
    BarChartVisual: 1,
    ComboChartVisual: 1,
    SankeyDiagramVisual: 1,
    InsightVisual: 2,
  });
});

test("ADV-08 maps every official sheet, visual, and control honestly", () => {
  assert.deepEqual(
    definition.sheets.map((sheet) => sheet.name),
    ["Budget Summary", "About"],
  );
  assert.equal(
    definition.sheets.reduce((sum, sheet) => sum + sheet.visualCount, 0),
    definition.totals.visuals,
  );
  assert.equal(
    definition.sheets.reduce(
      (sum, sheet) => sum + sheet.parameterControls.length,
      0,
    ),
    definition.totals.parameterControls,
  );
  assert.equal(
    definition.sheets.reduce(
      (sum, sheet) => sum + sheet.filterControls.length,
      0,
    ),
    definition.totals.filterControls,
  );
  assert.equal(definition.sheets[0]?.visuals.length, 11);
  assert.ok(
    definition.sheets[0]?.visuals.some(
      (visual) =>
        visual.name === "Budget Distribution from Group By to Budget Level" &&
        visual.coverage === "PARTIAL_EVIDENCE",
    ),
  );
});
