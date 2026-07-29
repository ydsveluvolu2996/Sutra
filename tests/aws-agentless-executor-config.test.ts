import assert from "node:assert/strict";
import test from "node:test";

import {
  describeAgentlessConfigGap,
  resolveAgentlessExecutorConfig,
  type AgentlessConfigSource,
} from "../lib/aws-agentless-executor-config.ts";

const COMPLETE: AgentlessConfigSource = {
  SUTRA_AGENTLESS_SCAN_ACCOUNT_ID: "738663485493",
  SUTRA_AGENTLESS_SCAN_AZ: "ap-south-1a",
  SUTRA_AGENTLESS_KMS_KEY_ARN:
    "arn:aws:kms:ap-south-1:738663485493:key/828cff96-5281-44e9-b113-5e3c4b63ee7b",
  SUTRA_AGENTLESS_SCANNER_IMAGE:
    "738663485493.dkr.ecr.ap-south-1.amazonaws.com/sutra/agentless-scanner@sha256:"
    + "0000000000000000000000000000000000000000000000000000000000000000",
  SUTRA_AGENTLESS_LIVE_VALIDATED: "true",
  // The compute settings. Real values from the deployed stack where they exist, so
  // a typo in the template outputs would surface here rather than at scan time.
  SUTRA_AGENTLESS_ORCHESTRATOR_ROLE_ARN: "arn:aws:iam::738663485493:role/sutra/SutraAgentlessOrchestrator",
  SUTRA_AGENTLESS_AMI_ID: "ami-0abcdef1234567890",
  SUTRA_AGENTLESS_INSTANCE_TYPE: "t3.medium",
  SUTRA_AGENTLESS_SUBNET_ID: "subnet-0a010828a2ca84cdd",
  SUTRA_AGENTLESS_SECURITY_GROUP_ID: "sg-015790dfd771987fb",
  SUTRA_AGENTLESS_INSTANCE_PROFILE_ARN:
    "arn:aws:iam::738663485493:instance-profile/sutra/sutra-agentless-scan-ScannerInstanceProfile-h7GgQ7VTUbnf",
  SUTRA_AGENTLESS_FINDINGS_BUCKET: "sutra-agentless-scan-findingsbucket-5at3eakxktgc",
};

/**
 * The orchestrator role ARN MUST keep its /sutra/ path. The control-plane instance
 * role explicitly denies sts:AssumeRole outside arn:aws:iam::*:role/sutra/*, so a
 * pathless ARN here would be accepted by the resolver and then produce an
 * explicitDeny at scan time — after a snapshot already exists and is billing.
 */
test("an orchestrator role ARN keeps its path", () => {
  const withPath = resolveAgentlessExecutorConfig(COMPLETE);
  assert.equal(
    withPath.available && withPath.settings.orchestratorRoleArn.includes("/sutra/"),
    true,
  );
});

test("every compute setting is required, and absence is reported by name", () => {
  for (const name of [
    "SUTRA_AGENTLESS_ORCHESTRATOR_ROLE_ARN",
    "SUTRA_AGENTLESS_AMI_ID",
    "SUTRA_AGENTLESS_INSTANCE_TYPE",
    "SUTRA_AGENTLESS_SUBNET_ID",
    "SUTRA_AGENTLESS_SECURITY_GROUP_ID",
    "SUTRA_AGENTLESS_INSTANCE_PROFILE_ARN",
    "SUTRA_AGENTLESS_FINDINGS_BUCKET",
  ]) {
    const resolved = resolveAgentlessExecutorConfig({ ...COMPLETE, [name]: undefined });
    assert.equal(resolved.available, false, `${name} must be required`);
    assert.ok(!resolved.available && resolved.missing.includes(name), `${name} must be named as missing`);
  }
});

test("a malformed compute setting is invalid rather than merely missing", () => {
  for (const [name, value] of [
    ["SUTRA_AGENTLESS_ORCHESTRATOR_ROLE_ARN", "SutraAgentlessOrchestrator"],
    ["SUTRA_AGENTLESS_AMI_ID", "ami-nothex!"],
    ["SUTRA_AGENTLESS_INSTANCE_TYPE", "enormous"],
    ["SUTRA_AGENTLESS_SUBNET_ID", "subnet-zzz"],
    ["SUTRA_AGENTLESS_INSTANCE_PROFILE_ARN", "arn:aws:iam::738663485493:role/sutra/NotAProfile"],
    ["SUTRA_AGENTLESS_FINDINGS_BUCKET", "Not A Bucket"],
  ] as const) {
    const resolved = resolveAgentlessExecutorConfig({ ...COMPLETE, [name]: value });
    assert.equal(resolved.available, false);
    assert.ok(
      !resolved.available && resolved.invalid.some((entry) => entry.name === name),
      `${name}=${value} must be reported as invalid, not missing`,
    );
  }
});

test("a complete, attested configuration resolves", () => {
  const resolved = resolveAgentlessExecutorConfig(COMPLETE);
  assert.equal(resolved.available, true);
  if (!resolved.available) return;
  assert.equal(resolved.settings.scanAccountId, "738663485493");
  assert.equal(resolved.settings.liveValidated, true);
});

