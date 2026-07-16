import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

const databaseUrl = process.env.SUTRA_POSTGRES_RUNTIME_TEST_URL?.trim();
if (!databaseUrl) throw new Error("SUTRA_POSTGRES_RUNTIME_TEST_URL is required");
process.env.DATABASE_URL = databaseUrl;
register(new URL("./cloudflare-loader.mjs", import.meta.url));

const authRepository = await import("../db/auth-repository.ts");
const localOperations = await import("../db/local-operations-repository.ts");
const outboxRepository = await import("../db/local-schedule-outbox-repository.ts");
const pilotRepository = await import("../db/pilot-repository.ts");
const { closePostgresDatabase } = await import("../db/postgres-d1-adapter.ts");
const { computeSnapshotSha256 } = await import("../lib/pilot-boundary.ts");
const authCrypto = await import("../lib/local-auth-crypto.ts");

const fixture = {
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

test("real PostgreSQL repositories persist auth, CMDB publication, and concurrent outbox order", async () => {
  try {
    const bootstrapped = await authRepository.bootstrapLocalAdmin({
      email: "postgres-repository@sutra.invalid",
      password: "Postgres repository acceptance passphrase 2026!",
      displayName: "Postgres Repository",
      organizationName: "Sutra PostgreSQL Test",
    });
    assert.equal(bootstrapped.session.session.user.email, "postgres-repository@sutra.invalid");
    assert.equal(await authRepository.isLocalBootstrapRequired(), false);

    const mfaNow = 59_000;
    const mfaSecrets = {
      encryptionKey: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
      keyVersion: "postgres-auth-test-v1",
    };
    const sealedTotp = await authCrypto.sealTotpSecret(
      "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      mfaSecrets.encryptionKey,
      mfaSecrets.keyVersion,
      bootstrapped.session.subject.userId,
    );
    const rawDatabase = (await import("../db/index.ts")).getRawDb();
    await rawDatabase.prepare(
      `INSERT INTO totp_credentials
        (user_id, secret_ciphertext, secret_key_version, confirmed_at,
         last_used_step, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).bind(
      bootstrapped.session.subject.userId,
      sealedTotp.ciphertext,
      sealedTotp.keyVersion,
      mfaNow - 1,
      mfaNow - 1,
      mfaNow - 1,
    ).run();
    const firstMfaSession = await authRepository.getLocalSession(bootstrapped.token, mfaNow);
    assert.ok(firstMfaSession);
    const secondToken = authCrypto.generateSessionToken();
    const secondDigest = await authCrypto.digestSessionToken(secondToken);
    await rawDatabase.prepare(
      `INSERT INTO local_sessions
        (id, token_digest, user_id, selected_org_id, created_at, expires_at,
         last_seen_at, mfa_verified_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).bind(
      `sess_${"2".repeat(32)}`,
      secondDigest,
      firstMfaSession.subject.userId,
      firstMfaSession.subject.orgId,
      mfaNow,
      mfaNow + authRepository.LOCAL_SESSION_TTL_MS,
      mfaNow,
    ).run();
    const secondMfaSession = await authRepository.getLocalSession(secondToken, mfaNow);
    assert.ok(secondMfaSession);
    const stepUpResults = await Promise.allSettled([
      authRepository.verifyTotpStepUp(firstMfaSession, "287082", mfaSecrets, mfaNow),
      authRepository.verifyTotpStepUp(secondMfaSession, "287082", mfaSecrets, mfaNow),
    ]);
    assert.equal(stepUpResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(stepUpResults.filter((result) => result.status === "rejected").length, 1);
    assert.equal(
      (await rawDatabase.prepare(
        "SELECT COUNT(*) AS count FROM local_sessions WHERE user_id = ? AND mfa_verified_at = ?",
      ).bind(firstMfaSession.subject.userId, mfaNow).first())?.count,
      1,
    );

    const now = new Date().toISOString();
    const jobId = `job_${"a".repeat(48)}`;
    const unsigned = {
      schemaVersion: "sutra.inventory.v1",
      jobId,
      connectionId: fixture.connectionId,
      accountId: fixture.accountId,
      partition: "aws",
      roleSessionName: "sutra-postgres-repository-test",
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
    const publication = await localOperations.publishLocalFixtureJob({
      fixture,
      actorId: bootstrapped.session.subject.userId,
      allowProvisioning: true,
      result: {
        job: {
          jobId,
          tenantId: fixture.tenantId,
          kind: "fixture.inventory.collect",
          fixtureId: fixture.fixtureId,
          customerId: fixture.customerId,
          connectionId: fixture.connectionId,
          version: "2026.07.0",
          triggerKind: "manual",
          scheduleId: null,
          status: "succeeded",
          attempts: 1,
          maxAttempts: 5,
          availableAt: now,
          createdAt: now,
          updatedAt: now,
          completedAt: now,
          lastFailure: null,
        },
        fixtureId: fixture.fixtureId,
        version: "2026.07.0",
        customerId: fixture.customerId,
        connectionId: fixture.connectionId,
        tenantId: fixture.tenantId,
        snapshot: { ...unsigned, snapshotSha256: await computeSnapshotSha256(unsigned) },
      },
    });
    assert.equal(publication.jobId, jobId);
    assert.equal(publication.scheduleId, null);

    const firstRunAt = "2026-07-16T06:00:00.000Z";
    const inputs = ["0", "1", "2", "3", "4", "5", "6", "7"].map((character) => ({
      operationId: `schedop_${character.repeat(48)}`,
      orgId: pilotRepository.LOCAL_ORG_ID,
      actorId: bootstrapped.session.subject.userId,
      customerId: null,
      scheduleId: `sched_${character.repeat(48)}`,
      fixtureId: fixture.fixtureId,
      connectionId: `conn_${character.repeat(32)}`,
      operationKind: "upsert",
      command: {
        fixtureId: fixture.fixtureId,
        version: "2026.07.0",
        everyMs: 300_000,
        enabled: true,
        firstRunAt,
      },
    }));
    const mutations = await Promise.all(inputs.map((input) =>
      outboxRepository.beginLocalScheduleMutation(input)));
    const sequences = mutations.map((mutation) => mutation.mutationSequence);
    assert.equal(new Set(sequences).size, inputs.length);
    assert.ok(sequences.every((sequence) => Number.isSafeInteger(sequence) && sequence > 0));
  } finally {
    await closePostgresDatabase();
  }
});
