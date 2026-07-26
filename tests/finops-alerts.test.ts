import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnomalyAlerts,
  buildBudgetAlerts,
  combineFinopsAlerts,
  evaluateFinopsAlerts,
} from "../lib/finops-alerts.ts";
import type { DailyAnomaly } from "../lib/finops-insights.ts";
import type { BudgetBurndown } from "../lib/finops-budget-burndown.ts";

const units = (whole: number): string => String(whole * 1_000_000);

const SCOPE = { connectionId: "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", period: "2026-07" } as const;

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
  const result = evaluateFinopsAlerts({ scope: SCOPE, anomalies: [anomaly({ ratio: 4 })], budgets: [] });
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0]?.kind, "cost_anomaly");
  assert.equal(result.alerts[0]?.severity, "medium");
  // id = kind:date:service-slug:hash(connection+currency+service)
  assert.match(result.alerts[0]?.id ?? "", /^cost_anomaly:2026-07-15:AmazonEC2:[0-9a-f]{8}$/u);
});

test("anomaly severity scales with ratio", () => {
  assert.equal(evaluateFinopsAlerts({ scope: SCOPE, anomalies: [anomaly({ ratio: 12 })], budgets: [] }).alerts[0]?.severity, "critical");
  assert.equal(evaluateFinopsAlerts({ scope: SCOPE, anomalies: [anomaly({ ratio: 6 })], budgets: [] }).alerts[0]?.severity, "high");
  assert.equal(evaluateFinopsAlerts({ scope: SCOPE, anomalies: [anomaly({ ratio: 3 })], budgets: [] }).alerts[0]?.severity, "medium");
});

test("a breached budget becomes a critical budget_breached alert", () => {
  const result = evaluateFinopsAlerts({ scope: SCOPE, anomalies: [], budgets: [budget({ status: "breached" })] });
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0]?.kind, "budget_breached");
  assert.equal(result.alerts[0]?.severity, "critical");
});

test("an at_risk budget becomes a high budget_at_risk alert; ok is ignored", () => {
  const result = evaluateFinopsAlerts({ scope: SCOPE,
    anomalies: [],
    budgets: [budget({ id: "fb_r", status: "at_risk" }), budget({ id: "fb_ok", status: "ok" })],
  });
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0]?.kind, "budget_at_risk");
  assert.equal(result.alerts[0]?.severity, "high");
});

test("minSeverity filters lower-severity alerts", () => {
  const result = evaluateFinopsAlerts({ scope: SCOPE,
    anomalies: [anomaly({ ratio: 3 })], // medium
    budgets: [budget({ status: "breached" })], // critical
    minSeverity: "high",
  });
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0]?.kind, "budget_breached");
});

test("alerts are ordered by severity desc then id; counts are tallied", () => {
  const result = evaluateFinopsAlerts({ scope: SCOPE,
    anomalies: [anomaly({ ratio: 4, service: "AmazonS3" })], // medium
    budgets: [budget({ id: "fb_a", status: "at_risk" }), budget({ id: "fb_b", status: "breached" })],
  });
  assert.deepEqual(result.alerts.map((a) => a.severity), ["critical", "high", "medium"]);
  assert.deepEqual(result.counts, { critical: 1, high: 1, medium: 1, low: 0 });
  assert.deepEqual(result.evaluated, { anomalies: 1, budgets: 2 });
});

test("empty inputs produce no alerts", () => {
  const result = evaluateFinopsAlerts({ scope: SCOPE, anomalies: [], budgets: [] });
  assert.equal(result.alerts.length, 0);
  assert.deepEqual(result.counts, { critical: 0, high: 0, medium: 0, low: 0 });
});

test("evaluation is deterministic", () => {
  const input = {
    scope: SCOPE,
    anomalies: [anomaly({ ratio: 8, service: "AmazonRDS" }), anomaly({ ratio: 4, service: "AmazonEC2" })],
    budgets: [budget({ id: "fb_x", status: "breached" })],
  };
  assert.deepEqual(evaluateFinopsAlerts(input), evaluateFinopsAlerts(input));
});

