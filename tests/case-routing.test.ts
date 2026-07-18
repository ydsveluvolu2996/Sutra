import assert from "node:assert/strict";
import test from "node:test";

import { routeCases } from "../lib/case-routing.ts";
import type { RoutingCase, RoutingRule } from "../lib/case-routing.ts";

test("happy path: a matching rule routes the case and the reason cites the rule id", () => {
  const rules: readonly RoutingRule[] = [
    { id: "r-crit", priority: 10, match: { severity: ["critical"] }, route: { assignee: "alice", team: "soc" } },
  ];
  const cases: readonly RoutingCase[] = [{ id: "c1", severity: "critical" }];

  const result = routeCases(cases, rules);

  assert.equal(result.schema, "sutra.case-routing.v1");
  assert.equal(result.decisions.length, 1);
  const [decision] = result.decisions;
  assert.equal(decision.caseId, "c1");
  assert.equal(decision.matchedRuleId, "r-crit");
  assert.deepEqual(decision.route, { assignee: "alice", team: "soc", destination: null });
  assert.equal(decision.reason, "matched-rule:r-crit");
  assert.ok(decision.reason.includes("r-crit"), "matched reason must cite the rule id");
  assert.deepEqual(result.summary, {
    cases: 1,
    routed: 1,
    unrouted: 0,
    matchedByRule: 1,
    defaulted: 0,
    unmatched: 0,
  });
  assert.equal(typeof result.disclaimer, "string");
  assert.ok(result.disclaimer.length > 0);
});

test("lowest priority number wins among multiple matching rules regardless of array order", () => {
  const rules: readonly RoutingRule[] = [
    { id: "broad", priority: 100, match: {}, route: { team: "tier1" } },
    { id: "specific", priority: 1, match: { severity: ["critical"] }, route: { team: "tier3" } },
  ];

  const result = routeCases([{ id: "c1", severity: "critical" }], rules);

  assert.equal(result.decisions[0].matchedRuleId, "specific");
  assert.deepEqual(result.decisions[0].route, { assignee: null, team: "tier3", destination: null });
  assert.equal(result.decisions[0].reason, "matched-rule:specific");
});

test("ties on priority fall back to declaration order", () => {
  const rules: readonly RoutingRule[] = [
    { id: "first", priority: 5, match: {}, route: { team: "a" } },
    { id: "second", priority: 5, match: {}, route: { team: "b" } },
  ];

  const result = routeCases([{ id: "c1", severity: "low" }], rules);

  assert.equal(result.decisions[0].matchedRuleId, "first");
  assert.deepEqual(result.decisions[0].route, { assignee: null, team: "a", destination: null });
});

test("all conditions must match: a partial match does not route", () => {
  const rules: readonly RoutingRule[] = [
    { id: "prod-high", priority: 1, match: { severity: ["high"], namespace: "prod" }, route: { team: "x" } },
  ];

  const partial = routeCases([{ id: "c1", severity: "high", namespace: "staging" }], rules);
  assert.equal(partial.decisions[0].matchedRuleId, null);
  assert.equal(partial.decisions[0].route, null);
  assert.equal(partial.decisions[0].reason, "no-match-no-default");

  const full = routeCases([{ id: "c2", severity: "high", namespace: "prod" }], rules);
  assert.equal(full.decisions[0].matchedRuleId, "prod-high");
  assert.deepEqual(full.decisions[0].route, { assignee: null, team: "x", destination: null });
});

test("a rule constraining a field the case lacks does not match", () => {
  const needsNamespace: readonly RoutingRule[] = [
    { id: "needs-ns", priority: 1, match: { namespace: "prod" }, route: { team: "x" } },
  ];
  const withDefault = routeCases([{ id: "c1", severity: "high" }], needsNamespace, { team: "fallback" });
  assert.equal(withDefault.decisions[0].matchedRuleId, null);
  assert.deepEqual(withDefault.decisions[0].route, { assignee: null, team: "fallback", destination: null });
  assert.equal(withDefault.decisions[0].reason, "no-match-default-route");

  // The same holds for customerId, ruleId, and source when the case omits them.
  const needsAll: readonly RoutingRule[] = [
    { id: "needs-cust", priority: 1, match: { customerId: "cust-1" }, route: { team: "a" } },
    { id: "needs-rule", priority: 2, match: { ruleId: "R-42" }, route: { team: "b" } },
    { id: "needs-src", priority: 3, match: { source: "falco" }, route: { team: "c" } },
  ];
  const bare = routeCases([{ id: "c2", severity: "high" }], needsAll);
  assert.equal(bare.decisions[0].matchedRuleId, null);
  assert.equal(bare.decisions[0].route, null);
  assert.equal(bare.decisions[0].reason, "no-match-no-default");
});

