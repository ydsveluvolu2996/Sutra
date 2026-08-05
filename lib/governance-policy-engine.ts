/**
 * Pure, deterministic governance policy engine.
 *
 * A POLICY is a declarative condition over FinOps / security state that Sutra
 * ALREADY computes, paired with a governance ACTION and an optional APPROVAL
 * GATE. This module only *decides*; it performs nothing and reads no clock (the
 * caller injects `now`), so the same inputs always produce byte-identical
 * output in a route, a job, or a test.
 *
 * It deliberately extends the existing metric-alerting discipline rather than
 * duplicating it: comparators, the metric availability contract
 * (`AlertMetricReading`) and `compareMetric` are imported from
 * {@link ../lib/alert-rules.ts}. An alert rule fires on ONE metric; a policy
 * composes MANY signals with all/any/not, then proposes a governed action that
 * may be held for human approval.
 *
 * Honesty rules (never relaxed):
 *  - Sutra's customer trust role is READ-ONLY by construction. Therefore no
 *    action here mutates a customer resource: every action is either performed
 *    by Sutra inside Sutra (propose a case, notify a destination, record an
 *    accepted-risk exception with an expiry) or produces something the CUSTOMER
 *    applies themselves (a remediation artefact, a CI gate result their own
 *    pipeline enforces). `mutatesCustomerCloud` is `false` for every action and
 *    `performedBy` names who actually acts. See GOVERNANCE_ACTION_DESCRIPTORS.
 *  - A missing signal is UNKNOWN, never false and never coerced to 0. A policy
 *    matches only when its condition evaluates to a definite true; an unknown
 *    leaf is reported as `signal-unavailable` with the reason disclosed.
 *  - Money is compared in integer micro-units and per currency; percentages of
 *    spend are computed with BigInt so no float drift enters a decision.
 *  - `requiresApproval` means the action is NOT taken by evaluation: the
 *    decision is emitted as `pendingApproval` with a deterministic request key,
 *    and something outside this module must record an approval before any
 *    action runs.
 */
import {
  compareMetric,
  isAlertComparator,
  isSupportedAlertMetric,
  type AlertComparator,
  type AlertMetricKey,
  type AlertMetricMap,
} from "./alert-rules.ts";
import type { BudgetBurndownResult } from "./finops-budget-burndown.ts";
import type { AnomalyResult } from "./finops-insights.ts";
import type { TagGovernanceReport } from "./finops-tag-governance.ts";
import type { AllocationResult } from "./finops-allocation-rules.ts";
import type { IdleWasteReport } from "./finops-idle-waste.ts";

/** Budget burn-down status values, mirrored from the burn-down engine. */
export type GovernanceBudgetStatus = "ok" | "at_risk" | "breached";

export const GOVERNANCE_BUDGET_STATUSES: readonly GovernanceBudgetStatus[] = ["ok", "at_risk", "breached"];

/**
 * The signals a policy condition may read. Every one is derived from an engine
 * Sutra already ships — nothing here is invented, and `alert-metric` reuses the
 * existing metric map so vulnerability / compliance / posture signals compose
 * under the same availability contract.
 */
export type GovernanceSignalKind =
  | "budget-burndown-status"
  | "budget-consumed-percent"
  | "budget-days-to-breach"
  | "cost-anomaly-count"
  | "untagged-spend-percent"
  | "required-tag-coverage-percent"
  | "unallocated-spend-percent"
  | "idle-waste-monthly-micros"
  | "idle-waste-finding-count"
  | "alert-metric";

export const GOVERNANCE_SIGNAL_KINDS: readonly GovernanceSignalKind[] = [
  "budget-burndown-status",
  "budget-consumed-percent",
  "budget-days-to-breach",
  "cost-anomaly-count",
  "untagged-spend-percent",
  "required-tag-coverage-percent",
  "unallocated-spend-percent",
  "idle-waste-monthly-micros",
  "idle-waste-finding-count",
  "alert-metric",
];

export interface GovernanceSignalDescriptor {
  readonly signal: GovernanceSignalKind;
  readonly label: string;
  readonly source: string;
}

export const GOVERNANCE_SIGNAL_DESCRIPTORS: readonly GovernanceSignalDescriptor[] = [
  {
    signal: "budget-burndown-status",
    label: "Budget burn-down status",
    source: "lib/finops-budget-burndown.ts — status of each budget as of the latest usage day present in the ingested billing file.",
  },
  {
    signal: "budget-consumed-percent",
    label: "Highest budget consumed percent",
    source: "lib/finops-budget-burndown.ts — highest month-to-date consumed percent across budgets with a derivable percent.",
  },
  {
    signal: "budget-days-to-breach",
    label: "Fewest days to budget breach",
    source: "lib/finops-budget-burndown.ts — fewest days until the disclosed straight-line run-rate crosses a budget.",
  },
  {
    signal: "cost-anomaly-count",
    label: "Cost anomalies detected",
    source: "lib/finops-insights.ts detectAnomalies — statistical spike signals over ingested billing lines. Not billing truth.",
  },
  {
    signal: "untagged-spend-percent",
    label: "Untagged spend percent",
    source: "lib/finops-tag-governance.ts — share of per-currency CUR spend on lines missing a required tag.",
  },
  {
    signal: "required-tag-coverage-percent",
    label: "Lowest required-tag coverage percent",
    source: "lib/finops-tag-governance.ts — lowest per-tag coverage across collected resources.",
  },
  {
    signal: "unallocated-spend-percent",
    label: "Unallocated spend percent",
    source: "lib/finops-allocation-rules.ts — share of ingested spend matched by no allocation rule.",
  },
  {
    signal: "idle-waste-monthly-micros",
    label: "Derivable idle/waste per month",
    source: "lib/finops-idle-waste.ts — per-currency derivable monthly waste in micro-units. An estimate, never a quote.",
  },
  {
    signal: "idle-waste-finding-count",
    label: "Idle/waste findings",
    source: "lib/finops-idle-waste.ts — count of idle/waste findings over collected CMDB evidence.",
  },
  {
    signal: "alert-metric",
    label: "Sutra alert metric",
    source: "lib/alert-metrics.ts — the same metric readings the alert-rule engine consumes (findings, KEV, posture, budgets, anomalies).",
  },
];

