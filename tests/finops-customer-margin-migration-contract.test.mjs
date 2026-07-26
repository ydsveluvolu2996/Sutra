import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const sqlite = await readFile(resolve(root, "drizzle/0059_finops_customer_margin.sql"), "utf8");
const postgres = await readFile(resolve(root, "postgres/migrations/0053_finops_customer_margin.sql"), "utf8");
const d1Runner = await readFile(resolve(root, "db/runtime-migrations.ts"), "utf8");
const pgVerify = await readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8");
const pgApply = await readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8");

test("both dialects create customer_margin with a per-(org,customer) unique scope", () => {
  assert.match(sqlite, /CREATE TABLE IF NOT EXISTS customer_margin/u);
  assert.match(sqlite, /markup_percent real NOT NULL DEFAULT 0/u);
  assert.match(sqlite, /CREATE UNIQUE INDEX IF NOT EXISTS customer_margin_scope ON customer_margin \(org_id, customer_id\)/u);

  assert.match(postgres, /CREATE TABLE IF NOT EXISTS customer_margin/u);
  assert.match(postgres, /markup_percent real NOT NULL DEFAULT 0/u);
  assert.match(postgres, /monthly_fee_micros bigint NOT NULL DEFAULT 0/u);
  assert.match(postgres, /CREATE UNIQUE INDEX IF NOT EXISTS customer_margin_scope ON customer_margin \(org_id, customer_id\)/u);
});

test("registered in all three appliers/verifiers, in order after finops_allocation_rules", () => {
  assert.ok(
    d1Runner.includes('"0059_finops_customer_margin"') &&
      d1Runner.indexOf("0058_finops_allocation_rules") < d1Runner.indexOf("0059_finops_customer_margin"),
  );
  assert.ok(
    pgVerify.includes('"0053_finops_customer_margin"') &&
      pgVerify.indexOf("0052_finops_allocation_rules") < pgVerify.indexOf("0053_finops_customer_margin"),
  );
  assert.ok(
    pgApply.includes('"0053_finops_customer_margin.sql"') &&
      pgApply.indexOf("0052_finops_allocation_rules.sql") < pgApply.indexOf("0053_finops_customer_margin.sql"),
  );
});
