import assert from "node:assert/strict";
import test from "node:test";
import { FINOPS_KPI_IDS } from "../lib/finops-kpi.ts";
import { FINOPS_KPI_OFFICIAL_DEFINITION } from
  "../lib/finops-kpi-official-definition.ts";

test("KPI official definition pins v2.2.1 and accounts for every published object", () => {
  const definition = FINOPS_KPI_OFFICIAL_DEFINITION;
  assert.equal(definition.source.commit,
    "f9e36d88c47709f10e8fa784ad11d5cc0e728021");
  assert.equal(definition.source.manifestSha256,
    "fd669f207c5589b4b54b981d6d85affb3af449871e908b85a4c1b9b357c35b1a");
  assert.equal(definition.source.definitionSha256,
    "299c6d39c55c28221b0d0d771358f526931d60fb5f4d00ba4f663d22554b89a1");
  assert.equal(definition.source.version, "v2.2.1");
  assert.equal(definition.sheets.length, definition.totals.sheets);
  assert.equal(definition.sheets.reduce((total, sheet) =>
    total + sheet.visualCount, 0), definition.totals.visuals);
  assert.equal(definition.sheets.reduce((total, sheet) =>
    total + sheet.parameterControls.length, 0),
  definition.totals.parameterControls);
  assert.equal(definition.sheets.reduce((total, sheet) =>
    total + Object.values(sheet.filterControls).reduce((sum, count) =>
      sum + count, 0), 0), definition.totals.filterControls);
  assert.equal(Object.values(definition.totals.visualTypes).reduce(
    (sum, count) => sum + count, 0), definition.totals.visuals);
});

test("the official 19 goal controls map one-for-one to the governed formula registry", () => {
  const tracker = FINOPS_KPI_OFFICIAL_DEFINITION.sheets[0];
  const goals = FINOPS_KPI_OFFICIAL_DEFINITION.sheets[1];
  assert.equal(goals.parameterControls.length, 19);
  assert.deepEqual([...tracker.formulaIds].sort(), [...FINOPS_KPI_IDS].sort());
  assert.equal(new Set(tracker.formulaIds).size, 19);
  assert.equal(FINOPS_KPI_OFFICIAL_DEFINITION.sheets.every((sheet) =>
    Object.values(sheet.visualTypes).reduce((sum, count) => sum + count, 0)
      === sheet.visualCount), true);
});
