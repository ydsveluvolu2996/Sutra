import assert from "node:assert/strict";
import test from "node:test";

import {
  CORA_ACTION_TYPES,
  CORA_CONDITIONAL_KMS_READ_OPERATIONS,
  CORA_ENROLLMENT_PROVISIONER_OPERATIONS,
  CORA_EXPORT_PROVISIONER_OPERATIONS,
  CORA_ORGANIZATION_READ_OPERATIONS,
  CORA_OPTIONAL_DESTINATION_PROVISIONER_OPERATIONS,
  CORA_PERMANENT_EXPORT_READ_OPERATIONS,
  CORA_PERMANENT_HUB_READ_OPERATIONS,
  CORA_PERMANENT_S3_READ_OPERATIONS,
  CoraBoundaryError,
  coraSourceEvidence,
  normalizeCoraCapture,
  deriveCoraCommitmentDimensions,
  type CoraCapture,
  type CoraRecommendationCapture,
  type CoraScope,
} from "../lib/finops-cora.ts";

test("pinned v0.0.11 rate dimensions fail closed to UNKNOWN instead of fuzzy inference", () => {
  assert.deepEqual(deriveCoraCommitmentDimensions({ actionType: "PurchaseSavingsPlans", currentResourceType: "ComputeSavingsPlans", recommendedResourceType: "ComputeSavingsPlans", currentResourceSummary: "Payer eligible usage", recommendedResourceSummary: "0.50/hour for m7i in Payer one year NoUpfront" }), {
    level: "PAYER", term: "ONE_YEAR", upfront: "NO_UPFRONT", offeringType: "ComputeSavingsPlans", service: "COMPUTE", hourlyCommitment: "0.50", instanceType: "m7i",
  });
  assert.deepEqual(deriveCoraCommitmentDimensions({ actionType: "PurchaseReservedInstances", currentResourceType: "RdsReservedInstances", recommendedResourceType: "RdsReservedInstances", currentResourceSummary: null, recommendedResourceSummary: "provider changed its format" }), {
    level: "UNKNOWN", term: "UNKNOWN", upfront: "UNKNOWN", offeringType: "RdsReservedInstances", service: "RDS", hourlyCommitment: null, instanceType: "changed",
  });
});

const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const MANAGEMENT = "111111111111";
const MEMBER = "222222222222";
const TRACK_USAGE = `cor_${"1".repeat(64)}`;
const TRACK_RATE = `cor_${"2".repeat(64)}`;
const SCOPE: CoraScope = {
  orgId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: `conn_${"a".repeat(32)}`,
  partition: "aws",
  managementAccountId: MANAGEMENT,
  awsOrganizationId: "o-abcdefghij12",
};

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
  ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
  : T;

function recommendation(
  trackingKey: string,
  recommendationId: string,
  overrides: Partial<CoraRecommendationCapture> = {},
): CoraRecommendationCapture {
  return {
    trackingKey,
    fingerprintSha256: "3".repeat(64),
    recommendationId,
    accountId: MEMBER,
    accountName: "Workloads",
    actionType: "Rightsize",
    currencyCode: "USD",
    currentResourceType: "Ec2Instance",
    recommendedResourceType: "Ec2Instance",
    currentResourceSummary: "m6i.4xlarge",
    recommendedResourceSummary: "m6i.2xlarge",
    currentResourceDetailsJson: "{\"ec2Instance\":{\"instanceType\":\"m6i.4xlarge\"}}",
    recommendedResourceDetailsJson: "{\"ec2Instance\":{\"instanceType\":\"m6i.2xlarge\"}}",
    estimatedMonthlyCostBeforeDiscount: "1200.125",
    estimatedMonthlyCostAfterDiscount: "900.10",
    estimatedMonthlySavingsBeforeDiscount: "400.125",
    estimatedMonthlySavingsAfterDiscount: "300.10",
    estimatedSavingsPercentageBeforeDiscount: "33.34",
    estimatedSavingsPercentageAfterDiscount: "33.34",
    implementationEffort: "Low",
    lastRefreshTimestamp: "2026-07-31T06:00:00.000Z",
    recommendationLookbackPeriodInDays: 14,
    recommendationSource: "ComputeOptimizer",
    region: "us-east-1",
    resourceId: "i-0123456789abcdef0",
    resourceArn: `arn:aws:ec2:us-east-1:${MEMBER}:instance/i-0123456789abcdef0`,
    restartNeeded: true,
    rollbackPossible: true,
    tags: [{ key: "CostCenter", value: "platform" }],
    ...overrides,
  };
}

