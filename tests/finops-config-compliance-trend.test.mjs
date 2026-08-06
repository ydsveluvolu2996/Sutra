import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const raw = readFileSync(`${root}/app/costs/finops-aws-config-resource-compliance-dashboard.tsx`, "utf8");
const source = raw.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
const css = readFileSync(`${root}/app/costs/finops-aws-config-resource-compliance-dashboard.module.css`, "utf8");

test("the compliance trend no longer floors a measured zero", () => {
  // ADD-12's ranking panel was charted earlier, but this second panel kept a
  // live Math.max(4, ...) floor against a maximum floored at 1: a generation
  // that accepted zero non-compliant resources drew the same visible stub as
  // one that found a single resource.
  assert.doesNotMatch(source, /Math\.max\(4, Math\.round/u, "the JS bar floor remains");
  assert.ok(!source.includes("maximumTrend"), "the floored divisor remains");
});

test("the trend is drawn by the chart kit", () => {
  assert.match(source, /import \{ RankingBars, TimeSeriesChart/u);
  assert.match(source, /ariaLabel="AWS Config non-compliant resource history"/u);
});

test("the irregular generation cadence is disclosed", () => {
  assert.match(source, /spacing does not represent elapsed time/u);
});

test("an empty history stays a worded state", () => {
  assert.match(source, /No accepted history yet/u);
});

test("the CSS floor is removed with the markup it styled", () => {
  assert.ok(!css.includes("min-height: 4px"), "the CSS bar floor remains");
  assert.ok(!/^\.trend/mu.test(css), "dead trend rules remain");
});
