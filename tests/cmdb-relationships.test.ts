import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonValue, PilotResource } from "../lib/pilot-types.ts";
import {
  buildDependencyGraph,
  deriveRelationships,
  type Relationship,
} from "../lib/cmdb-relationships.ts";

const PARTITION = "aws";
const ACCOUNT = "111122223333";
const REGION = "us-east-1";

function key(service: string, resourceType: string, nativeId: string): string {
  return `${PARTITION}:${ACCOUNT}:${REGION}:${service}:${resourceType}:${nativeId}`;
}

function res(
  service: string,
  resourceType: string,
  nativeId: string,
  configuration: Record<string, JsonValue>,
  overrides: Partial<PilotResource> = {},
): PilotResource {
  return {
    resourceKey: key(service, resourceType, nativeId),
    service,
    resourceType,
    nativeId,
    arn: `arn:${PARTITION}:${service}:${REGION}:${ACCOUNT}:${nativeId}`,
    name: null,
    region: REGION,
    state: "available",
    tags: {},
    configuration,
    source: { api: "test", accountId: ACCOUNT, collectedAt: "2026-07-20T00:00:00.000Z" },
    contentSha256: "0".repeat(64),
    ...overrides,
  };
}

const IAM_PROFILE_ARN = `arn:${PARTITION}:iam::${ACCOUNT}:instance-profile/app`;

function fleet(): PilotResource[] {
  return [
    res("ec2", "aws.ec2.vpc", "vpc-1", {}),
    res("ec2", "aws.ec2.subnet", "subnet-1", { vpcId: "vpc-1", mapPublicIpOnLaunch: true }),
    res("ec2", "aws.ec2.security-group", "sg-web", {
      vpcId: "vpc-1",
      ingress: [{ protocol: "tcp", fromPort: 443, toPort: 443, ipv4Cidrs: ["0.0.0.0/0"] }],
    }),
    res("ec2", "aws.ec2.security-group", "sg-app", {
      vpcId: "vpc-1",
      ingress: [{ protocol: "tcp", fromPort: 8080, toPort: 8080, referencedSecurityGroupIds: ["sg-web"] }],
    }),
    res("ec2", "aws.ec2.instance", "i-1", {
      vpcId: "vpc-1",
      subnetId: "subnet-1",
      securityGroupIds: ["sg-web"],
      iamInstanceProfileArn: IAM_PROFILE_ARN,
    }),
    res("ec2", "aws.ec2.volume", "vol-1", {
      kmsKeyId: "key-1",
      attachments: [{ instanceId: "i-1", device: "/dev/sda1", state: "attached" }],
      instanceIds: ["i-1"],
    }),
    res("kms", "aws.kms.key", "key-1", { enabled: true }),
    res("ec2", "aws.ec2.route-table", "rtb-1", {
      vpcId: "vpc-1",
      associatedSubnetIds: ["subnet-1"],
      routes: [
        { destination: "0.0.0.0/0", target: "igw-1" },
        { destination: "10.0.0.0/8", target: "nat-9" },
      ],
    }),
    res("ec2", "aws.ec2.route-table-association", "rtbassoc-1", {
      routeTableId: "rtb-1",
      vpcId: "vpc-1",
      subnetId: "subnet-1",
    }),
    res("ec2", "aws.ec2.route", "rtb-1/route/0.0.0.0%2F0", {
      routeTableId: "rtb-1",
      vpcId: "vpc-1",
      target: "igw-1",
    }),
    res("ec2", "aws.ec2.network-acl", "acl-1", {
      vpcId: "vpc-1",
      associatedSubnetIds: ["subnet-1"],
    }),
    res("ec2", "aws.ec2.network-acl-association", "aclassoc-1", {
      networkAclId: "acl-1",
      vpcId: "vpc-1",
      subnetId: "subnet-1",
    }),
    res("ec2", "aws.ec2.network-acl-entry", "acl-1/entry/ingress/100", {
      networkAclId: "acl-1",
      vpcId: "vpc-1",
      ruleNumber: 100,
    }),
    res("ec2", "aws.ec2.internet-gateway", "igw-1", { attachedVpcIds: ["vpc-1"], attached: true }),
    res("ec2", "aws.ec2.internet-gateway-attachment", "igw-1/attachment/vpc-1", {
      internetGatewayId: "igw-1",
      vpcId: "vpc-1",
    }),
    res("s3", "aws.s3.bucket", "my-bucket", { versioning: "Enabled" }),
  ];
}

