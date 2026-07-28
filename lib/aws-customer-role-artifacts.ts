export type AwsRoleProvisioningMode = "sutra_template" | "customer_managed";

export const SUTRA_ROLE_NAMESPACE = "/sutra/";

/**
 * The role name new stacks are created with.
 *
 * Renamed from `SutraReadOnlyRole` on 2026-07-28. That name became misleading
 * once agentless snapshot scanning shipped: with that opt-in enabled the role
 * can create and share its own EBS snapshots, so an auditor reading the IAM
 * console would have been told "read only" by a role that can write. The name is
 * now mode-neutral and the stack's own `AccessMode` output states which mode was
 * actually granted.
 */
export const SUTRA_TEMPLATE_ROLE_NAME = "SutraCollectorRole";

/**
 * The pre-rename name. Still fully supported and NOT deprecated in behaviour:
 * every customer who deployed before the rename has this role, and renaming it
 * in CloudFormation would replace the role, change its ARN and break their
 * connection. Both names are accepted forever; only the default for new stacks
 * changed.
 */
export const SUTRA_TEMPLATE_ROLE_NAME_LEGACY = "SutraReadOnlyRole";

/** Every role name a Sutra-templated connection may legitimately present. */
export const SUTRA_TEMPLATE_ROLE_NAMES: readonly string[] = [
  SUTRA_TEMPLATE_ROLE_NAME,
  SUTRA_TEMPLATE_ROLE_NAME_LEGACY,
];

export const SUTRA_CUSTOM_ROLE_DEFAULT_NAME = "SutraCustomerReadOnlyRole";
export const SUTRA_ROLE_POLICY_NAME = "SutraImplementedMetadataCollectors";

/**
 * This list is the browser-safe projection of the reviewed collector contract.
 * The generated role grants no action outside this list, while the explicit
 * NotAction deny also prevents a broader attached permission from taking
 * effect. The collector independently attests the live role before every scan.
 */
export const CUSTOMER_ROLE_METADATA_ACTIONS = [
  "sts:GetCallerIdentity",
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
  "ec2:DescribeFlowLogs",
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
  "eks:ListClusters",
  "eks:DescribeCluster",
  "s3:ListAllMyBuckets",
  "s3:GetBucketPublicAccessBlock",
  "rds:DescribeDBInstances",
  "iam:GetAccountSummary",
  "iam:GetAccountPasswordPolicy",
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
  "cloudwatch:GetMetricData",
  "cloudwatch:ListMetrics",
  "ssm:DescribeInstanceInformation",
  "ssm:DescribeInstancePatchStates",
  "ssm:DescribeInstancePatches",
] as const;

export const CUSTOMER_ROLE_ATTESTATION_ACTIONS = [
  "iam:GetRole",
  "iam:ListRolePolicies",
  "iam:ListAttachedRolePolicies",
  "iam:GetRolePolicy",
] as const;

export interface CustomerManagedRoleArtifactInput {
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly accountId: string;
  readonly collectorPrincipal: string;
  readonly externalId: string;
  readonly roleSessionName: string;
  readonly customerTenantId: string;
  readonly permissionPackVersion: string;
  readonly rolePath: string;
  readonly roleName: string;
}

export interface CustomerManagedRoleArtifacts {
  readonly roleArn: string;
  readonly trustPolicyJson: string;
  readonly cloudFormationYaml: string;
  readonly terraformHcl: string;
}

const IAM_ROLE_NAME = /^[A-Za-z0-9+=,.@_-]{1,64}$/u;
const IAM_ROLE_PATH = /^\/sutra\/(?:[A-Za-z0-9+=,.@_-]+\/)*$/u;
const ACCOUNT_ID = /^[0-9]{12}$/u;
const EXTERNAL_ID = /^[A-Za-z0-9_+=,.@:/-]{20,128}$/u;
const SESSION_NAME_PREFIX = /^[A-Za-z0-9_+=,.@-]{3,32}$/u;
const TENANT_ID = /^[A-Za-z0-9._:-]{3,64}$/u;
const PERMISSION_PACK = /^[A-Za-z0-9._:-]{3,64}$/u;
const EXACT_ROLE_PRINCIPAL = /^arn:(aws|aws-us-gov|aws-cn):iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_\/-]+$/u;
const UNSAFE_ROLE_NAME = /(admin|poweruser|root|shared|operation|break[-_.]?glass)/iu;

