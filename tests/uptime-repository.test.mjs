import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { UptimeRepository, UptimeRepositoryError } = await import("../db/uptime-repository.ts");
const {
  runPlatformUptimeProbeTick,
  runUptimeProbeJob,
  UPTIME_PROBE_INTERVAL_MS,
  UPTIME_RETENTION_MS,
  UPTIME_PROBE_JOB_KIND,
} = await import("../lib/uptime-probe-handler.ts");

const root = resolve(import.meta.dirname, "..");
// The parent registers migration 0044 in the runtime appliers; until then the
// table is not part of ensureRuntimeSchema, so this test applies the same SQL
// directly to keep the repository test self-contained.
const migrationSql = await readFile(resolve(root, "drizzle/0044_uptime_samples.sql"), "utf8");

async function applyUptimeMigration(database) {
  const statements = migrationSql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) {
    await database.prepare(statement).run();
  }
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-uptime-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await applyUptimeMigration(database);
    await run(database);
  } finally {
    await miniflare.dispose();
  }
}

const T0 = Date.parse("2026-07-21T12:00:00.000Z");
const MINUTE = 60_000;

test("recordSamples persists one row per component and listRecent reads them back newest-first", async () => {
  await withDatabase(async (database) => {
    const repo = new UptimeRepository(database);
    await repo.recordSamples(
      [
        { component: "web-app", healthy: true, detail: "runtime" },
        { component: "database", healthy: false, detail: "SELECT 1 failed" },
      ],
      T0 - 10 * MINUTE,
    );
    await repo.recordSamples([{ component: "database", healthy: true, detail: "recovered" }], T0);

    const all = await repo.listRecent({}, T0);
    assert.equal(all.length, 3);
    // Newest first: the recovered database sample leads.
    assert.equal(all[0].component, "database");
    assert.equal(all[0].healthy, true);

    const dbOnly = await repo.listRecent({ component: "database" }, T0);
    assert.equal(dbOnly.length, 2);
    assert.equal(dbOnly[0].detail, "recovered");
  });
});

test("recordSamples rejects an unknown component before any write", async () => {
  await withDatabase(async (database) => {
    const repo = new UptimeRepository(database);
    await assert.rejects(
      repo.recordSamples([{ component: "not-real", healthy: true, detail: null }], T0),
      (error) => error instanceof UptimeRepositoryError && error.code === "INVALID_INPUT",
    );
    const rows = await database.prepare("SELECT COUNT(*) AS total FROM uptime_samples").first();
    assert.equal(Number(rows.total), 0);
  });
});

test("recordSamples is idempotent for one component and observed timestamp", async () => {
  await withDatabase(async (database) => {
    const repo = new UptimeRepository(database);
    await repo.recordSamples([{ component: "web-app", healthy: true, detail: "first" }], T0);
    await repo.recordSamples([{ component: "web-app", healthy: false, detail: "racing duplicate" }], T0);
    const rows = await repo.listRecent({ component: "web-app" }, T0);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].healthy, true);
    assert.equal(rows[0].detail, "first");
  });
});

test("listRecent honours the since floor so old samples roll off the window", async () => {
  await withDatabase(async (database) => {
    const repo = new UptimeRepository(database);
    await repo.recordSamples([{ component: "collector", healthy: true, detail: null }], T0 - 40 * 24 * 60 * MINUTE);
    await repo.recordSamples([{ component: "collector", healthy: true, detail: null }], T0 - 5 * MINUTE);
    const recent = await repo.listRecent({ sinceMs: T0 - 60 * MINUTE }, T0);
    assert.equal(recent.length, 1);
  });
});

test("retention pruning keeps the 31-day history bounded", async () => {
  await withDatabase(async (database) => {
    const repo = new UptimeRepository(database);
    await repo.recordSamples([{ component: "collector", healthy: true, detail: "old" }], T0 - UPTIME_RETENTION_MS - MINUTE);
    await repo.recordSamples([{ component: "collector", healthy: true, detail: "current" }], T0);
    assert.equal(await repo.pruneBefore(T0 - UPTIME_RETENTION_MS), 1);
    const remaining = await repo.listRecent({ component: "collector", sinceMs: 0 }, T0);
    assert.deepEqual(remaining.map((sample) => sample.detail), ["current"]);
  });
});

