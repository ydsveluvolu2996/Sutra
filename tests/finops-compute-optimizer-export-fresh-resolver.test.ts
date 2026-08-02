import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type {
  StoredComputeOptimizerFinalizedExportEvidence,
} from "../db/finops-compute-optimizer-discovery-repository.ts";
import {
  COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS,
  ComputeOptimizerExportFreshResolverError,
  resolveFreshComputeOptimizerExportBinding,
  type ComputeOptimizerExportDescribeJob,
  type ComputeOptimizerExportDescribePage,
  type ComputeOptimizerExportDescribeReader,
  type ComputeOptimizerExportDescribeRequest,
} from "../lib/finops-compute-optimizer-export-fresh-resolver.ts";
import { COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG } from "../lib/finops-compute-optimizer-export-field-catalog.ts";
import {
  createComputeOptimizerExportPlan,
  type ComputeOptimizerExportPlan,
  type ComputeOptimizerExportPlanTarget,
} from "../lib/finops-compute-optimizer-export-plan.ts";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");
const ACCOUNT = "111122223333";
const REGION = "us-east-1";
const CONNECTION = `conn_${"a".repeat(32)}`;
const SCOPE = {
  orgId: "org_fresh_resolver",
  customerId: "customer_fresh_resolver",
  connectionId: CONNECTION,
};
const FAMILIES = ["EC2_INSTANCE", "RDS_DATABASE"] as const;

const OPERATION = {
  EC2_INSTANCE: "ExportEC2InstanceRecommendations",
  RDS_DATABASE: "ExportRDSDatabaseRecommendations",
} as const;

const RESOURCE_TYPE = {
  EC2_INSTANCE: "Ec2Instance",
  RDS_DATABASE: "RdsDBInstance",
} as const;

function target(exportFamily: (typeof FAMILIES)[number]) {
  const bucket = "sutra-fresh-export";
  const effectivePrefix = `compute-optimizer/${ACCOUNT}/`;
  const jobId = `job-${exportFamily.toLowerCase().replaceAll("_", "-")}`;
  const objectKey = `${effectivePrefix}${REGION}-2026-08-02T000000Z-${jobId}.csv`;
  return {
    region: REGION,
    exportFamily,
    bucket,
    optionalPrefix: null,
    effectivePrefix,
    request: {
      operation: OPERATION[exportFamily],
      region: REGION,
      fileFormat: "Csv" as const,
      includeMemberAccounts: true as const,
      filters: [] as const,
      fieldsToExport:
        COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG[exportFamily].minimumProjection,
      s3DestinationConfig: { bucket, keyPrefix: null },
    },
    expectedJob: {
      jobId,
      providerResourceType: RESOURCE_TYPE[exportFamily],
      bucket,
      objectKey,
      metadataKey: `${objectKey.slice(0, -4)}-metadata.json`,
    },
  };
}

