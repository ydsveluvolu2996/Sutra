import assert from "node:assert/strict";
import test from "node:test";

import { safeCsvCell, safeCsvRow } from "../lib/safe-csv.ts";

test("CSV fields neutralize direct and whitespace-obscured spreadsheet formulas", () => {
  for (const value of [
    "=HYPERLINK(\"https://attacker.invalid\")",
    "+cmd|' /C calc'!A0",
    "-2+3",
    "@SUM(A1:A2)",
    "\t=1+1",
    "\r@SUM(A1)",
    "  =1+1",
    "\uFEFF+1+1",
    "\u0000-1+1",
  ]) {
    assert.match(safeCsvCell(value), /^"?'/u, JSON.stringify(value));
  }
});

test("CSV fields retain ordinary evidence and apply RFC-4180 quoting", () => {
  assert.equal(safeCsvCell("ordinary"), "ordinary");
  assert.equal(safeCsvCell("has,comma"), '"has,comma"');
  assert.equal(safeCsvCell('has"quote'), '"has""quote"');
  assert.equal(safeCsvCell("line1\nline2"), '"line1\nline2"');
  assert.equal(safeCsvRow(["plain", "has,comma", null]), 'plain,"has,comma",');
});

test("all product CSV producers use the shared hardened cell encoder", async () => {
  const { readFile } = await import("node:fs/promises");
  const paths = [
    "app/api/pilot/export/route.ts",
    "app/api/v1/compliance/route.ts",
    "app/api/v1/compliance/frameworks/route.ts",
    "app/kubernetes/issues/issues-workspace.tsx",
    "app/kubernetes/trends/trends-workspace.tsx",
    "lib/kubernetes-risk-queue.ts",
    "lib/report-builder.ts",
  ];
  for (const path of paths) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(source, /safeCsvCell/u, path);
    assert.doesNotMatch(source, /function csvCell/u, path);
  }
});
