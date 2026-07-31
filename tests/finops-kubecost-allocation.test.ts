import assert from "node:assert/strict";
import test from "node:test";

import {
  buildKubecostAllocationSnapshot,
  KUBECOST_EXPORT_CONTRACT,
  KUBECOST_EXPORTER_S3_WRITE_IAM_ACTIONS,
  KUBECOST_RUNTIME_S3_READ_IAM_ACTIONS,
  KUBECOST_SSE_KMS_READ_IAM_ACTIONS,
  KUBECOST_VERSIONED_OBJECT_READ_IAM_ACTIONS,
  KubecostAllocationError,
  kubecostAllocationSourceEvidence,
  type KubecostAllocationCapture,
  type KubecostAllocationRow,
  type KubecostAllocationScope,
} from "../lib/finops-kubecost-allocation.ts";

const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const ACCOUNT = "111111111111";
const CLUSTER = "eks-prod-us-east-1";
const SCOPE: KubecostAllocationScope = {
  orgId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: `conn_${"a".repeat(32)}`,
  partition: "aws",
  billingPeriod: "2026-07",
  activeCur2GenerationId: `fbg_${"b".repeat(64)}`,
  awsAccountIds: [ACCOUNT],
  clusterIds: [CLUSTER],
};

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function costs(overrides: Partial<KubecostAllocationRow["costs"]> = {}): KubecostAllocationRow["costs"] {
  return {
    cpuCost: "4",
    ramCost: "2",
    gpuCost: "1",
    networkCost: "0.5",
    pvCost: "1",
    loadBalancerCost: "0.25",
    sharedCost: "1",
    externalCost: "1",
    totalCost: "10.75",
    ...overrides,
  };
}

function workloadRow(overrides: Partial<KubecostAllocationRow> = {}): KubecostAllocationRow {
  return {
    sourceRowId: "row_workload_001",
    sourceObjectId: "object_001",
    sourceRowNumber: 2,
    sourceRowSha256: "1".repeat(64),
    windowStartIso: "2026-07-31T10:00:00.000Z",
    windowEndIso: "2026-07-31T11:00:00.000Z",
    usageAccountId: ACCOUNT,
    region: "us-east-1",
    clusterId: CLUSTER,
    namespace: "payments",
    controllerKind: "Deployment",
    controller: "payments-api",
    workload: "payments-api",
    pod: "payments-api-7b9d-abcde",
    container: "api",
    allocationKind: "WORKLOAD",
    currency: "USD",
    costs: costs(),
    metrics: {
      cpuCoreRequestHours: "2",
      cpuCoreUsageHours: "1",
      ramByteRequestHours: "100",
      ramByteUsageHours: "50",
      gpuRequestHours: "1",
      gpuUsageHours: "0.25",
      networkTransferBytes: "1000",
      networkReceiveBytes: "500",
      networkCapacityBytes: null,
      pvProvisionedByteHours: "1000",
      pvUsedByteHours: "500",
    },
    ...overrides,
  };
}

function idleRow(): KubecostAllocationRow {
  return workloadRow({
    sourceRowId: "row_idle_001",
    sourceRowNumber: 3,
    sourceRowSha256: "2".repeat(64),
    namespace: null,
    controllerKind: null,
    controller: null,
    workload: null,
    pod: null,
    container: null,
    allocationKind: "IDLE",
    costs: costs({
      cpuCost: "2",
      ramCost: "0",
      gpuCost: "0",
      networkCost: "0",
      pvCost: "0",
      loadBalancerCost: "0",
      sharedCost: "0",
      externalCost: "0",
      totalCost: "2",
    }),
    metrics: {
      cpuCoreRequestHours: null,
      cpuCoreUsageHours: null,
      ramByteRequestHours: null,
      ramByteUsageHours: null,
      gpuRequestHours: null,
      gpuUsageHours: null,
      networkTransferBytes: null,
      networkReceiveBytes: null,
      networkCapacityBytes: null,
      pvProvisionedByteHours: null,
      pvUsedByteHours: null,
    },
  });
}

