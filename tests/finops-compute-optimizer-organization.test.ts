import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPUTE_OPTIMIZER_COLLECTION_BOUNDS,
  COMPUTE_OPTIMIZER_READ_OPERATIONS,
  ComputeOptimizerOrganizationError,
  ComputeOptimizerQueryServiceError,
  buildComputeOptimizerDashboard,
  computeOptimizerOrganizationSourceEvidence,
  createComputeOptimizerQueryService,
  normalizeComputeOptimizerOrganizationCapture,
  type ComputeOptimizerBrokerRequest,
  type ComputeOptimizerGetOperation,
  type ComputeOptimizerOrganizationCapture,
  type ComputeOptimizerPage,
  type ComputeOptimizerRecommendationRecord,
  type ComputeOptimizerSummaryRecord,
  type ComputeOptimizerTenantBoundary,
} from "../lib/finops-compute-optimizer-organization.ts";
import { buildFinopsSourceReadiness } from "../lib/finops-source-health.ts";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const ACCOUNT_ID = "123456789012";
const MEMBER_ACCOUNT_ID = "210987654321";
const CONNECTION_ID = `conn_${"a".repeat(32)}`;
const COLLECTION_ID = `co_${"b".repeat(32)}`;
const REGION = "ap-south-1";
const RESOURCE_ARN =
  `arn:aws:ec2:${REGION}:${MEMBER_ACCOUNT_ID}:instance/i-0123456789abcdef0`;
const boundary: ComputeOptimizerTenantBoundary = {
  scope: {
    orgId: "org_alpha",
    customerId: "customer_alpha",
    connectionId: CONNECTION_ID,
  },
  managementAccountId: ACCOUNT_ID,
  partition: "aws",
  regions: [REGION],
};

type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;

function mutable<T>(value: T): DeepMutable<T> {
  return structuredClone(value) as DeepMutable<T>;
}

function recommendationSequences(
  value: unknown,
): ComputeOptimizerOrganizationCapture["recommendationSequences"] {
  return value as
    ComputeOptimizerOrganizationCapture["recommendationSequences"];
}

const recommendationOperations: readonly ComputeOptimizerGetOperation[] = [
  "GET_EC2_INSTANCE_RECOMMENDATIONS",
  "GET_AUTO_SCALING_GROUP_RECOMMENDATIONS",
  "GET_EBS_VOLUME_RECOMMENDATIONS",
  "GET_LAMBDA_FUNCTION_RECOMMENDATIONS",
  "GET_ECS_SERVICE_RECOMMENDATIONS",
  "GET_LICENSE_RECOMMENDATIONS",
  "GET_RDS_DATABASE_RECOMMENDATIONS",
  "GET_IDLE_RECOMMENDATIONS",
];

function recommendation(
  overrides: Partial<ComputeOptimizerRecommendationRecord> = {},
): ComputeOptimizerRecommendationRecord {
  return {
    accountId: MEMBER_ACCOUNT_ID,
    region: REGION,
    resourceType: "EC2_INSTANCE",
    resourceArn: RESOURCE_ARN,
    resourceId: "i-0123456789abcdef0",
    finding: "OVER_PROVISIONED",
    findingReasonCodes: ["CPU_OVER_PROVISIONED"],
    lastRefreshAt: "2026-07-31T08:00:00.000Z",
    lookbackPeriodDays: 14,
    currentConfiguration: "m6i.xlarge",
    currentPerformanceRisk: 1,
    options: [{
      rank: 1,
      targetConfiguration: "m7g.large",
      performanceRisk: 1,
      migrationEffort: "LOW",
      savings: {
        estimatedMonthlySavings: 42.5,
        percentage: 31.2,
        currency: "USD",
        includesExistingDiscounts: false,
      },
    }],
    ...overrides,
  };
}

function page<T>(
  accountId: string,
  records: readonly T[],
  region = REGION,
): ComputeOptimizerPage<T> {
  return {
    request: {
      accountId,
      region,
      maxResults: COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.pageSize,
      nextToken: null,
      filters: [],
    },
    response: {
      records,
      nextToken: null,
    },
  };
}

