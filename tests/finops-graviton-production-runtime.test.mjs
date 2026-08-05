import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";
register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtime = await import("../db/runtime-migrations.ts");
const { GravitonRuntimeRepository } = await import("../db/finops-graviton-runtime-repository.ts");
const { GRAVITON_PRODUCTION_COMPOSITION_STATUS } = await import("../lib/finops-graviton-production-composition.ts");
const { GRAVITON_BROKER_PATH, createGravitonSignedBrokerCollector } = await import("../lib/finops-graviton-signed-broker.ts");
const { GRAVITON_SAVINGS_BOUNDS, GRAVITON_SAVINGS_READ_OPERATIONS } = await import("../lib/finops-graviton-savings.ts");
const CONNECTION = `conn_${"a".repeat(32)}`, OTHER = `conn_${"b".repeat(32)}`;
const SCOPE = { organizationId: "org_graviton_runtime", customerId: "customer_graviton_runtime", connectionId: CONNECTION };
const WINDOW = "2026-08-02T00:00:00.000Z", REQUEST = `gvrq_${"c".repeat(64)}`, NOW = Date.parse("2026-08-02T01:00:00.000Z");

async function applyUnique(db) {
  const exists = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='finops_graviton_runtime_attempts'").first();
  if (exists !== null) return;
  const sql = await readFile(new URL("../drizzle/0122_finops_graviton_runtime.sql", import.meta.url), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) await db.prepare(statement).run();
}
async function fixture() {
  const mf = new Miniflare({ modules: true, script: "export default{fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-05-22", d1Databases: { DB: `graviton-runtime-${crypto.randomUUID()}` }, d1Persist: false });
  const db = await mf.getD1Database("DB"); runtime.resetRuntimeSchemaCacheForTests(); await runtime.ensureRuntimeSchema(db); await applyUnique(db);
  await db.batch([
    db.prepare("INSERT INTO organizations(id,slug,name,status)VALUES(?,'graviton-runtime','Graviton Runtime','active')").bind(SCOPE.organizationId),
    db.prepare("INSERT INTO customers(id,org_id,slug,name,status)VALUES(?,?,'graviton-customer','Graviton Customer','active')").bind(SCOPE.customerId, SCOPE.organizationId),
    db.prepare("INSERT INTO aws_connections(id,org_id,customer_id,source_kind,partition,aws_account_id,role_arn,external_id_ciphertext,external_id_key_version,permission_pack_version,status,enabled_regions_json)VALUES(?,?,?,'aws_trust_role','aws','111122223333','arn:aws:iam::111122223333:role/sutra/SutraCollectorRole','ct','v1','standard-2026-08.12','active','[\"us-east-1\"]')").bind(CONNECTION, SCOPE.organizationId, SCOPE.customerId),
    db.prepare("INSERT INTO aws_connections(id,org_id,customer_id,source_kind,partition,aws_account_id,role_arn,external_id_ciphertext,external_id_key_version,permission_pack_version,status,enabled_regions_json)VALUES(?,?,?,'aws_trust_role','aws','444455556666','arn:aws:iam::444455556666:role/sutra/SutraCollectorRole','ct','v1','standard-2026-08.12','active','[\"us-west-2\"]')").bind(OTHER, SCOPE.organizationId, SCOPE.customerId),
    db.prepare("INSERT INTO finops_graviton_runtime_authorities VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(SCOPE.organizationId, SCOPE.customerId, CONNECTION,
      "cur2_generation_1", "1".repeat(64), "pricing_2026_08", "2".repeat(64), "compat_2026_08", "3".repeat(64),
      "workload_set_1", "4".repeat(64), "license_set_1", "5".repeat(64), NOW),
  ]);
  return { mf, db };
}

test("trusted boundary and content-addressed authorities are same-tenant, sorted and .8.12 gated", async () => {
  const { mf, db } = await fixture();
  try {
    const repository = new GravitonRuntimeRepository(db, { now: () => NOW, skipRuntimeSchema: true });
    const boundary = await repository.loadBoundary(SCOPE);
    assert.deepEqual(boundary.accountIds, ["111122223333", "444455556666"]);
    assert.deepEqual(boundary.regions, ["us-east-1", "us-west-2"]);
    const context = await repository.loadProviderContext({ boundary });
    assert.deepEqual(context.accountTargets, [{ accountId: "111122223333", connectionId: CONNECTION }, { accountId: "444455556666", connectionId: OTHER }]);
    assert.equal(context.evidenceAuthority.workloadAttestations.contentSha256, "4".repeat(64));
    await db.prepare("UPDATE aws_connections SET permission_pack_version='standard-2026-08.11' WHERE id=?").bind(CONNECTION).run();
    await assert.rejects(repository.loadBoundary(SCOPE), (error) => error.code === "STORED_STATE_INVALID");
  } finally { await mf.dispose(); }
});

