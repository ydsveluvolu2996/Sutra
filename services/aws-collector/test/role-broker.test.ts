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
  AWS_BROKER_CONNECTION_TIMEOUT_MS,
  AWS_BROKER_REQUEST_TIMEOUT_MS,
  AwsRoleBroker,
  IMPLEMENTED_READ_ACTIONS,
  TRUST_ATTESTATION_ACTIONS,
  accountIdFromRoleArn,
  parseIamRoleArn,
  agentlessSnapshotSessionPolicy,
  readonlyMetadataSessionPolicy,
  sanitizeRoleSessionName,
  workloadIdentityAwsClientConfig,
} from "../src/role-broker.js";
import {
  AssumeRoleDeniedError,
  AssumeRoleFailedError,
  ConnectionIntegrityError,
  NegativeProbeInconclusiveError,
  UnsafeTrustPolicyError,
  type AssumeRoleClient,
  type CallerIdentityClient,
  type ConnectionScope,
  type OnboardingTrustVerification,
  type RoleContractClient,
  type ScopedConnectionRegistry,
  type StoredAwsConnection,
} from "../src/types.js";

const scope: ConnectionScope = { tenantId: "tenant-01", subjectId: "queue-worker" };
const COLLECTOR_PRINCIPAL_ARN = "arn:aws:iam::999988887777:role/SutraLocalCollector";
const EXPECTED_IMPLEMENTED_READ_ACTIONS = [
  "sts:GetCallerIdentity",
  "ec2:DescribeRegions",
  "ec2:DescribeInstances",
  "ec2:DescribeVpcs",
  "ec2:DescribeSubnets",
  "ec2:DescribeSecurityGroups",
  "ec2:DescribeVolumes",
  "ec2:DescribeNetworkInterfaces",
  "elasticloadbalancing:DescribeLoadBalancers",
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
] as const;
const EXPECTED_TRUST_ACTIONS = [
  "iam:GetRole",
  "iam:ListRolePolicies",
  "iam:ListAttachedRolePolicies",
  "iam:GetRolePolicy",
] as const;

function connection(
  overrides: Partial<StoredAwsConnection> = {},
): StoredAwsConnection {
  return {
    tenantId: "tenant-01",
    connectionId: "conn-01",
    expectedAccountId: "123456789012",
    roleArn: "arn:aws:iam::123456789012:role/sutra/SutraReadOnlyRole",
    externalId: "4a3e789b-5a2e-47db-9cab-226cbe52fc04",
    status: "ACTIVE",
    permissionPackVersion: "standard-2026-07.4",
    sessionNamePrefix: "mspcmdb-",
    ...overrides,
  };
}

class MemoryRegistry implements ScopedConnectionRegistry {
  public readonly verified: OnboardingTrustVerification[] = [];

  public constructor(public stored: StoredAwsConnection | null) {}

  public async resolve(
    _scope: ConnectionScope,
    _connectionId: string,
  ): Promise<StoredAwsConnection | null> {
    void _scope;
    void _connectionId;
    return this.stored;
  }

  public async markOnboardingVerified(
    _scope: ConnectionScope,
    _connectionId: string,
    verification: OnboardingTrustVerification,
  ): Promise<void> {
    this.verified.push(verification);
  }
}

class FakeAssumeRoleClient implements AssumeRoleClient {
  public readonly calls: AssumeRoleCommandInput[] = [];

  public constructor(
    private readonly responder: (
      input: AssumeRoleCommandInput,
    ) => Promise<AssumeRoleCommandOutput> | AssumeRoleCommandOutput,
  ) {}

  public async send(command: AssumeRoleCommand): Promise<AssumeRoleCommandOutput> {
    this.calls.push({ ...command.input });
    return this.responder(command.input);
  }
}

class FakeCallerIdentityClient implements CallerIdentityClient {
  public calls = 0;

  public constructor(
    private readonly responder: () => GetCallerIdentityCommandOutput,
  ) {}

  public async send(
    _command: GetCallerIdentityCommand,
  ): Promise<GetCallerIdentityCommandOutput> {
    void _command;
    this.calls += 1;
    return this.responder();
  }
}

