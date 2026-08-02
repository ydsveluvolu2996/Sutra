import { createHash } from "node:crypto";

import {
  AssumeRoleCommand,
  GetCallerIdentityCommand,
  STSClient,
} from "@aws-sdk/client-sts";
import {
  GetRoleCommand,
  GetRolePolicyCommand,
  IAMClient,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
} from "@aws-sdk/client-iam";

import {
  AssumeRoleDeniedError,
  AssumeRoleFailedError,
  CallerIdentityFailedError,
  ConnectionIntegrityError,
  ConnectionNotFoundError,
  ConnectionScopeViolationError,
  ConnectionStateError,
  IdentityMismatchError,
  NegativeProbeInconclusiveError,
  StsResponseError,
  UnsafeTrustPolicyError,
  type AssumeRoleClient,
  type AwsConnectionStatus,
  type AwsPartition,
  type AwsRoleProvisioningMode,
  type AwsTemporaryCredentials,
  type CallerIdentityClientFactory,
  type ConnectionScope,
  type ComputeOptimizerExportLaunchContract,
  type ComputeOptimizerExportObjectContract,
  type FoundationalFinopsAddOnContract,
  type FoundationalFinopsBindingRequest,
  type FinopsSourceContract,
  type NegativeExternalIdProbe,
  type OnboardingTrustVerification,
  type ParsedIamRoleArn,
  type PermissionPackVersion,
  type PermissionCapabilityAssessment,
  type RoleContractClient,
  type RoleContractClientFactory,
  type ScopedConnectionRegistry,
  type StoredAwsConnection,
  type ValidatedRoleSession,
  CURRENT_PERMISSION_PACK_VERSION,
  FOUNDATIONAL_FINOPS_PERMISSION_PACK_VERSION,
  ORGANIZATION_FINOPS_PERMISSION_PACK_VERSION,
  ADVANCED_FINOPS_PERMISSION_PACK_VERSION,
  COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_PACK_VERSION,
  COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION,
} from "./types.js";
import {
  foundationalFinopsObjectArn,
  parseFoundationalFinopsContracts,
  resolveFoundationalFinopsContract,
} from "./finops-permission-contract.js";
import {
  actionsForFinopsSourceContracts,
  FINOPS_SOURCE_DEFINITIONS,
  parseFinopsSourceContracts,
  resolveFinopsSourceContract,
} from "./finops-source-contract.js";
import {
  computeOptimizerExportObjectPrefixArn,
  computeOptimizerKmsViaService,
  parseComputeOptimizerExportObjectAddress,
  parseComputeOptimizerExportObjectContracts,
  parseComputeOptimizerExportObjectVersionIdentity,
  resolveComputeOptimizerExportObjectContract,
  type ComputeOptimizerExportObjectVersionIdentity,
} from "./compute-optimizer-export-object-contract.js";
import {
  computeOptimizerExportLaunchPrefixArn,
  parseComputeOptimizerExportLaunchObjectAddress,
  parseComputeOptimizerExportLaunchContracts,
  resolveComputeOptimizerExportLaunchContract,
  resolveComputeOptimizerExportLaunchContractForRegion,
} from "./compute-optimizer-export-launch-contract.js";
import { AWS_BUDGETS_PROVIDER_SESSION_ACTIONS } from
  "./aws-budgets-provider-adapter.js";

const IAM_ROLE_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):iam::([0-9]{12}):role\/([A-Za-z0-9_+=,.@\/-]+)$/;

const ASSUMED_ROLE_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):sts::([0-9]{12}):assumed-role\/([A-Za-z0-9_+=,.@-]+)\/([A-Za-z0-9_+=,.@-]{2,64})$/;

const ACCOUNT_ID = /^[0-9]{12}$/;
const EXTERNAL_ID = /^[A-Za-z0-9_+=,.@:/-]{20,128}$/;
const SESSION_PREFIX = /^[A-Za-z0-9_+=,.@-]{3,32}$/;
const SESSION_NAME = /^[A-Za-z0-9_+=,.@-]{2,64}$/;
const PROVIDER_EXPORT_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const EXPECTED_ROLE_PATH = "/sutra/";
// Both names are valid Sutra-template roles. `SutraCollectorRole` is what new
// stacks create; `SutraReadOnlyRole` is the pre-2026-07-28 name that every
// earlier customer still has deployed. Renaming their role in CloudFormation
// would replace it and change its ARN, breaking the connection, so the legacy
// name is accepted permanently rather than deprecated.
//
// Kept as a literal rather than imported from lib/aws-customer-role-artifacts:
// this service sets `rootDir: "."` and cannot reach the root lib. The pairing is
// held by tests/aws-customer-role-artifacts, which compares the two lists.
const EXPECTED_ROLE_NAMES = ["SutraCollectorRole", "SutraReadOnlyRole"] as const;
const ROLE_PATH = /^\/sutra\/(?:[A-Za-z0-9_+=,.@-]+\/)*$/;
const ROLE_NAME = /^[A-Za-z0-9_+=,.@-]{1,64}$/;
const UNSAFE_SHARED_ROLE_NAME =
  /(admin|poweruser|root|shared|operation|break[-_.]?glass)/iu;
const EXPECTED_POLICY_NAME = "SutraImplementedMetadataCollectors";
const PERMISSION_PACK_VERSION = CURRENT_PERMISSION_PACK_VERSION;
const FINOPS_PERMISSION_PACK_VERSION = FOUNDATIONAL_FINOPS_PERMISSION_PACK_VERSION;
const ORGANIZATION_FINOPS_PACK_VERSION = ORGANIZATION_FINOPS_PERMISSION_PACK_VERSION;
const ADVANCED_FINOPS_PACK_VERSION = ADVANCED_FINOPS_PERMISSION_PACK_VERSION;
const COMPUTE_OPTIMIZER_OBJECT_PACK_VERSION =
  COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_PACK_VERSION;
const COMPUTE_OPTIMIZER_LAUNCH_PACK_VERSION =
  COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION;
const FINOPS_SOURCES_BY_PACK = Object.freeze({
  [FINOPS_PERMISSION_PACK_VERSION]: new Set([
    "cost_anomaly_detection",
  ]),
  [ORGANIZATION_FINOPS_PACK_VERSION]: new Set([
    "cost_anomaly_detection",
    "trusted_advisor_standard_checks",
    "aws_organizations_taxonomy",
  ]),
  [ADVANCED_FINOPS_PACK_VERSION]: new Set([
    "cost_anomaly_detection",
    "trusted_advisor_standard_checks",
    "aws_organizations_taxonomy",
    "compute_optimizer_organization_export",
  ]),
  [COMPUTE_OPTIMIZER_OBJECT_PACK_VERSION]: new Set([
    "cost_anomaly_detection",
    "trusted_advisor_standard_checks",
    "aws_organizations_taxonomy",
    "compute_optimizer_organization_export",
  ]),
  [COMPUTE_OPTIMIZER_LAUNCH_PACK_VERSION]: new Set([
    "cost_anomaly_detection",
    "trusted_advisor_standard_checks",
    "aws_organizations_taxonomy",
    "compute_optimizer_organization_export",
  ]),
});

function permissionPackSupportsSource(
  permissionPackVersion: keyof typeof FINOPS_SOURCES_BY_PACK,
  sourceId: string,
): boolean {
  return FINOPS_SOURCES_BY_PACK[permissionPackVersion].has(sourceId);
}
const FINOPS_CEILING_ACTIONS = [
  "s3:ListBucket",
  "s3:GetBucketLocation",
  "s3:GetObject",
  "s3:GetObjectAttributes",
  "kms:Decrypt",
  "bcm-data-exports:ListExports",
  "bcm-data-exports:GetExport",
] as const;
const COMPUTE_OPTIMIZER_OBJECT_CEILING_ACTIONS = [
  "s3:GetObjectVersion",
  "kms:GenerateDataKey",
] as const;
/** The exact eight launch operations and 17 AWS-documented dependencies. */
export const COMPUTE_OPTIMIZER_EXPORT_LAUNCH_ACTIONS = Object.freeze([
  "compute-optimizer:ExportAutoScalingGroupRecommendations",
  "compute-optimizer:ExportEBSVolumeRecommendations",
  "compute-optimizer:ExportEC2InstanceRecommendations",
  "compute-optimizer:ExportECSServiceRecommendations",
  "compute-optimizer:ExportIdleRecommendations",
  "compute-optimizer:ExportLambdaFunctionRecommendations",
  "compute-optimizer:ExportLicenseRecommendations",
  "compute-optimizer:ExportRDSDatabaseRecommendations",
  "compute-optimizer:GetAutoScalingGroupRecommendations",
  "compute-optimizer:GetEBSVolumeRecommendations",
  "compute-optimizer:GetEC2InstanceRecommendations",
  "compute-optimizer:GetECSServiceRecommendations",
  "compute-optimizer:GetIdleRecommendations",
  "compute-optimizer:GetLambdaFunctionRecommendations",
  "compute-optimizer:GetLicenseRecommendations",
  "compute-optimizer:GetRDSDatabaseRecommendations",
  "autoscaling:DescribeAutoScalingGroups",
  "ec2:DescribeInstances",
  "ec2:DescribeVolumes",
  "ecs:ListClusters",
  "ecs:ListServices",
  "lambda:ListFunctions",
  "lambda:ListProvisionedConcurrencyConfigs",
  "rds:DescribeDBClusters",
  "rds:DescribeDBInstances",
] as const);
export const COMPUTE_OPTIMIZER_EXPORT_EXACT_DESCRIBE_ACTION =
  "compute-optimizer:DescribeRecommendationExportJobs" as const;
export const IMPLEMENTED_READ_ACTIONS = [
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
  // Flow-log CONFIGURATION only. It reports whether a VPC is observable; the
  // records themselves live in CloudWatch Logs or S3 and need permissions this
  // role deliberately does not hold.
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
  "bedrock:ListGuardrails",
  "bedrock:GetGuardrail",
  "bedrock:GetModelInvocationLoggingConfiguration",
  "bedrock:GetAccountDataRetention",
  "ce:GetCostAndUsage",
  "ce:GetCostForecast",
  "cloudwatch:GetMetricData",
  "cloudwatch:ListMetrics",
  "ssm:DescribeInstanceInformation",
  "ssm:DescribeInstancePatchStates",
  "ssm:DescribeInstancePatches",
] as const;
export const TRUST_ATTESTATION_ACTIONS = [
  "iam:GetRole",
  "iam:ListRolePolicies",
  "iam:ListAttachedRolePolicies",
  "iam:GetRolePolicy",
] as const;
/**
 * Compact read-only outer cap for STS. The customer role contract is attested
 * before every collector session and contains the exact-action deny ceiling;
 * these patterns only keep the STS payload below AWS's packed-policy limit.
 */
const SESSION_READ_ACTIONS = [
  "sts:GetCallerIdentity",
  "ec2:Describe*",
  "elasticloadbalancing:Describe*",
  "kms:List*",
  "kms:Describe*",
  "dynamodb:List*",
  "dynamodb:Describe*",
  "ecr:Describe*",
  "eks:List*",
  "eks:Describe*",
  "s3:ListAllMyBuckets",
  "s3:GetBucketPublicAccessBlock",
  "rds:Describe*",
  "iam:GetAccountSummary",
  "iam:GetAccountPasswordPolicy",
  "iam:GetRole*",
  "iam:ListRolePolicies",
  "iam:ListAttachedRolePolicies",
  "cloudtrail:Describe*",
  "cloudtrail:GetTrailStatus",
  "cloudtrail:LookupEvents",
  "guardduty:List*",
  "guardduty:Get*",
  "securityhub:Describe*",
  "securityhub:Get*",
  "inspector2:BatchGet*",
  "inspector2:List*",
  "bedrock:ListGuardrails",
  "bedrock:GetGuardrail",
  "bedrock:GetModelInvocationLoggingConfiguration",
  "bedrock:GetAccountDataRetention",
  "ce:Get*",
  "cloudwatch:GetMetricData",
  "cloudwatch:ListMetrics",
  // Single read-family wildcard for the three SSM patch-compliance describes
  // (DescribeInstanceInformation / DescribeInstancePatchStates /
  // DescribeInstancePatches). One entry keeps the packed STS policy well under
  // its safe limit; the attested customer role supplies the exact-action ceiling.
  "ssm:Describe*",
] as const;
const EXPECTED_ACCESS_DENIALS = new Set([
  "AccessDenied",
  "AccessDeniedException",
  "NotAuthorized",
  "NotAuthorizedException",
  "UnauthorizedOperation",
]);

