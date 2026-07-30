import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AssumeRoleCommand,
  AssumeRoleCommandInput,
  AssumeRoleCommandOutput,
  GetCallerIdentityCommand,
  GetCallerIdentityCommandOutput,
} from "@aws-sdk/client-sts";

import { AwsCollectorJobHandler } from "../src/job-handler.js";
import {
  AwsRoleBroker,
  IMPLEMENTED_READ_ACTIONS,
  TRUST_ATTESTATION_ACTIONS,
} from "../src/role-broker.js";
import {
  IdentityMismatchError,
  InvalidJobError,
  type AssumeRoleClient,
  type CallerIdentityClient,
  type ConnectionScope,
  type InventoryCollectionContext,
  type InventoryCollectionResult,
  type InventoryRunner,
  type OnboardingTrustVerification,
  type ScopedConnectionRegistry,
  type StoredAwsConnection,
} from "../src/types.js";

const scope: ConnectionScope = { tenantId: "tenant-01", subjectId: "queue-worker" };
const COLLECTOR_PRINCIPAL_ARN = "arn:aws:iam::999988887777:role/SutraLocalCollector";

class Registry implements ScopedConnectionRegistry {
  public resolveCalls = 0;
  public readonly verificationMarks: OnboardingTrustVerification[] = [];

  public constructor(public stored: StoredAwsConnection) {}

  public async resolve(
    _scope: ConnectionScope,
    _connectionId: string,
  ): Promise<StoredAwsConnection | null> {
    void _scope;
    void _connectionId;
    this.resolveCalls += 1;
    return this.stored;
  }

  public async markOnboardingVerified(
    _scope: ConnectionScope,
    _connectionId: string,
    verification: OnboardingTrustVerification,
  ): Promise<void> {
    this.verificationMarks.push(verification);
  }
}

class AssumeClient implements AssumeRoleClient {
  public readonly calls: AssumeRoleCommandInput[] = [];

  public constructor(
    private readonly responder: (
      input: AssumeRoleCommandInput,
    ) => AssumeRoleCommandOutput,
  ) {}

  public async send(command: AssumeRoleCommand): Promise<AssumeRoleCommandOutput> {
    this.calls.push({ ...command.input });
    return this.responder(command.input);
  }
}

class IdentityClient implements CallerIdentityClient {
  public constructor(
    private readonly responder: () => GetCallerIdentityCommandOutput,
  ) {}

  public async send(
    _command: GetCallerIdentityCommand,
  ): Promise<GetCallerIdentityCommandOutput> {
    void _command;
    return this.responder();
  }
}

class CapturingInventoryRunner implements InventoryRunner {
  public readonly calls: InventoryCollectionContext[] = [];

  public async collect(
    context: InventoryCollectionContext,
  ): Promise<InventoryCollectionResult> {
    this.calls.push(context);
    return {
      resourcesObserved: 12,
      findingsObserved: 3,
      coverage: "COMPLETE",
      collectorCoverage: [
        {
          collectorKey: "ec2.instances",
          region: "us-east-1",
          status: "SUCCEEDED",
          itemsObserved: 12,
          pagesObserved: 1,
        },
      ],
      // Deliberate runtime extra field: the handler must not spread collector output.
      credentials: "must-not-escape",
    } as InventoryCollectionResult;
  }
}

function storedConnection(status: "ACTIVE" | "PENDING" = "ACTIVE"): StoredAwsConnection {
  return {
    tenantId: "tenant-01",
    connectionId: "conn-01",
    expectedAccountId: "123456789012",
    roleArn: "arn:aws:iam::123456789012:role/sutra/SutraReadOnlyRole",
    externalId: "4a3e789b-5a2e-47db-9cab-226cbe52fc04",
    status,
    permissionPackVersion: "standard-2026-07.4",
    sessionNamePrefix: "mspcmdb-",
  };
}

function assumeOutput(): AssumeRoleCommandOutput {
  return {
    $metadata: {},
    Credentials: {
      AccessKeyId: "ASIAHANDLER",
      SecretAccessKey: "secret-not-for-handler-output",
      SessionToken: "token-not-for-handler-output",
      Expiration: new Date("2099-01-01T00:00:00.000Z"),
    },
  };
}

function denied(): never {
  const error = new Error("denied");
  error.name = "AccessDenied";
  throw error;
}

