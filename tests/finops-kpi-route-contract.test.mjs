import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/v1/finops/kpi/route.ts", import.meta.url),
  "utf8",
);

test("Foundational KPI GET is tenant-resolved, read-only, and query-allowlisted", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/u);
  assert.match(
    route,
    /"connectionId", "period", "accountId", "payerAccountId"/u,
  );
  assert.match(route, /parameters\.getAll\(key\)\.length > 1/u);
  assert.doesNotMatch(route, /\.get\("(?:orgId|customerId|tenantId)"\)/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /getConnectionForOrg\(/u);
  assert.match(route, /"connection:read"/u);
  assert.match(route, /!isCollectableAwsSourceKind\(connection\.sourceKind\)/u);
  assert.match(route, /connection\.status !== "active"/u);
  assert.doesNotMatch(route, /export async function (?:POST|PUT|PATCH|DELETE)/u);
  assert.match(route, /ACCOUNT_ID\.test\(accountId\)/u);
  assert.match(route, /ACCOUNT_ID\.test\(payerAccountId\)/u);
});

test("KPI evaluation uses one exact active generation and persistent tenant goals", () => {
  assert.match(route, /billing\.listActivePartitions\(owner\)/u);
  assert.match(route, /billing\.loadActivePartition\(owner, selected\)/u);
  assert.match(
    route,
    /configuration\.goalsForEvaluation\(active\.scope\)/u,
  );
  assert.match(
    route,
    /evaluateFinopsKpis\(\{\s*scope: active\.scope,\s*rows,/u,
  );
  assert.match(route, /manifestSha256: active\.evidence\.activeManifestSha256/u);
  assert.match(route, /resourceAgeEvidence: \[\]/u);
  assert.match(route, /savingsAssumptions: \[\]/u);
  assert.match(route, /sourceState: "waiting"/u);
  assert.match(route, /sourceState: "complete"/u);
  assert.match(route, /goalsConfigured: goals\.length/u);
  assert.match(route, /row\.line\.usageAccountId === query\.accountId/u);
  assert.match(route, /row\.line\.payerAccountId === query\.payerAccountId/u);
  assert.match(route, /FINOPS_KPI_OFFICIAL_DEFINITION/u);
  assert.doesNotMatch(route, /fixture|demo|sample|finops_cur_lines/iu);
});

test("KPI evidence window is bounded by the selected month and real evaluation time", () => {
  assert.match(route, /const boundedEnd = Math\.min\(end, evaluatedAt\.getTime\(\)\)/u);
  assert.match(route, /boundedEnd <= start/u);
  assert.match(route, /evaluatedAtIso: evaluatedAt\.toISOString\(\)/u);
  assert.match(route, /sourceEvidenceId:\s*`aws-data-export:/u);
  assert.match(route, /sourceEvidence: \{\s*activeGeneration: \{/u);
  assert.match(route, /activeObservedAtIso/u);
  assert.match(route, /activeCommittedAtIso/u);
});
