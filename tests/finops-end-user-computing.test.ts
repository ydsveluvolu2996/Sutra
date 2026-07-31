import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEndUserComputingDashboard,
  createEndUserComputingQueryService,
  END_USER_COMPUTING_COLLECTION_BOUNDS,
  END_USER_COMPUTING_READ_OPERATIONS,
  endUserComputingSourceEvidence,
  EndUserComputingEngineError,
  EndUserComputingQueryError,
  normalizeEndUserComputingCapture,
  type EndUserComputingBoundary,
  type EndUserComputingCapture,
  type EndUserComputingPaginatedOperation,
  type EndUserComputingPaginationSequence,
} from "../lib/finops-end-user-computing.ts";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const ACCOUNT_ID = "123456789012";
const REGION = "us-east-1";
const WORKSPACE_ID = "ws-12345678";
const BUNDLE_ID = "wsb-12345678";
const FLEET_NAME = "production-fleet";
const STACK_NAME = "production-stack";
const ASSOCIATION_QUERY = "a".repeat(64);
const SESSION_QUERY = "b".repeat(64);
const BOUNDARY: EndUserComputingBoundary = {
  scope: {
    orgId: "org_alpha",
    customerId: "customer_alpha",
    connectionId: `conn_${"c".repeat(32)}`,
  },
  partition: "aws",
  accountIds: [ACCOUNT_ID],
  regions: [REGION],
};

type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key] extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : T[Key] extends object
      ? Mutable<T[Key]>
      : T[Key];
};

function sequence(
  service: "WORKSPACES" | "APPSTREAM",
  operation: EndUserComputingPaginatedOperation,
  queryKeySha256: string | null = null,
  recordCount = 1,
): EndUserComputingPaginationSequence {
  return {
    service,
    accountId: ACCOUNT_ID,
    region: REGION,
    operation,
    queryKeySha256,
    pages: [{
      requestTokenSha256: null,
      responseNextTokenSha256: null,
      pageSize: operation === "appstream:DescribeSessions"
        ? 50
        : operation === "cloudwatch:GetMetricData" ? 500 : 25,
      recordCount,
    }],
    exhausted: true,
  };
}

