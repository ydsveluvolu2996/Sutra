import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The IAM grant, the encryption context and the process that actually holds the
// key are one contract split across four files. A first attempt wired the ARN
// into the application worker's runtime file and put the grant on the EC2
// instance role -- neither of which runs hosted-server.js -- so the feature was
// inert while looking configured. These bind the pieces to the process that
// constructs the envelope.

const stack = await readFile(
  new URL("../infrastructure/production-ha.yaml", import.meta.url),
  "utf8",
);
const envelope = await readFile(
  new URL("../services/aws-collector/src/hosted-credential-envelope.ts", import.meta.url),
  "utf8",
);
const appEntrypoint = await readFile(
  new URL("../deploy/production/entrypoint.sh", import.meta.url),
  "utf8",
);
const brokerEntrypoint = await readFile(
  new URL("../deploy/production/broker-entrypoint.sh", import.meta.url),
  "utf8",
);
const singleNode = await readFile(
  new URL("../deploy/ec2/cloudformation-single-node.yaml", import.meta.url),
  "utf8",
);

function brokerCredentialPolicy() {
  const start = stack.indexOf("        - PolicyName: WrapOnlyCustomerCredentialDataKeys");
  assert.ok(start > 0, "the broker role must carry the credential-envelope policy");
  // It must sit inside BrokerTaskRole, not some other role that happens to
  // appear later in the template.
  const role = stack.lastIndexOf("  BrokerTaskRole:", start);
  const nextRole = stack.indexOf("\n  WorkerTaskRole:", role);
  assert.ok(role > 0 && start < nextRole, "the grant must belong to BrokerTaskRole");
  return stack.slice(start, stack.indexOf("        - PolicyName: AssumeOnlyDedicatedCustomerRoles", start));
}

test("the CMK is created in the stack, retained, and separate from the signing key", () => {
  const key = stack.slice(
    stack.indexOf("  CustomerCredentialKey:"),
    stack.indexOf("  TrustedAdvisorTaxonomySigningKey:"),
  );
  assert.match(key, /Type: AWS::KMS::Key/u);
  // Losing this key makes every stored customer credential permanently
  // unreadable. That is data loss, not cleanup.
  assert.match(key, /DeletionPolicy: Retain/u);
  assert.match(key, /UpdateReplacePolicy: Retain/u);
  assert.match(key, /EnableKeyRotation: true/u);
  assert.match(key, /KeyUsage: ENCRYPT_DECRYPT/u);
  // Distinct from TrustedAdvisorTaxonomySigningKey on purpose: that key signs
  // Sutra's own attestations, and one key for both would put two unrelated
  // blast radiuses behind a single grant and a single rotation.
  assert.ok(!key.includes("TrustedAdvisorTaxonomySigningKey"));
  assert.match(stack, /TrustedAdvisorTaxonomySigningKey:\s*\n\s*Type: AWS::KMS::Key/u);
});

test("the grant covers exactly the two calls the envelope makes", () => {
  const policy = brokerCredentialPolicy();
  assert.match(policy, /Action: \["kms:GenerateDataKey", "kms:Decrypt"\]/u);
  assert.match(policy, /Resource: !GetAtt CustomerCredentialKey\.Arn/u);
  // Any other kms action appearing in this policy must be in the Deny.
  const deny = policy.slice(policy.indexOf("Effect: Deny"));
  for (const action of [...policy.matchAll(/kms:[A-Za-z]+/gu)].map((match) => match[0])) {
    if (action.startsWith("kms:EncryptionContext")) continue;
    if (["kms:GenerateDataKey", "kms:Decrypt"].includes(action)) continue;
    assert.ok(deny.includes(action), `${action} is granted but not denied`);
  }
});

test("the grant's encryption context is the one the envelope actually sends", () => {
  // Read the context keys out of the implementation rather than restating them,
  // so renaming one in code fails here instead of at runtime against KMS.
  const context = envelope.slice(
    envelope.indexOf("function encryptionContext("),
    envelope.indexOf("function additionalData("),
  );
  const keys = [...context.matchAll(/"(sutra:[a-z-]+)":/gu)].map((match) => match[1]);
  assert.deepEqual([...keys].sort(), ["sutra:connection-id", "sutra:purpose", "sutra:tenant-id"]);
  const purpose = /"sutra:purpose": "([a-z0-9-]+)"/u.exec(context);
  assert.ok(purpose !== null);

  const policy = brokerCredentialPolicy();
  for (const key of keys) {
    assert.ok(policy.includes(`- ${key}`), `${key} must be listed in the allowed context keys`);
  }
  assert.ok(policy.includes(`kms:EncryptionContext:sutra:purpose: ${purpose[1]}`));
});

test("both scoping context keys must be PRESENT, not merely permitted", () => {
  // ForAllValues:StringEquals is a subset check: it constrains which keys may
  // appear, never which must. On its own, a request carrying only tenant and
  // purpose satisfies the policy and escapes the per-connection boundary this
  // grant claims to draw. Null enforces presence.
  const policy = brokerCredentialPolicy();
  assert.match(policy, /"Null":/u);
  assert.match(policy, /kms:EncryptionContext:sutra:tenant-id: "false"/u);
  assert.match(policy, /kms:EncryptionContext:sutra:connection-id: "false"/u);
  assert.match(policy, /"ForAllValues:StringEquals":/u);
});

test("the workload role can never administer the key it uses", () => {
  const deny = brokerCredentialPolicy();
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

test("the ARN reaches the process that constructs the envelope, and no other", () => {
  // hosted-server.js is launched by broker-entrypoint.sh from the broker task
  // definition. The application worker runs start-pilot.mjs and never builds an
  // envelope, so putting the ARN in its runtime file configured nothing.
  assert.match(brokerEntrypoint, /exec node \/app\/services\/aws-collector\/dist\/src\/hosted-server\.js/u);
  const brokerTask = stack.slice(
    stack.indexOf("  BrokerTaskDefinition:"),
    stack.indexOf("  BrokerService:"),
  );
  assert.match(
    brokerTask,
    /Name: SUTRA_HOSTED_CREDENTIAL_KMS_KEY_ARN, Value: !GetAtt CustomerCredentialKey\.Arn/u,
  );
  assert.ok(
    !appEntrypoint.includes("SUTRA_HOSTED_CREDENTIAL_KMS_KEY_ARN"),
    "the application worker does not construct envelopes and must not be given the key",
  );
  // The single-node EC2 host runs the in-process local collector, not
  // hosted-server, so a kms grant there would be permission nothing exercises.
  assert.ok(!singleNode.includes("HostedCredentialKmsKeyArn"));
  assert.ok(!singleNode.includes("CustomerCredentialEnvelopePolicy"));
});

test("the broker still starts without a CMK and refuses credentials instead", () => {
  // Absent configuration is a supported deployment: hostedCredentialKmsConfiguration
  // returns {} and HostedPostgresState refuses static-credential registrations,
  // rather than sealing customer key material under the shared registry key.
  const required = brokerEntrypoint.slice(0, brokerEntrypoint.indexOf('"\n\nrequire_one_line'));
  assert.ok(
    !required.includes("SUTRA_HOSTED_CREDENTIAL_KMS_KEY_ARN"),
    "the CMK must not join the broker's required-configuration list",
  );
});
