import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AssumeRoleCommand,
  AssumeRoleCommandInput,
  AssumeRoleCommandOutput,
  GetCallerIdentityCommand,
  GetCallerIdentityCommandOutput,
} from "@aws-sdk/client-sts";

import {
  AwsRoleBroker,
  IMPLEMENTED_READ_ACTIONS,
  TRUST_ATTESTATION_ACTIONS,
  computeOptimizerExportObjectSessionPolicy,
} from "../src/role-broker.js";
import {
  AssumeRoleFailedError,
  ConnectionIntegrityError,
  ConnectionScopeViolationError,
  ConnectionStateError,
  UnsafeTrustPolicyError,
  type AssumeRoleClient,
  type CallerIdentityClient,
  type ComputeOptimizerExportObjectContract,
  type ConnectionScope,
  type FinopsSourceContract,
  type OnboardingTrustVerification,
  type RoleContractClient,
  type ScopedConnectionRegistry,
  type StoredAwsConnection,
} from "../src/types.js";
import { computeOptimizerKmsViaService } from
  "../src/compute-optimizer-export-object-contract.js";

const SCOPE = { tenantId: "tenant-object" } as const;
const CONNECTION_ID = `conn_${"a".repeat(32)}`;
const PRINCIPAL = "arn:aws:iam::999988887777:role/SutraCollectorWorkload";
const JOB_ID = "12345678-abcd-4321-aaaa-123456789012";
const FINOPS_ACTIONS = [
  "s3:ListBucket",
  "s3:GetBucketLocation",
  "s3:GetObject",
  "s3:GetObjectAttributes",
  "kms:Decrypt",
  "bcm-data-exports:ListExports",
  "bcm-data-exports:GetExport",
] as const;
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
      "compute-optimizer:DescribeRecommendationExportJobs",
      "compute-optimizer:GetEnrollmentStatus",
      "compute-optimizer:GetEnrollmentStatusesForOrganization",
    ],
  },
} as const);

function sourceContracts(): readonly FinopsSourceContract[] {
  return Object.entries(SOURCE_DEFINITIONS).map(([sourceId, definition]) => ({
    tenantId: "tenant-object",
    connectionId: CONNECTION_ID,
    contractId: `${sourceId}-contract`,
    sourceId,
    accountId: "123456789012",
    partition: "aws",
    region: "us-east-1",
    permissionContractId: definition.permissionContractId,
    policyName: definition.policyName,
  }));
}

function contract(
  overrides: Partial<ComputeOptimizerExportObjectContract> = {},
): ComputeOptimizerExportObjectContract {
  return {
    tenantId: "tenant-object",
    connectionId: CONNECTION_ID,
    accountId: "123456789012",
    partition: "aws",
    region: "us-east-1",
    contractId: "co-object-use1-ec2",
    permissionPackVersion: "standard-2026-08.4",
    permissionContractId: "compute-optimizer-export-read-v1",
    policyName:
      "SutraComputeOptimizerExportReadV1-us-east-1-customer-compute-optimizer-use1",
    bucket: "customer-compute-optimizer-use1",
    effectivePrefix: "ec2-instance-recommendations/compute-optimizer/123456789012/",
    encryptionMode: "SSE_S3",
    kmsKeyArn: null,
    ...overrides,
  };
}

function connection(overrides: Partial<StoredAwsConnection> = {}): StoredAwsConnection {
  return {
    tenantId: "tenant-object",
    connectionId: CONNECTION_ID,
    expectedAccountId: "123456789012",
    roleArn: "arn:aws:iam::123456789012:role/sutra/SutraCollectorRole",
    externalId: "4a3e789b-5a2e-47db-9cab-226cbe52fc04",
    status: "ACTIVE",
    permissionPackVersion: "standard-2026-08.4",
    sessionNamePrefix: "sutra-",
    roleProvisioningMode: "sutra_template",
    expectedRolePath: "/sutra/",
    expectedRoleName: "SutraCollectorRole",
    finopsSourceContracts: sourceContracts(),
    computeOptimizerExportObjectContracts: [contract()],
    ...overrides,
  };
}