interface ResolvedConnection {
  readonly connection: StoredAwsConnection;
  readonly parsedRoleArn: ParsedIamRoleArn;
  readonly sessionNamePrefix: string;
  readonly roleProvisioningMode: AwsRoleProvisioningMode;
  readonly expectedRolePath: string;
  readonly expectedRoleName: string;
}

export interface AwsRoleBrokerDependencies {
  readonly registry: ScopedConnectionRegistry;
  readonly assumeRoleClient: AssumeRoleClient;
  readonly callerIdentityClientFactory: CallerIdentityClientFactory;
  readonly roleContractClientFactory: RoleContractClientFactory;
  readonly expectedPrincipalArn: string;
  readonly now?: () => Date;
}

export interface WorkloadIdentityRoleBrokerOptions {
  readonly registry: ScopedConnectionRegistry;
  readonly principalArn: string;
  readonly region?: string;
  readonly maxAttempts?: number;
}

export interface ComputeOptimizerExportObjectSessionRequest {
  readonly contractId: string;
  readonly plannedJobId: string;
  readonly region: string;
  readonly bucket: string;
  readonly objectKey: string;
  readonly versionIdentity: ComputeOptimizerExportObjectVersionIdentity;
}

export interface ComputeOptimizerExportLaunchSessionRequest {
  readonly contractId: string;
  readonly region: string;
}

export interface ComputeOptimizerExportDescribeSessionRequest {
  /** Opaque compute_optimizer_organization_export source contract identity. */
  readonly contractId: string;
  readonly region: string;
  readonly plannedJobIds: readonly string[];
}

export const AWS_BROKER_CONNECTION_TIMEOUT_MS = 5_000;
export const AWS_BROKER_REQUEST_TIMEOUT_MS = 10_000;

export interface WorkloadIdentityAwsClientConfig {
  readonly retryMode: "standard";
  readonly maxAttempts: number;
  readonly requestHandler: {
    readonly connectionTimeout: number;
    readonly requestTimeout: number;
  };
  readonly region?: string;
}

export function workloadIdentityAwsClientConfig(
  region: string | undefined,
  maxAttempts = 4,
): WorkloadIdentityAwsClientConfig {
  return {
    retryMode: "standard",
    maxAttempts,
    requestHandler: {
      connectionTimeout: AWS_BROKER_CONNECTION_TIMEOUT_MS,
      requestTimeout: AWS_BROKER_REQUEST_TIMEOUT_MS,
    },
    ...(region === undefined ? {} : { region }),
  };
}

/**
 * Parse only IAM role ARNs. Account-root, user, STS session, and malformed ARNs are
 * rejected before any AWS call is made.
 */
export function parseIamRoleArn(roleArn: string): ParsedIamRoleArn {
  const match = IAM_ROLE_ARN.exec(roleArn);
  if (match === null) {
    throw new ConnectionIntegrityError("Stored role ARN is not a valid IAM role ARN");
  }

  const partition = match[1] as AwsPartition;
  const accountId = match[2];
  const rolePathAndName = match[3];

  if (
    accountId === undefined ||
    rolePathAndName === undefined ||
    rolePathAndName.startsWith("/") ||
    rolePathAndName.endsWith("/") ||
    rolePathAndName.includes("//")
  ) {
    throw new ConnectionIntegrityError("Stored role ARN contains an invalid role path");
  }

  const roleName = rolePathAndName.split("/").at(-1);
  if (roleName === undefined || roleName.length === 0 || roleName.length > 64) {
    throw new ConnectionIntegrityError("Stored role ARN contains an invalid role name");
  }

  return {
    arn: roleArn,
    partition,
    accountId,
    rolePathAndName,
    roleName,
  };
}

/** Convenience helper used by connection-registration and authorization code. */
export function accountIdFromRoleArn(roleArn: string): string {
  return parseIamRoleArn(roleArn).accountId;
}

/**
 * Defense-in-depth cap applied to every STS session. Session policies are an
 * intersection with the role policy. This compact policy permits only read
 * families needed by Sutra; the freshly attested customer role supplies the
 * exact-action deny ceiling that also blocks direct resource-policy grants.
 */
export function readonlyMetadataSessionPolicy(roleArn: string): string {
  parseIamRoleArn(roleArn);
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: SESSION_READ_ACTIONS,
        Resource: "*",
      },
    ],
  });
  // Keep substantial headroom: a 1,073-character exact-action policy consumed
  // 107% of AWS's packed limit in live validation despite the 2,048-byte limit.
  if (policy.length > 900) {
    throw new ConnectionIntegrityError("The fixed STS session policy exceeds its safe limit");
  }
  return policy;
}

/**
 * The exact-action set an agentless snapshot scan needs on the CUSTOMER role.
 *
 * `ec2:CreateSnapshot` and `ec2:CreateTags` create the snapshot with its
 * `sutra-agentless` tag in one call — the tag has to be applied AT creation
 * because the customer role's own grant is conditioned on
 * `aws:RequestTag/sutra-agentless`. An untagged snapshot would be both
 * un-shareable and un-reapable. `ModifySnapshotAttribute` shares that snapshot
 * with the Sutra scan account so it can be copied and read.
 *
 * Reads come from the shared `ec2:Describe*` family below; nothing else is here.
 */
const SESSION_AGENTLESS_WRITE_ACTIONS = [
  "ec2:CreateSnapshot",
  "ec2:CreateTags",
  "ec2:ModifySnapshotAttribute",
] as const;

/**
 * Destructive verbs named in an explicit session-level Deny.
 *
 * Strictly speaking this is redundant: a session policy is an Allow-intersection,
 * so anything absent from the Allow list is already denied, and the customer role
 * carries its own `NeverDeleteAnything` deny. It is written out anyway because
 * the product makes a hard promise — Sutra can never delete anything in a
 * customer account — and a promise that rests only on an omission is one edit
 * away from being false. A Deny cannot be widened by a later Allow.
 */
const SESSION_AGENTLESS_DENY_ACTIONS = [
  "ec2:Delete*",
  "ec2:Detach*",
  "ec2:Terminate*",
  "ec2:Stop*",
  "ec2:Reboot*",
  // NOT a `ec2:Modify*` wildcard: that would also deny ModifySnapshotAttribute,
  // which the Allow above needs to share the snapshot. IAM wildcards are only
  // `*` and `?` — there is no character-class negation — so the volume verbs are
  // named explicitly rather than expressed as "Modify except Snapshot".
  "ec2:ModifyVolume",
  "ec2:ModifyVolumeAttribute",
  "ec2:ModifyInstanceAttribute",
  "ec2:Deregister*",
] as const;

/**
 * Session ceiling for the agentless snapshot path ONLY.
 *
 * Deliberately a separate function rather than extra entries in
 * `SESSION_READ_ACTIONS`: the collector runs on every schedule, and giving every
 * collector session the ability to create snapshots to serve one opt-in feature
 * is exactly the privilege creep the read-only session cap exists to prevent.
 * Call this only from the agentless executor's credential path, and only for a
 * connection whose customer role was deployed with agentless scanning enabled —
 * otherwise the customer role denies the write anyway and the scan fails with a
 * confusing AccessDenied instead of a readiness error.
 */
export function agentlessSnapshotSessionPolicy(roleArn: string): string {
  parseIamRoleArn(roleArn);
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      // Reads: the scan has to resolve volumes and poll snapshot progress.
      { Effect: "Allow", Action: ["sts:GetCallerIdentity", "ec2:Describe*"], Resource: "*" },
      { Effect: "Allow", Action: SESSION_AGENTLESS_WRITE_ACTIONS, Resource: "*" },
      { Effect: "Deny", Action: SESSION_AGENTLESS_DENY_ACTIONS, Resource: "*" },
    ],
  });
  if (policy.length > 900) {
    throw new ConnectionIntegrityError("The agentless STS session policy exceeds its safe limit");
  }
  return policy;
}

/**
 * Per-export STS intersection for the object broker. It intentionally excludes
 * ListBucket, bucket-location and Data Exports APIs: the chunk path needs only
 * the pinned object plus the four IAM calls required to re-attest the role.
 */
export function finopsDataExportSessionPolicy(
  roleArn: string,
  contract: FoundationalFinopsAddOnContract,
): string {
  const parsed = parseIamRoleArn(roleArn);
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: "sts:GetCallerIdentity", Resource: "*" },
      {
        Effect: "Allow",
        Action: TRUST_ATTESTATION_ACTIONS,
        Resource: roleArn,
      },
      {
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:GetObjectAttributes"],
        Resource: foundationalFinopsObjectArn(contract, parsed.partition),
      },
    ],
  });
  if (policy.length > 900) {
    throw new ConnectionIntegrityError("The FinOps STS session policy exceeds its safe limit");
  }
  return policy;
}

/** Exact STS intersection for one attested server-owned FinOps source. */
export function finopsSourceSessionPolicy(
  roleArn: string,
  contract: FinopsSourceContract,
): string {
  parseIamRoleArn(roleArn);
  const definition = FINOPS_SOURCE_DEFINITIONS[
    contract.sourceId as keyof typeof FINOPS_SOURCE_DEFINITIONS
  ];
  if (
    definition === undefined ||
    definition.implementationState !== "IMPLEMENTED" ||
    definition.permissionContractId !== contract.permissionContractId ||
    definition.policyName !== contract.policyName ||
    definition.actions.length === 0
  ) {
    throw new ConnectionIntegrityError("The FinOps source permission contract is invalid");
  }
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: "sts:GetCallerIdentity", Resource: "*" },
      { Effect: "Allow", Action: TRUST_ATTESTATION_ACTIONS, Resource: roleArn },
      { Effect: "Allow", Action: definition.actions, Resource: "*" },
    ],
  });
  if (policy.length > 900) {
    throw new ConnectionIntegrityError("The FinOps source STS session policy exceeds its safe limit");
  }
  return policy;
}

/** IAM-only first-stage session used to attest the .8.4 role and add-ons. */
export function computeOptimizerExportAttestationSessionPolicy(roleArn: string): string {
  parseIamRoleArn(roleArn);
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: "sts:GetCallerIdentity", Resource: "*" },
      { Effect: "Allow", Action: TRUST_ATTESTATION_ACTIONS, Resource: roleArn },
    ],
  });
  assertAwsInlineSessionPolicyLength(policy);
  return policy;
}

/** The activation-manifest route needs identity proof, never AWS data access. */
export function computeOptimizerActivationIdentitySessionPolicy(): string {
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Sid: "VerifyCallerIdentityOnly",
      Effect: "Allow",
      Action: "sts:GetCallerIdentity",
      Resource: "*",
    }],
  });
  assertAwsInlineSessionPolicyLength(policy);
  return policy;
}

/** Exact read-only STS intersection for the ADV-08 provider collector. */
export function awsBudgetsProviderSessionPolicy(): string {
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Sid: "ReadAwsBudgetsAndOrganizationHierarchy",
      Effect: "Allow",
      Action: AWS_BUDGETS_PROVIDER_SESSION_ACTIONS,
      Resource: "*",
    }],
  });
  assertAwsInlineSessionPolicyLength(policy);
  return policy;
}

/** Second-stage launch ceiling: caller identity plus the exact 25 operations. */
export function computeOptimizerExportLaunchSessionPolicy(): string {
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: "sts:GetCallerIdentity", Resource: "*" },
      { Effect: "Allow", Action: COMPUTE_OPTIMIZER_EXPORT_LAUNCH_ACTIONS, Resource: "*" },
    ],
  });
  assertAwsInlineSessionPolicyLength(policy);
  return policy;
}

/** Second-stage exact-ID observation ceiling; no launch, list, S3 or KMS grant. */
export function computeOptimizerExportDescribeSessionPolicy(): string {
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: "sts:GetCallerIdentity", Resource: "*" },
      {
        Effect: "Allow",
        Action: COMPUTE_OPTIMIZER_EXPORT_EXACT_DESCRIBE_ACTION,
        Resource: "*",
      },
    ],
  });
  assertAwsInlineSessionPolicyLength(policy);
  return policy;
}

/**
 * Second-stage STS intersection for exactly one provider-created object. It
 * deliberately contains no IAM attestation, bucket-listing, prefix wildcard,
 * GetObjectAttributes, write action, or neighboring object permission.
 */
