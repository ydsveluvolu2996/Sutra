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

const ORG_A = "org_co_export_evidence_a";
const ORG_B = "org_co_export_evidence_b";
const CUSTOMER_A = "customer_co_export_evidence_a";
const CUSTOMER_B = "customer_co_export_evidence_b";
const CONNECTION_A = `conn_${"a".repeat(32)}`;
const CONNECTION_B = `conn_${"b".repeat(32)}`;
const ACCOUNT_A = "111122223333";
const ACCOUNT_B = "999900001111";
const SCOPE_A = {
  organizationId: ORG_A,
  customerId: CUSTOMER_A,
  connectionId: CONNECTION_A,
};
const SCOPE_B = {
  organizationId: ORG_B,
  customerId: CUSTOMER_B,
  connectionId: CONNECTION_B,
};

function connection(database, id, orgId, customerId, accountId) {
  return database.prepare(
    `INSERT INTO aws_connections (
       id, org_id, customer_id, source_kind, partition, aws_account_id, role_arn,
       external_id_ciphertext, external_id_key_version, permission_pack_version,
       status, enabled_regions_json
     ) VALUES (?, ?, ?, 'aws_trust_role', 'aws', ?, ?,
       'ct', 'v1', 'standard-2026-08.1', 'active', '[]')`,
  ).bind(
    id,
    orgId,
    customerId,
    accountId,
    `arn:aws:iam::${accountId}:role/sutra/SutraCollectorRole`,
  );
}

async function withRepository(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-co-export-evidence-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status) VALUES (?, 'coe-a', 'COE A', 'active')",
      ).bind(ORG_A),
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status) VALUES (?, 'coe-b', 'COE B', 'active')",
      ).bind(ORG_B),
      database.prepare(
        "INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'coe-ca', 'COE CA', 'active')",
      ).bind(CUSTOMER_A, ORG_A),
      database.prepare(
        "INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'coe-cb', 'COE CB', 'active')",
      ).bind(CUSTOMER_B, ORG_B),
      connection(database, CONNECTION_A, ORG_A, CUSTOMER_A, ACCOUNT_A),
      connection(database, CONNECTION_B, ORG_B, CUSTOMER_B, ACCOUNT_B),
    ]);
    await run({
      database,
      repository: new ComputeOptimizerDiscoveryRepository(database),
    });
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

function evidence() {
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
      jobId: "job-z",
      resourceType: "RdsDBInstance",
      status: "COMPLETE",
      createdAt: "2026-08-01T00:00:00.000Z",
      lastUpdatedAt: "2026-08-01T00:40:00.000Z",
      failureCode: null,
      destination: {
        bucketSha256: "1".repeat(64),
        objectKeySha256: "2".repeat(64),
        metadataKeySha256: "3".repeat(64),
      },
    }, {
      jobId: "job-a",
      resourceType: "Ec2Instance",
      status: "COMPLETE",
      createdAt: "2026-08-01T00:10:00.000Z",
      lastUpdatedAt: "2026-08-01T00:30:00.000Z",
      failureCode: null,
      destination: {
        bucketSha256: "4".repeat(64),
        objectKeySha256: "5".repeat(64),
        metadataKeySha256: "6".repeat(64),
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
      operation: "DESCRIBE_RECOMMENDATION_EXPORT_JOBS",
      status: "SUCCEEDED",
      pagesObserved: 1,
      recordsObserved: 2,
      recordsAccepted: 2,
      recordsRejected: 0,
      recordsOmitted: 0,
      errorCode: null,
    }],
    errorCode: "EXPORT_OBJECT_BINDING_REQUIRED",
    limitations: [
      "READ_ONLY_EXPORT_DISCOVERY_ONLY",
      "EXPORT_OBJECT_BINDING_REQUIRED",
    ],
    evidenceReference: {
      ciphertext: `fsev1.${"A".repeat(40)}`,
      keyVersion: "co-evidence-v1",
    },
  };
}

async function finalized(repository, jobId = "finalized-export-evidence") {
  const run = await repository.createRun(SCOPE_A, {
    jobId,
    accountId: ACCOUNT_A,
    partition: "aws",
    region: "us-east-1",
  }, 10);
  await repository.startRun(SCOPE_A, run.runId, 20);
  const value = evidence();
  const contentSha256 = await computeOptimizerDiscoverySha256(SCOPE_A, value);
  await repository.recordDiscovery(
    SCOPE_A,
    run.runId,
    { ...value, contentSha256 },
    30,
  );
  return run.runId;
}

