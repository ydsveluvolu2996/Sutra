// Pure metric-alerting rule engine. A rule compares one Sutra-computed metric
// against a threshold; the evaluator decides, deterministically and with no I/O,
// whether it FIRES. The one non-negotiable honesty rule lives here: a rule can
// fire ONLY when its metric is genuinely available. An unavailable metric never
// fires — it is disclosed as "metric-unavailable", never silently treated as 0.
// Everything in this module is pure: values and the clock are injected by the
// caller, so the same evaluation runs identically in a route, a job, or a test.

export type AlertComparator = "gt" | "gte" | "lt" | "lte" | "eq";
export type AlertSeverity = "low" | "medium" | "high";

/**
 * The metrics an alert rule may target. Every key here is derived cleanly and
 * honestly from data Sutra already computes (FinOps budget/anomaly engines,
 * cloud vulnerability findings + the CISA KEV catalog, and the Kubernetes
 * posture scorecard). A metric that cannot be derived honestly is not listed.
 */
export type AlertMetricKey =
  | "budget-breach-count"
  | "budget-utilization-percent"
  | "cost-anomaly-count"
  | "new-critical-findings-count"
  | "open-critical-findings-count"
  | "kev-vulnerability-count"
  | "posture-score";

export const SUPPORTED_ALERT_METRICS: readonly AlertMetricKey[] = [
  "budget-breach-count",
  "budget-utilization-percent",
  "cost-anomaly-count",
  "new-critical-findings-count",
  "open-critical-findings-count",
  "kev-vulnerability-count",
  "posture-score",
];

export const ALERT_COMPARATORS: readonly AlertComparator[] = ["gt", "gte", "lt", "lte", "eq"];
export const ALERT_SEVERITIES: readonly AlertSeverity[] = ["low", "medium", "high"];

export interface AlertMetricDescriptor {
  readonly key: AlertMetricKey;
  readonly label: string;
  readonly unit: "count" | "percent" | "score";
  /** What the number means and where it comes from — shown in the UI. */
  readonly description: string;
}

export const ALERT_METRIC_DESCRIPTORS: readonly AlertMetricDescriptor[] = [
  {
    key: "budget-breach-count",
    label: "FinOps budgets breached",
    unit: "count",
    description: "Number of configured budgets whose spend, over the latest ingested billing period, has reached or exceeded its limit.",
  },
  {
    key: "budget-utilization-percent",
    label: "Highest budget utilization",
    unit: "percent",
    description: "Highest utilization percent across budgets that have ingested billing data for the latest period.",
  },
  {
    key: "cost-anomaly-count",
    label: "Cost anomalies detected",
    unit: "count",
    description: "Statistical cost-spike signals over ingested billing lines for the latest period. Not billing truth.",
  },
  {
    key: "new-critical-findings-count",
    label: "New critical findings",
    unit: "count",
    description: "Open critical cloud vulnerability findings first observed within the recent window.",
  },
  {
    key: "open-critical-findings-count",
    label: "Open critical findings",
    unit: "count",
    description: "Currently open critical cloud vulnerability findings across the tenant's connections.",
  },
  {
    key: "kev-vulnerability-count",
    label: "KEV-listed vulnerabilities",
    unit: "count",
    description: "Open findings whose CVE appears in the CISA Known Exploited Vulnerabilities catalog.",
  },
  {
    key: "posture-score",
    label: "Kubernetes posture score",
    unit: "score",
    description: "Fleet-average Kubernetes posture score (0-100) from collected scans. Lower is worse.",
  },
];

export interface AlertRuleScope {
  readonly orgId: string;
  readonly customerId: string;
}

export interface AlertRule {
  readonly id: string;
  readonly name: string;
  readonly metric: AlertMetricKey;
  readonly comparator: AlertComparator;
  readonly threshold: number;
  readonly severity: AlertSeverity;
  readonly scope: AlertRuleScope;
  readonly enabled: boolean;
  /** Optional notification destination id; null dispatches to all enabled destinations. */
  readonly destinationRef?: string | null;
}

/**
 * A single metric reading handed to the evaluator. `available` is authoritative:
 * when it is false the metric could not be derived honestly (no data, source
 * unreachable), `value` is meaningless, and no rule on this metric may fire.
 * `basis` is a short human-readable disclosure of how the value was derived (or
 * why it is unavailable).
 */
