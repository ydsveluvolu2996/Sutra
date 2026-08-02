import assert from "node:assert/strict";
import test from "node:test";
import {
  AWS_HEALTH_PERMISSION_ACTIONS,
  AWS_HEALTH_PERMISSION_CONTRACT,
  AWS_HEALTH_PERMISSION_PACK_VERSION,
  AWS_HEALTH_SESSION_ACTIONS,
  assertAwsHealthPermissionContract,
} from "../src/aws-health-permission-contract.js";
import { awsHealthSessionPolicy } from "../src/aws-health-session-policy.js";

test("Health .8.8 adds exactly seven read-only provider/prerequisite actions", () => {
  assert.equal(AWS_HEALTH_PERMISSION_PACK_VERSION, "standard-2026-08.8");
  assert.deepEqual(AWS_HEALTH_PERMISSION_ACTIONS, [
    "health:DescribeAffectedAccountsForOrganization",
    "health:DescribeAffectedEntitiesForOrganization",
    "health:DescribeEventDetailsForOrganization",
    "health:DescribeEventsForOrganization",
    "health:DescribeHealthServiceStatusForOrganization",
    "organizations:DescribeOrganization",
    "organizations:ListDelegatedAdministrators",
  ]);
  assert.deepEqual(AWS_HEALTH_PERMISSION_CONTRACT.resources, ["*"]);
  assert.deepEqual(AWS_HEALTH_PERMISSION_CONTRACT.mutableActions, []);
  assert.deepEqual(AWS_HEALTH_SESSION_ACTIONS, ["sts:GetCallerIdentity", ...AWS_HEALTH_PERMISSION_ACTIONS]);
});

test("Health STS session is the exact identity plus seven-read intersection", () => {
  const policy = JSON.parse(awsHealthSessionPolicy());
  assert.deepEqual(policy, {
    Version: "2012-10-17",
    Statement: [{
      Sid: "ReadAwsHealthOrganization",
      Effect: "Allow",
      Action: ["sts:GetCallerIdentity", ...AWS_HEALTH_PERMISSION_ACTIONS],
      Resource: "*",
    }],
  });
  assert.ok(Buffer.byteLength(JSON.stringify(policy), "utf8") <= 2_048);
});

test("Health permission attestation rejects removal, mutation, reorder and wildcard drift", () => {
  const valid = { permissionPackVersion: "standard-2026-08.8", policyName: "SutraFinopsHealthOrganizationReadV1", actions: [...AWS_HEALTH_PERMISSION_ACTIONS], resources: ["*"] };
  assert.doesNotThrow(() => assertAwsHealthPermissionContract(valid));
  for (const hostile of [
    { ...valid, permissionPackVersion: "standard-2026-08.7" },
    { ...valid, actions: valid.actions.slice(1) },
    { ...valid, actions: [...valid.actions, "health:EnableHealthServiceAccessForOrganization"] },
    { ...valid, actions: [...valid.actions].reverse() },
    { ...valid, resources: ["arn:aws:health:*:*:event/*"] },
  ]) assert.throws(() => assertAwsHealthPermissionContract(hostile), /AWS_HEALTH_PERMISSION_CONTRACT_REJECTED/u);
});
