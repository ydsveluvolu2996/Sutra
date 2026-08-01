import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const [trendsRoute, transferRoute, panel, trendsExport, foundational, css] =
  await Promise.all([
    readFile(path.join(root, "app/api/v1/finops/trends/route.ts"), "utf8"),
    readFile(
      path.join(root, "app/api/v1/finops/data-transfer/route.ts"),
      "utf8",
    ),
    readFile(
      path.join(root, "app/costs/finops-cur-intelligence-panels.tsx"),
      "utf8",
    ),
    readFile(path.join(root, "lib/finops-trends-export.ts"), "utf8"),
    readFile(
      path.join(root, "app/costs/finops-foundational-panels.tsx"),
      "utf8",
    ),
    readFile(path.join(root, "app/costs/costs.module.css"), "utf8"),
  ]);

function assertTenantResolvedReadOnlyRoute(route) {
  assert.match(route, /export const dynamic = "force-dynamic"/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(
    route,
    /getConnectionForOrg\(\s*authenticated\.subject\.orgId,\s*query\.connectionId,\s*\)/u,
  );
  assert.match(
    route,
    /assertSessionCapability\(\s*authenticated,\s*"connection:read",\s*connection\.customerId,\s*\)/u,
  );
  assert.match(route, /connection\.sourceKind !== "aws_trust_role"/u);
  assert.match(route, /connection\.status !== "active"/u);
  assert.match(route, /repository\.listActivePartitions\(owner\)/u);
  assert.match(route, /repository\.loadActivePartition\(owner,/u);
  assert.doesNotMatch(
    route,
    /\.get\("(?:orgId|organizationId|customerId|tenantId|accountId|exportName|generationId)"\)/u,
  );
  assert.doesNotMatch(route, /export async function (?:POST|PUT|PATCH|DELETE)/u);
  assert.doesNotMatch(
    route,
    /finops_cur_lines|CostExplorer|cost explorer|fixture|simulated|sample/iu,
  );
}

test("Trends GET is an exact bounded immutable-active-CUR2 route", () => {
  assertTenantResolvedReadOnlyRoute(trendsRoute);
  assert.match(
    trendsRoute,
    /const ALLOWED_QUERY_PARAMETERS = new Set\(\[\s*"connectionId",\s*"fromPeriod",\s*"toPeriod",\s*"costBases",\s*"rollingWindowMonths",\s*"contributorLimit",\s*\]\)/u,
  );
  assert.match(trendsRoute, /parameters\.keys\(\)/u);
  assert.match(trendsRoute, /parameters\.getAll\(key\)\.length > 1/u);
  assert.match(trendsRoute, /const MAX_WINDOW_PERIODS = 36/u);
  assert.match(
    trendsRoute,
    /\.slice\(0, FINOPS_TRENDS_INTELLIGENCE_BOUNDS\.maximumPeriods\)/u,
  );
  assert.match(
    trendsRoute,
    /FINOPS_TRENDS_INTELLIGENCE_BOUNDS\.maximumTotalRows/u,
  );
  assert.match(
    trendsRoute,
    /activeSourceFormat === "aws-cur"[\s\S]*activeSourceVersion === "2\.0"/u,
  );
  assert.match(trendsRoute, /buildFinopsTrendsIntelligence\(\{/u);
  assert.match(trendsRoute, /loadKind: "UNCLASSIFIED"/u);
  assert.match(trendsRoute, /report: null,[\s\S]*sourceState: "waiting"/u);
  assert.match(trendsRoute, /sourceState: "source_incomplete"/u);
});

test("Data Transfer GET uses only committed active manifest object coverage", () => {
  assertTenantResolvedReadOnlyRoute(transferRoute);
  assert.match(
    transferRoute,
    /const ALLOWED_QUERY_PARAMETERS = new Set\(\[\s*"connectionId",\s*"period",\s*"groupLimit",\s*\]\)/u,
  );
  assert.match(transferRoute, /parameters\.keys\(\)/u);
  assert.match(transferRoute, /parameters\.getAll\(key\)\.length > 1/u);
  assert.match(
    transferRoute,
    /selected\.evidence\.acceptedRows\s*>\s*DATA_TRANSFER_ANALYSIS_BOUNDS\.maximumRows/u,
  );
  assert.match(
    transferRoute,
    /activeSourceFormat === "aws-cur"[\s\S]*activeSourceVersion === "2\.0"/u,
  );
  assert.match(transferRoute, /buildDataTransferAnalysis\(/u);
  assert.match(
    transferRoute,
    /const activeFileCount = dataset\.evidence\.activeFileCount/u,
  );
  assert.match(
    transferRoute,
    /status: evidenceErrorCode === null \? "SUCCEEDED" : "PARTIAL"/u,
  );
  assert.match(transferRoute, /manifestObjectCount: activeFileCount/u);
  assert.match(transferRoute, /processedObjectCount: activeFileCount/u);
  assert.match(
    transferRoute,
    /activeFileCount === null[\s\S]*"MANIFEST_OBJECT_COVERAGE_UNAVAILABLE"/u,
  );
  assert.match(transferRoute, /"SOURCE_TIMESTAMPS_UNAVAILABLE"/u);
  assert.match(transferRoute, /"SOURCE_ROWS_REJECTED"/u);
  assert.match(transferRoute, /sourceState: "source_incomplete"/u);
  assert.match(
    transferRoute,
    /dataset\.rows\.length === 0[\s\S]*dataset\.evidence\.rejectedRows > 0[\s\S]*activeFileCount === null|dataset\.rows\.length === 0[\s\S]*dataset\.evidence\.activeFileCount === null/u,
  );
  assert.doesNotMatch(
    transferRoute,
    /manifestObjectCount:\s*dataset\.evidence\.acceptedRows/u,
  );
});

test("CUR2 panels expose exact arithmetic and every honest client state", () => {
  const moneyFormatter = panel.slice(
    panel.indexOf("export function formatCurMicrosExact"),
    panel.indexOf("export function formatCurRationalPercentExact"),
  );
  const rationalFormatter = panel.slice(
    panel.indexOf("export function formatCurRationalPercentExact"),
    panel.indexOf("function relativeBasisPoints"),
  );
  assert.match(moneyFormatter, /BigInt\(micros\)/u);
  assert.match(moneyFormatter, /BigInt\(1_000_000\)/u);
  assert.doesNotMatch(moneyFormatter, /Number\s*\(/u);
  assert.match(rationalFormatter, /BigInt\(value\.numerator\)/u);
  assert.match(rationalFormatter, /exact \$\{value\.numerator\}\/\$\{value\.denominator\}%/u);
  assert.doesNotMatch(rationalFormatter, /Number\s*\(/u);
  for (const state of [
    "loading",
    "configuration_required",
    "source_incomplete",
    "waiting",
    "empty",
    "error",
  ]) assert.match(panel, new RegExp(state, "u"), state);
  assert.match(panel, /<StatusBanner[\s\S]*state=\{report\.state\}/u);
  assert.match(panel, /partially reconciled periods remain visible/u);
  assert.match(panel, /completeness remains partial/u);
  assert.match(panel, /credentials: "same-origin"/u);
  assert.match(panel, /cache: "no-store"/u);
  assert.match(panel, /body\.connectionId !== connectionId/u);
  assert.match(panel, /report\.source\.objectCoverage\.status/u);
  assert.match(panel, /manifest object counts were not retained/u);
  assert.match(panel, /role="group"/u);
  assert.match(panel, /<caption>Data-transfer cost by exact provider-reported source/u);
  assert.match(panel, /All source locations/u);
  assert.match(panel, /All destination locations/u);
  assert.match(panel, /Provider path coverage/u);
  assert.match(
    panel,
    /never substitutes Cost Explorer snapshots, fixtures, or another tenant/u,
  );
});

test("Trends visual exposes bounded period comparisons, drilldowns, export and lineage", () => {
  assert.match(panel, /buildTrendsEvidenceCsv/u);
  assert.match(trendsExport, /total_micros/u);
  assert.match(trendsExport, /manifest_sha256/u);
  assert.match(trendsExport, /spreadsheet formula execution/u);
  assert.match(panel, /Export evidence CSV/u);
  assert.match(panel, /Trends start period/u);
  assert.match(panel, /Trends end period/u);
  assert.match(panel, /Trends comparison window/u);
  assert.match(panel, /<option value="1">Monthly<\/option>/u);
  assert.match(panel, /<option value="3">Quarterly<\/option>/u);
  assert.match(panel, /<option value="12">Yearly<\/option>/u);
  assert.match(panel, /aria-pressed=\{current\?\.period === point\.period\}/u);
  assert.match(panel, /Movement contributor dimension/u);
  for (const dimension of ["account", "service", "region", "charge_category"]) {
    assert.match(panel, new RegExp(`"${dimension}"`, "u"), dimension);
  }
  assert.match(panel, /Evidence, lineage, formulas, and parity limits/u);
  assert.match(panel, /QuickSight threshold alerts/u);
  assert.match(panel, /geographic usage map need authoritative source inputs/u);
  assert.match(panel, /not AWS Cost Anomaly Detection findings/u);
  assert.match(panel, /tabIndex=\{0\}/u);
  assert.match(css, /\.curDimensionTabs button:focus-visible/u);
  assert.match(css, /\.curEvidenceDrawer summary:focus-visible/u);
});

test("Trends report server-renders exact controls, contributors and lineage", async () => {
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    server: { middlewareMode: true },
  });
  try {
    const trendsModule = await vite.ssrLoadModule(
      "/app/costs/finops-cur-intelligence-panels.tsx",
    );
    const lineage = {
      sourceEvidenceId: "s3://billing/manifest.json#v1",
      manifestSha256: "b".repeat(64),
      generationId: `fbg_${"a".repeat(64)}`,
      sourceUpdatedAtIso: "2026-08-01T09:00:00.000Z",
      observedAtIso: "2026-08-01T09:05:00.000Z",
      committedAtIso: "2026-08-01T09:10:00.000Z",
      activatedAtIso: "2026-08-01T09:11:00.000Z",
      sourceRowCount: 1,
      sourceLineItemIdCount: 1,
      sourceLineItemIds: ["line-1"],
      sourceLineItemIdsTruncated: false,
    };
    const unavailable = { available: false, reason: "NO_PRIOR_PERIOD" };
    const unavailableHistory = {
      available: false,
      reason: "INSUFFICIENT_CONTIGUOUS_HISTORY",
    };
    const report = {
      ok: true,
      schema: "sutra.finops-trends-intelligence.v1",
      state: "READY",
      tenant: {
        organizationId: "org_render",
        customerId: "customer_render",
        connectionId: "conn_render",
        exportName: "cur2-export",
      },
      window: { fromPeriod: "2026-05", toPeriod: "2026-06", periodCount: 2 },
      evaluatedAtIso: "2026-08-01T10:00:00.000Z",
      expectedCurrencies: ["USD"],
      selectedCostBases: ["unblended"],
      rollingWindowMonths: 3,
      contributorLimit: 8,
      periods: ["2026-05", "2026-06"].map((period) => ({
        period,
        state: "COMPLETE",
        stateReasons: ["COMPLETE"],
        loadKind: "ORIGINAL",
        generationId: lineage.generationId,
        collectionState: "COMPLETE",
        rowCount: 1,
        rejectedRowCount: 0,
        ageSeconds: 3_600,
        staleAfterSeconds: 129_600,
        lineage,
      })),
      series: [{
        currency: "USD",
        costBasis: "unblended",
        points: [{
          period: "2026-05",
          periodState: "COMPLETE",
          totalMicros: "100000000",
          contributingRowCount: 1,
          missingCostRowCount: 0,
          costCoverage: "complete",
          monthOverMonth: unavailable,
          trailingAverage: unavailableHistory,
          rollingComparison: unavailableHistory,
          contributors: [],
          signals: [],
        }, {
          period: "2026-06",
          periodState: "COMPLETE",
          totalMicros: "125000000",
          contributingRowCount: 1,
          missingCostRowCount: 0,
          costCoverage: "complete",
          monthOverMonth: {
            available: true,
            baselineMicros: "100000000",
            currentMicros: "125000000",
            deltaMicros: "25000000",
            percent: { numerator: "25", denominator: "1" },
            percentUnavailableReason: null,
          },
          trailingAverage: unavailableHistory,
          rollingComparison: unavailableHistory,
          contributors: ["account", "service", "region", "charge_category"].map((dimension) => ({
            dimension,
            available: true,
            unavailableReason: null,
            contributors: [{
              value: dimension === "service" ? "AmazonEC2" : "evidence-value",
              currentMicros: "125000000",
              priorMicros: "100000000",
              deltaMicros: "25000000",
              absoluteMovementShare: { numerator: "1", denominator: "1" },
            }],
            totalDimensionValues: 1,
            truncated: false,
          })),
          signals: [{
            code: "MOM_ABSOLUTE_PERCENT_CHANGE",
            severity: "INFORMATIONAL",
            formula: "abs(current-prior)*100 >= abs(prior)*20",
            thresholdPercent: 20,
            observedPercent: { numerator: "25", denominator: "1" },
            baseline: "PRIOR_MONTH",
            explanation: "Exact movement crossed the pinned review threshold.",
          }],
        }],
      }],
      summary: {
        activeGenerationCount: 2,
        sourceRowCount: 2,
        completePeriodCount: 2,
        missingPeriodCount: 0,
        currentPartialPeriodCount: 0,
        correctionPeriodCount: 0,
        backfillPeriodCount: 0,
        stalePeriodCount: 0,
        partialPeriodCount: 0,
        emptyPeriodCount: 0,
        signalCount: 1,
      },
      forecast: {
        available: false,
        reason: "NOT_PRODUCED_EVIDENCE_HONEST_TRENDS_ONLY",
      },
      signalPolicy: {
        momAbsolutePercentThreshold: 20,
        trailingBaselineMonths: 3,
        trailingAbsolutePercentThreshold: 30,
        formulas: {
          momAbsolutePercentChange: "abs(currentMicros-priorMicros)*100 >= abs(priorMicros)*20",
          trailingBaselineDeviation: "abs(currentMicros*3-sum(previous3Micros))*100 >= sum(previous3Micros)*30",
        },
      },
      additionalReadOperations: [],
      limitations: ["ACTIVE_RECONCILED_IMMUTABLE_AWS_CUR2_GENERATIONS_ONLY"],
    };
    const markup = renderToStaticMarkup(createElement(trendsModule.TrendsReport, {
      report,
      availablePeriods: ["2026-05", "2026-06"].map((period) => ({
        period,
        generationId: lineage.generationId,
        committedAtIso: lineage.committedAtIso,
      })),
      onFromPeriodChange() {},
      onToPeriodChange() {},
      onRollingWindowChange() {},
    }));
    assert.match(markup, /Enterprise cost trends/u);
    assert.match(markup, /Export evidence CSV/u);
    assert.match(markup, /AmazonEC2/u);
    assert.match(markup, /Exact movement crossed the pinned review threshold/u);
    assert.match(markup, /Evidence, lineage, formulas, and parity limits/u);
    assert.match(markup, new RegExp(lineage.manifestSha256, "u"));
    assert.doesNotMatch(markup, /fixture|placeholder spend|sample spend/iu);
  } finally {
    await vite.close();
  }
});

test("workspace integrates one CUR2 panel per intended section with responsive visuals", () => {
  assert.match(
    foundational,
    /section === "overview" \|\| section === "services"[\s\S]*<FinopsCurIntelligencePanels/u,
  );
  assert.equal(
    foundational.match(/<FinopsCurIntelligencePanels/gu)?.length,
    1,
  );
  assert.match(css, /\.curWorkspace \{/u);
  assert.match(css, /\.curChart \{/u);
  assert.match(css, /\.curTableWrap \{/u);
  assert.match(
    css,
    /@media screen and \(max-width: 760px\)[\s\S]*\.curKpis, \.curCategoryGrid \{ grid-template-columns: 1fr;/u,
  );
  assert.match(css, /\.curState button:focus-visible/u);
});