function fixture(): Mutable<EndUserComputingCapture> {
  const pagination = [
    sequence("WORKSPACES", "workspaces:DescribeWorkspaces"),
    sequence("WORKSPACES", "workspaces:DescribeWorkspaceBundles"),
    sequence("WORKSPACES", "workspaces:DescribeWorkspacesConnectionStatus"),
    sequence("WORKSPACES", "cloudwatch:GetMetricData"),
    sequence("APPSTREAM", "appstream:DescribeFleets"),
    sequence("APPSTREAM", "appstream:DescribeStacks"),
    sequence("APPSTREAM", "appstream:ListAssociatedFleets", ASSOCIATION_QUERY),
    sequence("APPSTREAM", "appstream:DescribeSessions", SESSION_QUERY, 3),
    sequence("APPSTREAM", "cloudwatch:GetMetricData"),
  ];
  return {
    schemaVersion: "sutra.end-user-computing.v1",
    scope: { ...BOUNDARY.scope },
    partition: "aws",
    accountIds: [ACCOUNT_ID],
    regions: [REGION],
    captureId: `euc_${"d".repeat(64)}`,
    startedAt: "2026-07-31T11:55:00.000Z",
    completedAt: "2026-07-31T12:00:00.000Z",
    execution: {
      concurrencyLimit: 4,
      observedPeakConcurrency: 3,
      pageCount: pagination.length,
    },
    coverage: [{
      service: "APPSTREAM",
      accountId: ACCOUNT_ID,
      region: REGION,
      inventoryStatus: "COMPLETE",
      activityStatus: "COMPLETE",
      metricStatus: "COMPLETE",
      costStatus: "COMPLETE",
      inventoryObservedAt: "2026-07-31T11:59:00.000Z",
      activityObservedAt: "2026-07-31T11:59:00.000Z",
      metricDataThroughAt: "2026-07-31T11:55:00.000Z",
      costDataThroughAt: "2026-07-31T10:00:00.000Z",
      inventoryRecordCount: 2,
      activityRecordCount: 3,
      metricRecordCount: 1,
      costRecordCount: 1,
      inventoryPermissionValidated: true,
      activityPermissionValidated: true,
      metricPermissionValidated: true,
      costGenerationActivated: true,
      failureCode: null,
    }, {
      service: "WORKSPACES",
      accountId: ACCOUNT_ID,
      region: REGION,
      inventoryStatus: "COMPLETE",
      activityStatus: "COMPLETE",
      metricStatus: "COMPLETE",
      costStatus: "COMPLETE",
      inventoryObservedAt: "2026-07-31T11:58:00.000Z",
      activityObservedAt: "2026-07-31T11:58:00.000Z",
      metricDataThroughAt: "2026-07-31T11:55:00.000Z",
      costDataThroughAt: "2026-07-31T10:00:00.000Z",
      inventoryRecordCount: 1,
      activityRecordCount: 1,
      metricRecordCount: 1,
      costRecordCount: 1,
      inventoryPermissionValidated: true,
      activityPermissionValidated: true,
      metricPermissionValidated: true,
      costGenerationActivated: true,
      failureCode: null,
    }],
    pagination: pagination as Mutable<EndUserComputingPaginationSequence>[],
    workspaces: [{
      accountId: ACCOUNT_ID,
      region: REGION,
      workspaceId: WORKSPACE_ID,
      bundleId: BUNDLE_ID,
      state: "AVAILABLE",
      runningMode: "AUTO_STOP",
      computeType: "STANDARD",
      rootVolumeGib: 80,
      userVolumeGib: 50,
      observedAt: "2026-07-31T11:58:00.000Z",
      connection: {
        state: "CONNECTED",
        observedAt: "2026-07-31T11:58:00.000Z",
      },
    }],
    workspaceBundles: [{
      accountId: ACCOUNT_ID,
      region: REGION,
      bundleId: BUNDLE_ID,
      owner: "AMAZON",
      name: "Standard",
      computeType: "STANDARD",
      rootVolumeGib: 80,
      userVolumeGib: 50,
      observedAt: "2026-07-31T11:58:00.000Z",
    }],
    appStreamFleets: [{
      accountId: ACCOUNT_ID,
      region: REGION,
      fleetArn: `arn:aws:appstream:${REGION}:${ACCOUNT_ID}:fleet/${FLEET_NAME}`,
      fleetName: FLEET_NAME,
      state: "RUNNING",
      fleetType: "ON_DEMAND",
      instanceType: "stream.standard.large",
      desiredCapacity: 4,
      runningCapacity: 3,
      inUseCapacity: 2,
      availableCapacity: 1,
      maxSessionsPerInstance: 2,
      observedAt: "2026-07-31T11:59:00.000Z",
    }],
    appStreamStacks: [{
      accountId: ACCOUNT_ID,
      region: REGION,
      stackArn: `arn:aws:appstream:${REGION}:${ACCOUNT_ID}:stack/${STACK_NAME}`,
      stackName: STACK_NAME,
      associatedFleetNames: [FLEET_NAME],
      observedAt: "2026-07-31T11:59:00.000Z",
    }],
    appStreamSessions: [{
      accountId: ACCOUNT_ID,
      region: REGION,
      fleetName: FLEET_NAME,
      stackName: STACK_NAME,
      queryKeySha256: SESSION_QUERY,
      observedAt: "2026-07-31T11:59:00.000Z",
      active: 2,
      pending: 1,
      expired: 0,
      connected: 2,
      notConnected: 1,
    }],
    metrics: [{
      service: "APPSTREAM",
      accountId: ACCOUNT_ID,
      region: REGION,
      resourceScope: "FLEET",
      resourceId: FLEET_NAME,
      metricName: "APPSTREAM_CAPACITY_UTILIZATION",
      statistic: "AVERAGE",
      unit: "PERCENT",
      valueMicros: "66670000",
      sampleCount: 12,
      windowStartAt: "2026-07-31T11:00:00.000Z",
      windowEndAt: "2026-07-31T12:00:00.000Z",
      dataThroughAt: "2026-07-31T11:55:00.000Z",
      completeWindow: true,
      source: "CLOUDWATCH_GET_METRIC_DATA",
      privacyScope: "NO_USER_SESSION_OR_INSTANCE_DIMENSION",
    }, {
      service: "WORKSPACES",
      accountId: ACCOUNT_ID,
      region: REGION,
      resourceScope: "RESOURCE",
      resourceId: WORKSPACE_ID,
      metricName: "WORKSPACES_IN_SESSION_LATENCY",
      statistic: "AVERAGE",
      unit: "MILLISECONDS",
      valueMicros: "48000000",
      sampleCount: 10,
      windowStartAt: "2026-07-31T11:00:00.000Z",
      windowEndAt: "2026-07-31T12:00:00.000Z",
      dataThroughAt: "2026-07-31T11:55:00.000Z",
      completeWindow: true,
      source: "CLOUDWATCH_GET_METRIC_DATA",
      privacyScope: "NO_USER_DIMENSION",
    }],
    billingEvidence: {
      generationId: `fbg_${"e".repeat(64)}`,
      billingPeriod: "2026-07",
      sourceEvidenceId: "cur2-active-generation",
      manifestSha256: "f".repeat(64),
      sourceUpdatedAt: "2026-07-31T09:00:00.000Z",
      committedAt: "2026-07-31T10:00:00.000Z",
      sourceFormat: "aws-cur",
      sourceVersion: "2.0",
      reconciled: true,
      activeGenerationRowCount: 100,
      matchedLineItemCount: 2,
    },
    costs: [{
      lineItemId: "line-appstream-1",
      service: "APPSTREAM",
      accountId: ACCOUNT_ID,
      region: REGION,
      resourceId: null,
      usageStartAt: "2026-07-30T00:00:00.000Z",
      usageEndAt: "2026-07-30T01:00:00.000Z",
      currency: "USD",
      amountsMicros: {
        unblended: "1200000",
        net: "1100000",
        amortized: "1050000",
        list: "1300000",
        contracted: "1150000",
        public: "1300000",
      },
      usageAmountMicros: "1000000",
      usageUnit: "Hrs",
      commitmentClass: "SAVINGS_PLAN",
    }, {
      lineItemId: "line-workspaces-1",
      service: "WORKSPACES",
      accountId: ACCOUNT_ID,
      region: REGION,
      resourceId: WORKSPACE_ID,
      usageStartAt: "2026-07-30T00:00:00.000Z",
      usageEndAt: "2026-07-30T01:00:00.000Z",
      currency: "USD",
      amountsMicros: {
        unblended: "2000000",
        net: null,
        amortized: "1800000",
        list: "2200000",
        contracted: null,
        public: "2200000",
      },
      usageAmountMicros: "1000000",
      usageUnit: "Hrs",
      commitmentClass: "ON_DEMAND",
    }],
  };
}