function capture(rows: readonly KubecostAllocationRow[] = [workloadRow(), idleRow()]): Mutable<KubecostAllocationCapture> {
  return {
    schemaVersion: "sutra.kubecost-allocation.capture.v1",
    scope: {
      ...SCOPE,
      awsAccountIds: [...SCOPE.awsAccountIds],
      clusterIds: [...SCOPE.clusterIds],
    },
    captureId: `kubecost_${"c".repeat(64)}`,
    startedAtIso: "2026-07-31T11:45:00.000Z",
    completedAtIso: "2026-07-31T11:55:00.000Z",
    generatedAtIso: "2026-07-31T11:44:00.000Z",
    dataThroughAtIso: "2026-07-31T11:00:00.000Z",
    destination: {
      bucket: "sutra-kubecost-evidence-111111111111",
      prefix: "tenants/org_alpha/exports/kubecost/",
    },
    export: {
      provider: "KUBECOST",
      exporterName: "sutra-kubecost-exporter",
      exporterVersion: "1.0.0",
      schemaName: "sutra.kubecost-opencost-allocation",
      schemaVersion: "1.0.0",
      schemaSha256: "3".repeat(64),
      manifestSha256: "4".repeat(64),
      querySha256: "5".repeat(64),
      costModelSha256: "6".repeat(64),
      format: "NDJSON",
      costBasis: "CLOUD_BILL_RECONCILED",
      query: {
        windowStartIso: "2026-07-01T00:00:00.000Z",
        windowEndIso: "2026-08-01T00:00:00.000Z",
        step: "1h",
        accumulate: false,
        rawAllocationLineage: true,
        shareIdle: false,
        splitIdle: true,
        includeSharedCostBreakdown: true,
        external: true,
        cloudBillReconciliationEnabled: true,
      },
    },
    coverage: {
      configured: true,
      deliveryObserved: true,
      runtimeS3PermissionsValidated: true,
      status: "SUCCEEDED",
      expectedObjectCount: 1,
      processedObjectCount: 1,
      failedObjectCount: 0,
      expectedClusterIds: [CLUSTER],
      capturedClusterIds: [CLUSTER],
      rowsExhausted: true,
      errorCode: null,
    },
    objects: [{
      objectId: "object_001",
      bucket: "sutra-kubecost-evidence-111111111111",
      key: "tenants/org_alpha/exports/kubecost/window-2026-07.ndjson",
      eTag: "etag-001",
      versionId: "version-001",
      sha256: "7".repeat(64),
      sizeBytes: 4096,
    }],
    rows: rows.map((row) => ({
      ...row,
      costs: { ...row.costs },
      metrics: { ...row.metrics },
    })),
    cur2Evidence: {
      source: "AWS_CUR2_ACTIVE_GENERATION",
      generationState: "ACTIVE",
      generationId: SCOPE.activeCur2GenerationId,
      manifestSha256: "8".repeat(64),
      billingPeriod: "2026-07",
      dataThroughAtIso: "2026-07-31T11:00:00.000Z",
      payerAccountIds: [ACCOUNT],
      usageAccountIds: [ACCOUNT],
      clusterIds: [CLUSTER],
      scopeBasis: "KUBERNETES_CLUSTER_TAGGED_COST",
      rowsExhausted: true,
      totals: [{ currency: "USD", amountMicros: "12750000" }],
    },
    reconciliationToleranceMicros: "0",
  };
}

function hasError(code: KubecostAllocationError["code"]) {
  return (error: unknown): boolean => error instanceof KubecostAllocationError && error.code === code;
}

