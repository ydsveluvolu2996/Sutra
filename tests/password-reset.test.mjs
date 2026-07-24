import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const auth = await import("../db/auth-repository.ts");
const reset = await import("../db/password-reset-repository.ts");
const runtimeMigrations = await import("../db/runtime-migrations.ts");

const EMAIL = "reset-owner@sutra.invalid";
const OLD_PASSWORD = "Original secure workspace passphrase 2026!";
const NEW_PASSWORD = "Replacement secure workspace passphrase 2026!";

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-password-reset-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    const bootstrap = await auth.bootstrapLocalAdmin({
      email: EMAIL,
      password: OLD_PASSWORD,
      displayName: "Reset Owner",
      organizationName: "Sutra Reset Test",
    }, 1000);
    await run({ database, bootstrap });
  } finally {
    await miniflare.dispose();
  }
}

test("password reset stores only a digest, revokes sessions, preserves MFA state and is single-use", async () => {
  await withDatabase(async ({ database, bootstrap }) => {
    const created = await reset.createPasswordResetRequest(EMAIL, 2000);
    assert.ok(created);
    assert.match(created.token, /^[A-Za-z0-9_-]{43}$/u);

    const stored = await database.prepare(
      `SELECT token_digest, delivery_status FROM password_reset_tokens WHERE id = ?`,
    ).bind(created.id).first();
    assert.notEqual(stored.token_digest, created.token);
    assert.equal(stored.delivery_status, "not_attempted");
    const databaseDump = JSON.stringify(
      (await database.prepare(`SELECT * FROM password_reset_tokens`).all()).results,
    );
    assert.equal(databaseDump.includes(created.token), false);

    await reset.recordPasswordResetDelivery(created.id, {
      status: "accepted",
      transport: "email-api",
      provider: "resend",
      errorCode: null,
      httpStatus: 202,
    });
    await reset.completePasswordReset(created.token, NEW_PASSWORD, 3000);

    const session = await database.prepare(
      `SELECT revoked_at FROM local_sessions WHERE id = ?`,
    ).bind(bootstrap.session.session.id).first();
    assert.equal(session.revoked_at, 3000);
    const consumed = await database.prepare(
      `SELECT consumed_at, consumed_nonce, delivery_status
         FROM password_reset_tokens WHERE id = ?`,
    ).bind(created.id).first();
    assert.equal(consumed.consumed_at, 3000);
    assert.match(consumed.consumed_nonce, /^reset_complete_/u);
    assert.equal(consumed.delivery_status, "accepted");
    const audit = await database.prepare(
      `SELECT action, actor_id, target_id
         FROM audit_events WHERE action = 'auth.password_reset.completed'`,
    ).first();
    assert.equal(audit.action, "auth.password_reset.completed");
    assert.equal(audit.actor_id, bootstrap.session.subject.userId);
    assert.equal(audit.target_id, bootstrap.session.subject.userId);

    await assert.rejects(
      reset.completePasswordReset(created.token, `${NEW_PASSWORD} again`, 4000),
      (error) => error?.code === "PASSWORD_RESET_INVALID",
    );
    await assert.rejects(
      auth.loginLocalUser(
        { email: EMAIL, password: OLD_PASSWORD },
        { encryptionKey: "A".repeat(43), keyVersion: "local-auth-v1" },
        5000,
      ),
      (error) => error?.code === "INVALID_CREDENTIALS",
    );
    const login = await auth.loginLocalUser(
      { email: EMAIL, password: NEW_PASSWORD },
      { encryptionKey: "A".repeat(43), keyVersion: "local-auth-v1" },
      6000,
    );
    assert.equal(login.mfaEnrollmentRequired, true);
  });
});

test("unknown addresses are indistinguishable to the repository caller and a newer request supersedes the old token", async () => {
  await withDatabase(async () => {
    assert.equal(
      await reset.createPasswordResetRequest("missing@sutra.invalid", 2000),
      null,
    );
    const first = await reset.createPasswordResetRequest(EMAIL, 3000);
    const throttled = await reset.createPasswordResetRequest(EMAIL, 4000);
    assert.equal(throttled, null, "a repeated request must preserve the first emailed link");
    const second = await reset.createPasswordResetRequest(EMAIL, 303001);
    assert.ok(first);
    assert.ok(second);
    await assert.rejects(
      reset.completePasswordReset(first.token, NEW_PASSWORD, 304000),
      (error) => error?.code === "PASSWORD_RESET_INVALID",
    );
    await reset.completePasswordReset(second.token, NEW_PASSWORD, 304000);
  });
});
