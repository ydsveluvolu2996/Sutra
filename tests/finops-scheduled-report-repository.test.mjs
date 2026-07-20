import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { FinopsScheduledReportRepository, FinopsScheduledReportRepositoryError } = await import("../db/finops-scheduled-report-repository.ts");
const { nextRunAtIso } = await import("../lib/finops-report-schedule.ts");

const ORG_A = "org_sr_a";
const ORG_B = "org_sr_b";
const CUSTOMER_A = "cust_sr_a";
const CUSTOMER_B = "cust_sr_b";
const SCOPE_A = { orgId: ORG_A, customerId: CUSTOMER_A };
const SCOPE_B = { orgId: ORG_B, customerId: CUSTOMER_B };
const CONN_A = `conn_${"a".repeat(32)}`;
const WEBHOOK = "https://hooks.example.test/finops";
const CREATED_BY = "user_sr_a";
const T0 = Date.parse("2026-07-01T00:00:00.000Z");

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-sr-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'sr-a', 'SR A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'sr-b', 'SR B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'sr-cust-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'sr-cust-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
    ]);
    await run(new FinopsScheduledReportRepository(database));
  } finally {
    await miniflare.dispose();
  }
}

test("0038 migration applies; save computes next run by cadence and upserts by name", async () => {
  await withDatabase(async (repo) => {
    const created = await repo.save(
      SCOPE_A,
      { name: "weekly-costs", connectionId: CONN_A, cadence: "weekly", deliveryKind: "webhook", deliveryTarget: WEBHOOK },
      CREATED_BY,
      T0,
    );
    assert.equal(created.name, "weekly-costs");
    assert.equal(created.cadence, "weekly");
    assert.equal(created.deliveryKind, "webhook");
    assert.equal(created.enabled, true);
    assert.equal(created.lastRunAt, null);
    // Concrete cadence arithmetic (not just self-comparison): weekly is +7 days.
    assert.equal(created.nextRunAt, "2026-07-08T00:00:00.000Z");
    assert.equal(created.nextRunAt, nextRunAtIso("weekly", T0));

    // Same name -> update in place; cadence change reschedules the next run.
    const updated = await repo.save(
      SCOPE_A,
      { name: "weekly-costs", connectionId: CONN_A, cadence: "monthly", deliveryKind: "email", deliveryTarget: "ops@example.test" },
      CREATED_BY,
      T0,
    );
    assert.equal(updated.cadence, "monthly");
    assert.equal(updated.deliveryKind, "email");
    assert.equal(updated.deliveryTarget, "ops@example.test");
    // Monthly is the same calendar day one month on (UTC).
    assert.equal(updated.nextRunAt, "2026-08-01T00:00:00.000Z");
    assert.equal(updated.nextRunAt, nextRunAtIso("monthly", T0));
    assert.equal((await repo.list(SCOPE_A)).length, 1);
  });
});

test("monthly cadence clamps to the last valid day of the target month", () => {
  // 2026-01-31 has no 31st the next month; February clamps to the 28th.
  assert.equal(nextRunAtIso("monthly", Date.parse("2026-01-31T09:30:00.000Z")), "2026-02-28T09:30:00.000Z");
  // Year rollover is handled in UTC.
  assert.equal(nextRunAtIso("monthly", Date.parse("2026-12-15T00:00:00.000Z")), "2027-01-15T00:00:00.000Z");
});

test("get/list/setEnabled/delete are tenant-scoped", async () => {
  await withDatabase(async (repo) => {
    const created = await repo.save(
      SCOPE_A,
      { name: "monthly", connectionId: CONN_A, cadence: "monthly", deliveryKind: "webhook", deliveryTarget: WEBHOOK },
      CREATED_BY,
      T0,
    );
    // Cross-tenant reads/writes see nothing.
    assert.equal(await repo.get(SCOPE_B, created.id), null);
    assert.deepEqual(await repo.list(SCOPE_B), []);
    assert.equal(await repo.setEnabled(SCOPE_B, created.id, false), false);
    assert.equal(await repo.delete(SCOPE_B, created.id), false);

    assert.equal(await repo.setEnabled(SCOPE_A, created.id, false), true);
    assert.equal((await repo.get(SCOPE_A, created.id)).enabled, false);
    assert.equal(await repo.delete(SCOPE_A, created.id), true);
    assert.equal(await repo.get(SCOPE_A, created.id), null);
  });
});

