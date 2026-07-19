import assert from "node:assert/strict";
import test from "node:test";
import { buildNetworkExposureEvidence } from "../lib/aws-network-exposure-inputs.ts";
import { buildNetworkExposure } from "../lib/aws-network-exposure.ts";
import type { JsonValue, PilotResource } from "../lib/pilot-types.ts";

function resource(
  resourceType: string,
  nativeId: string,
  configuration: Record<string, JsonValue>,
): PilotResource {
  return {
    resourceKey: `key:${nativeId}`,
    service: "ec2",
    resourceType,
    nativeId,
    arn: `arn:aws:ec2:us-east-1:111122223333:${nativeId}`,
    name: null,
    region: "us-east-1",
    state: "available",
    tags: {},
    configuration,
    source: { api: "ec2:Describe", accountId: "111122223333", collectedAt: "2026-07-19T00:00:00.000Z" },
    contentSha256: "0".repeat(64),
  };
}

// A public-facing ENI: igw default route + public IP + a 0.0.0.0/0:443 ingress.
const publicScenario = (): readonly PilotResource[] => [
  resource("aws.ec2.network-interface", "eni-1", {
    subnetId: "subnet-1",
    securityGroupIds: ["sg-1"],
    publicIpAddress: "203.0.113.10",
  }),
  resource("aws.ec2.security-group", "sg-1", {
    ingress: [{ protocol: "tcp", fromPort: 443, toPort: 443, ipv4Cidrs: ["0.0.0.0/0"], ipv6Cidrs: [], referencedSecurityGroupIds: [] }],
  }),
  resource("aws.ec2.subnet", "subnet-1", { vpcId: "vpc-1", mapPublicIpOnLaunch: true }),
  resource("aws.ec2.route-table", "rtb-1", {
    vpcId: "vpc-1",
    main: true,
    associatedSubnetIds: ["subnet-1"],
    routes: [
      { destination: "10.0.0.0/16", target: "local" },
      { destination: "0.0.0.0/0", target: "igw-1" },
    ],
  }),
  resource("aws.ec2.internet-gateway", "igw-1", { attachedVpcIds: ["vpc-1"], attached: true }),
];

test("maps collected resources into evidence that yields 'internet-exposed'", () => {
  const evidence = buildNetworkExposureEvidence(publicScenario(), { tenant: "acme" });
  const report = buildNetworkExposure(evidence);
  const r = report.resources[0];
  assert.equal(report.tenant, "acme");
  assert.equal(r?.ref, "eni-1");
  assert.equal(r?.exposure, "internet-exposed");
  assert.deepEqual(r?.openPorts, [443]);
  assert.ok(r?.path.includes("igw-1"));
  assert.ok(r?.evidenceRefs.includes("sg-1"));
});

test("resolves a subnet to its VPC main route table when it has no explicit association", () => {
  const resources = publicScenario().map((entry) =>
    entry.nativeId === "rtb-1"
      ? resource("aws.ec2.route-table", "rtb-1", {
          vpcId: "vpc-1", main: true, associatedSubnetIds: [],
          routes: [{ destination: "0.0.0.0/0", target: "igw-1" }],
        })
      : entry);
  const evidence = buildNetworkExposureEvidence(resources);
  assert.equal(evidence.subnets["subnet-1"]?.routeTableId, "rtb-1");
  assert.equal(buildNetworkExposure(evidence).resources[0]?.exposure, "internet-exposed");
});

test("fans out an ingress permission into one rule per CIDR and referenced group", () => {
  const evidence = buildNetworkExposureEvidence([
    resource("aws.ec2.security-group", "sg-x", {
      ingress: [{ protocol: "tcp", fromPort: 443, toPort: 443, ipv4Cidrs: ["0.0.0.0/0", "10.0.0.0/8"], ipv6Cidrs: ["::/0"], referencedSecurityGroupIds: ["sg-peer"] }],
    }),
  ]);
  const rules = evidence.securityGroups["sg-x"];
  assert.equal(rules?.length, 4);
  assert.equal(rules?.filter((rule) => rule.cidr !== undefined).length, 3);
  assert.equal(rules?.filter((rule) => rule.sourceSgId === "sg-peer").length, 1);
});

test("an all-traffic (-1) permission with no ports becomes the full port range", () => {
  const evidence = buildNetworkExposureEvidence([
    resource("aws.ec2.security-group", "sg-all", {
      ingress: [{ protocol: "-1", ipv4Cidrs: ["0.0.0.0/0"], ipv6Cidrs: [], referencedSecurityGroupIds: [] }],
    }),
  ]);
  assert.deepEqual(evidence.securityGroups["sg-all"]?.[0], { protocol: "-1", fromPort: 0, toPort: 65_535, cidr: "0.0.0.0/0" });
});

