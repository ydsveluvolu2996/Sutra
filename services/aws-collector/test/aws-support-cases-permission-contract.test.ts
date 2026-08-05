import assert from "node:assert/strict";
import test from "node:test";
import {
  AWS_SUPPORT_CASES_PERMISSION_ACTIONS,
  AWS_SUPPORT_CASES_PERMISSION_CONTRACT,
  AWS_SUPPORT_CASES_PERMISSION_PACK_VERSION,
  assertAwsSupportCasesPermissionContract,
} from "../src/aws-support-cases-permission-contract.js";
import { awsSupportCasesProviderSessionPolicy } from
  "../src/aws-support-cases-session-policy.js";

test("Support Cases .8.7 contract grants exactly two account-local reads and no writes", () => {
  assert.equal(AWS_SUPPORT_CASES_PERMISSION_PACK_VERSION, "standard-2026-08.7");
  assert.deepEqual(AWS_SUPPORT_CASES_PERMISSION_ACTIONS, [
    "support:DescribeCases", "support:DescribeCommunications",
  ]);
  assert.deepEqual(AWS_SUPPORT_CASES_PERMISSION_CONTRACT.resources, ["*"]);
  assert.deepEqual(AWS_SUPPORT_CASES_PERMISSION_CONTRACT.mutableActions, []);
  assertAwsSupportCasesPermissionContract({
    permissionPackVersion: "standard-2026-08.7",
    policyName: "SutraFinopsSupportCasesReadV1",
    actions: ["support:DescribeCases", "support:DescribeCommunications"],
    resources: ["*"],
  });
});

test("Support Cases permission attestation rejects drift", () => {
  const valid = {
    permissionPackVersion: "standard-2026-08.7",
    policyName: "SutraFinopsSupportCasesReadV1",
    actions: ["support:DescribeCases", "support:DescribeCommunications"],
    resources: ["*"],
  };
  for (const hostile of [
    { ...valid, permissionPackVersion: "standard-2026-08.6" },
    { ...valid, actions: ["support:DescribeCases"] },
    { ...valid, actions: [...valid.actions, "support:AddCommunicationToCase"] },
    { ...valid, actions: [...valid.actions].reverse() },
    { ...valid, resources: ["arn:aws:support:::case/*"] },
  ]) assert.throws(() => assertAwsSupportCasesPermissionContract(hostile));
});

test("Support Cases STS session is the exact identity plus two-read intersection", () => {
  const policy = JSON.parse(awsSupportCasesProviderSessionPolicy());
  assert.deepEqual(policy, {
    Version: "2012-10-17",
    Statement: [{
      Sid: "ReadPrivacyMinimizedAwsSupportCases",
      Effect: "Allow",
      Action: [
        "sts:GetCallerIdentity",
        "support:DescribeCases",
        "support:DescribeCommunications",
      ],
      Resource: "*",
    }],
  });
  assert.ok(Buffer.byteLength(JSON.stringify(policy), "utf8") <= 2_048);
});
