import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DescribeRecommendationExportJobsRequest,
  RecommendationExportJob,
} from "@aws-sdk/client-compute-optimizer";

import {
  ComputeOptimizerExactDescribeError,
  describeComputeOptimizerExactExportJobs,
  parseComputeOptimizerExactDescribeRequest,
  type ComputeOptimizerExactDescribePlannedJob,
  type ComputeOptimizerExactDescribeReader,
  type ComputeOptimizerExactDescribeRequest,
} from "../src/compute-optimizer-export-exact-describe.js";
import type { AwsTemporaryCredentials } from "../src/types.js";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const CONNECTION = `conn_${"a".repeat(32)}`;
const TYPES = [
  ["EC2_INSTANCE", "Ec2Instance"],
  ["AUTO_SCALING_GROUP", "AutoScalingGroup"],
  ["EBS_VOLUME", "EbsVolume"],
  ["LAMBDA_FUNCTION", "LambdaFunction"],
  ["ECS_SERVICE", "EcsService"],
  ["LICENSE", "License"],
  ["RDS_DATABASE", "RdsDBInstance"],
  ["IDLE_RESOURCE", "Idle"],
] as const;

const CREDENTIALS: AwsTemporaryCredentials = {
  accessKeyId: "ASIAEXACTDESCRIBE",
  secretAccessKey: "never-return-describe-secret",
  sessionToken: "never-return-describe-token",
  expiration: new Date("2099-01-01T00:00:00.000Z"),
};

function plannedJobs(): ComputeOptimizerExactDescribePlannedJob[] {
  return TYPES.map(([exportFamily, providerResourceType], index) => {
    const plannedJobId = `provider-job-${index + 1}`;
    const objectKey = `compute-optimizer/123456789012/us-east-1-2026-08-02T000000Z-${plannedJobId}.csv`;
    return {
      targetId: `coelt_${(index + 1).toString(16).repeat(64)}`,
      plannedJobId,
      exportFamily,
      providerResourceType,
      requestSha256: ((index + 9) % 16).toString(16).repeat(64),
      bucket: "customer-compute-optimizer-use1",
      objectKey,
      metadataKey: `${objectKey.slice(0, -4)}-metadata.json`,
    };
  });
}

function request(jobs = plannedJobs()): ComputeOptimizerExactDescribeRequest {
  return {
    schema: "sutra.compute-optimizer-export-exact-describe-request.v1",
    tenantId: "tenant-exact-describe",
    connectionId: CONNECTION,
    collectionJobId: "materialize-exact-describe",
    contractId: "compute-optimizer-export-describe-v1",
    accountId: "123456789012",
    partition: "aws",
    region: "us-east-1",
    plannedJobs: jobs,
  };
}

function providerJob(
  planned: ComputeOptimizerExactDescribePlannedJob,
  overrides: Partial<RecommendationExportJob> = {},
): RecommendationExportJob {
  return {
    jobId: planned.plannedJobId,
    resourceType: planned.providerResourceType,
    status: "Complete",
    creationTimestamp: new Date("2026-08-01T12:00:00.000Z"),
    lastUpdatedTimestamp: new Date("2026-08-01T12:30:00.000Z"),
    destination: { s3: {
      bucket: planned.bucket,
      key: planned.objectKey,
      metadataKey: planned.metadataKey,
    } },
    ...overrides,
  };
}

function reader(
  operation: ComputeOptimizerExactDescribeReader["describeRecommendationExportJobs"],
): ComputeOptimizerExactDescribeReader {
  return { describeRecommendationExportJobs: operation };
}

function code(expected: ComputeOptimizerExactDescribeError["code"]):
(error: unknown) => boolean {
  return (error) => error instanceof ComputeOptimizerExactDescribeError
    && error.code === expected;
}

