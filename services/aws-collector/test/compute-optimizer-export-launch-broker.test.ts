import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AssumeRoleCommand, AssumeRoleCommandInput, AssumeRoleCommandOutput,
  GetCallerIdentityCommand, GetCallerIdentityCommandOutput,
} from "@aws-sdk/client-sts";

import {
  AwsRoleBroker,
  COMPUTE_OPTIMIZER_EXPORT_EXACT_DESCRIBE_ACTION,
  COMPUTE_OPTIMIZER_EXPORT_LAUNCH_ACTIONS,
  IMPLEMENTED_READ_ACTIONS,
  TRUST_ATTESTATION_ACTIONS,
  computeOptimizerExportDescribeSessionPolicy,
  computeOptimizerExportLaunchSessionPolicy,
} from "../src/role-broker.js";
import type {
  AssumeRoleClient, CallerIdentityClient, ComputeOptimizerExportLaunchContract,
  ConnectionScope, FinopsSourceContract, OnboardingTrustVerification,
  RoleContractClient, ScopedConnectionRegistry, StoredAwsConnection,
} from "../src/types.js";
import { ConnectionIntegrityError, UnsafeTrustPolicyError } from "../src/types.js";
import {
  parseComputeOptimizerExportLaunchContracts,
} from "../src/compute-optimizer-export-launch-contract.js";
import { parsePersistedConnection } from "../src/local-registry.js";

