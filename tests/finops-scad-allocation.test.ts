import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScadAllocationSnapshot,
  SCAD_CUR2_BASE_COLUMNS,
  SCAD_CUR2_SPLIT_COLUMNS,
  SCAD_ONE_TIME_PROVISIONER_IAM_ACTIONS,
  SCAD_RUNTIME_S3_READ_IAM_ACTIONS,
  ScadAllocationError,
  scadAllocationSourceEvidence,
  type ScadCapture,
  type ScadScope,
} from "../lib/finops-scad-allocation.ts";

const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const PAYER = "111111111111";
const MEMBER = "222222222222";
const SCOPE: ScadScope = {
  orgId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: `conn_${"a".repeat(32)}`,
  partition: "aws",
  payerAccountIds: [PAYER],
  usageAccountIds: [PAYER, MEMBER],
  regions: ["us-east-1"],
};

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function capture(): Mutable<ScadCapture> {
  return {
    schemaVersion: "sutra.scad-allocation.capture.v1",
    scope: {
      ...SCOPE,
      payerAccountIds: [...SCOPE.payerAccountIds],
      usageAccountIds: [...SCOPE.usageAccountIds],
      regions: [...SCOPE.regions],
    },
    captureId: `scad_${"b".repeat(64)}`,
    startedAt: "2026-07-31T11:50:00.000Z",
    completedAt: "2026-07-31T12:00:00.000Z",
    exportName: "sutra_cur2_scad_hourly",
    exportArn: `arn:aws:bcm-data-exports:us-east-1:${PAYER}:export/sutra_cur2_scad_hourly-1234`,
    activeGenerationId: `fbg_${"c".repeat(64)}`,
    correctionOfGenerationId: null,
    manifestSha256: "d".repeat(64),
    generatedAt: "2026-07-31T11:45:00.000Z",
    dataThroughAt: "2026-07-31T11:00:00.000Z",
    billingPeriodStartAt: "2026-07-01T00:00:00.000Z",
    billingPeriodEndAt: "2026-08-01T00:00:00.000Z",
    scadEnabledAt: "2026-07-15T08:00:00.000Z",
    firstDeliveryObservedAt: "2026-07-31T11:45:00.000Z",
    deliverySequence: 1,
    destination: {
      bucket: "sutra-cur2-evidence-111111111111",
      prefix: "exports/scad/",
    },
    tableConfiguration: {
      tableName: "COST_AND_USAGE_REPORT",
      timeGranularity: "HOURLY",
      includeResources: "TRUE",
      includeSplitCostAllocationData: "TRUE",
    },
    coverage: {
      runtimeS3PermissionsValidated: true,
      expectedObjectCount: 1,
      processedObjectCount: 1,
      failedObjectCount: 0,
      rowsExhausted: true,
      schemaColumns: [...SCAD_CUR2_BASE_COLUMNS, ...SCAD_CUR2_SPLIT_COLUMNS],
      errorCode: null,
    },
    objects: [{
      objectId: "object_2026_07_part_0001",
      bucket: "sutra-cur2-evidence-111111111111",
      key: "exports/scad/BILLING_PERIOD=2026-07/part-00001.csv.gz",
      eTag: "etag-0001",
      versionId: "version-0001",
      sha256: "e".repeat(64),
      sizeBytes: 4096,
    }],
    rows: [{
      lineItemId: "line-item-001",
      sourceObjectId: "object_2026_07_part_0001",
      sourceRowNumber: 2,
      payerAccountId: PAYER,
      usageAccountId: MEMBER,
      region: "us-east-1",
      usageStartAt: "2026-07-31T09:00:00.000Z",
      usageEndAt: "2026-07-31T10:00:00.000Z",
      platform: "EKS",
      usageType: "USE1-EKS-EC2-vCPU-Hours",
      metric: "VCPU",
      usageUnit: "vCPU-Hours",
      currency: "USD",
      resourceId: "arn:aws:eks:us-east-1:222222222222:pod/prod/payments/pod-a",
      parentResourceId: "i-0123456789abcdef0",
      resourceTags: {
        aws_eks_cluster_name: "payments-prod",
        aws_eks_namespace: "payments",
        aws_eks_workload_type: "ReplicaSet",
        aws_eks_workload_name: "payments-api-7b9d",
        aws_eks_deployment: "payments-api",
        aws_eks_node: "ip-10-0-1-10.ec2.internal",
      },
      reservedUsage: "2",
      actualUsage: "3",
      splitUsage: "3",
      splitUsageRatio: "0.25",
      splitCost: "1.25",
      unusedCost: "0.25",
      netSplitCost: "1.10",
      netUnusedCost: "0.20",
      publicOnDemandSplitCost: "1.50",
      publicOnDemandUnusedCost: "0.30",
    }, {
      lineItemId: "line-item-002",
      sourceObjectId: "object_2026_07_part_0001",
      sourceRowNumber: 3,
      payerAccountId: PAYER,
      usageAccountId: MEMBER,
      region: "us-east-1",
      usageStartAt: "2026-07-31T10:00:00.000Z",
      usageEndAt: "2026-07-31T11:00:00.000Z",
      platform: "EKS",
      usageType: "USE1-EKS-EC2-vCPU-Hours",
      metric: "VCPU",
      usageUnit: "vCPU-Hours",
      currency: "USD",
      resourceId: "arn:aws:eks:us-east-1:222222222222:pod/prod/payments/pod-a",
      parentResourceId: "i-0123456789abcdef0",
      resourceTags: {
        aws_eks_cluster_name: "payments-prod",
        aws_eks_namespace: "payments",
        aws_eks_workload_type: "ReplicaSet",
        aws_eks_workload_name: "payments-api-7b9d",
        aws_eks_deployment: "payments-api",
        aws_eks_node: "ip-10-0-1-10.ec2.internal",
      },
      reservedUsage: "4",
      actualUsage: "2",
      splitUsage: "4",
      splitUsageRatio: "0.333333333333",
      splitCost: "0.75",
      unusedCost: "0.25",
      netSplitCost: null,
      netUnusedCost: null,
      publicOnDemandSplitCost: "0.90",
      publicOnDemandUnusedCost: "0.30",
    }],
  };
}

