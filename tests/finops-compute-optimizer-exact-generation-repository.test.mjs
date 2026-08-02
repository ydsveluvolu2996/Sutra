import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtime = await import("../db/runtime-migrations.ts");
const {
  COMPUTE_OPTIMIZER_EXACT_PERSISTENCE_BOUNDS,
  ComputeOptimizerExactGenerationRepository,
  ComputeOptimizerExactGenerationRepositoryError,
} = await import("../db/finops-compute-optimizer-exact-generation-repository.ts");
const { ComputeOptimizerExportPlanRepository } =
  await import("../db/finops-compute-optimizer-export-plan-repository.ts");
const { ComputeOptimizerExportPlanSetRepository } =
  await import("../db/finops-compute-optimizer-export-plan-set-repository.ts");
const {
  createComputeOptimizerExportGenerationAttempt,
  finalizeComputeOptimizerExportGeneration,
} = await import("../lib/finops-compute-optimizer-export-generation.ts");
const { createComputeOptimizerExportPlanSet } =
  await import("../lib/finops-compute-optimizer-export-plan.ts");
const { COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG } =
  await import("../lib/finops-compute-optimizer-export-field-catalog.ts");

const ORG = "org_co_exact";
const CUSTOMER = "customer_co_exact";
const CONNECTION = `conn_${"a".repeat(32)}`;
const ACCOUNT = "111122223333";
const SCOPE = { organizationId: ORG, customerId: CUSTOMER, connectionId: CONNECTION };
const PLAN_SCOPE = { orgId: ORG, customerId: CUSTOMER, connectionId: CONNECTION };
const REGION = "us-east-1";
const FAMILIES = ["EC2_INSTANCE", "IDLE_RESOURCE"];
const MATERIALIZED_AT = "2026-08-02T12:00:00.000Z";
const OPTIONS = {
  scheduledWindow: "2026-08-02T00:00:00.000Z",
  materializedAtMs: Date.parse(MATERIALIZED_AT),
};

const OPERATION = {
  EC2_INSTANCE: "ExportEC2InstanceRecommendations",
  IDLE_RESOURCE: "ExportIdleRecommendations",
};
const PROVIDER = { EC2_INSTANCE: "Ec2Instance", IDLE_RESOURCE: "Idle" };

function hex(value) {
  let accumulator = 0;
  for (const character of value) accumulator = (accumulator * 33 + character.charCodeAt(0)) % 16;
  return accumulator.toString(16).repeat(64);
}

function planTarget(family, variant = "") {
  const bucket = "sutra-exact-us-east-1";
  const effectivePrefix = `compute-optimizer/${ACCOUNT}/`;
  const jobId = `job-${family.toLowerCase().replaceAll("_", "-")}${variant}`;
  const objectKey = `${effectivePrefix}${REGION}-2026-08-02T000000Z-${jobId}.csv`;
  return {
    region: REGION,
    exportFamily: family,
    bucket,
    optionalPrefix: null,
    effectivePrefix,
    request: {
      operation: OPERATION[family],
      region: REGION,
      fileFormat: "Csv",
      includeMemberAccounts: true,
      filters: [],
      fieldsToExport: COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG[family].minimumProjection,
      s3DestinationConfig: { bucket, keyPrefix: null },
    },
    expectedJob: {
      jobId,
      providerResourceType: PROVIDER[family],
      bucket,
      objectKey,
      metadataKey: objectKey.replace(/\.csv$/u, "-metadata.json"),
    },
  };
}

