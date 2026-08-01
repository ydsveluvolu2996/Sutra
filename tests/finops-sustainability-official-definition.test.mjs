import assert from "node:assert/strict";
import test from "node:test";
import { SUSTAINABILITY_OFFICIAL_DEFINITION as definition } from "../lib/finops-sustainability-official-definition.ts";

test("pins the exact Sustainability sheet, visual, and control inventory", () => {
  assert.equal(definition.commit, "f9e36d88c47709f10e8fa784ad11d5cc0e728021");
  assert.equal(definition.artifactSha256, "dff730465da14a7278dfa722340026265d5a16ec0a824fb310cbd6c89004e269");
  assert.equal(definition.sheetCount, 6);
  assert.equal(definition.visualCount, 25);
  assert.equal(definition.controlCount, 17);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.visualCount, 0), 25);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.controlCount, 0), 17);
  assert.deepEqual(definition.sheets.map((sheet) => sheet.name), ["Regional Footprint", "Compute Proxies",
    "Storage Proxies", "Data Transfer / Networking Proxies", "Carbon Emissions", "About"]);
  assert.equal(definition.sheets.find((sheet) => sheet.name === "Regional Footprint")?.coverage, "SCHEMA_GAP");
});
