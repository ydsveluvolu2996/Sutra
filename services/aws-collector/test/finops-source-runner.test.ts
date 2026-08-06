import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { setImmediate as waitImmediate } from "node:timers/promises";
import test from "node:test";

import type {
  Anomaly,
  AnomalyMonitor,
  AnomalySubscription,
} from "@aws-sdk/client-cost-explorer";
import type { TrustedAdvisorStandardReader } from "../src/trusted-advisor-standard-runner.js";
import type { ComputeOptimizerExportDiscoveryReader } from "../src/compute-optimizer-export-runner.js";
import type {
  AssumeRoleCommand,
  AssumeRoleCommandInput,
  AssumeRoleCommandOutput,
  GetCallerIdentityCommand,
  GetCallerIdentityCommandOutput,
} from "@aws-sdk/client-sts";
import { COST_ANOMALY_OFFICIAL_ENDPOINT } from "../src/cost-anomaly-runner.js";

import {
  FINOPS_SOURCE_DISPATCH_LIMITS,
  COST_ANOMALY_SOURCE_ACTIONS,
  COST_ANOMALY_SOURCE_PERMISSION_CONTRACT_ID,
  COST_ANOMALY_SOURCE_POLICY_NAME,
  COMPUTE_OPTIMIZER_EXPORT_SOURCE_ACTIONS,
  COMPUTE_OPTIMIZER_EXPORT_SOURCE_PERMISSION_CONTRACT_ID,
  COMPUTE_OPTIMIZER_EXPORT_SOURCE_POLICY_NAME,
  FINOPS_SOURCE_DEFINITIONS,
  FINOPS_SOURCE_MAX_CONCURRENT_DISPATCHES,
  FINOPS_SOURCE_MAX_OPERATION_CONCURRENCY,
  TRUSTED_ADVISOR_STANDARD_SOURCE_ACTIONS,
  TRUSTED_ADVISOR_STANDARD_SOURCE_PERMISSION_CONTRACT_ID,
  TRUSTED_ADVISOR_STANDARD_SOURCE_POLICY_NAME,
  executeFinopsSourceDispatch,
  parseFinopsSourceContracts,
  parseFinopsSourceDispatchRequest,
  type FinopsSourceDispatchDependencies,
  type FinopsSourceDispatchRequest,
} from "../src/finops-source-runner.js";
import {
  parsePersistedConnection,
  type RegisteredAwsConnection,
  type RegisterAwsConnectionInput,
} from "../src/local-registry.js";
import { createLocalCollectorServer } from "../src/local-server.js";
import {
  AwsRoleBroker,
  IMPLEMENTED_READ_ACTIONS,
  TRUST_ATTESTATION_ACTIONS,
  finopsSourceSessionPolicy,
} from "../src/role-broker.js";
import type {
  AssumeRoleClient,
  CallerIdentityClient,
  FinopsSourceContract,
  OnboardingTrustVerification,
  RoleContractClient,
  ScopedConnectionRegistry,
  StoredAwsConnection,
  ValidatedRoleSession,
} from "../src/types.js";
import { UnsafeTrustPolicyError } from "../src/types.js";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const TENANT_ID = "tenant-finops-source";
const CONNECTION_ID = "connection-finops-source";
const CONTRACT_ID = "contract-cost-anomaly-v1";
const ACCOUNT_ID = "123456789012";
const ROLE_ARN = `arn:aws:iam::${ACCOUNT_ID}:role/sutra/SutraCollectorRole`;
const PRINCIPAL_ARN = "arn:aws:iam::999988887777:role/SutraCollector";
const MONITOR_ARN = `arn:aws:ce::${ACCOUNT_ID}:anomalymonitor/monitor-1`;
const SUBSCRIPTION_ARN =
  `arn:aws:ce::${ACCOUNT_ID}:anomalysubscription/subscription-1`;

function sourceContract(
  overrides: Partial<FinopsSourceContract> = {},
): FinopsSourceContract {
  return {
    tenantId: TENANT_ID,
    connectionId: CONNECTION_ID,
    contractId: CONTRACT_ID,
    sourceId: "cost_anomaly_detection",
    accountId: ACCOUNT_ID,
    partition: "aws",
    region: "us-east-1",
    permissionContractId: COST_ANOMALY_SOURCE_PERMISSION_CONTRACT_ID,
    policyName: COST_ANOMALY_SOURCE_POLICY_NAME,
    ...overrides,
  };
}

