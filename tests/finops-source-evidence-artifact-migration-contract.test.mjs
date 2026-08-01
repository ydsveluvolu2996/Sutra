import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";

const [
  sqlite,
  postgres,
  runtime,
  postgresRuntime,
  migrator,
  repository,
] = await Promise.all([
  readFile(new URL("../drizzle/0082_finops_source_evidence_artifact.sql", import.meta.url), "utf8"),
  readFile(new URL("../postgres/migrations/0077_finops_source_evidence_artifact.sql", import.meta.url), "utf8"),
  readFile(new URL("../db/runtime-migrations.ts", import.meta.url), "utf8"),
  readFile(new URL("../db/postgres-runtime-migrations.ts", import.meta.url), "utf8"),
  readFile(new URL("../scripts/postgres-migrate.mjs", import.meta.url), "utf8"),
  readFile(new URL("../db/evidence-repository.ts", import.meta.url), "utf8"),
]);

test("dedicated FinOps source evidence artifact is forward-migrated in both runtimes", () => {
  for (const source of [sqlite, postgres]) {
    assert.match(source, /finops_source_snapshot/u);
    assert.match(source, /aws_snapshot_raw/u);
    assert.match(source, /export_json/u);
    assert.match(source, /export_csv/u);
  }
  assert.match(sqlite, /INSERT INTO `evidence_objects_finops_v2`[\s\S]*FROM `evidence_objects`/u);
  assert.match(sqlite, /evidence_objects_immutable_identity/u);
  assert.match(sqlite, /evidence_objects_no_delete/u);
  assert.match(postgres, /DROP CONSTRAINT IF EXISTS evidence_objects_artifact_kind_check/u);
  assert.match(postgres, /ADD CONSTRAINT evidence_objects_artifact_kind_check/u);
  assert.equal(runtime.match(/0082_finops_source_evidence_artifact/gu)?.length, 3);
  assert.match(runtime, /0082_finops_source_evidence_artifact[\s\S]*await db\.batch/u);
  assert.equal(postgresRuntime.match(/0077_finops_source_evidence_artifact/gu)?.length, 2);
  assert.equal(migrator.match(/0077_finops_source_evidence_artifact\.sql/gu)?.length, 1);
});

test("private FinOps evidence cannot be repurposed as a raw or export download", () => {
  assert.match(repository, /"finops_source_snapshot"/u);
  assert.match(
    repository,
    /input\.purpose === "export_download"[\s\S]*object\.artifact_kind !== "export_json"[\s\S]*object\.artifact_kind !== "export_csv"/u,
  );
  assert.match(
    repository,
    /input\.purpose === "raw_evidence_review" && object\.artifact_kind !== "aws_snapshot_raw"/u,
  );
});

