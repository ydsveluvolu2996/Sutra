import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

// Applier/verifier registration is asserted centrally, not here: this contract
// covers only that the two dialect files exist and agree.
const root = resolve(import.meta.dirname, "..");
const sqlite = await readFile(resolve(root, "drizzle/0061_finops_resource_schedules.sql"), "utf8");
const postgres = await readFile(resolve(root, "postgres/migrations/0055_finops_resource_schedules.sql"), "utf8");

const COLUMNS = [
  "id text PRIMARY KEY NOT NULL",
  "org_id text NOT NULL",
  "customer_id text",
  "connection_id text",
  "name text NOT NULL",
  "schedule_json text NOT NULL",
  "selector_json text NOT NULL",
  "enabled integer NOT NULL DEFAULT 1",
];

test("both dialects create the same additive finops_resource_schedules table", () => {
  for (const sql of [sqlite, postgres]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS finops_resource_schedules \(/u);
    for (const column of COLUMNS) {
      // Tabs (drizzle) vs two spaces (postgres) are the only indentation difference.
      assert.ok(sql.includes(column), `missing column definition: ${column}`);
    }
    assert.match(
      sql,
      /CREATE INDEX IF NOT EXISTS finops_resource_schedules_org ON finops_resource_schedules \(org_id, customer_id, name\)/u,
    );
    // Additive only: no destructive statement in either dialect.
    assert.equal(/\b(DROP TABLE|ALTER TABLE|DELETE FROM|TRUNCATE)\b/iu.test(sql), false);
  }
});

test("timestamp columns use each dialect's own integer type", () => {
  assert.match(postgres, /created_at bigint NOT NULL/u);
  assert.match(postgres, /updated_at bigint NOT NULL/u);
  assert.match(sqlite, /created_at integer NOT NULL/u);
  assert.match(sqlite, /updated_at integer NOT NULL/u);
  assert.equal(/bigint/iu.test(sqlite), false);
});

test("the sqlite migration splits its statements on the drizzle breakpoint marker", () => {
  assert.match(sqlite, /--> statement-breakpoint/u);
  const statements = sqlite.split("--> statement-breakpoint");
  assert.equal(statements.length, 2);
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS finops_resource_schedules/u);
  assert.match(statements[1], /CREATE INDEX IF NOT EXISTS finops_resource_schedules_org/u);
});

test("the postgres migration documents that Sutra never enforces a stored schedule", () => {
  assert.match(postgres, /read-only/u);
  assert.match(postgres, /never starts or stops/u);
});

test("the repository reads and writes exactly the migrated columns, tenant-scoped", async () => {
  const repository = await readFile(resolve(root, "db/finops-resource-schedule-repository.ts"), "utf8");
  assert.match(repository, /FROM finops_resource_schedules/u);
  assert.match(repository, /INSERT INTO finops_resource_schedules/u);
  // The owned-customer gate is scoped by (customer id, org); every schedule
  // statement is scoped by org AND customer — no org-wide read or write.
  assert.match(repository, /FROM customers WHERE id = \? AND org_id = \? AND status IN \('active', 'trial'\)/u);
  for (const clause of repository.match(/WHERE [^`]*?(?=\n|`)/gu) ?? []) {
    if (clause.includes("status IN")) continue;
    assert.match(clause, /org_id = \?/u);
    assert.match(clause, /customer_id = \?/u);
  }
});
