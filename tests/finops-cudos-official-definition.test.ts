import assert from "node:assert/strict";
import test from "node:test";
import { FINOPS_CUDOS_OFFICIAL_DEFINITION } from
  "../lib/finops-cudos-official-definition.ts";

test("CUDOS audit pins the exact immutable v5 object inventory", () => {
  const definition = FINOPS_CUDOS_OFFICIAL_DEFINITION;
  assert.equal(definition.source.commit,
    "f9e36d88c47709f10e8fa784ad11d5cc0e728021");
  assert.equal(definition.source.sha256,
    "7f0516c146b1de528e3960305a01b090d2521c020c6f8fba4b756f3a62f444c1");
  assert.equal(definition.sheets.length, definition.totals.sheets);
  assert.equal(definition.sheets.reduce((sum, sheet) =>
    sum + sheet.visualCount, 0), definition.totals.visuals);
  assert.equal(definition.sheets.reduce((sum, sheet) =>
    sum + sheet.parameterControlCount, 0), definition.totals.parameterControls);
  assert.equal(definition.sheets.reduce((sum, sheet) =>
    sum + sheet.filterControlCount, 0), definition.totals.filterControls);
  assert.deepEqual(definition.sheets.map((sheet) => sheet.name), [
    "Executive: Billing Summary", "Executive: RI/SP Summary",
    "Executive: Trends", "Compute", "Storage & Backup", "Amazon S3",
    "Databases", "Amazon DynamoDB", "AI/ML",
    "Data Transfer & Networking", "Messaging and Streaming",
    "Monitoring & Observability", "Analytics", "Security",
    "End User Computing", "GameTech & Media", "Taxonomy Explorer",
    "OPTICS Explorer", "About",
  ]);
});
