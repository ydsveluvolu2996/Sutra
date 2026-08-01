import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [route, job, evidence, snapshots, domain] = await Promise.all([
  readFile(new URL("../app/api/v1/finops/cost-anomaly/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/finops-source-collect-job.ts", import.meta.url), "utf8"),
  readFile(new URL("../db/evidence-repository.ts", import.meta.url), "utf8"),
  readFile(new URL("../db/finops-source-snapshot-repository.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/finops-aws-cost-anomaly.ts", import.meta.url), "utf8"),
]);

test("Cost Anomaly route is dynamic, authenticated, and connection-derived", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/u);
  assert.match(route, /const ALLOWED_QUERY_PARAMETERS = new Set\(\["connectionId"\]\)/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /getConnectionForOrg\([\s\S]*authenticated\.subject\.orgId[\s\S]*connectionId/u);
  assert.match(route, /connection\.sourceKind !== "aws_trust_role"/u);
  assert.match(route, /connection\.status !== "active"/u);
  assert.match(route, /assertSessionCapability\([\s\S]*"connection:read"[\s\S]*connection\.customerId/u);
  assert.match(route, /assertSessionCapability\(authenticated, "sync:run", connection\.customerId\)/u);
  assert.doesNotMatch(route, /parameters\.get\("(?:orgId|customerId|accountId|contractId|sourceId)"\)/u);
  assert.doesNotMatch(route, /headers\.get\("(?:x-org-id|x-customer-id)"\)/iu);
});
test("collection activation owns source and contract server-side", () => {
  assert.ok(route.indexOf("requireApiSession(request)") < route.indexOf("readBoundedJson(request, BODY_BYTES)"));
  assert.match(route, /connection\.permissionPackVersion !== REQUIRED_PERMISSION_PACK/u);
  assert.match(route, /enqueueAwsCostAnomalyCollection/u);
  assert.match(job, /AWS_COST_ANOMALY_SOURCE_ID/u);
  assert.match(job, /AWS_COST_ANOMALY_SOURCE_CONTRACT_ID/u);
  assert.match(job, /finops-source:\$\{AWS_COST_ANOMALY_SOURCE_ID\}/u);
  assert.doesNotMatch(route, /body\.(?:contractId|sourceId|accountId|partition|region|roleArn|operation)/u);
});

test("persisted evidence read is independently rebound to every tenant dimension", () => {
  assert.match(route, /sealer\.open\(selectedSnapshot\.evidenceReference/u);
  assert.match(route, /organizationId: scope\.organizationId/u);
  assert.match(route, /customerId: scope\.customerId/u);
  assert.match(route, /connectionId: scope\.connectionId/u);
  assert.match(route, /generationId: selectedSnapshot\.generationId/u);
  assert.match(route, /readFinopsSourceSnapshot/u);
  assert.match(evidence, /e\.org_id = \? AND e\.customer_id = \?/u);
  assert.match(evidence, /e\.connection_id = \? AND e\.snapshot_id = \?/u);
  assert.match(evidence, /e\.artifact_kind = 'finops_source_snapshot'/u);
  assert.match(evidence, /e\.content_sha256 = \? AND e\.status = 'available'/u);
  assert.match(evidence, /e\.retention_until > \?/u);
  assert.match(snapshots, /public async getLatestSnapshot/u);
  assert.match(snapshots, /s\.org_id = \? AND s\.customer_id = \? AND s\.connection_id = \?/u);
});

test("API uses canonical dashboard builder and exposes honest bounded states", () => {
  assert.match(route, /buildCostAnomalyDashboard/u);
  assert.match(route, /parsePersistedAwsCostAnomalyMaterialization/u);
  assert.match(domain, /sutra\.finops-source-evidence\.v2/u);
  for (const state of ["waiting", "complete", "partial", "stale", "failed"]) {
    assert.match(route, new RegExp(`"${state}"`, "u"));
  }
  assert.match(route, /MAX_STATISTICAL_PERIODS = 3/u);
  assert.match(route, /MAX_STATISTICAL_LINES = 50_000/u);
  assert.match(route, /STALE_AFTER_HOURS = 36/u);
  assert.doesNotMatch(route, /fixture|seed|demo|providerMessage|temporaryCredentials|roleArn|objectKey|ciphertext/iu);
});
