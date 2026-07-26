// Cross-tenant regression guard for FinOps budgets INSIDE a single org.
// tests/finops-workspace-repository.ts already covers two *different* orgs,
// which the old `WHERE org_id = ?` queries satisfied by accident. The MSP shape
// that actually broke is one org with several customers: listBudgets returned
// every customer's budgets, and deleteBudget accepted any id in the org.
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { FinopsWorkspaceRepository } = await import("../db/finops-workspace-repository.ts");

const ORG = "org_msp_shared";
const CUSTOMER_A = "cust_msp_a";
const CUSTOMER_B = "cust_msp_b";
const SCOPE_A = { orgId: ORG, customerId: CUSTOMER_A };
const SCOPE_B = { orgId: ORG, customerId: CUSTOMER_B };

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-fin-scope-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    // ONE org, TWO active customers — the multi-customer MSP shape.
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'msp-shared', 'MSP Shared', 'active')").bind(ORG),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'msp-cust-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'msp-cust-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG),
    ]);
    await run(new FinopsWorkspaceRepository(database), database);
  } finally {
    await miniflare.dispose();
  }
}

// Distinct names on purpose: the finops_budgets_name unique index is
// (org_id, name), so same-named budgets in one org would collide on write and
// mask what this test is actually measuring (the read/delete scoping).
async function seedBudgets(repo) {
  const budgetA = await repo.saveBudget(
    SCOPE_A,
    { name: "customer-a-prod", currency: "USD", limitMicros: "1000000", filter: { dimension: "service", value: "AmazonEC2" } },
    "user_a",
  );
  const budgetB = await repo.saveBudget(
    SCOPE_B,
    { name: "customer-b-prod", currency: "EUR", limitMicros: "2000000" },
    "user_b",
  );
  return { budgetA, budgetB };
}

test("listBudgets is customer-scoped within one org", async () => {
  await withDatabase(async (repo, database) => {
    const { budgetA, budgetB } = await seedBudgets(repo);

    // Both rows really exist under the same org_id — so an org-only query would
    // return two rows here, which is exactly the leak this asserts against.
    const total = await database.prepare("SELECT COUNT(*) AS total FROM finops_budgets WHERE org_id = ?").bind(ORG).first();
    assert.equal(Number(total.total), 2);

    const listedForA = await repo.listBudgets(SCOPE_A);
    assert.equal(listedForA.length, 1);
    assert.equal(listedForA[0].id, budgetA.id);
    assert.equal(listedForA[0].name, "customer-a-prod");
    assert.equal(listedForA[0].currency, "USD");
    assert.equal(listedForA[0].limitMicros, "1000000");
    // Return shape unchanged: filter still round-trips, metadata still present.
    assert.deepEqual(listedForA[0].filter, { dimension: "service", tagKey: undefined, value: "AmazonEC2" });
    assert.equal(listedForA[0].createdBy, "user_a");
    assert.equal(typeof listedForA[0].updatedAt, "string");

    const listedForB = await repo.listBudgets(SCOPE_B);
    assert.deepEqual(listedForB.map((budget) => budget.id), [budgetB.id]);
    assert.equal(listedForB[0].limitMicros, "2000000");
  });
});

test("deleteBudget cannot reach another customer's budget in the same org", async () => {
  await withDatabase(async (repo) => {
    const { budgetA } = await seedBudgets(repo);

    // Customer B tries to delete customer A's budget by id.
    assert.equal(await repo.deleteBudget(SCOPE_B, budgetA.id), false);
    const stillThere = await repo.listBudgets(SCOPE_A);
    assert.deepEqual(stillThere.map((budget) => budget.id), [budgetA.id]);

    // The rightful owner can still delete it.
    assert.equal(await repo.deleteBudget(SCOPE_A, budgetA.id), true);
    assert.deepEqual(await repo.listBudgets(SCOPE_A), []);
    // Customer B's own budget is untouched by A's delete.
    assert.equal((await repo.listBudgets(SCOPE_B)).length, 1);
  });
});
