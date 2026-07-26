import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { FinopsWorkspaceRepository, FinopsWorkspaceRepositoryError } = await import("../db/finops-workspace-repository.ts");
const { buildAllocation, evaluateBudgets } = await import("../lib/finops-insights.ts");

const ORG_A = "org_fin_a";
const ORG_B = "org_fin_b";
const CUSTOMER_A = "cust_fin_a";
const CUSTOMER_B = "cust_fin_b";
const CONN_A = `conn_${"e".repeat(32)}`;
const SCOPE_A = { orgId: ORG_A, customerId: CUSTOMER_A };
const SCOPE_B = { orgId: ORG_B, customerId: CUSTOMER_B };

function line(overrides) {
  return {
    lineItemId: "li-1",
    usageAccountId: "111111111111",
    service: "AmazonEC2",
    chargeCategory: "Usage",
    usageStartIso: "2026-07-01T00:00:00.000Z",
    amountMicros: "10000000",
    currency: "USD",
    region: null,
    tags: { env: "prod" },
    ...overrides,
  };
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-fin-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'fin-a', 'Fin A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'fin-b', 'Fin B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'fin-cust-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'fin-cust-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
    ]);
    await run(new FinopsWorkspaceRepository(database));
  } finally {
    await miniflare.dispose();
  }
}

test("0028 migration applies; a re-upload replaces the billing period, never double-counts", async () => {
  await withDatabase(async (repo) => {
    const first = await repo.replacePeriod(SCOPE_A, CONN_A, "2026-07", [line({}), line({ lineItemId: "li-2", amountMicros: "5000000" })]);
    assert.deepEqual(first, { billingPeriod: "2026-07", inserted: 2, replaced: 0 });
    const second = await repo.replacePeriod(SCOPE_A, CONN_A, "2026-07", [line({ lineItemId: "li-3", amountMicros: "7000000", region: "ap-south-1" })]);
    assert.deepEqual(second, { billingPeriod: "2026-07", inserted: 1, replaced: 2 });
    const lines = await repo.linesForPeriod(SCOPE_A, CONN_A, "2026-07");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].amountMicros, "7000000");
    assert.deepEqual(lines[0].tags, { env: "prod" });
    assert.equal(lines[0].region, "ap-south-1"); // region persists through insert + select
    assert.deepEqual(await repo.listPeriods(SCOPE_A, CONN_A), [{ period: "2026-07", lineCount: 1 }]);
    // Cross-tenant reads see nothing; cross-tenant write is rejected loudly.
    assert.deepEqual(await repo.linesForPeriod(SCOPE_B, CONN_A, "2026-07"), []);
    await assert.rejects(
      repo.replacePeriod({ orgId: ORG_B, customerId: CUSTOMER_A }, CONN_A, "2026-07", [line({})]),
      (error) => error instanceof FinopsWorkspaceRepositoryError && error.code === "SCOPE_NOT_FOUND",
    );
    await assert.rejects(
      repo.replacePeriod(SCOPE_A, CONN_A, "July-2026", [line({})]),
      (error) => error instanceof FinopsWorkspaceRepositoryError && error.code === "INVALID_INPUT",
    );
  });
});

test("stored lines feed the allocation and budget engines end to end", async () => {
  await withDatabase(async (repo) => {
    await repo.replacePeriod(SCOPE_A, CONN_A, "2026-07", [
      line({}),
      line({ lineItemId: "li-2", service: "AmazonS3", amountMicros: "4000000", tags: {} }),
    ]);
    const lines = await repo.linesForPeriod(SCOPE_A, CONN_A, "2026-07");
    const allocation = buildAllocation(lines, "tag", "env");
    assert.equal(allocation[0].buckets[0].amountMicros, "10000000");
    assert.equal(allocation[0].unallocatedMicros, "4000000");
    await repo.saveBudget(SCOPE_A, { name: "monthly", currency: "USD", limitMicros: "20000000" }, "user_a");
    const budgets = await repo.listBudgets(SCOPE_A);
    const evaluations = evaluateBudgets(lines, budgets);
    assert.equal(evaluations[0].spentMicros, "14000000");
    assert.equal(evaluations[0].state, "under");
  });
});

test("budgets validate, upsert by name, and stay org-scoped", async () => {
  await withDatabase(async (repo) => {
    const saved = await repo.saveBudget(SCOPE_A, { name: "ec2", currency: "USD", limitMicros: "1000000", filter: { dimension: "service", value: "AmazonEC2" } }, "user_a");
    await repo.saveBudget(SCOPE_A, { name: "ec2", currency: "USD", limitMicros: "2000000", filter: { dimension: "service", value: "AmazonEC2" } }, "user_a");
    const budgets = await repo.listBudgets(SCOPE_A);
    assert.equal(budgets.length, 1);
    assert.equal(budgets[0].limitMicros, "2000000");
    assert.deepEqual(await repo.listBudgets(SCOPE_B), []);
    await assert.rejects(
      repo.saveBudget(SCOPE_A, { name: "bad", currency: "usd", limitMicros: "1" }, "user_a"),
      (error) => error instanceof FinopsWorkspaceRepositoryError && error.code === "INVALID_INPUT",
    );
    await assert.rejects(
      repo.saveBudget(SCOPE_A, { name: "neg", currency: "USD", limitMicros: "-5" }, "user_a"),
      (error) => error instanceof FinopsWorkspaceRepositoryError && error.code === "INVALID_INPUT",
    );
    await assert.rejects(
      repo.saveBudget(SCOPE_A, { name: "tagless", currency: "USD", limitMicros: "1", filter: { dimension: "tag", value: "prod" } }, "user_a"),
      (error) => error instanceof FinopsWorkspaceRepositoryError && error.code === "INVALID_INPUT",
    );
    assert.equal(await repo.deleteBudget(SCOPE_B, saved.id), false);
    assert.equal(await repo.deleteBudget(SCOPE_A, saved.id), true);
  });
});
