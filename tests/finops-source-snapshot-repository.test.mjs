import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const {
  FinopsSourceJobLedgerRepository,
} = await import("../db/finops-source-job-ledger-repository.ts");
const {
  FinopsSourceSnapshotRepository,
  FinopsSourceSnapshotRepositoryError,
} = await import("../db/finops-source-snapshot-repository.ts");

const ORG_A = "org_snapshot_a";
const ORG_B = "org_snapshot_b";
const CUSTOMER_A = "customer_snapshot_a";
const CUSTOMER_B = "customer_snapshot_b";
const CONNECTION_A = `conn_${"a".repeat(32)}`;
const CONNECTION_B = `conn_${"b".repeat(32)}`;
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
const SOURCE_ID = "aws_cur2_data_export";
const SEALED_REFERENCE = `fsev1.${"A".repeat(40)}`;

function connection(database, id, orgId, customerId, accountId) {
  return database.prepare(
    `INSERT INTO aws_connections (
       id, org_id, customer_id, source_kind, aws_account_id, role_arn,
       external_id_ciphertext, external_id_key_version,
       permission_pack_version, status
     ) VALUES (?, ?, ?, 'aws_trust_role', ?, ?, 'ciphertext', 'v1', 'pack-v1', 'active')`,
  ).bind(
    id,
    orgId,
    customerId,
    accountId,
    `arn:aws:iam::${accountId}:role/SutraCollectorRole`,
  );
}

async function withRepositories(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-source-snapshot-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status) VALUES (?, 'snap-a', 'Snapshot A', 'active')",
      ).bind(ORG_A),
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status) VALUES (?, 'snap-b', 'Snapshot B', 'active')",
      ).bind(ORG_B),
      database.prepare(
        "INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'snap-ca', 'Snapshot CA', 'active')",
      ).bind(CUSTOMER_A, ORG_A),
      database.prepare(
        "INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'snap-cb', 'Snapshot CB', 'active')",
      ).bind(CUSTOMER_B, ORG_B),
      connection(database, CONNECTION_A, ORG_A, CUSTOMER_A, "111122223333"),
      connection(database, CONNECTION_B, ORG_B, CUSTOMER_B, "444455556666"),
    ]);
    await run({
      database,
      jobs: new FinopsSourceJobLedgerRepository(database),
      snapshots: new FinopsSourceSnapshotRepository(database),
    });
  } finally {
    await miniflare.dispose();
  }
}

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof FinopsSourceSnapshotRepositoryError);
    assert.equal(error.code, code);
    return true;
  };
}

async function terminalAttempt(jobs, scope, {
  attempt,
  status,
  queuedAtIso,
  accepted,
  rejected,
  expected = null,
  outcome,
}) {
  const identity = { sourceId: SOURCE_ID, jobId: "cur-july", attempt };
  await jobs.queueAttempt(scope, {
    ...identity,
    idempotencyKey: `cur-july-${attempt}`,
    queuedAtIso,
  });
  const startedAtIso = new Date(Date.parse(queuedAtIso) + 1_000).toISOString();
  const finishedAtIso = new Date(Date.parse(queuedAtIso) + 2_000).toISOString();
  await jobs.startAttempt(scope, identity, startedAtIso);
  await jobs.finishAttempt(scope, identity, {
    status,
    finishedAtIso,
    acceptedRecords: accepted,
    rejectedRecords: rejected,
    expectedRecords: expected,
    reconciliation: outcome === null
      ? null
      : {
          outcome,
          evidenceReference: `evidence://source-snapshot/attempt-${attempt}`,
        },
    errorCode: status === "failed" ? "RECONCILIATION_FAILED" : null,
  });
}

function snapshotInput({
  digit,
  attempt,
  status = "complete",
  collectedAtIso,
  dataThroughAtIso,
  coverage = {
    assessment: "complete",
    expected: null,
    observed: 7,
    missing: null,
  },
  reconciliation = {
    expected: null,
    accepted: 7,
    rejected: 0,
    outcome: "matched",
  },
}) {
  return {
    generationId: `fss_${digit.repeat(64)}`,
    sourceId: SOURCE_ID,
    jobId: "cur-july",
    attempt,
    status,
    contentSha256: digit.repeat(64),
    schemaVersion: "cur2-2026-07.1",
    collectedAtIso,
    dataThroughAtIso,
    coverage,
    reconciliation,
    evidenceReference: {
      ciphertext: SEALED_REFERENCE,
      keyVersion: "finops-evidence-key-v1",
    },
  };
}

