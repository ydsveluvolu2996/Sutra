import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { describe, it } from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const { CUSTOMER_ROLE_METADATA_ACTIONS } = await import("../lib/aws-customer-role-artifacts.ts");
const { deriveScopedAwsConnectionIdentity } = await import("../lib/aws-pilot-security.ts");
const { buildVerifiedAuditExport } = await import("../lib/audit-export.ts");
const { listAuditEventsForOrg } = await import("../db/audit-export-repository.ts");
const pilotRepository = await import("../db/pilot-repository.ts");
const runtimeMigrations = await import("../db/runtime-migrations.ts");

const ORG_A = "org_ownership_alpha";
const ORG_B = "org_ownership_beta";
const ACCOUNT_A = "111122223333";
const ACCOUNT_B = "444455556666";
const GENERIC_CONFLICT = "The AWS ownership claim could not be accepted";

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-aws-ownership-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status) VALUES (?, 'ownership-alpha', 'Ownership Alpha', 'active')",
      ).bind(ORG_A),
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status) VALUES (?, 'ownership-beta', 'Ownership Beta', 'active')",
      ).bind(ORG_B),
    ]);
    await run(database);
  } finally {
    await miniflare.dispose();
  }
}

async function draftInput(orgId, accountId, marker) {
  const identity = await deriveScopedAwsConnectionIdentity(orgId, accountId, "aws");
  return {
    orgId,
    actorId: `usr_ownership_${marker}`,
    operationId: `onb_${marker.repeat(32)}`,
    ...identity,
    customerName: `Ownership ${marker}`,
    customerSlug: `ownership-${marker}-${identity.customerId.slice(-8)}`,
    accountId,
    partition: "aws",
    enabledRegions: ["us-east-1"],
    externalIdCiphertext: `encrypted-external-id-material-${marker.repeat(8)}`,
    externalIdKeyVersion: "test-key-v1",
    roleProvisioningMode: "sutra_template",
    expectedRolePath: "/sutra/",
    expectedRoleName: "SutraReadOnlyRole",
  };
}

function verifiedRoleEvidence(accountId, roleArn) {
  const roleSessionName = "sutra-ownership-test";
  return {
    verified: true,
    accountId,
    roleArn,
    roleSessionName,
    callerIdentityArn:
      `arn:aws:sts::${accountId}:assumed-role/SutraReadOnlyRole/${roleSessionName}`,
    missingExternalIdDenied: true,
    wrongExternalIdDenied: true,
    trustPolicyAttested: true,
    permissionPolicyAttested: true,
    sessionPolicyApplied: true,
    permissionPackVersion: "standard-2026-07.4",
    capabilityAssessment: {
      grantedActions: [...CUSTOMER_ROLE_METADATA_ACTIONS],
      missingActions: [],
    },
  };
}

function insertCustomer(database, id, orgId, slug) {
  return database.prepare(
    `INSERT INTO customers (id, org_id, slug, name, status)
     VALUES (?, ?, ?, ?, 'active')`,
  ).bind(id, orgId, slug, slug);
}

function insertConnection(database, input) {
  return database.prepare(
    `INSERT INTO aws_connections
      (id, org_id, customer_id, source_kind, partition, aws_account_id, role_arn,
       external_id_ciphertext, external_id_key_version, permission_pack_version,
       status, enabled_regions_json)
     VALUES (?, ?, ?, ?, 'aws', ?, ?, 'test-encrypted-material', 'test-key-v1',
             'standard-2026-07.4', 'active', '["us-east-1"]')`,
  ).bind(
    input.id,
    input.orgId,
    input.customerId,
    input.sourceKind,
    input.accountId,
    input.roleArn,
  );
}

