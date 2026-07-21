import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const pilotRepository = await import("../db/pilot-repository.ts");
const { JobQueueRepository } = await import("../db/job-queue-repository.ts");
const {
  D1HostedBrokerReplayStore,
  resolveHostedBrokerConnectionScope,
} = await import("../db/hosted-broker-repository.ts");
const {
  HostedBrokerRequestVerifier,
  canonicalHostedBrokerRequest,
} = await import("../lib/hosted-broker-request-security.ts");
const { ingestHostedBrokerRequest } = await import("../lib/hosted-broker-ingest.ts");
const { isHostedBrokerIngestEnabled } = await import("../lib/hosted-broker-ingest-runtime.ts");

const root = resolve(import.meta.dirname, "..");
const replaySchema = (await readFile(resolve(root, "drizzle/0047_hosted_broker_replay_nonces.sql"), "utf8"))
  .split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);

const KEY_ID = "broker-key-1";
const INGEST_URL = "https://app.sutra.example/api/hosted/broker/ingest";
const MAX_BODY = 4096;

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-broker-ingest-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    // The replay-nonce table ships as an unregistered migration (parent
    // registers). Apply it here to exercise the durable store end to end.
    for (const statement of replaySchema) await database.prepare(statement).run();
    await run(database);
  } finally {
    await miniflare.dispose();
  }
}

