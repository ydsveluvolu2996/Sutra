import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { load as parseYaml } from
  "../node_modules/.pnpm/js-yaml@4.3.0/node_modules/js-yaml/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const priorPath = resolve(root,
  "infrastructure/customer-onboarding-role-standard-2026-08.5.yaml");
const successorPath = resolve(root,
  "infrastructure/customer-onboarding-role-standard-2026-08.6.yaml");
const [priorSource, successorSource] = await Promise.all([
  readFile(priorPath, "utf8"), readFile(successorPath, "utf8"),
]);
const prior = parseYaml(priorSource, { json: false });
const successor = parseYaml(successorSource, { json: false });

const actions = Object.freeze([
  "eks:ListClusters",
  "eks:DescribeCluster",
  "eks:DescribeClusterVersions",
  "rds:DescribeDBInstances",
  "rds:DescribeDBClusters",
  "rds:DescribeDBMajorEngineVersions",
  "rds:DescribeOrderableDBInstanceOptions",
  "es:ListDomainNames",
  "es:DescribeDomain",
  "es:DescribeDomains",
  "elasticache:DescribeCacheClusters",
  "elasticache:DescribeReplicationGroups",
  "elasticache:DescribeCacheEngineVersions",
  "pricing:GetProducts",
]);

function policies(template) {
  return template.Resources.CustomerReadRole.Properties.Policies;
}

function statements(template) {
  return policies(template).flatMap((policy) => policy.PolicyDocument.Statement);
}

test("standard-2026-08.5 remains immutable", () => {
  const committed = spawnSync("git", ["show",
    "HEAD:infrastructure/customer-onboarding-role-standard-2026-08.5.yaml"],
  { cwd: root, encoding: "utf8" });
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(priorSource, committed.stdout);
});

test("standard-2026-08.6 grants exactly the fourteen ADV-04 reads", () => {
  const policy = policies(successor).find(({ PolicyName }) =>
    PolicyName === "SutraFinopsExtendedSupportProjectionReadV1");
  assert.ok(policy);
  assert.deepEqual(policy.PolicyDocument.Statement, [{
    Sid: "ExactExtendedSupportProjectionRead",
    Effect: "Allow",
    Action: actions,
    Resource: "*",
  }]);
  assert.equal(successor.Metadata.SutraPermissionPack.Version, "standard-2026-08.6");
  assert.equal(successor.Resources.CustomerReadRole.Properties.Tags
    .find(({ Key }) => Key === "sutra:permission-pack").Value, "standard-2026-08.6");
  assert.equal(successor.Outputs.PermissionPackVersion.Value, "standard-2026-08.6");
});

test("the successor preserves .8.5 and opens only the missing ADV-04 ceiling", () => {
  const priorDeny = statements(prior).find(({ Sid }) => Sid === "DenyUnimplementedActions");
  const nextDeny = statements(successor).find(({ Sid }) => Sid === "DenyUnimplementedActions");
  const additions = nextDeny.NotAction.filter((action) => !priorDeny.NotAction.includes(action));
  assert.deepEqual(additions, actions.filter((action) => !priorDeny.NotAction.includes(action)));
  assert.deepEqual(priorDeny.NotAction.filter((action) => !nextDeny.NotAction.includes(action)), []);
  assert.equal(new Set(nextDeny.NotAction).size, nextDeny.NotAction.length);
  for (const action of actions) assert.ok(nextDeny.NotAction.includes(action), action);

  const priorPolicyNames = policies(prior).map(({ PolicyName }) => PolicyName);
  const nextPolicyNames = policies(successor).map(({ PolicyName }) => PolicyName);
  assert.deepEqual(nextPolicyNames.filter((name) => !priorPolicyNames.includes(name)),
    ["SutraFinopsExtendedSupportProjectionReadV1"]);
  for (const name of priorPolicyNames) {
    const next = structuredClone(
      policies(successor).find(({ PolicyName }) => PolicyName === name),
    );
    const previous = policies(prior).find(({ PolicyName }) => PolicyName === name);
    if (name === "SutraImplementedMetadataCollectors") {
      next.PolicyDocument.Statement.find(({ Sid }) => Sid === "DenyUnimplementedActions")
        .NotAction = next.PolicyDocument.Statement
          .find(({ Sid }) => Sid === "DenyUnimplementedActions").NotAction
          .filter((action) => !additions.includes(action));
    }
    assert.deepEqual(next, previous);
  }
});

test("ADV-04 successor adds no Support Cases, Health, or mutation permission", () => {
  const addedPolicy = policies(successor).at(-1);
  const strings = JSON.stringify(addedPolicy);
  assert.doesNotMatch(strings, /support:|health:|organizations:/u);
  assert.ok(actions.every((action) => /:(?:Get|List|Describe)/u.test(action)));
});
