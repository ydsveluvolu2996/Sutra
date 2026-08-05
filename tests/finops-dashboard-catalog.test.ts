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
  // Mirrors the parent capability table in
  // docs/FINOPS_CID_IMPLEMENTATION_TRACKER.md: 15 local candidates and 14
  // partial pipelines. The tracker is the authority; this catalog follows it and
  // must never present a row as more complete than the tracker records.
  assert.equal(counts.LOCAL_VERTICAL_CANDIDATE?.length, 15);
  assert.equal(counts.PARTIAL_PIPELINE?.length, 14);
  assert.equal("ENGINE_ONLY" in counts, false);
  assert.equal("ABSENT" in counts, false);
  assert.deepEqual(
    counts.LOCAL_VERTICAL_CANDIDATE?.map(({ id }) => id),
    [
      "cudos",
      "cost_intelligence_dashboard",
      "kpi_dashboard",
      "compute_optimizer",
      "cost_anomaly",
      "extended_support_projection",
      "health_events",
      "aws_news_feeds",
      "aws_budgets",
      "support_cases_radar",
      "resiliencevue",
      "end_user_computing",
      "data_collection_monitor",
      "trends",
      "data_transfer",
    ],
  );
  assert.deepEqual(
    counts.PARTIAL_PIPELINE?.map(({ id }) => id),
    [
      "trusted_advisor_organizational",
      "graviton_savings",
      "media_services_insights",
      "cora",
      "azure_cid",
      "gcp_cid",
      "focus",
      "marketplace_spg",
      "kubecost_container_allocation",
      "scad_container_allocation",
      "sustainability_proxy",
      "amazon_connect_cost_insights",
      "config_resource_compliance",
      "pricing_change",
    ],
  );
  // Neither excluded cross-cloud row may be promoted by this change.
  assert.equal(FINOPS_DASHBOARD_MATURITY_BY_ID.azure_cid, "PARTIAL_PIPELINE");
  assert.equal(FINOPS_DASHBOARD_MATURITY_BY_ID.gcp_cid, "PARTIAL_PIPELINE");
  assert.equal(
    Object.values(FINOPS_DASHBOARD_MATURITY_BY_ID)
      .filter((maturity) => maturity === "LOCAL_VERTICAL_VERIFIED" || maturity === "LIVE_ACCEPTED")
      .length,
    0,
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

test("official catalog identifiers are unique and match the level they belong to", () => {
  const PREFIX = { foundational: "FND", advanced: "ADV", additional: "ADD" } as const;
  const seen = new Set<string>();
  const perLevel: Record<string, number[]> = { FND: [], ADV: [], ADD: [] };

  for (const entry of FINOPS_DASHBOARD_CATALOG) {
    assert.match(entry.catalogId, /^(?:FND|ADV|ADD)-(?:0[1-9]|1[0-3])$/u, entry.id);
    const [prefix, ordinal] = entry.catalogId.split("-");
    assert.equal(prefix, PREFIX[entry.level], entry.id);
    assert.equal(seen.has(entry.catalogId), false, entry.catalogId);
    seen.add(entry.catalogId);
    perLevel[prefix!]!.push(Number(ordinal));
  }

  assert.equal(seen.size, 29);
  // Each level is numbered 1..n with no gap, renumbering or reuse, so an
  // evidence record in docs/finops-cid-evidence/ always resolves.
  assert.deepEqual(perLevel.FND, [1, 2, 3]);
  assert.deepEqual(perLevel.ADV, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.deepEqual(perLevel.ADD, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
});

test("every entry carries a drawable icon and a known tone", () => {
  const TONES = new Set([
    "blue", "indigo", "cyan", "teal", "green",
    "amber", "orange", "red", "violet", "slate",
  ]);
  for (const entry of FINOPS_DASHBOARD_CATALOG) {
    // Glyph names are validated against the drawn icon set at compile time by
    // GlyphIcon's IconName prop; this guards shape and non-emptiness only.
    assert.match(entry.icon, /^[a-z][A-Za-z]{2,23}$/u, entry.id);
    assert.equal(TONES.has(entry.tone), true, `${entry.id}: ${entry.tone}`);
  }
  // Icons need not be unique, but the catalog should not collapse into one
  // undifferentiated glyph; every level must be visually distinguishable.
  assert.ok(new Set(FINOPS_DASHBOARD_CATALOG.map(({ icon }) => icon)).size >= 24);
  assert.ok(new Set(FINOPS_DASHBOARD_CATALOG.map(({ tone }) => tone)).size >= 8);
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
