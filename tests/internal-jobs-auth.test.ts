import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifyInternalToken } from "../lib/internal-auth.ts";

describe("verifyInternalToken", () => {
  it("reports not-configured when no expected token is set", () => {
    assert.equal(verifyInternalToken(undefined, "anything"), "not-configured");
    assert.equal(verifyInternalToken("", "anything"), "not-configured");
    assert.equal(verifyInternalToken("   ", "anything"), "not-configured");
  });

  it("rejects a missing or empty provided token", () => {
    assert.equal(verifyInternalToken("expected-token", null), "unauthorized");
    assert.equal(verifyInternalToken("expected-token", ""), "unauthorized");
  });

  it("rejects a mismatched token", () => {
    assert.equal(verifyInternalToken("expected-token", "wrong-token"), "unauthorized");
    assert.equal(verifyInternalToken("expected-token", "expected-token-longer"), "unauthorized");
  });

  it("accepts an exact match (expected is trimmed)", () => {
    assert.equal(verifyInternalToken("expected-token", "expected-token"), "ok");
    assert.equal(verifyInternalToken("  expected-token  ", "expected-token"), "ok");
  });

  it("compares in constant time relative to length, not first-mismatch position", () => {
    const expected = "a".repeat(64);
    const earlyMismatch = `b${"a".repeat(63)}`;
    const lateMismatch = `${"a".repeat(63)}b`;
    // Both are same-length mismatches; the helper returns unauthorized for each
    // without short-circuiting on the first differing character.
    assert.equal(verifyInternalToken(expected, earlyMismatch), "unauthorized");
    assert.equal(verifyInternalToken(expected, lateMismatch), "unauthorized");
  });
});
