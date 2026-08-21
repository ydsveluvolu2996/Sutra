import assert from "node:assert/strict";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");

test("native Cost Intelligence workspace renders official sheets and decision visuals", async () => {
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    server: { middlewareMode: true },
  });
  try {
    const [panel, definition, sheets, endpoint] = await Promise.all([
      vite.ssrLoadModule("/app/costs/finops-foundational-panels.tsx"),
      vite.ssrLoadModule("/lib/finops-cost-intelligence-official-definition.ts"),
      vite.ssrLoadModule("/app/costs/finops-cost-intelligence-sheets-dashboard.tsx"),
      vite.ssrLoadModule("/app/costs/finops-foundational-endpoint.ts"),
    ]);
    const auditHtml = renderToStaticMarkup(createElement(
      panel.CostIntelligenceOfficialEvidence,
      { definition: definition.FINOPS_COST_INTELLIGENCE_OFFICIAL_DEFINITION },
    ));
    for (const expected of [
      "Report-independent official AWS Cost Intelligence definition",
      "Official Cost Intelligence source audit",
      "10 sheets · 77 visuals · 44 controls",
      "This source audit remains visible without a billing report",
      "10 official sheets and native evidence gaps",
    ]) assert.match(auditHtml, new RegExp(expected, "iu"), expected);
    assert.doesNotMatch(auditHtml, /sample spend|placeholder spend|mock spend/iu);
    const envelope = {
      connectionId: `conn_${"a".repeat(32)}`,
      selectedPeriods: ["2026-06", "2026-07"],
      availablePeriods: [],
      taxonomyConfigured: true,
      sourceState: "complete",
      sourceEvidence: null,
      officialDefinition:
        definition.FINOPS_COST_INTELLIGENCE_OFFICIAL_DEFINITION,
      report: {
        ok: true,
        schema: "sutra.finops-cost-intelligence.v1",
        costBasis: "amortized",
        baselinePeriod: "2026-06",
        comparisonPeriod: "2026-07",
        allocationMode: "showback",
        inclusionPolicy: { id: "usage_and_commitment" },
        taxonomyEvidence: {
          source: "tenant_account_mapping",
          observedAtIso: "2026-08-01T00:00:00.000Z",
        },
        allocations: [],
        summaries: [
          {
            period: "2026-06",
            currency: "USD",
            includedMicros: "1000000",
            excludedLineCount: 0,
            averageDailyRunRate: {
              roundedMicrosPerDay: "33333",
              observedDays: 30,
            },
          },
          {
            period: "2026-07",
            currency: "USD",
            includedMicros: "1500000",
            excludedLineCount: 1,
            averageDailyRunRate: {
              roundedMicrosPerDay: "48387",
              observedDays: 31,
            },
          },
        ],
        movers: [{
          currency: "USD",
          dimension: "service",
          value: "Amazon EC2",
          absoluteDeltaMicros: "500000",
          deltaPercentBasisPoints: "5000",
        }],
        forecasts: [{
          currency: "USD",
          status: "available",
          forecastMicros: "1600000",
          observedPeriods: 6,
          minimumPeriods: 3,
          model: "integer_linear_trend",
          trainingWindow: { startPeriod: "2026-02", endPeriod: "2026-07" },
          confidenceRange: {
            lowerMicros: "1400000",
            upperMicros: "1800000",
            disclosure: "deterministic_residual_range",
          },
        }],
        momPivot: {
          baselinePeriod: "2026-06",
          comparisonPeriod: "2026-07",
          dimensions: ["business_unit", "service"],
          cells: [{
            currency: "USD",
            rowValue: "Platform",
            columnValue: "Amazon EC2",
            baselineMicros: "1000000",
            comparisonMicros: "1500000",
            deltaMicros: "500000",
            deltaPercentBasisPoints: "5000",
          }],
        },
        explorer: {
          period: "2026-07",
          groups: [{
            currency: "USD",
            dimensions: [
              { dimension: "business_unit", value: "Platform" },
              { dimension: "service", value: "Amazon EC2" },
            ],
            amountMicros: "1500000",
            lineCount: 2,
          }],
        },
        commitments: {
          asOfIso: "2026-08-01T00:00:00.000Z",
          expiresWithinDays: 90,
          items: [],
          untrackable: [],
        },
      },
    };
    const html = renderToStaticMarkup(createElement(
      panel.CostIntelligenceExplorer,
      { envelope },
    ));
    for (const expected of [
      "10 sheets · 77 visuals · 44 controls",
      "Billing Summary",
      "Cost Summary",
      "Compute Summary",
      "Storage Summary",
      "RI/SP Summary",
      "Expiring RI/SP Tracker",
      "OPTICS Explorer",
      "MoM Pivot",
      "Summary of Changes",
      "About",
      "USD monthly cost trend",
      "Cost movers",
      "Forecast ranges",
      "MoM Pivot · Spend",
      "Bounded explorer groups",
      "No expiring commitment evidence was observed",
    ]) assert.match(html, new RegExp(expected, "iu"), expected);
    assert.doesNotMatch(html, /fixture|placeholder|sample data/iu);

    const controlsHtml = renderToStaticMarkup(createElement(
      sheets.FinopsCostIntelligenceSheetsDashboard,
      { connectionId: null },
    ));
    for (const expected of [
      "Cost Intelligence OPTICS controls",
      "Cost basis",
      "Group by level 1",
      "Group by level 2",
      "Explorer month",
      "Result limit",
      "Add exact filter",
      "Apply controls",
      "Database engine",
      "instance type family",
    ]) assert.match(controlsHtml, new RegExp(expected, "iu"), expected);

    const opticsUrl = new URL(endpoint.costIntelligenceRequestUrl(
      `conn_${"a".repeat(32)}`,
      {
        costBasis: "amortized",
        allocationMode: "showback",
        moverDimension: "service",
        pivotRow: "operation",
        pivotColumn: "usage_type",
        explorerPeriod: "2026-07",
        explorerLimit: 100,
        explorerFilters: [
          { dimension: "service", value: "AmazonEC2" },
          { dimension: "operation", value: "RunInstances:001" },
        ],
      },
    ), "https://www.sutracmdb.com");
    assert.equal(opticsUrl.searchParams.get("explorerPeriod"), "2026-07");
    assert.equal(opticsUrl.searchParams.get("explorerLimit"), "100");
    assert.deepEqual(opticsUrl.searchParams.getAll("explorerFilter"), [
      "service:AmazonEC2",
      "operation:RunInstances:001",
    ]);
    assert.equal(opticsUrl.searchParams.has("organizationId"), false);
    assert.equal(opticsUrl.searchParams.has("customerId"), false);

    const usagePivotHtml = renderToStaticMarkup(createElement(
      sheets.FinopsCostIntelligenceSheetContent,
      {
        sheet: { key: "mom-pivot", name: "MoM Pivot" },
        report: {
          momPivot: {
            baselinePeriod: "2026-06",
            comparisonPeriod: "2026-07",
            dimensions: ["service", "account"],
            cells: [{
              currency: "USD",
              rowValue: "AmazonEC2",
              columnValue: "111122223333",
              baselineMicros: "1000000",
              comparisonMicros: "2000000",
              deltaMicros: "1000000",
              deltaPercentBasisPoints: "10000",
            }],
          },
          usageMomPivot: {
            status: "partial",
            reason: "missing_usage_quantity_or_unit",
            baselinePeriod: "2026-06",
            comparisonPeriod: "2026-07",
            dimensions: ["service", "account"],
            eligibleLineCount: 3,
            usableLineCount: 2,
            missingEvidenceLineCount: 1,
            cells: [{
              currency: "USD",
              usageUnit: "Hrs",
              rowValue: "AmazonEC2",
              columnValue: "111122223333",
              baselineQuantityMicros: "2000000",
              comparisonQuantityMicros: "5000000",
              deltaQuantityMicros: "3000000",
              deltaPercentBasisPoints: "15000",
              baselineLineCount: 1,
              comparisonLineCount: 1,
            }],
          },
        },
      },
    ));
    for (const expected of [
      "Month-over-month spend pivot",
      "Month-over-month usage quantity pivot",
      "Partial usage quantity evidence",
      "1 of 3 usage lines lacked",
      "2 Hrs",
      "5 Hrs",
      "3 Hrs",
      "150.00%",
    ]) assert.match(usagePivotHtml, new RegExp(expected, "iu"), expected);
    assert.doesNotMatch(usagePivotHtml, />0 Hrs</u);
  } finally {
    await vite.close();
  }
});
