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

      const committed = await pilotRepository.commitVerifiedConnectionCredentials({
        orgId: ORG,
        connectionId: draft.connectionId,
        actorId: draft.actorId,
        verification: credentialEvidence(),
      });
      assert.equal(committed.status, "active");
      assert.equal(committed.sourceKind, "aws_static_credentials");
      assert.equal(committed.roleArn, null);
      assert.notEqual(committed.lastValidatedAt, null);

      // An exact replay recovers through the audit idempotency key.
      const replay = await pilotRepository.commitVerifiedConnectionCredentials({
        orgId: ORG,
        connectionId: draft.connectionId,
        actorId: draft.actorId,
        verification: credentialEvidence(),
      });
      assert.equal(replay.status, "active");

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
        credentialsStoredInControlPlane: false,
      });

      // No credential value ever lands in any aws_connections column.
      const row = await database.prepare(
        "SELECT * FROM aws_connections WHERE org_id = ? AND id = ?",
      ).bind(ORG, draft.connectionId).first();
      assert.equal(row.role_arn, "");
      for (const value of Object.values(row)) {
        assert.equal(/^(AKIA|ASIA)[A-Z0-9]{16}$/u.test(String(value)), false);
      }
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
        { ...credentialEvidence(), callerIdentityArn: "arn:aws:iam::210987654321:user/other" },
        { ...credentialEvidence(), callerIdentityArn: "not-an-arn" },
      ]) {
        await assert.rejects(
          pilotRepository.commitVerifiedConnectionCredentials({
            orgId: ORG,
            connectionId: draft.connectionId,
            actorId: draft.actorId,
            verification: evidence,
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
        }),
        (error) => error?.code === "INVALID_STATE" &&
          /Only static-credential AWS connections/u.test(error.message),
      );
    });
  });
});
