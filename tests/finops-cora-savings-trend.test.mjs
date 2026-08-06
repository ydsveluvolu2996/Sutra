import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const raw = readFileSync(`${root}/app/costs/finops-cora-dashboard.tsx`, "utf8");
const source = raw.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");

test("the savings trend is drawn by the chart kit", () => {
  assert.match(source, /import \{ TimeSeriesChart \} from "\.\.\/components\/charts"/u);
  assert.match(source, /<CoraSavingsTrend history=\{report\.history\}/u);
});

test("the chart plots one basis only, never the table's after-??-before fallback", () => {
  // A cell can be read beside its own row; a line cannot. A series that
  // switched basis between generations would look like a savings change that
  // never happened.
  // Scope to the component body only: the table later in the file legitimately
  // renders the fallback, because a cell is read beside its own row.
  const start = source.indexOf("function CoraSavingsTrend");
  const end = source.indexOf("\nfunction ", start + 1);
  const body = source.slice(start, end === -1 ? undefined : end);
  assert.ok(
    !body.includes("estimatedMonthlySavingsBeforeDiscountMicros"),
    "the chart falls back to the before-discount basis",
  );
  assert.match(source, /after-discount only/u);
});

test("a partially supplied generation is excluded, not summed partially", () => {
  assert.match(source, /excluded rather than summed\s*\n?\s*partially/u);
  assert.match(source, /if \(exact\.length !== amounts\.length\)/u);
});

test("each currency gets its own chart and its own axis", () => {
  assert.match(source, /this scale is not comparable with another currency's chart/u);
});

test("the irregular generation cadence is disclosed", () => {
  assert.match(source, /spacing does not represent elapsed time/u);
});

test("amounts beyond exact double range are refused rather than rounded", () => {
  assert.match(source, /Number\.isSafeInteger\(parsed\)/u);
});

test("no history renders no chart rather than an empty axis", () => {
  assert.match(source, /if \(charts\.length === 0\) return null;/u);
});
