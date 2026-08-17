import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const { deriveScopedAwsConnectionIdentity } = await import("../lib/aws-pilot-security.ts");
const pilotRepository = await import("../db/pilot-repository.ts");
const runtimeMigrations = await import("../db/runtime-migrations.ts");

const ORG = "org_static_credentials_alpha";
const ACCOUNT = "123456789012";

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-static-credentials-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.prepare(
      "INSERT INTO organizations (id, slug, name, status) VALUES (?, 'static-alpha', 'Static Alpha', 'active')",
    ).bind(ORG).run();
    await run(database);
  } finally {
    await miniflare.dispose();
  }
}

async function staticDraftInput(marker) {
  const identity = await deriveScopedAwsConnectionIdentity(ORG, ACCOUNT, "aws");
  return {
    orgId: ORG,
    sourceKind: "aws_static_credentials",
    actorId: `usr_static_${marker}`,
    operationId: `onb_${marker.repeat(32)}`,
    ...identity,
    customerName: `Static ${marker}`,
    customerSlug: `static-${marker}-${identity.customerId.slice(-8)}`,
    accountId: ACCOUNT,
    partition: "aws",
    enabledRegions: ["us-east-1"],
    externalIdCiphertext: `encrypted-external-id-material-${marker.repeat(8)}`,
    externalIdKeyVersion: "test-key-v1",
    roleProvisioningMode: "sutra_template",
    expectedRolePath: "/sutra/",
    expectedRoleName: "SutraCollectorRole",
  };
}

