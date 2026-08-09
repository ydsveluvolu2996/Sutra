import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { load as parseYaml } from
  "../node_modules/.pnpm/js-yaml@4.3.1/node_modules/js-yaml/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const priorPath = resolve(root, "infrastructure/customer-onboarding-role-standard-2026-08.6.yaml");
const successorPath = resolve(root, "infrastructure/customer-onboarding-role-standard-2026-08.7.yaml");
const [priorSource, successorSource] = await Promise.all([
  readFile(priorPath, "utf8"), readFile(successorPath, "utf8"),
]);
const [brokerSource, registrySource, localServerSource, hostedServerSource, ec2ComposeSource] =
  await Promise.all([
    readFile(resolve(root, "services/aws-collector/src/role-broker.ts"), "utf8"),
    readFile(resolve(root, "services/aws-collector/src/local-registry.ts"), "utf8"),
    readFile(resolve(root, "services/aws-collector/src/local-server.ts"), "utf8"),
    readFile(resolve(root, "services/aws-collector/src/hosted-server.ts"), "utf8"),
    readFile(resolve(root, "deploy/ec2/compose.prod.yaml"), "utf8"),
  ]);
const prior = parseYaml(priorSource, { json: false });
const successor = parseYaml(successorSource, { json: false });
const actions = Object.freeze(["support:DescribeCases", "support:DescribeCommunications"]);

function policies(template) { return template.Resources.CustomerReadRole.Properties.Policies; }
function statements(template) { return policies(template).flatMap((policy) => policy.PolicyDocument.Statement); }

test("standard-2026-08.6 remains immutable", () => {
  const committed = spawnSync("git", ["show",
    "HEAD:infrastructure/customer-onboarding-role-standard-2026-08.6.yaml"],
  { cwd: root, encoding: "utf8" });
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(priorSource, committed.stdout);
});

test("standard-2026-08.7 grants exactly the two ADV-09 Support reads", () => {
  const policy = policies(successor).find(({ PolicyName }) =>
    PolicyName === "SutraFinopsSupportCasesReadV1");
  assert.ok(policy);
  assert.deepEqual(policy.PolicyDocument.Statement, [{
    Sid: "ExactSupportCasesRead", Effect: "Allow", Action: actions, Resource: "*",
  }]);
  assert.equal(successor.Metadata.SutraPermissionPack.Version, "standard-2026-08.7");
  assert.equal(successor.Resources.CustomerReadRole.Properties.Tags
    .find(({ Key }) => Key === "sutra:permission-pack").Value, "standard-2026-08.7");
  assert.equal(successor.Outputs.PermissionPackVersion.Value, "standard-2026-08.7");
});

test("the successor preserves .8.6 and opens only the two Support reads", () => {
  const priorDeny = statements(prior).find(({ Sid }) => Sid === "DenyUnimplementedActions");
  const nextDeny = statements(successor).find(({ Sid }) => Sid === "DenyUnimplementedActions");
  const additions = nextDeny.NotAction.filter((action) => !priorDeny.NotAction.includes(action));
  assert.deepEqual(additions, actions);
  assert.deepEqual(priorDeny.NotAction.filter((action) => !nextDeny.NotAction.includes(action)), []);
  assert.equal(new Set(nextDeny.NotAction).size, nextDeny.NotAction.length);

  const priorPolicyNames = policies(prior).map(({ PolicyName }) => PolicyName);
  const nextPolicyNames = policies(successor).map(({ PolicyName }) => PolicyName);
  assert.deepEqual(nextPolicyNames.filter((name) => !priorPolicyNames.includes(name)),
    ["SutraFinopsSupportCasesReadV1"]);
  for (const name of priorPolicyNames) {
    const next = structuredClone(policies(successor).find(({ PolicyName }) => PolicyName === name));
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

test("ADV-09 successor adds no Support write, Health, Organizations, or data-plane access", () => {
  const added = policies(successor).find(({ PolicyName }) =>
    PolicyName === "SutraFinopsSupportCasesReadV1");
  const serialized = JSON.stringify(added);
  assert.doesNotMatch(serialized, /AddCommunication|CreateCase|ResolveCase|health:|organizations:/u);
  assert.deepEqual(added.PolicyDocument.Statement[0].Action, actions);
});

test(".8.7 is accepted and attested at every credential-owning collector boundary", () => {
  assert.match(brokerSource, /assumeValidatedAwsSupportCasesSession/u);
  assert.match(brokerSource, /assertAwsSupportCasesPolicy/u);
  assert.match(brokerSource, /AWS_SUPPORT_CASES_PERMISSION_ACTIONS/u);
  assert.match(brokerSource, /awsSupportCasesProviderSessionPolicy/u);
  assert.match(registrySource, /AWS_SUPPORT_CASES_PERMISSION_PACK_VERSION/u);
  assert.match(localServerSource, /AWS_SUPPORT_CASES_PROVIDER_ROUTE/u);
  assert.match(localServerSource, /AWS_SUPPORT_CASES_RESPONSE_LIMIT/u);
  assert.match(hostedServerSource, /SUTRA_AWS_SUPPORT_CASES_EVIDENCE_KEY_BASE64URL/u);
  assert.match(
    ec2ComposeSource,
    /SUTRA_AWS_SUPPORT_CASES_EVIDENCE_KEY_BASE64URL: \$\{SUTRA_AWS_SUPPORT_CASES_EVIDENCE_KEY_BASE64URL:\?Provision/u,
  );
});
