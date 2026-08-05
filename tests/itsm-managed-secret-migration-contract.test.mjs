import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const d1 = await readFile(resolve(root, "drizzle/0071_itsm_managed_secrets.sql"), "utf8");
const postgres = await readFile(
  resolve(root, "postgres/migrations/0066_itsm_managed_secrets.sql"),
  "utf8",
);
const d1Registry = await readFile(resolve(root, "db/runtime-migrations.ts"), "utf8");
const postgresRegistry = await readFile(
  resolve(root, "db/postgres-runtime-migrations.ts"),
  "utf8",
);
const postgresMigrator = await readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8");

test("D1 and PostgreSQL add reference-only ITSM storage metadata", () => {
  for (const migration of [d1, postgres]) {
    assert.match(migration, /secret_storage/u);
    assert.match(migration, /secret_reference/u);
    assert.match(migration, /secret_preview/u);
    assert.match(migration, /local[\s\S]*managed/u);
    assert.doesNotMatch(migration, /INSERT[\s\S]*shared_secret/iu);
  }
});

test("managed ITSM migrations are registered after SAML, DSPM, and SCIM", () => {
  assert.match(d1Registry, /0071_itsm_managed_secrets/u);
  assert.match(postgresRegistry, /0066_itsm_managed_secrets/u);
  assert.ok(
    postgresMigrator.indexOf('"0066_itsm_managed_secrets.sql"') >
      postgresMigrator.indexOf('"0065_hosted_broker_runtime.sql"'),
  );
});