export function computeOptimizerExportObjectSessionPolicy(
  contract: ComputeOptimizerExportObjectContract,
  objectArn: string,
  versionIdentity: ComputeOptimizerExportObjectVersionIdentity,
): string {
  const parsedRolePartition = /^arn:(aws|aws-us-gov|aws-cn):s3:::/u.exec(objectArn)?.[1];
  if (
    parsedRolePartition !== contract.partition ||
    objectArn.includes("*") ||
    !objectArn.startsWith(`arn:${contract.partition}:s3:::${contract.bucket}/`)
  ) throw new ConnectionIntegrityError("The Compute Optimizer object address is invalid");
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: "sts:GetCallerIdentity", Resource: "*" },
      {
        Effect: "Allow",
        Action: versionIdentity.kind === "CURRENT"
          ? "s3:GetObject"
          : "s3:GetObjectVersion",
        Resource: objectArn,
        ...(versionIdentity.kind === "VERSION"
          ? {
              Condition: {
                StringEquals: { "s3:VersionId": versionIdentity.versionId },
              },
            }
          : {}),
      },
      ...(contract.encryptionMode === "SSE_KMS"
        ? [{
            Effect: "Allow",
            Action: ["kms:Decrypt", "kms:GenerateDataKey"],
            Resource: contract.kmsKeyArn,
            Condition: {
              StringEquals: {
                "kms:ViaService": computeOptimizerKmsViaService(contract),
              },
            },
          }]
        : []),
    ],
  });
  assertAwsInlineSessionPolicyLength(policy);
  return policy;
}

/** Exact-object/version plus exact-key intersection for the SSE-KMS .8.5 bucket. */
export function computeOptimizerExportLaunchObjectSessionPolicy(
  contract: ComputeOptimizerExportLaunchContract,
  objectArn: string,
  versionIdentity: ComputeOptimizerExportObjectVersionIdentity,
): string {
  if (
    objectArn.includes("*") ||
    !objectArn.startsWith(`arn:${contract.partition}:s3:::${contract.bucket}/${contract.effectivePrefix}`)
  ) throw new ConnectionIntegrityError("The Compute Optimizer launch object address is invalid");
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: "sts:GetCallerIdentity", Resource: "*" },
      {
        Effect: "Allow",
        Action: versionIdentity.kind === "CURRENT" ? "s3:GetObject" : "s3:GetObjectVersion",
        Resource: objectArn,
        ...(versionIdentity.kind === "VERSION"
          ? { Condition: { StringEquals: { "s3:VersionId": versionIdentity.versionId } } }
          : {}),
      },
      {
        Effect: "Allow",
        Action: ["kms:Decrypt", "kms:GenerateDataKey"],
        Resource: contract.kmsKeyArn,
        Condition: {
          StringEquals: {
            "kms:ViaService": computeOptimizerKmsViaService(contract),
          },
        },
      },
    ],
  });
  assertAwsInlineSessionPolicyLength(policy);
  return policy;
}

function assertAwsInlineSessionPolicyLength(policy: string): void {
  // STS documents a 2,048-character plaintext aggregate limit for inline JSON.
  if (policy.length > 2_048) {
    throw new ConnectionIntegrityError("The exact STS session policy exceeds AWS limits");
  }
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("unexpected policy fields");
  }
}

function policyDocument(value: string | undefined): JsonRecord {
  if (value === undefined || value.length === 0 || value.length > 32_768) {
    throw new Error("missing policy document");
  }
  const source = value.trimStart().startsWith("{") ? value : decodeURIComponent(value);
  return record(JSON.parse(source) as unknown);
}

function stringList(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("expected string list");
  }
  return value as string[];
}

function sameStringSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

function assertActiveProvisioningSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new ConnectionStateError();
}

async function awaitWithActiveProvisioningSignal<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  assertActiveProvisioningSignal(signal);
  const result = await operation();
  assertActiveProvisioningSignal(signal);
  return result;
}

function assertExpectedTrustPolicy(
  value: string | undefined,
  externalId: string,
  sessionNamePrefix: string,
  expectedPrincipalArn: string,
): void {
  const document = policyDocument(value);
  exactKeys(document, ["Version", "Statement"]);
  if (document.Version !== "2012-10-17" || !Array.isArray(document.Statement) || document.Statement.length !== 1) {
    throw new Error("unexpected trust policy shape");
  }
  const statement = record(document.Statement[0]);
  exactKeys(statement, ["Sid", "Effect", "Principal", "Action", "Condition"]);
  if (
    statement.Sid !== "ExactCollectorWithConnectionExternalId" ||
    statement.Effect !== "Allow" ||
    !sameStringSet(stringList(statement.Action), ["sts:AssumeRole"])
  ) {
    throw new Error("unexpected trust statement");
  }
  const principal = record(statement.Principal);
  exactKeys(principal, ["AWS"]);
  if (!sameStringSet(stringList(principal.AWS), [expectedPrincipalArn])) {
    throw new Error("unexpected trust principal");
  }
  const condition = record(statement.Condition);
  exactKeys(condition, ["StringEquals", "StringLike"]);
  const equals = record(condition.StringEquals);
  const like = record(condition.StringLike);
  exactKeys(equals, ["sts:ExternalId"]);
  exactKeys(like, ["sts:RoleSessionName"]);
  if (
    equals["sts:ExternalId"] !== externalId ||
    like["sts:RoleSessionName"] !== `${sessionNamePrefix}*`
  ) {
    throw new Error("unexpected trust conditions");
  }
}

function assertExpectedPermissionPolicy(
  value: string | undefined,
  roleArn: string,
  provisioningMode: AwsRoleProvisioningMode,
  permissionPackVersion:
    | typeof PERMISSION_PACK_VERSION
    | typeof FINOPS_PERMISSION_PACK_VERSION
    | typeof ORGANIZATION_FINOPS_PACK_VERSION
    | typeof ADVANCED_FINOPS_PACK_VERSION
    | typeof COMPUTE_OPTIMIZER_OBJECT_PACK_VERSION
    | typeof COMPUTE_OPTIMIZER_LAUNCH_PACK_VERSION = PERMISSION_PACK_VERSION,
  additionalCeilingActions: readonly string[] = [],
): PermissionCapabilityAssessment {
  const document = policyDocument(value);
  exactKeys(document, ["Version", "Statement"]);
  if (document.Version !== "2012-10-17" || !Array.isArray(document.Statement) || document.Statement.length !== 3) {
    throw new Error("unexpected permission policy shape");
  }
  const statements = document.Statement.map(record);
  const ceiling = statements.find((statement) => statement.Sid === "DenyUnimplementedActions");
  const metadata = statements.find((statement) => statement.Sid === "ImplementedMetadataApis");
  const attestation = statements.find((statement) => statement.Sid === "TrustContractAttestation");
  if (ceiling === undefined || metadata === undefined || attestation === undefined) {
    throw new Error("missing permission statement");
  }
  exactKeys(ceiling, ["Sid", "Effect", "NotAction", "Resource"]);
  exactKeys(metadata, ["Sid", "Effect", "Action", "Resource"]);
  exactKeys(attestation, ["Sid", "Effect", "Action", "Resource"]);
  const metadataActions = stringList(metadata.Action);
  const implemented = new Set<string>(IMPLEMENTED_READ_ACTIONS);
  if (
    ceiling.Effect !== "Deny" ||
    ceiling.Resource !== "*" ||
    !sameStringSet(
      stringList(ceiling.NotAction),
      [...new Set([
        ...IMPLEMENTED_READ_ACTIONS,
        ...TRUST_ATTESTATION_ACTIONS,
        ...(permissionPackVersion === FINOPS_PERMISSION_PACK_VERSION
            || permissionPackVersion === ORGANIZATION_FINOPS_PACK_VERSION
            || permissionPackVersion === ADVANCED_FINOPS_PACK_VERSION
            || permissionPackVersion === COMPUTE_OPTIMIZER_OBJECT_PACK_VERSION
            || permissionPackVersion === COMPUTE_OPTIMIZER_LAUNCH_PACK_VERSION
          ? FINOPS_CEILING_ACTIONS
          : []),
        ...(permissionPackVersion === COMPUTE_OPTIMIZER_OBJECT_PACK_VERSION
            || permissionPackVersion === COMPUTE_OPTIMIZER_LAUNCH_PACK_VERSION
          ? COMPUTE_OPTIMIZER_OBJECT_CEILING_ACTIONS
          : []),
        ...(permissionPackVersion === COMPUTE_OPTIMIZER_LAUNCH_PACK_VERSION
          ? COMPUTE_OPTIMIZER_EXPORT_LAUNCH_ACTIONS
          : []),
        ...additionalCeilingActions,
      ])],
    ) ||
    metadata.Effect !== "Allow" ||
    metadata.Resource !== "*" ||
    metadataActions.length !== new Set(metadataActions).size ||
    metadataActions.some((action) => !implemented.has(action)) ||
    (provisioningMode === "sutra_template" &&
      !sameStringSet(metadataActions, IMPLEMENTED_READ_ACTIONS)) ||
    attestation.Effect !== "Allow" ||
    attestation.Resource !== roleArn ||
    !sameStringSet(stringList(attestation.Action), TRUST_ATTESTATION_ACTIONS)
  ) {
    throw new Error("unexpected permission policy");
  }
  const granted = new Set(metadataActions);
  return {
    grantedActions: IMPLEMENTED_READ_ACTIONS.filter((action) => granted.has(action)),
    missingActions: IMPLEMENTED_READ_ACTIONS.filter((action) => !granted.has(action)),
  };
}

function assertFinopsSourcePolicy(
  value: string | undefined,
  contract: FinopsSourceContract,
): void {
  const definition = FINOPS_SOURCE_DEFINITIONS[
    contract.sourceId as keyof typeof FINOPS_SOURCE_DEFINITIONS
  ];
  if (
    definition === undefined ||
    definition.implementationState !== "IMPLEMENTED" ||
    definition.permissionContractId !== contract.permissionContractId ||
    definition.policyName !== contract.policyName ||
    definition.actions.length === 0
  ) throw new Error("unsupported FinOps source permission contract");
  const document = policyDocument(value);
  exactKeys(document, ["Version", "Statement"]);
  if (
    document.Version !== "2012-10-17" ||
    !Array.isArray(document.Statement) ||
    document.Statement.length !== 1
  ) throw new Error("unexpected FinOps source policy shape");
  const statement = record(document.Statement[0]);
  exactKeys(statement, ["Sid", "Effect", "Action", "Resource"]);
  if (
    statement.Sid !== "ExactFinopsSourceRead" ||
    statement.Effect !== "Allow" ||
    statement.Resource !== "*" ||
    !sameStringSet(stringList(statement.Action), definition.actions)
  ) throw new Error("unexpected FinOps source permission policy");
}

function assertComputeOptimizerExportLaunchPolicy(
  value: string | undefined,
  contract: ComputeOptimizerExportLaunchContract,
): void {
  const document = policyDocument(value);
  exactKeys(document, ["Version", "Statement"]);
  if (
    document.Version !== "2012-10-17" || !Array.isArray(document.Statement) ||
    document.Statement.length !== 3
  ) throw new Error("unexpected Compute Optimizer launch policy shape");
  const statements = document.Statement.map(record);
  const exactStatement = (sid: string): JsonRecord => {
    const matches = statements.filter((statement) => statement.Sid === sid);
    if (matches.length !== 1) throw new Error("missing or duplicate launch statement");
    return matches[0] as JsonRecord;
  };
  const launch = exactStatement("LaunchAllDocumentedComputeOptimizerExports");
  const dependencies = exactStatement("ReadDocumentedComputeOptimizerExportDependencies");
  const objects = exactStatement("ReadSealedComputeOptimizerExportPrefix");
  for (const statement of [launch, dependencies, objects]) {
    exactKeys(statement, ["Sid", "Effect", "Action", "Resource"]);
    if (statement.Effect !== "Allow") throw new Error("unexpected launch permission effect");
  }
  if (
    launch.Resource !== "*" || dependencies.Resource !== "*" ||
    !sameStringSet(
      stringList(launch.Action),
      COMPUTE_OPTIMIZER_EXPORT_LAUNCH_ACTIONS.slice(0, 8),
    ) ||
    !sameStringSet(
      stringList(dependencies.Action),
      COMPUTE_OPTIMIZER_EXPORT_LAUNCH_ACTIONS.slice(8),
    ) ||
    !sameStringSet(stringList(objects.Action), ["s3:GetObject", "s3:GetObjectVersion"]) ||
    objects.Resource !== computeOptimizerExportLaunchPrefixArn(contract)
  ) throw new Error("unexpected Compute Optimizer launch permission policy");
}

