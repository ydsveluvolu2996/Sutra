// Case-routing rule engine (pure). Given a set of routing rules and a batch of
// cases, it decides — deterministically — which rule, if any, routes each case.
// Rules are tried in ascending priority (lowest number first) then declaration
// order, and the first rule whose match conditions all hold wins. A match
// condition that is absent is a wildcard; a condition present on the rule for a
// field the case does not carry does not match. Two honesty rules are the point:
//   * An unmatched case is never force-assigned. It falls back to the supplied
//     default route when one is configured, otherwise its route is null with the
//     explicit reason 'no-match-no-default' — never a fabricated assignee.
//   * A rule (or default) that matches but declares no assignee, team, or
//     destination is reported as matched-but-not-configured with a null route,
//     surfacing the misconfiguration rather than silently defaulting or dropping.
// Nothing is synthesized: no assignee, team, destination, or tenant is invented.

export interface RoutingMatch {
  readonly severity?: readonly string[];
  readonly customerId?: string;
  readonly ruleId?: string;
  readonly namespace?: string;
  readonly source?: string;
}

export interface RoutingRoute {
  readonly assignee?: string;
  readonly team?: string;
  readonly destination?: string;
}

export interface RoutingRule {
  readonly id: string;
  readonly priority: number;
  readonly match: RoutingMatch;
  readonly route: RoutingRoute;
}

export interface RoutingCase {
  readonly id: string;
  readonly severity: string;
  readonly customerId?: string;
  readonly ruleId?: string;
  readonly namespace?: string;
  readonly source?: string;
  readonly tenant?: string;
}

export interface RouteTarget {
  readonly assignee: string | null;
  readonly team: string | null;
  readonly destination: string | null;
}

export interface RouteDecision {
  readonly caseId: string;
  readonly tenant: string | null;
  readonly matchedRuleId: string | null;
  readonly route: RouteTarget | null;
  readonly reason: string;
}

export interface RouteSummary {
  readonly cases: number;
  readonly routed: number;
  readonly unrouted: number;
  readonly matchedByRule: number;
  readonly defaulted: number;
  readonly unmatched: number;
}

export interface CaseRoutingResult {
  readonly schema: "sutra.case-routing.v1";
  readonly decisions: readonly RouteDecision[];
  readonly summary: RouteSummary;
  readonly disclaimer: string;
}

const REASON_NO_MATCH_NO_DEFAULT = "no-match-no-default";
const REASON_NO_MATCH_DEFAULT_ROUTE = "no-match-default-route";
const REASON_NO_MATCH_DEFAULT_NOT_CONFIGURED = "no-match-default-not-configured";

const CASE_ROUTING_DISCLAIMER =
  "Routing evaluates the supplied rules against each case in ascending priority " +
  "then declaration order; all present match conditions must hold (an absent " +
  "condition is a wildcard, and a condition on a field the case does not carry " +
  "does not match) and the first matching rule wins. An unmatched case is never " +
  "force-assigned: it falls back to the default route when one is configured, " +
  "otherwise its route is null with reason 'no-match-no-default'. A rule or " +
  "default that matches but declares no assignee, team, or destination is " +
  "reported as matched-but-not-configured with a null route, never silently " +
  "defaulted or dropped. No assignee, team, destination, or tenant is synthesized.";

// A route field carries routing information only when it is a non-empty string;
// undefined or empty is the honest "absent" (null), and real values are kept
// verbatim — never trimmed, coerced, or invented.
function routeTarget(value: string | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeRoute(route: RoutingRoute): RouteTarget {
  return {
    assignee: routeTarget(route.assignee),
    team: routeTarget(route.team),
    destination: routeTarget(route.destination),
  };
}

function isConfiguredRoute(route: RouteTarget): boolean {
  return route.assignee !== null || route.team !== null || route.destination !== null;
}

// A present match condition on a field the case lacks does not match; an absent
// condition is a wildcard. Severity matches by array membership, so an empty
// severity array matches nothing (distinct from an absent, wildcard severity).
function ruleMatches(rule: RoutingRule, subject: RoutingCase): boolean {
  const match = rule.match;
  if (match.severity !== undefined && !match.severity.includes(subject.severity)) return false;
  if (match.customerId !== undefined && subject.customerId !== match.customerId) return false;
  if (match.ruleId !== undefined && subject.ruleId !== match.ruleId) return false;
  if (match.namespace !== undefined && subject.namespace !== match.namespace) return false;
  if (match.source !== undefined && subject.source !== match.source) return false;
  return true;
}

function decideCase(
  subject: RoutingCase,
  orderedRules: readonly RoutingRule[],
  normalizedDefault: RouteTarget | null,
): RouteDecision {
  const tenant = subject.tenant ?? null;
  for (const rule of orderedRules) {
    if (!ruleMatches(rule, subject)) continue;
    const route = normalizeRoute(rule.route);
    if (isConfiguredRoute(route)) {
      return { caseId: subject.id, tenant, matchedRuleId: rule.id, route, reason: `matched-rule:${rule.id}` };
    }
    return { caseId: subject.id, tenant, matchedRuleId: rule.id, route: null, reason: `matched-rule-not-configured:${rule.id}` };
  }
  if (normalizedDefault === null) {
    return { caseId: subject.id, tenant, matchedRuleId: null, route: null, reason: REASON_NO_MATCH_NO_DEFAULT };
  }
  if (isConfiguredRoute(normalizedDefault)) {
    return { caseId: subject.id, tenant, matchedRuleId: null, route: normalizedDefault, reason: REASON_NO_MATCH_DEFAULT_ROUTE };
  }
  return { caseId: subject.id, tenant, matchedRuleId: null, route: null, reason: REASON_NO_MATCH_DEFAULT_NOT_CONFIGURED };
}

export function routeCases(
  cases: readonly RoutingCase[],
  routingRules: readonly RoutingRule[],
  defaultRoute?: RoutingRoute,
): CaseRoutingResult {
  // Ascending priority, then original declaration order for ties. The explicit
  // index tiebreaker keeps ordering deterministic regardless of sort stability.
  const orderedRules = routingRules
    .map((rule, index) => ({ rule, index }))
    .sort((left, right) => left.rule.priority - right.rule.priority || left.index - right.index)
    .map((entry) => entry.rule);

  const normalizedDefault = defaultRoute === undefined ? null : normalizeRoute(defaultRoute);

  const decisions = cases.map((subject) => decideCase(subject, orderedRules, normalizedDefault));

  const routed = decisions.filter((decision) => decision.route !== null).length;
  const matchedByRule = decisions.filter((decision) => decision.matchedRuleId !== null).length;
  const defaulted = decisions.filter((decision) => decision.reason === REASON_NO_MATCH_DEFAULT_ROUTE).length;

  return {
    schema: "sutra.case-routing.v1",
    decisions,
    summary: {
      cases: decisions.length,
      routed,
      unrouted: decisions.length - routed,
      matchedByRule,
      defaulted,
      unmatched: decisions.length - matchedByRule,
    },
    disclaimer: CASE_ROUTING_DISCLAIMER,
  };
}