test("durable lease excludes concurrent workers, records failure, and is reclaimable", async () => {
  const { mf, db } = await fixture();
  try {
    const scope = { orgId: SCOPE.organizationId, customerId: SCOPE.customerId, connectionId: CONNECTION };
    const first = new GravitonRuntimeRepository(db, { now: () => NOW, skipRuntimeSchema: true });
    const second = new GravitonRuntimeRepository(db, { now: () => NOW, skipRuntimeSchema: true });
    await first.prepareAttempt(scope, REQUEST, WINDOW); assert.equal(await first.loadReceipt(scope, REQUEST), null);
    await assert.rejects(second.loadReceipt(scope, REQUEST), (error) => error.code === "ATTEMPT_IN_PROGRESS");
    await first.recordFailure(scope, REQUEST, "COLLECTION_FAILED");
    assert.equal((await first.getRuntimeStatus(SCOPE)).state, "failed");
    assert.equal(await second.loadReceipt(scope, REQUEST), null);
  } finally { await mf.dispose(); }
});

test("successful signed receipt is immutable and replayed without a new lease", async () => {
  const { mf, db } = await fixture();
  try {
    const scope = { orgId: SCOPE.organizationId, customerId: SCOPE.customerId, connectionId: CONNECTION };
    const repository = new GravitonRuntimeRepository(db, { now: () => NOW, skipRuntimeSchema: true });
    await repository.prepareAttempt(scope, REQUEST, WINDOW); await repository.loadReceipt(scope, REQUEST);
    const generation = `gvg_${"d".repeat(64)}`;
    await db.prepare("INSERT INTO finops_graviton_snapshots(generation_id,org_id,customer_id,connection_id,management_account_id,partition,source_collection_id,source_state,generated_at,content_sha256,snapshot_json,opportunity_count,usage_group_count,created_at)VALUES(?,?,?,?,?,'aws','collection_runtime','COMPLETE',?,?,?,0,0,?)")
      .bind(generation, SCOPE.organizationId, SCOPE.customerId, CONNECTION, "111122223333", new Date(NOW).toISOString(), "e".repeat(64), "{}", NOW).run();
    const receipt = { schemaVersion: "sutra.graviton-runtime-receipt.v1", requestKey: REQUEST, scope, scheduledWindow: WINDOW,
      generationId: generation, sourceCollectionId: "collection_runtime", sourceState: "COMPLETE", becameActive: true,
      completedAtIso: new Date(NOW).toISOString(), evidenceSha256: "f".repeat(64),
      signature: { keyId: "kms-graviton-1", algorithm: "ECDSA_P256_SHA256", value: "signed" } };
    await repository.recordReceipt(receipt);
    const replay = await new GravitonRuntimeRepository(db, { now: () => NOW, skipRuntimeSchema: true }).loadReceipt(scope, REQUEST);
    assert.deepEqual(replay, receipt); assert.equal((await repository.getRuntimeStatus(SCOPE)).state, "ready");
    await assert.rejects(db.prepare("UPDATE finops_graviton_runtime_attempts SET state='FAILED' WHERE request_key=?").bind(REQUEST).run(), /FINOPS_GRAVITON_RUNTIME_SUCCESS_IMMUTABLE/u);
  } finally { await mf.dispose(); }
});

test("runtime migrations have SQLite/PostgreSQL parity and production status is honest", async () => {
  const [sqlite, postgres] = await Promise.all([readFile(new URL("../drizzle/0122_finops_graviton_runtime.sql", import.meta.url), "utf8"),
    readFile(new URL("../postgres/migrations/0118_finops_graviton_runtime.sql", import.meta.url), "utf8")]);
  for (const sql of [sqlite, postgres]) { assert.match(sql, /finops_graviton_runtime_authorities/u); assert.match(sql, /finops_graviton_runtime_attempts/u); assert.match(sql, /lease_expires_at/u); assert.match(sql, /SUCCEEDED/u); }
  assert.match(postgres, /REVOKE ALL ON finops_graviton_runtime_attempts FROM PUBLIC/u);
  assert.equal(GRAVITON_PRODUCTION_COMPOSITION_STATUS.requiredPermissionPack, "standard-2026-08.12");
  assert.equal(GRAVITON_PRODUCTION_COMPOSITION_STATUS.activationState, "REGISTERED_LOCAL_RUNTIME");
});

