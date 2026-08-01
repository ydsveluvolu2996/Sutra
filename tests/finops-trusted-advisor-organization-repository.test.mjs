import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const {
  TrustedAdvisorOrganizationRepository,
  TrustedAdvisorOrganizationRepositoryError,
  trustedAdvisorAccountSetSha256,
  trustedAdvisorAccountSnapshotSha256,
  trustedAdvisorResourceKey,
} = await import("../db/finops-trusted-advisor-organization-repository.ts");

const ORG_A = "org_ta_a";
const ORG_B = "org_ta_b";
const CUSTOMER_A = "customer_ta_a";
const CUSTOMER_B = "customer_ta_b";
const CONNECTION_A = `conn_${"a".repeat(32)}`;
const CONNECTION_A2 = `conn_${"c".repeat(32)}`;
const CONNECTION_B = `conn_${"b".repeat(32)}`;
const ACCOUNT_A = "111122223333";
const ACCOUNT_A2 = "222233334444";
const ACCOUNT_B = "999900001111";
const SCOPE_A = { organizationId: ORG_A, customerId: CUSTOMER_A, connectionId: CONNECTION_A };
const SCOPE_B = { organizationId: ORG_B, customerId: CUSTOMER_B, connectionId: CONNECTION_B };
const EVIDENCE = { ciphertext: `fsev1.${"A".repeat(40)}`, keyVersion: "ta-evidence-v1" };

function connection(database, id, orgId, customerId, accountId) {
  return database.prepare(
    `INSERT INTO aws_connections (
       id, org_id, customer_id, source_kind, partition, aws_account_id, role_arn,
       external_id_ciphertext, external_id_key_version, permission_pack_version,
       status, enabled_regions_json
     ) VALUES (?, ?, ?, 'aws_trust_role', 'aws', ?, ?, 'ct', 'v1', 'standard-2026-08.1', 'active', '[]')`,
  ).bind(id, orgId, customerId, accountId, `arn:aws:iam::${accountId}:role/sutra/SutraCollectorRole`);
}

async function withRepository(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-ta-org-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'ta-a', 'TA A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'ta-b', 'TA B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'ta-ca', 'TA CA', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'ta-cb', 'TA CB', 'active')").bind(CUSTOMER_B, ORG_B),
      connection(database, CONNECTION_A, ORG_A, CUSTOMER_A, ACCOUNT_A),
      connection(database, CONNECTION_A2, ORG_A, CUSTOMER_A, ACCOUNT_A2),
      connection(database, CONNECTION_B, ORG_B, CUSTOMER_B, ACCOUNT_B),
    ]);
    await run({ database, repository: new TrustedAdvisorOrganizationRepository(database) });
  } finally {
    await miniflare.dispose();
  }
}

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof TrustedAdvisorOrganizationRepositoryError);
    assert.equal(error.code, code);
    return true;
  };
}

async function createManifest(repository, jobId, accounts, nowMs) {
  return repository.createManifest(SCOPE_A, {
    jobId,
    taxonomySnapshotId: "ta-standard-taxonomy-2026-08",
    taxonomySha256: "d".repeat(64),
    accountSetSha256: await trustedAdvisorAccountSetSha256(accounts),
    accounts,
  }, nowMs);
}