function mappedTarget(target, amountMicros = "9223372036854775807") {
  const csvSha = hex(`${target.exportFamily}:csv`);
  const metadataSha = hex(`${target.exportFamily}:metadata`);
  const recommendation = {
    rowNumber: 1,
    accountId: ACCOUNT,
    resourceArn: `arn:aws:ec2:${REGION}:${ACCOUNT}:instance/${target.exportFamily.toLowerCase()}`,
    resourceId: target.exportFamily.toLowerCase(),
    resourceIdSource: "ARN",
    region: REGION,
    exportFamily: target.exportFamily,
    findings: [],
    lastRefreshTimestamp: "2026-08-02 00:00:00",
    lookbackPeriodLexeme: "14",
    currentConfiguration: [],
    recommendedConfiguration: [],
    currentRisk: [],
    rankedOptions: [],
    savings: target.exportFamily === "IDLE_RESOURCE" ? [{
      scope: "RESOURCE",
      includesExistingDiscounts: false,
      normalizationState: "UNRESOLVED_PROVIDER_CSV_LABEL",
      apiField: "SavingsOpportunity",
      raw: "{\"estimatedMonthlySavings\":\"12.34\"}",
      evidence: {
        apiField: "SavingsOpportunity",
        column: "SavingsOpportunity",
        datatype: "string",
        raw: "{\"estimatedMonthlySavings\":\"12.34\"}",
        assurance: "API_FIELD_NAME_ONLY",
      },
    }] : [{
      scope: "RESOURCE",
      includesExistingDiscounts: false,
      normalizationState: "EXACT_DOCUMENTED_CSV_LABEL",
      currency: "USD",
      amountMicros,
      percentageBasisPoints: 1_234,
      evidence: [],
    }],
    tags: [],
    rds: null,
  };
  return {
    schemaVersion: "sutra.compute-optimizer-export-mapped-target.v1",
    source: {
      region: REGION,
      exportFamily: target.exportFamily,
      providerResourceType: target.expectedJob.providerResourceType,
      requestSha256: target.requestSha256,
      jobId: target.expectedJob.jobId,
      bucket: target.expectedJob.bucket,
      csvObject: {
        key: target.expectedJob.objectKey,
        eTag: `etag-${target.expectedJob.jobId}`,
        versionId: `version-${target.expectedJob.jobId}`,
        bytes: 100,
        sha256: csvSha,
      },
      metadataObject: {
        key: target.expectedJob.metadataKey,
        eTag: `etag-metadata-${target.expectedJob.jobId}`,
        versionId: null,
        bytes: 20,
        sha256: metadataSha,
      },
      csvBasename: target.expectedJob.objectKey.slice(target.expectedJob.objectKey.lastIndexOf("/") + 1),
      csvSha256: csvSha,
      metadataSha256: metadataSha,
      modifiedDate: "2026-08-02",
    },
    schemaAssurance: target.exportFamily === "IDLE_RESOURCE"
      ? "API_FIELD_NAME_ONLY_UNVERIFIED"
      : "OFFICIAL_USER_GUIDE_CSV_LABELS",
    rowCount: 1,
    recommendationCount: 1,
    rejectedRowCount: 0,
    recommendations: [recommendation],
    rejectedRows: [],
  };
}

function bindings(planSet, resolvedAt = "2026-08-02T11:58:00.000Z") {
  const plan = planSet.plans[0];
  return [{
    schemaVersion: "sutra.compute-optimizer-export-fresh-binding.v1",
    discoveryRunId: `cor_${hex(`run:${resolvedAt}`)}`,
    resolvedAtIso: resolvedAt,
    expiresAtIso: "2026-08-02T12:03:00.000Z",
    binding: {
      planId: plan.planId,
      contentSha256: plan.contentSha256,
      targets: plan.targets.map((target) => ({
        region: target.region,
        exportFamily: target.exportFamily,
        providerResourceType: target.expectedJob.providerResourceType,
        requestSha256: target.requestSha256,
        jobId: target.expectedJob.jobId,
        bucket: target.expectedJob.bucket,
        objectKey: target.expectedJob.objectKey,
        metadataKey: target.expectedJob.metadataKey,
      })),
    },
    jobChronology: plan.targets.map((target, index) => ({
      jobId: target.expectedJob.jobId,
      creationTimestampIso: `2026-08-01T00:0${index}:00.000Z`,
      lastUpdatedTimestampIso: `2026-08-02T10:${index === 0 ? "30" : "45"}:00.000Z`,
    })),
  }];
}

async function generationFixture(
  amountMicros = "9223372036854775807",
  resolvedAt,
  variant = "",
) {
  const planSet = await createComputeOptimizerExportPlanSet({
    scope: PLAN_SCOPE,
    requesterAccountId: ACCOUNT,
    partition: "aws",
    regions: [REGION],
    exportFamilies: FAMILIES,
    targets: FAMILIES.map((family) => planTarget(family, variant)),
  });
  const targets = planSet.plans[0].targets.map((target) => mappedTarget(target, amountMicros));
  const fresh = bindings(planSet, resolvedAt);
  return {
    planSet,
    targets,
    partial: await createComputeOptimizerExportGenerationAttempt(
      planSet,
      targets.slice(0, 1),
      fresh,
      OPTIONS,
    ),
    completeAttempt: await createComputeOptimizerExportGenerationAttempt(planSet, targets, fresh, OPTIONS),
    generation: await finalizeComputeOptimizerExportGeneration(planSet, targets, fresh, OPTIONS),
  };
}

