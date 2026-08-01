import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const {
  ComputeOptimizerDiscoveryRepository,
  ComputeOptimizerDiscoveryRepositoryError,
  computeOptimizerDiscoverySha256,
} = await import("../db/finops-compute-optimizer-discovery-repository.ts");

const ORG_A = "org_co_a";
const ORG_B = "org_co_b";
const CUSTOMER_A = "customer_co_a";
const CUSTOMER_B = "customer_co_b";
const CONNECTION_A = `conn_${"a".repeat(32)}`;
const CONNECTION_B = `conn_${"b".repeat(32)}`;
const ACCOUNT_A = "111122223333";
const ACCOUNT_B = "999900001111";
const SCOPE_A = { organizationId: ORG_A, customerId: CUSTOMER_A, connectionId: CONNECTION_A };
const SCOPE_B = { organizationId: ORG_B, customerId: CUSTOMER_B, connectionId: CONNECTION_B };

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
    d1Databases: { DB: `sutra-co-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'co-a', 'CO A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'co-b', 'CO B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'co-ca', 'CO CA', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'co-cb', 'CO CB', 'active')").bind(CUSTOMER_B, ORG_B),
      connection(database, CONNECTION_A, ORG_A, CUSTOMER_A, ACCOUNT_A),
      connection(database, CONNECTION_B, ORG_B, CUSTOMER_B, ACCOUNT_B),
    ]);
    await run({ database, repository: new ComputeOptimizerDiscoveryRepository(database) });
  } finally {
    await miniflare.dispose();
  }
}

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof ComputeOptimizerDiscoveryRepositoryError);
    assert.equal(error.code, code);
    return true;
  };
}

function partialEvidence() {
  return {
    accountId: ACCOUNT_A,
    partition: "aws",
    region: "us-east-1",
    status: "partial",
    collectedAt: "2026-08-01T03:00:00.000Z",
    dataThroughAt: "2026-08-01T02:00:00.000Z",
    enrollment: {
      status: "ACTIVE",
      reasonCode: null,
      memberAccountsEnrolled: true,
      numberOfMemberAccountsOptedIn: 1,
      lastUpdatedAt: "2026-08-01T01:00:00.000Z",
    },
    memberEnrollments: [{
      accountId: ACCOUNT_A,
      status: "ACTIVE",
      reasonCode: null,
      lastUpdatedAt: "2026-08-01T01:00:00.000Z",
    }],
    exportJobs: [{
      jobId: "export-job-1",
      resourceType: "Ec2Instance",
      status: "COMPLETE",
      createdAt: "2026-08-01T00:00:00.000Z",
      lastUpdatedAt: "2026-08-01T00:30:00.000Z",
      failureCode: null,
      destination: {
        bucketSha256: "a".repeat(64),
        objectKeySha256: "b".repeat(64),
        metadataKeySha256: "c".repeat(64),
      },
    }],
    coverage: [{
      operation: "GET_ENROLLMENT_STATUS",
      status: "SUCCEEDED",
      pagesObserved: 1,
      recordsObserved: 1,
      recordsAccepted: 1,
      recordsRejected: 0,
      recordsOmitted: 0,
      errorCode: null,
    }, {
      operation: "GET_ENROLLMENT_STATUSES_FOR_ORGANIZATION",
      status: "SUCCEEDED",
      pagesObserved: 1,
      recordsObserved: 1,
      recordsAccepted: 1,
      recordsRejected: 0,
      recordsOmitted: 0,
      errorCode: null,
    }, {
      operation: "DESCRIBE_RECOMMENDATION_EXPORT_JOBS",
      status: "SUCCEEDED",
      pagesObserved: 1,
      recordsObserved: 1,
      recordsAccepted: 1,
      recordsRejected: 0,
      recordsOmitted: 0,
      errorCode: null,
    }],
    errorCode: "EXPORT_OBJECT_BINDING_REQUIRED",
    limitations: [
      "READ_ONLY_EXPORT_DISCOVERY_ONLY",
      "EXPORT_PROVISIONING_LEDGER_REQUIRED",
      "EXPORT_OBJECTS_NOT_READ_WITHOUT_ATTESTED_BUCKET_PREFIX",
      "DIRECT_RECOMMENDATION_APIS_NOT_COLLECTED",
    ],
    evidenceReference: { ciphertext: `fsev1.${"A".repeat(40)}`, keyVersion: "co-evidence-v1" },
  };
}

test("run creation is tenant-bound, deterministic, replay-safe, and immutable", async () => {
  await withRepository(async ({ repository }) => {
    const input = { jobId: "compute-optimizer-1", accountId: ACCOUNT_A, partition: "aws", region: "us-east-1" };
    const first = await repository.createRun(SCOPE_A, input, 10);
    const replay = await repository.createRun(SCOPE_A, input, 20);
    assert.equal(replay.runId, first.runId);
    assert.equal(replay.createdAtIso, new Date(10).toISOString());
    await assert.rejects(repository.createRun(SCOPE_A, { ...input, region: "us-west-2" }, 30), expectCode("IMMUTABLE_CONFLICT"));
    await assert.rejects(repository.createRun(SCOPE_A, { ...input, jobId: "foreign-account", accountId: ACCOUNT_B }, 31), expectCode("SCOPE_NOT_FOUND"));
    assert.equal(await repository.getRun(SCOPE_B, first.runId), null);
    await assert.rejects(repository.createRun(
      { ...SCOPE_A, connectionId: CONNECTION_B }, input, 40,
    ), expectCode("SCOPE_NOT_FOUND"));
  });
});

test("partial discovery persists normalized evidence as history and never advances a complete head", async () => {
  await withRepository(async ({ database, repository }) => {
    const run = await repository.createRun(SCOPE_A, {
      jobId: "compute-optimizer-partial", accountId: ACCOUNT_A, partition: "aws", region: "us-east-1",
    }, 100);
    await repository.startRun(SCOPE_A, run.runId, 110);
    const evidence = partialEvidence();
    const contentSha256 = await computeOptimizerDiscoverySha256(SCOPE_A, evidence);
    const stored = await repository.recordDiscovery(SCOPE_A, run.runId, { ...evidence, contentSha256 }, 120);
    assert.equal(stored.status, "partial");
    assert.equal(stored.errorCode, "EXPORT_OBJECT_BINDING_REQUIRED");
    assert.deepEqual([stored.memberCount, stored.exportJobCount, stored.coverageCount], [1, 1, 3]);
    assert.equal(await repository.getActiveComplete(SCOPE_A), null);
    assert.deepEqual((await repository.listHistory(SCOPE_A)).map(({ runId }) => runId), [run.runId]);

    const replay = await repository.recordDiscovery(SCOPE_A, run.runId, { ...evidence, contentSha256 }, 130);
    assert.equal(replay.finalizedAtIso, new Date(120).toISOString());
    await assert.rejects(repository.recordDiscovery(SCOPE_A, run.runId, {
      ...evidence, errorCode: "ENROLLMENT_REQUIRED", contentSha256,
    }, 140), expectCode("CHECKSUM_MISMATCH"));

    const counts = await database.prepare(
      `SELECT
       (SELECT count(*) FROM finops_co_member_enrollments WHERE run_id = ?) AS members,
       (SELECT count(*) FROM finops_co_export_jobs WHERE run_id = ?) AS jobs,
       (SELECT count(*) FROM finops_co_discovery_coverage WHERE run_id = ?) AS coverage`,
    ).bind(run.runId, run.runId, run.runId).first();
    assert.deepEqual([Number(counts.members), Number(counts.jobs), Number(counts.coverage)], [1, 1, 3]);
  });
});

test("unavailable evidence remains honest history and malformed or recommendation-complete claims fail closed", async () => {
  await withRepository(async ({ repository }) => {
    const run = await repository.createRun(SCOPE_A, {
      jobId: "compute-optimizer-unavailable", accountId: ACCOUNT_A, partition: "aws", region: "us-east-1",
    }, 200);
    await repository.startRun(SCOPE_A, run.runId, 210);
    const evidence = {
      ...partialEvidence(),
      status: "unavailable",
      dataThroughAt: null,
      enrollment: null,
      memberEnrollments: [],
      exportJobs: [],
      coverage: [{
        operation: "GET_ENROLLMENT_STATUS",
        status: "FAILED",
        pagesObserved: 0,
        recordsObserved: 0,
        recordsAccepted: 0,
        recordsRejected: 0,
        recordsOmitted: 0,
        errorCode: "PROVIDER_UNAVAILABLE",
      }],
      errorCode: "PROVIDER_UNAVAILABLE",
      limitations: ["PROVIDER_UNAVAILABLE", "NO_PROVIDER_DATA_RETURNED"],
    };
    const contentSha256 = await computeOptimizerDiscoverySha256(SCOPE_A, evidence);
    assert.equal((await repository.recordDiscovery(SCOPE_A, run.runId, { ...evidence, contentSha256 }, 220)).status, "unavailable");
    await assert.rejects(computeOptimizerDiscoverySha256(SCOPE_A, {
      ...partialEvidence(), status: "complete", errorCode: null, limitations: [],
    }), expectCode("INVALID_INPUT"));
    await assert.rejects(computeOptimizerDiscoverySha256(SCOPE_A, {
      ...partialEvidence(), exportJobs: [{ ...partialEvidence().exportJobs[0], destination: { ...partialEvidence().exportJobs[0].destination, bucketSha256: "raw-bucket-name" } }],
    }), expectCode("INVALID_INPUT"));
  });
});

test("database guards reject child mutation, post-finalization inserts, and partial head promotion", async () => {
  await withRepository(async ({ database, repository }) => {
    const run = await repository.createRun(SCOPE_A, {
      jobId: "compute-optimizer-guards", accountId: ACCOUNT_A, partition: "aws", region: "us-east-1",
    }, 300);
    await repository.startRun(SCOPE_A, run.runId, 310);
    const evidence = partialEvidence();
    const contentSha256 = await computeOptimizerDiscoverySha256(SCOPE_A, evidence);
    await repository.recordDiscovery(SCOPE_A, run.runId, { ...evidence, contentSha256 }, 320);
    await assert.rejects(database.prepare(
      "UPDATE finops_co_member_enrollments SET status = 'FAILED' WHERE run_id = ?",
    ).bind(run.runId).run(), /FINOPS_CO_IMMUTABLE/u);
    await assert.rejects(database.prepare(
      "DELETE FROM finops_co_export_jobs WHERE run_id = ?",
    ).bind(run.runId).run(), /FINOPS_CO_IMMUTABLE/u);
    await assert.rejects(database.prepare(
      `INSERT INTO finops_co_discovery_coverage
       (run_id, operation, status, pages_observed, records_observed, records_accepted, records_rejected, records_omitted)
       VALUES (?, 'GET_ENROLLMENT_STATUS', 'FAILED', 0, 0, 0, 0, 0)`,
    ).bind(run.runId).run(), /FINOPS_CO_RUN_NOT_RUNNING/u);
    await assert.rejects(database.prepare(
      `INSERT INTO finops_co_discovery_heads (org_id, customer_id, connection_id, active_run_id, advanced_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(ORG_A, CUSTOMER_A, CONNECTION_A, run.runId, 330).run(), /FINOPS_CO_HEAD_ADVANCE_REJECTED/u);

    const second = await repository.createRun(SCOPE_A, {
      jobId: "compute-optimizer-false-complete", accountId: ACCOUNT_A, partition: "aws", region: "us-east-1",
    }, 340);
    await repository.startRun(SCOPE_A, second.runId, 350);
    await assert.rejects(database.prepare(
      `UPDATE finops_co_discovery_runs SET status = 'complete', content_sha256 = ?, collected_at = ?, data_through_at = ?,
       limitations_json = '[]', evidence_reference_ciphertext = ?, evidence_reference_key_version = 'v1', finalized_at = ?
       WHERE run_id = ?`,
    ).bind("d".repeat(64), "2026-08-01T05:00:00.000Z", "2026-08-01T04:00:00.000Z",
      `fsev1.${"B".repeat(40)}`, 360, second.runId).run(), /FINOPS_CO_EXPORT_OBJECT_BINDING_REQUIRED/u);
  });
});