function credentialEvidence() {
  return {
    verified: true,
    credentialKind: "static_credentials",
    accountId: ACCOUNT,
    partition: "aws",
    callerIdentityArn: `arn:aws:iam::${ACCOUNT}:user/finops-readonly`,
    accessKeyLast4: "Q4XY",
    secretVersionId: "a".repeat(64),
  };
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function secretReference(connectionId, options = {}) {
  const tenantDigest = await sha256(ORG);
  const connectionDigest = await sha256(options.connectionId ?? connectionId);
  return {
    secretArn: `arn:aws:secretsmanager:ap-south-1:738663485493:secret:sutra/customer-aws-credentials/v1/${tenantDigest}/${connectionDigest}-A1b2C3`,
    versionId: options.versionId ?? "a".repeat(64),
    accessKeyLast4: options.accessKeyLast4 ?? "Q4XY",
  };
}

describe("static-credential connection lifecycle", () => {
  it("persists the static draft kind and activates it through the verified credential commit", async () => {
    await withDatabase(async (database) => {
      const draft = await staticDraftInput("a");
      const handoff = await pilotRepository.createConnectionDraft(draft);
      assert.equal(handoff.connection.sourceKind, "aws_static_credentials");
      assert.equal(handoff.connection.status, "pending");
      assert.equal(handoff.connection.roleArn, null);
      const reference = await secretReference(draft.connectionId);
      await assert.rejects(
        database.prepare(
          `UPDATE aws_connections
              SET credential_secret_arn = ?, credential_secret_version_id = ?,
                  credential_access_key_last4 = NULL
            WHERE org_id = ? AND id = ?`,
        ).bind(reference.secretArn, reference.versionId, ORG, draft.connectionId).run(),
        /constraint|check/iu,
      );

      const staged = await pilotRepository.commitVerifiedConnectionCredentials({
        orgId: ORG,
        connectionId: draft.connectionId,
        actorId: draft.actorId,
        verification: credentialEvidence(),
        secretReference: reference,
      });
      assert.equal(staged.status, "validating");
      await assert.rejects(
        pilotRepository.createSyncRun(draft.connectionId, { orgId: ORG }),
        (error) => error?.code === "INVALID_STATE",
      );
      const committed = await pilotRepository.activateVerifiedConnectionCredentials({
        orgId: ORG,
        connectionId: draft.connectionId,
        actorId: draft.actorId,
        secretReference: reference,
      });
      assert.equal(committed.status, "active");
      assert.equal(committed.sourceKind, "aws_static_credentials");
      assert.equal(committed.roleArn, null);
      assert.notEqual(committed.lastValidatedAt, null);

      // An exact response replay recovers the already-committed audit without
      // reopening a live connection's validating window. Both phases remain
      // callable: the collector and control-plane activation steps are exact-
      // version idempotent.
      const replayCommitted = await pilotRepository.commitVerifiedConnectionCredentials({
        orgId: ORG,
        connectionId: draft.connectionId,
        actorId: draft.actorId,
        verification: credentialEvidence(),
        secretReference: await secretReference(draft.connectionId),
      });
      assert.equal(replayCommitted.status, "active");
      const replay = await pilotRepository.activateVerifiedConnectionCredentials({
        orgId: ORG,
        connectionId: draft.connectionId,
        actorId: draft.actorId,
        secretReference: await secretReference(draft.connectionId),
      });
      assert.equal(replay.status, "active");

      const stored = await pilotRepository.getStoredConnectionSecretForOrg(ORG, draft.connectionId);
      assert.equal(stored.credentialSecretArn, (await secretReference(draft.connectionId)).secretArn);
      assert.equal(stored.credentialSecretVersionId, "a".repeat(64));
      assert.equal(stored.credentialAccessKeyLast4, "Q4XY");

      const mismatchedReferences = [
        { ...reference, versionId: "b".repeat(64) },
        { ...reference, accessKeyLast4: "ZZZZ" },
        { ...reference, secretArn: reference.secretArn.replace(/-A1b2C3$/u, "-Z9y8X7") },
      ];
      for (const mismatchedReference of mismatchedReferences) {
        await assert.rejects(
          pilotRepository.activateVerifiedConnectionCredentials({
            orgId: ORG,
            connectionId: draft.connectionId,
            actorId: draft.actorId,
            secretReference: mismatchedReference,
          }),
          (error) => error?.code === "INVALID_STATE" && /committed reference/u.test(error.message),
        );
      }

      // Revalidation first claims the validating state, then atomically
      // re-attests the same exact immutable secret version.
      await pilotRepository.markConnectionValidating(draft.connectionId, ORG);
      await assert.rejects(
        pilotRepository.createSyncRun(draft.connectionId, { orgId: ORG }),
        (error) => error?.code === "INVALID_STATE",
      );
      await assert.rejects(
        pilotRepository.activateVerifiedConnectionCredentials({
          orgId: ORG,
          connectionId: draft.connectionId,
          actorId: draft.actorId,
          secretReference: { ...reference, versionId: "b".repeat(64) },
        }),
        (error) => error?.code === "INVALID_STATE" && /committed reference/u.test(error.message),
      );
      const revalidationStaged = await pilotRepository.commitVerifiedConnectionCredentials({
        orgId: ORG,
        connectionId: draft.connectionId,
        actorId: draft.actorId,
        verification: credentialEvidence(),
        secretReference: await secretReference(draft.connectionId),
      });
      assert.equal(revalidationStaged.status, "validating");
      const revalidated = await pilotRepository.activateVerifiedConnectionCredentials({
        orgId: ORG,
        connectionId: draft.connectionId,
        actorId: draft.actorId,
        secretReference: await secretReference(draft.connectionId),
      });
      assert.equal(revalidated.status, "active");

      const staticRunId = await pilotRepository.createSyncRun(
        draft.connectionId,
        { orgId: ORG },
      );
      assert.match(staticRunId, /^sync_/u);
      await pilotRepository.failSyncRun(
        staticRunId,
        draft.connectionId,
        draft.actorId,
        "COLLECTION_FAILED",
        ORG,
      );

      const audit = await database.prepare(
        `SELECT metadata_json FROM audit_events
          WHERE org_id = ? AND action = 'aws.connection.credentials_registered'`,
      ).bind(ORG).all();
      assert.equal((audit.results ?? []).length, 1);
      const metadata = audit.results[0].metadata_json;
      assert.deepEqual(JSON.parse(metadata), {
        accessKeyLast4: "Q4XY",
        callerIdentityArn: `arn:aws:iam::${ACCOUNT}:user/finops-readonly`,
        credentialKind: "static_credentials",
        credentialSecretVersionId: "a".repeat(64),
        credentialsStoredInControlPlane: false,
      });
      const validationAudit = await database.prepare(
        `SELECT metadata_json FROM audit_events
          WHERE org_id = ? AND action = 'aws.connection.credentials_validated'`,
      ).bind(ORG).all();
      assert.equal((validationAudit.results ?? []).length, 1);

      // No credential value ever lands in any aws_connections column.
      const row = await database.prepare(
        "SELECT * FROM aws_connections WHERE org_id = ? AND id = ?",
      ).bind(ORG, draft.connectionId).first();
      assert.equal(row.role_arn, "");
      for (const value of Object.values(row)) {
        assert.equal(/^(AKIA|ASIA)[A-Z0-9]{16}$/u.test(String(value)), false);
      }
      await assert.rejects(
        database.prepare(
          "UPDATE aws_connections SET credential_secret_version_id = NULL WHERE org_id = ? AND id = ?",
        ).bind(ORG, draft.connectionId).run(),
      );
      await assert.rejects(
        database.prepare(
          "UPDATE aws_connections SET credential_access_key_last4 = 'q4xy' WHERE org_id = ? AND id = ?",
        ).bind(ORG, draft.connectionId).run(),
      );
    });
  });

  it("fails closed on kind, account, and proof mismatches", async () => {
    await withDatabase(async () => {
      const draft = await staticDraftInput("b");
      await pilotRepository.createConnectionDraft(draft);

      for (const evidence of [
        { ...credentialEvidence(), verified: false },
        { ...credentialEvidence(), credentialKind: "trust_role" },
        { ...credentialEvidence(), accountId: "210987654321" },
        { ...credentialEvidence(), partition: "aws-us-gov" },
        { ...credentialEvidence(), accessKeyLast4: "q4xy" },
        { ...credentialEvidence(), secretVersionId: "b".repeat(64) },
        { ...credentialEvidence(), callerIdentityArn: "arn:aws:iam::210987654321:user/other" },
        { ...credentialEvidence(), callerIdentityArn: `arn:aws:iam::${ACCOUNT}:root` },
        { ...credentialEvidence(), callerIdentityArn: `arn:aws:sts::${ACCOUNT}:assumed-role/Administrator/session` },
        { ...credentialEvidence(), callerIdentityArn: "not-an-arn" },
      ]) {
        await assert.rejects(
          pilotRepository.commitVerifiedConnectionCredentials({
            orgId: ORG,
            connectionId: draft.connectionId,
            actorId: draft.actorId,
            verification: evidence,
            secretReference: await secretReference(draft.connectionId),
          }),
          (error) => error?.code === "INVALID_STATE",
        );
      }

      // A trust-role connection never accepts the credential commit.
      const trustIdentity = await deriveScopedAwsConnectionIdentity(ORG, "210987654321", "aws");
      await pilotRepository.createConnectionDraft({
        ...(await staticDraftInput("c")),
        sourceKind: "aws_trust_role",
        operationId: `onb_${"c".repeat(32)}`,
        ...trustIdentity,
        customerSlug: `trust-c-${trustIdentity.customerId.slice(-8)}`,
        accountId: "210987654321",
      });
      await assert.rejects(
        pilotRepository.commitVerifiedConnectionCredentials({
          orgId: ORG,
          connectionId: trustIdentity.connectionId,
          actorId: "usr_static_c",
          verification: { ...credentialEvidence(), accountId: "210987654321" },
          secretReference: await secretReference(trustIdentity.connectionId),
        }),
        (error) => error?.code === "INVALID_STATE" &&
          /Only static-credential AWS connections/u.test(error.message),
      );

      for (const reference of [
        { ...(await secretReference(draft.connectionId)), accessKeyLast4: "ZZZZ" },
        await secretReference(draft.connectionId, { connectionId: trustIdentity.connectionId }),
        { ...(await secretReference(draft.connectionId)), versionId: "short" },
        { ...(await secretReference(draft.connectionId)), extra: "not-allowed" },
      ]) {
        await assert.rejects(
          pilotRepository.commitVerifiedConnectionCredentials({
            orgId: ORG,
            connectionId: draft.connectionId,
            actorId: draft.actorId,
            verification: credentialEvidence(),
            secretReference: reference,
          }),
          (error) => error?.code === "INVALID_STATE",
        );
      }
    });
  });

  it("retries the exact committed version after an activation failure", async () => {
    await withDatabase(async () => {
      const draft = await staticDraftInput("e");
      const reference = await secretReference(draft.connectionId);
      await pilotRepository.createConnectionDraft(draft);
      const staged = await pilotRepository.commitVerifiedConnectionCredentials({
        orgId: ORG,
        connectionId: draft.connectionId,
        actorId: draft.actorId,
        verification: credentialEvidence(),
        secretReference: reference,
      });
      assert.equal(staged.status, "validating");

      // Keep wall-clock time fixed to prove repeated failures still receive
      // monotonic state revisions and never collide with a prior retry audit.
      const actualDateNow = Date.now;
      Date.now = () => Date.parse(staged.updatedAt);
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await pilotRepository.markConnectionNeedsAttention(
            draft.connectionId,
            draft.actorId,
            "BROKER_UNAVAILABLE",
            ORG,
          );
          const retryStaged = await pilotRepository.commitVerifiedConnectionCredentials({
            orgId: ORG,
            connectionId: draft.connectionId,
            actorId: draft.actorId,
            verification: credentialEvidence(),
            secretReference: reference,
          });
          assert.equal(retryStaged.status, "validating");
        }
      } finally {
        Date.now = actualDateNow;
      }
      await assert.rejects(
        pilotRepository.createSyncRun(draft.connectionId, { orgId: ORG }),
        (error) => error?.code === "INVALID_STATE",
      );

      const activated = await pilotRepository.activateVerifiedConnectionCredentials({
        orgId: ORG,
        connectionId: draft.connectionId,
        actorId: draft.actorId,
        secretReference: reference,
      });
      assert.equal(activated.status, "active");
    });
  });

  it("disables static connections without dropping their reference and clears it on offboarding", async () => {
    await withDatabase(async (database) => {
      const draft = await staticDraftInput("d");
      await pilotRepository.createConnectionDraft(draft);
      await pilotRepository.commitVerifiedConnectionCredentials({
        orgId: ORG,
        connectionId: draft.connectionId,
        actorId: draft.actorId,
        verification: credentialEvidence(),
        secretReference: await secretReference(draft.connectionId),
      });
      await pilotRepository.activateVerifiedConnectionCredentials({
        orgId: ORG,
        connectionId: draft.connectionId,
        actorId: draft.actorId,
        secretReference: await secretReference(draft.connectionId),
      });

      const disabled = await pilotRepository.disableAwsConnection(
        draft.connectionId,
        draft.actorId,
        ORG,
      );
      assert.equal(disabled.status, "disabled");
      const disabledStored = await pilotRepository.getStoredConnectionSecretForOrg(ORG, draft.connectionId);
      assert.equal(disabledStored.credentialSecretVersionId, "a".repeat(64));

      const offboarded = await pilotRepository.offboardAwsConnection(
        draft.connectionId,
        draft.actorId,
        ORG,
      );
      assert.equal(offboarded.status, "disabled");
      const row = await database.prepare(
        `SELECT credential_secret_arn, credential_secret_version_id,
                credential_access_key_last4, external_id_key_version
           FROM aws_connections WHERE org_id = ? AND id = ?`,
      ).bind(ORG, draft.connectionId).first();
      assert.equal(row.credential_secret_arn, null);
      assert.equal(row.credential_secret_version_id, null);
      assert.equal(row.credential_access_key_last4, null);
      assert.equal(row.external_id_key_version, "offboarded");
      await assert.rejects(
        pilotRepository.getStoredConnectionSecretForOrg(ORG, draft.connectionId),
        (error) => error?.code === "INVALID_STATE" && /offboarded/u.test(error.message),
      );

      const audit = await database.prepare(
        `SELECT metadata_json FROM audit_events
          WHERE org_id = ? AND action = 'aws.connection.offboarded'`,
      ).bind(ORG).first();
      const metadata = JSON.parse(audit.metadata_json);
      assert.equal(metadata.customerIamRoleRevocationRequired, false);
      assert.equal(metadata.customerAccessKeyRevocationRequired, true);
    });
  });
});