function connection(database, id = CONNECTION, orgId = ORG, customerId = CUSTOMER) {
  return database.prepare(
    `INSERT INTO aws_connections (
      id,org_id,customer_id,source_kind,partition,aws_account_id,role_arn,
      external_id_ciphertext,external_id_key_version,permission_pack_version,
      status,enabled_regions_json
    ) VALUES (?,?,?,'aws_trust_role','aws',?,?,'ct','v1','standard-2026-08.5','active','[]')`,
  ).bind(id, orgId, customerId, ACCOUNT, `arn:aws:iam::${ACCOUNT}:role/sutra/SutraCollectorRole`);
}

async function seedPlanSet(database, planSet, createdAt = 1) {
  const planRepository = new ComputeOptimizerExportPlanRepository(database);
  for (let index = 0; index < planSet.plans.length; index += 1) {
    const plan = planSet.plans[index];
    const discoveryRunId = `cor_${hex(`discovery:${plan.planId}`)}`;
    await database.prepare(
      `INSERT INTO finops_co_discovery_runs (
        run_id,org_id,customer_id,connection_id,job_id,account_id,partition,region,
        status,content_sha256,collected_at,data_through_at,member_count,
        export_job_count,coverage_count,error_code,limitations_json,
        evidence_reference_ciphertext,evidence_reference_key_version,
        created_at,started_at,finalized_at
      ) VALUES (?,?,?,?,?,?,'aws',?,'partial',?,
        '2026-08-02T11:00:00.000Z','2026-08-02T10:00:00.000Z',0,0,0,
        'EXPORT_OBJECT_BINDING_REQUIRED','[\"EXPORT_OBJECT_BINDING_REQUIRED\"]',
        ?,'co-evidence-v1',?,?,?)`,
    ).bind(
      discoveryRunId,
      ORG,
      CUSTOMER,
      CONNECTION,
      `seed-${plan.planId.slice(0, 24)}`,
      ACCOUNT,
      plan.regions[0],
      hex(`content:${plan.planId}`),
      `fsev1.${"A".repeat(40)}`,
      createdAt,
      createdAt + 1,
      createdAt + 2,
    ).run();
    await planRepository.recordPlan(SCOPE, {
      discoveryRunId,
      planId: plan.planId,
      contentSha256: plan.contentSha256,
      requesterAccountId: plan.requesterAccountId,
      partition: plan.partition,
      region: plan.regions[0],
      regionCount: plan.regions.length,
      exportFamilyCount: plan.exportFamilies.length,
      targetCount: plan.targets.length,
      sealedEnvelope: {
        format: "sutra.compute-optimizer-export-plan-envelope.v1",
        ciphertext: "A".repeat(64),
        keyVersion: "co-plan:v1",
      },
    }, createdAt + index + 3);
  }
  await new ComputeOptimizerExportPlanSetRepository(database)
    .recordPlanSet(SCOPE, planSet, createdAt + planSet.plans.length + 3);
}

async function seed(database, planSet) {
  await database.batch([
    database.prepare(
      "INSERT INTO organizations(id,slug,name,status) VALUES (?,'co-exact','CO Exact','active')",
    ).bind(ORG),
    database.prepare(
      "INSERT INTO customers(id,org_id,slug,name,status) VALUES (?,?,'co-exact','CO Exact','active')",
    ).bind(CUSTOMER, ORG),
    connection(database),
  ]);
  await seedPlanSet(database, planSet);
}

