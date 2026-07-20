import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const sqlite = await readFile(resolve(root, "drizzle/0037_finops_unit_counts.sql"), "utf8");
const postgres = await readFile(resolve(root, "postgres/migrations/0031_finops_unit_counts.sql"), "utf8");
const d1Runner = await readFile(resolve(root, "db/runtime-migrations.ts"), "utf8");
const pgVerify = await readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8");
const pgApply = await readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8");

const COLUMNS = ["id", "org_id", "customer_id", "period", "unit_label", "unit_count", "created_at", "updated_at"];

test("both dialects define finops_unit_counts with the same columns", () => {
  assert.match(sqlite, /CREATE TABLE IF NOT EXISTS finops_unit_counts/u);
  assert.match(postgres, /CREATE TABLE IF NOT EXISTS finops_unit_counts/u);
  for (const column of COLUMNS) {
    assert.ok(new RegExp(`\\b${column}\\b`, "u").test(sqlite), `sqlite migration is missing ${column}`);
    assert.ok(new RegExp(`\\b${column}\\b`, "u").test(postgres), `postgres migration is missing ${column}`);
  }
});

test("tenant-scoped with a unique key over (org_id, customer_id, period, unit_label) and a non-negative count", () => {
  // The count denominator can never be negative — enforced in the schema itself.
  assert.match(sqlite, /unit_count[\s\S]*CHECK \(unit_count >= 0\)/u);
  assert.match(postgres, /unit_count[\s\S]*CHECK \(unit_count >= 0\)/u);
  // The upsert conflict target must be backed by a unique index in both dialects.
  assert.match(sqlite, /CREATE UNIQUE INDEX IF NOT EXISTS finops_unit_counts_key ON finops_unit_counts \(org_id, customer_id, period, unit_label\)/u);
  assert.match(postgres, /CREATE UNIQUE INDEX IF NOT EXISTS finops_unit_counts_key ON finops_unit_counts \(org_id, customer_id, period, unit_label\)/u);
});

test("registered in all three appliers/verifiers, in order after contact_submissions", () => {
  assert.ok(
    d1Runner.includes('"0037_finops_unit_counts"') &&
      d1Runner.indexOf("0036_contact_submissions") < d1Runner.indexOf("0037_finops_unit_counts"),
  );
  assert.ok(
    pgVerify.includes('"0031_finops_unit_counts"') &&
      pgVerify.indexOf("0030_contact_submissions") < pgVerify.indexOf("0031_finops_unit_counts"),
  );
  assert.ok(
    pgApply.includes('"0031_finops_unit_counts.sql"') &&
      pgApply.indexOf("0030_contact_submissions.sql") < pgApply.indexOf("0031_finops_unit_counts.sql"),
  );
});
