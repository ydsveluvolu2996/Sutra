import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";
register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtime = await import("../db/runtime-migrations.ts");
const { AwsHealthRuntimeRepository } = await import("../db/finops-aws-health-runtime-repository.ts");
const { normalizeAwsHealthOrganizationCapture } = await import("../lib/finops-aws-health-organization.ts");
const { AWS_HEALTH_RUNTIME_JOB_KIND, runAwsHealthOrganizationRuntimeHandler } = await import("../lib/finops-aws-health-runtime-binding.ts");
const { awsHealthScheduledWindow, AWS_HEALTH_PRODUCTION_COMPOSITION_STATUS } = await import("../lib/finops-aws-health-production-composition.ts");
const { AWS_HEALTH_BROKER_PATH, createAwsHealthSignedBrokerAdapter } = await import("../lib/finops-aws-health-signed-broker.ts");
const CONNECTION = `conn_${"a".repeat(32)}`;
const OTHER = `conn_${"b".repeat(32)}`;
const SCOPE = { organizationId: "org_health_runtime", customerId: "customer_health_runtime", connectionId: CONNECTION };
const TRUSTED = { orgId: SCOPE.organizationId, customerId: SCOPE.customerId, connectionId: CONNECTION, accountId: "111122223333", partition: "aws", endpointRegion: "us-east-1" };
const WINDOW = "2026-08-02T00:00:00.000Z";
const REQUEST = `hrr_${"c".repeat(64)}`;
const NOW = Date.parse("2026-08-02T12:00:00.000Z");

function capture(status = "ENABLED") {
  return {
    schemaVersion: "sutra.aws-health-organization.v1", scope: TRUSTED,
    captureId: `health_${REQUEST.slice(4)}`, startedAtIso: "2026-08-02T11:59:00.000Z",
    completedAtIso: "2026-08-02T12:00:00.000Z",
    execution: { concurrencyLimit: 4, eventDetailBatchSize: 10, observedPeakConcurrency: 1 },
    prerequisites: { organizationsAllFeaturesEnabled: true, organizationViewStatus: status, organizationViewStatusEvidence: "management_status_api", supportPlan: "unknown", apiEntitlementValidated: true, collectorAccountType: "management", delegatedAdministratorRegistered: false, readPermissionsValidated: status === "ENABLED", initialLoadState: status === "ENABLED" ? "COMPLETE" : "UNKNOWN" },
    events: { exhausted: true, pages: [{ request: { filter: null, locale: "en", maxResults: 100, nextToken: null }, response: { events: [], nextToken: null } }] },
    affectedAccounts: [], affectedEntities: [], eventDetails: [],
  };
}

async function fixture() {
  const mf = new Miniflare({ modules: true, script: "export default{fetch(){return new Response('ok')}}", compatibilityDate: "2026-05-22", d1Databases: { DB: `health-runtime-${crypto.randomUUID()}` }, d1Persist: false });
  const db = await mf.getD1Database("DB");
  runtime.resetRuntimeSchemaCacheForTests(); await runtime.ensureRuntimeSchema(db);
  await db.batch([
    db.prepare("INSERT INTO organizations(id,slug,name,status)VALUES(?,'health-runtime','Health Runtime','active')").bind(SCOPE.organizationId),
    db.prepare("INSERT INTO customers(id,org_id,slug,name,status)VALUES(?,?,'health-customer','Health Customer','active')").bind(SCOPE.customerId, SCOPE.organizationId),
    db.prepare("INSERT INTO aws_connections(id,org_id,customer_id,source_kind,partition,aws_account_id,role_arn,external_id_ciphertext,external_id_key_version,permission_pack_version,status,enabled_regions_json)VALUES(?,?,?,'aws_trust_role','aws','111122223333','arn:aws:iam::111122223333:role/sutra/SutraCollectorRole','ct','v1','standard-2026-08.8','active','[]')").bind(CONNECTION, SCOPE.organizationId, SCOPE.customerId),
    db.prepare("INSERT INTO aws_connections(id,org_id,customer_id,source_kind,partition,aws_account_id,role_arn,external_id_ciphertext,external_id_key_version,permission_pack_version,status,enabled_regions_json)VALUES(?,?,?,'aws_trust_role','aws','222233334444','arn:aws:iam::222233334444:role/sutra/SutraCollectorRole','ct','v1','standard-2026-08.8','active','[]')").bind(OTHER, SCOPE.organizationId, SCOPE.customerId),
  ]);
  return { mf, db };
}