async function acceptAccount(repository, manifestId, accountId, collectedAtIso, dataThroughAtIso, nowMs) {
  await repository.startAccount(SCOPE_A, manifestId, accountId, nowMs - 1_000);
  const metadataJson = JSON.stringify({ service: "ec2", reason: "idle" });
  const metadataSha256 = createHash("sha256").update(metadataJson).digest("hex");
  const resourceWithoutKey = {
    checkId: "check-1",
    resourceId: `i-${accountId}`,
    region: "us-east-1",
    status: "warning",
    suppressed: false,
    metadataJson,
    metadataSha256,
  };
  const resource = {
    ...resourceWithoutKey,
    resourceKey: await trustedAdvisorResourceKey(manifestId, accountId, resourceWithoutKey),
  };
  const hashInput = {
    accountId,
    status: "complete",
    collectedAtIso,
    dataThroughAtIso,
    rejectedRecordCount: 0,
    evidenceReference: EVIDENCE,
    checks: [{
      checkId: "check-1",
      name: "Idle EC2 instances",
      category: "cost_optimizing",
      status: "warning",
      dataThroughAtIso,
      processedCount: 1,
      flaggedCount: 1,
      ignoredCount: 0,
      suppressedCount: 0,
      contentSha256: "e".repeat(64),
    }],
    resources: [resource],
  };
  const contentSha256 = await trustedAdvisorAccountSnapshotSha256(hashInput);
  return repository.recordAccountSnapshot(SCOPE_A, manifestId, {
    ...hashInput,
    contentSha256,
  }, nowMs);
}

test("manifests validate frozen account checksums and exact live connection ownership", async () => {
  await withRepository(async ({ repository }) => {
    const accounts = [{ accountId: ACCOUNT_A, targetConnectionId: CONNECTION_A }];
    await assert.rejects(repository.createManifest(SCOPE_A, {
      jobId: "ta-bad-hash",
      taxonomySnapshotId: "taxonomy-1",
      taxonomySha256: "1".repeat(64),
      accountSetSha256: "2".repeat(64),
      accounts,
    }, 1), expectCode("CHECKSUM_MISMATCH"));
    await assert.rejects(createManifest(repository, "ta-cross-tenant", [{
      accountId: ACCOUNT_B,
      targetConnectionId: CONNECTION_B,
    }], 2), expectCode("SCOPE_NOT_FOUND"));

    const manifest = await createManifest(repository, "ta-valid", accounts, 3);
    const retry = await createManifest(repository, "ta-valid", [...accounts].reverse(), 4);
    assert.equal(retry.manifestId, manifest.manifestId);
    assert.equal(retry.createdAtIso, new Date(3).toISOString());
    assert.equal(await repository.getManifest(SCOPE_B, manifest.manifestId), null);
  });
});

test("complete generations advance monotonically while partial generations remain history-only", async () => {
  await withRepository(async ({ repository }) => {
    const first = await createManifest(repository, "ta-first", [{
      accountId: ACCOUNT_A,
      targetConnectionId: CONNECTION_A,
    }], Date.parse("2026-07-30T00:00:00.000Z"));
    await repository.startManifest(SCOPE_A, first.manifestId, Date.parse("2026-07-30T00:01:00.000Z"));
    await acceptAccount(
      repository, first.manifestId, ACCOUNT_A,
      "2026-07-30T01:00:00.000Z", "2026-07-30T00:30:00.000Z",
      Date.parse("2026-07-30T01:01:00.000Z"),
    );
    const firstGeneration = await repository.finalizeManifest(
      SCOPE_A, first.manifestId, Date.parse("2026-07-30T01:02:00.000Z"),
    );
    assert.equal(firstGeneration.status, "complete");
    assert.equal((await repository.getActiveSnapshot(SCOPE_A))?.generationId, firstGeneration.generationId);

    const partial = await createManifest(repository, "ta-partial", [{
      accountId: ACCOUNT_A,
      targetConnectionId: CONNECTION_A,
    }, {
      accountId: ACCOUNT_A2,
      targetConnectionId: null,
    }], Date.parse("2026-07-31T00:00:00.000Z"));
    await repository.startManifest(SCOPE_A, partial.manifestId, Date.parse("2026-07-31T00:01:00.000Z"));
    await acceptAccount(
      repository, partial.manifestId, ACCOUNT_A,
      "2026-07-31T01:00:00.000Z", "2026-07-31T00:30:00.000Z",
      Date.parse("2026-07-31T01:01:00.000Z"),
    );
    await repository.markAccountUnavailable(
      SCOPE_A, partial.manifestId, ACCOUNT_A2, "unconfigured", "ACCOUNT_CONNECTION_MISSING",
      Date.parse("2026-07-31T01:01:30.000Z"),
    );
    const partialGeneration = await repository.finalizeManifest(
      SCOPE_A, partial.manifestId, Date.parse("2026-07-31T01:02:00.000Z"),
    );
    assert.equal(partialGeneration.status, "partial");
    assert.equal((await repository.getActiveSnapshot(SCOPE_A))?.generationId, firstGeneration.generationId);

    await assert.rejects(
      repository.finalizeManifest(SCOPE_A, (await createManifest(repository, "ta-not-terminal", [{
        accountId: ACCOUNT_A,
        targetConnectionId: CONNECTION_A,
      }], Date.parse("2026-08-01T00:00:00.000Z"))).manifestId, Date.parse("2026-08-01T00:01:00.000Z")),
      expectCode("INVALID_TRANSITION"),
    );
    assert.deepEqual((await repository.listHistory(SCOPE_A, 2)).map((item) => item.status), ["partial", "complete"]);
    await assert.rejects(repository.listHistory(SCOPE_A, 37), expectCode("INVALID_INPUT"));
  });
});

