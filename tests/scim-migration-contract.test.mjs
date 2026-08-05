import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const [sqlite, postgres, d1Runner, pgRuntime, pgApply, schema] = await Promise.all([
  readFile(resolve(root, "drizzle/0070_scim_identity_lifecycle.sql"), "utf8"),
  readFile(resolve(root, "postgres/migrations/0064_scim_identity_lifecycle.sql"), "utf8"),
  readFile(resolve(root, "db/runtime-migrations.ts"), "utf8"),
  readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8"),
  readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8"),
  readFile(resolve(root, "db/schema.ts"), "utf8"),
]);

test("D1 and PostgreSQL define the complete tenant-bound SCIM lifecycle", () => {
  for (const table of [
    "scim_connectors",
    "scim_user_links",
    "scim_groups",
    "scim_group_members",
    "scim_audit_events",
  ]) {
    assert.match(sqlite, new RegExp("CREATE TABLE `" + table + "`", "u"));
    assert.match(postgres, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "u"));
    assert.ok(schema.includes(`"${table}"`), `schema is missing ${table}`);
  }
  assert.match(sqlite, /scim_connectors_token_sha256_uq/u);
  assert.match(sqlite, /scim_user_links_connector_external_uq/u);
  assert.match(sqlite, /scim_groups_connector_external_uq/u);
  assert.match(postgres, /scim_connectors_token_sha256_uq/u);
  assert.match(postgres, /scim_user_links_connector_external_uq/u);
});

test("SCIM audit records are database-immutable in both dialects", () => {
  assert.match(sqlite, /scim_audit_events_no_update/u);
  assert.match(sqlite, /scim_audit_events_no_delete/u);
  assert.match(postgres, /BEFORE UPDATE OR DELETE ON scim_audit_events/u);
});

test("runtime verification and the owner migrator register exact SCIM migrations", () => {
  assert.ok(d1Runner.includes('"0070_scim_identity_lifecycle"'));
  assert.ok(pgRuntime.includes('"0064_scim_identity_lifecycle"'));
  assert.ok(pgApply.includes('"0064_scim_identity_lifecycle.sql"'));
});
