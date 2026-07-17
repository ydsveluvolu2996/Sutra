import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const pilotRepository = await import("../db/pilot-repository.ts");
const { getPortfolio } = await import("../db/portfolio-repository.ts");
const { assertSessionCapability } = await import("../lib/api-auth.ts");

const ORGS = [
  {
    orgId: "org_isolation_alpha",
    customerId: "cust_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    connectionId: "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    accountId: "111122223333",
    resourceKey: "aws:ec2:us-east-1:111122223333:instance/i-alpha",
  },
  {
    orgId: "org_isolation_beta",
    customerId: "cust_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    connectionId: "conn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    accountId: "444455556666",
    resourceKey: "aws:ec2:us-east-1:444455556666:instance/i-beta",
  },
];

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-tenant-isolation-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    const now = Date.now();
    for (const [index, scope] of ORGS.entries()) {
      const syncRunId = `sync_${String(index + 1).repeat(32)}`;
      const snapshotId = `snap_${String(index + 1).repeat(32)}`;
      await database.batch([
        database.prepare(
          "INSERT INTO organizations (id, slug, name, status, created_at) VALUES (?, ?, ?, 'active', ?)",
        ).bind(scope.orgId, `isolation-${index}`, `Isolation ${index}`, now + index),
        database.prepare(
          "INSERT INTO customers (id, org_id, slug, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
        ).bind(scope.customerId, scope.orgId, `customer-${index}`, `Customer ${index}`, now, now),
        database.prepare(
          `INSERT INTO aws_connections
            (id, org_id, customer_id, source_kind, partition, aws_account_id,
             role_arn, external_id_ciphertext, external_id_key_version,
             permission_pack_version, status, enabled_regions_json, created_at, updated_at)
           VALUES (?, ?, ?, 'aws_trust_role', 'aws', ?, ?, ?, 'test-key-v1',
                   ?, 'active', '["us-east-1"]', ?, ?)`,
        ).bind(
          scope.connectionId,
          scope.orgId,
          scope.customerId,
          scope.accountId,
          `arn:aws:iam::${scope.accountId}:role/sutra/SutraReadOnlyRole`,
          `ciphertext-${index}-not-a-real-secret`,
          pilotRepository.CURRENT_PILOT_PERMISSION_PACK,
          now,
          now,
        ),
        database.prepare(
          `INSERT INTO sync_runs
            (id, org_id, customer_id, connection_id, trigger_kind, status,
             coverage_state, collector_pack_version, totals_json, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, 'manual', 'succeeded', 'complete', 'test', '{}', ?, ?)`,
        ).bind(syncRunId, scope.orgId, scope.customerId, scope.connectionId, `isolation-${index}`, now),
        database.prepare(
          `INSERT INTO cmdb_snapshots
            (id, org_id, customer_id, connection_id, sync_run_id, status,
             collected_at, completed_at, coverage_json, summary_json,
             snapshot_sha256, origin_kind)
           VALUES (?, ?, ?, ?, ?, 'complete', ?, ?, '[]', '{}', ?, 'live_aws')`,
        ).bind(snapshotId, scope.orgId, scope.customerId, scope.connectionId, syncRunId, now, now, "a".repeat(64)),
        database.prepare(
          `INSERT INTO connection_heads
            (connection_id, org_id, customer_id, snapshot_id, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).bind(scope.connectionId, scope.orgId, scope.customerId, snapshotId, now),
        database.prepare(
          `INSERT INTO cmdb_resources
            (id, snapshot_id, org_id, customer_id, connection_id, resource_key,
             provider_key, service, resource_type, native_id, name, region_key,
             state, tags_json, configuration_json, source_json, content_sha256, collected_at)
           VALUES (?, ?, ?, ?, ?, ?, 'aws', 'ec2', 'ec2.instance', ?, ?, 'us-east-1',
                   'running', '{}', '{}', ?, ?, ?)`,
        ).bind(
          `res_${String(index + 1).repeat(32)}`,
          snapshotId,
          scope.orgId,
          scope.customerId,
          scope.connectionId,
          scope.resourceKey,
          `i-${index}`,
          `instance-${index}`,
          JSON.stringify({ api: "EC2.DescribeInstances", accountId: scope.accountId, collectedAt: new Date(now).toISOString() }),
          String(index + 1).repeat(64),
          now,
        ),
      ]);
    }
    await run(database);
  } finally {
    await miniflare.dispose();
  }
}

function subject(scope, scopeMode = "all_customers") {
  return {
    userId: `usr_${scope.orgId}`,
    orgId: scope.orgId,
    membershipId: `mem_${scope.orgId}`,
    role: "org_owner",
    scopeMode,
    grants: [],
  };
}

test("connection and trust-secret lookups require the authenticated organization", async () => {
  await withDatabase(async () => {
    const [alpha, beta] = ORGS;
    assert.equal((await pilotRepository.getConnectionForOrg(alpha.orgId, alpha.connectionId))?.awsAccountId, alpha.accountId);
    assert.equal(await pilotRepository.getConnectionForOrg(alpha.orgId, beta.connectionId), null);
    assert.equal((await pilotRepository.getStoredConnectionSecretForOrg(alpha.orgId, alpha.connectionId)).accountId, alpha.accountId);
    await assert.rejects(
      pilotRepository.getStoredConnectionSecretForOrg(alpha.orgId, beta.connectionId),
      (error) => error?.code === "NOT_FOUND",
    );
  });
});

test("CMDB state, latest selection, and portfolio aggregation never cross organizations", async () => {
  await withDatabase(async () => {
    const [alpha, beta] = ORGS;
    const alphaState = await pilotRepository.getPilotStateForOrg(alpha.orgId);
    assert.equal(alphaState.connection?.id, alpha.connectionId);
    assert.deepEqual(alphaState.resources.map((resource) => resource.resourceKey), [alpha.resourceKey]);
    const crossState = await pilotRepository.getPilotStateForOrg(alpha.orgId, beta.connectionId);
    assert.equal(crossState.mode, "empty");
    assert.equal(crossState.connection, null);
    assert.deepEqual(crossState.resources, []);
    const portfolio = await getPortfolio(subject(alpha));
    assert.equal(portfolio.organizationId, alpha.orgId);
    assert.deepEqual(portfolio.customers.map((customer) => customer.id), [alpha.customerId]);
    assert.deepEqual(portfolio.customers.flatMap((customer) => customer.connections.map((connection) => connection.id)), [alpha.connectionId]);
  });
});

test("authorization and immutable audit chains use the active hosted organization", async () => {
  await withDatabase(async (database) => {
    const [alpha, beta] = ORGS;
    assert.doesNotThrow(() => assertSessionCapability({ subject: subject(beta) }, "workspace:read"));
    for (const scope of [alpha, beta]) {
      await pilotRepository.appendAuditEvent({
        orgId: scope.orgId,
        actorId: subject(scope).userId,
        action: "tenant.isolation.accepted",
        targetType: "organization",
        targetId: scope.orgId,
        customerId: null,
        outcome: "allowed",
        requestId: "tenant-isolation-shared-idempotency-key",
        metadata: { evidence: scope.orgId },
      });
    }
    const result = await database.prepare(
      `SELECT org_id, previous_event_hash, metadata_json
         FROM audit_events
        WHERE action = 'tenant.isolation.accepted'
        ORDER BY org_id`,
    ).all();
    assert.equal(result.results.length, 2);
    assert.ok(result.results.every((row) => row.previous_event_hash === null));
    assert.deepEqual(
      result.results.map((row) => JSON.parse(row.metadata_json).evidence),
      [alpha.orgId, beta.orgId],
    );
  });
});

test("customer-facing API routes resolve connection state through organization-scoped repositories", async () => {
  const routeExpectations = new Map([
    ["app/api/pilot/export/route.ts", ["getConnectionForOrg(actor.orgId", "getPilotStateForOrg(actor.orgId"]],
    ["app/api/pilot/state/route.ts", ["getConnectionForOrg(actor.orgId", "getPilotStateForOrg(actor.orgId"]],
    ["app/api/v1/cases/route.ts", ["getConnectionForOrg(authenticated.subject.orgId"]],
    ["app/api/v1/changes/route.ts", ["getConnectionForOrg(authenticated.subject.orgId"]],
    ["app/api/v1/compliance/route.ts", ["getConnectionForOrg(actor.orgId", "getPilotStateForOrg(actor.orgId"]],
    ["app/api/v1/compliance/exceptions/route.ts", ["getConnectionForOrg(authenticated.subject.orgId", "getPilotStateForOrg(authenticated.subject.orgId"]],
    ["app/api/v1/costs/route.ts", ["getConnectionForOrg(authenticated.subject.orgId", "getStoredConnectionSecretForOrg(authenticated.subject.orgId"]],
    ["app/api/v1/security-events/route.ts", ["getConnectionForOrg(authenticated.subject.orgId"]],
  ]);
  for (const [path, expectations] of routeExpectations) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    for (const expectation of expectations) {
      assert.match(source, new RegExp(expectation.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), `${path} must bind ${expectation}`);
    }
  }
  const onboarding = await readFile(new URL("../app/api/pilot/connections/route.ts", import.meta.url), "utf8");
  assert.match(onboarding, /actor\.orgId !== LOCAL_ORG_ID/u);
  assert.match(onboarding, /Hosted AWS onboarding remains disabled/u);
});
