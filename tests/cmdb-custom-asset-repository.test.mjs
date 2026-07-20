import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { CmdbCustomAssetRepository, CmdbCustomAssetRepositoryError } = await import(
  "../db/cmdb-custom-asset-repository.ts"
);

const ORG_A = "org_ca_a";
const ORG_B = "org_ca_b";
const CUSTOMER_A = "cust_ca_a";
const CUSTOMER_B = "cust_ca_b";
const SCOPE_A = { orgId: ORG_A, customerId: CUSTOMER_A };
const SCOPE_B = { orgId: ORG_B, customerId: CUSTOMER_B };
const ACTOR = "user_ca_1";

function asset(assetType, name, extra = {}) {
  return {
    assetType,
    name,
    source: extra.source ?? "imported",
    externalId: extra.externalId ?? null,
    fields: extra.fields ?? {},
  };
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-ca-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'ca-a', 'CA A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'ca-b', 'CA B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'ca-cust-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'ca-cust-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
    ]);
    await run(new CmdbCustomAssetRepository(database));
  } finally {
    await miniflare.dispose();
  }
}

test("0043 migration applies; upsert stores and a repeat REPLACES on (asset_type, name), never duplicates", async () => {
  await withDatabase(async (repo) => {
    const first = await repo.upsert(SCOPE_A, asset("saas-app", "Okta", { externalId: "okta-01", fields: { vendor: "Okta" } }), ACTOR, 1000);
    assert.equal(first.name, "Okta");
    assert.equal(first.source, "imported");
    assert.equal(first.externalId, "okta-01");
    assert.deepEqual(first.fields, { vendor: "Okta" });
    assert.equal(first.createdAt, new Date(1000).toISOString());

    // Same (asset_type, name) -> update in place; created_at preserved.
    const second = await repo.upsert(SCOPE_A, asset("saas-app", "Okta", { source: "manual", fields: { vendor: "Okta", tier: "gold" } }), ACTOR, 5000);
    assert.equal(second.source, "manual");
    assert.deepEqual(second.fields, { vendor: "Okta", tier: "gold" });
    assert.equal(second.createdAt, new Date(1000).toISOString());
    assert.equal(second.updatedAt, new Date(5000).toISOString());

    const rows = await repo.list(SCOPE_A, {});
    assert.equal(rows.length, 1);
  });
});

test("bulkUpsert writes every asset and reports the count", async () => {
  await withDatabase(async (repo) => {
    const written = await repo.bulkUpsert(SCOPE_A, [
      asset("saas-app", "Okta"),
      asset("network-device", "core-switch", { externalId: "sw-1" }),
      asset("on-prem-server", "db-primary"),
    ], ACTOR);
    assert.equal(written, 3);
    assert.equal((await repo.list(SCOPE_A, {})).length, 3);
    assert.equal((await repo.bulkUpsert(SCOPE_A, [], ACTOR)), 0);
  });
});

test("assets are tenant-isolated: cross-tenant reads see nothing, cross-org writes are rejected", async () => {
  await withDatabase(async (repo) => {
    await repo.upsert(SCOPE_A, asset("saas-app", "Okta"), ACTOR);
    assert.deepEqual(await repo.list(SCOPE_B, {}), []);
    await assert.rejects(
      repo.upsert({ orgId: ORG_B, customerId: CUSTOMER_A }, asset("saas-app", "Okta"), ACTOR),
      (error) => error instanceof CmdbCustomAssetRepositoryError && error.code === "SCOPE_NOT_FOUND",
    );
    await assert.rejects(
      repo.bulkUpsert({ orgId: ORG_B, customerId: CUSTOMER_A }, [asset("saas-app", "X")], ACTOR),
      (error) => error instanceof CmdbCustomAssetRepositoryError && error.code === "SCOPE_NOT_FOUND",
    );
  });
});

test("list filters by asset type and orders deterministically", async () => {
  await withDatabase(async (repo) => {
    await repo.bulkUpsert(SCOPE_A, [
      asset("saas-app", "Zoom"),
      asset("saas-app", "Asana"),
      asset("network-device", "core-switch"),
    ], ACTOR);

    const saas = await repo.list(SCOPE_A, { assetType: "saas-app" });
    assert.deepEqual(saas.map((row) => row.name), ["Asana", "Zoom"]);

    const all = await repo.list(SCOPE_A, {});
    // asset_type ASC, then name ASC.
    assert.deepEqual(all.map((row) => `${row.assetType}/${row.name}`), [
      "network-device/core-switch",
      "saas-app/Asana",
      "saas-app/Zoom",
    ]);
  });
});

test("get resolves by id and by natural key; delete removes only the owned row", async () => {
  await withDatabase(async (repo) => {
    const stored = await repo.upsert(SCOPE_A, asset("saas-app", "Okta"), ACTOR);
    assert.equal((await repo.get(SCOPE_A, { id: stored.id }))?.name, "Okta");
    assert.equal((await repo.get(SCOPE_A, { assetType: "saas-app", name: "Okta" }))?.id, stored.id);
    // A different tenant cannot fetch it by id.
    assert.equal(await repo.get(SCOPE_B, { id: stored.id }), null);
    assert.equal(await repo.delete(SCOPE_B, stored.id), false);
    assert.equal(await repo.delete(SCOPE_A, stored.id), true);
    assert.equal((await repo.list(SCOPE_A, {})).length, 0);
  });
});

test("validation rejects a bad asset type, empty name, and non-string field values", async () => {
  await withDatabase(async (repo) => {
    await assert.rejects(
      repo.upsert(SCOPE_A, asset("Bad Type", "x"), ACTOR),
      (error) => error instanceof CmdbCustomAssetRepositoryError && error.code === "INVALID_INPUT",
    );
    await assert.rejects(
      repo.upsert(SCOPE_A, asset("custom", ""), ACTOR),
      (error) => error instanceof CmdbCustomAssetRepositoryError && error.code === "INVALID_INPUT",
    );
    await assert.rejects(
      repo.upsert(SCOPE_A, { assetType: "custom", name: "ok", source: "manual", externalId: null, fields: { n: 5 } }, ACTOR),
      (error) => error instanceof CmdbCustomAssetRepositoryError && error.code === "INVALID_INPUT",
    );
  });
});