test("durable lease seals a deterministic capture and replays it without recollection", async () => {
  const { mf, db } = await fixture();
  try {
    const repository = new AwsHealthRuntimeRepository(db, { now: () => NOW });
    await repository.prepareAttempt(SCOPE, REQUEST, WINDOW);
    assert.equal(await repository.getAccepted(SCOPE, REQUEST), null);
    const raw = capture(); const normalized = normalizeAwsHealthOrganizationCapture(raw, TRUSTED, NOW);
    const committed = await repository.commit({ scope: SCOPE, trustedScope: TRUSTED, requestId: REQUEST, scheduledWindow: WINDOW, capture: raw, normalizedSnapshot: normalized, completedAtMs: NOW });
    assert.equal(committed.accepted.snapshot.snapshot.collectionState, "complete");
    assert.equal((await repository.getAccepted(SCOPE, REQUEST)).snapshot.generationId, committed.accepted.snapshot.generationId);
    assert.deepEqual(await repository.getRuntimeStatus(SCOPE), { state: "ready", reason: "AWS_HEALTH_COLLECTION_READY", lastAttemptAt: new Date(NOW).toISOString() });
  } finally { await mf.dispose(); }
});

test("active lease excludes a second worker and failed work is reclaimable", async () => {
  const { mf, db } = await fixture();
  try {
    const first = new AwsHealthRuntimeRepository(db, { now: () => NOW });
    const second = new AwsHealthRuntimeRepository(db, { now: () => NOW });
    await first.prepareAttempt(SCOPE, REQUEST, WINDOW); await first.getAccepted(SCOPE, REQUEST);
    await assert.rejects(second.getAccepted(SCOPE, REQUEST), (error) => error.code === "ATTEMPT_IN_PROGRESS");
    await first.recordFailure({ scope: SCOPE, requestId: REQUEST, scheduledWindow: WINDOW, code: "ADAPTER_UNAVAILABLE", completedAtMs: NOW });
    assert.equal((await first.getRuntimeStatus(SCOPE)).state, "failed");
    assert.equal(await second.getAccepted(SCOPE, REQUEST), null);
  } finally { await mf.dispose(); }
});

test("trusted provider context is same-tenant, sorted and .8.8 gated", async () => {
  const { mf, db } = await fixture();
  try {
    const repository = new AwsHealthRuntimeRepository(db, { now: () => NOW });
    assert.deepEqual(await repository.loadScope(SCOPE), TRUSTED);
    assert.deepEqual((await repository.loadProviderContext(SCOPE)).candidateAccounts, [
      { accountId: "111122223333", connectionId: CONNECTION },
      { accountId: "222233334444", connectionId: OTHER },
    ]);
    await db.prepare("UPDATE aws_connections SET permission_pack_version='standard-2026-08.7' WHERE id=?").bind(CONNECTION).run();
    await assert.rejects(repository.loadScope(SCOPE), (error) => error.code === "SCOPE_NOT_FOUND");
  } finally { await mf.dispose(); }
});

test("production contract pins daily UTC windows and the registered shared hook", () => {
  assert.equal(awsHealthScheduledWindow(Date.parse("2026-08-02T23:59:59.999Z")), WINDOW);
  assert.equal(AWS_HEALTH_PRODUCTION_COMPOSITION_STATUS.requiredPermissionPack, "standard-2026-08.8");
  assert.equal(AWS_HEALTH_PRODUCTION_COMPOSITION_STATUS.activationState,
    "REGISTERED_LOCAL_RUNTIME");
});

test("runtime migrations have SQLite/PostgreSQL parity, leases and PUBLIC revokes", async () => {
  const [sqlite, postgres] = await Promise.all([
    readFile(new URL("../drizzle/0119_finops_aws_health_runtime.sql", import.meta.url), "utf8"),
    readFile(new URL("../postgres/migrations/0115_finops_aws_health_runtime.sql", import.meta.url), "utf8"),
  ]);
  for (const source of [sqlite, postgres]) {
    assert.match(source, /finops_aws_health_runtime_attempts/u);
    assert.match(source, /finops_aws_health_runtime_configuration/u);
    assert.match(source, /lease_expires_at/u);
    assert.match(source, /SUCCEEDED/u);
  }
  assert.match(postgres, /REVOKE ALL ON finops_aws_health_runtime_attempts FROM PUBLIC/u);
});

