import assert from "node:assert/strict";
import test from "node:test";

import type {
  Anomaly,
  AnomalyMonitor,
  AnomalySubscription,
} from "@aws-sdk/client-cost-explorer";

import {
  collectAwsCostAnomalyDetection,
  type CostAnomalyReader,
} from "../src/cost-anomaly-runner.js";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const START = new Date("2026-07-01T00:00:00.000Z");
const END = new Date("2026-07-31T00:00:00.000Z");
const ACCOUNT_ID = "123456789012";
const MONITOR_ARN =
  `arn:aws:ce::${ACCOUNT_ID}:anomalymonitor/monitor-1`;
const SUBSCRIPTION_ARN =
  `arn:aws:ce::${ACCOUNT_ID}:anomalysubscription/subscription-1`;
const credentials = {
  accessKeyId: "ASIAEXAMPLE00000000",
  secretAccessKey: "not-a-real-secret",
  sessionToken: "not-a-real-session",
  expiration: new Date("2026-08-01T00:00:00.000Z"),
};

function anomaly(id = "anomaly-1"): Anomaly {
  return {
    AnomalyId: id,
    AnomalyStartDate: "2026-07-20",
    AnomalyEndDate: "2026-07-21",
    DimensionValue: "Amazon Elastic Compute Cloud - Compute",
    MonitorArn: MONITOR_ARN,
    Feedback: "PLANNED_ACTIVITY",
    AnomalyScore: { CurrentScore: 72, MaxScore: 91 },
    Impact: {
      MaxImpact: 140,
      TotalImpact: 200,
      TotalActualSpend: 500,
      TotalExpectedSpend: 300,
      TotalImpactPercentage: 66.67,
    },
    RootCauses: [{
      Service: "Amazon Elastic Compute Cloud - Compute",
      Region: "us-east-1",
      LinkedAccount: "210987654321",
      LinkedAccountName: "payments-production",
      UsageType: "BoxUsage:m7g.large",
      Impact: { Contribution: 180 },
    }],
  };
}

function monitor(): AnomalyMonitor {
  return {
    MonitorArn: MONITOR_ARN,
    MonitorName: "Service monitor",
    MonitorType: "DIMENSIONAL",
    MonitorDimension: "SERVICE",
    DimensionalValueCount: 25,
    CreationDate: "2026-01-01T00:00:00Z",
    LastUpdatedDate: "2026-07-30T02:00:00Z",
    LastEvaluatedDate: "2026-07-31T04:30:00Z",
  };
}

function subscription(): AnomalySubscription {
  return {
    SubscriptionArn: SUBSCRIPTION_ARN,
    AccountId: ACCOUNT_ID,
    MonitorArnList: [MONITOR_ARN],
    Subscribers: [
      {
        Address: "finance@example.invalid",
        Type: "EMAIL",
        Status: "CONFIRMED",
      },
      {
        Address: "arn:aws:sns:us-east-1:123456789012:cost-alerts",
        Type: "SNS",
        Status: "DECLINED",
      },
    ],
    Threshold: 100,
    Frequency: "DAILY",
    SubscriptionName: "Finance daily",
    ThresholdExpression: {
      Dimensions: {
        Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE",
        Values: ["100"],
        MatchOptions: ["GREATER_THAN_OR_EQUAL"],
      },
    },
  };
}

function fakeReader(
  overrides: Partial<CostAnomalyReader> = {},
): CostAnomalyReader {
  return {
    async getAnomalies() {
      return { Anomalies: [anomaly()] };
    },
    async getAnomalyMonitors() {
      return { AnomalyMonitors: [monitor()] };
    },
    async getAnomalySubscriptions() {
      return { AnomalySubscriptions: [subscription()] };
    },
    ...overrides,
  };
}

function options(client: CostAnomalyReader) {
  return {
    accountId: ACCOUNT_ID,
    partition: "aws" as const,
    credentials,
    windowStart: START,
    windowEnd: END,
    now: () => NOW,
    client,
  };
}

