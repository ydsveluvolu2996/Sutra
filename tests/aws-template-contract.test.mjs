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

test("live demo customer role is the reviewed public artifact", async () => {
  const infrastructure = await readFile(
    resolve(root, "infrastructure/customer-role-live-demo.yaml"),
    "utf8",
  );
  const publicArtifact = await readFile(
    resolve(root, "public/sutra-customer-role-live-demo.yaml"),
    "utf8",
  );

  assert.equal(publicArtifact, infrastructure);
  assert.equal(
    createHash("sha256").update(infrastructure, "utf8").digest("hex"),
    AWS_CUSTOMER_ROLE_TEMPLATE_SHA256,
  );
  assert.equal(AWS_CUSTOMER_ROLE_TEMPLATE_VERSION, "live-demo-2026-07");
  for (const action of [
    "ec2:DescribeRegions",
    "ec2:DescribeInstances",
    "ec2:DescribeVpcs",
    "ec2:DescribeSubnets",
    "ec2:DescribeSecurityGroups",
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
    "guardduty:ListDetectors",
    "guardduty:GetDetector",
    "securityhub:DescribeHub",
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
  assert.match(infrastructure, /sts:RoleSessionName:/);
  assert.match(infrastructure, /AllowedValues:\s*\n\s*- SutraReadOnlyRole/u);
  assert.match(infrastructure, /Path: \/sutra\//u);
  assert.match(infrastructure, /Sid: TrustContractAttestation/u);
  assert.match(infrastructure, /sutra:permission-pack[\s\S]+live-demo-2026-07/u);
  assert.match(infrastructure, /PermissionPackVersion:[\s\S]+live-demo-2026-07/u);
});

test("local collector role can only assume the fixed Sutra customer role", async () => {
  const template = await readFile(
    resolve(root, "infrastructure/local-collector-role.yaml"),
    "utf8",
  );

  assert.match(template, /Action: sts:AssumeRole/);
  assert.match(template, /CustomerRoleName:[\s\S]+AllowedValues:\s*\n\s*- SutraReadOnlyRole/u);
  assert.match(
    template,
    /arn:\$\{AWS::Partition\}:iam::\*:role\/sutra\/\$\{CustomerRoleName\}/,
  );
  assert.doesNotMatch(template, /Action:\s*['"]?\*['"]?/);
  assert.doesNotMatch(template, /Principal:\s*['"]?\*['"]?/);
  assert.doesNotMatch(template, /AccessKey/);
});
