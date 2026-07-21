import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const auth = await import("../db/auth-repository.ts");
const invitations = await import("../db/identity-invitation-repository.ts");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const policy = await import("../lib/auth-policy.ts");

const HOUR_MS = 60 * 60 * 1000;
const STRONG_PASSWORD = "Client alpha workspace passphrase 2026!";

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-invite-accept-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    const bootstrap = await auth.bootstrapLocalAdmin(
      {
        email: "owner@sutra.invalid",
        password: "Master admin workspace passphrase 2026!",
        displayName: "Master Admin",
        organizationName: "Sutra MSP",
      },
      1000,
    );
    const orgId = bootstrap.session.subject.orgId;
    await database.batch([
      database.prepare(
        `INSERT INTO customers (id, org_id, slug, name, status)
         VALUES ('cust_alpha', ?, 'client-alpha', 'Client Alpha', 'active')`,
      ).bind(orgId),
      database.prepare(
        `INSERT INTO customers (id, org_id, slug, name, status)
         VALUES ('cust_beta', ?, 'client-beta', 'Client Beta', 'active')`,
      ).bind(orgId),
    ]);
    await run({ database, owner: bootstrap.session, orgId });
  } finally {
    await miniflare.dispose();
  }
}

// The master admin (org_owner) invites a client into a single customer, scoped.
async function inviteClientAdmin(owner, now, overrides = {}) {
  const scope = policy.resolveMembershipManagementScope(owner.subject);
  return invitations.createIdentityInvitation(
    owner,
    scope,
    {
      email: overrides.email ?? "client-alpha-admin@client.invalid",
      role: overrides.role ?? "customer_admin",
      scopeMode: overrides.scopeMode ?? "assigned_customers",
      lifetimeMs: overrides.lifetimeMs ?? 48 * HOUR_MS,
      customerId: overrides.customerId ?? "cust_alpha",
      ...(overrides.allowedIssuer ? { allowedIssuer: overrides.allowedIssuer } : {}),
    },
    now,
  );
}

test("a client accepts a password invitation and is provisioned scoped to exactly one customer", async () => {
  await withDatabase(async ({ database, owner, orgId }) => {
    const { token } = await inviteClientAdmin(owner, 2000);
    const accepted = await invitations.acceptPasswordInvitation(
      token,
      { password: STRONG_PASSWORD, displayName: "Alpha Admin" },
      3000,
    );

    // A session is issued but MFA is NOT yet confirmed.
    assert.equal(accepted.mfaEnrollmentRequired, true);
    assert.equal(accepted.session.session.mfa.enrolled, false);
    assert.equal(accepted.session.subject.orgId, orgId);
    assert.equal(accepted.session.subject.role, "customer_admin");
    assert.equal(accepted.session.subject.scopeMode, "assigned_customers");
    assert.deepEqual(
      accepted.session.subject.grants,
      [{ customerId: "cust_alpha", role: "customer_admin" }],
    );

    // A local password credential and a customer_access grant were written.
    const user = await database.prepare(
      `SELECT id, issuer, email FROM users WHERE issuer = 'sutra-local' AND email = 'client-alpha-admin@client.invalid'`,
    ).first();
    assert.ok(user, "the invited user row exists");
    const cred = await database.prepare(
      `SELECT user_id FROM local_password_credentials WHERE user_id = ?`,
    ).bind(user.id).first();
    assert.ok(cred, "a password credential was created");
    const grants = await database.prepare(
      `SELECT customer_id, role FROM customer_access WHERE membership_id = ?`,
    ).bind(accepted.session.subject.membershipId).all();
    assert.deepEqual(grants.results, [{ customer_id: "cust_alpha", role: "customer_admin" }]);
  });
});

test("the provisioned client can log in with the chosen password and is still MFA-gated", async () => {
  await withDatabase(async ({ owner }) => {
    const { token } = await inviteClientAdmin(owner, 2000);
    await invitations.acceptPasswordInvitation(token, { password: STRONG_PASSWORD, displayName: "Alpha Admin" }, 3000);

    const secrets = { encryptionKey: "A".repeat(43), keyVersion: "local-auth-v1" };
    const login = await auth.loginLocalUser(
      { email: "client-alpha-admin@client.invalid", password: STRONG_PASSWORD },
      secrets,
      4000,
    );
    assert.equal(login.mfaEnrollmentRequired, true, "the account still requires MFA enrollment");
    assert.equal(login.session.subject.role, "customer_admin");
  });
});

test("the client_admin is isolated to its own customer (cannot read another customer)", async () => {
  await withDatabase(async ({ owner }) => {
    const { token } = await inviteClientAdmin(owner, 2000);
    const accepted = await invitations.acceptPasswordInvitation(token, { password: STRONG_PASSWORD, displayName: "Alpha Admin" }, 3000);
    const subject = accepted.session.subject;

    const own = policy.authorize(subject, { orgId: subject.orgId, capability: "connection:read", customerId: "cust_alpha" });
    const other = policy.authorize(subject, { orgId: subject.orgId, capability: "connection:read", customerId: "cust_beta" });
    assert.equal(own.allowed, true, "can read its own customer");
    assert.equal(other.allowed, false, "must NOT read another customer");
  });
});

