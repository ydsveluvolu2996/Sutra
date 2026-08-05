import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { JobQueueRepository, JobQueueRepositoryError } = await import("../db/job-queue-repository.ts");

const ORG_A = "org_conn_a";
const ORG_B = "org_conn_b";
const CUSTOMER_A = "cust_conn_a";
const CUSTOMER_B = "cust_conn_b";
const CONN_A = "conn_a";
const CONN_B = "conn_b";
const KIND = "hosted.collector.collect";

function connectionInsert(database, id, orgId, customerId, account) {
  return database
    .prepare(
      `INSERT INTO aws_connections
        (id, org_id, customer_id, partition, aws_account_id, role_arn, external_id_ciphertext, external_id_key_version, permission_pack_version, status, enabled_regions_json)
       VALUES (?, ?, ?, 'aws', ?, ?, 'ct', 'v1', 'pp-v1', 'active', '[]')`,
    )
    .bind(id, orgId, customerId, account, `arn:aws:iam::${account}:role/sutra-collector`);
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-jobscope-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'conn-a', 'Conn A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'conn-b', 'Conn B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'conn-cust-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'conn-cust-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
      connectionInsert(database, CONN_A, ORG_A, CUSTOMER_A, "111111111111"),
      connectionInsert(database, CONN_B, ORG_B, CUSTOMER_B, "222222222222"),
    ]);
    await run(new JobQueueRepository(database));
  } finally {
    await miniflare.dispose();
  }
}

test("0052 connection-scoped enqueue binds the job to its tenant connection", async () => {
  await withDatabase(async (repository) => {
    const job = await repository.enqueue({ orgId: ORG_A, customerId: CUSTOMER_A, connectionId: CONN_A, kind: KIND, payload: { hello: "a" } });
    assert.equal(job.connectionId, CONN_A);
    assert.equal(job.orgId, ORG_A);
    assert.equal(job.customerId, CUSTOMER_A);
  });
});

test("connection-scoped idempotency returns one durable job and rejects key substitution", async () => {
  await withDatabase(async (repository) => {
    const input = {
      orgId: ORG_A,
      customerId: CUSTOMER_A,
      connectionId: CONN_A,
      kind: "finops.data-export.ingest",
      payload: { manifestSha256: "a".repeat(64) },
      maxAttempts: 6,
      idempotencyKey: `finops-data-export:${"b".repeat(64)}`,
    };
    const first = await repository.enqueue(input, 1_000);
    const duplicate = await repository.enqueue(input, 2_000);
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.createdAt, first.createdAt);
    assert.match(first.id, /^job_[a-f0-9]{32}$/u);

    const otherTenant = await repository.enqueue({
      ...input,
      orgId: ORG_B,
      customerId: CUSTOMER_B,
      connectionId: CONN_B,
    }, 2_000);
    assert.notEqual(otherTenant.id, first.id);

    await assert.rejects(
      repository.enqueue(
        { ...input, payload: { manifestSha256: "c".repeat(64) } },
        3_000,
      ),
      (error) =>
        error instanceof JobQueueRepositoryError
        && error.code === "INVALID_STATE",
    );
  });
});

test("0052 rejects enqueuing against a connection owned by another tenant", async () => {
  await withDatabase(async (repository) => {
    // Connection A belongs to ORG_A; ORG_B must never be able to schedule work on it.
    await assert.rejects(
      () => repository.enqueue({ orgId: ORG_B, customerId: CUSTOMER_B, connectionId: CONN_A, kind: KIND, payload: {} }),
      (error) => error instanceof JobQueueRepositoryError && error.code === "SCOPE_NOT_FOUND",
    );
    // Correct org but wrong customer for the connection is also rejected.
    await assert.rejects(
      () => repository.enqueue({ orgId: ORG_A, customerId: CUSTOMER_B, connectionId: CONN_A, kind: KIND, payload: {} }),
      (error) => error instanceof JobQueueRepositoryError && error.code === "SCOPE_NOT_FOUND",
    );
  });
});

test("0052 connection-scoped lease only returns the owning tenant's job", async () => {
  await withDatabase(async (repository) => {
    await repository.enqueue({ orgId: ORG_A, customerId: CUSTOMER_A, connectionId: CONN_A, kind: KIND, payload: {} });
    assert.equal(await repository.leaseConnectionJob(ORG_B, CONN_A, KIND), null, "another org cannot lease CONN_A's job");
    assert.equal(await repository.leaseConnectionJob(ORG_A, CONN_B, KIND), null, "wrong connection in the right org leases nothing");
    const leased = await repository.leaseConnectionJob(ORG_A, CONN_A, KIND);
    assert.notEqual(leased, null);
    assert.equal(leased.connectionId, CONN_A);
    assert.equal(leased.attempt, 1);
  });
});

test("0052 connection-scoped complete/fail reject cross-tenant mutation", async () => {
  await withDatabase(async (repository) => {
    await repository.enqueue({ orgId: ORG_A, customerId: CUSTOMER_A, connectionId: CONN_A, kind: KIND, payload: {} });
    const leased = await repository.leaseConnectionJob(ORG_A, CONN_A, KIND);
    assert.notEqual(leased, null);
    // Wrong org cannot complete or fail the job.
    assert.equal(await repository.completeConnectionJob(ORG_B, CONN_A, leased.id), false);
    await assert.rejects(
      () => repository.failConnectionJob(ORG_B, CONN_A, leased.id, "cross-tenant"),
      (error) => error instanceof JobQueueRepositoryError && error.code === "INVALID_STATE",
    );
    // The owning tenant completes it.
    assert.equal(await repository.completeConnectionJob(ORG_A, CONN_A, leased.id), true);
  });
});
