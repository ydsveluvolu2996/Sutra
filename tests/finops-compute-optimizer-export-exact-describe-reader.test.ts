import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ComputeOptimizerExactDescribeReaderError,
  createComputeOptimizerExactDescribeReader,
  type ComputeOptimizerExactDescribeTransport,
} from "../lib/finops-compute-optimizer-export-exact-describe-reader.ts";
import type {
  ComputeOptimizerExactDescribeRequest,
  ComputeOptimizerExactDescribeResponse,
} from "../services/aws-collector/src/compute-optimizer-export-exact-describe.ts";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");
const CONNECTION = `conn_${"a".repeat(32)}`;

function boundary(): ComputeOptimizerExactDescribeRequest {
  const jobs = [
    ["coelt_" + "1".repeat(64), "job-ec2", "EC2_INSTANCE", "Ec2Instance", "a"],
    ["coelt_" + "2".repeat(64), "job-rds", "RDS_DATABASE", "RdsDBInstance", "b"],
  ] as const;
  return {
    schema: "sutra.compute-optimizer-export-exact-describe-request.v1",
    tenantId: "tenant-exact-reader",
    connectionId: CONNECTION,
    collectionJobId: "fresh-read-job",
    contractId: "compute-optimizer-export-describe-v1",
    accountId: "123456789012",
    partition: "aws",
    region: "us-east-1",
    plannedJobs: jobs.map(([targetId, plannedJobId, exportFamily,
      providerResourceType, hash]) => {
      const objectKey = `compute-optimizer/123456789012/us-east-1-2026-08-02T000000Z-${plannedJobId}.csv`;
      return {
        targetId,
        plannedJobId,
        exportFamily,
        providerResourceType,
        requestSha256: hash.repeat(64),
        bucket: "customer-compute-optimizer-use1",
        objectKey,
        metadataKey: `${objectKey.slice(0, -4)}-metadata.json`,
      };
    }),
  };
}

function response(
  request = boundary(),
): ComputeOptimizerExactDescribeResponse {
  return {
    schema: "sutra.compute-optimizer-export-exact-describe-response.v1",
    tenantId: request.tenantId,
    connectionId: request.connectionId,
    collectionJobId: request.collectionJobId,
    contractId: request.contractId,
    accountId: request.accountId,
    partition: request.partition,
    region: request.region,
    observedAtIso: new Date(NOW).toISOString(),
    jobs: request.plannedJobs.map((job) => ({
      ...job,
      jobId: job.plannedJobId,
      status: "COMPLETE",
      creationTimestampIso: "2026-08-01T12:00:00.000Z",
      lastUpdatedTimestampIso: "2026-08-01T12:30:00.000Z",
      destination: {
        bucket: job.bucket,
        objectKey: job.objectKey,
        metadataKey: job.metadataKey,
      },
    })),
  };
}

function expectedFreshRequest(request = boundary()) {
  return {
    region: request.region,
    jobIds: request.plannedJobs.map(({ plannedJobId }) => plannedJobId).sort(),
    maxResults: 1_000,
  };
}

function code(expected: ComputeOptimizerExactDescribeReaderError["code"]):
(error: unknown) => boolean {
  return (error) => error instanceof ComputeOptimizerExactDescribeReaderError
    && error.code === expected;
}

test("authenticated transport response becomes exact provider-shaped fresh evidence", async () => {
  const fixed = boundary();
  const calls: unknown[] = [];
  let signedResponseVerified = false;
  const transport: ComputeOptimizerExactDescribeTransport = {
    describeExact: async (request, context) => {
      calls.push({ request, context });
      // The pilot transport performs signature verification before resolving.
      signedResponseVerified = true;
      return response(fixed);
    },
  };
  const reader = createComputeOptimizerExactDescribeReader(fixed, transport, {
    now: () => NOW,
  });
  const page = await reader(expectedFreshRequest(fixed), new AbortController().signal);
  assert.equal(signedResponseVerified, true);
  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0] as { request: unknown }).request, fixed);
  assert.deepEqual(page, {
    recommendationExportJobs: response(fixed).jobs.map((job) => ({
      jobId: job.jobId,
      resourceType: job.providerResourceType,
      status: "Complete",
      creationTimestamp: job.creationTimestampIso,
      lastUpdatedTimestamp: job.lastUpdatedTimestampIso,
      destination: { s3: {
        bucket: job.bucket,
        key: job.objectKey,
        metadataKey: job.metadataKey,
      } },
    })),
  });
});

