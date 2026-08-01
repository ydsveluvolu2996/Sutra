import assert from "node:assert/strict";
import test from "node:test";

import type {
  AccountEnrollmentStatus,
  RecommendationExportJob,
} from "@aws-sdk/client-compute-optimizer";

import {
  collectComputeOptimizerExportDiscovery,
  COMPUTE_OPTIMIZER_EXPORT_DISCOVERY_OPERATIONS,
  computeOptimizerEndpoint,
  type ComputeOptimizerExportDiscoveryReader,
} from "../src/compute-optimizer-export-runner.js";

const NOW = new Date("2026-08-01T12:00:00.000Z");
const ACCOUNT_ID = "123456789012";
const credentials = {
  accessKeyId: "ASIAEXAMPLE00000000",
  secretAccessKey: "not-a-real-secret",
  sessionToken: "not-a-real-session",
  expiration: new Date("2026-08-01T13:00:00.000Z"),
};

function member(accountId: string): AccountEnrollmentStatus {
  return {
    accountId,
    status: "Active",
    statusReason: "Success",
    lastUpdatedTimestamp: new Date("2026-08-01T09:00:00.000Z"),
  };
}

function job(jobId: string): RecommendationExportJob {
  return {
    jobId,
    resourceType: "Ec2Instance",
    status: "Complete",
    creationTimestamp: new Date("2026-08-01T10:00:00.000Z"),
    lastUpdatedTimestamp: new Date("2026-08-01T11:00:00.000Z"),
    destination: {
      s3: {
        bucket: "private-compute-optimizer-export",
        key: `private-prefix/${jobId}.csv`,
        metadataKey: `private-prefix/${jobId}-metadata.json`,
      },
    },
  };
}

function reader(
  overrides: Partial<ComputeOptimizerExportDiscoveryReader> = {},
): ComputeOptimizerExportDiscoveryReader {
  return {
    async getEnrollmentStatus() {
      return {
        status: "Active",
        statusReason: "Success",
        memberAccountsEnrolled: true,
        numberOfMemberAccountsOptedIn: 2,
        lastUpdatedTimestamp: new Date("2026-08-01T08:00:00.000Z"),
      };
    },
    async getEnrollmentStatusesForOrganization() {
      return { accountEnrollmentStatuses: [member("111122223333")] };
    },
    async describeRecommendationExportJobs() {
      return { recommendationExportJobs: [job("export-b"), job("export-a")] };
    },
    ...overrides,
  };
}

function options(client: ComputeOptimizerExportDiscoveryReader) {
  return {
    accountId: ACCOUNT_ID,
    partition: "aws" as const,
    region: "us-west-2",
    credentials,
    now: () => NOW,
    client,
  };
}