function capture(
  overrides: Partial<ComputeOptimizerOrganizationCapture> = {},
): ComputeOptimizerOrganizationCapture {
  const summary: ComputeOptimizerSummaryRecord = {
    accountId: MEMBER_ACCOUNT_ID,
    region: REGION,
    resourceType: "EC2_INSTANCE",
    findingCounts: {
      OPTIMIZED: 2,
      OVER_PROVISIONED: 1,
    },
    savings: {
      estimatedMonthlySavings: 42.5,
      percentage: 31.2,
      currency: "USD",
      includesExistingDiscounts: false,
    },
  };
  const allAccounts = [ACCOUNT_ID, MEMBER_ACCOUNT_ID];
  const summarySequences = allAccounts.map((accountId) => ({
    operation: "GET_RECOMMENDATION_SUMMARIES" as const,
    accountId,
    region: REGION,
    pages: [page(
      accountId,
      accountId === MEMBER_ACCOUNT_ID ? [summary] : [],
    )],
    exhausted: true,
    status: "SUCCEEDED" as const,
    errorCode: null,
  }));
  const recommendationSequences = allAccounts.flatMap((accountId) =>
    recommendationOperations.map((operation) => ({
      operation,
      accountId,
      region: REGION,
      pages: [page(
        accountId,
        accountId === MEMBER_ACCOUNT_ID
            && operation === "GET_EC2_INSTANCE_RECOMMENDATIONS"
          ? [recommendation()]
          : [],
      )],
      exhausted: true,
      status: "SUCCEEDED" as const,
      errorCode: null,
    }))
  );
  return {
    schemaVersion: "sutra.compute-optimizer-organization.v1",
    scope: boundary.scope,
    managementAccountId: ACCOUNT_ID,
    partition: "aws",
    regions: [REGION],
    collectionId: COLLECTION_ID,
    startedAt: "2026-07-31T10:00:00.000Z",
    completedAt: "2026-07-31T10:03:00.000Z",
    maximumConcurrency:
      COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumConcurrency,
    enrollment: {
      status: "ACTIVE",
      lastUpdatedAt: "2026-07-30T12:00:00.000Z",
      memberAccountsEnrolled: true,
      numberOfMemberAccountsOptedIn: 1,
      collectorAccountType: "MANAGEMENT",
      trustedAccessEnabled: true,
      readPermissionsValidated: true,
    },
    memberEnrollmentPages: [page(ACCOUNT_ID, [{
      accountId: MEMBER_ACCOUNT_ID,
      status: "ACTIVE",
      lastUpdatedAt: "2026-07-30T12:00:00.000Z",
      reasonCode: null,
    }])],
    memberEnrollmentExhausted: true,
    summarySequences,
    recommendationSequences,
    exportConfiguration: {
      configured: true,
      bucket: "sutra-compute-optimizer-exports",
      keyPrefix: "organization/history",
      includeMemberAccounts: true,
      provisioningLedgerVerified: true,
    },
    exportJobSequences: [{
      region: REGION,
      pages: [page(ACCOUNT_ID, [{
        jobId: "job-20260731",
        region: REGION,
        resourceType: "EC2_INSTANCE",
        status: "COMPLETE",
        createdAt: "2026-07-30T09:00:00.000Z",
        lastUpdatedAt: "2026-07-30T09:30:00.000Z",
        bucket: "sutra-compute-optimizer-exports",
        objectKey: "organization/history/compute-optimizer/export.csv",
        metadataKey:
          "organization/history/compute-optimizer/export-metadata.json",
        failureCode: null,
      }])],
      exhausted: true,
      status: "SUCCEEDED",
      errorCode: null,
    }],
    exportSnapshots: [{
      jobId: "job-20260731",
      region: REGION,
      resourceType: "EC2_INSTANCE",
      bucket: "sutra-compute-optimizer-exports",
      objectKey: "organization/history/compute-optimizer/export.csv",
      metadataKey:
        "organization/history/compute-optimizer/export-metadata.json",
      objectSha256: "c".repeat(64),
      metadataSha256: "d".repeat(64),
      contentBytes: 4_096,
      parsedAt: "2026-07-30T09:35:00.000Z",
      rowCount: 1,
      organizationScopeVerified: true,
      includeMemberAccounts: true,
      recommendations: [
        recommendation({
          lastRefreshAt: "2026-07-30T08:00:00.000Z",
        }),
      ],
    }],
    ...overrides,
  };
}