test("actual RDS provider type is preserved for the plan adapter and fresh resolver", async () => {
  const fixed = boundary();
  const original = response(fixed);
  const value: ComputeOptimizerExactDescribeResponse = {
    ...original,
    jobs: original.jobs.map((job, index) => index === 1 ? {
      ...job,
      providerResourceType: "AuroraDBClusterStorage",
    } : job),
  };
  const reader = createComputeOptimizerExactDescribeReader(fixed, {
    describeExact: async () => value,
  }, { now: () => NOW });
  const page = await reader(expectedFreshRequest(fixed), new AbortController().signal);
  assert.equal(page.recommendationExportJobs?.[1]?.resourceType,
    "AuroraDBClusterStorage");
});

test("reader rejects caller widening, pagination, replay and a second transport use", async () => {
  const fixed = boundary();
  const invalid = [
    { ...expectedFreshRequest(fixed), region: "us-west-2" },
    { ...expectedFreshRequest(fixed), jobIds: ["job-ec2"] },
    { ...expectedFreshRequest(fixed), jobIds: ["job-ec2", "neighbor"] },
    { ...expectedFreshRequest(fixed), nextToken: "caller-token" },
    { ...expectedFreshRequest(fixed), resourceTypes: ["Ec2Instance"] },
    { ...expectedFreshRequest(fixed), filters: [] },
  ];
  for (const request of invalid) {
    const reader = createComputeOptimizerExactDescribeReader(fixed, {
      describeExact: async () => response(fixed),
    }, { now: () => NOW });
    await assert.rejects(
      reader(request, new AbortController().signal),
      code("INVALID_FRESH_REQUEST"),
    );
  }
  const reader = createComputeOptimizerExactDescribeReader(fixed, {
    describeExact: async () => response(fixed),
  }, { now: () => NOW });
  await reader(expectedFreshRequest(fixed), new AbortController().signal);
  await assert.rejects(
    reader(expectedFreshRequest(fixed), new AbortController().signal),
    code("INVALID_FRESH_REQUEST"),
  );
});

test("response validator rejects scope, job, destination, chronology and unsafe-key substitution", async () => {
  const fixed = boundary();
  const base = response(fixed);
  const cases: unknown[] = [
    { ...base, tenantId: "neighbor-tenant" },
    { ...base, connectionId: `conn_${"b".repeat(32)}` },
    { ...base, jobs: [...base.jobs].reverse() },
    { ...base, jobs: base.jobs.map((job, index) => index === 0
      ? { ...job, jobId: "neighbor-job" }
      : job) },
    { ...base, jobs: base.jobs.map((job, index) => index === 0
      ? { ...job, destination: { ...job.destination, bucket: "neighbor-bucket" } }
      : job) },
    { ...base, jobs: base.jobs.map((job, index) => index === 0
      ? { ...job, lastUpdatedTimestampIso: "2026-07-01T00:00:00.000Z" }
      : job) },
    { ...base, credentials: { accessKeyId: "must-not-cross" } },
  ];
  for (const candidate of cases) {
    const reader = createComputeOptimizerExactDescribeReader(fixed, {
      describeExact: async () => candidate,
    }, { now: () => NOW });
    await assert.rejects(
      reader(expectedFreshRequest(fixed), new AbortController().signal),
      (error: unknown) => error instanceof ComputeOptimizerExactDescribeReaderError
        && (error.code === "BROKER_RESPONSE_INVALID"
          || error.code === "JOB_SUBSTITUTION"),
    );
  }
});

test("hard deadline and external abort stop an uncooperative authenticated transport", async () => {
  const fixed = boundary();
  let timeoutSignal: AbortSignal | undefined;
  const timed = createComputeOptimizerExactDescribeReader(fixed, {
    describeExact: async (_request, context) => {
      timeoutSignal = context.signal;
      return new Promise(() => undefined);
    },
  }, { now: () => NOW, deadlineAtMs: NOW + 5 });
  await assert.rejects(
    timed(expectedFreshRequest(fixed), new AbortController().signal),
    code("DEADLINE_EXCEEDED"),
  );
  assert.equal(timeoutSignal?.aborted, true);

  let abortSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const abortedReader = createComputeOptimizerExactDescribeReader(fixed, {
    describeExact: async (_request, context) => {
      abortSignal = context.signal;
      return new Promise(() => undefined);
    },
  }, { now: () => NOW });
  const pending = abortedReader(expectedFreshRequest(fixed), controller.signal);
  controller.abort();
  await assert.rejects(pending, code("ABORTED"));
  assert.equal(abortSignal?.aborted ?? controller.signal.aborted, true);
});

test("transport failures expose only the stable app-side error", async () => {
  const raw = "signature key secret and broker internal stack";
  const fixed = boundary();
  const reader = createComputeOptimizerExactDescribeReader(fixed, {
    describeExact: async () => { throw new Error(raw); },
  }, { now: () => NOW });
  await assert.rejects(
    reader(expectedFreshRequest(fixed), new AbortController().signal),
    (error: unknown) => error instanceof ComputeOptimizerExactDescribeReaderError
      && error.code === "TRANSPORT_FAILED"
      && !error.message.includes(raw),
  );
});
