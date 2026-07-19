import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const auth = await import("../db/auth-repository.ts");
const assignments = await import("../db/customer-assignment-repository.ts");
const runtimeMigrations = await import("../db/runtime-migrations.ts");

const root = resolve(import.meta.dirname, "..");
const routeSource = await readFile(resolve(root, "app/api/v1/customer-assignments/route.ts"), "utf8");
const repositorySource = await readFile(resolve(root, "db/customer-assignment-repository.ts"), "utf8");

async function withAssignmentDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-customer-assignments-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    const bootstrap = await auth.bootstrapLocalAdmin({
      email: "assignment-owner@sutra.invalid",
      password: "Customer assignment repository passphrase 2026!",
      displayName: "Assignment Owner",
      organizationName: "Assignment Test",
    }, 1000);
    const orgId = bootstrap.session.subject.orgId;
    await database.batch([
      database.prepare(
        `INSERT INTO users (id, issuer, subject, email, display_name, status)
         VALUES ('usr_assignment_target', 'test', 'assignment-target',
                 'target@sutra.invalid', 'Target Analyst', 'active')`,
      ),
      database.prepare(
        `INSERT INTO memberships (id, org_id, user_id, role, scope_mode, status)
         VALUES ('mem_assignment_target', ?, 'usr_assignment_target',
                 'analyst', 'assigned_customers', 'active')`,
      ).bind(orgId),
      database.prepare(
        `INSERT INTO customers (id, org_id, slug, name, status)
         VALUES ('cust_assignment_alpha', ?, 'assignment-alpha', 'Assignment Alpha', 'active')`,
      ).bind(orgId),
      database.prepare(
        `INSERT INTO customers (id, org_id, slug, name, status)
         VALUES ('cust_assignment_beta', ?, 'assignment-beta', 'Assignment Beta', 'active')`,
      ).bind(orgId),
      database.prepare(
        `INSERT INTO organizations (id, slug, name, status)
         VALUES ('org_assignment_foreign', 'assignment-foreign', 'Foreign organization', 'active')`,
      ),
      database.prepare(
        `INSERT INTO customers (id, org_id, slug, name, status)
         VALUES ('cust_assignment_foreign', 'org_assignment_foreign',
                 'assignment-foreign-customer', 'Foreign Customer', 'active')`,
      ),
    ]);
    await run({ database, actor: bootstrap.session, orgId });
  } finally {
    await miniflare.dispose();
  }
}

test("customer assignment API requires centralized membership capability, same-origin mutation, and recent MFA", () => {
  assert.match(routeSource, /authorizePilotRequest\(request, "membership:manage"\)/u);
  assert.match(routeSource, /assertAuthMutation\(request\)/u);
  assert.match(routeSource, /requireRecentMfa\(actor\.authenticated\)/u);
  assert.match(routeSource, /readAuthJson\(request, 64 \* 1024\)/u);
});

test("repository scopes every assignment relation through organization keys and commits an audit guard", () => {
  assert.match(repositorySource, /WHERE m\.id = \? AND m\.org_id = \?/u);
  assert.match(repositorySource, /WHERE org_id = \? AND membership_id = \?/u);
  assert.match(repositorySource, /c\.org_id = m\.org_id/u);
  assert.match(repositorySource, /commitAuditedStatements\(\{/u);
  assert.match(repositorySource, /membership\.customer_scope\.replace/u);
  assert.match(repositorySource, /mutationGuard:/u);
});

test("owner can atomically replace explicit assignments and audit the resulting scope", async () => {
  await withAssignmentDatabase(async ({ database, actor, orgId }) => {
    const initial = await assignments.listCustomerAssignments(actor);
    assert.deepEqual(initial.customers.map((customer) => customer.id), [
      "cust_assignment_alpha",
      "cust_assignment_beta",
    ]);
    assert.equal(initial.members.find((member) => member.membershipId === "mem_assignment_target")?.editable, true);
    assert.equal(initial.members.some((member) => member.email === "target@sutra.invalid"), true);

    const updated = await assignments.replaceCustomerAssignments(actor, {
      membershipId: "mem_assignment_target",
      scopeMode: "assigned_customers",
      grants: [
        { customerId: "cust_assignment_alpha", role: "analyst" },
        { customerId: "cust_assignment_beta", role: "viewer" },
      ],
    }, 2000);
    assert.equal(updated.scopeMode, "assigned_customers");
    assert.deepEqual(updated.grants, [
      { customerId: "cust_assignment_alpha", role: "analyst" },
      { customerId: "cust_assignment_beta", role: "viewer" },
    ]);

    const persisted = await database.prepare(
      `SELECT customer_id, role FROM customer_access
        WHERE org_id = ? AND membership_id = 'mem_assignment_target'
        ORDER BY customer_id`,
    ).bind(orgId).all();
    assert.deepEqual(persisted.results, [
      { customer_id: "cust_assignment_alpha", role: "analyst" },
      { customer_id: "cust_assignment_beta", role: "viewer" },
    ]);
    const audit = await database.prepare(
      `SELECT action, actor_id, target_id, metadata_json
         FROM audit_events
        WHERE org_id = ? AND action = 'membership.customer_scope.replace'`,
    ).bind(orgId).first();
    assert.equal(audit?.actor_id, actor.subject.userId);
    assert.equal(audit?.target_id, "mem_assignment_target");
    assert.deepEqual(JSON.parse(audit?.metadata_json ?? "{}").newAssignments, [
      "cust_assignment_alpha:analyst",
      "cust_assignment_beta:viewer",
    ]);
  });
});

test("foreign customers and protected owner membership fail closed without changing assignments", async () => {
  await withAssignmentDatabase(async ({ database, actor, orgId }) => {
    await assert.rejects(
      assignments.replaceCustomerAssignments(actor, {
        membershipId: "mem_assignment_target",
        scopeMode: "assigned_customers",
        grants: [{ customerId: "cust_assignment_foreign", role: "viewer" }],
      }),
      (error) => error?.code === "INVALID_INPUT",
    );
    await assert.rejects(
      assignments.replaceCustomerAssignments(actor, {
        membershipId: actor.subject.membershipId,
        scopeMode: "assigned_customers",
        grants: [],
      }),
      (error) => error?.code === "AUTHORIZATION_DENIED",
    );
    const grants = await database.prepare(
      "SELECT COUNT(*) AS count FROM customer_access WHERE org_id = ?",
    ).bind(orgId).first();
    assert.equal(grants?.count, 0);
    const audits = await database.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE org_id = ? AND action = 'membership.customer_scope.replace'",
    ).bind(orgId).first();
    assert.equal(audits?.count, 0);
  });
});