function hasEdge(
  edges: readonly Relationship[],
  fromNative: [string, string, string],
  toKeyOrExternal: string,
  type: string,
  derivedFrom: string,
): boolean {
  const from = key(...fromNative);
  return edges.some(
    (edge) =>
      edge.fromKey === from &&
      edge.toKey === toKeyOrExternal &&
      edge.type === type &&
      edge.source === "derived" &&
      edge.derivedFrom === derivedFrom,
  );
}

describe("deriveRelationships", () => {
  it("derives only edges backed by a present configuration field, each labelled with that field", () => {
    const edges = deriveRelationships(fleet());
    // Containment from vpcId.
    assert.ok(hasEdge(edges, ["ec2", "aws.ec2.subnet", "subnet-1"], key("ec2", "aws.ec2.vpc", "vpc-1"), "contained-in-vpc", "vpcId"));
    assert.ok(hasEdge(edges, ["ec2", "aws.ec2.instance", "i-1"], key("ec2", "aws.ec2.vpc", "vpc-1"), "contained-in-vpc", "vpcId"));
    // Subnet + security group from the instance.
    assert.ok(hasEdge(edges, ["ec2", "aws.ec2.instance", "i-1"], key("ec2", "aws.ec2.subnet", "subnet-1"), "contained-in-subnet", "subnetId"));
    assert.ok(hasEdge(edges, ["ec2", "aws.ec2.instance", "i-1"], key("ec2", "aws.ec2.security-group", "sg-web"), "uses-security-group", "securityGroupIds"));
    // SG-to-SG ingress reference.
    assert.ok(hasEdge(edges, ["ec2", "aws.ec2.security-group", "sg-app"], key("ec2", "aws.ec2.security-group", "sg-web"), "allows-from-security-group", "ingress.referencedSecurityGroupIds"));
    // Volume attachment + encryption.
    assert.ok(hasEdge(edges, ["ec2", "aws.ec2.volume", "vol-1"], key("ec2", "aws.ec2.instance", "i-1"), "attached-to-instance", "attachments.instanceId"));
    assert.ok(hasEdge(edges, ["ec2", "aws.ec2.volume", "vol-1"], key("kms", "aws.kms.key", "key-1"), "encrypted-with-kms-key", "kmsKeyId"));
    // Route table associations + gateway routing.
    assert.ok(hasEdge(edges, ["ec2", "aws.ec2.route-table", "rtb-1"], key("ec2", "aws.ec2.subnet", "subnet-1"), "associates-subnet", "associatedSubnetIds"));
    assert.ok(hasEdge(edges, ["ec2", "aws.ec2.route-table", "rtb-1"], key("ec2", "aws.ec2.internet-gateway", "igw-1"), "routes-through-gateway", "routes.target"));
    assert.ok(hasEdge(edges, ["ec2", "aws.ec2.internet-gateway", "igw-1"], key("ec2", "aws.ec2.vpc", "vpc-1"), "attached-to-vpc", "attachedVpcIds"));
    // First-class VPC subresources keep their own identities and exact edge provenance.
    assert.ok(hasEdge(edges, ["ec2", "aws.ec2.route", "rtb-1/route/0.0.0.0%2F0"], key("ec2", "aws.ec2.route-table", "rtb-1"), "contained-in-route-table", "routeTableId"));
    assert.ok(hasEdge(edges, ["ec2", "aws.ec2.route", "rtb-1/route/0.0.0.0%2F0"], key("ec2", "aws.ec2.internet-gateway", "igw-1"), "routes-through-gateway", "target"));
    assert.ok(hasEdge(edges, ["ec2", "aws.ec2.route-table-association", "rtbassoc-1"], key("ec2", "aws.ec2.subnet", "subnet-1"), "associates-subnet", "subnetId"));
    assert.ok(hasEdge(edges, ["ec2", "aws.ec2.network-acl-entry", "acl-1/entry/ingress/100"], key("ec2", "aws.ec2.network-acl", "acl-1"), "contained-in-network-acl", "networkAclId"));
    assert.ok(hasEdge(edges, ["ec2", "aws.ec2.network-acl-association", "aclassoc-1"], key("ec2", "aws.ec2.subnet", "subnet-1"), "associates-subnet", "subnetId"));
    assert.ok(hasEdge(edges, ["ec2", "aws.ec2.internet-gateway-attachment", "igw-1/attachment/vpc-1"], key("ec2", "aws.ec2.internet-gateway", "igw-1"), "contained-in-internet-gateway", "internetGatewayId"));
  });

  it("never emits a self-loop and produces no edges for a resource with no relationship fields", () => {
    const edges = deriveRelationships(fleet());
    assert.ok(edges.every((edge) => edge.fromKey !== edge.toKey));
    const bucketKey = key("s3", "aws.s3.bucket", "my-bucket");
    assert.equal(edges.filter((edge) => edge.fromKey === bucketKey || edge.toKey === bucketKey).length, 0);
  });

  it("is deterministic and sorted", () => {
    const first = deriveRelationships(fleet());
    const second = deriveRelationships([...fleet()].reverse());
    assert.deepEqual(first, second);
    const sortedKeys = [...first].map((edge) => `${edge.fromKey} ${edge.toKey} ${edge.type} ${edge.source}`);
    assert.deepEqual(sortedKeys, [...sortedKeys].sort((a, b) => a.localeCompare(b, "en-US")));
  });

  it("discloses a referenced-but-uncollected key as an external node, never inventing detail", () => {
    const graph = buildDependencyGraph(fleet(), deriveRelationships(fleet()));
    // The IAM instance profile ARN and the NAT gateway are not collected resources.
    const profile = graph.node(IAM_PROFILE_ARN);
    assert.notEqual(profile, null);
    assert.equal(profile?.present, false);
    assert.equal(profile?.service, null);
    assert.equal(profile?.resourceType, null);
    assert.equal(profile?.region, null);
    assert.ok(graph.externalNodeKeys.includes("nat-9"));
    assert.ok(graph.externalNodeKeys.includes(IAM_PROFILE_ARN));
  });
});

