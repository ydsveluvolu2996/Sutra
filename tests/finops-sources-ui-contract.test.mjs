import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const [panel, browser, css] = await Promise.all([
  readFile(path.join(root, "app/costs/finops-sources-panel.tsx"), "utf8"),
  readFile(path.join(root, "app/costs/costs-browser.tsx"), "utf8"),
  readFile(path.join(root, "app/costs/costs.module.css"), "utf8"),
]);

test("data sources section is backed by the tenant-scoped readiness route", () => {
  assert.match(panel, /\/api\/v1\/finops\/sources\?connectionId=\$\{encodeURIComponent\(connectionId\)\}/u);
  assert.match(panel, /cache: "no-store"/u);
  assert.match(panel, /credentials: "same-origin"/u);
  assert.match(browser, /activeSection === "sources" \? <FinopsSourcesPanel connectionId=\{connectionId\} \/>/u);
  assert.match(browser, /\["containers", "marketplace", "sustainability", "operations"\]/u);
  assert.doesNotMatch(browser, /\["containers", "marketplace", "sustainability", "operations", "sources"\]/u);
  assert.match(
    browser,
    /connection\?\.sourceKind === "aws_trust_role"[\s\S]*connection\.status === "active"[\s\S]*\(\["containers", "marketplace", "sustainability", "operations"\]/u,
  );
});

test("source health exposes every honest state and required evidence dimension", () => {
  for (const state of [
    "not_configured",
    "waiting_first_delivery",
    "healthy",
    "stale",
    "partial",
    "failed",
  ]) {
    assert.match(panel, new RegExp(`"${state}"`, "u"));
  }
  assert.match(panel, />Freshness</u);
  assert.match(panel, />Coverage</u);
  assert.match(panel, />Last success</u);
  assert.match(panel, />Last error</u);
  assert.match(panel, />Prerequisites</u);
  assert.match(panel, /No persisted configuration or delivery evidence/u);
  assert.doesNotMatch(panel, /demo|sampleSpend|fixtureSpend|placeholder result/iu);
});

test("capability tracker renders API-derived totals and all enterprise levels", () => {
  assert.match(panel, /report\.summary\.readyCapabilities/u);
  assert.match(panel, /report\.summary\.totalCapabilities/u);
  assert.match(panel, /report\.summary\.sources\[state\]/u);
  assert.match(panel, /report\.summary\.capabilities\[state\]/u);
  assert.match(panel, /report\.capabilities\.filter\(\(capability\) => capability\.level === level\)/u);
  assert.match(panel, /"foundational"/u);
  assert.match(panel, /"advanced"/u);
  assert.match(panel, /"additional"/u);
});

test("source readiness layout preserves accessible labels and responsive cards", () => {
  assert.match(panel, /aria-label="Source and capability state counts"/u);
  assert.match(panel, /aria-labelledby="source-inventory-heading"/u);
  assert.match(panel, /aria-labelledby="capability-readiness-heading"/u);
  assert.match(panel, /role="status"/u);
  assert.match(panel, /role="alert"/u);
  assert.match(css, /@media screen and \(max-width: 720px\)[\s\S]*\.capabilityRow \{ grid-template-columns: 1fr;/u);
  assert.match(css, /\.capabilityScore button:focus-visible/u);
});