function hasError(code: ScadAllocationError["code"]) {
  return (error: unknown): boolean =>
    error instanceof ScadAllocationError && error.code === code;
}

test("pins the current CUR2 SCAD schema and separates S3 runtime from one-time writes", () => {
  assert.equal(SCAD_CUR2_SPLIT_COLUMNS.length, 11);
  assert.deepEqual(SCAD_CUR2_SPLIT_COLUMNS, [
    "split_line_item_actual_usage",
    "split_line_item_net_split_cost",
    "split_line_item_net_unused_cost",
    "split_line_item_parent_resource_id",
    "split_line_item_public_on_demand_split_cost",
    "split_line_item_public_on_demand_unused_cost",
    "split_line_item_reserved_usage",
    "split_line_item_split_cost",
    "split_line_item_split_usage",
    "split_line_item_split_usage_ratio",
    "split_line_item_unused_cost",
  ]);
  assert.deepEqual(SCAD_RUNTIME_S3_READ_IAM_ACTIONS, [
    "s3:GetBucketLocation",
    "s3:ListBucket",
    "s3:GetObject",
    "s3:GetObjectAttributes",
  ]);
  assert.deepEqual(SCAD_ONE_TIME_PROVISIONER_IAM_ACTIONS, [
    "ce:UpdatePreferences",
    "ce:UpdateCostAllocationTagsStatus",
    "iam:CreateServiceLinkedRole",
    "bcm-data-exports:CreateExport",
    "cur:PutReportDefinition",
  ]);
  assert.equal(SCAD_RUNTIME_S3_READ_IAM_ACTIONS.every((action) => action.startsWith("s3:")), true);
});

