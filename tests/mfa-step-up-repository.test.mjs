import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const auth = await import("../db/auth-repository.ts");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const cryptoHelpers = await import("../lib/local-auth-crypto.ts");
const sessionLifecycle = await import("../lib/browser-session-lifecycle.ts");

const NOW = 59_000;
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const RFC_CODE = "287082";
const AUTH_SECRETS = {
  encryptionKey: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
  keyVersion: "test-auth-v1",
};

async function withEnrolledUser(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-mfa-step-up-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    const bootstrap = await auth.bootstrapLocalAdmin({
      email: "mfa-step-up@sutra.invalid",
      password: "MFA repository acceptance passphrase 2026!",
      displayName: "MFA Repository",
      organizationName: "Sutra MFA Test",
    }, NOW);
    const userId = bootstrap.session.subject.userId;
    const sealed = await cryptoHelpers.sealTotpSecret(
      RFC_SECRET,
      AUTH_SECRETS.encryptionKey,
      AUTH_SECRETS.keyVersion,
      userId,
    );
    await database.prepare(
      `INSERT INTO totp_credentials
        (user_id, secret_ciphertext, secret_key_version, confirmed_at,
         last_used_step, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).bind(userId, sealed.ciphertext, sealed.keyVersion, NOW - 1, NOW - 1, NOW - 1).run();
    const first = await auth.getLocalSession(bootstrap.token, NOW);
    assert.ok(first);

    const secondToken = cryptoHelpers.generateSessionToken();
    const secondDigest = await cryptoHelpers.digestSessionToken(secondToken);
    await database.prepare(
      `INSERT INTO local_sessions
        (id, token_digest, user_id, selected_org_id, created_at, expires_at,
         last_seen_at, mfa_verified_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).bind(
      `sess_${"2".repeat(32)}`,
      secondDigest,
      userId,
      first.subject.orgId,
      NOW,
      NOW + auth.LOCAL_SESSION_TTL_MS,
      NOW,
    ).run();
    const second = await auth.getLocalSession(secondToken, NOW);
    assert.ok(second);
    await run({ database, first, second, secondToken });
  } finally {
    await miniflare.dispose();
  }
}

test("an idle browser session is rejected without reviving last-seen", async () => {
  await withEnrolledUser(async ({ database, secondToken, second }) => {
    const idleDeadline = NOW + sessionLifecycle.BROWSER_SESSION_IDLE_TTL_MS;
    assert.equal(await auth.getLocalSession(secondToken, idleDeadline), null);
    const persisted = await database.prepare(
      "SELECT last_seen_at FROM local_sessions WHERE id = ?",
    ).bind(second.session.id).first();
    assert.equal(Number(persisted?.last_seen_at), NOW);
  });
});

test("one TOTP code refreshes exactly one of two concurrent sessions", async () => {
  await withEnrolledUser(async ({ database, first, second }) => {
    const outcomes = await Promise.allSettled([
      auth.verifyTotpStepUp(first, RFC_CODE, AUTH_SECRETS, NOW),
      auth.verifyTotpStepUp(second, RFC_CODE, AUTH_SECRETS, NOW),
    ]);
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
    const credential = await database.prepare(
      "SELECT last_used_step FROM totp_credentials WHERE user_id = ?",
    ).bind(first.subject.userId).first();
    assert.equal(credential?.last_used_step, 1);
    const refreshed = await database.prepare(
      "SELECT COUNT(*) AS count FROM local_sessions WHERE user_id = ? AND mfa_verified_at = ?",
    ).bind(first.subject.userId, NOW).first();
    assert.equal(refreshed?.count, 1);
  });
});

test("a missing target session rolls back the one-time credential claim", async () => {
  await withEnrolledUser(async ({ database, first }) => {
    const nonexistentSession = { ...first, tokenDigest: "x".repeat(43) };
    await assert.rejects(
      auth.verifyTotpStepUp(nonexistentSession, RFC_CODE, AUTH_SECRETS, NOW),
      (error) => error?.code === "PERSISTENCE_FAILED",
    );
    const afterFailure = await database.prepare(
      "SELECT last_used_step FROM totp_credentials WHERE user_id = ?",
    ).bind(first.subject.userId).first();
    assert.equal(afterFailure?.last_used_step, null);
    await auth.verifyTotpStepUp(first, RFC_CODE, AUTH_SECRETS, NOW);
  });
});
