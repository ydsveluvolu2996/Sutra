import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

const [sqlite, postgres, runtime, postgresRuntime, migrateScript, schema] = await Promise.all([
  readFile(resolve(root, "drizzle/0131_aws_org_scope_and_connection_addons.sql"), "utf8"),
  readFile(resolve(root, "postgres/migrations/0128_aws_org_scope_and_connection_addons.sql"), "utf8"),
  readFile(resolve(root, "db/runtime-migrations.ts"), "utf8"),
  readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8"),
  readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8"),
  readFile(resolve(root, "db/schema.ts"), "utf8"),
]);

const ADDON_COLUMNS = [
  "id", "org_id", "customer_id", "connection_id", "addon_contract_id",
  "status", "stack_arn", "verified_at", "created_at", "updated_at",
];

test("both dialects add the same organization-scope columns to aws_connections", () => {
  for (const source of [sqlite, postgres]) {
    assert.match(source, /ADD COLUMN (IF NOT EXISTS )?.?org_scope.? text NOT NULL DEFAULT 'account'/u);
    assert.match(source, /org_scope.? IN \('account', 'organization_management', 'organization_member'\)/u);
    assert.match(source, /ADD COLUMN (IF NOT EXISTS )?.?management_connection_id.? text/u);
    assert.match(source, /ADD COLUMN (IF NOT EXISTS )?.?organization_ou_id.? text/u);
    // Member linkage is queryable without scanning single-account rows.
    assert.match(source, /aws_connections_management_idx[\s\S]*?management_connection_id.? IS NOT NULL/u);
  }
});

test("both dialects define aws_connection_addons with the same columns and states", () => {
  for (const source of [sqlite, postgres]) {
    assert.match(source, /CREATE TABLE (IF NOT EXISTS )?.?aws_connection_addons/u);
    for (const column of ADDON_COLUMNS) {
      assert.ok(new RegExp(`\\b${column}\\b`, "u").test(source), `aws_connection_addons missing ${column}`);
    }
    // Only these attachment states exist; 'declared' is an intention, never
    // evidence, and only 'verified' may widen downstream behaviour.
    assert.match(source, /status.? IN \('declared', 'verified', 'detached'\)/u);
    // Verified-implies-timestamp in both directions: a verified row without
    // evidence time and an unverified row carrying one are both malformed.
    assert.match(source, /\(.?status.? = 'verified'\) = \(.?verified_at.? IS NOT NULL\)/u);
    // One attachment per connection per contract.
    assert.match(source, /aws_connection_addons_connection_contract_uq[\s\S]*?connection_id.?, .?addon_contract_id.?\)/u);
  }
});

test("the add-on contract enum is exact and excludes packs with no deployable template", () => {
  for (const source of [sqlite, postgres]) {
    assert.match(source, /'foundational-cur2-export-v1'/u);
    assert.match(source, /'foundational-focus12-export-v1'/u);
    // Lightsail is deliberately absent: the .12 deny ceiling reserves no
    // lightsail: action, so an add-on Allow on that role would be
    // Deny-overridden. It re-enters by migration once a successor ceiling
    // exists -- listing it now would let a row claim a capability that no
    // deployed stack can grant.
    assert.doesNotMatch(source, /lightsail/u);
  }
});

test("the migration is registered and correctly ordered in all three appliers/verifiers", () => {
  assert.match(runtime, /0131_aws_org_scope_and_connection_addons/u);
  assert.match(postgresRuntime, /0128_aws_org_scope_and_connection_addons/u);
  assert.match(migrateScript, /0128_aws_org_scope_and_connection_addons\.sql/u);
  // Ordered after the previous head of each registry.
  assert.ok(
    runtime.indexOf('id: "0131_aws_org_scope_and_connection_addons"')
      > runtime.indexOf('id: "0130_static_credential_connections"'),
    "SQLite registry order",
  );
  assert.ok(
    postgresRuntime.indexOf('id: "0128_aws_org_scope_and_connection_addons"')
      > postgresRuntime.indexOf('id: "0127_hosted_credential_envelope"'),
    "PostgreSQL registry order",
  );
  assert.ok(
    migrateScript.indexOf('"0128_aws_org_scope_and_connection_addons.sql"')
      > migrateScript.indexOf('"0127_hosted_credential_envelope.sql"'),
    "PostgreSQL apply-script order",
  );
});

