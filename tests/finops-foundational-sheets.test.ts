import assert from "node:assert/strict";
import test from "node:test";
import {
  FINOPS_COST_INTELLIGENCE_SHEETS,
  FINOPS_CUDOS_SHEETS,
  FINOPS_KPI_SHEETS,
  findSheet,
  sheetKey,
} from "../app/costs/finops-foundational-sheets.ts";
import { FINOPS_CUDOS_OFFICIAL_DEFINITION } from "../lib/finops-cudos-official-definition.ts";
import { FINOPS_COST_INTELLIGENCE_OFFICIAL_DEFINITION } from "../lib/finops-cost-intelligence-official-definition.ts";
import { FINOPS_KPI_OFFICIAL_DEFINITION } from "../lib/finops-kpi-official-definition.ts";

const INVENTORIES = [
  ["CUDOS", FINOPS_CUDOS_SHEETS],
  ["Cost Intelligence", FINOPS_COST_INTELLIGENCE_SHEETS],
  ["KPI", FINOPS_KPI_SHEETS],
] as const;

test("each inventory reproduces the pinned definition's own totals exactly", () => {
  // The audits state their totals independently of the per-sheet rows. If the
  // normalizer's sum disagrees, one of the two is wrong and the UI would show a
  // count that does not match the definition it claims to mirror.
  assert.equal(FINOPS_CUDOS_SHEETS.totalSheets, FINOPS_CUDOS_OFFICIAL_DEFINITION.totals.sheets);
  assert.equal(FINOPS_CUDOS_SHEETS.totalVisuals, FINOPS_CUDOS_OFFICIAL_DEFINITION.totals.visuals);
  assert.equal(
    FINOPS_CUDOS_SHEETS.totalControls,
    FINOPS_CUDOS_OFFICIAL_DEFINITION.totals.parameterControls
      + FINOPS_CUDOS_OFFICIAL_DEFINITION.totals.filterControls,
  );

  assert.equal(FINOPS_COST_INTELLIGENCE_SHEETS.totalSheets, 10);
  assert.equal(
    FINOPS_COST_INTELLIGENCE_SHEETS.totalVisuals,
    FINOPS_COST_INTELLIGENCE_OFFICIAL_DEFINITION.exactVisualCount,
  );
  assert.equal(
    FINOPS_COST_INTELLIGENCE_SHEETS.totalControls,
    FINOPS_COST_INTELLIGENCE_OFFICIAL_DEFINITION.exactFilterControlCount
      + FINOPS_COST_INTELLIGENCE_OFFICIAL_DEFINITION.exactParameterControlCount,
  );

  assert.equal(FINOPS_KPI_SHEETS.totalSheets, FINOPS_KPI_OFFICIAL_DEFINITION.totals.sheets);
  assert.equal(FINOPS_KPI_SHEETS.totalVisuals, FINOPS_KPI_OFFICIAL_DEFINITION.totals.visuals);
  assert.equal(
    FINOPS_KPI_SHEETS.totalControls,
    FINOPS_KPI_OFFICIAL_DEFINITION.totals.parameterControls
      + FINOPS_KPI_OFFICIAL_DEFINITION.totals.filterControls,
  );
});

test("sheet names and order are preserved verbatim from the official definition", () => {
  assert.deepEqual(
    FINOPS_CUDOS_SHEETS.sheets.map(({ name }) => name),
    FINOPS_CUDOS_OFFICIAL_DEFINITION.sheets.map(({ name }) => name),
  );
  assert.deepEqual(
    FINOPS_KPI_SHEETS.sheets.map(({ name }) => name),
    FINOPS_KPI_OFFICIAL_DEFINITION.sheets.map(({ name }) => name),
  );
  // One official Cost Intelligence sheet name carries a trailing space; the
  // displayed name is trimmed but the sheet itself is neither renamed nor moved.
  assert.deepEqual(
    FINOPS_COST_INTELLIGENCE_SHEETS.sheets.map(({ name }) => name),
    FINOPS_COST_INTELLIGENCE_OFFICIAL_DEFINITION.sheets.map(({ name }) => name.trim()),
  );
  assert.ok(FINOPS_COST_INTELLIGENCE_SHEETS.sheets.some(({ name }) => name === "OPTICS Explorer"));
});

