import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const auth = await import("../db/auth-repository.ts");
const assignments = await import("../db/customer-assignment-repository.ts");
const invitations = await import("../db/identity-invitation-repository.ts");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const policy = await import("../lib/auth-policy.ts");

const HOUR_MS = 60 * 60 * 1000;

// The customer_admin actor administers ONLY cust_scope_alpha (via a
// customer_access grant of role customer_admin). Everything the repository
// enforces must key off exactly that administered-customer set.
function customerAdminActor(orgId) {
  return {
    subject: {
      userId: "usr_scope_cadmin",
      orgId,
      membershipId: "mem_scope_cadmin",
      role: "customer_admin",
      scopeMode: "assigned_customers",
      grants: [{ customerId: "cust_scope_alpha", role: "customer_admin" }],
    },
  };
}

async function withScopeDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-customer-scope-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    const bootstrap = await auth.bootstrapLocalAdmin({
      email: "scope-owner@sutra.invalid",
      password: "Customer scope repository passphrase 2026!",
      displayName: "Scope Owner",
      organizationName: "Scope Test",
    }, 1000);
    const orgId = bootstrap.session.subject.orgId;
    await database.batch([
      // Two customers in the actor's org: alpha (administered) and beta (not).
      database.prepare(
        `INSERT INTO customers (id, org_id, slug, name, status)
         VALUES ('cust_scope_alpha', ?, 'scope-alpha', 'Scope Alpha', 'active')`,
      ).bind(orgId),
      database.prepare(
        `INSERT INTO customers (id, org_id, slug, name, status)
         VALUES ('cust_scope_beta', ?, 'scope-beta', 'Scope Beta', 'active')`,
      ).bind(orgId),
      // The acting customer administrator, holding customer_admin on alpha only.
      database.prepare(
        `INSERT INTO users (id, issuer, subject, email, display_name, status)
         VALUES ('usr_scope_cadmin', 'test', 'scope-cadmin', 'cadmin@sutra.invalid', 'Scope Admin', 'active')`,
      ),
      database.prepare(
        `INSERT INTO memberships (id, org_id, user_id, role, scope_mode, status)
         VALUES ('mem_scope_cadmin', ?, 'usr_scope_cadmin', 'customer_admin', 'assigned_customers', 'active')`,
      ).bind(orgId),
      database.prepare(
        `INSERT INTO customer_access (id, org_id, customer_id, membership_id, role)
         VALUES ('acc_scope_cadmin', ?, 'cust_scope_alpha', 'mem_scope_cadmin', 'customer_admin')`,
      ).bind(orgId),
      // A customer-level teammate with no grants yet (assignment target).
      database.prepare(
        `INSERT INTO users (id, issuer, subject, email, display_name, status)
         VALUES ('usr_scope_team', 'test', 'scope-team', 'team@sutra.invalid', 'Scope Teammate', 'active')`,
      ),
      database.prepare(
        `INSERT INTO memberships (id, org_id, user_id, role, scope_mode, status)
         VALUES ('mem_scope_team', ?, 'usr_scope_team', 'customer_viewer', 'assigned_customers', 'active')`,
      ).bind(orgId),
      // A member who only has access to beta — must stay invisible to the admin.
      database.prepare(
        `INSERT INTO users (id, issuer, subject, email, display_name, status)
         VALUES ('usr_scope_bonly', 'test', 'scope-bonly', 'bonly@sutra.invalid', 'Beta Only', 'active')`,
      ),
      database.prepare(
        `INSERT INTO memberships (id, org_id, user_id, role, scope_mode, status)
         VALUES ('mem_scope_bonly', ?, 'usr_scope_bonly', 'customer_viewer', 'assigned_customers', 'active')`,
      ).bind(orgId),
      database.prepare(
        `INSERT INTO customer_access (id, org_id, customer_id, membership_id, role)
         VALUES ('acc_scope_bonly', ?, 'cust_scope_beta', 'mem_scope_bonly', 'customer_viewer')`,
      ).bind(orgId),
      // An analyst (organization role) the admin must never be able to touch.
      database.prepare(
        `INSERT INTO users (id, issuer, subject, email, display_name, status)
         VALUES ('usr_scope_analyst', 'test', 'scope-analyst', 'analyst@sutra.invalid', 'Scope Analyst', 'active')`,
      ),
      database.prepare(
        `INSERT INTO memberships (id, org_id, user_id, role, scope_mode, status)
         VALUES ('mem_scope_analyst', ?, 'usr_scope_analyst', 'analyst', 'assigned_customers', 'active')`,
      ).bind(orgId),
      // A separate organization + customer for cross-org attempts.
      database.prepare(
        `INSERT INTO organizations (id, slug, name, status)
         VALUES ('org_scope_foreign', 'scope-foreign', 'Foreign Org', 'active')`,
      ),
      database.prepare(
        `INSERT INTO customers (id, org_id, slug, name, status)
         VALUES ('cust_scope_foreign', 'org_scope_foreign', 'scope-foreign-customer', 'Foreign Customer', 'active')`,
      ),
      database.prepare(
        `INSERT INTO memberships (id, org_id, user_id, role, scope_mode, status)
         VALUES ('mem_scope_foreign', 'org_scope_foreign', 'usr_scope_team', 'customer_viewer', 'assigned_customers', 'active')`,
      ),
    ]);
    const actor = customerAdminActor(orgId);
    const scope = policy.resolveMembershipManagementScope(actor.subject);
    await run({ database, orgId, actor, scope, owner: bootstrap.session });
  } finally {
    await miniflare.dispose();
  }
}

