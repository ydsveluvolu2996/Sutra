import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const sqlite = await readFile(resolve(root, "drizzle/0041_alert_rules.sql"), "utf8");
const postgres = await readFile(resolve(root, "postgres/migrations/0035_alert_rules.sql"), "utf8");
const d1Runner = await readFile(resolve(root, "db/runtime-migrations.ts"), "utf8");
const pgVerify = await readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8");
const pgApply = await readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8");

const RULE_COLUMNS = [
  "id", "org_id", "customer_id", "name", "metric", "comparator", "threshold",
  "severity", "enabled", "destination_ref", "created_by", "created_at", "updated_at",
];
const EVENT_COLUMNS = [
  "id", "org_id", "customer_id", "rule_id", "fired_at", "observed_value",
  "message", "delivery_state", "destination_count", "created_at",
];

test("both dialects define alert_rules and alert_events with the same columns", () => {
  for (const sql of [sqlite, postgres]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS alert_rules/u);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS alert_events/u);
    for (const column of RULE_COLUMNS) {
      assert.ok(new RegExp(`\\b${column}\\b`, "u").test(sql), `alert_rules missing ${column}`);
    }
    for (const column of EVENT_COLUMNS) {
      assert.ok(new RegExp(`\\b${column}\\b`, "u").test(sql), `alert_events missing ${column}`);
    }
  }
});

test("metric/comparator/severity are constrained and no secret column is stored", () => {
  for (const sql of [sqlite, postgres]) {
    assert.match(sql, /metric[\s\S]*CHECK \(metric IN \([\s\S]*'posture-score'[\s\S]*\)\)/u);
    assert.match(sql, /comparator[\s\S]*CHECK \(comparator IN \('gt', 'gte', 'lt', 'lte', 'eq'\)\)/u);
    assert.match(sql, /severity[\s\S]*CHECK \(severity IN \('low', 'medium', 'high'\)\)/u);
    assert.match(sql, /delivery_state[\s\S]*CHECK \(delivery_state IN \('queued', 'no_destination'\)\)/u);
    // The threshold is numeric; the rule stores only a comparison, never a secret.
    assert.match(sql, /threshold REAL NOT NULL/u);
    assert.doesNotMatch(sql, /secret|token|password|api_key|webhook_url/iu);
  }
});

test("the rules table is upsert-by-name unique and has a due-scan index", () => {
  for (const sql of [sqlite, postgres]) {
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS alert_rules_name ON alert_rules \(org_id, name\)/u);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS alert_rules_enabled ON alert_rules \(enabled, org_id, customer_id\)/u);
  }
});

test("registered in all three appliers/verifiers, ordered after the preceding migration", () => {
  assert.ok(d1Runner.includes('"0041_alert_rules"'), "not in the D1 applier list");
  assert.ok(
    d1Runner.indexOf("0039_kubernetes_node_side_array") < d1Runner.indexOf("0041_alert_rules"),
    "D1 order wrong",
  );
  assert.ok(pgVerify.includes('"0035_alert_rules"'), "not in the Postgres verifier list");
  assert.ok(
    pgVerify.indexOf("0033_kubernetes_node_side_array") < pgVerify.indexOf("0035_alert_rules"),
    "Postgres verifier order wrong",
  );
  assert.ok(pgApply.includes('"0035_alert_rules.sql"'), "not in the Postgres applier list");
  assert.ok(
    pgApply.indexOf("0033_kubernetes_node_side_array.sql") < pgApply.indexOf("0035_alert_rules.sql"),
    "Postgres applier order wrong",
  );
});
