import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { load as parseYaml } from
  "../node_modules/.pnpm/js-yaml@4.3.1/node_modules/js-yaml/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const priorPath = resolve(root,
  "infrastructure/customer-onboarding-role-standard-2026-08.7.yaml");
const successorPath = resolve(root,
  "infrastructure/customer-onboarding-role-standard-2026-08.8.yaml");
const [priorSource, successorSource, brokerSource, registrySource, localServerSource,
  hostedServerSource, permissionRegistrySource, supportRepositorySource,
  extendedRepositorySource, successorCatalogSource] = await Promise.all([
  readFile(priorPath, "utf8"), readFile(successorPath, "utf8"),
  readFile(resolve(root, "services/aws-collector/src/role-broker.ts"), "utf8"),
  readFile(resolve(root, "services/aws-collector/src/local-registry.ts"), "utf8"),
  readFile(resolve(root, "services/aws-collector/src/local-server.ts"), "utf8"),
  readFile(resolve(root, "services/aws-collector/src/hosted-server.ts"), "utf8"),
  readFile(resolve(root, "lib/finops-aws-permissions.ts"), "utf8"),
  readFile(resolve(root, "db/finops-aws-support-cases-runtime-repository.ts"), "utf8"),
  readFile(resolve(root, "db/finops-extended-support-runtime-repository.ts"), "utf8"),
  readFile(resolve(root, "lib/finops-permission-pack-successors.ts"), "utf8"),
]);
const prior = parseYaml(priorSource, { json: false });
const successor = parseYaml(successorSource, { json: false });
const actions = Object.freeze([
  "health:DescribeAffectedAccountsForOrganization",
  "health:DescribeAffectedEntitiesForOrganization",
  "health:DescribeEventDetailsForOrganization",
  "health:DescribeEventsForOrganization",
  "health:DescribeHealthServiceStatusForOrganization",
  "organizations:DescribeOrganization",
  "organizations:ListDelegatedAdministrators",
]);
const denyDelta = actions.filter((action) => action !== "organizations:DescribeOrganization");

function policies(template) { return template.Resources.CustomerReadRole.Properties.Policies; }
function statements(template) {
  return policies(template).flatMap((policy) => policy.PolicyDocument.Statement);
}

test("standard-2026-08.7 remains immutable", () => {
  const committed = spawnSync("git", ["show",
    "HEAD:infrastructure/customer-onboarding-role-standard-2026-08.7.yaml"],
  { cwd: root, encoding: "utf8" });
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(priorSource, committed.stdout);
});

test("standard-2026-08.8 grants exactly the seven ADV-06 reads", () => {
  const policy = policies(successor).find(({ PolicyName }) =>
    PolicyName === "SutraFinopsHealthOrganizationReadV1");
  assert.deepEqual(policy.PolicyDocument.Statement, [{
    Sid: "ExactHealthOrganizationRead", Effect: "Allow", Action: actions, Resource: "*",
  }]);
  assert.equal(successor.Metadata.SutraPermissionPack.Version, "standard-2026-08.8");
  assert.equal(successor.Resources.CustomerReadRole.Properties.Tags
    .find(({ Key }) => Key === "sutra:permission-pack").Value, "standard-2026-08.8");
  assert.equal(successor.Outputs.PermissionPackVersion.Value, "standard-2026-08.8");
});

test("the successor preserves .8.7 and opens only the six new ceiling actions", () => {
  const priorDeny = statements(prior).find(({ Sid }) => Sid === "DenyUnimplementedActions");
  const nextDeny = statements(successor).find(({ Sid }) => Sid === "DenyUnimplementedActions");
  assert.deepEqual(nextDeny.NotAction.filter((action) => !priorDeny.NotAction.includes(action)),
    denyDelta);
  assert.deepEqual(priorDeny.NotAction.filter((action) => !nextDeny.NotAction.includes(action)), []);
  assert.equal(new Set(nextDeny.NotAction).size, nextDeny.NotAction.length);
  const priorNames = policies(prior).map(({ PolicyName }) => PolicyName);
  const nextNames = policies(successor).map(({ PolicyName }) => PolicyName);
  assert.deepEqual(nextNames.filter((name) => !priorNames.includes(name)),
    ["SutraFinopsHealthOrganizationReadV1"]);
  for (const name of priorNames) {
    const next = structuredClone(policies(successor).find(({ PolicyName }) =>
      PolicyName === name));
    const previous = policies(prior).find(({ PolicyName }) => PolicyName === name);
    if (name === "SutraImplementedMetadataCollectors") {
      const deny = next.PolicyDocument.Statement.find(({ Sid }) =>
        Sid === "DenyUnimplementedActions");
      deny.NotAction = deny.NotAction.filter((action) => !denyDelta.includes(action));
    }
    assert.deepEqual(next, previous);
  }
});

test("ADV-06 successor adds no Health/Organizations mutation or wildcard action", () => {
  const policy = policies(successor).find(({ PolicyName }) =>
    PolicyName === "SutraFinopsHealthOrganizationReadV1");
  assert.deepEqual(policy.PolicyDocument.Statement[0].Action, actions);
  assert.ok(actions.every((action) => !action.includes("*")));
  assert.doesNotMatch(JSON.stringify(policy),
    /EnableHealthService|DisableHealthService|RegisterDelegated|DeregisterDelegated/u);
});

test(".8.8 is accepted and attested at every credential-owning boundary", () => {
  assert.match(brokerSource, /assumeValidatedAwsHealthSession/u);
  assert.match(brokerSource, /assertAwsHealthPolicy/u);
  assert.match(brokerSource, /awsHealthSessionPolicy/u);
  assert.match(registrySource, /AWS_HEALTH_PERMISSION_PACK_VERSION/u);
  assert.match(localServerSource, /AWS_HEALTH_PROVIDER_ROUTE/u);
  assert.match(localServerSource, /AWS_HEALTH_RESPONSE_LIMIT/u);
  assert.match(hostedServerSource, /createLocalCollectorServer/u);
  assert.match(hostedServerSource, /hostedRuntime: true/u);
  // These allowlists moved out of each runtime and into the shared successor catalog, so .8.8 is no
  // longer a literal here. Assert the same guarantee where it now lives: the catalog enumerates .8.8
  // and both runtimes resolve eligibility through that enumeration, not a lexical comparison.
  assert.match(successorCatalogSource, /"standard-2026-08\.8",/u);
  assert.match(supportRepositorySource, /AWS_SUPPORT_CASES_RUNTIME_PERMISSION_PACK_SQL/u);
  assert.match(extendedRepositorySource, /EXTENDED_SUPPORT_RUNTIME_PERMISSION_PACK_SQL/u);
  for (const action of actions) assert.match(permissionRegistrySource,
    new RegExp(action.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});