export function validateCustomerManagedRoleSelection(
  rolePath: string,
  roleName: string,
): string | null {
  if (rolePath.length > 512 || !IAM_ROLE_PATH.test(rolePath)) {
    return "Use a dedicated path beginning with /sutra/ and ending with /. Each path segment may contain IAM-safe letters, numbers, +=,.@_-.";
  }
  if (!IAM_ROLE_NAME.test(roleName)) {
    return "Use a 1–64 character IAM role name containing only letters, numbers, +=,.@_-.";
  }
  if (UNSAFE_ROLE_NAME.test(roleName) || /organizationaccountaccessrole/iu.test(roleName)) {
    return "Administrator, power-user, root, shared, break-glass, and operational role names are not accepted. Create a dedicated Sutra read-only role.";
  }
  return null;
}

function assertArtifactInput(input: CustomerManagedRoleArtifactInput): void {
  const roleError = validateCustomerManagedRoleSelection(input.rolePath, input.roleName);
  if (roleError) throw new Error(roleError);
  if (!ACCOUNT_ID.test(input.accountId)) throw new Error("AWS account ID must contain exactly 12 digits.");
  if (!EXACT_ROLE_PRINCIPAL.test(input.collectorPrincipal)) {
    throw new Error("Collector principal must be one exact IAM role ARN; roots and wildcards are forbidden.");
  }
  const principalPartition = input.collectorPrincipal.match(EXACT_ROLE_PRINCIPAL)?.[1];
  if (principalPartition !== input.partition) {
    throw new Error("Collector principal and customer role must use the same AWS partition.");
  }
  if (!EXTERNAL_ID.test(input.externalId)) throw new Error("External ID does not match the reviewed Sutra handoff contract.");
  if (!SESSION_NAME_PREFIX.test(input.roleSessionName)) throw new Error("Role session prefix does not match the reviewed Sutra contract.");
  if (!TENANT_ID.test(input.customerTenantId)) throw new Error("Customer tenant ID does not match the reviewed Sutra contract.");
  if (!PERMISSION_PACK.test(input.permissionPackVersion)) throw new Error("Permission-pack version is invalid.");
}

function roleArn(input: CustomerManagedRoleArtifactInput): string {
  return `arn:${input.partition}:iam::${input.accountId}:role/${input.rolePath.slice(1)}${input.roleName}`;
}

function trustPolicy(input: CustomerManagedRoleArtifactInput): Record<string, unknown> {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ExactCollectorWithConnectionExternalId",
        Effect: "Allow",
        Principal: { AWS: input.collectorPrincipal },
        Action: "sts:AssumeRole",
        Condition: {
          StringEquals: { "sts:ExternalId": input.externalId },
          StringLike: { "sts:RoleSessionName": `${input.roleSessionName}*` },
        },
      },
    ],
  };
}

function permissionPolicy(
  input: CustomerManagedRoleArtifactInput,
  exactRoleArn: string,
): Record<string, unknown> {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyUnimplementedActions",
        Effect: "Deny",
        NotAction: [...CUSTOMER_ROLE_METADATA_ACTIONS, ...CUSTOMER_ROLE_ATTESTATION_ACTIONS],
        Resource: "*",
      },
      {
        Sid: "ImplementedMetadataApis",
        Effect: "Allow",
        Action: [...CUSTOMER_ROLE_METADATA_ACTIONS],
        Resource: "*",
      },
      {
        Sid: "TrustContractAttestation",
        Effect: "Allow",
        Action: [...CUSTOMER_ROLE_ATTESTATION_ACTIONS],
        Resource: exactRoleArn,
      },
    ],
  };
}

function yamlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function yamlStringList(values: readonly string[], indentation: string): string {
  return values.map((value) => `${indentation}- ${value}`).join("\n");
}