test("declares only the exact read-only WorkSpaces, AppStream, and CloudWatch operations", () => {
  assert.deepEqual(END_USER_COMPUTING_READ_OPERATIONS, [...END_USER_COMPUTING_READ_OPERATIONS].sort());
  assert.deepEqual(END_USER_COMPUTING_READ_OPERATIONS, [
    "appstream:DescribeFleets",
    "appstream:DescribeSessions",
    "appstream:DescribeStacks",
    "appstream:ListAssociatedFleets",
    "cloudwatch:GetMetricData",
    "workspaces:DescribeWorkspaceBundles",
    "workspaces:DescribeWorkspaces",
    "workspaces:DescribeWorkspacesConnectionStatus",
  ]);
  assert.equal(END_USER_COMPUTING_READ_OPERATIONS.some((operation) =>
    /:(Create|Delete|Start|Stop|Update|Terminate|Associate|Disassociate|Put)/u.test(operation)
  ), false);
  assert.equal(END_USER_COMPUTING_COLLECTION_BOUNDS.maximumConcurrency, 4);
});

test("normalizes inventory, aggregate activity, CloudWatch evidence, and reconciled CUR2 cost", () => {
  const snapshot = normalizeEndUserComputingCapture(fixture(), BOUNDARY, NOW.getTime());
  assert.equal(snapshot.state, "READY");
  assert.equal(snapshot.workspaces.length, 1);
  assert.equal(snapshot.workspaceBundles.length, 1);
  assert.equal(snapshot.appStreamFleets.length, 1);
  assert.equal(snapshot.appStreamStacks.length, 1);
  assert.equal(snapshot.appStreamSessions[0]?.active, 2);
  assert.equal(snapshot.billingEvidence?.sourceVersion, "2.0");

  const dashboard = buildEndUserComputingDashboard(snapshot);
  assert.deepEqual(dashboard.inventory, {
    workspaceCount: 1,
    availableWorkspaces: 1,
    stoppedWorkspaces: 0,
    otherStateWorkspaces: 0,
    bundleCount: 1,
    fleetCount: 1,
    runningFleets: 1,
    stoppedFleets: 0,
    otherStateFleets: 0,
    stackCount: 1,
  });
  assert.deepEqual(dashboard.activity.workspaceConnections, {
    connected: 1,
    disconnected: 0,
    unknown: 0,
    missing: 0,
  });
  assert.equal(dashboard.activity.appStreamSessions.active, 2);
  assert.equal(dashboard.activity.appStreamSessions.pending, 1);
  assert.equal(dashboard.costViews.find((item) => item.service === "WORKSPACES")
    ?.totals.find((item) => item.basis === "net")?.totalMicros, null);
  assert.equal(dashboard.costViews.find((item) => item.service === "APPSTREAM")
    ?.commitments[0]?.commitmentClass, "SAVINGS_PLAN");
  assert.equal(dashboard.separation.crossSourceInference, false);

  const missing = dashboard.telemetry.find((item) =>
    item.metricName === "WORKSPACES_CONNECTION_FAILURE"
  );
  assert.equal(missing?.evidenceState, "UNKNOWN");
  assert.deepEqual(missing?.observations, []);
  assert.equal(dashboard.telemetry.find((item) =>
    item.metricName === "WORKSPACES_IN_SESSION_LATENCY"
  )?.evidenceKind, "PERFORMANCE");

  const source = endUserComputingSourceEvidence(snapshot);
  assert.equal(source.sourceId, "end_user_computing_telemetry");
  assert.equal(source.coverage.assessment, "complete");
  assert.equal(source.lastAttemptOutcome, "succeeded");
});

