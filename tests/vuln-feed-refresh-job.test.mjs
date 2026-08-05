import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

// The handler module imports `cloudflare:workers`; the loader resolves it. No
// database is needed — the handler takes injected deps and the tick takes an
// injected queue, so these are pure unit tests of the refresh + cadence logic.
register(new URL("./cloudflare-loader.mjs", import.meta.url));

const {
  runVulnFeedRefreshJob,
  ensureDueVulnFeedRefreshEnqueued,
  VULN_FEED_REFRESH_INTERVAL_MS,
} = await import("../db/background-job-handlers.ts");

const NOW = 1_785_000_000_000;
const handlerSource = await readFile(
  new URL("../db/background-job-handlers.ts", import.meta.url),
  "utf8",
);

function job(overrides = {}) {
  return { id: "job1", orgId: "org1", customerId: "cust1", connectionId: null, kind: "vuln-feed-refresh", payload: {}, attempt: 1, maxAttempts: 3, ...overrides };
}

/** Plan stub: refresh whatever the test names, always defer epss. */
function planStub(refresh, needsHostRun = true) {
  return () => ({
    decisions: [
      ...refresh.map((feed) => ({ feed, action: "refresh", reason: "stale", ...(feed === "nvd" ? { nvdWindowDays: 3 } : {}) })),
      { feed: "epss", action: "defer-to-host", reason: "bulk load" },
    ],
    summary: { refreshing: refresh.length, deferredToHost: 1, needsHostRun },
    disclaimer: "EPSS stays on the host schedule.",
  });
}

test("refreshes each planned feed and records rows written", async () => {
  const called = [];
  const audits = [];
  await runVulnFeedRefreshJob(job(), {
    readFeedState: async () => [],
    plan: planStub(["kev", "nvd"]),
    refreshFeed: async (feed, options) => { called.push(`${feed}:${options.nvdWindowDays ?? "-"}`); return feed === "kev" ? 1300 : 400; },
    audit: async (event) => { audits.push(event); },
  }, NOW);
  assert.deepEqual(called, ["kev:-", "nvd:3"]);
  assert.equal(audits[0]?.refreshed, 2);
  assert.equal(audits[0]?.rowsWritten, 1700);
});

test("the production refresh handler persists a redacted idempotent audit event", () => {
  assert.match(handlerSource, /action: "vulnerability\.feed_refresh\.completed"/u);
  assert.match(handlerSource, /requestId: `vuln\.feed_refresh:\$\{job\.id\}:\$\{job\.attempt\}`/u);
  assert.match(handlerSource, /failureCount/u);
  assert.doesNotMatch(
    handlerSource.slice(
      handlerSource.indexOf('action: "vulnerability.feed_refresh.completed"'),
      handlerSource.indexOf('action: "vulnerability.feed_refresh.completed"') + 1_200,
    ),
    /failures:/u,
    "raw upstream failures must not enter the durable audit metadata",
  );
});

test("EPSS is never fetched in-runtime, and needsHostRun is recorded every run", async () => {
  const called = [];
  const audits = [];
  await runVulnFeedRefreshJob(job(), {
    readFeedState: async () => [],
    plan: planStub(["kev"]),
    refreshFeed: async (feed) => { called.push(feed); return 10; },
    audit: async (event) => { audits.push(event); },
  }, NOW);
  assert.ok(!called.includes("epss"), "a deferred feed must never be fetched here");
  // Surfaced on every run so a stale EPSS mirror is discoverable from the audit
  // trail, not from rankings quietly looking wrong.
  assert.equal(audits[0]?.needsHostRun, true);
  assert.equal(audits[0]?.deferredToHost, 1);
  assert.match(String(audits[0]?.disclaimer), /host schedule/u);
});

test("one dead upstream does not block the other feed, and does not dead-letter the run", async () => {
  const audits = [];
  await runVulnFeedRefreshJob(job(), {
    readFeedState: async () => [],
    plan: planStub(["kev", "nvd"]),
    refreshFeed: async (feed) => {
      if (feed === "kev") throw new Error("cisa 503");
      return 250;
    },
    audit: async (event) => { audits.push(event); },
  }, NOW);
  // NVD still landed; the run did not throw.
  assert.equal(audits[0]?.refreshed, 1);
  assert.equal(audits[0]?.rowsWritten, 250);
  assert.equal(audits[0]?.failures.length, 1);
  assert.match(audits[0]?.failures[0], /kev: cisa 503/u);
});

