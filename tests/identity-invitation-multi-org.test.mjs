import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const auth = await import("../db/auth-repository.ts");
const invitations = await import("../db/identity-invitation-repository.ts");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const policy = await import("../lib/auth-policy.ts");

const root = resolve(import.meta.dirname, "..");
const signupRateLimitSchema = (await readFile(resolve(root, "drizzle/0048_hosted_signup_rate_limits.sql"), "utf8"))
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);
const BASE = Date.now();
const ISSUER = "https://accounts.google.com";
const HOUR = 60 * 60 * 1000;

function identity(subject, email, now = BASE) {
  return {
    issuer: ISSUER,
    subject,
    email,
    displayName: email.split("@")[0],
    authenticatedAt: now,
    expiresAt: now + HOUR,
  };
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-invite-multi-org-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    for (const statement of signupRateLimitSchema) await database.prepare(statement).run();
    await run(database);
  } finally {
    await miniflare.dispose();
  }
}

async function hostedOwner(subject, email, sourceKey, now) {
  return auth.provisionSelfServeHostedOrg(identity(subject, email, now), {
    sourceKey,
    now,
  });
}

async function createInvite(owner, email, now, overrides = {}) {
  return invitations.createIdentityInvitation(
    owner.session,
    policy.resolveMembershipManagementScope(owner.session.subject),
    {
      email,
      role: overrides.role ?? "analyst",
      scopeMode: "all_customers",
      lifetimeMs: 2 * HOUR,
      allowedIssuer: ISSUER,
    },
    now,
  );
}

test("an exact federated identity joins a second organization without duplicating the user", async () => {
  await withDatabase(async (database) => {
    const memberIdentity = identity("member-subject", "member@example.com", BASE);
    const home = await hostedOwner("member-subject", "member@example.com", "member-source", BASE);
    const targetOwner = await hostedOwner("target-owner", "owner@target.example", "target-source", BASE + 1);
    const targetOrgId = targetOwner.session.subject.orgId;
    const created = await createInvite(targetOwner, memberIdentity.email, BASE + 10);

    const accepted = await invitations.acceptIdentityInvitation(
      { ...memberIdentity, authenticatedAt: BASE + 20, expiresAt: BASE + HOUR },
      created.token,
      BASE + 20,
    );
    assert.equal(accepted.session.subject.userId, home.session.subject.userId);
    assert.equal(accepted.session.subject.orgId, targetOrgId, "the invite acceptance session lands in the invited org");
    assert.equal(accepted.session.subject.role, "analyst");

    const users = await database.prepare(
      `SELECT COUNT(*) AS total FROM users WHERE issuer = ? AND subject = ?`,
    ).bind(ISSUER, memberIdentity.subject).first();
    assert.equal(Number(users.total), 1, "one global identity row is reused");
    const memberships = await database.prepare(
      `SELECT org_id, role FROM memberships WHERE user_id = ? ORDER BY org_id`,
    ).bind(home.session.subject.userId).all();
    assert.equal(memberships.results.length, 2);
    assert.ok(memberships.results.some((membership) => membership.org_id === home.session.subject.orgId));
    assert.ok(memberships.results.some(
      (membership) => membership.org_id === targetOrgId && membership.role === "analyst",
    ));

    assert.equal(
      policy.authorize(accepted.session.subject, {
        orgId: home.session.subject.orgId,
        capability: "connection:read",
      }).allowed,
      false,
      "the invited-org session cannot read the older organization",
    );
    assert.equal(
      policy.authorize(accepted.session.subject, {
        orgId: targetOrgId,
        capability: "connection:read",
      }).allowed,
      true,
    );

    await assert.rejects(
      invitations.acceptIdentityInvitation(memberIdentity, created.token, BASE + 30),
      (error) => error?.code === "AUTHENTICATION_REQUIRED",
      "the invitation token remains single use",
    );

    const repeated = await createInvite(targetOwner, memberIdentity.email, BASE + 40, { role: "viewer" });
    await assert.rejects(
      invitations.acceptIdentityInvitation(memberIdentity, repeated.token, BASE + 50),
      (error) => error?.code === "IDENTITY_NOT_PROVISIONED" && error?.status === 409,
      "an invitation cannot mutate or escalate an existing target-org membership",
    );
    const repeatedState = await database.prepare(
      "SELECT accepted_at FROM identity_invitations WHERE id = ?",
    ).bind(repeated.invitation.id).first();
    assert.equal(repeatedState.accepted_at, null, "a refused duplicate membership does not consume the token");
  });
});

