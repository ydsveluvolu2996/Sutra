import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [
  template,
  compose,
  setup,
  envTemplate,
  releaseUpdate,
  redeploy,
  syncRuntime,
  onboarding,
  guide,
  security,
  privacy,
  about,
  collectorReadme,
  awsIntegration,
  staticCredentialRunbook,
  customerOnboardingRunbook,
] = await Promise.all([
  readFile(new URL("../deploy/ec2/cloudformation-single-node.yaml", import.meta.url), "utf8"),
  readFile(new URL("../deploy/ec2/compose.prod.yaml", import.meta.url), "utf8"),
  readFile(new URL("../scripts/setup-local-pilot.mjs", import.meta.url), "utf8"),
  readFile(new URL("../deploy/ec2/.env.ec2.example", import.meta.url), "utf8"),
  readFile(new URL("../deploy/ec2/release-update.sh", import.meta.url), "utf8"),
  readFile(new URL("../deploy/ec2/redeploy.sh", import.meta.url), "utf8"),
  readFile(new URL("../deploy/ec2/sync-zoho-runtime.sh", import.meta.url), "utf8"),
  readFile(new URL("../app/onboard/onboard-account.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/onboard/guide/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/security/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/privacy/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/about/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../services/aws-collector/README.md", import.meta.url), "utf8"),
  readFile(new URL("../docs/aws-integration.md", import.meta.url), "utf8"),
  readFile(new URL("../docs/aws-static-credential-onboarding.md", import.meta.url), "utf8"),
  readFile(new URL("../docs/customer-onboarding-runbook.md", import.meta.url), "utf8"),
]);

const customerSecretPolicy = template.slice(
  template.indexOf("PolicyName: ManageOnlySutraCustomerAwsCredentialSecrets"),
  template.indexOf("PolicyName: AssumeOnlyDedicatedSutraCustomerRoles"),
);

