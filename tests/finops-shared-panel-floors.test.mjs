import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
const foundational = strip(readFileSync(`${root}/app/costs/finops-foundational-panels.tsx`, "utf8"));
const cur = strip(readFileSync(`${root}/app/costs/finops-cur-intelligence-panels.tsx`, "utf8"));
const css = readFileSync(`${root}/app/costs/costs.module.css`, "utf8");

test("the CUR intelligence JS floor is gone", () => {
  assert.doesNotMatch(cur, /Math\.max\(3, relativeBasisPoints/u, "the 3% floor remains");
});

test("both shared helpers report absence as null, not as zero", () => {
  // Returning 0 made "no cost supplied" and "measured zero" the same bar.
  assert.match(foundational, /function relativeBasisPoints\(value: string \| null, maximum: bigint\): bigint \| null/u);
  assert.match(cur, /function relativeBasisPoints\(value: string \| null, maximum: bigint\): number \| null/u);
  for (const source of [foundational, cur]) {
    assert.match(source, /if \(value === null \|\| ![A-Z_]+\.test\(value\)\) return null;/u);
    assert.match(source, /if \(maximum <= BigInt\(0\)\) return null;/u);
  }
});

test("a measured zero still returns zero and still draws as zero", () => {
  assert.match(foundational, /if \(parsed <= BigInt\(0\)\) return BigInt\(0\);/u);
});

test("every shared bar site marks absence explicitly", () => {
  // Three sites in the foundational panels (two trend columns, one horizontal
  // bar) and one in the CUR intelligence panel.
  assert.equal((foundational.match(/data-absent=/gu) ?? []).length, 3, "expected three marked sites");
  assert.equal((cur.match(/data-absent=/gu) ?? []).length, 1, "expected one marked site");
});

test("the CSS floors on the shared columns are removed", () => {
  const line = (name) => css.split("\n").find((row) => row.startsWith(name)) ?? "";
  assert.ok(!line(".foundationalTrendColumn > i").includes("min-height"), "the 4px floor remains");
  assert.ok(!line(".curColumn > i").includes("min-height"), "the 3px floor remains");
});

test("absence is drawn with a non-colour cue", () => {
  // Hue must never be the only signal that a bar is absence rather than data.
  assert.match(css, /\[data-absent="true"\][^}]*border: 1px dashed/u);
  assert.match(css, /\[data-absent="true"\][^}]*repeating-linear-gradient/u);
});

test("out-of-scope floors are left alone deliberately", () => {
  // .trendColumn and .miniSpark belong to costs-browser and visibility-panels,
  // which are not among the 27 in-scope FinOps dashboards.
  assert.match(css, /\.trendColumn > i \{[^}]*min-height: 4px/u);
  assert.match(css, /\.miniSpark i \{[^}]*min-height: 3px/u);
});