// --- policy layer --------------------------------------------------------

test("a customer_admin holds only the customer-scoped management capability", () => {
  const actor = customerAdminActor("org_scope");
  const capabilities = new Set(policy.effectiveCapabilities(actor.subject));
  assert.equal(capabilities.has("membership:manage:customer"), true);
  assert.equal(capabilities.has("membership:manage"), false);
  assert.equal(capabilities.has("customer:create"), false);
  const resolved = policy.resolveMembershipManagementScope(actor.subject);
  assert.deepEqual(resolved, { mode: "customer", customerIds: ["cust_scope_alpha"] });
});

test("org operators keep org-wide membership management", () => {
  const owner = {
    userId: "u",
    orgId: "o",
    membershipId: "m",
    role: "org_owner",
    scopeMode: "all_customers",
    grants: [],
  };
  assert.deepEqual(policy.resolveMembershipManagementScope(owner), { mode: "org" });
  const analyst = { ...owner, role: "analyst" };
  assert.equal(policy.resolveMembershipManagementScope(analyst), null);
});

// --- invitations ---------------------------------------------------------

test("POSITIVE: a customer_admin invites a customer_viewer into an administered customer", async () => {
  await withScopeDatabase(async ({ database, orgId, actor, scope }) => {
    const created = await invitations.createIdentityInvitation(actor, scope, {
      email: "new-client@sutra.invalid",
      role: "customer_viewer",
      scopeMode: "assigned_customers",
      lifetimeMs: 24 * HOUR_MS,
      customerId: "cust_scope_alpha",
    }, 2000);
    assert.equal(created.invitation.customerId, "cust_scope_alpha");
    assert.equal(created.invitation.role, "customer_viewer");
    const row = await database.prepare(
      `SELECT role, scope_mode, customer_id FROM identity_invitations WHERE org_id = ? AND email = 'new-client@sutra.invalid'`,
    ).bind(orgId).first();
    assert.deepEqual(row, { role: "customer_viewer", scope_mode: "assigned_customers", customer_id: "cust_scope_alpha" });
  });
});

test("acceptance materializes exactly the invited customer_access grant", async () => {
  await withScopeDatabase(async ({ database, orgId, actor, scope }) => {
    const created = await invitations.createIdentityInvitation(actor, scope, {
      email: "accepting-client@sutra.invalid",
      role: "customer_viewer",
      scopeMode: "assigned_customers",
      lifetimeMs: 24 * HOUR_MS,
      customerId: "cust_scope_alpha",
    }, 3000);
    await invitations.acceptIdentityInvitation({
      issuer: "https://issuer.sutra.invalid",
      subject: "accepting-subject",
      email: "accepting-client@sutra.invalid",
      displayName: "Accepting Client",
      authenticatedAt: 4000,
      expiresAt: 4000 + HOUR_MS,
    }, created.token, 4000);
    const grant = await database.prepare(
      `SELECT ca.customer_id, ca.role, m.role AS membership_role
         FROM customer_access ca
         JOIN memberships m ON m.id = ca.membership_id
         JOIN users u ON u.id = m.user_id
        WHERE ca.org_id = ? AND u.email = 'accepting-client@sutra.invalid'`,
    ).bind(orgId).first();
    assert.deepEqual(grant, {
      customer_id: "cust_scope_alpha",
      role: "customer_viewer",
      membership_role: "customer_viewer",
    });
  });
});

