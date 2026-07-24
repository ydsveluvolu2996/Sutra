import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const sqlite = await readFile(resolve(root, "drizzle/0036_contact_submissions.sql"), "utf8");
const postgres = await readFile(resolve(root, "postgres/migrations/0030_contact_submissions.sql"), "utf8");
const sqliteRateLimits = await readFile(resolve(root, "drizzle/0053_contact_rate_limits.sql"), "utf8");
const postgresRateLimits = await readFile(resolve(root, "postgres/migrations/0047_contact_rate_limits.sql"), "utf8");
const d1Runner = await readFile(resolve(root, "db/runtime-migrations.ts"), "utf8");
const pgVerify = await readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8");
const pgApply = await readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8");

const COLUMNS = ["id", "name", "email", "company", "message", "source_ip", "recipient", "delivered", "created_at"];

test("both dialects define contact_submissions with the same columns", () => {
  assert.match(sqlite, /CREATE TABLE `contact_submissions`/u);
  assert.match(postgres, /CREATE TABLE IF NOT EXISTS contact_submissions/u);
  for (const column of COLUMNS) {
    assert.ok(sqlite.includes(`\`${column}\``), `sqlite migration is missing ${column}`);
    assert.ok(new RegExp(`\\b${column}\\b`, "u").test(postgres), `postgres migration is missing ${column}`);
  }
});

test("public leads carry NO tenant coupling (no org_id, no FKs)", () => {
  // These are public submissions with no organization; they must never reuse
  // the tenant-gated customer tables.
  assert.doesNotMatch(sqlite, /org_id/u);
  assert.doesNotMatch(sqlite, /FOREIGN KEY/u);
  assert.doesNotMatch(postgres, /org_id/u);
  assert.doesNotMatch(postgres, /REFERENCES/u);
});

test("registered in all three appliers/verifiers, in order", () => {
  assert.ok(
    d1Runner.includes('"0036_contact_submissions"') &&
      d1Runner.indexOf("0035_customer_scoped_invitations") < d1Runner.indexOf("0036_contact_submissions"),
  );
  assert.ok(
    pgVerify.includes('"0030_contact_submissions"') &&
      pgVerify.indexOf("0029_customer_scoped_invitations") < pgVerify.indexOf("0030_contact_submissions"),
  );
  assert.ok(
    pgApply.includes('"0030_contact_submissions.sql"') &&
      pgApply.indexOf("0029_customer_scoped_invitations.sql") < pgApply.indexOf("0030_contact_submissions.sql"),
  );
});

test("dedicated contact counters are durable, bounded and registered after invitation delivery", () => {
  for (const source of [sqliteRateLimits, postgresRateLimits]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS contact_rate_limits/u);
    assert.match(source, /bucket_key\s+TEXT PRIMARY KEY/iu);
    assert.match(source, /attempts\s+(?:INTEGER|BIGINT)\s+NOT NULL\s+CHECK \(attempts >= 1\)/iu);
    assert.match(source, /contact_rate_limits_expiry_idx/u);
    assert.doesNotMatch(source, /\b(?:source_ip|org_id|customer_id)\b/iu);
  }
  assert.ok(
    d1Runner.includes('"0053_contact_rate_limits"') &&
      d1Runner.indexOf("0052_background_jobs_connection_scope") < d1Runner.indexOf("0053_contact_rate_limits"),
  );
  assert.ok(
    pgVerify.includes('"0047_contact_rate_limits"') &&
      pgVerify.indexOf("0046_background_jobs_connection_scope") < pgVerify.indexOf("0047_contact_rate_limits"),
  );
  assert.ok(
    pgApply.includes('"0047_contact_rate_limits.sql"') &&
      pgApply.indexOf("0046_background_jobs_connection_scope.sql") < pgApply.indexOf("0047_contact_rate_limits.sql"),
  );
});