function expectedRoleContractClient(
  stored: StoredAwsConnection,
  options: {
    readonly metadataActions?: readonly string[];
    readonly attachedPolicies?: readonly { readonly policyName?: string; readonly policyArn?: string }[];
  } = {},
): RoleContractClient {
  const roleName = stored.expectedRoleName ?? "SutraReadOnlyRole";
  const rolePath = stored.expectedRolePath ?? "/sutra/";
  const metadataActions = options.metadataActions ?? IMPLEMENTED_READ_ACTIONS;
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
          Principal: { AWS: COLLECTOR_PRINCIPAL_ARN },
          Action: "sts:AssumeRole",
          Condition: {
            StringEquals: { "sts:ExternalId": stored.externalId },
            StringLike: { "sts:RoleSessionName": `${stored.sessionNamePrefix ?? "mspcmdb-"}*` },
          },
        }],
      })),
      tags: [
        { key: "sutra:access-mode", value: "read-only" },
        { key: "sutra:permission-pack", value: "standard-2026-07.4" },
        {
          key: "sutra:managed-by",
          value: stored.roleProvisioningMode === "customer_managed" ? "customer" : "cloudformation",
        },
      ],
    }),
    listRolePolicies: async () => ({
      policyNames: ["SutraImplementedMetadataCollectors"],
      isTruncated: false,
    }),
    listAttachedRolePolicies: async () => ({
      policies: options.attachedPolicies ?? [],
      isTruncated: false,
    }),
    getRolePolicy: async () => ({
      policyDocument: encodeURIComponent(JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "DenyUnimplementedActions",
            Effect: "Deny",
            NotAction: [...IMPLEMENTED_READ_ACTIONS, ...TRUST_ATTESTATION_ACTIONS],
            Resource: "*",
          },
          {
            Sid: "ImplementedMetadataApis",
            Effect: "Allow",
            Action: metadataActions,
            Resource: "*",
          },
          {
            Sid: "TrustContractAttestation",
            Effect: "Allow",
            Action: TRUST_ATTESTATION_ACTIONS,
            Resource: stored.roleArn,
          },
        ],
      })),
    }),
  };
}

function successfulAssumeRole(): AssumeRoleCommandOutput {
  return {
    $metadata: { httpStatusCode: 200 },
    Credentials: {
      AccessKeyId: "ASIAEXAMPLE",
      SecretAccessKey: "secret-not-for-logs",
      SessionToken: "session-token-not-for-logs",
      Expiration: new Date("2099-01-01T00:00:00.000Z"),
    },
  };
}

function accessDenied(): Error {
  const error = new Error("denied");
  error.name = "AccessDenied";
  return error;
}

test("parseIamRoleArn extracts partition/account/path and rejects non-role ARNs", () => {
  assert.deepEqual(
    parseIamRoleArn(
      "arn:aws-us-gov:iam::210987654321:role/team/security/MSPCMDBReadRole",
    ),
    {
      arn: "arn:aws-us-gov:iam::210987654321:role/team/security/MSPCMDBReadRole",
      partition: "aws-us-gov",
      accountId: "210987654321",
      rolePathAndName: "team/security/MSPCMDBReadRole",
      roleName: "MSPCMDBReadRole",
    },
  );
  assert.equal(
    accountIdFromRoleArn("arn:aws-cn:iam::999999999999:role/MSPCMDBReadRole"),
    "999999999999",
  );

  for (const invalid of [
    "arn:aws:iam::123456789012:root",
    "arn:aws:iam::123456789012:user/alice",
    "arn:aws:sts::123456789012:assumed-role/MSPCMDBReadRole/session",
    "arn:aws:iam::1234:role/MSPCMDBReadRole",
    "arn:aws:iam::123456789012:role/team//MSPCMDBReadRole",
  ]) {
    assert.throws(() => parseIamRoleArn(invalid), ConnectionIntegrityError);
  }
});

test("sanitizeRoleSessionName is deterministic, bounded, and collision resistant", () => {
  const first = sanitizeRoleSessionName(
    "scan / customer 🚀 / 1234567890".repeat(8),
  );
  const same = sanitizeRoleSessionName(
    "scan / customer 🚀 / 1234567890".repeat(8),
  );
  const collisionCandidate = sanitizeRoleSessionName("a/b");
  const otherCollisionCandidate = sanitizeRoleSessionName("a b");

  assert.equal(first, same);
  assert.match(first, /^mspcmdb-[A-Za-z0-9_+=,.@-]+$/);
  assert.ok(first.length >= 2 && first.length <= 64);
  assert.notEqual(collisionCandidate, otherCollisionCandidate);
  assert.throws(
    () => sanitizeRoleSessionName("job-1", "invalid prefix "),
    ConnectionIntegrityError,
  );
});

test("the compact STS session policy adds a read-family intersection cap to the attested role", () => {
  const roleArn = "arn:aws:iam::123456789012:role/sutra/SutraReadOnlyRole";
  const serialized = readonlyMetadataSessionPolicy(roleArn);
  const policy = JSON.parse(serialized) as {
    Statement: Array<{
      Effect: string;
      Action?: string[];
      NotAction?: string[];
      Resource?: string;
      NotResource?: string;
    }>;
  };
  const allows = policy.Statement.filter((statement) => statement.Effect === "Allow");
  const actions = allows.flatMap((statement) => statement.Action ?? []);

  assert.ok(serialized.length <= 900);
  assert.equal(policy.Statement.length, 1);
  assert.equal(policy.Statement.some((statement) => "Sid" in statement), false);
  assert.equal(policy.Statement.every((statement) => statement.Effect === "Allow"), true);
  assert.equal(
    actions.every((action) => /^[a-z0-9]+:(?:Get|List|Describe|Lookup|BatchGet)[A-Za-z*]+$/u.test(action)),
    true,
  );
  assert.equal(allows[0]?.Resource, "*");
});