test("normalizes complete current and immutable historical AWS evidence", () => {
  const snapshot = normalizeComputeOptimizerOrganizationCapture(
    capture(),
    boundary,
    NOW,
  );
  assert.equal(snapshot.status, "COMPLETE");
  assert.equal(snapshot.configurationState, "READY");
  assert.equal(snapshot.evidence.currentCoverageComplete, true);
  assert.equal(
    snapshot.evidence.organizationEnrollmentCoverageComplete,
    true,
  );
  assert.equal(snapshot.evidence.organizationExportCoverageComplete, true);
  assert.deepEqual(
    snapshot.evidence.readOperations,
    COMPUTE_OPTIMIZER_READ_OPERATIONS,
  );
  assert.equal(
    snapshot.currentRecommendations[0]?.provenance.evidenceKind,
    "DIRECT_GET_API",
  );
  assert.equal(
    snapshot.historicalRecommendations[0]?.provenance.evidenceKind,
    "S3_EXPORT",
  );
  assert.equal(
    snapshot.historicalRecommendations[0]?.provenance.exportObjectSha256,
    "c".repeat(64),
  );
  assert.equal(snapshot.evidence.localHeuristicsUsedAsAwsEvidence, false);

  const evidence = computeOptimizerOrganizationSourceEvidence(snapshot);
  assert.equal(evidence.sourceId, "compute_optimizer_organization_export");
  assert.equal(evidence.coverage.assessment, "complete");
  assert.match(evidence.evidenceBasis, /hash-addressed S3 exports/u);
  const readiness = buildFinopsSourceReadiness({
    scope: boundary.scope,
    evidence: [evidence],
    nowMs: NOW.getTime(),
  });
  assert.equal(
    readiness.sources.find((source) =>
      source.id === "compute_optimizer_organization_export"
    )?.state,
    "healthy",
  );
  assert.equal(
    readiness.capabilities.find((capability) =>
      capability.id === "compute_optimizer"
    )?.ready,
    true,
  );

  const dashboard = buildComputeOptimizerDashboard({ snapshot });
  assert.deepEqual(dashboard.savingsByCurrency, { USD: 42.5 });
  assert.match(dashboard.disclaimer, /Sutra heuristics are not substituted/u);
});

test("rejects tenant, connection, account, partition, and Region mismatches", () => {
  for (
    const changed of [
      {
        ...boundary,
        scope: { ...boundary.scope, orgId: "org_attacker" },
      },
      { ...boundary, managementAccountId: "999988887777" },
      { ...boundary, partition: "aws-us-gov" as const },
      { ...boundary, regions: ["us-east-1"] },
    ]
  ) {
    assert.throws(
      () => normalizeComputeOptimizerOrganizationCapture(
        capture(),
        changed,
        NOW,
      ),
      (error) =>
        error instanceof ComputeOptimizerOrganizationError
        && error.code === "SCOPE_MISMATCH",
    );
  }
});

test("rejects credential material at the trust boundary", () => {
  assert.throws(
    () => normalizeComputeOptimizerOrganizationCapture({
      ...capture(),
      temporaryCredentials: {
        accessKeyId: "must-not-cross-the-boundary",
      },
    }, boundary, NOW),
    (error) =>
      error instanceof ComputeOptimizerOrganizationError
      && error.code === "INVALID_INPUT",
  );
});

test("requires continuous unfiltered pagination and declared concurrency", () => {
  const invalidSequence = mutable(capture().recommendationSequences);
  invalidSequence[0]!.pages[0]!.request.nextToken = "unexpected-token";
  assert.throws(
    () => normalizeComputeOptimizerOrganizationCapture(
      capture({
        recommendationSequences: recommendationSequences(invalidSequence),
      }),
      boundary,
      NOW,
    ),
    (error) =>
      error instanceof ComputeOptimizerOrganizationError
      && error.code === "INVALID_PAGINATION",
  );

  assert.throws(
    () => normalizeComputeOptimizerOrganizationCapture(
      capture({ maximumConcurrency: 5 }),
      boundary,
      NOW,
    ),
    (error) =>
      error instanceof ComputeOptimizerOrganizationError
      && error.code === "INVALID_INPUT",
  );
});

