import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const { computeSnapshotSha256 } = await import("../lib/pilot-boundary.ts");
const {
  DEFAULT_RESOURCE_RETIREMENT_COMPLETE_MISSES,
  resolveResourceRetirementCompleteMisses,
} = await import("../lib/resource-retirement.ts");
const { buildReport } = await import("../lib/report-builder.ts");
const pilotRepository = await import("../db/pilot-repository.ts");
const { CmdbWorkspaceRepository } = await import("../db/cmdb-workspace-repository.ts");
const { ApiTokenRepository } = await import("../db/api-token-repository.ts");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const publicResourcesRoute = await import("../app/api/public/v1/resources/route.ts");

const ORG_ID = "org_retirement_a";
const CUSTOMER_ID = "cust_retirement_a";
const CONNECTION_ID = `conn_${"7".repeat(32)}`;
const ACCOUNT_ID = "700000000001";
const ACTOR_ID = "usr_retirement_test";
const RESOURCE_KEY = "aws.ec2.instance/i-retirement";
const ORIGIN = { kind: "aws_live", fixtureId: null, fixtureVersion: null };

function sha256(value) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
    .then((digest) => Buffer.from(digest).toString("hex"));
}

async function resource(collectedAt) {
  const unsigned = {
    resourceKey: RESOURCE_KEY,
    service: "ec2",
    resourceType: "aws.ec2.instance",
    nativeId: "i-retirement",
    arn: `arn:aws:ec2:ap-south-1:${ACCOUNT_ID}:instance/i-retirement`,
    name: "retirement-acceptance",
    region: "ap-south-1",
    state: "running",
    tags: { Environment: "production" },
    configuration: { instanceType: "t3.small", monitoring: true },
    source: {
      api: "ec2.DescribeInstances",
      accountId: ACCOUNT_ID,
      collectedAt,
    },
  };
  return { ...unsigned, contentSha256: await sha256(JSON.stringify(unsigned)) };
}

let collectedOffset = 0;

async function snapshot(runId, coverageState, includeResource) {
  collectedOffset += 1;
  const collectedAt = new Date(Date.now() + collectedOffset).toISOString();
  const resources = includeResource ? [await resource(collectedAt)] : [];
  const unsigned = {
    schemaVersion: "sutra.inventory.v1",
    jobId: runId,
    connectionId: CONNECTION_ID,
    accountId: ACCOUNT_ID,
    partition: "aws",
    roleSessionName: "sutra-retirement-test",
    collectedAt,
    coverageState,
    coverage: [{
      collectorKey: "ec2.instances",
      region: "ap-south-1",
      status: coverageState === "complete" ? "succeeded" : "partial",
      itemsObserved: resources.length,
      pagesObserved: 1,
      ...(coverageState === "complete" ? {} : {
        errorCode: "COLLECTION_FAILED",
        message: "Acceptance partial coverage",
      }),
    }],
    resources,
    relationships: [],
    findings: [],
  };
  return { ...unsigned, snapshotSha256: await computeSnapshotSha256(unsigned) };
}

async function publish(coverageState, includeResource) {
  const runId = await pilotRepository.createSyncRun(CONNECTION_ID, { orgId: ORG_ID });
  const payload = await snapshot(runId, coverageState, includeResource);
  const snapshotId = await pilotRepository.persistSnapshot(
    runId,
    payload,
    ACTOR_ID,
    ORIGIN,
    null,
    null,
    ORG_ID,
  );
  return { runId, payload, snapshotId };
}