export interface AlertMetricReading {
  readonly value: number | null;
  readonly available: boolean;
  readonly basis: string;
}

export type AlertMetricMap = Readonly<Partial<Record<AlertMetricKey, AlertMetricReading>>>;

export type AlertRuleState =
  | "fired"
  | "not-fired"
  | "metric-unavailable"
  | "metric-unsupported"
  | "disabled";

export interface AlertRuleEvaluation {
  readonly rule: AlertRule;
  readonly fired: boolean;
  readonly observedValue: number | null;
  readonly available: boolean;
  readonly reason: string;
  readonly state: AlertRuleState;
}

export function isSupportedAlertMetric(value: unknown): value is AlertMetricKey {
  return typeof value === "string" && (SUPPORTED_ALERT_METRICS as readonly string[]).includes(value);
}

export function isAlertComparator(value: unknown): value is AlertComparator {
  return typeof value === "string" && (ALERT_COMPARATORS as readonly string[]).includes(value);
}

export function isAlertSeverity(value: unknown): value is AlertSeverity {
  return typeof value === "string" && (ALERT_SEVERITIES as readonly string[]).includes(value);
}

const COMPARATOR_SYMBOL: Readonly<Record<AlertComparator, string>> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  eq: "==",
};

/** Deterministic numeric comparison. Non-finite operands never satisfy a rule. */
export function compareMetric(value: number, comparator: AlertComparator, threshold: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(threshold)) return false;
  switch (comparator) {
    case "gt": return value > threshold;
    case "gte": return value >= threshold;
    case "lt": return value < threshold;
    case "lte": return value <= threshold;
    case "eq": return value === threshold;
    default: return false;
  }
}

/**
 * Evaluate every rule against the metrics map. Pure and deterministic. A rule
 * FIRES only when it is enabled, its metric is present AND available, the value
 * is finite, and the comparator/threshold is satisfied. In every other case it
 * does not fire, and the state/reason disclose exactly why — an unavailable or
 * absent metric is reported, never coerced to a firing.
 */
export function evaluateAlertRules(
  rules: readonly AlertRule[],
  metrics: AlertMetricMap,
): readonly AlertRuleEvaluation[] {
  return rules.map((rule) => {
    if (!rule.enabled) {
      return {
        rule,
        fired: false,
        observedValue: null,
        available: false,
        reason: "The rule is disabled.",
        state: "disabled",
      };
    }
    if (!isSupportedAlertMetric(rule.metric)) {
      return {
        rule,
        fired: false,
        observedValue: null,
        available: false,
        reason: `The metric "${rule.metric}" is not supported.`,
        state: "metric-unsupported",
      };
    }
    const reading = metrics[rule.metric];
    if (reading === undefined || !reading.available || reading.value === null) {
      const basis = reading?.basis ?? "The metric was not provided.";
      return {
        rule,
        fired: false,
        observedValue: null,
        available: false,
        reason: `Metric unavailable — not evaluated. ${basis}`,
        state: "metric-unavailable",
      };
    }
    const fired = compareMetric(reading.value, rule.comparator, rule.threshold);
    return {
      rule,
      fired,
      observedValue: reading.value,
      available: true,
      reason: `Observed ${reading.value} ${COMPARATOR_SYMBOL[rule.comparator]} ${rule.threshold} is ${fired ? "met" : "not met"}. ${reading.basis}`,
      state: fired ? "fired" : "not-fired",
    };
  });
}

/** A concise, human-readable summary of a fired rule for a notification body. */
export function describeFiredAlert(evaluation: AlertRuleEvaluation): string {
  const rule = evaluation.rule;
  const descriptor = ALERT_METRIC_DESCRIPTORS.find((entry) => entry.key === rule.metric);
  const label = descriptor?.label ?? rule.metric;
  return [
    `Alert "${rule.name}" (${rule.severity}) fired.`,
    `${label}: observed ${evaluation.observedValue} ${COMPARATOR_SYMBOL[rule.comparator]} ${rule.threshold}.`,
    evaluation.reason,
  ].join(" ");
}
