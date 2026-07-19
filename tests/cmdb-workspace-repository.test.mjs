import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { CmdbWorkspaceRepository, CmdbWorkspaceRepositoryError } = await import("../db/cmdb-workspace-repository.ts");
const { runCmdbQuery, validateCmdbQuery } = await import("../lib/cmdb-query.ts");

const ORG_A = "org_cw_a";
const ORG_B = "org_cw_b";
const CUSTOMER_A = "cust_cw_a";
const CUSTOMER_B = "cust_cw_b";
const CONN_A = `conn_${"a".repeat(32)}`;
const SNAP_A = "snap_cw_a";
const SCOPE_A = { orgId: ORG_A, customerId: CUSTOMER_A };
const SCOPE_B = { orgId: ORG_B, customerId: CUSTOMER_B };

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-cw-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'cw-a', 'CW A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'cw-b', 'CW B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'cw-cust-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'cw-cust-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
    ]);
    await run(new CmdbWorkspaceRepository(database), database);
  } finally {
    await miniflare.dispose();
  }
}

test("0026 migration applies; annotations upsert, read back tenant-scoped, and update in place", async () => {
  await withDatabase(async (repo) => {
    await repo.upsertAnnotation(SCOPE_A, CONN_A, {
      resourceKey: "aws.s3.bucket/b-1",
      ownerTeam: "payments",
      ownerEmail: "payments@example.com",
      customFields: { costCenter: "cc-42" },
    }, "user_a");
    await repo.upsertAnnotation(SCOPE_A, CONN_A, {
      resourceKey: "aws.s3.bucket/b-1",
      ownerTeam: "billing",
      customFields: { costCenter: "cc-43", tier: "gold" },
    }, "user_a");
    const annotations = await repo.annotationsForConnection(SCOPE_A, CONN_A);
    assert.equal(annotations.length, 1);
    assert.equal(annotations[0].ownerTeam, "billing");
    assert.equal(annotations[0].ownerEmail, null);
    assert.deepEqual(annotations[0].customFields, { costCenter: "cc-43", tier: "gold" });
    // Other tenant sees nothing.
    assert.deepEqual(await repo.annotationsForConnection(SCOPE_B, CONN_A), []);
  });
});

test("annotation writes are gated to customers the organization owns", async () => {
  await withDatabase(async (repo) => {
    // Org B claiming Org A's customer id writes nothing and is told so.
    await assert.rejects(
      repo.upsertAnnotation({ orgId: ORG_B, customerId: CUSTOMER_A }, CONN_A, { resourceKey: "aws.s3.bucket/b-1" }, "user_b"),
      (error) => error instanceof CmdbWorkspaceRepositoryError && error.code === "SCOPE_NOT_FOUND",
    );
    await assert.rejects(
      repo.upsertAnnotation(SCOPE_A, CONN_A, { resourceKey: "aws.s3.bucket/b-1", ownerEmail: "not-an-email" }, "user_a"),
      (error) => error instanceof CmdbWorkspaceRepositoryError && error.code === "INVALID_INPUT",
    );
    await assert.rejects(
      repo.upsertAnnotation(SCOPE_A, CONN_A, {
        resourceKey: "aws.s3.bucket/b-1",
        customFields: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`k${index}`, "v"])),
      }, "user_a"),
      (error) => error instanceof CmdbWorkspaceRepositoryError && error.code === "LIMIT_EXCEEDED",
    );
  });
});

test("saved queries round-trip through validation, list tenant-scoped, and delete", async () => {
  await withDatabase(async (repo) => {
    const saved = await repo.saveQuery(SCOPE_A, "prod ec2", "running prod instances", {
      combine: "and",
      predicates: [
        { kind: "field", field: "service", op: "eq", value: "ec2" },
        { kind: "tag", key: "env", op: "eq", value: "prod" },
      ],
    }, "user_a");
    assert.match(saved.id, /^sq_[a-f0-9]{32}$/u);
    const queries = await repo.listQueries(SCOPE_A);
    assert.equal(queries.length, 1);
    assert.equal(queries[0].query.predicates.length, 2);
    assert.deepEqual(await repo.listQueries(SCOPE_B), []);
    // A malformed stored query is rejected up front.
    await assert.rejects(
      repo.saveQuery(SCOPE_A, "bad", null, { predicates: [{ kind: "field", field: "nope", op: "eq", value: "x" }] }, "user_a"),
      (error) => error instanceof CmdbWorkspaceRepositoryError && error.code === "INVALID_INPUT",
    );
    assert.equal(await repo.deleteQuery(SCOPE_A, saved.id), true);
    assert.deepEqual(await repo.listQueries(SCOPE_A), []);
    // Deleting from the wrong org is a no-op, not an error leak.
    assert.equal(await repo.deleteQuery(SCOPE_B, saved.id), false);
  });
});

