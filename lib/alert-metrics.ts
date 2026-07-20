// Pure assembly of the metric map that the alert engine evaluates. Given already
// gathered signals — the FinOps budget/anomaly engine outputs, a reduced set of
// open cloud vulnerability findings, and the Kubernetes posture scorecard fleet
// score — this derives one honest reading per supported metric. The single rule
// that matters: a metric is `available: true` only when the underlying source
// genuinely produced data. Absence is reported as unavailable with a basis, so
// the evaluator can never fire on data Sutra did not actually observe.
//
// This module is pure and deterministic: it performs no I/O and reads no clock.
// The thin async collector that fetches these signals from the repositories
// lives with the background job handler (db/background-job-handlers.ts); it
// hands the reduced signals here.

import type { AnomalyResult, BudgetEvaluation } from "./finops-insights.ts";
import {
  SUPPORTED_ALERT_METRICS,
  type AlertMetricKey,
  type AlertMetricMap,
  type AlertMetricReading,
} from "./alert-rules.ts";

export type FindingSeverityLike = "critical" | "high" | "medium" | "low" | "unknown";

/** One reduced open finding. `knownExploited` is resolved against the KEV catalog upstream. */
export interface OpenFindingSignal {
  readonly severity: FindingSeverityLike;
  readonly firstSeenMs: number;
  readonly knownExploited: boolean;
}

export interface CloudFindingSignals {
  readonly openFindings: readonly OpenFindingSignal[];
  /** Reference instant used to decide which findings are "new". */
  readonly asOfMs: number;
  /** A finding first seen within this many ms of `asOfMs` counts as new. */
  readonly newWindowMs: number;
  /** KEV catalog freshness; null means the catalog was not loaded (KEV unavailable). */
  readonly kevAsOf: string | null;
}

export interface PostureSignal {
  /** Fleet-average posture score from the scorecard; null when no cluster is scored. */
  readonly averageScore: number | null;
  readonly scoredClusterCount: number;
}

/**
 * The signals feeding metric derivation. A property left `undefined` means that
 * source was not reachable for this tenant — every metric it backs is reported
 * unavailable. `budgets`/`anomalies` present but empty is a real observation.
 */
export interface AlertMetricSignals {
  readonly budgets?: readonly BudgetEvaluation[];
  readonly anomalies?: AnomalyResult;
  readonly cloudFindings?: CloudFindingSignals;
  readonly posture?: PostureSignal;
}

export const DEFAULT_NEW_FINDING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function available(value: number, basis: string): AlertMetricReading {
  return { value, available: true, basis };
}

function unavailable(basis: string): AlertMetricReading {
  return { value: null, available: false, basis };
}

function budgetBreachCount(budgets: readonly BudgetEvaluation[] | undefined): AlertMetricReading {
  if (budgets === undefined) {
    return unavailable("FinOps billing data was not reachable for this tenant.");
  }
  const evaluated = budgets.filter((budget) => budget.state !== "no-data");
  if (evaluated.length === 0) {
    return unavailable(
      budgets.length === 0
        ? "No budgets are configured."
        : "Budgets are configured but none have ingested billing lines to evaluate.",
    );
  }
  const breached = evaluated.filter((budget) => budget.state === "breached").length;
  return available(
    breached,
    `${breached} of ${evaluated.length} budget(s) with billing data are breached.`,
  );
}

function budgetUtilizationPercent(budgets: readonly BudgetEvaluation[] | undefined): AlertMetricReading {
  if (budgets === undefined) {
    return unavailable("FinOps billing data was not reachable for this tenant.");
  }
  const utilizations = budgets
    .map((budget) => budget.utilizationPercent)
    .filter((percent): percent is number => percent !== null && Number.isFinite(percent));
  if (utilizations.length === 0) {
    return unavailable("No budget has ingested billing data to compute utilization.");
  }
  const highest = Math.max(...utilizations);
  return available(
    highest,
    `Highest utilization across ${utilizations.length} budget(s) with billing data.`,
  );
}

