import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const {
  FinopsSourceJobLedgerRepository,
  FinopsSourceJobLedgerRepositoryError,
} = await import("../db/finops-source-job-ledger-repository.ts");

const ORG_A = "org_source_ledger_a";
const ORG_B = "org_source_ledger_b";
const CUSTOMER_A = "customer_source_ledger_a";
const CUSTOMER_B = "customer_source_ledger_b";
const CONNECTION_A = `conn_${"a".repeat(32)}`;
const CONNECTION_B = `conn_${"b".repeat(32)}`;
const FIXTURE = `conn_${"c".repeat(32)}`;
const DISABLED = `conn_${"d".repeat(32)}`;
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
const IDENTITY = {
  sourceId: "aws_cur2_data_export",
  jobId: "billing-export-2026-07",
  attempt: 1,
};

function connection(database, {
  id,
  orgId,
  customerId,
  sourceKind = "aws_trust_role",
  status = "active",
  accountId,
}) {
  return database.prepare(
    `INSERT INTO aws_connections (
      id, org_id, customer_id, source_kind, fixture_id, aws_account_id,
      role_arn, external_id_ciphertext, external_id_key_version,
      permission_pack_version, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ciphertext', 'v1', 'pack-v1', ?)`,
  ).bind(
    id,
    orgId,
    customerId,
    sourceKind,
    sourceKind === "simulated_fixture" ? "fixture-one" : null,
    accountId,
    sourceKind === "aws_trust_role"
      ? `arn:aws:iam::${accountId}:role/SutraCollectorRole`
      : "",
    status,
  );
}

async function withRepository(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-source-ledger-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
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
      connection(database, {
        id: CONNECTION_A,
        orgId: ORG_A,
        customerId: CUSTOMER_A,
        accountId: "111122223333",
      }),
      connection(database, {
        id: CONNECTION_B,
        orgId: ORG_B,
        customerId: CUSTOMER_B,
        accountId: "444455556666",
      }),
      connection(database, {
        id: FIXTURE,
        orgId: ORG_A,
        customerId: CUSTOMER_A,
        sourceKind: "simulated_fixture",
        accountId: "999900001111",
      }),
      connection(database, {
        id: DISABLED,
        orgId: ORG_A,
        customerId: CUSTOMER_A,
        status: "disabled",
        accountId: "999900002222",
      }),
    ]);
    await run(new FinopsSourceJobLedgerRepository(database), database);
  } finally {
    await miniflare.dispose();
  }
}

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof FinopsSourceJobLedgerRepositoryError);
    assert.equal(error.code, code);
    return true;
  };
}