test("the compact session cap covers every exact permission-pack action", () => {
  const roleArn = "arn:aws:iam::123456789012:role/sutra/SutraReadOnlyRole";
  const policy = JSON.parse(readonlyMetadataSessionPolicy(roleArn)) as {
    Statement: Array<{ Effect: string; Action?: string[]; NotAction?: string[]; Resource?: string }>;
  };
  const metadata = policy.Statement.find(
    (statement) => statement.Effect === "Allow" && statement.Resource === "*",
  );
  const patterns = metadata?.Action ?? [];
  for (const action of EXPECTED_IMPLEMENTED_READ_ACTIONS) {
    assert.equal(
      patterns.some((pattern) => pattern.endsWith("*")
        ? action.startsWith(pattern.slice(0, -1))
        : action === pattern),
      true,
      action,
    );
  }
  for (const action of EXPECTED_TRUST_ACTIONS) {
    assert.equal(
      patterns.some((pattern) => pattern.endsWith("*")
        ? action.startsWith(pattern.slice(0, -1))
        : action === pattern),
      true,
      action,
    );
  }
});

test("workload STS and IAM clients use bounded standard-retry HTTP timeouts", () => {
  assert.equal(AWS_BROKER_CONNECTION_TIMEOUT_MS, 5_000);
  assert.equal(AWS_BROKER_REQUEST_TIMEOUT_MS, 10_000);
  assert.deepEqual(workloadIdentityAwsClientConfig("us-east-1"), {
    retryMode: "standard",
    maxAttempts: 4,
    requestHandler: {
      connectionTimeout: 5_000,
      requestTimeout: 10_000,
    },
    region: "us-east-1",
  });
  assert.deepEqual(workloadIdentityAwsClientConfig(undefined, 2), {
    retryMode: "standard",
    maxAttempts: 2,
    requestHandler: {
      connectionTimeout: 5_000,
      requestTimeout: 10_000,
    },
  });
});

test("positive AssumeRole/GetCallerIdentity contract uses registry trust material", async () => {
  const stored = connection();
  const registry = new MemoryRegistry(stored);
  const assume = new FakeAssumeRoleClient(() => successfulAssumeRole());
  let identityCredentialsAccessKey = "";
  const identityClient = new FakeCallerIdentityClient(() => {
    const sessionName = assume.calls[0]?.RoleSessionName;
    assert.ok(sessionName);
    return {
      $metadata: { httpStatusCode: 200 },
      Account: stored.expectedAccountId,
      Arn: `arn:aws:sts::${stored.expectedAccountId}:assumed-role/SutraReadOnlyRole/${sessionName}`,
      UserId: `AROATEST:${sessionName}`,
    };
  });
  const broker = new AwsRoleBroker({
    registry,
    assumeRoleClient: assume,
    expectedPrincipalArn: COLLECTOR_PRINCIPAL_ARN,
    roleContractClientFactory: () => expectedRoleContractClient(stored),
    callerIdentityClientFactory: (credentials) => {
      identityCredentialsAccessKey = credentials.accessKeyId;
      return identityClient;
    },
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  });

  const session = await broker.assumeValidatedSession(
    scope,
    stored.connectionId,
    "scan-job-01",
  );

  assert.equal(assume.calls.length, 1);
  assert.equal(assume.calls[0]?.RoleArn, stored.roleArn);
  assert.equal(assume.calls[0]?.ExternalId, stored.externalId);
  assert.equal(assume.calls[0]?.DurationSeconds, 900);
  assert.equal(assume.calls[0]?.Policy, readonlyMetadataSessionPolicy(stored.roleArn));
  assert.equal(identityCredentialsAccessKey, "ASIAEXAMPLE");
  assert.equal(identityClient.calls, 1);
  assert.equal(session.accountId, stored.expectedAccountId);
  assert.equal(session.credentials.sessionToken, "session-token-not-for-logs");
});

test("an active legacy permission pack is denied before STS is called", async () => {
  const stored = connection({ permissionPackVersion: "live-demo-2026-07.1" });
  const assume = new FakeAssumeRoleClient(() => successfulAssumeRole());
  const broker = new AwsRoleBroker({
    registry: new MemoryRegistry(stored),
    assumeRoleClient: assume,
    expectedPrincipalArn: COLLECTOR_PRINCIPAL_ARN,
    roleContractClientFactory: () => expectedRoleContractClient(stored),
    callerIdentityClientFactory: () => new FakeCallerIdentityClient(() => ({ $metadata: {} })),
  });
  await assert.rejects(
    broker.assumeValidatedSession(scope, stored.connectionId, "legacy-pack-job"),
    /not in a state/u,
  );
  assert.equal(assume.calls.length, 0);
});

