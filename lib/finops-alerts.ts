/**
 * Cost & budget alerting: a pure, deterministic engine that turns the signals
 * two existing FinOps engines already produce — spend anomalies
 * (finops-insights.detectAnomalies) and budget burn-down
 * (finops-budget-burndown.buildBudgetBurndown) — into a normalized alert list.
 *
 * This engine does NO I/O and NO delivery. It decides WHAT is worth alerting on
 * and how severe it is; the route reuses the existing notification outbox
 * (SecurityNotificationRepository.enqueue) to actually route an alert to
 * Slack / PagerDuty / Teams / webhook / email. Keeping evaluation pure means it
 * is fully testable and never fabricates a signal the source engines didn't.
 */

import type { DailyAnomaly } from "./finops-insights.ts";
import type { BudgetBurndown } from "./finops-budget-burndown.ts";

export type FinopsAlertSeverity = "critical" | "high" | "medium" | "low";
export type FinopsAlertKind = "cost_anomaly" | "budget_at_risk" | "budget_breached";

const SEVERITY_RANK: Record<FinopsAlertSeverity, number> = { critical: 3, high: 2, medium: 1, low: 0 };

export interface FinopsAlert {
  /** Stable, content-derived key: same signal → same id (used for dedup/idempotency). */
  readonly id: string;
  readonly kind: FinopsAlertKind;
  readonly severity: FinopsAlertSeverity;
  readonly title: string;
  readonly summary: string;
  readonly evidence: Record<string, string | number>;
}

export interface FinopsAlertEvaluation {
  readonly alerts: readonly FinopsAlert[];
  readonly counts: { readonly critical: number; readonly high: number; readonly medium: number; readonly low: number };
  readonly evaluated: { readonly anomalies: number; readonly budgets: number };
}

function microsToUnits(micros: string): number {
  try {
    return Number(BigInt(micros)) / 1_000_000;
  } catch {
    return 0;
  }
}

/** Anomaly severity scales with how far above baseline the day spiked. */
function anomalySeverity(ratio: number): FinopsAlertSeverity {
  if (ratio >= 10) return "critical";
  if (ratio >= 5) return "high";
  return "medium";
}

function anomalyAlert(anomaly: DailyAnomaly): FinopsAlert {
  const amount = microsToUnits(anomaly.amountMicros);
  const baseline = microsToUnits(anomaly.baselineMicros);
  return {
    id: `cost_anomaly:${anomaly.currency}:${anomaly.service}:${anomaly.dateIso}`,
    kind: "cost_anomaly",
    severity: anomalySeverity(anomaly.ratio),
    title: `Spend spike: ${anomaly.service}`,
    summary:
      `${anomaly.service} spend on ${anomaly.dateIso} was ${anomaly.ratio}x its trailing median ` +
      `(${amount.toFixed(2)} ${anomaly.currency} vs ${baseline.toFixed(2)} baseline).`,
    evidence: {
      service: anomaly.service,
      date: anomaly.dateIso,
      currency: anomaly.currency,
      amount: amount.toFixed(2),
      baseline: baseline.toFixed(2),
      ratio: anomaly.ratio,
    },
  };
}

function budgetAlert(budget: BudgetBurndown): FinopsAlert | null {
  if (budget.status === "ok") return null;
  const breached = budget.status === "breached";
  const overspend = budget.projectedOverspendMicros / 1_000_000;
  return {
    id: `${breached ? "budget_breached" : "budget_at_risk"}:${budget.id}`,
    kind: breached ? "budget_breached" : "budget_at_risk",
    severity: breached ? "critical" : "high",
    title: `${breached ? "Budget breached" : "Budget at risk"}: ${budget.name}`,
    summary: breached
      ? `Budget "${budget.name}" is projected to overspend by ${overspend.toFixed(2)} ${budget.currency} ` +
        `(${budget.consumedPercent === null ? "n/a" : `${Math.round(budget.consumedPercent)}%`} consumed).`
      : `Budget "${budget.name}" is trending over: ${budget.daysToBreach === null ? "on pace to breach" : `~${budget.daysToBreach} day(s) to breach`} ` +
        `at the current run-rate (${budget.consumedPercent === null ? "n/a" : `${Math.round(budget.consumedPercent)}%`} consumed).`,
    evidence: {
      budget: budget.name,
      currency: budget.currency,
      status: budget.status,
      consumedPercent: budget.consumedPercent === null ? "n/a" : Math.round(budget.consumedPercent),
      projectedOverspend: overspend.toFixed(2),
      daysToBreach: budget.daysToBreach === null ? "n/a" : budget.daysToBreach,
    },
  };
}

/**
 * Evaluate current anomalies + budget burn-downs into a normalized, severity-
 * filtered, deterministically-ordered alert list. `minSeverity` drops anything
 * below the threshold. No clock, no I/O — same inputs, same output.
 */
export function evaluateFinopsAlerts(input: {
  readonly anomalies: readonly DailyAnomaly[];
  readonly budgets: readonly BudgetBurndown[];
  readonly minSeverity?: FinopsAlertSeverity;
}): FinopsAlertEvaluation {
  const floor = SEVERITY_RANK[input.minSeverity ?? "low"];
  const alerts: FinopsAlert[] = [
    ...input.anomalies.map(anomalyAlert),
    ...input.budgets.map(budgetAlert).filter((alert): alert is FinopsAlert => alert !== null),
  ].filter((alert) => SEVERITY_RANK[alert.severity] >= floor);

  alerts.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.id.localeCompare(b.id, "en-US"));

  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const alert of alerts) counts[alert.severity] += 1;

  return {
    alerts,
    counts,
    evaluated: { anomalies: input.anomalies.length, budgets: input.budgets.length },
  };
}