async function plan(): Promise<ComputeOptimizerExportPlan> {
  return createComputeOptimizerExportPlan({
    scope: SCOPE,
    requesterAccountId: ACCOUNT,
    partition: "aws",
    regions: [REGION],
    exportFamilies: FAMILIES,
    targets: FAMILIES.map(target),
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function evidenceJob(targetValue: ComputeOptimizerExportPlanTarget) {
  return {
    jobId: targetValue.expectedJob.jobId,
    resourceType: targetValue.expectedJob.providerResourceType,
    status: "COMPLETE" as const,
    createdAt: "2026-08-01T00:00:00.000Z",
    lastUpdatedAt: "2026-08-01T01:00:00.000Z",
    failureCode: null,
    destination: {
      bucketSha256: hash(targetValue.expectedJob.bucket),
      objectKeySha256: hash(targetValue.expectedJob.objectKey),
      metadataKeySha256: hash(targetValue.expectedJob.metadataKey),
    },
  };
}

function evidence(
  value: ComputeOptimizerExportPlan,
  jobs = value.targets.map(evidenceJob),
): StoredComputeOptimizerFinalizedExportEvidence {
  return {
    run: {
      scope: {
        organizationId: SCOPE.orgId,
        customerId: SCOPE.customerId,
        connectionId: SCOPE.connectionId,
      },
      runId: `cor_${"c".repeat(64)}`,
      jobId: "fresh-resolver-discovery",
      status: "partial",
      contentSha256: "d".repeat(64),
      collectedAt: "2026-08-02T10:00:00.000Z",
      dataThroughAt: "2026-08-02T09:00:00.000Z",
      accountId: ACCOUNT,
      partition: "aws",
      region: REGION,
      memberCount: 0,
      exportJobCount: jobs.length,
      coverageCount: 1,
      errorCode: "EXPORT_OBJECT_BINDING_REQUIRED",
      limitations: ["EXPORT_OBJECT_BINDING_REQUIRED"],
      createdAtIso: "2026-08-02T09:00:00.000Z",
      startedAtIso: "2026-08-02T09:01:00.000Z",
      finalizedAtIso: "2026-08-02T10:00:00.000Z",
    },
    exportJobs: jobs,
  };
}

function describeJob(
  targetValue: ComputeOptimizerExportPlanTarget,
  overrides: Partial<ComputeOptimizerExportDescribeJob> = {},
): ComputeOptimizerExportDescribeJob {
  return {
    jobId: targetValue.expectedJob.jobId,
    resourceType: targetValue.expectedJob.providerResourceType,
    status: "Complete",
    creationTimestamp: new Date(NOW - 24 * 60 * 60 * 1_000),
    lastUpdatedTimestamp: "2026-08-02T11:00:00.000Z",
    destination: {
      s3: {
        bucket: targetValue.expectedJob.bucket,
        key: targetValue.expectedJob.objectKey,
        metadataKey: targetValue.expectedJob.metadataKey,
      },
    },
    ...overrides,
  };
}

function readerFor(
  pages: readonly ComputeOptimizerExportDescribePage[],
  calls: ComputeOptimizerExportDescribeRequest[] = [],
): ComputeOptimizerExportDescribeReader {
  let index = 0;
  return async (request) => {
    calls.push(request);
    const page = pages[index];
    index += 1;
    if (page === undefined) throw new Error("raw provider failure must not escape");
    return page;
  };
}

async function rejects(
  promise: Promise<unknown>,
  code: ComputeOptimizerExportFreshResolverError["code"],
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ComputeOptimizerExportFreshResolverError
      && error.code === code
      && error.message === "Compute Optimizer export freshness resolution rejected"
      && !/sutra-fresh-export|compute-optimizer\/111122223333/u.test(error.message),
  );
}

test("describes every sealed ID without filters and returns only a short-lived frozen binding", async () => {
  const value = await plan();
  const calls: ComputeOptimizerExportDescribeRequest[] = [];
  const unrelated = {
    jobId: "unrelated-seven-day-job",
    resourceType: "NotApplicable",
    status: "Failed",
  };
  const result = await resolveFreshComputeOptimizerExportBinding(
    value,
    evidence(value, [
      ...value.targets.map(evidenceJob),
      {
        ...evidenceJob(value.targets[0]!),
        jobId: "unrelated-discovery-job",
      },
    ]),
    readerFor([{ recommendationExportJobs: [
      describeJob(value.targets[1]!),
      unrelated,
    ], nextToken: "page-two" }, {
      recommendationExportJobs: [describeJob(value.targets[0]!)],
      nextToken: null,
    }], calls),
    { now: () => NOW },
  );

  const expectedIds = value.targets
    .map(({ expectedJob }) => expectedJob.jobId)
    .sort((left, right) => left.localeCompare(right));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ jobIds }) => jobIds), [expectedIds, expectedIds]);
  assert.equal(calls.every((request) => !Object.hasOwn(request, "filters")), true);
  assert.equal(calls[0]?.nextToken, undefined);
  assert.equal(calls[1]?.nextToken, "page-two");
  assert.equal(
    calls.every(({ maxResults }) => maxResults
      === COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS.maximumResultsPerPage),
    true,
  );
  assert.equal(result.resolvedAtIso, new Date(NOW).toISOString());
  assert.equal(
    result.expiresAtIso,
    new Date(NOW + COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS.maximumBindingLifetimeMs)
      .toISOString(),
  );
  assert.deepEqual(
    result.binding.targets.map(({ jobId }) => jobId),
    value.targets.map(({ expectedJob }) => expectedJob.jobId),
  );
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.binding), true);
  assert.equal(Object.isFrozen(result.binding.targets[0]), true);
  assert.doesNotMatch(JSON.stringify(result), /unrelated-seven-day-job/u);
});

test("finalized hashed evidence must bind every planned job exactly once", async () => {
  const value = await plan();
  const never: ComputeOptimizerExportDescribeReader = async () => {
    throw new Error("reader must not be called");
  };
  await rejects(
    resolveFreshComputeOptimizerExportBinding(
      value,
      evidence(value, [evidenceJob(value.targets[0]!)]),
      never,
      { now: () => NOW },
    ),
    "MISSING_JOB",
  );
  await rejects(
    resolveFreshComputeOptimizerExportBinding(
      value,
      evidence(value, [
        ...value.targets.map(evidenceJob),
        evidenceJob(value.targets[0]!),
      ]),
      never,
      { now: () => NOW },
    ),
    "DUPLICATE_JOB",
  );
  const substituted = value.targets.map(evidenceJob);
  substituted[0] = {
    ...substituted[0]!,
    destination: {
      ...substituted[0]!.destination,
      bucketSha256: "f".repeat(64),
    },
  };
  await rejects(
    resolveFreshComputeOptimizerExportBinding(
      value,
      evidence(value, substituted),
      never,
      { now: () => NOW },
    ),
    "EVIDENCE_MISMATCH",
  );
});

