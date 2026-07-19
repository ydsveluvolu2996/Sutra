import assert from "node:assert/strict";
import test from "node:test";
import { caseToRoutingCase, storedRuleToRoutingRule } from "../lib/case-routing-inputs.ts";
import { routeCases } from "../lib/case-routing.ts";
import type { StoredCaseRoutingRule } from "../db/case-routing-repository.ts";

function rule(over: Partial<StoredCaseRoutingRule> = {}): StoredCaseRoutingRule {
  return {
    id: "croute_" + "a".repeat(32),
    priority: 10,
    matchSeverity: ["critical", "high"],
    matchCustomerId: null,
    routeAssignee: "alice",
    routeTeam: null,
    routeDestination: null,
    ...over,
  };
}

test("a case's priority is its routing severity, tenant-scoped to its customer", () => {
  const routingCase = caseToRoutingCase({ id: "case_1", priority: "critical", customerId: "cust_a" });
  assert.deepEqual(routingCase, { id: "case_1", severity: "critical", customerId: "cust_a", tenant: "cust_a" });
});

test("only set match/route fields are emitted (empty match is a catch-all)", () => {
  const catchAll = storedRuleToRoutingRule(rule({ matchSeverity: [], matchCustomerId: null, routeTeam: "soc", routeAssignee: null }));
  assert.deepEqual(catchAll.match, {});
  assert.deepEqual(catchAll.route, { team: "soc" });
});

test("rules route matching cases and leave non-matching cases unrouted (preview only)", () => {
  const rules = [storedRuleToRoutingRule(rule({ matchSeverity: ["critical"], routeAssignee: "alice" }))];
  const cases = [
    caseToRoutingCase({ id: "c1", priority: "critical", customerId: "cust_a" }),
    caseToRoutingCase({ id: "c2", priority: "low", customerId: "cust_a" }),
  ];
  const result = routeCases(cases, rules);
  const byCase = new Map(result.decisions.map((d) => [d.caseId, d]));
  assert.equal(byCase.get("c1")?.route?.assignee, "alice");
  assert.equal(byCase.get("c2")?.route, null, "a case matching no rule is not routed");
  assert.equal(result.summary.routed, 1);
});
