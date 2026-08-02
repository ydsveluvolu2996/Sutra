import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtime = await import("../db/runtime-migrations.ts");
const {
  ComputeOptimizerActivationRepository,
  ComputeOptimizerActivationRepositoryError,
} = await import("../db/finops-compute-optimizer-activation-repository.ts");
const { ComputeOptimizerExportPlanRepository } = await import(
  "../db/finops-compute-optimizer-export-plan-repository.ts"
);
const { ComputeOptimizerExportPlanSetRepository } = await import(
  "../db/finops-compute-optimizer-export-plan-set-repository.ts"
);
const {
  coordinateComputeOptimizerMaterializationPlans,
  createComputeOptimizerMaterializationActivation,
} = await import("../lib/finops-compute-optimizer-export-coordinator.ts");
const {
  COMPUTE_OPTIMIZER_PROVIDER_RESOURCE_TYPES_BY_EXPORT_FAMILY,
  createComputeOptimizerExportLaunchAttempt,
} = await import("../lib/finops-compute-optimizer-export-launch.ts");
const { canonicalJson } = await import("../lib/canonical-json.ts");

const ORG_A = "org_co_activation_a";
const ORG_B = "org_co_activation_b";
const CUSTOMER_A = "customer_co_activation_a";
const CUSTOMER_B = "customer_co_activation_b";
const CONNECTION_A = `conn_${"a".repeat(32)}`;
const CONNECTION_B = `conn_${"b".repeat(32)}`;
const ACCOUNT_A = "111122223333";
const ACCOUNT_B = "999900001111";
const REGION = "us-east-1";
const WINDOW = "2026-08-02T00:00:00.000Z";
const SEALED = "2026-08-02T01:00:00.000Z";
const SCOPE_A = { organizationId: ORG_A, customerId: CUSTOMER_A, connectionId: CONNECTION_A };
const SCOPE_B = { organizationId: ORG_B, customerId: CUSTOMER_B, connectionId: CONNECTION_B };

async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((part) => part.toString(16).padStart(2, "0")).join("");
}
function code(expected) {
  return (error) => {
    assert.ok(error instanceof ComputeOptimizerActivationRepositoryError);
    assert.equal(error.code, expected);
    return true;
  };
}
function connection(database, id, orgId, customerId, accountId) {
  return database.prepare(
    `INSERT INTO aws_connections (
      id,org_id,customer_id,source_kind,partition,aws_account_id,role_arn,
      external_id_ciphertext,external_id_key_version,permission_pack_version,
      status,enabled_regions_json
    ) VALUES (?,?,?,'aws_trust_role','aws',?,?,'ct','v1',
      'standard-2026-08.4','active','[]')`,
  ).bind(id, orgId, customerId, accountId,
    `arn:aws:iam::${accountId}:role/sutra/SutraCollectorRole`);
}