function assertExpectedRole(
  role: Awaited<ReturnType<RoleContractClient["getRole"]>>,
  resolved: ResolvedConnection,
  expectedPrincipalArn: string,
  permissionPackVersion:
    | typeof PERMISSION_PACK_VERSION
    | typeof FINOPS_PERMISSION_PACK_VERSION
    | typeof ORGANIZATION_FINOPS_PACK_VERSION
    | typeof ADVANCED_FINOPS_PACK_VERSION
    | typeof COMPUTE_OPTIMIZER_OBJECT_PACK_VERSION
    | typeof COMPUTE_OPTIMIZER_LAUNCH_PACK_VERSION = PERMISSION_PACK_VERSION,
): void {
  const expectedRolePathAndName =
    `${resolved.expectedRolePath.slice(1)}${resolved.expectedRoleName}`;
  if (
    resolved.parsedRoleArn.rolePathAndName !== expectedRolePathAndName ||
    role.arn !== resolved.connection.roleArn ||
    role.roleName !== resolved.expectedRoleName ||
    role.path !== resolved.expectedRolePath ||
    role.maxSessionDuration !== 3_600
  ) {
    throw new Error("unexpected customer role identity");
  }
  const tags = new Map<string, string>();
  for (const tag of role.tags ?? []) {
    if (tag.key === undefined || tag.value === undefined || tags.has(tag.key)) {
      throw new Error("invalid role tags");
    }
    tags.set(tag.key, tag.value);
  }
  if (
    tags.get("sutra:access-mode") !== "read-only" ||
    tags.get("sutra:permission-pack") !== permissionPackVersion ||
    tags.get("sutra:managed-by") !==
      (resolved.roleProvisioningMode === "sutra_template" ? "cloudformation" : "customer")
  ) {
    throw new Error("role attestation tags are missing");
  }
  assertExpectedTrustPolicy(
    role.assumeRolePolicyDocument,
    resolved.connection.externalId,
    resolved.sessionNamePrefix,
    expectedPrincipalArn,
  );
}

function assertFoundationalFinopsPolicy(
  value: string | undefined,
  contract: FoundationalFinopsAddOnContract,
  partition: AwsPartition,
): void {
  const document = policyDocument(value);
  exactKeys(document, ["Version", "Statement"]);
  const expectedCount =
    contract.contractId === "foundational-cur2-export-v1" ? 5 : 4;
  if (
    document.Version !== "2012-10-17" ||
    !Array.isArray(document.Statement) ||
    document.Statement.length !== expectedCount
  ) {
    throw new Error("unexpected Foundational FinOps policy shape");
  }
  const statements = document.Statement.map(record);
  const statement = (sid: string): JsonRecord => {
    const matches = statements.filter((candidate) => candidate.Sid === sid);
    if (matches.length !== 1) throw new Error("missing or duplicate FinOps statement");
    return matches[0] as JsonRecord;
  };
  const bucketArn = `arn:${partition}:s3:::${contract.bucket}`;
  const objectArn = foundationalFinopsObjectArn(contract, partition);
  const prefixRoot = contract.prefix.slice(0, -1);

  const listSid = contract.contractId === "foundational-cur2-export-v1"
    ? "ListOnlyExactFoundationalExportPrefix"
    : "ListOnlyExactFocus12ExportPrefix";
  const list = statement(listSid);
  exactKeys(list, ["Sid", "Effect", "Action", "Resource", "Condition"]);
  const condition = record(list.Condition);
  exactKeys(condition, ["StringLike"]);
  const like = record(condition.StringLike);
  exactKeys(like, ["s3:prefix"]);
  if (
    list.Effect !== "Allow" ||
    !sameStringSet(stringList(list.Action), ["s3:ListBucket"]) ||
    list.Resource !== bucketArn ||
    !sameStringSet(stringList(like["s3:prefix"]), [prefixRoot, `${prefixRoot}/*`])
  ) {
    throw new Error("unexpected FinOps list permission");
  }

  const locationSid = contract.contractId === "foundational-cur2-export-v1"
    ? "ReadDedicatedBucketLocation"
    : "ReadDedicatedFocus12BucketLocation";
  const location = statement(locationSid);
  exactKeys(location, ["Sid", "Effect", "Action", "Resource"]);
  if (
    location.Effect !== "Allow" ||
    !sameStringSet(stringList(location.Action), ["s3:GetBucketLocation"]) ||
    location.Resource !== bucketArn
  ) {
    throw new Error("unexpected FinOps bucket permission");
  }

  const objectSid = contract.contractId === "foundational-cur2-export-v1"
    ? "ReadOnlyExactFoundationalExportObjects"
    : "ReadOnlyExactFocus12ExportObjects";
  const objects = statement(objectSid);
  exactKeys(objects, ["Sid", "Effect", "Action", "Resource"]);
  if (
    objects.Effect !== "Allow" ||
    !sameStringSet(
      stringList(objects.Action),
      ["s3:GetObject", "s3:GetObjectAttributes"],
    ) ||
    objects.Resource !== objectArn
  ) {
    throw new Error("unexpected FinOps object permission");
  }

  if (contract.contractId === "foundational-cur2-export-v1") {
    const listExports = statement("ListDataExports");
    exactKeys(listExports, ["Sid", "Effect", "Action", "Resource"]);
    if (
      listExports.Effect !== "Allow" ||
      !sameStringSet(stringList(listExports.Action), ["bcm-data-exports:ListExports"]) ||
      listExports.Resource !== "*"
    ) {
      throw new Error("unexpected Data Exports list permission");
    }
  }

  const exportSid = contract.contractId === "foundational-cur2-export-v1"
    ? "ReadOnlyThisDataExport"
    : "ReadOnlyThisFocus12ExportStatus";
  const dataExport = statement(exportSid);
  exactKeys(dataExport, ["Sid", "Effect", "Action", "Resource"]);
  if (
    dataExport.Effect !== "Allow" ||
    !sameStringSet(stringList(dataExport.Action), ["bcm-data-exports:GetExport"]) ||
    dataExport.Resource !== contract.exportArn
  ) {
    throw new Error("unexpected Data Export permission");
  }
}

function assertComputeOptimizerExportObjectPolicy(
  value: string | undefined,
  contract: ComputeOptimizerExportObjectContract,
): void {
  const document = policyDocument(value);
  exactKeys(document, ["Version", "Statement"]);
  const expectedCount = contract.encryptionMode === "SSE_KMS" ? 2 : 1;
  if (
    document.Version !== "2012-10-17" ||
    !Array.isArray(document.Statement) ||
    document.Statement.length !== expectedCount
  ) throw new Error("unexpected Compute Optimizer object policy shape");
  const statements = document.Statement.map(record);
  const objectStatements = statements.filter((statement) =>
    statement.Sid === "ReadSealedComputeOptimizerExportPrefix"
  );
  if (objectStatements.length !== 1) throw new Error("missing object-prefix statement");
  const objectStatement = objectStatements[0] as JsonRecord;
  exactKeys(objectStatement, ["Sid", "Effect", "Action", "Resource"]);
  if (
    objectStatement.Effect !== "Allow" ||
    !sameStringSet(
      stringList(objectStatement.Action),
      ["s3:GetObject", "s3:GetObjectVersion"],
    ) ||
    objectStatement.Resource !== computeOptimizerExportObjectPrefixArn(contract)
  ) throw new Error("unexpected Compute Optimizer object-prefix permission");

  const kmsStatements = statements.filter((statement) =>
    statement.Sid === "UseExactExportKeyThroughRegionalS3"
  );
  if (contract.encryptionMode === "SSE_S3") {
    if (kmsStatements.length !== 0 || contract.kmsKeyArn !== null) {
      throw new Error("unexpected Compute Optimizer KMS permission");
    }
    return;
  }
  if (kmsStatements.length !== 1 || contract.kmsKeyArn === null) {
    throw new Error("missing Compute Optimizer KMS permission");
  }
  const kms = kmsStatements[0] as JsonRecord;
  exactKeys(kms, ["Sid", "Effect", "Action", "Resource", "Condition"]);
  const condition = record(kms.Condition);
  exactKeys(condition, ["StringEquals"]);
  const equals = record(condition.StringEquals);
  exactKeys(equals, ["kms:ViaService"]);
  if (
    kms.Effect !== "Allow" ||
    !sameStringSet(stringList(kms.Action), ["kms:Decrypt", "kms:GenerateDataKey"]) ||
    kms.Resource !== contract.kmsKeyArn ||
    equals["kms:ViaService"] !== computeOptimizerKmsViaService(contract)
  ) throw new Error("unexpected Compute Optimizer KMS permission");
}

async function allInlinePolicyNames(
  client: RoleContractClient,
  roleName: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const names: string[] = [];
  let marker: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 100; page += 1) {
    const output = await awaitWithActiveProvisioningSignal(
      signal,
      () => client.listRolePolicies(roleName, marker),
    );
    names.push(...output.policyNames);
    if (!output.isTruncated) return [...new Set(names)].sort();
    if (output.marker === undefined || output.marker.length === 0 || seen.has(output.marker)) {
      throw new Error("invalid role-policy pagination");
    }
    seen.add(output.marker);
    marker = output.marker;
  }
  throw new Error("role-policy pagination limit exceeded");
}

async function allAttachedManagedPolicies(
  client: RoleContractClient,
  roleName: string,
  signal?: AbortSignal,
): Promise<readonly { readonly policyName?: string; readonly policyArn?: string }[]> {
  const policies: { policyName?: string; policyArn?: string }[] = [];
  let marker: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 100; page += 1) {
    const output = await awaitWithActiveProvisioningSignal(
      signal,
      () => client.listAttachedRolePolicies(roleName, marker),
    );
    policies.push(...output.policies);
    if (!output.isTruncated) return policies;
    if (output.marker === undefined || output.marker.length === 0 || seen.has(output.marker)) {
      throw new Error("invalid attached-policy pagination");
    }
    seen.add(output.marker);
    marker = output.marker;
  }
  throw new Error("attached-policy pagination limit exceeded");
}

/**
 * Produce a deterministic, CloudTrail-friendly STS session name. A short digest
 * avoids collisions after replacement/truncation without exposing trust material.
 */
export function sanitizeRoleSessionName(
  rawJobId: string,
  prefix = "mspcmdb-",
): string {
  if (!SESSION_PREFIX.test(prefix)) {
    throw new ConnectionIntegrityError("Stored STS session-name prefix is invalid");
  }
  if (rawJobId.length === 0 || rawJobId.length > 256) {
    throw new ConnectionIntegrityError("Collector job ID cannot form an STS session name");
  }

  const readable = rawJobId
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_+=,.@-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "job";
  const digest = createHash("sha256").update(rawJobId, "utf8").digest("hex").slice(0, 10);
  const availableReadableLength = 64 - prefix.length - digest.length - 1;

  if (availableReadableLength < 1) {
    throw new ConnectionIntegrityError("Stored STS session-name prefix is too long");
  }

  const result = `${prefix}${readable.slice(0, availableReadableLength)}-${digest}`;
  if (!SESSION_NAME.test(result)) {
    throw new ConnectionIntegrityError("Collector job ID produced an invalid STS session name");
  }
  return result;
}

export class AwsRoleBroker {
  private readonly now: () => Date;
  // Assigned explicitly rather than as a constructor parameter property. Node's
  // strip-only TypeScript mode rejects parameter properties, so the shorthand made
  // this module unimportable from any root-level `node --test` file — which is why
  // nothing outside the collector could reuse the broker even though it owns the
  // external-id decryption every AWS path needs.
  private readonly dependencies: AwsRoleBrokerDependencies;

  public constructor(dependencies: AwsRoleBrokerDependencies) {
    this.dependencies = dependencies;
    this.now = dependencies.now ?? (() => new Date());
  }

  /** Resolve server-side trust material and return a caller-identity-validated session. */
  public async assumeValidatedSession(
    scope: ConnectionScope,
    connectionId: string,
    jobId: string,
  ): Promise<ValidatedRoleSession> {
    const resolved = await this.resolveConnection(scope, connectionId, ["ACTIVE"]);
    if (resolved.connection.permissionPackVersion !== PERMISSION_PACK_VERSION) {
      throw new ConnectionStateError();
    }
    const validated = await this.assumeAndValidateIdentity(resolved, jobId);
    // Re-attest on every collection so customer-side role drift cannot silently
    // expand the compact read-family session cap.
    await this.attestRoleContract(resolved, validated.credentials);
    return validated;
  }