describe("tenant-global AWS ownership", () => {
  it("blocks cross-org and same-org account reuse with requester-scoped, non-disclosing signals", async () => {
    await withDatabase(async (database) => {
      const owner = await draftInput(ORG_A, ACCOUNT_A, "a");
      const otherTenant = await draftInput(ORG_B, ACCOUNT_A, "b");
      await pilotRepository.createConnectionDraft(owner);

      await assert.rejects(
        pilotRepository.createConnectionDraft(otherTenant),
        (error) => error?.code === "CONFLICT" && error.message === GENERIC_CONFLICT,
      );
      await assert.rejects(
        pilotRepository.createConnectionDraft({
          ...owner,
          operationId: `onb_${"c".repeat(32)}`,
          actorId: "usr_ownership_c",
        }),
        (error) => error?.code === "CONFLICT" && error.message === GENERIC_CONFLICT,
      );

      const betaSignal = await database.prepare(
        `SELECT org_id, customer_id, actor_id, action, target_id, outcome,
                request_id, metadata_json, event_hash, hash_version
           FROM audit_events
          WHERE org_id = ? AND action = 'security.aws_connection_ownership_collision'
          LIMIT 1`,
      ).bind(ORG_B).first();
      assert.equal(betaSignal?.org_id, ORG_B);
      assert.equal(betaSignal?.customer_id, null);
      assert.equal(betaSignal?.actor_id, otherTenant.actorId);
      assert.equal(betaSignal?.target_id, otherTenant.connectionId);
      assert.equal(betaSignal?.outcome, "denied");
      assert.match(betaSignal?.event_hash ?? "", /^[a-f0-9]{64}$/u);
      assert.equal(betaSignal?.hash_version, 2);
      const metadata = betaSignal?.metadata_json ?? "";
      assert.deepEqual(JSON.parse(metadata), {
        automaticTransfer: false,
        collisionKind: "account",
        ownerDisclosure: false,
        partition: "aws",
        transferRequiresExplicitAudit: true,
      });
      for (const forbidden of [
        ACCOUNT_A,
        owner.connectionId,
        owner.customerId,
        ORG_A,
        owner.externalIdCiphertext,
        "role/",
      ]) {
        assert.equal(metadata.includes(forbidden), false);
      }

      const exported = await buildVerifiedAuditExport({
        orgId: ORG_B,
        exportedAt: "2026-07-30T00:00:00.000Z",
        events: await listAuditEventsForOrg(ORG_B, database),
      });
      assert.equal(exported.eventCount, 1);
      assert.equal(
        Number((await database.prepare(
          `SELECT COUNT(*) AS count FROM audit_events
            WHERE org_id = ? AND action = 'security.aws_connection_ownership_collision'`,
        ).bind(ORG_A).first())?.count),
        1,
      );
      assert.equal(
        Number((await database.prepare(
          "SELECT COUNT(*) AS count FROM aws_connections WHERE source_kind = 'aws_trust_role'",
        ).first())?.count),
        1,
      );
    });
  });

  it("blocks a role already claimed by another tenant and does not mutate the pending connection", async () => {
    await withDatabase(async (database) => {
      const foreignCustomer = "cust_foreign_role_owner_000000000001";
      const claimedRoleArn =
        `arn:aws:iam::${ACCOUNT_B}:role/sutra/SutraReadOnlyRole`;
      await database.batch([
        insertCustomer(database, foreignCustomer, ORG_A, "foreign-role-owner"),
        // Deliberately adversarial stored state: the role ARN names ACCOUNT_B
        // while the row owns ACCOUNT_A. The independent role uniqueness guard
        // must still prevent a second claim.
        insertConnection(database, {
          id: "conn_foreign_role_owner_00000000001",
          orgId: ORG_A,
          customerId: foreignCustomer,
          sourceKind: "aws_trust_role",
          accountId: ACCOUNT_A,
          roleArn: claimedRoleArn,
        }),
      ]);
      const pending = await draftInput(ORG_B, ACCOUNT_B, "d");
      await pilotRepository.createConnectionDraft(pending);

      await assert.rejects(
        pilotRepository.commitVerifiedConnectionRole({
          orgId: ORG_B,
          connectionId: pending.connectionId,
          expectedPreviousRoleArn: null,
          roleArn: claimedRoleArn,
          actorId: pending.actorId,
          verification: verifiedRoleEvidence(ACCOUNT_B, claimedRoleArn),
        }),
        (error) => error?.code === "CONFLICT" && error.message === GENERIC_CONFLICT,
      );

      assert.deepEqual(
        await database.prepare(
          "SELECT role_arn, status FROM aws_connections WHERE org_id = ? AND id = ?",
        ).bind(ORG_B, pending.connectionId).first(),
        { role_arn: "", status: "pending" },
      );
      const signal = await database.prepare(
        `SELECT metadata_json FROM audit_events
          WHERE org_id = ? AND action = 'security.aws_connection_ownership_collision'
          LIMIT 1`,
      ).bind(ORG_B).first();
      assert.equal(JSON.parse(signal?.metadata_json ?? "{}").collisionKind, "role");
      assert.equal((signal?.metadata_json ?? "").includes(claimedRoleArn), false);
      assert.equal((signal?.metadata_json ?? "").includes(ORG_A), false);
    });
  });

  it("uses database uniqueness for races while leaving simulated fixtures outside the live claim boundary", async () => {
    await withDatabase(async (database) => {
      const customerA = "cust_race_alpha_00000000000000000001";
      const customerB = "cust_race_beta_000000000000000000002";
      await database.batch([
        insertCustomer(database, customerA, ORG_A, "race-alpha"),
        insertCustomer(database, customerB, ORG_B, "race-beta"),
      ]);
      const raceAccount = "777788889999";
      const attempts = await Promise.allSettled([
        insertConnection(database, {
          id: "conn_race_alpha_0000000000000000001",
          orgId: ORG_A,
          customerId: customerA,
          sourceKind: "aws_trust_role",
          accountId: raceAccount,
          roleArn: `arn:aws:iam::${raceAccount}:role/sutra/SutraAlpha`,
        }).run(),
        insertConnection(database, {
          id: "conn_race_beta_00000000000000000002",
          orgId: ORG_B,
          customerId: customerB,
          sourceKind: "aws_trust_role",
          accountId: raceAccount,
          roleArn: `arn:aws:iam::${raceAccount}:role/sutra/SutraBeta`,
        }).run(),
      ]);
      assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
      assert.equal(
        Number((await database.prepare(
          `SELECT COUNT(*) AS count FROM aws_connections
            WHERE source_kind = 'aws_trust_role' AND partition = 'aws' AND aws_account_id = ?`,
        ).bind(raceAccount).first())?.count),
        1,
      );

      const duplicateFixtureAccount = "999900001111";
      await database.batch([
        insertConnection(database, {
          id: "conn_fixture_alpha_00000000000000001",
          orgId: ORG_A,
          customerId: customerA,
          sourceKind: "simulated_fixture",
          accountId: duplicateFixtureAccount,
          roleArn: "",
        }),
        insertConnection(database, {
          id: "conn_fixture_beta_000000000000000002",
          orgId: ORG_B,
          customerId: customerB,
          sourceKind: "simulated_fixture",
          accountId: duplicateFixtureAccount,
          roleArn: "",
        }),
      ]);
      assert.equal(
        Number((await database.prepare(
          "SELECT COUNT(*) AS count FROM aws_connections WHERE source_kind = 'simulated_fixture' AND aws_account_id = ?",
        ).bind(duplicateFixtureAccount).first())?.count),
        2,
      );
    });
  });
});

it("registers equivalent global account and role constraints in D1, PostgreSQL, runtime verification, and schema", async () => {
  const [d1, postgres, runtime, postgresRuntime, migrator, schema] = await Promise.all([
    readFile(new URL("../drizzle/0073_aws_global_ownership.sql", import.meta.url), "utf8"),
    readFile(new URL("../postgres/migrations/0068_aws_global_ownership.sql", import.meta.url), "utf8"),
    readFile(new URL("../db/runtime-migrations.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/postgres-runtime-migrations.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/postgres-migrate.mjs", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  ]);
  for (const source of [d1, postgres, schema]) {
    assert.match(source, /aws_connections_global_live_account_uq/u);
    assert.match(source, /aws_connections_global_live_role_uq/u);
    assert.match(source, /source_kind.*aws_trust_role/isu);
  }
  assert.match(d1, /partition.*aws_account_id/isu);
  assert.match(postgres, /partition.*aws_account_id/isu);
  assert.match(runtime, /0073_aws_global_ownership/u);
  assert.match(postgresRuntime, /0068_aws_global_ownership/u);
  assert.match(migrator, /0068_aws_global_ownership\.sql/u);
});