test("severity matches by array membership", () => {
  const rules: readonly RoutingRule[] = [
    { id: "sev", priority: 1, match: { severity: ["critical", "high"] }, route: { team: "x" } },
  ];

  assert.equal(routeCases([{ id: "a", severity: "critical" }], rules).decisions[0].matchedRuleId, "sev");
  assert.equal(routeCases([{ id: "b", severity: "high" }], rules).decisions[0].matchedRuleId, "sev");
  assert.equal(routeCases([{ id: "c", severity: "medium" }], rules).decisions[0].matchedRuleId, null);
});

test("an absent match condition is a wildcard", () => {
  const rules: readonly RoutingRule[] = [
    { id: "catch-all", priority: 1, match: {}, route: { destination: "queue:triage" } },
  ];
  const cases: readonly RoutingCase[] = [
    { id: "a", severity: "low", customerId: "cust-9", namespace: "kube-system", source: "scanner", ruleId: "R-1" },
    { id: "b", severity: "critical" },
  ];

  const result = routeCases(cases, rules);
  for (const decision of result.decisions) {
    assert.equal(decision.matchedRuleId, "catch-all");
    assert.deepEqual(decision.route, { assignee: null, team: null, destination: "queue:triage" });
  }
});

test("an empty severity array matches nothing, unlike an absent (wildcard) severity", () => {
  const emptyArray: readonly RoutingRule[] = [
    { id: "empty-sev", priority: 1, match: { severity: [] }, route: { team: "x" } },
  ];
  const none = routeCases([{ id: "c1", severity: "critical" }], emptyArray);
  assert.equal(none.decisions[0].matchedRuleId, null);
  assert.equal(none.decisions[0].reason, "no-match-no-default");

  const wildcard: readonly RoutingRule[] = [
    { id: "any-sev", priority: 1, match: {}, route: { team: "x" } },
  ];
  const all = routeCases([{ id: "c1", severity: "critical" }], wildcard);
  assert.equal(all.decisions[0].matchedRuleId, "any-sev");
});

test("unmatched case falls back to the default route when one is configured", () => {
  const result = routeCases(
    [{ id: "c1", severity: "medium" }],
    [{ id: "crit", priority: 1, match: { severity: ["critical"] }, route: { team: "soc" } }],
    { assignee: "oncall", destination: "queue:triage" },
  );

  const [decision] = result.decisions;
  assert.equal(decision.matchedRuleId, null);
  assert.deepEqual(decision.route, { assignee: "oncall", team: null, destination: "queue:triage" });
  assert.equal(decision.reason, "no-match-default-route");
  assert.deepEqual(result.summary, {
    cases: 1,
    routed: 1,
    unrouted: 0,
    matchedByRule: 0,
    defaulted: 1,
    unmatched: 1,
  });
});

test("unmatched case with no default is null with reason no-match-no-default", () => {
  const result = routeCases([{ id: "c1", severity: "medium" }], []);

  const [decision] = result.decisions;
  assert.equal(decision.matchedRuleId, null);
  assert.equal(decision.route, null);
  assert.equal(decision.reason, "no-match-no-default");
  assert.deepEqual(result.summary, {
    cases: 1,
    routed: 0,
    unrouted: 1,
    matchedByRule: 0,
    defaulted: 0,
    unmatched: 1,
  });
});

test("a matched rule with no route target is reported not-configured, never force-defaulted", () => {
  const rules: readonly RoutingRule[] = [
    { id: "empty-route", priority: 1, match: { severity: ["low"] }, route: {} },
  ];
  const result = routeCases([{ id: "c1", severity: "low" }], rules, { team: "fallback" });

  const [decision] = result.decisions;
  assert.equal(decision.matchedRuleId, "empty-route", "the rule still matched");
  assert.equal(decision.route, null, "an empty route is not fabricated");
  assert.equal(decision.reason, "matched-rule-not-configured:empty-route");
  assert.ok(decision.reason.includes("empty-route"), "not-configured reason must cite the rule id");
  assert.deepEqual(result.summary, {
    cases: 1,
    routed: 0,
    unrouted: 1,
    matchedByRule: 1,
    defaulted: 0,
    unmatched: 0,
  });
});

test("route fields that are empty strings are treated as absent, not routed", () => {
  const rules: readonly RoutingRule[] = [
    { id: "blank", priority: 1, match: { severity: ["low"] }, route: { assignee: "", team: "", destination: "" } },
  ];
  const result = routeCases([{ id: "c1", severity: "low" }], rules);
  assert.equal(result.decisions[0].route, null);
  assert.equal(result.decisions[0].reason, "matched-rule-not-configured:blank");

  const partialBlank: readonly RoutingRule[] = [
    { id: "half", priority: 1, match: { severity: ["low"] }, route: { assignee: "", team: "soc" } },
  ];
  const partial = routeCases([{ id: "c1", severity: "low" }], partialBlank);
  assert.deepEqual(partial.decisions[0].route, { assignee: null, team: "soc", destination: null });
});