async function seedOrgConnection(database) {
  const now = Date.now();
  const orgId = `org_${crypto.randomUUID().replaceAll("-", "")}`;
  const customerId = `cust_${crypto.randomUUID().replaceAll("-", "")}`;
  const connectionId = `conn_${crypto.randomUUID().replaceAll("-", "")}`;
  const accountId = "111122223333";
  await database.batch([
    database.prepare(
      "INSERT INTO organizations (id, slug, name, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).bind(orgId, `broker-${orgId.slice(4, 12)}`, "Broker Org", now),
    database.prepare(
      "INSERT INTO customers (id, org_id, slug, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
    ).bind(customerId, orgId, "broker-customer", "Broker Customer", now, now),
    database.prepare(
      `INSERT INTO aws_connections
        (id, org_id, customer_id, source_kind, partition, aws_account_id, role_arn,
         external_id_ciphertext, external_id_key_version, permission_pack_version,
         status, enabled_regions_json, created_at, updated_at)
       VALUES (?, ?, ?, 'aws_trust_role', 'aws', ?, ?, ?, 'test-key-v1', ?, 'active', '["us-east-1"]', ?, ?)`,
    ).bind(
      connectionId, orgId, customerId, accountId,
      `arn:aws:iam::${accountId}:role/sutra/SutraReadOnlyRole`,
      "ciphertext-not-a-real-secret", pilotRepository.CURRENT_PILOT_PERMISSION_PACK, now, now,
    ),
  ]);
  return { orgId, customerId, connectionId };
}

function randomNonce() {
  return crypto.randomUUID().replaceAll("-", "") + "abcdefghijk"; // 43 base64url chars
}

function buildRequest({ keys, scope, body, headerOverrides = {}, nonce = randomNonce(), timestamp = String(Date.now()) }) {
  const bodyBytes = new TextEncoder().encode(body);
  const bodySha256 = createHash("sha256").update(bodyBytes).digest("hex");
  const url = new URL(INGEST_URL);
  const path = `${url.pathname}${url.search}`;
  const canonical = canonicalHostedBrokerRequest({
    method: "POST",
    path,
    timestamp,
    nonce,
    keyId: KEY_ID,
    scope,
    bodySha256,
  });
  const signature = signEd25519(null, canonical, keys.privateKey).toString("base64url");
  const headers = new Headers({
    "content-type": "application/octet-stream",
    "x-sutra-timestamp": timestamp,
    "x-sutra-nonce": nonce,
    "x-sutra-key-id": KEY_ID,
    "x-sutra-tenant-id": scope.tenantId,
    "x-sutra-connection-id": scope.connectionId,
    "x-sutra-job-id": scope.jobId,
    "x-sutra-signature": signature,
    ...headerOverrides,
  });
  return new Request(INGEST_URL, { method: "POST", headers, body: bodyBytes });
}

function makeDeps(database, keys) {
  const verifier = new HostedBrokerRequestVerifier({
    publicKeys: {
      async resolve({ tenantId, keyId }) {
        return keyId === KEY_ID && typeof tenantId === "string" ? keys.pem : null;
      },
    },
    replayStore: new D1HostedBrokerReplayStore(database),
    maximumBodyBytes: MAX_BODY,
  });
  return {
    verifier,
    resolveScope: (connectionId) => resolveHostedBrokerConnectionScope(connectionId, database),
    enqueue: (input) => new JobQueueRepository(database).enqueue(input),
    maximumBodyBytes: MAX_BODY,
  };
}

test("a valid signed broker request enqueues a collector job scoped to the connection's org", async () => {
  await withDatabase(async (database) => {
    const { orgId, customerId, connectionId } = await seedOrgConnection(database);
    const keys = generateKeyPairSync("ed25519");
    keys.pem = keys.publicKey.export({ type: "spki", format: "pem" });
    const deps = makeDeps(database, keys);
    const scope = { tenantId: orgId, connectionId, jobId: "collect-2026-07-21" };
    const request = buildRequest({ keys, scope, body: JSON.stringify({ resources: 3 }) });

    const outcome = await ingestHostedBrokerRequest(request, deps);
    assert.equal(outcome.status, 202, JSON.stringify(outcome.body));
    assert.equal(outcome.body.ok, true);

    // The enqueued job carries the SERVER-DERIVED org + customer, taken from the
    // connection row, not from anything the request declared.
    const row = await database.prepare(
      "SELECT org_id, customer_id, kind FROM background_jobs WHERE id = ?",
    ).bind(outcome.body.jobId).first();
    assert.equal(row.org_id, orgId);
    assert.equal(row.customer_id, customerId);
    assert.equal(row.kind, "hosted.broker.ingest");
  });
});

test("an unknown connection is indistinguishable from a bad signature (no existence oracle)", async () => {
  await withDatabase(async (database) => {
    const { orgId, connectionId } = await seedOrgConnection(database);
    const keys = generateKeyPairSync("ed25519");
    keys.pem = keys.publicKey.export({ type: "spki", format: "pem" });
    const deps = makeDeps(database, keys);

    // LOW-1: an unknown/inactive connection must NOT leak its non-existence. It
    // returns the SAME status+code as a KNOWN connection presented with a bad
    // signature, so an unauthenticated caller cannot probe which connection ids
    // exist.
    const unknownScope = { tenantId: "org_missing", connectionId: "conn_does_not_exist_00000000000000000000", jobId: "job-1" };
    const unknown = await ingestHostedBrokerRequest(buildRequest({ keys, scope: unknownScope, body: "{}" }), deps);

    const foreign = generateKeyPairSync("ed25519");
    const knownScope = { tenantId: orgId, connectionId, jobId: "job-1" };
    const badSignature = await ingestHostedBrokerRequest(
      buildRequest({ keys: { privateKey: foreign.privateKey }, scope: knownScope, body: "{}" }),
      deps,
    );

    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error.code, "AUTHENTICATION_FAILED");
    assert.deepEqual(unknown, badSignature, "unknown-connection and bad-signature responses must be identical");
  });
});

test("a tampered signature is rejected as AUTHENTICATION_FAILED", async () => {
  await withDatabase(async (database) => {
    const { orgId, connectionId } = await seedOrgConnection(database);
    const keys = generateKeyPairSync("ed25519");
    keys.pem = keys.publicKey.export({ type: "spki", format: "pem" });
    const deps = makeDeps(database, keys);
    const scope = { tenantId: orgId, connectionId, jobId: "job-1" };
    // A different key signs the request; the resolver returns the legitimate key.
    const foreign = generateKeyPairSync("ed25519");
    const request = buildRequest({ keys: { privateKey: foreign.privateKey }, scope, body: "{}" });
    const outcome = await ingestHostedBrokerRequest(request, deps);
    assert.equal(outcome.status, 401);
    assert.equal(outcome.body.error.code, "AUTHENTICATION_FAILED");
  });
});

test("a replayed request (same nonce) is rejected the second time", async () => {
  await withDatabase(async (database) => {
    const { orgId, connectionId } = await seedOrgConnection(database);
    const keys = generateKeyPairSync("ed25519");
    keys.pem = keys.publicKey.export({ type: "spki", format: "pem" });
    const deps = makeDeps(database, keys);
    const scope = { tenantId: orgId, connectionId, jobId: "job-1" };
    const nonce = randomNonce();
    const timestamp = String(Date.now());
    const first = await ingestHostedBrokerRequest(buildRequest({ keys, scope, body: "{}", nonce, timestamp }), deps);
    assert.equal(first.status, 202);
    const second = await ingestHostedBrokerRequest(buildRequest({ keys, scope, body: "{}", nonce, timestamp }), deps);
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "REQUEST_REPLAYED");
  });
});