test("an empty environment names every missing setting, not a vague failure", () => {
  const resolved = resolveAgentlessExecutorConfig({});
  assert.equal(resolved.available, false);
  if (resolved.available) return;
  // The exact list, not a count: the point of this contract is that an operator is
  // told which names to set. Adding a required setting SHOULD fail this test until
  // it is listed here, which is how the compute settings got caught.
  assert.deepEqual([...resolved.missing].sort(), [
    "SUTRA_AGENTLESS_AMI_ID",
    "SUTRA_AGENTLESS_FINDINGS_BUCKET",
    "SUTRA_AGENTLESS_INSTANCE_PROFILE_ARN",
    "SUTRA_AGENTLESS_INSTANCE_TYPE",
    "SUTRA_AGENTLESS_LIVE_VALIDATED",
    "SUTRA_AGENTLESS_ORCHESTRATOR_ROLE_ARN",
    "SUTRA_AGENTLESS_SCANNER_IMAGE",
    "SUTRA_AGENTLESS_SCAN_ACCOUNT_ID",
    "SUTRA_AGENTLESS_SCAN_AZ",
    "SUTRA_AGENTLESS_SECURITY_GROUP_ID",
    "SUTRA_AGENTLESS_SUBNET_ID",
  ]);
  // The KMS key is legitimately optional — an unencrypted source volume needs none.
  assert.equal(resolved.missing.includes("SUTRA_AGENTLESS_KMS_KEY_ARN"), false);
});

test("there is NO default scan account — a missing account id refuses", () => {
  // A default here would let a misconfigured deployment snapshot into the wrong
  // account, which is the exact failure this subsystem exists to prevent.
  const resolved = resolveAgentlessExecutorConfig({ ...COMPLETE, SUTRA_AGENTLESS_SCAN_ACCOUNT_ID: undefined });
  assert.equal(resolved.available, false);
});

test("a malformed value is reported as INVALID, distinctly from absent", () => {
  const resolved = resolveAgentlessExecutorConfig({ ...COMPLETE, SUTRA_AGENTLESS_SCAN_ACCOUNT_ID: "73866348549" });
  assert.equal(resolved.available, false);
  if (resolved.available) return;
  assert.deepEqual(resolved.missing, []);
  assert.equal(resolved.invalid[0]?.name, "SUTRA_AGENTLESS_SCAN_ACCOUNT_ID");
  assert.match(resolved.invalid[0]?.reason ?? "", /12-digit/u);
});

test("a region is rejected where an availability zone is required", () => {
  const resolved = resolveAgentlessExecutorConfig({ ...COMPLETE, SUTRA_AGENTLESS_SCAN_AZ: "ap-south-1" });
  assert.equal(resolved.available, false);
  if (resolved.available) return;
  assert.match(resolved.invalid[0]?.reason ?? "", /availability zone/u);
});

test("the scanner image must be digest-pinned, not a tag", () => {
  const tagged = resolveAgentlessExecutorConfig({
    ...COMPLETE,
    SUTRA_AGENTLESS_SCANNER_IMAGE: "738663485493.dkr.ecr.ap-south-1.amazonaws.com/sutra/agentless-scanner:latest",
  });
  assert.equal(tagged.available, false);
  if (tagged.available) return;
  // A mutable tag would make "which scanner produced this CVE" unanswerable later.
  assert.match(tagged.invalid[0]?.reason ?? "", /unattributable/u);
});

test("an absent KMS key is legal; a malformed one is not", () => {
  const absent = resolveAgentlessExecutorConfig({ ...COMPLETE, SUTRA_AGENTLESS_KMS_KEY_ARN: undefined });
  assert.equal(absent.available, true);
  if (absent.available) assert.equal(absent.settings.kmsKeyArn, null);

  // A typo would fail mid-scan, AFTER a snapshot exists and is already billing.
  const typo = resolveAgentlessExecutorConfig({ ...COMPLETE, SUTRA_AGENTLESS_KMS_KEY_ARN: "arn:aws:kms:key/oops" });
  assert.equal(typo.available, false);
});

test("only the exact string 'true' counts as the operator attestation", () => {
  for (const value of ["1", "yes", "TRUE", "True", " true " ]) {
    const resolved = resolveAgentlessExecutorConfig({ ...COMPLETE, SUTRA_AGENTLESS_LIVE_VALIDATED: value });
    // " true " trims to "true" and is accepted; the rest must not be, because this
    // flag records a human attesting they checked every AWS call by hand.
    if (value.trim() === "true") { assert.equal(resolved.available, true, value); continue; }
    assert.equal(resolved.available, false, value);
  }
});

test("explicitly false is refused as a MISSING attestation, not a config error", () => {
  const resolved = resolveAgentlessExecutorConfig({ ...COMPLETE, SUTRA_AGENTLESS_LIVE_VALIDATED: "false" });
  assert.equal(resolved.available, false);
  if (resolved.available) return;
  assert.deepEqual(resolved.missing, ["SUTRA_AGENTLESS_LIVE_VALIDATED=true"]);
  assert.deepEqual(resolved.invalid, []);
});

test("the gap description names the settings so an operator can act on it", () => {
  const text = describeAgentlessConfigGap(resolveAgentlessExecutorConfig({}));
  assert.match(text, /SUTRA_AGENTLESS_SCAN_ACCOUNT_ID/u);
  assert.match(text, /not configured/u);
  assert.equal(describeAgentlessConfigGap(resolveAgentlessExecutorConfig(COMPLETE)), "Agentless execution configuration is complete.");
});

test("resolution is deterministic", () => {
  assert.deepEqual(resolveAgentlessExecutorConfig({}), resolveAgentlessExecutorConfig({}));
});
