import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const { computeSnapshotSha256 } = await import("../lib/pilot-boundary.ts");
const awsSecurity = await import("../lib/aws-pilot-security.ts");
const localOperations = await import("../db/local-operations-repository.ts");
const pilotRepository = await import("../db/pilot-repository.ts");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const liveLimits = await import("../services/aws-collector/src/live-collection-limits.ts");

const FIXTURE = {
  fixtureId: "northstar-retail",
  customerName: "Northstar Retail",
  customerId: "cust_11111111111111111111111111111111",
  tenantId: pilotRepository.LOCAL_ORG_ID,
  connectionId: "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  accountId: "111122223333",
  partition: "aws",
  enabledRegions: ["us-east-1"],
  availableVersions: ["2026.07.0", "2026.07.1"],
};

const LIVE_CUSTOMER_ID = "cust_99999999999999999999999999999999";
const LIVE_CONNECTION_ID = "conn_99999999999999999999999999999999";
const LIVE_ACCOUNT_ID = "999900001111";

function verifiedRoleEvidence(accountId = LIVE_ACCOUNT_ID, partition = "aws") {
  return {
    verified: true,
    accountId,
    callerIdentityArn: `arn:${partition}:sts::${accountId}:assumed-role/SutraReadOnlyRole/sutra-repository-test`,
    missingExternalIdDenied: true,
    wrongExternalIdDenied: true,
    trustPolicyAttested: true,
    permissionPolicyAttested: true,
    sessionPolicyApplied: true,
    permissionPackVersion: "live-demo-2026-07.1",
  };
}

function verifiedRoleCommit({
  connectionId = LIVE_CONNECTION_ID,
  expectedPreviousRoleArn,
  roleArn,
  actorId = "usr_local_operations_test",
  accountId = LIVE_ACCOUNT_ID,
  partition = "aws",
}) {
  return pilotRepository.commitVerifiedConnectionRole({
    connectionId,
    expectedPreviousRoleArn,
    roleArn,
    actorId,
    verification: verifiedRoleEvidence(accountId, partition),
  });
}

async function provisionValidatedLiveConnection(database) {
  await database.batch([
    database.prepare(
      `INSERT INTO customers (id, org_id, slug, name, status)
       VALUES (?, ?, 'live-recovery-test', 'Live recovery test', 'active')`,
    ).bind(LIVE_CUSTOMER_ID, FIXTURE.tenantId),
    database.prepare(
      `INSERT INTO aws_connections
        (id, org_id, customer_id, source_kind, partition, aws_account_id,
         role_arn, external_id_ciphertext, external_id_key_version,
         permission_pack_version, status, enabled_regions_json, last_validated_at)
       VALUES (?, ?, ?, 'aws_trust_role', 'aws', ?, ?, 'test-ciphertext',
               'test-key-v1', 'aws-pilot-v1', 'active', '["us-east-1"]', ?)`,
    ).bind(
      LIVE_CONNECTION_ID,
      FIXTURE.tenantId,
      LIVE_CUSTOMER_ID,
      LIVE_ACCOUNT_ID,
      `arn:aws:iam::${LIVE_ACCOUNT_ID}:role/SutraReadOnly`,
      Date.now(),
    ),
  ]);
}

async function partialLiveSnapshot(runId) {
  const unsigned = {
    schemaVersion: "sutra.inventory.v1",
    jobId: runId,
    connectionId: LIVE_CONNECTION_ID,
    accountId: LIVE_ACCOUNT_ID,
    partition: "aws",
    roleSessionName: "sutra-live-partial-test",
    collectedAt: new Date().toISOString(),
    coverageState: "partial",
    coverage: [{
      collectorKey: "ec2.instances",
      region: "us-east-1",
      status: "failed",
      itemsObserved: 0,
      pagesObserved: 0,
      errorCode: "ACCESS_DENIED",
      message: "The collector was denied",
    }],
    resources: [],
    relationships: [],
    findings: [],
  };
  return { ...unsigned, snapshotSha256: await computeSnapshotSha256(unsigned) };
}

async function completeLiveSnapshot(runId) {
  const unsigned = {
    schemaVersion: "sutra.inventory.v1",
    jobId: runId,
    connectionId: LIVE_CONNECTION_ID,
    accountId: LIVE_ACCOUNT_ID,
    partition: "aws",
    roleSessionName: "sutra-live-complete-test",
    collectedAt: new Date().toISOString(),
    coverageState: "complete",
    coverage: [{
      collectorKey: "iam.roles",
      region: "global",
      status: "succeeded",
      itemsObserved: 2,
      pagesObserved: 1,
    }],
    resources: [],
    relationships: [],
    findings: [],
  };
  return { ...unsigned, snapshotSha256: await computeSnapshotSha256(unsigned) };
}