test("collects the three authoritative AWS anomaly sources with bounded normalized evidence", async () => {
  const calls: Array<Record<string, unknown>> = [];
  let anomalyPage = 0;
  const result = await collectAwsCostAnomalyDetection(options(fakeReader({
    async getAnomalies(input) {
      calls.push({ operation: "anomalies", ...input });
      anomalyPage += 1;
      return anomalyPage === 1
        ? { Anomalies: [anomaly("anomaly-1")], NextPageToken: "page-2" }
        : { Anomalies: [anomaly("anomaly-2")] };
    },
    async getAnomalyMonitors(input) {
      calls.push({ operation: "monitors", ...input });
      return { AnomalyMonitors: [monitor()] };
    },
    async getAnomalySubscriptions(input) {
      calls.push({ operation: "subscriptions", ...input });
      return { AnomalySubscriptions: [subscription()] };
    },
  })));

  assert.equal(result.status, "COMPLETE");
  assert.deepEqual(
    result.coverage.map((entry) => [entry.operation, entry.status]),
    [
      ["GET_ANOMALIES", "SUCCEEDED"],
      ["GET_ANOMALY_MONITORS", "SUCCEEDED"],
      ["GET_ANOMALY_SUBSCRIPTIONS", "SUCCEEDED"],
    ],
  );
  assert.equal(result.anomalies.length, 2);
  assert.equal(result.anomalies[0]?.rootCauses[0]?.contribution, 180);
  assert.equal(result.monitors[0]?.lastEvaluatedAt, "2026-07-31T04:30:00.000Z");
  assert.equal(result.dataThroughAt, "2026-07-31T04:30:00.000Z");
  assert.deepEqual(result.subscriptions[0]?.subscriberCounts, {
    emailConfirmed: 1,
    emailDeclined: 0,
    snsConfirmed: 0,
    snsDeclined: 1,
    unknown: 0,
  });
  assert.equal(
    JSON.stringify(result).includes("finance@example.invalid"),
    false,
  );
  assert.equal(
    JSON.stringify(result).includes("arn:aws:sns:us-east-1"),
    false,
  );
  assert.equal(
    calls.filter((call) => call.operation === "anomalies").length,
    2,
  );
  assert.deepEqual(
    calls.find((call) => call.operation === "anomalies"),
    {
      operation: "anomalies",
      DateInterval: { StartDate: "2026-07-01", EndDate: "2026-07-31" },
      MaxResults: 100,
    },
  );
});

test("marks repeated and malformed pagination tokens as partial protocol evidence", async () => {
  const repeated = await collectAwsCostAnomalyDetection(options(fakeReader({
    async getAnomalies() {
      return { Anomalies: [], NextPageToken: "same-token" };
    },
  })));
  assert.equal(repeated.status, "PARTIAL");
  assert.equal(
    repeated.coverage.find((entry) => entry.operation === "GET_ANOMALIES")
      ?.errorCode,
    "PAGINATION_TOKEN_REPEATED",
  );

  const malformed = await collectAwsCostAnomalyDetection(options(fakeReader({
    async getAnomalyMonitors() {
      return {
        AnomalyMonitors: [],
        NextPageToken: "unsafe\ncontinuation",
      };
    },
  })));
  assert.equal(malformed.status, "PARTIAL");
  assert.equal(
    malformed.coverage.find(
      (entry) => entry.operation === "GET_ANOMALY_MONITORS",
    )?.errorCode,
    "PAGINATION_TOKEN_INVALID",
  );
});

test("enforces record caps without silently presenting truncated results as complete", async () => {
  const result = await collectAwsCostAnomalyDetection({
    ...options(fakeReader({
      async getAnomalies() {
        return {
          Anomalies: [anomaly("anomaly-1"), anomaly("anomaly-2")],
          NextPageToken: "more",
        };
      },
    })),
    maxAnomalies: 1,
  });

  assert.equal(result.status, "PARTIAL");
  assert.equal(result.anomalies.length, 1);
  const coverage = result.coverage.find(
    (entry) => entry.operation === "GET_ANOMALIES",
  );
  assert.equal(coverage?.recordsObserved, 2);
  assert.equal(coverage?.recordsAccepted, 1);
  assert.equal(coverage?.recordsOmitted, 1);
  assert.equal(coverage?.errorCode, "RECORD_LIMIT_REACHED");
});

test("drops malformed provider rows and cross-account resources with explicit partial coverage", async () => {
  const result = await collectAwsCostAnomalyDetection(options(fakeReader({
    async getAnomalies() {
      return {
        Anomalies: [{
          ...anomaly(),
          MonitorArn:
            "arn:aws:ce::999988887777:anomalymonitor/wrong-account",
        }],
      };
    },
    async getAnomalySubscriptions() {
      return {
        AnomalySubscriptions: [{
          ...subscription(),
          AccountId: "999988887777",
        }],
      };
    },
  })));

  assert.equal(result.status, "PARTIAL");
  assert.equal(result.anomalies.length, 0);
  assert.equal(result.subscriptions.length, 0);
  assert.equal(result.coverage[0]?.recordsRejected, 1);
  assert.equal(result.coverage[2]?.recordsRejected, 1);
});

