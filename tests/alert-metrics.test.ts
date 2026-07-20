import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleAlertMetrics,
  DEFAULT_NEW_FINDING_WINDOW_MS,
  type OpenFindingSignal,
} from "../lib/alert-metrics.ts";
import { SUPPORTED_ALERT_METRICS } from "../lib/alert-rules.ts";
import type { AnomalyResult, BudgetEvaluation } from "../lib/finops-insights.ts";

function budget(over: Partial<BudgetEvaluation> & { id: string }): BudgetEvaluation {
  return {
    name: over.id,
    currency: "USD",
    limitMicros: "1000000",
    spentMicros: "0",
    utilizationPercent: null,
    state: "no-data",
    matchedLineCount: 0,
    ...over,
  };
}

function anomalyResult(over: Partial<AnomalyResult>): AnomalyResult {
  return { anomalies: [], evaluatedDays: 0, disclaimer: "d", ...over };
}

const NOW = Date.parse("2026-07-20T00:00:00.000Z");

test("every supported metric is present in the assembled map", () => {
  const map = assembleAlertMetrics({});
  for (const key of SUPPORTED_ALERT_METRICS) {
    assert.ok(map[key] !== undefined, `missing ${key}`);
  }
});

test("with no signals at all, every metric is unavailable and never a fabricated zero", () => {
  const map = assembleAlertMetrics({});
  for (const key of SUPPORTED_ALERT_METRICS) {
    assert.equal(map[key]?.available, false, `${key} should be unavailable`);
    assert.equal(map[key]?.value, null, `${key} value should be null`);
    assert.ok((map[key]?.basis.length ?? 0) > 0, `${key} should disclose a basis`);
  }
});

test("budget-breach-count counts breached budgets when at least one has billing data", () => {
  const map = assembleAlertMetrics({
    budgets: [
      budget({ id: "b1", state: "breached", utilizationPercent: 120, matchedLineCount: 4 }),
      budget({ id: "b2", state: "under", utilizationPercent: 40, matchedLineCount: 2 }),
    ],
  });
  assert.equal(map["budget-breach-count"]?.available, true);
  assert.equal(map["budget-breach-count"]?.value, 1);
});

test("budgets that are all no-data are unavailable, not a zero breach count", () => {
  const map = assembleAlertMetrics({ budgets: [budget({ id: "b1", state: "no-data" })] });
  assert.equal(map["budget-breach-count"]?.available, false);
  assert.equal(map["budget-utilization-percent"]?.available, false);
});

test("budget-utilization-percent reports the highest utilization with billing data", () => {
  const map = assembleAlertMetrics({
    budgets: [
      budget({ id: "b1", state: "under", utilizationPercent: 42.5, matchedLineCount: 1 }),
      budget({ id: "b2", state: "warning", utilizationPercent: 88, matchedLineCount: 1 }),
      budget({ id: "b3", state: "no-data", utilizationPercent: null }),
    ],
  });
  assert.equal(map["budget-utilization-percent"]?.available, true);
  assert.equal(map["budget-utilization-percent"]?.value, 88);
});

test("cost-anomaly-count is available only when days were actually evaluated", () => {
  const none = assembleAlertMetrics({ anomalies: anomalyResult({ evaluatedDays: 0 }) });
  assert.equal(none["cost-anomaly-count"]?.available, false);

  const some = assembleAlertMetrics({
    anomalies: anomalyResult({
      evaluatedDays: 30,
      anomalies: [
        { dateIso: "2026-07-10", service: "AmazonEC2", currency: "USD", amountMicros: "5", baselineMicros: "1", ratio: 5 },
      ],
    }),
  });
  assert.equal(some["cost-anomaly-count"]?.available, true);
  assert.equal(some["cost-anomaly-count"]?.value, 1);
});

test("open- and new-critical findings split by severity and first-seen window", () => {
  const findings: OpenFindingSignal[] = [
    { severity: "critical", firstSeenMs: NOW - 1000, knownExploited: true },
    { severity: "critical", firstSeenMs: NOW - DEFAULT_NEW_FINDING_WINDOW_MS - 1000, knownExploited: false },
    { severity: "high", firstSeenMs: NOW - 1000, knownExploited: true },
  ];
  const map = assembleAlertMetrics({
    cloudFindings: { openFindings: findings, asOfMs: NOW, newWindowMs: DEFAULT_NEW_FINDING_WINDOW_MS, kevAsOf: "2026-07-19" },
  });
  assert.equal(map["open-critical-findings-count"]?.value, 2);
  assert.equal(map["new-critical-findings-count"]?.value, 1);
  assert.equal(map["kev-vulnerability-count"]?.value, 2);
  assert.equal(map["kev-vulnerability-count"]?.available, true);
});

test("KEV count is unavailable when the KEV catalog was not loaded", () => {
  const map = assembleAlertMetrics({
    cloudFindings: {
      openFindings: [{ severity: "critical", firstSeenMs: NOW, knownExploited: true }],
      asOfMs: NOW,
      newWindowMs: DEFAULT_NEW_FINDING_WINDOW_MS,
      kevAsOf: null,
    },
  });
  assert.equal(map["kev-vulnerability-count"]?.available, false);
  // Findings counts remain available even without KEV.
  assert.equal(map["open-critical-findings-count"]?.available, true);
});

test("posture-score is available only when the fleet has a computed score", () => {
  const unscored = assembleAlertMetrics({ posture: { averageScore: null, scoredClusterCount: 0 } });
  assert.equal(unscored["posture-score"]?.available, false);

  const scored = assembleAlertMetrics({ posture: { averageScore: 72, scoredClusterCount: 3 } });
  assert.equal(scored["posture-score"]?.available, true);
  assert.equal(scored["posture-score"]?.value, 72);
});
