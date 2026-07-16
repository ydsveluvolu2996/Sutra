import assert from "node:assert/strict";
import test from "node:test";

import { CostBoundaryError, parseAwsCostSnapshot } from "../lib/cost-boundary.ts";

function validSnapshot(): Record<string, unknown> {
  return {
    schemaVersion: "sutra.aws-costs.v1",
    status: "COMPLETE",
    accountId: "123456789012",
    currency: "USD",
    collectedAt: new Date().toISOString(),
    periodStart: "2026-02-01",
    periodEnd: "2026-07-17",
    totalCost: 100,
    monthToDateCost: 20,
    previousMonthCost: 25,
    trendPercent: -20,
    monthlyTrend: [{ start: "2026-06-01", end: "2026-07-01", amount: 25 }],
    serviceBreakdown: [{ key: "Amazon EC2", label: "Amazon EC2", amount: 15, sharePercent: 75 }],
    accountBreakdown: [{ key: "123456789012", label: "AWS account 123456789012", amount: 20, sharePercent: 100 }],
    forecast: { status: "AVAILABLE", source: "AWS_COST_EXPLORER", amount: 40, periodStart: "2026-07-01", periodEnd: "2026-08-01", reasonCode: null },
    anomalies: [],
    recommendations: [],
    limitations: [],
    unavailableReason: null,
  };
}

test("accepts the exact normalized cost contract", () => {
  const result = parseAwsCostSnapshot(validSnapshot(), "123456789012");
  assert.equal(result.monthToDateCost, 20);
  assert.equal(result.forecast.source, "AWS_COST_EXPLORER");
});

test("rejects cross-account cost evidence", () => {
  assert.throws(
    () => parseAwsCostSnapshot(validSnapshot(), "999988887777"),
    (error) => error instanceof CostBoundaryError,
  );
});

test("rejects provider fields outside the normalized allowlist", () => {
  const value = { ...validSnapshot(), credentials: { accessKeyId: "forbidden" } };
  assert.throws(
    () => parseAwsCostSnapshot(value, "123456789012"),
    (error) => error instanceof CostBoundaryError,
  );
});