test("the declarative schema matches the migrated state", () => {
  assert.match(schema, /orgScope: text\("org_scope", \{ enum: \["account", "organization_management", "organization_member"\] \}\)/u);
  assert.match(schema, /managementConnectionId: text\("management_connection_id"\)/u);
  assert.match(schema, /organizationOuId: text\("organization_ou_id"\)/u);
  assert.match(schema, /awsConnectionAddons = sqliteTable\("aws_connection_addons"/u);
  assert.match(schema, /"foundational-cur2-export-v1",\s*\n\s*"foundational-focus12-export-v1",\s*\n\s*\] \}\)\.notNull\(\)/u);
  assert.match(schema, /aws_connection_addons_connection_contract_uq/u);
});

// --- live apply proof (SQLite/D1 via Miniflare) ---
// The PostgreSQL twin is proven by `pnpm db:postgres:test` in CI's
// Collector/CloudFormation/PostgreSQL job, which applies every registered
// migration to a real engine.

const { register } = await import("node:module");
register(new URL("./cloudflare-loader.mjs", import.meta.url));
const { Miniflare } = await import("miniflare");
const runtimeMigrations = await import("../db/runtime-migrations.ts");

test("0131 applies; scope columns and the add-on table enforce their constraints", async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-org-scope-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);

    await database.batch([
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status) VALUES ('org_orgscope', 'orgscope', 'Org Scope', 'active')",
      ),
      database.prepare(
        "INSERT INTO customers (id, org_id, slug, name, status) VALUES ('cust_orgscope', 'org_orgscope', 'acme', 'Acme', 'active')",
      ),
      database.prepare(
        `INSERT INTO aws_connections
           (id, org_id, customer_id, aws_account_id, role_arn,
            external_id_ciphertext, external_id_key_version, permission_pack_version)
         VALUES ('conn_${"a".repeat(32)}', 'org_orgscope', 'cust_orgscope', '111122223333',
            'arn:aws:iam::111122223333:role/sutra/SutraCollectorRole', 'ct', 'v1', 'standard-2026-08.12')`,
      ),
    ]);

    // Existing rows read as single-account scope by default.
    const scope = await database.prepare(
      "SELECT org_scope, management_connection_id FROM aws_connections WHERE id = ?",
    ).bind(`conn_${"a".repeat(32)}`).first();
    assert.equal(scope.org_scope, "account");
    assert.equal(scope.management_connection_id, null);

    // A malformed scope value is refused by the column constraint.
    await assert.rejects(
      database.prepare(
        "UPDATE aws_connections SET org_scope = 'organisation' WHERE id = ?",
      ).bind(`conn_${"a".repeat(32)}`).run(),
    );

    // An attachment starts declared; verified requires its evidence timestamp.
    const addonId = `cad_${"b".repeat(32)}`;
    await database.prepare(
      `INSERT INTO aws_connection_addons
        (id, org_id, customer_id, connection_id, addon_contract_id, created_at, updated_at)
       VALUES (?, 'org_orgscope', 'cust_orgscope', ?, 'foundational-cur2-export-v1', 1, 1)`,
    ).bind(addonId, `conn_${"a".repeat(32)}`).run();
    await assert.rejects(
      database.prepare(
        "UPDATE aws_connection_addons SET status = 'verified' WHERE id = ?",
      ).bind(addonId).run(),
      undefined,
      "verified without verified_at must be refused",
    );
    await database.prepare(
      "UPDATE aws_connection_addons SET status = 'verified', verified_at = 2 WHERE id = ?",
    ).bind(addonId).run();

    // One attachment per connection per contract.
    await assert.rejects(
      database.prepare(
        `INSERT INTO aws_connection_addons
          (id, org_id, customer_id, connection_id, addon_contract_id, created_at, updated_at)
         VALUES ('cad_${"c".repeat(32)}', 'org_orgscope', 'cust_orgscope', 'conn_${"a".repeat(32)}',
          'foundational-cur2-export-v1', 3, 3)`,
      ).run(),
    );

    // A contract outside the enum is refused rather than stored.
    await assert.rejects(
      database.prepare(
        `INSERT INTO aws_connection_addons
          (id, org_id, customer_id, connection_id, addon_contract_id, created_at, updated_at)
         VALUES ('cad_${"d".repeat(32)}', 'org_orgscope', 'cust_orgscope', 'conn_${"a".repeat(32)}',
          'lightsail-workload-read-v1', 4, 4)`,
      ).run(),
    );
  } finally {
    await miniflare.dispose();
  }
});
