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
  runUptimeProbeJob,
  ensureUptimeProbeEnqueued,
  UPTIME_PROBE_JOB_KIND,
} = await import("../lib/uptime-probe-handler.ts");
const { JobQueueRepository } = await import("../db/job-queue-repository.ts");

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

test("listRecent honours the since floor so old samples roll off the window", async () => {
  await withDatabase(async (database) => {
    const repo = new UptimeRepository(database);
    await repo.recordSamples([{ component: "collector", healthy: true, detail: null }], T0 - 40 * 24 * 60 * MINUTE);
    await repo.recordSamples([{ component: "collector", healthy: true, detail: null }], T0 - 5 * MINUTE);
    const recent = await repo.listRecent({ sinceMs: T0 - 60 * MINUTE }, T0);
    assert.equal(recent.length, 1);
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
  await runUptimeProbeJob(
    { id: "j", orgId: "org_carrier", customerId: null, kind: UPTIME_PROBE_JOB_KIND, payload: {}, attempt: 1, maxAttempts: 3 },
    {
      probeDatabase: async () => true,
      probeCollector: async () => { throw new Error("broker unreachable"); },
      record: async (samples) => { recorded.push(...samples); },
      now: () => T0,
    },
  );
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

test("ensureUptimeProbeEnqueued hosts one probe on the lowest-id carrier org and is idempotent", async () => {
  await withDatabase(async (database) => {
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES ('org_a', 'up-a', 'Up A', 'active')"),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES ('org_b', 'up-b', 'Up B', 'active')"),
    ]);
    const queue = new JobQueueRepository(database);
    const orgIds = ["org_b", "org_a"]; // deliberately unsorted; the tick picks org_a
    const first = await ensureUptimeProbeEnqueued(queue, orgIds, T0);
    assert.equal(first, 1);
    const second = await ensureUptimeProbeEnqueued(queue, orgIds, T0 + MINUTE);
    assert.equal(second, 0);
    const onCarrier = (await queue.list("org_a", null)).filter((job) => job.kind === UPTIME_PROBE_JOB_KIND);
    assert.equal(onCarrier.length, 1);
    // With no active org there is nothing to host the system probe.
    assert.equal(await ensureUptimeProbeEnqueued(queue, [], T0), 0);
  });
});
