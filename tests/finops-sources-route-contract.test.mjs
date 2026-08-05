import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [route, evidenceAdapter, snapshotEvidenceAdapter] = await Promise.all([
  readFile(
    new URL("../app/api/v1/finops/sources/route.ts", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../lib/finops-source-health-evidence.ts", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../lib/finops-source-snapshot-evidence.ts", import.meta.url),
    "utf8",
  ),
]);

test("source-readiness route is dynamic, authenticated, and customer scoped through the connection", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(
    route,
    /getConnectionForOrg\(authenticated\.subject\.orgId, connectionId\)/u,
  );
  assert.match(route, /connection\.sourceKind !== "aws_trust_role"/u);
  assert.match(route, /connection\.status !== "active"/u);
  assert.match(route, /assertSessionCapability\(authenticated, "connection:read", connection\.customerId\)/u);
  assert.match(route, /orgId: authenticated\.subject\.orgId/u);
  assert.match(route, /customerId: connection\.customerId/u);
  assert.match(route, /getPilotStateForOrg\(scope\.orgId, connectionId\)/u);
  assert.match(route, /billingRepository\.listActivePartitions\(scope\)/u);
  assert.match(route, /new FinopsSourceSnapshotRepository\(\)/u);
  assert.match(route, /new FinopsSourceJobLedgerRepository\(\)/u);
  assert.match(route, /snapshotRepository\.listActiveSnapshots\(\{/u);
  assert.match(route, /jobLedgerRepository\.summarize\(\{/u);
  assert.match(route, /organizationId: scope\.orgId/u);
  assert.match(route, /customerId: scope\.customerId/u);
  assert.match(route, /connectionId: scope\.connectionId/u);
  assert.match(route, /buildStoredFinopsSourceEvidence\(\{/u);
  assert.match(route, /activeSnapshots: activeSourceSnapshots/u);
  assert.match(route, /source\.latestAttempt/u);
  assert.match(route, /return jsonResponse\(buildFinopsSourceReadiness\(\{ scope, evidence \}\)\)/u);
  assert.match(route, /return errorResponse\(error\)/u);
});

test("source-readiness route has an exact connectionId allowlist and never trusts caller tenant identifiers", () => {
  assert.match(
    route,
    /const ALLOWED_QUERY_PARAMETERS = new Set\(\["connectionId"\]\)/u,
  );
  assert.match(route, /parameters\.keys\(\)/u);
  assert.match(route, /!ALLOWED_QUERY_PARAMETERS\.has\(key\)/u);
  assert.match(
    route,
    /parameters\.getAll\("connectionId"\)\.length !== 1/u,
  );
  assert.match(route, /parameters\.get\("connectionId"\)/u);
  assert.doesNotMatch(route, /parameters\.get\("(?:orgId|customerId)"\)/u);
  assert.doesNotMatch(route, /headers\.get\("(?:x-org-id|x-customer-id)"\)/iu);
});

test("source-readiness route uses immutable canonical evidence with no mutation or fallback", () => {
  assert.doesNotMatch(route, /export async function (?:POST|PUT|PATCH|DELETE)/u);
  assert.match(route, /new FinopsActiveBillingQueryRepository\(\)/u);
  assert.match(route, /activeBillingPartitions,/u);
  assert.match(route, /buildPersistedFinopsSourceEvidence/u);
  assert.match(route, /buildStoredFinopsSourceEvidence/u);
  assert.doesNotMatch(
    route,
    /FinopsWorkspaceRepository|finops_cur_lines|listPeriods|linesForPeriod|demo|fixture|seed/iu,
  );
});

test("source-readiness response projects only public source health metadata", () => {
  assert.doesNotMatch(
    route,
    /evidenceReference|ciphertext|contentSha256|schemaVersion|generationId|objectKey|decrypt/iu,
  );
  assert.doesNotMatch(
    snapshotEvidenceAdapter,
    /\.evidenceReference|\.ciphertext|\.contentSha256|\.schemaVersion|objectKey|decrypt/iu,
  );
  assert.match(
    snapshotEvidenceAdapter,
    /GENERIC_ERROR_MESSAGES/u,
  );
  assert.match(
    snapshotEvidenceAdapter,
    /acceptedSnapshot\.jobId === attempt\.jobId/u,
  );
  assert.match(
    snapshotEvidenceAdapter,
    /lastSuccessAt: accepted\?\.lastSuccessAt \?\? null/u,
  );
  assert.match(
    snapshotEvidenceAdapter,
    /coverage: failureOrPartial/u,
  );
});

test("source evidence separates CUR2 and FOCUS histories and reads only immutable active fields", () => {
  assert.match(
    evidenceAdapter,
    /partition\.evidence\.activeSourceFormat === "aws-cur"[\s\S]*partition\.evidence\.activeSourceVersion === "2\.0"/u,
  );
  assert.match(
    evidenceAdapter,
    /partition\.evidence\.activeSourceFormat === "focus"[\s\S]*partition\.evidence\.activeSourceVersion === "1\.2"/u,
  );
  assert.match(
    evidenceAdapter,
    /sameExportDefinition\(partition, newest\)/u,
  );
  assert.match(
    evidenceAdapter,
    /left\.scope\.exportName === right\.scope\.exportName/u,
  );
  assert.match(
    evidenceAdapter,
    /left\.evidence\.activeSourceTable[\s\S]*left\.evidence\.activeSourceFormat[\s\S]*left\.evidence\.activeSourceVersion/u,
  );
  assert.match(evidenceAdapter, /MAX_ACTIVE_PARTITIONS = 36/u);
  assert.match(evidenceAdapter, /MAX_PARTITION_RECORDS = 250_000/u);
  assert.match(evidenceAdapter, /MAX_HISTORY_RECORDS/u);
  assert.match(evidenceAdapter, /activeSourceUpdatedAtIso/u);
  assert.match(evidenceAdapter, /activeObservedAtIso/u);
  assert.match(evidenceAdapter, /activeCommittedAtIso/u);
  assert.match(evidenceAdapter, /evidence\.acceptedRows/u);
  assert.match(evidenceAdapter, /evidence\.rejectedRows/u);
  assert.doesNotMatch(
    evidenceAdapter,
    /FinopsWorkspaceRepository|finops_cur_lines|latestPeriodLines|periods:/u,
  );
});
