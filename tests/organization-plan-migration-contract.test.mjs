import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

const [sqlite, postgres, runtime, postgresRuntime, migrateScript, schema, authRepo] = await Promise.all([
  readFile(resolve(root, "drizzle/0132_organization_plan.sql"), "utf8"),
  readFile(resolve(root, "postgres/migrations/0129_organization_plan.sql"), "utf8"),
  readFile(resolve(root, "db/runtime-migrations.ts"), "utf8"),
  readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8"),
  readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8"),
  readFile(resolve(root, "db/schema.ts"), "utf8"),
  readFile(resolve(root, "db/auth-repository.ts"), "utf8"),
]);

test("both dialects add the same plan column with the same states and default", () => {
  for (const source of [sqlite, postgres]) {
    assert.match(source, /ADD COLUMN (IF NOT EXISTS )?.?plan.? text NOT NULL DEFAULT 'standard'/u);
    assert.match(source, /plan.? IN \('trial', 'standard'\)/u);
  }
});

test("the migration is registered and ordered in all three appliers/verifiers", () => {
  assert.match(runtime, /0132_organization_plan/u);
  assert.match(postgresRuntime, /0129_organization_plan/u);
  assert.match(migrateScript, /0129_organization_plan\.sql/u);
  assert.ok(
    runtime.indexOf('id: "0132_organization_plan"')
      > runtime.indexOf('id: "0131_aws_org_scope_and_connection_addons"'),
    "SQLite registry order",
  );
  assert.ok(
    postgresRuntime.indexOf('id: "0129_organization_plan"')
      > postgresRuntime.indexOf('id: "0128_aws_org_scope_and_connection_addons"'),
    "PostgreSQL registry order",
  );
});

test("the declarative schema and both provisioning paths agree with the migration", () => {
  assert.match(schema, /plan: text\("plan", \{ enum: \["trial", "standard"\] \}\)\.notNull\(\)\.default\("standard"\)/u);
  // Self-serve orgs are born trial...
  assert.match(authRepo, /INSERT INTO organizations \(id, slug, name, status, plan, created_at\)\s*\n\s*VALUES \(\?, \?, \?, 'active', 'trial', \?\)/u);
  // ...and the session carries the plan so the UI needs no second lookup. The
  // plan is presentation/gating state only: nothing in the authorization
  // subject derives from it.
  assert.match(authRepo, /o\.plan AS org_plan/u);
  assert.match(authRepo, /plan: row\.org_plan/u);
  assert.doesNotMatch(authRepo, /grants[^\n]*plan|plan[^\n]*capabilit/iu);
});
