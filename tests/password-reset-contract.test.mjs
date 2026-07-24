import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [
  login,
  requestPage,
  completePage,
  requestRoute,
  completeRoute,
  repository,
  sqliteMigration,
  postgresMigration,
  sqliteRunner,
  postgresRunner,
  postgresApply,
] = await Promise.all([
  read("../app/login/page.tsx"),
  read("../app/forgot-password/page.tsx"),
  read("../app/reset-password/page.tsx"),
  read("../app/api/auth/password-reset/request/route.ts"),
  read("../app/api/auth/password-reset/complete/route.ts"),
  read("../db/password-reset-repository.ts"),
  read("../drizzle/0054_password_reset.sql"),
  read("../postgres/migrations/0048_password_reset.sql"),
  read("../db/runtime-migrations.ts"),
  read("../db/postgres-runtime-migrations.ts"),
  read("../scripts/postgres-migrate.mjs"),
]);

test("login exposes a real reset flow protected by fixed Turnstile actions", () => {
  assert.match(login, /href="\/forgot-password"/u);
  assert.match(requestPage, /TURNSTILE_ACTIONS\.passwordResetRequest/u);
  assert.match(completePage, /TURNSTILE_ACTIONS\.passwordResetComplete/u);
  assert.match(requestRoute, /verifyTurnstileToken\(/u);
  assert.match(completeRoute, /verifyTurnstileToken\(/u);
  assert.match(requestRoute, /PUBLIC_RESPONSE/u);
});

test("password reset tokens are digest-only, expiring, single-use, audited and revoke sessions", () => {
  for (const migration of [sqliteMigration, postgresMigration]) {
    assert.match(migration, /token_digest/iu);
    assert.doesNotMatch(migration, /token_plaintext|reset_url/iu);
    assert.match(migration, /consumed_at/iu);
    assert.match(migration, /expires_at/iu);
  }
  assert.match(repository, /digestSessionToken\(token\)/u);
  assert.match(repository, /UPDATE local_sessions SET revoked_at/u);
  assert.match(repository, /auth\.password_reset\.completed/u);
  assert.match(repository, /mfaCredentialPreserved: true/u);
});

test("both runtime migration chains and the PostgreSQL owner migrator include password reset", () => {
  assert.match(sqliteRunner, /"0054_password_reset"/u);
  assert.match(postgresRunner, /"0048_password_reset"/u);
  assert.match(postgresApply, /"0048_password_reset\.sql"/u);
});