const SCOPE = { tenantId: "tenant-launch" } as const;
const CONNECTION_ID = `conn_${"a".repeat(32)}`;
const PRINCIPAL = "arn:aws:iam::999988887777:role/SutraCollectorWorkload";
const ACCOUNT = "123456789012";
const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/sutra/SutraCollectorRole`;
const PROVIDER_JOB_ID = "12345678-abcd-4321-aaaa-123456789012";
const FINOPS_ACTIONS = [
  "s3:ListBucket", "s3:GetBucketLocation", "s3:GetObject", "s3:GetObjectAttributes",
  "kms:Decrypt", "bcm-data-exports:ListExports", "bcm-data-exports:GetExport",
] as const;
const OBJECT_CEILING = ["s3:GetObjectVersion", "kms:GenerateDataKey"] as const;
const SOURCE_DEFINITIONS = Object.freeze({
  cost_anomaly_detection: {
    permissionContractId: "aws-cost-anomaly-read-v1",
    policyName: "SutraFinopsCostAnomalyReadV1",
    actions: ["ce:GetAnomalies", "ce:GetAnomalyMonitors", "ce:GetAnomalySubscriptions"],
  },
  trusted_advisor_standard_checks: {
    permissionContractId: "aws-trusted-advisor-standard-checks-read-v1",
    policyName: "SutraFinopsTrustedAdvisorStandardReadV1",
    actions: ["support:DescribeTrustedAdvisorCheckResult", "support:DescribeTrustedAdvisorChecks"],
  },
  aws_organizations_taxonomy: {
    permissionContractId: "aws-organizations-taxonomy-read-v1",
    policyName: "SutraFinopsOrganizationsTaxonomyReadV1",
    actions: ["organizations:DescribeOrganization", "organizations:ListAccounts"],
  },
  compute_optimizer_organization_export: {
    permissionContractId: "aws-compute-optimizer-organization-export-read-v1",
    policyName: "SutraFinopsComputeOptimizerExportReadV1",
    actions: [
      COMPUTE_OPTIMIZER_EXPORT_EXACT_DESCRIBE_ACTION,
      "compute-optimizer:GetEnrollmentStatus",
      "compute-optimizer:GetEnrollmentStatusesForOrganization",
    ],
  },
} as const);

function sourceContracts(): readonly FinopsSourceContract[] {
  return Object.entries(SOURCE_DEFINITIONS).map(([sourceId, definition]) => ({
    tenantId: SCOPE.tenantId, connectionId: CONNECTION_ID,
    contractId: `${sourceId}-contract`, sourceId,
    accountId: ACCOUNT, partition: "aws", region: "us-east-1",
    permissionContractId: definition.permissionContractId,
    policyName: definition.policyName,
  }));
}

function launchContract(
  overrides: Partial<ComputeOptimizerExportLaunchContract> = {},
): ComputeOptimizerExportLaunchContract {
  const bucket = "sutra-compute-optimizer-use1";
  const basePrefix = "sutra-finops/";
  const effectivePrefix = `${basePrefix}compute-optimizer/${ACCOUNT}/`;
  return {
    tenantId: SCOPE.tenantId, connectionId: CONNECTION_ID, accountId: ACCOUNT,
    partition: "aws", region: "us-east-1", contractId: "co-launch-use1",
    permissionPackVersion: "standard-2026-08.5",
    permissionContractId: "compute-optimizer-export-launch-v1",
    policyName: "SutraComputeOptimizerExportLaunchV1-us-east-1",
    bucket, bucketArn: `arn:aws:s3:::${bucket}`, basePrefix, effectivePrefix,
    objectArnPrefix: `arn:aws:s3:::${bucket}/${effectivePrefix}*`,
    encryptionMode: "SSE_S3", bucketVersioningStatus: "Enabled",
    servicePrincipal: "compute-optimizer.amazonaws.com", ...overrides,
  };
}

function connection(overrides: Partial<StoredAwsConnection> = {}): StoredAwsConnection {
  return {
    tenantId: SCOPE.tenantId, connectionId: CONNECTION_ID,
    expectedAccountId: ACCOUNT, roleArn: ROLE_ARN,
    externalId: "4a3e789b-5a2e-47db-9cab-226cbe52fc04", status: "ACTIVE",
    permissionPackVersion: "standard-2026-08.5", sessionNamePrefix: "sutra-",
    roleProvisioningMode: "sutra_template", expectedRolePath: "/sutra/",
    expectedRoleName: "SutraCollectorRole", finopsSourceContracts: sourceContracts(),
    computeOptimizerExportLaunchContracts: [launchContract()], ...overrides,
  };
}

class Registry implements ScopedConnectionRegistry {
  private readonly stored: StoredAwsConnection;
  public constructor(stored: StoredAwsConnection) { this.stored = stored; }
  public async resolve(): Promise<StoredAwsConnection> { return this.stored; }
  public async markOnboardingVerified(
    _scope: ConnectionScope, _connectionId: string, _verification: OnboardingTrustVerification,
  ): Promise<void> { void _scope; void _connectionId; void _verification; }
}

class Assume implements AssumeRoleClient {
  public readonly calls: AssumeRoleCommandInput[] = [];
  public async send(command: AssumeRoleCommand): Promise<AssumeRoleCommandOutput> {
    this.calls.push({ ...command.input });
    return { $metadata: {}, Credentials: {
      AccessKeyId: `ASIALAUNCH${this.calls.length}`, SecretAccessKey: "secret",
      SessionToken: "token", Expiration: new Date("2099-01-01T00:00:00.000Z"),
    } };
  }
}

class Identity implements CallerIdentityClient {
  private readonly assume: Assume;
  public constructor(assume: Assume) { this.assume = assume; }
  public async send(_command: GetCallerIdentityCommand): Promise<GetCallerIdentityCommandOutput> {
    void _command;
    const session = this.assume.calls.at(-1)?.RoleSessionName;
    assert.ok(session);
    return { $metadata: {}, Account: ACCOUNT,
      Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/SutraCollectorRole/${session}`,
      UserId: `AROA:${session}` };
  }
}