async function fixtureResult(triggerKind, character) {
  const now = new Date().toISOString();
  const jobId = `job_${character.repeat(48)}`;
  const unsigned = {
    schemaVersion: "sutra.inventory.v1",
    jobId,
    connectionId: FIXTURE.connectionId,
    accountId: FIXTURE.accountId,
    partition: "aws",
    roleSessionName: `sutra-fixture-${character}`,
    collectedAt: now,
    coverageState: "complete",
    coverage: [{
      collectorKey: "fixture.inventory",
      region: "us-east-1",
      status: "succeeded",
      itemsObserved: 0,
      pagesObserved: 1,
    }],
    resources: [],
    relationships: [],
    findings: [],
  };
  return {
    job: {
      jobId,
      tenantId: FIXTURE.tenantId,
      kind: "fixture.inventory.collect",
      fixtureId: FIXTURE.fixtureId,
      customerId: FIXTURE.customerId,
      connectionId: FIXTURE.connectionId,
      version: "2026.07.0",
      triggerKind,
      scheduleId: triggerKind === "scheduled" ? `sched_${character.repeat(48)}` : null,
      status: "succeeded",
      attempts: 1,
      maxAttempts: 5,
      availableAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      lastFailure: null,
    },
    fixtureId: FIXTURE.fixtureId,
    version: "2026.07.0",
    customerId: FIXTURE.customerId,
    connectionId: FIXTURE.connectionId,
    tenantId: FIXTURE.tenantId,
    snapshot: {
      ...unsigned,
      snapshotSha256: await computeSnapshotSha256(unsigned),
    },
  };
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-local-operations-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.prepare(
      "INSERT INTO organizations (id, slug, name, status) VALUES (?, ?, ?, 'active')",
    ).bind(FIXTURE.tenantId, "local-sutra", "Sutra local MSP").run();
    await run(database);
  } finally {
    await miniflare.dispose();
  }
}

async function withForcedAtomicAuditFailure(database, operation) {
  let forced = false;
  cloudflare.env.DB = {
    prepare: database.prepare.bind(database),
    batch: async (statements) => {
      if (!forced && statements.length === 2) {
        forced = true;
        return database.batch([
          statements[0],
          database.prepare(
            `INSERT INTO audit_events (id) VALUES (?)`,
          ).bind(`broken_audit_${crypto.randomUUID().replaceAll("-", "")}`),
        ]);
      }
      return database.batch(statements);
    },
  };
  try {
    return await operation();
  } finally {
    cloudflare.env.DB = database;
  }
}

async function connectionDraftInput(overrides = {}) {
  const accountId = overrides.accountId ?? "555566667777";
  const partition = overrides.partition ?? "aws";
  const identity = await awsSecurity.deriveLocalAwsConnectionIdentity(accountId, partition);
  return {
    actorId: "usr_connection_creator",
    operationId: `onb_${"a".repeat(32)}`,
    ...identity,
    customerName: "Atomic customer",
    customerSlug: `atomic-customer-${identity.customerId.slice(-8)}`,
    accountId,
    partition,
    enabledRegions: ["us-east-1"],
    externalIdCiphertext: "encrypted-external-id-material-first",
    externalIdKeyVersion: "test-key-v1",
    ...overrides,
  };
}