test("deduplicates identical records and rejects conflicting provider evidence", () => {
  const sequences = mutable(capture().recommendationSequences);
  const ec2 = sequences.find((entry) =>
    entry.accountId === MEMBER_ACCOUNT_ID
    && entry.operation === "GET_EC2_INSTANCE_RECOMMENDATIONS"
  )!;
  ec2.pages[0]!.response.records = [
    mutable(recommendation()),
    mutable(recommendation()),
  ];
  const deduped = normalizeComputeOptimizerOrganizationCapture(
    capture({ recommendationSequences: recommendationSequences(sequences) }),
    boundary,
    NOW,
  );
  assert.equal(deduped.currentRecommendations.length, 1);

  ec2.pages[0]!.response.records = [
    mutable(recommendation()),
    mutable(recommendation({ finding: "OPTIMIZED" })),
  ];
  assert.throws(
    () => normalizeComputeOptimizerOrganizationCapture(
      capture({ recommendationSequences: recommendationSequences(sequences) }),
      boundary,
      NOW,
    ),
    (error) =>
      error instanceof ComputeOptimizerOrganizationError
      && error.code === "CONFLICTING_DUPLICATE",
  );
});

test("never accepts an unverified or single-account export as organization history", () => {
  const snapshots = mutable(capture().exportSnapshots);
  snapshots[0]!.organizationScopeVerified = false;
  assert.throws(
    () => normalizeComputeOptimizerOrganizationCapture(
      capture({ exportSnapshots: snapshots }),
      boundary,
      NOW,
    ),
    (error) =>
      error instanceof ComputeOptimizerOrganizationError
      && error.code === "UNVERIFIED_EXPORT",
  );

  const singleAccount = mutable(capture().exportConfiguration);
  singleAccount.includeMemberAccounts = false;
  assert.throws(
    () => normalizeComputeOptimizerOrganizationCapture(
      capture({ exportConfiguration: singleAccount }),
      boundary,
      NOW,
    ),
    (error) =>
      error instanceof ComputeOptimizerOrganizationError
      && error.code === "UNVERIFIED_EXPORT",
  );
});

test("reports explicit enrollment and export-configuration states", () => {
  const notEnrolled = normalizeComputeOptimizerOrganizationCapture(capture({
    enrollment: {
      ...capture().enrollment,
      status: "INACTIVE",
      memberAccountsEnrolled: false,
      numberOfMemberAccountsOptedIn: 0,
    },
    memberEnrollmentPages: [page(ACCOUNT_ID, [])],
    summarySequences: [],
    recommendationSequences: [],
    exportConfiguration: {
      configured: false,
      bucket: null,
      keyPrefix: null,
      includeMemberAccounts: false,
      provisioningLedgerVerified: false,
    },
    exportJobSequences: [],
    exportSnapshots: [],
  }), boundary, NOW);
  assert.equal(notEnrolled.configurationState, "ENROLLMENT_REQUIRED");
  assert.equal(notEnrolled.status, "PARTIAL");

  const missingExport = normalizeComputeOptimizerOrganizationCapture(capture({
    exportConfiguration: {
      configured: false,
      bucket: null,
      keyPrefix: null,
      includeMemberAccounts: false,
      provisioningLedgerVerified: false,
    },
    exportJobSequences: [],
    exportSnapshots: [],
  }), boundary, NOW);
  assert.equal(
    missingExport.configurationState,
    "EXPORT_CONFIGURATION_REQUIRED",
  );
  assert.equal(
    computeOptimizerOrganizationSourceEvidence(missingExport).coverage
      .assessment,
    "partial",
  );
});

test("reports pending, failed, organization-access, and export-job states", () => {
  const pending = mutable(capture());
  pending.enrollment.status = "PENDING";
  assert.equal(
    normalizeComputeOptimizerOrganizationCapture(pending, boundary, NOW)
      .configurationState,
    "ENROLLMENT_PENDING",
  );

  const enrollmentFailed = mutable(capture());
  enrollmentFailed.enrollment.status = "FAILED";
  const failedEnrollmentSnapshot =
    normalizeComputeOptimizerOrganizationCapture(
      enrollmentFailed,
      boundary,
      NOW,
    );
  assert.equal(
    failedEnrollmentSnapshot.configurationState,
    "ENROLLMENT_FAILED",
  );
  assert.equal(failedEnrollmentSnapshot.status, "UNAVAILABLE");

  const organizationAccess = mutable(capture());
  organizationAccess.enrollment.trustedAccessEnabled = false;
  assert.equal(
    normalizeComputeOptimizerOrganizationCapture(
      organizationAccess,
      boundary,
      NOW,
    ).configurationState,
    "ORGANIZATION_ACCESS_REQUIRED",
  );

  const exportInProgress = mutable(capture());
  const progressJob =
    exportInProgress.exportJobSequences[0]!.pages[0]!.response.records[0]!;
  progressJob.status = "IN_PROGRESS";
  progressJob.bucket = null;
  progressJob.objectKey = null;
  progressJob.metadataKey = null;
  exportInProgress.exportSnapshots = [];
  assert.equal(
    normalizeComputeOptimizerOrganizationCapture(
      exportInProgress,
      boundary,
      NOW,
    ).configurationState,
    "EXPORT_IN_PROGRESS",
  );

  const exportFailed = mutable(capture());
  const failedJob =
    exportFailed.exportJobSequences[0]!.pages[0]!.response.records[0]!;
  failedJob.status = "FAILED";
  failedJob.bucket = null;
  failedJob.objectKey = null;
  failedJob.metadataKey = null;
  failedJob.failureCode = "ACCESS_DENIED";
  exportFailed.exportSnapshots = [];
  assert.equal(
    normalizeComputeOptimizerOrganizationCapture(
      exportFailed,
      boundary,
      NOW,
    ).configurationState,
    "EXPORT_FAILED",
  );
});

