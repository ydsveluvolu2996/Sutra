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
const caseRepository = await import("../db/case-repository.ts");
const complianceExceptionRepository = await import("../db/compliance-exception-repository.ts");
const invitationRepository = await import("../db/identity-invitation-repository.ts");
const { UptimeRepository } = await import("../db/uptime-repository.ts");
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

    const inviteNow = Date.now();
    const creationInput = {
      email: `postgres-invite-${crypto.randomUUID()}@example.com`,
      role: "viewer",
      scopeMode: "assigned_customers",
      lifetimeMs: 60 * 60 * 1_000,
    };
    const creationKey = "postgres-create-key-000000000000001";
    const competingCreations = await Promise.all([
      invitationRepository.createIdentityInvitationIdempotently(
        bootstrapped.session,
        { mode: "org" },
        creationInput,
        creationKey,
        inviteNow,
      ),
      invitationRepository.createIdentityInvitationIdempotently(
        bootstrapped.session,
        { mode: "org" },
        creationInput,
        creationKey,
        inviteNow,
      ),
    ]);
    assert.equal(competingCreations.filter((result) => result.replayed === false).length, 1);
    assert.equal(competingCreations.filter((result) => result.replayed === true).length, 1);
    assert.equal(competingCreations.filter((result) => result.token !== null).length, 1);
    assert.equal(new Set(competingCreations.map((result) => result.invitation.id)).size, 1);
    const invitation = competingCreations[0];
    const firstInviteKey = "postgres-resend-key-000000000000001";
    const secondInviteKey = "postgres-resend-key-000000000000002";
    await invitationRepository.beginIdentityInvitationDelivery(
      bootstrapped.session,
      { mode: "org" },
      {
        invitationId: invitation.invitation.id,
        idempotencyKey: firstInviteKey,
        rotateToken: true,
        lifetimeMs: 60 * 60 * 1_000,
      },
      inviteNow + 1,
    );
    await invitationRepository.completeIdentityInvitationDelivery(
      bootstrapped.session,
      { mode: "org" },
      invitation.invitation.id,
      firstInviteKey,
      { status: "accepted", transport: "email-api", provider: "zoho", errorCode: null, httpStatus: 202 },
      inviteNow + 2,
    );
    await invitationRepository.beginIdentityInvitationDelivery(
      bootstrapped.session,
      { mode: "org" },
      {
        invitationId: invitation.invitation.id,
        idempotencyKey: secondInviteKey,
        rotateToken: true,
        lifetimeMs: 2 * 60 * 60 * 1_000,
      },
      inviteNow + 3,
    );
    await invitationRepository.completeIdentityInvitationDelivery(
      bootstrapped.session,
      { mode: "org" },
      invitation.invitation.id,
      secondInviteKey,
      { status: "failed", transport: "email-api", provider: "resend", errorCode: "PROVIDER_REJECTED", httpStatus: 400 },
      inviteNow + 4,
    );
    const historicalReplay = await invitationRepository.beginIdentityInvitationDelivery(
      bootstrapped.session,
      { mode: "org" },
      {
        invitationId: invitation.invitation.id,
        idempotencyKey: firstInviteKey,
        rotateToken: true,
        lifetimeMs: 60 * 60 * 1_000,
      },
      inviteNow + 5,
    );
    assert.equal(historicalReplay.replayed, true);
    assert.equal(historicalReplay.token, null);
    await assert.rejects(
      invitationRepository.beginIdentityInvitationDelivery(
        bootstrapped.session,
        { mode: "org" },
        {
          invitationId: invitation.invitation.id,
          idempotencyKey: firstInviteKey,
          rotateToken: true,
          lifetimeMs: 3 * 60 * 60 * 1_000,
        },
        inviteNow + 6,
      ),
      (error) => error?.status === 409,
    );
    const invitationLedger = await (await import("../db/index.ts")).getRawDb().prepare(
      `SELECT operation_status, outcome_status FROM identity_invitation_operations
        WHERE invitation_id = ? ORDER BY created_at, id`,
    ).bind(invitation.invitation.id).all();
    assert.deepEqual(invitationLedger.results, [
      { operation_status: "completed", outcome_status: null },
      { operation_status: "completed", outcome_status: "accepted" },
      { operation_status: "completed", outcome_status: "failed" },
    ]);

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
    const uptimeRepository = new UptimeRepository(rawDatabase);
    const uptimeSlot = Date.parse("2026-07-22T06:00:00.000Z");
    const uptimeSamples = ["web-app", "database", "job-runner", "collector"].map((component) => ({
      component,
      healthy: true,
      detail: "PostgreSQL platform probe acceptance",
    }));
    assert.equal(await uptimeRepository.recordSamples(uptimeSamples, uptimeSlot, uptimeSlot), 4);
    assert.equal(await uptimeRepository.recordSamples(uptimeSamples, uptimeSlot + 1_000, uptimeSlot), 0);
    assert.equal(await uptimeRepository.hasCompleteProbeSlot(uptimeSlot), true);
    assert.equal(await uptimeRepository.pruneBefore(uptimeSlot - 1), 0);
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

    const findingFingerprint = `pg-workflow-${crypto.randomUUID().replaceAll("-", "")}`;
    const findingId = `finding_${crypto.randomUUID().replaceAll("-", "")}`;
    await rawDatabase.prepare(
      `INSERT INTO cmdb_findings
        (id, snapshot_id, org_id, customer_id, connection_id, resource_key,
         control_key, control_version, fingerprint, severity, status, title,
         summary, remediation, evidence_json, evaluated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, '1.0.0', ?, 'high', 'open', ?, ?, ?, '{}', ?)`,
    ).bind(
      findingId,
      publication.snapshotId,
      pilotRepository.LOCAL_ORG_ID,
      fixture.customerId,
      fixture.connectionId,
      "SUTRA.AWS.EC2.PUBLIC_IP",
      findingFingerprint,
      "PostgreSQL workflow finding",
      "Acceptance evidence for atomic workflow audit",
      "Remove the test exposure",
      Date.now(),
    ).run();
    const createdCase = await caseRepository.createFindingCase({
      orgId: pilotRepository.LOCAL_ORG_ID,
      customerId: fixture.customerId,
      connectionId: fixture.connectionId,
      fingerprint: findingFingerprint,
      priority: "high",
      assigneeMembershipId: bootstrapped.session.subject.membershipId,
      dueAt: null,
      actorUserId: bootstrapped.session.subject.userId,
    });
    const notedCase = await caseRepository.addCaseNote({
      orgId: pilotRepository.LOCAL_ORG_ID,
      customerId: fixture.customerId,
      connectionId: fixture.connectionId,
      caseId: createdCase.id,
      actorUserId: bootstrapped.session.subject.userId,
      note: "Atomic case note and audit acceptance",
    });
    assert.equal(notedCase.activities.length, 2);

    const requestedException = await complianceExceptionRepository.createComplianceException({
      orgId: pilotRepository.LOCAL_ORG_ID,
      customerId: fixture.customerId,
      connectionId: fixture.connectionId,
      controlKey: "SUTRA.AWS.EC2.PUBLIC_IP",
      findingFingerprint,
      ownerUserId: bootstrapped.session.subject.userId,
      requestedBy: bootstrapped.session.subject.userId,
      rationale: "The acceptance database needs a governed exception workflow test.",
      compensatingControl: "The isolated test database contains no customer workload or network path.",
      expiresAt: Date.now() + 24 * 60 * 60 * 1_000,
    });
    const approvedException = await complianceExceptionRepository.reviewComplianceException({
      orgId: pilotRepository.LOCAL_ORG_ID,
      customerId: fixture.customerId,
      connectionId: fixture.connectionId,
      exceptionId: requestedException.id,
      actorId: bootstrapped.session.subject.userId,
      action: "approved",
      reviewNote: "Single-owner PostgreSQL acceptance approval",
      selfReviewed: true,
    });
    assert.equal(approvedException.status, "approved");
    const workflowAudits = await rawDatabase.prepare(
      `SELECT action FROM audit_events
        WHERE org_id = ? AND customer_id = ?
          AND action IN (
            'finding.case.create', 'finding.case.note',
            'compliance.exception.requested', 'compliance.exception.approved'
          )
        ORDER BY occurred_at, id`,
    ).bind(pilotRepository.LOCAL_ORG_ID, fixture.customerId).all();
    assert.deepEqual(workflowAudits.results.map((row) => row.action), [
      "finding.case.create",
      "finding.case.note",
      "compliance.exception.requested",
      "compliance.exception.approved",
    ]);

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