test("throws only when EVERY attempted feed failed, after recording the failure", async () => {
  const audits = [];
  await assert.rejects(
    () => runVulnFeedRefreshJob(job(), {
      readFeedState: async () => [],
      plan: planStub(["kev", "nvd"]),
      refreshFeed: async () => { throw new Error("network down"); },
      audit: async (event) => { audits.push(event); },
    }, NOW),
    /vuln-feed-refresh-all-feeds-failed \(2\)/u,
  );
  // Evidence written BEFORE the throw, so the failure is not only visible as a
  // dead-lettered job.
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.refreshed, 0);
});

test("a nothing-to-do plan is not a failure", async () => {
  const called = [];
  await runVulnFeedRefreshJob(job(), {
    readFeedState: async () => [],
    plan: planStub([], false),
    refreshFeed: async (feed) => { called.push(feed); return 0; },
  }, NOW);
  assert.deepEqual(called, [], "all feeds fresh means no fetch");
});

test("a failing audit write does not lose the refresh", async () => {
  let rows = 0;
  await runVulnFeedRefreshJob(job(), {
    readFeedState: async () => [],
    plan: planStub(["kev"]),
    refreshFeed: async () => { rows = 1300; return rows; },
    audit: async () => { throw new Error("audit chain busy"); },
  }, NOW);
  assert.equal(rows, 1300, "evidence is best-effort; the refresh is not");
});

test("the mirror is GLOBAL: exactly one job is enqueued across all orgs", async () => {
  const enqueued = [];
  const queue = {
    list: async () => [],
    enqueue: async (entry) => { enqueued.push(entry); },
  };
  const count = await ensureDueVulnFeedRefreshEnqueued(
    queue,
    ["orgA", "orgB", "orgC"],
    async () => [{ customerId: "cust1" }],
    NOW,
  );
  // Refreshing per-org would multiply identical upstream fetches by tenant count.
  assert.equal(count, 1);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]?.kind, "vuln-feed-refresh");
});

test("never stacks: an in-flight refresh blocks another", async () => {
  for (const status of ["queued", "leased"]) {
    const queue = {
      list: async () => [{ kind: "vuln-feed-refresh", status, createdAt: NOW - 10 * 60 * 60 * 1000 }],
      enqueue: async () => { throw new Error("must not enqueue"); },
    };
    assert.equal(await ensureDueVulnFeedRefreshEnqueued(queue, ["orgA"], async () => [{ customerId: "c" }], NOW), 0);
  }
});

test("the cadence gate also acts as the dead-letter cooldown", async () => {
  // A recent run — even a dead one — is not retried on the very next tick.
  const recent = {
    list: async () => [{ kind: "vuln-feed-refresh", status: "dead", createdAt: NOW - 60_000 }],
    enqueue: async () => { throw new Error("must not enqueue"); },
  };
  assert.equal(await ensureDueVulnFeedRefreshEnqueued(recent, ["orgA"], async () => [{ customerId: "c" }], NOW), 0);

  const old = {
    list: async () => [{ kind: "vuln-feed-refresh", status: "dead", createdAt: NOW - VULN_FEED_REFRESH_INTERVAL_MS - 1 }],
    enqueue: async () => {},
  };
  assert.equal(await ensureDueVulnFeedRefreshEnqueued(old, ["orgA"], async () => [{ customerId: "c" }], NOW), 1);
});

test("an org with no readable customer is skipped, not fatal", async () => {
  const enqueued = [];
  const queue = { list: async () => [], enqueue: async (entry) => { enqueued.push(entry); } };
  const count = await ensureDueVulnFeedRefreshEnqueued(
    queue,
    ["emptyOrg", "goodOrg"],
    async (orgId) => (orgId === "emptyOrg" ? [] : [{ customerId: "cust9" }]),
    NOW,
  );
  assert.equal(count, 1);
  assert.equal(enqueued[0]?.orgId, "goodOrg");
});