test("AssumeRole access denial is classified as trust drift while transient STS failure is not", async () => {
  const stored = connection();
  const denied = new FakeAssumeRoleClient(() => {
    throw accessDenied();
  });
  await assert.rejects(
    brokerWithIdentity(new MemoryRegistry(stored), denied, stored)
      .assumeValidatedSession(scope, stored.connectionId, "denied-role-job"),
    AssumeRoleDeniedError,
  );

  const transient = new FakeAssumeRoleClient(() => {
    const error = new Error("STS request timed out");
    error.name = "TimeoutError";
    throw error;
  });
  await assert.rejects(
    brokerWithIdentity(new MemoryRegistry(stored), transient, stored)
      .assumeValidatedSession(scope, stored.connectionId, "transient-role-job"),
    AssumeRoleFailedError,
  );
});

test("onboarding requires positive validation plus missing and wrong ExternalId denials", async () => {
  const stored = connection({ status: "PENDING" });
  const registry = new MemoryRegistry(stored);
  const assume = new FakeAssumeRoleClient((input) => {
    if (input.ExternalId === stored.externalId) {
      return successfulAssumeRole();
    }
    throw accessDenied();
  });
  const identityClient = new FakeCallerIdentityClient(() => {
    const sessionName = assume.calls[0]?.RoleSessionName;
    assert.ok(sessionName);
    return {
      $metadata: {},
      Account: stored.expectedAccountId,
      Arn: `arn:aws:sts::${stored.expectedAccountId}:assumed-role/SutraReadOnlyRole/${sessionName}`,
      UserId: `AROATEST:${sessionName}`,
    };
  });
  const broker = new AwsRoleBroker({
    registry,
    assumeRoleClient: assume,
    expectedPrincipalArn: COLLECTOR_PRINCIPAL_ARN,
    roleContractClientFactory: () => expectedRoleContractClient(stored),
    callerIdentityClientFactory: () => identityClient,
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  });

  const verification = await broker.verifyOnboardingTrust(
    scope,
    stored.connectionId,
    "onboard-job-01",
  );

  assert.equal(assume.calls.length, 3);
  assert.equal(assume.calls[0]?.ExternalId, stored.externalId);
  assert.equal(assume.calls[1]?.ExternalId, undefined);
  assert.ok(assume.calls[2]?.ExternalId);
  assert.notEqual(assume.calls[2]?.ExternalId, stored.externalId);
  assert.equal(assume.calls[1]?.RoleSessionName, assume.calls[0]?.RoleSessionName);
  assert.equal(assume.calls[2]?.RoleSessionName, assume.calls[0]?.RoleSessionName);
  assert.ok(assume.calls.every((call) => call.Policy === assume.calls[0]?.Policy));
  assert.equal(assume.calls[2]?.ExternalId?.length, stored.externalId.length);
  assert.equal(
    assume.calls[2]?.ExternalId?.slice(0, -1),
    stored.externalId.slice(0, -1),
  );
  assert.equal(verification.missingExternalIdDenied, true);
  assert.equal(verification.wrongExternalIdDenied, true);
  assert.equal(JSON.stringify(verification).includes(stored.externalId), false);
  assert.equal(JSON.stringify(verification).includes("session-token-not-for-logs"), false);
});

test("an active connection can explicitly revalidate the unchanged trust contract", async () => {
  const stored = connection({ status: "ACTIVE" });
  const registry = new MemoryRegistry(stored);
  const assume = new FakeAssumeRoleClient((input) => {
    if (input.ExternalId === stored.externalId) {
      return successfulAssumeRole();
    }
    throw accessDenied();
  });
  const broker = brokerWithIdentity(registry, assume, stored);

  const verification = await broker.verifyOnboardingTrust(
    scope,
    stored.connectionId,
    "revalidate-job-01",
  );

  assert.equal(assume.calls.length, 3);
  assert.equal(verification.accountId, stored.expectedAccountId);
  assert.equal(verification.missingExternalIdDenied, true);
  assert.equal(verification.wrongExternalIdDenied, true);
});

test("onboarding rejects a role that succeeds without ExternalId", async () => {
  const stored = connection({ status: "PENDING" });
  const registry = new MemoryRegistry(stored);
  const assume = new FakeAssumeRoleClient((input) => {
    if (input.ExternalId === undefined || input.ExternalId === stored.externalId) {
      return successfulAssumeRole();
    }
    throw accessDenied();
  });
  const broker = brokerWithIdentity(registry, assume, stored);

  await assert.rejects(
    broker.verifyOnboardingTrust(scope, stored.connectionId, "onboard-job-02"),
    (error: unknown) =>
      error instanceof UnsafeTrustPolicyError &&
      error.probe === "MISSING_EXTERNAL_ID",
  );
  assert.equal(assume.calls.length, 3, "both negative probes must execute");
});

