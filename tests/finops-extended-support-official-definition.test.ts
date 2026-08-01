import assert from "node:assert/strict";
import test from "node:test";
import { EXTENDED_SUPPORT_OFFICIAL_DEFINITION } from "../lib/finops-extended-support-official-definition.ts";

test("Extended Support audit pins every exact official definition object", () => {
  const definition = EXTENDED_SUPPORT_OFFICIAL_DEFINITION;
  assert.equal(
    definition.source.sha256,
    "6e50955ebeab4f2cbcc86c731c939e12c3fe4880d8132514f8de05042cfdb53f",
  );
  assert.equal(definition.sheets.length, definition.totals.sheets);
  assert.equal(
    definition.sheets.reduce((sum, sheet) => sum + sheet.visualCount, 0),
    definition.totals.visuals,
  );
  assert.equal(
    definition.sheets.reduce(
      (sum, sheet) => sum + sheet.parameterControlCount,
      0,
    ),
    definition.totals.parameterControls,
  );
  assert.deepEqual(
    definition.sheets.map((sheet) => sheet.name),
    [
      "RDS Extended Support (Cost Projection)",
      "EKS Extended Support (Cost Projection)",
      "OpenSearch Extended Support (Cost Projection)",
      "ElastiCache Extended Support (Cost Projection)",
      "About",
    ],
  );
});
