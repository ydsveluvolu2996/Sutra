import assert from "node:assert/strict";
import test from "node:test";

import type {
  TrustedAdvisorCheckDescription,
  TrustedAdvisorCheckResult,
} from "@aws-sdk/client-support";

import {
  collectTrustedAdvisorStandardChecks,
  TRUSTED_ADVISOR_STANDARD_MAX_CONCURRENCY,
  type TrustedAdvisorStandardReader,
} from "../src/trusted-advisor-standard-runner.js";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const ACCOUNT_ID = "123456789012";
const credentials = {
  accessKeyId: "ASIAEXAMPLE00000000",
  secretAccessKey: "not-a-real-secret",
  sessionToken: "not-a-real-session",
  expiration: new Date("2026-08-01T00:00:00.000Z"),
};

function description(id: string, category = "cost_optimizing"): TrustedAdvisorCheckDescription {
  return {
    id,
    name: `Check ${id}`,
    description: `Description ${id}`,
    category,
    metadata: ["Resource", "Monthly Savings"],
  };
}

function result(
  checkId: string,
  timestamp = "2026-07-31T08:00:00Z",
): TrustedAdvisorCheckResult {
  return {
    checkId,
    timestamp,
    status: "warning",
    resourcesSummary: {
      resourcesProcessed: 5,
      resourcesFlagged: 1,
      resourcesIgnored: 0,
      resourcesSuppressed: 0,
    },
    categorySpecificSummary: {
      costOptimizing: {
        estimatedMonthlySavings: 25,
        estimatedPercentMonthlySavings: 10,
      },
    },
    flaggedResources: [{
      resourceId: `resource-${checkId}`,
      region: "us-east-1",
      status: "warning",
      isSuppressed: false,
      metadata: [`resource-${checkId}`, "25"],
    }],
  };
}

function reader(overrides: Partial<TrustedAdvisorStandardReader> = {}): TrustedAdvisorStandardReader {
  return {
    async describeTrustedAdvisorChecks() {
      return { checks: [description("check-b"), description("check-a", "security")] };
    },
    async describeTrustedAdvisorCheckResult(input) {
      return {
        result: result(
          input.checkId ?? "",
          input.checkId === "check-a"
            ? "2026-07-30T08:00:00Z"
            : "2026-07-31T08:00:00Z",
        ),
      };
    },
    ...overrides,
  };
}

function options(client: TrustedAdvisorStandardReader) {
  return {
    accountId: ACCOUNT_ID,
    partition: "aws" as const,
    credentials,
    now: () => NOW,
    client,
  };
}

test("collects every catalog check with fixed Support API inputs and deterministic evidence", async () => {
  const catalogInputs: unknown[] = [];
  const resultInputs: unknown[] = [];
  const collection = await collectTrustedAdvisorStandardChecks(options(reader({
    async describeTrustedAdvisorChecks(input) {
      catalogInputs.push(input);
      return { checks: [description("check-b"), description("check-a", "security")] };
    },
    async describeTrustedAdvisorCheckResult(input) {
      resultInputs.push(input);
      return { result: result(input.checkId ?? "") };
    },
  })));

  assert.equal(collection.status, "COMPLETE");
  assert.deepEqual(catalogInputs, [{ language: "en" }]);
  assert.deepEqual(resultInputs, [
    { checkId: "check-a", language: "en" },
    { checkId: "check-b", language: "en" },
  ]);
  assert.deepEqual(collection.checks.map((check) => check.checkId), ["check-a", "check-b"]);
  assert.equal(collection.checks[0]?.flaggedResources[0]?.metadata[1]?.name, "Monthly Savings");
  assert.equal(collection.dataThroughAt, "2026-07-31T08:00:00.000Z");
  assert.ok(collection.limitations.includes("CHECK_REFRESH_NOT_REQUESTED"));
});

test("uses the oldest provider timestamp as the account freshness watermark", async () => {
  const collection = await collectTrustedAdvisorStandardChecks(options(reader()));
  assert.equal(collection.status, "COMPLETE");
  assert.equal(collection.dataThroughAt, "2026-07-30T08:00:00.000Z");
});

