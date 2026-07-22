import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCustomerManagedRoleArtifacts,
  CUSTOMER_ROLE_ATTESTATION_ACTIONS,
  CUSTOMER_ROLE_METADATA_ACTIONS,
  SUTRA_ROLE_POLICY_NAME,
  validateCustomerManagedRoleSelection,
  type CustomerManagedRoleArtifactInput,
} from "../lib/aws-customer-role-artifacts.ts";

const input: CustomerManagedRoleArtifactInput = {
  partition: "aws",
  accountId: "123456789012",
  collectorPrincipal: "arn:aws:iam::210987654321:role/sutra-collector/SutraCollectorRole",
  externalId: "sutra_ext_0123456789abcdef0123456789abcdef",
  roleSessionName: "sutra-",
  customerTenantId: "cus_0123456789abcdef",
  permissionPackVersion: "standard-2026-07.2",
  rolePath: "/sutra/acme-production/",
  roleName: "SutraCustomerReadOnly",
};

test("customer-role generators produce exact deterministic trust and a dedicated role ARN", () => {
  const first = buildCustomerManagedRoleArtifacts(input);
  const second = buildCustomerManagedRoleArtifacts({ ...input });
  assert.deepEqual(first, second);
  assert.equal(
    first.roleArn,
    "arn:aws:iam::123456789012:role/sutra/acme-production/SutraCustomerReadOnly",
  );

  const trust = JSON.parse(first.trustPolicyJson) as {
    Statement: Array<Record<string, unknown>>;
  };
  assert.deepEqual(trust.Statement, [
    {
      Sid: "ExactCollectorWithConnectionExternalId",
      Effect: "Allow",
      Principal: { AWS: input.collectorPrincipal },
      Action: "sts:AssumeRole",
      Condition: {
        StringEquals: { "sts:ExternalId": input.externalId },
        StringLike: { "sts:RoleSessionName": "sutra-*" },
      },
    },
  ]);
  assert.doesNotMatch(first.trustPolicyJson, /"AWS":\s*"\*"|:root/u);
});

test("CloudFormation and Terraform include the exact trust, tags, inline contract, and explicit deny ceiling", () => {
  const artifacts = buildCustomerManagedRoleArtifacts(input);
  const expectedCeiling = [...CUSTOMER_ROLE_METADATA_ACTIONS, ...CUSTOMER_ROLE_ATTESTATION_ACTIONS];

  assert.match(artifacts.cloudFormationYaml, /Path: '\/sutra\/acme-production\/'/u);
  assert.match(artifacts.cloudFormationYaml, /RoleName: 'SutraCustomerReadOnly'/u);
  assert.match(artifacts.cloudFormationYaml, /Sid: DenyUnimplementedActions[\s\S]+Effect: Deny[\s\S]+NotAction:/u);
  assert.match(artifacts.cloudFormationYaml, new RegExp(`PolicyName: ${SUTRA_ROLE_POLICY_NAME}`, "u"));
  assert.match(artifacts.cloudFormationYaml, /Key: 'sutra:managed-by'[\s\S]+Value: customer/u);
  assert.match(artifacts.cloudFormationYaml, /Key: 'sutra:permission-pack'[\s\S]+standard-2026-07.2/u);
  assert.match(artifacts.cloudFormationYaml, /MaxSessionDuration: 3600/u);
  for (const action of expectedCeiling) {
    assert.match(artifacts.cloudFormationYaml, new RegExp(`- ${action.replaceAll("*", "\\*")}`, "u"));
  }
  for (const forbidden of ["s3:GetObject", "secretsmanager:GetSecretValue", "kms:Decrypt", "iam:PassRole"]) {
    assert.doesNotMatch(artifacts.cloudFormationYaml, new RegExp(forbidden, "u"));
    assert.doesNotMatch(artifacts.terraformHcl, new RegExp(forbidden, "u"));
  }

  assert.match(artifacts.terraformHcl, /resource "aws_iam_role" "sutra_customer_readonly"/u);
  assert.match(artifacts.terraformHcl, /max_session_duration = 3600/u);
  assert.match(artifacts.terraformHcl, /"sutra:managed-by"\s+= "customer"/u);
  assert.match(artifacts.terraformHcl, /"Sid": "DenyUnimplementedActions"/u);
  assert.match(artifacts.terraformHcl, /"NotAction": \[/u);
});

test("role selection stays within Sutra's dedicated namespace and rejects shared privilege names", () => {
  assert.equal(validateCustomerManagedRoleSelection("/sutra/", "SutraAcmeReadOnly"), null);
  assert.equal(validateCustomerManagedRoleSelection("/sutra/acme/prod/", "SutraAcmeReadOnly"), null);
  assert.match(validateCustomerManagedRoleSelection("/", "SutraAcmeReadOnly") ?? "", /\/sutra\//u);
  assert.match(validateCustomerManagedRoleSelection("/sutra/acme", "SutraAcmeReadOnly") ?? "", /ending with \//u);
  for (const name of [
    "Admin",
    "sutra-administrator",
    "AdministratorAccess",
    "shared-readonly",
    "breakglass-security",
    "root",
    "poweruser",
    "OrganizationAccountAccessRole",
  ]) {
    assert.match(validateCustomerManagedRoleSelection("/sutra/", name) ?? "", /not accepted/u);
  }
});

test("artifact generation fails closed for roots, wildcards, partition mismatch, and malformed handoffs", () => {
  for (const collectorPrincipal of [
    "arn:aws:iam::210987654321:root",
    "arn:aws:iam::210987654321:role/*",
    "*",
  ]) {
    assert.throws(
      () => buildCustomerManagedRoleArtifacts({ ...input, collectorPrincipal }),
      /exact IAM role ARN/u,
    );
  }
  assert.throws(
    () => buildCustomerManagedRoleArtifacts({
      ...input,
      partition: "aws-us-gov",
    }),
    /same AWS partition/u,
  );
  assert.throws(
    () => buildCustomerManagedRoleArtifacts({ ...input, externalId: "short" }),
    /External ID/u,
  );
  assert.throws(
    () => buildCustomerManagedRoleArtifacts({ ...input, roleName: "shared-admin" }),
    /not accepted/u,
  );
});