  /**
   * ADV-08 session with an exact read-only intersection. Scope, account,
   * partition and action set are server-pinned before STS; provider credentials
   * never cross the collector process.
   */
  public async assumeValidatedAwsBudgetsSession(
    scope: ConnectionScope,
    connectionId: string,
    jobId: string,
    input: {
      readonly expectedAccountId: string;
      readonly partition: AwsPartition;
      readonly sessionActions: typeof AWS_BUDGETS_PROVIDER_SESSION_ACTIONS;
      readonly signal: AbortSignal;
    },
  ): Promise<ValidatedRoleSession> {
    if (typeof input !== "object" || input === null
      || !sameStringSet(Object.keys(input), [
        "expectedAccountId", "partition", "sessionActions", "signal",
      ])
      || !ACCOUNT_ID.test(input.expectedAccountId)
      || !["aws", "aws-us-gov", "aws-cn"].includes(input.partition)
      || !Array.isArray(input.sessionActions)
      || !sameStringSet(input.sessionActions, AWS_BUDGETS_PROVIDER_SESSION_ACTIONS)
      || !(input.signal instanceof AbortSignal)) {
      throw new ConnectionIntegrityError("The AWS Budgets session request is invalid");
    }
    assertActiveProvisioningSignal(input.signal);
    const resolved = await this.resolveConnection(scope, connectionId, ["ACTIVE"]);
    if (resolved.connection.expectedAccountId !== input.expectedAccountId
      || resolved.parsedRoleArn.partition !== input.partition) {
      throw new ConnectionStateError();
    }
    return this.assumeAndValidateIdentity(
      resolved,
      `${jobId}-budgets`,
      awsBudgetsProviderSessionPolicy,
      input.signal,
    );
  }

  /**
   * Prove the ACTIVE .8.5 connection identity without returning credentials or
   * granting any provider read/launch action to the manifest route.
   */
  public async attestComputeOptimizerActivationManifestIdentity(
    scope: ConnectionScope,
    connectionId: string,
    jobId: string,
    input: {
      readonly expectedAccountId: string;
      readonly partition: AwsPartition;
      readonly sessionActions: readonly ["sts:GetCallerIdentity"];
      readonly signal: AbortSignal;
    },
  ): Promise<{
    readonly verified: true;
    readonly connectionId: string;
    readonly accountId: string;
    readonly partition: AwsPartition;
  }> {
    if (
      typeof input !== "object" || input === null
      || !sameStringSet(Object.keys(input), [
        "expectedAccountId", "partition", "sessionActions", "signal",
      ])
      || typeof input.expectedAccountId !== "string"
      || !ACCOUNT_ID.test(input.expectedAccountId)
      || (input.partition !== "aws" && input.partition !== "aws-us-gov"
        && input.partition !== "aws-cn")
      || !Array.isArray(input.sessionActions)
      || input.sessionActions.length !== 1
      || input.sessionActions[0] !== "sts:GetCallerIdentity"
      || !(input.signal instanceof AbortSignal)
    ) throw new ConnectionIntegrityError("The activation identity request is invalid");
    assertActiveProvisioningSignal(input.signal);
    const resolved = await this.resolveConnection(scope, connectionId, ["ACTIVE"]);
    assertActiveProvisioningSignal(input.signal);
    if (
      resolved.connection.permissionPackVersion
        !== COMPUTE_OPTIMIZER_LAUNCH_PACK_VERSION
      || resolved.connection.expectedAccountId !== input.expectedAccountId
      || resolved.parsedRoleArn.partition !== input.partition
    ) throw new ConnectionStateError();
    const identity = await this.assumeAndValidateIdentity(
      resolved,
      `${jobId}-co85-identity`,
      computeOptimizerActivationIdentitySessionPolicy,
      input.signal,
    );
    assertActiveProvisioningSignal(input.signal);
    return Object.freeze({
      verified: true,
      connectionId: identity.connectionId,
      accountId: identity.accountId,
      partition: identity.partition,
    });
  }

  /**
   * Successor-only session for one immutable Foundational FinOps export.
   * The request is matched against server-owned CloudFormation outputs before
   * STS, then both the .8.1 base policy and every recorded add-on are attested.
   */
  public async assumeValidatedFinopsSession(
    scope: ConnectionScope,
    connectionId: string,
    jobId: string,
    request: FoundationalFinopsBindingRequest,
  ): Promise<ValidatedRoleSession> {
    const resolved = await this.resolveConnection(scope, connectionId, ["ACTIVE"]);
    if (
      resolved.connection.permissionPackVersion !== FINOPS_PERMISSION_PACK_VERSION ||
      resolved.connection.foundationalFinopsContracts === undefined
    ) {
      throw new ConnectionStateError();
    }
    const owner = {
      tenantId: resolved.connection.tenantId,
      connectionId: resolved.connection.connectionId,
      expectedAccountId: resolved.connection.expectedAccountId,
      partition: resolved.parsedRoleArn.partition,
    } as const;
    let contracts: readonly FoundationalFinopsAddOnContract[];
    let sourceContracts: readonly FinopsSourceContract[];
    let contract: FoundationalFinopsAddOnContract;
    try {
      contracts = parseFoundationalFinopsContracts(
        resolved.connection.foundationalFinopsContracts,
        owner,
      );
      contract = resolveFoundationalFinopsContract(contracts, owner, request);
      sourceContracts = resolved.connection.finopsSourceContracts === undefined
        ? []
        : parseFinopsSourceContracts(
            resolved.connection.finopsSourceContracts,
            owner,
          );
    } catch (cause) {
      const failure = new ConnectionIntegrityError(
        "Stored Foundational FinOps binding is invalid",
      );
      (failure as { cause?: unknown }).cause = cause;
      throw failure;
    }
    const validated = await this.assumeAndValidateIdentity(
      resolved,
      jobId,
      (roleArn) => finopsDataExportSessionPolicy(roleArn, contract),
    );
    await this.attestFinopsRoleContract(
      resolved,
      validated.credentials,
      contracts,
      sourceContracts,
    );
    return validated;
  }

  /**
   * Successor-only session for one persisted FinOps source identity. The caller
   * supplies only the opaque contract ID; source actions and endpoint scope are
   * recovered from encrypted registry state and the compiled source catalog.
   */
  public async assumeValidatedFinopsSourceSession(
    scope: ConnectionScope,
    connectionId: string,
    jobId: string,
    contractId: string,
  ): Promise<ValidatedRoleSession> {
    const resolved = await this.resolveConnection(scope, connectionId, ["ACTIVE"]);
    const permissionPackVersion = resolved.connection.permissionPackVersion;
    if (
      (permissionPackVersion !== FINOPS_PERMISSION_PACK_VERSION
        && permissionPackVersion !== ORGANIZATION_FINOPS_PACK_VERSION
        && permissionPackVersion !== ADVANCED_FINOPS_PACK_VERSION
        && permissionPackVersion !== COMPUTE_OPTIMIZER_OBJECT_PACK_VERSION
        && permissionPackVersion !== COMPUTE_OPTIMIZER_LAUNCH_PACK_VERSION) ||
      resolved.connection.finopsSourceContracts === undefined
    ) throw new ConnectionStateError();
    const owner = {
      tenantId: resolved.connection.tenantId,
      connectionId: resolved.connection.connectionId,
      expectedAccountId: resolved.connection.expectedAccountId,
      partition: resolved.parsedRoleArn.partition,
    } as const;
    let sourceContracts: readonly FinopsSourceContract[];
    let foundationalContracts: readonly FoundationalFinopsAddOnContract[];
    let objectContracts: readonly ComputeOptimizerExportObjectContract[];
    let launchContracts: readonly ComputeOptimizerExportLaunchContract[];
    let contract: FinopsSourceContract | null;
    try {
      sourceContracts = parseFinopsSourceContracts(
        resolved.connection.finopsSourceContracts,
        owner,
      );
      contract = resolveFinopsSourceContract(sourceContracts, owner, contractId);
      foundationalContracts = resolved.connection.foundationalFinopsContracts === undefined
        ? []
        : parseFoundationalFinopsContracts(
            resolved.connection.foundationalFinopsContracts,
            owner,
          );
      objectContracts = resolved.connection.computeOptimizerExportObjectContracts === undefined
        ? []
        : parseComputeOptimizerExportObjectContracts(
            resolved.connection.computeOptimizerExportObjectContracts,
            owner,
          );
      launchContracts = resolved.connection.computeOptimizerExportLaunchContracts === undefined
        ? []
        : parseComputeOptimizerExportLaunchContracts(
            resolved.connection.computeOptimizerExportLaunchContracts,
            owner,
          );
    } catch (cause) {
      const failure = new ConnectionIntegrityError(
        "Stored FinOps source binding is invalid",
      );
      (failure as { cause?: unknown }).cause = cause;
      throw failure;
    }
    if (contract === null) throw new ConnectionStateError();
    const definition = FINOPS_SOURCE_DEFINITIONS[
      contract.sourceId as keyof typeof FINOPS_SOURCE_DEFINITIONS
    ];
    if (
      definition?.implementationState !== "IMPLEMENTED"
      || !permissionPackSupportsSource(permissionPackVersion, contract.sourceId)
    ) {
      throw new ConnectionStateError();
    }
    const validated = await this.assumeAndValidateIdentity(
      resolved,
      jobId,
      (roleArn) => finopsSourceSessionPolicy(roleArn, contract),
    );
    await this.attestFinopsRoleContract(
      resolved,
      validated.credentials,
      foundationalContracts,
      sourceContracts,
      objectContracts,
      launchContracts,
    );
    return validated;
  }

  /**
   * Trusted control-plane attestation for an explicit .8.5 promotion. Unlike a
   * collection session, this accepts only already-derived server contracts and
   * does not mutate registry state. The caller must stage the returned proof
   * through the encrypted registry and activate it in a separate step.
   */
  public async attestComputeOptimizerExportLaunchProvisioning(
    scope: ConnectionScope,
    connectionId: string,
    operationId: string,
    input: {
      readonly sourceContracts: readonly FinopsSourceContract[];
      readonly objectContracts: readonly ComputeOptimizerExportObjectContract[];
      readonly launchContracts: readonly ComputeOptimizerExportLaunchContract[];
      readonly signal: AbortSignal;
    },
  ): Promise<{
    readonly identityAttested: true;
    readonly permissionPolicyAttested: true;
    readonly launchPoliciesAttested: true;
  }> {
    if (typeof input !== "object" || input === null || Array.isArray(input)
      || !sameStringSet(Object.keys(input), [
        "sourceContracts", "objectContracts", "launchContracts", "signal",
      ])
      || !(input.signal instanceof AbortSignal)) {
      throw new ConnectionIntegrityError(
        "The Compute Optimizer provisioning attestation input is invalid",
      );
    }
    assertActiveProvisioningSignal(input.signal);
    const resolved = await this.resolveConnection(scope, connectionId, ["ACTIVE"]);
    assertActiveProvisioningSignal(input.signal);
    if (!new Set<PermissionPackVersion>([
      PERMISSION_PACK_VERSION,
      FINOPS_PERMISSION_PACK_VERSION,
      ORGANIZATION_FINOPS_PACK_VERSION,
      ADVANCED_FINOPS_PACK_VERSION,
      COMPUTE_OPTIMIZER_OBJECT_PACK_VERSION,
      COMPUTE_OPTIMIZER_LAUNCH_PACK_VERSION,
    ]).has(resolved.connection.permissionPackVersion)) throw new ConnectionStateError();
    const owner = {
      tenantId: resolved.connection.tenantId,
      connectionId: resolved.connection.connectionId,
      expectedAccountId: resolved.connection.expectedAccountId,
      partition: resolved.parsedRoleArn.partition,
    } as const;
    let sources: readonly FinopsSourceContract[];
    let objects: readonly ComputeOptimizerExportObjectContract[];
    let launches: readonly ComputeOptimizerExportLaunchContract[];
    try {
      sources = parseFinopsSourceContracts(input.sourceContracts, owner);
      objects = parseComputeOptimizerExportObjectContracts(input.objectContracts, owner);
      launches = parseComputeOptimizerExportLaunchContracts(input.launchContracts, owner);
      const sourceRegions = sources
        .filter(({ sourceId }) => sourceId === "compute_optimizer_organization_export")
        .map(({ region }) => region)
        .sort();
      const launchRegions = launches.map(({ region }) => region).sort();
      const objectRegions = objects.map(({ region }) => region).sort();
      if (sourceRegions.length === 0
        || JSON.stringify(sourceRegions) !== JSON.stringify(objectRegions)
        || JSON.stringify(sourceRegions) !== JSON.stringify(launchRegions)
        || objects.some((objectContract) => {
          const launchContract = launches.find(({ region }) => region === objectContract.region);
          return launchContract === undefined
            || objectContract.bucket !== launchContract.bucket
            || objectContract.effectivePrefix !== launchContract.effectivePrefix
            || objectContract.encryptionMode !== "SSE_KMS"
            || objectContract.kmsKeyArn !== launchContract.kmsKeyArn;
        })) {
        throw new Error("regional provisioning contract mismatch");
      }
    } catch (cause) {
      const failure = new ConnectionIntegrityError(
        "The Compute Optimizer provisioning binding is invalid",
      );
      (failure as { cause?: unknown }).cause = cause;
      throw failure;
    }
    assertActiveProvisioningSignal(input.signal);
    const attestation = await this.assumeAndValidateIdentity(
      resolved,
      `${operationId}-co85-attest`,
      computeOptimizerExportAttestationSessionPolicy,
      input.signal,
    );
    assertActiveProvisioningSignal(input.signal);
    await this.attestFinopsRoleContract(
      resolved,
      attestation.credentials,
      undefined,
      sources,
      objects,
      launches,
      COMPUTE_OPTIMIZER_LAUNCH_PACK_VERSION,
      input.signal,
    );
    assertActiveProvisioningSignal(input.signal);
    return {
      identityAttested: true,
      permissionPolicyAttested: true,
      launchPoliciesAttested: true,
    };
  }

