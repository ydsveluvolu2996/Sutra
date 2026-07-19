import assert from "node:assert/strict";
import test from "node:test";

import { assessRecoveryObjectives } from "../lib/recovery-objectives.ts";

test("passes approved 24-hour RPO and four-hour RTO objectives", () => {
  const result = assessRecoveryObjectives({
    backupCreatedAt: "2026-07-17T00:00:00.000Z",
    drillStartedAt: "2026-07-17T20:00:00.000Z",
    drillCompletedAt: "2026-07-17T20:30:00.000Z",
  });
  assert.equal(result.rpoMet, true);
  assert.equal(result.rtoMet, true);
  assert.equal(result.outcome, "passed");
});

test("fails stale recovery points without hiding a fast restore", () => {
  const result = assessRecoveryObjectives({
    backupCreatedAt: "2026-07-15T00:00:00.000Z",
    drillStartedAt: "2026-07-17T00:00:01.000Z",
    drillCompletedAt: "2026-07-17T00:01:01.000Z",
  });
  assert.equal(result.rpoMet, false);
  assert.equal(result.rtoMet, true);
  assert.equal(result.outcome, "failed");
});

test("rejects reversed or malformed drill timestamps", () => {
  assert.throws(() => assessRecoveryObjectives({
    backupCreatedAt: "not-a-date",
    drillStartedAt: "2026-07-17T00:00:00.000Z",
    drillCompletedAt: "2026-07-17T00:01:00.000Z",
  }), /invalid/u);
});