test("onboarding rejects a role that succeeds with a wrong ExternalId", async () => {
  const stored = connection({ status: "PENDING" });
  const registry = new MemoryRegistry(stored);
  const assume = new FakeAssumeRoleClient((input) => {
    if (input.ExternalId === undefined) {
      throw accessDenied();
    }
    return successfulAssumeRole();
  });
  const broker = brokerWithIdentity(registry, assume, stored);

  await assert.rejects(
    broker.verifyOnboardingTrust(scope, stored.connectionId, "onboard-job-03"),
    (error: unknown) =>
      error instanceof UnsafeTrustPolicyError && error.probe === "WRONG_EXTERNAL_ID",
  );
  assert.equal(assume.calls.length, 3, "both negative probes must execute");
});

test("onboarding rejects prefix-wildcard ExternalId trust even when the session name is restricted", async () => {
  const stored = connection({ status: "PENDING", externalId: "sutra_abcdefghijklmnopqrstuvwxyz123456" });
  const registry = new MemoryRegistry(stored);
  let acceptedSessionName: string | undefined;
  const assume = new FakeAssumeRoleClient((input) => {
    acceptedSessionName ??= input.RoleSessionName;
    if (
      input.RoleSessionName === acceptedSessionName &&
      typeof input.ExternalId === "string" &&
      input.ExternalId.startsWith("sutra_")
    ) {
      return successfulAssumeRole();
    }
    throw accessDenied();
  });
  const broker = brokerWithIdentity(registry, assume, stored);

  await assert.rejects(
    broker.verifyOnboardingTrust(scope, stored.connectionId, "onboard-job-prefix-wildcard"),
    (error: unknown) =>
      error instanceof UnsafeTrustPolicyError && error.probe === "WRONG_EXTERNAL_ID",
  );
  assert.equal(assume.calls.length, 3);
  assert.ok(assume.calls.every((call) => call.RoleSessionName === acceptedSessionName));
});

test("onboarding rejects a role whose fetched trust policy is not an exact StringEquals contract", async () => {
  const stored = connection({ status: "PENDING", externalId: "sutra_abcdefghijklmnopqrstuvwxyz123456" });
  const registry = new MemoryRegistry(stored);
  const assume = new FakeAssumeRoleClient((input) => {
    if (input.ExternalId === stored.externalId) return successfulAssumeRole();
    throw accessDenied();
  });
  const base = expectedRoleContractClient(stored);
  const broker = new AwsRoleBroker({
    registry,
    assumeRoleClient: assume,
    expectedPrincipalArn: COLLECTOR_PRINCIPAL_ARN,
    callerIdentityClientFactory: () => new FakeCallerIdentityClient(() => {
      const sessionName = assume.calls[0]?.RoleSessionName;
      assert.ok(sessionName);
      return {
        $metadata: {},
        Account: stored.expectedAccountId,
        Arn: `arn:aws:sts::${stored.expectedAccountId}:assumed-role/SutraReadOnlyRole/${sessionName}`,
        UserId: `AROATEST:${sessionName}`,
      };
    }),
    roleContractClientFactory: () => ({
      ...base,
      getRole: async (roleName) => ({
        ...(await base.getRole(roleName)),
        assumeRolePolicyDocument: encodeURIComponent(JSON.stringify({
          Version: "2012-10-17",
          Statement: [{
            Sid: "ExactCollectorWithConnectionExternalId",
            Effect: "Allow",
            Principal: { AWS: COLLECTOR_PRINCIPAL_ARN },
            Action: "sts:AssumeRole",
            Condition: {
              StringLike: {
                "sts:ExternalId": "sutra_*",
                "sts:RoleSessionName": "mspcmdb-*",
              },
            },
          }],
        })),
      }),
    }),
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  });

  await assert.rejects(
    broker.verifyOnboardingTrust(scope, stored.connectionId, "onboard-job-attestation"),
    (error: unknown) =>
      error instanceof UnsafeTrustPolicyError && error.probe === "ROLE_CONTRACT",
  );
});

test("onboarding rejects wildcard-principal trust even when ExternalId is exact", async () => {
  const stored = connection({ status: "PENDING" });
  const registry = new MemoryRegistry(stored);
  const assume = new FakeAssumeRoleClient((input) => {
    if (input.ExternalId === stored.externalId) return successfulAssumeRole();
    throw accessDenied();
  });
  const base = expectedRoleContractClient(stored);
  const broker = new AwsRoleBroker({
    registry,
    assumeRoleClient: assume,
    expectedPrincipalArn: COLLECTOR_PRINCIPAL_ARN,
    callerIdentityClientFactory: () => new FakeCallerIdentityClient(() => {
      const sessionName = assume.calls[0]?.RoleSessionName;
      assert.ok(sessionName);
      return {
        $metadata: {},
        Account: stored.expectedAccountId,
        Arn: `arn:aws:sts::${stored.expectedAccountId}:assumed-role/SutraReadOnlyRole/${sessionName}`,
        UserId: `AROATEST:${sessionName}`,
      };
    }),
    roleContractClientFactory: () => ({
      ...base,
      getRole: async (roleName) => ({
        ...(await base.getRole(roleName)),
        assumeRolePolicyDocument: encodeURIComponent(JSON.stringify({
          Version: "2012-10-17",
          Statement: [{
            Sid: "ExactCollectorWithConnectionExternalId",
            Effect: "Allow",
            Principal: { AWS: "*" },
            Action: "sts:AssumeRole",
            Condition: {
              StringEquals: { "sts:ExternalId": stored.externalId },
              StringLike: { "sts:RoleSessionName": "mspcmdb-*" },
            },
          }],
        })),
      }),
    }),
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  });

  await assert.rejects(
    broker.verifyOnboardingTrust(scope, stored.connectionId, "wildcard-principal"),
    (error: unknown) =>
      error instanceof UnsafeTrustPolicyError && error.probe === "ROLE_CONTRACT",
  );
});

