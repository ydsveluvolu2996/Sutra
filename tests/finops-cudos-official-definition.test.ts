import assert from "node:assert/strict";
import test from "node:test";
import { FINOPS_CUDOS_OFFICIAL_DEFINITION } from
  "../lib/finops-cudos-official-definition.ts";

test("CUDOS audit pins the exact immutable v5.9.1 object inventory", () => {
  const definition = FINOPS_CUDOS_OFFICIAL_DEFINITION;
  assert.equal(definition.source.commit,
    "9cecc158b81504344cf96b38d5918b6953b2e97d");
  assert.equal(definition.source.sha256,
    "4db8cd567b3aea50b44f4e7c3d175586799a5aaf3e923db260b570ae56d1aea2");
  assert.equal(definition.source.version, "v5.9.1");
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