function capture(): Mutable<CoraCapture> {
  const recommendations = [
    recommendation(TRACK_USAGE, "rec-usage"),
    recommendation(TRACK_RATE, "rec-rate", {
      fingerprintSha256: "4".repeat(64),
      accountId: MANAGEMENT,
      actionType: "PurchaseSavingsPlans",
      currentResourceType: "ComputeSavingsPlans",
      recommendedResourceType: "ComputeSavingsPlans",
      currentResourceSummary: "Eligible on-demand usage",
      recommendedResourceSummary: "1-year no-upfront Compute Savings Plan",
      currentResourceDetailsJson: "{\"computeSavingsPlans\":{\"accountScope\":\"PAYER\"}}",
      recommendedResourceDetailsJson: "{\"computeSavingsPlans\":{\"term\":\"ONE_YEAR\"}}",
      estimatedMonthlyCostBeforeDiscount: "5000",
      estimatedMonthlyCostAfterDiscount: null,
      estimatedMonthlySavingsBeforeDiscount: "1000",
      estimatedMonthlySavingsAfterDiscount: null,
      estimatedSavingsPercentageBeforeDiscount: "20",
      estimatedSavingsPercentageAfterDiscount: null,
      recommendationSource: "CostExplorer",
      region: "global",
      resourceId: "payer-eligible-usage",
      resourceArn: null,
      restartNeeded: false,
      rollbackPossible: false,
      tags: [],
    }),
  ];
  return {
    schemaVersion: "sutra.cora.capture.v1",
    scope: { ...SCOPE },
    captureId: `cora_${"5".repeat(64)}`,
    startedAt: "2026-07-31T11:45:00.000Z",
    completedAt: "2026-07-31T12:00:00.000Z",
    hubRegion: "us-east-1",
    coverage: {
      basis: "AWS_ORGANIZATIONS_ACTIVE_ACCOUNTS",
      evidenceId: "organizations:accounts:20260731",
      observedAt: "2026-07-31T05:50:00.000Z",
      activeAccountIds: [MANAGEMENT, MEMBER],
    },
    enrollments: [{
      accountId: MANAGEMENT,
      status: "Active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-07-31T05:30:00.000Z",
    }, {
      accountId: MEMBER,
      status: "Active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-07-31T05:30:00.000Z",
    }],
    preferences: {
      savingsEstimationMode: "AfterDiscounts",
      memberAccountDiscountVisibility: "All",
      preferredCommitmentTerm: "OneYear",
      preferredPaymentOption: "NoUpfront",
      observedAt: "2026-07-31T05:30:00.000Z",
    },
    export: {
      exportArn: `arn:aws:bcm-data-exports:us-east-1:${MANAGEMENT}:export/sutra-cora-12345678-abcd-abcd-abcd-1234567890ab`,
      exportName: "sutra-cora",
      tableName: "COST_OPTIMIZATION_RECOMMENDATIONS",
      executionId: "execution-20260731",
      status: "SUCCEEDED",
      errorCode: null,
      includeAllRecommendations: true,
      filterJson: null,
      refreshCadence: "SYNCHRONOUS",
      fileVersioning: "CREATE_NEW_REPORT",
      fileFormat: "PARQUET",
      compression: "PARQUET",
      bucketName: "sutra-billing-111111111111",
      prefix: "cost-optimization/recommendations",
      manifestObjectKey: "cost-optimization/recommendations/sutra-cora/20260731/Manifest.json",
      manifestSha256: "6".repeat(64),
      generatedAt: "2026-07-31T06:00:00.000Z",
      dataThroughAt: "2026-07-31T06:00:00.000Z",
      objectCount: 1,
      processedObjectCount: 1,
      rowCount: recommendations.length,
      acceptedRowCount: recommendations.length,
      rejectedRowCount: 0,
      exhausted: true,
    },
    recommendations: recommendations.map((item) => ({
      ...item,
      tags: item.tags.map((tag) => ({ ...tag })),
    })),
    retainedHistory: [{
      trackingKey: TRACK_USAGE,
      fingerprintSha256: "3".repeat(64),
      recommendationId: "rec-yesterday",
      capturedAt: "2026-07-30T06:00:00.000Z",
      lifecycle: "PRESENT",
      accountId: MEMBER,
      region: "us-east-1",
      resourceId: "i-0123456789abcdef0",
      resourceArn: `arn:aws:ec2:us-east-1:${MEMBER}:instance/i-0123456789abcdef0`,
      currentResourceType: "Ec2Instance",
      recommendedResourceType: "Ec2Instance",
      actionType: "Rightsize",
      currencyCode: "USD",
      estimatedMonthlySavingsBeforeDiscount: "390",
      estimatedMonthlySavingsAfterDiscount: "290",
      sourceCaptureId: `cora_${"7".repeat(64)}`,
    }],
    workflow: [{
      trackingKey: TRACK_USAGE,
      ownerPrincipalId: "user_finops_owner",
      status: "TRIAGED",
      suppression: {
        mode: "UNTIL",
        until: "2026-08-15T00:00:00.000Z",
        reasonCode: "CHANGE_FREEZE",
      },
      externalTicketId: "FINOPS-101",
      revision: 2,
      updatedAt: "2026-07-31T08:30:00.000Z",
      audit: [{
        revision: 1,
        at: "2026-07-31T07:00:00.000Z",
        actorPrincipalId: "user_finops_owner",
        fromStatus: null,
        toStatus: "NEW",
        evidenceId: "workflow:create:101",
      }, {
        revision: 2,
        at: "2026-07-31T08:30:00.000Z",
        actorPrincipalId: "user_finops_owner",
        fromStatus: "NEW",
        toStatus: "TRIAGED",
        evidenceId: "workflow:triage:101",
      }],
    }],
    cur2: {
      generationId: `fbg_${"8".repeat(64)}`,
      generationState: "ACTIVE",
      sourceEvidenceId: "cur2:manifest:20260731",
      manifestSha256: "9".repeat(64),
      generatedAt: "2026-07-31T06:00:00.000Z",
      dataThroughAt: "2026-07-31T05:00:00.000Z",
      status: "SUCCEEDED",
      errorCode: null,
      payerAccountIds: [MANAGEMENT],
      usageAccountIds: [MANAGEMENT, MEMBER],
      objectCount: 2,
      processedObjectCount: 2,
      observedCosts: [{
        trackingKey: TRACK_USAGE,
        observationKind: "CURRENT",
        periodStartAt: "2026-07-01T00:00:00.000Z",
        periodEndAt: "2026-08-01T00:00:00.000Z",
        costBasis: "AMORTIZED",
        amountMicros: "875125000",
        currencyCode: "USD",
        sourceLineIds: ["li:ec2:202607:001"],
        sourceLineIdsTruncated: false,
      }, {
        trackingKey: TRACK_USAGE,
        observationKind: "BEFORE_ACTION",
        periodStartAt: "2026-06-01T00:00:00.000Z",
        periodEndAt: "2026-07-01T00:00:00.000Z",
        costBasis: "AMORTIZED",
        amountMicros: "910000000",
        currencyCode: "USD",
        sourceLineIds: ["li:ec2:202606:001"],
        sourceLineIdsTruncated: false,
      }],
    },
  };
}

