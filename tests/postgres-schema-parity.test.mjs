import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import pg from "pg";

const root = resolve(import.meta.dirname, "..");
const snapshot = JSON.parse(await readFile(resolve(root, "drizzle/meta/0013_snapshot.json"), "utf8"));
const postBaselineD1Migrations = await Promise.all(
  (await readdir(resolve(root, "drizzle"), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d{4}_.+\.sql$/u.test(entry.name))
    .filter((entry) => Number.parseInt(entry.name.slice(0, 4), 10) > 13)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => readFile(resolve(root, "drizzle", entry.name), "utf8")),
);
const postgresMigrations = (
  await Promise.all([
    "0000_sutra_baseline.sql",
    "0001_finops_cost_snapshots.sql",
    "0002_case_management.sql",
    "0003_security_events.sql",
    "0004_compliance_exceptions.sql",
    "0005_hosted_identity_lifecycle.sql",
    "0006_kubernetes_persistence.sql",
    "0007_kubernetes_scanner_evidence.sql",
  ].map((file) => readFile(resolve(root, "postgres/migrations", file), "utf8")))
).join("\n--> statement-breakpoint\n");

function expectedSchema() {
  const tables = new Map();
  const indexes = new Map();
  for (const table of Object.values(snapshot.tables)) {
    tables.set(table.name, Object.values(table.columns).map((column) => column.name).sort());
    for (const index of Object.values(table.indexes)) {
      indexes.set(index.name, {
        table: table.name,
        columns: [...index.columns],
        unique: index.isUnique,
      });
    }
  }
  return { tables, indexes };
}

function expectedCurrentSchema() {
  const schema = expectedSchema();
  const addColumn = /^ALTER TABLE\s+[`"]?([a-z_][a-z0-9_]*)[`"]?\s+ADD(?:\s+COLUMN)?\s+[`"]?([a-z_][a-z0-9_]*)[`"]?\b/gimu;

  // Snapshot 0013 is the immutable source for the PostgreSQL baseline. Later
  // hand-authored D1 migrations can still evolve those baseline tables, so the
  // live catalog comparison must apply their forward-only ADD COLUMN changes.
  for (const migration of postBaselineD1Migrations) {
    for (const match of migration.matchAll(addColumn)) {
      const columns = schema.tables.get(match[1]);
      if (columns !== undefined && !columns.includes(match[2])) {
        columns.push(match[2]);
        columns.sort();
      }
    }
  }

  return schema;
}

function postgresBaselineSchema() {
  const tables = new Map();
  const indexes = new Map();
  for (const statement of postgresMigrations.split("--> statement-breakpoint").map((value) => value.trim())) {
    const table = /CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)\s*\(([\s\S]+)\);?$/iu.exec(statement);
    if (table !== null) {
      const columns = table[2]
        .split("\n")
        .map((line) => line.trim().replace(/,$/u, ""))
        .filter((line) => /^[a-z_][a-z0-9_]*\s/iu.test(line))
        .map((line) => line.split(/\s+/u)[0])
        .sort();
      tables.set(table[1], columns);
      continue;
    }
    const index = /^CREATE\s+(UNIQUE\s+)?INDEX IF NOT EXISTS\s+([a-z0-9_]+)\s+ON\s+([a-z0-9_]+)\s*\(([^)]+)\)/iu.exec(statement);
    if (index !== null) {
      indexes.set(index[2], {
        table: index[3],
        columns: index[4].split(",").map((column) => column.trim()),
        unique: index[1] !== undefined,
      });
    }
  }
  return { tables, indexes };
}

function sortedEntries(map) {
  return [...map.entries()].sort(([left], [right]) => left.localeCompare(right));
}

test("PostgreSQL baseline contains every current D1 application table, column, and index", () => {
  const expected = expectedSchema();
  const actual = postgresBaselineSchema();
  assert.deepEqual(sortedEntries(actual.tables), sortedEntries(expected.tables));
  assert.deepEqual(sortedEntries(actual.indexes), sortedEntries(expected.indexes));
});

test("current D1 expectations include columns added after the generated baseline snapshot", () => {
  const current = expectedCurrentSchema();
  assert.ok(current.tables.get("identity_invitations")?.includes("customer_id"));
  assert.ok(current.tables.get("kubernetes_scan_runs")?.includes("nodes_json"));
});

const databaseUrl = process.env.SUTRA_POSTGRES_TEST_URL?.trim();

test("migrated PostgreSQL catalog matches the current D1 application schema", {
  skip: databaseUrl ? false : "set SUTRA_POSTGRES_TEST_URL to inspect the migrated PostgreSQL catalog",
}, async () => {
  assert.ok(databaseUrl);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const expected = expectedCurrentSchema();
    const tableNames = [...expected.tables.keys()];
    const columnResult = await pool.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ANY($1::text[])
        ORDER BY table_name, ordinal_position`,
      [tableNames],
    );
    const actualTables = new Map(tableNames.map((name) => [name, []]));
    for (const row of columnResult.rows) actualTables.get(row.table_name)?.push(row.column_name);
    for (const columns of actualTables.values()) columns.sort();
    assert.deepEqual(sortedEntries(actualTables), sortedEntries(expected.tables));

    const expectedIndexNames = [...expected.indexes.keys()];
    const indexResult = await pool.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema() AND indexname = ANY($1::text[])
        ORDER BY indexname`,
      [expectedIndexNames],
    );
    assert.deepEqual(indexResult.rows.map((row) => row.indexname), expectedIndexNames.sort());
  } finally {
    await pool.end();
  }
});