function connection(
  contracts: readonly FinopsSourceContract[] | null = [sourceContract()],
): StoredAwsConnection {
  return {
    tenantId: TENANT_ID,
    connectionId: CONNECTION_ID,
    expectedAccountId: ACCOUNT_ID,
    roleArn: ROLE_ARN,
    externalId: "source-external-id-1234567890",
    status: "ACTIVE",
    permissionPackVersion: "standard-2026-08.1",
    roleProvisioningMode: "sutra_template",
    expectedRolePath: "/sutra/",
    expectedRoleName: "SutraCollectorRole",
    sessionNamePrefix: "sutra-",
    ...(contracts === null ? {} : { finopsSourceContracts: contracts }),
  };
}

function registeredConnection(
  contracts: readonly FinopsSourceContract[],
): RegisteredAwsConnection {
  return {
    ...connection(contracts),
    partition: "aws",
    enabledRegions: ["us-east-1"],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

class Registry implements ScopedConnectionRegistry {
  public constructor(public stored: StoredAwsConnection | null) {}
  public async resolve(): Promise<StoredAwsConnection | null> {
    return this.stored;
  }
  public async markStaticCredentialVerified(): Promise<void> {
    throw new Error("unexpected static-credential verification");
  }

  public async markOnboardingVerified(
    _scope: { readonly tenantId: string },
    _connectionId: string,
    _verification: OnboardingTrustVerification,
  ): Promise<void> {
    void _scope;
    void _connectionId;
    void _verification;
  }
}

class HttpRegistry extends Registry {
  public override stored: RegisteredAwsConnection | null;

  public constructor(stored: RegisteredAwsConnection) {
    super(stored);
    this.stored = stored;
  }

  public async getRegistered(): Promise<RegisteredAwsConnection | null> {
    return this.stored;
  }
  public async upsert(_input: RegisterAwsConnectionInput): Promise<void> {
    void _input;
  }
  public async disable(): Promise<void> {}
  public async offboard(): Promise<void> {}
  public async activateOnboarding(): Promise<void> {}
  public async discardStagedOnboarding(): Promise<void> {}
}

class Broker {
  public readonly calls: Array<{
    readonly tenantId: string;
    readonly connectionId: string;
    readonly jobId: string;
    readonly contractId: string;
  }> = [];

  public async assumeValidatedFinopsSourceSession(
    scope: { readonly tenantId: string },
    connectionId: string,
    jobId: string,
    contractId: string,
  ): Promise<ValidatedRoleSession> {
    this.calls.push({ tenantId: scope.tenantId, connectionId, jobId, contractId });
    return {
      connectionId,
      accountId: ACCOUNT_ID,
      partition: "aws",
      roleArn: ROLE_ARN,
      roleSessionName: `sutra-${jobId}`.slice(0, 64),
      callerIdentityArn:
        `arn:aws:sts::${ACCOUNT_ID}:assumed-role/SutraCollectorRole/sutra-job`,
      expiresAt: new Date("2026-07-31T12:15:00.000Z"),
      credentials: {
        accessKeyId: "ASIASOURCE",
        secretAccessKey: "secret",
        sessionToken: "token",
        expiration: new Date("2026-07-31T12:15:00.000Z"),
      },
    };
  }
}

class Assume implements AssumeRoleClient {
  public readonly calls: AssumeRoleCommandInput[] = [];
  public async send(command: AssumeRoleCommand): Promise<AssumeRoleCommandOutput> {
    this.calls.push({ ...command.input });
    return {
      $metadata: {},
      Credentials: {
        AccessKeyId: "ASIASOURCE",
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
    const sessionName = this.assume.calls.at(-1)?.RoleSessionName;
    assert.ok(sessionName);
    return {
      $metadata: {},
      Account: ACCOUNT_ID,
      Arn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/SutraCollectorRole/${sessionName}`,
      UserId: `AROASOURCE:${sessionName}`,
    };
  }
}

const FINOPS_FOUNDATIONAL_CEILING = [
  "s3:ListBucket",
  "s3:GetBucketLocation",
  "s3:GetObject",
  "s3:GetObjectAttributes",
  "kms:Decrypt",
  "bcm-data-exports:ListExports",
  "bcm-data-exports:GetExport",
] as const;

function attestedRoleClient(extraSourceAction = false): RoleContractClient {
  return {
    getRole: async () => ({
      arn: ROLE_ARN,
      roleName: "SutraCollectorRole",
      path: "/sutra/",
      maxSessionDuration: 3_600,
      assumeRolePolicyDocument: encodeURIComponent(JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Sid: "ExactCollectorWithConnectionExternalId",
          Effect: "Allow",
          Principal: { AWS: PRINCIPAL_ARN },
          Action: "sts:AssumeRole",
          Condition: {
            StringEquals: {
              "sts:ExternalId": "source-external-id-1234567890",
            },
            StringLike: { "sts:RoleSessionName": "sutra-*" },
          },
        }],
      })),
      tags: [
        { key: "sutra:access-mode", value: "read-only" },
        { key: "sutra:permission-pack", value: "standard-2026-08.1" },
        { key: "sutra:managed-by", value: "cloudformation" },
      ],
    }),
    listRolePolicies: async () => ({
      policyNames: ["SutraImplementedMetadataCollectors", COST_ANOMALY_SOURCE_POLICY_NAME],
      isTruncated: false,
    }),
    listAttachedRolePolicies: async () => ({ policies: [], isTruncated: false }),
    getRolePolicy: async (_roleName, policyName) => ({
      policyDocument: encodeURIComponent(JSON.stringify(
        policyName === "SutraImplementedMetadataCollectors"
          ? {
              Version: "2012-10-17",
              Statement: [
                {
                  Sid: "DenyUnimplementedActions",
                  Effect: "Deny",
                  NotAction: [
                    ...IMPLEMENTED_READ_ACTIONS,
                    ...TRUST_ATTESTATION_ACTIONS,
                    ...FINOPS_FOUNDATIONAL_CEILING,
                    ...COST_ANOMALY_SOURCE_ACTIONS,
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
                  Resource: ROLE_ARN,
                },
              ],
            }
          : {
              Version: "2012-10-17",
              Statement: [{
                Sid: "ExactFinopsSourceRead",
                Effect: "Allow",
                Action: [
                  ...COST_ANOMALY_SOURCE_ACTIONS,
                  ...(extraSourceAction ? ["ce:DeleteAnomalyMonitor"] : []),
                ],
                Resource: "*",
              }],
            },
      )),
    }),
  };
}

function request(suffix = "one"): FinopsSourceDispatchRequest {
  return {
    tenantId: TENANT_ID,
    connectionId: CONNECTION_ID,
    jobId: `job-finops-source-${suffix}`,
    contractId: CONTRACT_ID,
  };
}

function anomaly(): Anomaly {
  return {
    AnomalyId: "anomaly-1",
    AnomalyStartDate: "2026-07-20",
    AnomalyEndDate: "2026-07-21",
    DimensionValue: "private-client-label",
    MonitorArn: MONITOR_ARN,
    AnomalyScore: { CurrentScore: 70, MaxScore: 90 },
    Impact: { MaxImpact: 100 },
    RootCauses: [{
      Service: "Amazon EC2",
      Region: "us-east-1",
      LinkedAccount: ACCOUNT_ID,
      LinkedAccountName: "Jane Doe private account",
      UsageType: "BoxUsage:m7g.large",
      Impact: { Contribution: 100 },
    }],
  };
}

function monitor(): AnomalyMonitor {
  return {
    MonitorArn: MONITOR_ARN,
    MonitorName: "jane.doe@example.invalid monitor",
    MonitorType: "DIMENSIONAL",
    MonitorDimension: "SERVICE",
  };
}

function subscription(): AnomalySubscription {
  return {
    SubscriptionArn: SUBSCRIPTION_ARN,
    SubscriptionName: "Jane Doe finance alerts",
    AccountId: ACCOUNT_ID,
    MonitorArnList: [MONITOR_ARN],
    Subscribers: [{
      Address: "jane.doe@example.invalid",
      Type: "EMAIL",
      Status: "CONFIRMED",
    }],
    Frequency: "DAILY",
  };
}

function dependencies(
  registry = new Registry(connection()),
  broker = new Broker(),
): FinopsSourceDispatchDependencies & { readonly broker: Broker } {
  return {
    registry,
    broker,
    now: () => NOW,
    costAnomalyReader: {
      getAnomalies: async () => ({ Anomalies: [anomaly()] }),
      getAnomalyMonitors: async () => ({ AnomalyMonitors: [monitor()] }),
      getAnomalySubscriptions: async () => ({
        AnomalySubscriptions: [subscription()],
      }),
    },
  };
}

test("dispatches a persisted Cost Anomaly contract and removes caller-defined PII before transport", async () => {
  const deps = dependencies();
  const result = await executeFinopsSourceDispatch(request(), deps);

  assert.equal(result.implementationState, "IMPLEMENTED");
  assert.equal(result.collectionStatus, "COMPLETE");
  assert.equal(result.region, "us-east-1");
  assert.equal(result.coverage.pagesObserved, 3);
  assert.equal(result.coverage.recordsAccepted, 3);
  const operationCoverage = result.evidence?.coverage;
  assert.ok(Array.isArray(operationCoverage));
  assert.deepEqual(
    operationCoverage.map((entry) =>
      typeof entry === "object" && entry !== null && "operation" in entry
        ? entry.operation
        : null
    ),
    [
      "GET_ANOMALIES",
      "GET_ANOMALY_MONITORS",
      "GET_ANOMALY_SUBSCRIPTIONS",
    ],
  );
  assert.deepEqual(deps.broker.calls, [{
    tenantId: TENANT_ID,
    connectionId: CONNECTION_ID,
    jobId: "job-finops-source-one",
    contractId: CONTRACT_ID,
  }]);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("jane.doe@example.invalid"), false);
  assert.equal(serialized.includes("Jane Doe"), false);
  assert.equal(serialized.includes("private-client-label"), false);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("ASIASOURCE"), false);
});

test("dispatches only the exact persisted standard Trusted Advisor Support contract", async () => {
  const contract = sourceContract({
    contractId: "contract-ta-standard-v1",
    sourceId: "trusted_advisor_standard_checks",
    permissionContractId: TRUSTED_ADVISOR_STANDARD_SOURCE_PERMISSION_CONTRACT_ID,
    policyName: TRUSTED_ADVISOR_STANDARD_SOURCE_POLICY_NAME,
  });
  assert.throws(() => parseFinopsSourceContracts([{ ...contract, region: "us-west-2" }], {
    tenantId: TENANT_ID,
    connectionId: CONNECTION_ID,
    expectedAccountId: ACCOUNT_ID,
    partition: "aws",
  }));
  assert.throws(() => parseFinopsSourceContracts([{
    ...contract,
    permissionContractId: "broader-contract",
  }], {
    tenantId: TENANT_ID,
    connectionId: CONNECTION_ID,
    expectedAccountId: ACCOUNT_ID,
    partition: "aws",
  }));
  const supportReader: TrustedAdvisorStandardReader = {
    async describeTrustedAdvisorChecks(input) {
      assert.deepEqual(input, { language: "en" });
      return {
        checks: [{
          id: "check-one",
          name: "Idle resource check",
          description: "Finds an idle resource",
          category: "cost_optimizing",
          metadata: ["Resource", "Savings"],
        }],
      };
    },
    async describeTrustedAdvisorCheckResult(input) {
      assert.deepEqual(input, { checkId: "check-one", language: "en" });
      return {
        result: {
          checkId: "check-one",
          timestamp: "2026-07-31T08:00:00Z",
          status: "warning",
          resourcesSummary: {
            resourcesProcessed: 1,
            resourcesFlagged: 1,
            resourcesIgnored: 0,
            resourcesSuppressed: 0,
          },
          categorySpecificSummary: {},
          flaggedResources: [{
            resourceId: "i-0123456789abcdef0",
            region: "us-east-1",
            status: "warning",
            isSuppressed: false,
            metadata: ["i-0123456789abcdef0", "20"],
          }],
        },
      };
    },
  };
  const deps = {
    ...dependencies(new Registry(connection([contract]))),
    trustedAdvisorStandardReader: supportReader,
  };
  const dispatched = await executeFinopsSourceDispatch({
    ...request("ta-standard"),
    contractId: contract.contractId,
  }, deps);

  assert.equal(dispatched.sourceId, "trusted_advisor_standard_checks");
  assert.equal(dispatched.collectionStatus, "COMPLETE");
  assert.equal(dispatched.dataThroughAt, "2026-07-31T08:00:00.000Z");
  assert.equal(dispatched.coverage.pagesObserved, 2);
  assert.equal(dispatched.coverage.recordsAccepted, 3);
  assert.deepEqual(
    FINOPS_SOURCE_DEFINITIONS.trusted_advisor_standard_checks.actions,
    TRUSTED_ADVISOR_STANDARD_SOURCE_ACTIONS,
  );
  assert.equal(JSON.stringify(dispatched).includes("ASIASOURCE"), false);
  assert.equal(JSON.stringify(dispatched).includes("secret"), false);
});

test("returns sanitized unavailable standard-check evidence when AWS Support access is absent", async () => {
  const contract = sourceContract({
    contractId: "contract-ta-standard-unavailable-v1",
    sourceId: "trusted_advisor_standard_checks",
    permissionContractId: TRUSTED_ADVISOR_STANDARD_SOURCE_PERMISSION_CONTRACT_ID,
    policyName: TRUSTED_ADVISOR_STANDARD_SOURCE_POLICY_NAME,
  });
  const deps = {
    ...dependencies(new Registry(connection([contract]))),
    trustedAdvisorStandardReader: {
      async describeTrustedAdvisorChecks() {
        throw Object.assign(new Error("private AWS error body"), {
          name: "SubscriptionRequiredException",
        });
      },
      async describeTrustedAdvisorCheckResult() {
        throw new Error("must not be called");
      },
    } satisfies TrustedAdvisorStandardReader,
  };
  const dispatched = await executeFinopsSourceDispatch({
    ...request("ta-standard-unavailable"),
    contractId: contract.contractId,
  }, deps);

  assert.equal(dispatched.collectionStatus, "UNAVAILABLE");
  assert.equal(dispatched.errorCode, "SUPPORT_PLAN_REQUIRED");
  assert.equal(dispatched.evidence, null);
  assert.equal(JSON.stringify(dispatched).includes("private AWS error body"), false);
});

test("dispatches the exact Compute Optimizer export-discovery contract without caller AWS controls", async () => {
  const contract = sourceContract({
    contractId: "contract-compute-optimizer-export-v1",
    sourceId: "compute_optimizer_organization_export",
    region: "us-west-2",
    permissionContractId: COMPUTE_OPTIMIZER_EXPORT_SOURCE_PERMISSION_CONTRACT_ID,
    policyName: COMPUTE_OPTIMIZER_EXPORT_SOURCE_POLICY_NAME,
  });
  const inputs: unknown[] = [];
  const computeOptimizerExportReader: ComputeOptimizerExportDiscoveryReader = {
    async getEnrollmentStatus(input) {
      inputs.push(input);
      return {
        status: "Active",
        memberAccountsEnrolled: true,
        numberOfMemberAccountsOptedIn: 1,
        lastUpdatedTimestamp: new Date("2026-07-31T08:00:00.000Z"),
      };
    },
    async getEnrollmentStatusesForOrganization(input) {
      inputs.push(input);
      return {
        accountEnrollmentStatuses: [{
          accountId: "111122223333",
          status: "Active",
          lastUpdatedTimestamp: new Date("2026-07-31T08:30:00.000Z"),
        }],
      };
    },
    async describeRecommendationExportJobs(input) {
      inputs.push(input);
      return {
        recommendationExportJobs: [{
          jobId: "export-one",
          resourceType: "Ec2Instance",
          status: "Complete",
          creationTimestamp: new Date("2026-07-31T09:00:00.000Z"),
          lastUpdatedTimestamp: new Date("2026-07-31T10:00:00.000Z"),
          destination: {
            s3: {
              bucket: "private-compute-optimizer-bucket",
              key: "private-prefix/export.csv",
              metadataKey: "private-prefix/export-metadata.json",
            },
          },
        }],
      };
    },
  };
  const dispatched = await executeFinopsSourceDispatch({
    ...request("compute-optimizer-export"),
    contractId: contract.contractId,
  }, {
    ...dependencies(new Registry(connection([contract]))),
    computeOptimizerExportReader,
  });

  assert.equal(dispatched.sourceId, "compute_optimizer_organization_export");
  assert.equal(dispatched.collectionStatus, "PARTIAL");
  assert.equal(dispatched.errorCode, "EXPORT_OBJECT_BINDING_REQUIRED");
  assert.equal(dispatched.region, "us-west-2");
  assert.equal(dispatched.dataThroughAt, "2026-07-31T10:00:00.000Z");
  assert.deepEqual(inputs, [{}, { maxResults: 100 }, { maxResults: 1_000 }]);
  assert.deepEqual(
    FINOPS_SOURCE_DEFINITIONS.compute_optimizer_organization_export.actions,
    COMPUTE_OPTIMIZER_EXPORT_SOURCE_ACTIONS,
  );
  const serialized = JSON.stringify(dispatched);
  assert.equal(serialized.includes("private-compute-optimizer-bucket"), false);
  assert.equal(serialized.includes("private-prefix"), false);
  assert.equal(serialized.includes("ASIASOURCE"), false);
  assert.equal(serialized.includes("secret"), false);
});

test("Compute Optimizer dispatch sanitizes provider failures and rejects broader persisted policy bindings", async () => {
  const contract = sourceContract({
    contractId: "contract-compute-optimizer-unavailable-v1",
    sourceId: "compute_optimizer_organization_export",
    region: "us-west-2",
    permissionContractId: COMPUTE_OPTIMIZER_EXPORT_SOURCE_PERMISSION_CONTRACT_ID,
    policyName: COMPUTE_OPTIMIZER_EXPORT_SOURCE_POLICY_NAME,
  });
  assert.throws(() => parseFinopsSourceContracts([{
    ...contract,
    permissionContractId: "broader-compute-optimizer-policy",
  }], {
    tenantId: TENANT_ID,
    connectionId: CONNECTION_ID,
    expectedAccountId: ACCOUNT_ID,
    partition: "aws",
  }));
  const dispatched = await executeFinopsSourceDispatch({
    ...request("compute-optimizer-unavailable"),
    contractId: contract.contractId,
  }, {
    ...dependencies(new Registry(connection([contract]))),
    computeOptimizerExportReader: {
      async getEnrollmentStatus() {
        throw Object.assign(new Error("private AWS provider body"), {
          name: "AccessDeniedException",
        });
      },
      async getEnrollmentStatusesForOrganization() {
        throw new Error("must not be called");
      },
      async describeRecommendationExportJobs() {
        throw new Error("must not be called");
      },
    },
  });
  assert.equal(dispatched.collectionStatus, "UNAVAILABLE");
  assert.equal(dispatched.errorCode, "ACCESS_DENIED");
  assert.equal(dispatched.evidence, null);
  assert.equal(JSON.stringify(dispatched).includes("private AWS provider body"), false);
});

test("returns honest not-configured and not-implemented envelopes without assuming a role", async () => {
  const missingDeps = dependencies(new Registry(connection(null)));
  const missing = await executeFinopsSourceDispatch(request("missing"), missingDeps);
  assert.equal(missing.configured, false);
  assert.equal(missing.implementationState, "NOT_CONFIGURED");
  assert.equal(missing.evidence, null);
  assert.equal(missingDeps.broker.calls.length, 0);

  const unsupported = sourceContract({
    contractId: "contract-budgets-v1",
    sourceId: "aws_budgets",
    permissionContractId: null,
    policyName: null,
  });
  const unsupportedDeps = dependencies(new Registry(connection([unsupported])));
  const result = await executeFinopsSourceDispatch({
    ...request("unsupported"),
    contractId: unsupported.contractId,
  }, unsupportedDeps);
  assert.equal(result.configured, true);
  assert.equal(result.implementationState, "NOT_IMPLEMENTED");
  assert.equal(result.errorCode, "SOURCE_ADAPTER_NOT_IMPLEMENTED");
  assert.equal(result.evidence, null);
  assert.equal(unsupportedDeps.broker.calls.length, 0);
});

test("the signed collector discovery gate accepts an active .8.4 connection and only an opaque contract identity", async (t) => {
  const unsupported = sourceContract({
    contractId: "contract-budgets-http-v1",
    sourceId: "aws_budgets",
    permissionContractId: null,
    policyName: null,
  });
  const server = createLocalCollectorServer({
    mode: "live",
    allowLiveAws: true,
    principalArn: PRINCIPAL_ARN,
    registry: new HttpRegistry({
      ...registeredConnection([unsupported]),
      permissionPackVersion: "standard-2026-08.4",
    }),
    authenticator: {
      verify: () => ({ nonce: "test-nonce", timestamp: NOW.getTime() }),
      responseSignature: () => "test-signature",
    },
    now: () => NOW,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  }));
  const address = server.address() as AddressInfo;
  const endpoint =
    `http://127.0.0.1:${address.port}/v1/connections/${CONNECTION_ID}/finops-source`;
  const valid = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...request("http"),
      contractId: unsupported.contractId,
    }),
  });
  assert.equal(valid.status, 200);
  const result = await valid.json() as { implementationState: string };
  assert.equal(result.implementationState, "NOT_IMPLEMENTED");

  const unsafe = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...request("http-unsafe"),
      contractId: unsupported.contractId,
      operation: "ce:GetCostAndUsage",
    }),
  });
  assert.equal(unsafe.status, 400);
});