test("parser seals canonical tenant, connection, partition, target and object scope", () => {
  const value = request();
  assert.deepEqual(
    parseComputeOptimizerExactDescribeRequest(JSON.stringify(value), CONNECTION),
    value,
  );
  const first = value.plannedJobs[0]!;
  for (const candidate of [
    { ...value, connectionId: `conn_${"b".repeat(32)}` },
    { ...value, connectionId: "connection-not-canonical" },
    { ...value, partition: "aws-cn" },
    { ...value, credentials: CREDENTIALS },
    { ...value, plannedJobs: [{ ...first, targetId: "target-1" }] },
    { ...value, plannedJobs: [{ ...first, objectKey: first.objectKey.replace("us-east-1", "us-west-2") }] },
    { ...value, plannedJobs: [{ ...first, metadataKey: "neighbor-metadata.json" }] },
    { ...value, plannedJobs: [{ ...first, objectKey: `${first.objectKey}/../neighbor.csv` }] },
    { ...value, plannedJobs: [first, first] },
  ]) assert.throws(
    () => parseComputeOptimizerExactDescribeRequest(JSON.stringify(candidate), CONNECTION),
    code("INVALID_REQUEST"),
  );
});

test("requests only all eight exact IDs, exhausts bounded pages, and returns ordered safe bindings", async () => {
  const value = request();
  const inputs: DescribeRecommendationExportJobsRequest[] = [];
  const signals: AbortSignal[] = [];
  const firstPage = value.plannedJobs.slice(0, 4).map((job) => providerJob(job));
  const secondPage = value.plannedJobs.slice(4).map((job) => providerJob(job));
  const result = await describeComputeOptimizerExactExportJobs(value, CREDENTIALS, {
    now: () => NOW,
    reader: reader(async (input, signal) => {
      inputs.push(input);
      signals.push(signal);
      return input.nextToken === undefined
        ? { recommendationExportJobs: firstPage, nextToken: "page-2" }
        : { recommendationExportJobs: secondPage };
    }),
  });
  const exactIds = value.plannedJobs.map(({ plannedJobId }) => plannedJobId).sort();
  assert.deepEqual(inputs, [
    { jobIds: exactIds, maxResults: 1_000 },
    { jobIds: exactIds, maxResults: 1_000, nextToken: "page-2" },
  ]);
  assert.equal(signals.every((signal) => signal instanceof AbortSignal), true);
  assert.deepEqual(result.jobs.map(({ targetId, jobId }) => [targetId, jobId]),
    value.plannedJobs.map(({ targetId, plannedJobId }) => [targetId, plannedJobId]));
  assert.equal(result.jobs.every(({ status }) => status === "COMPLETE"), true);
  assert.equal(result.observedAtIso, NOW.toISOString());
  const serialized = JSON.stringify(result);
  for (const secret of Object.values(CREDENTIALS)) {
    if (typeof secret === "string") assert.equal(serialized.includes(secret), false);
  }
  assert.equal(serialized.includes("filters"), false);
  assert.equal(serialized.includes("failureReason"), false);
});

test("RDS binding admits both documented provider job types without inference", async () => {
  const rds = plannedJobs().find(({ exportFamily }) => exportFamily === "RDS_DATABASE")!;
  for (const resourceType of ["RdsDBInstance", "AuroraDBClusterStorage"] as const) {
    const result = await describeComputeOptimizerExactExportJobs(
      request([rds]),
      CREDENTIALS,
      {
        now: () => NOW,
        reader: reader(async () => ({
          recommendationExportJobs: [providerJob(rds, { resourceType })],
        })),
      },
    );
    assert.equal(result.jobs[0]?.providerResourceType, resourceType);
  }
});