async function withDatabase(planSet, run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `co-exact-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtime.resetRuntimeSchemaCacheForTests();
    await runtime.ensureRuntimeSchema(database);
    await seed(database, planSet);
    await run(database);
  } finally {
    await miniflare.dispose();
  }
}

function code(expected) {
  return (error) => error instanceof ComputeOptimizerExactGenerationRepositoryError
    && error.code === expected;
}

test("D1 and PostgreSQL schemas preserve the same commit-last immutable graph", async () => {
  const [d1, postgres, d1Runtime, pgRuntime, migrator] = await Promise.all([
    readFile(new URL("../drizzle/0115_finops_compute_optimizer_exact_generations.sql", import.meta.url), "utf8"),
    readFile(new URL("../postgres/migrations/0110_finops_compute_optimizer_exact_generations.sql", import.meta.url), "utf8"),
    readFile(new URL("../db/runtime-migrations.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/postgres-runtime-migrations.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/postgres-migrate.mjs", import.meta.url), "utf8"),
  ]);
  for (const sql of [d1, postgres]) {
    for (const table of [
      "finops_co_exact_artifacts",
      "finops_co_exact_artifact_chunks",
      "finops_co_exact_artifact_manifests",
      "finops_co_exact_generation_heads",
    ]) assert.match(sql, new RegExp(table, "u"));
    assert.match(sql, /sutra[.]compute-optimizer-export-generation[.]v1/u);
    assert.match(sql, /ALL_REGION_ACCEPTED/u);
    assert.match(sql, /FINOPS_CO_EXACT_(?:HEAD_REJECTED|IMMUTABLE)/u);
  }
  assert.match(d1, /byte_count` BETWEEN 1 AND 983040/u);
  assert.match(postgres, /byte_count BETWEEN 1 AND 983040/u);
  assert.equal(COMPUTE_OPTIMIZER_EXACT_PERSISTENCE_BOUNDS.maximumD1EvidenceBytes, 8 * 1_024 * 1_024);
  assert.equal(COMPUTE_OPTIMIZER_EXACT_PERSISTENCE_BOUNDS.maximumPostgresEvidenceBytes, 32 * 1_024 * 1_024);
  assert.ok(COMPUTE_OPTIMIZER_EXACT_PERSISTENCE_BOUNDS.maximumBase64urlCharactersPerRow < 2_000_000);
  assert.ok(COMPUTE_OPTIMIZER_EXACT_PERSISTENCE_BOUNDS.maximumBoundParametersPerStatement <= 100);
  assert.equal(d1Runtime.match(/0115_finops_compute_optimizer_exact_generations/gu)?.length, 2);
  assert.equal(pgRuntime.match(/0110_finops_compute_optimizer_exact_generations/gu)?.length, 2);
  assert.equal(migrator.match(/0110_finops_compute_optimizer_exact_generations/gu)?.length, 1);
});

test("partial and complete attempts are immutable evidence and structurally cannot become heads", async () => {
  const fixture = await generationFixture();
  await withDatabase(fixture.planSet, async (database) => {
    const repository = new ComputeOptimizerExactGenerationRepository(database);
    for (const [attempt, time] of [[fixture.partial, 100], [fixture.completeAttempt, 200]]) {
      const result = await repository.recordAttempt(SCOPE, fixture.planSet, attempt, time);
      assert.equal(result.becameHead, false);
      assert.equal(result.activeGenerationId, null);
      assert.deepEqual(await repository.getAttempt(SCOPE, fixture.planSet, attempt.attemptId), attempt);
    }
    assert.equal(await repository.getAcceptedHeadReference(SCOPE), null);
    await assert.rejects(database.prepare(
      `INSERT INTO finops_co_exact_generation_heads (
        org_id,customer_id,connection_id,generation_id,data_through_at,observed_at,advanced_at
      ) VALUES (?,?,?,?,?,?,?)`,
    ).bind(
      ORG,
      CUSTOMER,
      CONNECTION,
      fixture.completeAttempt.attemptId,
      fixture.completeAttempt.dataThroughAtIso,
      fixture.completeAttempt.observedAtIso,
      300,
    ).run(), /FINOPS_CO_EXACT_HEAD_REJECTED/u);
  });
});

