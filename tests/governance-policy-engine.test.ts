import assert from "node:assert/strict";
import test from "node:test";
import {
  describeGovernanceDecision,
  evaluateGovernancePolicies,
  governanceApprovalRequestKey,
  GOVERNANCE_ACTION_DESCRIPTORS,
  orderGovernancePolicies,
  type GovernanceCondition,
  type GovernanceEvaluationContext,
  type GovernancePolicy,
  type GovernanceSignals,
} from "../lib/governance-policy-engine.ts";
import { buildBudgetBurndown } from "../lib/finops-budget-burndown.ts";
import { detectAnomalies } from "../lib/finops-insights.ts";
import { buildTagGovernance } from "../lib/finops-tag-governance.ts";
import { applyAllocationRules } from "../lib/finops-allocation-rules.ts";
import { buildIdleWaste } from "../lib/finops-idle-waste.ts";
import type { NormalizedCurLine } from "../lib/finops-cur.ts";

const NOW = Date.parse("2026-07-27T00:00:00.000Z");

function line(over: Partial<NormalizedCurLine> = {}): NormalizedCurLine {
  return {
    lineItemId: "li-1",
    usageAccountId: "111111111111",
    service: "AmazonEC2",
    chargeCategory: "Usage",
    usageStartIso: "2026-07-01T00:00:00.000Z",
    amountMicros: "1000000",
    currency: "USD",
    region: "us-east-1",
    amortizedMicros: null,
    commitmentType: null,
    commitmentId: null,
    commitmentExpiry: null,
    usageType: null,
    usageAmountMicros: null,
    usageUnit: null,
    tags: {},
    ...over,
  };
}

function policy(over: Partial<GovernancePolicy> & { id: string; condition: GovernanceCondition }): GovernancePolicy {
  return {
    name: `policy-${over.id}`,
    enabled: true,
    priority: 100,
    scope: { customerId: null, connectionId: null },
    action: { kind: "open-case", target: "finops-queue" },
    requiresApproval: false,
    ...over,
  };
}

function context(signals: GovernanceSignals): GovernanceEvaluationContext {
  return { orgId: "org_a", customerId: "cust_a", connectionId: "conn_a", signals };
}

// --- signal fixtures built from the REAL engines, never hand-rolled shapes ---

const breachedBurndown = buildBudgetBurndown({
  budgets: [{ id: "bud_1", name: "Platform", currency: "USD", limitMicros: "5000000" }],
  dailyLines: [
    line({ usageStartIso: "2026-07-01T00:00:00.000Z", amountMicros: "4000000" }),
    line({ usageStartIso: "2026-07-02T00:00:00.000Z", amountMicros: "3000000" }),
  ],
  period: "2026-07",
  asOfDayIndex: 2,
  daysInMonth: 31,
});

const healthyBurndown = buildBudgetBurndown({
  budgets: [{ id: "bud_1", name: "Platform", currency: "USD", limitMicros: "500000000" }],
  dailyLines: [line({ amountMicros: "1000000" })],
  period: "2026-07",
  asOfDayIndex: 1,
  daysInMonth: 31,
});

const anomalies = detectAnomalies([
  line({ usageStartIso: "2026-07-01T00:00:00.000Z", amountMicros: "2000000" }),
  line({ usageStartIso: "2026-07-02T00:00:00.000Z", amountMicros: "2000000" }),
  line({ usageStartIso: "2026-07-03T00:00:00.000Z", amountMicros: "2000000" }),
  line({ usageStartIso: "2026-07-04T00:00:00.000Z", amountMicros: "90000000" }),
]);

const tagGovernance = buildTagGovernance({
  resources: [
    { resourceKey: "i-1", service: "ec2", region: "us-east-1", tags: {} },
    { resourceKey: "i-2", service: "ec2", region: "us-east-1", tags: { CostCenter: "cc-1", Owner: "a", Environment: "prod" } },
  ],
  curLines: [line({ amountMicros: "7000000" }), line({ amountMicros: "3000000", tags: { CostCenter: "cc-1", Owner: "a", Environment: "prod" } })],
});

