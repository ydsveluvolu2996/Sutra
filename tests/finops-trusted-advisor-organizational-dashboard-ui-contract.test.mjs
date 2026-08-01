import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const [route, component, navigation, repository, css] = await Promise.all([
  readFile(path.join(root, "app/api/v1/finops/trusted-advisor-organizational/route.ts"), "utf8"),
  readFile(path.join(root, "app/costs/finops-trusted-advisor-organizational-dashboard.tsx"), "utf8"),
  readFile(path.join(root, "app/costs/finops-dashboard-catalog-nav.tsx"), "utf8"),
  readFile(path.join(root, "db/finops-trusted-advisor-organization-repository.ts"), "utf8"),
  readFile(path.join(root, "app/costs/costs.module.css"), "utf8"),
]);

test("TAO catalog entry is wired to its authenticated same-tenant standard-check GET report", () => {
  assert.match(navigation, /selected\.id === "trusted_advisor_organizational"/u);
  assert.match(navigation, /<FinopsTrustedAdvisorOrganizationalDashboard/u);
  assert.match(component, /\/api\/v1\/finops\/trusted-advisor-organizational\?\$\{parameters\.toString\(\)\}/u);
  assert.match(component, /credentials: "same-origin"/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /getConnectionForOrg\([\s\S]*authenticated\.subject\.orgId/u);
  assert.match(route, /assertSessionCapability\(authenticated, "connection:read", connection\.customerId\)/u);
  assert.match(repository, /WHERE h\.org_id = \? AND h\.customer_id = \? AND h\.anchor_connection_id = \?/u);
});

test("TAO API accepts only bounded filters and never reads or substitutes Priority recommendations", () => {
  assert.match(route, /"connectionId", "accountId", "checkId", "status", "region"/u);
  assert.match(route, /parameters\.getAll\(key\)\.length > 1/u);
  assert.match(route, /AWS_SUPPORT_TRUSTED_ADVISOR_STANDARD_CHECKS/u);
  assert.match(route, /Priority recommendations are supplemental and are never substituted/u);
  assert.match(repository, /MAX_DASHBOARD_ACCOUNTS = 200/u);
  assert.match(repository, /MAX_DASHBOARD_CHECKS = 500/u);
  assert.match(repository, /MAX_DASHBOARD_RESOURCES = 500/u);
  assert.doesNotMatch(route, /trusted_advisor_organization[^a-z_]/u);
  assert.doesNotMatch(route, /ListOrganizationRecommendation|Priority API/u);
});

test("TAO UI exposes honest states, activation gap, filters, and drilldowns", () => {
  for (const state of [
    "loading", "configuration_required", "waiting", "empty", "partial", "stale", "failed", "complete",
  ]) assert.match(component, new RegExp(`view: "${state}"`, "u"), state);
  for (const label of [
    "Organization coverage summary",
    "Organization trend",
    "Account drilldown",
    "Check drilldown",
    "Resource drilldown",
    "Trusted Advisor organization filters",
  ]) assert.match(component, new RegExp(label, "u"), label);
  assert.match(component, /signed server-owned AWS Organizations taxonomy|signed Organizations adapter/iu);
  assert.match(component, /browser-provided account list/iu);
  assert.match(component, /Priority is never substituted|Priority recommendations are supplemental only/iu);
  assert.match(component, /aria-pressed=\{filters\.accountId === account\.accountId\}/u);
  assert.match(component, /aria-pressed=\{filters\.checkId === check\.checkId\}/u);
  assert.match(component, /tabIndex=\{0\} role="region"/u);
  assert.match(component, /<caption>Accepted resources from the active standard-check generation<\/caption>/u);
});

test("TAO layout is responsive and has visible keyboard focus", () => {
  for (const selector of [
    ".taoWorkspace", ".taoFilters", ".taoKpis", ".taoSplitGrid", ".taoCheckGrid", ".taoTableWrap", ".taoActivationNote",
  ]) assert.match(css, new RegExp(selector.replace(".", "\\."), "u"), selector);
  assert.match(css, /\.taoFilters select:focus-visible/u);
  assert.match(css, /\.taoCheckGrid button:focus-visible/u);
  assert.match(css, /@media screen and \(max-width: 1120px\)[\s\S]*\.taoSplitGrid \{ grid-template-columns: 1fr;/u);
  assert.match(css, /@media screen and \(max-width: 760px\)[\s\S]*\.taoFilters, \.taoKpis, \.taoCheckGrid \{ grid-template-columns: 1fr;/u);
  assert.match(css, /min-height: 44px/u);
});

test("TAO report renders accepted account, check, resource, history, and evidence content", async () => {
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    server: { middlewareMode: true },
  });
  try {
    const taoModule = await vite.ssrLoadModule("/app/costs/finops-trusted-advisor-organizational-dashboard.tsx");
    const report = {
      schema: "sutra.finops-trusted-advisor-organizational-dashboard.v1",
      connectionId: `conn_${"a".repeat(32)}`,
      source: "AWS_SUPPORT_TRUSTED_ADVISOR_STANDARD_CHECKS",
      sourceState: "complete",
      freshness: { dataThroughAt: "2026-08-01T00:00:00.000Z", collectedAt: "2026-08-01T01:00:00.000Z", ageHours: 1, staleAfterHours: 24 },
      coverage: { expectedAccounts: 1, acceptedAccounts: 1, rejectedAccounts: 0, acceptedChecks: 1, acceptedResources: 1, rejectedRecords: 0 },
      accounts: [{ accountId: "111122223333", collectedAtIso: "2026-08-01T01:00:00.000Z", dataThroughAtIso: "2026-08-01T00:00:00.000Z", checkCount: 1, resourceCount: 1, rejectedRecordCount: 0 }],
      checks: [{ checkId: "check-1", name: "Idle EC2 instances", category: "cost_optimizing", status: "warning", accountCount: 1, processedCount: 1, flaggedCount: 1, ignoredCount: 0, suppressedCount: 0 }],
      resources: [{ resourceKey: "a".repeat(64), accountId: "111122223333", checkId: "check-1", checkName: "Idle EC2 instances", resourceId: "i-render", region: "us-east-1", status: "warning", suppressed: false, metadata: [{ name: "reason", value: "idle" }], metadataSha256: "b".repeat(64) }],
      history: [{ generationId: `tao_${"c".repeat(64)}`, status: "complete", collectedAtIso: "2026-08-01T01:00:00.000Z", expectedAccountCount: 1, acceptedAccountCount: 1, rejectedAccountCount: 0, checkCount: 1, resourceCount: 1 }],
      evidence: { generationId: `tao_${"c".repeat(64)}`, manifestId: `tam_${"d".repeat(64)}`, contentSha256: "e".repeat(64) },
      activation: { available: false, reason: "AWS_ORGANIZATIONS_SIGNED_TAXONOMY_ADAPTER_NOT_REGISTERED" },
      limitations: ["Priority is never substituted."],
    };
    const markup = renderToStaticMarkup(createElement(
      taoModule.FinopsTrustedAdvisorOrganizationalReportView,
      { report, filters: { accountId: "", checkId: "", status: "", region: "" }, onFiltersChange: () => undefined },
    ));
    assert.match(markup, /111122223333/u);
    assert.match(markup, /Idle EC2 instances/u);
    assert.match(markup, /i-render/u);
    assert.match(markup, /us-east-1/u);
    assert.match(markup, /reason/u);
    assert.match(markup, /server-owned/u);
    assert.doesNotMatch(markup, /fixture|sample|placeholder/iu);
  } finally {
    await vite.close();
  }
});
