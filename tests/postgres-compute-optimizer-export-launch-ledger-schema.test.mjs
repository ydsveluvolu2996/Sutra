import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import pg from "pg";

const databaseUrl = process.env.SUTRA_POSTGRES_RUNTIME_TEST_URL;
const root = resolve(import.meta.dirname, "..");

test("launch ledger migration is registered in both immutable migration registries", async () => {
  const [runtime, migrator] = await Promise.all([
    readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8"),
    readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8"),
  ]);
  assert.match(runtime, /0111_compute_optimizer_export_launch_ledger[.]sql[?]raw/u);
  assert.match(runtime, /id: "0111_compute_optimizer_export_launch_ledger"/u);
  assert.match(migrator, /"0111_compute_optimizer_export_launch_ledger[.]sql"/u);
});

test("PostgreSQL installs the launch ledger constraints and transition guard",
  { skip: databaseUrl === undefined }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const table = await pool.query(
      `SELECT to_regclass('public.compute_optimizer_export_launch_executions') AS name`,
    );
    assert.equal(table.rows[0]?.name, "compute_optimizer_export_launch_executions");
    const triggers = await pool.query(
      `SELECT tgname FROM pg_trigger
       WHERE NOT tgisinternal
         AND tgrelid='compute_optimizer_export_launch_executions'::regclass`,
    );
    assert.deepEqual(triggers.rows.map(({ tgname }) => tgname),
      ["compute_optimizer_export_launch_transition_guard"]);
    const constraints = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid='compute_optimizer_export_launch_executions'::regclass`,
    );
    const definitions = constraints.rows.map(({ definition }) => definition).join("\n");
    for (const state of ["PREPARED", "IN_PROGRESS", "TERMINAL", "AMBIGUOUS"]) {
      assert.match(definitions, new RegExp(state, "u"));
    }
    const publicPrivileges = await pool.query(
      `SELECT count(*)::int AS privilege_count FROM information_schema.table_privileges
       WHERE table_schema='public'
         AND table_name='compute_optimizer_export_launch_executions'
         AND grantee='PUBLIC'`,
    );
    assert.equal(publicPrivileges.rows[0]?.privilege_count, 0);
  } finally {
    await pool.end();
  }
});

test("PostgreSQL permits one-way launch states and seals ambiguous executions",
  { skip: databaseUrl === undefined }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  const token = randomUUID().replaceAll("-", "");
  const connectionId = `conn_${token.slice(0, 32)}`;
  const attemptHash = createHash("sha256").update(token).digest("hex");
  const launchAttemptId = `coela_${attemptHash}`;
  const claimToken = `coelc_${randomUUID()}`;
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO compute_optimizer_export_launch_executions
        (tenant_id,connection_id,launch_attempt_id,attempt_content_sha256,
         attempt_json,state,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'{}','PREPARED',1,1)`,
      [`org_${token}`, connectionId, launchAttemptId, attemptHash],
    );
    await assert.rejects(client.query(
      `UPDATE compute_optimizer_export_launch_executions
          SET state='TERMINAL', execution_json='{}', execution_sha256=$4, updated_at=2
        WHERE tenant_id=$1 AND connection_id=$2 AND launch_attempt_id=$3`,
      [`org_${token}`, connectionId, launchAttemptId, attemptHash],
    ), /COMPUTE_OPTIMIZER_EXPORT_LAUNCH_TRANSITION_INVALID/u);
    await client.query("ROLLBACK");

    await client.query("BEGIN");
    await client.query(
      `INSERT INTO compute_optimizer_export_launch_executions
        (tenant_id,connection_id,launch_attempt_id,attempt_content_sha256,
         attempt_json,state,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'{}','PREPARED',1,1)`,
      [`org_${token}`, connectionId, launchAttemptId, attemptHash],
    );
    await client.query(
      `UPDATE compute_optimizer_export_launch_executions
          SET state='IN_PROGRESS', claim_token=$4, lease_expires_at=1000, updated_at=2
        WHERE tenant_id=$1 AND connection_id=$2 AND launch_attempt_id=$3`,
      [`org_${token}`, connectionId, launchAttemptId, claimToken],
    );
    await client.query(
      `UPDATE compute_optimizer_export_launch_executions
          SET state='AMBIGUOUS', claim_token=NULL, lease_expires_at=NULL, updated_at=3
        WHERE tenant_id=$1 AND connection_id=$2 AND launch_attempt_id=$3`,
      [`org_${token}`, connectionId, launchAttemptId],
    );
    await assert.rejects(client.query(
      `UPDATE compute_optimizer_export_launch_executions
          SET updated_at=4
        WHERE tenant_id=$1 AND connection_id=$2 AND launch_attempt_id=$3`,
      [`org_${token}`, connectionId, launchAttemptId],
    ), /COMPUTE_OPTIMIZER_EXPORT_LAUNCH_TERMINAL_IMMUTABLE/u);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.end();
  }
});
