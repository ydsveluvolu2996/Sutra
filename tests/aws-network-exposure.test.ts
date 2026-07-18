import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNetworkExposure,
  type NetworkExposureEvidence,
  type NetworkResource,
  type SecurityGroupIngressRule,
} from "../lib/aws-network-exposure.ts";

function evidence(over: Partial<NetworkExposureEvidence> = {}): NetworkExposureEvidence {
  return {
    resources: [],
    securityGroups: {},
    subnets: {},
    routeTables: {},
    internetGateways: [],
    loadBalancers: [],
    ...over,
  };
}

function res(ref: string, over: Partial<NetworkResource> = {}): NetworkResource {
  return { ref, subnetId: "subnet-1", securityGroupIds: ["sg-open"], publicIp: "203.0.113.10", ...over };
}

function ingress(port: number, over: Partial<SecurityGroupIngressRule> = {}): SecurityGroupIngressRule {
  return { protocol: "tcp", fromPort: port, toPort: port, cidr: "0.0.0.0/0", ...over };
}

// A subnet + route table + internet gateway that together form a public-facing hop.
const publicNetwork = {
  subnets: { "subnet-1": { routeTableId: "rtb-1", mapPublicIpOnLaunch: true } },
  routeTables: { "rtb-1": [{ destinationCidr: "0.0.0.0/0", gatewayId: "igw-1" }] },
  internetGateways: ["igw-1"],
};

test("a complete internet-gateway allow-path yields 'internet-exposed' with a cited, non-empty path", () => {
  const report = buildNetworkExposure(evidence({
    resources: [res("eni-1")],
    securityGroups: { "sg-open": [ingress(443)] },
    ...publicNetwork,
  }));
  const r = report.resources[0];
  assert.equal(r?.exposure, "internet-exposed");
  assert.ok((r?.path.length ?? 0) > 0);
  assert.deepEqual(r?.path, ["igw-1", "rtb-1", "subnet-1", "sg-open 0.0.0.0/0:443"]);
  assert.deepEqual(r?.openPorts, [443]);
  assert.deepEqual(r?.missingEvidence, []);
  assert.ok(r?.evidenceRefs.includes("igw-1"));
  assert.ok(r?.evidenceRefs.includes("sg-open"));
  assert.ok(r?.evidenceRefs.includes("eni-1"));
  assert.equal(report.summary.internetExposed, 1);
});

test("an internet-facing load balancer target is exposed even without a public IP", () => {
  const report = buildNetworkExposure(evidence({
    resources: [res("eni-5", { publicIp: undefined })],
    securityGroups: { "sg-open": [ingress(443)] },
    loadBalancers: [{ ref: "elb-pub", scheme: "internet-facing", listeners: [{ port: 443 }], targets: ["eni-5"] }],
  }));
  const r = report.resources[0];
  assert.equal(r?.exposure, "internet-exposed");
  assert.deepEqual(r?.path, ["elb-pub internet-facing", "sg-open 0.0.0.0/0:443"]);
  assert.ok(r?.evidenceRefs.includes("elb-pub"));
});

test("a missing route table for the subnet is 'unknown', never defaulted to 'not-exposed'", () => {
  const report = buildNetworkExposure(evidence({
    resources: [res("eni-2")],
    securityGroups: { "sg-open": [ingress(443)] },
    subnets: { "subnet-1": { routeTableId: "rtb-missing", mapPublicIpOnLaunch: true } },
    routeTables: {},
    internetGateways: ["igw-1"],
  }));
  const r = report.resources[0];
  assert.equal(r?.exposure, "unknown");
  assert.notEqual(r?.exposure, "not-exposed");
  assert.ok(r?.missingEvidence.some((m) => m.includes("route table rtb-missing")));
  assert.deepEqual(r?.path, []);
});

test("a missing subnet is 'unknown' and surfaces the absent subnet", () => {
  const report = buildNetworkExposure(evidence({
    resources: [res("eni-7", { subnetId: "subnet-missing" })],
    securityGroups: { "sg-open": [ingress(443)] },
  }));
  const r = report.resources[0];
  assert.equal(r?.exposure, "unknown");
  assert.ok(r?.missingEvidence.some((m) => m.includes("subnet subnet-missing")));
});