/**
 * The complete action set. Sutra's customer role grants zero mutating cloud
 * permissions, so an action is only allowed here when Sutra can genuinely
 * perform it inside Sutra, or when the CUSTOMER performs the change themselves
 * from something Sutra produced. `performedBy` is part of the contract and the
 * label must stay honest about who acts.
 */
export type GovernanceActionKind =
  | "open-case"
  | "notify-destination"
  | "accept-risk-with-expiry"
  | "generate-remediation-artefact"
  | "block-ci-gate";

export const GOVERNANCE_ACTION_KINDS: readonly GovernanceActionKind[] = [
  "open-case",
  "notify-destination",
  "accept-risk-with-expiry",
  "generate-remediation-artefact",
  "block-ci-gate",
];

export interface GovernanceActionDescriptor {
  readonly kind: GovernanceActionKind;
  /** Names who performs the action, in the UI and in the audit trail. */
  readonly label: string;
  readonly performedBy: "sutra" | "customer";
  readonly description: string;
  /** Always false: Sutra holds read-only access to customer accounts. */
  readonly mutatesCustomerCloud: false;
}

export const GOVERNANCE_ACTION_DESCRIPTORS: readonly GovernanceActionDescriptor[] = [
  {
    kind: "open-case",
    label: "Sutra proposes opening a case",
    performedBy: "sutra",
    description:
      "Produces a governed proposal to create a case in Sutra. Policy evaluation creates and routes nothing: current case-routing rules are preview-only, and ITSM delivery requires a separate authorized dispatch. Nothing changes in the customer's cloud account.",
    mutatesCustomerCloud: false,
  },
  {
    kind: "notify-destination",
    label: "Sutra notifies a configured destination",
    performedBy: "sutra",
    description:
      "Sends the matched evidence to a Sutra notification destination the operator configured. Notification only — no cloud change.",
    mutatesCustomerCloud: false,
  },
  {
    kind: "accept-risk-with-expiry",
    label: "Sutra records an accepted-risk exception with an expiry",
    performedBy: "sutra",
    description:
      "Records, inside Sutra, that a finding or budget breach is accepted until a stated expiry date. It suppresses Sutra's own surfacing until then and changes nothing in the customer's cloud; the underlying risk is unchanged.",
    mutatesCustomerCloud: false,
  },
  {
    kind: "generate-remediation-artefact",
    label: "Sutra generates a remediation artefact for the customer to apply",
    performedBy: "customer",
    description:
      "Produces a reviewable artefact (template / command / policy document). The customer applies it in their own account with their own credentials — Sutra never executes it.",
    mutatesCustomerCloud: false,
  },
  {
    kind: "block-ci-gate",
    label: "Customer's CI pipeline fails its Sutra scan gate",
    performedBy: "customer",
    description:
      "Marks the condition as gate-breaching so the customer's own pipeline, running Sutra's CI scan gate, fails its next build. The customer's CI enforces it; Sutra does not stop any deployment or resource.",
    mutatesCustomerCloud: false,
  },
];

export function isGovernanceActionKind(value: unknown): value is GovernanceActionKind {
  return typeof value === "string" && (GOVERNANCE_ACTION_KINDS as readonly string[]).includes(value);
}

export function isGovernanceSignalKind(value: unknown): value is GovernanceSignalKind {
  return typeof value === "string" && (GOVERNANCE_SIGNAL_KINDS as readonly string[]).includes(value);
}

export function isGovernanceBudgetStatus(value: unknown): value is GovernanceBudgetStatus {
  return typeof value === "string" && (GOVERNANCE_BUDGET_STATUSES as readonly string[]).includes(value);
}

export function governanceActionDescriptor(kind: GovernanceActionKind): GovernanceActionDescriptor {
  const found = GOVERNANCE_ACTION_DESCRIPTORS.find((entry) => entry.kind === kind);
  if (found === undefined) throw new Error(`Unknown governance action: ${kind}`);
  return found;
}

/** One leaf predicate over a single signal. */
export interface GovernanceSignalCondition {
  readonly signal: GovernanceSignalKind;
  readonly comparator?: AlertComparator;
  readonly threshold?: number;
  /** Only for "budget-burndown-status": the statuses that satisfy the leaf. */
  readonly statuses?: readonly GovernanceBudgetStatus[];
  /** Only for "alert-metric": which existing metric reading to compare. */
  readonly metric?: AlertMetricKey;
  /** Restricts a per-currency signal to one currency (never summed across currencies). */
  readonly currency?: string;
  /** Restricts a budget signal to one budget id. */
  readonly budgetId?: string;
}