test("does not coerce malformed optional impact, date, or root-cause fields", async () => {
  const result = await collectAwsCostAnomalyDetection(options(fakeReader({
    async getAnomalies() {
      return {
        Anomalies: [
          { ...anomaly("bad-percent"), Impact: {
            ...anomaly().Impact!,
            TotalImpactPercentage: Number.NaN,
          } },
          { ...anomaly("bad-date"), AnomalyEndDate: "2026-07-21garbage" },
          { ...anomaly("bad-root"), RootCauses: [{
            ...anomaly().RootCauses![0]!,
            LinkedAccount: "not-an-account",
          }] },
        ],
      };
    },
  })));

  assert.equal(result.status, "PARTIAL");
  assert.equal(result.anomalies.length, 1);
  assert.equal(result.anomalies[0]?.anomalyId, "bad-root");
  assert.equal(result.anomalies[0]?.rootCauses.length, 0);
  assert.equal(result.anomalies[0]?.rootCausesOmitted, 1);
  assert.equal(result.coverage[0]?.recordsRejected, 2);
  assert.equal(result.coverage[0]?.errorCode, "NORMALIZATION_DROPPED");
});

test("maps provider failures to generic evidence codes and never returns exception messages", async () => {
  const client = fakeReader({
    async getAnomalies() {
      throw Object.assign(new Error("provider request id and secret detail"), {
        name: "AccessDeniedException",
      });
    },
    async getAnomalyMonitors() {
      throw Object.assign(new Error("provider request id and secret detail"), {
        name: "AccessDeniedException",
      });
    },
    async getAnomalySubscriptions() {
      throw Object.assign(new Error("provider request id and secret detail"), {
        name: "AccessDeniedException",
      });
    },
  });
  const result = await collectAwsCostAnomalyDetection(options(client));

  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(
    result.coverage.every((entry) => entry.errorCode === "ACCESS_DENIED"),
    true,
  );
  assert.equal(
    JSON.stringify(result).includes("provider request id"),
    false,
  );
});

test("does not call Cost Explorer in unsupported partitions", async () => {
  let called = false;
  const client = fakeReader({
    async getAnomalies() {
      called = true;
      return { Anomalies: [] };
    },
  });
  const result = await collectAwsCostAnomalyDetection({
    ...options(client),
    partition: "aws-cn",
  });
  assert.equal(called, false);
  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(
    result.coverage.every(
      (entry) => entry.errorCode === "UNSUPPORTED_PARTITION",
    ),
    true,
  );
});

test("aborts stalled commands at the bounded command deadline", async () => {
  let observedAbort = false;
  const stalled = async (
    _input: unknown,
    signal?: AbortSignal,
  ): Promise<never> => new Promise((_, reject) => {
    const fallback = setTimeout(
      () => reject(new Error("abort was not delivered")),
      1_000,
    );
    signal?.addEventListener("abort", () => {
      observedAbort = true;
      clearTimeout(fallback);
      reject(signal.reason);
    }, { once: true });
  });
  const result = await collectAwsCostAnomalyDetection({
    ...options(fakeReader({
      getAnomalies: stalled,
      getAnomalyMonitors: stalled,
      getAnomalySubscriptions: stalled,
    })),
    commandDeadlineMs: 20,
    overallDeadlineMs: 1_000,
  });

  assert.equal(observedAbort, true);
  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(
    result.coverage.every((entry) => entry.errorCode === "TIMEOUT"),
    true,
  );
});

test("rejects unbounded or future query windows before any AWS call", async () => {
  let called = false;
  const client = fakeReader({
    async getAnomalies() {
      called = true;
      return { Anomalies: [] };
    },
  });
  await assert.rejects(
    collectAwsCostAnomalyDetection({
      ...options(client),
      windowStart: new Date("2025-01-01T00:00:00.000Z"),
    }),
    /input is invalid/u,
  );
  await assert.rejects(
    collectAwsCostAnomalyDetection({
      ...options(client),
      windowEnd: new Date("2026-08-02T00:00:00.000Z"),
    }),
    /input is invalid/u,
  );
  assert.equal(called, false);
});