test("pins a read-only collector and keeps exporter writes on a separate identity", () => {
  assert.deepEqual(KUBECOST_RUNTIME_S3_READ_IAM_ACTIONS, [
    "s3:GetBucketLocation", "s3:ListBucket", "s3:GetObject",
  ]);
  assert.deepEqual(KUBECOST_VERSIONED_OBJECT_READ_IAM_ACTIONS, ["s3:GetObjectVersion"]);
  assert.deepEqual(KUBECOST_SSE_KMS_READ_IAM_ACTIONS, ["kms:Decrypt"]);
  assert.deepEqual(KUBECOST_EXPORTER_S3_WRITE_IAM_ACTIONS, ["s3:PutObject"]);
  assert.equal(KUBECOST_RUNTIME_S3_READ_IAM_ACTIONS.some((action) => action.includes("Put")), false);
  assert.deepEqual(KUBECOST_EXPORT_CONTRACT.query, {
    window: "EXPLICIT_UTC_RFC3339_PAIR",
    step: "1h",
    accumulate: false,
    rawAllocationLineage: true,
    shareIdle: false,
    splitIdle: true,
    includeSharedCostBreakdown: true,
    external: true,
  });
});

test("builds full container lineage, disjoint cost categories, exact efficiencies, and CUR2 reconciliation", () => {
  const snapshot = buildKubecostAllocationSnapshot(capture(), SCOPE, NOW);
  assert.equal(snapshot.state, "READY");
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.rowCount, 2);
  assert.equal(snapshot.groupCount, 2);
  assert.equal(snapshot.exportLineage.versionPinnedObjectCount, 1);
  assert.deepEqual(snapshot.categoryTotals, [
    { category: "EXTERNAL", currency: "USD", exact: { numerator: "1", denominator: "1" }, rowCount: 1 },
    { category: "IDLE", currency: "USD", exact: { numerator: "2", denominator: "1" }, rowCount: 1 },
    { category: "SHARED", currency: "USD", exact: { numerator: "1", denominator: "1" }, rowCount: 1 },
    { category: "WORKLOAD_ALLOCATION", currency: "USD", exact: { numerator: "35", denominator: "4" }, rowCount: 1 },
  ]);
  const workload = snapshot.groups.find((group) => group.allocationKind === "WORKLOAD");
  assert.equal(workload?.namespace, "payments");
  assert.equal(workload?.controller, "payments-api");
  assert.equal(workload?.pod, "payments-api-7b9d-abcde");
  assert.equal(workload?.container, "api");
  assert.deepEqual(workload?.efficiencies.find((metric) => metric.metric === "CPU")?.ratio, {
    numerator: "1", denominator: "2",
  });
  assert.deepEqual(workload?.efficiencies.find((metric) => metric.metric === "GPU")?.ratio, {
    numerator: "1", denominator: "4",
  });
  assert.equal(workload?.efficiencies.find((metric) => metric.metric === "NETWORK")?.state, "UNAVAILABLE");
  assert.equal(snapshot.reconciliation.state, "MATCHED");
  assert.equal(snapshot.reconciliation.presentationPolicy, "ATTRIBUTION_VIEW_ONLY_DO_NOT_ADD_TO_CUR2");
  assert.deepEqual(snapshot.reconciliation.currencies[0], {
    currency: "USD",
    kubecostTotal: { numerator: "51", denominator: "4" },
    cur2TotalMicros: "12750000",
    delta: { numerator: "0", denominator: "1" },
    withinTolerance: true,
  });
});

test("keeps currencies independent and applies an exact micro-unit tolerance", () => {
  const euro = workloadRow({
    sourceRowId: "row_eur_001",
    sourceRowNumber: 4,
    sourceRowSha256: "9".repeat(64),
    currency: "EUR",
    costs: costs({
      cpuCost: "1.500001",
      ramCost: "0",
      gpuCost: "0",
      networkCost: "0",
      pvCost: "0",
      loadBalancerCost: "0",
      sharedCost: "0",
      externalCost: "0",
      totalCost: "1.500001",
    }),
  });
  const value = capture([workloadRow(), idleRow(), euro]);
  value.cur2Evidence!.totals = [
    { currency: "EUR", amountMicros: "1500000" },
    { currency: "USD", amountMicros: "12750000" },
  ];
  value.reconciliationToleranceMicros = "1";
  const snapshot = buildKubecostAllocationSnapshot(value, SCOPE, NOW);
  assert.equal(snapshot.state, "READY");
  assert.deepEqual(snapshot.reconciliation.currencies.map((entry) => [entry.currency, entry.withinTolerance]), [
    ["EUR", true], ["USD", true],
  ]);
});