export type GovernanceCondition =
  | { readonly all: readonly GovernanceCondition[] }
  | { readonly any: readonly GovernanceCondition[] }
  | { readonly not: GovernanceCondition }
  | GovernanceSignalCondition;

export interface GovernanceActionSpec {
  readonly kind: GovernanceActionKind;
  /** What the action is aimed at (case queue, destination id, budget id, gate stage). */
  readonly target?: string | null;
  /** Required for accept-risk-with-expiry: the acceptance window in days. */
  readonly expiresInDays?: number | null;
  readonly note?: string | null;
}

export interface GovernancePolicyScope {
  /** null = applies to every customer in the org. */
  readonly customerId: string | null;
  /** null = applies to every connection in scope. */
  readonly connectionId?: string | null;
}

export interface GovernancePolicy {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  /** Lower runs first; ties break on id so ordering is total and deterministic. */
  readonly priority: number;
  readonly scope: GovernancePolicyScope;
  readonly condition: GovernanceCondition;
  readonly action: GovernanceActionSpec;
  readonly requiresApproval: boolean;
}

/**
 * Everything the engine may read. Each field is the OUTPUT of an existing
 * engine. An omitted / null field is UNKNOWN — leaves that need it report
 * `signal-unavailable` and never contribute a match.
 */
export interface GovernanceSignals {
  readonly budgetBurndown?: BudgetBurndownResult | null;
  readonly anomalies?: AnomalyResult | null;
  readonly tagGovernance?: TagGovernanceReport | null;
  readonly allocation?: AllocationResult | null;
  readonly idleWaste?: IdleWasteReport | null;
  /** The same readings the alert-rule engine consumes (lib/alert-metrics.ts). */
  readonly alertMetrics?: AlertMetricMap;
}

export interface GovernanceEvaluationContext {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId?: string | null;
  readonly signals: GovernanceSignals;
}

export type GovernanceTruth = "true" | "false" | "unknown";

