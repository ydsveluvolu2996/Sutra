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
  "infrastructure/customer-onboarding-role-standard-2026-08.8.yaml");
const successorPath = resolve(root,
  "infrastructure/customer-onboarding-role-standard-2026-08.9.yaml");
const [priorSource, successorSource, brokerSource, registrySource, serverSource,
  workerSource, runnerSource, healthRepositorySource, supportRepositorySource,
  extendedRepositorySource, supportRouteSource] = await Promise.all([
  readFile(priorPath, "utf8"),
  readFile(successorPath, "utf8"),
  readFile(resolve(root, "services/aws-collector/src/role-broker.ts"), "utf8"),
  readFile(resolve(root, "services/aws-collector/src/local-registry.ts"), "utf8"),
  readFile(resolve(root, "services/aws-collector/src/local-server.ts"), "utf8"),
  readFile(resolve(root, "db/background-job-handlers.ts"), "utf8"),
  readFile(resolve(root, "app/api/internal/jobs/run/route.ts"), "utf8"),
  readFile(resolve(root, "db/finops-aws-health-runtime-repository.ts"), "utf8"),
  readFile(resolve(root, "db/finops-aws-support-cases-runtime-repository.ts"), "utf8"),
  readFile(resolve(root, "db/finops-extended-support-runtime-repository.ts"), "utf8"),
  readFile(resolve(root, "app/api/v1/finops/aws-support-cases-radar/route.ts"), "utf8"),
]);
const prior = parseYaml(priorSource, { json: false });
const successor = parseYaml(successorSource, { json: false });
const actions = Object.freeze([
  "resiliencehub:DescribeApp",
  "resiliencehub:DescribeAppAssessment",
  "resiliencehub:DescribeResiliencyPolicy",
  "resiliencehub:ListAlarmRecommendations",
  "resiliencehub:ListAppAssessmentComplianceDrifts",
  "resiliencehub:ListAppAssessmentResourceDrifts",
  "resiliencehub:ListAppAssessments",
  "resiliencehub:ListAppComponentCompliances",
  "resiliencehub:ListAppComponentRecommendations",
  "resiliencehub:ListAppVersionResources",
  "resiliencehub:ListApps",
  "resiliencehub:ListResiliencyPolicies",
  "resiliencehub:ListSopRecommendations",
  "resiliencehub:ListTestRecommendations",
]);

function policies(template) { return template.Resources.CustomerReadRole.Properties.Policies; }
function statements(template) {
  return policies(template).flatMap((policy) => policy.PolicyDocument.Statement);
}

test("standard-2026-08.8 remains immutable", () => {
  const committed = spawnSync("git", ["show",
    "HEAD:infrastructure/customer-onboarding-role-standard-2026-08.8.yaml"],
  { cwd: root, encoding: "utf8" });
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(priorSource, committed.stdout);
});

test("standard-2026-08.9 grants exactly the fourteen ADV-10 reads", () => {
  const policy = policies(successor).find(({ PolicyName }) =>
    PolicyName === "SutraFinopsResilienceVueReadV1");
  assert.deepEqual(policy.PolicyDocument.Statement, [{
    Sid: "ExactResilienceVueRead", Effect: "Allow", Action: actions, Resource: "*",
  }]);
  assert.equal(successor.Metadata.SutraPermissionPack.Version, "standard-2026-08.9");
  assert.equal(successor.Resources.CustomerReadRole.Properties.Tags
    .find(({ Key }) => Key === "sutra:permission-pack").Value, "standard-2026-08.9");
  assert.equal(successor.Outputs.PermissionPackVersion.Value, "standard-2026-08.9");
});

test("the successor preserves .8.8 and opens only Resilience Hub reads", () => {
  const priorDeny = statements(prior).find(({ Sid }) => Sid === "DenyUnimplementedActions");
  const nextDeny = statements(successor).find(({ Sid }) => Sid === "DenyUnimplementedActions");
  assert.deepEqual(nextDeny.NotAction.filter((action) => !priorDeny.NotAction.includes(action)),
    actions);
  assert.deepEqual(priorDeny.NotAction.filter((action) => !nextDeny.NotAction.includes(action)), []);
  assert.equal(new Set(nextDeny.NotAction).size, nextDeny.NotAction.length);
  const priorNames = policies(prior).map(({ PolicyName }) => PolicyName);
  const nextNames = policies(successor).map(({ PolicyName }) => PolicyName);
  assert.deepEqual(nextNames.filter((name) => !priorNames.includes(name)),
    ["SutraFinopsResilienceVueReadV1"]);
  assert.ok(actions.every((action) => !action.includes("*")
    && /^(?:resiliencehub:Describe|resiliencehub:List)/u.test(action)));
});

test(".8.9 is enforced at every credential-owning and worker boundary", () => {
  assert.match(brokerSource, /assumeValidatedResilienceVueSession/u);
  assert.match(brokerSource, /assertResilienceVuePolicy/u);
  assert.match(registrySource, /RESILIENCE_VUE_PERMISSION_PACK_VERSION/u);
  assert.match(serverSource, /RESILIENCE_VUE_PROVIDER_ROUTE/u);
  assert.match(serverSource, /RESILIENCE_VUE_RESPONSE_LIMIT/u);
  assert.match(workerSource, /RESILIENCE_VUE_RUNTIME_JOB_KIND/u);
  assert.match(workerSource, /scheduleResilienceVueTick/u);
  assert.match(runnerSource, /scheduleResilienceVueTick/u);
  for (const source of [healthRepositorySource, supportRepositorySource,
    extendedRepositorySource, supportRouteSource]) {
    assert.match(source, /standard-2026-08\.9/u,
      "the .8.9 successor must preserve every predecessor runtime");
  }
});