test("discovers organization enrollment and export jobs with fixed unfiltered inputs", async () => {
  const enrollmentInputs: unknown[] = [];
  const memberInputs: unknown[] = [];
  const jobInputs: unknown[] = [];
  const collection = await collectComputeOptimizerExportDiscovery(options(reader({
    async getEnrollmentStatus(input) {
      enrollmentInputs.push(input);
      return {
        status: "Active",
        memberAccountsEnrolled: true,
        numberOfMemberAccountsOptedIn: 1,
        lastUpdatedTimestamp: new Date("2026-08-01T08:00:00.000Z"),
      };
    },
    async getEnrollmentStatusesForOrganization(input) {
      memberInputs.push(input);
      return { accountEnrollmentStatuses: [member("111122223333")] };
    },
    async describeRecommendationExportJobs(input) {
      jobInputs.push(input);
      return { recommendationExportJobs: [job("export-b"), job("export-a")] };
    },
  })));

  assert.equal(collection.status, "PARTIAL");
  assert.deepEqual(enrollmentInputs, [{}]);
  assert.deepEqual(memberInputs, [{ maxResults: 100 }]);
  assert.deepEqual(jobInputs, [{ maxResults: 1_000 }]);
  assert.deepEqual(collection.exportJobs.map(({ jobId }) => jobId), ["export-a", "export-b"]);
  assert.deepEqual(
    collection.coverage.map(({ operation }) => operation),
    [
      "GET_ENROLLMENT_STATUS",
      "GET_ENROLLMENT_STATUSES_FOR_ORGANIZATION",
      "DESCRIBE_RECOMMENDATION_EXPORT_JOBS",
    ],
  );
  assert.deepEqual(COMPUTE_OPTIMIZER_EXPORT_DISCOVERY_OPERATIONS, [
    "compute-optimizer:GetEnrollmentStatus",
    "compute-optimizer:GetEnrollmentStatusesForOrganization",
    "compute-optimizer:DescribeRecommendationExportJobs",
  ]);
  const serialized = JSON.stringify(collection);
  assert.equal(serialized.includes("private-compute-optimizer-export"), false);
  assert.equal(serialized.includes("private-prefix"), false);
  assert.match(collection.exportJobs[0]?.destination.bucketSha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.ok(collection.limitations.includes("EXPORT_PROVISIONING_LEDGER_REQUIRED"));
  assert.ok(collection.limitations.includes("EXPORT_OBJECTS_NOT_READ_WITHOUT_ATTESTED_BUCKET_PREFIX"));
});

test("paginates with only provider tokens and fails partial on repetition and conflicting records", async () => {
  const inputs: unknown[] = [];
  let memberPage = 0;
  let jobPage = 0;
  const collection = await collectComputeOptimizerExportDiscovery(options(reader({
    async getEnrollmentStatusesForOrganization(input) {
      inputs.push(input);
      memberPage += 1;
      if (memberPage === 1) {
        return {
          accountEnrollmentStatuses: [member("111122223333")],
          nextToken: "member-page-2",
        };
      }
      return {
        accountEnrollmentStatuses: [{
          ...member("111122223333"),
          status: "Failed",
        }],
        nextToken: "member-page-2",
      };
    },
    async describeRecommendationExportJobs(input) {
      inputs.push(input);
      jobPage += 1;
      return jobPage === 1
        ? { recommendationExportJobs: [job("export-a")], nextToken: "job-page-2" }
        : { recommendationExportJobs: [job("export-b")] };
    },
  })));

  assert.deepEqual(inputs, [
    { maxResults: 100 },
    { maxResults: 1_000 },
    { maxResults: 100, nextToken: "member-page-2" },
    { maxResults: 1_000, nextToken: "job-page-2" },
  ]);
  const memberCoverage = collection.coverage.find((entry) =>
    entry.operation === "GET_ENROLLMENT_STATUSES_FOR_ORGANIZATION"
  );
  assert.equal(memberCoverage?.status, "PARTIAL");
  assert.equal(memberCoverage?.errorCode, "INVALID_PAGINATION");
  assert.equal(memberCoverage?.recordsRejected, 1);
  assert.equal(collection.memberEnrollments.length, 1);
  assert.equal(collection.exportJobs.length, 2);
  assert.equal(JSON.stringify(inputs).includes("filters"), false);
  assert.equal(JSON.stringify(inputs).includes("accountIds"), false);
  assert.equal(JSON.stringify(inputs).includes("jobIds"), false);
  assert.equal(JSON.stringify(inputs).includes("bucket"), false);
});

test("sanitizes provider failures and never returns raw messages", async () => {
  for (const [name, code] of [
    ["AccessDeniedException", "ACCESS_DENIED"],
    ["OptInRequiredException", "ENROLLMENT_REQUIRED"],
    ["ThrottlingException", "RATE_LIMITED"],
    ["SecretProviderFailure", "PROVIDER_REQUEST_FAILED"],
  ] as const) {
    const collection = await collectComputeOptimizerExportDiscovery(options(reader({
      async getEnrollmentStatus() {
        throw Object.assign(new Error("private provider body and bucket"), { name });
      },
    })));
    assert.equal(collection.status, "UNAVAILABLE");
    assert.equal(collection.coverage[0]?.errorCode, code);
    assert.equal(JSON.stringify(collection).includes("private provider body"), false);
  }
});

test("enforces page, record, output, region, and partition boundaries", async () => {
  const bounded = await collectComputeOptimizerExportDiscovery({
    ...options(reader({
      async getEnrollmentStatusesForOrganization() {
        return {
          accountEnrollmentStatuses: [member("111122223333"), member("444455556666")],
          nextToken: "more",
        };
      },
      async describeRecommendationExportJobs() {
        return { recommendationExportJobs: [job("export-a"), job("export-b")] };
      },
    })),
    maximumMemberPages: 1,
    maximumMemberAccounts: 1,
    maximumJobs: 1,
  });
  assert.equal(bounded.status, "PARTIAL");
  assert.equal(bounded.memberEnrollments.length, 1);
  assert.equal(bounded.exportJobs.length, 1);
  assert.ok(bounded.coverage.some(({ errorCode }) => errorCode === "RECORD_LIMIT_REACHED"));

  const pageBound = await collectComputeOptimizerExportDiscovery({
    ...options(reader({
      async getEnrollmentStatusesForOrganization() {
        return {
          accountEnrollmentStatuses: [member("111122223333")],
          nextToken: "more",
        };
      },
    })),
    maximumMemberPages: 1,
  });
  assert.ok(pageBound.coverage.some(({ errorCode }) => errorCode === "PAGE_LIMIT_REACHED"));

  const outputBound = await collectComputeOptimizerExportDiscovery({
    ...options(reader()),
    maximumOutputBytes: 1_024,
  });
  assert.equal(outputBound.status, "UNAVAILABLE");
  assert.equal(outputBound.coverage[0]?.errorCode, "OUTPUT_SIZE_LIMIT_REACHED");

  await assert.rejects(collectComputeOptimizerExportDiscovery({
    ...options(reader()),
    partition: "aws-cn",
  }));
  assert.equal(
    computeOptimizerEndpoint("aws", "us-west-2"),
    "https://compute-optimizer.us-west-2.amazonaws.com",
  );
  assert.equal(
    computeOptimizerEndpoint("aws-cn", "cn-north-1"),
    "https://compute-optimizer.cn-north-1.amazonaws.com.cn",
  );
  assert.throws(() => computeOptimizerEndpoint("aws", "cn-north-1"));
});
