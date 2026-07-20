import assert from "node:assert/strict";
import test from "node:test";
import {
  compareMetric,
  evaluateAlertRules,
  isSupportedAlertMetric,
  SUPPORTED_ALERT_METRICS,
  type AlertMetricMap,
  type AlertRule,
} from "../lib/alert-rules.ts";

const SCOPE = { orgId: "org_a", customerId: "cust_a" };

function rule(over: Partial<AlertRule> & { id: string }): AlertRule {
  return {
    name: over.name ?? over.id,
    metric: "open-critical-findings-count",
    comparator: "gt",
    threshold: 0,
    severity: "high",
    scope: SCOPE,
    enabled: true,
    ...over,
  };
}

function available(value: number): AlertMetricMap {
  return { "open-critical-findings-count": { value, available: true, basis: "test basis" } };
}

test("the supported metric set is stable and every key is recognized", () => {
  assert.equal(SUPPORTED_ALERT_METRICS.length, 7);
  for (const key of SUPPORTED_ALERT_METRICS) assert.ok(isSupportedAlertMetric(key));
  assert.equal(isSupportedAlertMetric("not-a-metric"), false);
});

test("compareMetric implements each comparator and rejects non-finite operands", () => {
  assert.equal(compareMetric(5, "gt", 3), true);
  assert.equal(compareMetric(3, "gt", 3), false);
  assert.equal(compareMetric(3, "gte", 3), true);
  assert.equal(compareMetric(2, "lt", 3), true);
  assert.equal(compareMetric(3, "lte", 3), true);
  assert.equal(compareMetric(3, "eq", 3), true);
  assert.equal(compareMetric(3, "eq", 4), false);
  assert.equal(compareMetric(Number.NaN, "gt", 0), false);
  assert.equal(compareMetric(1, "gt", Number.NaN), false);
});

test("a rule fires when its available metric satisfies the comparator", () => {
  const [result] = evaluateAlertRules([rule({ id: "r1", comparator: "gt", threshold: 0 })], available(3));
  assert.equal(result.fired, true);
  assert.equal(result.state, "fired");
  assert.equal(result.observedValue, 3);
  assert.equal(result.available, true);
});

test("gte/lte/eq fire exactly at the boundary", () => {
  const gte = evaluateAlertRules([rule({ id: "gte", comparator: "gte", threshold: 5 })], available(5))[0];
  assert.equal(gte.fired, true);
  const lte = evaluateAlertRules([rule({ id: "lte", comparator: "lte", threshold: 5 })], available(5))[0];
  assert.equal(lte.fired, true);
  const eq = evaluateAlertRules([rule({ id: "eq", comparator: "eq", threshold: 5 })], available(5))[0];
  assert.equal(eq.fired, true);
  const notEq = evaluateAlertRules([rule({ id: "neq", comparator: "eq", threshold: 4 })], available(5))[0];
  assert.equal(notEq.fired, false);
  assert.equal(notEq.state, "not-fired");
});

test("an UNAVAILABLE metric NEVER fires and is disclosed", () => {
  const metrics: AlertMetricMap = {
    "open-critical-findings-count": { value: null, available: false, basis: "No synced findings were reachable." },
  };
  const [result] = evaluateAlertRules([rule({ id: "r1", comparator: "gt", threshold: -1 })], metrics);
  assert.equal(result.fired, false);
  assert.equal(result.available, false);
  assert.equal(result.observedValue, null);
  assert.equal(result.state, "metric-unavailable");
  assert.match(result.reason, /unavailable/iu);
  assert.match(result.reason, /No synced findings were reachable\./u);
});

test("a metric absent from the map never fires (treated as unavailable, not zero)", () => {
  // Empty map: a gt 0 or an eq 0 rule must not fire on an absent metric.
  const gt = evaluateAlertRules([rule({ id: "gt", comparator: "gt", threshold: 0 })], {})[0];
  assert.equal(gt.fired, false);
  assert.equal(gt.state, "metric-unavailable");
  const eqZero = evaluateAlertRules([rule({ id: "eq0", comparator: "eq", threshold: 0 })], {})[0];
  assert.equal(eqZero.fired, false);
  assert.equal(eqZero.state, "metric-unavailable");
});

test("a disabled rule is never evaluated", () => {
  const [result] = evaluateAlertRules([rule({ id: "r1", enabled: false, comparator: "gt", threshold: 0 })], available(9));
  assert.equal(result.fired, false);
  assert.equal(result.state, "disabled");
});

test("an unsupported metric never fires", () => {
  const bad = rule({ id: "r1" });
  const mutated = { ...bad, metric: "totally-made-up" } as unknown as AlertRule;
  const [result] = evaluateAlertRules([mutated], available(9));
  assert.equal(result.fired, false);
  assert.equal(result.state, "metric-unsupported");
});

test("severity and rule identity are carried through the evaluation", () => {
  const [result] = evaluateAlertRules([rule({ id: "r1", severity: "low", name: "watch-critical" })], available(3));
  assert.equal(result.rule.severity, "low");
  assert.equal(result.rule.name, "watch-critical");
  assert.equal(result.rule.id, "r1");
});
