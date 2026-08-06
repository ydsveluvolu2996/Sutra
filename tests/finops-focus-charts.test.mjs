import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const raw = readFileSync(`${root}/app/costs/finops-focus-dashboard.tsx`, "utf8");
// Assert against code only. The doc comments deliberately quote the removed
// expressions to explain why they went, and must not trip these checks.
const source = raw.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
const css = readFileSync(`${root}/app/costs/costs.module.css`, "utf8");

test("a missing cost is no longer coerced to zero before plotting", () => {
  // `focusCostMicros(entry, basis) ?? "0"` plotted absence as a zero amount,
  // which the bar floor then drew as a visible stub.
  assert.doesNotMatch(source, /focusCostMicros\([^)]*\) \?\? "0"/u, 'a `?? "0"` cost coercion remains');
});

test("no bar floor survives", () => {
  assert.doesNotMatch(source, /Math\.max\(4, relativeHeight/u);
  assert.doesNotMatch(source, /Math\.max\(1, relativeHeight/u);
  assert.ok(!source.includes("relativeHeight"), "the superseded height helper remains");
});

test("the sign-erasing divisor is gone, so a credit no longer draws like a charge", () => {
  assert.ok(!source.includes("absoluteMicros"), "absoluteMicros still erases sign for plotting");
});

test("amounts beyond exact double range are refused rather than rounded", () => {
  assert.match(source, /Number\.isSafeInteger\(parsed\)/u);
});

test("all four panels are drawn by the chart kit", () => {
  assert.match(source, /import \{ RankingBars, TimeSeriesChart \} from "\.\.\/components\/charts"/u);
  assert.equal((source.match(/<FocusCostTrend/gu) ?? []).length, 2, "expected two trends");
  assert.equal((source.match(/<FocusDimensionRanking/gu) ?? []).length, 2, "expected two rankings");
});

test("excluded rows are disclosed rather than silently dropped", () => {
  assert.match(source, /excluded\s*\n?\s*from the chart rather than drawn as zero/u);
});

test("basis coverage survives the migration", () => {
  // Coverage of "unavailable" is a truth signal about the selected basis and
  // must not be lost with the markup the chart replaced.
  assert.match(source, /focusCostCoverage\(entry, costBasis\)/u);
  assert.ok(css.includes("focusCoverageList"), "the coverage list has no styling");
});

test("every superseded maximum divisor is gone, not left dangling", () => {
  for (const dead of ["maximumDimensionCost", "maximumSecondaryCost", "maximumTrendCost", "maximumDailyCost"]) {
    assert.ok(!source.includes(dead), `${dead} is still referenced`);
  }
});

test("the CSS that styled the removed markup is removed with it", () => {
  assert.ok(!css.includes("focusTrendChart"), "dead trend-chart rules remain");
  assert.ok(!css.includes("focusDimensionBars"), "dead dimension-bar rules remain");
});