test("customer-managed dedicated roles support a dynamic path/name and report missing capabilities", async () => {
  const missingAction = "ce:GetCostForecast";
  const grantedActions = IMPLEMENTED_READ_ACTIONS.filter((action) => action !== missingAction);
  const stored = connection({
    status: "PENDING",
    roleProvisioningMode: "customer_managed",
    expectedRolePath: "/sutra/acme/security/",
    expectedRoleName: "AcmeSutraEvidenceRole",
    roleArn: "arn:aws:iam::123456789012:role/sutra/acme/security/AcmeSutraEvidenceRole",
  });
  const registry = new MemoryRegistry(stored);
  const assume = new FakeAssumeRoleClient((input) => {
    if (input.ExternalId === stored.externalId) return successfulAssumeRole();
    throw accessDenied();
  });
  const broker = new AwsRoleBroker({
    registry,
    assumeRoleClient: assume,
    expectedPrincipalArn: COLLECTOR_PRINCIPAL_ARN,
    roleContractClientFactory: () => expectedRoleContractClient(stored, { metadataActions: grantedActions }),
    callerIdentityClientFactory: () => new FakeCallerIdentityClient(() => {
      const sessionName = assume.calls[0]?.RoleSessionName;
      assert.ok(sessionName);
      return {
        $metadata: {},
        Account: stored.expectedAccountId,
        Arn: `arn:aws:sts::${stored.expectedAccountId}:assumed-role/AcmeSutraEvidenceRole/${sessionName}`,
        UserId: `AROATEST:${sessionName}`,
      };
    }),
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  });

  const verification = await broker.verifyOnboardingTrust(
    scope,
    stored.connectionId,
    "custom-role-onboarding",
  );

  assert.deepEqual(verification.capabilityAssessment.missingActions, [missingAction]);
  assert.deepEqual(verification.capabilityAssessment.grantedActions, grantedActions);
  assert.equal(assume.calls[0]?.DurationSeconds, 900);
  assert.equal(assume.calls[0]?.Policy, readonlyMetadataSessionPolicy(stored.roleArn));
});

test("customer-managed roles reject attached AdministratorAccess", async () => {
  const stored = connection({
    status: "PENDING",
    roleProvisioningMode: "customer_managed",
    expectedRolePath: "/sutra/customer/",
    expectedRoleName: "SutraEvidenceRole",
    roleArn: "arn:aws:iam::123456789012:role/sutra/customer/SutraEvidenceRole",
  });
  const assume = new FakeAssumeRoleClient((input) => {
    if (input.ExternalId === stored.externalId) return successfulAssumeRole();
    throw accessDenied();
  });
  const registry = new MemoryRegistry(stored);
  const base = expectedRoleContractClient(stored, {
    attachedPolicies: [{
      policyName: "AdministratorAccess",
      policyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
    }],
  });
  const broker = new AwsRoleBroker({
    registry,
    assumeRoleClient: assume,
    expectedPrincipalArn: COLLECTOR_PRINCIPAL_ARN,
    roleContractClientFactory: () => base,
    callerIdentityClientFactory: () => new FakeCallerIdentityClient(() => {
      const sessionName = assume.calls[0]?.RoleSessionName;
      assert.ok(sessionName);
      return {
        $metadata: {},
        Account: stored.expectedAccountId,
        Arn: `arn:aws:sts::${stored.expectedAccountId}:assumed-role/SutraEvidenceRole/${sessionName}`,
        UserId: `AROATEST:${sessionName}`,
      };
    }),
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  });

  await assert.rejects(
    broker.verifyOnboardingTrust(scope, stored.connectionId, "attached-admin-policy"),
    (error: unknown) =>
      error instanceof UnsafeTrustPolicyError && error.probe === "ROLE_CONTRACT",
  );
});