test("SQLite forward migration preserves immutable objects and their child bindings", async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-evidence-upgrade-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    const setup = [
      "PRAGMA foreign_keys = ON",
      "CREATE TABLE organizations (id text PRIMARY KEY)",
      "CREATE TABLE customers (id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id))",
      "CREATE TABLE aws_connections (id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id), customer_id text NOT NULL REFERENCES customers(id))",
      `CREATE TABLE evidence_objects (
        id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id),
        customer_id text NOT NULL REFERENCES customers(id),
        connection_id text NOT NULL REFERENCES aws_connections(id), run_id text NOT NULL,
        snapshot_id text, artifact_kind text NOT NULL CHECK (artifact_kind IN
          ('aws_snapshot_raw', 'export_json', 'export_csv')),
        object_key text NOT NULL, content_type text NOT NULL,
        content_sha256 text NOT NULL, byte_size integer NOT NULL,
        status text NOT NULL, retention_until integer NOT NULL,
        created_by text NOT NULL, created_at integer NOT NULL, available_at integer
      )`,
      "CREATE UNIQUE INDEX evidence_objects_key_uq ON evidence_objects (object_key)",
      "CREATE UNIQUE INDEX evidence_objects_run_kind_uq ON evidence_objects (org_id, connection_id, run_id, artifact_kind)",
      "CREATE INDEX evidence_objects_scope_time_idx ON evidence_objects (org_id, customer_id, connection_id, created_at, id)",
      "CREATE TRIGGER evidence_objects_immutable_identity BEFORE UPDATE ON evidence_objects BEGIN SELECT RAISE(ABORT, 'immutable evidence identity'); END",
      "CREATE TRIGGER evidence_objects_no_delete BEFORE DELETE ON evidence_objects BEGIN SELECT RAISE(ABORT, 'immutable evidence object'); END",
      `CREATE TABLE evidence_download_grants (
        id text PRIMARY KEY, org_id text NOT NULL, customer_id text NOT NULL,
        object_id text NOT NULL REFERENCES evidence_objects(id), actor_id text NOT NULL,
        purpose text NOT NULL, token_sha256 text NOT NULL, expires_at integer NOT NULL,
        consumed_at integer, created_at integer NOT NULL
      )`,
      "CREATE UNIQUE INDEX evidence_download_grants_token_uq ON evidence_download_grants (token_sha256)",
      "CREATE INDEX evidence_download_grants_scope_expiry_idx ON evidence_download_grants (org_id, customer_id, actor_id, expires_at)",
      `CREATE TABLE evidence_local_payloads (
        object_id text PRIMARY KEY REFERENCES evidence_objects(id),
        content_sha256 text NOT NULL, byte_size integer NOT NULL,
        body_base64 text NOT NULL, created_at integer NOT NULL
      )`,
      "INSERT INTO organizations VALUES ('org_a')",
      "INSERT INTO customers VALUES ('cust_a', 'org_a')",
      "INSERT INTO aws_connections VALUES ('conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'org_a', 'cust_a')",
      `INSERT INTO evidence_objects VALUES (
        'eobj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'org_a', 'cust_a',
        'conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'run_a', NULL, 'export_json',
        'evidence/v1/opaque', 'application/json', '${"a".repeat(64)}', 2,
        'available', 9999999999999, 'system_test', 1, 1
      )`,
      `INSERT INTO evidence_download_grants VALUES (
        'grant_a', 'org_a', 'cust_a', 'eobj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'usr_a', 'export_download', '${"c".repeat(64)}', 9999999999999, NULL, 1
      )`,
      `INSERT INTO evidence_local_payloads VALUES (
        'eobj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '${"a".repeat(64)}', 2, 'e30=', 1
      )`,
    ];
    for (const statement of setup) await database.prepare(statement).run();
    const migrationStatements = sqlite
      .split("--> statement-breakpoint")
      .map((candidate) => candidate.trim())
      .filter(Boolean);
    await database.batch(migrationStatements.map((statement) =>
      database.prepare(statement)));
    const object = await database.prepare(
      "SELECT id, artifact_kind, object_key FROM evidence_objects",
    ).first();
    assert.deepEqual(object, {
      id: "eobj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      artifact_kind: "export_json",
      object_key: "evidence/v1/opaque",
    });
    assert.equal((await database.prepare(
      "SELECT object_id FROM evidence_download_grants",
    ).first()).object_id, object.id);
    assert.equal((await database.prepare(
      "SELECT object_id FROM evidence_local_payloads",
    ).first()).object_id, object.id);
    const foreignKeyCheck = await database.prepare("PRAGMA foreign_key_check").all();
    assert.deepEqual(foreignKeyCheck.results ?? [], []);
    await assert.rejects(
      database.prepare("DELETE FROM evidence_objects WHERE id = ?").bind(object.id).run(),
      /immutable evidence object/u,
    );
    await database.prepare(
      `INSERT INTO evidence_objects VALUES (
        'eobj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'org_a', 'cust_a',
        'conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'run_b', NULL,
        'finops_source_snapshot', 'evidence/v1/opaque-b', 'application/json',
        '${"b".repeat(64)}', 2, 'available', 9999999999999, 'system_test', 2, 2
      )`,
    ).run();
  } finally {
    await miniflare.dispose();
  }
});