test("marks an unreconciled source partial and never treats Kubecost as authoritative spend", () => {
  const value = capture();
  value.cur2Evidence!.totals[0]!.amountMicros = "12000000";
  const snapshot = buildKubecostAllocationSnapshot(value, SCOPE, NOW);
  assert.equal(snapshot.state, "PARTIAL");
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.reconciliation.state, "MISMATCH");
  assert.deepEqual(snapshot.reconciliation.currencies[0]?.delta, {
    numerator: "3", denominator: "4",
  });
});

test("emits explicit configuration, waiting, unknown, error, empty, partial, and stale states", () => {
  const notConfigured = capture();
  notConfigured.coverage.configured = false;
  notConfigured.cur2Evidence = null;
  assert.equal(buildKubecostAllocationSnapshot(notConfigured, SCOPE, NOW).state, "CONFIGURATION_REQUIRED");

  const waiting = capture();
  waiting.coverage.deliveryObserved = false;
  assert.equal(buildKubecostAllocationSnapshot(waiting, SCOPE, NOW).state, "WAITING_FIRST_DELIVERY");

  const unknown = capture();
  unknown.coverage.status = "UNKNOWN";
  assert.equal(buildKubecostAllocationSnapshot(unknown, SCOPE, NOW).state, "UNKNOWN");

  const failed = capture();
  failed.coverage.status = "FAILED";
  failed.coverage.expectedObjectCount = 2;
  failed.coverage.failedObjectCount = 1;
  failed.coverage.errorCode = "EXPORT_FAILED";
  assert.equal(buildKubecostAllocationSnapshot(failed, SCOPE, NOW).state, "ERROR");

  const empty = capture([]);
  empty.cur2Evidence!.totals = [];
  assert.equal(buildKubecostAllocationSnapshot(empty, SCOPE, NOW).state, "EMPTY");

  const partial = capture();
  partial.coverage.rowsExhausted = false;
  partial.coverage.status = "PARTIAL";
  assert.equal(buildKubecostAllocationSnapshot(partial, SCOPE, NOW).state, "PARTIAL");

  const stale = capture();
  stale.dataThroughAtIso = "2026-07-29T11:00:00.000Z";
  stale.cur2Evidence!.dataThroughAtIso = stale.dataThroughAtIso;
  assert.equal(buildKubecostAllocationSnapshot(stale, SCOPE, NOW).state, "STALE");
});

test("blocks cross-tenant, cross-account, and cross-cluster evidence", () => {
  const wrongTenant = { ...SCOPE, customerId: "customer_other" };
  assert.throws(() => buildKubecostAllocationSnapshot(capture(), wrongTenant, NOW), hasError("SCOPE_MISMATCH"));

  const wrongAccount = capture();
  wrongAccount.rows[0]!.usageAccountId = "222222222222";
  assert.throws(() => buildKubecostAllocationSnapshot(wrongAccount, SCOPE, NOW), hasError("ACCOUNT_SCOPE_MISMATCH"));

  const wrongCluster = capture();
  wrongCluster.rows[0]!.clusterId = "eks-other";
  assert.throws(() => buildKubecostAllocationSnapshot(wrongCluster, SCOPE, NOW), hasError("CLUSTER_SCOPE_MISMATCH"));
});

test("pins object prefix/hash lineage and rejects missing or conflicting row evidence", () => {
  const wrongPrefix = capture();
  wrongPrefix.objects[0]!.key = "another-tenant/window.ndjson";
  assert.throws(() => buildKubecostAllocationSnapshot(wrongPrefix, SCOPE, NOW), hasError("OBJECT_SCOPE_MISMATCH"));

  const missingObject = capture();
  missingObject.rows[0]!.sourceObjectId = "object_missing";
  assert.throws(() => buildKubecostAllocationSnapshot(missingObject, SCOPE, NOW), hasError("EVIDENCE_REFERENCE_MISSING"));

  const duplicate = capture([workloadRow(), { ...workloadRow(), sourceRowSha256: "a".repeat(64) }]);
  duplicate.cur2Evidence!.totals[0]!.amountMicros = "21500000";
  assert.throws(() => buildKubecostAllocationSnapshot(duplicate, SCOPE, NOW), hasError("CONFLICTING_DUPLICATE"));
});

