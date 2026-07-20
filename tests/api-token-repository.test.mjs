import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { ApiTokenRepository, ApiTokenRepositoryError, PUBLIC_API_RATE_LIMIT_PER_MINUTE } = await import("../db/api-token-repository.ts");

const ORG_A = "org_tok_a";
const ORG_B = "org_tok_b";
const CUSTOMER_A = "cust_tok_a";
const CUSTOMER_A2 = "cust_tok_a2";
const CUSTOMER_B = "cust_tok_b";
const SCOPE_A = { orgId: ORG_A, customerId: CUSTOMER_A };
const SCOPE_A2 = { orgId: ORG_A, customerId: CUSTOMER_A2 };

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-tok-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'tok-a', 'Tok A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'tok-b', 'Tok B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'tok-cust-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'tok-cust-a2', 'Customer A2', 'active')").bind(CUSTOMER_A2, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'tok-cust-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
    ]);
    await run(new ApiTokenRepository(database));
  } finally {
    await miniflare.dispose();
  }
}

test("0029 migration applies; mint returns the secret once and only the hash is stored", async () => {
  await withDatabase(async (repo) => {
    const minted = await repo.mint(SCOPE_A, "ci-reader", ["read:resources", "read:findings"], null, "user_a");
    assert.match(minted.token, /^sutra_pat_[a-f0-9]{64}$/u);
    const listed = await repo.list(SCOPE_A);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].tokenPrefix, minted.token.slice(0, 16));
    // The listing never contains the secret.
    assert.equal(JSON.stringify(listed).includes(minted.token), false);
    // Cross-org listing sees nothing.
    assert.deepEqual(await repo.list({ orgId: ORG_B, customerId: CUSTOMER_B }), []);
    // Unknown scopes are rejected, not silently filtered.
    await assert.rejects(
      repo.mint(SCOPE_A, "bad", ["read:resources", "admin:everything"], null, "user_a"),
      (error) => error instanceof ApiTokenRepositoryError && error.code === "INVALID_INPUT",
    );
    // Minting into a customer the org does not own writes nothing.
    await assert.rejects(
      repo.mint({ orgId: ORG_B, customerId: CUSTOMER_A }, "steal", ["read:resources"], null, "user_b"),
      (error) => error instanceof ApiTokenRepositoryError && error.code === "SCOPE_NOT_FOUND",
    );
  });
});

test("verify authenticates, enforces expiry/revocation, and rate-limits per minute", async () => {
  await withDatabase(async (repo) => {
    const now = Date.parse("2026-07-19T12:00:00Z");
    const minted = await repo.mint(SCOPE_A, "ops", ["read:cases", "write:cases"], "2026-08-01T00:00:00Z", "user_a", now);
    const verified = await repo.verify(minted.token, now);
    assert.equal(verified.ok, true);
    assert.equal(verified.token.orgId, ORG_A);
    assert.deepEqual(verified.token.scopes, ["read:cases", "write:cases"]);
    assert.deepEqual(await repo.verify("sutra_pat_" + "0".repeat(64), now), { ok: false, reason: "unknown" });
    assert.deepEqual(await repo.verify("not-a-token", now), { ok: false, reason: "malformed" });
    // Expired token.
    assert.deepEqual((await repo.verify(minted.token, Date.parse("2026-08-02T00:00:00Z"))).ok, false);
    // Rate limit: the request that crosses the cap is rejected.
    let limited = false;
    for (let i = 0; i < PUBLIC_API_RATE_LIMIT_PER_MINUTE + 1; i += 1) {
      const attempt = await repo.verify(minted.token, now + 1_000);
      if (!attempt.ok) { assert.equal(attempt.reason, "rate-limited"); limited = true; break; }
    }
    assert.equal(limited, true);
    // Revocation is immediate.
    const revoked = await repo.revoke(SCOPE_A, minted.id, now);
    assert.equal(revoked, true);
    assert.deepEqual((await repo.verify(minted.token, now)).ok, false);
  });
});

test("list and revoke are scoped to the customer, not just the org (cross-customer containment)", async () => {
  await withDatabase(async (repo) => {
    // Two customers in the SAME org. A token minted for customer A must never
    // be visible to — or revocable by — a caller scoped to customer A2.
    const minted = await repo.mint(SCOPE_A, "cust-a-token", ["read:resources"], null, "user_a");

    // Scope A2 (same org, different customer) sees nothing.
    assert.deepEqual(await repo.list(SCOPE_A2), []);
    // Scope A sees exactly its own token.
    const listedA = await repo.list(SCOPE_A);
    assert.equal(listedA.length, 1);
    assert.equal(listedA[0].id, minted.id);

    // Scope A2 cannot revoke customer A's token (no row matches its customer).
    assert.equal(await repo.revoke(SCOPE_A2, minted.id), false);
    // And the token is still active for its real owner.
    assert.equal((await repo.verify(minted.token)).ok, true);

    // Scope A (the true owner) can revoke it.
    assert.equal(await repo.revoke(SCOPE_A, minted.id), true);
    assert.equal((await repo.verify(minted.token)).ok, false);
  });
});

test("idempotency keys replay the stored response and conflict on a different request", async () => {
  await withDatabase(async (repo) => {
    const minted = await repo.mint(SCOPE_A, "writer", ["write:cases"], null, "user_a");
    const verified = await repo.verify(minted.token);
    assert.equal(verified.ok, true);
    const token = verified.token;
    const requestHash = "a".repeat(64);
    assert.equal(await repo.findIdempotentReplay(token, "key-1", requestHash), null);
    await repo.storeIdempotentResponse(token, "key-1", requestHash, 200, '{"ok":true}');
    const replay = await repo.findIdempotentReplay(token, "key-1", requestHash);
    assert.deepEqual(replay, { status: 200, body: '{"ok":true}' });
    // Same key, different request body → conflict, never silent re-execution.
    assert.equal(await repo.findIdempotentReplay(token, "key-1", "b".repeat(64)), "conflict");
  });
});
