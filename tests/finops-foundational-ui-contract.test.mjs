import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  FINOPS_KPI_FORMULAS,
  FINOPS_KPI_IDS,
} from "../lib/finops-kpi.ts";

const root = path.resolve(import.meta.dirname, "..");
const [panel, browser, css] = await Promise.all([
  readFile(
    path.join(root, "app/costs/finops-foundational-panels.tsx"),
    "utf8",
  ),
  readFile(path.join(root, "app/costs/costs-browser.tsx"), "utf8"),
  readFile(path.join(root, "app/costs/costs.module.css"), "utf8"),
]);

test("Foundational panels use only the three tenant-resolved report envelopes", () => {
  assert.match(panel, /\/api\/v1\/finops\/cudos\?\$\{query\.toString\(\)\}/u);
  assert.match(panel, /\/api\/v1\/finops\/cost-intelligence\?\$\{query\.toString\(\)\}/u);
  assert.match(panel, /\/api\/v1\/finops\/kpi\?\$\{query\.toString\(\)\}/u);
  assert.match(panel, /new URLSearchParams\(\{\s*connectionId,/u);
  assert.match(panel, /costBasis: "amortized"/u);
  assert.match(panel, /rankingLimit: "8"/u);
  assert.match(panel, /allocationMode: "showback"/u);
  assert.match(panel, /moverDimension: "service"/u);
  assert.match(panel, /body\.connectionId !== connectionId/u);
  assert.match(panel, /!\("report" in body\)/u);
  assert.match(panel, /cache: "no-store"/u);
  assert.match(panel, /credentials: "same-origin"/u);
  assert.doesNotMatch(panel, /body\.(?:result|data)/u);
});

test("exact micros and ranking widths never convert billing integers to Number", () => {
  const formatter = panel.slice(
    panel.indexOf("export function formatMicrosExact"),
    panel.indexOf("function formatBasisPoints"),
  );
  assert.match(formatter, /BigInt\(micros\)/u);
  assert.match(formatter, /BigInt\(1_000_000\)/u);
  assert.doesNotMatch(formatter, /Number\s*\(/u);
  assert.match(panel, /function relativeBasisPoints/u);
  assert.match(panel, /parsed \* BigInt\(10_000\)/u);
  assert.match(panel, /report\.unitCosts\.invariant/u);
  assert.doesNotMatch(panel, /fixture|demo|sample|fallback/iu);
});

test("every honest canonical source state is visible and actionable", () => {
  for (const state of [
    "idle",
    "loading",
    "waiting",
    "configuration_required",
    "ready",
    "incomplete",
    "error",
  ]) {
    assert.match(panel, new RegExp(`"${state}"`, "u"));
  }
  assert.match(panel, /No active reconciled generation/u);
  assert.match(panel, /Source evidence is incomplete/u);
  assert.match(panel, /Organization taxonomy is required/u);
  assert.match(panel, /At least one selected cost basis is incomplete/u);
  assert.match(panel, /Source evidence is partial/u);
  assert.match(panel, /report\.trends\.monthly/u);
  assert.match(panel, /report\.trends\.weekly/u);
  assert.match(panel, /report\.trends\.daily/u);
  assert.match(panel, /report\.rankings\.serviceCategories/u);
  assert.match(panel, /Resource: \{report\.drilldowns\.resource\.status\}/u);
  assert.match(panel, /Hourly: \{report\.drilldowns\.hourly\.status\}/u);
  assert.match(panel, /active\.sourceUpdatedAtIso/u);
  assert.match(panel, /active\.observedAtIso/u);
  assert.match(panel, /role="status"/u);
  assert.match(panel, /role="alert"/u);
  assert.match(panel, />Retry</u);
});

test("official audits remain visible independently of report readiness and validate server pins", () => {
  assert.match(
    panel,
    /<CudosOfficialEvidence definition=\{cudosOfficialDefinition\} \/>[\s\S]*\{statusReady\(cudos\)/u,
  );
  assert.match(
    panel,
    /<CostIntelligenceOfficialEvidence[\s\S]*definition=\{costIntelligenceOfficialDefinition\}[\s\S]*\{statusReady\(costIntelligence\)/u,
  );
  assert.match(
    panel,
    /<KpiOfficialEvidence definition=\{kpiOfficialDefinition\} \/>[\s\S]*\{statusReady\(kpi\)/u,
  );
  assert.match(
    panel,
    /stateEnvelope\(cudos\)\?\.officialDefinition[\s\S]*FINOPS_CUDOS_OFFICIAL_DEFINITION/u,
  );
  assert.match(
    panel,
    /stateEnvelope\(costIntelligence\)[\s\S]*FINOPS_COST_INTELLIGENCE_OFFICIAL_DEFINITION/u,
  );
  assert.match(
    panel,
    /stateEnvelope\(kpi\)\?\.officialDefinition[\s\S]*FINOPS_KPI_OFFICIAL_DEFINITION/u,
  );
  for (const identity of [
    "4db8cd567b3aea50b44f4e7c3d175586799a5aaf3e923db260b570ae56d1aea2",
    "71795647fd09a17c3a2e1ea2f1308d6aecb150efe339a0950866ad766ef10ab0",
    "fd669f207c5589b4b54b981d6d85affb3af449871e908b85a4c1b9b357c35b1a",
    "299c6d39c55c28221b0d0d771358f526931d60fb5f4d00ba4f663d22554b89a1",
  ]) assert.match(panel, new RegExp(identity, "u"), identity);
  assert.match(panel, /does not fabricate spend, usage, savings, or/u);
});

test("KPI scorecard is driven by the complete versioned 19-formula registry", () => {
  assert.equal(FINOPS_KPI_IDS.length, 19);
  assert.equal(FINOPS_KPI_FORMULAS.length, 19);
  assert.deepEqual(
    FINOPS_KPI_FORMULAS.map(({ id }) => id),
    [...FINOPS_KPI_IDS],
  );
  for (const formula of FINOPS_KPI_FORMULAS) {
    assert.ok(formula.label.length > 0, formula.id);
  }
  assert.match(panel, /FINOPS_KPI_IDS\.every/u);
  assert.match(panel, /visibleRegistry\.map\(\(formula\)/u);
  assert.match(panel, /measurement\.selectedGoal\.targetBasisPoints/u);
  assert.match(panel, /Candidate estimate · validation required/u);
});

test("workspace wires canonical panels into the required sections and gates legacy numeric panels", () => {
  assert.match(browser, /<FinopsFoundationalPanels/u);
  for (const section of [
    "overview",
    "explorer",
    "allocation",
    "optimization",
    "commitments",
    "services",
  ]) {
    assert.match(
      browser,
      new RegExp(`"${section}"`, "u"),
      section,
    );
  }
  assert.match(browser, /foundationalAvailability === "legacy"[\s\S]*<VisibilityPanels/u);
  assert.match(browser, /foundationalAvailability === "legacy"[\s\S]*<FinopsMorePanels/u);
  assert.match(browser, /activeSection === "commitments" && foundationalAvailability === "legacy"/u);
  assert.match(browser, /activeSection === "services" && foundationalAvailability === "legacy"/u);
  assert.match(browser, /activeSection === "optimization" && foundationalAvailability === "legacy"/u);
});

test("visuals are accessible, responsive, and bound source identifiers", () => {
  assert.match(panel, /role="img"/u);
  assert.match(
    panel,
    /aria-label="Cost Intelligence billing summary by currency"/u,
  );
  assert.match(
    panel,
    /aria-label="Official AWS Cost Intelligence dashboard definition"/u,
  );
  assert.match(
    panel,
    /aria-label="Official Cost Intelligence dashboard sheet inventory"/u,
  );
  assert.match(panel, /sheet\.gaps\.join/u);
  assert.match(panel, /title="MoM Pivot · Spend"/u);
  assert.match(
    panel,
    /<caption>Cost Intelligence exact month over month spend pivot<\/caption>/u,
  );
  assert.match(panel, /title="Bounded explorer groups"/u);
  assert.match(panel, /title="Expiring RI\/SP Tracker"/u);
  assert.match(
    panel,
    /<caption>Evidence-backed expiring RI and Savings Plans<\/caption>/u,
  );
  assert.match(
    panel,
    /This is not a claim\s+that no commitments exist\./u,
  );
  assert.match(panel, /"All 19 Foundational KPI measurements"/u);
  assert.match(panel, /<caption>Signed charge-kind disclosure by currency<\/caption>/u);
  assert.match(panel, /sourceLineIds\.slice\(0, 3\)/u);
  assert.match(panel, /visibleOpportunities\.slice\(0, 12\)/u);
  assert.match(panel, /Official AWS KPI dashboard definition/u);
  assert.match(panel, /envelope\.officialDefinition\.sheets\.map/u);
  assert.match(panel, /Billing period<select/u);
  assert.match(panel, /Account ID<select/u);
  assert.match(panel, /Payer account ID<select/u);
  assert.match(css, /\.foundationalTrend \{/u);
  assert.match(css, /\.foundationalKpiMatrix \{/u);
  assert.match(
    css,
    /@media screen and \(max-width: 760px\)[\s\S]*\.foundationalKpiMatrix \{ grid-template-columns: 1fr;/u,
  );
  assert.match(css, /\.foundationalState button:focus-visible/u);
});
