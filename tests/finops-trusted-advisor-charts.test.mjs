import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const source = readFileSync(`${root}/app/costs/finops-trusted-advisor-organizational-dashboard.tsx`, "utf8");
const css = readFileSync(`${root}/app/costs/costs.module.css`, "utf8");

test("no hand-rolled bar floor survives in this dashboard", () => {
  // Every one of these floored a measured zero into a visible bar, making
  // "nothing flagged" indistinguishable from "one flagged".
  assert.doesNotMatch(source, /Math\.max\(2, Math\.round/u, "a 2% bar floor remains");
  assert.doesNotMatch(source, /Math\.max\(4, Math\.round/u, "a 4% bar floor remains");
  assert.doesNotMatch(source, /entry\.count === 0 \? 0 : 2/u, "the status special-case remains");
});

test("the four panels are drawn by the chart kit", () => {
  assert.match(source, /import \{ RankingBars, TimeSeriesChart \} from "\.\.\/components\/charts"/u);
  assert.equal((source.match(/<RankingBars/gu) ?? []).length, 3, "expected three ranked panels");
  assert.equal((source.match(/<TimeSeriesChart/gu) ?? []).length, 1, "expected one trend");
});

test("every superseded maximum divisor is gone, not left dangling", () => {
  for (const dead of [
    "maximumHistoryResources",
    "maximumCategoryFlagged",
    "maximumStatusCount",
    "maximumRegionCount",
  ]) {
    assert.ok(!source.includes(dead), `${dead} is still referenced`);
  }
});

test("absence stays a worded state in every panel", () => {
  assert.match(source, /No category evidence is available/u);
  assert.match(source, /No accepted resource rows are available/u);
  assert.match(source, /No regional resource evidence is available/u);
  assert.match(source, /No accepted history is available/u);
});

test("the irregular generation cadence is disclosed rather than implied", () => {
  assert.match(source, /spacing does not represent elapsed time/u);
});

test("the CSS that styled the removed markup is removed with it", () => {
  assert.ok(!css.includes("taoHorizontalBars"), "dead horizontal-bar rules remain");
  assert.ok(!css.includes("taoHistoryChart"), "dead history-chart rules remain");
});