describe("recoverable initial AWS connection handoff", () => {
  it("returns the same committed secret for an exact actor-bound retry", async () => {
    await withDatabase(async (database) => {
      const input = await connectionDraftInput();
      const created = await pilotRepository.createConnectionDraft(input);
      const replay = await pilotRepository.createConnectionDraft({
        ...input,
        externalIdCiphertext: "encrypted-external-id-material-not-committed",
      });
      assert.equal(created.recovered, false);
      assert.equal(replay.recovered, true);
      assert.equal(replay.connection.id, created.connection.id);
      assert.equal(replay.externalIdCiphertext, created.externalIdCiphertext);
      assert.notEqual(replay.externalIdCiphertext, "encrypted-external-id-material-not-committed");
      const audits = await database.prepare(
        "SELECT actor_id, request_id, metadata_json FROM audit_events WHERE action = 'aws.connection.created'",
      ).all();
      assert.equal(audits.results.length, 1);
      assert.equal(audits.results[0]?.actor_id, input.actorId);
      assert.equal(
        audits.results[0]?.request_id,
        `aws.connection.created:${input.operationId}`,
      );
      assert.doesNotMatch(audits.results[0]?.metadata_json ?? "", /cipher|external.?id/iu);
    });
  });

  it("recovers a committed batch when the database acknowledgement is lost", async () => {
    await withDatabase(async (database) => {
      const input = await connectionDraftInput({ operationId: `onb_${"b".repeat(32)}` });
      let loseAcknowledgement = true;
      cloudflare.env.DB = {
        prepare: database.prepare.bind(database),
        batch: async (statements) => {
          const result = await database.batch(statements);
          if (loseAcknowledgement && statements.length === 4) {
            loseAcknowledgement = false;
            throw new Error("simulated lost database acknowledgement");
          }
          return result;
        },
      };
      let recovered;
      try {
        recovered = await pilotRepository.createConnectionDraft(input);
      } finally {
        cloudflare.env.DB = database;
      }
      assert.equal(recovered?.recovered, true);
      assert.equal(recovered?.connection.id, input.connectionId);
      assert.equal(
        (await database.prepare("SELECT COUNT(*) AS count FROM aws_connections").first())?.count,
        1,
      );
      assert.equal(
        (await database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'aws.connection.created'").first())?.count,
        1,
      );
    });
  });

  it("rolls back the customer and connection when the atomic audit insert fails", async () => {
    await withDatabase(async (database) => {
      const input = await connectionDraftInput({ operationId: `onb_${"c".repeat(32)}` });
      let failAudit = true;
      cloudflare.env.DB = {
        prepare: database.prepare.bind(database),
        batch: async (statements) => {
          if (failAudit && statements.length === 4) {
            failAudit = false;
            return database.batch([
              ...statements.slice(0, -1),
              database.prepare("INSERT INTO audit_events (id) VALUES ('broken-audit')"),
            ]);
          }
          return database.batch(statements);
        },
      };
      try {
        await assert.rejects(
          pilotRepository.createConnectionDraft(input),
          (error) => error?.code === "PERSISTENCE_FAILED",
        );
      } finally {
        cloudflare.env.DB = database;
      }
      assert.equal(
        (await database.prepare("SELECT COUNT(*) AS count FROM aws_connections").first())?.count,
        0,
      );
      assert.equal(
        (await database.prepare("SELECT COUNT(*) AS count FROM customers").first())?.count,
        0,
      );
      assert.equal(
        (await database.prepare("SELECT COUNT(*) AS count FROM audit_events").first())?.count,
        0,
      );
    });
  });

  it("handles concurrent same-operation retries and rejects a competing operation", async () => {
    await withDatabase(async (database) => {
      const input = await connectionDraftInput({ operationId: `onb_${"d".repeat(32)}` });
      const [first, second] = await Promise.all([
        pilotRepository.createConnectionDraft(input),
        pilotRepository.createConnectionDraft({
          ...input,
          externalIdCiphertext: "encrypted-concurrent-secret-material-second",
        }),
      ]);
      assert.deepEqual([first.recovered, second.recovered].sort(), [false, true]);
      assert.equal(first.externalIdCiphertext, second.externalIdCiphertext);
      await assert.rejects(
        pilotRepository.createConnectionDraft({
          ...input,
          operationId: `onb_${"e".repeat(32)}`,
        }),
        (error) => error?.code === "CONFLICT",
      );
      assert.equal(
        (await database.prepare("SELECT COUNT(*) AS count FROM aws_connections").first())?.count,
        1,
      );
    });
  });

  it("retains the exact actor-bound handoff when verified role evidence is incomplete", async () => {
    await withDatabase(async (database) => {
      const input = await connectionDraftInput({ operationId: `onb_${"1".repeat(32)}` });
      const created = await pilotRepository.createConnectionDraft(input);
      await assert.rejects(
        pilotRepository.commitVerifiedConnectionRole({
          connectionId: input.connectionId,
          expectedPreviousRoleArn: null,
          roleArn: `arn:aws:iam::${input.accountId}:role/sutra/SutraReadOnlyRole`,
          actorId: input.actorId,
          verification: {
            ...verifiedRoleEvidence(input.accountId, input.partition),
            wrongExternalIdDenied: false,
          },
        }),
        (error) => error?.code === "INVALID_STATE",
      );
      const recovered = await pilotRepository.createConnectionDraft({
        ...input,
        externalIdCiphertext: "encrypted-material-that-must-not-replace-the-handoff",
      });
      assert.equal(recovered.recovered, true);
      assert.equal(recovered.externalIdCiphertext, created.externalIdCiphertext);
      const row = await database.prepare(
        "SELECT role_arn, status FROM aws_connections WHERE id = ? LIMIT 1",
      ).bind(input.connectionId).first();
      assert.deepEqual(row, { role_arn: "", status: "pending" });
      assert.equal(
        (await database.prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'aws.connection.role_registered'",
        ).first())?.count,
        0,
      );
    });
  });

  it("never recovers the handoff for another actor, changed input, or a registered role", async () => {
    await withDatabase(async (database) => {
      const input = await connectionDraftInput({ operationId: `onb_${"f".repeat(32)}` });
      await pilotRepository.createConnectionDraft(input);
      await assert.rejects(
        pilotRepository.createConnectionDraft({ ...input, actorId: "usr_other_creator" }),
        (error) => error?.code === "INVALID_STATE",
      );
      await assert.rejects(
        pilotRepository.createConnectionDraft({ ...input, customerName: "Changed customer" }),
        (error) => error?.code === "INVALID_STATE",
      );
      const roleArn = `arn:aws:iam::${input.accountId}:role/sutra/SutraReadOnlyRole`;
      const committed = await verifiedRoleCommit({
        connectionId: input.connectionId,
        expectedPreviousRoleArn: null,
        roleArn,
        actorId: input.actorId,
        accountId: input.accountId,
        partition: input.partition,
      });
      const exactRetry = await verifiedRoleCommit({
        connectionId: input.connectionId,
        expectedPreviousRoleArn: roleArn,
        roleArn,
        actorId: input.actorId,
        accountId: input.accountId,
        partition: input.partition,
      });
      assert.equal(committed.status, "active");
      assert.equal(exactRetry.updatedAt, committed.updatedAt);
      assert.equal(
        (await database.prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'aws.connection.role_registered'",
        ).first())?.count,
        1,
      );
      await assert.rejects(
        pilotRepository.createConnectionDraft(input),
        (error) => error?.code === "INVALID_STATE" && /handoff closed/iu.test(error.message),
      );
    });
  });
});

