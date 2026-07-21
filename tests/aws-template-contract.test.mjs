import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import {
  AWS_CUSTOMER_ROLE_TEMPLATE_SHA256,
  AWS_CUSTOMER_ROLE_TEMPLATE_VERSION,
} from "../lib/aws-template-contract.ts";

const root = resolve(import.meta.dirname, "..");

function statementActions(source, sid) {
  const marker = `- Sid: ${sid}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, sid);
  const following = source.indexOf("\n              - Sid:", start + marker.length);
  const block = source.slice(start, following === -1 ? source.length : following);
  return [...block.matchAll(/^\s+- ([a-z0-9*]+:[A-Za-z0-9*]+)\s*$/gmu)]
    .map((match) => match[1]);
}

test("standard customer onboarding role is the reviewed public artifact", async () => {
  const infrastructure = await readFile(
    resolve(root, "infrastructure/customer-onboarding-role.yaml"),
    "utf8",
  );
  const publicArtifact = await readFile(
    resolve(root, "public/sutra-customer-onboarding-role.yaml"),
    "utf8",
  );

  assert.equal(publicArtifact, infrastructure);
  assert.equal(
    createHash("sha256").update(infrastructure, "utf8").digest("hex"),
    AWS_CUSTOMER_ROLE_TEMPLATE_SHA256,
  );
  assert.equal(AWS_CUSTOMER_ROLE_TEMPLATE_VERSION, "standard-2026-07");
  for (const action of [
    "ec2:DescribeRegions",
    "ec2:DescribeInstances",
    "ec2:DescribeVpcs",
    "ec2:DescribeSubnets",
    "ec2:DescribeSecurityGroups",
    "ec2:DescribeVolumes",
    "ec2:DescribeNetworkInterfaces",
    "ec2:DescribeNetworkAcls",
    "ec2:DescribeRouteTables",
    "ec2:DescribeInternetGateways",
    "ec2:DescribeAddresses",
    "ec2:DescribeSnapshots",
    "elasticloadbalancing:DescribeLoadBalancers",
    "elasticloadbalancing:DescribeListeners",
    "elasticloadbalancing:DescribeTargetGroups",
    "elasticloadbalancing:DescribeTargetHealth",
    "kms:ListKeys",
    "kms:ListAliases",
    "kms:DescribeKey",
    "dynamodb:ListTables",
    "dynamodb:DescribeTable",
    "ecr:DescribeRepositories",
    "s3:ListAllMyBuckets",
    "s3:GetBucketPublicAccessBlock",
    "rds:DescribeDBInstances",
    "iam:GetAccountSummary",
    "iam:GetAccountPasswordPolicy",
    "iam:GetRole",
    "iam:ListRolePolicies",
    "iam:GetRolePolicy",
    "cloudtrail:DescribeTrails",
    "cloudtrail:GetTrailStatus",
    "cloudtrail:LookupEvents",
    "guardduty:ListDetectors",
    "guardduty:GetDetector",
    "guardduty:ListFindings",
    "guardduty:GetFindings",
    "securityhub:DescribeHub",
    "securityhub:GetFindings",
    "inspector2:BatchGetAccountStatus",
    "inspector2:ListFindings",
    "ce:GetCostAndUsage",
    "ce:GetCostForecast",
    "ssm:DescribeInstanceInformation",
    "ssm:DescribeInstancePatchStates",
    "ssm:DescribeInstancePatches",
  ]) {
    assert.match(infrastructure, new RegExp(`- ${action.replaceAll("*", "\\*")}`));
  }

  for (const forbidden of [
    "s3:GetObject",
    "secretsmanager:GetSecretValue",
    "ssm:GetParameter",
    "kms:Decrypt",
    "iam:PassRole",
    "ec2:RunInstances",
    "Principal: '*'",
  ]) {
    assert.doesNotMatch(infrastructure, new RegExp(forbidden.replaceAll("*", "\\*")));
  }
  assert.match(infrastructure, /sts:ExternalId:/);
  assert.doesNotMatch(infrastructure, /NoEcho:\s*true/u);
  assert.match(infrastructure, /sts:RoleSessionName:/);
  assert.match(infrastructure, /AllowedValues:\s*\n\s*- SutraReadOnlyRole/u);
  assert.match(infrastructure, /Path: \/sutra\//u);
  assert.match(infrastructure, /Sid: TrustContractAttestation/u);
  assert.match(infrastructure, /Sid: DenyUnimplementedActions[\s\S]+Effect: Deny[\s\S]+NotAction:/u);
  assert.match(infrastructure, /sutra:permission-pack[\s\S]+standard-2026-07/u);
  assert.match(infrastructure, /PermissionPackVersion:[\s\S]+standard-2026-07/u);

  const implemented = statementActions(infrastructure, "ImplementedMetadataApis");
  const trust = statementActions(infrastructure, "TrustContractAttestation");
  const ceiling = statementActions(infrastructure, "DenyUnimplementedActions");
  assert.deepEqual(new Set(ceiling), new Set([...implemented, ...trust]));
  assert.equal(implemented.includes("lambda:ListFunctions"), false);
});

test("local collector role can only assume the fixed Sutra customer role", async () => {
  const template = await readFile(
    resolve(root, "infrastructure/local-collector-role.yaml"),
    "utf8",
  );
  const boundary = JSON.parse(await readFile(
    resolve(root, "infrastructure/sutra-collector-boundary-policy.json"),
    "utf8",
  ));

  assert.match(template, /Action: sts:AssumeRole/);
  assert.match(template, /CustomerRoleName:[\s\S]+AllowedValues:\s*\n\s*- SutraReadOnlyRole/u);
  assert.match(
    template,
    /arn:\$\{AWS::Partition\}:iam::\*:role\/sutra\/\$\{CustomerRoleName\}/,
  );
  assert.doesNotMatch(template, /Action:\s*['"]?\*['"]?/);
  assert.doesNotMatch(template, /Principal:\s*['"]?\*['"]?/);
  assert.doesNotMatch(template, /AccessKey/);
  assert.match(
    template,
    /PermissionsBoundary:\s*\n\s*Fn::Sub: arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:policy\/SutraCollectorBoundary/u,
  );
  assert.doesNotMatch(template, /ManagedPolicyArns/u);
  assert.deepEqual(boundary, {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyEveryNonAssumeRoleAction",
        Effect: "Deny",
        NotAction: "sts:AssumeRole",
        Resource: "*",
      },
      {
        Sid: "DenyAssumeRoleOutsideFixedCustomerRole",
        Effect: "Deny",
        Action: "sts:AssumeRole",
        NotResource: "arn:aws:iam::*:role/sutra/SutraReadOnlyRole",
      },
      {
        Sid: "AssumeFixedSutraCustomerRoleOnly",
        Effect: "Allow",
        Action: "sts:AssumeRole",
        Resource: "arn:aws:iam::*:role/sutra/SutraReadOnlyRole",
      },
    ],
  });
});

test("SutraOperator permission-set policy is the exact account-scoped live contract", async () => {
  const path = resolve(root, "infrastructure/sutra-operator-permission-set-policy.json");
  const source = await readFile(path, "utf8");
  const policy = JSON.parse(source);
  assert.equal(
    createHash("sha256").update(source, "utf8").digest("hex"),
    "308f89a15bf382fec54537df18556fe9d5531dd2b9f57a8479f79d42d0a066fa",
  );
  assert.equal(policy.Version, "2012-10-17");
  assert.ok(Array.isArray(policy.Statement));
  const statements = new Map(policy.Statement.map((statement) => [statement.Sid, statement]));
  assert.deepEqual(
    new Set(statements.get("AttestExactCollectorRolePolicies")?.Action),
    new Set(["iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:ListRolePolicies"]),
  );
  assert.equal(
    statements.get("AttestExactCollectorRolePolicies")?.Resource,
    "arn:aws:iam::505060607080:role/sutra/SutraLocalCollectorRole",
  );
  assert.deepEqual(
    new Set(statements.get("ConfigureAndRecoverExactTemplateBucket")?.Action),
    new Set([
      "s3:GetBucketTagging",
      "s3:ListBucket",
      "s3:ListBucketVersions",
      "s3:PutBucketOwnershipControls",
      "s3:PutBucketPolicy",
      "s3:PutBucketPublicAccessBlock",
      "s3:PutBucketTagging",
      "s3:PutBucketVersioning",
      "s3:PutEncryptionConfiguration",
    ]),
  );
  assert.equal(
    statements.get("PublishExactReviewedTemplateObject")?.Resource,
    "arn:aws:s3:::sutra-onboarding-505060607080-us-east-1/templates/standard-2026-07/" +
      "17c7a57637dedd150114d5100ec36609437aa4c75dd353cb311e9bbcdb4b668e.yaml",
  );
  assert.equal(
    statements.get("CreateReviewedCollectorChangeSet")?.Condition?.StringEquals?.[
      "aws:RequestTag/sutra:template-sha256"
    ],
    "c8bbaa5b20b33b576ad33c930a98ea51afdb67013bd263833b16c91bcfe4006d",
  );
  const serialized = JSON.stringify(policy);
  for (const forbidden of [
    '"Action":"*"',
    "iam:AttachRolePolicy",
    "iam:CreatePolicy",
    "iam:CreatePolicyVersion",
    "iam:DeleteRolePermissionsBoundary",
    "iam:PassRole",
    "iam:SetDefaultPolicyVersion",
    "s3:GetObject",
    "s3:DeleteObject",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
