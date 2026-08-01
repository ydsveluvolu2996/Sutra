import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const [trendsRoute, transferRoute, panel, foundational, css] =
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
  assert.match(trendsRoute, /const MAX_WINDOW_PERIODS = 12/u);
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

test("Data Transfer GET never invents manifest object coverage", () => {
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
  assert.match(transferRoute, /status: "PARTIAL"/u);
  assert.match(transferRoute, /manifestObjectCount: null/u);
  assert.match(transferRoute, /processedObjectCount: null/u);
  assert.match(
    transferRoute,
    /errorCode: "MANIFEST_OBJECT_COVERAGE_UNAVAILABLE"/u,
  );
  assert.match(transferRoute, /sourceState: "source_incomplete"/u);
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
  assert.match(panel, /role="img"/u);
  assert.match(panel, /<caption>Data-transfer cost by category/u);
  assert.match(
    panel,
    /never substitutes Cost Explorer snapshots, fixtures, or another tenant/u,
  );
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