async function projectionRow(database) {
  return database.prepare(
    `SELECT lifecycle_state, consecutive_complete_misses,
            last_observed_snapshot_id, first_missing_snapshot_id,
            state_changed_snapshot_id, last_complete_run_id
       FROM cmdb_resource_projection_states
      WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND resource_key = ?
      LIMIT 1`,
  ).bind(ORG_ID, CUSTOMER_ID, CONNECTION_ID, RESOURCE_KEY).first();
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-retirement-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    cloudflare.env.SUTRA_RESOURCE_RETIREMENT_COMPLETE_MISSES = "2";
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status) VALUES (?, 'retirement-a', 'Retirement A', 'active')",
      ).bind(ORG_ID),
      database.prepare(
        "INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'retirement-customer', 'Retirement customer', 'active')",
      ).bind(CUSTOMER_ID, ORG_ID),
      database.prepare(
        `INSERT INTO aws_connections
          (id, org_id, customer_id, source_kind, partition, aws_account_id,
           role_arn, external_id_ciphertext, external_id_key_version,
           permission_pack_version, status, enabled_regions_json,
           last_validated_at, created_at, updated_at)
         VALUES (?, ?, ?, 'aws_trust_role', 'aws', ?,
                 ?, 'ciphertext', 'test-key-v1', ?, 'active', '["ap-south-1"]',
                 ?, ?, ?)`,
      ).bind(
        CONNECTION_ID,
        ORG_ID,
        CUSTOMER_ID,
        ACCOUNT_ID,
        `arn:aws:iam::${ACCOUNT_ID}:role/sutra/SutraReadOnlyRole`,
        pilotRepository.CURRENT_PILOT_PERMISSION_PACK,
        Date.now(),
        Date.now(),
        Date.now(),
      ),
    ]);
    await run(database);
  } finally {
    delete cloudflare.env.SUTRA_RESOURCE_RETIREMENT_COMPLETE_MISSES;
    await miniflare.dispose();
  }
}

test("retirement grace configuration is explicit, bounded, and fail-closed", () => {
  assert.equal(resolveResourceRetirementCompleteMisses(undefined), DEFAULT_RESOURCE_RETIREMENT_COMPLETE_MISSES);
  assert.equal(resolveResourceRetirementCompleteMisses(" 3 "), 3);
  for (const invalid of ["0", "1", "31", "2.5", "two", "-2"]) {
    assert.throws(() => resolveResourceRetirementCompleteMisses(invalid), /must be/u);
  }
});

test("D1/PostgreSQL migrations and production surfaces pin the retirement contract", async () => {
  const files = await Promise.all([
    "drizzle/0074_cmdb_resource_retirement.sql",
    "postgres/migrations/0069_cmdb_resource_retirement.sql",
    "db/runtime-migrations.ts",
    "db/postgres-runtime-migrations.ts",
    "scripts/postgres-migrate.mjs",
    "db/schema.ts",
    "infrastructure/production-ha.yaml",
    "deploy/production/entrypoint.sh",
    "app/cmdb/inventory-browser.tsx",
    "app/api/public/v1/resources/route.ts",
    "lib/report-builder.ts",
  ].map((path) => readFile(new URL(`../${path}`, import.meta.url), "utf8")));
  const [d1, postgres, d1Registry, postgresRegistry, migrator, schema, production,
    entrypoint, dashboard, publicRoute, report] = files;
  for (const migration of [d1, postgres]) {
    assert.match(migration, /cmdb_resource_projection_states/u);
    assert.match(migration, /consecutive_complete_misses/u);
    assert.match(migration, /retirement_pending/u);
    assert.match(migration, /last_observed_resource_id/u);
    assert.match(migration, /projection_applied/u);
  }
  assert.match(d1Registry, /0074_cmdb_resource_retirement/u);
  assert.match(postgresRegistry, /0069_cmdb_resource_retirement/u);
  assert.match(migrator, /0069_cmdb_resource_retirement\.sql/u);
  assert.match(schema, /cmdbResourceProjectionStates/u);
  assert.match(production, /ResourceRetirementCompleteMisses:[\s\S]*Default: 2[\s\S]*MinValue: 2[\s\S]*MaxValue: 30/u);
  assert.match(entrypoint, /SUTRA_RESOURCE_RETIREMENT_COMPLETE_MISSES/u);
  assert.match(dashboard, /retirement pending/u);
  assert.match(publicRoute, /consecutiveCompleteMisses/u);
  assert.match(report, /Evidence snapshot SHA-256/u);
});

