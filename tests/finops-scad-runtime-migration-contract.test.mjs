import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

for (const [kind, file] of [["D1", "drizzle/0125_finops_scad_runtime_attempts.sql"],
  ["PostgreSQL", "postgres/migrations/0121_finops_scad_runtime_attempts.sql"]]) {
  test(`${kind} SCAD replay ledger pins 31-minute CAS leases and terminal immutability`, async () => {
    const sql = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(sql, /finops_scad_runtime_attempts/u); assert.match(sql, /1860000/u);
    assert.match(sql, /PERSISTED/u); assert.match(sql, /SUCCEEDED/u); assert.match(sql, /RETRYABLE_FAILED/u);
    assert.match(sql, /result_sha256/u); assert.match(sql, /SCAD_CUR2_RUNTIME_FAILED/u);
    assert.match(sql, /generation_id[\s\S]*finops_scad_allocation_snapshots/u);
    assert.match(sql, /TERMINAL_IMMUTABLE/u); assert.match(sql, /UNIQUE\s*\([^)]*org_id[^)]*scheduled_window/isu);
  });
}