test("builds exact requested, actual, allocated, headroom, and idle cost without float drift", () => {
  const snapshot = buildScadAllocationSnapshot(capture(), SCOPE, NOW);
  assert.equal(snapshot.state, "READY");
  assert.equal(snapshot.deliveryState, "FIRST_DELIVERY");
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.groupCount, 1);
  const group = snapshot.groups[0];
  assert.deepEqual(group?.requestedUsage.exact, { numerator: "6", denominator: "1" });
  assert.deepEqual(group?.actualUsage.exact, { numerator: "5", denominator: "1" });
  assert.deepEqual(group?.allocatedUsage, { numerator: "7", denominator: "1" });
  assert.deepEqual(group?.actualAboveRequest.exact, { numerator: "1", denominator: "1" });
  assert.deepEqual(group?.requestedHeadroom.exact, { numerator: "2", denominator: "1" });
  assert.deepEqual(group?.allocatedAmortizedCost, { numerator: "2", denominator: "1" });
  assert.deepEqual(group?.attributedUnusedAmortizedCost, { numerator: "1", denominator: "2" });
  assert.deepEqual(group?.attributedAmortizedCost, { numerator: "5", denominator: "2" });
  assert.equal(group?.netAllocatedCost.complete, false);
  assert.equal(group?.netAllocatedCost.exact, null);
  assert.deepEqual(snapshot.totals.attributedAmortizedCost, [{
    currency: "USD",
    exact: { numerator: "5", denominator: "2" },
  }]);
});

test("derives documented account-to-pod lineage and refuses to invent container identity", () => {
  const snapshot = buildScadAllocationSnapshot(capture(), SCOPE, NOW);
  const value = snapshot.groups[0]?.lineage;
  assert.equal(value?.usageAccountId, MEMBER);
  assert.equal(value?.cluster, "payments-prod");
  assert.equal(value?.namespace, "payments");
  assert.equal(value?.workloadType, "ReplicaSet");
  assert.equal(value?.workload, "payments-api-7b9d");
  assert.equal(value?.deployment, "payments-api");
  assert.match(value?.podOrTaskId ?? "", /pod-a$/u);
  assert.equal(value?.containerId, null);
  assert.equal(value?.containerLineageState, "NOT_PUBLISHED_BY_CUR2_SCAD");
  assert.equal(snapshot.lineageCoverage.rowsCompleteThroughPodOrTask, 2);
  assert.equal(snapshot.lineageCoverage.containerRowsPublishedByScad, 0);
});

test("preserves missing actual utilization as null in resource-request-only mode", () => {
  const input = capture();
  for (const row of input.rows) {
    row.actualUsage = null;
    row.splitUsage = row.reservedUsage ?? "0";
  }
  const group = buildScadAllocationSnapshot(input, SCOPE, NOW).groups[0];
  assert.equal(group?.actualUsage.exact, null);
  assert.equal(group?.actualUsage.presentRows, 0);
  assert.equal(group?.actualAboveRequest.exact, null);
  assert.equal(group?.requestedHeadroom.exact, null);
  assert.deepEqual(group?.requestedUsage.exact, { numerator: "6", denominator: "1" });
});

test("discloses forward-only history and atomically replaces corrected billing periods", () => {
  const input = capture();
  input.correctionOfGenerationId = `fbg_${"f".repeat(64)}`;
  input.firstDeliveryObservedAt = "2026-07-16T09:00:00.000Z";
  input.deliverySequence = 2;
  const snapshot = buildScadAllocationSnapshot(input, SCOPE, NOW);
  assert.equal(snapshot.deliveryState, "CORRECTED_DELIVERY");
  assert.equal(snapshot.replacementPolicy, "REPLACE_BILLING_PERIOD_ATOMICALLY");
  assert.equal(snapshot.historicalCoverage.state, "NO_BACKFILL_BEFORE_ENABLEMENT");
  assert.equal(snapshot.historicalCoverage.backfillAvailable, false);
  assert.match(snapshot.historicalCoverage.disclosure, /not backfilled/u);
});