  /**
   * Resolve and re-attest one immutable regional .8.5 launch add-on, then
   * issue a distinct session containing only caller identity and the exact 25
   * documented launch/dependency actions. Destination/account/partition are
   * recovered from encrypted server state rather than from public input.
   */
  public async assumeValidatedComputeOptimizerExportLaunchSession(
    scope: ConnectionScope,
    connectionId: string,
    jobId: string,
    request: ComputeOptimizerExportLaunchSessionRequest,
  ): Promise<ValidatedRoleSession> {
    const resolved = await this.resolveConnection(scope, connectionId, ["ACTIVE"]);
    if (
      resolved.connection.permissionPackVersion !== COMPUTE_OPTIMIZER_LAUNCH_PACK_VERSION ||
      resolved.connection.computeOptimizerExportLaunchContracts === undefined
    ) throw new ConnectionStateError();
    if (
      typeof request !== "object" || request === null ||
      !sameStringSet(Object.keys(request), ["contractId", "region"])
    ) throw new ConnectionIntegrityError("The Compute Optimizer launch request is invalid");
    const owner = {
      tenantId: resolved.connection.tenantId,
      connectionId: resolved.connection.connectionId,
      expectedAccountId: resolved.connection.expectedAccountId,
      partition: resolved.parsedRoleArn.partition,
    } as const;
    let launchContracts: readonly ComputeOptimizerExportLaunchContract[];
    let launchContract: ComputeOptimizerExportLaunchContract;
    try {
      launchContracts = parseComputeOptimizerExportLaunchContracts(
        resolved.connection.computeOptimizerExportLaunchContracts,
        owner,
      );
      launchContract = resolveComputeOptimizerExportLaunchContract(
        launchContracts,
        owner,
        request.contractId,
        request.region,
      );
    } catch (cause) {
      const failure = new ConnectionIntegrityError(
        "The Compute Optimizer launch binding is invalid",
      );
      (failure as { cause?: unknown }).cause = cause;
      throw failure;
    }
    const attestation = await this.assumeAndValidateIdentity(
      resolved,
      `${jobId}-attest`,
      computeOptimizerExportAttestationSessionPolicy,
    );
    await this.attestFinopsRoleContract(
      resolved,
      attestation.credentials,
      undefined,
      undefined,
      undefined,
      launchContracts,
    );
    return this.assumeAndValidateIdentity(
      resolved,
      `${jobId}-launch-${createHash("sha256").update(launchContract.contractId).digest("hex").slice(0, 12)}`,
      computeOptimizerExportLaunchSessionPolicy,
    );
  }

  /**
   * .8.5-only exact-ID observation session. The opaque contract must resolve
   * to the regional Compute Optimizer source and that Region must also have an
   * attested launch destination. The provider job IDs are bounded and unique;
   * AWS offers no resource-level condition for this API, so the exact IDs are
   * enforced again by the credential-owning Describe runner.
   */
  public async assumeValidatedComputeOptimizerExportDescribeSession(
    scope: ConnectionScope,
    connectionId: string,
    jobId: string,
    request: ComputeOptimizerExportDescribeSessionRequest,
  ): Promise<ValidatedRoleSession> {
    const resolved = await this.resolveConnection(scope, connectionId, ["ACTIVE"]);
    if (
      resolved.connection.permissionPackVersion !== COMPUTE_OPTIMIZER_LAUNCH_PACK_VERSION ||
      resolved.connection.finopsSourceContracts === undefined ||
      resolved.connection.computeOptimizerExportLaunchContracts === undefined ||
      typeof request !== "object" || request === null ||
      !sameStringSet(Object.keys(request), ["contractId", "region", "plannedJobIds"]) ||
      !Array.isArray(request.plannedJobIds) || request.plannedJobIds.length < 1 ||
      request.plannedJobIds.length > 8 ||
      request.plannedJobIds.some((plannedJobId) =>
        typeof plannedJobId !== "string" || !PROVIDER_EXPORT_JOB_ID.test(plannedJobId)
      ) ||
      new Set(request.plannedJobIds).size !== request.plannedJobIds.length
    ) throw new ConnectionIntegrityError("The Compute Optimizer exact Describe request is invalid");
    const owner = {
      tenantId: resolved.connection.tenantId,
      connectionId: resolved.connection.connectionId,
      expectedAccountId: resolved.connection.expectedAccountId,
      partition: resolved.parsedRoleArn.partition,
    } as const;
    let sourceContracts: readonly FinopsSourceContract[];
    let launchContracts: readonly ComputeOptimizerExportLaunchContract[];
    try {
      sourceContracts = parseFinopsSourceContracts(
        resolved.connection.finopsSourceContracts,
        owner,
      );
      const sourceContract = resolveFinopsSourceContract(
        sourceContracts,
        owner,
        request.contractId,
      );
      if (
        sourceContract === null ||
        sourceContract.sourceId !== "compute_optimizer_organization_export" ||
        sourceContract.region !== request.region
      ) throw new Error("source contract mismatch");
      launchContracts = parseComputeOptimizerExportLaunchContracts(
        resolved.connection.computeOptimizerExportLaunchContracts,
        owner,
      );
      resolveComputeOptimizerExportLaunchContractForRegion(
        launchContracts,
        owner,
        request.region,
      );
    } catch (cause) {
      const failure = new ConnectionIntegrityError(
        "The Compute Optimizer exact Describe binding is invalid",
      );
      (failure as { cause?: unknown }).cause = cause;
      throw failure;
    }
    const attestation = await this.assumeAndValidateIdentity(
      resolved,
      `${jobId}-attest`,
      computeOptimizerExportAttestationSessionPolicy,
    );
    await this.attestFinopsRoleContract(
      resolved,
      attestation.credentials,
      undefined,
      sourceContracts,
      undefined,
      launchContracts,
    );
    const jobSetDigest = createHash("sha256")
      .update([...request.plannedJobIds].sort().join("\0"), "utf8")
      .digest("hex")
      .slice(0, 12);
    return this.assumeAndValidateIdentity(
      resolved,
      `${jobId}-describe-${jobSetDigest}`,
      computeOptimizerExportDescribeSessionPolicy,
    );
  }

  /**
   * Resolve a server-owned .8.4 binding, attest the complete role contract with
   * an IAM-only session, then issue a distinct 900-second session for exactly
   * one CSV or CSVW metadata object.
   */
  public async assumeValidatedComputeOptimizerExportObjectSession(
    scope: ConnectionScope,
    connectionId: string,
    jobId: string,
    request: ComputeOptimizerExportObjectSessionRequest,
  ): Promise<ValidatedRoleSession> {
    const resolved = await this.resolveConnection(scope, connectionId, ["ACTIVE"]);
    if (
      typeof request !== "object" || request === null ||
      !sameStringSet(
        Object.keys(request),
        ["contractId", "plannedJobId", "region", "bucket", "objectKey", "versionIdentity"],
      )
    ) throw new ConnectionIntegrityError("The Compute Optimizer object request is invalid");
    const packVersion = resolved.connection.permissionPackVersion;
    if (
      (packVersion !== COMPUTE_OPTIMIZER_OBJECT_PACK_VERSION ||
        resolved.connection.computeOptimizerExportObjectContracts === undefined) &&
      (packVersion !== COMPUTE_OPTIMIZER_LAUNCH_PACK_VERSION ||
        resolved.connection.computeOptimizerExportLaunchContracts === undefined)
    ) throw new ConnectionStateError();
    const owner = {
      tenantId: resolved.connection.tenantId,
      connectionId: resolved.connection.connectionId,
      expectedAccountId: resolved.connection.expectedAccountId,
      partition: resolved.parsedRoleArn.partition,
    } as const;
    let versionIdentity: ComputeOptimizerExportObjectVersionIdentity;
    let objectArn: string;
    let sessionPolicy: () => string;
    if (packVersion === COMPUTE_OPTIMIZER_OBJECT_PACK_VERSION) {
      let contracts: readonly ComputeOptimizerExportObjectContract[];
      let contract: ComputeOptimizerExportObjectContract;
      try {
        contracts = parseComputeOptimizerExportObjectContracts(
          resolved.connection.computeOptimizerExportObjectContracts,
          owner,
        );
        contract = resolveComputeOptimizerExportObjectContract(
          contracts,
          owner,
          request.contractId,
        );
        versionIdentity = parseComputeOptimizerExportObjectVersionIdentity(request.versionIdentity);
        objectArn = parseComputeOptimizerExportObjectAddress(
          contract,
          resolved.parsedRoleArn.partition,
          request.region,
          request.bucket,
          request.objectKey,
          request.plannedJobId,
        ).objectArn;
      } catch (cause) {
        const failure = new ConnectionIntegrityError(
          "The Compute Optimizer export object binding is invalid",
        );
        (failure as { cause?: unknown }).cause = cause;
        throw failure;
      }
      const attestation = await this.assumeAndValidateIdentity(
        resolved,
        `${jobId}-attest`,
        computeOptimizerExportAttestationSessionPolicy,
      );
      await this.attestComputeOptimizerExportObjectRoleContract(
        resolved,
        attestation.credentials,
        contracts,
      );
      sessionPolicy = () => computeOptimizerExportObjectSessionPolicy(
        contract,
        objectArn,
        versionIdentity,
      );
    } else {
      let launchContracts: readonly ComputeOptimizerExportLaunchContract[];
      let launchContract: ComputeOptimizerExportLaunchContract;
      try {
        launchContracts = parseComputeOptimizerExportLaunchContracts(
          resolved.connection.computeOptimizerExportLaunchContracts,
          owner,
        );
        launchContract = resolveComputeOptimizerExportLaunchContract(
          launchContracts,
          owner,
          request.contractId,
          request.region,
        );
        versionIdentity = parseComputeOptimizerExportObjectVersionIdentity(request.versionIdentity);
        objectArn = parseComputeOptimizerExportLaunchObjectAddress(
          launchContract,
          request.region,
          request.bucket,
          request.objectKey,
          request.plannedJobId,
        );
      } catch (cause) {
        const failure = new ConnectionIntegrityError(
          "The Compute Optimizer launch object binding is invalid",
        );
        (failure as { cause?: unknown }).cause = cause;
        throw failure;
      }
      const attestation = await this.assumeAndValidateIdentity(
        resolved,
        `${jobId}-attest`,
        computeOptimizerExportAttestationSessionPolicy,
      );
      await this.attestFinopsRoleContract(
        resolved,
        attestation.credentials,
        undefined,
        undefined,
        undefined,
        launchContracts,
      );
      sessionPolicy = () => computeOptimizerExportLaunchObjectSessionPolicy(
        launchContract,
        objectArn,
        versionIdentity,
      );
    }
    const objectSessionDiscriminator = createHash("sha256")
      .update(objectArn, "utf8")
      .update("\0", "utf8")
      .update(versionIdentity.kind, "utf8")
      .update("\0", "utf8")
      .update(versionIdentity.versionId ?? "CURRENT", "utf8")
      .digest("hex")
      .slice(0, 16);
    return this.assumeAndValidateIdentity(
      resolved,
      `${jobId}-object-${objectSessionDiscriminator}`,
      sessionPolicy,
    );
  }

  /**
   * A customer session for AGENTLESS SNAPSHOT SCANNING.
   *
   * Identical to assumeValidatedSession — same connection resolution, same identity
   * check, same re-attestation on every use — except for the STS ceiling. Agentless
   * needs snapshot verbs (CreateSnapshot, ModifySnapshotAttribute) that the
   * read-only metadata policy deliberately withholds, and it carries explicit
   * Denies on every destructive verb so a compromised control plane still cannot
   * delete a customer's data.
   *
   * THIS LIVES ON THE BROKER, not beside it. The external id is stored encrypted
   * (externalIdCiphertext + externalIdKeyVersion) and the broker is what holds the
   * key; a second path that decrypted credentials itself would be a second thing to
   * audit, and the first place a mistake would go unnoticed.
   */
  public async assumeAgentlessSession(
    scope: ConnectionScope,
    connectionId: string,
    jobId: string,
  ): Promise<ValidatedRoleSession> {
    const resolved = await this.resolveConnection(scope, connectionId, ["ACTIVE"]);
    if (resolved.connection.permissionPackVersion !== PERMISSION_PACK_VERSION) {
      throw new ConnectionStateError();
    }
    const validated = await this.assumeAndValidateIdentity(
      resolved,
      jobId,
      agentlessSnapshotSessionPolicy,
    );
    // Re-attested here for the same reason as a collection: customer-side role
    // drift must not silently widen what a scan can do.
    await this.attestRoleContract(resolved, validated.credentials);
    return validated;
  }

