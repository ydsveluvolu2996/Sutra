import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The IAM grant and the encryption context are one contract split across two
// files. If they drift, KMS refuses every call at runtime -- or worse, accepts
// one it should not. These bind them together.

const template = await readFile(
  new URL("../deploy/ec2/cloudformation-single-node.yaml", import.meta.url),
  "utf8",
);
const envelope = await readFile(
  new URL("../services/aws-collector/src/hosted-credential-envelope.ts", import.meta.url),
  "utf8",
);
const entrypoint = await readFile(
  new URL("../deploy/production/entrypoint.sh", import.meta.url),
  "utf8",
);

test("the grant is absent unless an operator names one exact key", () => {
  // The shipped default stack must carry no kms permission at all. A key that
  // is merely unused is not the same as a role that cannot use one.
  assert.match(template, /GrantCustomerCredentialEnvelope:\s*\n\s*Fn::Not:/u);
  assert.match(template, /Condition: GrantCustomerCredentialEnvelope/u);
  const parameter = template.slice(template.indexOf("  HostedCredentialKmsKeyArn:"));
  assert.match(parameter, /Default: ""/u);
  // A key ARN, never an alias: an alias can be repointed at a different key
  // without the role's grant changing.
  assert.match(parameter, /\^\$\|\^arn:aws:kms:\[a-z0-9-\]\{1,32\}:\[0-9\]\{12\}:key\//u);
});

test("the grant covers exactly the two calls the envelope makes", () => {
  const policy = template.slice(
    template.indexOf("  CustomerCredentialEnvelopePolicy:"),
    template.indexOf("  InstanceProfile:"),
  );
  assert.match(policy, /Action: \["kms:GenerateDataKey", "kms:Decrypt"\]/u);
  // Anything beyond those two would be permission the code cannot justify.
  assert.equal([...policy.matchAll(/kms:[A-Za-z]+/gu)]
    .map((match) => match[0])
    .filter((action) => !action.startsWith("kms:EncryptionContext"))
    .filter((action) => !["kms:GenerateDataKey", "kms:Decrypt"].includes(action))
    .every((action) => policy.slice(policy.indexOf("Effect: Deny")).includes(action)), true);
  assert.match(policy, /Resource: \{ Ref: HostedCredentialKmsKeyArn \}/u);
});

test("the grant's encryption context is the one the envelope actually sends", () => {
  // Read the context keys out of the implementation rather than restating them,
  // so renaming one in code fails here instead of at runtime.
  const context = envelope.slice(
    envelope.indexOf("function encryptionContext("),
    envelope.indexOf("function additionalData("),
  );
  const keys = [...context.matchAll(/"(sutra:[a-z-]+)":/gu)].map((match) => match[1]);
  assert.deepEqual([...keys].sort(), ["sutra:connection-id", "sutra:purpose", "sutra:tenant-id"]);

  const purpose = /"sutra:purpose": "([a-z0-9-]+)"/u.exec(context);
  assert.ok(purpose !== null);

  const policy = template.slice(
    template.indexOf("  CustomerCredentialEnvelopePolicy:"),
    template.indexOf("  InstanceProfile:"),
  );
  // Every context key the code sends must be required by the policy, and the
  // purpose must be pinned to the exact value the code uses -- otherwise a data
  // key minted for another feature could be unwrapped through this grant.
  for (const key of keys) {
    assert.ok(policy.includes(`- ${key}`), `${key} must be required by the IAM condition`);
  }
  assert.ok(
    policy.includes(`kms:EncryptionContext:sutra:purpose: ${purpose[1]}`),
    "the policy must pin the exact purpose the envelope sends",
  );
  // Without ForAllValues the caller could add keys; without a tenant
  // requirement it could drop the one that separates tenants.
  assert.match(policy, /"ForAllValues:StringEquals":/u);
  assert.match(policy, /"ForAnyValue:StringEquals":[\s\S]*?- sutra:tenant-id/u);
});

test("the workload role can never administer the key it uses", () => {
  const policy = template.slice(
    template.indexOf("  CustomerCredentialEnvelopePolicy:"),
    template.indexOf("  InstanceProfile:"),
  );
  const deny = policy.slice(policy.indexOf("Effect: Deny"));
  // Denied outright rather than merely left ungranted, so a later broadening of
  // some other Allow cannot reach them.
  for (const action of [
    "kms:CreateGrant",
    "kms:RetireGrant",
    "kms:RevokeGrant",
    "kms:PutKeyPolicy",
    "kms:ScheduleKeyDeletion",
    "kms:DisableKey",
    "kms:DisableKeyRotation",
  ]) {
    assert.ok(deny.includes(action), `${action} must be denied to the workload role`);
  }
});

test("the hosted broker receives the key ARN without requiring it", () => {
  // Optional on purpose: a deployment without a customer-credential CMK must
  // still start, and must refuse access-key onboarding rather than falling back
  // to the shared registry key.
  assert.match(
    entrypoint,
    /SUTRA_HOSTED_CREDENTIAL_KMS_KEY_ARN=\$\{SUTRA_HOSTED_CREDENTIAL_KMS_KEY_ARN:-\}/u,
  );
  const required = entrypoint.slice(0, entrypoint.indexOf('"\n\nrequire_one_line'));
  assert.ok(
    !required.includes("SUTRA_HOSTED_CREDENTIAL_KMS_KEY_ARN"),
    "the CMK must not join the required-configuration list",
  );
});
