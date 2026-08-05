import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const {
  ComputeOptimizerExportPlanRepository,
  ComputeOptimizerExportPlanRepositoryError,
} = await import("../db/finops-compute-optimizer-export-plan-repository.ts");

const ORG_A = "org_cope_a";
const ORG_B = "org_cope_b";
const CUSTOMER_A = "customer_cope_a";
const CUSTOMER_B = "customer_cope_b";
const CONNECTION_A = `conn_${"a".repeat(32)}`;
const CONNECTION_B = `conn_${"b".repeat(32)}`;
const ACCOUNT_A = "111122223333";
const ACCOUNT_B = "999900001111";
const DISCOVERY_A = `cor_${"d".repeat(64)}`;
const DISCOVERY_B = `cor_${"e".repeat(64)}`;
const DISCOVERY_PENDING = `cor_${"f".repeat(64)}`;
const MAX_DATE_MS = 8_640_000_000_000_000;
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

function finalizedDiscovery(database, {
  runId,
  scope,
  accountId,
  jobId,
}) {
  return database.prepare(
    `INSERT INTO finops_co_discovery_runs (
       run_id, org_id, customer_id, connection_id, job_id, account_id,
       partition, region, status, content_sha256, collected_at, data_through_at,
       member_count, export_job_count, coverage_count, error_code,
       limitations_json, evidence_reference_ciphertext,
       evidence_reference_key_version, created_at, started_at, finalized_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'aws', 'us-east-1', 'partial', ?,
       '2026-08-01T03:00:00.000Z', '2026-08-01T02:00:00.000Z', 0, 0, 0,
       'EXPORT_OBJECT_BINDING_REQUIRED', '["EXPORT_OBJECT_BINDING_REQUIRED"]',
       ?, 'co-evidence-v1', 10, 20, 30)`,
  ).bind(
    runId,
    scope.organizationId,
    scope.customerId,
    scope.connectionId,
    jobId,
    accountId,
    "7".repeat(64),
    `fsev1.${"A".repeat(40)}`,
  );
}

function pendingDiscovery(database) {
  return database.prepare(
    `INSERT INTO finops_co_discovery_runs (
       run_id, org_id, customer_id, connection_id, job_id, account_id,
       partition, region, status, member_count, export_job_count,
       coverage_count, created_at
     ) VALUES (?, ?, ?, ?, 'pending-plan', ?, 'aws', 'us-east-1',
       'pending', 0, 0, 0, 10)`,
  ).bind(
    DISCOVERY_PENDING,
    ORG_A,
    CUSTOMER_A,
    CONNECTION_A,
    ACCOUNT_A,
  );
}

async function withRepository(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-cope-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status) VALUES (?, 'cope-a', 'COPE A', 'active')",
      ).bind(ORG_A),
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status) VALUES (?, 'cope-b', 'COPE B', 'active')",
      ).bind(ORG_B),
      database.prepare(
        "INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'cope-ca', 'COPE CA', 'active')",
      ).bind(CUSTOMER_A, ORG_A),
      database.prepare(
        "INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'cope-cb', 'COPE CB', 'active')",
      ).bind(CUSTOMER_B, ORG_B),
      connection(database, CONNECTION_A, ORG_A, CUSTOMER_A, ACCOUNT_A),
      connection(database, CONNECTION_B, ORG_B, CUSTOMER_B, ACCOUNT_B),
    ]);
    await database.batch([
      finalizedDiscovery(database, {
        runId: DISCOVERY_A,
        scope: SCOPE_A,
        accountId: ACCOUNT_A,
        jobId: "finalized-plan-a",
      }),
      finalizedDiscovery(database, {
        runId: DISCOVERY_B,
        scope: SCOPE_B,
        accountId: ACCOUNT_B,
        jobId: "finalized-plan-b",
      }),
      pendingDiscovery(database),
    ]);
    await run({
      database,
      repository: new ComputeOptimizerExportPlanRepository(database),
    });
  } finally {
    await miniflare.dispose();
  }
}

function planInput(hash = "1".repeat(64)) {
  return {
    discoveryRunId: DISCOVERY_A,
    planId: `cope_${hash}`,
    contentSha256: hash,
    requesterAccountId: ACCOUNT_A,
    partition: "aws",
    region: "us-east-1",
    regionCount: 1,
    exportFamilyCount: 3,
    targetCount: 3,
    sealedEnvelope: {
      format: "sutra.compute-optimizer-export-plan-envelope.v1",
      ciphertext: "A".repeat(64),
      keyVersion: "co-plan:v1+prod",
    },
  };
}

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof ComputeOptimizerExportPlanRepositoryError);
    assert.equal(error.code, code);
    return true;
  };
}

