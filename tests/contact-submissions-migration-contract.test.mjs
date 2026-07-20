import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const sqlite = await readFile(resolve(root, "drizzle/0036_contact_submissions.sql"), "utf8");
const postgres = await readFile(resolve(root, "postgres/migrations/0030_contact_submissions.sql"), "utf8");
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
