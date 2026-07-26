import assert from "node:assert/strict";
import test from "node:test";
import { evaluateFinopsAlerts } from "../lib/finops-alerts.ts";
import type { DailyAnomaly } from "../lib/finops-insights.ts";
import type { BudgetBurndown } from "../lib/finops-budget-burndown.ts";

const units = (whole: number): string => String(whole * 1_000_000);

function anomaly(overrides: Partial<DailyAnomaly> & { ratio: number }): DailyAnomaly {
  return {
    dateIso: overrides.dateIso ?? "2026-07-15",
    service: overrides.service ?? "AmazonEC2",
    currency: overrides.currency ?? "USD",
    amountMicros: overrides.amountMicros ?? units(300),
    baselineMicros: overrides.baselineMicros ?? units(100),
    ratio: overrides.ratio,
  };
}

function budget(overrides: Partial<BudgetBurndown> & { status: BudgetBurndown["status"] }): BudgetBurndown {
  return {
    id: overrides.id ?? "fb_1",
    name: overrides.name ?? "Prod",
    currency: overrides.currency ?? "USD",
    budgetMicros: overrides.budgetMicros ?? 100_000_000,
    mtdMicros: overrides.mtdMicros ?? 90_000_000,
    consumedPercent: overrides.consumedPercent ?? 90,
    projectedMonthEndMicros: overrides.projectedMonthEndMicros ?? 130_000_000,
    projectedOverspendMicros: overrides.projectedOverspendMicros ?? 30_000_000,
    daysToBreach: overrides.daysToBreach ?? 3,
    status: overrides.status,
    matchedLineCount: overrides.matchedLineCount ?? 10,
    series: overrides.series ?? [],
  };
}

test("an anomaly becomes a cost_anomaly alert", () => {
  const result = evaluateFinopsAlerts({ anomalies: [anomaly({ ratio: 4 })], budgets: [] });
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0]?.kind, "cost_anomaly");
  assert.equal(result.alerts[0]?.severity, "medium");
  assert.match(result.alerts[0]?.id ?? "", /^cost_anomaly:USD:AmazonEC2:2026-07-15$/u);
});

test("anomaly severity scales with ratio", () => {
  assert.equal(evaluateFinopsAlerts({ anomalies: [anomaly({ ratio: 12 })], budgets: [] }).alerts[0]?.severity, "critical");
  assert.equal(evaluateFinopsAlerts({ anomalies: [anomaly({ ratio: 6 })], budgets: [] }).alerts[0]?.severity, "high");
  assert.equal(evaluateFinopsAlerts({ anomalies: [anomaly({ ratio: 3 })], budgets: [] }).alerts[0]?.severity, "medium");
});

test("a breached budget becomes a critical budget_breached alert", () => {
  const result = evaluateFinopsAlerts({ anomalies: [], budgets: [budget({ status: "breached" })] });
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0]?.kind, "budget_breached");
  assert.equal(result.alerts[0]?.severity, "critical");
});

test("an at_risk budget becomes a high budget_at_risk alert; ok is ignored", () => {
  const result = evaluateFinopsAlerts({
    anomalies: [],
    budgets: [budget({ id: "fb_r", status: "at_risk" }), budget({ id: "fb_ok", status: "ok" })],
  });
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0]?.kind, "budget_at_risk");
  assert.equal(result.alerts[0]?.severity, "high");
});

test("minSeverity filters lower-severity alerts", () => {
  const result = evaluateFinopsAlerts({
    anomalies: [anomaly({ ratio: 3 })], // medium
    budgets: [budget({ status: "breached" })], // critical
    minSeverity: "high",
  });
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0]?.kind, "budget_breached");
});

test("alerts are ordered by severity desc then id; counts are tallied", () => {
  const result = evaluateFinopsAlerts({
    anomalies: [anomaly({ ratio: 4, service: "AmazonS3" })], // medium
    budgets: [budget({ id: "fb_a", status: "at_risk" }), budget({ id: "fb_b", status: "breached" })],
  });
  assert.deepEqual(result.alerts.map((a) => a.severity), ["critical", "high", "medium"]);
  assert.deepEqual(result.counts, { critical: 1, high: 1, medium: 1, low: 0 });
  assert.deepEqual(result.evaluated, { anomalies: 1, budgets: 2 });
});

test("empty inputs produce no alerts", () => {
  const result = evaluateFinopsAlerts({ anomalies: [], budgets: [] });
  assert.equal(result.alerts.length, 0);
  assert.deepEqual(result.counts, { critical: 0, high: 0, medium: 0, low: 0 });
});

test("evaluation is deterministic", () => {
  const input = {
    anomalies: [anomaly({ ratio: 8, service: "AmazonRDS" }), anomaly({ ratio: 4, service: "AmazonEC2" })],
    budgets: [budget({ id: "fb_x", status: "breached" })],
  };
  assert.deepEqual(evaluateFinopsAlerts(input), evaluateFinopsAlerts(input));
});