test("sealed plans are deterministic, replay-safe, and ordered immutable history", async () => {
  await withRepository(async ({ repository }) => {
    const input = planInput();
    await assert.rejects(
      repository.recordPlan(SCOPE_A, input, MAX_DATE_MS + 1),
      expectCode("INVALID_INPUT"),
    );
    const first = await repository.recordPlan(SCOPE_A, input, 100);
    const replay = await repository.recordPlan(SCOPE_A, input, 200);
    assert.deepEqual(replay, first);
    assert.equal(first.createdAtIso, new Date(100).toISOString());
    assert.match(first.sealedEnvelopeSha256, /^[a-f0-9]{64}$/u);
    assert.match(first.bindingSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(await repository.getPlan(SCOPE_A, input.planId), first);

    const secondInput = planInput("2".repeat(64));
    const second = await repository.recordPlan(SCOPE_A, secondInput, 300);
    assert.deepEqual(
      (await repository.listPlans(SCOPE_A)).map(({ planId }) => planId),
      [second.planId, first.planId],
    );
    assert.deepEqual(
      (await repository.listPlans(SCOPE_A, 1)).map(({ planId }) => planId),
      [second.planId],
    );
  });
});

test("same plan identity rejects any metadata or sealed-envelope conflict", async () => {
  await withRepository(async ({ repository }) => {
    const input = planInput();
    await repository.recordPlan(SCOPE_A, input, 100);
    await assert.rejects(repository.recordPlan(SCOPE_A, {
      ...input,
      sealedEnvelope: {
        ...input.sealedEnvelope,
        ciphertext: "B".repeat(64),
      },
    }, 200), expectCode("IMMUTABLE_CONFLICT"));
    await assert.rejects(repository.recordPlan(SCOPE_A, {
      ...input,
      exportFamilyCount: 2,
      targetCount: 2,
    }, 200), expectCode("IMMUTABLE_CONFLICT"));
  });
});

test("validation rejects forged identities, plaintext, and inconsistent bounds", async () => {
  await withRepository(async ({ repository }) => {
    const input = planInput();
    await assert.rejects(repository.recordPlan(SCOPE_A, {
      ...input,
      planId: `cope_${"9".repeat(64)}`,
    }), expectCode("INVALID_INPUT"));
    await assert.rejects(repository.recordPlan(SCOPE_A, {
      ...input,
      targetCount: 5,
    }), expectCode("INVALID_INPUT"));
    await assert.rejects(repository.recordPlan(SCOPE_A, {
      ...input,
      bucket: "raw-plaintext-bucket-must-not-cross-boundary",
    }), expectCode("INVALID_INPUT"));
    await assert.rejects(repository.recordPlan(SCOPE_A, {
      ...input,
      sealedEnvelope: {
        ...input.sealedEnvelope,
        objectKey: "raw/plaintext-key",
      },
    }), expectCode("INVALID_INPUT"));
    await assert.rejects(repository.recordPlan(SCOPE_A, {
      ...input,
      sealedEnvelope: {
        ...input.sealedEnvelope,
        format: "sutra.compute-optimizer-export-plan-envelope.v2",
      },
    }), expectCode("INVALID_INPUT"));
    await assert.rejects(repository.recordPlan(SCOPE_A, {
      ...input,
      sealedEnvelope: {
        ...input.sealedEnvelope,
        ciphertext: `${"A".repeat(41)}B`,
      },
    }), expectCode("INVALID_INPUT"));
    await assert.rejects(repository.recordPlan(SCOPE_A, {
      ...input,
      sealedEnvelope: {
        format: "sutra.compute-optimizer-export-plan-envelope.v1",
        ciphertext: '{"bucket":"plaintext-secret","key":"raw/key"}',
        keyVersion: "co-plan-v1",
      },
    }), expectCode("INVALID_INPUT"));
    await assert.rejects(repository.listPlans(SCOPE_A, 0), expectCode("INVALID_INPUT"));
  });
});

test("live AWS and finalized discovery scope fail closed across tenants", async () => {
  await withRepository(async ({ repository }) => {
    const input = planInput();
    await assert.rejects(repository.recordPlan(SCOPE_A, {
      ...input,
      requesterAccountId: ACCOUNT_B,
    }), expectCode("SCOPE_NOT_FOUND"));
    await assert.rejects(repository.recordPlan(SCOPE_A, {
      ...input,
      discoveryRunId: DISCOVERY_PENDING,
    }), expectCode("DISCOVERY_RUN_NOT_FOUND"));
    await assert.rejects(repository.recordPlan(SCOPE_A, {
      ...input,
      discoveryRunId: DISCOVERY_B,
    }), expectCode("DISCOVERY_RUN_NOT_FOUND"));
    await assert.rejects(repository.recordPlan(SCOPE_A, {
      ...input,
      region: "us-west-2",
    }), expectCode("DISCOVERY_RUN_NOT_FOUND"));
    await assert.rejects(repository.recordPlan({
      ...SCOPE_A,
      connectionId: CONNECTION_B,
    }, input), expectCode("SCOPE_NOT_FOUND"));

    await repository.recordPlan(SCOPE_A, input, 100);
    assert.equal(await repository.getPlan(SCOPE_B, input.planId), null);
    assert.deepEqual(await repository.listPlans(SCOPE_B), []);
  });
});

test("database triggers enforce scope and immutable records against raw SQL", async () => {
  await withRepository(async ({ database, repository }) => {
    const stored = await repository.recordPlan(SCOPE_A, planInput(), 100);
    await assert.rejects(database.prepare(
      "UPDATE finops_co_export_plans SET created_at = 101 WHERE plan_id = ?",
    ).bind(stored.planId).run(), /FINOPS_CO_EXPORT_PLAN_IMMUTABLE/u);
    await assert.rejects(database.prepare(
      "DELETE FROM finops_co_export_plans WHERE plan_id = ?",
    ).bind(stored.planId).run(), /FINOPS_CO_EXPORT_PLAN_IMMUTABLE/u);
    await assert.rejects(database.prepare(
       `INSERT INTO finops_co_export_plans
       SELECT ?, org_id, customer_id, ?, discovery_run_id, ?, ?, partition,
         region, region_count, export_family_count, target_count,
         sealed_envelope_format,
         sealed_envelope_ciphertext, sealed_envelope_key_version,
         sealed_envelope_sha256, binding_sha256, created_at
       FROM finops_co_export_plans WHERE plan_id = ?`,
    ).bind(
      `cope_${"8".repeat(64)}`,
      CONNECTION_B,
      "8".repeat(64),
      ACCOUNT_B,
      stored.planId,
    ).run(), /FINOPS_CO_EXPORT_PLAN_SCOPE_REJECTED/u);
    await assert.rejects(database.prepare(
      `INSERT INTO finops_co_export_plans
       SELECT ?, org_id, customer_id, connection_id, discovery_run_id, ?,
         requester_account_id, partition, region, region_count, export_family_count,
         target_count, sealed_envelope_format, sealed_envelope_ciphertext,
         sealed_envelope_key_version,
         sealed_envelope_sha256, binding_sha256, created_at
       FROM finops_co_export_plans WHERE plan_id = ?`,
    ).bind(
      `cope_${"6".repeat(64)}`,
      "5".repeat(64),
      stored.planId,
    ).run(), /CHECK constraint failed/u);
  });
});

test("D1 and PostgreSQL schemas retain only sealed material and parity guards", async () => {
  await withRepository(async ({ database }) => {
    const columns = await database.prepare(
      "PRAGMA table_info('finops_co_export_plans')",
    ).all();
    const names = (columns.results ?? []).map(({ name }) => name);
    assert.deepEqual(names, [
      "plan_id",
      "org_id",
      "customer_id",
      "connection_id",
      "discovery_run_id",
      "content_sha256",
      "requester_account_id",
      "partition",
      "region",
      "region_count",
      "export_family_count",
      "target_count",
      "sealed_envelope_format",
      "sealed_envelope_ciphertext",
      "sealed_envelope_key_version",
      "sealed_envelope_sha256",
      "binding_sha256",
      "created_at",
    ]);
    assert.equal(names.some((name) => /bucket|prefix|object_key|plan_json/u.test(name)), false);
    const guard = await database.prepare(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",
    ).bind("finops_co_export_plans_created_at_guard").first();
    assert.match(guard?.sql ?? "", /8640000000000000/u);
    const applied = await database.prepare(
      "SELECT migration_id FROM sutra_runtime_migrations WHERE migration_id=?",
    ).bind("0114_finops_compute_optimizer_export_plan_timestamp_guard").first();
    assert.notEqual(applied, null);
  });

  const [postgres, forward, registry, migrator] = await Promise.all([
    readFile(new URL(
      "../postgres/migrations/0107_finops_compute_optimizer_export_plans.sql",
      import.meta.url,
    ), "utf8"),
    readFile(new URL(
      "../postgres/migrations/0109_finops_compute_optimizer_export_plan_timestamp_guard.sql",
      import.meta.url,
    ), "utf8"),
    readFile(new URL("../db/postgres-runtime-migrations.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/postgres-migrate.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(postgres, /CHECK \(plan_id = 'cope_' \|\| content_sha256\)/u);
  assert.match(postgres, /FINOPS_CO_EXPORT_PLAN_SCOPE_REJECTED/u);
  assert.match(postgres, /FINOPS_CO_EXPORT_PLAN_IMMUTABLE/u);
  assert.match(postgres, /REVOKE ALL ON finops_co_export_plans FROM PUBLIC/u);
  assert.doesNotMatch(
    postgres.match(/CREATE TABLE finops_co_export_plans \([\s\S]*?\n\);/u)?.[0] ?? "",
    /\b(bucket|prefix|object_key|plan_json)\b/u,
  );
  assert.match(forward, /created_at BETWEEN 0 AND 8640000000000000/u);
  assert.equal(registry.match(/0109_finops_compute_optimizer_export_plan_timestamp_guard/gu)?.length, 2);
  assert.equal(migrator.match(/0109_finops_compute_optimizer_export_plan_timestamp_guard\.sql/gu)?.length, 1);
});
