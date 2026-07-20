import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const { nextLoginFailureState } = await import("../db/auth-repository.ts");

const NOW = 1_000_000_000_000;
const LOCKOUT_MS = 5 * 60 * 1000;

test("failed attempts increment and lock out at the threshold", () => {
  assert.deepEqual(nextLoginFailureState(0, NOW), { failedAttempts: 1, lockedUntil: null });
  assert.deepEqual(nextLoginFailureState(3, NOW), { failedAttempts: 4, lockedUntil: null });
  // The 5th failure locks the account.
  assert.deepEqual(nextLoginFailureState(4, NOW), { failedAttempts: 5, lockedUntil: NOW + LOCKOUT_MS });
});

test("the counter is NEVER reset to 0 on lockout, so a new cycle cannot mint a fresh budget", () => {
  // Regression: the old code reset failed_attempts to 0 at lockout, so once the
  // window expired the attacker got a brand-new budget of 5. It must keep
  // climbing instead.
  const atThreshold = nextLoginFailureState(4, NOW);
  assert.equal(atThreshold.failedAttempts, 5);

  // The next failure after a lockout expired (counter still 5) climbs to 6 and
  // extends the lockout progressively (2x here), never resetting.
  const again = nextLoginFailureState(5, NOW);
  assert.equal(again.failedAttempts, 6);
  assert.equal(again.lockedUntil, NOW + LOCKOUT_MS * 2);

  const third = nextLoginFailureState(6, NOW);
  assert.equal(third.failedAttempts, 7);
  assert.equal(third.lockedUntil, NOW + LOCKOUT_MS * 3);
});

test("the progressive lockout multiplier is bounded", () => {
  // Even after many failures the lockout window stays finite (capped at 12x).
  const deep = nextLoginFailureState(1_000, NOW);
  assert.equal(deep.failedAttempts, 1_001);
  assert.equal(deep.lockedUntil, NOW + LOCKOUT_MS * 12);
});