const allocation = applyAllocationRules(
  [line({ amountMicros: "4000000", service: "AmazonEC2" }), line({ amountMicros: "6000000", service: "AmazonS3" })],
  [{ id: "ar_1", name: "ec2", priority: 10, match: { service: "AmazonEC2" }, targetKind: "cost_center", targetValue: "cc-1", enabled: true }],
);

const idleWaste = buildIdleWaste({
  volumes: [{ resourceKey: "vol-1", region: "us-east-1", name: null, attached: false, sizeGiB: 500, volumeType: "gp3" }],
  elasticIps: [{ resourceKey: "eip-1", region: "us-east-1", name: null, associated: false }],
});

const ALL_SIGNALS: GovernanceSignals = {
  budgetBurndown: breachedBurndown,
  anomalies,
  tagGovernance,
  allocation,
  idleWaste,
  alertMetrics: {
    "open-critical-findings-count": { value: 4, available: true, basis: "Four open critical findings." },
    "posture-score": { value: null, available: false, basis: "No Kubernetes scans collected." },
  },
};

test("every allowed action is honest about who performs it and mutates nothing in the customer cloud", () => {
  assert.equal(GOVERNANCE_ACTION_DESCRIPTORS.length, 5);
  for (const descriptor of GOVERNANCE_ACTION_DESCRIPTORS) {
    assert.equal(descriptor.mutatesCustomerCloud, false);
    assert.ok(descriptor.performedBy === "sutra" || descriptor.performedBy === "customer");
    assert.ok(descriptor.label.length > 0 && descriptor.description.length > 0);
    // No action may claim Sutra changes a customer resource.
    assert.doesNotMatch(descriptor.label, /\b(stop|stops|delete|deletes|terminate|patch|patches|resize)\b/iu);
  }
});

test("budget burn-down status composes: a breached budget matches, a healthy one does not", () => {
  const condition: GovernanceCondition = { signal: "budget-burndown-status", statuses: ["breached"] };
  const matched = evaluateGovernancePolicies([policy({ id: "gpol_a", condition })], context({ budgetBurndown: breachedBurndown }), NOW);
  assert.equal(matched.decisions[0].state, "matched");
  assert.equal(matched.decisions[0].evidence[0].observed, "breached");
  assert.match(matched.decisions[0].evidence[0].basis, /latest usage day present/u);

  const unmatched = evaluateGovernancePolicies([policy({ id: "gpol_a", condition })], context({ budgetBurndown: healthyBurndown }), NOW);
  assert.equal(unmatched.decisions[0].state, "not-matched");
  assert.equal(unmatched.decisions[0].evidence[0].truth, "false");
});

test("budget consumed-percent and days-to-breach read the burn-down engine's own numbers", () => {
  const report = evaluateGovernancePolicies(
    [
      policy({ id: "gpol_a", condition: { signal: "budget-consumed-percent", comparator: "gte", threshold: 100 } }),
      policy({ id: "gpol_b", condition: { signal: "budget-days-to-breach", comparator: "lte", threshold: 3 } }),
    ],
    context({ budgetBurndown: breachedBurndown }),
    NOW,
  );
  assert.equal(report.decisions[0].state, "matched");
  assert.equal(report.decisions[0].evidence[0].observed, breachedBurndown.budgets[0].consumedPercent);
  assert.equal(report.decisions[1].state, "matched");
  assert.equal(report.decisions[1].evidence[0].observed, breachedBurndown.budgets[0].daysToBreach);
});

