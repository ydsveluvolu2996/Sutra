import assert from "node:assert/strict";
import test from "node:test";

import {
  collectAwsCosts,
  type CostExplorerReader,
} from "../src/cost-explorer-runner.js";

const credentials = {
  accessKeyId: "ASIAEXAMPLE00000000",
  secretAccessKey: "not-a-real-secret",
  sessionToken: "not-a-real-session",
  expiration: new Date("2026-08-01T00:00:00.000Z"),
};

function fakeClient(overrides: Partial<CostExplorerReader> = {}): CostExplorerReader {
  return {
    async getCostAndUsage(input) {
      const dimension = input.GroupBy?.[0]?.Key;
      if (dimension === "LINKED_ACCOUNT") {
        return {
          ResultsByTime: [{
            TimePeriod: { Start: "2026-07-01", End: "2026-07-16" },
            Groups: [{ Keys: ["123456789012"], Metrics: { UnblendedCost: { Amount: "40", Unit: "USD" } } }],
          }],
        };
      }
      return {
        ResultsByTime: [
          {
            TimePeriod: { Start: "2026-05-01", End: "2026-06-01" },
            Groups: [{ Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "10", Unit: "USD" } } }],
          },
          {
            TimePeriod: { Start: "2026-06-01", End: "2026-07-01" },
            Groups: [{ Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "30", Unit: "USD" } } }],
          },
          {
            TimePeriod: { Start: "2026-07-01", End: "2026-07-16" },
            Groups: [
              { Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "30", Unit: "USD" } } },
              { Keys: ["Amazon S3"], Metrics: { UnblendedCost: { Amount: "10", Unit: "USD" } } },
            ],
          },
        ],
      };
    },
    async getCostForecast() {
      return { Total: { Amount: "20", Unit: "USD" } };
    },
    ...overrides,
  };
}

test("collects AWS-backed trends, breakdowns, forecast, and evidence signals", async () => {
  const usageEnds: string[] = [];
  const result = await collectAwsCosts({
    accountId: "123456789012",
    partition: "aws",
    credentials,
    now: () => new Date("2026-07-15T10:00:00.000Z"),
    client: fakeClient({
      async getCostAndUsage(input) {
        usageEnds.push(input.TimePeriod?.End ?? "");
        return fakeClient().getCostAndUsage(input);
      },
    }),
  });

  assert.equal(result.status, "COMPLETE");
  assert.equal(result.monthToDateCost, 40);
  assert.equal(result.previousMonthCost, 30);
  assert.equal(result.totalCost, 80);
  assert.equal(result.forecast.source, "AWS_COST_EXPLORER");
  assert.equal(result.forecast.amount, 60);
  assert.deepEqual(result.serviceBreakdown.map((item) => item.sharePercent), [75, 25]);
  assert.equal(result.accountBreakdown[0]?.key, "123456789012");
  assert.equal(result.anomalies[0]?.evidence.delta, 20);
  assert.deepEqual(usageEnds, ["2026-07-15", "2026-07-15"]);
});

test("returns an explicit unavailable state when Cost Explorer is denied", async () => {
  const result = await collectAwsCosts({
    accountId: "123456789012",
    partition: "aws",
    credentials,
    now: () => new Date("2026-07-15T10:00:00.000Z"),
    client: fakeClient({
      async getCostAndUsage() {
        throw Object.assign(new Error("sensitive provider message"), { name: "AccessDeniedException" });
      },
    }),
  });

  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(result.unavailableReason, "ACCESS_DENIED");
  assert.equal(JSON.stringify(result).includes("sensitive provider message"), false);
});

test("uses a labelled linear projection when AWS forecast data is unavailable", async () => {
  const result = await collectAwsCosts({
    accountId: "123456789012",
    partition: "aws",
    credentials,
    now: () => new Date("2026-07-15T10:00:00.000Z"),
    client: fakeClient({
      async getCostForecast() {
        throw Object.assign(new Error("not enough history"), { name: "DataUnavailableException" });
      },
    }),
  });

  assert.equal(result.status, "PARTIAL");
  assert.equal(result.forecast.status, "FALLBACK");
  assert.equal(result.forecast.source, "SUTRA_LINEAR_PROJECTION");
  assert.equal(result.forecast.amount, 82.67);
  assert.equal(result.forecast.reasonCode, "BILLING_DATA_UNAVAILABLE");
});

test("does not call Cost Explorer in unsupported AWS partitions", async () => {
  let called = false;
  const client = fakeClient({
    async getCostAndUsage() {
      called = true;
      return {};
    },
  });
  const result = await collectAwsCosts({
    accountId: "123456789012",
    partition: "aws-cn",
    credentials,
    client,
  });
  assert.equal(called, false);
  assert.equal(result.unavailableReason, "UNSUPPORTED_PARTITION");
});