test("fails closed on conflicting check ids, malformed resources, and summary mismatches", async () => {
  const collection = await collectTrustedAdvisorStandardChecks(options(reader({
    async describeTrustedAdvisorChecks() {
      return {
        checks: [
          description("duplicate"),
          { ...description("duplicate"), name: "Conflicting name" },
          description("valid"),
        ],
      };
    },
    async describeTrustedAdvisorCheckResult(input) {
      const value = result(input.checkId ?? "");
      const summary = value.resourcesSummary!;
      return {
        result: {
          ...value,
          resourcesSummary: {
            resourcesProcessed: summary.resourcesProcessed,
            resourcesFlagged: 9,
            resourcesIgnored: summary.resourcesIgnored,
            resourcesSuppressed: summary.resourcesSuppressed,
          },
          flaggedResources: [
            ...(value.flaggedResources ?? []),
            {
              resourceId: "bad-resource",
              status: "warning",
              isSuppressed: false,
              metadata: ["too", "many", "values"],
            },
          ],
        },
      };
    },
  })));

  assert.equal(collection.status, "PARTIAL");
  assert.equal(collection.coverage[0]?.errorCode, "CONFLICTING_DUPLICATE");
  assert.equal(collection.coverage[1]?.errorCode, "RESOURCE_SUMMARY_MISMATCH");
  assert.equal(collection.coverage[1]?.recordsRejected, 2);
});

test("sanitizes access, support-plan, throttle, and arbitrary provider failures", async () => {
  for (const [name, code] of [
    ["SubscriptionRequiredException", "SUPPORT_PLAN_REQUIRED"],
    ["AccessDeniedException", "ACCESS_DENIED"],
    ["ThrottlingException", "THROTTLED"],
    ["SecretProviderFailure", "PROVIDER_REQUEST_FAILED"],
  ] as const) {
    const collection = await collectTrustedAdvisorStandardChecks(options(reader({
      async describeTrustedAdvisorChecks() {
        throw Object.assign(new Error("secret provider body"), { name });
      },
    })));
    assert.equal(collection.status, "UNAVAILABLE");
    assert.equal(collection.coverage[0]?.errorCode, code);
    assert.equal(JSON.stringify(collection).includes("secret provider body"), false);
  }
});

test("applies deterministic resource and output bounds without false completeness", async () => {
  const bounded = await collectTrustedAdvisorStandardChecks({
    ...options(reader({
      async describeTrustedAdvisorChecks() {
        return { checks: [description("bounded")] };
      },
      async describeTrustedAdvisorCheckResult(input) {
        const value = result(input.checkId ?? "");
        const summary = value.resourcesSummary!;
        const firstResource = value.flaggedResources?.[0];
        assert.ok(firstResource);
        return {
          result: {
            ...value,
            resourcesSummary: {
              resourcesProcessed: summary.resourcesProcessed,
              resourcesFlagged: 2,
              resourcesIgnored: summary.resourcesIgnored,
              resourcesSuppressed: summary.resourcesSuppressed,
            },
            flaggedResources: [
              firstResource,
              { ...firstResource, resourceId: "second" },
            ],
          },
        };
      },
    })),
    maximumResources: 1,
  });
  assert.equal(bounded.status, "PARTIAL");
  assert.equal(bounded.checks[0]?.flaggedResources.length, 1);
  assert.equal(bounded.coverage[1]?.recordsOmitted, 1);

  const outputBound = await collectTrustedAdvisorStandardChecks({
    ...options(reader({
      async describeTrustedAdvisorChecks() {
        return {
          checks: [{
            ...description("output"),
            description: "x".repeat(5_000),
          }],
        };
      },
    })),
    maximumOutputBytes: 2_048,
  });
  assert.equal(outputBound.status, "PARTIAL");
  assert.equal(outputBound.checks.length, 0);
  assert.equal(outputBound.coverage[0]?.errorCode, "OUTPUT_SIZE_LIMIT_REACHED");
});

test("bounds result concurrency and rejects unsupported partitions before AWS calls", async () => {
  let active = 0;
  let maximumActive = 0;
  const checks = Array.from({ length: 8 }, (_, index) => description(`check-${index}`));
  const client = reader({
    async describeTrustedAdvisorChecks() {
      return { checks };
    },
    async describeTrustedAdvisorCheckResult(input) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return { result: result(input.checkId ?? "") };
    },
  });
  const collection = await collectTrustedAdvisorStandardChecks(options(client));
  assert.equal(collection.status, "COMPLETE");
  assert.equal(maximumActive, TRUSTED_ADVISOR_STANDARD_MAX_CONCURRENCY);

  let called = false;
  const unsupported = await collectTrustedAdvisorStandardChecks({
    ...options(reader({
      async describeTrustedAdvisorChecks() {
        called = true;
        return { checks: [] };
      },
    })),
    partition: "aws-us-gov",
  });
  assert.equal(unsupported.status, "UNAVAILABLE");
  assert.equal(unsupported.coverage[0]?.errorCode, "UNSUPPORTED_PARTITION");
  assert.equal(called, false);
});
