import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sqlite = await readFile(new URL("../drizzle/0086_finops_active_file_count.sql", import.meta.url), "utf8");
const postgres = await readFile(new URL("../postgres/migrations/0081_finops_active_file_count.sql", import.meta.url), "utf8");
const runtime = await readFile(new URL("../db/runtime-migrations.ts", import.meta.url), "utf8");
const postgresRuntime = await readFile(new URL("../db/postgres-runtime-migrations.ts", import.meta.url), "utf8");
const migrator = await readFile(new URL("../scripts/postgres-migrate.mjs", import.meta.url), "utf8");

test("active file-count migrations are bounded and conservatively backfill only matching ready manifests", () => {
  for (const source of [sqlite, postgres]) {
    assert.match(source, /active_file_count/u);
    assert.match(source, /active_file_count[^\n]*IS NULL[\s\S]*BETWEEN 1 AND 10000/u);
    assert.match(source, /status[^\n]*= 'ready'/u);
    assert.match(source, /active_manifest_sha256[^\n]*= [`]?manifest_sha256/u);
    assert.match(source, /staging_generation_id[^\n]*IS NULL/u);
    assert.match(source, /staging_manifest_sha256[^\n]*IS NULL/u);
    assert.match(source, /file_count[^\n]*BETWEEN 1 AND 10000/u);
  }
});

test("active file-count migrations are registered after compute optimizer discovery", () => {
  assert.equal(runtime.match(/0086_finops_active_file_count/gu)?.length, 2);
  assert.equal(postgresRuntime.match(/0081_finops_active_file_count/gu)?.length, 2);
  assert.equal(migrator.match(/0081_finops_active_file_count\.sql/gu)?.length, 1);
  assert.ok(runtime.indexOf("0086_finops_active_file_count") > runtime.indexOf("0085_finops_compute_optimizer_discovery"));
  assert.ok(postgresRuntime.indexOf("0081_finops_active_file_count") > postgresRuntime.indexOf("0080_finops_compute_optimizer_discovery"));
});