test("the signed collector discovery gate accepts the exact .8.5 launch successor", async () => {
  const contract = sourceContract({
    contractId: "contract-compute-optimizer-85-v1",
    sourceId: "compute_optimizer_organization_export",
    region: "us-west-2",
    permissionContractId: COMPUTE_OPTIMIZER_EXPORT_SOURCE_PERMISSION_CONTRACT_ID,
    policyName: COMPUTE_OPTIMIZER_EXPORT_SOURCE_POLICY_NAME,
  });
  const deps = dependencies(new Registry({
    ...connection([contract]),
    permissionPackVersion: "standard-2026-08.5",
  }));
  const result = await executeFinopsSourceDispatch({
    ...request("compute-optimizer-85"),
    contractId: contract.contractId,
  }, {
    ...deps,
    computeOptimizerExportReader: {
      async getEnrollmentStatus() {
        return {
          status: "Active",
          memberAccountsEnrolled: true,
          numberOfMemberAccountsOptedIn: 1,
          lastUpdatedTimestamp: NOW,
        };
      },
      async getEnrollmentStatusesForOrganization() {
        return { accountEnrollmentStatuses: [], nextToken: undefined };
      },
      async describeRecommendationExportJobs() {
        return { recommendationExportJobs: [], nextToken: undefined };
      },
    },
  });
  assert.equal(result.sourceId, "compute_optimizer_organization_export");
  assert.equal(result.region, "us-west-2");
  assert.equal(result.collectionStatus, "PARTIAL");
  assert.equal(deps.broker.calls.length, 1);
});