describe("local fixture publication provenance", () => {
  it("persists manual collection provenance on the CMDB sync run", async () => {
    await withDatabase(async (database) => {
      const result = await fixtureResult("manual", "a");
      await localOperations.publishLocalFixtureJob({
        fixture: FIXTURE,
        result,
        actorId: "usr_local_operations_test",
        allowProvisioning: true,
      });
      const run = await database.prepare(
        "SELECT trigger_kind, schedule_id FROM sync_runs WHERE org_id = ? AND idempotency_key = ? LIMIT 1",
      ).bind(FIXTURE.tenantId, result.job.jobId).first();
      assert.equal(run?.trigger_kind, "manual");
      assert.equal(run?.schedule_id, null);
    });
  });

  it("persists scheduled collection provenance on the CMDB sync run", async () => {
    await withDatabase(async (database) => {
      const result = await fixtureResult("scheduled", "b");
      const publication = await localOperations.publishLocalFixtureJob({
        fixture: FIXTURE,
        result,
        actorId: "usr_local_operations_test",
        allowProvisioning: true,
      });
      const run = await database.prepare(
        "SELECT trigger_kind, schedule_id FROM sync_runs WHERE org_id = ? AND idempotency_key = ? LIMIT 1",
      ).bind(FIXTURE.tenantId, result.job.jobId).first();
      assert.equal(run?.trigger_kind, "scheduled");
      assert.equal(run?.schedule_id, result.job.scheduleId);
      assert.equal(publication.scheduleId, result.job.scheduleId);
      const storedPublication = await database.prepare(
        "SELECT schedule_id FROM local_job_publications WHERE job_id = ? LIMIT 1",
      ).bind(result.job.jobId).first();
      assert.equal(storedPublication?.schedule_id, result.job.scheduleId);
      const audit = await database.prepare(
        "SELECT metadata_json FROM audit_events WHERE action = 'fixture.job.published' AND target_id = ? LIMIT 1",
      ).bind(result.job.jobId).first();
      assert.equal(JSON.parse(audit?.metadata_json ?? "{}").scheduleId, result.job.scheduleId);
    });
  });
});