  /**
   * Onboarding is accepted only after a positive identity check and two explicit
   * negative confused-deputy probes. No temporary credentials leave this method.
   */
  public async verifyOnboardingTrust(
    scope: ConnectionScope,
    connectionId: string,
    jobId: string,
  ): Promise<OnboardingTrustVerification> {
    const resolved = await this.resolveConnection(scope, connectionId, [
      "PENDING",
      "VERIFIED",
      "DEGRADED",
      "ACTIVE",
    ]);
    const validated = await this.assumeAndValidateIdentity(resolved, jobId);

    const missingResult = await this.runNegativeProbe(
      resolved,
      validated.roleSessionName,
      "MISSING_EXTERNAL_ID",
    );
    const wrongResult = await this.runNegativeProbe(
      resolved,
      validated.roleSessionName,
      "WRONG_EXTERNAL_ID",
      createWrongExternalId(resolved.connection),
    );

    if (missingResult === "SUCCEEDED") {
      throw new UnsafeTrustPolicyError("MISSING_EXTERNAL_ID");
    }
    if (wrongResult === "SUCCEEDED") {
      throw new UnsafeTrustPolicyError("WRONG_EXTERNAL_ID");
    }

    const capabilityAssessment = await this.attestRoleContract(
      resolved,
      validated.credentials,
    );

    return {
      connectionId: validated.connectionId,
      accountId: validated.accountId,
      partition: validated.partition,
      roleArn: validated.roleArn,
      callerIdentityArn: validated.callerIdentityArn,
      roleSessionName: validated.roleSessionName,
      missingExternalIdDenied: true,
      wrongExternalIdDenied: true,
      trustPolicyAttested: true,
      permissionPolicyAttested: true,
      sessionPolicyApplied: true,
      permissionPackVersion: PERMISSION_PACK_VERSION,
      capabilityAssessment,
    };
  }

  private async attestRoleContract(
    resolved: ResolvedConnection,
    credentials: AwsTemporaryCredentials,
  ): Promise<PermissionCapabilityAssessment> {
    try {
      const expectedPrincipal = parseIamRoleArn(this.dependencies.expectedPrincipalArn);
      if (expectedPrincipal.partition !== resolved.parsedRoleArn.partition) {
        throw new Error("principal partition mismatch");
      }
      const client = this.dependencies.roleContractClientFactory(credentials);
      const role = await client.getRole(resolved.parsedRoleArn.roleName);
      assertExpectedRole(role, resolved, expectedPrincipal.arn);
      const attachedPolicies = await allAttachedManagedPolicies(
        client,
        resolved.parsedRoleArn.roleName,
      );
      if (attachedPolicies.length !== 0) {
        // This rejects AdministratorAccess and every other managed policy. A
        // dedicated Sutra role has one reviewed inline policy and nothing else.
        throw new Error("attached managed policies are prohibited");
      }
      const policyNames = await allInlinePolicyNames(client, resolved.parsedRoleArn.roleName);
      if (policyNames.length !== 1 || policyNames[0] !== EXPECTED_POLICY_NAME) {
        throw new Error("unexpected inline policy set");
      }
      const policy = await client.getRolePolicy(
        resolved.parsedRoleArn.roleName,
        EXPECTED_POLICY_NAME,
      );
      return assertExpectedPermissionPolicy(
        policy.policyDocument,
        resolved.connection.roleArn,
        resolved.roleProvisioningMode,
      );
    } catch (reason) {
      const failure = new UnsafeTrustPolicyError("ROLE_CONTRACT");
      // The specific mismatch stays OUT of the error code on purpose: the code is
      // surfaced to API callers, and naming which statement failed would describe
      // the customer's policy shape back to whoever asked. But discarding the
      // reason entirely makes an attestation regression undiagnosable — the whole
      // contract check collapses to one opaque string. Keep it as a cause, which
      // reaches server logs and test output and never the response body.
      (failure as { cause?: unknown }).cause = reason;
      throw failure;
    }
  }

  private async attestFinopsRoleContract(
    resolved: ResolvedConnection,
    credentials: AwsTemporaryCredentials,
    suppliedFoundationalContracts?: readonly FoundationalFinopsAddOnContract[],
    suppliedSourceContracts?: readonly FinopsSourceContract[],
    suppliedObjectContracts?: readonly ComputeOptimizerExportObjectContract[],
    suppliedLaunchContracts?: readonly ComputeOptimizerExportLaunchContract[],
    suppliedPermissionPackVersion?:
      | typeof FINOPS_PERMISSION_PACK_VERSION
      | typeof ORGANIZATION_FINOPS_PACK_VERSION
      | typeof ADVANCED_FINOPS_PACK_VERSION
      | typeof COMPUTE_OPTIMIZER_OBJECT_PACK_VERSION
      | typeof COMPUTE_OPTIMIZER_LAUNCH_PACK_VERSION,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      assertActiveProvisioningSignal(signal);
      const permissionPackVersion = suppliedPermissionPackVersion
        ?? resolved.connection.permissionPackVersion;
      if (
        permissionPackVersion !== FINOPS_PERMISSION_PACK_VERSION
        && permissionPackVersion !== ORGANIZATION_FINOPS_PACK_VERSION
        && permissionPackVersion !== ADVANCED_FINOPS_PACK_VERSION
        && permissionPackVersion !== COMPUTE_OPTIMIZER_OBJECT_PACK_VERSION
        && permissionPackVersion !== COMPUTE_OPTIMIZER_LAUNCH_PACK_VERSION
      ) throw new Error("unexpected FinOps permission pack");
      const expectedPrincipal = parseIamRoleArn(this.dependencies.expectedPrincipalArn);
      if (expectedPrincipal.partition !== resolved.parsedRoleArn.partition) {
        throw new Error("principal partition mismatch");
      }
      assertActiveProvisioningSignal(signal);
      const client = this.dependencies.roleContractClientFactory(credentials);
      const owner = {
        tenantId: resolved.connection.tenantId,
        connectionId: resolved.connection.connectionId,
        expectedAccountId: resolved.connection.expectedAccountId,
        partition: resolved.parsedRoleArn.partition,
      } as const;
      const contracts = suppliedFoundationalContracts ??
        (resolved.connection.foundationalFinopsContracts === undefined
          ? []
          : parseFoundationalFinopsContracts(
              resolved.connection.foundationalFinopsContracts,
              owner,
            ));
      const sourceContracts = suppliedSourceContracts ??
        (resolved.connection.finopsSourceContracts === undefined
          ? []
          : parseFinopsSourceContracts(
              resolved.connection.finopsSourceContracts,
              owner,
            ));
      const objectContracts = suppliedObjectContracts ??
        (resolved.connection.computeOptimizerExportObjectContracts === undefined
          ? []
          : parseComputeOptimizerExportObjectContracts(
              resolved.connection.computeOptimizerExportObjectContracts,
              owner,
            ));
      const launchContracts = suppliedLaunchContracts ??
        (resolved.connection.computeOptimizerExportLaunchContracts === undefined
          ? []
          : parseComputeOptimizerExportLaunchContracts(
              resolved.connection.computeOptimizerExportLaunchContracts,
              owner,
            ));
      const role = await awaitWithActiveProvisioningSignal(
        signal,
        () => client.getRole(resolved.parsedRoleArn.roleName),
      );
      assertExpectedRole(
        role,
        resolved,
        expectedPrincipal.arn,
        permissionPackVersion,
      );
      if (sourceContracts.some((contract) =>
        !permissionPackSupportsSource(permissionPackVersion, contract.sourceId)
      )) throw new Error("FinOps source is not provisioned by this permission pack");
      const attachedPolicies = await allAttachedManagedPolicies(
        client,
        resolved.parsedRoleArn.roleName,
        signal,
      );
      if (attachedPolicies.length !== 0) {
        throw new Error("attached managed policies are prohibited");
      }
      const policyNames = await allInlinePolicyNames(
        client,
        resolved.parsedRoleArn.roleName,
        signal,
      );
      const expectedPolicyNames = [...new Set([
        EXPECTED_POLICY_NAME,
        ...contracts.map(({ policyName }) => policyName),
        ...sourceContracts.flatMap(({ policyName }) =>
          policyName === null ? [] : [policyName]
        ),
        ...objectContracts.map(({ policyName }) => policyName),
        ...launchContracts.map(({ policyName }) => policyName),
      ])];
      if (!sameStringSet(policyNames, expectedPolicyNames)) {
        throw new Error("unexpected inline policy set");
      }
      const basePolicy = await awaitWithActiveProvisioningSignal(
        signal,
        () => client.getRolePolicy(
          resolved.parsedRoleArn.roleName,
          EXPECTED_POLICY_NAME,
        ),
      );
      assertExpectedPermissionPolicy(
        basePolicy.policyDocument,
        resolved.connection.roleArn,
        resolved.roleProvisioningMode,
        permissionPackVersion,
        actionsForFinopsSourceContracts(sourceContracts),
      );
      for (const contract of contracts) {
        const policy = await awaitWithActiveProvisioningSignal(
          signal,
          () => client.getRolePolicy(
            resolved.parsedRoleArn.roleName,
            contract.policyName,
          ),
        );
        assertFoundationalFinopsPolicy(
          policy.policyDocument,
          contract,
          resolved.parsedRoleArn.partition,
        );
      }
      for (const contract of sourceContracts) {
        if (contract.policyName === null) continue;
        const policy = await awaitWithActiveProvisioningSignal(
          signal,
          () => client.getRolePolicy(
            resolved.parsedRoleArn.roleName,
            contract.policyName as string,
          ),
        );
        assertFinopsSourcePolicy(policy.policyDocument, contract);
      }
      for (const contract of objectContracts) {
        const policy = await awaitWithActiveProvisioningSignal(
          signal,
          () => client.getRolePolicy(
            resolved.parsedRoleArn.roleName,
            contract.policyName,
          ),
        );
        assertComputeOptimizerExportObjectPolicy(policy.policyDocument, contract);
      }
      for (const contract of launchContracts) {
        const policy = await awaitWithActiveProvisioningSignal(
          signal,
          () => client.getRolePolicy(
            resolved.parsedRoleArn.roleName,
            contract.policyName,
          ),
        );
        assertComputeOptimizerExportLaunchPolicy(policy.policyDocument, contract);
      }
    } catch (reason) {
      const failure = new UnsafeTrustPolicyError("ROLE_CONTRACT");
      (failure as { cause?: unknown }).cause = reason;
      throw failure;
    }
  }

  private async attestComputeOptimizerExportObjectRoleContract(
    resolved: ResolvedConnection,
    credentials: AwsTemporaryCredentials,
    objectContracts: readonly ComputeOptimizerExportObjectContract[],
  ): Promise<void> {
    const owner = {
      tenantId: resolved.connection.tenantId,
      connectionId: resolved.connection.connectionId,
      expectedAccountId: resolved.connection.expectedAccountId,
      partition: resolved.parsedRoleArn.partition,
    } as const;
    let foundationalContracts: readonly FoundationalFinopsAddOnContract[];
    let sourceContracts: readonly FinopsSourceContract[];
    try {
      foundationalContracts = resolved.connection.foundationalFinopsContracts === undefined
        ? []
        : parseFoundationalFinopsContracts(
            resolved.connection.foundationalFinopsContracts,
            owner,
          );
      sourceContracts = resolved.connection.finopsSourceContracts === undefined
        ? []
        : parseFinopsSourceContracts(resolved.connection.finopsSourceContracts, owner);
    } catch (reason) {
      const failure = new UnsafeTrustPolicyError("ROLE_CONTRACT");
      (failure as { cause?: unknown }).cause = reason;
      throw failure;
    }
    await this.attestFinopsRoleContract(
      resolved,
      credentials,
      foundationalContracts,
      sourceContracts,
      objectContracts,
    );
  }

  private async resolveConnection(
    scope: ConnectionScope,
    connectionId: string,
    allowedStatuses: readonly AwsConnectionStatus[],
  ): Promise<ResolvedConnection> {
    if (scope.tenantId.length === 0 || connectionId.length === 0) {
      throw new ConnectionNotFoundError();
    }

    const connection = await this.dependencies.registry.resolve(scope, connectionId);
    if (connection === null) {
      throw new ConnectionNotFoundError();
    }
    if (connection.tenantId !== scope.tenantId) {
      throw new ConnectionScopeViolationError();
    }
    if (connection.connectionId !== connectionId) {
      throw new ConnectionIntegrityError("Scoped registry returned the wrong connection ID");
    }
    if (!allowedStatuses.includes(connection.status)) {
      throw new ConnectionStateError();
    }
    if (!ACCOUNT_ID.test(connection.expectedAccountId)) {
      throw new ConnectionIntegrityError("Stored expected AWS account ID is invalid");
    }
    if (!EXTERNAL_ID.test(connection.externalId)) {
      throw new ConnectionIntegrityError("Stored External ID does not meet platform policy");
    }

    const parsedRoleArn = parseIamRoleArn(connection.roleArn);
    if (parsedRoleArn.accountId !== connection.expectedAccountId) {
      throw new ConnectionIntegrityError(
        "Stored role ARN account does not match the expected AWS account",
      );
    }

    const sessionNamePrefix = connection.sessionNamePrefix ?? "mspcmdb-";
    if (!SESSION_PREFIX.test(sessionNamePrefix)) {
      throw new ConnectionIntegrityError("Stored STS session-name prefix is invalid");
    }

    const roleProvisioningMode = connection.roleProvisioningMode ?? "sutra_template";
    const expectedRolePath = connection.expectedRolePath ?? EXPECTED_ROLE_PATH;
    // Fall back to the role name in the connection's OWN stored ARN, not to the
    // current template's role name.
    //
    // Connection records written before the SutraReadOnlyRole → SutraCollectorRole
    // rename have no `expectedRoleName` field. Defaulting those to the current
    // constant attests them against a role name the customer never deployed, so
    // assertExpectedRole rejects the identity and every collection for that
    // customer fails — a rename in our repo silently breaking accounts that were
    // never touched. The stored ARN is the authoritative record of what the
    // customer actually created, and it is the same value assertExpectedRole
    // compares against, so deriving from it is correct for legacy and current
    // records alike.
    //
    // This is not a hole: the allowlist and unsafe-name checks below still run on
    // the derived name, so a tampered stored ARN cannot smuggle an unexpected role
    // past the sutra_template allowlist.
    const expectedRoleName = connection.expectedRoleName ?? parsedRoleArn.roleName;
    if (
      (roleProvisioningMode !== "sutra_template" &&
        roleProvisioningMode !== "customer_managed") ||
      !ROLE_PATH.test(expectedRolePath) ||
      expectedRolePath.length > 512 ||
      !ROLE_NAME.test(expectedRoleName) ||
      (roleProvisioningMode === "sutra_template" &&
        (expectedRolePath !== EXPECTED_ROLE_PATH ||
          !(EXPECTED_ROLE_NAMES as readonly string[]).includes(expectedRoleName))) ||
      (roleProvisioningMode === "customer_managed" &&
        (UNSAFE_SHARED_ROLE_NAME.test(expectedRoleName) ||
          expectedRoleName.toLowerCase() === "organizationaccountaccessrole"))
    ) {
      throw new ConnectionIntegrityError("Stored customer role contract is invalid or unsafe");
    }

    return {
      connection,
      parsedRoleArn,
      sessionNamePrefix,
      roleProvisioningMode,
      expectedRolePath,
      expectedRoleName,
    };
  }

  private async assumeAndValidateIdentity(
    resolved: ResolvedConnection,
    jobId: string,
    /**
     * The STS session ceiling. Defaults to the read-only metadata policy every
     * collection uses; agentless scanning passes its own because it needs snapshot
     * verbs the read policy does not grant. Injected rather than branched on a flag
     * so a caller cannot accidentally get a WIDER ceiling than it asked for — the
     * default stays the narrow one.
     */
    sessionPolicy: (roleArn: string) => string = readonlyMetadataSessionPolicy,
    provisioningSignal?: AbortSignal,
  ): Promise<ValidatedRoleSession> {
    assertActiveProvisioningSignal(provisioningSignal);
    const roleSessionName = sanitizeRoleSessionName(jobId, resolved.sessionNamePrefix);
    const policy = sessionPolicy(resolved.connection.roleArn);
    let output;

    assertActiveProvisioningSignal(provisioningSignal);
    try {
      output = await this.dependencies.assumeRoleClient.send(
        new AssumeRoleCommand({
          RoleArn: resolved.connection.roleArn,
          RoleSessionName: roleSessionName,
          ExternalId: resolved.connection.externalId,
          DurationSeconds: 900,
          Policy: policy,
        }),
      );
    } catch (error: unknown) {
      const name = errorName(error);
      if (EXPECTED_ACCESS_DENIALS.has(name)) {
        throw new AssumeRoleDeniedError(name);
      }
      throw new AssumeRoleFailedError(name);
    }
    assertActiveProvisioningSignal(provisioningSignal);

    const credentials = parseTemporaryCredentials(output.Credentials, this.now());
    const identityClient = this.dependencies.callerIdentityClientFactory(credentials);
    let identity;

    assertActiveProvisioningSignal(provisioningSignal);
    try {
      identity = await identityClient.send(new GetCallerIdentityCommand({}));
    } catch (error: unknown) {
      throw new CallerIdentityFailedError(errorName(error));
    }
    assertActiveProvisioningSignal(provisioningSignal);

    const callerIdentityArn = identity.Arn;
    if (
      identity.Account !== resolved.connection.expectedAccountId ||
      callerIdentityArn === undefined ||
      identity.UserId === undefined ||
      !identity.UserId.endsWith(`:${roleSessionName}`) ||
      !matchesExpectedAssumedRoleArn(
        callerIdentityArn,
        resolved.parsedRoleArn,
        roleSessionName,
      )
    ) {
      throw new IdentityMismatchError();
    }

    return {
      connectionId: resolved.connection.connectionId,
      accountId: resolved.connection.expectedAccountId,
      partition: resolved.parsedRoleArn.partition,
      roleArn: resolved.connection.roleArn,
      roleSessionName,
      callerIdentityArn,
      expiresAt: credentials.expiration,
      credentials,
    };
  }

  private async runNegativeProbe(
    resolved: ResolvedConnection,
    roleSessionName: string,
    probe: NegativeExternalIdProbe,
    externalId?: string,
  ): Promise<"DENIED" | "SUCCEEDED"> {
    const input = {
      RoleArn: resolved.connection.roleArn,
      // Keep every request field identical to the successful probe except the
      // ExternalId. Otherwise a condition on RoleSessionName can masquerade as
      // proof that the ExternalId itself was rejected.
      RoleSessionName: roleSessionName,
      DurationSeconds: 900,
      Policy: readonlyMetadataSessionPolicy(resolved.connection.roleArn),
      ...(externalId === undefined ? {} : { ExternalId: externalId }),
    };

    try {
      await this.dependencies.assumeRoleClient.send(new AssumeRoleCommand(input));
      return "SUCCEEDED";
    } catch (error: unknown) {
      const name = errorName(error);
      if (EXPECTED_ACCESS_DENIALS.has(name)) {
        return "DENIED";
      }
      throw new NegativeProbeInconclusiveError(probe, name);
    }
  }
}

