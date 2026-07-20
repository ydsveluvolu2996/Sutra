import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { CmdbRelationshipRepository, CmdbRelationshipRepositoryError } = await import(
  "../db/cmdb-relationship-repository.ts"
);

const ORG_A = "org_rel_a";
const ORG_B = "org_rel_b";
const CUSTOMER_A = "cust_rel_a";
const CUSTOMER_B = "cust_rel_b";
const SCOPE_A = { orgId: ORG_A, customerId: CUSTOMER_A };
const SCOPE_B = { orgId: ORG_B, customerId: CUSTOMER_B };
const CREATED_BY = "user_rel_operator";

const FROM_KEY = "aws:111122223333:us-east-1:ec2:aws.ec2.instance:i-01a2b3c4";
const TO_KEY = "aws:111122223333:us-east-1:ec2:aws.ec2.volume:vol-01a2b3c4";
const OTHER_KEY = "aws:111122223333:us-east-1:s3:aws.s3.bucket:my-bucket";

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-rel-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'rel-a', 'Rel A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'rel-b', 'Rel B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'rel-cust-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'rel-cust-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
    ]);
    await run(new CmdbRelationshipRepository(database));
  } finally {
    await miniflare.dispose();
  }
}

test("0042 migration applies; add stores a manual edge and re-asserting the same edge REPLACES its note", async () => {
  await withDatabase(async (repo) => {
    const first = await repo.add(SCOPE_A, { fromKey: FROM_KEY, toKey: TO_KEY, relType: "depends-on", note: "first" }, CREATED_BY, 1000);
    assert.equal(first.fromKey, FROM_KEY);
    assert.equal(first.toKey, TO_KEY);
    assert.equal(first.relType, "depends-on");
    assert.equal(first.note, "first");
    assert.equal(first.createdAt, new Date(1000).toISOString());

    // Same (from, to, type) -> update note in place, no duplicate row.
    const second = await repo.add(SCOPE_A, { fromKey: FROM_KEY, toKey: TO_KEY, relType: "depends-on", note: "second" }, CREATED_BY, 5000);
    assert.equal(second.note, "second");
    assert.equal(second.updatedAt, new Date(5000).toISOString());

    const rows = await repo.list(SCOPE_A);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].note, "second");
  });
});

test("list and delete are scoped to the owning tenant", async () => {
  await withDatabase(async (repo) => {
    const saved = await repo.add(SCOPE_A, { fromKey: FROM_KEY, toKey: TO_KEY, relType: "connects-to" }, CREATED_BY);
    // Another tenant cannot see or delete it.
    assert.deepEqual(await repo.list(SCOPE_B), []);
    assert.equal(await repo.delete(SCOPE_B, saved.id), false);
    assert.equal((await repo.list(SCOPE_A)).length, 1);
    // The owner can delete it.
    assert.equal(await repo.delete(SCOPE_A, saved.id), true);
    assert.equal((await repo.list(SCOPE_A)).length, 0);
  });
});

test("edges are tenant-isolated: cross-org writes to another org's customer are rejected", async () => {
  await withDatabase(async (repo) => {
    await repo.add(SCOPE_A, { fromKey: FROM_KEY, toKey: OTHER_KEY, relType: "depends-on" }, CREATED_BY);
    assert.deepEqual(await repo.list(SCOPE_B), []);
    await assert.rejects(
      repo.add({ orgId: ORG_B, customerId: CUSTOMER_A }, { fromKey: FROM_KEY, toKey: OTHER_KEY, relType: "depends-on" }, CREATED_BY),
      (error) => error instanceof CmdbRelationshipRepositoryError && error.code === "SCOPE_NOT_FOUND",
    );
  });
});

test("validation rejects a self-edge, a bad relationship type and a malformed key before any write", async () => {
  await withDatabase(async (repo) => {
    await assert.rejects(
      repo.add(SCOPE_A, { fromKey: FROM_KEY, toKey: FROM_KEY, relType: "depends-on" }, CREATED_BY),
      (error) => error instanceof CmdbRelationshipRepositoryError && error.code === "INVALID_INPUT",
    );
    await assert.rejects(
      repo.add(SCOPE_A, { fromKey: FROM_KEY, toKey: TO_KEY, relType: "BAD TYPE!" }, CREATED_BY),
      (error) => error instanceof CmdbRelationshipRepositoryError && error.code === "INVALID_INPUT",
    );
    await assert.rejects(
      repo.add(SCOPE_A, { fromKey: "not a key ~", toKey: TO_KEY, relType: "depends-on" }, CREATED_BY),
      (error) => error instanceof CmdbRelationshipRepositoryError && error.code === "INVALID_INPUT",
    );
    assert.deepEqual(await repo.list(SCOPE_A), []);
  });
});

test("delete rejects a malformed id", async () => {
  await withDatabase(async (repo) => {
    await assert.rejects(
      repo.delete(SCOPE_A, "not-an-id"),
      (error) => error instanceof CmdbRelationshipRepositoryError && error.code === "INVALID_INPUT",
    );
  });
});
