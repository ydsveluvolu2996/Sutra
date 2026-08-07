import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// "Connection health" used to be `href: "/onboard#connection-lifecycle"`. That
// anchor did two wrong things at once: it handed a reader the onboarding form
// and (until it moved) the whole FinOps catalog, and it scrolled them to the
// Disable and Offboard buttons. Checking health should never land on the two
// destructive actions.

const nav = await readFile(
  new URL("../app/components/navigation-config.ts", import.meta.url),
  "utf8",
);
const page = await readFile(
  new URL("../app/connection-health/connection-health.tsx", import.meta.url),
  "utf8",
);
const onboardPage = await readFile(
  new URL("../app/onboard/page.tsx", import.meta.url),
  "utf8",
);

test("connection health has its own destination, not an anchor into onboarding", () => {
  assert.match(
    nav,
    /key: "connection_health",[^}]*href: "\/connection-health"/u,
  );
  assert.doesNotMatch(nav, /\/onboard#connection-lifecycle/u);
});

test("the health page mutates nothing", () => {
  // A health view is a read. Every state-changing call lives on Manage AWS
  // account, which is where an operator goes intending to change something.
  assert.doesNotMatch(page, /method:\s*"(POST|PUT|PATCH|DELETE)"/u);
  for (const route of [
    "/api/pilot/connections/disable",
    "/api/pilot/connections/offboard",
    "/api/pilot/connections/rotate-external-id",
    "/api/pilot/connections/credentials",
    "/api/pilot/connections/role",
  ]) {
    assert.ok(!page.includes(route), `${route} must not be reachable from a health page`);
  }
});

test("the onboarding page no longer carries the FinOps catalog", () => {
  // It rendered the entire 29-dashboard source contract under the trust form.
  assert.doesNotMatch(onboardPage, /FinopsOnboardingSources|FinopsSourceCoverage/u);
});

test("absent evidence is reported as absent, never as healthy", () => {
  // A collector probe that does not answer must not read as "live", and a
  // connection that has never collected must not read as a zero.
  assert.match(page, /healthBody\?\.health\?\.mode \?\? null/u);
  assert.match(page, /value=\{collectorMode \?\? "Unavailable"\}/u);
  assert.match(page, /if \(value === null\) return "Never";/u);
  assert.match(page, /No collection has run for this connection yet\./u);
  // A failure with no reported reason is not given an invented one.
  assert.match(page, /run\.error \?\? \(run\.status === "succeeded" \? "—" : "No detail reported"\)/u);
});

test("pending is not coloured as a failure", () => {
  // Awaiting validation is a normal onboarding step. Painting it red trains
  // operators to ignore red.
  const map = page.slice(page.indexOf("const STATE_TONE"), page.indexOf("function formatTimestamp"));
  assert.match(map, /pending: "pending"/u);
  assert.match(map, /active: "resolved"/u);
  assert.doesNotMatch(map, /pending: "failed"/u);
});

test("the health page reuses the shared dashboard chrome", () => {
  // Same density, tables and tiles as every other surface, so this page cannot
  // drift into its own visual dialect.
  assert.match(page, /from "\.\.\/components\/dashboard-chrome"/u);
  for (const component of ["DataTable", "DashboardCard", "StatTile", "StatePill", "DashboardTileRow"]) {
    assert.ok(page.includes(component), `${component} must come from the shared chrome`);
  }
});

test("the client directive is the first statement", async () => {
  assert.equal(page.split("\n")[0], '"use client";');
});