function signingKeys() {
  const client = generateKeyPairSync("ed25519"), broker = generateKeyPairSync("ed25519");
  return { brokerPrivateKey: broker.privateKey, config: {
    clientKeyId: "sutra-app-graviton-2026-08",
    clientPrivateKey: client.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    brokerKeyId: "sutra-broker-graviton-2026-08",
    brokerPublicKey: broker.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
  } };
}
function providerCapture(boundary) { return { schemaVersion: "sutra.graviton-savings.capture.v1", scope: boundary.scope,
  managementAccountId: boundary.managementAccountId, partition: boundary.partition, accountIds: boundary.accountIds,
  regions: boundary.regions, collectionId: "collection_broker", startedAt: "2026-08-02T00:59:00.000Z",
  completedAt: "2026-08-02T01:00:00.000Z", recommendations: [], inventory: [], instanceMetadata: [],
  compatibility: [], costs: [], pricing: [], realizations: [] }; }
function signedFetcher(keys, boundary, forged = false) {
  return async (_url, init) => {
    const headers = init.headers, requestBody = String(init.body), request = JSON.parse(requestBody);
    assert.equal(headers["x-sutra-tenant-id"], boundary.scope.orgId);
    assert.equal(request.accountTargets[0].connectionId, CONNECTION);
    assert.equal(request.evidenceAuthority.cur2.contentSha256, "1".repeat(64));
    const responseBody = JSON.stringify({ schemaVersion: "sutra.graviton-provider-response.v1", requestKey: REQUEST,
      requestBodySha256: createHash("sha256").update(requestBody).digest("hex"), capture: providerCapture(boundary) });
    const bodySha = createHash("sha256").update(responseBody).digest("hex");
    const canonical = Buffer.from(["SUTRA-BROKER-APP-V1", "200", GRAVITON_BROKER_PATH,
      headers["x-sutra-nonce"], keys.config.brokerKeyId, bodySha].join("\n"));
    const signature = forged ? "A".repeat(86) : sign(null, canonical, keys.brokerPrivateKey).toString("base64url");
    return new Response(responseBody, { status: 200, headers: { "content-type": "application/json",
      "content-length": String(Buffer.byteLength(responseBody)), "x-sutra-key-id": keys.config.brokerKeyId,
      "x-sutra-signature": signature } });
  };
}
test("signed broker verifies exact response bytes and rejects forged provider evidence", async () => {
  const keys = signingKeys();
  const boundary = { scope: { orgId: SCOPE.organizationId, customerId: SCOPE.customerId, connectionId: CONNECTION },
    managementAccountId: "111122223333", partition: "aws", accountIds: ["111122223333"], regions: ["us-east-1"] };
  const runtimeRequest = { schemaVersion: "sutra.graviton-materialization-request.v1", requestKey: REQUEST,
    scheduledWindow: WINDOW, boundary, operations: GRAVITON_SAVINGS_READ_OPERATIONS,
    services: ["EC2_AND_AUTO_SCALING", "RDS_AND_AURORA", "OPENSEARCH", "ELASTICACHE"],
    recommendationPolicy: { computeOptimizerAccepted: true, managedServiceInventoryPricingAcceptedOnlyWithAllCompatibilityDimensions: true,
      inferCompatibilityFromFamilyName: false, inferSavingsWithoutPeriodMatchedCur2AndPricing: false },
    bounds: GRAVITON_SAVINGS_BOUNDS, deadlineAtIso: "2026-08-02T01:15:00.000Z" };
  const context = { accountTargets: [{ accountId: "111122223333", connectionId: CONNECTION }], evidenceAuthority: {
    cur2: { generationId: "cur2_generation_1", contentSha256: "1".repeat(64) }, pricing: { catalogVersion: "pricing_2026_08", contentSha256: "2".repeat(64) },
    compatibility: { policyVersion: "compat_2026_08", contentSha256: "3".repeat(64) }, workloadAttestations: { setId: "workload_set_1", contentSha256: "4".repeat(64) },
    licenseAttestations: { setId: "license_set_1", contentSha256: "5".repeat(64) } } };
  const base = { configuration: { brokerOrigin: "https://graviton.internal", signing: keys.config }, resolveContext: async () => context,
    now: () => NOW, nonce: () => "n".repeat(32) };
  const valid = createGravitonSignedBrokerCollector({ ...base, fetcher: signedFetcher(keys, boundary) });
  assert.equal((await valid.collect(runtimeRequest, new AbortController().signal)).collectionId, "collection_broker");
  const forged = createGravitonSignedBrokerCollector({ ...base, fetcher: signedFetcher(keys, boundary, true) });
  await assert.rejects(forged.collect(runtimeRequest, new AbortController().signal), (error) => error.code === "TRANSPORT_FAILED");
});