test("accepted evidence round-trips exact micros and replay is idempotent", async () => {
  const fixture = await generationFixture("9223372036854775807");
  await withDatabase(fixture.planSet, async (database) => {
    const repository = new ComputeOptimizerExactGenerationRepository(database);
    const first = await repository.recordAcceptedGeneration(SCOPE, fixture.planSet, fixture.generation, 100);
    assert.equal(first.becameHead, true);
    assert.equal(first.activeGenerationId, fixture.generation.generationId);
    const replay = await repository.recordAcceptedGeneration(SCOPE, fixture.planSet, fixture.generation, 900);
    assert.equal(replay.becameHead, false);
    assert.equal(replay.artifact.createdAtIso, new Date(100).toISOString());
    const head = await repository.getAcceptedHeadForPlanSet(SCOPE, fixture.planSet);
    assert.deepEqual(head, fixture.generation);
    assert.deepEqual(await repository.getAcceptedHeadReference(SCOPE), {
      generationId: fixture.generation.generationId,
      planSetId: fixture.planSet.planSetId,
      planSetContentSha256: fixture.planSet.contentSha256,
    });
    assert.equal(head.targets[0].recommendations[0].savings[0].amountMicros, "9223372036854775807");
    const chunks = await database.prepare(
      "SELECT byte_count,payload_base64url FROM finops_co_exact_artifact_chunks WHERE artifact_id=?",
    ).bind(fixture.generation.generationId).all();
    assert.ok(chunks.results.every((row) => row.byte_count <= 983_040));
    assert.ok(chunks.results.every((row) => row.payload_base64url.length < 2_000_000));
  });
});

for (const phase of ["AFTER_ARTIFACT", "AFTER_CHUNK_BATCH"]) {
  test(`${phase} fault remains invisible and replay finishes the same artifact`, async () => {
    const fixture = await generationFixture();
    await withDatabase(fixture.planSet, async (database) => {
      const broken = new ComputeOptimizerExactGenerationRepository(database, (event) => {
        if (event.phase === phase) throw new Error(`fault:${phase}`);
      });
      await assert.rejects(
        broken.recordAttempt(SCOPE, fixture.planSet, fixture.partial, 100),
        new RegExp(`fault:${phase}`, "u"),
      );
      assert.equal(await database.prepare(
        "SELECT count(*) AS total FROM finops_co_exact_artifacts WHERE artifact_id=?",
      ).bind(fixture.partial.attemptId).first("total"), 1);
      assert.equal(await database.prepare(
        "SELECT count(*) AS total FROM finops_co_exact_artifact_manifests WHERE artifact_id=?",
      ).bind(fixture.partial.attemptId).first("total"), 0);
      assert.equal(
        await new ComputeOptimizerExactGenerationRepository(database)
          .getAttempt(SCOPE, fixture.planSet, fixture.partial.attemptId),
        null,
      );
      const recovered = new ComputeOptimizerExactGenerationRepository(database);
      const result = await recovered.recordAttempt(SCOPE, fixture.planSet, fixture.partial, 200);
      assert.deepEqual(await recovered.getAttempt(SCOPE, fixture.planSet, fixture.partial.attemptId), fixture.partial);
      assert.equal(result.artifact.committedAtIso, new Date(200).toISOString());
      if (phase === "AFTER_ARTIFACT") {
        await database.prepare("DROP TRIGGER finops_co_exact_artifacts_update_guard").run();
        await database.prepare(
          "UPDATE finops_co_exact_artifacts SET evidence_sha256=? WHERE artifact_id=?",
        ).bind("c".repeat(64), fixture.partial.attemptId).run();
        await assert.rejects(
          recovered.recordAttempt(SCOPE, fixture.planSet, fixture.partial, 300),
          code("IMMUTABLE_CONFLICT"),
        );
      }
    });
  });
}

test("read recomputes payload hash, chain and whole evidence hash", async () => {
  const fixture = await generationFixture();
  await withDatabase(fixture.planSet, async (database) => {
    const repository = new ComputeOptimizerExactGenerationRepository(database);
    await repository.recordAcceptedGeneration(SCOPE, fixture.planSet, fixture.generation, 100);
    await assert.rejects(database.prepare(
      "UPDATE finops_co_exact_artifact_chunks SET payload_base64url=payload_base64url WHERE artifact_id=?",
    ).bind(fixture.generation.generationId).run(), /FINOPS_CO_EXACT_CHUNK_IMMUTABLE/u);
    await database.prepare("DROP TRIGGER finops_co_exact_chunks_update_guard").run();
    const row = await database.prepare(
      "SELECT payload_base64url FROM finops_co_exact_artifact_chunks WHERE artifact_id=? AND chunk_index=0",
    ).bind(fixture.generation.generationId).first();
    const replacement = `${row.payload_base64url[0] === "A" ? "B" : "A"}${row.payload_base64url.slice(1)}`;
    await database.prepare(
      "UPDATE finops_co_exact_artifact_chunks SET payload_base64url=? WHERE artifact_id=? AND chunk_index=0",
    ).bind(replacement, fixture.generation.generationId).run();
    await assert.rejects(
      repository.getAcceptedHeadForPlanSet(SCOPE, fixture.planSet),
      code("STORED_EVIDENCE_INVALID"),
    );
  });
});

