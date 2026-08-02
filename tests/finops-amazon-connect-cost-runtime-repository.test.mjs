import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));
const { AmazonConnectCostRuntimeRepository } = await import(
  "../db/finops-amazon-connect-cost-runtime-repository.ts");
const { normalizeAmazonConnectCostInsightCapture } = await import(
  "../lib/finops-amazon-connect-cost-insight.ts");

const root = path.resolve(import.meta.dirname, "..");
const NOW = Date.parse("2026-08-02T01:00:00.000Z");
const SCOPE = { organizationId: "org_add11", customerId: "customer_add11",
  connectionId: `conn_${"a".repeat(32)}` };
const INSTANCE_ID = "12345678-1234-1234-1234-123456789abc";
const INSTANCE_ARN = `arn:aws:connect:us-east-1:111122223333:instance/${INSTANCE_ID}`;
const TRUSTED = { orgId: SCOPE.organizationId, customerId: SCOPE.customerId,
  connectionId: SCOPE.connectionId, accountId: "111122223333", partition: "aws",
  region: "us-east-1", instanceArns: [INSTANCE_ARN] };
const REQUEST = `acr_${"b".repeat(64)}`;
const WINDOW = "2026-08-02T00:00:00.000Z";
const CAPTURE = { schemaVersion: "sutra.amazon-connect-cost-insight.v1", scope: TRUSTED,
  captureId: `connect_${"b".repeat(64)}`, startedAtIso: "2026-08-02T00:04:00.000Z",
  completedAtIso: "2026-08-02T00:05:00.000Z",
  execution: { concurrencyLimit: 4, observedPeakConcurrency: 1 },
  privacy: { rawContactRecordsAccepted: false, rawPhoneNumbersAccepted: false,
    tokenization: "HMAC_SHA256_TENANT_SCOPED_ROTATING", tokenKeyVersion: "key_2026_08",
    contactDrilldownEnabled: false },
  collections: [{ instanceArn: INSTANCE_ARN, configured: true, regionSupported: true,
    permissionsValidated: true, pagesExhausted: true, apiCallCount: 2,
    phoneRecordsScanned: 1, failureCode: null,
    instance: { instanceArn: INSTANCE_ARN, instanceId: INSTANCE_ID, alias: "support-prod",
      status: "ACTIVE", inboundCallsEnabled: true, outboundCallsEnabled: true,
      observedAtIso: "2026-08-02T00:04:30.000Z" },
    phoneInventory: [{ instanceArn: INSTANCE_ARN, countryCode: "US",
      phoneNumberType: "DID", status: "CLAIMED", count: 1 }] }],
  costEvidence: { source: "AWS_CUR2_ACTIVE_GENERATION", generationId: `fbg_${"c".repeat(64)}`,
    manifestSha256: "d".repeat(64), dataThroughAtIso: "2026-08-02T00:00:00.000Z",
    costBasis: "NET_AMORTIZED", currency: "USD", rowsExhausted: true,
    contactResourceIdsIncluded: false, activatedSystemTags: [], rows: [] } };

