import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const pilotRepository = await import("../db/pilot-repository.ts");

const ORG_A = "org_list_alpha";
const ORG_B = "org_list_beta";

// Two customers/connections in org A, one in org B, so the listing proves both
// cross-org isolation and that a single org's multiple connections are returned.
const CONN_A1 = {
  orgId: ORG_A,
  customerId: "cust_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  connectionId: "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  accountId: "111122223333",
  customerName: "Alpha One",
};
const CONN_A2 = {
  orgId: ORG_A,
  customerId: "cust_cccccccccccccccccccccccccccccccc",
  connectionId: "conn_cccccccccccccccccccccccccccccccc",
  accountId: "777788889999",
  customerName: "Alpha Two",
};
const CONN_B1 = {
  orgId: ORG_B,
  customerId: "cust_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  connectionId: "conn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  accountId: "444455556666",
  customerName: "Beta One",
};

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-list-connections-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    const now = Date.now();
    await database.batch([
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status, created_at) VALUES (?, 'list-alpha', 'List Alpha', 'active', ?)",
      ).bind(ORG_A, now),
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status, created_at) VALUES (?, 'list-beta', 'List Beta', 'active', ?)",
      ).bind(ORG_B, now),
    ]);
    // created_at values are staggered so DESC ordering is deterministic.
    const rows = [
      { conn: CONN_A1, slug: "alpha-one", status: "active", createdAt: now + 10 },
      { conn: CONN_A2, slug: "alpha-two", status: "disabled", createdAt: now + 20 },
      { conn: CONN_B1, slug: "beta-one", status: "active", createdAt: now + 30 },
    ];
    for (const { conn, slug, status, createdAt } of rows) {
      await database.batch([
        database.prepare(
          "INSERT INTO customers (id, org_id, slug, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
        ).bind(conn.customerId, conn.orgId, slug, conn.customerName, createdAt, createdAt),
        database.prepare(
          `INSERT INTO aws_connections
            (id, org_id, customer_id, source_kind, partition, aws_account_id,
             role_arn, external_id_ciphertext, external_id_key_version,
             permission_pack_version, status, enabled_regions_json, created_at, updated_at)
           VALUES (?, ?, ?, 'aws_trust_role', 'aws', ?, ?, ?, 'test-key-v1',
                   ?, ?, '["us-east-1"]', ?, ?)`,
        ).bind(
          conn.connectionId,
          conn.orgId,
          conn.customerId,
          conn.accountId,
          `arn:aws:iam::${conn.accountId}:role/sutra/SutraReadOnlyRole`,
          `ciphertext-${slug}-not-a-real-secret`,
          pilotRepository.CURRENT_PILOT_PERMISSION_PACK,
          status,
          createdAt,
          createdAt,
        ),
      ]);
    }
    await run(database);
  } finally {
    await miniflare.dispose();
  }
}

test("listConnectionsForOrg returns only the org's connections, across every status, with customer names joined", async () => {
  await withDatabase(async () => {
    const alpha = await pilotRepository.listConnectionsForOrg(ORG_A);
    // Both org A connections are returned (newest created_at first), including
    // the disabled one — showback reads historical billing regardless of status.
    assert.deepEqual(alpha.map((connection) => connection.id), [CONN_A2.connectionId, CONN_A1.connectionId]);
    assert.deepEqual(alpha.map((connection) => connection.customerName), ["Alpha Two", "Alpha One"]);
    assert.deepEqual(alpha.map((connection) => connection.status), ["disabled", "active"]);
    assert.deepEqual(alpha.map((connection) => connection.awsAccountId), [CONN_A2.accountId, CONN_A1.accountId]);
    // Org B's connection is never present in org A's listing (tenant isolation).
    assert.equal(alpha.some((connection) => connection.id === CONN_B1.connectionId), false);
    assert.equal(alpha.some((connection) => connection.customerId === CONN_B1.customerId), false);
  });
});

test("listConnectionsForOrg is scoped per org and empty for an unknown org", async () => {
  await withDatabase(async () => {
    const beta = await pilotRepository.listConnectionsForOrg(ORG_B);
    assert.deepEqual(beta.map((connection) => connection.id), [CONN_B1.connectionId]);
    assert.equal(beta[0].customerName, "Beta One");
    assert.deepEqual(await pilotRepository.listConnectionsForOrg("org_does_not_exist"), []);
  });
});