/**
 * Production constructor. The source STS client intentionally has no static
 * credentials configuration, so the AWS SDK resolves the service's workload identity.
 * Every STS/IAM client also uses bounded connect/request timeouts so SDK retries fit
 * within the broker's outer trust deadline.
 */
export function createWorkloadIdentityRoleBroker(
  options: WorkloadIdentityRoleBrokerOptions,
): AwsRoleBroker {
  const clientConfig = workloadIdentityAwsClientConfig(
    options.region,
    options.maxAttempts ?? 4,
  );

  const assumeRoleClient = new STSClient(clientConfig);
  return new AwsRoleBroker({
    registry: options.registry,
    assumeRoleClient,
    expectedPrincipalArn: options.principalArn,
    callerIdentityClientFactory: (credentials) =>
      new STSClient({ ...clientConfig, credentials }),
    roleContractClientFactory: (credentials) => {
      const client = new IAMClient({
        ...workloadIdentityAwsClientConfig(
          options.region,
          options.maxAttempts ?? 4,
        ),
        credentials,
      });
      return {
        getRole: async (roleName) => {
          const output = await client.send(new GetRoleCommand({ RoleName: roleName }));
          return {
            ...(output.Role?.Arn === undefined ? {} : { arn: output.Role.Arn }),
            ...(output.Role?.RoleName === undefined ? {} : { roleName: output.Role.RoleName }),
            ...(output.Role?.Path === undefined ? {} : { path: output.Role.Path }),
            ...(output.Role?.MaxSessionDuration === undefined
              ? {}
              : { maxSessionDuration: output.Role.MaxSessionDuration }),
            ...(output.Role?.AssumeRolePolicyDocument === undefined
              ? {}
              : { assumeRolePolicyDocument: output.Role.AssumeRolePolicyDocument }),
            ...(output.Role?.Tags === undefined
              ? {}
              : {
                  tags: output.Role.Tags.map((tag) => ({
                    ...(tag.Key === undefined ? {} : { key: tag.Key }),
                    ...(tag.Value === undefined ? {} : { value: tag.Value }),
                  })),
                }),
          };
        },
        listRolePolicies: async (roleName, marker) => {
          const output = await client.send(new ListRolePoliciesCommand({
            RoleName: roleName,
            ...(marker === undefined ? {} : { Marker: marker }),
          }));
          return {
            policyNames: output.PolicyNames ?? [],
            isTruncated: output.IsTruncated === true,
            ...(output.Marker === undefined ? {} : { marker: output.Marker }),
          };
        },
        listAttachedRolePolicies: async (roleName, marker) => {
          const output = await client.send(new ListAttachedRolePoliciesCommand({
            RoleName: roleName,
            ...(marker === undefined ? {} : { Marker: marker }),
          }));
          return {
            policies: (output.AttachedPolicies ?? []).map((policy) => ({
              ...(policy.PolicyName === undefined ? {} : { policyName: policy.PolicyName }),
              ...(policy.PolicyArn === undefined ? {} : { policyArn: policy.PolicyArn }),
            })),
            isTruncated: output.IsTruncated === true,
            ...(output.Marker === undefined ? {} : { marker: output.Marker }),
          };
        },
        getRolePolicy: async (roleName, policyName) => {
          const output = await client.send(new GetRolePolicyCommand({
            RoleName: roleName,
            PolicyName: policyName,
          }));
          return output.PolicyDocument === undefined
            ? {}
            : { policyDocument: output.PolicyDocument };
        },
      };
    },
  });
}

function parseTemporaryCredentials(
  value:
    | {
        AccessKeyId?: string | undefined;
        SecretAccessKey?: string | undefined;
        SessionToken?: string | undefined;
        Expiration?: Date | undefined;
      }
    | undefined,
  now: Date,
): AwsTemporaryCredentials {
  if (
    value?.AccessKeyId === undefined ||
    value.AccessKeyId.length === 0 ||
    value.SecretAccessKey === undefined ||
    value.SecretAccessKey.length === 0 ||
    value.SessionToken === undefined ||
    value.SessionToken.length === 0 ||
    !(value.Expiration instanceof Date) ||
    !Number.isFinite(value.Expiration.getTime()) ||
    value.Expiration.getTime() <= now.getTime() + 60_000
  ) {
    throw new StsResponseError();
  }

  return {
    accessKeyId: value.AccessKeyId,
    secretAccessKey: value.SecretAccessKey,
    sessionToken: value.SessionToken,
    expiration: value.Expiration,
  };
}

function matchesExpectedAssumedRoleArn(
  callerIdentityArn: string,
  expectedRole: ParsedIamRoleArn,
  expectedSessionName: string,
): boolean {
  const match = ASSUMED_ROLE_ARN.exec(callerIdentityArn);
  return (
    match !== null &&
    match[1] === expectedRole.partition &&
    match[2] === expectedRole.accountId &&
    match[3] === expectedRole.roleName &&
    match[4] === expectedSessionName
  );
}

function createWrongExternalId(connection: StoredAwsConnection): string {
  // Preserve the exact shape and prefix of the configured value. A probe with
  // a different prefix would not detect an unsafe StringLike "sutra_*" trust
  // condition. The trust-policy attestation remains the authoritative check;
  // this is a complementary behavioral sample.
  const replacement = connection.externalId.endsWith("A") ? "B" : "A";
  return `${connection.externalId.slice(0, -1)}${replacement}`;
}

function errorName(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string" &&
    error.name.length > 0
  ) {
    return error.name;
  }
  return "UnknownError";
}
