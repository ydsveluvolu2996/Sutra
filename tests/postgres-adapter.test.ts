import assert from "node:assert/strict";
import test from "node:test";
import { closePostgresDatabase, postgresDatabase, postgresSqlFromD1 } from "../db/postgres-d1-adapter.ts";

test("D1 SQL placeholders and conflict-ignore inserts translate to PostgreSQL", () => {
  assert.equal(
    postgresSqlFromD1("SELECT '?' AS literal, id FROM users WHERE issuer = ? AND email = ?"),
    "SELECT '?' AS literal, id FROM users WHERE issuer = $1 AND email = $2",
  );
  assert.equal(
    postgresSqlFromD1("INSERT OR IGNORE INTO organizations (id, slug) VALUES (?, ?);"),
    "INSERT INTO organizations (id, slug) VALUES ($1, $2) ON CONFLICT DO NOTHING;",
  );
  assert.match(
    postgresSqlFromD1("SELECT COALESCE(MAX(mutation_sequence), 0) + 1 FROM local_schedule_mutation_outbox"),
    /nextval\('local_schedule_mutation_sequence'\)/u,
  );
});

const databaseUrl = process.env.SUTRA_POSTGRES_TEST_URL?.trim();
const runtimeDatabaseUrl = process.env.SUTRA_POSTGRES_RUNTIME_TEST_URL?.trim();

test("PostgreSQL adapter preserves D1 query and atomic batch semantics", {
  skip: databaseUrl ? false : "set SUTRA_POSTGRES_TEST_URL to run the Docker PostgreSQL integration test",
}, async () => {
  assert.ok(databaseUrl);
  const db = postgresDatabase(databaseUrl);
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const table = `sutra_adapter_test_${suffix}`;

  try {
    await db.prepare(`CREATE TABLE ${table} (id text PRIMARY KEY NOT NULL, value bigint NOT NULL)`).run();
    const inserted = await db.prepare(
      `INSERT OR IGNORE INTO ${table} (id, value) VALUES (?, ?)`,
    ).bind("one", 9_007).run();
    assert.equal(inserted.meta?.changes, 1);

    const ignored = await db.prepare(
      `INSERT OR IGNORE INTO ${table} (id, value) VALUES (?, ?)`,
    ).bind("one", 10).run();
    assert.equal(ignored.meta?.changes, 0);

    const row = await db.prepare(`SELECT id, value FROM ${table} WHERE id = ?`).bind("one").first<{
      id: string;
      value: number;
    }>();
    assert.deepEqual(row, { id: "one", value: 9_007 });

    await assert.rejects(db.batch([
      db.prepare(`INSERT INTO ${table} (id, value) VALUES (?, ?)`).bind("two", 2),
      db.prepare(`INSERT INTO ${table} (id, value) VALUES (?, ?)`).bind("one", 3),
    ]));
    const rolledBack = await db.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind("two").first();
    assert.equal(rolledBack, null);
  } finally {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
    await closePostgresDatabase();
  }
});

test("PostgreSQL runtime role can use application data but cannot create schema", {
  skip: runtimeDatabaseUrl ? false : "set SUTRA_POSTGRES_RUNTIME_TEST_URL to test the restricted runtime role",
}, async () => {
  assert.ok(runtimeDatabaseUrl);
  const runtime = postgresDatabase(runtimeDatabaseUrl);
  try {
    const migration = await runtime.prepare(
      "SELECT migration_id FROM sutra_runtime_migrations WHERE migration_id = ?",
    ).bind("0000_sutra_baseline").first<{ migration_id: string }>();
    assert.equal(migration?.migration_id, "0000_sutra_baseline");
    await assert.rejects(
      runtime.prepare("CREATE TABLE sutra_runtime_must_not_create (id text PRIMARY KEY)").run(),
      /permission denied/iu,
    );
  } finally {
    await closePostgresDatabase();
  }
});
