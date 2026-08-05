import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const [callback, start, login, sqlite, postgres, sqliteRuntime, postgresRuntime, migrator] = await Promise.all([
  readFile(resolve(root, "app/api/auth/saml/callback/route.ts"), "utf8"),
  readFile(resolve(root, "app/api/auth/saml/start/route.ts"), "utf8"),
  readFile(resolve(root, "app/login/page.tsx"), "utf8"),
  readFile(resolve(root, "drizzle/0068_saml_assertion_replays.sql"), "utf8"),
  readFile(resolve(root, "postgres/migrations/0062_saml_assertion_replays.sql"), "utf8"),
  readFile(resolve(root, "db/runtime-migrations.ts"), "utf8"),
  readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8"),
  readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8"),
]);

test("SAML callback verifies before replay reservation and tenant provisioning", () => {
  const verify = callback.indexOf("await verifySamlAssertion(");
  const replay = callback.indexOf("await consumeSamlAssertion(");
  const login = callback.indexOf("await loginHostedUser(");
  const invitation = callback.indexOf("await acceptIdentityInvitation(");
  assert.ok(verify >= 0 && verify < replay);
  assert.ok(replay < login && replay < invitation);
  assert.match(callback, /request\.method !== "POST"/u);
  assert.match(callback, /application\/x-www-form-urlencoded/u);
  assert.doesNotMatch(callback, /provisionSelfServeHostedOrg/u);
});

test("SAML starts only through a sealed request-bound transaction and is surfaced honestly", () => {
  assert.match(start, /sealSamlTransaction/u);
  assert.match(start, /createSamlAuthorizationUrl/u);
  assert.match(login, /\/api\/auth\/federation/u);
  assert.match(login, /signed, tenant-bound assertion/u);
  assert.match(login, /administrator-provisioned membership required/u);
});

test("SAML assertion replay storage is durable and registered in both databases", () => {
  for (const migration of [sqlite, postgres]) {
    assert.match(migration, /saml_assertion_replays/u);
    assert.match(migration, /PRIMARY KEY \(identity_issuer, assertion_id\)/u);
    assert.match(migration, /expires_at/u);
  }
  assert.match(sqliteRuntime, /0068_saml_assertion_replays/u);
  assert.match(postgresRuntime, /0062_saml_assertion_replays/u);
  assert.match(migrator, /0062_saml_assertion_replays\.sql/u);
});
