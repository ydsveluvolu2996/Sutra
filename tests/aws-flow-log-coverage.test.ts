import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFlowLogCoverage,
  type FlowLogConfig,
  type VpcUnderReview,
} from "../lib/aws-flow-log-coverage.ts";

function vpc(over: Partial<VpcUnderReview> & { vpcId: string }): VpcUnderReview {
  return {
    vpcId: over.vpcId,
    region: over.region ?? "ap-south-1",
    isDefault: over.isDefault ?? false,
    subnetIds: over.subnetIds ?? ["subnet-a", "subnet-b"],
  };
}

function log(over: Partial<FlowLogConfig> & { flowLogId: string; resourceId: string }): FlowLogConfig {
  return {
    flowLogId: over.flowLogId,
    resourceId: over.resourceId,
    destination: over.destination ?? "cloud-watch-logs",
    trafficType: over.trafficType ?? "ALL",
    status: over.status ?? "ACTIVE",
    region: over.region ?? "ap-south-1",
  };
}

test("a VPC-level ACTIVE log makes the VPC observable", () => {
  const report = buildFlowLogCoverage({
    vpcs: [vpc({ vpcId: "vpc-1" })],
    flowLogs: [log({ flowLogId: "fl-1", resourceId: "vpc-1" })],
  });
  assert.equal(report.vpcs[0]?.level, "vpc");
  assert.equal(report.vpcs[0]?.observable, true);
  assert.equal(report.vpcs[0]?.gapReason, null);
  assert.equal(report.summary.observable, 1);
  assert.equal(report.summary.blind, 0);
});

test("a VPC with NO log is blind, and that is the actionable finding", () => {
  const report = buildFlowLogCoverage({ vpcs: [vpc({ vpcId: "vpc-blind" })], flowLogs: [] });
  assert.equal(report.vpcs[0]?.level, "none");
  assert.equal(report.vpcs[0]?.observable, false);
  assert.match(report.vpcs[0]?.gapReason ?? "", /no flow log covers/u);
  assert.equal(report.summary.blind, 1);
});

test("an INACTIVE log is not coverage — configuration theatre is reported as a gap", () => {
  const report = buildFlowLogCoverage({
    vpcs: [vpc({ vpcId: "vpc-1" })],
    flowLogs: [log({ flowLogId: "fl-1", resourceId: "vpc-1", status: "FAILED" })],
  });
  assert.equal(report.vpcs[0]?.level, "configured-inactive");
  assert.equal(report.vpcs[0]?.observable, false);
  assert.match(report.vpcs[0]?.gapReason ?? "", /not ACTIVE/u);
  assert.equal(report.summary.inactive, 1);
});

test("every subnet covered counts as observable; some covered does NOT", () => {
  const all = buildFlowLogCoverage({
    vpcs: [vpc({ vpcId: "vpc-1", subnetIds: ["subnet-a", "subnet-b"] })],
    flowLogs: [log({ flowLogId: "fl-a", resourceId: "subnet-a" }), log({ flowLogId: "fl-b", resourceId: "subnet-b" })],
  });
  assert.equal(all.vpcs[0]?.level, "all-subnets");
  assert.equal(all.vpcs[0]?.observable, true);

  const some = buildFlowLogCoverage({
    vpcs: [vpc({ vpcId: "vpc-1", subnetIds: ["subnet-a", "subnet-b", "subnet-c"] })],
    flowLogs: [log({ flowLogId: "fl-a", resourceId: "subnet-a" })],
  });
  // Partial coverage is the dangerous state: it looks like coverage in a summary.
  assert.equal(some.vpcs[0]?.level, "partial-subnets");
  assert.equal(some.vpcs[0]?.observable, false);
  assert.match(some.vpcs[0]?.gapReason ?? "", /2 of 3 subnets/u);
  assert.equal(some.summary.partial, 1);
});

test("REJECT-only logging is flagged: it cannot answer what an attacker reached", () => {
  const report = buildFlowLogCoverage({
    vpcs: [vpc({ vpcId: "vpc-1" })],
    flowLogs: [log({ flowLogId: "fl-1", resourceId: "vpc-1", trafficType: "REJECT" })],
  });
  assert.equal(report.vpcs[0]?.observable, true, "records ARE produced");
  assert.equal(report.vpcs[0]?.acceptedTrafficRecorded, false, "but accepted traffic is not among them");
  assert.equal(report.summary.rejectOnly, 1);
});

test("the widest traffic type wins when several logs cover the same VPC", () => {
  const report = buildFlowLogCoverage({
    vpcs: [vpc({ vpcId: "vpc-1" })],
    flowLogs: [
      log({ flowLogId: "fl-r", resourceId: "vpc-1", trafficType: "REJECT" }),
      log({ flowLogId: "fl-all", resourceId: "vpc-1", trafficType: "ALL" }),
    ],
  });
  assert.equal(report.vpcs[0]?.trafficType, "ALL");
  assert.equal(report.vpcs[0]?.acceptedTrafficRecorded, true);
  assert.deepEqual(report.vpcs[0]?.flowLogIds, ["fl-all", "fl-r"]);
});

test("a VPC-level log wins over subnet logs and does not need every subnet", () => {
  const report = buildFlowLogCoverage({
    vpcs: [vpc({ vpcId: "vpc-1", subnetIds: ["subnet-a", "subnet-b", "subnet-c"] })],
    flowLogs: [log({ flowLogId: "fl-vpc", resourceId: "vpc-1" })],
  });
  assert.equal(report.vpcs[0]?.level, "vpc");
  assert.equal(report.vpcs[0]?.coveredSubnets, 0);
  assert.equal(report.vpcs[0]?.observable, true);
});

test("a VPC with zero subnets and no log is blind, not accidentally all-subnets", () => {
  // An empty set must not satisfy "every subnet is covered".
  const report = buildFlowLogCoverage({ vpcs: [vpc({ vpcId: "vpc-empty", subnetIds: [] })], flowLogs: [] });
  assert.equal(report.vpcs[0]?.level, "none");
  assert.equal(report.vpcs[0]?.observable, false);
});

test("the claim boundary is explicit — coverage is not visibility", () => {
  const report = buildFlowLogCoverage({ vpcs: [], flowLogs: [] });
  assert.equal(report.claimBoundary, "FLOW_LOG_CONFIGURATION_ONLY_NOT_FLOW_RECORDS");
  assert.match(report.disclaimer, /does\s+not read the flow records/u);
  assert.match(report.disclaimer, /NOT that Sutra has analysed it/u);
  assert.match(report.disclaimer, /cannot be\s+recovered after the fact/u);
});

test("output is deterministic, sorted by region then vpcId", () => {
  const vpcs = [
    vpc({ vpcId: "vpc-b", region: "us-east-1" }),
    vpc({ vpcId: "vpc-a", region: "us-east-1" }),
    vpc({ vpcId: "vpc-z", region: "ap-south-1" }),
  ];
  const first = buildFlowLogCoverage({ vpcs, flowLogs: [] });
  const second = buildFlowLogCoverage({ vpcs: [...vpcs].reverse(), flowLogs: [] });
  assert.deepEqual(first, second);
  assert.deepEqual(first.vpcs.map((entry) => `${entry.region}/${entry.vpcId}`),
    ["ap-south-1/vpc-z", "us-east-1/vpc-a", "us-east-1/vpc-b"]);
});