test("a referenced security group absent from the evidence is 'unknown', not 'not-exposed'", () => {
  const report = buildNetworkExposure(evidence({
    resources: [res("eni-6", { securityGroupIds: ["sg-ghost"] })],
    securityGroups: {},
    ...publicNetwork,
  }));
  const r = report.resources[0];
  assert.equal(r?.exposure, "unknown");
  assert.ok(r?.missingEvidence.some((m) => m.includes("security group sg-ghost")));
});

test("an unconfirmed internet gateway (route to an igw not in the evidence) is 'unknown'", () => {
  const report = buildNetworkExposure(evidence({
    resources: [res("eni-8")],
    securityGroups: { "sg-open": [ingress(443)] },
    subnets: { "subnet-1": { routeTableId: "rtb-1", mapPublicIpOnLaunch: true } },
    routeTables: { "rtb-1": [{ destinationCidr: "0.0.0.0/0", gatewayId: "igw-unknown" }] },
    internetGateways: [],
  }));
  const r = report.resources[0];
  assert.equal(r?.exposure, "unknown");
  assert.ok(r?.missingEvidence.some((m) => m.includes("internet gateway")));
});

test("empty security group membership is 'unknown', never assumed closed", () => {
  const report = buildNetworkExposure(evidence({
    resources: [res("eni-10", { securityGroupIds: [] })],
    ...publicNetwork,
  }));
  const r = report.resources[0];
  assert.equal(r?.exposure, "unknown");
  assert.ok(r?.missingEvidence.some((m) => m.includes("security group membership")));
});

test("a security group with no internet ingress is a supported 'not-exposed'", () => {
  const report = buildNetworkExposure(evidence({
    resources: [res("eni-3", { securityGroupIds: ["sg-closed"] })],
    securityGroups: { "sg-closed": [ingress(443, { cidr: "10.0.0.0/8" })] },
    ...publicNetwork,
  }));
  const r = report.resources[0];
  assert.equal(r?.exposure, "not-exposed");
  assert.deepEqual(r?.openPorts, []);
  assert.deepEqual(r?.path, []);
  assert.deepEqual(r?.missingEvidence, []);
  assert.ok(r?.evidenceRefs.includes("sg-closed"));
});

test("an internal-only load balancer target with no public IP is 'not-exposed'", () => {
  const report = buildNetworkExposure(evidence({
    resources: [res("eni-4", { publicIp: undefined, securityGroupIds: ["sg-closed"] })],
    securityGroups: { "sg-closed": [ingress(443, { cidr: "10.0.0.0/8" })] },
    ...publicNetwork,
    loadBalancers: [{ ref: "elb-int", scheme: "internal", listeners: [{ port: 443 }], targets: ["eni-4"] }],
  }));
  const r = report.resources[0];
  assert.equal(r?.exposure, "not-exposed");
  assert.deepEqual(r?.path, []);
});

test("a default route to a NAT gateway is not an internet path -> 'not-exposed'", () => {
  const report = buildNetworkExposure(evidence({
    resources: [res("eni-9")],
    securityGroups: { "sg-open": [ingress(443)] },
    subnets: { "subnet-1": { routeTableId: "rtb-1", mapPublicIpOnLaunch: false } },
    routeTables: { "rtb-1": [{ destinationCidr: "0.0.0.0/0", gatewayId: "nat-1" }, { destinationCidr: "10.0.0.0/16", gatewayId: "local" }] },
    internetGateways: ["igw-1"],
  }));
  const r = report.resources[0];
  assert.equal(r?.exposure, "not-exposed");
  assert.ok(r?.evidenceRefs.includes("rtb-1"));
  assert.ok(!r?.evidenceRefs.includes("igw-1"));
});

test("a definitively closed security group absorbs an unknown network path -> 'not-exposed'", () => {
  // Route table is missing (network reach is unknown) but the SG is fully
  // resolved with no internet ingress: the AND is refuted, so the verdict is a
  // supported 'not-exposed' with no missing-evidence noise.
  const report = buildNetworkExposure(evidence({
    resources: [res("eni-11", { securityGroupIds: ["sg-closed"] })],
    securityGroups: { "sg-closed": [ingress(443, { cidr: "10.0.0.0/8" })] },
    subnets: { "subnet-1": { routeTableId: "rtb-missing", mapPublicIpOnLaunch: true } },
    routeTables: {},
  }));
  const r = report.resources[0];
  assert.equal(r?.exposure, "not-exposed");
  assert.deepEqual(r?.missingEvidence, []);
});

