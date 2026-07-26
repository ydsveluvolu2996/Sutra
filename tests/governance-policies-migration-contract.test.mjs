import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const sqlite = await readFile(resolve(root, "drizzle/0064_governance_policies.sql"), "utf8");
const postgres = await readFile(resolve(root, "postgres/migrations/0058_governance_policies.sql"), "utf8");

// NOTE: applier registration (db/runtime-migrations.ts,
// db/postgres-runtime-migrations.ts, scripts/postgres-migrate.mjs) is done
// centrally to avoid collisions between parallel workstreams, so this contract
// deliberately asserts the two SQL files ONLY.

test("both dialects create governance_policies with the condition/action shape and its indexes", () => {
  for (const sql of [sqlite, postgres]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS governance_policies/u);
    assert.match(sql, /condition_json text NOT NULL/u);
    assert.match(sql, /action_kind text NOT NULL/u);
    assert.match(sql, /action_target text/u);
    assert.match(sql, /action_expires_in_days integer/u);
    assert.match(sql, /requires_approval integer NOT NULL DEFAULT 1/u);
    assert.match(sql, /enabled integer NOT NULL DEFAULT 1/u);
    assert.match(sql, /priority integer NOT NULL DEFAULT 100/u);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS governance_policies_org/u);
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS governance_policies_scope_name/u);
  }
});

test("both dialects create the append-only governance_approvals ledger", () => {
  for (const sql of [sqlite, postgres]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS governance_approvals/u);
    assert.match(sql, /request_id text NOT NULL/u);
    assert.match(sql, /policy_id text NOT NULL/u);
    assert.match(sql, /request_key text NOT NULL/u);
    assert.match(sql, /decision text NOT NULL/u);
    // The audit fields that make a decision attributable are mandatory.
    assert.match(sql, /reason text NOT NULL/u);
    assert.match(sql, /actor_user_id text NOT NULL/u);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS governance_approvals_request/u);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS governance_approvals_pending/u);
  }
});

test("the ledger carries no unique key that would block re-requesting a decided action", () => {
  for (const sql of [sqlite, postgres]) {
    assert.doesNotMatch(sql, /CREATE UNIQUE INDEX[^\n]*governance_approvals/u);
  }
});

test("the migrations are additive: no DROP or destructive ALTER", () => {
  for (const sql of [sqlite, postgres]) {
    assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/iu);
    assert.doesNotMatch(sql, /\bDROP\s+COLUMN\b/iu);
    assert.doesNotMatch(sql, /\bALTER\s+TABLE\b/iu);
    assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/iu);
  }
});

test("the two dialects agree on every column name of both tables", () => {
  const columns = (sql, table) => {
    const body = sql.slice(sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`));
    const inner = body.slice(body.indexOf("(") + 1, body.indexOf("\n);"));
    return inner
      .split("\n")
      .map((row) => row.trim().split(/\s+/u)[0].replace(/,$/u, ""))
      .filter((name) => name.length > 0 && !name.startsWith("--"));
  };
  for (const table of ["governance_policies", "governance_approvals"]) {
    assert.deepEqual(columns(sqlite, table), columns(postgres, table));
  }
});

test("the postgres dialect uses bigint epoch timestamps, the D1 dialect integer", () => {
  assert.match(postgres, /created_at bigint NOT NULL/u);
  assert.match(sqlite, /created_at integer NOT NULL/u);
});
