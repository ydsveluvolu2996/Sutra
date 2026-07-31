import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sqlite = readFileSync(
  new URL("../drizzle/0079_finops_foundational_config.sql", import.meta.url),
  "utf8",
);
const postgres = readFileSync(
  new URL("../postgres/migrations/0074_finops_foundational_config.sql", import.meta.url),
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

test("Foundational config migrations normalize tenant-scoped goals and immutable taxonomy publications", () => {
  for (const source of [sqlite, postgres]) {
    assert.match(source, /finops_kpi_goal_versions/u);
    assert.match(source, /finops_taxonomy_snapshots/u);
    assert.match(source, /finops_taxonomy_assignments/u);
    assert.match(source, /finops_taxonomy_allowed_values/u);
    assert.match(source, /finops_taxonomy_heads/u);
    assert.match(source, /target_basis_points[\s\S]{0,100}(?:BETWEEN 0 AND 10000|between 0 and 10000)/iu);
    assert.match(source, /finops_kpi_goal_versions_no_overlap/u);
    assert.match(source, /IMMUTABLE/iu);
    assert.match(source, /org_id[\s\S]*customer_id[\s\S]*connection_id/u);
  }
});

test("persistent KPI goals contain no billing period or generation coupling", () => {
  for (const source of [sqlite, postgres]) {
    const goalTable = /CREATE TABLE [`"]?finops_kpi_goal_versions[`"]? \(([\s\S]*?)\);/iu.exec(source)?.[1] ?? "";
    assert.notEqual(goalTable, "");
    assert.doesNotMatch(goalTable, /billing_period|generation_id/u);
    assert.match(goalTable, /UNIQUE\s*\([^)]*org_id[^)]*customer_id[^)]*connection_id[^)]*kpi_id[^)]*version/iu);
    assert.match(goalTable, /rbac_decision_id/u);
    assert.match(goalTable, /audit_reference/u);
  }
  assert.match(postgres, /pg_advisory_xact_lock/u);
});

test("both migration registries, PostgreSQL migrator, and typed schema include the release once", () => {
  assert.match(runtime, /0079_finops_foundational_config/u);
  assert.match(postgresRuntime, /0074_finops_foundational_config/u);
  assert.match(migrator, /0074_finops_foundational_config\.sql/u);
  assert.match(schema, /finopsKpiGoalVersions/u);
  assert.match(schema, /finopsTaxonomySnapshots/u);
  assert.match(schema, /finopsTaxonomyAssignments/u);
  assert.match(schema, /finopsTaxonomyAllowedValues/u);
  assert.match(schema, /finopsTaxonomyHeads/u);
});