test("only fresh, fully covered and reconciled generations atomically advance the active head", async () => {
  await withRepositories(async ({ database, jobs, snapshots }) => {
    await terminalAttempt(jobs, SCOPE_A, {
      attempt: 1,
      status: "succeeded",
      queuedAtIso: "2026-07-30T00:00:00.000Z",
      accepted: 7,
      rejected: 0,
      outcome: "matched",
    });
    const firstInput = snapshotInput({
      digit: "1",
      attempt: 1,
      collectedAtIso: "2026-07-30T01:00:00.000Z",
      dataThroughAtIso: "2026-07-30T00:00:00.000Z",
    });
    const first = await snapshots.recordSnapshot(
      SCOPE_A,
      firstInput,
      Date.parse("2026-07-30T01:01:00.000Z"),
    );
    assert.equal(first.becameActive, true);
    assert.equal(first.activeGenerationId, firstInput.generationId);

    const retry = await snapshots.recordSnapshot(
      SCOPE_A,
      firstInput,
      Date.parse("2026-07-31T01:01:00.000Z"),
    );
    assert.equal(retry.becameActive, false);
    assert.equal(retry.snapshot.createdAtIso, "2026-07-30T01:01:00.000Z");

    await terminalAttempt(jobs, SCOPE_A, {
      attempt: 2,
      status: "partial",
      queuedAtIso: "2026-07-30T02:00:00.000Z",
      accepted: 5,
      rejected: 2,
      expected: 7,
      outcome: "mismatched",
    });
    const partial = await snapshots.recordSnapshot(SCOPE_A, snapshotInput({
      digit: "2",
      attempt: 2,
      status: "partial",
      collectedAtIso: "2026-07-30T03:00:00.000Z",
      dataThroughAtIso: "2026-07-30T02:00:00.000Z",
      coverage: {
        assessment: "partial",
        expected: 7,
        observed: 5,
        missing: 2,
      },
      reconciliation: {
        expected: 7,
        accepted: 5,
        rejected: 2,
        outcome: "mismatched",
      },
    }), Date.parse("2026-07-30T03:01:00.000Z"));
    assert.equal(partial.becameActive, false);
    assert.equal(partial.activeGenerationId, firstInput.generationId);

    await terminalAttempt(jobs, SCOPE_A, {
      attempt: 3,
      status: "failed",
      queuedAtIso: "2026-07-30T04:00:00.000Z",
      accepted: 0,
      rejected: 1,
      expected: 1,
      outcome: "mismatched",
    });
    const failed = await snapshots.recordSnapshot(SCOPE_A, snapshotInput({
      digit: "3",
      attempt: 3,
      status: "failed",
      collectedAtIso: "2026-07-30T05:00:00.000Z",
      dataThroughAtIso: "2026-07-30T04:00:00.000Z",
      coverage: {
        assessment: "unknown",
        expected: null,
        observed: 0,
        missing: null,
      },
      reconciliation: {
        expected: 1,
        accepted: 0,
        rejected: 1,
        outcome: "mismatched",
      },
    }), Date.parse("2026-07-30T05:01:00.000Z"));
    assert.equal(failed.becameActive, false);

    await terminalAttempt(jobs, SCOPE_A, {
      attempt: 4,
      status: "succeeded",
      queuedAtIso: "2026-07-30T06:00:00.000Z",
      accepted: 7,
      rejected: 0,
      outcome: "matched",
    });
    const staleReady = await snapshots.recordSnapshot(SCOPE_A, snapshotInput({
      digit: "4",
      attempt: 4,
      status: "ready",
      collectedAtIso: "2026-07-30T07:00:00.000Z",
      dataThroughAtIso: "2026-07-29T23:00:00.000Z",
    }), Date.parse("2026-07-30T07:01:00.000Z"));
    assert.equal(staleReady.becameActive, false);
    assert.equal(staleReady.activeGenerationId, firstInput.generationId);

    await terminalAttempt(jobs, SCOPE_A, {
      attempt: 5,
      status: "succeeded",
      queuedAtIso: "2026-07-30T08:00:00.000Z",
      accepted: 9,
      rejected: 0,
      outcome: "matched",
    });
    const latestInput = snapshotInput({
      digit: "5",
      attempt: 5,
      status: "ready",
      collectedAtIso: "2026-07-30T09:00:00.000Z",
      dataThroughAtIso: "2026-07-30T08:00:00.000Z",
      coverage: {
        assessment: "complete",
        expected: null,
        observed: 9,
        missing: null,
      },
      reconciliation: {
        expected: null,
        accepted: 9,
        rejected: 0,
        outcome: "matched",
      },
    });
    const latest = await snapshots.recordSnapshot(
      SCOPE_A,
      latestInput,
      Date.parse("2026-07-30T09:01:00.000Z"),
    );
    assert.equal(latest.becameActive, true);
    assert.equal(latest.activeGenerationId, latestInput.generationId);

    const active = await snapshots.getActiveSnapshot(SCOPE_A, SOURCE_ID);
    assert.equal(active?.generationId, latestInput.generationId);
    assert.equal(active?.activeGenerationId, latestInput.generationId);
    assert.equal(active?.committedAtIso, "2026-07-30T09:01:00.000Z");
    assert.deepEqual(active?.coverage, latestInput.coverage);
    assert.deepEqual(active?.reconciliation, latestInput.reconciliation);
    assert.deepEqual(active?.evidenceReference, latestInput.evidenceReference);
    assert.deepEqual(
      (await snapshots.listActiveSnapshots(SCOPE_A)).map((entry) => entry.sourceId),
      [SOURCE_ID],
    );
    assert.deepEqual(await snapshots.listActiveSnapshots(SCOPE_B), []);
    await assert.rejects(
      snapshots.listActiveSnapshots(SCOPE_A, { limit: 101 }),
      expectCode("INVALID_INPUT"),
    );

    await assert.rejects(
      database.prepare(
        "UPDATE finops_source_snapshots SET schema_version = 'changed' WHERE generation_id = ?",
      ).bind(latestInput.generationId).run(),
      /FINOPS_SOURCE_SNAPSHOT_IMMUTABLE/u,
    );
    await assert.rejects(
      database.prepare(
        "DELETE FROM finops_source_snapshot_heads WHERE active_generation_id = ?",
      ).bind(latestInput.generationId).run(),
      /FINOPS_SOURCE_SNAPSHOT_HEAD_IMMUTABLE/u,
    );
  });
});

