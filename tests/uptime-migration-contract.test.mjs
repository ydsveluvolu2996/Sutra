import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const sqlite = await readFile(resolve(root, "drizzle/0044_uptime_samples.sql"), "utf8");
const postgres = await readFile(resolve(root, "postgres/migrations/0038_uptime_samples.sql"), "utf8");
const d1Runner = await readFile(resolve(root, "db/runtime-migrations.ts"), "utf8");
const pgVerify = await readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8");
const pgApply = await readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8");

const COLUMNS = ["id", "component", "observed_at", "healthy", "detail", "created_at"];

/** Strip `--` comment lines so assertions test the DDL, not the prose. */
function ddl(sql) {
  return sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
}

test("both dialects define uptime_samples with the same columns", () => {
  for (const sql of [sqlite, postgres]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS uptime_samples/u);
    for (const column of COLUMNS) {
      assert.ok(new RegExp(`\\b${column}\\b`, "u").test(sql), `uptime_samples missing ${column}`);
    }
  }
});

test("healthy is constrained to 0/1 and there is no tenant/secret column", () => {
  for (const sql of [sqlite, postgres]) {
    assert.match(sql, /healthy INTEGER NOT NULL DEFAULT 0 CHECK \(healthy IN \(0, 1\)\)/u);
    // System/platform health carries no tenant scope and stores no secret.
    const definition = ddl(sql);
    assert.doesNotMatch(definition, /\borg_id\b|\bcustomer_id\b/u);
    assert.doesNotMatch(definition, /secret|token|password|api_key/iu);
  }
});

test("the component/observed_at lookup index exists in both dialects", () => {
  for (const sql of [sqlite, postgres]) {
    assert.match(
      sql,
      /CREATE INDEX IF NOT EXISTS uptime_samples_component_observed ON uptime_samples \(component, observed_at\)/u,
    );
  }
});

// NOTE FOR THE PARENT: these registration assertions fail until the parent
// registers migration 0044 (drizzle) / 0038 (postgres) in the three appliers.
// This agent deliberately did NOT edit those files.
test("registered in all three appliers/verifiers, ordered after the preceding migration", () => {
  assert.ok(d1Runner.includes('"0044_uptime_samples"'), "not in the D1 applier list");
  assert.ok(
    d1Runner.indexOf("0043_cmdb_custom_assets") < d1Runner.indexOf("0044_uptime_samples"),
    "D1 order wrong",
  );
  assert.ok(pgVerify.includes('"0038_uptime_samples"'), "not in the Postgres verifier list");
  assert.ok(
    pgVerify.indexOf("0037_cmdb_custom_assets") < pgVerify.indexOf("0038_uptime_samples"),
    "Postgres verifier order wrong",
  );
  assert.ok(pgApply.includes('"0038_uptime_samples.sql"'), "not in the Postgres applier list");
  assert.ok(
    pgApply.indexOf("0037_cmdb_custom_assets.sql") < pgApply.indexOf("0038_uptime_samples.sql"),
    "Postgres applier order wrong",
  );
});
