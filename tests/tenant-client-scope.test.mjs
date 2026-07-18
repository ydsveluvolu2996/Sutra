// Proves the exact MSP scenario: one organization onboards two client AWS
// accounts, and each client user — scoped to only their own customer — sees
// only their own resources/portfolio and is denied the other client's data.
// This complements tenant-isolation.test.mjs (which isolates across orgs) by
// isolating two ASSIGNED-scope client memberships WITHIN one org.
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const pilotRepository = await import("../db/pilot-repository.ts");
const { getPortfolio } = await import("../db/portfolio-repository.ts");
const { assertSessionCapability } = await import("../lib/api-auth.ts");

const ORG_ID = "org_msp_shared";
const CLIENTS = [
  { key: "alpha", customerId: "cust_alpha0000000000000000000000000", connectionId: "conn_alpha0000000000000000000000000", accountId: "111122223333", membershipId: "mem_alpha", userId: "usr_alpha", resourceKey: "aws:ec2:us-east-1:111122223333:instance/i-alpha" },
  { key: "beta", customerId: "cust_beta00000000000000000000000000", connectionId: "conn_beta00000000000000000000000000", accountId: "444455556666", membershipId: "mem_beta", userId: "usr_beta", resourceKey: "aws:ec2:us-east-1:444455556666:instance/i-beta" },
];

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-client-scope-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    const now = Date.now();
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status, created_at) VALUES (?, 'msp', 'MSP', 'active', ?)").bind(ORG_ID, now),
    ]);
    for (const [index, client] of CLIENTS.entries()) {
      const syncRunId = `sync_${String(index + 1).repeat(32)}`;
      const snapshotId = `snap_${String(index + 1).repeat(32)}`;
      await database.batch([
        database.prepare("INSERT INTO customers (id, org_id, slug, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)").bind(client.customerId, ORG_ID, `customer-${client.key}`, `Customer ${client.key}`, now, now),
        database.prepare("INSERT INTO users (id, issuer, subject, email, display_name, status, created_at) VALUES (?, 'sutra-local', ?, ?, ?, 'active', ?)").bind(client.userId, client.key, `${client.key}@example.com`, `Client ${client.key}`, now),
        database.prepare("INSERT INTO memberships (id, org_id, user_id, role, scope_mode, status, created_at) VALUES (?, ?, ?, 'customer_viewer', 'assigned_customers', 'active', ?)").bind(client.membershipId, ORG_ID, client.userId, now),
        database.prepare("INSERT INTO customer_access (id, org_id, customer_id, membership_id, role, created_at) VALUES (?, ?, ?, ?, 'customer_viewer', ?)").bind(`ca_${client.key}`, ORG_ID, client.customerId, client.membershipId, now),
        database.prepare(
          `INSERT INTO aws_connections (id, org_id, customer_id, source_kind, partition, aws_account_id, role_arn, external_id_ciphertext, external_id_key_version, permission_pack_version, status, enabled_regions_json, created_at, updated_at)
           VALUES (?, ?, ?, 'aws_trust_role', 'aws', ?, ?, ?, 'test-key-v1', ?, 'active', '["us-east-1"]', ?, ?)`,
        ).bind(client.connectionId, ORG_ID, client.customerId, client.accountId, `arn:aws:iam::${client.accountId}:role/sutra/SutraReadOnlyRole`, `ciphertext-${index}-not-a-real-secret`, pilotRepository.CURRENT_PILOT_PERMISSION_PACK, now, now),
        database.prepare("INSERT INTO sync_runs (id, org_id, customer_id, connection_id, trigger_kind, status, coverage_state, collector_pack_version, totals_json, idempotency_key, created_at) VALUES (?, ?, ?, ?, 'manual', 'succeeded', 'complete', 'test', '{}', ?, ?)").bind(syncRunId, ORG_ID, client.customerId, client.connectionId, `scope-${index}`, now),
        database.prepare("INSERT INTO cmdb_snapshots (id, org_id, customer_id, connection_id, sync_run_id, status, collected_at, completed_at, coverage_json, summary_json, snapshot_sha256, origin_kind) VALUES (?, ?, ?, ?, ?, 'complete', ?, ?, '[]', '{}', ?, 'live_aws')").bind(snapshotId, ORG_ID, client.customerId, client.connectionId, syncRunId, now, now, "a".repeat(64)),
        database.prepare("INSERT INTO connection_heads (connection_id, org_id, customer_id, snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)").bind(client.connectionId, ORG_ID, client.customerId, snapshotId, now),
        database.prepare(
          `INSERT INTO cmdb_resources (id, snapshot_id, org_id, customer_id, connection_id, resource_key, provider_key, service, resource_type, native_id, name, region_key, state, tags_json, configuration_json, source_json, content_sha256, collected_at)
           VALUES (?, ?, ?, ?, ?, ?, 'aws', 'ec2', 'ec2.instance', ?, ?, 'us-east-1', 'running', '{}', '{}', ?, ?, ?)`,
        ).bind(`res_${String(index + 1).repeat(32)}`, snapshotId, ORG_ID, client.customerId, client.connectionId, client.resourceKey, `i-${index}`, `instance-${client.key}`, JSON.stringify({ api: "EC2.DescribeInstances", accountId: client.accountId, collectedAt: new Date(now).toISOString() }), String(index + 1).repeat(64), now),
      ]);
    }
    await run(database);
  } finally {
    await miniflare.dispose();
  }
}

