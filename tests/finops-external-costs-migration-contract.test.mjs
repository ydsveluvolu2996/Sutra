// Contract for the external-cost migration SQL in BOTH dialects. This test
// deliberately asserts ONLY the two SQL files' content: registration in the
// three appliers is owned centrally, so asserting it here would fight the
// operator who wires the migration ids in.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const sqlite = await readFile(resolve(root, "drizzle/0063_finops_external_costs.sql"), "utf8");
const postgres = await readFile(resolve(root, "postgres/migrations/0057_finops_external_costs.sql"), "utf8");

const COLUMNS = [
  "id", "org_id", "customer_id", "connection_id", "source", "period",
  "amount_micros", "currency", "attributed_customer", "category", "vendor",
  "tags_json", "created_at",
];

test("both dialects create finops_external_costs with the same columns", () => {
  for (const sql of [sqlite, postgres]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS finops_external_costs/u);
    for (const column of COLUMNS) {
      assert.ok(new RegExp(`\\b${column}\\b`, "u").test(sql), `finops_external_costs missing ${column}`);
    }
  }
});

test("the tenant, connection, source and period columns are NOT NULL", () => {
  for (const sql of [sqlite, postgres]) {
    for (const column of ["org_id", "customer_id", "connection_id", "source", "period", "currency", "amount_micros", "created_at"]) {
      assert.match(sql, new RegExp(`${column} \\w+ NOT NULL`, "u"), `${column} must be NOT NULL`);
    }
  }
});

test("both migrations are additive only — no DROP, ALTER or DELETE of existing data", () => {
  for (const sql of [sqlite, postgres]) {
    assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/iu);
    assert.doesNotMatch(sql, /\bALTER\s+TABLE\b/iu);
    assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/iu);
    // Every object is created defensively so a re-run is a no-op.
    for (const statement of sql.split(";").filter((part) => /CREATE/iu.test(part))) {
      assert.match(statement, /IF NOT EXISTS/u, `missing IF NOT EXISTS: ${statement.trim().slice(0, 60)}`);
    }
  }
});

test("money and timestamps use pg bigint / sqlite integer", () => {
  assert.match(postgres, /amount_micros bigint NOT NULL/u);
  assert.match(postgres, /created_at bigint NOT NULL/u);
  assert.match(sqlite, /amount_micros integer NOT NULL/u);
  assert.match(sqlite, /created_at integer NOT NULL/u);
  // The SQLite dialect must not use the postgres-only bigint spelling.
  assert.doesNotMatch(sqlite, /\bbigint\b/iu);
});

test("the replace-by-(source, period) read/delete path is indexed in both dialects", () => {
  for (const sql of [sqlite, postgres]) {
    assert.match(
      sql,
      /CREATE INDEX IF NOT EXISTS finops_external_costs_scope ON finops_external_costs \(org_id, customer_id, connection_id, period\)/u,
    );
    assert.match(
      sql,
      /CREATE INDEX IF NOT EXISTS finops_external_costs_source ON finops_external_costs \(org_id, customer_id, connection_id, source, period\)/u,
    );
  }
});

test("the drizzle file separates statements with the drizzle breakpoint marker", () => {
  const statements = sqlite.split("--> statement-breakpoint");
  assert.equal(statements.length, 3, "expected the table plus two indexes to be breakpoint-separated");
  assert.doesNotMatch(postgres, /statement-breakpoint/u);
});

test("no credential-shaped column is stored on external cost records", () => {
  for (const sql of [sqlite, postgres]) {
    assert.doesNotMatch(sql, /secret|token|password|api_key|access_key/iu);
  }
});
