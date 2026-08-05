import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

const databaseUrl = process.env.SUTRA_POSTGRES_RUNTIME_TEST_URL;
// Skip rather than throw when no database is configured. scripts/test-postgres.mjs runs this file with
// the URL set, but ci-test-shard.mjs also globs it into the offline shards, where a top-level throw
// failed the whole file instead of standing aside. Matches the sibling launch-ledger schema test.
const skip = databaseUrl === undefined;

test("PostgreSQL installs the exact-generation constraints and immutable guards", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name = ANY($1::text[])`,
      [[
        "finops_co_exact_artifacts",
        "finops_co_exact_artifact_chunks",
        "finops_co_exact_artifact_manifests",
        "finops_co_exact_generation_heads",
      ]],
    );
    assert.equal(tables.rowCount, 4);
    const triggers = await pool.query(
      `SELECT tgname FROM pg_trigger
       WHERE NOT tgisinternal AND tgrelid = ANY($1::regclass[])`,
      [[
        "finops_co_exact_artifacts",
        "finops_co_exact_artifact_chunks",
        "finops_co_exact_artifact_manifests",
        "finops_co_exact_generation_heads",
      ]],
    );
    const names = new Set(triggers.rows.map(({ tgname }) => tgname));
    for (const name of [
      "finops_co_exact_artifacts_scope_guard",
      "finops_co_exact_artifacts_update_guard",
      "finops_co_exact_chunks_insert_guard",
      "finops_co_exact_manifests_insert_guard",
      "finops_co_exact_heads_guard",
    ]) assert.ok(names.has(name), `missing PostgreSQL trigger ${name}`);

    const constraints = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid = ANY($1::regclass[])`,
      [["finops_co_exact_artifacts", "finops_co_exact_artifact_chunks"]],
    );
    const definitions = constraints.rows.map(({ definition }) => definition).join("\n");
    assert.match(definitions, /byte_count >= 1/u);
    assert.match(definitions, /byte_count <= 983040/u);
    assert.match(definitions, /ALL_REGION_ACCEPTED/u);
    assert.match(definitions, /sutra[.]compute-optimizer-export-generation[.]v1/u);
  } finally {
    await pool.end();
  }
});

test("PostgreSQL rejects an exact artifact over a forged finalized plan-set shell", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  const token = crypto.randomUUID().replaceAll("-", "");
  const org = `org_pg_co_${token}`;
  const customer = `customer_pg_co_${token}`;
  const connection = `conn_${token.slice(0, 32)}`;
  const planSetHash = "b".repeat(64);
  const attemptHash = "a".repeat(64);
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO organizations(id,slug,name,status) VALUES ($1,$2,'PG CO Exact','active')",
      [org, `pg-co-${token}`],
    );
    await client.query(
      "INSERT INTO customers(id,org_id,slug,name,status) VALUES ($1,$2,$3,'PG CO Exact','active')",
      [customer, org, `pg-co-${token}`],
    );
    await client.query(
      `INSERT INTO aws_connections (
        id,org_id,customer_id,source_kind,partition,aws_account_id,role_arn,
        external_id_ciphertext,external_id_key_version,permission_pack_version,
        status,enabled_regions_json
      ) VALUES ($1,$2,$3,'aws_trust_role','aws','111122223333',
        'arn:aws:iam::111122223333:role/sutra/SutraCollectorRole',
        'ct','v1','standard-2026-08.5','active','[]')`,
      [connection, org, customer],
    );
    await client.query(
      `INSERT INTO finops_co_export_plan_sets (
        plan_set_id,org_id,customer_id,connection_id,content_sha256,
        requester_account_id,partition,regions_json,export_families_json,
        plan_ids_json,region_count,export_family_count,plan_count,binding_sha256,
        finalized,created_at
      ) VALUES ($1,$2,$3,$4,$5,'111122223333','aws','["us-east-1"]',
        '["EC2_INSTANCE"]',$6,1,1,1,$7,true,1)`,
      [
        `copes_${planSetHash}`,
        org,
        customer,
        connection,
        planSetHash,
        `["cope_${"c".repeat(64)}"]`,
        "d".repeat(64),
      ],
    );
    await assert.rejects(client.query(
      `INSERT INTO finops_co_exact_artifacts (
        artifact_id,record_kind,schema_version,state,accepted_head_eligible,
        org_id,customer_id,connection_id,plan_set_id,plan_set_content_sha256,
        requester_account_id,partition,content_sha256,evidence_sha256,
        scheduled_window,materialized_at,data_through_at,observed_at,
        expected_target_count,mapped_target_count,recommendation_count,
        rejected_row_count,source_bytes,total_bytes,chunk_count,created_at
      ) VALUES ($1,'ATTEMPT','sutra.compute-optimizer-export-generation-attempt.v1',
        'PARTIAL',false,$2,$3,$4,$5,$6,'111122223333','aws',$7,$8,
        '2026-08-02T00:00:00.000Z','2026-08-02T12:00:00.000Z',
        '2026-08-02T10:30:00.000Z','2026-08-02T11:58:00.000Z',
        1,0,0,0,0,10,1,1)`,
      [
        `coa_${attemptHash}`,
        org,
        customer,
        connection,
        `copes_${planSetHash}`,
        planSetHash,
        attemptHash,
        "e".repeat(64),
      ],
    ), /FINOPS_CO_EXACT_SCOPE_REJECTED/u);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await pool.end();
  }
});