test("rejects overlapping windows for the same allocation lineage", () => {
  const overlapping = workloadRow({
    sourceRowId: "row_workload_overlap",
    sourceRowNumber: 5,
    sourceRowSha256: "d".repeat(64),
  });
  const value = capture([workloadRow(), overlapping]);
  value.cur2Evidence!.totals[0]!.amountMicros = "21500000";
  assert.throws(() => buildKubecostAllocationSnapshot(value, SCOPE, NOW), hasError("POLICY_VIOLATION"));
});

test("rejects a declared total that differs from exact cost components", () => {
  const value = capture();
  value.rows[0]!.costs.totalCost = "10.750001";
  assert.throws(() => buildKubecostAllocationSnapshot(value, SCOPE, NOW), hasError("COST_TOTAL_MISMATCH"));
});

test("rejects hidden idle redistribution and inconsistent cloud-bill metadata", () => {
  const sharedIdle = capture();
  (sharedIdle.export.query as { shareIdle: boolean }).shareIdle = true;
  assert.throws(() => buildKubecostAllocationSnapshot(sharedIdle, SCOPE, NOW), hasError("POLICY_VIOLATION"));

  const falseBasis = capture();
  falseBasis.export.costBasis = "KUBECOST_ESTIMATE";
  assert.throws(() => buildKubecostAllocationSnapshot(falseBasis, SCOPE, NOW), hasError("POLICY_VIOLATION"));
});

test("rejects a CUR2 generation, account, cluster, period, or data boundary outside the active scope", () => {
  const cases = [capture(), capture(), capture(), capture(), capture()];
  cases[0]!.cur2Evidence!.generationId = `fbg_${"f".repeat(64)}`;
  cases[1]!.cur2Evidence!.usageAccountIds = ["222222222222"];
  cases[2]!.cur2Evidence!.clusterIds = ["eks-other"];
  cases[3]!.cur2Evidence!.billingPeriod = "2026-06";
  cases[4]!.cur2Evidence!.dataThroughAtIso = "2026-07-31T10:00:00.000Z";
  for (const value of cases) {
    assert.throws(() => buildKubecostAllocationSnapshot(value, SCOPE, NOW), hasError("CUR2_EVIDENCE_MISMATCH"));
  }
});

test("maps READY, PARTIAL, and ERROR snapshots to evidence-honest source health", () => {
  const ready = kubecostAllocationSourceEvidence(buildKubecostAllocationSnapshot(capture(), SCOPE, NOW));
  assert.equal(ready.sourceId, "kubecost_allocation");
  assert.equal(ready.lastAttemptOutcome, "succeeded");
  assert.equal(ready.coverage.assessment, "complete");

  const mismatch = capture();
  mismatch.cur2Evidence!.totals[0]!.amountMicros = "1";
  const partial = kubecostAllocationSourceEvidence(buildKubecostAllocationSnapshot(mismatch, SCOPE, NOW));
  assert.equal(partial.lastAttemptOutcome, "partial");
  assert.equal(partial.coverage.assessment, "partial");

  const failed = capture();
  failed.coverage.status = "FAILED";
  failed.coverage.expectedObjectCount = 2;
  failed.coverage.failedObjectCount = 1;
  failed.coverage.errorCode = "EXPORT_FAILED";
  const error = kubecostAllocationSourceEvidence(buildKubecostAllocationSnapshot(failed, SCOPE, NOW));
  assert.equal(error.lastAttemptOutcome, "failed");
  assert.equal(error.lastError?.code, "KUBECOST_EXPORT_FAILED");
});