class Registry implements ScopedConnectionRegistry {
  public constructor(public readonly stored: StoredAwsConnection | null) {}
  public async resolve(): Promise<StoredAwsConnection | null> { return this.stored; }
  public async markOnboardingVerified(
    _scope: ConnectionScope,
    _connectionId: string,
    _verification: OnboardingTrustVerification,
  ): Promise<void> {
    void _scope; void _connectionId; void _verification;
  }
}

class Assume implements AssumeRoleClient {
  public readonly calls: AssumeRoleCommandInput[] = [];
  public failAt: number | null = null;
  public async send(command: AssumeRoleCommand): Promise<AssumeRoleCommandOutput> {
    this.calls.push({ ...command.input });
    if (this.failAt === this.calls.length) throw Object.assign(new Error("retry"), {
      name: "ThrottlingException",
    });
    return {
      $metadata: {},
      Credentials: {
        AccessKeyId: `ASIAOBJECT${this.calls.length}`,
        SecretAccessKey: "secret",
        SessionToken: "token",
        Expiration: new Date("2099-01-01T00:00:00.000Z"),
      },
    };
  }
}

class Identity implements CallerIdentityClient {
  public constructor(private readonly assume: Assume) {}
  public async send(
    _command: GetCallerIdentityCommand,
  ): Promise<GetCallerIdentityCommandOutput> {
    void _command;
    const input = this.assume.calls.at(-1);
    const sessionName = input?.RoleSessionName;
    const roleArn = input?.RoleArn;
    assert.ok(sessionName); assert.ok(roleArn);
    const match = /^arn:(aws|aws-us-gov|aws-cn):iam::(\d{12}):role\/(?:.+\/)?([^/]+)$/u.exec(roleArn);
    assert.ok(match);
    return {
      $metadata: {},
      Account: match[2],
      Arn: `arn:${match[1]}:sts::${match[2]}:assumed-role/${match[3]}/${sessionName}`,
      UserId: `AROAOBJECT:${sessionName}`,
    };
  }
}

function objectPolicy(item: ComputeOptimizerExportObjectContract): Record<string, unknown> {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ReadSealedComputeOptimizerExportPrefix",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:GetObjectVersion"],
        Resource:
          `arn:${item.partition}:s3:::${item.bucket}/${item.effectivePrefix}*`,
      },
      ...(item.encryptionMode === "SSE_KMS" ? [{
        Sid: "UseExactExportKeyThroughRegionalS3",
        Effect: "Allow",
        Action: ["kms:Decrypt", "kms:GenerateDataKey"],
        Resource: item.kmsKeyArn,
        Condition: {
          StringEquals: { "kms:ViaService": computeOptimizerKmsViaService(item) },
        },
      }] : []),
    ],
  };
}

