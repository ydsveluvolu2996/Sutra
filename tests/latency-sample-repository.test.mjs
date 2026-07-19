import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { LatencySampleRepository, LatencySampleRepositoryError } = await import("../db/latency-sample-repository.ts");
const { buildReachabilityLatency } = await import("../lib/reachability-latency.ts");

const ORG_A = "org_lat_a";
const ORG_B = "org_lat_b";
const CUSTOMER_A = "cust_lat_a";
const CUSTOMER_B = "cust_lat_b";
const CONN_A = `conn_${"a".repeat(32)}`;
const SCOPE_A = { orgId: ORG_A, customerId: CUSTOMER_A };
const SCOPE_B = { orgId: ORG_B, customerId: CUSTOMER_B };

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-latency-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'lat-a', 'Lat A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'lat-b', 'Lat B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'lat-cust-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'lat-cust-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
    ]);
    await run(new LatencySampleRepository(database));
  } finally {
    await miniflare.dispose();
  }
}

test("0025 migration applies; samples ingest and read back, and drive the engine", async () => {
  await withDatabase(async (repo) => {
    const written = await repo.ingest(SCOPE_A, CONN_A, [
      { endpointRef: "eni-1", kind: "response", milliseconds: 120 },
      { endpointRef: "eni-1", kind: "database", milliseconds: 300 },
    ]);
    assert.equal(written, 2);
    const samples = await repo.recentForConnection(SCOPE_A, CONN_A);
    assert.equal(samples.length, 2);
    const report = buildReachabilityLatency(samples);
    const endpoint = report.endpoints.find((entry) => entry.endpointRef === "eni-1");
    assert.equal(endpoint?.metrics.response.status, "healthy"); // 120 <= 300
    assert.equal(endpoint?.metrics.database.status, "slow"); // 300 > 200
  });
});

test("reads are tenant-isolated: another org sees none of the samples", async () => {
  await withDatabase(async (repo) => {
    await repo.ingest(SCOPE_A, CONN_A, [{ endpointRef: "eni-1", kind: "response", milliseconds: 50 }]);
    assert.deepEqual(await repo.recentForConnection(SCOPE_B, CONN_A), []);
  });
});

test("ingest to a customer the org does not own is rejected as SCOPE_NOT_FOUND", async () => {
  await withDatabase(async (repo) => {
    await assert.rejects(
      repo.ingest({ orgId: ORG_A, customerId: CUSTOMER_B }, CONN_A, [{ endpointRef: "eni-1", kind: "response", milliseconds: 10 }]),
      (error) => error instanceof LatencySampleRepositoryError && error.code === "SCOPE_NOT_FOUND",
    );
  });
});

test("invalid samples are refused before any write", async () => {
  await withDatabase(async (repo) => {
    for (const bad of [
      [{ endpointRef: "eni-1", kind: "cpu", milliseconds: 10 }], // bad kind
      [{ endpointRef: "eni-1", kind: "response", milliseconds: -1 }], // negative
      [{ endpointRef: "eni-1", kind: "response", milliseconds: 10_000_000 }], // beyond 1h
      [{ endpointRef: "", kind: "response", milliseconds: 10 }], // empty ref
      [], // empty batch
    ]) {
      await assert.rejects(
        repo.ingest(SCOPE_A, CONN_A, bad),
        (error) => error instanceof LatencySampleRepositoryError && error.code === "INVALID_INPUT",
      );
    }
    assert.deepEqual(await repo.recentForConnection(SCOPE_A, CONN_A), []);
  });
});