test("the EC2 host can manage only the versioned customer-credential secret prefix", () => {
  assert.ok(customerSecretPolicy.length > 0);
  for (const action of [
    "secretsmanager:CreateSecret",
    "secretsmanager:DescribeSecret",
    "secretsmanager:GetSecretValue",
    "secretsmanager:PutSecretValue",
    "secretsmanager:UpdateSecretVersionStage",
    "secretsmanager:DeleteSecret",
  ]) {
    assert.match(customerSecretPolicy, new RegExp(action, "u"));
  }
  assert.equal(
    [...customerSecretPolicy.matchAll(/secret:sutra\/customer-aws-credentials\/v1\/\*/gu)].length,
    3,
  );
  assert.doesNotMatch(customerSecretPolicy, /Resource:\s*["']?\*["']?/u);
  assert.doesNotMatch(customerSecretPolicy, /secretsmanager:(?:ListSecrets|RestoreSecret|ReplicateSecretToRegions|PutResourcePolicy|TagResource|UntagResource|\*)/u);
  const readGrant = customerSecretPolicy.slice(
    customerSecretPolicy.indexOf("Sid: ReadOnlyCurrentOrPendingSutraCustomerCredentialVersion"),
    customerSecretPolicy.indexOf("Sid: ScheduleSutraCustomerAwsCredentialSecretDeletion"),
  );
  assert.match(readGrant, /Action: secretsmanager:GetSecretValue/u);
  assert.match(readGrant, /secretsmanager:VersionStage:[\s\S]*?- AWSCURRENT[\s\S]*?- SUTRAPENDING/u);
  assert.match(readGrant, /"Null":[\s\S]*?secretsmanager:VersionId: "false"/u);
  assert.doesNotMatch(readGrant, /AWSPREVIOUS/u);
});

test("offboarding can schedule only a seven-day recoverable secret deletion", () => {
  const deletion = customerSecretPolicy.slice(
    customerSecretPolicy.indexOf("Sid: ScheduleSutraCustomerAwsCredentialSecretDeletion"),
  );
  assert.match(deletion, /Action: secretsmanager:DeleteSecret/u);
  assert.match(deletion, /NumericEquals:\s*\n\s*secretsmanager:RecoveryWindowInDays: 7/u);
  assert.doesNotMatch(deletion, /ForceDeleteWithoutRecovery|RestoreSecret/u);
});

test("the live EC2 runtime opts in and materializes the exact flag and Region", () => {
  assert.match(
    compose,
    /SUTRA_AWS_STATIC_KEYS_ENABLED: "\$\{SUTRA_AWS_STATIC_KEYS_ENABLED:-false\}"/u,
  );
  assert.match(compose, /AWS_REGION: \$\{AWS_REGION:-ap-south-1\}/u);
  assert.match(setup, /SUTRA_AWS_STATIC_KEYS_ENABLED must be exactly true or false/u);
  assert.match(setup, /AWS static-key onboarding requires the live AWS collector boundary/u);
  for (const name of ["SUTRA_AWS_STATIC_KEYS_ENABLED", "AWS_REGION", "AWS_DEFAULT_REGION"]) {
    assert.match(setup, new RegExp(`\\{ name: "${name}", value:`, "u"));
  }
  assert.equal(
    envTemplate.split("\n").filter((line) => line === "SUTRA_AWS_STATIC_KEYS_ENABLED=false").length,
    1,
  );
  assert.doesNotMatch(envTemplate, /^SUTRA_AWS_STATIC_KEYS_ENABLED=true$/mu);
  assert.match(releaseUpdate, /The AWS static-key emergency switch was not preserved/u);
  assert.match(releaseUpdate, /export SUTRA_AWS_STATIC_KEYS_ENABLED="\$staged_static_keys_enabled"/u);
  assert.match(redeploy, /static_keys_enabled="\$\{static_keys_enabled:-false\}"/u);
  assert.match(redeploy, /export SUTRA_AWS_STATIC_KEYS_ENABLED="\$static_keys_enabled"/u);
  assert.doesNotMatch(syncRuntime, /SUTRA_AWS_STATIC_KEYS_ENABLED/u);
});

test("customer copy recommends IAM Role and states the static-key boundary honestly", () => {
  assert.match(onboarding, /IAM Role <em>Recommended<\/em>/u);
  assert.match(onboarding, /long-lived AKIA access key/u);
  assert.match(onboarding, /temporary ASIA session credentials are not accepted/u);
  assert.doesNotMatch(onboarding, /session token required/u);
  assert.match(onboarding, /GetCallerIdentity proves only that the keys resolve to account/u);
  assert.match(onboarding, /it does not prove least privilege/u);
  assert.match(onboarding, /schedules that secret for deletion after a seven-day recovery window/u);
  assert.doesNotMatch(onboarding, /encrypted in the collector/u);
  assert.match(guide, /GetCallerIdentity proves identity, not least privilege/u);
  assert.match(guide, /long-lived AKIA access key ID and secret/u);
  assert.match(security, /optional Access &amp; Secret Keys method/u);
  assert.match(privacy, /optional access-key method stores customer-supplied credentials encrypted in AWS Secrets Manager/u);
  assert.match(about, /optional access-key path stores a dedicated IAM user credential encrypted in AWS Secrets Manager/u);
  assert.match(collectorReadme, /long-lived `AKIA` key/u);
  assert.match(collectorReadme, /temporary `ASIA` session credentials and session tokens are rejected/u);
  assert.match(awsIntegration, /long-lived `AKIA` access key ID/u);
  assert.match(staticCredentialRunbook, /ID starting `AKIA`/u);
  assert.match(staticCredentialRunbook, /`ASIA` session credentials are not accepted/u);
  assert.match(customerOnboardingRunbook, /long-lived `AKIA` access key ID/u);
  assert.match(customerOnboardingRunbook, /temporary `ASIA` credentials/u);

  for (const source of [security, privacy, about]) {
    assert.doesNotMatch(source, /never store (?:your |customer )?AWS access keys|no stored access keys|No customer access keys stored/u);
  }
});