function buildCloudFormation(
  input: CustomerManagedRoleArtifactInput,
  exactRoleArn: string,
): string {
  const ceiling = [...CUSTOMER_ROLE_METADATA_ACTIONS, ...CUSTOMER_ROLE_ATTESTATION_ACTIONS];
  return `AWSTemplateFormatVersion: '2010-09-09'
Description: Exact customer-managed read-only role contract for Sutra. Generated from a one-time onboarding handoff.

Resources:
  CustomerReadRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: ${yamlQuote(input.roleName)}
      Path: ${yamlQuote(input.rolePath)}
      Description: Customer-owned, dedicated read-only metadata and posture role for Sutra.
      MaxSessionDuration: 3600
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Sid: ExactCollectorWithConnectionExternalId
            Effect: Allow
            Principal:
              AWS: ${yamlQuote(input.collectorPrincipal)}
            Action: sts:AssumeRole
            Condition:
              StringEquals:
                sts:ExternalId: ${yamlQuote(input.externalId)}
              StringLike:
                sts:RoleSessionName: ${yamlQuote(`${input.roleSessionName}*`)}
      Policies:
        - PolicyName: ${SUTRA_ROLE_POLICY_NAME}
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Sid: DenyUnimplementedActions
                Effect: Deny
                NotAction:
${yamlStringList(ceiling, "                  ")}
                Resource: '*'
              - Sid: ImplementedMetadataApis
                Effect: Allow
                Action:
${yamlStringList(CUSTOMER_ROLE_METADATA_ACTIONS, "                  ")}
                Resource: '*'
              - Sid: TrustContractAttestation
                Effect: Allow
                Action:
${yamlStringList(CUSTOMER_ROLE_ATTESTATION_ACTIONS, "                  ")}
                Resource: ${yamlQuote(exactRoleArn)}
      Tags:
        - Key: 'sutra:tenant-id'
          Value: ${yamlQuote(input.customerTenantId)}
        - Key: 'sutra:access-mode'
          Value: read-only
        - Key: 'sutra:permission-pack'
          Value: ${yamlQuote(input.permissionPackVersion)}
        - Key: 'sutra:managed-by'
          Value: customer

Outputs:
  CustomerReadRoleArn:
    Description: Register this exact ARN in the matching Sutra connection.
    Value: !GetAtt CustomerReadRole.Arn
  PermissionPackVersion:
    Description: Permission contract attested by this Sutra release.
    Value: ${yamlQuote(input.permissionPackVersion)}
`;
}

function buildTerraform(
  input: CustomerManagedRoleArtifactInput,
  exactRoleArn: string,
  exactTrustPolicy: Record<string, unknown>,
  exactPermissionPolicy: Record<string, unknown>,
): string {
  return `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0, < 7.0"
    }
  }
}

# Generated from a one-time Sutra onboarding handoff. Keep this file out of
# tickets and chat because it contains the connection-specific External ID.
resource "aws_iam_role" "sutra_customer_readonly" {
  name                 = ${JSON.stringify(input.roleName)}
  path                 = ${JSON.stringify(input.rolePath)}
  description          = "Customer-owned, dedicated read-only metadata and posture role for Sutra"
  max_session_duration = 3600
  assume_role_policy   = <<-POLICY
${JSON.stringify(exactTrustPolicy, null, 2)}
POLICY

  tags = {
    "sutra:tenant-id"       = ${JSON.stringify(input.customerTenantId)}
    "sutra:access-mode"     = "read-only"
    "sutra:permission-pack" = ${JSON.stringify(input.permissionPackVersion)}
    "sutra:managed-by"      = "customer"
  }
}

resource "aws_iam_role_policy" "sutra_implemented_metadata_collectors" {
  name   = "${SUTRA_ROLE_POLICY_NAME}"
  role   = aws_iam_role.sutra_customer_readonly.id
  policy = <<-POLICY
${JSON.stringify(exactPermissionPolicy, null, 2)}
POLICY
}

output "sutra_customer_read_role_arn" {
  description = "Register this exact ARN in the matching Sutra connection."
  value       = aws_iam_role.sutra_customer_readonly.arn
}

# Expected ARN: ${exactRoleArn}
`;
}

export function buildCustomerManagedRoleArtifacts(
  input: CustomerManagedRoleArtifactInput,
): CustomerManagedRoleArtifacts {
  assertArtifactInput(input);
  const exactRoleArn = roleArn(input);
  const exactTrustPolicy = trustPolicy(input);
  const exactPermissionPolicy = permissionPolicy(input, exactRoleArn);
  return {
    roleArn: exactRoleArn,
    trustPolicyJson: `${JSON.stringify(exactTrustPolicy, null, 2)}\n`,
    cloudFormationYaml: buildCloudFormation(input, exactRoleArn),
    terraformHcl: buildTerraform(input, exactRoleArn, exactTrustPolicy, exactPermissionPolicy),
  };
}