test("equal chronology never uses a generation hash tiebreak", async () => {
  const firstFixture = await generationFixture("1000000");
  const secondFixture = await generationFixture("2000000");
  assert.equal(firstFixture.generation.dataThroughAtIso, secondFixture.generation.dataThroughAtIso);
  assert.equal(firstFixture.generation.observedAtIso, secondFixture.generation.observedAtIso);
  assert.notEqual(firstFixture.generation.generationId, secondFixture.generation.generationId);
  await withDatabase(firstFixture.planSet, async (database) => {
    const repository = new ComputeOptimizerExactGenerationRepository(database);
    await repository.recordAcceptedGeneration(SCOPE, firstFixture.planSet, firstFixture.generation, 100);
    const equal = await repository.recordAcceptedGeneration(
      SCOPE,
      secondFixture.planSet,
      secondFixture.generation,
      200,
    );
    assert.equal(equal.becameHead, false);
    assert.equal(equal.activeGenerationId, firstFixture.generation.generationId);
    assert.deepEqual(
      await repository.getAcceptedHeadForPlanSet(SCOPE, firstFixture.planSet),
      firstFixture.generation,
    );
    assert.equal(await database.prepare(
      "SELECT count(*) AS total FROM finops_co_exact_artifact_manifests",
    ).first("total"), 2);
  });
});

test("plan-specific head reads return null when the scope head belongs to a newer plan set", async () => {
  const prior = await generationFixture("1000000", "2026-08-02T11:58:00.000Z", "-prior");
  const current = await generationFixture("1000000", "2026-08-02T11:59:00.000Z", "-current");
  assert.notEqual(prior.planSet.planSetId, current.planSet.planSetId);
  assert.equal(prior.generation.dataThroughAtIso, current.generation.dataThroughAtIso);
  assert.ok(prior.generation.observedAtIso < current.generation.observedAtIso);
  await withDatabase(prior.planSet, async (database) => {
    await seedPlanSet(database, current.planSet, 2);
    const repository = new ComputeOptimizerExactGenerationRepository(database);
    await repository.recordAcceptedGeneration(SCOPE, prior.planSet, prior.generation, 100);
    await repository.recordAcceptedGeneration(SCOPE, current.planSet, current.generation, 200);
    assert.equal(await repository.getAcceptedHeadForPlanSet(SCOPE, prior.planSet), null);
    assert.deepEqual(
      await repository.getAcceptedGeneration(
        SCOPE,
        prior.planSet,
        prior.generation.generationId,
      ),
      prior.generation,
      "a request that resolved the prior head remains consistent after head advance",
    );
    assert.deepEqual(
      await repository.getAcceptedHeadForPlanSet(SCOPE, current.planSet),
      current.generation,
    );
  });
});

test("scope, schema, plan-set and immutable identity substitutions are rejected", async () => {
  const fixture = await generationFixture();
  const uncommitted = await generationFixture("1000000", undefined, "-uncommitted");
  await withDatabase(fixture.planSet, async (database) => {
    const repository = new ComputeOptimizerExactGenerationRepository(database);
    await assert.rejects(repository.recordAttempt(
      { ...SCOPE, customerId: "other_customer" },
      fixture.planSet,
      fixture.partial,
    ), code("INVALID_INPUT"));
    const changed = structuredClone(fixture.generation);
    changed.targets[0].recommendations[0].savings[0].amountMicros = "1";
    await assert.rejects(
      repository.recordAcceptedGeneration(SCOPE, fixture.planSet, changed),
      code("INVALID_INPUT"),
    );
    await assert.rejects(
      repository.recordAttempt(SCOPE, uncommitted.planSet, uncommitted.partial),
      code("PLAN_SET_NOT_COMMITTED"),
    );
  });
});