function costAnomalyCount(anomalies: AnomalyResult | undefined): AlertMetricReading {
  if (anomalies === undefined) {
    return unavailable("FinOps billing data was not reachable for this tenant.");
  }
  if (anomalies.evaluatedDays === 0) {
    return unavailable("No ingested billing lines to evaluate for anomalies.");
  }
  return available(
    anomalies.anomalies.length,
    `${anomalies.anomalies.length} statistical anomaly signal(s) over ${anomalies.evaluatedDays} evaluated service-day(s).`,
  );
}

function openCriticalFindings(cloudFindings: CloudFindingSignals | undefined): AlertMetricReading {
  if (cloudFindings === undefined) {
    return unavailable("No synced cloud vulnerability findings were reachable for this tenant.");
  }
  const count = cloudFindings.openFindings.filter((finding) => finding.severity === "critical").length;
  return available(
    count,
    `${count} open critical finding(s) across ${cloudFindings.openFindings.length} observed open finding(s).`,
  );
}

function newCriticalFindings(cloudFindings: CloudFindingSignals | undefined): AlertMetricReading {
  if (cloudFindings === undefined) {
    return unavailable("No synced cloud vulnerability findings were reachable for this tenant.");
  }
  const cutoff = cloudFindings.asOfMs - cloudFindings.newWindowMs;
  const count = cloudFindings.openFindings.filter(
    (finding) => finding.severity === "critical" && finding.firstSeenMs >= cutoff,
  ).length;
  const days = Math.round(cloudFindings.newWindowMs / (24 * 60 * 60 * 1000));
  return available(
    count,
    `${count} open critical finding(s) first observed within the last ${days} day(s).`,
  );
}

function kevVulnerabilityCount(cloudFindings: CloudFindingSignals | undefined): AlertMetricReading {
  if (cloudFindings === undefined) {
    return unavailable("No synced cloud vulnerability findings were reachable for this tenant.");
  }
  if (cloudFindings.kevAsOf === null) {
    return unavailable("The CISA KEV catalog was not loaded, so KEV matches cannot be counted.");
  }
  const count = cloudFindings.openFindings.filter((finding) => finding.knownExploited).length;
  return available(
    count,
    `${count} open finding(s) match the CISA KEV catalog (as of ${cloudFindings.kevAsOf}).`,
  );
}

function postureScore(posture: PostureSignal | undefined): AlertMetricReading {
  if (posture === undefined) {
    return unavailable("No Kubernetes clusters were reachable for this tenant.");
  }
  if (posture.averageScore === null || !Number.isFinite(posture.averageScore)) {
    return unavailable("No collected Kubernetes scan has produced a posture score yet.");
  }
  return available(
    posture.averageScore,
    `Fleet-average posture score across ${posture.scoredClusterCount} scored cluster(s).`,
  );
}

/**
 * Build one honest reading for every supported metric. Every key in
 * SUPPORTED_ALERT_METRICS is present in the returned map; unbacked or empty
 * sources yield `available: false` rather than a fabricated zero.
 */
export function assembleAlertMetrics(signals: AlertMetricSignals): AlertMetricMap {
  const map: Record<AlertMetricKey, AlertMetricReading> = {
    "budget-breach-count": budgetBreachCount(signals.budgets),
    "budget-utilization-percent": budgetUtilizationPercent(signals.budgets),
    "cost-anomaly-count": costAnomalyCount(signals.anomalies),
    "new-critical-findings-count": newCriticalFindings(signals.cloudFindings),
    "open-critical-findings-count": openCriticalFindings(signals.cloudFindings),
    "kev-vulnerability-count": kevVulnerabilityCount(signals.cloudFindings),
    "posture-score": postureScore(signals.posture),
  };
  // Defensive: guarantee the map covers exactly the supported metric set.
  for (const key of SUPPORTED_ALERT_METRICS) {
    if (map[key] === undefined) map[key] = unavailable("The metric was not derived.");
  }
  return map;
}