test("NEGATIVE: a customer_admin cannot invite into a customer it does not administer", async () => {
  await withScopeDatabase(async ({ database, orgId, actor, scope }) => {
    await assert.rejects(
      invitations.createIdentityInvitation(actor, scope, {
        email: "beta-client@sutra.invalid",
        role: "customer_viewer",
        scopeMode: "assigned_customers",
        lifetimeMs: 24 * HOUR_MS,
        customerId: "cust_scope_beta",
      }),
      (error) => error?.code === "AUTHORIZATION_DENIED",
    );
    const count = await database.prepare(
      `SELECT COUNT(*) AS count FROM identity_invitations WHERE org_id = ?`,
    ).bind(orgId).first();
    assert.equal(count?.count, 0);
  });
});

test("NEGATIVE: a customer_admin cannot mint an organization role or an all-customers invite", async () => {
  await withScopeDatabase(async ({ actor, scope }) => {
    await assert.rejects(
      invitations.createIdentityInvitation(actor, scope, {
        email: "escalate@sutra.invalid",
        role: "org_admin",
        scopeMode: "assigned_customers",
        lifetimeMs: 24 * HOUR_MS,
        customerId: "cust_scope_alpha",
      }),
      (error) => error?.code === "INVALID_INPUT" || error?.code === "AUTHORIZATION_DENIED",
    );
    await assert.rejects(
      invitations.createIdentityInvitation(actor, scope, {
        email: "escalate2@sutra.invalid",
        role: "analyst",
        scopeMode: "assigned_customers",
        lifetimeMs: 24 * HOUR_MS,
        customerId: "cust_scope_alpha",
      }),
      (error) => error?.code === "AUTHORIZATION_DENIED",
    );
    await assert.rejects(
      invitations.createIdentityInvitation(actor, scope, {
        email: "escalate3@sutra.invalid",
        role: "customer_viewer",
        scopeMode: "all_customers",
        lifetimeMs: 24 * HOUR_MS,
        customerId: "cust_scope_alpha",
      }),
      (error) => error?.code === "AUTHORIZATION_DENIED",
    );
  });
});

test("NEGATIVE: a cross-organization invitation target is rejected", async () => {
  await withScopeDatabase(async ({ actor, scope }) => {
    await assert.rejects(
      invitations.createIdentityInvitation(actor, scope, {
        email: "foreign@sutra.invalid",
        role: "customer_viewer",
        scopeMode: "assigned_customers",
        lifetimeMs: 24 * HOUR_MS,
        customerId: "cust_scope_foreign",
      }),
      (error) => error?.code === "AUTHORIZATION_DENIED",
    );
  });
});

test("a customer_admin only lists invitations bound to its administered customers", async () => {
  await withScopeDatabase(async ({ orgId, actor, scope, owner }) => {
    // An org owner invitation into beta must never appear in the admin's list.
    await invitations.createIdentityInvitation(owner, { mode: "org" }, {
      email: "beta-owner-invite@sutra.invalid",
      role: "customer_viewer",
      scopeMode: "assigned_customers",
      lifetimeMs: 24 * HOUR_MS,
      customerId: "cust_scope_beta",
    }, 2000);
    await invitations.createIdentityInvitation(actor, scope, {
      email: "alpha-invite@sutra.invalid",
      role: "customer_viewer",
      scopeMode: "assigned_customers",
      lifetimeMs: 24 * HOUR_MS,
      customerId: "cust_scope_alpha",
    }, 2100);
    const listed = await invitations.listIdentityInvitations(actor, scope, 3000);
    assert.deepEqual(listed.map((invitation) => invitation.email), ["alpha-invite@sutra.invalid"]);
    assert.equal(listed.every((invitation) => invitation.customerId === "cust_scope_alpha"), true);
    // The org owner still sees every invitation in the organization.
    assert.equal((await invitations.listIdentityInvitations(owner, { mode: "org" }, 3000)).length, 2);
  });
});

// --- customer assignments ------------------------------------------------

test("POSITIVE: a customer_admin assigns a teammate to an administered customer", async () => {
  await withScopeDatabase(async ({ database, orgId, actor, scope }) => {
    const updated = await assignments.replaceCustomerAssignments(actor, scope, {
      membershipId: "mem_scope_team",
      scopeMode: "assigned_customers",
      grants: [{ customerId: "cust_scope_alpha", role: "customer_viewer" }],
    }, 2000);
    assert.deepEqual(updated.grants, [{ customerId: "cust_scope_alpha", role: "customer_viewer" }]);
    const persisted = await database.prepare(
      `SELECT customer_id, role FROM customer_access
        WHERE org_id = ? AND membership_id = 'mem_scope_team' ORDER BY customer_id`,
    ).bind(orgId).all();
    assert.deepEqual(persisted.results, [{ customer_id: "cust_scope_alpha", role: "customer_viewer" }]);
  });
});