describe("AWS trust health remains separate from collection health", () => {
  it("reclaims a crashed live run only after the bounded collector window", async () => {
    await withDatabase(async (database) => {
      await provisionValidatedLiveConnection(database);
      const abandonedRunId = await pilotRepository.createSyncRun(LIVE_CONNECTION_ID);

      await assert.rejects(
        pilotRepository.createSyncRun(LIVE_CONNECTION_ID),
        (error) => error?.code === "CONFLICT",
      );

      const crashedAt = Date.now() - liveLimits.LIVE_AWS_RUN_RECLAIM_AFTER_MS - 1_000;
      await database.prepare(
        "UPDATE sync_runs SET created_at = ?, started_at = ? WHERE id = ?",
      ).bind(crashedAt, crashedAt, abandonedRunId).run();

      const retryRunId = await pilotRepository.createSyncRun(LIVE_CONNECTION_ID);
      assert.notEqual(retryRunId, abandonedRunId);
      const runs = await database.prepare(
        "SELECT id, status, coverage_state, totals_json FROM sync_runs WHERE connection_id = ? ORDER BY created_at",
      ).bind(LIVE_CONNECTION_ID).all();
      const abandoned = runs.results.find((run) => run.id === abandonedRunId);
      const retry = runs.results.find((run) => run.id === retryRunId);
      assert.deepEqual(abandoned, {
        id: abandonedRunId,
        status: "failed",
        coverage_state: "unknown",
        totals_json: '{"error":"COLLECTION_FAILED"}',
      });
      assert.deepEqual(retry, {
        id: retryRunId,
        status: "running",
        coverage_state: "unknown",
        totals_json: "{}",
      });
    });
  });

  it("keeps a validated connection active after an ordinary sync failure", async () => {
    await withDatabase(async (database) => {
      await provisionValidatedLiveConnection(database);
      const runId = await pilotRepository.createSyncRun(LIVE_CONNECTION_ID);
      await pilotRepository.failSyncRun(
        runId,
        LIVE_CONNECTION_ID,
        "usr_local_operations_test",
        "COLLECTION_FAILED",
      );
      const connection = await database.prepare(
        "SELECT status FROM aws_connections WHERE id = ? LIMIT 1",
      ).bind(LIVE_CONNECTION_ID).first();
      const run = await database.prepare(
        "SELECT status, coverage_state FROM sync_runs WHERE id = ? LIMIT 1",
      ).bind(runId).first();
      assert.equal(connection?.status, "active");
      assert.equal(run?.status, "failed");
      assert.equal(run?.coverage_state, "unknown");
    });
  });

  it("keeps a validated connection active while persisting partial coverage", async () => {
    await withDatabase(async (database) => {
      await provisionValidatedLiveConnection(database);
      const runId = await pilotRepository.createSyncRun(LIVE_CONNECTION_ID);
      await pilotRepository.persistSnapshot(
        runId,
        await partialLiveSnapshot(runId),
        "usr_local_operations_test",
        { kind: "aws_sandbox", fixtureId: null, fixtureVersion: null },
      );
      const connection = await database.prepare(
        "SELECT status, last_successful_sync_at FROM aws_connections WHERE id = ? LIMIT 1",
      ).bind(LIVE_CONNECTION_ID).first();
      const run = await database.prepare(
        "SELECT status, coverage_state FROM sync_runs WHERE id = ? LIMIT 1",
      ).bind(runId).first();
      assert.equal(connection?.status, "active");
      assert.equal(connection?.last_successful_sync_at, null);
      assert.equal(run?.status, "partial");
      assert.equal(run?.coverage_state, "partial");

      const state = await pilotRepository.getPilotState(LIVE_CONNECTION_ID);
      assert.equal(state.activeSnapshot, null);
      assert.deepEqual(state.coverage, []);
      assert.equal(state.latestRunCoverage?.syncRunId, runId);
      assert.deepEqual(state.latestRunCoverage?.entries, [{
        collectorKey: "ec2.instances",
        region: "us-east-1",
        status: "failed",
        itemsObserved: 0,
        pagesObserved: 0,
        errorCode: "ACCESS_DENIED",
        message: "The collector was denied",
      }]);
    });
  });

  it("returns only the latest partial run coverage while retaining the previous complete projection", async () => {
    await withDatabase(async (database) => {
      await provisionValidatedLiveConnection(database);
      const completeRunId = await pilotRepository.createSyncRun(LIVE_CONNECTION_ID);
      await pilotRepository.persistSnapshot(
        completeRunId,
        await completeLiveSnapshot(completeRunId),
        "usr_local_operations_test",
        { kind: "aws_sandbox", fixtureId: null, fixtureVersion: null },
      );
      // Make ordering deterministic even if both runs are created in the same
      // millisecond on a fast local database.
      await database.prepare(
        "UPDATE sync_runs SET created_at = ? WHERE id = ?",
      ).bind(Date.now() - 1_000, completeRunId).run();

      const partialRunId = await pilotRepository.createSyncRun(LIVE_CONNECTION_ID);
      await pilotRepository.persistSnapshot(
        partialRunId,
        await partialLiveSnapshot(partialRunId),
        "usr_local_operations_test",
        { kind: "aws_sandbox", fixtureId: null, fixtureVersion: null },
      );

      const state = await pilotRepository.getPilotState(LIVE_CONNECTION_ID);
      assert.equal(state.activeSnapshot?.coverageState, "complete");
      assert.equal(state.coverage[0]?.collectorKey, "iam.roles");
      assert.equal(state.latestRunCoverage?.syncRunId, partialRunId);
      assert.equal(state.latestRunCoverage?.entries[0]?.collectorKey, "ec2.instances");
      assert.equal(state.latestRunCoverage?.entries[0]?.errorCode, "ACCESS_DENIED");
      assert.equal(
        state.latestRunCoverage?.entries.some((entry) => entry.collectorKey === "iam.roles"),
        false,
      );
    });
  });

  it("allows explicit trust revalidation only while no sync is running", async () => {
    await withDatabase(async (database) => {
      await provisionValidatedLiveConnection(database);
      await pilotRepository.markConnectionValidating(LIVE_CONNECTION_ID);
      assert.equal(
        (await database.prepare("SELECT status FROM aws_connections WHERE id = ?")
          .bind(LIVE_CONNECTION_ID).first())?.status,
        "validating",
      );
      await pilotRepository.markConnectionValidated(
        LIVE_CONNECTION_ID,
        "usr_local_operations_test",
      );
      await pilotRepository.createSyncRun(LIVE_CONNECTION_ID);
      await assert.rejects(
        pilotRepository.markConnectionValidating(LIVE_CONNECTION_ID),
        (error) => error?.code === "INVALID_STATE",
      );
    });
  });
});