test("cost anomalies, untagged spend, tag coverage, unallocated spend, idle waste and alert metrics all compose", () => {
  const conditions: readonly GovernanceCondition[] = [
    { signal: "cost-anomaly-count", comparator: "gt", threshold: 0 },
    { signal: "untagged-spend-percent", comparator: "gte", threshold: 50 },
    { signal: "required-tag-coverage-percent", comparator: "lt", threshold: 75 },
    { signal: "unallocated-spend-percent", comparator: "gt", threshold: 50 },
    { signal: "idle-waste-finding-count", comparator: "gte", threshold: 2 },
    { signal: "idle-waste-monthly-micros", comparator: "gt", threshold: 0, currency: "USD" },
    { signal: "alert-metric", metric: "open-critical-findings-count", comparator: "gt", threshold: 1 },
  ];
  const report = evaluateGovernancePolicies(
    conditions.map((condition, index) => policy({ id: `gpol_${index}`, condition, priority: index })),
    context(ALL_SIGNALS),
    NOW,
  );
  for (const decision of report.decisions) {
    assert.equal(decision.state, "matched", `${decision.policyName}: ${decision.reason}`);
    assert.equal(decision.evidence.length, 1);
    assert.equal(decision.evidence[0].truth, "true");
    assert.ok(decision.evidence[0].basis.length > 0);
  }
  // The untagged-spend witness is per currency and discloses which currency.
  const untagged = report.decisions.find((entry) => entry.evidence[0].signal === "untagged-spend-percent");
  assert.match(untagged?.evidence[0].basis ?? "", /USD/u);
});

test("all / any / not compose, and a definite answer beats a missing signal", () => {
  const both: GovernanceCondition = {
    all: [
      { signal: "budget-burndown-status", statuses: ["breached"] },
      { signal: "alert-metric", metric: "open-critical-findings-count", comparator: "gt", threshold: 1 },
    ],
  };
  assert.equal(evaluateGovernancePolicies([policy({ id: "gpol_a", condition: both })], context(ALL_SIGNALS), NOW).decisions[0].state, "matched");

  // all(): a definite FALSE decides even though another leaf is unavailable.
  const falseAndUnknown: GovernanceCondition = {
    all: [
      { signal: "budget-burndown-status", statuses: ["breached"] },
      { signal: "alert-metric", metric: "posture-score", comparator: "lt", threshold: 50 },
    ],
  };
  assert.equal(
    evaluateGovernancePolicies([policy({ id: "gpol_a", condition: falseAndUnknown })], context({ budgetBurndown: healthyBurndown, alertMetrics: ALL_SIGNALS.alertMetrics }), NOW).decisions[0].state,
    "not-matched",
  );

  // any(): one definite TRUE decides.
  const anyTrue: GovernanceCondition = {
    any: [
      { signal: "alert-metric", metric: "posture-score", comparator: "lt", threshold: 50 },
      { signal: "budget-burndown-status", statuses: ["breached"] },
    ],
  };
  assert.equal(evaluateGovernancePolicies([policy({ id: "gpol_a", condition: anyTrue })], context(ALL_SIGNALS), NOW).decisions[0].state, "matched");

  // not() negates a definite value.
  const negated: GovernanceCondition = { not: { signal: "budget-burndown-status", statuses: ["breached"] } };
  assert.equal(evaluateGovernancePolicies([policy({ id: "gpol_a", condition: negated })], context({ budgetBurndown: healthyBurndown }), NOW).decisions[0].state, "matched");
  assert.equal(evaluateGovernancePolicies([policy({ id: "gpol_a", condition: negated })], context(ALL_SIGNALS), NOW).decisions[0].state, "not-matched");
});

