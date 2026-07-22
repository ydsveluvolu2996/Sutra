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
  assert.equal(AWS_CUSTOMER_ROLE_TEMPLATE_VERSION, "standard-2026-07.2");
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
  assert.match(infrastructure, /sutra:permission-pack[\s\S]+standard-2026-07.2/u);
  assert.match(infrastructure, /PermissionPackVersion:[\s\S]+standard-2026-07.2/u);

  const implemented = statementActions(infrastructure, "ImplementedMetadataApis");
  const trust = statementActions(infrastructure, "TrustContractAttestation");
  const ceiling = statementActions(infrastructure, "DenyUnimplementedActions");
  assert.deepEqual(new Set(ceiling), new Set([...implemented, ...trust]));
  assert.equal(implemented.includes("lambda:ListFunctions"), false);
});

test("local collector role can assume only dedicated roles in the Sutra IAM namespace", async () => {
  const template = await readFile(
    resolve(root, "infrastructure/local-collector-role.yaml"),
    "utf8",
  );
  const hostedTemplate = await readFile(
    resolve(root, "deploy/ec2/cloudformation-single-node.yaml"),
    "utf8",
  );
  const boundary = JSON.parse(await readFile(
    resolve(root, "infrastructure/sutra-collector-boundary-policy.json"),
    "utf8",
  ));

  assert.match(template, /Action: sts:AssumeRole/);
  assert.match(
    template,
    /NotResource:\s*\n\s*Fn::Sub: arn:\$\{AWS::Partition\}:iam::\*:role\/sutra\/\*/u,
  );
  assert.match(
    template,
    /Resource:\s*\n\s*Fn::Sub: arn:\$\{AWS::Partition\}:iam::\*:role\/sutra\/\*/u,
  );
  assert.doesNotMatch(template, /CustomerRoleName/u);
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
        Sid: "DenyAssumeRoleOutsideSutraRoleNamespace",
        Effect: "Deny",
        Action: "sts:AssumeRole",
        NotResource: "arn:aws:iam::*:role/sutra/*",
      },
      {
        Sid: "AssumeDedicatedSutraCustomerRolesOnly",
        Effect: "Allow",
        Action: "sts:AssumeRole",
        Resource: "arn:aws:iam::*:role/sutra/*",
      },
    ],
  });

  const allowedResource = boundary.Statement[2].Resource;
  const namespacePattern = new RegExp(
    `^${allowedResource.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\\\*/gu, ".*")}$`,
    "u",
  );
  assert.equal(
    namespacePattern.test("arn:aws:iam::123456789012:role/sutra/CustomerSecurityCollector"),
    true,
  );
  assert.equal(
    namespacePattern.test("arn:aws:iam::123456789012:role/sutra/acme/security/ReadOnlyCollector"),
    true,
  );
  assert.equal(
    namespacePattern.test("arn:aws:iam::123456789012:role/AdministratorAccess"),
    false,
  );
  assert.equal(
    namespacePattern.test("arn:aws:iam::123456789012:role/operations/SharedCollector"),
    false,
  );
  assert.equal(
    namespacePattern.test("arn:aws:iam::123456789012:role/sutrax/LookalikeCollector"),
    false,
  );

  for (const sourceTemplate of [template, hostedTemplate]) {
    assert.match(sourceTemplate, /Sid: DenyAssumeRoleOutsideSutraRoleNamespace/u);
    assert.match(sourceTemplate, /Sid: AssumeDedicatedSutraCustomerRolesOnly/u);
    assert.match(sourceTemplate, /arn:\$\{AWS::Partition\}:iam::\*:role\/sutra\/\*/u);
    assert.doesNotMatch(sourceTemplate, /arn:\$\{AWS::Partition\}:iam::\*:role\/\*(?:\s|$)/u);
    assert.doesNotMatch(sourceTemplate, /role\/AdministratorAccess/u);
  }
});

test("SutraOperator permission-set policy is the exact account-scoped live contract", async () => {
  const path = resolve(root, "infrastructure/sutra-operator-permission-set-policy.json");
  const source = await readFile(path, "utf8");
  const policy = JSON.parse(source);
  assert.equal(
    createHash("sha256").update(source, "utf8").digest("hex"),
    "391fbfb39bba1237e054e9131c923065ae3ea448fcdbf0409862f60649ce57dc",
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
    "arn:aws:s3:::sutra-onboarding-505060607080-us-east-1/templates/standard-2026-07.2/" +
      "8257b9e9ba516795a3a75ca86ddca13199223f0b38fbd577797ffdd8d14eba98.yaml",
  );
  assert.equal(
    statements.get("CreateReviewedCollectorChangeSet")?.Condition?.StringEquals?.[
      "aws:RequestTag/sutra:template-sha256"
    ],
    "571c9004cfd8816509b74f3b41ae3d2cf9708a7b8a7f61097ed3b76dccf0b58e",
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
