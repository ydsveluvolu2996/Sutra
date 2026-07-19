import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectRowsForPrune } from "../lib/retention-policy.ts";

describe("retention policy", () => {
  const now = Date.parse("2026-07-19T00:00:00Z");
  const rows = [
    { id: "old", occurredAtMs: now - 31 * 24 * 60 * 60 * 1_000 },
    { id: "fresh", occurredAtMs: now - 24 * 60 * 60 * 1_000 },
  ];

  it("selects only expired rows from mutable operational tables", () => {
    assert.deepEqual(selectRowsForPrune({ table: "security_events", keepDays: 30, nowMs: now, rows }), ["old"]);
  });

  it("never selects immutable CMDB or compliance audit evidence", () => {
    for (const table of ["cmdb_snapshots", "cmdb_change_events", "compliance_signoffs"] as const) {
      assert.deepEqual(selectRowsForPrune({ table, keepDays: 1, nowMs: now, rows }), []);
    }
  });
});
