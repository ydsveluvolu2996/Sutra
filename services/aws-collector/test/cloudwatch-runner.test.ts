import assert from "node:assert/strict";
import test from "node:test";

import {
  collectEc2Utilization,
  fixtureEc2Utilization,
  type CloudWatchUtilizationReader,
} from "../src/cloudwatch-runner.js";

const credentials = {
  accessKeyId: "ASIAEXAMPLE00000000",
  secretAccessKey: "not-a-real-secret",
  sessionToken: "not-a-real-session",
  expiration: new Date("2026-08-01T00:00:00.000Z"),
};

const now = () => new Date("2026-07-20T00:00:00.000Z");

test("fixture mode returns deterministic representative samples without AWS calls", () => {
  const result = fixtureEc2Utilization({
    accountId: "111122223333",
    instances: [
      { instanceId: "i-aaaa", region: "us-east-1", instanceType: "m5.xlarge", resourceKey: "rk-a" },
      { instanceId: "i-bbbb", region: "us-east-1", instanceType: "m5.large" },
    ],
    now,
  });
  assert.equal(result.schemaVersion, "sutra.aws-utilization.v1");
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.windowDays, 14);
  assert.equal(result.samples.length, 2);
  const [firstSample] = result.samples;
  assert.ok(firstSample);
  assert.equal(firstSample.resourceKey, "rk-a");
  // Deterministic: the same instance ids always produce the same profile.
  const again = fixtureEc2Utilization({
    accountId: "111122223333",
    instances: [{ instanceId: "i-aaaa", region: "us-east-1", instanceType: "m5.xlarge", resourceKey: "rk-a" }],
    now,
  });
  assert.deepEqual(again.samples[0], firstSample);
  // Every sample carries a CPU reading and a window; memory may be null.
  for (const sample of result.samples) {
    assert.equal(typeof sample.cpuP95Percent, "number");
    assert.equal(sample.sampleWindowDays, 14);
  }
});

test("fixture mode with no instances is honestly UNAVAILABLE", () => {
  const result = fixtureEc2Utilization({ accountId: "111122223333", instances: [], now });
  assert.equal(result.status, "UNAVAILABLE");
  assert.deepEqual(result.samples, []);
  assert.ok(result.limitations.includes("NO_EC2_INSTANCES_TO_SAMPLE"));
});

function reader(overrides: Partial<CloudWatchUtilizationReader> = {}): CloudWatchUtilizationReader {
  return {
    async listMetrics() {
      // Only i-mem has the CloudWatch agent memory metric.
      return {
        $metadata: {},
        Metrics: [
          {
            Namespace: "CWAgent",
            MetricName: "mem_used_percent",
            Dimensions: [{ Name: "InstanceId", Value: "i-mem" }],
          },
        ],
      };
    },
    async getMetricData(input) {
      const results = (input.MetricDataQueries ?? []).map((query) => {
        const id = query.Id ?? "";
        const values = id.startsWith("cpu_")
          ? [9, 11, 10]
          : id.startsWith("mem_")
            ? [70, 74, 72]
            : [500_000, 600_000, 550_000];
        return { Id: id, Values: values, Timestamps: values.map(() => new Date(0)) };
      });
      return { $metadata: {}, MetricDataResults: results };
    },
    ...overrides,
  };
}

test("live mode reads CPU/network for every instance and leaves memory unknown without the agent metric", async () => {
  const result = await collectEc2Utilization({
    accountId: "111122223333",
    credentials,
    now,
    readerFactory: () => reader(),
    instances: [
      { instanceId: "i-cpu", region: "us-east-1", instanceType: "m5.xlarge" },
    ],
  });
  assert.equal(result.status, "COMPLETE");
  const [sample] = result.samples;
  assert.ok(sample);
  assert.equal(sample.instanceId, "i-cpu");
  assert.equal(sample.cpuP95Percent, 11); // peak p95 of [9, 11, 10]
  assert.equal(sample.memoryP95Percent, null); // no CWAgent metric -> unknown
  assert.notEqual(sample.networkP95BytesPerMinute, null);
});

test("live mode reports memory only for agent-instrumented instances", async () => {
  const result = await collectEc2Utilization({
    accountId: "111122223333",
    credentials,
    now,
    readerFactory: () => reader(),
    instances: [
      { instanceId: "i-mem", region: "us-east-1", instanceType: "m5.xlarge" },
    ],
  });
  const [sample] = result.samples;
  assert.ok(sample);
  assert.equal(sample.memoryP95Percent, 74); // peak p95 of [70, 74, 72]
});

test("live mode is UNAVAILABLE and read-only-safe when there are no instances", async () => {
  const result = await collectEc2Utilization({
    accountId: "111122223333",
    credentials,
    now,
    readerFactory: () => reader(),
    instances: [],
  });
  assert.equal(result.status, "UNAVAILABLE");
  assert.deepEqual(result.samples, []);
});
