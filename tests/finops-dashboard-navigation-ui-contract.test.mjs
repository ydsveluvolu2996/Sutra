import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [browser, navigation, shell, css] = await Promise.all([
  readFile(new URL("../app/costs/costs-browser.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/costs/finops-dashboard-catalog-nav.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/costs/finops-capability-shell.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/costs/costs.module.css", import.meta.url), "utf8"),
]);

test("cost workspace adds the 29-dashboard catalog without replacing shared analysis", () => {
  assert.match(browser, /<FinopsDashboardCatalogNav[\s\S]*connectionId=\{connectionId\}[\s\S]*onOpenSharedAnalysis=\{navigateToSection\}/u);
  assert.match(browser, /FINOPS_SECTIONS\.map/u);
  assert.match(browser, /<FinopsFoundationalPanels/u);
  assert.match(browser, /<FinopsWave3Panels/u);
  assert.match(browser, /<FinopsSourcesPanel/u);
  assert.match(browser, /#finops-\$\{section\}/u);
  assert.ok(browser.includes("window.location.hash.replace(/^#finops-/u"));
  assert.match(browser, /document\.getElementById\(`finops-\$\{section\}`\)/u);
  assert.match(browser, /target\?\.scrollIntoView/u);
  assert.match(browser, /target\?\.focus/u);
  assert.doesNotMatch(browser, /Existing live capability|Live capability/u);
});

test("dashboard navigation is grouped, hash-addressable, and maturity-labelled", () => {
  assert.match(navigation, /"foundational"[\s\S]*"advanced"[\s\S]*"additional"/u);
  assert.match(navigation, /listFinopsDashboardsByLevel\(level\)/u);
  assert.match(navigation, /#finops-dashboard-\$\{dashboard\.slug\}/u);
  assert.match(navigation, /\^#finops-dashboard-\(\.\+\)\$/u);
  assert.match(navigation, /aria-current=\{selected\.id === dashboard\.id \? "page"/u);
  assert.match(navigation, /aria-label="Cloud Intelligence dashboards"/u);
  assert.match(navigation, /MATURITY_LABELS\[dashboard\.currentMaturity\]/u);
  assert.match(navigation, /aria-controls=\{`finops-\$\{selected\.relatedSharedAnalysis\}`\}/u);
  assert.match(navigation, /no entry is presented as production accepted/iu);
});

test("reusable shell declares every honest delivery state and an evidence drawer", () => {
  for (const state of [
    "loading",
    "configuration_required",
    "waiting",
    "empty",
    "partial",
    "stale",
    "failed",
    "complete",
    "not_implemented",
  ]) {
    assert.match(shell, new RegExp(`\\| "${state}"|${state}:`, "u"), state);
  }
  assert.match(shell, /Source evidence and limitations/u);
  assert.match(shell, />Accepted \/ rejected</u);
  assert.match(shell, />SHA-256</u);
  assert.match(shell, /role=\{state === "failed" \? "alert" : "status"\}/u);
  assert.match(shell, /mayRenderEvidence \? children : null/u);
  assert.doesNotMatch(shell, /fixture|sample spend|dummy metric/iu);
});

test("catalog navigation remains usable on tablet and phone layouts", () => {
  assert.match(css, /\.dashboardCatalogLayout \{ display: grid; grid-template-columns:/u);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.dashboardCatalogNav \{ max-height: none; overflow-x: auto;/u);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.capabilityStateBoundary \{ grid-template-columns:/u);
  assert.match(css, /\.dashboardCatalogNav button:focus-visible/u);
  assert.match(css, /\.capabilityEvidence dl \{ display: grid;/u);
});
