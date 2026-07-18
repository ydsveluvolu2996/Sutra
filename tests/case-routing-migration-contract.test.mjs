import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const sqlite = await readFile(resolve(root, "drizzle/0024_case_routing_rules.sql"), "utf8");
const postgres = await readFile(resolve(root, "postgres/migrations/0018_case_routing_rules.sql"), "utf8");
const d1Runner = await readFile(resolve(root, "db/runtime-migrations.ts"), "utf8");
const pgVerify = await readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8");
const pgApply = await readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8");

const COLUMNS = [
  "id", "org_id", "customer_id", "priority", "match_severity", "match_customer_id",
  "route_assignee", "route_team", "route_destination", "created_at",
];

test("both dialects define case_routing_rules with the same columns", () => {
  assert.match(sqlite, /CREATE TABLE `case_routing_rules`/u);
  assert.match(postgres, /CREATE TABLE IF NOT EXISTS case_routing_rules/u);
  for (const column of COLUMNS) {
    assert.ok(sqlite.includes(`\`${column}\``), `sqlite migration is missing ${column}`);
    assert.ok(new RegExp(`\\b${column}\\b`, "u").test(postgres), `postgres migration is missing ${column}`);
  }
});

test("tenant-scoped with FKs and registered in all three appliers/verifiers", () => {
  assert.match(sqlite, /REFERENCES `organizations`/u);
  assert.match(postgres, /REFERENCES customers\(id\)/u);
  assert.ok(d1Runner.includes('"0024_case_routing_rules"') && d1Runner.indexOf("0023_cloud_vulnerability_findings") < d1Runner.indexOf("0024_case_routing_rules"));
  assert.ok(pgVerify.includes('"0018_case_routing_rules"') && pgVerify.indexOf("0017_cloud_vulnerability_findings") < pgVerify.indexOf("0018_case_routing_rules"));
  assert.ok(pgApply.includes('"0018_case_routing_rules.sql"') && pgApply.indexOf("0017_cloud_vulnerability_findings.sql") < pgApply.indexOf("0018_case_routing_rules.sql"));
});