test("planned Describe rows reject substitution, duplicates, missing jobs, and token cycles", async () => {
  const value = await plan();
  const stored = evidence(value);
  await rejects(resolveFreshComputeOptimizerExportBinding(
    value,
    stored,
    readerFor([{ recommendationExportJobs: [
      describeJob(value.targets[0]!, { resourceType: "AutoScalingGroup" }),
      describeJob(value.targets[1]!),
    ] }]),
    { now: () => NOW },
  ), "JOB_SUBSTITUTION");

  await rejects(resolveFreshComputeOptimizerExportBinding(
    value,
    stored,
    readerFor([{ recommendationExportJobs: [
      ...value.targets.map((entry) => describeJob(entry)),
      describeJob(value.targets[0]!),
    ] }]),
    { now: () => NOW },
  ), "DUPLICATE_JOB");

  await rejects(resolveFreshComputeOptimizerExportBinding(
    value,
    stored,
    readerFor([{ recommendationExportJobs: [describeJob(value.targets[0]!)] }]),
    { now: () => NOW },
  ), "MISSING_JOB");

  await rejects(resolveFreshComputeOptimizerExportBinding(
    value,
    stored,
    readerFor([{ recommendationExportJobs: [], nextToken: "repeat" }, {
      recommendationExportJobs: [], nextToken: "repeat",
    }]),
    { now: () => NOW },
  ), "PAGINATION_INVALID");

  await rejects(resolveFreshComputeOptimizerExportBinding(
    value,
    stored,
    readerFor([{ recommendationExportJobs: [], nextToken: "extra-page" }]),
    { now: () => NOW, limits: { maximumPages: 1 } },
  ), "PAGINATION_INVALID");
});

test("canonical timestamps enforce the seven-day safety window and bounded clock skew", async () => {
  const value = await plan();
  const stored = evidence(value);
  const goodOther = describeJob(value.targets[1]!);
  const safety = COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS
    .minimumVisibilityRemainingMs;
  const almostExpired = new Date(
    NOW - COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS.describeVisibilityMs
      + safety,
  ).toISOString();
  await rejects(resolveFreshComputeOptimizerExportBinding(
    value,
    stored,
    readerFor([{ recommendationExportJobs: [
      describeJob(value.targets[0]!, {
        creationTimestamp: almostExpired,
        lastUpdatedTimestamp: almostExpired,
      }),
      goodOther,
    ] }]),
    { now: () => NOW },
  ), "EXPIRED");

  await rejects(resolveFreshComputeOptimizerExportBinding(
    value,
    stored,
    readerFor([{ recommendationExportJobs: [
      describeJob(value.targets[0]!, {
        creationTimestamp: "2026-08-02 10:00:00Z",
      }),
      goodOther,
    ] }]),
    { now: () => NOW },
  ), "PROVIDER_RESPONSE_INVALID");

  await rejects(resolveFreshComputeOptimizerExportBinding(
    value,
    stored,
    readerFor([{ recommendationExportJobs: [
      describeJob(value.targets[0]!, {
        creationTimestamp: "2026-08-02T11:00:00.000Z",
        lastUpdatedTimestamp: "2026-08-02T10:00:00.000Z",
      }),
      goodOther,
    ] }]),
    { now: () => NOW },
  ), "PROVIDER_RESPONSE_INVALID");

  const tooFuture = new Date(
    NOW + COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS.maximumClockSkewMs + 1,
  ).toISOString();
  await rejects(resolveFreshComputeOptimizerExportBinding(
    value,
    stored,
    readerFor([{ recommendationExportJobs: [
      describeJob(value.targets[0]!, { lastUpdatedTimestamp: tooFuture }),
      goodOther,
    ] }]),
    { now: () => NOW },
  ), "PROVIDER_RESPONSE_INVALID");
});

test("abort and deadline hard-race readers that ignore their AbortSignal", async () => {
  const value = await plan();
  const stored = evidence(value);
  const ignoringReader: ComputeOptimizerExportDescribeReader = async () =>
    new Promise<ComputeOptimizerExportDescribePage>(() => undefined);

  const controller = new AbortController();
  const aborted = resolveFreshComputeOptimizerExportBinding(
    value,
    stored,
    ignoringReader,
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 10);
  await rejects(aborted, "ABORTED");

  await rejects(resolveFreshComputeOptimizerExportBinding(
    value,
    stored,
    ignoringReader,
    { deadlineAtMs: Date.now() + 10 },
  ), "DEADLINE_EXCEEDED");

  const failed: ComputeOptimizerExportDescribeReader = async () => {
    throw new Error("s3://sutra-fresh-export/compute-optimizer/111122223333/raw.csv");
  };
  await rejects(resolveFreshComputeOptimizerExportBinding(
    value,
    stored,
    failed,
  ), "READ_FAILED");

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await rejects(resolveFreshComputeOptimizerExportBinding(
    value,
    stored,
    ignoringReader,
    { signal: alreadyAborted.signal },
  ), "ABORTED");
});

test("a forged plan is rejected before credentials are used", async () => {
  const value = await plan();
  const forged = structuredClone(value) as ComputeOptimizerExportPlan;
  (forged as unknown as { contentSha256: string }).contentSha256 = "f".repeat(64);
  let calls = 0;
  await rejects(resolveFreshComputeOptimizerExportBinding(
    forged,
    evidence(value),
    async () => {
      calls += 1;
      return { recommendationExportJobs: [] };
    },
    { now: () => NOW },
  ), "INVALID_INPUT");
  assert.equal(calls, 0);
});
