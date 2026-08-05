import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtime = await import("../db/runtime-migrations.ts");
const { ComputeOptimizerExportPlanRepository } = await import(
  "../db/finops-compute-optimizer-export-plan-repository.ts"
);
const {
  ComputeOptimizerExportPlanSetRepository,
  ComputeOptimizerExportPlanSetRepositoryError,
} = await import("../db/finops-compute-optimizer-export-plan-set-repository.ts");
const { COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG } = await import(
  "../lib/finops-compute-optimizer-export-field-catalog.ts"
);
const { createComputeOptimizerExportPlanSet } = await import(
  "../lib/finops-compute-optimizer-export-plan.ts"
);

const ORG = "org_copes_a";
const CUSTOMER = "customer_copes_a";
const CONNECTION = `conn_${"a".repeat(32)}`;
const ACCOUNT = "111122223333";
const SCOPE = { organizationId: ORG, customerId: CUSTOMER, connectionId: CONNECTION };
const REGIONS = ["us-east-1", "us-west-2"];
const RUNS = [`cor_${"a".repeat(64)}`, `cor_${"b".repeat(64)}`];
const MAX_DATE_MS = 8_640_000_000_000_000;

function exportTarget(region, index) {
  const bucket = `sutra-co-${region}`;
  const jobId = `job-region-${index + 1}`;
  const effectivePrefix = `exports/compute-optimizer/${ACCOUNT}/`;
  const objectKey = `${effectivePrefix}${region}-2026-08-02T000000-${jobId}.csv`;
  return {
    region,
    exportFamily: "EC2_INSTANCE",
    bucket,
    optionalPrefix: "exports",
    effectivePrefix,
    request: {
      operation: "ExportEC2InstanceRecommendations",
      region,
      fileFormat: "Csv",
      includeMemberAccounts: true,
      filters: [],
      fieldsToExport: COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG.EC2_INSTANCE.minimumProjection,
      s3DestinationConfig: { bucket, keyPrefix: "exports" },
    },
    expectedJob: {
      jobId,
      providerResourceType: "Ec2Instance",
      bucket,
      objectKey,
      metadataKey: `${objectKey.slice(0, -4)}-metadata.json`,
    },
  };
}

async function planSet() {
  return createComputeOptimizerExportPlanSet({
    scope: { orgId: ORG, customerId: CUSTOMER, connectionId: CONNECTION },
    requesterAccountId: ACCOUNT,
    partition: "aws",
    regions: REGIONS,
    exportFamilies: ["EC2_INSTANCE"],
    targets: REGIONS.map(exportTarget),
  });
}

function discovery(database, region, runId, index) {
  return database.prepare(
    `INSERT INTO finops_co_discovery_runs (
      run_id,org_id,customer_id,connection_id,job_id,account_id,partition,region,
      status,content_sha256,collected_at,data_through_at,member_count,export_job_count,
      coverage_count,error_code,limitations_json,evidence_reference_ciphertext,
      evidence_reference_key_version,created_at,started_at,finalized_at
    ) VALUES (?,?,?,?,?,?,'aws',?,'partial',?,'2026-08-02T01:00:00.000Z',
      '2026-08-02T00:00:00.000Z',0,0,0,'EXPORT_OBJECT_BINDING_REQUIRED',
      '["EXPORT_OBJECT_BINDING_REQUIRED"]',?,'evidence-v1',10,20,30)`,
  ).bind(
    runId,
    ORG,
    CUSTOMER,
    CONNECTION,
    `discovery-${index}`,
    ACCOUNT,
    region,
    String(index + 1).repeat(64),
    `fsev1.${"A".repeat(40)}`,
  );
}

