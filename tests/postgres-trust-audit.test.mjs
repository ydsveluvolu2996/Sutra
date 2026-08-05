import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

const databaseUrl = process.env.SUTRA_POSTGRES_RUNTIME_TEST_URL?.trim();
if (!databaseUrl) throw new Error("SUTRA_POSTGRES_RUNTIME_TEST_URL is required");
process.env.DATABASE_URL = databaseUrl;
register(new URL("./cloudflare-loader.mjs", import.meta.url));

const pilotRepository = await import("../db/pilot-repository.ts");
const { CUSTOMER_ROLE_METADATA_ACTIONS } = await import("../lib/aws-customer-role-artifacts.ts");
const { deriveScopedAwsConnectionIdentity } = await import("../lib/aws-pilot-security.ts");
const { getRawDb } = await import("../db/index.ts");
const { closePostgresDatabase } = await import("../db/postgres-d1-adapter.ts");

test("PostgreSQL commits each AWS trust mutation with one chained audit event", async () => {
  const database = getRawDb();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const customerId = `cust_${suffix}`;
  const connectionId = `conn_${suffix}`;
  const accountId = "888899990000";
  const actorId = `usr_${suffix}`;
  const originalRoleArn = `arn:aws:iam::${accountId}:role/LegacySutraReadOnly`;
  const replacementRoleArn = `arn:aws:iam::${accountId}:role/sutra/SutraReadOnlyRole`;
  const now = Date.now();

  try {
    await database.batch([
      database.prepare(
        `INSERT OR IGNORE INTO organizations (id, slug, name, status)
         VALUES (?, ?, ?, 'active')`,
      ).bind(
        pilotRepository.LOCAL_ORG_ID,
        pilotRepository.LOCAL_ORG_SLUG,
        "Sutra local MSP",
      ),
      database.prepare(
        `INSERT INTO customers (id, org_id, slug, name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      ).bind(customerId, pilotRepository.LOCAL_ORG_ID, `pg-trust-${suffix}`, "PG trust", now, now),
      database.prepare(
        `INSERT INTO aws_connections
          (id, org_id, customer_id, source_kind, partition, aws_account_id,
           role_arn, external_id_ciphertext, external_id_key_version,
           permission_pack_version, status, enabled_regions_json,
           last_validated_at, created_at, updated_at)
         VALUES (?, ?, ?, 'aws_trust_role', 'aws', ?, ?, ?, 'test-key-v1',
                 'standard-2026-07.4', 'active', '["us-east-1"]', ?, ?, ?)`,
      ).bind(
        connectionId,
        pilotRepository.LOCAL_ORG_ID,
        customerId,
        accountId,
        originalRoleArn,
        "postgres-encrypted-external-id-material",
        now,
        now,
        now,
      ),
    ]);

    const registered = await pilotRepository.commitVerifiedConnectionRole({
      connectionId,
      expectedPreviousRoleArn: originalRoleArn,
      roleArn: replacementRoleArn,
      actorId,
      verification: {
        verified: true,
        accountId,
        roleArn: replacementRoleArn,
        roleSessionName: "sutra-postgres-test",
        callerIdentityArn: `arn:aws:sts::${accountId}:assumed-role/SutraReadOnlyRole/sutra-postgres-test`,
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
      },
    });
    assert.equal(registered.roleArn, replacementRoleArn);
    assert.equal(registered.status, "active");

    const disabled = await pilotRepository.disableAwsConnection(connectionId, actorId);
    assert.equal(disabled.status, "disabled");

    const offboarded = await pilotRepository.offboardAwsConnection(connectionId, actorId);
    assert.equal(offboarded.roleArn, null);
    assert.equal(offboarded.status, "disabled");

    const rows = await database.prepare(
      `SELECT action, previous_event_hash, event_hash
         FROM audit_events
        WHERE org_id = ? AND target_id = ?
          AND action IN (
            'aws.connection.role_registered',
            'aws.connection.disabled',
            'aws.connection.offboarded'
          )
        ORDER BY occurred_at, id`,
    ).bind(pilotRepository.LOCAL_ORG_ID, connectionId).all();
    assert.deepEqual(rows.results.map((row) => row.action), [
      "aws.connection.role_registered",
      "aws.connection.disabled",
      "aws.connection.offboarded",
    ]);
    assert.equal(rows.results[1]?.previous_event_hash, rows.results[0]?.event_hash);
    assert.equal(rows.results[2]?.previous_event_hash, rows.results[1]?.event_hash);

    const stored = await database.prepare(
      `SELECT role_arn, external_id_ciphertext, external_id_key_version, status
         FROM aws_connections WHERE org_id = ? AND id = ? LIMIT 1`,
    ).bind(pilotRepository.LOCAL_ORG_ID, connectionId).first();
    assert.equal(stored?.role_arn, "");
    assert.notEqual(stored?.external_id_ciphertext, "postgres-encrypted-external-id-material");
    assert.equal(stored?.external_id_key_version, "offboarded");
    assert.equal(stored?.status, "disabled");
  } finally {
    await closePostgresDatabase();
  }
});

test("PostgreSQL globally serializes live AWS ownership races and emits a scoped collision signal", async () => {
  const database = getRawDb();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const orgA = `org_pg_owner_a_${suffix}`;
  const orgB = `org_pg_owner_b_${suffix}`;
  const customerA = `cust_${crypto.randomUUID().replaceAll("-", "")}`;
  const customerB = `cust_${crypto.randomUUID().replaceAll("-", "")}`;
  const raceAccount = "700000000001";
  const claimedAccount = "700000000002";
  const fixtureAccount = "700000000003";
  const insertConnection = (input) => database.prepare(
    `INSERT INTO aws_connections
      (id, org_id, customer_id, source_kind, partition, aws_account_id, role_arn,
       external_id_ciphertext, external_id_key_version, permission_pack_version,
       status, enabled_regions_json)
     VALUES (?, ?, ?, ?, 'aws', ?, ?, 'postgres-encrypted-material', 'test-key-v1',
             'standard-2026-07.4', 'active', '["us-east-1"]')`,
  ).bind(
    input.connectionId,
    input.orgId,
    input.customerId,
    input.sourceKind,
    input.accountId,
    input.roleArn,
  );

  try {
    await database.batch([
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status) VALUES (?, ?, 'PG owner A', 'active')",
      ).bind(orgA, `pg-owner-a-${suffix}`),
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status) VALUES (?, ?, 'PG owner B', 'active')",
      ).bind(orgB, `pg-owner-b-${suffix}`),
      database.prepare(
        "INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, ?, 'PG customer A', 'active')",
      ).bind(customerA, orgA, `pg-customer-a-${suffix}`),
      database.prepare(
        "INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, ?, 'PG customer B', 'active')",
      ).bind(customerB, orgB, `pg-customer-b-${suffix}`),
    ]);

    const race = await Promise.allSettled([
      insertConnection({
        connectionId: `conn_${crypto.randomUUID().replaceAll("-", "")}`,
        orgId: orgA,
        customerId: customerA,
        sourceKind: "aws_trust_role",
        accountId: raceAccount,
        roleArn: `arn:aws:iam::${raceAccount}:role/sutra/SutraRaceA`,
      }).run(),
      insertConnection({
        connectionId: `conn_${crypto.randomUUID().replaceAll("-", "")}`,
        orgId: orgB,
        customerId: customerB,
        sourceKind: "aws_trust_role",
        accountId: raceAccount,
        roleArn: `arn:aws:iam::${raceAccount}:role/sutra/SutraRaceB`,
      }).run(),
    ]);
    assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(race.filter((result) => result.status === "rejected").length, 1);
    assert.equal(
      Number((await database.prepare(
        `SELECT COUNT(*) AS count FROM aws_connections
          WHERE source_kind = 'aws_trust_role' AND partition = 'aws' AND aws_account_id = ?`,
      ).bind(raceAccount).first())?.count),
      1,
    );

    await insertConnection({
      connectionId: `conn_${crypto.randomUUID().replaceAll("-", "")}`,
      orgId: orgA,
      customerId: customerA,
      sourceKind: "aws_trust_role",
      accountId: claimedAccount,
      roleArn: `arn:aws:iam::${claimedAccount}:role/sutra/SutraClaimOwner`,
    }).run();
    const attempted = await deriveScopedAwsConnectionIdentity(orgB, claimedAccount, "aws");
    await assert.rejects(
      pilotRepository.createConnectionDraft({
        orgId: orgB,
        actorId: `usr_pg_collision_${suffix}`,
        operationId: `onb_${"a".repeat(32)}`,
        ...attempted,
        customerName: "PG collision",
        customerSlug: `pg-collision-${suffix.slice(0, 16)}`,
        accountId: claimedAccount,
        partition: "aws",
        enabledRegions: ["us-east-1"],
        externalIdCiphertext: "postgres-encrypted-collision-material",
        externalIdKeyVersion: "test-key-v1",
        roleProvisioningMode: "sutra_template",
        expectedRolePath: "/sutra/",
        expectedRoleName: "SutraReadOnlyRole",
      }),
      (error) =>
        error?.code === "CONFLICT" &&
        error.message === "The AWS ownership claim could not be accepted",
    );
    const signal = await database.prepare(
      `SELECT customer_id, outcome, metadata_json, event_hash
         FROM audit_events
        WHERE org_id = ? AND action = 'security.aws_connection_ownership_collision'
        LIMIT 1`,
    ).bind(orgB).first();
    assert.equal(signal?.customer_id, null);
    assert.equal(signal?.outcome, "denied");
    assert.match(signal?.event_hash ?? "", /^[a-f0-9]{64}$/u);
    assert.equal((signal?.metadata_json ?? "").includes(claimedAccount), false);
    assert.equal((signal?.metadata_json ?? "").includes(orgA), false);

    await database.batch([
      insertConnection({
        connectionId: `conn_${crypto.randomUUID().replaceAll("-", "")}`,
        orgId: orgA,
        customerId: customerA,
        sourceKind: "simulated_fixture",
        accountId: fixtureAccount,
        roleArn: "",
      }),
      insertConnection({
        connectionId: `conn_${crypto.randomUUID().replaceAll("-", "")}`,
        orgId: orgB,
        customerId: customerB,
        sourceKind: "simulated_fixture",
        accountId: fixtureAccount,
        roleArn: "",
      }),
    ]);
    assert.equal(
      Number((await database.prepare(
        "SELECT COUNT(*) AS count FROM aws_connections WHERE source_kind = 'simulated_fixture' AND aws_account_id = ?",
      ).bind(fixtureAccount).first())?.count),
      2,
    );
  } finally {
    await closePostgresDatabase();
  }
});
