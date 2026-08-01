import assert from "node:assert/strict";
import test from "node:test";
import {
  FINOPS_DASHBOARD_CATALOG,
  FINOPS_DASHBOARD_MATURITY_BY_ID,
  getFinopsDashboardCatalogEntry,
  listFinopsDashboardsByLevel,
} from "../lib/finops-dashboard-catalog.ts";
import { FINOPS_CAPABILITY_DEFINITIONS } from "../lib/finops-source-health.ts";

test("catalog contains the exact official 29 dashboards across all three levels", () => {
  assert.equal(FINOPS_DASHBOARD_CATALOG.length, 29);
  assert.equal(listFinopsDashboardsByLevel("foundational").length, 3);
  assert.equal(listFinopsDashboardsByLevel("advanced").length, 13);
  assert.equal(listFinopsDashboardsByLevel("additional").length, 13);
  assert.equal(new Set(FINOPS_DASHBOARD_CATALOG.map(({ id }) => id)).size, 29);
  assert.equal(new Set(FINOPS_DASHBOARD_CATALOG.map(({ slug }) => slug)).size, 29);

  assert.deepEqual(
    FINOPS_DASHBOARD_CATALOG.filter(({ provider }) => provider === "azure" || provider === "gcp")
      .map(({ id }) => id),
    ["azure_cid", "gcp_cid"],
  );
  for (const name of [
    "CUDOS Dashboard",
    "Cost Intelligence Dashboard",
    "KPI and Modernization Dashboard",
    "Trusted Advisor Organizational (TAO) Dashboard",
    "Cloud Intelligence Dashboard for Azure",
    "Cloud Intelligence Dashboard for GCP",
    "Pricing Change Analysis Dashboard",
  ]) {
    assert.ok(FINOPS_DASHBOARD_CATALOG.some((entry) => entry.name === name), name);
  }
});

test("catalog preserves the tracker maturity vocabulary without claiming completion", () => {
  const counts = Object.groupBy(
    FINOPS_DASHBOARD_CATALOG,
    ({ currentMaturity }) => currentMaturity,
  );
  assert.equal(counts.LOCAL_VERTICAL_CANDIDATE?.length, 6);
  assert.equal(counts.PARTIAL_PIPELINE?.length, 12);
  assert.equal(counts.ENGINE_ONLY?.length, 9);
  assert.equal(counts.ABSENT?.length, 2);
  assert.deepEqual(
    counts.LOCAL_VERTICAL_CANDIDATE?.map(({ id }) => id),
    [
      "cudos",
      "cost_intelligence_dashboard",
      "kpi_dashboard",
      "cost_anomaly",
      "trends",
      "data_transfer",
    ],
  );
  assert.deepEqual(
    counts.PARTIAL_PIPELINE?.map(({ id }) => id),
    [
      "trusted_advisor_organizational",
      "aws_news_feeds",
      "aws_budgets",
      "support_cases_radar",
      "resiliencevue",
      "end_user_computing",
      "data_collection_monitor",
      "media_services_insights",
      "cora",
      "focus",
      "config_resource_compliance",
      "pricing_change",
    ],
  );
  assert.equal(Object.values(FINOPS_DASHBOARD_MATURITY_BY_ID).includes("COMPLETE" as never), false);
  assert.equal(Object.values(FINOPS_DASHBOARD_MATURITY_BY_ID).includes("READY" as never), false);
});

test("all 27 AWS runtime capabilities map to catalog entries while cross-cloud entries remain separate", () => {
  assert.equal(FINOPS_CAPABILITY_DEFINITIONS.length, 27);
  for (const capability of FINOPS_CAPABILITY_DEFINITIONS) {
    const catalog = getFinopsDashboardCatalogEntry(capability.id);
    assert.notEqual(catalog, null, capability.id);
    assert.equal(FINOPS_DASHBOARD_MATURITY_BY_ID[capability.id], catalog?.currentMaturity);
  }
  assert.equal(FINOPS_CAPABILITY_DEFINITIONS.some(({ id }) => id === "azure_cid" as never), false);
  assert.equal(FINOPS_CAPABILITY_DEFINITIONS.some(({ id }) => id === "gcp_cid" as never), false);
});

test("catalog and lookup helpers are deeply immutable and fail closed", () => {
  assert.equal(Object.isFrozen(FINOPS_DASHBOARD_CATALOG), true);
  assert.equal(Object.isFrozen(FINOPS_DASHBOARD_CATALOG[0]), true);
  assert.equal(Object.isFrozen(FINOPS_DASHBOARD_CATALOG[0].targetAudience), true);
  assert.equal(Object.isFrozen(FINOPS_DASHBOARD_MATURITY_BY_ID), true);
  assert.equal(getFinopsDashboardCatalogEntry("trusted-advisor-organizational")?.id, "trusted_advisor_organizational");
  assert.equal(getFinopsDashboardCatalogEntry("unknown"), null);
  assert.equal(getFinopsDashboardCatalogEntry(""), null);
});

test("every entry has bounded client-safe presentation metadata", () => {
  for (const entry of FINOPS_DASHBOARD_CATALOG) {
    assert.match(entry.id, /^[a-z][a-z0-9_]{0,63}$/u);
    assert.match(entry.slug, /^[a-z][a-z0-9-]{0,79}$/u);
    assert.ok(entry.name.length > 4 && entry.name.length < 100);
    assert.ok(entry.summary.length > 30 && entry.summary.length < 240);
    assert.ok(entry.targetAudience.length > 0 && entry.targetAudience.length <= 10);
    assert.match(entry.documentationUrl, /^https:\/\//u);
    assert.equal(/[\u0000-\u001f\u007f]/u.test(JSON.stringify(entry)), false);
  }
});

test("official names and target audiences are preserved without Sutra expansion", () => {
  const entry = (id: string) => {
    const value = getFinopsDashboardCatalogEntry(id);
    assert.notEqual(value, null, id);
    return value!;
  };
  assert.deepEqual(entry("cost_intelligence_dashboard").targetAudience, [
    "Executives", "Finance/Procurement",
  ]);
  assert.deepEqual(entry("kpi_dashboard").targetAudience, [
    "Product owners", "Finance", "FinOps", "DevOps", "Engineering",
  ]);
  assert.deepEqual(entry("trusted_advisor_organizational").targetAudience, [
    "Product owners", "FinOps", "DevOps", "Engineering", "SRE", "Security",
  ]);
  assert.deepEqual(entry("marketplace_spg").targetAudience, [
    "AWS Marketplace buyers", "Procurement", "Sourcing", "Finance", "FinOps",
    "Legal", "GRC", "IT", "BizApps",
  ]);
  assert.deepEqual(entry("data_transfer").targetAudience, ["Network Team"]);
});