function roleClient(
  stored: StoredAwsConnection,
  mutate?: (policyName: string, value: Record<string, unknown>) => Record<string, unknown>,
): RoleContractClient {
  const objects = stored.computeOptimizerExportObjectContracts ?? [];
  const sources = stored.finopsSourceContracts ?? [];
  const sourceActions = sources.flatMap((item) =>
    SOURCE_DEFINITIONS[item.sourceId as keyof typeof SOURCE_DEFINITIONS]?.actions ?? []
  );
  const policies = new Map<string, Record<string, unknown>>([
    ["SutraImplementedMetadataCollectors", {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "DenyUnimplementedActions",
          Effect: "Deny",
          NotAction: [
            ...IMPLEMENTED_READ_ACTIONS,
            ...TRUST_ATTESTATION_ACTIONS,
            ...FINOPS_ACTIONS,
            "s3:GetObjectVersion",
            "kms:GenerateDataKey",
            ...sourceActions,
          ],
          Resource: "*",
        },
        {
          Sid: "ImplementedMetadataApis",
          Effect: "Allow",
          Action: IMPLEMENTED_READ_ACTIONS,
          Resource: "*",
        },
        {
          Sid: "TrustContractAttestation",
          Effect: "Allow",
          Action: TRUST_ATTESTATION_ACTIONS,
          Resource: stored.roleArn,
        },
      ],
    }],
    ...sources.flatMap((item) => item.policyName === null
      ? []
      : [[item.policyName, {
          Version: "2012-10-17",
          Statement: [{
            Sid: "ExactFinopsSourceRead",
            Effect: "Allow",
            Action:
              SOURCE_DEFINITIONS[item.sourceId as keyof typeof SOURCE_DEFINITIONS].actions,
            Resource: "*",
          }],
        }] as const]),
    ...objects.map((item) => [item.policyName, objectPolicy(item)] as const),
  ]);
  const roleName = stored.expectedRoleName ?? "SutraCollectorRole";
  const rolePath = stored.expectedRolePath ?? "/sutra/";
  const principalPartition = stored.roleArn.split(":")[1];
  const expectedPrincipal = PRINCIPAL.replace("arn:aws:", `arn:${principalPartition}:`);
  return {
    getRole: async () => ({
      arn: stored.roleArn,
      roleName,
      path: rolePath,
      maxSessionDuration: 3_600,
      assumeRolePolicyDocument: encodeURIComponent(JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Sid: "ExactCollectorWithConnectionExternalId",
          Effect: "Allow",
          Principal: { AWS: expectedPrincipal },
          Action: "sts:AssumeRole",
          Condition: {
            StringEquals: { "sts:ExternalId": stored.externalId },
            StringLike: { "sts:RoleSessionName": `${stored.sessionNamePrefix ?? "sutra-"}*` },
          },
        }],
      })),
      tags: [
        { key: "sutra:access-mode", value: "read-only" },
        { key: "sutra:permission-pack", value: stored.permissionPackVersion },
        { key: "sutra:managed-by", value: "cloudformation" },
      ],
    }),
    listRolePolicies: async () => ({ policyNames: [...policies.keys()], isTruncated: false }),
    listAttachedRolePolicies: async () => ({ policies: [], isTruncated: false }),
    getRolePolicy: async (_roleName, policyName) => {
      const value = policies.get(policyName);
      if (value === undefined) return {};
      const output = mutate?.(policyName, structuredClone(value)) ?? value;
      return { policyDocument: encodeURIComponent(JSON.stringify(output)) };
    },
  };
}

function broker(
  stored = connection(),
  assume = new Assume(),
  mutate?: (policyName: string, value: Record<string, unknown>) => Record<string, unknown>,
): { broker: AwsRoleBroker; assume: Assume } {
  const partition = stored.roleArn.split(":")[1];
  return {
    assume,
    broker: new AwsRoleBroker({
      registry: new Registry(stored),
      assumeRoleClient: assume,
      callerIdentityClientFactory: () => new Identity(assume),
      roleContractClientFactory: () => roleClient(stored, mutate),
      expectedPrincipalArn: PRINCIPAL.replace("arn:aws:", `arn:${partition}:`),
      now: () => new Date("2026-08-02T00:00:00.000Z"),
    }),
  };
}

function request(
  item = contract(),
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    contractId: item.contractId,
    plannedJobId: JOB_ID,
    region: item.region,
    bucket: item.bucket,
    objectKey:
      `${item.effectivePrefix}${item.region}-2026-08-02T000000Z-${JOB_ID}.csv`,
    versionIdentity: { kind: "CURRENT", versionId: null },
    ...overrides,
  };
}

