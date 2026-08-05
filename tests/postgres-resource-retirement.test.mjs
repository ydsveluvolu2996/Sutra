import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

const databaseUrl = process.env.SUTRA_POSTGRES_RUNTIME_TEST_URL?.trim();
if (!databaseUrl) throw new Error("SUTRA_POSTGRES_RUNTIME_TEST_URL is required");
process.env.DATABASE_URL = databaseUrl;
process.env.SUTRA_RESOURCE_RETIREMENT_COMPLETE_MISSES = "2";
register(new URL("./cloudflare-loader.mjs", import.meta.url));

const { computeSnapshotSha256 } = await import("../lib/pilot-boundary.ts");
const pilotRepository = await import("../db/pilot-repository.ts");
const { getRawDb } = await import("../db/index.ts");

const SUFFIX = crypto.randomUUID().replaceAll("-", "");
const ORG_ID = `org_pg_retirement_${SUFFIX}`;
const CUSTOMER_ID = `cust_pg_retirement_${SUFFIX}`;
const CONNECTION_ID = `conn_${SUFFIX.slice(0, 32)}`;
const ACCOUNT_ID = `8${SUFFIX.replaceAll(/[a-f]/gu, "1").slice(0, 11)}`;
const ACTOR_ID = `usr_pg_retirement_${SUFFIX}`;
const RESOURCE_KEY = "aws.s3.bucket/pg-retirement";
const ORIGIN = { kind: "aws_live", fixtureId: null, fixtureVersion: null };
let collectedOffset = 0;

async function sha256(value) {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  ).toString("hex");
}

async function snapshot(runId, includeResource) {
  collectedOffset += 1;
  const collectedAt = new Date(Date.now() + collectedOffset).toISOString();
  const unsignedResource = {
    resourceKey: RESOURCE_KEY,
    service: "s3",
    resourceType: "aws.s3.bucket",
    nativeId: "pg-retirement",
    arn: `arn:aws:s3:::sutra-pg-retirement-${SUFFIX}`,
    name: "sutra-pg-retirement",
    region: "ap-south-1",
    state: "available",
    tags: { Environment: "production" },
    configuration: { bucketKeyEnabled: true },
    source: { api: "s3.ListBuckets", accountId: ACCOUNT_ID, collectedAt },
  };
  const resources = includeResource
    ? [{ ...unsignedResource, contentSha256: await sha256(JSON.stringify(unsignedResource)) }]
    : [];
  const unsigned = {
    schemaVersion: "sutra.inventory.v1",
    jobId: runId,
    connectionId: CONNECTION_ID,
    accountId: ACCOUNT_ID,
    partition: "aws",
    roleSessionName: "sutra-pg-retirement",
    collectedAt,
    coverageState: "complete",
    coverage: [{
      collectorKey: "s3.buckets",
      region: "ap-south-1",
      status: "succeeded",
      itemsObserved: resources.length,
      pagesObserved: 1,
    }],
    resources,
    relationships: [],
    findings: [],
  };
  return { ...unsigned, snapshotSha256: await computeSnapshotSha256(unsigned) };
}

async function publish(includeResource) {
  const runId = await pilotRepository.createSyncRun(CONNECTION_ID, { orgId: ORG_ID });
  const payload = await snapshot(runId, includeResource);
  const snapshotId = await pilotRepository.persistSnapshot(
    runId,
    payload,
    ACTOR_ID,
    ORIGIN,
    null,
    null,
    ORG_ID,
  );
  return { runId, snapshotId };
}

