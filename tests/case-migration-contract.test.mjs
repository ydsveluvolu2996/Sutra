import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [d1, postgres] = await Promise.all([
  readFile(new URL("../drizzle/0010_sutra_operations_wave.sql", import.meta.url), "utf8"),
  readFile(new URL("../postgres/migrations/0002_case_management.sql", import.meta.url), "utf8"),
]);

for (const [name, source] of [["D1", d1], ["PostgreSQL", postgres]]) {
  test(`${name} case schema enforces scope, assignment, evidence, and immutable activity`, () => {
    for (const table of ["finding_cases", "finding_case_activities"]) assert.match(source, new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? [\`]?${table}`));
    for (const column of ["org_id", "customer_id", "connection_id", "finding_fingerprint", "finding_snapshot_id", "assignee_membership_id", "due_at", "event_hash", "previous_event_hash"]) assert.match(source, new RegExp("`?" + column + "`?"));
    assert.match(source, /finding_cases_active_fingerprint_uq/u);
    assert.match(source, /finding_case_activity_chain_uq/u);
    assert.match(source, /BEFORE UPDATE/u);
    assert.match(source, /BEFORE DELETE/u);
    assert.match(source, /case activity is immutable/u);
  });
}
