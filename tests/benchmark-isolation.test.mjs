import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contracts = [
  ["resource_annotations", "db/cmdb-workspace-repository.ts", "drizzle/0026_cmdb_workspace.sql"],
  ["cmdb_saved_queries", "db/cmdb-workspace-repository.ts", "drizzle/0026_cmdb_workspace.sql"],
  ["custom_frameworks", "db/compliance-workspace-repository.ts", "drizzle/0027_compliance_workspace.sql"],
  ["compliance_signoffs", "db/compliance-workspace-repository.ts", "drizzle/0027_compliance_workspace.sql"],
  ["compliance_trend_points", "db/compliance-workspace-repository.ts", "drizzle/0027_compliance_workspace.sql"],
  ["finops_cur_lines", "db/finops-workspace-repository.ts", "drizzle/0028_finops_workspace.sql"],
  ["finops_budgets", "db/finops-workspace-repository.ts", "drizzle/0028_finops_workspace.sql"],
  ["api_tokens", "db/api-token-repository.ts", "drizzle/0029_public_api.sql"],
  ["itsm_connectors", "db/itsm-connector-repository.ts", "drizzle/0030_itsm_connectors.sql"],
  ["background_jobs", "db/job-queue-repository.ts", "drizzle/0031_background_jobs.sql"],
];

test("benchmark data planes carry organization scope in schema and repository queries", async () => {
  for (const [table, repositoryPath, migrationPath] of contracts) {
    const [repository, migration] = await Promise.all([
      readFile(new URL(`../${repositoryPath}`, import.meta.url), "utf8"),
      readFile(new URL(`../${migrationPath}`, import.meta.url), "utf8"),
    ]);
    const tableStart = migration.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`);
    assert.notEqual(tableStart, -1, `${table} must have a migration`);
    const tableEnd = migration.indexOf(");", tableStart);
    const tableDefinition = migration.slice(tableStart, tableEnd);
    assert.match(tableDefinition, /\borg_id\b/u, `${table} must carry org_id`);
    assert.match(repository, new RegExp(`\\b${table}\\b`, "u"), `${repositoryPath} must own ${table}`);
    assert.match(repository, /\borg_id\s*=\s*\?/u, `${repositoryPath} must filter by org_id`);
  }
});

test("new connector and queue suites contain explicit cross-organization negative probes", async () => {
  for (const path of ["tests/itsm-connector-repository.test.mjs", "tests/job-queue-repository.test.mjs"]) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(source, /ORG_B/u);
    assert.match(source, /SCOPE_NOT_FOUND|deepEqual\(await repository\.list/u);
  }
});
