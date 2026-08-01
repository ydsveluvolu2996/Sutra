import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const [route, component, css, repository] = await Promise.all([
  readFile(path.join(root, "app/api/v1/finops/pricing-change-analysis/route.ts"), "utf8"),
  readFile(path.join(root, "app/costs/finops-pricing-change-dashboard.tsx"), "utf8"),
  readFile(path.join(root, "app/costs/finops-pricing-change-dashboard.module.css"), "utf8"),
  readFile(path.join(root, "db/finops-pricing-change-repository.ts"), "utf8"),
]);

test("Pricing Change API is authenticated, tenant-bound, and reads independently rebound evidence", () => {
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /getConnectionForOrg\([\s\S]*authenticated\.subject\.orgId/u);
  assert.match(route, /assertSessionCapability\([\s\S]*"connection:read"[\s\S]*connection\.customerId/u);
  assert.match(route, /sealer\.open\(selected\.evidenceReference/u);
  assert.match(route, /sourceId: SOURCE_ID/u);
  assert.match(route, /generationId: selected\.evidenceGenerationId/u);
  assert.match(route, /readFinopsSourceSnapshot/u);
  assert.match(route, /buildPricingChangeAnalysis/u);
  assert.match(repository, /WHERE org_id = \? AND customer_id = \? AND connection_id = \?/u);
  assert.doesNotMatch(route, /parameters\.get\("(?:orgId|customerId|accountId|payerAccountId|price|region)"\)/u);
});

test("route and UI expose honest source states and disabled activation", () => {
  for (const state of ["configuration_required", "waiting", "partial", "stale", "failed", "empty", "complete"]) {
    assert.match(route + component, new RegExp(`"${state}"`, "u"), state);
  }
  assert.match(route, /PRICING_CHANGE_CAPTURE_MATERIALIZER_NOT_IMPLEMENTED/u);
  assert.match(route, /available: false/u);
  assert.doesNotMatch(route, /fixture|sample|placeholder|temporaryCredentials|roleArn|objectKey/iu);
  for (const label of [
    "Pricing Change Analysis filters", "All services", "All payer accounts",
    "All linked accounts", "All Regions", "Baseline and comparison catalog impact",
    "Excluded usage and mapping coverage", "Immutable Price List and CUR 2.0 lineage",
  ]) assert.match(component, new RegExp(label, "u"), label);
  assert.match(component, /not an invoice, quote, discount, forecast, or savings claim/iu);
});

test("Pricing Change layout is responsive, keyboard-visible, and uses a separate CSS module", () => {
  assert.match(component, /finops-pricing-change-dashboard\.module\.css/u);
  assert.doesNotMatch(component, /costs\.module\.css/u);
  for (const selector of [".workspace", ".filters", ".kpis", ".currencyGrid", ".tableWrap", ".evidence"]) {
    assert.match(css, new RegExp(selector.replace(".", "\\."), "u"));
  }
  assert.match(css, /\.filters select:focus-visible/u);
  assert.match(css, /min-height: 44px/u);
  assert.match(css, /@media screen and \(max-width: 760px\)/u);
});

test("Pricing Change report actually renders exact comparison, drilldown, exclusions, and lineage", async () => {
  const vite = await createServer({ root, configFile: false, logLevel: "silent", plugins: [react()], server: { middlewareMode: true } });
  try {
    const dashboardModule = await vite.ssrLoadModule("/app/costs/finops-pricing-change-dashboard.tsx");
    const money = (currency, roundedMicros) => ({ currency, exactNumerator: roundedMicros, exactDenominator: "1000000", roundedMicros });
    const report = {
      schemaVersion: "sutra.pricing-change.snapshot.v1",
      scope: { orgId: "org_render", customerId: "customer_render", connectionId: `conn_${"a".repeat(32)}` },
      collectionId: `pca_${"b".repeat(64)}`,
      generatedAt: "2026-08-01T01:00:00.000Z",
      state: "PARTIAL",
      usagePeriodStartAt: "2026-06-01T00:00:00.000Z",
      usagePeriodEndAt: "2026-07-01T00:00:00.000Z",
      baselineEffectiveAt: "2025-01-15T00:00:00.000Z",
      comparisonEffectiveAt: "2026-01-15T00:00:00.000Z",
      activeCur2GenerationId: `gen_${"c".repeat(64)}`,
      activeCur2GeneratedAt: "2026-08-01T00:00:00.000Z",
      activeCur2ManifestSha256: "d".repeat(64),
      assumptions: [],
      catalogEvidence: [{ snapshotId: `pls_${"e".repeat(64)}`, role: "BASELINE", serviceCode: "AmazonEC2", region: "us-east-1", currency: "USD", requestedEffectiveAt: "2025-01-15T00:00:00.000Z", catalogEffectiveAt: "2025-01-01T00:00:00.000Z", catalogPublicationAt: "2025-01-01T00:00:00.000Z", catalogVersion: "20250101000000", priceListArn: "arn:aws:pricing:::price-list/aws/AmazonEC2/USD/20250101000000/us-east-1", retrievedAt: "2026-07-31T00:00:00.000Z", listResponseSha256: "f".repeat(64), priceListFileSha256: "1".repeat(64) }],
      summary: { inputLineCount: 2, modeledLineCount: 1, excludedLineCount: 1, catalogSnapshotCount: 1, catalogTermCount: 2, modeledTotalsByCurrency: [{ currency: "USD", baselineModeledCost: money("USD", "100000"), comparisonModeledCost: money("USD", "125000"), modeledChange: money("USD", "25000") }] },
      groups: [{ serviceCode: "AmazonEC2", payerAccountId: "111122223333", linkedAccountId: "222233334444", region: "us-east-1", currency: "USD", usageUnit: "Hrs", termType: "ON_DEMAND", usage: { unit: "Hrs", exactNumerator: "1", exactDenominator: "1" }, baselineModeledCost: money("USD", "100000"), comparisonModeledCost: money("USD", "125000"), modeledChange: money("USD", "25000"), modeledLineCount: 1, catalogSnapshotIds: [`pls_${"e".repeat(64)}`] }],
      exclusions: [{ reason: "MISSING_COMPARISON_PRICE", serviceCode: "AmazonRDS", payerAccountId: "111122223333", linkedAccountId: "222233334444", region: "us-east-1", usageUnit: "Hrs", termType: "ON_DEMAND", excludedLineCount: 1, excludedUsage: { unit: "Hrs", exactNumerator: "2", exactDenominator: "1" } }],
    };
    const markup = renderToStaticMarkup(createElement(dashboardModule.FinopsPricingChangeReportView, { report }));
    assert.match(markup, /AmazonEC2/u);
    assert.match(markup, /111122223333/u);
    assert.match(markup, /222233334444/u);
    assert.match(markup, /USD 0\.125/u);
    assert.match(markup, /MISSING_COMPARISON_PRICE/u);
    assert.match(markup, /20250101000000/u);
    assert.match(markup, new RegExp("1".repeat(64), "u"));
    assert.doesNotMatch(markup, /fixture|sample|placeholder/iu);
  } finally {
    await vite.close();
  }
});
