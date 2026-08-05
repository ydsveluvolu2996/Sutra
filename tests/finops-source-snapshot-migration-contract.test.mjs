import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sqlite = readFileSync(
  new URL("../drizzle/0081_finops_source_snapshots.sql", import.meta.url),
  "utf8",
);
const postgres = readFileSync(
  new URL("../postgres/migrations/0076_finops_source_snapshots.sql", import.meta.url),
  "utf8",
);
const runtime = readFileSync(
  new URL("../db/runtime-migrations.ts", import.meta.url),
  "utf8",
);
const postgresRuntime = readFileSync(
  new URL("../db/postgres-runtime-migrations.ts", import.meta.url),
  "utf8",
);
const migrator = readFileSync(
  new URL("../scripts/postgres-migrate.mjs", import.meta.url),
  "utf8",
);
const schema = readFileSync(new URL("../db/schema.ts", import.meta.url), "utf8");
const repository = readFileSync(
  new URL("../db/finops-source-snapshot-repository.ts", import.meta.url),
  "utf8",
);

test("snapshot migrations preserve tenant, source, generation, coverage, reconciliation, and encrypted evidence parity", () => {
  for (const source of [sqlite, postgres]) {
    for (const field of [
      "generation_id",
      "org_id",
      "customer_id",
      "connection_id",
      "source_id",
      "job_id",
      "attempt",
      "content_sha256",
      "schema_version",
      "collected_at",
      "data_through_at",
      "coverage_assessment",
      "coverage_expected_records",
      "coverage_observed_records",
      "coverage_missing_records",
      "reconciliation_expected_records",
      "reconciliation_accepted_records",
      "reconciliation_rejected_records",
      "reconciliation_outcome",
      "evidence_reference_ciphertext",
      "evidence_reference_key_version",
      "active_generation_id",
      "advanced_at",
    ]) {
      assert.match(source, new RegExp(`\\b${field}\\b`, "u"));
    }
    assert.match(source, /complete[\s\S]{0,100}partial[\s\S]{0,100}unknown/u);
    assert.match(source, /ready[\s\S]{0,100}complete[\s\S]{0,100}partial[\s\S]{0,100}failed[\s\S]{0,100}stale/u);
    assert.match(source, /FINOPS_SOURCE_SNAPSHOT_ATTEMPT_REJECTED/u);
    assert.match(source, /FINOPS_SOURCE_SNAPSHOT_IMMUTABLE/u);
    assert.match(source, /FINOPS_SOURCE_SNAPSHOT_HEAD_ADVANCE_REJECTED/u);
    assert.match(source, /fsev1(?:\\)?\./u);
    assert.match(source, /9007199254740991/u);
    assert.match(
      source,
      /org_id[\s\S]{0,100}customer_id[\s\S]{0,100}connection_id[\s\S]{0,100}source_id[\s\S]{0,100}job_id[\s\S]{0,100}attempt/u,
    );
  }
  assert.match(postgres, /REVOKE ALL ON finops_source_snapshots FROM PUBLIC/u);
  assert.match(postgres, /REVOKE ALL ON finops_source_snapshot_heads FROM PUBLIC/u);
});

test("runtime registries, owner migrator grants, and typed schema include the next immutable migration once", () => {
  assert.equal(runtime.match(/0081_finops_source_snapshots/gu)?.length, 2);
  assert.equal(postgresRuntime.match(/0076_finops_source_snapshots/gu)?.length, 2);
  assert.equal(migrator.match(/0076_finops_source_snapshots\.sql/gu)?.length, 1);
  assert.match(migrator, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public/u);
  assert.match(schema, /finopsSourceSnapshots/u);
  assert.match(schema, /finopsSourceSnapshotHeads/u);
});

test("repository uses the durable attempt ledger, atomic batches, exact live scope, and bounded active reads", () => {
  assert.match(repository, /FROM finops_source_job_attempts/u);
  assert.match(repository, /await database\.batch\(\[/u);
  assert.match(repository, /c\.source_kind = 'aws_trust_role'/u);
  assert.match(repository, /c\.status = 'active'/u);
  assert.match(repository, /cu\.status = 'active'/u);
  assert.match(repository, /MAX_LIST_LIMIT = 100/u);
  assert.match(repository, /listActiveSnapshots/u);
  assert.match(repository, /getActiveSnapshot/u);
  assert.doesNotMatch(repository, /providerError|rawPayload|simulated_fixture/u);
});
