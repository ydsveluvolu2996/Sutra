import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sqlite = readFileSync(new URL(
  "../drizzle/0084_finops_trusted_advisor_organization.sql",
  import.meta.url,
), "utf8");
const postgres = readFileSync(new URL(
  "../postgres/migrations/0079_finops_trusted_advisor_organization.sql",
  import.meta.url,
), "utf8");
const runtime = readFileSync(new URL("../db/runtime-migrations.ts", import.meta.url), "utf8");
const postgresRuntime = readFileSync(new URL("../db/postgres-runtime-migrations.ts", import.meta.url), "utf8");
const migrator = readFileSync(new URL("../scripts/postgres-migrate.mjs", import.meta.url), "utf8");
const schema = readFileSync(new URL("../db/schema.ts", import.meta.url), "utf8");
const repository = readFileSync(new URL(
  "../db/finops-trusted-advisor-organization-repository.ts",
  import.meta.url,
), "utf8");

const tables = [
  "finops_ta_collection_manifests",
  "finops_ta_manifest_accounts",
  "finops_ta_account_snapshots",
  "finops_ta_check_snapshots",
  "finops_ta_resource_snapshots",
  "finops_ta_organization_snapshots",
  "finops_ta_organization_snapshot_heads",
];

test("SQLite and PostgreSQL keep organizational TA identity and acceptance fields in parity", () => {
  for (const source of [sqlite, postgres]) {
    for (const table of tables) assert.match(source, new RegExp(`\\b${table}\\b`, "u"));
    for (const field of [
      "manifest_id", "org_id", "customer_id", "anchor_connection_id", "job_id",
      "taxonomy_snapshot_id", "taxonomy_sha256", "account_set_sha256",
      "expected_account_count", "account_id", "account_position", "target_connection_id",
      "account_snapshot_id", "content_sha256", "collected_at", "data_through_at",
      "check_count", "resource_count", "rejected_record_count", "generation_id",
      "accepted_account_count", "rejected_account_count", "active_generation_id", "advanced_at",
    ]) assert.match(source, new RegExp(`\\b${field}\\b`, "u"));
    assert.match(source, /FINOPS_TA_MANIFEST_(?:TRANSITION_REJECTED|INCOMPLETE)/u);
    assert.match(source, /FINOPS_TA_ACCOUNT_(?:TRANSITION_REJECTED|SNAPSHOT_NOT_ACCEPTED)/u);
    assert.match(source, /FINOPS_TA_(?:HEAD_ADVANCE_REJECTED|IMMUTABLE|ACCOUNT_SNAPSHOT_IMMUTABLE)/u);
    assert.match(source, /complete[\s\S]{0,100}partial[\s\S]{0,100}failed/u);
    assert.match(source, /9007199254740991/u);
  }
  for (const table of tables) {
    assert.match(postgres, new RegExp(`REVOKE ALL ON ${table} FROM PUBLIC`, "u"));
  }
});

test("runtime registries, owner migrator, typed schema, and repository expose the immutable foundation", () => {
  assert.equal(runtime.match(/0084_finops_trusted_advisor_organization/gu)?.length, 2);
  assert.equal(postgresRuntime.match(/0079_finops_trusted_advisor_organization/gu)?.length, 2);
  assert.equal(migrator.match(/0079_finops_trusted_advisor_organization\.sql/gu)?.length, 1);
  for (const symbol of [
    "finopsTaCollectionManifests", "finopsTaManifestAccounts", "finopsTaAccountSnapshots",
    "finopsTaCheckSnapshots", "finopsTaResourceSnapshots", "finopsTaOrganizationSnapshots",
    "finopsTaOrganizationSnapshotHeads",
  ]) assert.match(schema, new RegExp(`export const ${symbol}\\b`, "u"));
  assert.match(repository, /c\.source_kind = 'aws_trust_role'/u);
  assert.match(repository, /c\.status = 'active'/u);
  assert.match(repository, /await database\.batch\(statements\)/u);
  assert.match(repository, /MAX_HISTORY = 36/u);
  assert.doesNotMatch(repository, /rawPayload|providerError|simulated_fixture/u);
});