async function withRepositories(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `copes-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtime.resetRuntimeSchemaCacheForTests();
    await runtime.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare(
        "INSERT INTO organizations(id,slug,name,status) VALUES (?,'copes','COPES','active')",
      ).bind(ORG),
      database.prepare(
        "INSERT INTO customers(id,org_id,slug,name,status) VALUES (?,?,'copes-c','COPES C','active')",
      ).bind(CUSTOMER, ORG),
      database.prepare(
        `INSERT INTO aws_connections (
          id,org_id,customer_id,source_kind,partition,aws_account_id,role_arn,
          external_id_ciphertext,external_id_key_version,permission_pack_version,
          status,enabled_regions_json
        ) VALUES (?,?,?,'aws_trust_role','aws',?,?,'ct','v1',
          'standard-2026-08.4','active','[]')`,
      ).bind(
        CONNECTION,
        ORG,
        CUSTOMER,
        ACCOUNT,
        `arn:aws:iam::${ACCOUNT}:role/sutra/SutraCollectorRole`,
      ),
    ]);
    await database.batch(REGIONS.map((region, index) =>
      discovery(database, region, RUNS[index], index)));
    await run({
      database,
      plans: new ComputeOptimizerExportPlanRepository(database),
      sets: new ComputeOptimizerExportPlanSetRepository(database),
    });
  } finally {
    await miniflare.dispose();
  }
}

async function persistRegionalPlans(repository, value) {
  for (let index = 0; index < value.plans.length; index += 1) {
    const plan = value.plans[index];
    await repository.recordPlan(SCOPE, {
      discoveryRunId: RUNS[index],
      planId: plan.planId,
      contentSha256: plan.contentSha256,
      requesterAccountId: plan.requesterAccountId,
      partition: plan.partition,
      region: plan.regions[0],
      regionCount: 1,
      exportFamilyCount: plan.exportFamilies.length,
      targetCount: plan.targets.length,
      sealedEnvelope: {
        format: "sutra.compute-optimizer-export-plan-envelope.v1",
        ciphertext: `${String.fromCharCode(65 + index).repeat(64)}`,
        keyVersion: "co-plan-v1",
      },
    }, 100 + index);
  }
}

function code(expected) {
  return (error) => {
    assert.ok(error instanceof ComputeOptimizerExportPlanSetRepositoryError);
    assert.equal(error.code, expected);
    return true;
  };
}

test("persists one immutable all-Region set only after every regional plan exists", async () => {
  await withRepositories(async ({ database, plans, sets }) => {
    const value = await planSet();
    await assert.rejects(sets.recordPlanSet(SCOPE, value), code("REGIONAL_PLAN_NOT_FOUND"));
    await persistRegionalPlans(plans, value);
    await assert.rejects(
      sets.recordPlanSet(SCOPE, value, MAX_DATE_MS + 1),
      code("INVALID_INPUT"),
    );
    const [first, concurrentReplay] = await Promise.all([
      sets.recordPlanSet(SCOPE, value, MAX_DATE_MS),
      sets.recordPlanSet(SCOPE, structuredClone(value), MAX_DATE_MS),
    ]);
    assert.deepEqual(concurrentReplay, first);
    const replay = await sets.recordPlanSet(SCOPE, structuredClone(value), 900);
    assert.deepEqual(replay, first);
    assert.deepEqual(first.regions, REGIONS);
    assert.deepEqual(first.planIds, value.planIds);
    assert.equal(first.createdAtIso, new Date(MAX_DATE_MS).toISOString());
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.planIds), true);
    assert.deepEqual(await sets.getPlanSet(SCOPE, value.planSetId), first);
    assert.deepEqual((await sets.listPlanSets(SCOPE)).map(({ planSetId }) => planSetId), [value.planSetId]);

    await assert.rejects(database.prepare(
      "UPDATE finops_co_export_plan_sets SET created_at=501 WHERE plan_set_id=?",
    ).bind(value.planSetId).run(), /FINOPS_CO_EXPORT_PLAN_SET_IMMUTABLE/u);
    await assert.rejects(database.prepare(
      "DELETE FROM finops_co_export_plan_set_members WHERE plan_set_id=?",
    ).bind(value.planSetId).run(), /FINOPS_CO_EXPORT_PLAN_SET_IMMUTABLE/u);
  });
});

test("fails closed on forged sets, tenant scope, member reuse, and stored tampering", async () => {
  await withRepositories(async ({ database, plans, sets }) => {
    const value = await planSet();
    await persistRegionalPlans(plans, value);
    await assert.rejects(sets.recordPlanSet(SCOPE, {
      ...structuredClone(value),
      planIds: [...value.planIds].reverse(),
    }), code("INVALID_INPUT"));
    await assert.rejects(sets.recordPlanSet({ ...SCOPE, organizationId: "other" }, value), code("INVALID_INPUT"));
    await sets.recordPlanSet(SCOPE, value, 500);

    const reusedSetId = `copes_${"c".repeat(64)}`;
    await database.prepare(
      `INSERT INTO finops_co_export_plan_sets (
        plan_set_id,org_id,customer_id,connection_id,content_sha256,
        requester_account_id,partition,regions_json,export_families_json,
        plan_ids_json,region_count,export_family_count,plan_count,binding_sha256,
        finalized,created_at
      ) VALUES (?,?,?,?,?,?,'aws',?,?,?,?,1,1,?,0,501)`,
    ).bind(
      reusedSetId,
      ORG,
      CUSTOMER,
      CONNECTION,
      "c".repeat(64),
      ACCOUNT,
      JSON.stringify([REGIONS[0]]),
      JSON.stringify(["EC2_INSTANCE"]),
      JSON.stringify([value.planIds[0]]),
      1,
      "d".repeat(64),
    ).run();
    await assert.rejects(
      database.prepare(
        `INSERT INTO finops_co_export_plan_set_members
          (plan_set_id,position,region,plan_id) VALUES (?,0,?,?)`,
      ).bind(reusedSetId, REGIONS[0], value.planIds[0]).run(),
      /UNIQUE constraint failed/u,
    );

    await database.prepare("DROP TRIGGER finops_co_export_plan_sets_update_guard").run();
    await database.prepare("DROP TRIGGER finops_co_export_plan_sets_finalize_guard").run();
    await database.prepare(
      "UPDATE finops_co_export_plan_sets SET binding_sha256=? WHERE plan_set_id=?",
    ).bind("f".repeat(64), value.planSetId).run();
    await assert.rejects(sets.getPlanSet(SCOPE, value.planSetId), code("STORED_STATE_INVALID"));
  });
});

test("D1 and PostgreSQL schemas register normalized immutable set membership", async () => {
  await withRepositories(async ({ database }) => {
    const setColumns = await database.prepare(
      "PRAGMA table_info('finops_co_export_plan_sets')",
    ).all();
    const names = (setColumns.results ?? []).map(({ name }) => name);
    assert.equal(names.some((name) => /bucket|prefix|object_key|plan_json/u.test(name)), false);
    const memberSchema = await database.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
    ).bind("finops_co_export_plan_set_members").first();
    assert.match(memberSchema?.sql ?? "", /substr\(`region`,3,5\) = '-gov-'/u);
    assert.match(memberSchema?.sql ?? "", /NOT GLOB '\*\[\^a-z\]\*'/u);
    const migrations = await database.prepare(
      "SELECT migration_id FROM sutra_runtime_migrations WHERE migration_id=?",
    ).bind("0113_finops_compute_optimizer_export_plan_sets").first();
    assert.notEqual(migrations, null);
  });

  const [postgres, pgRegistry, pgMigrator] = await Promise.all([
    readFile(new URL("../postgres/migrations/0108_finops_compute_optimizer_export_plan_sets.sql", import.meta.url), "utf8"),
    readFile(new URL("../db/postgres-runtime-migrations.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/postgres-migrate.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(postgres, /FINOPS_CO_EXPORT_PLAN_SET_MEMBER_REJECTED/u);
  assert.match(postgres, /FINOPS_CO_EXPORT_PLAN_SET_IMMUTABLE/u);
  assert.match(postgres, /UNIQUE \(plan_id\)/u);
  assert.match(postgres, /REVOKE ALL ON finops_co_export_plan_sets FROM PUBLIC/u);
  assert.doesNotMatch(
    postgres.match(/CREATE TABLE finops_co_export_plan_sets \([\s\S]*?\n\);/u)?.[0] ?? "",
    /\b(bucket|prefix|object_key|plan_json)\b/u,
  );
  assert.equal(pgRegistry.match(/0108_finops_compute_optimizer_export_plan_sets/gu)?.length, 2);
  assert.equal(pgMigrator.match(/0108_finops_compute_optimizer_export_plan_sets\.sql/gu)?.length, 1);
});