test("query service derives all scope from server configuration", async () => {
  const requests: ComputeOptimizerBrokerRequest[] = [];
  const service = createComputeOptimizerQueryService(boundary, {
    async collect(request) {
      requests.push(request);
      return capture({ collectionId: request.collectionId });
    },
  }, {
    now: () => NOW,
    createCollectionId: () => COLLECTION_ID,
  });
  const result = await service.query({});
  assert.equal(result.managementAccountId, ACCOUNT_ID);
  assert.deepEqual(requests, [{
    tenantId: "org_alpha",
    customerId: "customer_alpha",
    connectionId: CONNECTION_ID,
    managementAccountId: ACCOUNT_ID,
    partition: "aws",
    regions: [REGION],
    collectionId: COLLECTION_ID,
    maximumConcurrency:
      COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumConcurrency,
  }]);
  await assert.rejects(
    service.query({ tenantId: "org_attacker" }),
    (error) =>
      error instanceof ComputeOptimizerQueryServiceError
      && error.code === "INVALID_QUERY",
  );
});

test("query service redacts transport/provider failures", async () => {
  const service = createComputeOptimizerQueryService(boundary, {
    async collect() {
      throw new Error("provider request id and temporary credential secret");
    },
  }, {
    now: () => NOW,
    createCollectionId: () => COLLECTION_ID,
  });
  await assert.rejects(
    service.query({}),
    (error) => {
      assert.ok(error instanceof ComputeOptimizerQueryServiceError);
      assert.equal(error.code, "COLLECTION_FAILED");
      assert.equal(error.message.includes("secret"), false);
      return true;
    },
  );
});

test("partial pagination remains partial and cannot be called complete", () => {
  const sequences = mutable(capture().recommendationSequences);
  sequences.pop();
  const snapshot = normalizeComputeOptimizerOrganizationCapture(capture({
    recommendationSequences: recommendationSequences(sequences),
  }), boundary, NOW);
  assert.equal(snapshot.evidence.currentCoverageComplete, false);
  assert.equal(snapshot.status, "PARTIAL");
  assert.equal(snapshot.configurationState, "COLLECTION_PARTIAL");
});

test("keeps currencies separate and counts only rank-one current AWS savings", () => {
  const sequences = mutable(capture().recommendationSequences);
  const ec2 = sequences.find((entry) =>
    entry.accountId === MEMBER_ACCOUNT_ID
    && entry.operation === "GET_EC2_INSTANCE_RECOMMENDATIONS"
  )!;
  ec2.pages[0]!.response.records = [
    mutable(recommendation()),
    mutable(recommendation({
      resourceArn:
        `arn:aws:ec2:${REGION}:${MEMBER_ACCOUNT_ID}:instance/i-eur0000000000000`,
      resourceId: "i-eur0000000000000",
      options: [{
        rank: 1,
        targetConfiguration: "m7g.medium",
        performanceRisk: 0,
        migrationEffort: "VERY_LOW",
        savings: {
          estimatedMonthlySavings: 15,
          percentage: 25,
          currency: "EUR",
          includesExistingDiscounts: true,
        },
      }],
    })),
  ];
  const dashboard = buildComputeOptimizerDashboard({
    snapshot: normalizeComputeOptimizerOrganizationCapture(
      capture({ recommendationSequences: recommendationSequences(sequences) }),
      boundary,
      NOW,
    ),
  });
  assert.deepEqual(dashboard.savingsByCurrency, {
    EUR: 15,
    USD: 42.5,
  });
});
