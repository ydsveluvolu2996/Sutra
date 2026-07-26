import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const sqlite = await readFile(resolve(root, "drizzle/0056_finops_cur_region.sql"), "utf8");
const postgres = await readFile(resolve(root, "postgres/migrations/0050_finops_cur_region.sql"), "utf8");
const d1Runner = await readFile(resolve(root, "db/runtime-migrations.ts"), "utf8");
const pgVerify = await readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8");
const pgApply = await readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8");

test("both dialects add a nullable region column to finops_cur_lines", () => {
  assert.match(sqlite, /ALTER TABLE finops_cur_lines ADD COLUMN region text/u);
  assert.match(postgres, /ALTER TABLE finops_cur_lines ADD COLUMN IF NOT EXISTS region text/u);
});

test("registered in all three appliers/verifiers, in order after background_jobs_kind_index", () => {
  assert.ok(
    d1Runner.includes('"0056_finops_cur_region"') &&
      d1Runner.indexOf("0055_background_jobs_kind_index") < d1Runner.indexOf("0056_finops_cur_region"),
  );
  assert.ok(
    pgVerify.includes('"0050_finops_cur_region"') &&
      pgVerify.indexOf("0049_background_jobs_kind_index") < pgVerify.indexOf("0050_finops_cur_region"),
  );
  assert.ok(
    pgApply.includes('"0050_finops_cur_region.sql"') &&
      pgApply.indexOf("0049_background_jobs_kind_index.sql") < pgApply.indexOf("0050_finops_cur_region.sql"),
  );
});
