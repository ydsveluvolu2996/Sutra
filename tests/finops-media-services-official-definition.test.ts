import assert from "node:assert/strict";
import test from "node:test";
import { MEDIA_SERVICES_OFFICIAL_DEFINITION as definition } from "../lib/finops-media-services-official-definition.ts";

test("ADV-13 pins both linked AWS repositories and every published MSIH artifact", () => {
  assert.deepEqual(definition.repositories.map((item) => [item.role, item.commit]), [
    ["PRIMARY", "f9e36d88c47709f10e8fa784ad11d5cc0e728021"],
    ["DEFINITION_LINKED_MIRROR", "f9e36d88c47709f10e8fa784ad11d5cc0e728021"],
  ]);
  assert.equal(definition.repositories[1].byteIdenticalMediaServicesArtifacts, true);
  assert.equal(definition.source.version, "v2.2.1");
  assert.equal(definition.publication.completeQuickSightDefinitionPublished, true);
  assert.equal(definition.publication.dashboardSpecificDeploymentTemplatePublished, false);
  assert.deepEqual(definition.artifacts.map((item) => [item.kind, item.sha256]), [
    ["DASHBOARD_CATALOG", "169a37fb7be4660e96a1fa258d0f95d4cef597f4294c0c27cfda101dfbdb197d"],
    ["MANIFEST", "ab485a191da780a262b09d133731095c19720de4d3827a74dd42b454d974867a"],
    ["QUICKSIGHT_DEFINITION", "a29384174b7eafb599c3ca3734a8a7f4954b8e057f716e6d79e8750cee88fe4d"],
    ["CHANGELOG", "c489667883cbf69a92144f592d3b4d50ad8fae59420833e8dd1a7ad24e043a53"],
    ["SHARED_DEPLOYMENT_TEMPLATE", "b96a47e6b53418293ec7127d0a95f96f2ffdae2781cde2b2dffcabad926a713d"],
    ["DATASET_TEMPLATE", "86dbd25fc53dd7db2c121465371bc2e33621bbbb761f3391bac1a5e09beb00a4"],
    ["DATASET_TEMPLATE", "7332380211b604b6727c9cbab7292ba61539ac8402a88668a41e8be939fb6ab0"],
    ["DATASET_TEMPLATE", "690b21cc539aad83ceffe7f1fc933c6bc59eaed40a5619bd09a911ecaf99e8e5"],
    ["ATHENA_VIEW", "e35911d887dcccca397693a7bc390c6f9539e0aa2c0e2d2e5e1e0c9944517a45"],
    ["ATHENA_VIEW", "9a8ba7f427db59e695b4f83b61ebed672280f5c7e51d371493e91d1196ccb0f2"],
    ["ATHENA_VIEW", "c53c3ae61c5cc47181c29c2c6ca6cd393796d3c4f5e8f6f6805d5dfd5bee616a"],
  ]);
});

test("ADV-13 preserves the exact complete QuickSight object inventory", () => {
  assert.deepEqual(definition.totals, {
    sheets: 9,
    visuals: 144,
    parameterControls: 59,
    filterControls: 33,
    controlPlacements: 92,
    parameterDeclarations: 44,
    calculatedFields: 175,
    filterGroups: 241,
    columnConfigurations: 2,
    datasets: 3,
  });
  assert.deepEqual(definition.visualTypes, {
    BarChartVisual: 48,
    KPIVisual: 29,
    InsightVisual: 14,
    LineChartVisual: 25,
    TableVisual: 6,
    HeatMapVisual: 1,
    ScatterPlotVisual: 1,
    ComboChartVisual: 7,
    PivotTableVisual: 7,
    SankeyDiagramVisual: 6,
  });
  assert.deepEqual(definition.sheets.map((sheet) => [sheet.name, sheet.visualCount, sheet.controls.length]), [
    ["Executive Summary", 20, 7],
    ["MediaLive Reservation & Savings", 27, 16],
    ["MediaConvert", 17, 12],
    ["MediaConnect", 14, 8],
    ["MediaLive", 35, 20],
    ["MediaTailor", 16, 8],
    ["MediaPackage", 14, 8],
    ["Raw Data", 1, 13],
    ["About", 0, 0],
  ]);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.visualCount, 0), 144);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.controls.length, 0), 92);
});

test("ADV-13 maps all documented purposes without inventing reservation savings", () => {
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.documentedPurposes.length, 0), 52);
  for (const sheet of definition.sheets) {
    assert.ok(sheet.documentedPurposes.length > 0, sheet.name);
    for (const item of sheet.documentedPurposes) {
      assert.ok(item.purpose.length > 5);
      assert.ok(item.nativeEvidence.length > 20);
      if (item.coverage !== "SUPPORTED" && item.coverage !== "ABOUT_EVIDENCE") {
        assert.ok((item.remainingGap ?? "").length > 15, item.purpose);
      }
    }
  }
  const reservations = definition.sheets[1];
  assert.equal(reservations?.documentedPurposes[0]?.coverage, "UNAVAILABLE");
  assert.equal(reservations?.documentedPurposes[1]?.coverage, "UNAVAILABLE");
  assert.match(definition.disclosures.join(" "), /up-to-75-percent reservation savings.*not tenant savings evidence/iu);
  assert.match(definition.disclosures.join(" "), /deployment and live acceptance remain open/iu);
});

test("ADV-13 retains exact SPICE and embedded query boundaries", () => {
  assert.deepEqual(definition.datasets, [
    { id: "msih_reservation_optimize", importMode: "SPICE", physicalTables: 3, inputColumnCounts: [2, 2, 36], queryLineCount: 151 },
    { id: "msih_reservations", importMode: "SPICE", physicalTables: 3, inputColumnCounts: [31, 2, 2], queryLineCount: 123 },
    { id: "msih_view", importMode: "SPICE", physicalTables: 3, inputColumnCounts: [51, 2, 2], queryLineCount: 128 },
  ]);
});
