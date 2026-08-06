import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const raw = readFileSync(`${root}/app/costs/finops-pricing-change-dashboard.tsx`, "utf8");
// Assert against code only; the doc comments quote the removed expressions.
const source = raw.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
const css = readFileSync(`${root}/app/costs/finops-pricing-change-dashboard.module.css`, "utf8");

test("no single divisor spans every currency any more", () => {
  // `maximum` was reduced over a flatMap across all currencies, then used to
  // scale the bars inside each per-currency card.
  assert.ok(!source.includes("modeledTotalsByCurrency.flatMap"), "the cross-currency divisor remains");
  assert.doesNotMatch(source, /const maximum =/u, "a shared maximum remains");
});

test("the sign-erasing percentage helper is gone", () => {
  assert.ok(!source.includes("function percentage"), "percentage() still scales by absolute value");
});

test("each currency card scales only within its own currency", () => {
  assert.match(source, /<CurrencyCatalogImpact total=\{total\}/u);
  assert.match(source, /This scale is not comparable with another currency's card/u);
});

test("amounts beyond exact double range are refused rather than rounded", () => {
  assert.match(source, /Number\.isSafeInteger\(parsed\)/u);
});

test("exact figures still come from the original micros string", () => {
  assert.match(source, /detail: formatMicros\(row\.micros, total\.currency\)/u);
});

test("a currency with nothing exactly plottable says so", () => {
  assert.match(source, /Neither total is exactly plottable in/u);
});

test("the CSS bar floor is removed with the markup it styled", () => {
  // `.bar { min-width: 2px }` floored a zero-length bar into a visible stub in
  // CSS, the same defect the JS floors caused.
  assert.ok(!css.includes("min-width: 2px"), "the CSS bar floor remains");
  for (const dead of [".barRow", ".barTrack", ".barComparison"]) {
    assert.ok(!css.includes(dead), `${dead} still styles removed markup`);
  }
});