test("customer-managed permission subsets reject any unimplemented extra action", async () => {
  const stored = connection({
    status: "PENDING",
    roleProvisioningMode: "customer_managed",
    expectedRolePath: "/sutra/customer/",
    expectedRoleName: "SutraEvidenceRole",
    roleArn: "arn:aws:iam::123456789012:role/sutra/customer/SutraEvidenceRole",
  });
  const assume = new FakeAssumeRoleClient((input) => {
    if (input.ExternalId === stored.externalId) return successfulAssumeRole();
    throw accessDenied();
  });
  const broker = new AwsRoleBroker({
    registry: new MemoryRegistry(stored),
    assumeRoleClient: assume,
    expectedPrincipalArn: COLLECTOR_PRINCIPAL_ARN,
    roleContractClientFactory: () => expectedRoleContractClient(stored, {
      metadataActions: [...IMPLEMENTED_READ_ACTIONS, "iam:CreateUser"],
    }),
    callerIdentityClientFactory: () => new FakeCallerIdentityClient(() => {
      const sessionName = assume.calls[0]?.RoleSessionName;
      assert.ok(sessionName);
      return {
        $metadata: {},
        Account: stored.expectedAccountId,
        Arn: `arn:aws:sts::${stored.expectedAccountId}:assumed-role/SutraEvidenceRole/${sessionName}`,
        UserId: `AROATEST:${sessionName}`,
      };
    }),
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  });

  await assert.rejects(
    broker.verifyOnboardingTrust(scope, stored.connectionId, "extra-action"),
    (error: unknown) =>
      error instanceof UnsafeTrustPolicyError && error.probe === "ROLE_CONTRACT",
  );
});

test("unsafe admin and shared operational role names are rejected before STS", async () => {
  for (const roleName of [
    "customer-admin-role",
    "AdministratorAccess",
    "shared-operations-role",
    "OrganizationAccountAccessRole",
  ]) {
    const stored = connection({
      roleProvisioningMode: "customer_managed",
      expectedRolePath: "/sutra/customer/",
      expectedRoleName: roleName,
      roleArn: `arn:aws:iam::123456789012:role/sutra/customer/${roleName}`,
    });
    const assume = new FakeAssumeRoleClient(() => successfulAssumeRole());
    const broker = brokerWithIdentity(new MemoryRegistry(stored), assume, stored);
    await assert.rejects(
      broker.assumeValidatedSession(scope, stored.connectionId, `unsafe-${roleName}`),
      ConnectionIntegrityError,
    );
    assert.equal(assume.calls.length, 0);
  }
});

test("every scan re-attests the role and rejects managed-policy drift", async () => {
  const stored = connection({ status: "ACTIVE" });
  const registry = new MemoryRegistry(stored);
  const assume = new FakeAssumeRoleClient((input) => {
    if (input.ExternalId === stored.externalId) return successfulAssumeRole();
    throw accessDenied();
  });
  const base = expectedRoleContractClient(stored);
  let drifted = false;
  const broker = new AwsRoleBroker({
    registry,
    assumeRoleClient: assume,
    expectedPrincipalArn: COLLECTOR_PRINCIPAL_ARN,
    roleContractClientFactory: () => ({
      ...base,
      listAttachedRolePolicies: async () => ({
        policies: drifted
          ? [{ policyName: "AdministratorAccess", policyArn: "arn:aws:iam::aws:policy/AdministratorAccess" }]
          : [],
        isTruncated: false,
      }),
    }),
    callerIdentityClientFactory: () => new FakeCallerIdentityClient(() => {
      const sessionName = assume.calls.at(-1)?.RoleSessionName;
      assert.ok(sessionName);
      return {
        $metadata: {},
        Account: stored.expectedAccountId,
        Arn: `arn:aws:sts::${stored.expectedAccountId}:assumed-role/SutraReadOnlyRole/${sessionName}`,
        UserId: `AROATEST:${sessionName}`,
      };
    }),
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  });

  await broker.verifyOnboardingTrust(scope, stored.connectionId, "drift-baseline");
  drifted = true;
  await assert.rejects(
    broker.assumeValidatedSession(scope, stored.connectionId, "drifted-scan"),
    (error: unknown) =>
      error instanceof UnsafeTrustPolicyError && error.probe === "ROLE_CONTRACT",
  );
});

test("a transient negative-probe error is inconclusive, never treated as a safe denial", async () => {
  const stored = connection({ status: "PENDING" });
  const registry = new MemoryRegistry(stored);
  const assume = new FakeAssumeRoleClient((input) => {
    if (input.ExternalId === stored.externalId) {
      return successfulAssumeRole();
    }
    const error = new Error("retry later");
    error.name = "ThrottlingException";
    throw error;
  });
  const broker = brokerWithIdentity(registry, assume, stored);

  await assert.rejects(
    broker.verifyOnboardingTrust(scope, stored.connectionId, "onboard-job-04"),
    (error: unknown) => error instanceof NegativeProbeInconclusiveError,
  );
});