test("rejects tenant, connection, partition, account, and Region substitution", () => {
  const boundaries: EndUserComputingBoundary[] = [
    { ...BOUNDARY, scope: { ...BOUNDARY.scope, orgId: "org_attacker" } },
    { ...BOUNDARY, scope: { ...BOUNDARY.scope, connectionId: `conn_${"9".repeat(32)}` } },
    { ...BOUNDARY, partition: "aws-cn" },
    { ...BOUNDARY, accountIds: ["999988887777"] },
    { ...BOUNDARY, regions: ["us-west-2"] },
  ];
  for (const boundary of boundaries) {
    assert.throws(
      () => normalizeEndUserComputingCapture(fixture(), boundary, NOW.getTime()),
      (error) => error instanceof EndUserComputingEngineError && error.code === "SCOPE_MISMATCH",
    );
  }
});

test("rejects end-user PII, session IDs, instance IDs, and network fields at the broker shape", () => {
  const disallowed: Array<[keyof ReturnType<typeof fixture>, string, unknown]> = [
    ["workspaces", "userName", "alice@example.com"],
    ["workspaces", "computerName", "ALICE-DESKTOP"],
    ["workspaces", "ipAddress", "10.0.0.5"],
    ["appStreamSessions", "sessionId", "session-secret"],
    ["appStreamSessions", "userId", "alice@example.com"],
    ["appStreamSessions", "instanceId", "i-session-host"],
  ];
  for (const [collection, field, value] of disallowed) {
    const input = fixture() as unknown as Record<string, Array<Record<string, unknown>>>;
    input[collection as string]![0]![field] = value;
    assert.throws(
      () => normalizeEndUserComputingCapture(input, BOUNDARY, NOW.getTime()),
      (error) => error instanceof EndUserComputingEngineError && error.code === "INVALID_INPUT",
    );
  }
  const dashboardJson = JSON.stringify(buildEndUserComputingDashboard(
    normalizeEndUserComputingCapture(fixture(), BOUNDARY, NOW.getTime()),
  ));
  assert.doesNotMatch(dashboardJson, /userName|userId|sessionId|instanceId|ipAddress|computerName/u);
});

