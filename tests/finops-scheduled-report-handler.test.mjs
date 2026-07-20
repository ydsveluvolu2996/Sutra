import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { FinopsScheduledReportRepository } = await import("../db/finops-scheduled-report-repository.ts");
const { FinopsWorkspaceRepository } = await import("../db/finops-workspace-repository.ts");
const { JobQueueRepository } = await import("../db/job-queue-repository.ts");
const { runScheduledReportJob, ensureDueScheduledReportsEnqueued } = await import("../db/background-job-handlers.ts");
const { nextRunAtIso } = await import("../lib/finops-report-schedule.ts");

const ORG_A = "org_srh_a";
const CUSTOMER_A = "cust_srh_a";
const SCOPE_A = { orgId: ORG_A, customerId: CUSTOMER_A };
const CONN_A = `conn_${"c".repeat(32)}`;
const WEBHOOK = "https://hooks.example.test/finops";
const T0 = Date.parse("2026-07-01T00:00:00.000Z");
const GENERATED_AT = Date.parse("2026-07-15T00:00:00.000Z");

function line(overrides) {
  return {
    lineItemId: "li-1",
    usageAccountId: "111111111111",
    service: "AmazonEC2",
    chargeCategory: "Usage",
    usageStartIso: "2026-07-01T00:00:00.000Z",
    amountMicros: "10000000",
    currency: "USD",
    tags: {},
    ...overrides,
  };
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-srh-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'srh-a', 'SRH A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'srh-cust-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
    ]);
    await run({
      database,
      reports: new FinopsScheduledReportRepository(database),
      finops: new FinopsWorkspaceRepository(database),
      queue: new JobQueueRepository(database),
    });
  } finally {
    await miniflare.dispose();
  }
}

function jobFor(schedule, overrides = {}) {
  return {
    id: `job_${"1".repeat(32)}`,
    orgId: ORG_A,
    customerId: CUSTOMER_A,
    kind: "finops-scheduled-report",
    attempt: 1,
    maxAttempts: 5,
    payload: {
      scheduleId: schedule.id,
      connectionId: CONN_A,
      name: schedule.name,
      deliveryKind: schedule.deliveryKind,
      deliveryTarget: schedule.deliveryTarget,
      ...overrides,
    },
  };
}

test("due -> render -> deliver: builds the latest-period summary and hands it to the injected transport", async () => {
  await withDatabase(async ({ reports, finops }) => {
    const schedule = await reports.save(
      SCOPE_A,
      { name: "weekly", connectionId: CONN_A, cadence: "weekly", deliveryKind: "webhook", deliveryTarget: WEBHOOK },
      "user_srh_a",
      T0,
    );
    await finops.replacePeriod(SCOPE_A, CONN_A, "2026-07", [
      line({}),
      line({ lineItemId: "li-2", service: "AmazonS3", amountMicros: "4000000" }),
    ]);
    await finops.saveBudget(SCOPE_A, { name: "cap", currency: "USD", limitMicros: "20000000" }, "user_srh_a");

    const captured = [];
    await runScheduledReportJob(jobFor(schedule), {
      scheduleRepo: reports,
      finopsRepo: finops,
      deliver: async (kind, target, envelope) => {
        captured.push({ kind, target, envelope });
        return { delivered: true, transport: "webhook" };
      },
      now: () => GENERATED_AT,
    });

    assert.equal(captured.length, 1);
    const { kind, target, envelope } = captured[0];
    assert.equal(kind, "webhook");
    assert.equal(target, WEBHOOK);
    assert.equal(envelope.schema, "sutra.finops-scheduled-report.v1");
    assert.equal(envelope.period, "2026-07");
    assert.equal(envelope.lineCount, 2);
    // 10000000 + 4000000 = 14000000 total USD micros, never summed across currencies.
    assert.deepEqual(envelope.currencyTotals, [{ currency: "USD", totalMicros: "14000000" }]);
    assert.deepEqual(envelope.budgetStates, [{ name: "cap", state: "under", spentMicros: "14000000" }]);
    assert.equal(envelope.generatedAt, new Date(GENERATED_AT).toISOString());
  });
});

test("a configured transport that rejects the report throws so the queue retries", async () => {
  await withDatabase(async ({ reports, finops }) => {
    const schedule = await reports.save(
      SCOPE_A,
      { name: "weekly", connectionId: CONN_A, cadence: "weekly", deliveryKind: "webhook", deliveryTarget: WEBHOOK },
      "user_srh_a",
      T0,
    );
    await assert.rejects(
      runScheduledReportJob(jobFor(schedule), {
        scheduleRepo: reports,
        finopsRepo: finops,
        deliver: async () => ({ delivered: false, transport: "webhook" }),
        now: () => GENERATED_AT,
      }),
      /delivery via webhook was not accepted/u,
    );
  });
});

test("an unconfigured transport is an honest non-delivery and does not throw", async () => {
  await withDatabase(async ({ reports, finops }) => {
    const schedule = await reports.save(
      SCOPE_A,
      { name: "weekly", connectionId: CONN_A, cadence: "weekly", deliveryKind: "email", deliveryTarget: "ops@example.test" },
      "user_srh_a",
      T0,
    );
    await runScheduledReportJob(jobFor(schedule), {
      scheduleRepo: reports,
      finopsRepo: finops,
      deliver: async () => ({ delivered: false, transport: "none" }),
      now: () => GENERATED_AT,
    });
  });
});

test("a disabled schedule is a no-op: nothing is rendered or delivered", async () => {
  await withDatabase(async ({ reports, finops }) => {
    const schedule = await reports.save(
      SCOPE_A,
      { name: "weekly", connectionId: CONN_A, cadence: "weekly", deliveryKind: "webhook", deliveryTarget: WEBHOOK },
      "user_srh_a",
      T0,
    );
    await reports.setEnabled(SCOPE_A, schedule.id, false);
    let delivered = false;
    await runScheduledReportJob(jobFor(schedule), {
      scheduleRepo: reports,
      finopsRepo: finops,
      deliver: async () => { delivered = true; return { delivered: true, transport: "webhook" }; },
      now: () => GENERATED_AT,
    });
    assert.equal(delivered, false);
  });
});

test("the scheduler tick advances due schedules and enqueues a tenant-scoped job", async () => {
  await withDatabase(async ({ reports, queue }) => {
    const schedule = await reports.save(
      SCOPE_A,
      { name: "weekly", connectionId: CONN_A, cadence: "weekly", deliveryKind: "webhook", deliveryTarget: WEBHOOK },
      "user_srh_a",
      T0,
    );
    const dueAt = T0 + 8 * 24 * 60 * 60 * 1000;
    const enqueued = await ensureDueScheduledReportsEnqueued(queue, reports, dueAt);
    assert.equal(enqueued, 1);

    // The schedule was advanced (no longer due at dueAt).
    const advanced = await reports.get(SCOPE_A, schedule.id);
    assert.equal(advanced.lastRunAt, new Date(dueAt).toISOString());
    assert.equal(advanced.nextRunAt, nextRunAtIso("weekly", dueAt));
    assert.deepEqual(await reports.listDue(dueAt), []);

    // A tenant-scoped job was queued for the handler kind.
    const jobs = (await queue.list(ORG_A, CUSTOMER_A)).filter((job) => job.kind === "finops-scheduled-report");
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].payload.scheduleId, schedule.id);
    assert.equal(jobs[0].payload.deliveryTarget, WEBHOOK);

    // Idempotent within the same due window: already advanced, so nothing new.
    assert.equal(await ensureDueScheduledReportsEnqueued(queue, reports, dueAt), 0);
  });
});
