// Pure adapters between Sutra's persisted case + routing-rule shapes and the
// case-routing engine. A case's priority is its routing "severity" (matched
// verbatim against a rule's severity set); a rule contributes a match dimension
// only when it is actually set, so an empty match is a genuine catch-all rather
// than a synthesized filter, and an absent route field is left undefined.
import type { RoutingCase, RoutingRule } from "./case-routing.ts";
import type { StoredCaseRoutingRule } from "../db/case-routing-repository.ts";

export interface RoutableCaseLike {
  readonly id: string;
  readonly priority: string;
  readonly customerId: string;
}

export function caseToRoutingCase(item: RoutableCaseLike): RoutingCase {
  return { id: item.id, severity: item.priority, customerId: item.customerId, tenant: item.customerId };
}

export function storedRuleToRoutingRule(rule: StoredCaseRoutingRule): RoutingRule {
  const match: {
    severity?: readonly string[];
    customerId?: string;
  } = {};
  if (rule.matchSeverity.length > 0) match.severity = rule.matchSeverity;
  if (rule.matchCustomerId !== null) match.customerId = rule.matchCustomerId;

  const route: { assignee?: string; team?: string; destination?: string } = {};
  if (rule.routeAssignee !== null) route.assignee = rule.routeAssignee;
  if (rule.routeTeam !== null) route.team = rule.routeTeam;
  if (rule.routeDestination !== null) route.destination = rule.routeDestination;

  return { id: rule.id, priority: rule.priority, match, route };
}
