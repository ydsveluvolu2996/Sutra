import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const [sqlite, postgres, d1Runner, pgRuntime, pgApply, schema] = await Promise.all([
  readFile(resolve(root, "drizzle/0069_dspm_workspace.sql"), "utf8"),
  readFile(resolve(root, "postgres/migrations/0063_dspm_workspace.sql"), "utf8"),
  readFile(resolve(root, "db/runtime-migrations.ts"), "utf8"),
  readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8"),
  readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8"),
  readFile(resolve(root, "db/schema.ts"), "utf8"),
]);

test("D1 and PostgreSQL migrations define scoped DSPM runs, assets and heads", () => {
  for (const table of ["dspm_scan_runs", "dspm_asset_evidence", "dspm_scan_heads"]) {
    assert.match(sqlite, new RegExp("CREATE TABLE `" + table + "`", "u"));
    assert.match(postgres, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "u"));
    assert.ok(schema.includes(`"${table}"`));
  }
  for (const column of ["org_id", "customer_id", "connection_id", "scan_run_id", "evidence_sha256", "risk_score"]) {
    assert.ok(sqlite.includes(`\`${column}\``), `D1 migration missing ${column}`);
    assert.match(postgres, new RegExp(`\\b${column}\\b`, "u"));
  }
});

test("evidence tables are immutable and publications are idempotent", () => {
  assert.match(sqlite, /dspm_scan_runs_no_update/u);
  assert.match(sqlite, /dspm_asset_evidence_no_delete/u);
  assert.match(postgres, /BEFORE UPDATE OR DELETE ON dspm_scan_runs/u);
  assert.match(postgres, /BEFORE UPDATE OR DELETE ON dspm_asset_evidence/u);
  assert.match(sqlite, /dspm_scan_runs_idempotency_uq/u);
  assert.match(postgres, /dspm_scan_runs_idempotency_uq/u);
});

test("both runtime verifiers and the PostgreSQL migrator register the new migrations", () => {
  assert.ok(d1Runner.includes('"0069_dspm_workspace"'));
  assert.ok(pgRuntime.includes('"0063_dspm_workspace"'));
  assert.ok(pgApply.includes('"0063_dspm_workspace.sql"'));
});