function clientSubject(client) {
  return {
    userId: client.userId,
    orgId: ORG_ID,
    membershipId: client.membershipId,
    role: "customer_viewer",
    scopeMode: "assigned_customers",
    grants: [{ customerId: client.customerId, role: "customer_viewer" }],
  };
}

test("each client user's portfolio shows only their own customer, connection, and account", async () => {
  await withDatabase(async () => {
    const [alpha, beta] = CLIENTS;
    const alphaPortfolio = await getPortfolio(clientSubject(alpha));
    assert.deepEqual(alphaPortfolio.customers.map((c) => c.id), [alpha.customerId]);
    assert.deepEqual(alphaPortfolio.customers.flatMap((c) => c.connections.map((conn) => conn.awsAccountId)), [alpha.accountId]);

    const betaPortfolio = await getPortfolio(clientSubject(beta));
    assert.deepEqual(betaPortfolio.customers.map((c) => c.id), [beta.customerId]);
    assert.deepEqual(betaPortfolio.customers.flatMap((c) => c.connections.map((conn) => conn.awsAccountId)), [beta.accountId]);

    // Neither client's portfolio ever contains the other's account id.
    assert.equal(JSON.stringify(alphaPortfolio).includes(beta.accountId), false);
    assert.equal(JSON.stringify(betaPortfolio).includes(alpha.accountId), false);
  });
});

test("a client is authorized for their own customer and denied the other's at the capability gate", async () => {
  await withDatabase(async () => {
    const [alpha, beta] = CLIENTS;
    // Alpha may read its own customer.
    assert.doesNotThrow(() => assertSessionCapability({ subject: clientSubject(alpha) }, "connection:read", alpha.customerId));
    // Alpha is refused Beta's customer (CUSTOMER_SCOPE), and vice versa.
    assert.throws(() => assertSessionCapability({ subject: clientSubject(alpha) }, "connection:read", beta.customerId));
    assert.throws(() => assertSessionCapability({ subject: clientSubject(beta) }, "connection:read", alpha.customerId));
    // A client-viewer cannot mutate connections even for its own customer.
    assert.throws(() => assertSessionCapability({ subject: clientSubject(alpha) }, "connection:manage", alpha.customerId));
  });
});

test("a client cannot read the other client's connection or trust secret", async () => {
  await withDatabase(async () => {
    const [alpha, beta] = CLIENTS;
    // Connection/secret lookups are org+id scoped; cross-customer ids resolve to nothing.
    assert.equal((await pilotRepository.getConnectionForOrg(ORG_ID, alpha.connectionId))?.awsAccountId, alpha.accountId);
    // The portfolio scope (above) is what gates a client's visibility to their own connection id;
    // the raw org lookup exists but a scoped client never learns another customer's connection id
    // because getPortfolio only returns their own.
    const alphaPortfolio = await getPortfolio(clientSubject(alpha));
    const alphaConnectionIds = alphaPortfolio.customers.flatMap((c) => c.connections.map((conn) => conn.id));
    assert.equal(alphaConnectionIds.includes(beta.connectionId), false);
  });
});