describe("dependency traversal", () => {
  const resources = fleet();
  const graph = buildDependencyGraph(resources, deriveRelationships(resources));
  const instanceKey = key("ec2", "aws.ec2.instance", "i-1");
  const vpcKey = key("ec2", "aws.ec2.vpc", "vpc-1");
  const subnetKey = key("ec2", "aws.ec2.subnet", "subnet-1");
  const sgWebKey = key("ec2", "aws.ec2.security-group", "sg-web");

  it("dependencies(instance) reaches its subnet, security group, vpc and external profile", () => {
    const reached = new Set(graph.dependencies(instanceKey).reached.map((r) => r.node.key));
    assert.ok(reached.has(subnetKey));
    assert.ok(reached.has(sgWebKey));
    assert.ok(reached.has(vpcKey));
    assert.ok(reached.has(IAM_PROFILE_ARN));
  });

  it("dependents(vpc) includes every resource contained in or attached to it", () => {
    const reached = new Set(graph.dependents(vpcKey).reached.map((r) => r.node.key));
    for (const nid of [
      key("ec2", "aws.ec2.subnet", "subnet-1"),
      key("ec2", "aws.ec2.security-group", "sg-web"),
      key("ec2", "aws.ec2.security-group", "sg-app"),
      key("ec2", "aws.ec2.instance", "i-1"),
      key("ec2", "aws.ec2.route-table", "rtb-1"),
      key("ec2", "aws.ec2.internet-gateway", "igw-1"),
    ]) {
      assert.ok(reached.has(nid), `expected ${nid} in vpc dependents`);
    }
  });

  it("blastRadius(security group) is bounded by depth and honestly reports truncation", () => {
    const shallow = graph.blastRadius(sgWebKey, 1);
    assert.equal(shallow.maxDepth, 1);
    const shallowKeys = new Set(shallow.reached.map((r) => r.node.key));
    // Direct dependents of sg-web: the instance (uses) and sg-app (allows-from).
    assert.ok(shallowKeys.has(instanceKey));
    assert.ok(shallowKeys.has(key("ec2", "aws.ec2.security-group", "sg-app")));
    assert.ok(shallow.reached.every((r) => r.depth === 1));

    const deep = graph.blastRadius(sgWebKey, 3);
    const deepKeys = new Set(deep.reached.map((r) => r.node.key));
    // The volume depends on the instance, so it is inside the deeper blast radius.
    assert.ok(deepKeys.has(key("ec2", "aws.ec2.volume", "vol-1")));
  });

  it("shortestPath follows dependent->dependency edges and returns empty when unrelated", () => {
    const path = graph.shortestPath(instanceKey, vpcKey);
    assert.equal(path.found, true);
    assert.equal(path.path[0]?.node.key, instanceKey);
    assert.equal(path.path[path.path.length - 1]?.node.key, vpcKey);
    assert.equal(path.path[0]?.edge, null);

    // The bucket has no dependencies, so it cannot reach the internet gateway.
    const none = graph.shortestPath(key("s3", "aws.s3.bucket", "my-bucket"), key("ec2", "aws.ec2.internet-gateway", "igw-1"));
    assert.equal(none.found, false);
    assert.deepEqual(none.path, []);
  });
});

