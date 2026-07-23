import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BROWSER_SESSION_IDLE_TTL_MS,
  browserSessionEffectiveExpiresAt,
  browserSessionIsActive,
} from "../lib/browser-session-lifecycle.ts";

const repository = await readFile(new URL("../db/auth-repository.ts", import.meta.url), "utf8");
const loginRoute = await readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8");
const oidcCallback = await readFile(new URL("../app/api/auth/oidc/callback/route.ts", import.meta.url), "utf8");
const apiTokenRepository = await readFile(new URL("../db/api-token-repository.ts", import.meta.url), "utf8");

test("human browser sessions have a fixed fifteen-minute idle deadline", () => {
  assert.equal(BROWSER_SESSION_IDLE_TTL_MS, 15 * 60 * 1000);
  const session = { absoluteExpiresAt: 10_000_000, lastSeenAt: 1_000, revokedAt: null };
  assert.equal(browserSessionIsActive(session, 1_000 + BROWSER_SESSION_IDLE_TTL_MS - 1), true);
  assert.equal(browserSessionIsActive(session, 1_000 + BROWSER_SESSION_IDLE_TTL_MS), false);
});

test("revocation and absolute expiry remain authoritative", () => {
  assert.equal(browserSessionIsActive({
    absoluteExpiresAt: 2_000,
    lastSeenAt: 1_900,
    revokedAt: null,
  }, 2_000), false);
  assert.equal(browserSessionIsActive({
    absoluteExpiresAt: 3_000,
    lastSeenAt: 1_900,
    revokedAt: 1_950,
  }, 2_000), false);
});

test("the administration expiry is the earlier idle or absolute deadline", () => {
  assert.equal(browserSessionEffectiveExpiresAt({
    absoluteExpiresAt: 10_000_000,
    lastSeenAt: 1_000,
  }), 1_000 + BROWSER_SESSION_IDLE_TTL_MS);
  assert.equal(browserSessionEffectiveExpiresAt({
    absoluteExpiresAt: 2_000,
    lastSeenAt: 1_000,
  }), 2_000);
});

test("session lookup enforces idle expiry before touching last-seen", () => {
  assert.match(repository, /WHERE s\.token_digest = \?[\s\S]*s\.expires_at > \?[\s\S]*s\.last_seen_at > \?/u);
  assert.match(repository, /bind\(LOCAL_IDENTITY_ISSUER, digest, now, now - BROWSER_SESSION_IDLE_TTL_MS\)/u);
  const lookup = repository.indexOf("const row = await db.prepare");
  const touch = repository.indexOf("UPDATE local_sessions SET last_seen_at", lookup);
  assert.ok(lookup >= 0 && touch > lookup, "an expired row must never be revived before validation");
});

test("password and OIDC login both issue the same browser-session cookie", () => {
  assert.match(loginRoute, /sessionCookie\(request, result\.token\)/u);
  assert.match(oidcCallback, /sessionCookie\(request, result\.token\)/u);
  assert.doesNotMatch(loginRoute, /LOCAL_SESSION_TTL_MS \/ 1000/u);
  assert.doesNotMatch(oidcCallback, /maximumAgeSeconds/u);
});

test("public API tokens keep their independent bearer-token lifecycle", () => {
  assert.match(apiTokenRepository, /token_sha256/u);
  assert.match(apiTokenRepository, /expires_at/u);
  assert.doesNotMatch(apiTokenRepository, /BROWSER_SESSION_IDLE_TTL_MS|sutra_session/u);
});