test("PostgreSQL applies complete-miss retirement and stale-history guards", async () => {
  const database = getRawDb();
  const now = Date.now();
  await database.batch([
    database.prepare(
      "INSERT INTO organizations (id, slug, name, status) VALUES (?, ?, 'PG retirement', 'active')",
    ).bind(ORG_ID, `pg-retirement-${SUFFIX}`),
    database.prepare(
      "INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, ?, 'PG retirement customer', 'active')",
    ).bind(CUSTOMER_ID, ORG_ID, `pg-retirement-customer-${SUFFIX}`),
    database.prepare(
      `INSERT INTO aws_connections
        (id, org_id, customer_id, source_kind, partition, aws_account_id,
         role_arn, external_id_ciphertext, external_id_key_version,
         permission_pack_version, status, enabled_regions_json,
         last_validated_at, created_at, updated_at)
       VALUES (?, ?, ?, 'aws_trust_role', 'aws', ?, ?, 'ciphertext',
               'pg-test-key', ?, 'active', '["ap-south-1"]', ?, ?, ?)`,
    ).bind(
      CONNECTION_ID,
      ORG_ID,
      CUSTOMER_ID,
      ACCOUNT_ID,
      `arn:aws:iam::${ACCOUNT_ID}:role/sutra/SutraReadOnlyRole`,
      pilotRepository.CURRENT_PILOT_PERMISSION_PACK,
      now,
      now,
      now,
    ),
  ]);

  await publish(true);
  const firstMiss = await publish(false);
  let projection = await database.prepare(
    `SELECT lifecycle_state, consecutive_complete_misses,
            last_observed_snapshot_id
       FROM cmdb_resource_projection_states
      WHERE org_id = ? AND connection_id = ? AND resource_key = ?`,
  ).bind(ORG_ID, CONNECTION_ID, RESOURCE_KEY).first();
  assert.equal(projection.lifecycle_state, "retirement_pending");
  assert.equal(Number(projection.consecutive_complete_misses), 1);
  const pending = await pilotRepository.getPilotStateForOrg(ORG_ID, CONNECTION_ID);
  assert.equal(pending.activeSnapshot.id, firstMiss.snapshotId);
  assert.equal(pending.resources[0].lifecycleState, "retirement_pending");
  assert.notEqual(pending.resources[0].evidenceSnapshot.id, firstMiss.snapshotId);
  assert.equal(
    (await pilotRepository.getChangeHistory({
      orgId: ORG_ID,
      customerId: CUSTOMER_ID,
      connectionId: CONNECTION_ID,
    })).filter((event) => event.changeType === "removed").length,
    0,
  );

  const retired = await publish(false);
  projection = await database.prepare(
    `SELECT lifecycle_state, consecutive_complete_misses
       FROM cmdb_resource_projection_states
      WHERE org_id = ? AND connection_id = ? AND resource_key = ?`,
  ).bind(ORG_ID, CONNECTION_ID, RESOURCE_KEY).first();
  assert.equal(projection.lifecycle_state, "retired");
  assert.equal(Number(projection.consecutive_complete_misses), 2);
  assert.equal((await pilotRepository.getPilotStateForOrg(ORG_ID, CONNECTION_ID)).resources.length, 0);
  const history = await pilotRepository.getChangeHistory({
    orgId: ORG_ID,
    customerId: CUSTOMER_ID,
    connectionId: CONNECTION_ID,
  });
  assert.equal(history.filter((event) => event.changeType === "removed").length, 1);
  assert.equal(history.find((event) => event.changeType === "removed").toSnapshotId, retired.snapshotId);

  const staleRunId = `sync_pg_stale_${SUFFIX}`;
  await database.prepare(
    `INSERT INTO sync_runs
      (id, org_id, customer_id, connection_id, trigger_kind, status,
       coverage_state, collector_pack_version, totals_json, idempotency_key,
       started_at, created_at)
     VALUES (?, ?, ?, ?, 'manual', 'running', 'unknown',
             'aws-pilot-v1', '{}', ?, 1, 1)`,
  ).bind(staleRunId, ORG_ID, CUSTOMER_ID, CONNECTION_ID, staleRunId).run();
  const stalePayload = await snapshot(staleRunId, true);
  const staleSnapshotId = await pilotRepository.persistSnapshot(
    staleRunId,
    stalePayload,
    ACTOR_ID,
    ORIGIN,
    null,
    null,
    ORG_ID,
  );
  projection = await database.prepare(
    `SELECT lifecycle_state, consecutive_complete_misses
       FROM cmdb_resource_projection_states
      WHERE org_id = ? AND connection_id = ? AND resource_key = ?`,
  ).bind(ORG_ID, CONNECTION_ID, RESOURCE_KEY).first();
  assert.equal(projection.lifecycle_state, "retired");
  assert.equal(Number(projection.consecutive_complete_misses), 2);
  assert.equal(
    Number((await database.prepare(
      "SELECT projection_applied FROM cmdb_change_events WHERE to_snapshot_id = ?",
    ).bind(staleSnapshotId).first()).projection_applied),
    0,
  );
  assert.equal(
    (await pilotRepository.getChangeHistory({
      orgId: ORG_ID,
      customerId: CUSTOMER_ID,
      connectionId: CONNECTION_ID,
    })).some((event) => event.toSnapshotId === staleSnapshotId),
    false,
  );
});
