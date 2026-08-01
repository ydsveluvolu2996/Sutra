import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");

test("CORA route authenticates and tenant-scopes before reading immutable projections", async () => {
  const route = await readFile(new URL("../app/api/v1/finops/cora/route.ts", import.meta.url), "utf8");
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /getConnectionForOrg\(authenticated\.subject\.orgId/u);
  assert.match(route, /assertSessionCapability\(authenticated, "connection:read", connection\.customerId\)/u);
  assert.match(route, /repository\.getActiveSnapshot\(scope\)/u);
  assert.match(route, /CORA_COLLECTOR_ORCHESTRATION_NOT_BOUND/u);
  assert.equal(route.match(/officialDefinition: CORA_OFFICIAL_DEFINITION/gu)?.length, 2);
  assert.doesNotMatch(route, /ListRecommendations|GetRecommendation/u);
});

test("CORA UI exposes exact official inventory in report and configuration-required states", async () => {
  const dashboard = await readFile(new URL("../app/costs/finops-cora-dashboard.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /Official AWS CORA definition/u);
  assert.match(dashboard, /Exact official CORA sheet inventory/u);
  assert.match(dashboard, /embedded <code>cora_view<\/code> SQL/u);
  assert.match(dashboard, /credential-owning S3\/Parquet adapter/u);
  assert.match(dashboard, /No pixel, layout, interaction-tree, or QuickSight runtime parity is claimed/u);
  assert.match(dashboard, /state\.officialDefinition === null \? null : <OfficialDefinitionCoverage/u);
});

test("CORA report actually renders filters, honest disclosures, history, drilldown and evidence", async () => {
  const vite = await createServer({ root, configFile: false, logLevel: "silent", plugins: [react()], server: { middlewareMode: true } });
  try {
  const dashboardModule = await vite.ssrLoadModule("/app/costs/finops-cora-dashboard.tsx");
  const definitionModule = await vite.ssrLoadModule("/lib/finops-cora-official-definition.ts");
  const filters = { accountId: null, optimizationClass: null, actionType: null, region: null, implementationEffort: null, workflowStatus: null, currencyCode: null, tagKey: null, tagValue: null, resourceId: null, restartNeeded: null, rollbackPossible: null, excludeFinopsExceptions: false };
  const summary = { optimizationClass: "RESOURCE_USAGE_OPTIMIZATION", currencyCode: "USD", recommendationCount: 1, estimatedMonthlyCostBeforeDiscountMicros: "2000000", estimatedMonthlyCostAfterDiscountMicros: "1800000", estimatedMonthlySavingsBeforeDiscountMicros: "1000000", estimatedMonthlySavingsAfterDiscountMicros: "900000", aggregationMeaning: "NON_DEDUPLICATED_ROW_SUM_NOT_A_PORTFOLIO_SAVINGS_CLAIM" };
  const report = {
    schema: "sutra.finops-cora-dashboard.v1", connectionId: `conn_${"a".repeat(32)}`, sourceState: "partial", source: "AWS_COST_OPTIMIZATION_HUB_DATA_EXPORT",
    officialDefinition: definitionModule.CORA_OFFICIAL_DEFINITION,
    filters, filterOptions: { accounts: [{ id: "111111111111", name: "Platform" }], optimizationClasses: ["RESOURCE_USAGE_OPTIMIZATION"], actionTypes: ["Rightsize"], regions: ["us-east-1"], implementationEfforts: ["Low"], workflowStatuses: ["NEW"], currencies: ["USD"], tagKeys: ["Owner"] },
    resultCount: 1, rowsTruncated: false, summaries: [summary], opportunitySummaries: [{ optimizationClass: "RESOURCE_USAGE_OPTIMIZATION", currencyCode: "USD", rawRecommendationCount: 1, deduplicatedActionCount: 1, distinctResourceCount: 1, recommendationsWithoutResourceId: 0, estimatedMonthlySavingsBeforeDiscountMicros: "1000000", estimatedMonthlySavingsAfterDiscountMicros: "900000", aggregationMeaning: "MAX_RECOMMENDATION_PER_RESOURCE_WITHIN_OPTIMIZATION_CLASS_MISSING_RESOURCE_IDS_UNDEDUPLICATED" }],
    officialSheetCoverage: [
      { sheet: "Summary", status: "PARTIAL", localEvidence: "Resource-deduplicated summaries", limitation: "QuickSight visual geometry is not reproduced" },
      { sheet: "Usage Optimization", status: "PARTIAL", localEvidence: "Usage actions", limitation: "QuickSight visual geometry is not reproduced" },
      { sheet: "Rate Optimization - Saving Plans", status: "PARTIAL", localEvidence: "SP evidence", limitation: "Terms unavailable" },
      { sheet: "Rate Optimization - Reserved Instances", status: "PARTIAL", localEvidence: "RI evidence", limitation: "Terms unavailable" },
      { sheet: "About", status: "IMPLEMENTED", localEvidence: "Evidence lineage", limitation: null },
    ],
    rows: [{ trackingKey: `cor_${"1".repeat(64)}`, accountId: "111111111111", accountName: "Platform", optimizationClass: "RESOURCE_USAGE_OPTIMIZATION", actionType: "Rightsize", region: "us-east-1", currencyCode: "USD", implementationEffort: "Low", currentResourceType: "Ec2Instance", recommendedResourceType: "Ec2Instance", currentResourceSummary: "large", recommendedResourceSummary: "medium", resourceId: "i-1", resourceArn: null, restartNeeded: true, rollbackPossible: true, recommendationSource: "ComputeOptimizer", recommendationLookbackPeriodInDays: 14, lastRefreshTimestamp: "2026-07-31T00:00:00.000Z", estimates: { currencyCode: "USD", monthlyCostBeforeDiscountMicros: "2000000", monthlyCostAfterDiscountMicros: "1800000", monthlySavingsBeforeDiscountMicros: "1000000", monthlySavingsAfterDiscountMicros: "900000", meaning: "AWS_ESTIMATE_NOT_REALIZED_SAVINGS" }, tags: [{ key: "Owner", value: "Platform" }], workflow: { status: "NEW", ownerPrincipalId: null, externalTicketId: null, updatedAt: "2026-07-31T00:00:00.000Z" }, observedCostEvidenceCount: 0 }],
    history: [{ generationId: `corg_${"2".repeat(64)}`, collectedAtIso: "2026-07-31T01:00:00.000Z", dataThroughAtIso: "2026-07-31T00:00:00.000Z", sourceState: "READY", recommendationCount: 1, summaries: [summary] }],
    freshness: { dataThroughAt: "2026-07-31T00:00:00.000Z", ageHours: 1, staleAfterHours: 48 }, evidence: { organizationCoverage: "COMPLETE" }, collection: { available: false, reason: "CORA_COLLECTOR_ORCHESTRATION_NOT_BOUND" }, disclosures: ["AWS estimates are not realized savings or invoices."],
  };
  const html = renderToStaticMarkup(createElement(dashboardModule.CoraDashboardReportView, { report, filters, onFiltersChange: () => undefined }));
  for (const text of ["not realized savings", "rate estimates are not adjusted", "Cost allocation tag", "Resource ID", "FinopsException", "Drill down", "Daily evidence history", "About · Evidence and coverage", "Export visible rows", "Coverage is partial", "Usage Optimization", "Savings Plans", "Reserved Instances", "Resource-deduplicated opportunity summaries", "Official AWS CORA definition", "28 visuals", "Logarithmic Scale", "PROVIDER DIMENSIONS BLOCKED", "6486f50810f40558423cffb90c245a658678597fccdda8445e26a40e02e6a644", "S3/Parquet adapter"]) assert.match(html, new RegExp(text, "iu"));
  } finally {
    await vite.close();
  }
});

test("CORA migrations enforce immutable snapshots and a complete-only monotonic head", async () => {
  const sqlite = await readFile(new URL("../drizzle/0089_finops_cora_snapshots.sql", import.meta.url), "utf8");
  const postgres = await readFile(new URL("../postgres/migrations/0084_finops_cora_snapshots.sql", import.meta.url), "utf8");
  for (const sql of [sqlite, postgres]) {
    assert.match(sql, /CORA_SNAPSHOT_IMMUTABLE/u);
    assert.match(sql, /source_state[^\n]*READY|source_state` = 'READY'/u);
    assert.match(sql, /candidate\.data_through_at > active\.data_through_at|candidate\.`data_through_at` > active\.`data_through_at`/u);
  }
});
