import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const pilotRepository = await import("../db/pilot-repository.ts");
const { computeSnapshotSha256 } = await import("../lib/pilot-boundary.ts");
const { runHostedBrokerIngestJob, HOSTED_BROKER_INGEST_ACTOR_ID } =
  await import("../lib/hosted-broker-ingest-job.ts");

const ORG_A = "org_hbi_a";
const ORG_B = "org_hbi_b";
const CUSTOMER_A = "cust_hbi_a";
const CUSTOMER_B = "cust_hbi_b";
const CONN_A = `conn_${"a".repeat(32)}`;
const CONN_B = `conn_${"b".repeat(32)}`;
const ACCOUNT_A = "111111111111";
const ACCOUNT_B = "222222222222";
const PERMISSION_PACK = "standard-2026-07.3";

// Real repository deps: this is the exact wiring buildJobHandlers registers, so
// a passing test exercises the true createSyncRun -> persistSnapshot path.
function realDeps() {
  return {
    getConnection: (orgId, connectionId) => pilotRepository.getConnectionForOrg(orgId, connectionId),
    createSyncRun: (connectionId, options) => pilotRepository.createSyncRun(connectionId, options),
    persistSnapshot: ({ runId, payload, actorId, origin, orgId }) =>
      pilotRepository.persistSnapshot(runId, payload, actorId, origin, null, null, orgId),
  };
}

async function insertActiveConnection(database, { orgId, customerId, connectionId, accountId }) {
  const now = Date.now();
  await database.prepare(
    `INSERT INTO aws_connections
      (id, org_id, customer_id, source_kind, partition, aws_account_id, role_arn,
       external_id_ciphertext, external_id_key_version, permission_pack_version,
       status, enabled_regions_json, created_at, updated_at)
     VALUES (?, ?, ?, 'aws_trust_role', 'aws', ?, ?, 'ct', 'v1', ?, 'active', '["us-east-1"]', ?, ?)`,
  ).bind(connectionId, orgId, customerId, accountId, `arn:aws:iam::${accountId}:role/sutra`, PERMISSION_PACK, now, now).run();
}

// Build a self-consistent sutra.inventory.v1 payload for the given identity.
async function buildSnapshotBody({ jobId, connectionId, accountId, partition = "aws" }) {
  const collectedAt = new Date().toISOString();
  const unsigned = {
    schemaVersion: "sutra.inventory.v1",
    jobId,
    connectionId,
    accountId,
    partition,
    roleSessionName: "sutra-hosted",
    collectedAt,
    coverageState: "complete",
    coverage: [{ collectorKey: "ec2", region: "us-east-1", status: "succeeded", itemsObserved: 1, pagesObserved: 1 }],
    resources: [{
      resourceKey: "ec2:i-1",
      service: "ec2",
      resourceType: "instance",
      nativeId: "i-1",
      arn: `arn:aws:ec2:us-east-1:${accountId}:instance/i-1`,
      name: "web",
      region: "us-east-1",
      state: "running",
      tags: {},
      configuration: {},
      source: { api: "ec2.DescribeInstances", accountId, collectedAt },
      contentSha256: "a".repeat(64),
    }],
    relationships: [],
    findings: [],
  };
  const snapshotSha256 = await computeSnapshotSha256(unsigned);
  const payload = { ...unsigned, snapshotSha256 };
  const bodyText = JSON.stringify(payload);
  const bytes = Buffer.from(bodyText, "utf8");
  return {
    connectionId,
    brokerJobId: jobId,
    keyId: "broker-key-1",
    bodySha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    bodyBase64: bytes.toString("base64"),
  };
}

function jobFor(envelope, { orgId = ORG_A, customerId = CUSTOMER_A } = {}) {
  return {
    id: `job_${"1".repeat(32)}`,
    orgId,
    customerId,
    kind: "hosted.broker.ingest",
    attempt: 1,
    maxAttempts: 5,
    payload: envelope,
  };
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-hbi-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'hbi-a', 'HBI A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'hbi-b', 'HBI B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'hbi-cust-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'hbi-cust-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
    ]);
    await run(database);
  } finally {
    await miniflare.dispose();
  }
}

async function snapshotCount(database, orgId, connectionId) {
  const row = await database.prepare(
    "SELECT COUNT(*) AS n FROM cmdb_snapshots WHERE org_id = ? AND connection_id = ?",
  ).bind(orgId, connectionId).first();
  return Number(row?.n ?? 0);
}