test("complete-run grace is atomic, tenant-scoped, evidence-honest, and non-regressive", async () => {
  await withDatabase(async (database) => {
    const initial = await publish("complete", true);
    let row = await projectionRow(database);
    assert.equal(row.lifecycle_state, "active");
    assert.equal(row.consecutive_complete_misses, 0);
    assert.equal(row.last_observed_snapshot_id, initial.snapshotId);

    const initialHead = await database.prepare(
      "SELECT snapshot_id FROM connection_heads WHERE connection_id = ? AND org_id = ?",
    ).bind(CONNECTION_ID, ORG_ID).first();

    // Partial evidence is retained, but it cannot advance the head or misses.
    await publish("partial", false);
    row = await projectionRow(database);
    assert.equal(row.lifecycle_state, "active");
    assert.equal(row.consecutive_complete_misses, 0);
    assert.equal(
      (await database.prepare(
        "SELECT snapshot_id FROM connection_heads WHERE connection_id = ? AND org_id = ?",
      ).bind(CONNECTION_ID, ORG_ID).first()).snapshot_id,
      initialHead.snapshot_id,
    );

    // A failed run likewise has no lifecycle effect.
    const failedRunId = await pilotRepository.createSyncRun(CONNECTION_ID, { orgId: ORG_ID });
    await pilotRepository.failSyncRun(
      failedRunId,
      CONNECTION_ID,
      ACTOR_ID,
      "COLLECTION_FAILED",
      ORG_ID,
    );
    row = await projectionRow(database);
    assert.equal(row.lifecycle_state, "active");
    assert.equal(row.consecutive_complete_misses, 0);

    // Force the final publication batch to fail. Snapshot staging evidence may
    // remain, but head, run, lifecycle, and projected history must roll back.
    const atomicRunId = await pilotRepository.createSyncRun(CONNECTION_ID, { orgId: ORG_ID });
    const atomicPayload = await snapshot(atomicRunId, "complete", false);
    let forced = false;
    cloudflare.env.DB = {
      prepare: database.prepare.bind(database),
      batch: async (statements) => {
        if (!forced && statements.length >= 7) {
          forced = true;
          return database.batch([
            ...statements,
            database.prepare("INSERT INTO audit_events (id) VALUES (?)")
              .bind(`broken_retirement_${crypto.randomUUID().replaceAll("-", "")}`),
          ]);
        }
        return database.batch(statements);
      },
    };
    await assert.rejects(
      pilotRepository.persistSnapshot(
        atomicRunId,
        atomicPayload,
        ACTOR_ID,
        ORIGIN,
        null,
        null,
        ORG_ID,
      ),
    );
    cloudflare.env.DB = database;
    row = await projectionRow(database);
    assert.equal(row.lifecycle_state, "active");
    assert.equal(row.consecutive_complete_misses, 0);
    assert.equal(
      (await database.prepare(
        "SELECT snapshot_id FROM connection_heads WHERE connection_id = ? AND org_id = ?",
      ).bind(CONNECTION_ID, ORG_ID).first()).snapshot_id,
      initialHead.snapshot_id,
    );
    assert.equal(
      (await database.prepare("SELECT status FROM sync_runs WHERE id = ?").bind(atomicRunId).first()).status,
      "running",
    );
    await database.prepare(
      "UPDATE sync_runs SET status = 'failed', coverage_state = 'unknown', finished_at = ? WHERE id = ?",
    ).bind(Date.now(), atomicRunId).run();

    // First authoritative miss: remain live and visibly pending, with the exact
    // original content/snapshot checksums and no premature "removed" history.
    const firstMiss = await publish("complete", false);
    row = await projectionRow(database);
    assert.equal(row.lifecycle_state, "retirement_pending");
    assert.equal(row.consecutive_complete_misses, 1);
    assert.equal(row.last_observed_snapshot_id, initial.snapshotId);
    assert.equal(row.first_missing_snapshot_id, firstMiss.snapshotId);

    const pendingState = await pilotRepository.getPilotStateForOrg(ORG_ID, CONNECTION_ID);
    assert.equal(pendingState.activeSnapshot.id, firstMiss.snapshotId);
    assert.equal(pendingState.resources.length, 1);
    assert.equal(pendingState.resources[0].lifecycleState, "retirement_pending");
    assert.equal(pendingState.resources[0].consecutiveCompleteMisses, 1);
    assert.equal(pendingState.resources[0].evidenceSnapshot.id, initial.snapshotId);
    assert.equal(
      pendingState.resources[0].evidenceSnapshot.snapshotSha256,
      initial.payload.snapshotSha256,
    );
    assert.equal(pendingState.resources[0].contentSha256, initial.payload.resources[0].contentSha256);
    assert.notEqual(pendingState.resources[0].evidenceSnapshot.id, pendingState.activeSnapshot.id);

    const workspace = new CmdbWorkspaceRepository(database);
    const pendingRows = await workspace.resourcesForQuery(
      { orgId: ORG_ID, customerId: CUSTOMER_ID },
      CONNECTION_ID,
    );
    assert.equal(pendingRows.length, 1);
    assert.equal(pendingRows[0].lifecycleState, "retirement_pending");
    assert.equal(pendingRows[0].evidenceSnapshotId, initial.snapshotId);
    assert.equal(pendingRows[0].evidenceSnapshotSha256, initial.payload.snapshotSha256);
    assert.deepEqual(
      await workspace.resourcesForQuery(
        { orgId: "org_retirement_b", customerId: CUSTOMER_ID },
        CONNECTION_ID,
      ),
      [],
    );

    const report = buildReport({
      dataset: "cmdb-resources",
      filters: {
        combine: "and",
        predicates: [{ kind: "field", field: "resourceKey", op: "eq", value: RESOURCE_KEY }],
      },
      columns: [
        "resourceKey",
        "lifecycleState",
        "consecutiveCompleteMisses",
        "evidenceSnapshotId",
        "evidenceSnapshotSha256",
        "contentSha256",
      ],
    }, pendingRows);
    assert.equal(report.rows[0].lifecycleState, "retirement_pending");
    assert.equal(report.rows[0].evidenceSnapshotId, initial.snapshotId);

    const minted = await new ApiTokenRepository(database).mint(
      { orgId: ORG_ID, customerId: CUSTOMER_ID },
      "Retirement acceptance",
      ["read:resources"],
      null,
      ACTOR_ID,
    );
    const publicResponse = await publicResourcesRoute.GET(new Request(
      "https://api.sutra.test/api/public/v1/resources",
      { headers: { authorization: `Bearer ${minted.token}` } },
    ));
    assert.equal(publicResponse.status, 200);
    const publicBody = await publicResponse.json();
    assert.equal(publicBody.data.length, 1);
    assert.equal(publicBody.data[0].lifecycleState, "retirement_pending");
    assert.equal(publicBody.data[0].consecutiveCompleteMisses, 1);
    assert.equal(publicBody.data[0].evidenceSnapshot.id, initial.snapshotId);
    assert.equal(publicBody.data[0].evidenceSnapshot.snapshotSha256, initial.payload.snapshotSha256);
    assert.equal(publicBody.data[0].contentSha256, initial.payload.resources[0].contentSha256);

    let history = await pilotRepository.getChangeHistory({
      orgId: ORG_ID,
      customerId: CUSTOMER_ID,
      connectionId: CONNECTION_ID,
      limit: 100,
    });
    assert.equal(history.filter((event) => event.changeType === "removed").length, 0);

    // Reappearance during grace resets lifecycle and misses.
    const reappeared = await publish("complete", true);
    row = await projectionRow(database);
    assert.equal(row.lifecycle_state, "active");
    assert.equal(row.consecutive_complete_misses, 0);
    assert.equal(row.last_observed_snapshot_id, reappeared.snapshotId);
    assert.equal(row.first_missing_snapshot_id, null);

    // Only the configured second consecutive complete miss retires it.
    await publish("complete", false);
    row = await projectionRow(database);
    assert.equal(row.lifecycle_state, "retirement_pending");
    assert.equal(row.consecutive_complete_misses, 1);
    const threshold = await publish("complete", false);
    row = await projectionRow(database);
    assert.equal(row.lifecycle_state, "retired");
    assert.equal(row.consecutive_complete_misses, 2);
    assert.equal(row.state_changed_snapshot_id, threshold.snapshotId);
    assert.equal(
      (await pilotRepository.getPilotStateForOrg(ORG_ID, CONNECTION_ID)).resources.length,
      0,
    );
    assert.equal(
      (await workspace.resourcesForQuery(
        { orgId: ORG_ID, customerId: CUSTOMER_ID },
        CONNECTION_ID,
      )).length,
      0,
    );
    history = await pilotRepository.getChangeHistory({
      orgId: ORG_ID,
      customerId: CUSTOMER_ID,
      connectionId: CONNECTION_ID,
      limit: 100,
    });
    assert.equal(history.filter((event) => event.changeType === "removed").length, 1);
    assert.equal(
      history.find((event) => event.changeType === "removed").toSnapshotId,
      threshold.snapshotId,
    );

    // A completion from a server-side older run is retained as immutable
    // evidence but cannot move the head, reanimate the resource, or publish
    // stale change history.
    const staleRunId = "sync_stale_retirement_acceptance";
    await database.prepare(
      `INSERT INTO sync_runs
        (id, org_id, customer_id, connection_id, trigger_kind, status,
         coverage_state, collector_pack_version, totals_json, idempotency_key,
         started_at, created_at)
       VALUES (?, ?, ?, ?, 'manual', 'running', 'unknown',
               'aws-pilot-v1', '{}', ?, 1, 1)`,
    ).bind(staleRunId, ORG_ID, CUSTOMER_ID, CONNECTION_ID, staleRunId).run();
    const stalePayload = await snapshot(staleRunId, "complete", true);
    const headBeforeStale = (await database.prepare(
      "SELECT snapshot_id FROM connection_heads WHERE connection_id = ? AND org_id = ?",
    ).bind(CONNECTION_ID, ORG_ID).first()).snapshot_id;
    const staleSnapshotId = await pilotRepository.persistSnapshot(
      staleRunId,
      stalePayload,
      ACTOR_ID,
      ORIGIN,
      null,
      null,
      ORG_ID,
    );
    assert.equal(
      (await database.prepare(
        "SELECT snapshot_id FROM connection_heads WHERE connection_id = ? AND org_id = ?",
      ).bind(CONNECTION_ID, ORG_ID).first()).snapshot_id,
      headBeforeStale,
    );
    row = await projectionRow(database);
    assert.equal(row.lifecycle_state, "retired");
    assert.equal(row.consecutive_complete_misses, 2);
    assert.equal(
      (await database.prepare(
        "SELECT projection_applied FROM cmdb_change_events WHERE to_snapshot_id = ? LIMIT 1",
      ).bind(staleSnapshotId).first()).projection_applied,
      0,
    );
    history = await pilotRepository.getChangeHistory({
      orgId: ORG_ID,
      customerId: CUSTOMER_ID,
      connectionId: CONNECTION_ID,
      limit: 100,
    });
    assert.equal(history.some((event) => event.toSnapshotId === staleSnapshotId), false);
  });
});