test("rejects pagination replay, unexhausted complete coverage, count mismatch, and excess concurrency", () => {
  const validTwoPages = fixture();
  validTwoPages.pagination[0]!.pages = [{
    requestTokenSha256: null,
    responseNextTokenSha256: "0".repeat(64),
    pageSize: 25,
    recordCount: 1,
  }, {
    requestTokenSha256: "0".repeat(64),
    responseNextTokenSha256: null,
    pageSize: 25,
    recordCount: 0,
  }];
  validTwoPages.execution.pageCount += 1;
  assert.equal(
    normalizeEndUserComputingCapture(
      validTwoPages,
      BOUNDARY,
      NOW.getTime(),
    ).paginationSequenceCount,
    9,
  );

  const replay = fixture();
  replay.pagination[0]!.pages = [{
    requestTokenSha256: null,
    responseNextTokenSha256: "1".repeat(64),
    pageSize: 25,
    recordCount: 1,
  }, {
    requestTokenSha256: "1".repeat(64),
    responseNextTokenSha256: "1".repeat(64),
    pageSize: 25,
    recordCount: 1,
  }];
  replay.execution.pageCount += 1;
  assert.throws(
    () => normalizeEndUserComputingCapture(replay, BOUNDARY, NOW.getTime()),
    (error) => error instanceof EndUserComputingEngineError && error.code === "INVALID_PAGINATION",
  );

  const incomplete = fixture();
  incomplete.pagination[0]!.exhausted = false;
  incomplete.pagination[0]!.pages[0]!.responseNextTokenSha256 = "2".repeat(64);
  assert.throws(
    () => normalizeEndUserComputingCapture(incomplete, BOUNDARY, NOW.getTime()),
    (error) => error instanceof EndUserComputingEngineError && error.code === "INVALID_PAGINATION",
  );

  const countMismatch = fixture();
  countMismatch.coverage[0]!.metricRecordCount = 2;
  assert.throws(
    () => normalizeEndUserComputingCapture(countMismatch, BOUNDARY, NOW.getTime()),
    (error) => error instanceof EndUserComputingEngineError && error.code === "INVALID_INPUT",
  );

  const concurrency = fixture();
  concurrency.execution.observedPeakConcurrency = 5;
  assert.throws(
    () => normalizeEndUserComputingCapture(concurrency, BOUNDARY, NOW.getTime()),
    (error) => error instanceof EndUserComputingEngineError && error.code === "INVALID_INPUT",
  );
});

test("accepts identical duplicates deterministically and rejects conflicting duplicates", () => {
  const identical = fixture();
  identical.metrics.push(structuredClone(identical.metrics[0]!));
  assert.equal(
    normalizeEndUserComputingCapture(identical, BOUNDARY, NOW.getTime()).metrics.length,
    2,
  );

  const conflict = fixture();
  const duplicate = structuredClone(conflict.metrics[0]!);
  duplicate.valueMicros = "70000000";
  conflict.metrics.push(duplicate);
  assert.throws(
    () => normalizeEndUserComputingCapture(conflict, BOUNDARY, NOW.getTime()),
    (error) => error instanceof EndUserComputingEngineError && error.code === "CONFLICTING_DUPLICATE",
  );
});

test("keeps missing metrics unknown and partial, and reports stale source evidence", () => {
  const partial = fixture();
  partial.metrics = partial.metrics.filter((item) => item.service !== "WORKSPACES");
  const row = partial.coverage.find((item) => item.service === "WORKSPACES")!;
  row.metricStatus = "PARTIAL";
  row.metricDataThroughAt = null;
  row.metricRecordCount = 0;
  row.metricPermissionValidated = false;
  row.failureCode = "BOUND_REACHED";
  const snapshot = normalizeEndUserComputingCapture(partial, BOUNDARY, NOW.getTime());
  assert.equal(snapshot.state, "PARTIAL");
  const workspaceTelemetry = buildEndUserComputingDashboard(snapshot, {
    services: ["WORKSPACES"],
  }).telemetry;
  assert.equal(workspaceTelemetry.every((metric) => metric.evidenceState === "UNKNOWN"), true);
  assert.equal(workspaceTelemetry.every((metric) => metric.observations.length === 0), true);

  const stale = fixture();
  for (const coverage of stale.coverage) {
    coverage.metricDataThroughAt = "2026-07-30T00:00:00.000Z";
  }
  for (const metric of stale.metrics) {
    metric.windowStartAt = "2026-07-29T23:00:00.000Z";
    metric.windowEndAt = "2026-07-30T00:00:00.000Z";
    metric.dataThroughAt = "2026-07-30T00:00:00.000Z";
  }
  const staleSnapshot = normalizeEndUserComputingCapture(stale, BOUNDARY, NOW.getTime());
  assert.equal(staleSnapshot.state, "STALE");
  assert.equal(staleSnapshot.freshness.metrics, "STALE");
});