/* --------------------------------------------------------------------------
 * Regression tests for the two dedup defects found by the adversarial audit.
 * Both were PERMANENT-SUPPRESSION bugs: the alert id is used as the notification
 * idempotency key, so an id that is not unique enough silently swallows a real
 * alert forever.
 * ----------------------------------------------------------------------- */

test("budget alert id carries the period, so a later month is a NEW alert", () => {
  const july = evaluateFinopsAlerts({
    scope: { connectionId: "conn_a", period: "2026-07" },
    anomalies: [], budgets: [budget({ id: "fb_same", status: "breached" })],
  });
  const august = evaluateFinopsAlerts({
    scope: { connectionId: "conn_a", period: "2026-08" },
    anomalies: [], budgets: [budget({ id: "fb_same", status: "breached" })],
  });
  assert.notEqual(july.alerts[0]?.id, august.alerts[0]?.id);
  assert.match(july.alerts[0]?.id ?? "", /^budget_breached:2026-07:fb_same$/u);
  assert.match(august.alerts[0]?.id ?? "", /^budget_breached:2026-08:fb_same$/u);
});

test("budget alert id is stable within the same period (still de-duplicates)", () => {
  const args = { scope: { connectionId: "conn_a", period: "2026-07" } as const, anomalies: [], budgets: [budget({ id: "fb_x", status: "breached" })] };
  assert.equal(evaluateFinopsAlerts(args).alerts[0]?.id, evaluateFinopsAlerts(args).alerts[0]?.id);
});

test("anomaly alert id carries the connection, so two accounts do not collide", () => {
  const shared = anomaly({ ratio: 5, service: "AmazonEC2", dateIso: "2026-07-15" });
  const first = evaluateFinopsAlerts({ scope: { connectionId: "conn_one", period: "2026-07" }, anomalies: [shared], budgets: [] });
  const second = evaluateFinopsAlerts({ scope: { connectionId: "conn_two", period: "2026-07" }, anomalies: [shared], budgets: [] });
  assert.notEqual(first.alerts[0]?.id, second.alerts[0]?.id);
});

test("anomaly ids stay valid when the service name has spaces and punctuation", () => {
  // FOCUS ServiceName values contain spaces/dashes; the id feeds a strict
  // idempotency-key format, so an unsanitised id would throw and poison the job.
  const focus = anomaly({ ratio: 6, service: "Amazon Elastic Compute Cloud - Compute", dateIso: "2026-07-15" });
  const result = evaluateFinopsAlerts({ scope: { connectionId: "conn_a", period: "2026-07" }, anomalies: [focus], budgets: [] });
  const id = result.alerts[0]?.id ?? "";
  assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._:@+-]{7,127}$/u, `id must satisfy the outbox idempotency-key format: ${id}`);
});

test("two space-containing services sharing a first token get distinct ids", () => {
  const scope = { connectionId: "conn_a", period: "2026-07" } as const;
  const a = evaluateFinopsAlerts({ scope, budgets: [], anomalies: [anomaly({ ratio: 5, service: "Amazon Elastic Compute Cloud - Compute" })] });
  const b = evaluateFinopsAlerts({ scope, budgets: [], anomalies: [anomaly({ ratio: 5, service: "Amazon Elastic Container Service" })] });
  assert.notEqual(a.alerts[0]?.id, b.alerts[0]?.id);
});

test("combineFinopsAlerts de-duplicates by id and keeps severity order", () => {
  const scope = { connectionId: "conn_a", period: "2026-07" } as const;
  const dup = buildAnomalyAlerts([anomaly({ ratio: 4 })], scope);
  const combined = combineFinopsAlerts([...dup, ...dup, ...buildBudgetAlerts([budget({ status: "breached" })], "2026-07")]);
  assert.equal(combined.alerts.length, 2);
  assert.deepEqual(combined.alerts.map((a) => a.severity), ["critical", "medium"]);
});