test("a default route provided but empty is reported not-configured", () => {
  const empty = routeCases([{ id: "c1", severity: "medium" }], [], {});
  assert.equal(empty.decisions[0].matchedRuleId, null);
  assert.equal(empty.decisions[0].route, null);
  assert.equal(empty.decisions[0].reason, "no-match-default-not-configured");
  assert.equal(empty.summary.routed, 0);
  assert.equal(empty.summary.defaulted, 0);

  const blank = routeCases([{ id: "c1", severity: "medium" }], [], { assignee: "" });
  assert.equal(blank.decisions[0].reason, "no-match-default-not-configured");
  assert.equal(blank.decisions[0].route, null);
});

test("tenant scope is passed through onto each decision, null when absent", () => {
  const rules: readonly RoutingRule[] = [
    { id: "any", priority: 1, match: {}, route: { team: "soc" } },
  ];
  const cases: readonly RoutingCase[] = [
    { id: "c1", severity: "low", tenant: "t-acme" },
    { id: "c2", severity: "low" },
  ];

  const result = routeCases(cases, rules);
  assert.equal(result.decisions[0].tenant, "t-acme");
  assert.equal(result.decisions[1].tenant, null);
});

test("customerId, ruleId, and source are exact-match conditions", () => {
  const rules: readonly RoutingRule[] = [
    { id: "scoped", priority: 1, match: { customerId: "cust-1", ruleId: "R-7", source: "falco" }, route: { team: "ir" } },
  ];

  const hit = routeCases([{ id: "c1", severity: "high", customerId: "cust-1", ruleId: "R-7", source: "falco" }], rules);
  assert.equal(hit.decisions[0].matchedRuleId, "scoped");

  const wrongCustomer = routeCases([{ id: "c1", severity: "high", customerId: "cust-2", ruleId: "R-7", source: "falco" }], rules);
  assert.equal(wrongCustomer.decisions[0].matchedRuleId, null);

  const wrongSource = routeCases([{ id: "c1", severity: "high", customerId: "cust-1", ruleId: "R-7", source: "scanner" }], rules);
  assert.equal(wrongSource.decisions[0].matchedRuleId, null);
});

test("batch summary counts routed vs unrouted honestly across mixed outcomes", () => {
  const rules: readonly RoutingRule[] = [
    { id: "crit", priority: 1, match: { severity: ["critical"] }, route: { team: "soc" } },
    { id: "low-empty", priority: 2, match: { severity: ["low"] }, route: {} },
  ];
  const cases: readonly RoutingCase[] = [
    { id: "c1", severity: "critical" }, // matched + routed
    { id: "c2", severity: "low" }, // matched but not configured -> unrouted
    { id: "c3", severity: "medium" }, // unmatched -> default -> routed
  ];

  const result = routeCases(cases, rules, { team: "fallback" });

  assert.deepEqual(result.decisions.map((decision) => decision.caseId), ["c1", "c2", "c3"], "input order preserved");
  assert.equal(result.decisions[0].reason, "matched-rule:crit");
  assert.equal(result.decisions[1].reason, "matched-rule-not-configured:low-empty");
  assert.equal(result.decisions[2].reason, "no-match-default-route");
  assert.deepEqual(result.summary, {
    cases: 3,
    routed: 2,
    unrouted: 1,
    matchedByRule: 2,
    defaulted: 1,
    unmatched: 1,
  });
});

test("empty inputs yield empty decisions and a zeroed summary", () => {
  const result = routeCases([], []);
  assert.deepEqual(result.decisions, []);
  assert.deepEqual(result.summary, {
    cases: 0,
    routed: 0,
    unrouted: 0,
    matchedByRule: 0,
    defaulted: 0,
    unmatched: 0,
  });
  assert.equal(result.schema, "sutra.case-routing.v1");
  assert.ok(result.disclaimer.length > 0);
});

test("routing is deterministic for identical inputs", () => {
  const rules: readonly RoutingRule[] = [
    { id: "broad", priority: 50, match: {}, route: { team: "tier1" } },
    { id: "crit", priority: 1, match: { severity: ["critical"] }, route: { assignee: "alice" } },
  ];
  const cases: readonly RoutingCase[] = [
    { id: "c1", severity: "critical", tenant: "t-1" },
    { id: "c2", severity: "low" },
  ];

  assert.deepEqual(routeCases(cases, rules, { team: "fallback" }), routeCases(cases, rules, { team: "fallback" }));
});