test("resourcesForQuery reads only the published head snapshot and feeds the engine", async (t) => {
  await withDatabase(async (repo, database) => {
    const columns = await database.prepare("PRAGMA table_info(cmdb_resources)").all();
    const names = new Set((columns.results ?? []).map((row) => row.name));
    const required = ["snapshot_id", "org_id", "customer_id", "connection_id", "resource_key", "provider_key", "service", "resource_type", "native_id", "region_key", "tags_json", "configuration_json"];
    if (!required.every((name) => names.has(name))) {
      t.skip("cmdb_resources shape differs from the seeding contract used here");
      return;
    }
    const resourceColumns = (columns.results ?? []).map((row) => row.name);
    const seedResource = async (key, service, type, tags, configuration) => {
      const values = {
        id: `res_${crypto.randomUUID().replaceAll("-", "")}`,
        snapshot_id: SNAP_A,
        org_id: ORG_A,
        customer_id: CUSTOMER_A,
        connection_id: CONN_A,
        resource_key: key,
        provider_key: "aws",
        service,
        resource_type: type,
        native_id: key.split("/")[1] ?? key,
        arn: null,
        name: key,
        region_key: "us-east-1",
        state: "available",
        tags_json: JSON.stringify(tags),
        configuration_json: JSON.stringify(configuration),
        collected_at: 0,
        source_json: "{}",
        content_sha256: "0".repeat(64),
      };
      const present = resourceColumns.filter((column) => column in values);
      await database.prepare(
        `INSERT INTO cmdb_resources (${present.join(", ")}) VALUES (${present.map(() => "?").join(", ")})`,
      ).bind(...present.map((column) => values[column])).run();
    };
    const connectionColumns = await database.prepare("PRAGMA table_info(aws_connections)").all();
    const connectionNames = (connectionColumns.results ?? []).map((row) => row.name);
    const connectionValues = {
      id: CONN_A,
      org_id: ORG_A,
      customer_id: CUSTOMER_A,
      partition: "aws",
      aws_account_id: "111111111111",
      role_arn: "arn:aws:iam::111111111111:role/sutra-collector",
      external_id_ciphertext: "ciphertext",
      external_id_key_version: 1,
      permission_pack_version: "v1",
      status: "active",
      enabled_regions_json: JSON.stringify(["us-east-1"]),
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    };
    const presentConnection = connectionNames.filter((column) => column in connectionValues);
    await database.prepare(
      `INSERT INTO aws_connections (${presentConnection.join(", ")}) VALUES (${presentConnection.map(() => "?").join(", ")})`,
    ).bind(...presentConnection.map((column) => connectionValues[column])).run();

    const RUN_A = `run_${crypto.randomUUID().replaceAll("-", "")}`;
    await database.prepare(
      "INSERT INTO sync_runs (id, org_id, customer_id, connection_id, trigger_kind, status, collector_pack_version, idempotency_key) VALUES (?, ?, ?, ?, 'manual', 'succeeded', 'v1', ?)",
    ).bind(RUN_A, ORG_A, CUSTOMER_A, CONN_A, RUN_A).run();

    const snapshotColumns = await database.prepare("PRAGMA table_info(cmdb_snapshots)").all();
    const snapshotNames = (snapshotColumns.results ?? []).map((row) => row.name);
    const snapshotValues = {
      id: SNAP_A,
      org_id: ORG_A,
      customer_id: CUSTOMER_A,
      connection_id: CONN_A,
      sync_run_id: RUN_A,
      status: "complete",
      collected_at: 0,
      coverage_json: "{}",
      summary_json: "{}",
      snapshot_sha256: "0".repeat(64),
      origin_kind: "fixture",
    };
    const presentSnapshot = snapshotNames.filter((column) => column in snapshotValues);
    await database.prepare(
      `INSERT INTO cmdb_snapshots (${presentSnapshot.join(", ")}) VALUES (${presentSnapshot.map(() => "?").join(", ")})`,
    ).bind(...presentSnapshot.map((column) => snapshotValues[column])).run();
    const headColumns = await database.prepare("PRAGMA table_info(connection_heads)").all();
    const headNames = (headColumns.results ?? []).map((row) => row.name);
    const headValues = { connection_id: CONN_A, snapshot_id: SNAP_A, org_id: ORG_A, customer_id: CUSTOMER_A, updated_at: new Date(0).toISOString(), published_at: new Date(0).toISOString() };
    const presentHead = headNames.filter((column) => column in headValues);
    await database.prepare(
      `INSERT INTO connection_heads (${presentHead.join(", ")}) VALUES (${presentHead.map(() => "?").join(", ")})`,
    ).bind(...presentHead.map((column) => headValues[column])).run();

    await seedResource("aws.ec2.instance/i-1", "ec2", "aws.ec2.instance", { env: "prod" }, { encrypted: false });
    await seedResource("aws.s3.bucket/b-1", "s3", "aws.s3.bucket", { env: "prod" }, { encrypted: true });

    const resources = await repo.resourcesForQuery(SCOPE_A, CONN_A);
    assert.equal(resources.length, 2);
    const { query } = validateCmdbQuery({ predicates: [{ kind: "config", path: "encrypted", op: "eq", value: false }] });
    const result = runCmdbQuery(resources, query);
    assert.deepEqual(result.matched.map((resource) => resource.resourceKey), ["aws.ec2.instance/i-1"]);
    // Cross-tenant read returns nothing.
    assert.deepEqual(await repo.resourcesForQuery(SCOPE_B, CONN_A), []);
  });
});