test("a source-security-group ingress rule is not internet-open", () => {
  const report = buildNetworkExposure(evidence({
    resources: [res("eni-12", { securityGroupIds: ["sg-ref"] })],
    securityGroups: { "sg-ref": [{ protocol: "tcp", fromPort: 443, toPort: 443, sourceSgId: "sg-peer" }] },
    ...publicNetwork,
  }));
  assert.equal(report.resources[0]?.exposure, "not-exposed");
});

test("an IPv6 ::/0 ingress rule is treated as internet-open", () => {
  const report = buildNetworkExposure(evidence({
    resources: [res("eni-13", { securityGroupIds: ["sg-v6"] })],
    securityGroups: { "sg-v6": [{ protocol: "tcp", fromPort: 443, toPort: 443, cidr: "::/0" }] },
    ...publicNetwork,
  }));
  const r = report.resources[0];
  assert.equal(r?.exposure, "internet-exposed");
  assert.ok(r?.path.includes("sg-v6 ::/0:443"));
});

test("open ports are de-duplicated, sorted, and port ranges are cited in the path", () => {
  const report = buildNetworkExposure(evidence({
    resources: [res("eni-14", { securityGroupIds: ["sg-multi"] })],
    securityGroups: {
      "sg-multi": [ingress(22), { protocol: "tcp", fromPort: 80, toPort: 8080, cidr: "0.0.0.0/0" }, ingress(22)],
    },
    ...publicNetwork,
  }));
  const r = report.resources[0];
  assert.deepEqual(r?.openPorts, [22, 80]);
  assert.ok(r?.path.includes("sg-multi 0.0.0.0/0:22"));
  assert.ok(r?.path.includes("sg-multi 0.0.0.0/0:80-8080"));
});

test("open SG ports are surfaced even when the network path is unreachable ('not-exposed')", () => {
  const report = buildNetworkExposure(evidence({
    resources: [res("eni-19", { publicIp: undefined })],
    securityGroups: { "sg-open": [ingress(443)] },
  }));
  const r = report.resources[0];
  assert.equal(r?.exposure, "not-exposed");
  assert.deepEqual(r?.openPorts, [443]);
  assert.deepEqual(r?.path, []);
});

test("empty evidence produces no resources and no false findings", () => {
  const report = buildNetworkExposure(evidence());
  assert.deepEqual(report.resources, []);
  assert.deepEqual(report.summary, { resources: 0, internetExposed: 0, notExposed: 0, unknown: 0 });
  assert.equal(report.tenant, null);
  assert.match(report.disclaimer, /never assumed 'not-exposed'/u);
});

test("summary counts and resource ordering are accurate across a mixed batch", () => {
  const report = buildNetworkExposure(evidence({
    resources: [
      res("eni-z-exposed"),
      res("eni-a-closed", { securityGroupIds: ["sg-closed"] }),
      res("eni-m-unknown", { subnetId: "subnet-gone" }),
    ],
    securityGroups: {
      "sg-open": [ingress(443)],
      "sg-closed": [ingress(443, { cidr: "10.0.0.0/8" })],
    },
    ...publicNetwork,
  }));
  assert.deepEqual(report.summary, { resources: 3, internetExposed: 1, notExposed: 1, unknown: 1 });
  assert.deepEqual(report.resources.map((r) => r.ref), ["eni-a-closed", "eni-m-unknown", "eni-z-exposed"]);
});

test("tenant scope is echoed from the evidence when present", () => {
  const report = buildNetworkExposure(evidence({ tenant: "acme", resources: [res("eni-1")], securityGroups: { "sg-open": [ingress(443)] }, ...publicNetwork }));
  assert.equal(report.tenant, "acme");
});

test("output is deterministic for identical input", () => {
  const build = () => buildNetworkExposure(evidence({
    resources: [res("eni-2"), res("eni-1", { securityGroupIds: ["sg-closed"] }), res("eni-3", { subnetId: "gone" })],
    securityGroups: { "sg-open": [ingress(443), ingress(22)], "sg-closed": [ingress(443, { cidr: "10.0.0.0/8" })] },
    loadBalancers: [{ ref: "elb-pub", scheme: "internet-facing", listeners: [{ port: 443 }], targets: ["eni-9"] }],
    ...publicNetwork,
  }));
  assert.deepEqual(build(), build());
});
