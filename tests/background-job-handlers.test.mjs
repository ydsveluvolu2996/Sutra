import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { JobQueueRepository } = await import("../db/job-queue-repository.ts");
const {
  buildJobHandlers,
  ensureRetentionSweepsEnqueued,
  runItsmSecretCleanupJob,
} = await import("../db/background-job-handlers.ts");
const { runDueBackgroundJobs } = await import("../lib/background-job-runner.ts");

const ORG_A = "org_handler_a";
const ORG_B = "org_handler_b";
const CUSTOMER_A = "cust_handler_a";
const CUSTOMER_B = "cust_handler_b";

test("every job kind emitted by the production ticks has a real handler", () => {
  const handlers = buildJobHandlers();
  for (const kind of [
    "retention-sweep",
    "finops-scheduled-report",
    "alert-evaluation",
    "finops-alert-sweep",
    "finops.data-export.ingest",
    "finops-source-collect",
    "finops-ta-organization-activate",
    "finops-ta-account-collect",
    "finops-ta-manifest-finalize",
    "finops-compute-optimizer-materialize",
    "agentless-teardown-sweep",
    "vuln-feed-refresh",
    "itsm-secret-cleanup",
  ]) {
    assert.equal(typeof handlers[kind], "function", `${kind} must never enter the queue unhandled`);
  }
});

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

test("ITSM secret cleanup failures are retried and later completed by the durable runner", async () => {
  await withDatabase(async (queue) => {
    const connectorId = "itc_00000000000000000000000000000001";
    const secretReference =
      `secret://itsm/${connectorId}/versions/00000000-0000-4000-8000-000000000001`;
    const job = await queue.enqueue({
      orgId: ORG_A,
      customerId: CUSTOMER_A,
      kind: "itsm-secret-cleanup",
      payload: { connectorId, secretReference },
      maxAttempts: 10,
    }, 1_000);
    let attempts = 0;
    const cleanupRepository = {
      async cleanupDeletedManagedSecret(scope, actualConnectorId, actualReference) {
        attempts += 1;
        assert.deepEqual(scope, { orgId: ORG_A, customerId: CUSTOMER_A });
        assert.equal(actualConnectorId, connectorId);
        assert.equal(actualReference, secretReference);
        if (attempts === 1) throw new Error("temporary-secrets-manager-failure");
      },
    };
    const handlers = {
      "itsm-secret-cleanup": (leased) =>
        runItsmSecretCleanupJob(leased, cleanupRepository),
    };

    const failed = await runDueBackgroundJobs({
      queue,
      handlers,
      kinds: ["itsm-secret-cleanup"],
      maxPerKind: 1,
      now: () => 1_000,
    });
    assert.equal(failed.outcomes[0].retried, 1);
    assert.equal(failed.totalSucceeded, 0);

    const recovered = await runDueBackgroundJobs({
      queue,
      handlers,
      kinds: ["itsm-secret-cleanup"],
      maxPerKind: 1,
      now: () => 10_000,
    });
    assert.equal(recovered.outcomes[0].succeeded, 1);
    assert.equal(attempts, 2);
    const stored = (await queue.list(ORG_A, CUSTOMER_A)).find((candidate) => candidate.id === job.id);
    assert.equal(stored?.status, "succeeded");
    assert.equal(stored?.attempt, 2);
    assert.equal(stored?.maxAttempts, 10);
  });
});
