import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { DspmRepository, DspmRepositoryError } = await import("../db/dspm-repository.ts");
const { parseDspmPublishRequest } = await import("../lib/dspm-posture.ts");

const ORG_A = "org_dspm_a";
const ORG_B = "org_dspm_b";
const CUSTOMER_A = "cust_dspm_a";
const CUSTOMER_B = "cust_dspm_b";
const CONN_A = `conn_${"a".repeat(32)}`;
const CONN_B = `conn_${"b".repeat(32)}`;
const SCOPE_A = { orgId: ORG_A, customerId: CUSTOMER_A };
const SCOPE_B = { orgId: ORG_B, customerId: CUSTOMER_B };

function publication(overrides = {}) {
  return parseDspmPublishRequest({
    connectionId: CONN_A,
    source: "normalized-import",
    idempotencyKey: "dspm-publication-1",
    collectedAt: "2026-07-30T00:00:00.000Z",
    coverage: { status: "COMPLETE", resourcesDiscovered: 2, resourcesClassified: 2, limitations: [] },
    assets: [
      {
        resourceKey: "arn:aws:s3:::restricted-public",
        resourceType: "s3-bucket",
        region: "ap-south-1",
        classification: "restricted",
        categories: ["personal"],
        ownerRef: null,
        encrypted: false,
        publicAccess: true,
        crossAccountAccess: true,
        externalSharing: false,
        credentialsDetected: false,
        dataSizeBytes: 2048,
      },
      {
        resourceKey: "arn:aws:dynamodb:ap-south-1:111122223333:table/public-catalog",
        resourceType: "dynamodb-table",
        region: "ap-south-1",
        classification: "public",
        categories: [],
        ownerRef: "catalog-team",
        encrypted: true,
        publicAccess: false,
        crossAccountAccess: false,
        externalSharing: false,
        credentialsDetected: false,
        dataSizeBytes: 512,
      },
    ],
    ...overrides,
  });
}

function connectionRow(database, id, orgId, customerId, account) {
  return database.prepare(
    `INSERT INTO aws_connections
       (id, org_id, customer_id, aws_account_id, role_arn, external_id_ciphertext,
        external_id_key_version, permission_pack_version, status)
     VALUES (?, ?, ?, ?, ?, 'ct', 'v1', 'pack-v1', 'active')`,
  ).bind(id, orgId, customerId, account, `arn:aws:iam::${account}:role/sutra`);
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-dspm-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'dspm-a', 'DSPM A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'dspm-b', 'DSPM B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'dspm-ca', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'dspm-cb', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
      connectionRow(database, CONN_A, ORG_A, CUSTOMER_A, "111122223333"),
      connectionRow(database, CONN_B, ORG_B, CUSTOMER_B, "444455556666"),
    ]);
    await run(new DspmRepository(database), database);
  } finally {
    await miniflare.dispose();
  }
}

test("publishes immutable risk evidence and a chained global audit event", async () => {
  await withDatabase(async (repository, database) => {
    const result = await repository.publish(SCOPE_A, publication(), { actorId: "user_dspm_operator" });
    assert.equal(result.replayed, false);
    assert.match(result.run.id, /^dsr_[a-f0-9]{32}$/u);
    assert.equal(result.run.assetCount, 2);
    assert.equal(result.run.findingCount, 1);

    const workspace = await repository.workspace(SCOPE_A, CONN_A);
    assert.equal(workspace.state, "AVAILABLE");
    assert.equal(workspace.summary.critical, 1);
    assert.equal(workspace.summary.publicAccess, 1);
    assert.equal(workspace.summary.ownerUnassigned, 1);
    assert.equal(workspace.assets[0].risk.score, 100);

    const audit = await database.prepare(
      "SELECT action, customer_id, target_id, metadata_json, event_hash FROM audit_events WHERE org_id = ?",
    ).bind(ORG_A).first();
    assert.equal(audit.action, "dspm.evidence.published");
    assert.equal(audit.customer_id, CUSTOMER_A);
    assert.equal(audit.target_id, result.run.id);
    assert.match(audit.event_hash, /^[a-f0-9]{64}$/u);
    assert.equal(JSON.parse(audit.metadata_json).evidenceSha256, result.run.evidenceSha256);

    await assert.rejects(
      () => database.prepare("UPDATE dspm_scan_runs SET source = 'aws-macie' WHERE id = ?").bind(result.run.id).run(),
      /immutable/iu,
    );
    await assert.rejects(
      () => database.prepare("DELETE FROM dspm_asset_evidence WHERE scan_run_id = ?").bind(result.run.id).run(),
      /immutable/iu,
    );
  });
});

test("an exact retry is idempotent and key reuse with different evidence conflicts", async () => {
  await withDatabase(async (repository, database) => {
    const first = await repository.publish(SCOPE_A, publication(), { actorId: "user_dspm_operator" });
    const replay = await repository.publish(SCOPE_A, publication(), { actorId: "user_dspm_operator" });
    assert.equal(replay.replayed, true);
    assert.equal(replay.run.id, first.run.id);
    assert.equal(Number((await database.prepare("SELECT COUNT(*) AS n FROM dspm_scan_runs").first()).n), 1);
    assert.equal(Number((await database.prepare("SELECT COUNT(*) AS n FROM audit_events").first()).n), 1);

    await assert.rejects(
      () => repository.publish(SCOPE_A, publication({
        coverage: { status: "PARTIAL", resourcesDiscovered: 2, resourcesClassified: 2, limitations: ["ACCESS_EVIDENCE_PARTIAL"] },
      }), { actorId: "user_dspm_operator" }),
      (error) => error instanceof DspmRepositoryError && error.code === "CONFLICT",
    );
  });
});

test("tenant and connection scope fail closed on writes and reads", async () => {
  await withDatabase(async (repository) => {
    await repository.publish(SCOPE_A, publication(), { actorId: "user_dspm_operator" });
    const otherTenant = await repository.workspace(SCOPE_B, CONN_A);
    assert.equal(otherTenant.state, "NEVER_SCANNED");
    assert.deepEqual(otherTenant.assets, []);

    await assert.rejects(
      () => repository.publish(SCOPE_B, publication(), { actorId: "user_dspm_operator" }),
      (error) => error instanceof DspmRepositoryError && error.code === "NOT_FOUND",
    );
  });
});

test("an older publication remains historical but cannot roll back the current head", async () => {
  await withDatabase(async (repository) => {
    const recent = await repository.publish(SCOPE_A, publication({
      idempotencyKey: "recent",
      collectedAt: "2026-07-30T00:00:00.000Z",
    }), { actorId: "user_dspm_operator" });
    const old = await repository.publish(SCOPE_A, publication({
      idempotencyKey: "old",
      collectedAt: "2026-07-29T00:00:00.000Z",
    }), { actorId: "user_dspm_operator" });
    const current = await repository.workspace(SCOPE_A, CONN_A);
    assert.equal(current.currentRun.id, recent.run.id);
    assert.equal(current.runs.length, 2);
    const historical = await repository.workspace(SCOPE_A, CONN_A, old.run.id);
    assert.equal(historical.currentRun.id, old.run.id);
  });
});
