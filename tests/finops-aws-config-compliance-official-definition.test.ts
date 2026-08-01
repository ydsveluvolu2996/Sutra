import assert from "node:assert/strict";
import test from "node:test";
import { AWS_CONFIG_COMPLIANCE_OFFICIAL_DEFINITION as definition } from "../lib/finops-aws-config-compliance-official-definition.ts";

test("ADD-12 pins every published CRCD artifact and embedded section hash", () => {
  assert.equal(
    definition.cidFrameworkAudit.commit,
    "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
  );
  assert.equal(definition.cidFrameworkAudit.dashboardSpecificArtifactCount, 0);
  assert.equal(
    definition.sourceCommit,
    "c0d0c6a36d4f0cc04dc32e84d5f077bec2d4b60c",
  );
  assert.equal(definition.completeDefinitionPublished, true);
  assert.equal(definition.exactGeometryClaimed, false);
  assert.deepEqual(
    definition.artifacts.map((artifact) => [
      artifact.kind,
      artifact.count,
      artifact.sha256,
    ]),
    [
      [
        "CID_CMD_MANIFEST",
        1,
        "1eabc9654371d23672c95daa6aff90be5505dbe59ab9fa9877e81e9bf47d5ff1",
      ],
      [
        "QUICKSIGHT_DEFINITION",
        1,
        "7827c3d11e1c7cefd6e7f26913c4c5284866d0cb1126a1c55ae614cff6eb30ee",
      ],
      [
        "CLOUDFORMATION_TEMPLATE",
        1,
        "97542e8c142f5189b57c161a25b3051310b552fbb2826f11aaf96681400d98dc",
      ],
      [
        "BACKFILL_TEMPLATE",
        1,
        "27aabcad33304cb63510e88d7d9245e11f227de39ab79e38160fd544c33d5e4a",
      ],
      [
        "CHANGELOG",
        1,
        "1f0131ddb4ac458df9b8322be8735d925469e32c1ca18306d22d609a202f04b3",
      ],
      [
        "EMBEDDED_DATASET_DEFINITIONS",
        13,
        "6a6a46f386e4e9f4d4073393800c5e7303106b575a45848922b796d78406eef3",
      ],
      [
        "EMBEDDED_ATHENA_VIEW_QUERIES",
        14,
        "aaa904287c86066d4873805581b1a929a798021d5e736092dd32de3fe360ce03",
      ],
    ],
  );
});

test("ADD-12 freezes exact published QuickSight object totals", () => {
  assert.deepEqual(definition.totals, {
    sheets: 7,
    visuals: 124,
    parameterControls: 51,
    filterControls: 13,
    parameterDeclarations: 53,
    calculatedFields: 40,
    filterGroups: 267,
    columnConfigurations: 1,
    datasets: 13,
    views: 14,
  });
  assert.deepEqual(definition.visualTypes, {
    KPIVisual: 29,
    BarChartVisual: 64,
    TableVisual: 19,
    GaugeChartVisual: 6,
    PivotTableVisual: 1,
    HeatMapVisual: 4,
    PieChartVisual: 1,
  });
  assert.equal(
    definition.sheets.reduce((total, sheet) => total + sheet.visualCount, 0),
    124,
  );
  assert.equal(
    definition.sheets.reduce(
      (total, sheet) => total + sheet.parameterControlCount,
      0,
    ),
    51,
  );
  assert.equal(
    definition.sheets.reduce(
      (total, sheet) => total + sheet.filterControlCount,
      0,
    ),
    13,
  );
});

test("ADD-12 maps only documented sheet purposes and explicit native gaps", () => {
  assert.deepEqual(
    definition.sheets.map((sheet) => [
      sheet.name,
      sheet.visualCount,
      sheet.nativeCoverage,
    ]),
    [
      ["Compliance", 30, "PARTIAL"],
      ["Tag Compliance", 13, "UNAVAILABLE"],
      ["Resource Inventory", 29, "PARTIAL"],
      ["Config Usage Insights", 28, "PARTIAL"],
      ["Threat-Informed Security Compliance", 19, "UNAVAILABLE"],
      ["Configuration Item Events", 5, "UNAVAILABLE"],
      ["About", 0, "SUPPORTED"],
    ],
  );
  assert.match(definition.sheets[1]?.remainingGap ?? "", /not collected/u);
  assert.match(definition.sheets[4]?.nativeEvidence ?? "", /does not infer/u);
  assert.match(
    definition.sheets[5]?.nativeEvidence ?? "",
    /no event timeline is synthesized/iu,
  );
  assert.match(
    definition.limitations.join(" "),
    /does not claim pixel or QuickSight geometry parity/u,
  );
});
