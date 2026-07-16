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
  accountIdFromRoleArn,
  parseIamRoleArn,
  readonlyMetadataSessionPolicy,
  sanitizeRoleSessionName,
  workloadIdentityAwsClientConfig,
} from "../src/role-broker.js";
import {
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
  "ce:GetCostAndUsage",
  "ce:GetCostForecast",
] as const;
const EXPECTED_TRUST_ACTIONS = ["iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy"] as const;

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
    permissionPackVersion: "live-demo-2026-07.2",
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

function expectedRoleContractClient(stored: StoredAwsConnection): RoleContractClient {
  const capped = JSON.parse(readonlyMetadataSessionPolicy(stored.roleArn)) as {
    Statement: Array<{ Effect: string; Action?: string[]; Resource?: string }>;
  };
  const metadata = capped.Statement.find(
    (statement) => statement.Effect === "Allow" && statement.Resource === "*",
  );
  const attestation = capped.Statement.find(
    (statement) => statement.Effect === "Allow" && statement.Resource === stored.roleArn,
  );
  return {
    getRole: async () => ({
      arn: stored.roleArn,
      roleName: "SutraReadOnlyRole",
      path: "/sutra/",
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
        { key: "sutra:permission-pack", value: "live-demo-2026-07.2" },
        { key: "sutra:managed-by", value: "cloudformation" },
      ],
    }),
    listRolePolicies: async () => ({
      policyNames: ["SutraImplementedMetadataCollectors"],
      isTruncated: false,
    }),
    getRolePolicy: async () => ({
      policyDocument: encodeURIComponent(JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "DenyUnimplementedActions",
            Effect: "Deny",
            NotAction: [...(metadata?.Action ?? []), ...(attestation?.Action ?? [])],
            Resource: "*",
          },
          {
            Sid: "ImplementedMetadataApis",
            Effect: "Allow",
            Action: metadata?.Action ?? [],
            Resource: "*",
          },
          {
            Sid: "TrustContractAttestation",
            Effect: "Allow",
            Action: attestation?.Action ?? [],
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

test("the fixed STS session policy caps an overprivileged customer role to implemented reads", () => {
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
  const denyOutside = policy.Statement.find(
    (statement) => statement.Effect === "Deny" && statement.NotAction !== undefined,
  );
  const denyTrustScope = policy.Statement.find(
    (statement) => statement.Effect === "Deny" && statement.NotResource === roleArn,
  );

  assert.ok(serialized.length <= 1_800);
  assert.equal(policy.Statement.some((statement) => "Sid" in statement), false);
  assert.ok(actions.includes("ec2:DescribeInstances"));
  assert.ok(actions.includes("ce:GetCostAndUsage"));
  assert.ok(actions.includes("ce:GetCostForecast"));
  assert.ok(actions.includes("cloudtrail:LookupEvents"));
  assert.ok(actions.includes("ec2:DescribeVolumes"));
  assert.ok(actions.includes("ec2:DescribeNetworkInterfaces"));
  assert.ok(actions.includes("elasticloadbalancing:DescribeLoadBalancers"));
  assert.ok(actions.includes("kms:DescribeKey"));
  assert.ok(actions.includes("dynamodb:DescribeTable"));
  assert.ok(actions.includes("ecr:DescribeRepositories"));
  assert.ok(actions.includes("iam:GetRole"));
  assert.equal(actions.some((action) => /(?:Put|Create|Delete|Update|Attach|PassRole|AssumeRole)/u.test(action)), false);
  assert.equal(
    allows.find((statement) => statement.Resource === roleArn)?.Resource,
    roleArn,
  );
  assert.equal(denyOutside?.Effect, "Deny");
  assert.deepEqual(new Set(denyOutside?.NotAction), new Set([
    "sts:GetCallerIdentity", "ec2:Describe*", "s3:ListAllMyBuckets",
    "s3:GetBucketPublicAccessBlock", "rds:Describe*", "iam:Get*", "iam:List*",
    "cloudtrail:Describe*", "cloudtrail:GetTrailStatus", "cloudtrail:LookupEvents",
    "guardduty:List*", "guardduty:Get*", "securityhub:Describe*", "securityhub:Get*",
    "inspector2:BatchGet*", "inspector2:List*", "ce:Get*",
    "elasticloadbalancing:Describe*", "kms:List*", "kms:Describe*",
    "dynamodb:List*", "dynamodb:Describe*", "ecr:Describe*",
  ]));
  assert.equal(denyOutside?.Resource, "*");
  assert.equal(denyTrustScope?.Effect, "Deny");
  assert.deepEqual(new Set(denyTrustScope?.Action), new Set([
    "iam:GetRole",
    "iam:ListRolePolicies",
    "iam:GetRolePolicy",
  ]));
  assert.equal(denyTrustScope?.NotResource, roleArn);
});

test("the permission pack exact Allows and compact deny exceptions have independent full parity", () => {
  const roleArn = "arn:aws:iam::123456789012:role/sutra/SutraReadOnlyRole";
  const policy = JSON.parse(readonlyMetadataSessionPolicy(roleArn)) as {
    Statement: Array<{ Effect: string; Action?: string[]; NotAction?: string[]; Resource?: string }>;
  };
  const metadata = policy.Statement.find(
    (statement) => statement.Effect === "Allow" && statement.Resource === "*",
  );
  const trust = policy.Statement.find(
    (statement) => statement.Effect === "Allow" && statement.Resource === roleArn,
  );
  const deny = policy.Statement.find(
    (statement) => statement.Effect === "Deny" && statement.NotAction !== undefined,
  );
  assert.deepEqual(new Set(metadata?.Action), new Set(EXPECTED_IMPLEMENTED_READ_ACTIONS));
  assert.deepEqual(new Set(trust?.Action), new Set(EXPECTED_TRUST_ACTIONS));
  const patterns = deny?.NotAction ?? [];
  for (const action of [...EXPECTED_IMPLEMENTED_READ_ACTIONS, ...EXPECTED_TRUST_ACTIONS]) {
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
        return {
          $metadata: {},
          Account: stored.expectedAccountId,
          Arn: `arn:aws:sts::${stored.expectedAccountId}:assumed-role/SutraReadOnlyRole/${sessionName}`,
          UserId: `AROATEST:${sessionName}`,
        };
      }),
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  });
}
