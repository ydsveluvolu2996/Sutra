import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const pilotRepository = await import("../db/pilot-repository.ts");
const { EvidenceRepository, EvidenceRepositoryError } =
  await import("../db/evidence-repository.ts");
const { FinopsSourceJobLedgerRepository } =
  await import("../db/finops-source-job-ledger-repository.ts");
const { FinopsSourceSnapshotRepository } =
  await import("../db/finops-source-snapshot-repository.ts");
const {
  FINOPS_SOURCE_COLLECT_JOB_KIND,
  FinopsSourceCollectJobError,
  enqueueAwsCostAnomalyCollection,
  runFinopsSourceCollectJob,
} = await import("../lib/finops-source-collect-job.ts");
const {
  FinopsEvidenceReferenceError,
  FinopsEvidenceReferenceSealer,
} = await import("../lib/finops-source-evidence-reference.ts");
const {
  PilotServerError,
  parseFinopsSourceCollectionResult,
} = await import("../lib/pilot-server.ts");

const ORG_A = "org_source_collect_a";
const ORG_B = "org_source_collect_b";
const CUSTOMER_A = "customer_source_collect_a";
const CUSTOMER_B = "customer_source_collect_b";
const CONNECTION_A = `conn_${"a".repeat(32)}`;
const CONNECTION_B = `conn_${"b".repeat(32)}`;
const ACCOUNT_A = "111122223333";
const ACCOUNT_B = "444455556666";
const SOURCE_ID = "cost_anomaly_detection";
const CONTRACT_ID = "cost-anomaly-primary-v1";
const COLLECTED_AT = "2026-07-31T12:00:00.000Z";
const DATA_THROUGH_AT = "2026-07-31T11:00:00.000Z";

function connection(database, id, orgId, customerId, accountId) {
  return database.prepare(
    `INSERT INTO aws_connections (
       id, org_id, customer_id, source_kind, partition, aws_account_id,
       role_arn, external_id_ciphertext, external_id_key_version,
       permission_pack_version, status, enabled_regions_json
     ) VALUES (?, ?, ?, 'aws_trust_role', 'aws', ?, ?, 'ciphertext', 'v1',
               'standard-2026-07.4', 'active', '["us-east-1"]')`,
  ).bind(
    id,
    orgId,
    customerId,
    accountId,
    `arn:aws:iam::${accountId}:role/sutra/SutraCollectorRole`,
  );
}

async function withRuntime(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-source-collect-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status) VALUES (?, 'source-a', 'Source A', 'active')",
      ).bind(ORG_A),
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status) VALUES (?, 'source-b', 'Source B', 'active')",
      ).bind(ORG_B),
      database.prepare(
        "INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'source-ca', 'Source CA', 'active')",
      ).bind(CUSTOMER_A, ORG_A),
      database.prepare(
        "INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'source-cb', 'Source CB', 'active')",
      ).bind(CUSTOMER_B, ORG_B),
      connection(database, CONNECTION_A, ORG_A, CUSTOMER_A, ACCOUNT_A),
      connection(database, CONNECTION_B, ORG_B, CUSTOMER_B, ACCOUNT_B),
    ]);
    const sealer = await FinopsEvidenceReferenceSealer.fromRawKey({
      rawKey: new Uint8Array(32).fill(7),
      keyVersion: "finops-evidence-v1",
    });
    const ledger = new FinopsSourceJobLedgerRepository(database);
    const evidence = new EvidenceRepository(database, {
      objectStore: null,
      retentionDays: 30,
      environment: { SUTRA_DEPLOYMENT_ENV: "test" },
    });
    const snapshots = new FinopsSourceSnapshotRepository(database);
    await run({ database, sealer, ledger, evidence, snapshots });
  } finally {
    await miniflare.dispose();
  }
}

