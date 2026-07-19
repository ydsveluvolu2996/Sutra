import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { CaseRoutingRepository, CaseRoutingRepositoryError } = await import("../db/case-routing-repository.ts");

const ORG_A = "org_route_a";
const ORG_B = "org_route_b";
const CUSTOMER_A = "cust_route_a";
const CUSTOMER_B = "cust_route_b";
const SCOPE_A = { orgId: ORG_A, customerId: CUSTOMER_A };
const SCOPE_B = { orgId: ORG_B, customerId: CUSTOMER_B };

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-case-routing-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'route-a', 'Route A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'route-b', 'Route B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'route-cust-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'route-cust-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
    ]);
    await run(new CaseRoutingRepository(database));
  } finally {
    await miniflare.dispose();
  }
}

test("0024 migration applies; a rule is created, listed by priority, and severities round-trip", async () => {
  await withDatabase(async (repo) => {
    await repo.create(SCOPE_A, { priority: 20, matchSeverity: ["low"], routeTeam: "triage" });
    await repo.create(SCOPE_A, { priority: 5, matchSeverity: ["critical", "high"], routeAssignee: "alice" });
    const rules = await repo.list(SCOPE_A);
    assert.equal(rules.length, 2);
    assert.equal(rules[0].priority, 5, "ordered by priority ascending");
    assert.deepEqual(rules[0].matchSeverity, ["critical", "high"]);
    assert.equal(rules[0].routeAssignee, "alice");
  });
});

test("a rule with no route target is refused", async () => {
  await withDatabase(async (repo) => {
    await assert.rejects(
      () => repo.create(SCOPE_A, { priority: 1, matchSeverity: ["critical"] }),
      (error) => error instanceof CaseRoutingRepositoryError && error.code === "INVALID_INPUT",
    );
  });
});

test("a rule cannot be created for a customer outside the acting organization", async () => {
  await withDatabase(async (repo) => {
    await assert.rejects(
      () => repo.create({ orgId: ORG_A, customerId: CUSTOMER_B }, { priority: 1, routeAssignee: "x" }),
      (error) => error instanceof CaseRoutingRepositoryError && error.code === "SCOPE_NOT_FOUND",
    );
  });
});

test("list is tenant-isolated and remove is scoped to the tenant", async () => {
  await withDatabase(async (repo) => {
    const created = await repo.create(SCOPE_A, { priority: 1, routeAssignee: "alice" });
    assert.equal((await repo.list(SCOPE_B)).length, 0, "another tenant sees no rules");
    assert.equal(await repo.remove(SCOPE_B, created.id), false, "cross-tenant remove is a no-op");
    assert.equal((await repo.list(SCOPE_A)).length, 1, "the rule survives a cross-tenant remove");
    assert.equal(await repo.remove(SCOPE_A, created.id), true);
    assert.equal((await repo.list(SCOPE_A)).length, 0);
  });
});