test("requires active reconciled CUR2 evidence and never lets cost imply utilization", () => {
  const noBilling = fixture();
  noBilling.billingEvidence = null;
  noBilling.costs = [];
  for (const row of noBilling.coverage) {
    row.costStatus = "UNAVAILABLE";
    row.costDataThroughAt = null;
    row.costRecordCount = 0;
    row.costGenerationActivated = false;
    row.failureCode = "CANONICAL_COST_UNAVAILABLE";
  }
  const snapshot = normalizeEndUserComputingCapture(noBilling, BOUNDARY, NOW.getTime());
  const dashboard = buildEndUserComputingDashboard(snapshot);
  assert.equal(snapshot.state, "PARTIAL");
  assert.deepEqual(dashboard.costViews, []);
  assert.equal(dashboard.telemetry.some((metric) => metric.evidenceState === "OBSERVED"), true);

  const fakeFocus = fixture();
  const fakeBilling = fakeFocus.billingEvidence as unknown as Record<string, unknown>;
  fakeBilling.sourceFormat = "focus";
  fakeBilling.sourceVersion = "1.2";
  assert.throws(
    () => normalizeEndUserComputingCapture(fakeFocus, BOUNDARY, NOW.getTime()),
    (error) => error instanceof EndUserComputingEngineError && error.code === "INVALID_INPUT",
  );
});

test("bounds dashboard filters and paginates resources without accepting a foreign account", () => {
  const snapshot = normalizeEndUserComputingCapture(fixture(), BOUNDARY, NOW.getTime());
  const first = buildEndUserComputingDashboard(snapshot, { limit: 1 });
  assert.equal(first.resources.length, 1);
  assert.equal(first.nextCursor, "v1:1");
  const second = buildEndUserComputingDashboard(snapshot, {
    limit: 2,
    cursor: first.nextCursor!,
  });
  assert.equal(second.resources.length, 2);
  assert.equal(second.nextCursor, null);
  assert.throws(
    () => buildEndUserComputingDashboard(snapshot, {
      accountIds: ["999988887777"],
    }),
    (error) => error instanceof EndUserComputingEngineError && error.code === "INVALID_INPUT",
  );
});

test("query service sends a server-pinned, privacy-minimized broker request and returns generic errors", async () => {
  let observed: unknown;
  const service = createEndUserComputingQueryService(BOUNDARY, {
    async collect(request) {
      observed = request;
      return fixture();
    },
  }, () => NOW.getTime());
  const dashboard = await service.query({ services: ["WORKSPACES"] });
  assert.equal(dashboard.inventory.workspaceCount, 1);
  assert.deepEqual(observed, {
    schemaVersion: "sutra.end-user-computing-query.v1",
    boundary: BOUNDARY,
    operations: END_USER_COMPUTING_READ_OPERATIONS,
    bounds: END_USER_COMPUTING_COLLECTION_BOUNDS,
    canonicalBillingSource: "ACTIVE_RECONCILED_CUR2_GENERATION",
    sanitizeBeforeBroker: true,
    includeUserIdentifiers: false,
    includeSessionIdentifiers: false,
    includeInstanceIdentifiers: false,
    includeNetworkAddresses: false,
    includeRawProviderMessages: false,
    includeRawPaginationTokens: false,
  });

  const unavailable = createEndUserComputingQueryService(BOUNDARY, {
    async collect() { throw new Error("sensitive provider detail"); },
  });
  await assert.rejects(
    unavailable.query(),
    (error) => error instanceof EndUserComputingQueryError
      && error.code === "SOURCE_UNAVAILABLE"
      && !error.message.includes("sensitive"),
  );

  const invalid = createEndUserComputingQueryService(BOUNDARY, {
    async collect() { return { providerMessage: "sensitive" }; },
  });
  await assert.rejects(
    invalid.query(),
    (error) => error instanceof EndUserComputingQueryError
      && error.code === "INVALID_EVIDENCE",
  );
});