test("NEGATIVE: a customer_admin cannot assign into, or grant org roles on, a customer it does not administer", async () => {
  await withScopeDatabase(async ({ database, orgId, actor, scope }) => {
    await assert.rejects(
      assignments.replaceCustomerAssignments(actor, scope, {
        membershipId: "mem_scope_team",
        scopeMode: "assigned_customers",
        grants: [{ customerId: "cust_scope_beta", role: "customer_viewer" }],
      }),
      (error) => error?.code === "AUTHORIZATION_DENIED",
    );
    await assert.rejects(
      assignments.replaceCustomerAssignments(actor, scope, {
        membershipId: "mem_scope_team",
        scopeMode: "assigned_customers",
        grants: [{ customerId: "cust_scope_alpha", role: "analyst" }],
      }),
      (error) => error?.code === "AUTHORIZATION_DENIED",
    );
    await assert.rejects(
      assignments.replaceCustomerAssignments(actor, scope, {
        membershipId: "mem_scope_team",
        scopeMode: "all_customers",
        grants: [],
      }),
      (error) => error?.code === "AUTHORIZATION_DENIED",
    );
    const count = await database.prepare(
      `SELECT COUNT(*) AS count FROM customer_access WHERE org_id = ? AND membership_id = 'mem_scope_team'`,
    ).bind(orgId).first();
    assert.equal(count?.count, 0);
  });
});

test("NEGATIVE: a customer_admin cannot touch an organization-role membership", async () => {
  await withScopeDatabase(async ({ actor, scope }) => {
    await assert.rejects(
      assignments.replaceCustomerAssignments(actor, scope, {
        membershipId: "mem_scope_analyst",
        scopeMode: "assigned_customers",
        grants: [{ customerId: "cust_scope_alpha", role: "customer_viewer" }],
      }),
      (error) => error?.code === "AUTHORIZATION_DENIED",
    );
  });
});

test("NEGATIVE: a customer_admin never touches grants outside its administered set", async () => {
  await withScopeDatabase(async ({ database, orgId, actor, scope }) => {
    // mem_scope_bonly holds a beta grant. Even a well-formed alpha assignment
    // must leave the beta grant untouched, and beta must never be writable.
    await assignments.replaceCustomerAssignments(actor, scope, {
      membershipId: "mem_scope_bonly",
      scopeMode: "assigned_customers",
      grants: [{ customerId: "cust_scope_alpha", role: "customer_viewer" }],
    }, 2000);
    const persisted = await database.prepare(
      `SELECT customer_id, role FROM customer_access
        WHERE org_id = ? AND membership_id = 'mem_scope_bonly' ORDER BY customer_id`,
    ).bind(orgId).all();
    assert.deepEqual(persisted.results, [
      { customer_id: "cust_scope_alpha", role: "customer_viewer" },
      { customer_id: "cust_scope_beta", role: "customer_viewer" },
    ]);
  });
});

test("NEGATIVE: a customer_admin cannot read customers or members outside its administered set", async () => {
  await withScopeDatabase(async ({ actor, scope }) => {
    const directory = await assignments.listCustomerAssignments(actor, scope);
    assert.deepEqual(directory.customers.map((customer) => customer.id), ["cust_scope_alpha"]);
    const emails = directory.members.map((member) => member.email);
    assert.equal(emails.includes("bonly@sutra.invalid"), false);
    assert.equal(emails.includes("analyst@sutra.invalid"), false);
    // Every visible member is bound to the administered customer only.
    for (const member of directory.members) {
      assert.equal(member.grants.every((grant) => grant.customerId === "cust_scope_alpha"), true);
    }
  });
});

test("NEGATIVE: a cross-organization membership target fails closed", async () => {
  await withScopeDatabase(async ({ actor, scope }) => {
    await assert.rejects(
      assignments.replaceCustomerAssignments(actor, scope, {
        membershipId: "mem_scope_foreign",
        scopeMode: "assigned_customers",
        grants: [{ customerId: "cust_scope_alpha", role: "customer_viewer" }],
      }),
      (error) => error?.code === "INVALID_INPUT",
    );
  });
});

test("the org owner assignment path is unchanged (all-customers still allowed)", async () => {
  await withScopeDatabase(async ({ database, orgId, owner }) => {
    const updated = await assignments.replaceCustomerAssignments(owner, { mode: "org" }, {
      membershipId: "mem_scope_team",
      scopeMode: "all_customers",
      grants: [],
    }, 2000);
    assert.equal(updated.scopeMode, "all_customers");
    const membership = await database.prepare(
      `SELECT scope_mode FROM memberships WHERE id = 'mem_scope_team' AND org_id = ?`,
    ).bind(orgId).first();
    assert.equal(membership?.scope_mode, "all_customers");
  });
});
