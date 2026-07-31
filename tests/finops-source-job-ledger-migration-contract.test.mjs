import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sqlite = readFileSync(
  new URL("../drizzle/0080_finops_source_job_ledger.sql", import.meta.url),
  "utf8",
);
const postgres = readFileSync(
  new URL(
    "../postgres/migrations/0075_finops_source_job_ledger.sql",
    import.meta.url,
  ),
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
  new URL("../db/finops-source-job-ledger-repository.ts", import.meta.url),
  "utf8",
);

test("source-job migrations have SQLite/PostgreSQL field and constraint parity", () => {
  for (const source of [sqlite, postgres]) {
    for (const field of [
      "org_id",
      "customer_id",
      "connection_id",
      "source_id",
      "job_id",
      "attempt",
      "idempotency_key",
      "queued_at",
      "started_at",
      "finished_at",
      "accepted_records",
      "rejected_records",
      "expected_records",
      "processed_bytes",
      "reconciliation_outcome",
      "reconciliation_evidence_reference",
      "error_code",
      "error_message",
    ]) {
      assert.match(source, new RegExp(`\\b${field}\\b`, "u"));
    }
    assert.match(
      source,
      /queued[\s\S]{0,100}running[\s\S]{0,100}succeeded[\s\S]{0,100}partial[\s\S]{0,100}failed[\s\S]{0,100}cancelled/u,
    );
    assert.match(source, /attempt[`"]?\s+BETWEEN 1 AND 100/iu);
    assert.match(source, /9007199254740991/u);
    assert.match(source, /FINOPS_SOURCE_JOB_INVALID_TRANSITION/u);
    assert.match(source, /FINOPS_SOURCE_JOB_ATTEMPT_IMMUTABLE/u);
    assert.match(source, /Collection failed because of an internal processing error/u);
    assert.match(
      source,
      /UNIQUE\s*\([^)]*org_id[^)]*customer_id[^)]*connection_id[^)]*source_id[^)]*idempotency_key/iu,
    );
  }
});

test("migration registries, PostgreSQL migrator, and typed schema include the ledger once", () => {
  assert.equal(
    runtime.match(/0080_finops_source_job_ledger/gu)?.length,
    2,
  );
  assert.equal(
    postgresRuntime.match(/0075_finops_source_job_ledger/gu)?.length,
    2,
  );
  assert.equal(
    migrator.match(/0075_finops_source_job_ledger\.sql/gu)?.length,
    1,
  );
  assert.match(schema, /finopsSourceJobAttempts/u);
  assert.match(schema, /finops_source_job_attempts_scope_idempotency_uq/u);
});

test("repository enforces live trust-role ownership and bounded keyset reads", () => {
  assert.match(repository, /c\.source_kind = 'aws_trust_role'/u);
  assert.match(repository, /c\.status = 'active'/u);
  assert.match(repository, /cu\.status = 'active'/u);
  assert.match(repository, /MAX_PAGE_LIMIT = 100/u);
  assert.match(repository, /a\.queued_at < \?/u);
  assert.match(repository, /IDEMPOTENCY_CONFLICT/u);
  assert.match(repository, /ATTEMPT_SEQUENCE_CONFLICT/u);
  assert.doesNotMatch(repository, /simulated_fixture/u);
});