test("attempt lifecycle is idempotent, contiguous, bounded, and summarized from durable evidence", async () => {
  await withRepository(async (repository) => {
    const queued = await repository.queueAttempt(SCOPE_A, {
      ...IDENTITY,
      idempotencyKey: "cur-july-attempt-1",
      queuedAtIso: "2026-07-30T00:00:00.000Z",
    }, 1_722_297_600_000);
    assert.equal(queued.status, "queued");
    assert.equal(queued.queueWaitMs, null);
    assert.deepEqual(
      await repository.queueAttempt(SCOPE_A, {
        ...IDENTITY,
        idempotencyKey: "cur-july-attempt-1",
        queuedAtIso: "2026-07-30T00:00:00.000Z",
      }, 1_722_297_600_999),
      queued,
    );

    await assert.rejects(
      repository.queueAttempt(SCOPE_A, {
        ...IDENTITY,
        jobId: "different-job",
        idempotencyKey: "cur-july-attempt-1",
        queuedAtIso: "2026-07-30T00:00:00.000Z",
      }),
      expectCode("IDEMPOTENCY_CONFLICT"),
    );
    await assert.rejects(
      repository.queueAttempt(SCOPE_A, {
        ...IDENTITY,
        attempt: 2,
        idempotencyKey: "cur-july-attempt-2",
        queuedAtIso: "2026-07-30T00:02:00.000Z",
      }),
      expectCode("ATTEMPT_SEQUENCE_CONFLICT"),
    );

    const running = await repository.startAttempt(
      SCOPE_A,
      IDENTITY,
      "2026-07-30T00:00:05.000Z",
    );
    assert.equal(running.status, "running");
    assert.equal(running.queueWaitMs, 5_000);
    assert.deepEqual(
      await repository.startAttempt(
        SCOPE_A,
        IDENTITY,
        "2026-07-30T00:00:05.000Z",
      ),
      running,
    );

    const failed = await repository.finishAttempt(SCOPE_A, IDENTITY, {
      status: "failed",
      finishedAtIso: "2026-07-30T00:01:05.000Z",
      acceptedRecords: 80,
      rejectedRecords: 10,
      expectedRecords: 100,
      processedBytes: 4_096,
      reconciliation: {
        outcome: "mismatched",
        evidenceReference: "evidence://cur/2026-07/reconciliation",
      },
      errorCode: "RECONCILIATION_FAILED",
    });
    assert.equal(failed.durationMs, 60_000);
    assert.equal(failed.totalDurationMs, 65_000);
    assert.deepEqual(failed.error, {
      code: "RECONCILIATION_FAILED",
      message: "Collected data did not pass reconciliation",
    });

    const secondIdentity = { ...IDENTITY, attempt: 2 };
    await repository.queueAttempt(SCOPE_A, {
      ...secondIdentity,
      idempotencyKey: "cur-july-attempt-2",
      queuedAtIso: "2026-07-30T00:02:00.000Z",
    });
    await repository.startAttempt(
      SCOPE_A,
      secondIdentity,
      "2026-07-30T00:02:03.000Z",
    );
    const succeeded = await repository.finishAttempt(
      SCOPE_A,
      secondIdentity,
      {
        status: "succeeded",
        finishedAtIso: "2026-07-30T00:03:00.000Z",
        acceptedRecords: 100,
        rejectedRecords: 0,
        expectedRecords: 100,
        processedBytes: 8_192,
        reconciliation: {
          outcome: "matched",
          evidenceReference: "evidence://cur/2026-07/reconciliation-2",
        },
      },
    );
    assert.equal(succeeded.error, null);
    assert.deepEqual(
      await repository.finishAttempt(SCOPE_A, secondIdentity, {
        status: "succeeded",
        finishedAtIso: "2026-07-30T00:03:00.000Z",
        acceptedRecords: 100,
        rejectedRecords: 0,
        expectedRecords: 100,
        processedBytes: 8_192,
        reconciliation: {
          outcome: "matched",
          evidenceReference: "evidence://cur/2026-07/reconciliation-2",
        },
      }),
      succeeded,
    );

    const summary = await repository.summarize(
      SCOPE_A,
      "aws_cur2_data_export",
    );
    assert.equal(summary.sources.length, 1);
    assert.deepEqual(summary.sources[0].statuses, {
      queued: 0,
      running: 0,
      succeeded: 1,
      partial: 0,
      failed: 1,
      cancelled: 0,
    });
    assert.equal(summary.sources[0].attempts, 2);
    assert.equal(summary.sources[0].latestAttempt.attempt, 2);
    assert.equal(
      summary.sources[0].lastSuccessAtIso,
      "2026-07-30T00:03:00.000Z",
    );
  });
});

test("reads are tenant-isolated, fixture/disabled scopes fail closed, and cursors are scope-bound", async () => {
  await withRepository(async (repository) => {
    for (const [index, sourceId] of [
      "aws_cur2_data_export",
      "aws_budgets",
      "aws_health_organization",
    ].entries()) {
      await repository.queueAttempt(SCOPE_A, {
        sourceId,
        jobId: `source-job-${index}`,
        attempt: 1,
        idempotencyKey: `source-page-${index}`,
        queuedAtIso: `2026-07-30T00:0${index}:00.000Z`,
      });
    }
    const first = await repository.listAttempts(SCOPE_A, { limit: 2 });
    assert.equal(first.attempts.length, 2);
    assert.notEqual(first.nextCursor, null);
    const second = await repository.listAttempts(SCOPE_A, {
      limit: 2,
      cursor: first.nextCursor,
    });
    assert.equal(second.attempts.length, 1);
    assert.equal(second.nextCursor, null);
    assert.equal(
      new Set([...first.attempts, ...second.attempts].map((row) => row.jobId))
        .size,
      3,
    );

    assert.equal(await repository.getAttempt(SCOPE_B, IDENTITY), null);
    assert.deepEqual((await repository.summarize(SCOPE_B)).sources, []);
    await assert.rejects(
      repository.listAttempts(SCOPE_B, {
        limit: 2,
        cursor: first.nextCursor,
      }),
      expectCode("INVALID_INPUT"),
    );
    await assert.rejects(
      repository.listAttempts({
        organizationId: ORG_B,
        customerId: CUSTOMER_B,
        connectionId: CONNECTION_A,
      }),
      expectCode("SCOPE_NOT_FOUND"),
    );
    await assert.rejects(
      repository.listAttempts({ ...SCOPE_A, connectionId: FIXTURE }),
      expectCode("SCOPE_NOT_FOUND"),
    );
    await assert.rejects(
      repository.listAttempts({ ...SCOPE_A, connectionId: DISABLED }),
      expectCode("SCOPE_NOT_FOUND"),
    );
    await assert.rejects(
      repository.listAttempts(SCOPE_A, { limit: 101 }),
      expectCode("INVALID_INPUT"),
    );
  });
});