test("cross-tenant attempts, incomplete acceptance, raw evidence references, and generation mutation are rejected", async () => {
  await withRepositories(async ({ jobs, snapshots }) => {
    await terminalAttempt(jobs, SCOPE_B, {
      attempt: 1,
      status: "succeeded",
      queuedAtIso: "2026-07-30T00:00:00.000Z",
      accepted: 7,
      rejected: 0,
      outcome: "matched",
    });
    const candidate = snapshotInput({
      digit: "a",
      attempt: 1,
      collectedAtIso: "2026-07-30T01:00:00.000Z",
      dataThroughAtIso: "2026-07-30T00:00:00.000Z",
    });
    await assert.rejects(
      snapshots.recordSnapshot(SCOPE_A, candidate),
      expectCode("ATTEMPT_NOT_ACCEPTED"),
    );

    await terminalAttempt(jobs, SCOPE_A, {
      attempt: 1,
      status: "succeeded",
      queuedAtIso: "2026-07-30T00:00:00.000Z",
      accepted: 7,
      rejected: 0,
      outcome: "matched",
    });
    await assert.rejects(
      snapshots.recordSnapshot(SCOPE_A, {
        ...candidate,
        evidenceReference: {
          ciphertext: "s3://private-bucket/raw-provider-payload.json",
          keyVersion: "finops-evidence-key-v1",
        },
      }),
      expectCode("INVALID_INPUT"),
    );
    await assert.rejects(
      snapshots.recordSnapshot(SCOPE_A, {
        ...candidate,
        coverage: {
          assessment: "unknown",
          expected: null,
          observed: 7,
          missing: null,
        },
      }),
      expectCode("INVALID_INPUT"),
    );

    const stored = await snapshots.recordSnapshot(
      SCOPE_A,
      candidate,
      Date.parse("2026-07-30T01:01:00.000Z"),
    );
    assert.equal(stored.becameActive, true);
    await assert.rejects(
      snapshots.recordSnapshot(SCOPE_A, {
        ...candidate,
        contentSha256: "b".repeat(64),
      }),
      expectCode("IMMUTABLE_GENERATION_CONFLICT"),
    );
  });
});
