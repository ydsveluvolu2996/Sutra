import assert from "node:assert/strict";
import { after, test } from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

/**
 * Pins the non-compliant rule ranking that feeds the chart on ADD-12.
 *
 * The rule list already names which rules are non-compliant. It does not say
 * which are non-compliant at scale, which is the question the ranking answers.
 * Turning that into a chart makes three properties load-bearing that a flat
 * list never had to honour:
 *
 * 1. A null contributorCount is unavailable, not zero. Plotting it as a
 *    zero-length bar would assert that AWS measured no offending resources for
 *    that rule, which was never collected.
 * 2. A capped count is a floor, not a value. A bar whose total absorbs a capped
 *    deployment must be marked as a lower bound.
 * 3. Deployments of one rule across accounts and Regions aggregate into a
 *    single bar, and dropping an uncollected deployment from that sum must be
 *    disclosed rather than silently understated.
 */

const vite = await createServer({
  root: new URL("..", import.meta.url).pathname,
  configFile: false,
  logLevel: "silent",
  plugins: [react()],
  server: { middlewareMode: true },
});
const dashboard = await vite.ssrLoadModule(
  "/app/costs/finops-aws-config-resource-compliance-dashboard.tsx",
);
after(async () => vite.close());

const rule = (ruleName, contributorCount, extra = {}) => ({
  accountId: extra.accountId ?? "111122223333",
  region: extra.region ?? "us-east-1",
  ruleName,
  complianceType: extra.complianceType ?? "NON_COMPLIANT",
  lifecycle: "ACTIVE",
  contributorCount,
  contributorCountCapped: extra.capped ?? false,
  resourceTypes: [],
  duplicateSignatureCount: 1,
});

test("rules are ranked by contributing resource count, descending", () => {
  const ranking = dashboard.nonCompliantRuleRanking({
    rules: [rule("small", 2), rule("largest", 90), rule("middle", 15)],
  });
  assert.deepEqual(ranking.items.map((item) => item.label), ["largest", "middle", "small"]);
  assert.deepEqual(ranking.items.map((item) => item.value), [90, 15, 2]);
});

test("only non-compliant rules are ranked", () => {
  const ranking = dashboard.nonCompliantRuleRanking({
    rules: [
      rule("violating", 5),
      rule("clean", 900, { complianceType: "COMPLIANT" }),
      rule("unknown", 900, { complianceType: "INSUFFICIENT_DATA" }),
    ],
  });
  assert.deepEqual(ranking.items.map((item) => item.label), ["violating"]);
});

test("an uncollected count is excluded, never plotted as zero", () => {
  const ranking = dashboard.nonCompliantRuleRanking({
    rules: [rule("counted", 4), rule("uncounted", null)],
  });
  assert.deepEqual(ranking.items.map((item) => item.label), ["counted"]);
  assert.equal(ranking.unavailableRuleCount, 1);
  for (const item of ranking.items) {
    assert.notEqual(item.value, 0, "an uncollected rule must not reach the chart as zero");
  }
});

test("a measured zero is a real value and stays plotted", () => {
  // Zero contributors is a legitimate measurement. Only an absent count is a gap.
  const ranking = dashboard.nonCompliantRuleRanking({ rules: [rule("measured-zero", 0)] });
  assert.deepEqual(ranking.items.map((item) => item.value), [0]);
  assert.equal(ranking.unavailableRuleCount, 0);
});

test("deployments of one rule aggregate into a single bar", () => {
  const ranking = dashboard.nonCompliantRuleRanking({
    rules: [
      rule("spread", 3, { region: "us-east-1" }),
      rule("spread", 4, { region: "eu-west-1" }),
      rule("spread", 5, { accountId: "444455556666" }),
    ],
  });
  assert.equal(ranking.items.length, 1);
  assert.equal(ranking.items[0].value, 12);
  assert.match(ranking.items[0].detail, /3 deployments/u);
  assert.equal(ranking.anyLowerBound, false);
});

test("a capped deployment makes the total a lower bound", () => {
  const ranking = dashboard.nonCompliantRuleRanking({
    rules: [rule("capped", 100, { capped: true })],
  });
  assert.equal(ranking.anyLowerBound, true);
  assert.match(ranking.items[0].detail, /at least/u);
  assert.match(ranking.items[0].detail, /capped by AWS/u);
});

test("dropping an uncollected deployment is disclosed, not silently understated", () => {
  const ranking = dashboard.nonCompliantRuleRanking({
    rules: [
      rule("partial", 7, { region: "us-east-1" }),
      rule("partial", null, { region: "eu-west-1" }),
    ],
  });
  assert.equal(ranking.items.length, 1);
  // The sum covers only the collected deployment, and says so.
  assert.equal(ranking.items[0].value, 7);
  assert.equal(ranking.anyLowerBound, true);
  assert.match(ranking.items[0].detail, /at least/u);
  assert.match(ranking.items[0].detail, /1 without a count/u);
  // The rule still ranks — it is partially collected, not unavailable.
  assert.equal(ranking.unavailableRuleCount, 0);
});

test("a rule with no collected deployment at all is unavailable", () => {
  const ranking = dashboard.nonCompliantRuleRanking({
    rules: [
      rule("never-counted", null, { region: "us-east-1" }),
      rule("never-counted", null, { region: "eu-west-1" }),
    ],
  });
  assert.deepEqual(ranking.items, []);
  assert.equal(ranking.unavailableRuleCount, 1, "one rule, not one deployment");
});

test("truncated rule rows are reported so the ranking is not read as complete", () => {
  assert.equal(
    dashboard.nonCompliantRuleRanking({ rules: [rule("a", 1)], rulesTruncated: true }).truncated,
    true,
  );
  assert.equal(dashboard.nonCompliantRuleRanking({ rules: [rule("a", 1)] }).truncated, false);
});

test("ties break by rule name so the order is deterministic", () => {
  const ranking = dashboard.nonCompliantRuleRanking({
    rules: [rule("zebra", 5), rule("alpha", 5)],
  });
  assert.deepEqual(ranking.items.map((item) => item.label), ["alpha", "zebra"]);
});

test("no rules produce no ranking rather than an empty axis", () => {
  const ranking = dashboard.nonCompliantRuleRanking({});
  assert.deepEqual(ranking.items, []);
  assert.equal(ranking.unavailableRuleCount, 0);
  assert.equal(ranking.anyLowerBound, false);
  assert.equal(ranking.truncated, false);
});

test("a non-finite count is treated as unavailable, not as a magnitude", () => {
  const ranking = dashboard.nonCompliantRuleRanking({
    rules: [rule("nan", Number.NaN), rule("infinite", Number.POSITIVE_INFINITY)],
  });
  assert.deepEqual(ranking.items, []);
  assert.equal(ranking.unavailableRuleCount, 2);
});
