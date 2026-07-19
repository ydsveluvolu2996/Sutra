import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { JobQueueRepository, JobQueueRepositoryError } = await import("../db/job-queue-repository.ts");
const ORG_A = "org_job_a";
const ORG_B = "org_job_b";
const CUSTOMER_A = "cust_job_a";
const CUSTOMER_B = "cust_job_b";

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-jobs-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'job-a', 'Job A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'job-b', 'Job B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'job-cust-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'job-cust-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
    ]);
    await run(new JobQueueRepository(database));
  } finally {
    await miniflare.dispose();
  }
}

test("0031 queue leases exclusively and isolates organization listings", async () => {
  await withDatabase(async (repository) => {
    const now = 1_000_000;
    const queued = await repository.enqueue({
      orgId: ORG_A, customerId: CUSTOMER_A, kind: "itsm-dispatch", payload: { caseId: "case_a" }, maxAttempts: 3,
    }, now);
    const [first, second] = await Promise.all([
      repository.lease(ORG_A, "itsm-dispatch", now),
      repository.lease(ORG_A, "itsm-dispatch", now),
    ]);
    assert.equal([first, second].filter(Boolean).length, 1);
    const leased = first ?? second;
    assert.equal(leased?.id, queued.id);
    assert.equal(leased?.attempt, 1);
    assert.deepEqual(await repository.list(ORG_B, CUSTOMER_B), []);
    assert.equal((await repository.list(ORG_A, CUSTOMER_A)).length, 1);
  });
});

test("queue retries with backoff then dead-letters at max attempts", async () => {
  await withDatabase(async (repository) => {
    const now = 2_000_000;
    const queued = await repository.enqueue({
      orgId: ORG_A, customerId: CUSTOMER_A, kind: "retention-sweep", payload: {}, maxAttempts: 2,
    }, now);
    const first = await repository.lease(ORG_A, "retention-sweep", now);
    assert.equal(first?.id, queued.id);
    const retry = await repository.fail(ORG_A, queued.id, "temporary", now);
    assert.equal(retry.status, "queued");
    assert.equal(retry.runAfter, now + 5_000);
    assert.equal(await repository.lease(ORG_A, "retention-sweep", now + 4_999), null);
    const second = await repository.lease(ORG_A, "retention-sweep", now + 5_000);
    assert.equal(second?.attempt, 2);
    const dead = await repository.fail(ORG_A, queued.id, "permanent", now + 5_000);
    assert.equal(dead.status, "dead_letter");
    assert.equal(await repository.lease(ORG_A, "retention-sweep", now + 10_000), null);
  });
});

test("queue rejects customer theft across organizations", async () => {
  await withDatabase(async (repository) => {
    await assert.rejects(
      repository.enqueue({ orgId: ORG_B, customerId: CUSTOMER_A, kind: "stolen-job", payload: {} }),
      (error) => error instanceof JobQueueRepositoryError && error.code === "SCOPE_NOT_FOUND",
    );
  });
});
