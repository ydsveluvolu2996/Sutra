import assert from "node:assert/strict";
import test from "node:test";
import {
  diffCmdbResources,
  type CmdbComparableResource,
} from "../lib/cmdb-change-history.ts";

function resource(
  resourceKey: string,
  overrides: Partial<CmdbComparableResource> = {},
): CmdbComparableResource {
  return {
    resourceKey,
    service: "ec2",
    resourceType: "aws.ec2.instance",
    nativeId: resourceKey,
    arn: `arn:aws:ec2:us-east-1:111122223333:instance/${resourceKey}`,
    name: resourceKey,
    region: "us-east-1",
    state: "running",
    tags: { Environment: "demo", Owner: "platform" },
    configuration: {
      monitoring: { enabled: false },
      network: { securityGroups: ["sg-1", "sg-2"] },
    },
    contentSha256: `sha-${resourceKey}`,
    ...overrides,
  };
}

test("CMDB diff emits deterministic add, change, and remove events", () => {
  const changes = diffCmdbResources(
    [resource("removed"), resource("changed")],
    [
      resource("changed", {
        tags: { Owner: "security", CostCenter: "42" },
        configuration: {
          monitoring: { enabled: true },
          network: { securityGroups: ["sg-1", "sg-3"] },
        },
        contentSha256: "sha-changed-v2",
      }),
      resource("added"),
    ],
  );

  assert.deepEqual(changes.map(({ changeType, resourceKey }) => ({ changeType, resourceKey })), [
    { changeType: "added", resourceKey: "added" },
    { changeType: "changed", resourceKey: "changed" },
    { changeType: "removed", resourceKey: "removed" },
  ]);
  assert.deepEqual(changes[1]?.changedPaths, [
    "tags.CostCenter",
    "tags.Environment",
    "tags.Owner",
    "configuration.monitoring.enabled",
    "configuration.network.securityGroups[1]",
  ]);
  assert.equal(changes[0]?.before, null);
  assert.equal(changes[2]?.after, null);
});

test("CMDB diff ignores object key order and collector-only hash churn", () => {
  const before = resource("stable", {
    tags: { A: "1", B: "2" },
    configuration: { first: true, second: { a: 1, b: 2 } },
    contentSha256: "collector-hash-1",
  });
  const after = resource("stable", {
    tags: { B: "2", A: "1" },
    configuration: { second: { b: 2, a: 1 }, first: true },
    contentSha256: "collector-hash-2",
  });

  assert.deepEqual(diffCmdbResources([before], [after]), []);
});

test("CMDB diff rejects duplicate logical identities", () => {
  assert.throws(
    () => diffCmdbResources([resource("duplicate"), resource("duplicate")], []),
    /Duplicate resourceKey in previous CMDB snapshot/,
  );
});
