import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const sqlite = await readFile(resolve(root, "drizzle/0038_finops_scheduled_reports.sql"), "utf8");
const postgres = await readFile(resolve(root, "postgres/migrations/0032_finops_scheduled_reports.sql"), "utf8");
const d1Runner = await readFile(resolve(root, "db/runtime-migrations.ts"), "utf8");
const pgVerify = await readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8");
const pgApply = await readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8");

const COLUMNS = [
  "id", "org_id", "customer_id", "name", "connection_id", "cadence",
  "delivery_kind", "delivery_target", "enabled", "last_run_at", "next_run_at",
  "created_by", "created_at", "updated_at",
];

test("both dialects define finops_scheduled_reports with the same columns", () => {
  assert.match(sqlite, /CREATE TABLE IF NOT EXISTS finops_scheduled_reports/u);
  assert.match(postgres, /CREATE TABLE IF NOT EXISTS finops_scheduled_reports/u);
  for (const column of COLUMNS) {
    assert.ok(new RegExp(`\\b${column}\\b`, "u").test(sqlite), `sqlite migration is missing ${column}`);
    assert.ok(new RegExp(`\\b${column}\\b`, "u").test(postgres), `postgres migration is missing ${column}`);
  }
});

test("tenant-scoped, cadence/delivery-kind are constrained, and delivery stores NO secret", () => {
  assert.match(sqlite, /cadence[\s\S]*CHECK \(cadence IN \('weekly', 'monthly'\)\)/u);
  assert.match(postgres, /cadence[\s\S]*CHECK \(cadence IN \('weekly', 'monthly'\)\)/u);
  assert.match(sqlite, /delivery_kind[\s\S]*CHECK \(delivery_kind IN \('webhook', 'email'\)\)/u);
  assert.match(postgres, /delivery_kind[\s\S]*CHECK \(delivery_kind IN \('webhook', 'email'\)\)/u);
  // Only a destination is stored — never a token/secret/authorization column.
  assert.doesNotMatch(sqlite, /secret|token|password|api_key/iu);
  assert.doesNotMatch(postgres, /secret|token|password|api_key/iu);
  // Upsert-by-name unique index plus a due-scan index.
  assert.match(sqlite, /CREATE UNIQUE INDEX IF NOT EXISTS finops_scheduled_reports_name ON finops_scheduled_reports \(org_id, name\)/u);
  assert.match(sqlite, /CREATE INDEX IF NOT EXISTS finops_scheduled_reports_due ON finops_scheduled_reports \(enabled, next_run_at\)/u);
});

test("registered in all three appliers/verifiers, in order after finops_unit_counts", () => {
  assert.ok(
    d1Runner.includes('"0038_finops_scheduled_reports"') &&
      d1Runner.indexOf("0037_finops_unit_counts") < d1Runner.indexOf("0038_finops_scheduled_reports"),
  );
  assert.ok(
    pgVerify.includes('"0032_finops_scheduled_reports"') &&
      pgVerify.indexOf("0031_finops_unit_counts") < pgVerify.indexOf("0032_finops_scheduled_reports"),
  );
  assert.ok(
    pgApply.includes('"0032_finops_scheduled_reports.sql"') &&
      pgApply.indexOf("0031_finops_unit_counts.sql") < pgApply.indexOf("0032_finops_scheduled_reports.sql"),
  );
});