test("reports waiting-first-delivery, partial, stale, and no-usage states honestly", () => {
  const waiting = capture();
  waiting.firstDeliveryObservedAt = null;
  waiting.deliverySequence = 0;
  waiting.objects = [];
  waiting.rows = [];
  waiting.coverage.expectedObjectCount = 0;
  waiting.coverage.processedObjectCount = 0;
  assert.equal(buildScadAllocationSnapshot(waiting, SCOPE, NOW).state, "WAITING_FIRST_DELIVERY");

  const partial = capture();
  partial.coverage.expectedObjectCount = 2;
  partial.coverage.failedObjectCount = 1;
  partial.coverage.errorCode = "S3_OBJECT_FAILED";
  const partialSnapshot = buildScadAllocationSnapshot(partial, SCOPE, NOW);
  assert.equal(partialSnapshot.state, "PARTIAL");
  assert.equal(partialSnapshot.complete, false);
  assert.equal(partialSnapshot.historicalCoverage.state, "PARTIAL_SINCE_ENABLEMENT");

  const stale = capture();
  stale.dataThroughAt = "2026-07-25T00:00:00.000Z";
  assert.equal(buildScadAllocationSnapshot(stale, SCOPE, NOW).state, "STALE");

  const empty = capture();
  empty.rows = [];
  assert.equal(buildScadAllocationSnapshot(empty, SCOPE, NOW).state, "NO_USAGE");
});

test("requires SCAD, resource IDs, every split column, and validated S3 reads", () => {
  for (const mutate of [
    (value: Mutable<ScadCapture>) => { value.tableConfiguration.includeSplitCostAllocationData = "FALSE"; },
    (value: Mutable<ScadCapture>) => { value.tableConfiguration.includeResources = "FALSE"; },
    (value: Mutable<ScadCapture>) => { value.coverage.runtimeS3PermissionsValidated = false; },
    (value: Mutable<ScadCapture>) => {
      value.coverage.schemaColumns = value.coverage.schemaColumns
        .filter((column) => column !== "split_line_item_actual_usage");
    },
  ]) {
    const input = capture();
    mutate(input);
    assert.equal(buildScadAllocationSnapshot(input, SCOPE, NOW).state, "CONFIGURATION_REQUIRED");
  }
});

test("fails closed on tenant, payer, usage-account, and region boundary changes", () => {
  const wrongTenant = { ...SCOPE, customerId: "customer_attacker" };
  assert.throws(
    () => buildScadAllocationSnapshot(capture(), wrongTenant, NOW),
    hasError("SCOPE_MISMATCH"),
  );
  const wrongAccount = capture();
  wrongAccount.rows[0]!.usageAccountId = "333333333333";
  assert.throws(
    () => buildScadAllocationSnapshot(wrongAccount, SCOPE, NOW),
    hasError("ACCOUNT_SCOPE_MISMATCH"),
  );
  const wrongRegion = capture();
  wrongRegion.rows[0]!.region = "eu-west-1";
  assert.throws(
    () => buildScadAllocationSnapshot(wrongRegion, SCOPE, NOW),
    hasError("REGION_SCOPE_MISMATCH"),
  );
});

test("rejects missing object evidence, duplicate billing identity, and inconsistent split usage", () => {
  const missingObject = capture();
  missingObject.rows[0]!.sourceObjectId = "unknown_object";
  assert.throws(
    () => buildScadAllocationSnapshot(missingObject, SCOPE, NOW),
    hasError("EVIDENCE_REFERENCE_MISSING"),
  );
  const duplicate = capture();
  duplicate.rows[1]!.lineItemId = duplicate.rows[0]!.lineItemId;
  assert.throws(
    () => buildScadAllocationSnapshot(duplicate, SCOPE, NOW),
    hasError("CONFLICTING_DUPLICATE"),
  );
  const inconsistent = capture();
  inconsistent.rows[0]!.splitUsage = "2.5";
  assert.throws(
    () => buildScadAllocationSnapshot(inconsistent, SCOPE, NOW),
    hasError("INCONSISTENT_SPLIT_USAGE"),
  );
});