test("a missing signal is disclosed, never treated as zero or false", () => {
  const report = evaluateGovernancePolicies(
    [
      policy({ id: "gpol_a", condition: { signal: "budget-burndown-status", statuses: ["breached"] } }),
      policy({ id: "gpol_b", condition: { signal: "cost-anomaly-count", comparator: "gt", threshold: 0 } }),
      policy({ id: "gpol_c", condition: { signal: "alert-metric", metric: "posture-score", comparator: "lt", threshold: 50 } }),
      policy({ id: "gpol_d", condition: { not: { signal: "cost-anomaly-count", comparator: "gt", threshold: 0 } } }),
    ],
    context({ alertMetrics: ALL_SIGNALS.alertMetrics }),
    NOW,
  );
  for (const decision of report.decisions) {
    assert.equal(decision.matched, false);
    assert.equal(decision.state, "signal-unavailable");
    assert.equal(decision.proposedAction, null);
    assert.match(decision.reason, /unavailable/iu);
  }
  assert.equal(report.summary.signalUnavailable, 4);
  assert.equal(report.summary.matched, 0);
  // An anomaly report with no evaluated days is unavailable, not "zero anomalies".
  const empty = evaluateGovernancePolicies(
    [policy({ id: "gpol_a", condition: { signal: "cost-anomaly-count", comparator: "gte", threshold: 0 } })],
    context({ anomalies: detectAnomalies([]) }),
    NOW,
  );
  assert.equal(empty.decisions[0].state, "signal-unavailable");
});

test("an empty or malformed condition never matches", () => {
  const report = evaluateGovernancePolicies(
    [
      policy({ id: "gpol_a", condition: { all: [] } }),
      policy({ id: "gpol_b", condition: { any: [] } }),
      policy({ id: "gpol_c", condition: { signal: "budget-consumed-percent" } }),
    ],
    context(ALL_SIGNALS),
    NOW,
  );
  for (const decision of report.decisions) {
    assert.equal(decision.matched, false);
    assert.equal(decision.state, "signal-unavailable");
  }
});

test("policies are ordered by priority then id, and a disabled policy is skipped entirely", () => {
  const policies = [
    policy({ id: "gpol_z", priority: 50, condition: { signal: "budget-burndown-status", statuses: ["breached"] } }),
    policy({ id: "gpol_a", priority: 50, condition: { signal: "budget-burndown-status", statuses: ["breached"] } }),
    policy({ id: "gpol_m", priority: 10, condition: { signal: "budget-burndown-status", statuses: ["breached"] } }),
    policy({ id: "gpol_off", priority: 1, enabled: false, condition: { signal: "budget-burndown-status", statuses: ["breached"] } }),
  ];
  assert.deepEqual(orderGovernancePolicies(policies).map((entry) => entry.id), ["gpol_off", "gpol_m", "gpol_a", "gpol_z"]);
  const report = evaluateGovernancePolicies(policies, context(ALL_SIGNALS), NOW);
  assert.deepEqual(report.decisions.map((entry) => entry.policyId), ["gpol_off", "gpol_m", "gpol_a", "gpol_z"]);
  const disabled = report.decisions[0];
  assert.equal(disabled.state, "disabled");
  assert.equal(disabled.evidence.length, 0);
  assert.equal(disabled.proposedAction, null);
  assert.equal(report.summary.disabled, 1);
  assert.equal(report.summary.matched, 3);
});

test("a policy scoped to another customer or connection is out of scope, not matched", () => {
  const report = evaluateGovernancePolicies(
    [
      policy({ id: "gpol_a", scope: { customerId: "cust_other" }, condition: { signal: "budget-burndown-status", statuses: ["breached"] } }),
      policy({ id: "gpol_b", scope: { customerId: null, connectionId: "conn_other" }, condition: { signal: "budget-burndown-status", statuses: ["breached"] } }),
      policy({ id: "gpol_c", scope: { customerId: "cust_a", connectionId: "conn_a" }, condition: { signal: "budget-burndown-status", statuses: ["breached"] } }),
    ],
    context(ALL_SIGNALS),
    NOW,
  );
  assert.equal(report.decisions[0].state, "out-of-scope");
  assert.equal(report.decisions[1].state, "out-of-scope");
  assert.equal(report.decisions[2].state, "matched");
  assert.equal(report.summary.outOfScope, 2);
});

