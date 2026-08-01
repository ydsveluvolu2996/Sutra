import assert from "node:assert/strict";
import test from "node:test";
import type { CoraSnapshot } from "../lib/finops-cora.ts";
import { buildCoraDashboardProjection, type CoraDashboardFilters } from "../lib/finops-cora-dashboard.ts";

const FILTERS: CoraDashboardFilters = {
  accountId: null, optimizationClass: null, actionType: null, region: null,
  implementationEffort: null, workflowStatus: null, currencyCode: null,
  tagKey: null, tagValue: null,
};

function recommendation(overrides: Partial<CoraSnapshot["recommendations"][number]> = {}): CoraSnapshot["recommendations"][number] {
  return {
    trackingKey: `cor_${"1".repeat(64)}`, fingerprintSha256: "2".repeat(64), recommendationId: "rec-1",
    accountId: "111111111111", accountName: "Platform", actionType: "Rightsize", currencyCode: "USD",
    currentResourceType: "Ec2Instance", recommendedResourceType: "Ec2Instance",
    currentResourceSummary: "m7i.large", recommendedResourceSummary: "m7i.medium",
    currentResourceDetailsJson: null, recommendedResourceDetailsJson: null,
    estimatedSavingsPercentageBeforeDiscount: "50", estimatedSavingsPercentageAfterDiscount: "40",
    implementationEffort: "Low", lastRefreshTimestamp: "2026-07-31T00:00:00.000Z",
    recommendationLookbackPeriodInDays: 14, recommendationSource: "ComputeOptimizer",
    region: "us-east-1", resourceId: "i-1", resourceArn: "arn:aws:ec2:us-east-1:111111111111:instance/i-1",
    restartNeeded: true, rollbackPossible: true, tags: [{ key: "Owner", value: "Platform" }],
    optimizationClass: "RESOURCE_USAGE_OPTIMIZATION",
    estimates: {
      currencyCode: "USD", monthlyCostBeforeDiscountMicros: "9007199254740993000001",
      monthlyCostAfterDiscountMicros: "8000000", monthlySavingsBeforeDiscountMicros: "9007199254740993000000",
      monthlySavingsAfterDiscountMicros: "7000000", meaning: "AWS_ESTIMATE_NOT_REALIZED_SAVINGS",
    },
    workflow: { trackingKey: `cor_${"1".repeat(64)}`, ownerPrincipalId: null, status: "NEW", suppression: { mode: "NONE", until: null, reasonCode: null }, externalTicketId: null, revision: 0, updatedAt: "2026-07-31T00:00:00.000Z", audit: [] },
    observedCosts: [],
    ...overrides,
  };
}

function snapshot(rows: CoraSnapshot["recommendations"]): CoraSnapshot {
  return {
    scope: { orgId: "org_one", customerId: "customer_one", connectionId: `conn_${"a".repeat(32)}`, partition: "aws", managementAccountId: "111111111111", awsOrganizationId: "o-1234567890" },
    state: "READY", generatedAt: "2026-07-31T01:00:00.000Z", sourceCaptureId: `cora_${"3".repeat(64)}`,
    sourceDataThroughAt: "2026-07-31T00:00:00.000Z", sourceErrorCode: null,
    optimizationClasses: ["RESOURCE_USAGE_OPTIMIZATION", "RATE_COMMITMENT_OPTIMIZATION"], organizationCoverage: "COMPLETE",
    coverage: { expectedAccountCount: 1, activeEnrollmentAccountCount: 1, recommendationAccountCount: 1, missingEnrollmentAccountIds: [], unexpectedRecommendationAccountIds: [], exportAcceptedRows: rows.length, exportRejectedRows: 0 },
    channelStates: { enrollment: "READY", recommendations: "READY", cur2: "EMPTY", workflow: "EMPTY" },
    recommendations: rows, retainedHistory: [], summaries: [], limitations: ["AWS estimates are not realized savings or invoices."],
  };
}

test("CORA projection preserves exact micros and never combines currencies or optimization classes", () => {
  const rows = [recommendation(), recommendation({
    trackingKey: `cor_${"4".repeat(64)}`, recommendationId: "rec-2", currencyCode: "EUR",
    actionType: "PurchaseSavingsPlans", optimizationClass: "RATE_COMMITMENT_OPTIMIZATION",
    estimates: { currencyCode: "EUR", monthlyCostBeforeDiscountMicros: "20", monthlyCostAfterDiscountMicros: null, monthlySavingsBeforeDiscountMicros: "10", monthlySavingsAfterDiscountMicros: null, meaning: "AWS_ESTIMATE_NOT_REALIZED_SAVINGS" },
  })];
  const result = buildCoraDashboardProjection(snapshot(rows), [], FILTERS);
  assert.equal(result.summaries.length, 2);
  assert.equal(result.summaries[1]?.estimatedMonthlySavingsBeforeDiscountMicros, "9007199254740993000000");
  assert.deepEqual(result.summaries.map((item) => `${item.optimizationClass}:${item.currencyCode}`), [
    "RATE_COMMITMENT_OPTIMIZATION:EUR", "RESOURCE_USAGE_OPTIMIZATION:USD",
  ]);
});

test("CORA projection filters by workload-owner tags without changing evidence history", () => {
  const result = buildCoraDashboardProjection(snapshot([recommendation()]), [{
    generationId: `corg_${"5".repeat(64)}`, collectedAtIso: "2026-07-31T01:00:00.000Z",
    dataThroughAtIso: "2026-07-31T00:00:00.000Z", sourceState: "READY", recommendationCount: 1, summaries: [],
  }], { ...FILTERS, tagKey: "Owner", tagValue: "Platform" });
  assert.equal(result.resultCount, 1);
  assert.equal(result.history.length, 1);
  assert.equal(result.rows[0]?.workflow.status, "NEW");
  assert.equal(result.rows[0]?.observedCostEvidenceCount, 0);
});