async function fixture() {
  const mf = new Miniflare({ modules: true,
    script: "export default{fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-05-22", d1Databases: { DB: `acrt-${crypto.randomUUID()}` },
    d1Persist: false });
  const db = await mf.getD1Database("DB");
  for (const statement of [
    "CREATE TABLE organizations(id text PRIMARY KEY,status text NOT NULL)",
    "CREATE TABLE customers(id text PRIMARY KEY,org_id text NOT NULL,status text NOT NULL)",
    "CREATE TABLE aws_connections(id text PRIMARY KEY,org_id text NOT NULL,customer_id text NOT NULL,aws_account_id text NOT NULL,partition text NOT NULL,source_kind text NOT NULL,status text NOT NULL,permission_pack_version text NOT NULL)",
  ]) await db.prepare(statement).run();
  for (const file of ["drizzle/0100_finops_amazon_connect_cost_insights.sql",
    "drizzle/0127_finops_amazon_connect_runtime.sql"]) {
    const sql = await readFile(path.join(root, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
  await db.batch([
    db.prepare("INSERT INTO organizations VALUES(?,?)").bind(SCOPE.organizationId, "active"),
    db.prepare("INSERT INTO customers VALUES(?,?,?)").bind(SCOPE.customerId, SCOPE.organizationId, "active"),
    db.prepare("INSERT INTO aws_connections VALUES(?,?,?,?,?,?,?,?)").bind(
      SCOPE.connectionId, SCOPE.organizationId, SCOPE.customerId, TRUSTED.accountId,
      TRUSTED.partition, "aws_trust_role", "active", "standard-2026-08.16"),
  ]);
  return { mf, db, repository: new AmazonConnectCostRuntimeRepository(db,
    { now: () => NOW, skipRuntimeSchema: true }) };
}

test("durable ADD-11 receipt leases, commits immutable evidence, replays and reports ready", async () => {
  const { mf, repository } = await fixture();
  try {
    const identity = { scope: SCOPE, requestId: REQUEST, scheduledWindow: WINDOW,
      sourceBoundarySha256: "e".repeat(64), nowMs: NOW };
    await repository.prepareAttempt(identity);
    assert.equal(await repository.getAccepted(SCOPE, REQUEST), null);
    const normalizedSnapshot = normalizeAmazonConnectCostInsightCapture(CAPTURE, TRUSTED, NOW);
    const committed = await repository.commit({ ...identity, trustedScope: TRUSTED,
      capture: CAPTURE, normalizedSnapshot,
      evidence: { generationId: `fss_${"f".repeat(64)}`, objectId: `eobj_${"1".repeat(32)}`,
        contentSha256: "2".repeat(64), reference: { ciphertext: `fsev1.${"A".repeat(32)}`,
          keyVersion: "amazon-connect-evidence-v1" } } });
    assert.equal(committed.accepted.snapshot.snapshot.state, "current");
    await repository.prepareAttempt(identity);
    const replay = await repository.getAccepted(SCOPE, REQUEST);
    assert.equal(replay?.snapshot.generationId, committed.accepted.snapshot.generationId);
    assert.deepEqual(await repository.getRuntimeStatus(SCOPE), { state: "ready",
      reason: "AMAZON_CONNECT_COLLECTION_READY", lastAttemptAt: new Date(NOW).toISOString(),
      acceptedGenerationId: committed.accepted.snapshot.generationId });
  } finally { await mf.dispose(); }
});

test("active ADD-11 lease rejects a second worker and failure history is immutable", async () => {
  const { mf, db, repository } = await fixture();
  try {
    const identity = { scope: SCOPE, requestId: REQUEST, scheduledWindow: WINDOW,
      sourceBoundarySha256: "e".repeat(64), nowMs: NOW };
    await repository.prepareAttempt(identity);
    const competing = new AmazonConnectCostRuntimeRepository(db,
      { now: () => NOW, skipRuntimeSchema: true });
    await assert.rejects(competing.prepareAttempt(identity), (error) => error?.code === "ATTEMPT_IN_PROGRESS");
    await repository.recordFailure({ scope: SCOPE, requestId: REQUEST,
      scheduledWindow: WINDOW, code: "MATERIALIZER_UNAVAILABLE", completedAtMs: NOW });
    assert.equal((await repository.getRuntimeStatus(SCOPE)).state, "failed");
    const row = await db.prepare("SELECT failure_id FROM finops_amazon_connect_runtime_failures LIMIT 1").first();
    await assert.rejects(db.prepare("DELETE FROM finops_amazon_connect_runtime_failures WHERE failure_id=?")
      .bind(row.failure_id).run(), /FINOPS_AMAZON_CONNECT_RUNTIME_FAILURE_IMMUTABLE/u);
  } finally { await mf.dispose(); }
});
