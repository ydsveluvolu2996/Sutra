import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const sqlite = await readFile(resolve(root, "drizzle/0042_cmdb_relationships.sql"), "utf8");
const postgres = await readFile(resolve(root, "postgres/migrations/0036_cmdb_relationships.sql"), "utf8");
const d1Runner = await readFile(resolve(root, "db/runtime-migrations.ts"), "utf8");
const pgVerify = await readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8");
const pgApply = await readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8");

const COLUMNS = [
  "id", "org_id", "customer_id", "from_key", "to_key", "rel_type", "note",
  "created_by", "created_at", "updated_at",
];

// The table is named cmdb_manual_relationships to avoid colliding with the
// pre-existing cmdb_relationships table (migration 0001, collector snapshot
// edges). The migration FILE keeps the 0042/0036 stem the parent registers.
test("both dialects define cmdb_manual_relationships with the same columns", () => {
  assert.match(sqlite, /CREATE TABLE IF NOT EXISTS cmdb_manual_relationships/u);
  assert.match(postgres, /CREATE TABLE IF NOT EXISTS cmdb_manual_relationships/u);
  // It must NOT redefine the existing collector relationships table.
  assert.doesNotMatch(sqlite, /CREATE TABLE IF NOT EXISTS cmdb_relationships\b/u);
  assert.doesNotMatch(postgres, /CREATE TABLE IF NOT EXISTS cmdb_relationships\b/u);
  for (const column of COLUMNS) {
    assert.ok(new RegExp(`\\b${column}\\b`, "u").test(sqlite), `sqlite migration is missing ${column}`);
    assert.ok(new RegExp(`\\b${column}\\b`, "u").test(postgres), `postgres migration is missing ${column}`);
  }
});

test("the edge is uniquely keyed by (org_id, from_key, to_key, rel_type) and tenant-indexed", () => {
  const unique = /CREATE UNIQUE INDEX IF NOT EXISTS cmdb_manual_relationships_edge ON cmdb_manual_relationships \(org_id, from_key, to_key, rel_type\)/u;
  assert.match(sqlite, unique);
  assert.match(postgres, unique);
  const customer = /CREATE INDEX IF NOT EXISTS cmdb_manual_relationships_customer ON cmdb_manual_relationships \(org_id, customer_id\)/u;
  assert.match(sqlite, customer);
  assert.match(postgres, customer);
  // Manual edges store operator intent only — never any collected-evidence blob.
  assert.doesNotMatch(sqlite, /configuration|evidence|secret|token/iu);
  assert.doesNotMatch(postgres, /configuration|evidence|secret|token/iu);
});

// NOTE: registration in the three appliers is owned by the PARENT (drizzle 0042
// / postgres 0036). Until it lands, this assertion fails by design — it is the
// only expected failure when the migration is run in isolation.
test("registered in all three appliers/verifiers, in order after alert_rules", () => {
  assert.ok(
    d1Runner.includes('"0042_cmdb_relationships"') &&
      d1Runner.indexOf("0041_alert_rules") < d1Runner.indexOf("0042_cmdb_relationships"),
  );
  assert.ok(
    pgVerify.includes('"0036_cmdb_relationships"') &&
      pgVerify.indexOf("0035_alert_rules") < pgVerify.indexOf("0036_cmdb_relationships"),
  );
  assert.ok(
    pgApply.includes('"0036_cmdb_relationships.sql"') &&
      pgApply.indexOf("0035_alert_rules.sql") < pgApply.indexOf("0036_cmdb_relationships.sql"),
  );
});