function launchPolicy(item: ComputeOptimizerExportLaunchContract): Record<string, unknown> {
  return { Version: "2012-10-17", Statement: [
    { Sid: "LaunchAllDocumentedComputeOptimizerExports", Effect: "Allow",
      Action: COMPUTE_OPTIMIZER_EXPORT_LAUNCH_ACTIONS.slice(0, 8), Resource: "*" },
    { Sid: "ReadDocumentedComputeOptimizerExportDependencies", Effect: "Allow",
      Action: COMPUTE_OPTIMIZER_EXPORT_LAUNCH_ACTIONS.slice(8), Resource: "*" },
    { Sid: "ReadSealedComputeOptimizerExportPrefix", Effect: "Allow",
      Action: ["s3:GetObject", "s3:GetObjectVersion"], Resource: item.objectArnPrefix },
  ] };
}

function roleClient(
  stored: StoredAwsConnection,
  mutate?: (name: string, value: Record<string, unknown>) => Record<string, unknown>,
): RoleContractClient {
  const sources = stored.finopsSourceContracts ?? [];
  const launches = stored.computeOptimizerExportLaunchContracts ?? [];
  const sourceActions = sources.flatMap((source) =>
    SOURCE_DEFINITIONS[source.sourceId as keyof typeof SOURCE_DEFINITIONS]?.actions ?? []);
  const ceiling = [...new Set([
    ...IMPLEMENTED_READ_ACTIONS, ...TRUST_ATTESTATION_ACTIONS, ...FINOPS_ACTIONS,
    ...OBJECT_CEILING, ...COMPUTE_OPTIMIZER_EXPORT_LAUNCH_ACTIONS, ...sourceActions,
  ])];
  const policies = new Map<string, Record<string, unknown>>([
    ["SutraImplementedMetadataCollectors", { Version: "2012-10-17", Statement: [
      { Sid: "DenyUnimplementedActions", Effect: "Deny", NotAction: ceiling, Resource: "*" },
      { Sid: "ImplementedMetadataApis", Effect: "Allow", Action: IMPLEMENTED_READ_ACTIONS, Resource: "*" },
      { Sid: "TrustContractAttestation", Effect: "Allow", Action: TRUST_ATTESTATION_ACTIONS, Resource: ROLE_ARN },
    ] }],
    ...sources.map((source) => [source.policyName as string, { Version: "2012-10-17", Statement: [{
      Sid: "ExactFinopsSourceRead", Effect: "Allow",
      Action: SOURCE_DEFINITIONS[source.sourceId as keyof typeof SOURCE_DEFINITIONS].actions,
      Resource: "*",
    }] }] as const),
    ...launches.map((item) => [item.policyName, launchPolicy(item)] as const),
  ]);
  return {
    getRole: async () => ({ arn: ROLE_ARN, roleName: "SutraCollectorRole", path: "/sutra/",
      maxSessionDuration: 3_600,
      assumeRolePolicyDocument: encodeURIComponent(JSON.stringify({ Version: "2012-10-17", Statement: [{
        Sid: "ExactCollectorWithConnectionExternalId", Effect: "Allow", Principal: { AWS: PRINCIPAL },
        Action: "sts:AssumeRole", Condition: {
          StringEquals: { "sts:ExternalId": stored.externalId },
          StringLike: { "sts:RoleSessionName": "sutra-*" },
        },
      }] })),
      tags: [
        { key: "sutra:access-mode", value: "read-only" },
        { key: "sutra:permission-pack", value: "standard-2026-08.5" },
        { key: "sutra:managed-by", value: "cloudformation" },
      ] }),
    listRolePolicies: async () => ({ policyNames: [...policies.keys()], isTruncated: false }),
    listAttachedRolePolicies: async () => ({ policies: [], isTruncated: false }),
    getRolePolicy: async (_role, name) => {
      const value = policies.get(name); if (value === undefined) return {};
      return { policyDocument: encodeURIComponent(JSON.stringify(mutate?.(name, structuredClone(value)) ?? value)) };
    },
  };
}