test("handler rejects client-supplied role material before registry or STS access", async () => {
  const stored = storedConnection();
  const registry = new Registry(stored);
  const assume = new AssumeClient(() => assumeOutput());
  const runner = new CapturingInventoryRunner();
  const handler = createHandler(registry, assume, runner, stored.expectedAccountId);

  await assert.rejects(
    handler.handleInventoryJob(scope, {
      jobId: "job-01",
      connectionId: stored.connectionId,
      roleArn: "arn:aws:iam::999999999999:role/attacker",
      externalId: "attacker-controlled-external-id",
    }),
    InvalidJobError,
  );

  assert.equal(registry.resolveCalls, 0);
  assert.equal(assume.calls.length, 0);
  assert.equal(runner.calls.length, 0);
});

test("handler returns an allowlisted summary and never returns temporary credentials", async () => {
  const stored = storedConnection();
  const registry = new Registry(stored);
  const assume = new AssumeClient(() => assumeOutput());
  const runner = new CapturingInventoryRunner();
  const handler = createHandler(registry, assume, runner, stored.expectedAccountId);

  const result = await handler.handleInventoryJob(scope, {
    jobId: "job-02",
    connectionId: stored.connectionId,
  });

  assert.deepEqual(result, {
    jobId: "job-02",
    connectionId: "conn-01",
    accountId: "123456789012",
    partition: "aws",
    resourcesObserved: 12,
    findingsObserved: 3,
    coverage: "COMPLETE",
    completedAt: "2026-07-15T12:00:00.000Z",
  });
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0]?.credentials.accessKeyId, "ASIAHANDLER");
  assert.equal(Object.hasOwn(result, "credentials"), false);
  assert.equal(Object.hasOwn(result, "externalId"), false);
  assert.equal(JSON.stringify(result).includes("token-not-for-handler-output"), false);
  assert.equal(JSON.stringify(result).includes("must-not-escape"), false);
});

test("mismatched caller account fails before inventory collection", async () => {
  const stored = storedConnection();
  const registry = new Registry(stored);
  const assume = new AssumeClient(() => assumeOutput());
  const runner = new CapturingInventoryRunner();
  const handler = createHandler(registry, assume, runner, "000000000000");

  await assert.rejects(
    handler.handleInventoryJob(scope, {
      jobId: "job-03",
      connectionId: stored.connectionId,
    }),
    IdentityMismatchError,
  );
  assert.equal(runner.calls.length, 0);
});

test("onboarding handler marks verified only after both negative probes are denied", async () => {
  const stored = storedConnection("PENDING");
  const registry = new Registry(stored);
  const assume = new AssumeClient((input) => {
    if (input.ExternalId === stored.externalId) {
      return assumeOutput();
    }
    return denied();
  });
  const runner = new CapturingInventoryRunner();
  const handler = createHandler(registry, assume, runner, stored.expectedAccountId);

  const result = await handler.handleOnboardingVerificationJob(scope, {
    jobId: "onboarding-01",
    connectionId: stored.connectionId,
  });

  assert.equal(assume.calls.length, 3);
  assert.equal(registry.verificationMarks.length, 1);
  assert.equal(result.missingExternalIdDenied, true);
  assert.equal(result.wrongExternalIdDenied, true);
  assert.deepEqual(result.capabilityAssessment.missingActions, []);
  assert.ok(result.capabilityAssessment.grantedActions.length > 0);
  assert.equal(Object.hasOwn(result, "credentials"), false);
  assert.equal(Object.hasOwn(result, "externalId"), false);
  assert.equal(JSON.stringify(result).includes(stored.externalId), false);
});

function createHandler(
  registry: Registry,
  assume: AssumeClient,
  runner: InventoryRunner,
  identityAccountId: string,
): AwsCollectorJobHandler {
  const broker = new AwsRoleBroker({
    registry,
    assumeRoleClient: assume,
    expectedPrincipalArn: COLLECTOR_PRINCIPAL_ARN,
    roleContractClientFactory: () => {
      const stored = registry.stored;
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
            { key: "sutra:permission-pack", value: "standard-2026-07.4" },
            { key: "sutra:managed-by", value: "cloudformation" },
          ],
        }),
        listRolePolicies: async () => ({
          policyNames: ["SutraImplementedMetadataCollectors"],
          isTruncated: false,
        }),
        listAttachedRolePolicies: async () => ({
          policies: [],
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
          })),
        }),
      };
    },
    callerIdentityClientFactory: () =>
      new IdentityClient(() => {
        const sessionName = assume.calls[0]?.RoleSessionName;
        assert.ok(sessionName);
        return {
          $metadata: {},
          Account: identityAccountId,
          Arn: `arn:aws:sts::${identityAccountId}:assumed-role/SutraReadOnlyRole/${sessionName}`,
          UserId: `AROATEST:${sessionName}`,
        };
      }),
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  });

  return new AwsCollectorJobHandler({
    roleBroker: broker,
    registry,
    inventoryRunner: runner,
    now: () => new Date("2026-07-15T12:00:00.000Z"),
  });
}
