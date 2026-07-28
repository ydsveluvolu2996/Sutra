import assert from "node:assert/strict";
import test from "node:test";

import { buildFlowLogCoverage } from "../lib/aws-flow-log-coverage.ts";
import { buildFlowLogInputs } from "../lib/aws-flow-log-inputs.ts";
import type { JsonValue, PilotResource } from "../lib/pilot-types.ts";

function resource(
  resourceType: string,
  nativeId: string,
  configuration: Readonly<Record<string, JsonValue>> = {},
  region = "ap-south-1",
): PilotResource {
  return {
    resourceKey: `${resourceType}:${nativeId}`,
    service: "ec2",
    resourceType,
    nativeId,
    arn: null,
    name: null,
    region,
    state: "available",
    tags: {},
    configuration,
    source: { api: "ec2:Describe", accountId: "123456789012", collectedAt: "2026-07-28T00:00:00.000Z" },
  } as PilotResource;
}

test("maps VPCs with their subnets and attributes", () => {
  const inputs = buildFlowLogInputs([
    resource("aws.ec2.vpc", "vpc-1", { isDefault: true }),
    resource("aws.ec2.subnet", "subnet-b", { vpcId: "vpc-1" }),
    resource("aws.ec2.subnet", "subnet-a", { vpcId: "vpc-1" }),
    resource("aws.ec2.subnet", "subnet-x", { vpcId: "vpc-other" }),
  ]);
  assert.equal(inputs.vpcs.length, 1);
  assert.equal(inputs.vpcs[0]?.isDefault, true);
  // Sorted so a coverage report does not churn with collector pagination order.
  assert.deepEqual(inputs.vpcs[0]?.subnetIds, ["subnet-a", "subnet-b"]);
});

test("accepts both prefixed and bare resource kinds", () => {
  const prefixed = buildFlowLogInputs([resource("aws.ec2.vpc", "vpc-1")]);
  const bare = buildFlowLogInputs([resource("vpc", "vpc-1")]);
  assert.equal(prefixed.vpcs.length, 1);
  assert.equal(bare.vpcs.length, 1);
});

test("maps a flow log's covered resource, traffic type and destination", () => {
  const inputs = buildFlowLogInputs([
    resource("aws.ec2.flow-log", "fl-1", {
      resourceId: "vpc-1",
      flowLogStatus: "ACTIVE",
      trafficType: "ALL",
      logDestinationType: "s3",
    }),
  ]);
  assert.deepEqual(inputs.flowLogs[0], {
    flowLogId: "fl-1",
    resourceId: "vpc-1",
    destination: "s3",
    trafficType: "ALL",
    status: "ACTIVE",
    region: "ap-south-1",
  });
  assert.equal(inputs.flowLogsCollected, true);
});

test("a FAILED delivery status is surfaced, not hidden behind an ACTIVE flow log", () => {
  // FlowLogStatus ACTIVE + DeliverLogsStatus FAILED is a real AWS state: the log
  // exists and produces nothing usable. Reporting it as ACTIVE would claim
  // coverage that does not exist.
  const inputs = buildFlowLogInputs([
    resource("aws.ec2.flow-log", "fl-1", {
      resourceId: "vpc-1", flowLogStatus: "ACTIVE", deliverLogsStatus: "FAILED", trafficType: "ALL",
    }),
  ]);
  assert.equal(inputs.flowLogs[0]?.status, "DELIVERY_FAILED");
  const report = buildFlowLogCoverage({
    vpcs: [{ vpcId: "vpc-1", region: "ap-south-1", isDefault: false, subnetIds: [] }],
    flowLogs: inputs.flowLogs,
  });
  assert.equal(report.vpcs[0]?.observable, false);
  assert.equal(report.vpcs[0]?.level, "configured-inactive");
});

test("a flow log with no covered resource is DROPPED, which can only understate coverage", () => {
  const inputs = buildFlowLogInputs([
    resource("aws.ec2.flow-log", "fl-1", { flowLogStatus: "ACTIVE" }),
  ]);
  assert.deepEqual(inputs.flowLogs, []);
  // Still counted as collected: DescribeFlowLogs clearly ran.
  assert.equal(inputs.flowLogsCollected, true);
});

test("flowLogsCollected distinguishes 'not permitted' from 'none exist'", () => {
  // A pre-.3 role could not call DescribeFlowLogs, so the snapshot has no
  // flow-log resources. That is NOT the same as an account with no flow logs, and
  // the two have opposite meanings — the caller must be able to tell them apart.
  const notCollected = buildFlowLogInputs([resource("aws.ec2.vpc", "vpc-1")]);
  assert.equal(notCollected.flowLogsCollected, false);
  assert.deepEqual(notCollected.flowLogs, []);
});

test("unknown traffic type and destination degrade rather than throw", () => {
  const inputs = buildFlowLogInputs([
    resource("aws.ec2.flow-log", "fl-1", { resourceId: "vpc-1", trafficType: "WAT", logDestinationType: "carrier-pigeon" }),
  ]);
  assert.equal(inputs.flowLogs[0]?.trafficType, "unknown");
  assert.equal(inputs.flowLogs[0]?.destination, "unknown");
  assert.equal(inputs.flowLogs[0]?.status, "unknown");
});

test("traffic type is case-insensitive", () => {
  const inputs = buildFlowLogInputs([
    resource("aws.ec2.flow-log", "fl-1", { resourceId: "vpc-1", trafficType: "all" }),
  ]);
  assert.equal(inputs.flowLogs[0]?.trafficType, "ALL");
});

test("end to end: a subnet-covered VPC reads as observable through the real engine", () => {
  const inputs = buildFlowLogInputs([
    resource("aws.ec2.vpc", "vpc-1"),
    resource("aws.ec2.subnet", "subnet-a", { vpcId: "vpc-1" }),
    resource("aws.ec2.subnet", "subnet-b", { vpcId: "vpc-1" }),
    resource("aws.ec2.flow-log", "fl-a", { resourceId: "subnet-a", flowLogStatus: "ACTIVE", trafficType: "ALL" }),
    resource("aws.ec2.flow-log", "fl-b", { resourceId: "subnet-b", flowLogStatus: "ACTIVE", trafficType: "ALL" }),
  ]);
  const report = buildFlowLogCoverage(inputs);
  assert.equal(report.vpcs[0]?.level, "all-subnets");
  assert.equal(report.summary.observable, 1);
});

test("end to end: a VPC with no flow log is reported blind", () => {
  const inputs = buildFlowLogInputs([
    resource("aws.ec2.vpc", "vpc-blind"),
    resource("aws.ec2.subnet", "subnet-a", { vpcId: "vpc-blind" }),
  ]);
  const report = buildFlowLogCoverage(inputs);
  assert.equal(report.summary.blind, 1);
  assert.match(report.vpcs[0]?.gapReason ?? "", /no flow log covers/u);
});

test("output is deterministic for the same resource set in any order", () => {
  const resources = [
    resource("aws.ec2.flow-log", "fl-1", { resourceId: "vpc-1", flowLogStatus: "ACTIVE", trafficType: "ALL" }),
    resource("aws.ec2.subnet", "subnet-a", { vpcId: "vpc-1" }),
    resource("aws.ec2.vpc", "vpc-1"),
  ];
  assert.deepEqual(buildFlowLogInputs(resources), buildFlowLogInputs([...resources].reverse()));
});