test("requiresApproval gates the action: matched but pending, with a deterministic request key", () => {
  const gated = policy({
    id: "gpol_a",
    requiresApproval: true,
    action: { kind: "accept-risk-with-expiry", target: "bud_1", expiresInDays: 30 },
    condition: { signal: "budget-burndown-status", statuses: ["breached"] },
  });
  const ungated = policy({
    id: "gpol_b",
    requiresApproval: false,
    action: { kind: "notify-destination", target: "dest_1" },
    condition: { signal: "budget-burndown-status", statuses: ["breached"] },
  });
  const report = evaluateGovernancePolicies([gated, ungated], context(ALL_SIGNALS), NOW);
  const gatedDecision = report.decisions[0];
  assert.equal(gatedDecision.matched, true);
  assert.equal(gatedDecision.pendingApproval, true);
  assert.equal(gatedDecision.approvalRequestKey, governanceApprovalRequestKey(gated));
  assert.equal(gatedDecision.approvalRequestKey, "gpol_a|accept-risk-with-expiry|bud_1");
  assert.match(gatedDecision.reason, /held for approval/u);
  assert.equal(gatedDecision.proposedAction?.expiresInDays, 30);
  assert.equal(gatedDecision.proposedAction?.performedBy, "sutra");
  assert.equal(gatedDecision.proposedAction?.mutatesCustomerCloud, false);

  const ungatedDecision = report.decisions[1];
  assert.equal(ungatedDecision.pendingApproval, false);
  assert.equal(ungatedDecision.approvalRequestKey, "gpol_b|notify-destination|dest_1");
  assert.equal(report.summary.pendingApproval, 1);
  assert.equal(report.summary.readyToAct, 1);

  // A customer-performed action is labelled as such and still mutates nothing.
  const artefact = evaluateGovernancePolicies(
    [policy({ id: "gpol_c", action: { kind: "generate-remediation-artefact", target: "vol-1" }, condition: { signal: "idle-waste-finding-count", comparator: "gt", threshold: 0 } })],
    context(ALL_SIGNALS),
    NOW,
  );
  assert.equal(artefact.decisions[0].proposedAction?.performedBy, "customer");
});

test("evaluation is deterministic and takes the clock as an argument", () => {
  const policies = [
    policy({ id: "gpol_a", priority: 5, requiresApproval: true, condition: { any: [{ signal: "cost-anomaly-count", comparator: "gt", threshold: 0 }, { signal: "untagged-spend-percent", comparator: "gt", threshold: 10 }] } }),
    policy({ id: "gpol_b", priority: 1, condition: { all: [{ signal: "unallocated-spend-percent", comparator: "gt", threshold: 10 }, { not: { signal: "budget-burndown-status", statuses: ["ok"] } }] } }),
  ];
  const first = evaluateGovernancePolicies(policies, context(ALL_SIGNALS), NOW);
  const second = evaluateGovernancePolicies(policies, context(ALL_SIGNALS), NOW);
  assert.deepEqual(second, first);
  assert.equal(first.evaluatedAtIso, "2026-07-27T00:00:00.000Z");
  const later = evaluateGovernancePolicies(policies, context(ALL_SIGNALS), NOW + 86_400_000);
  assert.equal(later.evaluatedAtIso, "2026-07-28T00:00:00.000Z");
  assert.deepEqual(later.decisions, first.decisions);
});

test("a matched decision carries the evidence into its human-readable summary", () => {
  const report = evaluateGovernancePolicies(
    [policy({ id: "gpol_a", requiresApproval: true, condition: { signal: "budget-burndown-status", statuses: ["breached"] } })],
    context(ALL_SIGNALS),
    NOW,
  );
  const summary = describeGovernanceDecision(report.decisions[0]);
  assert.match(summary, /matched/u);
  assert.match(summary, /Proposed action/u);
  assert.match(summary, /pending human approval/u);
  assert.match(report.disclaimer, /read-only/u);
});
