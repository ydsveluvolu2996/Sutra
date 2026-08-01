import assert from "node:assert/strict";
import test from "node:test";

import { END_USER_COMPUTING_OFFICIAL_DEFINITION } from "../lib/finops-end-user-computing-official-definition.ts";

test("pins the exact AWS CID EUC sheet, visual, and control inventory", () => {
  const definition = END_USER_COMPUTING_OFFICIAL_DEFINITION;
  assert.equal(definition.commit, "f9e36d88c47709f10e8fa784ad11d5cc0e728021");
  assert.equal(definition.path, "dashboards/euc/euc-dashboard.yaml");
  assert.equal(definition.sourceUrl.includes(definition.commit), true);
  assert.equal(definition.artifactSha256, "1342648480b1c839c5f71e8c700c84cdc5525d3f0b74ceaf74aa0c2ec3c85af1");
  assert.equal(definition.dashboardVersion, "v1.2.0");
  assert.equal(definition.sheetCount, 7);
  assert.equal(definition.visualCount, 82);
  assert.equal(definition.controlCount, 24);
  assert.deepEqual(definition.sheets.map((sheet) => sheet.name), [
    "Summary",
    "WorkSpaces Desktop Insights",
    "WorkSpaces Desktop Usage",
    "WorkSpaces Desktops Metrics",
    "WorkSpaces Applications Summary",
    "EUC Cost Optimization",
    "About",
  ]);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.visualCount, 0), definition.visualCount);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.controlCount, 0), definition.controlCount);
  assert.equal(definition.sheets.find((sheet) => sheet.name === "WorkSpaces Desktop Usage")?.coverage, "PRIVACY_LIMITED");
  assert.equal(definition.sheets.find((sheet) => sheet.name === "EUC Cost Optimization")?.coverage, "SIGNALS_ONLY");
});
