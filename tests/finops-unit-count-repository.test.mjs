import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { FinopsUnitCountRepository, FinopsUnitCountRepositoryError } = await import("../db/finops-unit-count-repository.ts");

const ORG_A = "org_uc_a";
const ORG_B = "org_uc_b";
const CUSTOMER_A = "cust_uc_a";
const CUSTOMER_B = "cust_uc_b";
const SCOPE_A = { orgId: ORG_A, customerId: CUSTOMER_A };
const SCOPE_B = { orgId: ORG_B, customerId: CUSTOMER_B };

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-uc-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'uc-a', 'UC A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'uc-b', 'UC B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'uc-cust-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'uc-cust-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
    ]);
    await run(new FinopsUnitCountRepository(database));
  } finally {
    await miniflare.dispose();
  }
}

test("0037 migration applies; upsert stores and a repeat REPLACES the count, never duplicates", async () => {
  await withDatabase(async (repo) => {
    const first = await repo.upsert(SCOPE_A, { period: "2026-07", unitLabel: "transactions", count: 100 }, 1000);
    assert.equal(first.customerId, CUSTOMER_A);
    assert.equal(first.count, 100);
    assert.equal(first.createdAt, new Date(1000).toISOString());

    // Same key -> update in place; original created_at preserved, updated_at moves.
    const second = await repo.upsert(SCOPE_A, { period: "2026-07", unitLabel: "transactions", count: 250 }, 5000);
    assert.equal(second.count, 250);
    assert.equal(second.createdAt, new Date(1000).toISOString());
    assert.equal(second.updatedAt, new Date(5000).toISOString());

    const rows = await repo.list(SCOPE_A, {});
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 250);
  });
});

test("counts are tenant-isolated: cross-tenant reads see nothing and cross-org writes are rejected", async () => {
  await withDatabase(async (repo) => {
    await repo.upsert(SCOPE_A, { period: "2026-07", unitLabel: "seats", count: 42 });
    assert.deepEqual(await repo.list(SCOPE_B, {}), []);
    // A customer that is not owned by the named org cannot be written.
    await assert.rejects(
      repo.upsert({ orgId: ORG_B, customerId: CUSTOMER_A }, { period: "2026-07", unitLabel: "seats", count: 1 }),
      (error) => error instanceof FinopsUnitCountRepositoryError && error.code === "SCOPE_NOT_FOUND",
    );
  });
});

test("list filters by period and orders deterministically", async () => {
  await withDatabase(async (repo) => {
    await repo.upsert(SCOPE_A, { period: "2026-07", unitLabel: "transactions", count: 10 });
    await repo.upsert(SCOPE_A, { period: "2026-07", unitLabel: "seats", count: 20 });
    await repo.upsert(SCOPE_A, { period: "2026-06", unitLabel: "transactions", count: 5 });

    const july = await repo.list(SCOPE_A, { period: "2026-07" });
    assert.deepEqual(july.map((row) => row.unitLabel), ["seats", "transactions"]);

    const all = await repo.list(SCOPE_A, {});
    // period DESC, then unit_label ASC.
    assert.deepEqual(all.map((row) => `${row.period}/${row.unitLabel}`), [
      "2026-07/seats",
      "2026-07/transactions",
      "2026-06/transactions",
    ]);
  });
});

test("validation rejects bad period, label charset, and out-of-range counts", async () => {
  await withDatabase(async (repo) => {
    const bad = [
      { period: "July-2026", unitLabel: "transactions", count: 1 },
      { period: "2026-13", unitLabel: "transactions", count: 1 },
      { period: "2026-07", unitLabel: "Transactions", count: 1 },
      { period: "2026-07", unitLabel: "trans actions", count: 1 },
      { period: "2026-07", unitLabel: "transactions", count: -1 },
      { period: "2026-07", unitLabel: "transactions", count: 1.5 },
      { period: "2026-07", unitLabel: "transactions", count: 1_000_000_000_001 },
    ];
    for (const input of bad) {
      await assert.rejects(
        repo.upsert(SCOPE_A, input),
        (error) => error instanceof FinopsUnitCountRepositoryError && error.code === "INVALID_INPUT",
        `expected ${JSON.stringify(input)} to be rejected`,
      );
    }
  });
});
