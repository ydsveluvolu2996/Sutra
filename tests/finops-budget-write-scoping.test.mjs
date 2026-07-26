// Cross-tenant regression guard for the FinOps budget WRITE path.
// tests/finops-budget-scoping.test.mjs covers the read/delete side and
// deliberately uses distinct budget names so the writes cannot collide. This
// file measures the collision itself: finops_budgets is customer-scoped
// (customer_id NOT NULL), so two customers in one org must be able to hold a
// budget with the SAME name. With the old (org_id, name) upsert conflict target
// customer B's save UPDATEd customer A's row instead of inserting its own.
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { FinopsWorkspaceRepository } = await import("../db/finops-workspace-repository.ts");

const ORG = "org_msp_write";
const CUSTOMER_A = "cust_msp_write_a";
const CUSTOMER_B = "cust_msp_write_b";
const SCOPE_A = { orgId: ORG, customerId: CUSTOMER_A };
const SCOPE_B = { orgId: ORG, customerId: CUSTOMER_B };
const SHARED_NAME = "prod";

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-fin-write-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    // ONE org, TWO active customers — the multi-customer MSP shape.
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'msp-write', 'MSP Write', 'active')").bind(ORG),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'msp-write-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'msp-write-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG),
    ]);
    await run(new FinopsWorkspaceRepository(database), database);
  } finally {
    await miniflare.dispose();
  }
}

test("the unique scope on finops_budgets is per (org, customer, name)", async () => {
  await withDatabase(async (_repo, database) => {
    const indexes = await database.prepare("PRAGMA index_list(\"finops_budgets\")").all();
    const names = (indexes.results ?? []).map((row) => row.name);
    assert.ok(names.includes("finops_budgets_scope_name"), `expected finops_budgets_scope_name, saw ${names.join(", ")}`);
    assert.ok(!names.includes("finops_budgets_name"), "the over-strict (org_id, name) index must be dropped");
  });
});

test("two customers in one org can hold same-named budgets without clobbering each other", async () => {
  await withDatabase(async (repo, database) => {
    const budgetA = await repo.saveBudget(
      SCOPE_A,
      { name: SHARED_NAME, currency: "USD", limitMicros: "1000000", filter: { dimension: "service", value: "AmazonEC2" } },
      "user_a",
    );
    const budgetB = await repo.saveBudget(
      SCOPE_B,
      { name: SHARED_NAME, currency: "EUR", limitMicros: "2000000" },
      "user_b",
    );

    // B's save must have INSERTed a second row, not UPDATEd A's.
    const total = await database.prepare("SELECT COUNT(*) AS total FROM finops_budgets WHERE org_id = ?").bind(ORG).first();
    assert.equal(Number(total.total), 2);
    assert.notEqual(budgetA.id, budgetB.id);

    // A's row is untouched: original limit, original currency, original filter.
    const listedForA = await repo.listBudgets(SCOPE_A);
    assert.equal(listedForA.length, 1);
    assert.equal(listedForA[0].id, budgetA.id);
    assert.equal(listedForA[0].name, SHARED_NAME);
    assert.equal(listedForA[0].limitMicros, "1000000");
    assert.equal(listedForA[0].currency, "USD");
    assert.deepEqual(listedForA[0].filter, { dimension: "service", tagKey: undefined, value: "AmazonEC2" });
    assert.equal(listedForA[0].createdBy, "user_a");

    // B's own row is reachable — the id it was handed really landed in the table.
    const listedForB = await repo.listBudgets(SCOPE_B);
    assert.equal(listedForB.length, 1);
    assert.equal(listedForB[0].id, budgetB.id);
    assert.equal(listedForB[0].limitMicros, "2000000");
    assert.equal(listedForB[0].currency, "EUR");
    assert.equal(listedForB[0].createdBy, "user_b");
  });
});

test("same-customer re-save still upserts in place", async () => {
  await withDatabase(async (repo, database) => {
    const budgetA = await repo.saveBudget(
      SCOPE_A,
      { name: SHARED_NAME, currency: "USD", limitMicros: "1000000" },
      "user_a",
    );
    await repo.saveBudget(SCOPE_B, { name: SHARED_NAME, currency: "EUR", limitMicros: "2000000" }, "user_b");

    await repo.saveBudget(SCOPE_A, { name: SHARED_NAME, currency: "USD", limitMicros: "3000000" }, "user_a");

    // Still exactly one row for A, and it is the same row (id preserved).
    const totalForA = await database
      .prepare("SELECT COUNT(*) AS total FROM finops_budgets WHERE org_id = ? AND customer_id = ?")
      .bind(ORG, CUSTOMER_A)
      .first();
    assert.equal(Number(totalForA.total), 1);

    const listedForA = await repo.listBudgets(SCOPE_A);
    assert.equal(listedForA.length, 1);
    assert.equal(listedForA[0].id, budgetA.id);
    assert.equal(listedForA[0].limitMicros, "3000000");

    // B is unaffected by A's update.
    const listedForB = await repo.listBudgets(SCOPE_B);
    assert.equal(listedForB.length, 1);
    assert.equal(listedForB[0].limitMicros, "2000000");
  });
});

test("saveBudget still rejects a customer that does not belong to the org", async () => {
  await withDatabase(async (repo) => {
    await assert.rejects(
      repo.saveBudget({ orgId: ORG, customerId: "cust_not_here" }, { name: "other", currency: "USD", limitMicros: "1" }, "user_a"),
      (error) => error.code === "SCOPE_NOT_FOUND",
    );
  });
});