test("coverage is never upgraded and every partial sheet names its gaps", () => {
  for (const [label, inventory] of INVENTORIES) {
    for (const sheet of inventory.sheets) {
      // Only the two fully-covered literals may normalize to SUPPORTED.
      if (sheet.support === "SUPPORTED") {
        assert.ok(
          sheet.supportLabel === "SUPPORTED" || sheet.supportLabel === "IMPLEMENTED_LOCAL",
          `${label}/${sheet.name} claims full coverage from ${sheet.supportLabel}`,
        );
      } else {
        assert.notEqual(sheet.supportLabel, "SUPPORTED", `${label}/${sheet.name}`);
        // A partial sheet must explain itself; an unexplained partial reads as
        // an unexplained absence of data.
        assert.ok(sheet.gaps.length > 0, `${label}/${sheet.name} is partial with no named gap`);
        for (const gap of sheet.gaps) assert.ok(gap.length > 20, gap);
      }
    }
  }
});

test("the partial and supported split matches the audits", () => {
  // CUDOS: only Billing Summary, Trends and About are fully covered.
  assert.equal(FINOPS_CUDOS_SHEETS.supportedSheets, 3);
  assert.equal(FINOPS_CUDOS_SHEETS.partialSheets, 16);
  assert.equal(FINOPS_COST_INTELLIGENCE_SHEETS.supportedSheets, 6);
  assert.equal(FINOPS_COST_INTELLIGENCE_SHEETS.partialSheets, 4);
  assert.equal(FINOPS_KPI_SHEETS.supportedSheets, 1);
  assert.equal(FINOPS_KPI_SHEETS.partialSheets, 9);
  for (const [, inventory] of INVENTORIES) {
    assert.equal(inventory.supportedSheets + inventory.partialSheets, inventory.totalSheets);
  }
});

test("sheet keys are unique, URL-safe and stable", () => {
  for (const [label, inventory] of INVENTORIES) {
    const keys = inventory.sheets.map(({ key }) => key);
    assert.equal(new Set(keys).size, keys.length, `${label} has duplicate sheet keys`);
    for (const key of keys) assert.match(key, /^[a-z0-9][a-z0-9-]*$/u, `${label}: ${key}`);
  }
  // Punctuation in official names collapses without losing distinctness.
  assert.equal(sheetKey("Executive: Billing Summary"), "executive-billing-summary");
  assert.equal(sheetKey("Storage & Backup"), "storage-backup");
  assert.equal(sheetKey("AI/ML"), "ai-ml");
  assert.equal(sheetKey("OPTICS Explorer "), "optics-explorer");
  assert.equal(sheetKey("   "), "sheet", "an empty slug must still be addressable");
});

test("KPI carries its governed formulas and the 19 goal sliders", () => {
  const tracker = findSheet(FINOPS_KPI_SHEETS, "kpi-tracker");
  assert.notEqual(tracker, null);
  assert.equal(tracker!.formulaIds.length, 19);
  assert.ok(tracker!.formulaIds.includes("ec2_graviton_share"));
  assert.ok(tracker!.formulaIds.includes("ebs_gp3_adoption"));

  // Every formula named on a service sheet must also exist on the tracker, so a
  // sheet cannot reference a formula the dashboard does not govern.
  const governed = new Set(tracker!.formulaIds);
  for (const sheet of FINOPS_KPI_SHEETS.sheets) {
    for (const id of sheet.formulaIds) {
      assert.ok(governed.has(id), `${sheet.name} names ungoverned formula ${id}`);
    }
  }
  assert.equal(FINOPS_KPI_OFFICIAL_DEFINITION.totals.goalSliders, 19);
  assert.equal(FINOPS_KPI_SHEETS.source.version, "v2.2.1");
});

test("every inventory records the exact source pin it mirrors", () => {
  for (const [label, inventory] of INVENTORIES) {
    assert.match(inventory.source.sha256, /^[a-f0-9]{64}$/u, label);
    assert.match(inventory.source.commit, /^[a-f0-9]{40}$/u, label);
    assert.ok(inventory.source.path.length > 10, label);
    assert.equal(
      inventory.source.repository,
      "aws-solutions-library-samples/cloud-intelligence-dashboards-framework",
      label,
    );
  }
  // The three audits pin distinct definition files.
  const shas = INVENTORIES.map(([, inventory]) => inventory.source.sha256);
  assert.equal(new Set(shas).size, 3);
});

test("lookup fails closed and inventories are deeply frozen", () => {
  assert.equal(findSheet(FINOPS_CUDOS_SHEETS, "not-a-sheet"), null);
  assert.equal(findSheet(FINOPS_CUDOS_SHEETS, ""), null);
  assert.notEqual(findSheet(FINOPS_CUDOS_SHEETS, "about"), null);
  for (const [, inventory] of INVENTORIES) {
    assert.equal(Object.isFrozen(inventory), true);
    assert.equal(Object.isFrozen(inventory.sheets), true);
    assert.equal(Object.isFrozen(inventory.sheets[0]), true);
    assert.equal(Object.isFrozen(inventory.sheets[0]!.gaps), true);
  }
});