test("attests first, then creates a distinct exact-current-object session", async () => {
  const fixture = broker();
  const result = await fixture.broker.assumeValidatedComputeOptimizerExportObjectSession(
    SCOPE, CONNECTION_ID, "collector-job", request() as never,
  );
  assert.equal(result.credentials.accessKeyId, "ASIAOBJECT2");
  assert.equal(fixture.assume.calls.length, 2);
  assert.notEqual(
    fixture.assume.calls[0]?.RoleSessionName,
    fixture.assume.calls[1]?.RoleSessionName,
  );
  assert.equal(fixture.assume.calls[0]?.DurationSeconds, 900);
  assert.equal(fixture.assume.calls[1]?.DurationSeconds, 900);
  const attestPolicy = fixture.assume.calls[0]?.Policy ?? "";
  const objectSession = JSON.parse(fixture.assume.calls[1]?.Policy ?? "") as {
    Statement: Array<{ Action: string | string[]; Resource: string }>;
  };
  assert.ok(attestPolicy.includes("iam:GetRole"));
  assert.equal(attestPolicy.includes("s3:GetObject"), false);
  const s3 = objectSession.Statement.find(({ Resource }) => Resource.startsWith("arn:aws:s3"));
  assert.equal(s3?.Action, "s3:GetObject");
  assert.equal(s3?.Resource.endsWith(`${JOB_ID}.csv`), true);
  assert.equal(JSON.stringify(objectSession).includes("GetObjectVersion"), false);
  assert.equal(JSON.stringify(objectSession).includes("ListBucket"), false);
  assert.equal(JSON.stringify(objectSession).includes("GetObjectAttributes"), false);
  assert.equal(JSON.stringify(objectSession).includes("*\""), true); // STS identity Resource only.
  assert.ok((fixture.assume.calls[1]?.Policy?.length ?? 0) <= 2_048);
});

test("versioned KMS object session uses only GetObjectVersion and exact regional CMK", async () => {
  const item = contract({
    encryptionMode: "SSE_KMS",
    kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/key-123",
  });
  const stored = connection({ computeOptimizerExportObjectContracts: [item] });
  const fixture = broker(stored);
  await fixture.broker.assumeValidatedComputeOptimizerExportObjectSession(
    SCOPE,
    CONNECTION_ID,
    "collector-version-job",
    request(item, {
      versionIdentity: { kind: "VERSION", versionId: "3Lg-x_9" },
    }) as never,
  );
  const policy = JSON.parse(fixture.assume.calls[1]?.Policy ?? "") as {
    Statement: Array<Record<string, unknown>>;
  };
  const s3 = policy.Statement.find(({ Resource }) =>
    typeof Resource === "string" && Resource.startsWith("arn:aws:s3"));
  const kms = policy.Statement.find(({ Resource }) => Resource === item.kmsKeyArn);
  assert.equal(s3?.Action, "s3:GetObjectVersion");
  assert.deepEqual(s3?.Condition, {
    StringEquals: { "s3:VersionId": "3Lg-x_9" },
  });
  assert.equal(JSON.stringify(policy).includes('"s3:GetObject"'), false);
  assert.deepEqual(kms?.Action, ["kms:Decrypt", "kms:GenerateDataKey"]);
  assert.deepEqual(kms?.Condition, {
    StringEquals: { "kms:ViaService": "s3.us-east-1.amazonaws.com" },
  });
});

test("CSV and metadata objects receive distinct exact-object STS sessions", async () => {
  const fixture = broker();
  const csvRequest = request();
  await fixture.broker.assumeValidatedComputeOptimizerExportObjectSession(
    SCOPE, CONNECTION_ID, "same-materialization-job", csvRequest as never,
  );
  await fixture.broker.assumeValidatedComputeOptimizerExportObjectSession(
    SCOPE,
    CONNECTION_ID,
    "same-materialization-job",
    {
      ...csvRequest,
      objectKey: String(csvRequest.objectKey).replace(/\.csv$/u, "-metadata.json"),
    } as never,
  );
  assert.equal(fixture.assume.calls.length, 4);
  assert.notEqual(
    fixture.assume.calls[1]?.RoleSessionName,
    fixture.assume.calls[3]?.RoleSessionName,
  );
});