test("a scope claim that disagrees with the connection's true org is rejected as SCOPE_MISMATCH", async () => {
  await withDatabase(async (database) => {
    const { connectionId } = await seedOrgConnection(database);
    const keys = generateKeyPairSync("ed25519");
    keys.pem = keys.publicKey.export({ type: "spki", format: "pem" });
    const deps = makeDeps(database, keys);
    // The caller signs and presents a FORGED tenant id; the server derives the
    // real org from the connection row, so the header disagrees and fails closed.
    const scope = { tenantId: "org_attacker_controlled_0000000000", connectionId, jobId: "job-1" };
    const outcome = await ingestHostedBrokerRequest(buildRequest({ keys, scope, body: "{}" }), deps);
    assert.equal(outcome.status, 403);
    assert.equal(outcome.body.error.code, "SCOPE_MISMATCH");
  });
});

test("an oversized body is rejected as BODY_TOO_LARGE", async () => {
  await withDatabase(async (database) => {
    const { orgId, connectionId } = await seedOrgConnection(database);
    const keys = generateKeyPairSync("ed25519");
    keys.pem = keys.publicKey.export({ type: "spki", format: "pem" });
    const deps = makeDeps(database, keys);
    const scope = { tenantId: orgId, connectionId, jobId: "job-1" };
    const body = "x".repeat(MAX_BODY + 1);
    const outcome = await ingestHostedBrokerRequest(buildRequest({ keys, scope, body }), deps);
    assert.equal(outcome.status, 413);
    assert.equal(outcome.body.error.code, "BODY_TOO_LARGE");
  });
});

test("the durable D1 replay store reserves atomically and expires", async () => {
  await withDatabase(async (database) => {
    let clock = 1_000_000_000_000;
    const store = new D1HostedBrokerReplayStore(database, () => clock);
    assert.equal(await store.consume("nonce-a", clock + 1000), true, "first reservation succeeds");
    assert.equal(await store.consume("nonce-a", clock + 1000), false, "immediate replay is refused");
    // After the entry expires it is swept and the key can be reserved again.
    clock += 2000;
    assert.equal(await store.consume("nonce-a", clock + 1000), true, "post-expiry reservation succeeds");
  });
});

test("the ingestion route is inert unless hosted mode AND the master switch are on", async () => {
  const snapshot = {
    SUTRA_DEPLOYMENT_ENV: cloudflare.env.SUTRA_DEPLOYMENT_ENV,
    SUTRA_LOCAL_MODE: cloudflare.env.SUTRA_LOCAL_MODE,
    SUTRA_IDENTITY_MODE: cloudflare.env.SUTRA_IDENTITY_MODE,
    SUTRA_HOSTED_ENABLED: cloudflare.env.SUTRA_HOSTED_ENABLED,
  };
  try {
    cloudflare.env.SUTRA_DEPLOYMENT_ENV = "production";
    cloudflare.env.SUTRA_LOCAL_MODE = "false";
    cloudflare.env.SUTRA_IDENTITY_MODE = "oidc";
    // Hosted runtime but master switch off => inert.
    for (const value of [undefined, "false", "TRUE", "1", " true"]) {
      if (value === undefined) delete cloudflare.env.SUTRA_HOSTED_ENABLED;
      else cloudflare.env.SUTRA_HOSTED_ENABLED = value;
      assert.equal(isHostedBrokerIngestEnabled(), false, `master switch ${JSON.stringify(value)} must stay inert`);
    }
    // Master switch on AND hosted => live.
    cloudflare.env.SUTRA_HOSTED_ENABLED = "true";
    assert.equal(isHostedBrokerIngestEnabled(), true);
    // Master switch on but NOT a hosted runtime => still inert.
    cloudflare.env.SUTRA_DEPLOYMENT_ENV = "local";
    assert.equal(isHostedBrokerIngestEnabled(), false);
  } finally {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) delete cloudflare.env[key];
      else cloudflare.env[key] = value;
    }
  }
});
