import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [sqlite, postgres, runtime, postgresRuntime, migrator, repository] =
  await Promise.all([
    readFile(new URL(
      "../drizzle/0083_finops_data_export_observations.sql",
      import.meta.url,
    ), "utf8"),
    readFile(new URL(
      "../postgres/migrations/0078_finops_data_export_observations.sql",
      import.meta.url,
    ), "utf8"),
    readFile(new URL("../db/runtime-migrations.ts", import.meta.url), "utf8"),
    readFile(new URL(
      "../db/postgres-runtime-migrations.ts",
      import.meta.url,
    ), "utf8"),
    readFile(new URL("../scripts/postgres-migrate.mjs", import.meta.url), "utf8"),
    readFile(new URL(
      "../db/finops-data-export-observation-repository.ts",
      import.meta.url,
    ), "utf8"),
  ]);

test("billing observation outbox has immutable SQLite/PostgreSQL parity", () => {
  for (const source of [sqlite, postgres]) {
    for (const field of [
      "org_id",
      "customer_id",
      "connection_id",
      "payload_json",
      "payload_sha256",
      "producer_key_id",
      "producer_operation_id",
      "producer_nonce",
      "producer_body_sha256",
      "observed_at",
      "created_at",
    ]) assert.match(source, new RegExp(`\\b${field}\\b`, "u"));
    assert.match(source, /FINOPS_DATA_EXPORT_OBSERVATION_IMMUTABLE/u);
  }
  assert.match(
    postgres,
    /REVOKE ALL ON finops_data_export_observations FROM PUBLIC/u,
  );
  assert.equal(runtime.match(/0083_finops_data_export_observations/gu)?.length, 2);
  assert.equal(
    postgresRuntime.match(/0078_finops_data_export_observations/gu)?.length,
    2,
  );
  assert.equal(
    migrator.match(/0078_finops_data_export_observations\.sql/gu)?.length,
    1,
  );
});

test("repository binds observations to live exact scope and verified producer evidence", () => {
  assert.match(repository, /recordVerifiedObservation/u);
  assert.match(repository, /VerifiedHostedBrokerRequest/u);
  assert.match(repository, /value\.tenantId === scope\.orgId/u);
  assert.match(repository, /value\.connectionId === scope\.connectionId/u);
  assert.match(
    repository,
    /await sha256Bytes\(input\.body\) !== input\.verification\.bodySha256/u,
  );
  assert.match(repository, /c\.source_kind = 'aws_trust_role'/u);
  assert.match(repository, /c\.status = 'active'/u);
  assert.match(
    repository,
    /d\.id = \? AND d\.org_id = \? AND d\.customer_id = \?[\s\S]*d\.connection_id = \?/u,
  );
  assert.match(
    repository,
    /await sha256Bytes\(encoded\(JSON\.stringify\(payload\)\)\) !== row\.payload_sha256/u,
  );
});