function job(digit, overrides = {}) {
  const connectionId = overrides.connectionId ?? CONNECTION_A;
  return {
    id: `job_${digit.repeat(32)}`,
    orgId: overrides.orgId ?? ORG_A,
    customerId: overrides.customerId ?? CUSTOMER_A,
    connectionId,
    kind: FINOPS_SOURCE_COLLECT_JOB_KIND,
    attempt: overrides.attempt ?? 1,
    maxAttempts: 6,
    payload: overrides.payload ?? {
      connectionId,
      sourceId: SOURCE_ID,
      contractId: CONTRACT_ID,
    },
  };
}

function result(input, overrides = {}) {
  const status = overrides.collectionStatus ?? "COMPLETE";
  const aggregateCoverage = overrides.coverage ?? {
    pagesObserved: 3,
    recordsObserved: 3,
    recordsAccepted: 3,
    recordsRejected: 0,
    recordsOmitted: 0,
  };
  const partial = status === "PARTIAL";
  return {
    schemaVersion: "sutra.finops-source-dispatch.v1",
    tenantId: input.tenantId,
    connectionId: input.connectionId,
    jobId: input.jobId,
    contractId: input.contractId,
    sourceId: input.sourceId,
    configured: true,
    implementationState: "IMPLEMENTED",
    collectionStatus: status,
    accountId: input.accountId,
    partition: input.partition,
    region: "us-east-1",
    collectedAt: COLLECTED_AT,
    dataThroughAt: overrides.dataThroughAt === undefined
      ? DATA_THROUGH_AT
      : overrides.dataThroughAt,
    coverage: aggregateCoverage,
    evidence: status === "UNAVAILABLE"
      ? null
      : {
          schemaVersion: "sutra.aws-cost-anomaly-detection.v1",
          source: "AWS_COST_EXPLORER_COST_ANOMALY_DETECTION",
          windowStartDate: "2026-07-01",
          windowEndDate: "2026-07-31",
          coverage: [
            { operation: "GET_ANOMALIES", status: "SUCCEEDED", pagesObserved: 1, recordsObserved: 1, recordsAccepted: 1, recordsRejected: 0, recordsOmitted: 0, errorCode: null },
            partial
              ? { operation: "GET_ANOMALY_MONITORS", status: "PARTIAL", pagesObserved: 1, recordsObserved: 1, recordsAccepted: 0, recordsRejected: 1, recordsOmitted: 0, errorCode: "SOURCE_COVERAGE_INCOMPLETE" }
              : { operation: "GET_ANOMALY_MONITORS", status: "SUCCEEDED", pagesObserved: 1, recordsObserved: 1, recordsAccepted: 1, recordsRejected: 0, recordsOmitted: 0, errorCode: null },
            { operation: "GET_ANOMALY_SUBSCRIPTIONS", status: "SUCCEEDED", pagesObserved: partial ? 0 : 1, recordsObserved: 1, recordsAccepted: 1, recordsRejected: 0, recordsOmitted: 0, errorCode: null },
          ],
          anomalies: [{
            anomalyId: "anomaly-1",
            monitorArn: `arn:aws:ce::${input.accountId}:anomalymonitor/monitor-1`,
            startDate: "2026-07-20",
            endDate: "2026-07-21",
            feedback: null,
            score: { current: 70, maximum: 90 },
            impact: { maximum: 12.5, total: 12.5, actualSpend: 22.5, expectedSpend: 10, percentage: 125 },
            rootCauses: [],
            rootCausesOmitted: 0,
          }],
          monitors: partial ? [] : [{
            monitorArn: `arn:aws:ce::${input.accountId}:anomalymonitor/monitor-1`,
            type: "DIMENSIONAL",
            dimension: "SERVICE",
            specificationPresent: false,
            dimensionalValueCount: 1,
            createdAt: null,
            lastUpdatedAt: null,
            lastEvaluatedAt: DATA_THROUGH_AT,
          }],
          subscriptions: [{
            subscriptionArn: `arn:aws:ce::${input.accountId}:anomalysubscription/subscription-1`,
            frequency: "DAILY",
            monitorArns: [`arn:aws:ce::${input.accountId}:anomalymonitor/monitor-1`],
            monitorArnsOmitted: 0,
            threshold: 100,
            thresholdExpressionPresent: false,
            subscriberCounts: { emailConfirmed: 0, emailDeclined: 0, snsConfirmed: 0, snsDeclined: 0, unknown: 0 },
          }],
        },
    errorCode: status === "COMPLETE"
      ? null
      : overrides.errorCode ?? "SOURCE_COVERAGE_INCOMPLETE",
    limitations: status === "COMPLETE" ? [] : ["SOURCE_COVERAGE_INCOMPLETE"],
  };
}