describe("manual edges and cycle safety", () => {
  it("merges manual edges into the graph, labelled manually-asserted, without touching derived provenance", () => {
    const resources = fleet();
    const instanceKey = key("ec2", "aws.ec2.instance", "i-1");
    const bucketKey = key("s3", "aws.s3.bucket", "my-bucket");
    const graph = buildDependencyGraph(resources, deriveRelationships(resources), [
      { fromKey: instanceKey, toKey: bucketKey, type: "depends-on", note: "app writes here" },
    ]);
    const manual = graph
      .neighbors(instanceKey)
      .dependencies.find((n) => n.neighbor.key === bucketKey);
    assert.notEqual(manual, undefined);
    assert.equal(manual?.edge.source, "manual");
    assert.equal(manual?.edge.derivedFrom, null);
    assert.equal(manual?.edge.note, "app writes here");
    // A derived edge on the same node keeps source "derived".
    assert.ok(graph.allEdges.some((edge) => edge.source === "derived" && edge.fromKey === instanceKey));
  });

  it("terminates on a manually-introduced cycle, visiting each node once", () => {
    const resources = fleet();
    const bucketKey = key("s3", "aws.s3.bucket", "my-bucket");
    const kmsKeyKey = key("kms", "aws.kms.key", "key-1");
    const graph = buildDependencyGraph(resources, deriveRelationships(resources), [
      { fromKey: bucketKey, toKey: kmsKeyKey, type: "depends-on" },
      { fromKey: kmsKeyKey, toKey: bucketKey, type: "depends-on" },
    ]);
    const reached = graph.dependencies(bucketKey).reached;
    const keys = reached.map((r) => r.node.key);
    assert.equal(new Set(keys).size, keys.length, "no node should be visited twice");
    assert.ok(keys.includes(kmsKeyKey));
    // The root never re-appears despite the back-edge.
    assert.ok(!keys.includes(bucketKey));
  });
});