test("active dashboard reads bounded standard-check account, check, resource, and history evidence", async () => {
  await withRepository(async ({ repository }) => {
    const manifest = await createManifest(repository, "ta-dashboard", [{
      accountId: ACCOUNT_A,
      targetConnectionId: CONNECTION_A,
    }], Date.parse("2026-08-01T00:00:00.000Z"));
    await repository.startManifest(
      SCOPE_A,
      manifest.manifestId,
      Date.parse("2026-08-01T00:01:00.000Z"),
    );
    await acceptAccount(
      repository,
      manifest.manifestId,
      ACCOUNT_A,
      "2026-08-01T01:00:00.000Z",
      "2026-08-01T00:30:00.000Z",
      Date.parse("2026-08-01T01:01:00.000Z"),
    );
    const generation = await repository.finalizeManifest(
      SCOPE_A,
      manifest.manifestId,
      Date.parse("2026-08-01T01:02:00.000Z"),
    );
    const latest = await repository.getLatestManifest(SCOPE_A);
    assert.equal(latest?.manifestId, manifest.manifestId);
    const dashboard = await repository.getActiveDashboard(SCOPE_A, {
      accountId: ACCOUNT_A,
      checkId: "check-1",
      status: "warning",
      region: "us-east-1",
    });
    assert.equal(dashboard?.snapshot.generationId, generation.generationId);
    assert.equal(dashboard?.snapshot.status, "complete");
    assert.deepEqual(dashboard?.accounts.map((account) => account.accountId), [ACCOUNT_A]);
    assert.deepEqual(dashboard?.checks.map((check) => ({
      id: check.checkId,
      status: check.status,
      flagged: check.flaggedCount,
      accounts: check.accountCount,
    })), [{ id: "check-1", status: "warning", flagged: 1, accounts: 1 }]);
    assert.deepEqual(dashboard?.resources.map((resource) => ({
      accountId: resource.accountId,
      checkId: resource.checkId,
      region: resource.region,
      status: resource.status,
    })), [{ accountId: ACCOUNT_A, checkId: "check-1", region: "us-east-1", status: "warning" }]);
    assert.equal(dashboard?.resources[0]?.metadataJson, JSON.stringify({ service: "ec2", reason: "idle" }));
    assert.deepEqual(dashboard?.history.map((entry) => entry.generationId), [generation.generationId]);
    assert.equal(await repository.getActiveDashboard(SCOPE_B, {
      accountId: null,
      checkId: null,
      status: null,
      region: null,
    }), null);
    await assert.rejects(repository.getActiveDashboard(SCOPE_A, {
      accountId: "not-an-account",
      checkId: null,
      status: null,
      region: null,
    }), expectCode("INVALID_INPUT"));
  });
});