describe("AWS trust connection lifecycle", () => {
  it("atomically activates a replacement only with complete fresh trust evidence", async () => {
    await withDatabase(async (database) => {
      await provisionValidatedLiveConnection(database);
      const before = await database.prepare(
        "SELECT last_validated_at FROM aws_connections WHERE id = ? LIMIT 1",
      ).bind(LIVE_CONNECTION_ID).first();
      assert.equal(typeof before?.last_validated_at, "number");

      const replaced = await verifiedRoleCommit({
        expectedPreviousRoleArn: `arn:aws:iam::${LIVE_ACCOUNT_ID}:role/SutraReadOnly`,
        roleArn: `arn:aws:iam::${LIVE_ACCOUNT_ID}:role/sutra/SutraReadOnlyRole`,
      });
      assert.equal(replaced.status, "active");
      assert.equal(typeof replaced.lastValidatedAt, "string");
      assert.equal(
        replaced.roleArn,
        `arn:aws:iam::${LIVE_ACCOUNT_ID}:role/sutra/SutraReadOnlyRole`,
      );
      const after = await database.prepare(
        "SELECT last_validated_at FROM aws_connections WHERE id = ? LIMIT 1",
      ).bind(LIVE_CONNECTION_ID).first();
      assert.equal(typeof after?.last_validated_at, "number");
      const audit = await database.prepare(
        `SELECT request_id, metadata_json FROM audit_events
          WHERE action = 'aws.connection.role_registered' AND target_id = ? LIMIT 1`,
      ).bind(LIVE_CONNECTION_ID).first();
      assert.match(audit?.request_id ?? "", /^aws\.connection\.role_verified:/u);
      const metadata = JSON.parse(audit?.metadata_json ?? "{}");
      assert.deepEqual(metadata.trustProof, {
        assumeRoleSucceeded: true,
        exactPermissionPolicyAttested: true,
        exactTrustPolicyAttested: true,
        expectedCallerIdentityMatched: true,
        missingExternalIdDenied: true,
        permissionPackVersion: "live-demo-2026-07.1",
        sessionPolicyApplied: true,
        wrongExternalIdDenied: true,
      });
      assert.equal("callerIdentityArn" in metadata, false);
    });
  });

  it("refuses to disable while inventory is active and then stops future work", async () => {
    await withDatabase(async (database) => {
      await provisionValidatedLiveConnection(database);
      const runId = await pilotRepository.createSyncRun(LIVE_CONNECTION_ID);
      await assert.rejects(
        pilotRepository.disableAwsConnection(
          LIVE_CONNECTION_ID,
          "usr_local_operations_test",
        ),
        (error) => error?.code === "INVALID_STATE",
      );
      await pilotRepository.failSyncRun(
        runId,
        LIVE_CONNECTION_ID,
        "usr_local_operations_test",
        "COLLECTION_FAILED",
      );
      const disabled = await pilotRepository.disableAwsConnection(
        LIVE_CONNECTION_ID,
        "usr_local_operations_test",
      );
      assert.equal(disabled.status, "disabled");
      await assert.rejects(
        pilotRepository.createSyncRun(LIVE_CONNECTION_ID),
        (error) => error?.code === "INVALID_STATE",
      );
      const stored = await pilotRepository.getStoredConnectionSecret(LIVE_CONNECTION_ID);
      assert.equal(stored.externalIdCiphertext, "test-ciphertext");
      assert.equal(stored.status, "disabled");
      const audit = await database.prepare(
        "SELECT metadata_json FROM audit_events WHERE action = 'aws.connection.disabled' LIMIT 1",
      ).first();
      assert.equal(JSON.parse(audit?.metadata_json ?? "{}").accountId, LIVE_ACCOUNT_ID);
    });
  });

  it("offboards trust material while retaining the CMDB snapshot tombstone", async () => {
    await withDatabase(async (database) => {
      await provisionValidatedLiveConnection(database);
      const now = Date.now();
      await database.batch([
        database.prepare(
          `INSERT INTO sync_runs
            (id, org_id, customer_id, connection_id, trigger_kind, status,
             coverage_state, collector_pack_version, totals_json, idempotency_key,
             started_at, finished_at, created_at)
           VALUES ('sync_retained', ?, ?, ?, 'manual', 'succeeded', 'complete',
                   'aws-pilot-v1', '{}', 'retained', ?, ?, ?)`,
        ).bind(FIXTURE.tenantId, LIVE_CUSTOMER_ID, LIVE_CONNECTION_ID, now, now, now),
        database.prepare(
          `INSERT INTO cmdb_snapshots
            (id, org_id, customer_id, connection_id, sync_run_id, status,
             collected_at, completed_at, coverage_json, summary_json,
             snapshot_sha256, origin_kind)
           VALUES ('snap_retained', ?, ?, ?, 'sync_retained', 'complete', ?, ?,
                   '[]', '{}', ?, 'aws_sandbox')`,
        ).bind(
          FIXTURE.tenantId,
          LIVE_CUSTOMER_ID,
          LIVE_CONNECTION_ID,
          now,
          now,
          "a".repeat(64),
        ),
        database.prepare(
          `INSERT INTO connection_heads
            (connection_id, org_id, customer_id, snapshot_id, updated_at)
           VALUES (?, ?, ?, 'snap_retained', ?)`,
        ).bind(LIVE_CONNECTION_ID, FIXTURE.tenantId, LIVE_CUSTOMER_ID, now),
      ]);

      const offboarded = await pilotRepository.offboardAwsConnection(
        LIVE_CONNECTION_ID,
        "usr_local_operations_test",
      );
      assert.equal(offboarded.status, "disabled");
      assert.equal(offboarded.roleArn, null);
      await assert.rejects(
        pilotRepository.getStoredConnectionSecret(LIVE_CONNECTION_ID),
        (error) => error?.code === "INVALID_STATE",
      );
      const retained = await database.prepare(
        "SELECT snapshot_id FROM connection_heads WHERE connection_id = ? LIMIT 1",
      ).bind(LIVE_CONNECTION_ID).first();
      assert.equal(retained?.snapshot_id, "snap_retained");
      const row = await database.prepare(
        `SELECT role_arn, external_id_ciphertext, external_id_key_version
           FROM aws_connections WHERE id = ? LIMIT 1`,
      ).bind(LIVE_CONNECTION_ID).first();
      assert.equal(row?.role_arn, "");
      assert.notEqual(row?.external_id_ciphertext, "test-ciphertext");
      assert.equal(row?.external_id_key_version, "offboarded");
      assert.doesNotMatch(JSON.stringify(offboarded), /cipher|external.?id/iu);
      const audit = await database.prepare(
        "SELECT metadata_json FROM audit_events WHERE action = 'aws.connection.offboarded' LIMIT 1",
      ).first();
      const auditMetadata = JSON.parse(audit?.metadata_json ?? "{}");
      assert.equal(auditMetadata.cmdbHistoryRetained, true);
      assert.equal(auditMetadata.controlPlaneTrustMaterialRemoved, true);
      assert.equal(auditMetadata.customerIamRoleRevocationRequired, true);
      assert.equal("collectorTrustMaterialRemoved" in auditMetadata, false);
    });
  });

  it("replays each audited trust mutation without changing state or duplicating evidence", async () => {
    await withDatabase(async (database) => {
      await provisionValidatedLiveConnection(database);
      const actorId = "usr_local_operations_test";
      const previousRoleArn = `arn:aws:iam::${LIVE_ACCOUNT_ID}:role/SutraReadOnly`;
      const roleArn = `arn:aws:iam::${LIVE_ACCOUNT_ID}:role/sutra/SutraReadOnlyRole`;

      const registered = await verifiedRoleCommit({
        expectedPreviousRoleArn: previousRoleArn,
        roleArn,
        actorId,
      });
      const roleReplay = await verifiedRoleCommit({
        expectedPreviousRoleArn: roleArn,
        roleArn,
        actorId,
      });
      assert.equal(roleReplay.updatedAt, registered.updatedAt);
      assert.equal(roleReplay.roleArn, roleArn);
      await assert.rejects(
        verifiedRoleCommit({
          expectedPreviousRoleArn: roleArn,
          roleArn,
          actorId: "usr_different_actor",
        }),
        (error) => error?.code === "INVALID_STATE",
      );

      const disabled = await pilotRepository.disableAwsConnection(LIVE_CONNECTION_ID, actorId);
      const disableReplay = await pilotRepository.disableAwsConnection(LIVE_CONNECTION_ID, actorId);
      assert.equal(disableReplay.updatedAt, disabled.updatedAt);
      assert.equal(disableReplay.status, "disabled");
      await assert.rejects(
        pilotRepository.disableAwsConnection(LIVE_CONNECTION_ID, "usr_different_actor"),
        (error) => error?.code === "INVALID_STATE",
      );

      const offboarded = await pilotRepository.offboardAwsConnection(LIVE_CONNECTION_ID, actorId);
      const offboardReplay = await pilotRepository.offboardAwsConnection(LIVE_CONNECTION_ID, actorId);
      assert.equal(offboardReplay.updatedAt, offboarded.updatedAt);
      assert.equal(offboardReplay.roleArn, null);
      await assert.rejects(
        pilotRepository.offboardAwsConnection(LIVE_CONNECTION_ID, "usr_different_actor"),
        (error) => error?.code === "INVALID_STATE",
      );

      const audits = await database.prepare(
        `SELECT action, COUNT(*) AS count
           FROM audit_events
          WHERE action IN (
            'aws.connection.role_registered',
            'aws.connection.disabled',
            'aws.connection.offboarded'
          )
          GROUP BY action`,
      ).all();
      assert.deepEqual(
        Object.fromEntries(audits.results.map((row) => [row.action, row.count])),
        {
          "aws.connection.disabled": 1,
          "aws.connection.offboarded": 1,
          "aws.connection.role_registered": 1,
        },
      );
    });
  });

  it("rolls back IAM role registration when its audit insert is forced to fail", async () => {
    await withDatabase(async (database) => {
      await provisionValidatedLiveConnection(database);
      const before = await database.prepare(
        `SELECT role_arn, status, last_validated_at, updated_at
           FROM aws_connections WHERE id = ? LIMIT 1`,
      ).bind(LIVE_CONNECTION_ID).first();

      await assert.rejects(
        withForcedAtomicAuditFailure(database, () => verifiedRoleCommit({
          expectedPreviousRoleArn: `arn:aws:iam::${LIVE_ACCOUNT_ID}:role/SutraReadOnly`,
          roleArn: `arn:aws:iam::${LIVE_ACCOUNT_ID}:role/sutra/SutraReadOnlyRole`,
        })),
        (error) => error?.code === "PERSISTENCE_FAILED",
      );

      const after = await database.prepare(
        `SELECT role_arn, status, last_validated_at, updated_at
           FROM aws_connections WHERE id = ? LIMIT 1`,
      ).bind(LIVE_CONNECTION_ID).first();
      assert.deepEqual(after, before);
      assert.equal(
        (await database.prepare(
          `SELECT COUNT(*) AS count FROM audit_events
            WHERE action = 'aws.connection.role_registered'`,
        ).first())?.count,
        0,
      );
    });
  });

  it("rolls back disabled status when its audit insert is forced to fail", async () => {
    await withDatabase(async (database) => {
      await provisionValidatedLiveConnection(database);
      const before = await database.prepare(
        `SELECT role_arn, status, external_id_ciphertext, external_id_key_version, updated_at
           FROM aws_connections WHERE id = ? LIMIT 1`,
      ).bind(LIVE_CONNECTION_ID).first();

      await assert.rejects(
        withForcedAtomicAuditFailure(database, () => pilotRepository.disableAwsConnection(
          LIVE_CONNECTION_ID,
          "usr_local_operations_test",
        )),
        (error) => error?.code === "PERSISTENCE_FAILED",
      );

      const after = await database.prepare(
        `SELECT role_arn, status, external_id_ciphertext, external_id_key_version, updated_at
           FROM aws_connections WHERE id = ? LIMIT 1`,
      ).bind(LIVE_CONNECTION_ID).first();
      assert.deepEqual(after, before);
      assert.equal(
        (await database.prepare(
          `SELECT COUNT(*) AS count FROM audit_events
            WHERE action = 'aws.connection.disabled'`,
        ).first())?.count,
        0,
      );
    });
  });

  it("rolls back trust-secret destruction when its audit insert is forced to fail", async () => {
    await withDatabase(async (database) => {
      await provisionValidatedLiveConnection(database);
      const before = await database.prepare(
        `SELECT role_arn, status, external_id_ciphertext, external_id_key_version, updated_at
           FROM aws_connections WHERE id = ? LIMIT 1`,
      ).bind(LIVE_CONNECTION_ID).first();

      await assert.rejects(
        withForcedAtomicAuditFailure(database, () => pilotRepository.offboardAwsConnection(
          LIVE_CONNECTION_ID,
          "usr_local_operations_test",
        )),
        (error) => error?.code === "PERSISTENCE_FAILED",
      );

      const after = await database.prepare(
        `SELECT role_arn, status, external_id_ciphertext, external_id_key_version, updated_at
           FROM aws_connections WHERE id = ? LIMIT 1`,
      ).bind(LIVE_CONNECTION_ID).first();
      assert.deepEqual(after, before);
      assert.equal(
        (await database.prepare(
          `SELECT COUNT(*) AS count FROM audit_events
            WHERE action = 'aws.connection.offboarded'`,
        ).first())?.count,
        0,
      );
    });
  });
});
