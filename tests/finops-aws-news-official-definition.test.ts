import assert from "node:assert/strict";
import test from "node:test";
import { AWS_NEWS_OFFICIAL_DEFINITION as definition } from "../lib/finops-aws-news-official-definition.ts";

test("ADV-07 pins the complete embedded AWS News Feeds definition", () => {
  assert.equal(
    definition.source.sha256,
    "1e3c569b4fe4100971a0c0c1530492745726408f58e9c5edd817895c516a4d6e",
  );
  assert.equal(
    definition.source.embeddedDefinitionSha256,
    "ac9bffb471fcf9730d765c45270ddc818c363ed8539c2d62f1df2da6f6115c4e",
  );
  assert.deepEqual(definition.totals, {
    sheets: 6,
    visuals: 21,
    parameterControls: 12,
    filterControls: 0,
    parameterDeclarations: 20,
    calculatedFields: 16,
    filterGroups: 20,
    columnConfigurations: 0,
    datasets: 5,
  });
  assert.deepEqual(definition.visualTypes, {
    TableVisual: 7,
    BarChartVisual: 7,
    WordCloudVisual: 1,
    PivotTableVisual: 3,
    CustomContentVisual: 1,
    InsightVisual: 2,
  });
});

test("ADV-07 inventories every exact sheet, visual, and control placement", () => {
  assert.deepEqual(
    definition.sheets.map((sheet) => sheet.name),
    [
      "AWS Feeds Summary",
      "AWS What's New",
      "AWS Blog Posts",
      "AWS YouTube Videos",
      "AWS Security Bulletin",
      "About",
    ],
  );
  assert.equal(
    definition.sheets.reduce((sum, sheet) => sum + sheet.visuals.length, 0),
    definition.totals.visuals,
  );
  assert.equal(
    definition.sheets.reduce((sum, sheet) => sum + sheet.controls.length, 0),
    definition.totals.parameterControls,
  );
  assert.equal(
    new Set(
      definition.sheets.flatMap((sheet) =>
        sheet.visuals.map((visual) => visual.id),
      ),
    ).size,
    definition.totals.visuals,
  );
});