test("rejects token replay, duplicate, omission, and extra IDs", async () => {
  const value = request([plannedJobs()[0]!, plannedJobs()[1]!]);
  const first = providerJob(value.plannedJobs[0]!);
  const second = providerJob(value.plannedJobs[1]!);
  const outsider = { ...second, jobId: "unplanned-job" };
  const cases: readonly [ComputeOptimizerExactDescribeReader, string][] = [
    [reader(async () => ({ recommendationExportJobs: [first], nextToken: "again" })),
      "PAGINATION_INVALID"],
    [reader(async () => ({ recommendationExportJobs: [first, first] })),
      "DUPLICATE_JOB"],
    [reader(async () => ({ recommendationExportJobs: [first] })), "MISSING_JOB"],
    [reader(async () => ({ recommendationExportJobs: [first, outsider] })),
      "JOB_SUBSTITUTION"],
  ];
  for (const [source, expected] of cases) {
    if (expected === "PAGINATION_INVALID") {
      let count = 0;
      source.describeRecommendationExportJobs = async () => {
        count += 1;
        return { recommendationExportJobs: count === 1 ? [first] : [second], nextToken: "again" };
      };
    }
    await assert.rejects(
      describeComputeOptimizerExactExportJobs(value, CREDENTIALS, {
        now: () => NOW, reader: source,
      }),
      code(expected as ComputeOptimizerExactDescribeError["code"]),
    );
  }
});

test("rejects status, destination, type, chronology, stale and raw-message substitution", async () => {
  const planned = plannedJobs()[0]!;
  const cases: readonly [Partial<RecommendationExportJob>, string][] = [
    [{ status: "InProgress" }, "JOB_SUBSTITUTION"],
    [{ resourceType: "EbsVolume" }, "JOB_SUBSTITUTION"],
    [{ destination: { s3: { bucket: "neighbor-bucket", key: planned.objectKey,
      metadataKey: planned.metadataKey } } }, "JOB_SUBSTITUTION"],
    [{ lastUpdatedTimestamp: new Date("2026-07-31T00:00:00.000Z") },
      "PROVIDER_RESPONSE_INVALID"],
    [{ creationTimestamp: new Date("2026-07-20T00:00:00.000Z") }, "EXPIRED"],
    [{ creationTimestamp: new Date("invalid") }, "PROVIDER_RESPONSE_INVALID"],
    [{ failureReason: "provider secret stack and account details" }, "JOB_SUBSTITUTION"],
  ];
  for (const [overrides, expected] of cases) {
    await assert.rejects(
      describeComputeOptimizerExactExportJobs(request([planned]), CREDENTIALS, {
        now: () => NOW,
        reader: reader(async () => ({
          recommendationExportJobs: [providerJob(planned, overrides)],
        })),
      }),
      code(expected as ComputeOptimizerExactDescribeError["code"]),
    );
  }
});

test("hard overall deadline and external abort stop uncooperative provider reads", async () => {
  const value = request([plannedJobs()[0]!]);
  let timeoutSignal: AbortSignal | undefined;
  const stalled = reader(async (_input, signal) => {
    timeoutSignal = signal;
    return new Promise(() => undefined);
  });
  await assert.rejects(
    describeComputeOptimizerExactExportJobs(value, CREDENTIALS, {
      now: () => NOW, reader: stalled, overallDeadlineMs: 5, commandDeadlineMs: 10,
    }),
    code("DESCRIBE_TIMEOUT"),
  );
  assert.equal(timeoutSignal?.aborted, true);

  const controller = new AbortController();
  let abortSignal: AbortSignal | undefined;
  const aborted = describeComputeOptimizerExactExportJobs(value, CREDENTIALS, {
    now: () => NOW,
    reader: reader(async (_input, signal) => {
      abortSignal = signal;
      return new Promise(() => undefined);
    }),
    abortSignal: controller.signal,
  });
  controller.abort();
  await assert.rejects(aborted, code("ABORTED"));
  assert.equal(abortSignal?.aborted ?? controller.signal.aborted, true);
});

test("provider exceptions are reduced to a stable public error without raw messages", async () => {
  const raw = "AccessDenied for arn:aws:iam::123456789012:role/private-role secret=abc";
  await assert.rejects(
    describeComputeOptimizerExactExportJobs(request([plannedJobs()[0]!]), CREDENTIALS, {
      now: () => NOW,
      reader: reader(async () => { throw new Error(raw); }),
    }),
    (error: unknown) => error instanceof ComputeOptimizerExactDescribeError
      && error.code === "DESCRIBE_FAILED"
      && !error.message.includes(raw),
  );
});
