import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLaunchedResources,
  type LaunchedAddedEvent,
} from "../lib/finops-launched.ts";
import type { CmdbComparableResource } from "../lib/cmdb-change-history.ts";

function comparable(over: Partial<CmdbComparableResource>): CmdbComparableResource {
  return {
    resourceKey: over.resourceKey ?? "arn:ec2:i-0abc",
    service: over.service ?? "AmazonEC2",
    resourceType: over.resourceType ?? "AWS::EC2::Instance",
    nativeId: over.nativeId ?? "i-0abc",
    arn: over.arn ?? null,
    name: over.name ?? null,
    region: over.region ?? "us-east-1",
    state: over.state ?? "running",
    tags: over.tags ?? {},
    configuration: over.configuration ?? {},
    contentSha256: over.contentSha256 ?? "sha",
  };
}

// A fixed occurred_at so firstObservedAt is deterministic in assertions.
const OCCURRED_MS = Date.UTC(2026, 6, 20, 12, 0, 0); // 2026-07-20T12:00:00.000Z

test("EC2 added event with configuration.launchTime → launchSource 'aws' and the reported launchedAt", () => {
  const events: readonly LaunchedAddedEvent[] = [{
    resourceKey: "arn:ec2:i-0abc",
    occurredAtMs: OCCURRED_MS,
    after: comparable({
      service: "AmazonEC2",
      resourceType: "AWS::EC2::Instance",
      region: "us-west-2",
      name: "web-1",
      configuration: { launchTime: "2026-07-19T08:30:00.000Z", instanceType: "t3.micro" },
    }),
  }];
  const [row] = buildLaunchedResources(events);
  assert.equal(row.launchSource, "aws");
  assert.equal(row.launchedAt, "2026-07-19T08:30:00.000Z");
  assert.equal(row.firstObservedAt, "2026-07-20T12:00:00.000Z");
  assert.equal(row.service, "AmazonEC2");
  assert.equal(row.resourceType, "AWS::EC2::Instance");
  assert.equal(row.region, "us-west-2");
  assert.equal(row.name, "web-1");
  assert.equal(row.resourceKey, "arn:ec2:i-0abc");
});

test("ELB createdAt and S3/KMS creationDate are also honored as provider launch times", () => {
  const [elb, s3] = buildLaunchedResources([
    {
      resourceKey: "arn:elb:lb-1",
      occurredAtMs: OCCURRED_MS,
      after: comparable({ service: "ElasticLoadBalancingV2", configuration: { createdAt: "2026-07-18T00:00:00.000Z" } }),
    },
    {
      resourceKey: "arn:s3:bucket-1",
      occurredAtMs: OCCURRED_MS,
      after: comparable({ service: "AmazonS3", configuration: { creationDate: "2026-07-17T00:00:00.000Z" } }),
    },
  ]);
  assert.equal(elb.launchSource, "aws");
  assert.equal(elb.launchedAt, "2026-07-18T00:00:00.000Z");
  assert.equal(s3.launchSource, "aws");
  assert.equal(s3.launchedAt, "2026-07-17T00:00:00.000Z");
});

test("added event without any config launch key → 'first-observed' and launchedAt null", () => {
  const [row] = buildLaunchedResources([{
    resourceKey: "arn:sg:sg-1",
    occurredAtMs: OCCURRED_MS,
    after: comparable({ service: "AmazonEC2", resourceType: "AWS::EC2::SecurityGroup", configuration: { groupName: "default" } }),
  }]);
  assert.equal(row.launchSource, "first-observed");
  assert.equal(row.launchedAt, null);
  assert.equal(row.firstObservedAt, "2026-07-20T12:00:00.000Z");
});

test("launchTime wins over createdAt/creationDate when several keys are present (priority order)", () => {
  const [row] = buildLaunchedResources([{
    resourceKey: "arn:ec2:i-multi",
    occurredAtMs: OCCURRED_MS,
    after: comparable({
      configuration: {
        launchTime: "2026-07-10T00:00:00.000Z",
        createdAt: "2026-07-11T00:00:00.000Z",
        creationDate: "2026-07-12T00:00:00.000Z",
      },
    }),
  }]);
  assert.equal(row.launchedAt, "2026-07-10T00:00:00.000Z");
  assert.equal(row.launchSource, "aws");
});

test("a null after snapshot degrades to first-observed with null metadata, never throwing", () => {
  const [row] = buildLaunchedResources([{ resourceKey: "arn:x", occurredAtMs: OCCURRED_MS, after: null }]);
  assert.equal(row.launchSource, "first-observed");
  assert.equal(row.launchedAt, null);
  assert.equal(row.service, null);
  assert.equal(row.name, null);
  assert.equal(row.region, null);
  assert.equal(row.resourceType, null);
  assert.equal(row.resourceKey, "arn:x");
});

test("a non-timestamp launch key value falls back to first-observed", () => {
  const [row] = buildLaunchedResources([{
    resourceKey: "arn:ec2:i-bad",
    occurredAtMs: OCCURRED_MS,
    after: comparable({ configuration: { launchTime: "not-a-date" } }),
  }]);
  assert.equal(row.launchSource, "first-observed");
  assert.equal(row.launchedAt, null);
});

test("output order mirrors input order and is deterministic across calls", () => {
  const events: readonly LaunchedAddedEvent[] = [
    { resourceKey: "b", occurredAtMs: OCCURRED_MS, after: comparable({ resourceKey: "b" }) },
    { resourceKey: "a", occurredAtMs: OCCURRED_MS - 1000, after: comparable({ resourceKey: "a" }) },
  ];
  const first = buildLaunchedResources(events);
  const second = buildLaunchedResources(events);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((row) => row.resourceKey), ["b", "a"]);
});