test("summarize derives an honest report: recorded component measured, unobserved component unknown", async () => {
  await withDatabase(async (database) => {
    const repo = new UptimeRepository(database);
    await repo.recordSamples([{ component: "web-app", healthy: true, detail: "up" }], T0 - MINUTE);
    const report = await repo.summarize(T0);
    const webApp = report.components.find((entry) => entry.component.key === "web-app");
    const collector = report.components.find((entry) => entry.component.key === "collector");
    assert.equal(webApp.status, "operational");
    assert.equal(collector.status, "unknown");
    assert.equal(collector.windows.every((window) => window.uptimePercent === null), true);
  });
});

test("runUptimeProbeJob records four component samples, turning a failed check into an unhealthy sample", async () => {
  const recorded = [];
  let recordedAt = null;
  await runUptimeProbeJob(
    { id: "j", orgId: "org_carrier", customerId: null, kind: UPTIME_PROBE_JOB_KIND, payload: {}, attempt: 1, maxAttempts: 3 },
    {
      probeDatabase: async () => true,
      probeCollector: async () => { throw new Error("broker unreachable"); },
      record: async (samples, observedAtMs) => {
        recorded.push(...samples);
        recordedAt = observedAtMs;
        return samples.length;
      },
      now: () => T0,
    },
  );
  assert.equal(recordedAt, T0);
  assert.equal(recorded.length, 4);
  const byComponent = Object.fromEntries(recorded.map((sample) => [sample.component, sample]));
  assert.equal(byComponent["web-app"].healthy, true);
  assert.equal(byComponent["job-runner"].healthy, true);
  assert.equal(byComponent["database"].healthy, true);
  // A thrown collector check is recorded as unhealthy, not swallowed or thrown.
  assert.equal(byComponent["collector"].healthy, false);
});

test("runUptimeProbeJob rethrows only when persistence fails, so the queue can retry", async () => {
  await assert.rejects(
    runUptimeProbeJob(
      { id: "j", orgId: "org_carrier", customerId: null, kind: UPTIME_PROBE_JOB_KIND, payload: {}, attempt: 1, maxAttempts: 3 },
      {
        probeDatabase: async () => false,
        probeCollector: async () => true,
        record: async () => { throw new Error("write failed"); },
        now: () => T0,
      },
    ),
    /write failed/u,
  );
});

test("platform uptime tick records without a tenant and only once per ten-minute bucket", async () => {
  await withDatabase(async (database) => {
    const repo = new UptimeRepository(database);
    let now = T0 + MINUTE;
    const firstSlot = Math.floor(now / UPTIME_PROBE_INTERVAL_MS) * UPTIME_PROBE_INTERVAL_MS;
    // A future sample and a partial current slot must not suppress the missing
    // platform measurements. The tick repairs the partial slot idempotently.
    await repo.recordSamples(
      [{ component: "collector", healthy: true, detail: "future" }],
      now + 2 * UPTIME_PROBE_INTERVAL_MS,
    );
    await repo.recordSamples(
      [{ component: "web-app", healthy: true, detail: "partial" }],
      now,
      firstSlot,
    );
    assert.equal(await repo.hasCompleteProbeSlot(firstSlot), false);
    const deps = {
      probeDatabase: async () => true,
      probeCollector: async () => true,
      record: (samples, observedAtMs, idempotencySlotMs) =>
        repo.recordSamples(samples, observedAtMs, idempotencySlotMs),
      hasCompleteProbeSlot: (slotMs) => repo.hasCompleteProbeSlot(slotMs),
      pruneBefore: (cutoffMs) => repo.pruneBefore(cutoffMs),
      now: () => now,
    };

    const first = await runPlatformUptimeProbeTick(deps);
    assert.equal(first.recorded, true);
    assert.equal(first.observedAt, new Date(now).toISOString());
    assert.equal(await repo.hasCompleteProbeSlot(firstSlot), true);
    const firstSlotRows = (await repo.listRecent({}, now)).filter(
      (sample) => sample.observedAt === new Date(now).toISOString(),
    );
    assert.equal(firstSlotRows.length, 4);
    const sameBucket = await runPlatformUptimeProbeTick(deps);
    assert.equal(sameBucket.recorded, false);
    assert.equal((await repo.listRecent({}, now)).length, 5);

    now += UPTIME_PROBE_INTERVAL_MS;
    const nextBucket = await runPlatformUptimeProbeTick(deps);
    assert.equal(nextBucket.recorded, true);
    assert.equal((await repo.listRecent({}, now)).length, 9);

    const organizations = await database.prepare("SELECT COUNT(*) AS total FROM organizations").first();
    assert.equal(Number(organizations.total), 0, "platform metrics must not create or require a tenant");
  });
});