function brokerWithIdentity(
  registry: ScopedConnectionRegistry,
  assume: FakeAssumeRoleClient,
  stored: StoredAwsConnection,
): AwsRoleBroker {
  return new AwsRoleBroker({
    registry,
    assumeRoleClient: assume,
    expectedPrincipalArn: COLLECTOR_PRINCIPAL_ARN,
    roleContractClientFactory: () => expectedRoleContractClient(stored),
    callerIdentityClientFactory: () =>
      new FakeCallerIdentityClient(() => {
        const sessionName = assume.calls[0]?.RoleSessionName;
        assert.ok(sessionName);
        const expectedRoleName = parseIamRoleArn(stored.roleArn).roleName;
        return {
          $metadata: {},
          Account: stored.expectedAccountId,
          Arn: `arn:aws:sts::${stored.expectedAccountId}:assumed-role/${expectedRoleName}/${sessionName}`,
          UserId: `AROATEST:${sessionName}`,
        };
      }),
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  });
}

// ─── AGENTLESS SESSION CEILING ───────────────────────────────────────────────
// The product promises Sutra can never delete anything in a customer account.
// These tests are the code-side half of that promise: the read-only collector cap
// must stay read-only, and the agentless cap must stay narrow.

const AGENTLESS_ROLE_ARN = "arn:aws:iam::123456789012:role/sutra/SutraCollectorRole";

function agentlessPolicy(): {
  Statement: Array<{ Effect: string; Action?: string[]; Resource?: string }>;
} {
  return JSON.parse(agentlessSnapshotSessionPolicy(AGENTLESS_ROLE_ARN)) as {
    Statement: Array<{ Effect: string; Action?: string[]; Resource?: string }>;
  };
}

function agentlessAllowed(): string[] {
  return agentlessPolicy().Statement
    .filter((statement) => statement.Effect === "Allow")
    .flatMap((statement) => statement.Action ?? []);
}

test("the agentless session cap allows exactly three writes and nothing more", () => {
  const writes = agentlessAllowed().filter(
    (action) => !action.startsWith("sts:") && !action.endsWith(":Describe*"),
  );
  // Any fourth write action here is a privilege expansion and must be a
  // deliberate, reviewed change — not something a refactor can add quietly.
  assert.deepEqual(writes.sort(), [
    "ec2:CreateSnapshot",
    "ec2:CreateTags",
    "ec2:ModifySnapshotAttribute",
  ]);
});

test("the agentless session cap denies every destructive verb explicitly", () => {
  const denies = agentlessPolicy().Statement
    .filter((statement) => statement.Effect === "Deny")
    .flatMap((statement) => statement.Action ?? []);
  for (const verb of ["ec2:Delete*", "ec2:Detach*", "ec2:Terminate*", "ec2:Stop*", "ec2:Reboot*"]) {
    assert.ok(denies.includes(verb), verb);
  }
  // A wildcard Deny on Modify* would also kill the share the scan depends on, so
  // the volume/instance verbs are named. Assert the names, not a pattern.
  assert.ok(denies.includes("ec2:ModifyVolume"));
  assert.ok(denies.includes("ec2:ModifyInstanceAttribute"));
  assert.ok(!denies.includes("ec2:Modify*"), "a Modify* deny would break snapshot sharing");
});

test("no deny pattern in the agentless cap can swallow an action it must allow", () => {
  // Matches how IAM evaluates a policy wildcard: `*` only, no character classes.
  const matches = (pattern: string, action: string): boolean =>
    new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "u")
      .test(action);
  const denies = agentlessPolicy().Statement
    .filter((statement) => statement.Effect === "Deny")
    .flatMap((statement) => statement.Action ?? []);
  for (const allowed of agentlessAllowed()) {
    for (const deny of denies) {
      assert.equal(matches(deny, allowed), false, `${deny} would deny ${allowed}`);
    }
  }
});

test("every deny pattern is a real IAM wildcard — no character classes", () => {
  const denies = agentlessPolicy().Statement
    .filter((statement) => statement.Effect === "Deny")
    .flatMap((statement) => statement.Action ?? []);
  for (const pattern of denies) {
    // IAM supports only `*` and `?`. A `[!S]`-style class is silently literal,
    // so the deny it was meant to express would match nothing at all.
    assert.match(pattern, /^[a-z0-9]+:[A-Za-z0-9*?]+$/u, pattern);
  }
});

test("the agentless cap stays inside the packed-policy limit and is separate from the read cap", () => {
  const serialized = agentlessSnapshotSessionPolicy(AGENTLESS_ROLE_ARN);
  assert.ok(serialized.length <= 900, `${serialized.length} bytes`);
  // The two ceilings must never converge: every scheduled collection uses the
  // read cap, and it must not gain snapshot-creation because one opt-in feature
  // needs it.
  const readCap = readonlyMetadataSessionPolicy(AGENTLESS_ROLE_ARN);
  assert.notEqual(serialized, readCap);
  for (const write of ["CreateSnapshot", "CreateTags", "ModifySnapshotAttribute"]) {
    assert.equal(readCap.includes(write), false, `the read-only cap must not grant ${write}`);
  }
});

test("the agentless cap validates the role ARN like every other broker entry point", () => {
  assert.throws(() => agentlessSnapshotSessionPolicy("not-an-arn"));
  assert.throws(() => agentlessSnapshotSessionPolicy("arn:aws:iam::123456789012:user/someone"));
});