function signingKeys() {
  const client = generateKeyPairSync("ed25519"); const broker = generateKeyPairSync("ed25519");
  return { brokerPrivateKey: broker.privateKey, config: {
    clientKeyId: "sutra-app-health-2026-08",
    clientPrivateKey: client.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    brokerKeyId: "sutra-broker-health-2026-08",
    brokerPublicKey: broker.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
  } };
}
function signedFetcher(keys, forged = false) {
  return async (_url, init) => {
    const headers = init.headers; const requestBody = String(init.body); const request = JSON.parse(requestBody);
    assert.equal(headers["x-sutra-tenant-id"], SCOPE.organizationId);
    assert.equal(headers["x-sutra-request-id"], REQUEST);
    assert.equal(request.candidateAccounts[0].connectionId, CONNECTION);
    const responseBody = JSON.stringify({ schemaVersion: "sutra.aws-health-provider-response.v1", requestId: REQUEST,
      requestBodySha256: createHash("sha256").update(requestBody).digest("hex"), capture: capture() });
    const bodySha = createHash("sha256").update(responseBody).digest("hex");
    const canonical = Buffer.from(["SUTRA-BROKER-APP-V1", "200", AWS_HEALTH_BROKER_PATH,
      headers["x-sutra-nonce"], keys.config.brokerKeyId, bodySha].join("\n"));
    const signature = forged ? "A".repeat(86) : sign(null, canonical, keys.brokerPrivateKey).toString("base64url");
    return new Response(responseBody, { status: 200, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(responseBody)), "x-sutra-key-id": keys.config.brokerKeyId, "x-sutra-signature": signature } });
  };
}
test("signed broker verifies exact response bytes and rejects a forged response", async () => {
  const keys = signingKeys();
  const runtimeRequest = { schemaVersion: "sutra.aws-health-runtime-request.v1", requestId: REQUEST, scheduledWindow: WINDOW,
    scope: TRUSTED, credentials: "SERVER_OWNED_TRUST_ROLE_SESSION", locale: "en", unfilteredAvailableEvents: true,
    operations: ["health:DescribeAffectedAccountsForOrganization", "health:DescribeAffectedEntitiesForOrganization", "health:DescribeEventDetailsForOrganization", "health:DescribeEventsForOrganization"],
    configurationOperation: "health:DescribeHealthServiceStatusForOrganization",
    bounds: { apiPageSize: 100, apiDetailBatchSize: 10, maximumConcurrency: 4, maximumDurationMs: 900000, maximumCaptureBytes: 50331648, maximumPages: 20000, maximumEvents: 10000, maximumAffectedAccounts: 100000, maximumAffectedEntities: 200000, maximumDescriptionCharacters: 16384, maximumMetadataEntries: 50, maximumMetadataKeyCharacters: 1024, maximumMetadataValueCharacters: 4096, maximumDashboardInputBytes: 67108864, maximumDashboardEvents: 500, sourceFreshnessSlaHours: 72, providerRetentionDays: 90 },
    pagination: { pageSize: 100, detailBatchSize: 10, rejectTokenReplay: true, requireExhaustionEvidence: true } };
  const base = { configuration: { brokerOrigin: "https://health.internal", signing: keys.config },
    resolveContext: async () => ({ candidateAccounts: [{ accountId: TRUSTED.accountId, connectionId: CONNECTION }], enabledObservedSince: "2026-08-01T00:00:00.000Z" }), now: () => NOW, nonce: () => "n".repeat(32) };
  const valid = createAwsHealthSignedBrokerAdapter({ ...base, fetcher: signedFetcher(keys) });
  assert.equal((await valid.collect(runtimeRequest, new AbortController().signal)).captureId, `health_${REQUEST.slice(4)}`);
  const forged = createAwsHealthSignedBrokerAdapter({ ...base, fetcher: signedFetcher(keys, true) });
  await assert.rejects(forged.collect(runtimeRequest, new AbortController().signal), (error) => error.code === "ADAPTER_UNAVAILABLE");
});

test("runtime enforces its deadline even when a provider ignores AbortSignal", async () => {
  const originalTimeout = globalThis.setTimeout; const originalClear = globalThis.clearTimeout;
  const failures = [];
  globalThis.setTimeout = ((callback) => { queueMicrotask(callback); return 1; });
  globalThis.clearTimeout = (() => undefined);
  try {
    await assert.rejects(runAwsHealthOrganizationRuntimeHandler({
      id: `job_${"1".repeat(32)}`, orgId: SCOPE.organizationId, customerId: SCOPE.customerId,
      connectionId: CONNECTION, kind: AWS_HEALTH_RUNTIME_JOB_KIND, payload: { scheduledWindow: WINDOW }, attempt: 1, maxAttempts: 5,
    }, {
      now: () => NOW, loadScope: async () => TRUSTED,
      adapter: { collect: async () => new Promise(() => undefined) },
      handoff: {
        getAccepted: async () => null,
        commit: async () => { throw new Error("must not commit"); },
        recordFailure: async (input) => { failures.push(input.code); },
      },
    }), (error) => error.code === "ADAPTER_TIMEOUT");
    assert.deepEqual(failures, ["ADAPTER_TIMEOUT"]);
  } finally {
    globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClear;
  }
});