test("pins the exact read-only and one-time provisioner boundaries", () => {
  assert.deepEqual(CORA_PERMANENT_HUB_READ_OPERATIONS, [
    "cost-optimization-hub:GetPreferences",
    "cost-optimization-hub:ListEnrollmentStatuses",
  ]);
  assert.deepEqual(CORA_PERMANENT_EXPORT_READ_OPERATIONS, [
    "bcm-data-exports:GetExport",
    "bcm-data-exports:GetExecution",
    "bcm-data-exports:ListExecutions",
  ]);
  assert.deepEqual(CORA_PERMANENT_S3_READ_OPERATIONS, [
    "s3:GetBucketLocation",
    "s3:ListBucket",
    "s3:GetObject",
    "s3:GetObjectAttributes",
  ]);
  assert.deepEqual(CORA_ORGANIZATION_READ_OPERATIONS, [
    "organizations:DescribeOrganization",
    "organizations:ListAccounts",
  ]);
  assert.deepEqual(CORA_CONDITIONAL_KMS_READ_OPERATIONS, ["kms:Decrypt"]);
  assert.deepEqual(CORA_ENROLLMENT_PROVISIONER_OPERATIONS, [
    "iam:CreateServiceLinkedRole",
    "iam:PutRolePolicy",
    "organizations:EnableAWSServiceAccess",
    "cost-optimization-hub:UpdateEnrollmentStatus",
  ]);
  assert.deepEqual(CORA_EXPORT_PROVISIONER_OPERATIONS, [
    "bcm-data-exports:CreateExport",
    "bcm-data-exports:TagResource",
    "cost-optimization-hub:GetRecommendation",
    "cost-optimization-hub:ListRecommendations",
  ]);
  assert.deepEqual(CORA_OPTIONAL_DESTINATION_PROVISIONER_OPERATIONS, [
    "s3:GetBucketPolicy",
    "s3:PutBucketPolicy",
  ]);
  assert.equal(CORA_ACTION_TYPES.length, 8);
});

