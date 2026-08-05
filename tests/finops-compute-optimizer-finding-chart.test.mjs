import assert from "node:assert/strict";
import { after, test } from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

/**
 * Pins the finding-count ranking that feeds the chart on ADV-01.
 *
 * This panel drew its own bars with `width: count * 100 / maxFinding`, where
 * maxFinding was floored at 1. Two defects came with that, and the chart kit
 * closes both:
 *
 * 1. With every count at zero the divisor floor made each bar zero-width, so a
 *    set of real measured zeros looked exactly like absent evidence.
 * 2. Every bucket was styled identically, so the synthetic "Missing provider
 *    value" and "Tag key not selected" groups read as finding categories AWS
 *    had reported. They are counts of ABSENCE and must be distinguishable.
 */

const vite = await createServer({
  root: new URL("..", import.meta.url).pathname,
  configFile: false,
  logLevel: "silent",
  plugins: [react()],
  server: { middlewareMode: true },
});
const dashboard = await vite.ssrLoadModule("/app/costs/finops-compute-optimizer-dashboard.tsx");
after(async () => vite.close());

const present = (value, count) => ({ key: { state: "PRESENT", value }, count });
const missing = (count) => ({ key: { state: "MISSING", value: null }, count });
const unselected = (count) => ({ key: { state: "NOT_SELECTED", value: null }, count });

test("findings rank descending by count", () => {
  const items = dashboard.findingCountRanking([
    present("UNDER_PROVISIONED", 3),
    present("OVER_PROVISIONED", 11),
    present("OPTIMIZED", 7),
  ]);
  assert.deepEqual(items.map((item) => item.label), [
    "OVER_PROVISIONED",
    "OPTIMIZED",
    "UNDER_PROVISIONED",
  ]);
  assert.deepEqual(items.map((item) => item.value), [11, 7, 3]);
});

test("a provider finding and an absence bucket are visually distinct", () => {
  const items = dashboard.findingCountRanking([present("OPTIMIZED", 5), missing(4)]);
  const [finding, absence] = items;
  assert.equal(finding.label, "OPTIMIZED");
  assert.equal(absence.label, "Missing provider value");
  assert.notEqual(finding.tone, absence.tone, "an absence must not share a finding's tone");
  // Hue is never the only cue: the absence carries explanatory detail text.
  assert.equal(finding.detail, undefined);
  assert.match(absence.detail, /not a finding/u);
});

test("the unselected-tag bucket is also treated as an absence", () => {
  const [item] = dashboard.findingCountRanking([unselected(9)]);
  assert.equal(item.label, "Tag key not selected");
  assert.equal(item.tone, "slate");
  assert.match(item.detail, /not a finding/u);
});

test("a set of measured zeros is preserved rather than flattened", () => {
  // The old divisor floor of 1 made these indistinguishable from no evidence.
  const items = dashboard.findingCountRanking([present("OPTIMIZED", 0), present("IDLE", 0)]);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.value), [0, 0]);
});

test("a non-finite count is dropped rather than plotted as a magnitude", () => {
  const items = dashboard.findingCountRanking([
    present("OPTIMIZED", Number.NaN),
    present("IDLE", Number.POSITIVE_INFINITY),
    present("REAL", 2),
  ]);
  assert.deepEqual(items.map((item) => item.label), ["REAL"]);
});

test("ties break by label so the order is deterministic", () => {
  const items = dashboard.findingCountRanking([present("zebra", 4), present("alpha", 4)]);
  assert.deepEqual(items.map((item) => item.label), ["alpha", "zebra"]);
});

test("ids stay unique across absence buckets that share a null value", () => {
  const items = dashboard.findingCountRanking([missing(2), unselected(1)]);
  assert.equal(new Set(items.map((item) => item.id)).size, 2);
});

test("no findings produce no ranking rather than an empty axis", () => {
  assert.deepEqual(dashboard.findingCountRanking([]), []);
});
