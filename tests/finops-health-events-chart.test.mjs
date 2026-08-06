import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const raw = readFileSync(`${root}/app/costs/finops-health-events-dashboard.tsx`, "utf8");
const source = raw.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");

test("the blast-radius ranking is drawn by the chart kit", () => {
  assert.match(source, /import \{ RankingBars \} from "\.\.\/components\/charts"/u);
  assert.match(source, /<UpcomingAccountsByService/u);
});

test("services rank by affected accounts, not by event count", () => {
  // Ten advisories against one account is a smaller planning problem than one
  // advisory against ten, so accounts is the ranked measure.
  assert.match(source, /accounts: current\.accounts \+ item\.affectedAccountCount/u);
  assert.match(source, /\$\{value\.toLocaleString\("en-US"\)\} accounts/u);
});

test("an unsupplied service is an explicit absence bucket, not a drop or a fold", () => {
  assert.match(source, /Service not supplied/u);
  assert.match(source, /AWS supplied no service for these/u);
  // Colour must never be the only cue that a bucket is absence.
  assert.match(source, /tone: service === null \? \("slate" as const\)/u);
});

test("truncation is disclosed because it can change the ranking", () => {
  assert.match(source, /A service outside those rows could outrank everything shown/u);
});

test("an empty timeline renders no chart rather than an empty axis", () => {
  assert.match(source, /if \(totals\.size === 0\) return null;/u);
});

test("the summary counts are deliberately not charted as a partition", () => {
  // pastCount/currentCount/upcomingCount/actionRequiredCount overlap:
  // actionRequired is not disjoint from current or upcoming, so ranking them
  // together would imply a partition that does not exist.
  assert.ok(!source.includes("actionRequiredCount,"), "action-required was folded into a chart series");
});
