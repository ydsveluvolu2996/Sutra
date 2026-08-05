import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const [successor, previous, current, publicDefault, runbook] = await Promise.all([
  readFile(new URL(
    "../infrastructure/customer-onboarding-role-standard-2026-08.2.yaml",
    import.meta.url,
  ), "utf8"),
  readFile(new URL(
    "../infrastructure/customer-onboarding-role-standard-2026-08.1.yaml",
    import.meta.url,
  ), "utf8"),
  readFile(new URL("../infrastructure/customer-onboarding-role.yaml", import.meta.url), "utf8"),
  readFile(new URL("../public/sutra-customer-onboarding-role.yaml", import.meta.url), "utf8"),
  readFile(new URL(
    "../docs/customer-onboarding-role-standard-2026-08.2.md",
    import.meta.url,
  ), "utf8"),
]);

const ADVANCED_READS = Object.freeze({
  SutraFinopsCostAnomalyReadV1: [
    "ce:GetAnomalies",
    "ce:GetAnomalyMonitors",
    "ce:GetAnomalySubscriptions",
  ],
  SutraFinopsTrustedAdvisorStandardReadV1: [
    "support:DescribeTrustedAdvisorCheckResult",
    "support:DescribeTrustedAdvisorChecks",
  ],
  SutraFinopsOrganizationsTaxonomyReadV1: [
    "organizations:DescribeOrganization",
    "organizations:ListAccounts",
  ],
});

function statement(source, sid) {
  const marker = `- Sid: ${sid}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing statement ${sid}`);
  const candidates = [
    source.indexOf("\n              - Sid:", start + marker.length),
    source.indexOf("\n        - PolicyName:", start + marker.length),
    source.indexOf("\n      Tags:", start + marker.length),
    source.indexOf("\nOutputs:", start + marker.length),
  ].filter((value) => value >= 0);
  assert.ok(candidates.length > 0, `unbounded statement ${sid}`);
  return source.slice(start, Math.min(...candidates));
}

function actions(source, sid, key = "Action") {
  const block = statement(source, sid);
  const keyStart = block.indexOf(`${key}:`);
  assert.notEqual(keyStart, -1, `missing ${key} in ${sid}`);
  return [...block.slice(keyStart).matchAll(
    /^\s+- ([a-z0-9-]+:[A-Za-z0-9*]+)\s*$/gmu,
  )].map((match) => match[1]);
}

function policy(source, policyName) {
  const marker = `- PolicyName: ${policyName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing policy ${policyName}`);
  const candidates = [
    source.indexOf("\n        - PolicyName:", start + marker.length),
    source.indexOf("\n      Tags:", start + marker.length),
  ].filter((value) => value >= 0);
  assert.ok(candidates.length > 0, `unbounded policy ${policyName}`);
  return source.slice(start, Math.min(...candidates));
}

function policyActions(source, policyName) {
  const block = policy(source, policyName);
  assert.match(block, /- Sid: ExactFinopsSourceRead/u);
  return [...block.matchAll(
    /^\s+- ([a-z0-9-]+:[A-Za-z0-9*]+)\s*$/gmu,
  )].map((match) => match[1]);
}

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing section ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `unbounded section ${startMarker}`);
  return source.slice(start, end);
}

test("standard-2026-08.2 is immutable and leaves every mutable default untouched", () => {
  assert.match(successor, /Version: standard-2026-08\.2/u);
  assert.match(successor, /Value: standard-2026-08\.2/u);
  assert.match(successor, /PermissionPackVersion:[\s\S]*Value: standard-2026-08\.2/u);
  assert.match(previous, /Version: standard-2026-08\.1/u);
  assert.doesNotMatch(previous, /standard-2026-08\.2/u);
  assert.match(current, /Value: standard-2026-07\.4/u);
  assert.match(publicDefault, /Value: standard-2026-07\.4/u);
  assert.doesNotMatch(current, /standard-2026-08\.2/u);
  assert.doesNotMatch(publicDefault, /standard-2026-08\.2/u);
  assert.match(runbook, /has not been\s+published or\s+deployed/u);
  assert.match(runbook, /Do not overwrite/u);
});

