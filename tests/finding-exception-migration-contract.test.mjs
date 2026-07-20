import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const sqlite = await readFile(resolve(root, "drizzle/0032_finding_exceptions.sql"), "utf8");
const postgres = await readFile(resolve(root, "postgres/migrations/0026_finding_exceptions.sql"), "utf8");
const d1Runner = await readFile(resolve(root, "db/runtime-migrations.ts"), "utf8");
const pgVerify = await readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8");
const pgApply = await readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8");

const COLUMNS = [
  "id", "org_id", "customer_id", "scope_rule_id", "scope_resource_ref",
  "justification", "approved_by", "status", "created_at", "expires_at",
];

test("both dialects define finding_exceptions with the same columns", () => {
  assert.match(sqlite, /CREATE TABLE `finding_exceptions`/u);
  assert.match(postgres, /CREATE TABLE IF NOT EXISTS finding_exceptions/u);
  for (const column of COLUMNS) {
    assert.ok(sqlite.includes(`\`${column}\``), `sqlite migration is missing ${column}`);
    assert.ok(new RegExp(`\\b${column}\\b`, "u").test(postgres), `postgres migration is missing ${column}`);
  }
});

test("tenant-scoped with FKs and registered in all three appliers/verifiers", () => {
  assert.match(sqlite, /REFERENCES `organizations`/u);
  assert.match(sqlite, /REFERENCES `customers`/u);
  assert.match(postgres, /REFERENCES organizations\(id\)/u);
  assert.match(postgres, /REFERENCES customers\(id\)/u);
  assert.ok(d1Runner.includes('"0032_finding_exceptions"') && d1Runner.indexOf("0031_background_jobs") < d1Runner.indexOf("0032_finding_exceptions"));
  assert.ok(pgVerify.includes('"0026_finding_exceptions"') && pgVerify.indexOf("0025_background_jobs") < pgVerify.indexOf("0026_finding_exceptions"));
  assert.ok(pgApply.includes('"0026_finding_exceptions.sql"') && pgApply.indexOf("0025_background_jobs.sql") < pgApply.indexOf("0026_finding_exceptions.sql"));
});