test("valid payload persists the inventory scoped to the job's tenant", async () => {
  await withDatabase(async (database) => {
    await insertActiveConnection(database, { orgId: ORG_A, customerId: CUSTOMER_A, connectionId: CONN_A, accountId: ACCOUNT_A });
    const brokerJobId = `job_${"9".repeat(32)}`;
    const envelope = await buildSnapshotBody({ jobId: brokerJobId, connectionId: CONN_A, accountId: ACCOUNT_A });

    await runHostedBrokerIngestJob(jobFor(envelope), realDeps());

    // A complete snapshot exists under the tenant org, with its resource.
    const snapshot = await database.prepare(
      "SELECT id, status FROM cmdb_snapshots WHERE org_id = ? AND connection_id = ?",
    ).bind(ORG_A, CONN_A).first();
    assert.equal(snapshot?.status, "complete");
    const resources = await database.prepare(
      "SELECT COUNT(*) AS n FROM cmdb_resources WHERE org_id = ? AND snapshot_id = ?",
    ).bind(ORG_A, snapshot.id).first();
    assert.equal(Number(resources.n), 1);

    // The sync run is keyed by the broker's signed job id and marked succeeded.
    const run = await database.prepare(
      "SELECT status, idempotency_key, customer_id FROM sync_runs WHERE org_id = ? AND connection_id = ?",
    ).bind(ORG_A, CONN_A).first();
    assert.equal(run.status, "succeeded");
    assert.equal(run.idempotency_key, brokerJobId);
    assert.equal(run.customer_id, CUSTOMER_A);

    // The publication audit event is chained under the tenant org, not local.
    const audit = await database.prepare(
      "SELECT actor_id, action FROM audit_events WHERE org_id = ? AND action = 'aws.sync.published'",
    ).bind(ORG_A).first();
    assert.equal(audit.actor_id, HOSTED_BROKER_INGEST_ACTOR_ID);

    // Nothing leaked into the local pilot org.
    assert.equal(await snapshotCount(database, "org_local_sutra", CONN_A), 0);
  });
});

test("a connection unknown in the job's org is rejected with no write", async () => {
  await withDatabase(async (database) => {
    // The connection lives in ORG_B, but the job claims ORG_A scope.
    await insertActiveConnection(database, { orgId: ORG_B, customerId: CUSTOMER_B, connectionId: CONN_B, accountId: ACCOUNT_B });
    const envelope = await buildSnapshotBody({ jobId: `job_${"7".repeat(32)}`, connectionId: CONN_B, accountId: ACCOUNT_B });
    await assert.rejects(
      runHostedBrokerIngestJob(jobFor(envelope, { orgId: ORG_A, customerId: CUSTOMER_A }), realDeps()),
      /connection-unknown/u,
    );
    assert.equal(await snapshotCount(database, ORG_A, CONN_B), 0);
    assert.equal(await snapshotCount(database, ORG_B, CONN_B), 0);
  });
});

test("a connection owned by a different customer than the job scope is rejected", async () => {
  await withDatabase(async (database) => {
    await insertActiveConnection(database, { orgId: ORG_A, customerId: CUSTOMER_A, connectionId: CONN_A, accountId: ACCOUNT_A });
    const envelope = await buildSnapshotBody({ jobId: `job_${"6".repeat(32)}`, connectionId: CONN_A, accountId: ACCOUNT_A });
    // Same org, but the job's customer scope does not own the connection.
    await assert.rejects(
      runHostedBrokerIngestJob(jobFor(envelope, { orgId: ORG_A, customerId: "cust_not_owner" }), realDeps()),
      /scope-mismatch/u,
    );
    assert.equal(await snapshotCount(database, ORG_A, CONN_A), 0);
  });
});

test("a payload that claims a different AWS account cannot redirect the write", async () => {
  await withDatabase(async (database) => {
    await insertActiveConnection(database, { orgId: ORG_A, customerId: CUSTOMER_A, connectionId: CONN_A, accountId: ACCOUNT_A });
    // Self-consistent snapshot (valid sha), but for a foreign account id.
    const envelope = await buildSnapshotBody({ jobId: `job_${"5".repeat(32)}`, connectionId: CONN_A, accountId: ACCOUNT_B });
    await assert.rejects(
      runHostedBrokerIngestJob(jobFor(envelope), realDeps()),
      /inventory-invalid/u,
    );
    assert.equal(await snapshotCount(database, ORG_A, CONN_A), 0);
  });
});

test("a body whose SHA-256 does not match what the broker signed is rejected", async () => {
  await withDatabase(async (database) => {
    await insertActiveConnection(database, { orgId: ORG_A, customerId: CUSTOMER_A, connectionId: CONN_A, accountId: ACCOUNT_A });
    const envelope = await buildSnapshotBody({ jobId: `job_${"4".repeat(32)}`, connectionId: CONN_A, accountId: ACCOUNT_A });
    const tampered = { ...envelope, bodySha256: "b".repeat(64) };
    await assert.rejects(
      runHostedBrokerIngestJob(jobFor(tampered), realDeps()),
      /body-hash-mismatch/u,
    );
    assert.equal(await snapshotCount(database, ORG_A, CONN_A), 0);
  });
});

test("a structurally malformed job payload is rejected", async () => {
  await withDatabase(async (database) => {
    await assert.rejects(
      runHostedBrokerIngestJob(jobFor({ connectionId: CONN_A }), realDeps()),
      /payload-invalid/u,
    );
    assert.equal(await snapshotCount(database, ORG_A, CONN_A), 0);
  });
});
