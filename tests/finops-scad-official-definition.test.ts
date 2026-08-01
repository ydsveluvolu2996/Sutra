import assert from "node:assert/strict";
import test from "node:test";
import { SCAD_OFFICIAL_DEFINITION } from "../lib/finops-scad-official-definition.ts";

test("SCAD audit pins the immutable manifest without fabricating QuickSight objects", () => {
  assert.equal(
    SCAD_OFFICIAL_DEFINITION.source.commit,
    "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
  );
  assert.equal(
    SCAD_OFFICIAL_DEFINITION.source.sha256,
    "0b27190fecbb87988b3f06ec122f3a2ffc7636b25f8008b3117367ad8302c2d4",
  );
  assert.equal(
    SCAD_OFFICIAL_DEFINITION.source.quickSightDefinitionEmbedded,
    false,
  );
  assert.equal(
    SCAD_OFFICIAL_DEFINITION.source.quickSightControlInventory,
    "NOT_DISCLOSED_IN_IMMUTABLE_SOURCE",
  );
  assert.equal(
    SCAD_OFFICIAL_DEFINITION.source.quickSightVisualObjectCount,
    null,
  );
});

test("SCAD audit preserves AWS's three-tab claim and five named sections separately", () => {
  assert.equal(SCAD_OFFICIAL_DEFINITION.documentedTabCountClaim, 3);
  assert.equal(SCAD_OFFICIAL_DEFINITION.documentedSectionCount, 5);
  assert.deepEqual(
    SCAD_OFFICIAL_DEFINITION.sections.map((section) => section.label),
    [
      "Executive Summary",
      "Workloads Explorer",
      "Cluster Breakdown",
      "Labels/Tags Explorer",
      "Data on EKS",
    ],
  );
  assert.deepEqual(
    SCAD_OFFICIAL_DEFINITION.sections.map((section) => section.support),
    ["SUPPORTED", "SUPPORTED", "SUPPORTED", "PARTIAL", "PARTIAL"],
  );
});
