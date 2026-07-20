import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { SavedReportRepository, SavedReportRepositoryError } = await import("../db/saved-report-repository.ts");

const ORG_A = "org_sr_a";
const ORG_B = "org_sr_b";
const CUSTOMER_A = "cust_sr_a";
const CUSTOMER_B = "cust_sr_b";
const SCOPE_A = { orgId: ORG_A, customerId: CUSTOMER_A };
const SCOPE_B = { orgId: ORG_B, customerId: CUSTOMER_B };
const CREATED_BY = "user_sr_operator";

const CMDB_DEFINITION = {
  dataset: "cmdb-resources",
  filters: { combine: "and", predicates: [{ kind: "field", field: "service", op: "eq", value: "ec2" }] },
  columns: ["resourceKey", "service"],
  limit: 100,
};

const FINDINGS_DEFINITION = {
  dataset: "findings",
  filters: [{ field: "severity", op: "eq", value: "critical" }],
  columns: ["fingerprint", "title"],
};

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-sr-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'sr-a', 'SR A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'sr-b', 'SR B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'sr-cust-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'sr-cust-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
    ]);
    await run(new SavedReportRepository(database));
  } finally {
    await miniflare.dispose();
  }
}

test("0040 migration applies; save stores a view and re-saving by name REPLACES it, never duplicates", async () => {
  await withDatabase(async (repo) => {
    const first = await repo.save(SCOPE_A, "Prod EC2", CMDB_DEFINITION, CREATED_BY, 1000);
    assert.equal(first.name, "Prod EC2");
    assert.equal(first.dataset, "cmdb-resources");
    assert.equal(first.createdAt, new Date(1000).toISOString());
    assert.deepEqual(first.definition.columns, ["resourceKey", "service"]);

    // Same name -> update in place (dataset + definition switch), no duplicate row.
    const second = await repo.save(SCOPE_A, "Prod EC2", FINDINGS_DEFINITION, CREATED_BY, 5000);
    assert.equal(second.dataset, "findings");
    assert.equal(second.updatedAt, new Date(5000).toISOString());

    const rows = await repo.list(SCOPE_A);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dataset, "findings");
  });
});

test("get and delete are scoped to the owning tenant", async () => {
  await withDatabase(async (repo) => {
    const saved = await repo.save(SCOPE_A, "My view", CMDB_DEFINITION, CREATED_BY);
    assert.notEqual(await repo.get(SCOPE_A, saved.id), null);
    // Another tenant cannot read or delete it.
    assert.equal(await repo.get(SCOPE_B, saved.id), null);
    assert.equal(await repo.delete(SCOPE_B, saved.id), false);
    assert.equal((await repo.list(SCOPE_A)).length, 1);
    // The owner can delete it.
    assert.equal(await repo.delete(SCOPE_A, saved.id), true);
    assert.equal((await repo.list(SCOPE_A)).length, 0);
  });
});

test("views are tenant-isolated: cross-tenant reads see nothing and cross-org writes are rejected", async () => {
  await withDatabase(async (repo) => {
    await repo.save(SCOPE_A, "Only A", CMDB_DEFINITION, CREATED_BY);
    assert.deepEqual(await repo.list(SCOPE_B), []);
    // A customer that is not owned by the named org cannot be written.
    await assert.rejects(
      repo.save({ orgId: ORG_B, customerId: CUSTOMER_A }, "Sneaky", CMDB_DEFINITION, CREATED_BY),
      (error) => error instanceof SavedReportRepositoryError && error.code === "SCOPE_NOT_FOUND",
    );
  });
});

test("validation rejects a bad name and an invalid definition before any write", async () => {
  await withDatabase(async (repo) => {
    await assert.rejects(
      repo.save(SCOPE_A, "bad/name<>", CMDB_DEFINITION, CREATED_BY),
      (error) => error instanceof SavedReportRepositoryError && error.code === "INVALID_INPUT",
    );
    await assert.rejects(
      repo.save(SCOPE_A, "Good name", { dataset: "widgets" }, CREATED_BY),
      (error) => error instanceof SavedReportRepositoryError && error.code === "INVALID_INPUT",
    );
    await assert.rejects(
      repo.save(SCOPE_A, "Good name", { dataset: "cmdb-resources", filters: { combine: "and", predicates: [] }, columns: ["service"] }, CREATED_BY),
      (error) => error instanceof SavedReportRepositoryError && error.code === "INVALID_INPUT",
    );
    assert.deepEqual(await repo.list(SCOPE_A), []);
  });
});

test("get rejects a malformed id and returns null for an unknown one", async () => {
  await withDatabase(async (repo) => {
    await assert.rejects(
      repo.get(SCOPE_A, "not-an-id"),
      (error) => error instanceof SavedReportRepositoryError && error.code === "INVALID_INPUT",
    );
    assert.equal(await repo.get(SCOPE_A, `rpt_${"0".repeat(32)}`), null);
  });
});