test("normalizes complete enterprise evidence without mixing estimates and observed costs", () => {
  const snapshot = normalizeCoraCapture(capture(), SCOPE, NOW);
  assert.equal(snapshot.state, "READY");
  assert.equal(snapshot.organizationCoverage, "COMPLETE");
  assert.deepEqual(snapshot.channelStates, {
    enrollment: "READY",
    recommendations: "READY",
    cur2: "READY",
    workflow: "READY",
  });
  assert.equal(snapshot.recommendations.length, 2);
  const usage = snapshot.recommendations.find((row) => row.trackingKey === TRACK_USAGE)!;
  assert.equal(usage.optimizationClass, "RESOURCE_USAGE_OPTIMIZATION");
  assert.equal(usage.estimates.monthlyCostBeforeDiscountMicros, "1200125000");
  assert.equal(usage.estimates.monthlySavingsAfterDiscountMicros, "300100000");
  assert.equal(usage.estimates.meaning, "AWS_ESTIMATE_NOT_REALIZED_SAVINGS");
  assert.equal(usage.workflow.ownerPrincipalId, "user_finops_owner");
  assert.equal(usage.workflow.status, "TRIAGED");
  assert.equal(usage.observedCosts.length, 2);
  assert.equal(usage.observedCosts[0]?.attribution, "OBSERVED_COST_NOT_ATTRIBUTED_SAVINGS");

  const rate = snapshot.recommendations.find((row) => row.trackingKey === TRACK_RATE)!;
  assert.equal(rate.optimizationClass, "RATE_COMMITMENT_OPTIMIZATION");
  assert.equal(rate.estimates.monthlyCostAfterDiscountMicros, null);
  assert.equal(rate.workflow.status, "NEW");
  assert.equal(rate.workflow.revision, 0);
  assert.deepEqual(snapshot.summaries.map((row) => [row.optimizationClass, row.currencyCode]), [
    ["RATE_COMMITMENT_OPTIMIZATION", "USD"],
    ["RESOURCE_USAGE_OPTIMIZATION", "USD"],
  ]);
  assert.ok(snapshot.summaries.every((row) =>
    row.aggregationMeaning === "NON_DEDUPLICATED_ROW_SUM_NOT_A_PORTFOLIO_SAVINGS_CLAIM"
  ));
  assert.equal(snapshot.retainedHistory[0]?.recommendationId, "rec-yesterday");
  assert.equal(snapshot.retainedHistory[0]?.trackingKey, TRACK_USAGE);
});

test("marks filtered or de-duplicated exports partial instead of claiming completeness", () => {
  const sample = capture();
  sample.export!.includeAllRecommendations = false;
  sample.export!.filterJson = "{\"accountIds\":[\"222222222222\"]}";
  const snapshot = normalizeCoraCapture(sample, SCOPE, NOW);
  assert.equal(snapshot.state, "PARTIAL");
  assert.equal(snapshot.channelStates.recommendations, "PARTIAL");
  assert.ok(snapshot.limitations.some((item) => item.includes("incompatible")));
  assert.ok(snapshot.limitations.some((item) => item.includes("filtered")));
});

test("keeps organization coverage partial when a member is not actively enrolled", () => {
  const sample = capture();
  sample.enrollments[1]!.status = "Inactive";
  const snapshot = normalizeCoraCapture(sample, SCOPE, NOW);
  assert.equal(snapshot.state, "PARTIAL");
  assert.equal(snapshot.organizationCoverage, "PARTIAL");
  assert.deepEqual(snapshot.coverage.missingEnrollmentAccountIds, [MEMBER]);
});

test("reports configuration required when enrollment/export are absent", () => {
  const sample = capture();
  sample.enrollments = [];
  sample.preferences = null;
  sample.export = null;
  sample.recommendations = [];
  sample.workflow = [];
  sample.cur2 = null;
  const snapshot = normalizeCoraCapture(sample, SCOPE, NOW);
  assert.equal(snapshot.state, "CONFIGURATION_REQUIRED");
  assert.equal(snapshot.channelStates.enrollment, "CONFIGURATION_REQUIRED");
  assert.equal(snapshot.channelStates.recommendations, "CONFIGURATION_REQUIRED");
  assert.equal(snapshot.channelStates.cur2, "CONFIGURATION_REQUIRED");
});

test("reports stale rather than ready when recommendation evidence exceeds the SLA", () => {
  const sample = capture();
  sample.export!.generatedAt = "2026-07-27T06:00:00.000Z";
  sample.export!.dataThroughAt = "2026-07-27T06:00:00.000Z";
  const snapshot = normalizeCoraCapture(sample, SCOPE, NOW);
  assert.equal(snapshot.state, "STALE");
  assert.equal(snapshot.channelStates.recommendations, "STALE");
});

