import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const moduleSource = await readFile(new URL("../lib/finops-cost-intelligence-official-definition.ts", import.meta.url), "utf8");
const evidence = await readFile(new URL("../docs/finops-cid-evidence/FND-02-cost-intelligence.md", import.meta.url), "utf8");

test("Cost Intelligence official definition is pinned by immutable commit and SHA-256", () => {
  assert.match(moduleSource, /f9e36d88c47709f10e8fa784ad11d5cc0e728021/u);
  assert.match(moduleSource, /71795647fd09a17c3a2e1ea2f1308d6aecb150efe339a0950866ad766ef10ab0/u);
  assert.match(moduleSource, /sha256: "[a-f0-9]{64}"/u);
  assert.match(evidence, /cost-intelligence-definition\.yaml/u);
});

test("the exact ten-sheet and 77-visual inventory cannot silently shrink", async () => {
  const { FINOPS_COST_INTELLIGENCE_OFFICIAL_DEFINITION: definition } = await import("../lib/finops-cost-intelligence-official-definition.ts");
  assert.equal(definition.sheets.length, 10);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.visualCount, 0), 77);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.filterControlCount, 0), 11);
  assert.equal(definition.sheets.reduce((sum, sheet) => sum + sheet.parameterControlCount, 0), 33);
  assert.deepEqual(definition.sheets.map(({ name }) => name), ["Billing Summary", "Cost Summary", "Compute Summary", "Storage Summary", "RI/SP Summary", "Expiring RI/SP Tracker", "OPTICS Explorer ", "MoM Pivot", "Summary of Changes", "About"]);
  assert.deepEqual(
    definition.sheets.filter(({ gaps }) => gaps.length > 0).map(({ name }) => name),
    ["Compute Summary", "Storage Summary", "RI/SP Summary", "OPTICS Explorer ", "MoM Pivot"],
  );
  assert.equal(definition.sheets.every(({ support }) => support.length > 0), true);
});
