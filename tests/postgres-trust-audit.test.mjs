import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

const databaseUrl = process.env.SUTRA_POSTGRES_RUNTIME_TEST_URL?.trim();
if (!databaseUrl) throw new Error("SUTRA_POSTGRES_RUNTIME_TEST_URL is required");
process.env.DATABASE_URL = databaseUrl;
register(new URL("./cloudflare-loader.mjs", import.meta.url));

const pilotRepository = await import("../db/pilot-repository.ts");
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
                 'live-demo-2026-07.2', 'active', '["us-east-1"]', ?, ?, ?)`,
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
        callerIdentityArn: `arn:aws:sts::${accountId}:assumed-role/SutraReadOnlyRole/sutra-postgres-test`,
        missingExternalIdDenied: true,
        wrongExternalIdDenied: true,
        trustPolicyAttested: true,
        permissionPolicyAttested: true,
        sessionPolicyApplied: true,
        permissionPackVersion: "live-demo-2026-07.2",
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