test("listDue is a system-wide scan of enabled, past-due schedules; markRun advances", async () => {
  await withDatabase(async (repo) => {
    const a = await repo.save(
      SCOPE_A,
      { name: "weekly", connectionId: CONN_A, cadence: "weekly", deliveryKind: "webhook", deliveryTarget: WEBHOOK },
      CREATED_BY,
      T0,
    );
    await repo.save(
      SCOPE_B,
      { name: "weekly-b", connectionId: CONN_A, cadence: "weekly", deliveryKind: "webhook", deliveryTarget: WEBHOOK },
      "user_sr_b",
      T0,
    );
    // At T0 nothing is due yet (next run is a week out).
    assert.deepEqual(await repo.listDue(T0), []);
    // Eight days later, both tenants' schedules are due — a cross-tenant scan.
    const due = await repo.listDue(T0 + 8 * 24 * 60 * 60 * 1000);
    assert.equal(due.length, 2);
    assert.deepEqual([...new Set(due.map((row) => row.orgId))].sort(), [ORG_A, ORG_B]);

    // Advancing a schedule removes it from the due set and records the run.
    const ranAt = T0 + 8 * 24 * 60 * 60 * 1000;
    const nextRun = nextRunAtIso("weekly", ranAt);
    assert.equal(await repo.markRun(a.id, ranAt, nextRun), true);
    const afterAdvance = await repo.listDue(ranAt);
    assert.deepEqual(afterAdvance.map((row) => row.orgId), [ORG_B]);
    const reloaded = await repo.get(SCOPE_A, a.id);
    assert.equal(reloaded.lastRunAt, new Date(ranAt).toISOString());
    assert.equal(reloaded.nextRunAt, nextRun);

    // A disabled schedule is never due.
    await repo.setEnabled(SCOPE_B, due.find((row) => row.orgId === ORG_B).id, false);
    assert.deepEqual(await repo.listDue(ranAt), []);
  });
});

test("validation rejects bad fields and SSRF/non-https webhook targets", async () => {
  await withDatabase(async (repo) => {
    const base = { name: "ok", connectionId: CONN_A, cadence: "weekly", deliveryKind: "webhook", deliveryTarget: WEBHOOK };
    const bad = [
      { ...base, name: "" },
      { ...base, connectionId: "conn_bad" },
      { ...base, cadence: "daily" },
      { ...base, deliveryKind: "sms" },
      { ...base, deliveryTarget: "http://hooks.example.test/x" }, // not https
      { ...base, deliveryTarget: "https://127.0.0.1/x" },         // SSRF loopback
      { ...base, deliveryTarget: "https://hooks.internal/x" },    // internal host
      { ...base, deliveryKind: "email", deliveryTarget: "not-an-email" },
    ];
    for (const input of bad) {
      await assert.rejects(
        repo.save(SCOPE_A, input, CREATED_BY, T0),
        (error) => error instanceof FinopsScheduledReportRepositoryError && error.code === "INVALID_INPUT",
        `expected ${JSON.stringify(input)} to be rejected`,
      );
    }
    // A customer not owned by the named org cannot be written.
    await assert.rejects(
      repo.save({ orgId: ORG_B, customerId: CUSTOMER_A }, base, CREATED_BY, T0),
      (error) => error instanceof FinopsScheduledReportRepositoryError && error.code === "SCOPE_NOT_FOUND",
    );
  });
});