test("rejects caller-supplied AWS controls and cross-boundary persisted contracts", async () => {
  assert.throws(() => parseFinopsSourceDispatchRequest({
    ...request(),
    operation: "ce:GetCostAndUsage",
  }));
  assert.throws(() => parseFinopsSourceDispatchRequest({
    ...request(),
    endpoint: "https://attacker.invalid",
  }));
  assert.throws(() => parseFinopsSourceDispatchRequest({
    ...request(),
    accountId: "999988887777",
  }));
  assert.throws(() => parseFinopsSourceDispatchRequest({
    ...request(),
    query: { arbitrary: true },
  }));
  assert.throws(() => parseFinopsSourceDispatchRequest({
    ...request(),
    accounts: ["999988887777"],
  }));
  assert.throws(() => parseFinopsSourceDispatchRequest({
    ...request(),
    filters: [{ name: "JobStatus", values: ["Complete"] }],
  }));
  assert.throws(() => parseFinopsSourceDispatchRequest({
    ...request(),
    bucket: "caller-controlled-export-bucket",
  }));
  assert.throws(() => parseFinopsSourceDispatchRequest({
    ...request(),
    regions: ["us-west-2"],
  }));
  assert.throws(() => parseFinopsSourceContracts([
    sourceContract({ accountId: "999988887777" }),
  ], {
    tenantId: TENANT_ID,
    connectionId: CONNECTION_ID,
    expectedAccountId: ACCOUNT_ID,
    partition: "aws",
  }));
  assert.throws(() => parseFinopsSourceContracts([
    sourceContract({ region: "us-west-2" }),
  ], {
    tenantId: TENANT_ID,
    connectionId: CONNECTION_ID,
    expectedAccountId: ACCOUNT_ID,
    partition: "aws",
  }));
});