function dependencies(runtime, collect, now = Date.parse(COLLECTED_AT)) {
  return {
    getConnection: (orgId, connectionId) =>
      pilotRepository.getConnectionForOrg(orgId, connectionId),
    collect,
    ledger: runtime.ledger,
    evidence: runtime.evidence,
    snapshots: runtime.snapshots,
    evidenceReferenceSealer: runtime.sealer,
    now: () => now,
  };
}

test("durable job archives complete evidence, isolates tenants, and never activates partial or failed attempts", async () => {
  await withRuntime(async (runtime) => {
    const observedInputs = [];
    await runFinopsSourceCollectJob(job("1"), dependencies(runtime, async (input) => {
      observedInputs.push(input);
      return result(input);
    }));

    assert.deepEqual(observedInputs, [{
      tenantId: ORG_A,
      connectionId: CONNECTION_A,
      jobId: `job_${"1".repeat(32)}`,
      contractId: CONTRACT_ID,
      sourceId: SOURCE_ID,
      accountId: ACCOUNT_A,
      partition: "aws",
    }]);
    const attempt = await runtime.database.prepare(
      `SELECT status, accepted_records, rejected_records, expected_records,
              reconciliation_outcome, reconciliation_evidence_reference
         FROM finops_source_job_attempts WHERE job_id = ?`,
    ).bind(`job_${"1".repeat(32)}`).first();
    assert.deepEqual({
      status: attempt.status,
      accepted: Number(attempt.accepted_records),
      rejected: Number(attempt.rejected_records),
      expected: Number(attempt.expected_records),
      reconciliation: attempt.reconciliation_outcome,
    }, {
      status: "succeeded",
      accepted: 3,
      rejected: 0,
      expected: 3,
      reconciliation: "matched",
    });
    assert.match(attempt.reconciliation_evidence_reference, /^fsev1\./u);

    const object = await runtime.database.prepare(
      `SELECT o.id, o.artifact_kind, o.status, o.object_key, p.body_base64
         FROM evidence_objects o
         JOIN evidence_local_payloads p ON p.object_id = o.id
        WHERE o.org_id = ? AND o.customer_id = ? AND o.connection_id = ?`,
    ).bind(ORG_A, CUSTOMER_A, CONNECTION_A).first();
    assert.equal(object.artifact_kind, "finops_source_snapshot");
    assert.equal(object.status, "available");
    const archivedJson = Buffer.from(object.body_base64, "base64").toString("utf8");
    assert.doesNotMatch(archivedJson, new RegExp(ORG_A, "u"));
    assert.doesNotMatch(archivedJson, new RegExp(CONNECTION_A, "u"));
    assert.doesNotMatch(archivedJson, /roleArn|credentials|endpoint|providerMessage|temporaryCredentials/u);
    assert.match(archivedJson, /sutra\.finops-source-evidence\.v2/u);

    const active = await runtime.snapshots.getActiveSnapshot({
      organizationId: ORG_A,
      customerId: CUSTOMER_A,
      connectionId: CONNECTION_A,
    }, SOURCE_ID);
    assert.equal(active?.status, "complete");
    assert.equal(active?.activeGenerationId, active?.generationId);
    assert.equal(active?.evidenceReference.ciphertext, attempt.reconciliation_evidence_reference);
    assert.equal(await runtime.sealer.open(active.evidenceReference, {
      organizationId: ORG_A,
      customerId: CUSTOMER_A,
      connectionId: CONNECTION_A,
      sourceId: SOURCE_ID,
      generationId: active.generationId,
    }), object.id);
    const verified = await runtime.evidence.readFinopsSourceSnapshot({
      scope: { orgId: ORG_A, customerId: CUSTOMER_A, connectionId: CONNECTION_A },
      objectId: object.id,
      snapshotId: active.generationId,
      contentSha256: active.contentSha256,
      now: Date.parse(COLLECTED_AT),
    });
    assert.equal(new TextDecoder().decode(verified.body), archivedJson);
    for (const adversarial of [
      { scope: { orgId: ORG_B, customerId: CUSTOMER_B, connectionId: CONNECTION_B }, objectId: object.id, snapshotId: active.generationId, contentSha256: active.contentSha256 },
      { scope: { orgId: ORG_A, customerId: CUSTOMER_A, connectionId: CONNECTION_A }, objectId: object.id, snapshotId: `fss_${"f".repeat(64)}`, contentSha256: active.contentSha256 },
      { scope: { orgId: ORG_A, customerId: CUSTOMER_A, connectionId: CONNECTION_A }, objectId: object.id, snapshotId: active.generationId, contentSha256: "f".repeat(64) },
    ]) {
      await assert.rejects(
        runtime.evidence.readFinopsSourceSnapshot({ ...adversarial, now: Date.parse(COLLECTED_AT) }),
        (error) => error instanceof EvidenceRepositoryError && error.code === "SCOPE_NOT_FOUND",
      );
    }

    await assert.rejects(
      runtime.evidence.issueGrant({
        scope: { orgId: ORG_A, customerId: CUSTOMER_A, connectionId: CONNECTION_A },
        objectId: object.id,
        actorId: "usr_finops_reviewer",
        purpose: "export_download",
      }),
      (error) => error instanceof EvidenceRepositoryError && error.code === "INVALID_INPUT",
    );
    const activeBefore = await runtime.snapshots.getActiveSnapshot({
      organizationId: ORG_A,
      customerId: CUSTOMER_A,
      connectionId: CONNECTION_A,
    }, SOURCE_ID);

    await runFinopsSourceCollectJob(job("3"), dependencies(runtime, async (input) =>
      result(input, {
        collectionStatus: "PARTIAL",
        coverage: {
          pagesObserved: 2,
          recordsObserved: 3,
          recordsAccepted: 2,
          recordsRejected: 1,
          recordsOmitted: 0,
        },
      }), Date.parse("2026-07-31T12:05:00.000Z")));
    const partial = await runtime.database.prepare(
      "SELECT status, reconciliation_outcome FROM finops_source_job_attempts WHERE job_id = ?",
    ).bind(`job_${"3".repeat(32)}`).first();
    assert.equal(partial.status, "partial");
    assert.equal(partial.reconciliation_outcome, "mismatched");
    const partialSnapshot = await runtime.database.prepare(
      "SELECT status FROM finops_source_snapshots WHERE job_id = ?",
    ).bind(`job_${"3".repeat(32)}`).first();
    assert.equal(partialSnapshot.status, "partial");
    const latestAfterPartial = await runtime.snapshots.getLatestSnapshot({
      organizationId: ORG_A,
      customerId: CUSTOMER_A,
      connectionId: CONNECTION_A,
    }, SOURCE_ID);
    assert.equal(latestAfterPartial?.status, "partial");
    const activeAfter = await runtime.snapshots.getActiveSnapshot({
      organizationId: ORG_A,
      customerId: CUSTOMER_A,
      connectionId: CONNECTION_A,
    }, SOURCE_ID);
    assert.equal(activeAfter?.generationId, activeBefore?.generationId);
    const evidenceBeforeUnavailable = Number((await runtime.database.prepare(
      "SELECT COUNT(*) AS n FROM evidence_objects",
    ).first()).n);
    const snapshotsBeforeUnavailable = Number((await runtime.database.prepare(
      "SELECT COUNT(*) AS n FROM finops_source_snapshots",
    ).first()).n);
    await assert.rejects(
      runFinopsSourceCollectJob(job("4"), dependencies(runtime, async (input) =>
        result(input, {
          collectionStatus: "UNAVAILABLE",
          dataThroughAt: null,
          coverage: {
            pagesObserved: 0,
            recordsObserved: 0,
            recordsAccepted: 0,
            recordsRejected: 0,
            recordsOmitted: 0,
          },
          errorCode: "DATA_UNAVAILABLE",
        }))),
      (error) => error instanceof FinopsSourceCollectJobError && error.code === "COLLECTION_REJECTED",
    );
    const unavailable = await runtime.database.prepare(
      "SELECT status, error_code FROM finops_source_job_attempts WHERE job_id = ?",
    ).bind(`job_${"4".repeat(32)}`).first();
    assert.deepEqual(unavailable, { status: "failed", error_code: "SOURCE_UNAVAILABLE" });
    assert.equal(Number((await runtime.database.prepare(
      "SELECT COUNT(*) AS n FROM evidence_objects",
    ).first()).n), evidenceBeforeUnavailable);
    assert.equal(Number((await runtime.database.prepare(
      "SELECT COUNT(*) AS n FROM finops_source_snapshots",
    ).first()).n), snapshotsBeforeUnavailable);

    let called = false;
    await assert.rejects(
      runFinopsSourceCollectJob(job("5", {
        orgId: ORG_A,
        customerId: CUSTOMER_B,
      }), dependencies(runtime, async () => {
        called = true;
        throw new Error("must not run");
      })),
      (error) => error instanceof FinopsSourceCollectJobError && error.code === "CONNECTION_NOT_RUNNABLE",
    );
    assert.equal(called, false);
    const attemptsBeforeInvalidPayloads = Number((await runtime.database.prepare(
      "SELECT COUNT(*) AS n FROM finops_source_job_attempts",
    ).first()).n);
    const forbidden = [
      ["accountId", ACCOUNT_A],
      ["roleArn", `arn:aws:iam::${ACCOUNT_A}:role/attacker`],
      ["endpoint", "https://ce.us-east-1.amazonaws.com"],
      ["operation", "ce:GetAnomalies"],
      ["credentials", { accessKeyId: "ASIAEXAMPLE" }],
      ["filters", { region: "us-east-1" }],
      ["tenantId", ORG_A],
    ];
    for (const [key, value] of forbidden) {
      const attempted = job("6", {
        payload: {
          connectionId: CONNECTION_A,
          sourceId: SOURCE_ID,
          contractId: CONTRACT_ID,
          [key]: value,
        },
      });
      await assert.rejects(
        runFinopsSourceCollectJob(attempted, dependencies(runtime, async () => {
          throw new Error("must not run");
        })),
        (error) => error instanceof FinopsSourceCollectJobError && error.code === "INVALID_JOB",
      );
    }
    assert.equal(Number((await runtime.database.prepare(
      "SELECT COUNT(*) AS n FROM finops_source_job_attempts",
    ).first()).n), attemptsBeforeInvalidPayloads);

    await assert.rejects(
      runFinopsSourceCollectJob(job("a"), dependencies(runtime, async (input) => ({
        ...result(input),
        accountId: ACCOUNT_B,
      }))),
      (error) => error instanceof FinopsSourceCollectJobError && error.code === "COLLECTION_REJECTED",
    );
    const mismatch = await runtime.database.prepare(
      "SELECT status, error_code FROM finops_source_job_attempts WHERE job_id = ?",
    ).bind(`job_${"a".repeat(32)}`).first();
    assert.deepEqual(mismatch, { status: "failed", error_code: "INTERNAL_ERROR" });
    assert.equal(Number((await runtime.database.prepare(
      "SELECT COUNT(*) AS n FROM evidence_objects",
    ).first()).n), evidenceBeforeUnavailable);
  });
});

