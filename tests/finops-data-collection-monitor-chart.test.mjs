import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const raw = readFileSync(`${root}/app/costs/finops-data-collection-monitor-dashboard.tsx`, "utf8");
const source = raw.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");

test("the failure ranking is drawn by the chart kit", () => {
  assert.match(source, /import \{ RankingBars \} from "\.\.\/components\/charts"/u);
  assert.match(source, /<ModuleFailureRanking modules=\{visibleModules\}/u);
});

test("a module that ran without failing stays plotted at zero", () => {
  // Filtering it out would make a healthy module indistinguishable from one
  // that never reported, which is the opposite of what a monitor should say.
  assert.ok(!/\.filter\(\([a-zA-Z]+\) => [a-zA-Z]+\.failureCount/u.test(source), "zero-failure modules are filtered out");
  assert.match(source, /stays plotted at zero/u);
});

test("retries are not stacked with failures", () => {
  // A retry is not a failed execution; stacking would invent a total.
  assert.match(source, /detail: `\$\{moduleEntry\.executionCount/u);
  assert.doesNotMatch(source, /series: \[[^\]]*retryCount/u);
});

test("coverage is not charted against a nullable denominator", () => {
  // coverage.expected is nullable; a ratio against it would state a
  // completeness the framework never reported.
  const start = source.indexOf("function ModuleFailureRanking");
  const ends = ["\nfunction ", "\nexport function "]
    .map((marker) => source.indexOf(marker, start + 1))
    .filter((index) => index !== -1);
  const body = source.slice(start, ends.length === 0 ? undefined : Math.min(...ends));
  assert.ok(!body.includes("coverage"), "coverage is charted despite a nullable expected");
});

test("no modules renders no chart rather than an empty axis", () => {
  assert.match(source, /if \(modules\.length === 0\) return null;/u);
});
