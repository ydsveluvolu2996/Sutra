import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { JobQueueRepository } = await import("../db/job-queue-repository.ts");
const { buildJobHandlers, ensureRetentionSweepsEnqueued } = await import("../db/background-job-handlers.ts");
const { runDueBackgroundJobs } = await import("../lib/background-job-runner.ts");

const ORG_A = "org_handler_a";
const ORG_B = "org_handler_b";
const CUSTOMER_A = "cust_handler_a";
const CUSTOMER_B = "cust_handler_b";

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-handlers-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    // The retention-sweep handler resolves its repository via the ambient
    // getRawDb(), so bind the injected D1 database into the worker env stub.
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'handler-a', 'Handler A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'handler-b', 'Handler B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'handler-cust-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'handler-cust-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
    ]);
    await run(new JobQueueRepository(database), database);
  } finally {
    await miniflare.dispose();
  }
}

test("ensureRetentionSweepsEnqueued enqueues one sweep per org and is idempotent", async () => {
  await withDatabase(async (queue) => {
    const first = await ensureRetentionSweepsEnqueued(queue, [ORG_A, ORG_B]);
    assert.equal(first, 2);
    const sweepsA = (await queue.list(ORG_A, null)).filter((job) => job.kind === "retention-sweep");
    assert.equal(sweepsA.length, 1);
    assert.equal(sweepsA[0].customerId, null);
    assert.deepEqual(sweepsA[0].payload, { orgId: ORG_A });

    // Second call while the sweeps are still queued enqueues nothing.
    const second = await ensureRetentionSweepsEnqueued(queue, [ORG_A, ORG_B]);
    assert.equal(second, 0);
    assert.equal((await queue.list(ORG_A, null)).filter((job) => job.kind === "retention-sweep").length, 1);
  });
});

test("runDueBackgroundJobs drains retention-sweep jobs to succeeded", async () => {
  await withDatabase(async (queue) => {
    await ensureRetentionSweepsEnqueued(queue, [ORG_A]);
    const result = await runDueBackgroundJobs({
      queue,
      handlers: buildJobHandlers(),
      kinds: ["retention-sweep"],
      maxPerKind: 25,
    });
    const outcome = result.outcomes.find((entry) => entry.kind === "retention-sweep");
    assert.equal(outcome?.leased, 1);
    assert.equal(outcome?.succeeded, 1);
    assert.equal(result.totalFailed, 0);
    const sweeps = (await queue.list(ORG_A, null)).filter((job) => job.kind === "retention-sweep");
    assert.equal(sweeps.length, 1);
    assert.equal(sweeps[0].status, "succeeded");
  });
});