test("subject/email drift is refused without consuming either invitation", async () => {
  await withDatabase(async (database) => {
    await hostedOwner("stable-subject", "stable@example.com", "stable-source", BASE);
    const targetOwner = await hostedOwner("drift-owner", "owner@drift.example", "drift-source", BASE + 1);

    const changedEmail = await createInvite(targetOwner, "changed@example.com", BASE + 10);
    await assert.rejects(
      invitations.acceptIdentityInvitation(
        identity("stable-subject", "changed@example.com", BASE + 20),
        changedEmail.token,
        BASE + 20,
      ),
      (error) => error?.code === "IDENTITY_NOT_PROVISIONED" && error?.status === 409,
    );

    const changedSubject = await createInvite(targetOwner, "stable@example.com", BASE + 30);
    await assert.rejects(
      invitations.acceptIdentityInvitation(
        identity("different-subject", "stable@example.com", BASE + 40),
        changedSubject.token,
        BASE + 40,
      ),
      (error) => error?.code === "IDENTITY_NOT_PROVISIONED" && error?.status === 409,
    );

    const states = await database.prepare(
      `SELECT accepted_at FROM identity_invitations WHERE id IN (?, ?) ORDER BY id`,
    ).bind(changedEmail.invitation.id, changedSubject.invitation.id).all();
    assert.deepEqual(states.results, [{ accepted_at: null }, { accepted_at: null }]);
  });
});

test("a suspended organization cannot consume a federated invitation", async () => {
  await withDatabase(async (database) => {
    const targetOwner = await hostedOwner("suspended-owner", "owner@suspended.example", "suspended-source", BASE);
    const targetOrgId = targetOwner.session.subject.orgId;
    const created = await createInvite(targetOwner, "new-member@example.com", BASE + 10);
    await database.prepare("UPDATE organizations SET status = 'suspended' WHERE id = ?").bind(targetOrgId).run();

    await assert.rejects(
      invitations.acceptIdentityInvitation(
        identity("new-member", "new-member@example.com", BASE + 20),
        created.token,
        BASE + 20,
      ),
      (error) => error?.code === "AUTHENTICATION_REQUIRED",
    );
    const pending = await database.prepare(
      "SELECT accepted_at FROM identity_invitations WHERE id = ?",
    ).bind(created.invitation.id).first();
    assert.equal(pending.accepted_at, null);
    assert.equal(
      await database.prepare("SELECT id FROM users WHERE email = 'new-member@example.com'").first(),
      null,
    );

    await database.prepare("UPDATE organizations SET status = 'active' WHERE id = ?").bind(targetOrgId).run();
    const accepted = await invitations.acceptIdentityInvitation(
      identity("new-member", "new-member@example.com", BASE + 30),
      created.token,
      BASE + 30,
    );
    assert.equal(accepted.session.subject.orgId, targetOrgId);
  });
});

test("a suspended organization cannot consume a password invitation", async () => {
  await withDatabase(async (database) => {
    const owner = await auth.bootstrapLocalAdmin({
      email: "password-owner@example.com",
      password: "Password invitation active org passphrase 2026!",
      displayName: "Password Owner",
      organizationName: "Password Organization",
    }, BASE);
    const created = await invitations.createIdentityInvitation(
      owner.session,
      policy.resolveMembershipManagementScope(owner.session.subject),
      {
        email: "password-member@example.com",
        role: "viewer",
        scopeMode: "all_customers",
        lifetimeMs: 2 * HOUR,
      },
      BASE + 10,
    );
    await database.prepare("UPDATE organizations SET status = 'suspended' WHERE id = ?")
      .bind(owner.session.subject.orgId)
      .run();

    await assert.rejects(
      invitations.acceptPasswordInvitation(
        created.token,
        {
          password: "Password invitation member passphrase 2026!",
          displayName: "Password Member",
        },
        BASE + 20,
      ),
      (error) => error?.code === "AUTHENTICATION_REQUIRED",
    );
    const pending = await database.prepare(
      "SELECT accepted_at FROM identity_invitations WHERE id = ?",
    ).bind(created.invitation.id).first();
    assert.equal(pending.accepted_at, null);
    assert.equal(
      await database.prepare("SELECT id FROM users WHERE email = 'password-member@example.com'").first(),
      null,
    );

    await database.prepare("UPDATE organizations SET status = 'active' WHERE id = ?")
      .bind(owner.session.subject.orgId)
      .run();
    const accepted = await invitations.acceptPasswordInvitation(
      created.token,
      {
        password: "Password invitation member passphrase 2026!",
        displayName: "Password Member",
      },
      BASE + 30,
    );
    assert.equal(accepted.session.subject.orgId, owner.session.subject.orgId);
  });
});