test("authorized Cost Anomaly enqueue owns the exact source and contract identity", async () => {
  const calls = [];
  const queued = await enqueueAwsCostAnomalyCollection({
    async enqueue(input, now) {
      calls.push({ input, now });
      return { id: `job_${"d".repeat(32)}` };
    },
  }, {
    organizationId: ORG_A,
    customerId: CUSTOMER_A,
    connectionId: CONNECTION_A,
  }, Date.parse("2026-07-31T12:04:00.000Z"));
  assert.equal(queued.jobId, `job_${"d".repeat(32)}`);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input.payload, {
    connectionId: CONNECTION_A,
    sourceId: "cost_anomaly_detection",
    contractId: "cost-anomaly-primary-v1",
  });
  assert.equal(calls[0].input.kind, "finops-source-collect");
  assert.equal(calls[0].input.orgId, ORG_A);
  assert.equal(calls[0].input.customerId, CUSTOMER_A);
  assert.equal(calls[0].input.connectionId, CONNECTION_A);
  assert.match(calls[0].input.idempotencyKey, /cost_anomaly_detection/u);
});

test("signed-result parser binds source, contract, account, partition, and connection", () => {
  const expected = {
    tenantId: ORG_A,
    connectionId: CONNECTION_A,
    jobId: `job_${"7".repeat(32)}`,
    contractId: CONTRACT_ID,
    sourceId: SOURCE_ID,
    accountId: ACCOUNT_A,
    partition: "aws",
  };
  const valid = result(expected);
  assert.deepEqual(parseFinopsSourceCollectionResult(valid, expected), valid);
  for (const mutation of [
    { sourceId: "aws_budgets" },
    { contractId: "foreign-contract" },
    { accountId: ACCOUNT_B },
    { partition: "aws-us-gov" },
    { connectionId: CONNECTION_B },
  ]) {
    assert.throws(
      () => parseFinopsSourceCollectionResult({ ...valid, ...mutation }, expected),
      (error) => error instanceof PilotServerError && error.code === "BROKER_RESPONSE_INVALID",
    );
  }
});

