import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const sqlite = await readFile(resolve(root, "drizzle/0058_finops_allocation_rules.sql"), "utf8");
const postgres = await readFile(resolve(root, "postgres/migrations/0052_finops_allocation_rules.sql"), "utf8");
const d1Runner = await readFile(resolve(root, "db/runtime-migrations.ts"), "utf8");
const pgVerify = await readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8");
const pgApply = await readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8");

test("both dialects create allocation_rules with a match/target shape and an index", () => {
  assert.match(sqlite, /CREATE TABLE IF NOT EXISTS allocation_rules/u);
  assert.match(sqlite, /match_json text NOT NULL/u);
  assert.match(sqlite, /target_kind text NOT NULL/u);
  assert.match(sqlite, /CREATE INDEX IF NOT EXISTS allocation_rules_org/u);

  assert.match(postgres, /CREATE TABLE IF NOT EXISTS allocation_rules/u);
  assert.match(postgres, /match_json text NOT NULL/u);
  assert.match(postgres, /target_kind text NOT NULL/u);
  assert.match(postgres, /CREATE INDEX IF NOT EXISTS allocation_rules_org/u);
});

test("registered in all three appliers/verifiers, in order after finops_cur_commitments", () => {
  assert.ok(
    d1Runner.includes('"0058_finops_allocation_rules"') &&
      d1Runner.indexOf("0057_finops_cur_commitments") < d1Runner.indexOf("0058_finops_allocation_rules"),
  );
  assert.ok(
    pgVerify.includes('"0052_finops_allocation_rules"') &&
      pgVerify.indexOf("0051_finops_cur_commitments") < pgVerify.indexOf("0052_finops_allocation_rules"),
  );
  assert.ok(
    pgApply.includes('"0052_finops_allocation_rules.sql"') &&
      pgApply.indexOf("0051_finops_cur_commitments.sql") < pgApply.indexOf("0052_finops_allocation_rules.sql"),
  );
});