function fixture(
  stored = connection(),
  mutate?: (name: string, value: Record<string, unknown>) => Record<string, unknown>,
): { broker: AwsRoleBroker; assume: Assume } {
  const assume = new Assume();
  return { assume, broker: new AwsRoleBroker({ registry: new Registry(stored),
    assumeRoleClient: assume, callerIdentityClientFactory: () => new Identity(assume),
    roleContractClientFactory: () => roleClient(stored, mutate),
    expectedPrincipalArn: PRINCIPAL, now: () => new Date("2026-08-02T00:00:00.000Z"),
  }) };
}

function objectRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const item = launchContract();
  return { contractId: item.contractId, plannedJobId: PROVIDER_JOB_ID,
    region: item.region, bucket: item.bucket,
    objectKey: `${item.effectivePrefix}${item.region}-2026-08-02T000000Z-${PROVIDER_JOB_ID}.csv`,
    versionIdentity: { kind: "CURRENT", versionId: null }, ...overrides };
}

test("launch and Describe policies are disjoint, exact and bounded", () => {
  assert.equal(COMPUTE_OPTIMIZER_EXPORT_LAUNCH_ACTIONS.length, 25);
  assert.equal(new Set(COMPUTE_OPTIMIZER_EXPORT_LAUNCH_ACTIONS).size, 25);
  const launch = computeOptimizerExportLaunchSessionPolicy();
  assert.doesNotMatch(launch, /DescribeRecommendationExportJobs|s3:|kms:|iam:/u);
  const describe = computeOptimizerExportDescribeSessionPolicy();
  assert.match(describe, /DescribeRecommendationExportJobs/u);
  assert.doesNotMatch(describe, /ExportEC2|GetEnrollment|s3:|kms:|iam:/u);
});

test("persisted launch output is exact and rejects account, partition, prefix and version tamper", () => {
  const owner = { tenantId: SCOPE.tenantId, connectionId: CONNECTION_ID,
    expectedAccountId: ACCOUNT, partition: "aws" as const };
  assert.equal(parseComputeOptimizerExportLaunchContracts([launchContract()], owner).length, 1);
  for (const mutation of [
    { accountId: "999988887777" }, { partition: "aws-cn" as const },
    { effectivePrefix: `sutra-finops/compute-optimizer/999988887777/` },
    { permissionPackVersion: "standard-2026-08.4" as never },
    { objectArnPrefix: "arn:aws:s3:::sutra-compute-optimizer-use1/*" },
  ]) assert.throws(() => parseComputeOptimizerExportLaunchContracts([
    launchContract(mutation),
  ], owner));
});

test("encrypted registry serialization admits .8.5 only with an exact launch contract", () => {
  const persisted = {
    ...connection(), partition: "aws", enabledRegions: ["us-east-1"],
    createdAt: "2026-08-02T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z",
  };
  const parsed = parsePersistedConnection(persisted);
  assert.equal(parsed.permissionPackVersion, "standard-2026-08.5");
  assert.deepEqual(parsed.computeOptimizerExportLaunchContracts, [launchContract()]);
  assert.throws(() => parsePersistedConnection({
    ...persisted, permissionPackVersion: "standard-2026-08.4",
  }));
});

test("launch re-attests first and then mints only the exact 25-action session", async () => {
  const value = fixture();
  const result = await value.broker.assumeValidatedComputeOptimizerExportLaunchSession(
    SCOPE, CONNECTION_ID, "launch-attempt", { contractId: "co-launch-use1", region: "us-east-1" },
  );
  assert.equal(result.credentials.accessKeyId, "ASIALAUNCH2");
  assert.equal(value.assume.calls.length, 2);
  assert.match(value.assume.calls[0]?.Policy ?? "", /iam:GetRole/u);
  assert.equal(value.assume.calls[1]?.Policy, computeOptimizerExportLaunchSessionPolicy());
});