test("database guards reject evidence mutation, unbacked acceptance, and partial head promotion", async () => {
  await withRepository(async ({ database, repository }) => {
    const manifest = await createManifest(repository, "ta-guards", [{
      accountId: ACCOUNT_A,
      targetConnectionId: CONNECTION_A,
    }], Date.parse("2026-08-01T00:00:00.000Z"));
    await repository.startManifest(SCOPE_A, manifest.manifestId, Date.parse("2026-08-01T00:01:00.000Z"));
    const accountSnapshotId = await acceptAccount(
      repository, manifest.manifestId, ACCOUNT_A,
      "2026-08-01T01:00:00.000Z", "2026-08-01T00:30:00.000Z",
      Date.parse("2026-08-01T01:01:00.000Z"),
    );
    const persistedAccount = (await repository.getManifest(SCOPE_A, manifest.manifestId))
      ?.accounts.find((account) => account.accountId === ACCOUNT_A);
    assert.equal(persistedAccount?.accountSnapshotId, accountSnapshotId);
    const generation = await repository.finalizeManifest(
      SCOPE_A, manifest.manifestId, Date.parse("2026-08-01T01:02:00.000Z"),
    );
    for (const statement of [
      database.prepare("UPDATE finops_ta_account_snapshots SET content_sha256 = ? WHERE account_snapshot_id = ?")
        .bind("0".repeat(64), accountSnapshotId),
      database.prepare("DELETE FROM finops_ta_check_snapshots WHERE account_snapshot_id = ?").bind(accountSnapshotId),
      database.prepare("UPDATE finops_ta_resource_snapshots SET suppressed = 1 WHERE account_snapshot_id = ?").bind(accountSnapshotId),
      database.prepare("DELETE FROM finops_ta_organization_snapshots WHERE generation_id = ?").bind(generation.generationId),
    ]) await assert.rejects(statement.run(), /FINOPS_TA_/u);

    const second = await createManifest(repository, "ta-unbacked", [{
      accountId: ACCOUNT_A,
      targetConnectionId: CONNECTION_A,
    }], Date.parse("2026-08-02T00:00:00.000Z"));
    await repository.startManifest(SCOPE_A, second.manifestId, Date.parse("2026-08-02T00:01:00.000Z"));
    await repository.startAccount(SCOPE_A, second.manifestId, ACCOUNT_A, Date.parse("2026-08-02T00:02:00.000Z"));
    await assert.rejects(database.prepare(
      `UPDATE finops_ta_manifest_accounts SET status = 'accepted', account_snapshot_id = ?, finished_at = ?
       WHERE manifest_id = ? AND account_id = ?`,
    ).bind(`tas_${"9".repeat(64)}`, Date.parse("2026-08-02T00:03:00.000Z"), second.manifestId, ACCOUNT_A).run(),
    /FINOPS_TA_ACCOUNT_SNAPSHOT_NOT_ACCEPTED/u);

    const partialId = `tao_${"8".repeat(64)}`;
    await database.prepare(
      `INSERT INTO finops_ta_organization_snapshots (
         generation_id, manifest_id, org_id, customer_id, anchor_connection_id, status,
         content_sha256, collected_at, data_through_at, expected_account_count,
         accepted_account_count, rejected_account_count, check_count, resource_count, created_at
       ) VALUES (?, ?, ?, ?, ?, 'partial', ?, '2026-08-02T02:00:00.000Z', null, 1, 0, 1, 0, 0, ?)`,
    ).bind(partialId, second.manifestId, ORG_A, CUSTOMER_A, CONNECTION_A, "8".repeat(64),
      Date.parse("2026-08-02T02:01:00.000Z")).run();
    await assert.rejects(database.prepare(
      `UPDATE finops_ta_organization_snapshot_heads SET active_generation_id = ?, advanced_at = ?
       WHERE org_id = ? AND customer_id = ? AND anchor_connection_id = ?`,
    ).bind(partialId, Date.parse("2026-08-02T02:02:00.000Z"), ORG_A, CUSTOMER_A, CONNECTION_A).run(),
    /FINOPS_TA_HEAD_ADVANCE_REJECTED/u);
  });
});
