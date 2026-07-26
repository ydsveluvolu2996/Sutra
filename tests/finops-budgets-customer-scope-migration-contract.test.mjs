import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const sqlite = await readFile(resolve(root, "drizzle/0060_finops_budgets_customer_scope.sql"), "utf8");
const postgres = await readFile(resolve(root, "postgres/migrations/0054_finops_budgets_customer_scope.sql"), "utf8");
const d1Runner = await readFile(resolve(root, "db/runtime-migrations.ts"), "utf8");
const pgVerify = await readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8");
const pgApply = await readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8");

test("both dialects swap the org-wide budget name index for a customer-scoped one", () => {
  assert.match(sqlite, /DROP INDEX IF EXISTS finops_budgets_name;/u);
  assert.match(
    sqlite,
    /CREATE UNIQUE INDEX IF NOT EXISTS finops_budgets_scope_name ON finops_budgets \(org_id, customer_id, name\)/u,
  );
  // SQLite migrations are split on the drizzle breakpoint marker, so the drop
  // and the create must be two statements.
  assert.match(sqlite, /--> statement-breakpoint/u);

  assert.match(postgres, /DROP INDEX IF EXISTS finops_budgets_name;/u);
  assert.match(
    postgres,
    /CREATE UNIQUE INDEX IF NOT EXISTS finops_budgets_scope_name ON finops_budgets \(org_id, customer_id, name\)/u,
  );
});

test("registered in all three appliers/verifiers, in order after finops_customer_margin", () => {
  assert.ok(
    d1Runner.includes('"0060_finops_budgets_customer_scope"') &&
      d1Runner.indexOf("0059_finops_customer_margin") < d1Runner.indexOf("0060_finops_budgets_customer_scope"),
  );
  assert.ok(
    pgVerify.includes('"0054_finops_budgets_customer_scope"') &&
      pgVerify.indexOf("0053_finops_customer_margin") < pgVerify.indexOf("0054_finops_budgets_customer_scope"),
  );
  assert.ok(
    pgApply.includes('"0054_finops_budgets_customer_scope.sql"') &&
      pgApply.indexOf("0053_finops_customer_margin.sql") < pgApply.indexOf("0054_finops_budgets_customer_scope.sql"),
  );
});

test("the repository upsert targets the customer-scoped conflict tuple", async () => {
  const repository = await readFile(resolve(root, "db/finops-workspace-repository.ts"), "utf8");
  assert.match(repository, /ON CONFLICT \(org_id, customer_id, name\) DO UPDATE SET/u);
  assert.ok(!/ON CONFLICT \(org_id, name\)/u.test(repository));
});
