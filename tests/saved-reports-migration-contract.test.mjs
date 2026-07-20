import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const sqlite = await readFile(resolve(root, "drizzle/0040_saved_reports.sql"), "utf8");
const postgres = await readFile(resolve(root, "postgres/migrations/0034_saved_reports.sql"), "utf8");
const d1Runner = await readFile(resolve(root, "db/runtime-migrations.ts"), "utf8");
const pgVerify = await readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8");
const pgApply = await readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8");

const COLUMNS = ["id", "org_id", "customer_id", "name", "dataset", "definition_json", "created_by", "created_at", "updated_at"];

test("both dialects define saved_reports with the same columns", () => {
  assert.match(sqlite, /CREATE TABLE IF NOT EXISTS saved_reports/u);
  assert.match(postgres, /CREATE TABLE IF NOT EXISTS saved_reports/u);
  for (const column of COLUMNS) {
    assert.ok(new RegExp(`\\b${column}\\b`, "u").test(sqlite), `sqlite migration is missing ${column}`);
    assert.ok(new RegExp(`\\b${column}\\b`, "u").test(postgres), `postgres migration is missing ${column}`);
  }
});

test("tenant-scoped with a unique key over (org_id, name) backing the upsert", () => {
  assert.match(sqlite, /CREATE UNIQUE INDEX IF NOT EXISTS saved_reports_name ON saved_reports \(org_id, name\)/u);
  assert.match(postgres, /CREATE UNIQUE INDEX IF NOT EXISTS saved_reports_name ON saved_reports \(org_id, name\)/u);
});

// NOTE FOR THE PARENT: this suite fails until the migration is registered in the
// three appliers. The child agent is forbidden from editing those files; the
// parent must add 0040 (D1) after 0039_kubernetes_node_side_array and 0034
// (Postgres) after 0033_kubernetes_node_side_array.
test("registered in all three appliers/verifiers, in order after kubernetes_node_side_array", () => {
  assert.ok(
    d1Runner.includes('"0040_saved_reports"') &&
      d1Runner.indexOf("0039_kubernetes_node_side_array") < d1Runner.indexOf("0040_saved_reports"),
  );
  assert.ok(
    pgVerify.includes('"0034_saved_reports"') &&
      pgVerify.indexOf("0033_kubernetes_node_side_array") < pgVerify.indexOf("0034_saved_reports"),
  );
  assert.ok(
    pgApply.includes('"0034_saved_reports.sql"') &&
      pgApply.indexOf("0033_kubernetes_node_side_array.sql") < pgApply.indexOf("0034_saved_reports.sql"),
  );
});