test("local encrypted-registry parsing preserves only an exact source binding", () => {
  const persisted = parsePersistedConnection({
    ...connection(),
    partition: "aws",
    enabledRegions: ["us-east-1"],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
  assert.deepEqual(persisted.finopsSourceContracts, [sourceContract()]);

  assert.throws(() => parsePersistedConnection({
    ...connection([sourceContract({
      permissionContractId: "caller-selected-permission-contract",
    })]),
    partition: "aws",
    enabledRegions: ["us-east-1"],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  }));
});

test("the source catalog and exact action arrays are deeply immutable", () => {
  assert.equal(Object.isFrozen(FINOPS_SOURCE_DEFINITIONS), true);
  assert.equal(Object.isFrozen(FINOPS_SOURCE_DEFINITIONS.cost_anomaly_detection), true);
  assert.equal(Object.isFrozen(COST_ANOMALY_SOURCE_ACTIONS), true);
  assert.equal(Object.isFrozen(FINOPS_SOURCE_DISPATCH_LIMITS), true);
  assert.equal(Object.isFrozen(FINOPS_SOURCE_DISPATCH_LIMITS.cost_anomaly_detection), true);
  assert.equal(Object.isFrozen(FINOPS_SOURCE_DISPATCH_LIMITS.trusted_advisor_standard_checks), true);
  assert.equal(Object.isFrozen(FINOPS_SOURCE_DISPATCH_LIMITS.compute_optimizer_organization_export), true);
  assert.ok(
    FINOPS_SOURCE_DISPATCH_LIMITS.cost_anomaly_detection.maximumBytes
      < FINOPS_SOURCE_DISPATCH_LIMITS.trusted_advisor_standard_checks.maximumBytes,
  );
  assert.ok(
    FINOPS_SOURCE_DISPATCH_LIMITS.cost_anomaly_detection.deadlineMs
      < FINOPS_SOURCE_DISPATCH_LIMITS.trusted_advisor_standard_checks.deadlineMs,
  );
  assert.throws(() => {
    (FINOPS_SOURCE_DEFINITIONS.cost_anomaly_detection.actions as string[])
      .push("ce:DeleteAnomalyMonitor");
  }, TypeError);
});

test("mints an exact source session policy with no wildcard actions or caller endpoint", () => {
  assert.equal(
    COST_ANOMALY_OFFICIAL_ENDPOINT,
    "https://ce.us-east-1.amazonaws.com",
  );
  const policy = JSON.parse(
    finopsSourceSessionPolicy(ROLE_ARN, sourceContract()),
  ) as { Statement: Array<{ Action: string | string[]; Resource: string }> };
  const actions = policy.Statement.flatMap(({ Action }) =>
    typeof Action === "string" ? [Action] : Action
  );
  assert.deepEqual(
    actions.filter((action) => action.startsWith("ce:")),
    [...COST_ANOMALY_SOURCE_ACTIONS],
  );
  assert.equal(actions.some((action) => action.includes("*")), false);
  assert.equal(JSON.stringify(policy).includes("endpoint"), false);
});

test("mints a read-only Compute Optimizer discovery session with no export or S3 authority", () => {
  const contract = sourceContract({
    contractId: "contract-compute-optimizer-policy-v1",
    sourceId: "compute_optimizer_organization_export",
    region: "us-west-2",
    permissionContractId: COMPUTE_OPTIMIZER_EXPORT_SOURCE_PERMISSION_CONTRACT_ID,
    policyName: COMPUTE_OPTIMIZER_EXPORT_SOURCE_POLICY_NAME,
  });
  const policy = JSON.parse(finopsSourceSessionPolicy(ROLE_ARN, contract)) as {
    Statement: Array<{ Action: string | string[]; Resource: string }>;
  };
  const actions = policy.Statement.flatMap(({ Action }) =>
    typeof Action === "string" ? [Action] : Action
  );
  assert.deepEqual(
    actions.filter((action) => action.startsWith("compute-optimizer:")),
    [...COMPUTE_OPTIMIZER_EXPORT_SOURCE_ACTIONS],
  );
  assert.equal(actions.some((action) => /^compute-optimizer:Export/u.test(action)), false);
  assert.equal(actions.some((action) => action.startsWith("s3:")), false);
  assert.equal(actions.some((action) => action.includes("*")), false);
});

test("the broker re-resolves and attests the exact persisted source policy before collection", async () => {
  const assume = new Assume();
  const registry = new Registry(connection());
  const broker = new AwsRoleBroker({
    registry,
    assumeRoleClient: assume,
    callerIdentityClientFactory: () => new Identity(assume),
    roleContractClientFactory: () => attestedRoleClient(),
    expectedPrincipalArn: PRINCIPAL_ARN,
    now: () => NOW,
  });
  const session = await broker.assumeValidatedFinopsSourceSession(
    { tenantId: TENANT_ID },
    CONNECTION_ID,
    "job-attested-source",
    CONTRACT_ID,
  );
  assert.equal(session.accountId, ACCOUNT_ID);
  assert.equal(
    assume.calls[0]?.Policy,
    finopsSourceSessionPolicy(ROLE_ARN, sourceContract()),
  );

  const unsafe = new AwsRoleBroker({
    registry,
    assumeRoleClient: assume,
    callerIdentityClientFactory: () => new Identity(assume),
    roleContractClientFactory: () => attestedRoleClient(true),
    expectedPrincipalArn: PRINCIPAL_ARN,
    now: () => NOW,
  });
  await assert.rejects(
    () => unsafe.assumeValidatedFinopsSourceSession(
      { tenantId: TENANT_ID },
      CONNECTION_ID,
      "job-unsafe-source",
      CONTRACT_ID,
    ),
    UnsafeTrustPolicyError,
  );
});

test("propagates pagination-token cycles as partial bounded evidence", async () => {
  const deps = dependencies();
  deps.costAnomalyReader!.getAnomalies = async () => ({
    Anomalies: [],
    NextPageToken: "cycle",
  });
  const result = await executeFinopsSourceDispatch(request("cycle"), deps);
  assert.equal(result.collectionStatus, "PARTIAL");
  assert.equal(result.errorCode, "PAGINATION_TOKEN_REPEATED");
  assert.ok(result.coverage.pagesObserved <= 4);
});

test("enforces the process-wide source dispatch concurrency ceiling", async () => {
  let activeOperations = 0;
  let maximumOperations = 0;
  let reachedExpectedConcurrencyResolve!: () => void;
  const reachedExpectedConcurrency = new Promise<void>((resolve) => {
    reachedExpectedConcurrencyResolve = resolve;
  });
  let releaseResolve!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  const waitForRelease = async (): Promise<void> => {
    activeOperations += 1;
    maximumOperations = Math.max(maximumOperations, activeOperations);
    if (
      activeOperations ===
      FINOPS_SOURCE_MAX_CONCURRENT_DISPATCHES *
        FINOPS_SOURCE_MAX_OPERATION_CONCURRENCY
    ) reachedExpectedConcurrencyResolve();
    await release;
    activeOperations -= 1;
  };
  const deps = dependencies();
  deps.costAnomalyReader!.getAnomalies = async () => {
    await waitForRelease();
    return { Anomalies: [] };
  };
  deps.costAnomalyReader!.getAnomalyMonitors = async () => {
    await waitForRelease();
    return { AnomalyMonitors: [] };
  };
  deps.costAnomalyReader!.getAnomalySubscriptions = async () => {
    await waitForRelease();
    return { AnomalySubscriptions: [] };
  };

  const runs = Array.from({ length: 4 }, (_, index) =>
    executeFinopsSourceDispatch(request(`concurrency-${index}`), deps)
  );
  await reachedExpectedConcurrency;
  await waitImmediate();
  assert.equal(
    maximumOperations,
    FINOPS_SOURCE_MAX_CONCURRENT_DISPATCHES *
      FINOPS_SOURCE_MAX_OPERATION_CONCURRENCY,
  );
  releaseResolve();
  const results = await Promise.all(runs);
  assert.equal(results.length, 4);
  assert.ok(results.every(({ collectionStatus }) => collectionStatus === "COMPLETE"));
});
