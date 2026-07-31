import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL(
    "../app/api/v1/finops/cost-intelligence/route.ts",
    import.meta.url,
  ),
  "utf8",
);

test("Cost Intelligence rejects duplicate, unknown, and invalid query inputs with exact defaults", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/u);
  assert.match(
    route,
    /const ALLOWED_QUERY_PARAMETERS = new Set\(\[\s*"connectionId",\s*"baselinePeriod",\s*"comparisonPeriod",\s*"costBasis",\s*"allocationMode",\s*"moverDimension",\s*"pivotRow",\s*"pivotColumn",\s*\]\)/u,
  );
  assert.match(route, /parameters\.keys\(\)/u);
  assert.match(route, /!ALLOWED_QUERY_PARAMETERS\.has\(key\)/u);
  assert.match(route, /parameters\.getAll\(key\)\.length > 1/u);
  assert.match(route, /parameters\.get\("costBasis"\) \?\? "billed"/u);
  assert.match(route, /parameters\.get\("allocationMode"\) \?\? "showback"/u);
  assert.match(route, /parameters\.get\("moverDimension"\) \?\? "service"/u);
  assert.match(route, /parameters\.get\("pivotRow"\) \?\? "account"/u);
  assert.match(route, /parameters\.get\("pivotColumn"\) \?\? "service"/u);
  assert.match(route, /FINOPS_COST_BASES\.includes/u);
  assert.match(route, /FINOPS_COST_DIMENSIONS\.includes/u);
  assert.match(route, /requestedPivotRow === requestedPivotColumn/u);
  assert.match(
    route,
    /baselinePeriod === comparisonPeriod/u,
  );
});

test("tenant scope is derived only from the authenticated live AWS connection", () => {
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(
    route,
    /getConnectionForOrg\(\s*authenticated\.subject\.orgId,\s*query\.connectionId,\s*\)/u,
  );
  assert.match(route, /connection\.sourceKind !== "aws_trust_role"/u);
  assert.match(route, /connection\.status !== "active"/u);
  assert.match(
    route,
    /assertSessionCapability\(\s*authenticated,\s*"connection:read",\s*connection\.customerId,\s*\)/u,
  );
  assert.match(route, /orgId: authenticated\.subject\.orgId/u);
  assert.match(route, /organizationId: authenticated\.subject\.orgId/u);
  assert.match(route, /customerId: connection\.customerId/u);
  assert.match(route, /connectionId: connection\.id/u);
  assert.doesNotMatch(
    route,
    /parameters\.get\("(?:orgId|organizationId|customerId|tenantId)"\)/u,
  );
  assert.doesNotMatch(route, /headers\.get\("x-(?:org|customer|tenant)/iu);
  assert.doesNotMatch(
    route,
    /export async function (?:POST|PUT|PATCH|DELETE)/u,
  );
});

test("only one newest canonical active export history is selected and bounded", () => {
  assert.match(route, /const MAX_PERIODS = 36/u);
  assert.match(
    route,
    /const canonicalExportName = sorted\[0\]\?\.scope\.exportName/u,
  );
  assert.match(
    route,
    /partition\.scope\.exportName !== canonicalExportName/u,
  );
  assert.match(route, /periods\.size >= MAX_PERIODS/u);
  assert.match(
    route,
    /billingRepository\.listActivePartitions\(billingOwner\)/u,
  );
  assert.match(
    route,
    /billingRepository\.loadActivePartition\(billingOwner, partition\)/u,
  );
  assert.match(route, /const MAX_TOTAL_ROWS = 250_000/u);
  assert.match(route, /acceptedRows > MAX_TOTAL_ROWS/u);
  assert.match(route, /configRepository\.activeTaxonomy\(foundationalScope\)/u);
  assert.doesNotMatch(
    route,
    /FinopsWorkspaceRepository|finops_cur_lines|legacy|fallback|fixture|demo|sample/iu,
  );
});

test("missing taxonomy and one-period histories produce honest non-ready states", () => {
  assert.match(
    route,
    /if \(publishedTaxonomy === null\) \{[\s\S]*false,[\s\S]*"configuration_required"/u,
  );
  assert.match(
    route,
    /if \(history\.length < 2\) \{[\s\S]*true,[\s\S]*"waiting"/u,
  );
  assert.match(
    route,
    /report: null,\s*taxonomyConfigured,\s*sourceState/u,
  );
  assert.match(route, /taxonomyConfigured: true,\s*sourceState: "ready"/u);
});

test("the report receives exact active datasets, bounded options, and conservative commitment coverage", () => {
  assert.match(
    route,
    /buildFinopsCostIntelligence\(\{\s*periods: datasets\.map/u,
  );
  assert.match(
    route,
    /dataset\.evidence\.activeSourceUpdatedAtIso[\s\S]*dataset\.evidence\.activeObservedAtIso/u,
  );
  assert.match(
    route,
    /observedThrough\.slice\(0, 7\) === dataset\.scope\.billingPeriod/u,
  );
  assert.match(route, /taxonomy: publishedTaxonomy\.taxonomy/u);
  assert.match(route, /baselinePeriod: selected\.baselinePeriod/u);
  assert.match(route, /comparisonPeriod: selected\.comparisonPeriod/u);
  assert.match(route, /moverDimension: query\.moverDimension/u);
  assert.match(route, /pivotDimensions: query\.pivotDimensions/u);
  assert.match(route, /const commitmentAsOfIso = new Date\(\)\.toISOString\(\)/u);
  assert.match(route, /asOfIso: commitmentAsOfIso/u);
  assert.match(route, /unusedChargesComplete: false/u);
  assert.match(route, /publicOnDemandCostComplete: false/u);
  assert.match(route, /usageQuantityComplete: false/u);
  assert.doesNotMatch(
    route,
    /asOfIso:\s*(?:partition|dataset|connection)\./u,
  );
});

test("source evidence preserves each active generation without flattening freshness", () => {
  assert.match(route, /sourceEvidence: activeEvidence\(history\)/u);
  assert.match(route, /periods: history\.map\(\(partition\) => \(\{/u);
  assert.match(route, /generationId: partition\.scope\.generationId/u);
  assert.match(
    route,
    /manifestSha256: partition\.evidence\.activeManifestSha256/u,
  );
  assert.match(
    route,
    /sourceUpdatedAtIso:\s*partition\.evidence\.activeSourceUpdatedAtIso/u,
  );
  assert.match(
    route,
    /observedAtIso: partition\.evidence\.activeObservedAtIso/u,
  );
  assert.match(
    route,
    /committedAtIso: partition\.evidence\.activeCommittedAtIso/u,
  );
  assert.match(route, /acceptedRows: partition\.evidence\.acceptedRows/u);
  assert.match(route, /rejectedRows: partition\.evidence\.rejectedRows/u);
  assert.doesNotMatch(route, /partitionFreshness/u);
  assert.doesNotMatch(route, /partitionFreshnessMatchesActiveManifest/u);
});