test("exact Describe binds source, regional launch contract and unique provider IDs", async () => {
  const value = fixture();
  await value.broker.assumeValidatedComputeOptimizerExportDescribeSession(
    SCOPE, CONNECTION_ID, "describe-attempt", {
      contractId: "compute_optimizer_organization_export-contract",
      region: "us-east-1", plannedJobIds: [PROVIDER_JOB_ID],
    },
  );
  assert.equal(value.assume.calls[1]?.Policy, computeOptimizerExportDescribeSessionPolicy());
  for (const request of [
    { contractId: "cost_anomaly_detection-contract", region: "us-east-1", plannedJobIds: [PROVIDER_JOB_ID] },
    { contractId: "compute_optimizer_organization_export-contract", region: "eu-west-1", plannedJobIds: [PROVIDER_JOB_ID] },
    { contractId: "compute_optimizer_organization_export-contract", region: "us-east-1", plannedJobIds: [PROVIDER_JOB_ID, PROVIDER_JOB_ID] },
  ]) await assert.rejects(fixture().broker.assumeValidatedComputeOptimizerExportDescribeSession(
    SCOPE, CONNECTION_ID, "describe-tamper", request,
  ), ConnectionIntegrityError);
});

test(".8.5 object read mints one exact current/version ARN and rejects sibling tamper", async () => {
  const current = fixture();
  await current.broker.assumeValidatedComputeOptimizerExportObjectSession(
    SCOPE, CONNECTION_ID, "object-current", objectRequest() as never,
  );
  const currentPolicy = current.assume.calls[1]?.Policy ?? "";
  assert.match(currentPolicy, /s3:GetObject/u);
  assert.doesNotMatch(currentPolicy, /GetObjectVersion|ListBucket/u);
  const currentDocument = JSON.parse(currentPolicy) as {
    Statement: Array<{ Action: string; Resource: string }>;
  };
  const objectGrant = currentDocument.Statement.find(({ Action }) => Action === "s3:GetObject");
  assert.ok(objectGrant);
  assert.equal(objectGrant.Resource.includes("*"), false);
  const versioned = fixture();
  await versioned.broker.assumeValidatedComputeOptimizerExportObjectSession(
    SCOPE, CONNECTION_ID, "object-version", objectRequest({
      versionIdentity: { kind: "VERSION", versionId: "v1.EXACT" },
    }) as never,
  );
  const versionPolicy = versioned.assume.calls[1]?.Policy ?? "";
  assert.match(versionPolicy, /s3:GetObjectVersion|s3:VersionId|v1\.EXACT/u);
  for (const tamper of [
    { contractId: "other-contract" }, { region: "eu-west-1" }, { bucket: "other-safe-bucket" },
    { objectKey: `${launchContract().effectivePrefix}neighbor.csv` },
    { versionIdentity: { kind: "VERSION", versionId: "*" } },
  ]) await assert.rejects(fixture().broker.assumeValidatedComputeOptimizerExportObjectSession(
    SCOPE, CONNECTION_ID, "object-tamper", objectRequest(tamper) as never,
  ), ConnectionIntegrityError);
});

test("missing or widened live launch add-on fails before operation credentials", async () => {
  for (const mutate of [
    (_name: string, value: Record<string, unknown>) => {
      const statements = value.Statement as Array<Record<string, unknown>>;
      if (statements?.[0]?.Sid === "LaunchAllDocumentedComputeOptimizerExports") {
        if (statements[0].Action instanceof Array) {
          statements[0].Action.push("compute-optimizer:UpdateEnrollmentStatus");
        }
      }
      return value;
    },
    (name: string, value: Record<string, unknown>) => name.startsWith("SutraComputeOptimizerExportLaunchV1")
      ? { ...value, Statement: (value.Statement as unknown[]).slice(0, 2) } : value,
  ]) {
    const value = fixture(connection(), mutate);
    await assert.rejects(value.broker.assumeValidatedComputeOptimizerExportLaunchSession(
      SCOPE, CONNECTION_ID, "launch-policy-tamper",
      { contractId: "co-launch-use1", region: "us-east-1" },
    ), UnsafeTrustPolicyError);
    assert.equal(value.assume.calls.length, 1);
  }
});