async function withRepository(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `co-activation-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtime.resetRuntimeSchemaCacheForTests();
    await runtime.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations(id,slug,name,status) VALUES (?,'coa','CO A','active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations(id,slug,name,status) VALUES (?,'cob','CO B','active')").bind(ORG_B),
      database.prepare("INSERT INTO customers(id,org_id,slug,name,status) VALUES (?,?,'coa-c','CO A C','active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers(id,org_id,slug,name,status) VALUES (?,?,'cob-c','CO B C','active')").bind(CUSTOMER_B, ORG_B),
      connection(database, CONNECTION_A, ORG_A, CUSTOMER_A, ACCOUNT_A),
      connection(database, CONNECTION_B, ORG_B, CUSTOMER_B, ACCOUNT_B),
    ]);
    let clockMs = Date.parse("2026-08-02T01:05:01.000Z");
    await run({
      database,
      repository: new ComputeOptimizerActivationRepository(database, () => clockMs),
      setClock: (value) => { clockMs = value; },
      plans: new ComputeOptimizerExportPlanRepository(database),
      sets: new ComputeOptimizerExportPlanSetRepository(database),
    });
  } finally { await miniflare.dispose(); }
}

function capabilityInput(enabled = true) {
  return {
    accountId: ACCOUNT_A,
    partition: "aws",
    regions: [REGION],
    manifestSha256: "a".repeat(64),
    verifiedAtMs: Date.parse("2026-08-02T00:30:00.000Z"),
    enabled,
  };
}

async function activationFixture() {
  const attempt = await createComputeOptimizerExportLaunchAttempt({
    scope: { orgId: ORG_A, customerId: CUSTOMER_A, connectionId: CONNECTION_A },
    requesterAccountId: ACCOUNT_A,
    partition: "aws",
    region: REGION,
    scheduledWindow: WINDOW,
    sealedAtIso: SEALED,
    attemptNumber: 1,
    bucket: "sutra-co-activation-us-east-1",
    optionalPrefix: "organization/exports",
  });
  const outcomes = attempt.targets.map((target, index) => {
    const jobId = `job-${index + 1}`;
    const objectKey = `${target.effectivePrefix}${REGION}-2026-08-02T010000Z-${jobId}.csv`;
    return {
      targetId: target.targetId,
      exportFamily: target.exportFamily,
      operation: target.operation,
      status: "SUCCEEDED",
      jobId,
      bucket: target.bucket,
      objectKey,
      metadataKey: objectKey.replace(/\.csv$/u, "-metadata.json"),
      errorCode: null,
    };
  });
  const executionBody = {
    schemaVersion: "sutra.compute-optimizer-export-launch-execution.v1",
    requestBatchId: attempt.requestBatchId,
    launchAttemptId: attempt.launchAttemptId,
    status: "COMPLETE",
    startedAtIso: "2026-08-02T01:01:00.000Z",
    finishedAtIso: "2026-08-02T01:02:00.000Z",
    outcomes,
  };
  const executionHash = await digest(canonicalJson(executionBody));
  const execution = {
    ...executionBody,
    executionId: `coele_${executionHash}`,
    contentSha256: executionHash,
  };
  const completedJobs = outcomes.map((outcome, index) => {
    const target = attempt.targets[index];
    return {
      targetId: target.targetId,
      plannedJobId: outcome.jobId,
      jobId: outcome.jobId,
      exportFamily: target.exportFamily,
      providerResourceType: target.exportFamily === "RDS_DATABASE"
        ? "RdsDBInstance"
        : COMPUTE_OPTIMIZER_PROVIDER_RESOURCE_TYPES_BY_EXPORT_FAMILY[target.exportFamily][0],
      requestSha256: target.requestSha256,
      status: "COMPLETE",
      bucket: outcome.bucket,
      objectKey: outcome.objectKey,
      metadataKey: outcome.metadataKey,
      destination: { bucket: outcome.bucket, objectKey: outcome.objectKey, metadataKey: outcome.metadataKey },
      creationTimestampIso: "2026-08-02T01:01:00.000Z",
      lastUpdatedTimestampIso: "2026-08-02T01:03:00.000Z",
    };
  });
  const activation = await createComputeOptimizerMaterializationActivation([attempt]);
  const checkpoint = await coordinateComputeOptimizerMaterializationPlans(activation, [{
    launchAttemptId: attempt.launchAttemptId,
    execution,
    completedJobs,
  }]);
  assert.equal(checkpoint.status, "PLAN_SET_READY");
  return { activation, checkpoint, execution };
}

async function persistPlanLineage(database, plans, sets, checkpoint) {
  const plan = checkpoint.planSet.plans[0];
  const discoveryRunId = `cor_${await digest(`discovery:${plan.planId}`)}`;
  await database.prepare(
    `INSERT INTO finops_co_discovery_runs (
      run_id,org_id,customer_id,connection_id,job_id,account_id,partition,region,
      status,content_sha256,collected_at,data_through_at,member_count,export_job_count,
      coverage_count,error_code,limitations_json,evidence_reference_ciphertext,
      evidence_reference_key_version,created_at,started_at,finalized_at
    ) VALUES (?,?,?,?,?,?,'aws',?,'partial',?,'2026-08-02T01:04:00.000Z',
      '2026-08-02T01:03:00.000Z',0,8,1,'EXPORT_OBJECT_BINDING_REQUIRED',
      '["EXPORT_OBJECT_BINDING_REQUIRED"]',?,'evidence-v1',1,2,3)`,
  ).bind(discoveryRunId, ORG_A, CUSTOMER_A, CONNECTION_A, "discovery-job", ACCOUNT_A,
    REGION, await digest("discovery-content"), `fsev1.${"A".repeat(40)}`).run();
  await plans.recordPlan(SCOPE_A, {
    discoveryRunId,
    planId: plan.planId,
    contentSha256: plan.contentSha256,
    requesterAccountId: plan.requesterAccountId,
    partition: plan.partition,
    region: REGION,
    regionCount: 1,
    exportFamilyCount: plan.exportFamilies.length,
    targetCount: plan.targets.length,
    sealedEnvelope: {
      format: "sutra.compute-optimizer-export-plan-envelope.v1",
      ciphertext: "A".repeat(64),
      keyVersion: "co-plan-v1",
    },
  }, 10);
  await sets.recordPlanSet(SCOPE_A, checkpoint.planSet, 11);
  return [{ region: REGION, planId: plan.planId, discoveryRunId }];
}

test("separate .8.5 capability is exact, content-addressed, tenant-bound, and never mutates generic pack", async () => {
  await withRepository(async ({ database, repository }) => {
    const now = Date.parse("2026-08-02T00:31:00.000Z");
    const [first, raced] = await Promise.all([
      repository.recordCapability(SCOPE_A, capabilityInput(), now),
      repository.recordCapability(SCOPE_A, capabilityInput(), now),
    ]);
    assert.deepEqual(raced, first);
    assert.equal(first.permissionPackVersion, "standard-2026-08.5");
    assert.equal(first.enabled, true);
    assert.deepEqual(first.regions, [REGION]);
    assert.equal(await repository.getCurrentCapability(SCOPE_B), null);
    const connection = await database.prepare(
      "SELECT permission_pack_version FROM aws_connections WHERE id=?",
    ).bind(CONNECTION_A).first();
    assert.equal(connection.permission_pack_version, "standard-2026-08.4");

    await assert.rejects(repository.recordCapability(SCOPE_A, {
      ...capabilityInput(),
      bucket: "must-not-enter-capability",
    }, now), code("INVALID_INPUT"));
    await assert.rejects(repository.recordCapability(SCOPE_A, {
      ...capabilityInput(),
      regions: ["us-west-2", REGION],
    }, now), code("INVALID_INPUT"));
    await assert.rejects(repository.recordCapability(SCOPE_A, {
      ...capabilityInput(),
      accountId: ACCOUNT_B,
    }, now), code("IMMUTABLE_CONFLICT"));

    const disabled = await repository.recordCapability(SCOPE_A, capabilityInput(false), now + 1);
    assert.equal(disabled.enabled, false);
    assert.notEqual(disabled.capabilityId, first.capabilityId);
    await assert.rejects(database.prepare(
      "UPDATE finops_co_materialization_capabilities SET state='ENABLED' WHERE capability_id=?",
    ).bind(disabled.capabilityId).run(), /FINOPS_CO_CAPABILITY_IMMUTABLE/u);
  });
});

test("daily activation is deterministic, replay-safe, exact-keyed, and CAS guarded", async () => {
  await withRepository(async ({ repository }) => {
    const now = Date.parse("2026-08-02T01:05:00.000Z");
    const capability = await repository.recordCapability(SCOPE_A, capabilityInput(), now);
    const { activation, execution } = await activationFixture();
    const input = { capabilityId: capability.capabilityId, activation,
      sealedAtMs: Date.parse(SEALED), attempt: 1 };
    const [first, raced] = await Promise.all([
      repository.createDailyActivation(SCOPE_A, input, now + 1),
      repository.createDailyActivation(SCOPE_A, structuredClone(input), now + 1),
    ]);
    assert.deepEqual(raced, first);
    assert.equal(first.activationId, activation.activationId);
    assert.equal(first.state, "SEALED");
    assert.equal(first.attempt, 1);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(await repository.getActivation(SCOPE_B, activation.activationId), null);
    assert.deepEqual(await repository.getLatestActivation(SCOPE_A), first);
    assert.equal(await repository.getLatestActivation(SCOPE_B), null);

    const checkpoint = await repository.recordRegionalLaunchCheckpoint(SCOPE_A, {
      activation,
      region: REGION,
      execution,
    }, now + 2);
    assert.match(checkpoint.checkpointId, /^coalc_[a-f0-9]{64}$/u);
    assert.match(checkpoint.launchOutcomeProofSha256, /^[a-f0-9]{64}$/u);
    assert.equal("bucket" in checkpoint, false);
    assert.deepEqual(await repository.listRegionalLaunchCheckpoints(
      SCOPE_A,
      activation.activationId,
    ), [checkpoint]);
    const discoveryPending = await repository.finalizeLaunchCheckpoints(SCOPE_A, {
      activationId: activation.activationId,
      expectedAttempt: 1,
    }, now + 3);
    assert.equal(discoveryPending.state, "DISCOVERY_PENDING");
    const reconciling = await repository.transitionActivation(SCOPE_A, {
      activationId: activation.activationId,
      expectedState: "DISCOVERY_PENDING",
      nextState: "RECONCILING",
      expectedAttempt: 1,
      nextAttempt: 1,
      failureCode: null,
    }, now + 4);
    assert.equal(reconciling.state, "RECONCILING");
    assert.deepEqual(await repository.getLatestActivation(SCOPE_A), reconciling);
    await assert.rejects(repository.transitionActivation(SCOPE_A, {
      activationId: activation.activationId,
      expectedState: "DISCOVERY_PENDING",
      nextState: "FAILED",
      expectedAttempt: 1,
      nextAttempt: 1,
      failureCode: "LATE_FAILURE",
    }, now + 5), code("CAS_MISMATCH"));
    await assert.rejects(repository.transitionActivation(SCOPE_A, {
      activationId: activation.activationId,
      expectedState: "RECONCILING",
      nextState: "RECONCILING",
      expectedAttempt: 1,
      nextAttempt: 1,
      failureCode: null,
    }, now + 5), /FINOPS_CO_ACTIVATION_TRANSITION_REJECTED/u);
    assert.deepEqual((await repository.listEnabledCapabilities(null)).map(({ capabilityId }) => capabilityId),
      [capability.capabilityId]);
    assert.deepEqual((await repository.listRecoverableActivations(null)).map(({ activationId }) => activationId),
      [activation.activationId]);
  });
});

test("stages existing queue contract with exact plan/discovery lineage and replay-safe outbox CAS recovery", async () => {
  await withRepository(async ({ database, repository, plans, sets }) => {
    const now = Date.parse("2026-08-02T01:05:00.000Z");
    const capability = await repository.recordCapability(SCOPE_A, capabilityInput(), now);
    const { activation, checkpoint, execution } = await activationFixture();
    await repository.createDailyActivation(SCOPE_A, {
      capabilityId: capability.capabilityId,
      activation,
      sealedAtMs: Date.parse(SEALED),
      attempt: 1,
    }, now + 1);
    await repository.recordRegionalLaunchCheckpoint(SCOPE_A, {
      activation,
      region: REGION,
      execution,
    }, now + 2);
    await repository.finalizeLaunchCheckpoints(SCOPE_A, {
      activationId: activation.activationId,
      expectedAttempt: 1,
    }, now + 3);
    await repository.transitionActivation(SCOPE_A, {
      activationId: activation.activationId,
      expectedState: "DISCOVERY_PENDING",
      nextState: "RECONCILING",
      expectedAttempt: 1,
      nextAttempt: 1,
      failureCode: null,
    }, now + 4);
    const references = await persistPlanLineage(database, plans, sets, checkpoint);
    const input = {
      activation,
      checkpoint,
      regionalPlans: checkpoint.planSet.plans,
      regionalPlanDiscoveryReferences: references,
      regionContracts: [{
        region: REGION,
        describeContractId: "co-describe-contract-v1",
        objectContractId: "co-object-contract-v1",
      }],
    };
    const [first, raced] = await Promise.all([
      repository.stageReadyAndOutbox(SCOPE_A, input, now + 5),
      repository.stageReadyAndOutbox(SCOPE_A, structuredClone(input), now + 5),
    ]);
    assert.deepEqual(raced, first);
    assert.equal(first.state, "PENDING");
    assert.equal(first.payload.schemaVersion, "sutra.compute-optimizer-materialization-job.v1");
    assert.equal(first.payload.activationId, activation.activationId);
    assert.equal(first.payload.planCheckpointId, checkpoint.checkpointId);
    assert.equal(first.payload.planSetId, checkpoint.planSet.planSetId);
    assert.deepEqual(await repository.listDispatchable(SCOPE_A), [first]);
    assert.deepEqual((await repository.listOutboxWork(null, now + 5)).map(({ outboxId }) => outboxId),
      [first.outboxId]);
    assert.deepEqual(await repository.listDispatchable(SCOPE_B), []);

    const token = "lease-token-activation-outbox-001";
    const leased = await repository.leaseOutbox(SCOPE_A, {
      outboxId: first.outboxId,
      leaseToken: token,
      nowMs: now + 6,
      leaseDurationMs: 1_000,
    });
    assert.equal(leased.state, "LEASED");
    assert.equal(leased.deliveryAttempt, 1);
    assert.deepEqual(await repository.listOutboxWork(null, now + 1_005), []);
    await assert.rejects(repository.markOutboxDispatched(SCOPE_A, {
      outboxId: first.outboxId,
      leaseToken: "wrong-lease-token-activation-outbox",
      nowMs: now + 7,
    }), code("CAS_MISMATCH"));
    await assert.rejects(repository.markExpiredLeaseRecoverable(SCOPE_A, {
      outboxId: first.outboxId,
      nowMs: now + 1_005,
    }), code("CAS_MISMATCH"));
    const recoverable = await repository.markExpiredLeaseRecoverable(SCOPE_A, {
      outboxId: first.outboxId,
      nowMs: now + 1_006,
    });
    assert.equal(recoverable.state, "RECOVERABLE");
    const pending = await repository.requeueRecoverable(SCOPE_A, {
      outboxId: first.outboxId,
      nowMs: now + 1_007,
    });
    assert.equal(pending.state, "PENDING");
    const leasedAgain = await repository.leaseOutbox(SCOPE_A, {
      outboxId: first.outboxId,
      leaseToken: token,
      nowMs: now + 1_008,
      leaseDurationMs: 1_000,
    });
    assert.equal(leasedAgain.deliveryAttempt, 2);
    const dispatched = await repository.markOutboxDispatched(SCOPE_A, {
      outboxId: first.outboxId,
      leaseToken: token,
      nowMs: now + 1_009,
    });
    assert.equal(dispatched.state, "DISPATCHED");
    assert.deepEqual(await repository.listDispatchable(SCOPE_A), []);

    await assert.rejects(database.prepare(
      "UPDATE finops_co_materializer_outbox SET payload_sha256=? WHERE outbox_id=?",
    ).bind("f".repeat(64), first.outboxId).run(), /FINOPS_CO_OUTBOX_TRANSITION_REJECTED/u);
  });
});

test("sealed discovery reference is claimed once, replayed verbatim, tenant-bound, and crash recoverable", async () => {
  await withRepository(async ({ database, repository, setClock }) => {
    const startedAt = Date.parse("2026-08-02T01:05:00.000Z");
    setClock(startedAt + 1);
    const runId = `cor_${"d".repeat(64)}`;
    const evidenceContentSha256 = "e".repeat(64);
    const objectId = `eobj_${"f".repeat(32)}`;
    await database.batch([
      database.prepare(
        `INSERT INTO finops_co_discovery_runs (
          run_id,org_id,customer_id,connection_id,job_id,account_id,partition,region,
          status,created_at,started_at,member_count,export_job_count,coverage_count
        ) VALUES (?,?,?,?,?,?,'aws',?,'running',1,2,0,0,0)`,
      ).bind(runId, ORG_A, CUSTOMER_A, CONNECTION_A, "seal-discovery", ACCOUNT_A, REGION),
      database.prepare(
        `INSERT INTO evidence_objects (
          id,org_id,customer_id,connection_id,run_id,snapshot_id,artifact_kind,
          object_key,content_type,content_sha256,byte_size,status,retention_until,
          created_by,created_at,available_at
        ) VALUES (?,?,?,?,?,NULL,'export_json',?,'application/json',?,128,'available',?,?,?,?)`,
      ).bind(objectId, ORG_A, CUSTOMER_A, CONNECTION_A, runId,
        `finops/co/${runId}.json`, evidenceContentSha256, startedAt + 86_400_000,
        "finops-co-discovery", startedAt, startedAt),
    ]);
    const input = { runId, evidenceContentSha256, objectId };
    let sealCalls = 0;
    let release;
    let claimStarted;
    const gate = new Promise((resolve) => { release = resolve; });
    const claimed = new Promise((resolve) => { claimStarted = resolve; });
    const firstPromise = repository.getOrCreateSealedEvidenceReference(
      SCOPE_A,
      input,
      async () => {
        sealCalls += 1;
        claimStarted();
        await gate;
        return { ciphertext: `fsev1.${"A".repeat(40)}`, keyVersion: "co-evidence-v1" };
      },
      startedAt,
    );
    await claimed;
    await assert.rejects(repository.getOrCreateSealedEvidenceReference(
      SCOPE_A,
      input,
      async () => {
        sealCalls += 1;
        return { ciphertext: `fsev1.${"B".repeat(40)}`, keyVersion: "co-evidence-v1" };
      },
      startedAt,
    ), code("CAS_MISMATCH"));
    assert.equal(sealCalls, 1);
    release();
    const first = await firstPromise;
    assert.equal(first.reference.ciphertext, `fsev1.${"A".repeat(40)}`);
    assert.equal(first.objectId, objectId);

    const replay = await repository.getOrCreateSealedEvidenceReference(
      SCOPE_A,
      structuredClone(input),
      async () => {
        sealCalls += 1;
        return { ciphertext: `fsev1.${"C".repeat(40)}`, keyVersion: "co-evidence-v1" };
      },
      startedAt + 2,
    );
    assert.deepEqual(replay, first);
    assert.equal(sealCalls, 1);
    await assert.rejects(repository.getOrCreateSealedEvidenceReference(
      SCOPE_A,
      { ...input, evidenceContentSha256: "1".repeat(64) },
      async () => ({ ciphertext: `fsev1.${"D".repeat(40)}`, keyVersion: "co-evidence-v1" }),
      startedAt + 3,
    ), code("IMMUTABLE_CONFLICT"));
    await assert.rejects(repository.getOrCreateSealedEvidenceReference(
      SCOPE_A,
      { ...input, objectId: `eobj_${"1".repeat(32)}` },
      async () => ({ ciphertext: `fsev1.${"D".repeat(40)}`, keyVersion: "co-evidence-v1" }),
      startedAt + 3,
    ), code("IMMUTABLE_CONFLICT"));
    await assert.rejects(repository.getOrCreateSealedEvidenceReference(
      SCOPE_B,
      input,
      async () => ({ ciphertext: `fsev1.${"E".repeat(40)}`, keyVersion: "co-evidence-v1" }),
      startedAt + 3,
    ), code("PLAN_LINEAGE_NOT_FOUND"));
    await assert.rejects(database.prepare(
      "UPDATE finops_co_discovery_evidence_seals SET ciphertext=? WHERE run_id=?",
    ).bind(`fsev1.${"Z".repeat(40)}`, runId).run(), /FINOPS_CO_DISCOVERY_SEAL_TRANSITION_REJECTED/u);

    const crashedRunId = `cor_${"2".repeat(64)}`;
    const crashedObjectId = `eobj_${"3".repeat(32)}`;
    await database.batch([
      database.prepare(
        `INSERT INTO finops_co_discovery_runs (
          run_id,org_id,customer_id,connection_id,job_id,account_id,partition,region,
          status,created_at,started_at,member_count,export_job_count,coverage_count
        ) VALUES (?,?,?,?,?,?,'aws',?,'running',1,2,0,0,0)`,
      ).bind(crashedRunId, ORG_A, CUSTOMER_A, CONNECTION_A,
        "seal-discovery-crash", ACCOUNT_A, REGION),
      database.prepare(
        `INSERT INTO evidence_objects (
          id,org_id,customer_id,connection_id,run_id,snapshot_id,artifact_kind,
          object_key,content_type,content_sha256,byte_size,status,retention_until,
          created_by,created_at,available_at
        ) VALUES (?,?,?,?,?,NULL,'export_json',?,'application/json',?,128,'available',?,?,?,?)`,
      ).bind(crashedObjectId, ORG_A, CUSTOMER_A, CONNECTION_A, crashedRunId,
        `finops/co/${crashedRunId}.json`, evidenceContentSha256, startedAt + 86_400_000,
        "finops-co-discovery", startedAt, startedAt),
    ]);
    let releaseStale;
    let staleStarted;
    const staleGate = new Promise((resolve) => { releaseStale = resolve; });
    const staleClaimed = new Promise((resolve) => { staleStarted = resolve; });
    const staleOwner = repository.getOrCreateSealedEvidenceReference(
      SCOPE_A,
      { runId: crashedRunId, evidenceContentSha256, objectId: crashedObjectId },
      async () => {
        staleStarted();
        await staleGate;
        return { ciphertext: `fsev1.${"S".repeat(40)}`, keyVersion: "co-evidence-v1" };
      },
      startedAt,
    );
    await staleClaimed;
    let recoveryCalls = 0;
    const recoveredAt = startedAt + 120_001;
    setClock(recoveredAt + 1);
    const recovered = await repository.getOrCreateSealedEvidenceReference(
      SCOPE_A,
      { runId: crashedRunId, evidenceContentSha256, objectId: crashedObjectId },
      async () => {
        recoveryCalls += 1;
        return { ciphertext: `fsev1.${"R".repeat(40)}`, keyVersion: "co-evidence-v1" };
      },
      recoveredAt,
    );
    assert.equal(recoveryCalls, 1);
    assert.equal(recovered.reference.ciphertext, `fsev1.${"R".repeat(40)}`);
    releaseStale();
    await assert.rejects(staleOwner, code("CAS_MISMATCH"));
    const recoveredReplay = await repository.getOrCreateSealedEvidenceReference(
      SCOPE_A,
      { runId: crashedRunId, evidenceContentSha256, objectId: crashedObjectId },
      async () => ({ ciphertext: `fsev1.${"T".repeat(40)}`, keyVersion: "co-evidence-v1" }),
      recoveredAt + 2,
    );
    assert.deepEqual(recoveredReplay, recovered);
  });
});

test("D1/PostgreSQL migrations expose no capability topology and register immutable outbox guards", async () => {
  await withRepository(async ({ database }) => {
    const columns = await database.prepare(
      "PRAGMA table_info('finops_co_materialization_capabilities')",
    ).all();
    const names = (columns.results ?? []).map(({ name }) => name);
    assert.equal(names.some((name) => /bucket|prefix|role|policy|credential|secret/u.test(name)), false);
    const launchColumns = await database.prepare(
      "PRAGMA table_info('finops_co_activation_launch_checkpoints')",
    ).all();
    assert.equal((launchColumns.results ?? []).some(({ name }) => /bucket|object_key|metadata_key/u.test(name)), false);
    const registered = await database.prepare(
      "SELECT migration_id FROM sutra_runtime_migrations WHERE migration_id=?",
    ).bind("0116_finops_compute_optimizer_activation_outbox").first();
    assert.notEqual(registered, null);
  });
  const [postgres, registry] = await Promise.all([
    readFile(new URL("../postgres/migrations/0112_finops_compute_optimizer_activation_outbox.sql", import.meta.url), "utf8"),
    readFile(new URL("../db/postgres-runtime-migrations.ts", import.meta.url), "utf8"),
  ]);
  assert.match(postgres, /FINOPS_CO_ACTIVATION_TRANSITION_REJECTED/u);
  assert.match(postgres, /FINOPS_CO_OUTBOX_LINEAGE_REJECTED/u);
  assert.match(postgres, /FINOPS_CO_DISCOVERY_SEAL_TRANSITION_REJECTED/u);
  assert.match(postgres, /REVOKE ALL ON finops_co_materializer_outbox FROM PUBLIC/u);
  assert.match(registry, /0112_finops_compute_optimizer_activation_outbox/u);
});
