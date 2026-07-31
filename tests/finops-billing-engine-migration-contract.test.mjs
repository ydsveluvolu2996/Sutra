import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const sqlite = await readFile(path.join(root, "drizzle/0078_finops_billing_engine_v2.sql"), "utf8");
const postgres = await readFile(path.join(root, "postgres/migrations/0073_finops_billing_engine_v2.sql"), "utf8");
const sqliteRuntime = await readFile(path.join(root, "db/runtime-migrations.ts"), "utf8");
const postgresRuntime = await readFile(path.join(root, "db/postgres-runtime-migrations.ts"), "utf8");
const postgresMigrator = await readFile(path.join(root, "scripts/postgres-migrate.mjs"), "utf8");
const schema = await readFile(path.join(root, "db/schema.ts"), "utf8");

const requiredPartitionColumns = [
  "org_id",
  "customer_id",
  "connection_id",
  "export_name",
  "billing_period",
  "manifest_sha256",
  "schema_sha256",
  "active_generation_id",
  "active_manifest_sha256",
  "active_manifest_version_id",
  "active_source_table",
  "active_source_format",
  "active_source_version",
  "active_source_updated_at",
  "active_observed_at",
  "active_accepted_rows",
  "active_rejected_rows",
  "active_currency_totals_json",
  "active_committed_at",
  "staging_generation_id",
  "staging_manifest_sha256",
  "accepted_rows",
  "rejected_rows",
  "currency_totals_json",
];

const requiredBillingColumns = [
  "source_format",
  "source_version",
  "payer_account_id",
  "usage_account_id",
  "product_code",
  "product_family",
  "resource_id",
  "resource_type",
  "operation",
  "charge_kind",
  "amount_micros",
  "net_unblended_cost_micros",
  "amortized_micros",
  "list_cost_micros",
  "contracted_cost_micros",
  "public_on_demand_cost_micros",
  "commitment_id",
  "invoice_id",
  "legal_entity",
  "canonical_json",
];

test("SQLite and PostgreSQL migrations carry the canonical generation contract", () => {
  for (const source of [sqlite, postgres]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS finops_export_partitions/u);
    assert.match(source, /CREATE TABLE IF NOT EXISTS finops_billing_lines_v2/u);
    for (const column of [...requiredPartitionColumns, ...requiredBillingColumns]) {
      assert.match(source, new RegExp(`\\b${column}\\b`, "u"), `${column} missing from a billing-engine migration`);
    }
    assert.match(source, /finops_export_partitions_scope_uq/u);
    assert.match(source, /finops_billing_lines_v2_generation_line_uq/u);
    assert.match(source, /finops_billing_lines_v2_query_idx/u);
    assert.match(source, /finops_billing_lines_v2_resource_idx/u);
  }
});

test("both runtime migration registries include the billing engine", () => {
  assert.match(sqliteRuntime, /0078_finops_billing_engine_v2/u);
  assert.match(postgresRuntime, /0073_finops_billing_engine_v2/u);
  assert.match(postgresMigrator, /"0073_finops_billing_engine_v2\.sql"/u);
  assert.equal(sqlite.match(/--> statement-breakpoint/gu)?.length, 6);
  assert.equal(postgres.match(/--> statement-breakpoint/gu)?.length, 6);
});

test("Drizzle schema exposes tenant and active-generation boundaries", () => {
  assert.match(schema, /export const finopsExportPartitions/u);
  assert.match(schema, /export const finopsBillingLinesV2/u);
  assert.match(schema, /activeGenerationId: text\("active_generation_id"\)/u);
  assert.match(schema, /activeObservedAt: text\("active_observed_at"\)/u);
  assert.match(schema, /activeRejectedRows: integer\("active_rejected_rows"\)/u);
  assert.match(schema, /activeCommittedAt: text\("active_committed_at"\)/u);
  assert.match(schema, /stagingGenerationId: text\("staging_generation_id"\)/u);
  assert.match(schema, /canonicalJson: text\("canonical_json"\)\.notNull\(\)/u);
  assert.match(schema, /table\.orgId, table\.customerId, table\.connectionId/u);
});