test("keeps missing business lineage costs separate from AWS unused cost", () => {
  const input = capture();
  input.rows[0]!.resourceTags = {};
  const snapshot = buildScadAllocationSnapshot(input, SCOPE, NOW);
  assert.equal(snapshot.lineageCoverage.rowsMissingBusinessLineage, 1);
  assert.deepEqual(snapshot.lineageCoverage.unallocatedAmortizedCost, [{
    currency: "USD",
    exact: { numerator: "3", denominator: "2" },
  }]);
  assert.deepEqual(snapshot.totals.attributedUnusedAmortizedCost, [{
    currency: "USD",
    exact: { numerator: "1", denominator: "2" },
  }]);
});

test("produces deterministic groups and evidence line ordering", () => {
  const forward = buildScadAllocationSnapshot(capture(), SCOPE, NOW);
  const reversedInput = capture();
  reversedInput.rows.reverse();
  const reversed = buildScadAllocationSnapshot(reversedInput, SCOPE, NOW);
  assert.deepEqual(reversed.groups, forward.groups);
  assert.deepEqual(forward.groups[0]?.evidenceLineItemIds, [
    "line-item-001",
    "line-item-002",
  ]);
});

test("adapts accepted SCAD evidence into the shared source-health model", () => {
  const snapshot = buildScadAllocationSnapshot(capture(), SCOPE, NOW);
  const evidence = scadAllocationSourceEvidence(snapshot);
  assert.equal(evidence.sourceId, "scad_allocation");
  assert.equal(evidence.configured, true);
  assert.equal(evidence.deliveryObserved, true);
  assert.equal(evidence.lastAttemptOutcome, "succeeded");
  assert.equal(evidence.coverage.assessment, "complete");
  assert.equal(evidence.coverage.acceptedRecords, 2);
  assert.match(evidence.evidenceBasis, /1\/1 S3 objects processed/u);
});

test("pins the export account and every immutable object to the tenant destination", () => {
  const wrongExportAccount = capture();
  wrongExportAccount.exportArn = "arn:aws:bcm-data-exports:us-east-1:333333333333:export/attacker";
  assert.throws(
    () => buildScadAllocationSnapshot(wrongExportAccount, SCOPE, NOW),
    hasError("INVALID_INPUT"),
  );
  const siblingPrefix = capture();
  siblingPrefix.objects[0]!.key = "exports/scad-archive/BILLING_PERIOD=2026-07/part.csv.gz";
  assert.throws(
    () => buildScadAllocationSnapshot(siblingPrefix, SCOPE, NOW),
    hasError("INVALID_INPUT"),
  );
  const wrongBucket = capture();
  wrongBucket.objects[0]!.bucket = "attacker-cur2-evidence";
  assert.throws(
    () => buildScadAllocationSnapshot(wrongBucket, SCOPE, NOW),
    hasError("INVALID_INPUT"),
  );
});

test("keeps currency totals separate and publishes source failures", () => {
  const mixedCurrency = capture();
  mixedCurrency.rows[1]!.currency = "EUR";
  const snapshot = buildScadAllocationSnapshot(mixedCurrency, SCOPE, NOW);
  assert.deepEqual(snapshot.totals.attributedAmortizedCost, [{
    currency: "EUR",
    exact: { numerator: "1", denominator: "1" },
  }, {
    currency: "USD",
    exact: { numerator: "3", denominator: "2" },
  }]);

  const failed = capture();
  failed.coverage.expectedObjectCount = 2;
  failed.coverage.failedObjectCount = 1;
  failed.coverage.errorCode = "S3_OBJECT_FAILED";
  const failedEvidence = scadAllocationSourceEvidence(
    buildScadAllocationSnapshot(failed, SCOPE, NOW),
  );
  assert.equal(failedEvidence.lastAttemptOutcome, "partial");
  assert.equal(failedEvidence.lastError?.code, "S3_OBJECT_FAILED");
});
