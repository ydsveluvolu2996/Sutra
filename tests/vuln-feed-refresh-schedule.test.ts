import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MAX_ROWS_IN_RUNTIME,
  feedsToRefresh,
  planVulnFeedRefresh,
  type FeedState,
} from "../lib/vuln-feed-refresh-schedule.ts";

const NOW = 1_785_000_000_000;
const HOUR = 3_600_000;

function state(feed: FeedState["feed"], ageHours: number | null, rowCount = 1_000): FeedState {
  return { feed, asOfMs: ageHours === null ? null : NOW - ageHours * HOUR, rowCount };
}

function decision(plan: ReturnType<typeof planVulnFeedRefresh>, feed: string) {
  return plan.decisions.find((entry) => entry.feed === feed);
}

test("a stale KEV feed is refreshed in-runtime — it is the highest-signal feed", () => {
  const plan = planVulnFeedRefresh([state("kev", 30), state("nvd", 2), state("epss", 2)], {}, NOW);
  assert.equal(decision(plan, "kev")?.action, "refresh");
  assert.match(decision(plan, "kev")?.reason ?? "", /stale \(30h old\)/u);
  assert.deepEqual(feedsToRefresh(plan), ["kev"]);
});

test("EPSS is ALWAYS deferred to the host, fresh or stale — it is a bulk load", () => {
  const fresh = planVulnFeedRefresh([state("epss", 1)], {}, NOW);
  assert.equal(decision(fresh, "epss")?.action, "defer-to-host");
  const stale = planVulnFeedRefresh([state("epss", 200)], {}, NOW);
  assert.equal(decision(stale, "epss")?.action, "defer-to-host");
  // Never planned in-runtime under any condition: ~349k rows against an adapter
  // that opens a connection per query is the wrong place for a bulk load.
  assert.ok(!feedsToRefresh(stale).includes("epss"));
});

test("a stale deferred feed raises needsHostRun so the operator learns from the audit trail", () => {
  const stale = planVulnFeedRefresh([state("kev", 1), state("nvd", 1), state("epss", 100)], {}, NOW);
  assert.equal(stale.summary.needsHostRun, true);
  const fresh = planVulnFeedRefresh([state("kev", 1), state("nvd", 1), state("epss", 1)], {}, NOW);
  assert.equal(fresh.summary.needsHostRun, false);
});

test("a never-ingested feed is stale, not skipped for lack of a baseline", () => {
  const plan = planVulnFeedRefresh([state("kev", null), state("nvd", null)], {}, NOW);
  assert.equal(decision(plan, "kev")?.action, "refresh");
  assert.match(decision(plan, "kev")?.reason ?? "", /never ingested/u);
  assert.equal(decision(plan, "nvd")?.action, "refresh");
});

test("a completely absent feed state still yields a decision — feeds are never dropped", () => {
  const plan = planVulnFeedRefresh([], {}, NOW);
  assert.equal(plan.decisions.length, 3);
  assert.deepEqual(plan.decisions.map((entry) => entry.feed), ["kev", "nvd", "epss"]);
  assert.equal(decision(plan, "kev")?.action, "refresh");
  assert.equal(decision(plan, "epss")?.action, "defer-to-host");
});

test("a fresh feed is skipped with its age stated", () => {
  const plan = planVulnFeedRefresh([state("kev", 3), state("nvd", 3)], {}, NOW);
  assert.equal(decision(plan, "kev")?.action, "skip");
  assert.match(decision(plan, "kev")?.reason ?? "", /fresh \(3h old\)/u);
  assert.deepEqual(feedsToRefresh(plan), []);
});

test("a small feed that grew past the row ceiling is deferred, not attempted", () => {
  const plan = planVulnFeedRefresh(
    [state("kev", 48, DEFAULT_MAX_ROWS_IN_RUNTIME + 1)],
    {},
    NOW,
  );
  // Guards against an upstream that suddenly grows turning this into a bulk load.
  assert.equal(decision(plan, "kev")?.action, "defer-to-host");
  assert.match(decision(plan, "kev")?.reason ?? "", /exceeds the 25000-row/u);
  assert.equal(plan.summary.needsHostRun, true);
});

test("NVD carries a bounded window; the window is clamped", () => {
  const normal = planVulnFeedRefresh([state("nvd", 48)], { nvdWindowDays: 7 }, NOW);
  const nvd = decision(normal, "nvd");
  assert.equal(nvd?.action, "refresh");
  assert.equal(nvd?.action === "refresh" ? nvd.nvdWindowDays : null, 7);
  const clamped = planVulnFeedRefresh([state("nvd", 48)], { nvdWindowDays: 9999 }, NOW);
  const c = decision(clamped, "nvd");
  assert.equal(c?.action === "refresh" ? c.nvdWindowDays : null, 120);
  const floored = planVulnFeedRefresh([state("nvd", 48)], { nvdWindowDays: 0 }, NOW);
  const f = decision(floored, "nvd");
  assert.equal(f?.action === "refresh" ? f.nvdWindowDays : null, 1);
});

test("the staleness threshold is configurable and floored so it cannot be disabled", () => {
  const tight = planVulnFeedRefresh([state("kev", 2)], { staleAfterMs: HOUR }, NOW);
  assert.equal(decision(tight, "kev")?.action, "refresh");
  // A zero/negative threshold would make everything permanently stale; floored.
  const floored = planVulnFeedRefresh([state("kev", 0)], { staleAfterMs: -1 }, NOW);
  assert.equal(decision(floored, "kev")?.action, "skip");
});

test("the disclaimer names the runtime reason, so it can be repeated verbatim", () => {
  const plan = planVulnFeedRefresh([], {}, NOW);
  assert.match(plan.disclaimer, /EPSS/u);
  assert.match(plan.disclaimer, /one connection\s*per query/u);
  assert.match(plan.disclaimer, /partially updated while appearing fresh/u);
});

test("planning is deterministic and order-independent", () => {
  const states = [state("epss", 100), state("kev", 30), state("nvd", 2)];
  const first = planVulnFeedRefresh(states, {}, NOW);
  const second = planVulnFeedRefresh([...states].reverse(), {}, NOW);
  assert.deepEqual(first, second);
});