test("fsev1 references authenticate all AAD dimensions and never contain raw object addresses", async () => {
  const sealer = await FinopsEvidenceReferenceSealer.fromRawKey({
    rawKey: new Uint8Array(32).fill(11),
    keyVersion: "finops-evidence-v1",
  });
  const context = {
    organizationId: ORG_A,
    customerId: CUSTOMER_A,
    connectionId: CONNECTION_A,
    sourceId: SOURCE_ID,
    generationId: `fss_${"8".repeat(64)}`,
  };
  const objectId = `eobj_${"9".repeat(32)}`;
  const sealed = await sealer.seal(objectId, context);
  assert.match(sealed.ciphertext, /^fsev1\.[A-Za-z0-9_-]+$/u);
  assert.equal(sealed.ciphertext.includes(objectId), false);
  assert.equal(sealed.ciphertext.includes("s3://"), false);
  assert.equal(await sealer.open(sealed, context), objectId);
  const final = sealed.ciphertext.at(-1);
  const tampered = {
    ...sealed,
    ciphertext: `${sealed.ciphertext.slice(0, -1)}${final === "A" ? "B" : "A"}`,
  };
  await assert.rejects(
    sealer.open(tampered, context),
    (error) => error instanceof FinopsEvidenceReferenceError && error.code === "REFERENCE_INVALID",
  );
  for (const mutation of [
    { organizationId: ORG_B },
    { customerId: CUSTOMER_B },
    { connectionId: CONNECTION_B },
    { sourceId: "aws_budgets" },
    { generationId: `fss_${"a".repeat(64)}` },
  ]) {
    await assert.rejects(
      sealer.open(sealed, { ...context, ...mutation }),
      (error) => error instanceof FinopsEvidenceReferenceError && error.code === "REFERENCE_INVALID",
    );
  }
});