test("a load balancer contributes its listeners and a public DNS entry point", () => {
  const evidence = buildNetworkExposureEvidence([
    resource("aws.elasticloadbalancingv2.load-balancer", "arn:lb/app/demo", {
      scheme: "internet-facing", dnsName: "demo-123.elb.amazonaws.com",
    }),
    resource("aws.elasticloadbalancingv2.listener", "arn:lb/app/demo/listener/443", {
      loadBalancerArn: "arn:lb/app/demo", port: 443,
    }),
  ]);
  const lb = evidence.loadBalancers[0];
  assert.equal(lb?.scheme, "internet-facing");
  assert.deepEqual(lb?.listeners, [{ port: 443 }]);
  assert.deepEqual(lb?.targets, []);
  assert.deepEqual(evidence.dnsRecords, [
    { name: "demo-123.elb.amazonaws.com", type: "ALIAS", public: true, targetRef: "arn:lb/app/demo" },
  ]);
});

test("maps a collected NACL that denies the open port into a filtered result", () => {
  const resources = [
    ...publicScenario(),
    resource("aws.ec2.network-acl", "acl-1", {
      vpcId: "vpc-1",
      isDefault: false,
      associatedSubnetIds: ["subnet-1"],
      entries: [
        { ruleNumber: 100, egress: false, protocol: "tcp", ruleAction: "deny", cidr: "0.0.0.0/0", fromPort: 443, toPort: 443 },
        { ruleNumber: 32767, egress: false, protocol: "-1", ruleAction: "deny", cidr: "0.0.0.0/0" },
      ],
    }),
  ];
  const evidence = buildNetworkExposureEvidence(resources);
  assert.equal(evidence.subnets["subnet-1"]?.networkAclId, "acl-1");
  assert.equal(evidence.networkAcls?.["acl-1"]?.length, 2);
  const report = buildNetworkExposure(evidence);
  const r = report.resources[0];
  assert.equal(r?.exposure, "not-exposed"); // 443 filtered at the subnet boundary
  assert.deepEqual(r?.openPorts, []);
  assert.deepEqual(r?.filteredPorts, [443]);
});

test("a collected NACL that allows the open port keeps it internet-exposed", () => {
  const resources = [
    ...publicScenario(),
    resource("aws.ec2.network-acl", "acl-2", {
      vpcId: "vpc-1", isDefault: true, associatedSubnetIds: ["subnet-1"],
      entries: [{ ruleNumber: 100, egress: false, protocol: "-1", ruleAction: "allow", cidr: "0.0.0.0/0" }],
    }),
  ];
  const report = buildNetworkExposure(buildNetworkExposureEvidence(resources));
  assert.equal(report.resources[0]?.exposure, "internet-exposed");
  assert.deepEqual(report.resources[0]?.openPorts, [443]);
});

test("resolves load-balancer instance targets to their ENIs so LB reachability fires", () => {
  const lbArn = "arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/demo/1234";
  const evidence = buildNetworkExposureEvidence([
    // A private ENI (no public IP) behind an internet-facing ALB, attached to i-1.
    resource("aws.ec2.network-interface", "eni-priv", { subnetId: "subnet-9", securityGroupIds: ["sg-9"], instanceId: "i-1" }),
    resource("aws.ec2.security-group", "sg-9", { ingress: [{ protocol: "tcp", fromPort: 443, toPort: 443, ipv4Cidrs: ["0.0.0.0/0"], ipv6Cidrs: [], referencedSecurityGroupIds: [] }] }),
    resource("aws.elasticloadbalancingv2.load-balancer", lbArn, { scheme: "internet-facing", dnsName: "demo.elb.amazonaws.com" }),
    resource("aws.elasticloadbalancingv2.target-group", "arn:tg/demo", {
      targetType: "instance", loadBalancerArns: [lbArn], targets: [{ id: "i-1", port: 443, state: "healthy" }],
    }),
  ]);
  assert.deepEqual(evidence.loadBalancers[0]?.targets, ["eni-priv"]);
  const report = buildNetworkExposure(evidence);
  assert.equal(report.resources[0]?.exposure, "internet-exposed"); // via the internet-facing LB, no public IP needed
  assert.ok(report.resources[0]?.path.some((hop) => hop.includes("internet-facing")));
});

test("also accepts bare (non-aws-prefixed) resource type names", () => {
  const evidence = buildNetworkExposureEvidence([
    resource("network-interface", "eni-9", { subnetId: "subnet-9", securityGroupIds: ["sg-9"] }),
    resource("security-group", "sg-9", { ingress: [] }),
  ]);
  assert.equal(evidence.resources[0]?.ref, "eni-9");
  assert.ok("sg-9" in evidence.securityGroups);
});

test("empty input yields empty, well-formed evidence", () => {
  const evidence = buildNetworkExposureEvidence([]);
  assert.deepEqual(evidence.resources, []);
  assert.deepEqual(evidence.securityGroups, {});
  assert.equal(evidence.dnsRecords, undefined);
  const report = buildNetworkExposure(evidence);
  assert.equal(report.summary.resources, 0);
});
