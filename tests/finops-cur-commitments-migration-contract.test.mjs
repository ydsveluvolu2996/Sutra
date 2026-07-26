import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const sqlite = await readFile(resolve(root, "drizzle/0057_finops_cur_commitments.sql"), "utf8");
const postgres = await readFile(resolve(root, "postgres/migrations/0051_finops_cur_commitments.sql"), "utf8");
const d1Runner = await readFile(resolve(root, "db/runtime-migrations.ts"), "utf8");
const pgVerify = await readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8");
const pgApply = await readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8");

test("both dialects add the four nullable commitment columns to finops_cur_lines", () => {
  // SQLite: one ALTER per column, separated by statement breakpoints.
  assert.match(sqlite, /ALTER TABLE finops_cur_lines ADD COLUMN amortized_micros integer/u);
  assert.match(sqlite, /ALTER TABLE finops_cur_lines ADD COLUMN commitment_type text/u);
  assert.match(sqlite, /ALTER TABLE finops_cur_lines ADD COLUMN commitment_id text/u);
  assert.match(sqlite, /ALTER TABLE finops_cur_lines ADD COLUMN commitment_expiry text/u);
  assert.equal((sqlite.match(/--> statement-breakpoint/gu) ?? []).length, 3);

  // Postgres: each column added IF NOT EXISTS (additive + idempotent).
  assert.match(postgres, /ALTER TABLE finops_cur_lines ADD COLUMN IF NOT EXISTS amortized_micros bigint/u);
  assert.match(postgres, /ALTER TABLE finops_cur_lines ADD COLUMN IF NOT EXISTS commitment_type text/u);
  assert.match(postgres, /ALTER TABLE finops_cur_lines ADD COLUMN IF NOT EXISTS commitment_id text/u);
  assert.match(postgres, /ALTER TABLE finops_cur_lines ADD COLUMN IF NOT EXISTS commitment_expiry text/u);
});

test("registered in all three appliers/verifiers, in order after finops_cur_region", () => {
  assert.ok(
    d1Runner.includes('"0057_finops_cur_commitments"') &&
      d1Runner.indexOf("0056_finops_cur_region") < d1Runner.indexOf("0057_finops_cur_commitments"),
  );
  assert.ok(
    pgVerify.includes('"0051_finops_cur_commitments"') &&
      pgVerify.indexOf("0050_finops_cur_region") < pgVerify.indexOf("0051_finops_cur_commitments"),
  );
  assert.ok(
    pgApply.includes('"0051_finops_cur_commitments.sql"') &&
      pgApply.indexOf("0050_finops_cur_region.sql") < pgApply.indexOf("0051_finops_cur_commitments.sql"),
  );
});