test("keeps a complete recommendation export partial until immutable CUR2 is configured", () => {
  const sample = capture();
  sample.cur2 = null;
  const snapshot = normalizeCoraCapture(sample, SCOPE, NOW);
  assert.equal(snapshot.state, "PARTIAL");
  assert.equal(snapshot.channelStates.recommendations, "READY");
  assert.equal(snapshot.channelStates.cur2, "CONFIGURATION_REQUIRED");
});

test("reports a failed export as error evidence without provider error text", () => {
  const sample = capture();
  sample.export!.status = "FAILED";
  sample.export!.errorCode = "ACCESS_DENIED";
  sample.export!.rowCount = 0;
  sample.export!.acceptedRowCount = 0;
  sample.recommendations = [];
  sample.workflow = [];
  sample.cur2!.observedCosts = [];
  const snapshot = normalizeCoraCapture(sample, SCOPE, NOW);
  assert.equal(snapshot.state, "ERROR");
  const evidence = coraSourceEvidence(snapshot);
  assert.equal(evidence.lastAttemptOutcome, "failed");
  assert.equal(evidence.lastError?.code, "ACCESS_DENIED");
  assert.equal(evidence.lastError?.message, "AWS Cost Optimization Hub export collection failed.");
});

test("never combines different source currencies", () => {
  const sample = capture();
  sample.recommendations[1]!.actionType = "Rightsize";
  sample.recommendations[1]!.currencyCode = "EUR";
  const snapshot = normalizeCoraCapture(sample, SCOPE, NOW);
  assert.deepEqual(snapshot.summaries.map((row) => row.currencyCode), ["EUR", "USD"]);
});

test("rejects a recommendation that crosses the expected tenant account set", () => {
  const sample = capture();
  sample.recommendations[0]!.accountId = "333333333333";
  assert.throws(
    () => normalizeCoraCapture(sample, SCOPE, NOW),
    (error: unknown) => error instanceof CoraBoundaryError && error.code === "INVALID_INPUT",
  );
});

test("rejects a resource ARN whose account disagrees with its recommendation", () => {
  const sample = capture();
  sample.recommendations[0]!.accountId = MANAGEMENT;
  assert.throws(
    () => normalizeCoraCapture(sample, SCOPE, NOW),
    (error: unknown) =>
      error instanceof CoraBoundaryError && error.code === "ACCOUNT_COVERAGE_MISMATCH",
  );
});

test("rejects broken workflow audit continuity", () => {
  const sample = capture();
  sample.workflow[0]!.audit[1]!.fromStatus = "APPROVED";
  assert.throws(
    () => normalizeCoraCapture(sample, SCOPE, NOW),
    (error: unknown) => error instanceof CoraBoundaryError && error.code === "WORKFLOW_AUDIT_MISMATCH",
  );
});

test("rejects unsafe configuration JSON and does not render it as a summary", () => {
  const sample = capture();
  sample.recommendations[0]!.currentResourceDetailsJson = "{\"constructor\":{\"prototype\":{\"polluted\":true}}}";
  assert.throws(
    () => normalizeCoraCapture(sample, SCOPE, NOW),
    (error: unknown) => error instanceof CoraBoundaryError && error.code === "UNSAFE_CONFIGURATION_JSON",
  );
});

test("rejects mismatched Sutra scope", () => {
  assert.throws(
    () => normalizeCoraCapture(capture(), { ...SCOPE, customerId: "customer_other" }, NOW),
    (error: unknown) => error instanceof CoraBoundaryError && error.code === "SCOPE_MISMATCH",
  );
});

test("emits source-health evidence without promoting partial coverage", () => {
  const ready = coraSourceEvidence(normalizeCoraCapture(capture(), SCOPE, NOW));
  assert.equal(ready.sourceId, "cost_optimization_hub_export");
  assert.equal(ready.coverage.assessment, "complete");
  assert.equal(ready.coverage.acceptedRecords, 2);
  assert.equal(ready.lastAttemptOutcome, "succeeded");
  assert.equal(ready.dataThroughAt, "2026-07-31T06:00:00.000Z");

  const partialCapture = capture();
  partialCapture.export!.rejectedRowCount = 1;
  partialCapture.export!.rowCount = 3;
  const partial = coraSourceEvidence(normalizeCoraCapture(partialCapture, SCOPE, NOW));
  assert.equal(partial.coverage.assessment, "partial");
  assert.equal(partial.coverage.rejectedRecords, 1);
  assert.equal(partial.lastAttemptOutcome, "partial");
});