test("database guards reject identity mutation, lifecycle skips, deletes, and provider error text", async () => {
  await withRepository(async (repository, database) => {
    await repository.queueAttempt(SCOPE_A, {
      ...IDENTITY,
      idempotencyKey: "guard-attempt-1",
      queuedAtIso: "2026-07-30T00:00:00.000Z",
    });
    await assert.rejects(
      database.prepare(
        `UPDATE finops_source_job_attempts
            SET job_id = 'mutated'
          WHERE org_id = ? AND customer_id = ? AND connection_id = ?
            AND source_id = ? AND job_id = ? AND attempt = 1`,
      ).bind(
        ORG_A,
        CUSTOMER_A,
        CONNECTION_A,
        IDENTITY.sourceId,
        IDENTITY.jobId,
      ).run(),
      /FINOPS_SOURCE_JOB_IDENTITY_IMMUTABLE/u,
    );
    await assert.rejects(
      database.prepare(
        `UPDATE finops_source_job_attempts
            SET status = 'succeeded',
                started_at = '2026-07-30T00:00:01.000Z',
                finished_at = '2026-07-30T00:00:02.000Z'
          WHERE org_id = ? AND customer_id = ? AND connection_id = ?
            AND source_id = ? AND job_id = ? AND attempt = 1`,
      ).bind(
        ORG_A,
        CUSTOMER_A,
        CONNECTION_A,
        IDENTITY.sourceId,
        IDENTITY.jobId,
      ).run(),
      /FINOPS_SOURCE_JOB_INVALID_TRANSITION/u,
    );
    await repository.startAttempt(
      SCOPE_A,
      IDENTITY,
      "2026-07-30T00:00:01.000Z",
    );
    await assert.rejects(
      database.prepare(
        `UPDATE finops_source_job_attempts
            SET status = 'failed',
                finished_at = '2026-07-30T00:00:02.000Z',
                error_code = 'INTERNAL_ERROR',
                error_message = 'AccessKeyId=provider-secret-detail'
          WHERE org_id = ? AND customer_id = ? AND connection_id = ?
            AND source_id = ? AND job_id = ? AND attempt = 1`,
      ).bind(
        ORG_A,
        CUSTOMER_A,
        CONNECTION_A,
        IDENTITY.sourceId,
        IDENTITY.jobId,
      ).run(),
      /CHECK constraint failed/u,
    );
    await assert.rejects(
      database.prepare(
        `UPDATE finops_source_job_attempts
            SET status = 'failed',
                finished_at = '2026-07-30T00:00:02.000Z',
                error_code = 'INTERNAL_ERROR',
                error_message = NULL
          WHERE org_id = ? AND customer_id = ? AND connection_id = ?
            AND source_id = ? AND job_id = ? AND attempt = 1`,
      ).bind(
        ORG_A,
        CUSTOMER_A,
        CONNECTION_A,
        IDENTITY.sourceId,
        IDENTITY.jobId,
      ).run(),
      /CHECK constraint failed/u,
    );
    await assert.rejects(
      database.prepare(
        `DELETE FROM finops_source_job_attempts
          WHERE org_id = ? AND customer_id = ? AND connection_id = ?
            AND source_id = ? AND job_id = ? AND attempt = 1`,
      ).bind(
        ORG_A,
        CUSTOMER_A,
        CONNECTION_A,
        IDENTITY.sourceId,
        IDENTITY.jobId,
      ).run(),
      /FINOPS_SOURCE_JOB_ATTEMPT_IMMUTABLE/u,
    );
  });
});