test("a token can be redeemed at most once", async () => {
  await withDatabase(async ({ owner }) => {
    const { token } = await inviteClientAdmin(owner, 2000);
    await invitations.acceptPasswordInvitation(token, { password: STRONG_PASSWORD, displayName: "Alpha Admin" }, 3000);
    await assert.rejects(
      invitations.acceptPasswordInvitation(token, { password: STRONG_PASSWORD + "x", displayName: "Impostor" }, 4000),
      /invalid, expired, or already used|already used or revoked/u,
    );
  });
});

test("an OIDC-issuer-pinned invitation cannot be redeemed with a password", async () => {
  await withDatabase(async ({ owner }) => {
    const { token } = await inviteClientAdmin(owner, 2000, {
      email: "pinned@client.invalid",
      allowedIssuer: "https://accounts.google.com",
    });
    await assert.rejects(
      invitations.acceptPasswordInvitation(token, { password: STRONG_PASSWORD, displayName: "Pinned User" }, 3000),
      /sign-in provider/u,
    );
  });
});

test("a weak password is rejected and no account is created", async () => {
  await withDatabase(async ({ database, owner }) => {
    const { token } = await inviteClientAdmin(owner, 2000);
    await assert.rejects(
      invitations.acceptPasswordInvitation(token, { password: "short", displayName: "Alpha Admin" }, 3000),
      /password/iu,
    );
    const user = await database.prepare(
      `SELECT id FROM users WHERE email = 'client-alpha-admin@client.invalid'`,
    ).first();
    assert.equal(user, null, "no user row was created for a rejected password");
  });
});

test("an expired invitation is refused", async () => {
  await withDatabase(async ({ owner }) => {
    const { token } = await inviteClientAdmin(owner, 2000, { lifetimeMs: HOUR_MS });
    await assert.rejects(
      invitations.acceptPasswordInvitation(token, { password: STRONG_PASSWORD, displayName: "Alpha Admin" }, 2000 + HOUR_MS + 1),
      /invalid, expired, or already used/u,
    );
  });
});

test("per-source login rate limit throttles a single origin and is per-source independent", async () => {
  await withDatabase(async () => {
    const opts = { windowMs: 5 * 60 * 1000, maxPerWindow: 3 };
    // Three attempts from one IP are allowed; the fourth is blocked.
    for (let i = 0; i < 3; i += 1) {
      await auth.consumeLoginAttemptBudget({ sourceKey: "203.0.113.7", now: 10_000, ...opts });
    }
    await assert.rejects(
      auth.consumeLoginAttemptBudget({ sourceKey: "203.0.113.7", now: 10_000, ...opts }),
      /too many sign-in attempts/iu,
    );
    // A different source has its own budget in the same window.
    await assert.doesNotReject(
      auth.consumeLoginAttemptBudget({ sourceKey: "198.51.100.9", now: 10_000, ...opts }),
    );
    // The original source recovers in the next window.
    await assert.doesNotReject(
      auth.consumeLoginAttemptBudget({ sourceKey: "203.0.113.7", now: 10_000 + 5 * 60 * 1000, ...opts }),
    );
  });
});

test("operator can unlock a locked member; non-operator cannot; cross-org is refused", async () => {
  await withDatabase(async ({ database, owner, orgId }) => {
    const { token } = await inviteClientAdmin(owner, 2000);
    const accepted = await invitations.acceptPasswordInvitation(token, { password: STRONG_PASSWORD, displayName: "Alpha Admin" }, 3000);
    const userId = accepted.session.subject.userId;

    // Force the account into a locked state.
    await database.prepare(
      `UPDATE local_password_credentials SET failed_attempts = 5, locked_until = ? WHERE user_id = ?`,
    ).bind(9_999_999_999_999, userId).run();

    // A customer-scoped admin (no org-wide membership:manage) is refused.
    const customerAdmin = {
      subject: {
        userId: "usr_x", orgId, membershipId: "mem_x",
        role: "customer_admin", scopeMode: "assigned_customers",
        grants: [{ customerId: "cust_alpha", role: "customer_admin" }],
      },
    };
    await assert.rejects(auth.unlockLocalUserAccount(customerAdmin, userId, 4000), /cannot unlock/iu);

    // A well-formed id that is not a member of this org -> 404.
    await assert.rejects(
      auth.unlockLocalUserAccount(owner, "user_" + "a".repeat(32), 4000),
      /No such local account/iu,
    );

    // The org owner unlocks the real member.
    const unlocked = await auth.unlockLocalUserAccount(owner, userId, 4000);
    assert.equal(unlocked, true);

    // The lockout is cleared and the member can log in again.
    const secrets = { encryptionKey: "A".repeat(43), keyVersion: "local-auth-v1" };
    const login = await auth.loginLocalUser(
      { email: "client-alpha-admin@client.invalid", password: STRONG_PASSWORD },
      secrets,
      5000,
    );
    assert.equal(login.session.subject.userId, userId);
  });
});