export interface GovernanceEvidence {
  readonly signal: GovernanceSignalKind;
  readonly label: string;
  readonly observed: number | string | null;
  readonly comparator: AlertComparator | null;
  readonly threshold: number | null;
  readonly truth: GovernanceTruth;
  /** Where the number came from, or exactly why it is unavailable. */
  readonly basis: string;
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ProposedGovernanceAction {
  readonly kind: GovernanceActionKind;
  readonly label: string;
  readonly performedBy: "sutra" | "customer";
  readonly description: string;
  readonly mutatesCustomerCloud: false;
  readonly target: string | null;
  readonly expiresInDays: number | null;
  readonly note: string | null;
}

export type GovernanceDecisionState =
  | "matched"
  | "not-matched"
  | "signal-unavailable"
  | "disabled"
  | "out-of-scope";

export interface GovernancePolicyDecision {
  readonly policyId: string;
  readonly policyName: string;
  readonly priority: number;
  readonly requiresApproval: boolean;
  readonly state: GovernanceDecisionState;
  readonly matched: boolean;
  readonly reason: string;
  readonly evidence: readonly GovernanceEvidence[];
  readonly proposedAction: ProposedGovernanceAction | null;
  /** True when the policy matched AND an approval must be recorded first. */
  readonly pendingApproval: boolean;
  /**
   * Deterministic idempotency key for the approval request this decision would
   * raise (no clock, no randomness), so re-evaluating the same state does not
   * queue a second request for the same target.
   */
  readonly approvalRequestKey: string | null;
}

export interface GovernancePolicyReport {
  readonly schema: "sutra.governance-policy-engine.v1";
  readonly evaluatedAtIso: string;
  readonly customerId: string;
  readonly connectionId: string | null;
  readonly decisions: readonly GovernancePolicyDecision[];
  readonly summary: {
    readonly total: number;
    readonly matched: number;
    readonly pendingApproval: number;
    readonly readyToAct: number;
    readonly signalUnavailable: number;
    readonly disabled: number;
    readonly outOfScope: number;
  };
  readonly limitations: readonly string[];
  readonly disclaimer: string;
}

export const GOVERNANCE_POLICY_DISCLAIMER =
  "Governance policies decide, they do not act. Sutra holds read-only access to " +
  "customer accounts, so no policy can stop, patch, resize or delete a customer " +
  "resource: an action either happens inside Sutra (propose a case, notify a " +
  "destination, record an accepted-risk exception with an expiry) or produces " +
  "something the customer applies themselves (a remediation artefact, or a CI " +
  "gate result their own pipeline enforces). A policy matches only on signals " +
  "that are genuinely available — a missing signal is disclosed, never treated " +
  "as zero — and a policy that requires approval takes no action until a " +
  "separate human approval is recorded.";

const GOVERNANCE_LIMITATIONS: readonly string[] = [
  "SUTRA_ACCESS_IS_READ_ONLY_NO_POLICY_ACTION_MUTATES_A_CUSTOMER_RESOURCE",
  "A_MISSING_SIGNAL_IS_UNKNOWN_AND_NEVER_TREATED_AS_ZERO_OR_FALSE",
  "SPEND_PERCENTAGES_ARE_PER_CURRENCY_AND_NEVER_SUMMED_ACROSS_CURRENCIES",
  "COST_ANOMALIES_AND_WASTE_ESTIMATES_ARE_SIGNALS_NOT_BILLING_TRUTH",
  "AN_APPROVAL_GATED_POLICY_TAKES_NO_ACTION_UNTIL_A_HUMAN_APPROVAL_IS_RECORDED",
];

const UNAVAILABLE = "SIGNAL_NOT_AVAILABLE_NO_DECISION_CLAIMED";

function descriptorFor(signal: GovernanceSignalKind): GovernanceSignalDescriptor {
  const found = GOVERNANCE_SIGNAL_DESCRIPTORS.find((entry) => entry.signal === signal);
  return found ?? { signal, label: signal, source: "unknown" };
}

function unknownEvidence(
  condition: GovernanceSignalCondition,
  basis: string,
  detail?: Readonly<Record<string, string | number | boolean | null>>,
): GovernanceEvidence {
  return {
    signal: condition.signal,
    label: descriptorFor(condition.signal).label,
    observed: null,
    comparator: condition.comparator ?? null,
    threshold: condition.threshold ?? null,
    truth: "unknown",
    basis,
    ...(detail === undefined ? {} : { detail }),
  };
}

function numericEvidence(
  condition: GovernanceSignalCondition,
  observed: number,
  basis: string,
  detail?: Readonly<Record<string, string | number | boolean | null>>,
): GovernanceEvidence {
  // A numeric leaf needs a comparator and a finite threshold; without one the
  // leaf is not decidable and is disclosed as unknown rather than guessed.
  if (
    condition.comparator === undefined ||
    !isAlertComparator(condition.comparator) ||
    typeof condition.threshold !== "number" ||
    !Number.isFinite(condition.threshold)
  ) {
    return unknownEvidence(condition, "CONDITION_IS_MISSING_A_COMPARATOR_OR_FINITE_THRESHOLD", detail);
  }
  const truth = compareMetric(observed, condition.comparator, condition.threshold) ? "true" : "false";
  return {
    signal: condition.signal,
    label: descriptorFor(condition.signal).label,
    observed,
    comparator: condition.comparator,
    threshold: condition.threshold,
    truth,
    basis,
    ...(detail === undefined ? {} : { detail }),
  };
}

function percentOfBig(part: bigint, whole: bigint): number | null {
  if (whole <= BigInt(0)) return null;
  return Number((part * BigInt(1000000)) / whole) / 10000;
}

function budgetsInScope(
  burndown: BudgetBurndownResult,
  budgetId: string | undefined,
): BudgetBurndownResult["budgets"] {
  return budgetId === undefined ? burndown.budgets : burndown.budgets.filter((budget) => budget.id === budgetId);
}

function evaluateBudgetStatus(
  condition: GovernanceSignalCondition,
  signals: GovernanceSignals,
): GovernanceEvidence {
  const burndown = signals.budgetBurndown;
  if (burndown === undefined || burndown === null) {
    return unknownEvidence(condition, `${UNAVAILABLE} No budget burn-down has been computed for this scope.`);
  }
  const wanted = (condition.statuses ?? ["breached"]).filter(isGovernanceBudgetStatus);
  if (wanted.length === 0) {
    return unknownEvidence(condition, "CONDITION_NAMES_NO_BUDGET_STATUS_NO_DECISION_CLAIMED");
  }
  const budgets = budgetsInScope(burndown, condition.budgetId);
  if (budgets.length === 0) {
    return unknownEvidence(
      condition,
      `${UNAVAILABLE} No budget in this scope has ingested billing data for period ${burndown.period}.`,
      { period: burndown.period, budgetId: condition.budgetId ?? null },
    );
  }
  // Deterministic pick: the first budget (in the burn-down's own order) whose
  // status satisfies the leaf; otherwise the first budget as the counterexample.
  const hit = budgets.find((budget) => wanted.includes(budget.status));
  const witness = hit ?? budgets[0];
  return {
    signal: condition.signal,
    label: descriptorFor(condition.signal).label,
    observed: witness.status,
    comparator: null,
    threshold: null,
    truth: hit === undefined ? "false" : "true",
    basis: `Budget "${witness.name}" is ${witness.status} as of day ${burndown.asOfDayIndex} of ${burndown.period} (latest usage day present in the ingested billing file).`,
    detail: {
      budgetId: witness.id,
      budgetName: witness.name,
      status: witness.status,
      currency: witness.currency,
      mtdMicros: witness.mtdMicros,
      budgetMicros: witness.budgetMicros,
      consumedPercent: witness.consumedPercent,
      daysToBreach: witness.daysToBreach,
      period: burndown.period,
      wantedStatuses: wanted.join(","),
    },
  };
}

function evaluateBudgetConsumedPercent(
  condition: GovernanceSignalCondition,
  signals: GovernanceSignals,
): GovernanceEvidence {
  const burndown = signals.budgetBurndown;
  if (burndown === undefined || burndown === null) {
    return unknownEvidence(condition, `${UNAVAILABLE} No budget burn-down has been computed for this scope.`);
  }
  const candidates = budgetsInScope(burndown, condition.budgetId).filter(
    (budget) => budget.consumedPercent !== null && Number.isFinite(budget.consumedPercent),
  );
  if (candidates.length === 0) {
    return unknownEvidence(
      condition,
      `${UNAVAILABLE} No budget in this scope has a derivable consumed percent (a zero or unfunded limit yields no percent).`,
      { period: burndown.period },
    );
  }
  let worst = candidates[0];
  for (const budget of candidates) {
    if ((budget.consumedPercent ?? 0) > (worst.consumedPercent ?? 0)) worst = budget;
  }
  const observed = worst.consumedPercent ?? 0;
  return numericEvidence(
    condition,
    observed,
    `Highest month-to-date consumption is ${observed}% on budget "${worst.name}" as of day ${burndown.asOfDayIndex} of ${burndown.period}.`,
    { budgetId: worst.id, budgetName: worst.name, currency: worst.currency, period: burndown.period, status: worst.status },
  );
}

function evaluateBudgetDaysToBreach(
  condition: GovernanceSignalCondition,
  signals: GovernanceSignals,
): GovernanceEvidence {
  const burndown = signals.budgetBurndown;
  if (burndown === undefined || burndown === null) {
    return unknownEvidence(condition, `${UNAVAILABLE} No budget burn-down has been computed for this scope.`);
  }
  const candidates = budgetsInScope(burndown, condition.budgetId).filter(
    (budget) => budget.daysToBreach !== null && Number.isFinite(budget.daysToBreach),
  );
  if (candidates.length === 0) {
    return unknownEvidence(
      condition,
      `${UNAVAILABLE} The disclosed straight-line run-rate does not cross any budget in this scope within the month, so no days-to-breach exists.`,
      { period: burndown.period },
    );
  }
  let soonest = candidates[0];
  for (const budget of candidates) {
    if ((budget.daysToBreach ?? 0) < (soonest.daysToBreach ?? 0)) soonest = budget;
  }
  const observed = soonest.daysToBreach ?? 0;
  return numericEvidence(
    condition,
    observed,
    `Budget "${soonest.name}" is ${observed} day(s) from breaching on the disclosed straight-line run-rate (a forecast, not a bill).`,
    { budgetId: soonest.id, budgetName: soonest.name, currency: soonest.currency, period: burndown.period },
  );
}

function evaluateAnomalyCount(
  condition: GovernanceSignalCondition,
  signals: GovernanceSignals,
): GovernanceEvidence {
  const result = signals.anomalies;
  if (result === undefined || result === null) {
    return unknownEvidence(condition, `${UNAVAILABLE} No cost-anomaly detection has been run for this scope.`);
  }
  if (result.evaluatedDays <= 0) {
    return unknownEvidence(
      condition,
      `${UNAVAILABLE} No billing days were evaluated, so an anomaly count of zero would be meaningless.`,
      { evaluatedDays: result.evaluatedDays },
    );
  }
  const scoped = condition.currency === undefined
    ? result.anomalies
    : result.anomalies.filter((anomaly) => anomaly.currency === condition.currency);
  const first = scoped[0] ?? null;
  return numericEvidence(
    condition,
    scoped.length,
    `${scoped.length} statistical cost-spike signal(s) over ${result.evaluatedDays} evaluated billing day(s)${condition.currency === undefined ? "" : ` in ${condition.currency}`}. A signal, not billing truth.`,
    first === null
      ? { evaluatedDays: result.evaluatedDays, currency: condition.currency ?? null }
      : {
        evaluatedDays: result.evaluatedDays,
        currency: first.currency,
        topService: first.service,
        topDay: first.dateIso,
        topAmountMicros: first.amountMicros,
        topBaselineMicros: first.baselineMicros,
        topRatio: first.ratio,
      },
  );
}

function evaluateUntaggedSpendPercent(
  condition: GovernanceSignalCondition,
  signals: GovernanceSignals,
): GovernanceEvidence {
  const report = signals.tagGovernance;
  if (report === undefined || report === null) {
    return unknownEvidence(condition, `${UNAVAILABLE} No tag-governance report has been computed for this scope.`);
  }
  const scoped = condition.currency === undefined
    ? report.spendByCurrency
    : report.spendByCurrency.filter((entry) => entry.currency === condition.currency);
  const withPercent = scoped.filter((entry) => entry.untaggedPercent !== null);
  if (withPercent.length === 0) {
    return unknownEvidence(
      condition,
      `${UNAVAILABLE} No ingested billing spend${condition.currency === undefined ? "" : ` in ${condition.currency}`}, so no untagged-spend percent is derivable.`,
      { currency: condition.currency ?? null },
    );
  }
  // Per currency, never summed: the worst single currency is the witness.
  let worst = withPercent[0];
  for (const entry of withPercent) {
    if ((entry.untaggedPercent ?? 0) > (worst.untaggedPercent ?? 0)) worst = entry;
  }
  const observed = worst.untaggedPercent ?? 0;
  return numericEvidence(
    condition,
    observed,
    `${observed}% of ingested ${worst.currency} spend is on billing lines missing at least one required tag (${report.requiredTags.join(", ")}). A coverage statement, not proof of untracked cost.`,
    {
      currency: worst.currency,
      untaggedMicros: worst.untaggedMicros,
      totalMicros: worst.totalMicros,
      unattributableMicros: worst.unattributableMicros,
      untaggedLineCount: worst.untaggedLineCount,
    },
  );
}

function evaluateTagCoveragePercent(
  condition: GovernanceSignalCondition,
  signals: GovernanceSignals,
): GovernanceEvidence {
  const report = signals.tagGovernance;
  if (report === undefined || report === null) {
    return unknownEvidence(condition, `${UNAVAILABLE} No tag-governance report has been computed for this scope.`);
  }
  const withPercent = report.resourceCoverage.filter((entry) => entry.coveragePercent !== null);
  if (withPercent.length === 0) {
    return unknownEvidence(
      condition,
      `${UNAVAILABLE} No collected resources were evaluated, so tag coverage is not derivable.`,
      { resourcesEvaluated: report.summary.resourcesEvaluated },
    );
  }
  let lowest = withPercent[0];
  for (const entry of withPercent) {
    if ((entry.coveragePercent ?? 0) < (lowest.coveragePercent ?? 0)) lowest = entry;
  }
  const observed = lowest.coveragePercent ?? 0;
  return numericEvidence(
    condition,
    observed,
    `Lowest required-tag coverage is ${observed}% for tag "${lowest.tag}" across ${lowest.resourcesTotal} collected resource(s).`,
    {
      tag: lowest.tag,
      resourcesTotal: lowest.resourcesTotal,
      resourcesWithTag: lowest.resourcesWithTag,
      missingResourceCount: lowest.missingResourceKeys.length,
    },
  );
}

function evaluateUnallocatedSpendPercent(
  condition: GovernanceSignalCondition,
  signals: GovernanceSignals,
): GovernanceEvidence {
  const result = signals.allocation;
  if (result === undefined || result === null) {
    return unknownEvidence(condition, `${UNAVAILABLE} No allocation-rule run has been computed for this scope.`);
  }
  if (condition.currency !== undefined && result.currency !== null && result.currency !== condition.currency) {
    return unknownEvidence(
      condition,
      `${UNAVAILABLE} The allocation run covers ${result.currency}, not ${condition.currency}; currencies are never mixed.`,
      { runCurrency: result.currency, requestedCurrency: condition.currency },
    );
  }
  const total = BigInt(result.totalMicros);
  const unallocated = BigInt(result.unallocated.amountMicros);
  const percent = percentOfBig(unallocated, total);
  if (percent === null) {
    return unknownEvidence(
      condition,
      `${UNAVAILABLE} The allocation run covers no spend, so an unallocated percent is not derivable.`,
      { ruleCount: result.ruleCount },
    );
  }
  return numericEvidence(
    condition,
    percent,
    `${percent}% of ingested ${result.currency ?? "mixed-currency"} spend was matched by none of the ${result.ruleCount} enabled allocation rule(s).`,
    {
      currency: result.currency,
      unallocatedMicros: result.unallocated.amountMicros,
      totalMicros: result.totalMicros,
      unallocatedLineCount: result.unallocated.lineCount,
      ruleCount: result.ruleCount,
    },
  );
}

function evaluateIdleWasteMicros(
  condition: GovernanceSignalCondition,
  signals: GovernanceSignals,
): GovernanceEvidence {
  const report = signals.idleWaste;
  if (report === undefined || report === null) {
    return unknownEvidence(condition, `${UNAVAILABLE} No idle/waste report has been computed for this scope.`);
  }
  const currency = condition.currency ?? "USD";
  const totals = report.summary.wasteByCurrencyMicros;
  const raw = Object.prototype.hasOwnProperty.call(totals, currency) ? totals[currency] : undefined;
  if (raw === undefined) {
    return unknownEvidence(
      condition,
      `${UNAVAILABLE} No derivable ${currency} waste amount: ${report.summary.findingsWithoutEstimate} of ${report.summary.count} finding(s) carry no derivable cost, and none totalled in ${currency}.`,
      { currency, findingCount: report.summary.count, findingsWithoutEstimate: report.summary.findingsWithoutEstimate },
    );
  }
  const observed = Number(BigInt(raw));
  return numericEvidence(
    condition,
    observed,
    `Derivable ${currency} idle/waste is ${observed} micro-units per month across ${report.summary.count} finding(s); ${report.summary.findingsWithoutEstimate} finding(s) carry no derivable cost. An estimate, never a quote.`,
    {
      currency,
      wasteMicros: raw,
      findingCount: report.summary.count,
      findingsWithoutEstimate: report.summary.findingsWithoutEstimate,
    },
  );
}

function evaluateIdleWasteCount(
  condition: GovernanceSignalCondition,
  signals: GovernanceSignals,
): GovernanceEvidence {
  const report = signals.idleWaste;
  if (report === undefined || report === null) {
    return unknownEvidence(condition, `${UNAVAILABLE} No idle/waste report has been computed for this scope.`);
  }
  return numericEvidence(
    condition,
    report.summary.count,
    `${report.summary.count} idle/waste finding(s) over collected CMDB evidence; ${report.summary.findingsWithoutEstimate} carry no derivable cost.`,
    { findingsWithoutEstimate: report.summary.findingsWithoutEstimate },
  );
}

function evaluateAlertMetric(
  condition: GovernanceSignalCondition,
  signals: GovernanceSignals,
): GovernanceEvidence {
  const metric = condition.metric;
  if (metric === undefined || !isSupportedAlertMetric(metric)) {
    return unknownEvidence(condition, "CONDITION_NAMES_NO_SUPPORTED_ALERT_METRIC_NO_DECISION_CLAIMED", {
      metric: metric ?? null,
    });
  }
  const reading = signals.alertMetrics?.[metric];
  if (reading === undefined || !reading.available || reading.value === null) {
    return unknownEvidence(
      condition,
      `${UNAVAILABLE} ${reading?.basis ?? `The metric "${metric}" was not provided.`}`,
      { metric },
    );
  }
  return numericEvidence(condition, reading.value, `${metric}: ${reading.basis}`, { metric });
}

function evaluateLeaf(condition: GovernanceSignalCondition, signals: GovernanceSignals): GovernanceEvidence {
  switch (condition.signal) {
    case "budget-burndown-status": return evaluateBudgetStatus(condition, signals);
    case "budget-consumed-percent": return evaluateBudgetConsumedPercent(condition, signals);
    case "budget-days-to-breach": return evaluateBudgetDaysToBreach(condition, signals);
    case "cost-anomaly-count": return evaluateAnomalyCount(condition, signals);
    case "untagged-spend-percent": return evaluateUntaggedSpendPercent(condition, signals);
    case "required-tag-coverage-percent": return evaluateTagCoveragePercent(condition, signals);
    case "unallocated-spend-percent": return evaluateUnallocatedSpendPercent(condition, signals);
    case "idle-waste-monthly-micros": return evaluateIdleWasteMicros(condition, signals);
    case "idle-waste-finding-count": return evaluateIdleWasteCount(condition, signals);
    case "alert-metric": return evaluateAlertMetric(condition, signals);
    default:
      return unknownEvidence(
        condition as GovernanceSignalCondition,
        "CONDITION_NAMES_AN_UNSUPPORTED_SIGNAL_NO_DECISION_CLAIMED",
      );
  }
}

function isAllNode(condition: GovernanceCondition): condition is { readonly all: readonly GovernanceCondition[] } {
  return Object.prototype.hasOwnProperty.call(condition, "all");
}

function isAnyNode(condition: GovernanceCondition): condition is { readonly any: readonly GovernanceCondition[] } {
  return Object.prototype.hasOwnProperty.call(condition, "any");
}

function isNotNode(condition: GovernanceCondition): condition is { readonly not: GovernanceCondition } {
  return Object.prototype.hasOwnProperty.call(condition, "not");
}

/**
 * Three-valued composition. A definite answer wins over unknown, so a policy
 * can still decide when an irrelevant signal is missing:
 *  - all: one definite false => false; else any unknown => unknown; else true.
 *  - any: one definite true => true; else any unknown => unknown; else false.
 *  - not: negates a definite value; unknown stays unknown.
 * An empty all() is unknown, not vacuously true — a policy with no condition
 * must never match.
 */
function evaluateCondition(
  condition: GovernanceCondition,
  signals: GovernanceSignals,
  evidence: GovernanceEvidence[],
  depth: number,
): GovernanceTruth {
  if (depth > 8) return "unknown";
  if (isAllNode(condition)) {
    const children = condition.all;
    if (!Array.isArray(children) || children.length === 0) return "unknown";
    let unknownSeen = false;
    for (const child of children) {
      const truth = evaluateCondition(child, signals, evidence, depth + 1);
      if (truth === "false") return "false";
      if (truth === "unknown") unknownSeen = true;
    }
    return unknownSeen ? "unknown" : "true";
  }
  if (isAnyNode(condition)) {
    const children = condition.any;
    if (!Array.isArray(children) || children.length === 0) return "unknown";
    let unknownSeen = false;
    let trueSeen = false;
    for (const child of children) {
      const truth = evaluateCondition(child, signals, evidence, depth + 1);
      if (truth === "true") trueSeen = true;
      else if (truth === "unknown") unknownSeen = true;
    }
    if (trueSeen) return "true";
    return unknownSeen ? "unknown" : "false";
  }
  if (isNotNode(condition)) {
    const truth = evaluateCondition(condition.not, signals, evidence, depth + 1);
    if (truth === "unknown") return "unknown";
    return truth === "true" ? "false" : "true";
  }
  const leaf = evaluateLeaf(condition, signals);
  evidence.push(leaf);
  return leaf.truth;
}

function proposeAction(policy: GovernancePolicy): ProposedGovernanceAction | null {
  if (!isGovernanceActionKind(policy.action.kind)) return null;
  const descriptor = governanceActionDescriptor(policy.action.kind);
  return {
    kind: descriptor.kind,
    label: descriptor.label,
    performedBy: descriptor.performedBy,
    description: descriptor.description,
    mutatesCustomerCloud: false,
    target: policy.action.target ?? null,
    expiresInDays: policy.action.expiresInDays ?? null,
    note: policy.action.note ?? null,
  };
}

/**
 * Deterministic approval-request key: the policy, the action kind and the
 * action target. No clock and no randomness, so re-evaluating identical state
 * yields the same key and the approval queue does not grow duplicates.
 */
export function governanceApprovalRequestKey(policy: GovernancePolicy): string {
  return [policy.id, policy.action.kind, policy.action.target ?? "-"].join("|");
}

function inScope(policy: GovernancePolicy, context: GovernanceEvaluationContext): boolean {
  const scopedCustomer = policy.scope.customerId;
  if (scopedCustomer !== null && scopedCustomer !== undefined && scopedCustomer !== context.customerId) return false;
  const scopedConnection = policy.scope.connectionId ?? null;
  const contextConnection = context.connectionId ?? null;
  if (scopedConnection !== null && contextConnection !== null && scopedConnection !== contextConnection) return false;
  return true;
}

/** Total, deterministic policy order: priority ascending, then id. */
export function orderGovernancePolicies(
  policies: readonly GovernancePolicy[],
): readonly GovernancePolicy[] {
  return policies
    .slice()
    .sort((a, b) => (a.priority - b.priority) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Evaluate every policy against the supplied signals. Pure and deterministic —
 * `now` is injected and is used only to stamp the report.
 */
export function evaluateGovernancePolicies(
  policies: readonly GovernancePolicy[],
  context: GovernanceEvaluationContext,
  now: number,
): GovernancePolicyReport {
  const decisions: GovernancePolicyDecision[] = orderGovernancePolicies(policies).map((policy) => {
    const base = {
      policyId: policy.id,
      policyName: policy.name,
      priority: policy.priority,
      requiresApproval: policy.requiresApproval,
    } as const;
    if (!policy.enabled) {
      return {
        ...base,
        state: "disabled" as const,
        matched: false,
        reason: "The policy is disabled and was not evaluated.",
        evidence: [],
        proposedAction: null,
        pendingApproval: false,
        approvalRequestKey: null,
      };
    }
    if (!inScope(policy, context)) {
      return {
        ...base,
        state: "out-of-scope" as const,
        matched: false,
        reason: "The policy is scoped to another customer or connection.",
        evidence: [],
        proposedAction: null,
        pendingApproval: false,
        approvalRequestKey: null,
      };
    }
    const evidence: GovernanceEvidence[] = [];
    const truth = evaluateCondition(policy.condition, context.signals, evidence, 0);
    if (truth === "unknown") {
      const missing = evidence.filter((entry) => entry.truth === "unknown");
      return {
        ...base,
        state: "signal-unavailable" as const,
        matched: false,
        reason: missing.length === 0
          ? "The policy condition is empty or malformed, so nothing was decided."
          : `Not decided — ${missing.length} signal(s) unavailable. ${missing[0].basis}`,
        evidence,
        proposedAction: null,
        pendingApproval: false,
        approvalRequestKey: null,
      };
    }
    if (truth === "false") {
      return {
        ...base,
        state: "not-matched" as const,
        matched: false,
        reason: "The policy condition was evaluated on available signals and is not satisfied.",
        evidence,
        proposedAction: null,
        pendingApproval: false,
        approvalRequestKey: null,
      };
    }
    const proposedAction = proposeAction(policy);
    if (proposedAction === null) {
      return {
        ...base,
        state: "signal-unavailable" as const,
        matched: false,
        reason: "The policy names an unsupported action, so no action is proposed.",
        evidence,
        proposedAction: null,
        pendingApproval: false,
        approvalRequestKey: null,
      };
    }
    return {
      ...base,
      state: "matched" as const,
      matched: true,
      reason: policy.requiresApproval
        ? `Matched on ${evidence.length} signal(s). ${proposedAction.label} — held for approval; nothing happens until an approval is recorded.`
        : `Matched on ${evidence.length} signal(s). ${proposedAction.label}.`,
      evidence,
      proposedAction,
      pendingApproval: policy.requiresApproval,
      approvalRequestKey: governanceApprovalRequestKey(policy),
    };
  });

  return {
    schema: "sutra.governance-policy-engine.v1",
    evaluatedAtIso: new Date(now).toISOString(),
    customerId: context.customerId,
    connectionId: context.connectionId ?? null,
    decisions,
    summary: {
      total: decisions.length,
      matched: decisions.filter((decision) => decision.matched).length,
      pendingApproval: decisions.filter((decision) => decision.pendingApproval).length,
      readyToAct: decisions.filter((decision) => decision.matched && !decision.pendingApproval).length,
      signalUnavailable: decisions.filter((decision) => decision.state === "signal-unavailable").length,
      disabled: decisions.filter((decision) => decision.state === "disabled").length,
      outOfScope: decisions.filter((decision) => decision.state === "out-of-scope").length,
    },
    limitations: GOVERNANCE_LIMITATIONS,
    disclaimer: GOVERNANCE_POLICY_DISCLAIMER,
  };
}

/** A concise, human-readable summary of a matched policy for a case or notification body. */
export function describeGovernanceDecision(decision: GovernancePolicyDecision): string {
  const parts = [`Policy "${decision.policyName}" ${decision.matched ? "matched" : `did not act (${decision.state})`}.`];
  if (decision.proposedAction !== null) {
    parts.push(
      `Proposed action: ${decision.proposedAction.label} (performed by ${decision.proposedAction.performedBy}).`,
    );
  }
  for (const entry of decision.evidence) {
    parts.push(`${entry.label}: ${entry.basis}`);
  }
  if (decision.pendingApproval) parts.push("Held pending human approval — no action has been taken.");
  return parts.join(" ");
}
