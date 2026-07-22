import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("customer-managed AWS role contract is registered in both database runtimes", async () => {
  const [sqlite, postgres, runtime, postgresRuntime, migrateScript, schema] = await Promise.all([
    readFile(resolve(root, "drizzle/0049_customer_managed_aws_roles.sql"), "utf8"),
    readFile(resolve(root, "postgres/migrations/0043_customer_managed_aws_roles.sql"), "utf8"),
    readFile(resolve(root, "db/runtime-migrations.ts"), "utf8"),
    readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8"),
    readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8"),
    readFile(resolve(root, "db/schema.ts"), "utf8"),
  ]);

  for (const column of [
    "role_provisioning_mode",
    "expected_role_path",
    "expected_role_name",
    "permission_capabilities_json",
  ]) {
    assert.match(sqlite, new RegExp(column, "u"));
    assert.match(postgres, new RegExp(column, "u"));
  }
  assert.match(postgres, /CHECK \(role_provisioning_mode IN \('sutra_template', 'customer_managed'\)\)/u);
  assert.match(runtime, /0049_customer_managed_aws_roles/u);
  assert.match(postgresRuntime, /0043_customer_managed_aws_roles/u);
  assert.match(migrateScript, /0043_customer_managed_aws_roles\.sql/u);
  assert.match(schema, /permissionCapabilitiesJson: text\("permission_capabilities_json"\)/u);
});
