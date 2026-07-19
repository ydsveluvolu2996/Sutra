import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify, decideNextAttempt } from "../lib/job-queue.ts";

describe("job retry policy", () => {
  it("uses deterministic exponential backoff without guessing jitter", () => {
    assert.deepEqual(decideNextAttempt({ attempt: 1, maxAttempts: 4, baseDelayMs: 5_000, nowMs: 100_000 }), {
      kind: "retry-at", runAfterMs: 105_000,
    });
    assert.deepEqual(decideNextAttempt({ attempt: 3, maxAttempts: 4, baseDelayMs: 5_000, nowMs: 100_000 }), {
      kind: "retry-at", runAfterMs: 120_000,
    });
  });

  it("dead-letters at the maximum attempt", () => {
    assert.equal(classify({ attempt: 2, maxAttempts: 3 }), "retry");
    assert.equal(classify({ attempt: 3, maxAttempts: 3 }), "dead-letter");
    assert.deepEqual(decideNextAttempt({ attempt: 3, maxAttempts: 3, baseDelayMs: 5_000, nowMs: 100_000 }), {
      kind: "dead-letter",
    });
  });
});