test("the 08.2 deny ceiling adds exactly four reviewed reads to immutable 08.1", () => {
  const prior = actions(previous, "DenyUnimplementedActions", "NotAction");
  const next = actions(successor, "DenyUnimplementedActions", "NotAction");
  const additions = next.filter((action) => !prior.includes(action));
  assert.deepEqual(additions, [
    ...ADVANCED_READS.SutraFinopsTrustedAdvisorStandardReadV1,
    ...ADVANCED_READS.SutraFinopsOrganizationsTaxonomyReadV1,
  ]);
  assert.deepEqual(prior.filter((action) => !next.includes(action)), []);
  assert.equal(new Set(next).size, next.length);
  assert.match(statement(successor, "DenyUnimplementedActions"), /Effect: Deny/u);
});

test("each source policy grants exactly its compiled read contract", () => {
  const expectedPolicies = [
    "SutraFinopsCostAnomalyReadV1",
    "SutraFinopsTrustedAdvisorStandardReadV1",
    "SutraFinopsOrganizationsTaxonomyReadV1",
  ];
  for (const policy of expectedPolicies) {
    assert.equal(
      [...successor.matchAll(new RegExp(`PolicyName: ${policy}`, "gu"))].length,
      1,
      `${policy} must occur exactly once`,
    );
  }
  for (const [policyName, expected] of Object.entries(ADVANCED_READS)) {
    const block = policy(successor, policyName);
    assert.deepEqual(policyActions(successor, policyName), expected);
    assert.match(block, /Effect: Allow/u);
    assert.match(block, /Resource: '\*'/u);
    assert.doesNotMatch(block, /Action:\s*['"]?\*['"]?/u);
    for (const action of expected) {
      assert.equal(
        [...successor.matchAll(new RegExp(
          `^\\s+- ${action.replace(/[.*+?^\${}()|[\]\\]/gu, "\\$&")}\\s*$`,
          "gmu",
        ))].length,
        2,
        `${action} must occur only in the ceiling and its exact policy`,
      );
    }
  }
});

test("trust, parameters, metadata grants, and attestation are preserved from 08.1", () => {
  assert.equal(
    section(successor, "Parameters:", "Conditions:"),
    section(previous, "Parameters:", "Conditions:"),
  );
  assert.equal(
    section(successor, "      AssumeRolePolicyDocument:", "      Policies:"),
    section(previous, "      AssumeRolePolicyDocument:", "      Policies:"),
  );
  assert.deepEqual(
    actions(successor, "ImplementedMetadataApis"),
    actions(previous, "ImplementedMetadataApis"),
  );
  assert.deepEqual(
    actions(successor, "TrustContractAttestation"),
    actions(previous, "TrustContractAttestation"),
  );
  assert.match(successor, /sts:ExternalId:[\s\S]*Ref: ExternalId/u);
  assert.match(successor, /Path: \/sutra\//u);
  assert.match(successor, /MaxSessionDuration: 3600/u);
});

test("advanced sources stay read-only and the base role still does not grant export access", () => {
  const sourceActions = Object.values(ADVANCED_READS).flat();
  for (const action of sourceActions) {
    assert.match(action, /^[a-z0-9-]+:(?:Describe|Get|List)/u);
  }
  assert.doesNotMatch(
    successor,
    /(?:organizations|support|ce):(Create|Update|Delete|Enable|Disable)|Action:\s*['"]?\*['"]?/u,
  );
  for (const action of [
    "s3:ListBucket",
    "s3:GetBucketLocation",
    "s3:GetObject",
    "s3:GetObjectAttributes",
    "kms:Decrypt",
    "bcm-data-exports:ListExports",
    "bcm-data-exports:GetExport",
  ]) {
    assert.equal(
      [...successor.matchAll(new RegExp(
        `^\\s+- ${action.replace(/[.*+?^\${}()|[\]\\]/gu, "\\$&")}\\s*$`,
        "gmu",
      ))].length,
      1,
      `${action} must remain ceiling-only`,
    );
  }
});

test("the runbook pins the commercial-partition us-east-1 source boundary", () => {
  assert.match(runbook, /commercial `aws` partition/u);
  assert.match(runbook, /`us-east-1`/u);
  assert.match(runbook, /fail closed/u);
  assert.match(runbook, /source\s+contract/u);
});

test("the immutable template stays below the direct CloudFormation body limit", async () => {
  const metadata = await stat(new URL(
    "../infrastructure/customer-onboarding-role-standard-2026-08.2.yaml",
    import.meta.url,
  ));
  assert.ok(metadata.size < 51_200, `template is ${metadata.size} bytes`);
});
