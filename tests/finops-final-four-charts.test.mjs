import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
const read = (name) => strip(readFileSync(`${root}/app/costs/finops-${name}-dashboard.tsx`, "utf8"));
const scad = read("scad-allocation");
const media = read("media-services-insights");
const news = read("aws-news-feeds");
const budgets = read("aws-budgets-organization");

test("ADD-07 SCAD ranks within a currency, never across", () => {
  assert.match(scad, /<ScadCurrencyRankings/u);
  assert.match(scad, /This scale is not comparable with another currency's chart/u);
  // An entry with no cost in a currency is absent from that chart, not a zero.
  assert.match(scad, /if \(cost === undefined\) continue;/u);
  assert.match(scad, /absent rather than ranked at zero/u);
});

test("ADD-07 refuses to round an exact rational into a coordinate", () => {
  assert.match(scad, /Number\.isSafeInteger\(numerator\) \|\| !Number\.isSafeInteger\(denominator\)/u);
  assert.match(scad, /if \(denominator === 0\) return null;/u);
});

test("ADV-13 Media Services groups by currency and cost basis, not by period", () => {
  assert.match(media, /const key = `\$\{point\.currency\}\|\$\{point\.costBasis\}`/u);
  assert.match(media, /not comparable with another currency or cost basis/u);
});

test("ADV-13 keeps the Sutra projection out of the observed line", () => {
  assert.match(media, /the Sutra projection below is not plotted here/u);
  const start = media.indexOf("function MediaCostTrends");
  const ends = ["\nfunction ", "\nexport function "].map((m) => media.indexOf(m, start + 1)).filter((i) => i !== -1);
  const body = media.slice(start, ends.length === 0 ? undefined : Math.min(...ends));
  assert.ok(!body.includes("forecast"), "the forecast is joined to the observed series");
});

test("ADV-13 treats a missing service-period as a gap, not a zero", () => {
  assert.match(media, /if \(row === undefined \|\| row\.costMicros === null\) return \[\];/u);
});

test("ADV-07 News Feeds separates a failed fetch from a published zero", () => {
  assert.match(news, /<SourceContributionRanking/u);
  assert.match(news, /count is not a measurement/u);
  assert.match(news, /tone: failed \? \("slate" as const\)/u);
  // The dashboard opens by calling itself context, not impact evidence.
  assert.match(news, /not relevance or impact/u);
});

test("ADV-08 Budgets never stacks budgeted, actual and forecast", () => {
  assert.match(budgets, /layout="grouped"/u);
  assert.doesNotMatch(budgets, /layout="stacked"/u);
  assert.match(budgets, /never summed/u);
});

test("ADV-08 keeps all groups of a currency on one shared axis", () => {
  // One chart per group would rescale each group to itself and destroy the
  // cross-group comparison the per-currency maximum already provided.
  assert.match(budgets, /categories: monetary\.map\(\(group\) => group\.label\)/u);
});

test("ADV-08 excludes relationship-only groups rather than plotting them at zero", () => {
  assert.match(budgets, /group\.monetaryAllocation !== "relationship_only"/u);
  assert.match(budgets, /no amount\s*\n?\s*to plot/u);
});

test("ADV-08 leaves the exact gauge alone", () => {
  // gaugeRatio is bigint-exact and the kit has no gauge primitive; porting it
  // would trade precision for consistency.
  assert.match(budgets, /function gaugeRatio/u);
});
