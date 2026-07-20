import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const sqlite = await readFile(resolve(root, "drizzle/0043_cmdb_custom_assets.sql"), "utf8");
const postgres = await readFile(resolve(root, "postgres/migrations/0037_cmdb_custom_assets.sql"), "utf8");
const d1Runner = await readFile(resolve(root, "db/runtime-migrations.ts"), "utf8");
const pgVerify = await readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8");
const pgApply = await readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8");

const COLUMNS = [
  "id",
  "org_id",
  "customer_id",
  "asset_type",
  "name",
  "source",
  "external_id",
  "fields_json",
  "created_by",
  "created_at",
  "updated_at",
];

test("both dialects define cmdb_custom_assets with the same columns", () => {
  assert.match(sqlite, /CREATE TABLE IF NOT EXISTS cmdb_custom_assets/u);
  assert.match(postgres, /CREATE TABLE IF NOT EXISTS cmdb_custom_assets/u);
  for (const column of COLUMNS) {
    assert.ok(new RegExp(`\\b${column}\\b`, "u").test(sqlite), `sqlite migration is missing ${column}`);
    assert.ok(new RegExp(`\\b${column}\\b`, "u").test(postgres), `postgres migration is missing ${column}`);
  }
});

test("tenant-scoped with a unique key over (org_id, asset_type, name) in both dialects", () => {
  // The upsert conflict target must be backed by a unique index in both dialects.
  assert.match(sqlite, /CREATE UNIQUE INDEX IF NOT EXISTS cmdb_custom_assets_key ON cmdb_custom_assets \(org_id, asset_type, name\)/u);
  assert.match(postgres, /CREATE UNIQUE INDEX IF NOT EXISTS cmdb_custom_assets_key ON cmdb_custom_assets \(org_id, asset_type, name\)/u);
  // fields_json defaults to an empty object so a fieldless asset is honest, not null.
  assert.match(sqlite, /fields_json TEXT NOT NULL DEFAULT '\{\}'/u);
  assert.match(postgres, /fields_json TEXT NOT NULL DEFAULT '\{\}'/u);
});

// NOTE FOR PARENT: this migration is intentionally NOT self-registered. The
// parent registers drizzle 0043 / postgres 0037. Until then, this block fails —
// that failure is expected and is the only reason this test does not pass on the
// authoring agent's run.
test("registered in all three appliers/verifiers, in order after saved_reports", () => {
  assert.ok(
    d1Runner.includes('"0043_cmdb_custom_assets"') &&
      d1Runner.indexOf("0040_saved_reports") < d1Runner.indexOf("0043_cmdb_custom_assets"),
  );
  assert.ok(
    pgVerify.includes('"0037_cmdb_custom_assets"') &&
      pgVerify.indexOf("0034_saved_reports") < pgVerify.indexOf("0037_cmdb_custom_assets"),
  );
  assert.ok(
    pgApply.includes('"0037_cmdb_custom_assets.sql"') &&
      pgApply.indexOf("0034_saved_reports.sql") < pgApply.indexOf("0037_cmdb_custom_assets.sql"),
  );
});