test("rejects caller widening and substitutions before any STS call", async () => {
  for (const changes of [
    { contractId: "neighbor-contract" },
    { region: "us-west-2" },
    { bucket: "neighbor-bucket" },
    { objectKey: `${contract().effectivePrefix}us-east-1-2026-${JOB_ID}-other.csv` },
    { objectKey: `${contract().effectivePrefix}us-east-1-2026-other.csv` },
    { kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/attacker" },
    { action: "s3:*" },
  ]) {
    const fixture = broker();
    await assert.rejects(
      fixture.broker.assumeValidatedComputeOptimizerExportObjectSession(
        SCOPE, CONNECTION_ID, "job", request(contract(), changes) as never,
      ),
      ConnectionIntegrityError,
    );
    assert.equal(fixture.assume.calls.length, 0);
  }
});

test(".8.3 and cross-tenant records cannot use the object path", async () => {
  const prior = broker(connection({ permissionPackVersion: "standard-2026-08.3" }));
  await assert.rejects(
    prior.broker.assumeValidatedComputeOptimizerExportObjectSession(
      SCOPE, CONNECTION_ID, "job", request() as never,
    ),
    ConnectionStateError,
  );
  assert.equal(prior.assume.calls.length, 0);

  const crossed = broker(connection({ tenantId: "other-tenant" }));
  await assert.rejects(
    crossed.broker.assumeValidatedComputeOptimizerExportObjectSession(
      SCOPE, CONNECTION_ID, "job", request() as never,
    ),
    ConnectionScopeViolationError,
  );
  assert.equal(crossed.assume.calls.length, 0);
});

test("fails closed on widened add-on/base attestation before object credentials", async () => {
  for (const mutate of [
    (name: string, value: Record<string, unknown>): Record<string, unknown> => {
      if (name !==
        "SutraComputeOptimizerExportReadV1-us-east-1-customer-compute-optimizer-use1"
      ) return value;
      const statement = (value.Statement as Array<Record<string, unknown>>)[0]!;
      statement.Action = ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket"];
      return value;
    },
    (name: string, value: Record<string, unknown>): Record<string, unknown> => {
      if (name !== "SutraImplementedMetadataCollectors") return value;
      const statement = (value.Statement as Array<Record<string, unknown>>)[0]!;
      statement.NotAction = [...(statement.NotAction as string[]), "s3:PutObject"];
      return value;
    },
  ]) {
    const fixture = broker(connection(), new Assume(), mutate);
    await assert.rejects(
      fixture.broker.assumeValidatedComputeOptimizerExportObjectSession(
        SCOPE, CONNECTION_ID, "job", request() as never,
      ),
      UnsafeTrustPolicyError,
    );
    assert.equal(fixture.assume.calls.length, 1);
  }
});

test("maps second-session STS failures without returning attestation credentials", async () => {
  const assume = new Assume();
  assume.failAt = 2;
  const fixture = broker(connection(), assume);
  await assert.rejects(
    fixture.broker.assumeValidatedComputeOptimizerExportObjectSession(
      SCOPE, CONNECTION_ID, "job", request() as never,
    ),
    AssumeRoleFailedError,
  );
  assert.equal(assume.calls.length, 2);
});

test("exact policy stays partition-correct for China and GovCloud", () => {
  for (const item of [
    contract({
      partition: "aws-cn",
      region: "cn-north-1",
      bucket: "customer-co-cn",
      encryptionMode: "SSE_KMS",
      kmsKeyArn: "arn:aws-cn:kms:cn-north-1:123456789012:key/key-cn",
    }),
    contract({
      partition: "aws-us-gov",
      region: "us-gov-west-1",
      bucket: "customer-co-gov",
      encryptionMode: "SSE_KMS",
      kmsKeyArn: "arn:aws-us-gov:kms:us-gov-west-1:123456789012:key/key-gov",
    }),
  ]) {
    const objectArn = `arn:${item.partition}:s3:::${item.bucket}/${item.effectivePrefix}` +
      `${item.region}-2026-${JOB_ID}.csv`;
    const policy = computeOptimizerExportObjectSessionPolicy(
      item,
      objectArn,
      { kind: "CURRENT", versionId: null },
    );
    assert.ok(policy.includes(objectArn));
    assert.ok(policy.includes(computeOptimizerKmsViaService(item)));
    assert.equal(policy.includes("arn:aws:s3"), false);
  }
});
