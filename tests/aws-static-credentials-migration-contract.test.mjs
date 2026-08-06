import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("static-credential ownership boundary is registered in every migration registry in lockstep", async () => {
  const [sqlite, postgres, runtime, postgresRuntime, migrateScript, schema] = await Promise.all([
    readFile(resolve(root, "drizzle/0130_static_credential_connections.sql"), "utf8"),
    readFile(resolve(root, "postgres/migrations/0126_static_credential_connections.sql"), "utf8"),
    readFile(resolve(root, "db/runtime-migrations.ts"), "utf8"),
    readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8"),
    readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8"),
    readFile(resolve(root, "db/schema.ts"), "utf8"),
  ]);

  // Both database dialects rebuild both partial unique indexes with the
  // broadened two-kind live predicate.
  for (const source of [sqlite, postgres]) {
    assert.match(source, /DROP INDEX IF EXISTS .?aws_connections_global_live_account_uq/u);
    assert.match(source, /DROP INDEX IF EXISTS .?aws_connections_global_live_role_uq/u);
    assert.match(
      source,
      /aws_connections_global_live_account_uq[\s\S]*?source_kind.? IN \('aws_trust_role', 'aws_static_credentials'\)/u,
    );
    assert.match(
      source,
      /aws_connections_global_live_role_uq[\s\S]*?source_kind.? IN \('aws_trust_role', 'aws_static_credentials'\) AND .?role_arn.? <> ''/u,
    );
  }

  // All three migration registries carry the migration in lockstep.
  assert.match(runtime, /0130_static_credential_connections/u);
  assert.match(postgresRuntime, /0126_static_credential_connections/u);
  assert.match(migrateScript, /0126_static_credential_connections\.sql/u);

  // The declarative schema matches the migrated state: the enum includes the
  // new kind and both index predicates name both live kinds.
  assert.match(schema, /"aws_trust_role", "aws_static_credentials", "simulated_fixture"/u);
  assert.match(
    schema,
    /aws_connections_global_live_account_uq[\s\S]*?IN \('aws_trust_role','aws_static_credentials'\)/u,
  );
  assert.match(
    schema,
    /aws_connections_global_live_role_uq[\s\S]*?IN \('aws_trust_role','aws_static_credentials'\)/u,
  );
});