test("finalized evidence is scope-bound, hash-verified, and normalized by job id", async () => {
  await withRepository(async ({ repository }) => {
    const runId = await finalized(repository);
    const result = await repository.getFinalizedExportEvidence(SCOPE_A, runId);
    assert.ok(result !== null);
    assert.equal(result.run.runId, runId);
    assert.equal(result.run.exportJobCount, 2);
    assert.deepEqual(
      result.exportJobs.map(({ jobId }) => jobId),
      ["job-a", "job-z"],
    );
    assert.deepEqual(result.exportJobs[0].destination, {
      bucketSha256: "4".repeat(64),
      objectKeySha256: "5".repeat(64),
      metadataKeySha256: "6".repeat(64),
    });
    assert.deepEqual(Object.keys(result.exportJobs[0].destination), [
      "bucketSha256",
      "objectKeySha256",
      "metadataKeySha256",
    ]);
    assert.doesNotMatch(
      JSON.stringify(result),
      /raw-bucket-secret|organization\/raw-object-key/u,
    );
    const reorderedScope = {
      connectionId: CONNECTION_A,
      organizationId: ORG_A,
      customerId: CUSTOMER_A,
    };
    assert.equal(
      (await repository.getFinalizedExportEvidence(reorderedScope, runId))?.run.runId,
      runId,
    );
    assert.equal(await repository.getFinalizedExportEvidence(SCOPE_B, runId), null);
  });
});

test("pending, running, and inactive scopes fail closed", async () => {
  await withRepository(async ({ database, repository }) => {
    const run = await repository.createRun(SCOPE_A, {
      jobId: "not-finalized-export-evidence",
      accountId: ACCOUNT_A,
      partition: "aws",
      region: "us-east-1",
    }, 10);
    await assert.rejects(
      repository.getFinalizedExportEvidence(SCOPE_A, run.runId),
      expectCode("STORED_STATE_INVALID"),
    );
    await repository.startRun(SCOPE_A, run.runId, 20);
    await assert.rejects(
      repository.getFinalizedExportEvidence(SCOPE_A, run.runId),
      expectCode("STORED_STATE_INVALID"),
    );
    await database.prepare(
      "UPDATE aws_connections SET status = 'disabled' WHERE id = ?",
    ).bind(CONNECTION_A).run();
    await assert.rejects(
      repository.getFinalizedExportEvidence(SCOPE_A, run.runId),
      expectCode("SCOPE_NOT_FOUND"),
    );
  });
});

test("tampered parent counts and content hashes are rejected", async () => {
  await withRepository(async ({ database, repository }) => {
    const runId = await finalized(repository, "tampered-export-parent");
    await database.prepare("DROP TRIGGER finops_co_run_update_guard").run();
    await database.prepare(
      "UPDATE finops_co_discovery_runs SET export_job_count = 1 WHERE run_id = ?",
    ).bind(runId).run();
    await assert.rejects(
      repository.getFinalizedExportEvidence(SCOPE_A, runId),
      expectCode("STORED_STATE_INVALID"),
    );
    await database.prepare(
      "UPDATE finops_co_discovery_runs SET export_job_count = 2, content_sha256 = ? WHERE run_id = ?",
    ).bind("f".repeat(64), runId).run();
    await assert.rejects(
      repository.getFinalizedExportEvidence(SCOPE_A, runId),
      expectCode("STORED_STATE_INVALID"),
    );
  });
});

test("malformed resource types and incomplete COMPLETE destinations are rejected", async () => {
  await withRepository(async ({ database, repository }) => {
    const runId = await finalized(repository, "tampered-export-child");
    await database.prepare("DROP TRIGGER finops_co_export_update_guard").run();
    await database.prepare(
      "UPDATE finops_co_export_jobs SET resource_type = 's3://raw-bucket' WHERE run_id = ? AND job_id = 'job-a'",
    ).bind(runId).run();
    await assert.rejects(
      repository.getFinalizedExportEvidence(SCOPE_A, runId),
      expectCode("STORED_STATE_INVALID"),
    );
    await database.prepare(
      `UPDATE finops_co_export_jobs
       SET resource_type = 'Ec2Instance', metadata_key_sha256 = NULL
       WHERE run_id = ? AND job_id = 'job-a'`,
    ).bind(runId).run();
    await assert.rejects(
      repository.getFinalizedExportEvidence(SCOPE_A, runId),
      expectCode("STORED_STATE_INVALID"),
    );
    await database.prepare(
      `UPDATE finops_co_export_jobs SET metadata_key_sha256 = ?, bucket_sha256 = ?
       WHERE run_id = ? AND job_id = 'job-a'`,
    ).bind("6".repeat(64), "9".repeat(64), runId).run();
    await assert.rejects(
      repository.getFinalizedExportEvidence(SCOPE_A, runId),
      expectCode("STORED_STATE_INVALID"),
    );
  });
});
