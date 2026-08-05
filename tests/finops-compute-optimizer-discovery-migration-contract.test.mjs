import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sqlite = await readFile(new URL("../drizzle/0085_finops_compute_optimizer_discovery.sql", import.meta.url), "utf8");
const postgres = await readFile(new URL("../postgres/migrations/0080_finops_compute_optimizer_discovery.sql", import.meta.url), "utf8");
const runtime = await readFile(new URL("../db/runtime-migrations.ts", import.meta.url), "utf8");
const postgresRuntime = await readFile(new URL("../db/postgres-runtime-migrations.ts", import.meta.url), "utf8");
const migrator = await readFile(new URL("../scripts/postgres-migrate.mjs", import.meta.url), "utf8");

test("SQLite and PostgreSQL ship the same bounded discovery tables and immutable/head guards", () => {
  for (const name of [
    "finops_co_discovery_runs",
    "finops_co_member_enrollments",
    "finops_co_export_jobs",
    "finops_co_discovery_coverage",
    "finops_co_discovery_heads",
  ]) {
    assert.match(sqlite, new RegExp(name, "u"));
    assert.match(postgres, new RegExp(name, "u"));
  }
  for (const contract of [
    "FINOPS_CO_IMMUTABLE",
    "FINOPS_CO_RUN_NOT_RUNNING",
    "FINOPS_CO_HEAD_ADVANCE_REJECTED",
    "FINOPS_CO_MATERIALIZATION_INCOMPLETE",
    "FINOPS_CO_EXPORT_OBJECT_BINDING_REQUIRED",
  ]) {
    assert.match(sqlite, new RegExp(contract, "u"));
    assert.match(postgres, new RegExp(contract, "u"));
  }
  assert.match(sqlite, /status` = 'complete'/u);
  assert.match(postgres, /status = 'complete'/u);
  assert.doesNotMatch(sqlite, /bucket_name|object_key` text/u);
  assert.doesNotMatch(postgres, /bucket_name|object_key text/u);
});

test("both runtime migrators register the paired migration exactly once", () => {
  assert.equal(runtime.match(/0085_finops_compute_optimizer_discovery/gu)?.length, 2);
  assert.equal(postgresRuntime.match(/0080_finops_compute_optimizer_discovery/gu)?.length, 2);
  assert.equal(migrator.match(/0080_finops_compute_optimizer_discovery\.sql/gu)?.length, 1);
});
