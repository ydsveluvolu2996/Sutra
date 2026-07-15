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
  accountIdFromRoleArn,
  parseIamRoleArn,
  sanitizeRoleSessionName,
} from "../src/role-broker.js";
import {
  ConnectionIntegrityError,
  NegativeProbeInconclusiveError,
  UnsafeTrustPolicyError,
  type AssumeRoleClient,
  type CallerIdentityClient,
  type ConnectionScope,
  type OnboardingTrustVerification,
  type ScopedConnectionRegistry,
  type StoredAwsConnection,
} from "../src/types.js";

const scope: ConnectionScope = { tenantId: "tenant-01", subjectId: "queue-worker" };

function connection(
  overrides: Partial<StoredAwsConnection> = {},
): StoredAwsConnection {
  return {
    tenantId: "tenant-01",
    connectionId: "conn-01",
    expectedAccountId: "123456789012",
    roleArn: "arn:aws:iam::123456789012:role/mspcmdb/MSPCMDBReadRole",
    externalId: "4a3e789b-5a2e-47db-9cab-226cbe52fc04",
    status: "ACTIVE",
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
      Arn: `arn:aws:sts::${stored.expectedAccountId}:assumed-role/MSPCMDBReadRole/${sessionName}`,
      UserId: `AROATEST:${sessionName}`,
    };
  });
  const broker = new AwsRoleBroker({
    registry,
    assumeRoleClient: assume,
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
  assert.equal(identityCredentialsAccessKey, "ASIAEXAMPLE");
  assert.equal(identityClient.calls, 1);
  assert.equal(session.accountId, stored.expectedAccountId);
  assert.equal(session.credentials.sessionToken, "session-token-not-for-logs");
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
      Arn: `arn:aws:sts::${stored.expectedAccountId}:assumed-role/MSPCMDBReadRole/${sessionName}`,
      UserId: `AROATEST:${sessionName}`,
    };
  });
  const broker = new AwsRoleBroker({
    registry,
    assumeRoleClient: assume,
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
  assert.equal(verification.missingExternalIdDenied, true);
  assert.equal(verification.wrongExternalIdDenied, true);
  assert.equal(JSON.stringify(verification).includes(stored.externalId), false);
  assert.equal(JSON.stringify(verification).includes("session-token-not-for-logs"), false);
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
    callerIdentityClientFactory: () =>
      new FakeCallerIdentityClient(() => {
        const sessionName = assume.calls[0]?.RoleSessionName;
        assert.ok(sessionName);
        return {
          $metadata: {},
          Account: stored.expectedAccountId,
          Arn: `arn:aws:sts::${stored.expectedAccountId}:assumed-role/MSPCMDBReadRole/${sessionName}`,
          UserId: `AROATEST:${sessionName}`,
        };
      }),
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  });
}
