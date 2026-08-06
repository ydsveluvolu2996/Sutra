import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { DescribeRecommendationExportJobsRequest } from
  "@aws-sdk/client-compute-optimizer";

import { createLocalCollectorServer } from "../src/local-server.js";
import type { RegisteredAwsConnection } from "../src/local-registry.js";
import type { ComputeOptimizerExportDescribeSessionRequest } from
  "../src/role-broker.js";
import {
  COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_CONTRACT_ID,
  COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION,
  type ConnectionScope,
  type OnboardingTrustVerification,
  type StoredAwsConnection,
  type ValidatedRoleSession,
} from "../src/types.js";
import {
  COMPUTE_OPTIMIZER_EXPORT_SOURCE_PERMISSION_CONTRACT_ID,
  COMPUTE_OPTIMIZER_EXPORT_SOURCE_POLICY_NAME,
} from "../src/finops-source-contract.js";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const TENANT = "tenant-exact-route";
const CONNECTION = `conn_${"a".repeat(32)}`;
const ACCOUNT = "123456789012";
const SOURCE_CONTRACT = "compute-optimizer-source-use1";
const LAUNCH_CONTRACT = "compute-optimizer-launch-use1";
const PROVIDER_JOB = "provider-job-1";
const OBJECT_KEY =
  `compute-optimizer/${ACCOUNT}/us-east-1-2026-08-02T000000Z-${PROVIDER_JOB}.csv`;

function stored(
  overrides: Partial<RegisteredAwsConnection> = {},
): RegisteredAwsConnection {
  return {
    tenantId: TENANT,
    connectionId: CONNECTION,
    expectedAccountId: ACCOUNT,
    partition: "aws",
    roleArn: `arn:aws:iam::${ACCOUNT}:role/sutra/SutraCollectorRole`,
    externalId: "exact-describe-external-id-1234567890",
    status: "ACTIVE",
    permissionPackVersion: COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION,
    sessionNamePrefix: "sutra-",
    roleProvisioningMode: "sutra_template",
    expectedRolePath: "/sutra/",
    expectedRoleName: "SutraCollectorRole",
    enabledRegions: ["us-east-1"],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    finopsSourceContracts: [{
      tenantId: TENANT,
      connectionId: CONNECTION,
      contractId: SOURCE_CONTRACT,
      sourceId: "compute_optimizer_organization_export",
      accountId: ACCOUNT,
      partition: "aws",
      region: "us-east-1",
      permissionContractId:
        COMPUTE_OPTIMIZER_EXPORT_SOURCE_PERMISSION_CONTRACT_ID,
      policyName: COMPUTE_OPTIMIZER_EXPORT_SOURCE_POLICY_NAME,
    }],
    computeOptimizerExportLaunchContracts: [{
      tenantId: TENANT,
      connectionId: CONNECTION,
      accountId: ACCOUNT,
      partition: "aws",
      region: "us-east-1",
      contractId: LAUNCH_CONTRACT,
      permissionPackVersion:
        COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION,
      permissionContractId:
        COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_CONTRACT_ID,
      policyName: "SutraComputeOptimizerExportLaunchV1-us-east-1",
      bucket: "customer-compute-optimizer-use1",
      bucketArn: "arn:aws:s3:::customer-compute-optimizer-use1",
      basePrefix: "compute-optimizer",
      effectivePrefix: `compute-optimizer/${ACCOUNT}/`,
      objectArnPrefix:
        `arn:aws:s3:::customer-compute-optimizer-use1/compute-optimizer/${ACCOUNT}/`,
      encryptionMode: "SSE_KMS",
      kmsKeyArn:
        `arn:aws:kms:us-east-1:${ACCOUNT}:key/compute-optimizer-key`,
      bucketVersioningStatus: "Enabled",
      servicePrincipal: "compute-optimizer.amazonaws.com",
    }],
    ...overrides,
  };
}

class Registry {
  public constructor(public record: RegisteredAwsConnection) {}
  public async resolve(scope: ConnectionScope, connectionId: string):
  Promise<StoredAwsConnection | null> {
    return scope.tenantId === this.record.tenantId
      && connectionId === this.record.connectionId ? this.record : null;
  }
  public async getRegistered(scope: ConnectionScope, connectionId: string):
  Promise<RegisteredAwsConnection | null> {
    return this.resolve(scope, connectionId) as Promise<RegisteredAwsConnection | null>;
  }
  public async markStaticCredentialVerified(): Promise<void> {
    throw new Error("unexpected static-credential verification");
  }

  public async markOnboardingVerified(
    _scope: ConnectionScope, _connectionId: string,
    _verification: OnboardingTrustVerification,
  ): Promise<void> { void _scope; void _connectionId; void _verification; }
  public async upsert(): Promise<void> {}
  public async disable(): Promise<void> {}
  public async offboard(): Promise<void> {}
  public async activateOnboarding(): Promise<void> {}
  public async discardStagedOnboarding(): Promise<void> {}
}

const SESSION: ValidatedRoleSession = {
  connectionId: CONNECTION,
  accountId: ACCOUNT,
  partition: "aws",
  roleArn: `arn:aws:iam::${ACCOUNT}:role/sutra/SutraCollectorRole`,
  roleSessionName: "sutra-exact-describe",
  callerIdentityArn:
    `arn:aws:sts::${ACCOUNT}:assumed-role/SutraCollectorRole/sutra-exact-describe`,
  expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  credentials: {
    accessKeyId: "ASIAEXACTROUTE",
    secretAccessKey: "never-return-route-secret",
    sessionToken: "never-return-route-token",
    expiration: new Date("2099-01-01T00:00:00.000Z"),
  },
};

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "sutra.compute-optimizer-export-exact-describe-request.v1",
    tenantId: TENANT,
    connectionId: CONNECTION,
    collectionJobId: "fresh-materialize-route",
    contractId: SOURCE_CONTRACT,
    accountId: ACCOUNT,
    partition: "aws",
    region: "us-east-1",
    plannedJobs: [{
      targetId: `coelt_${"1".repeat(64)}`,
      plannedJobId: PROVIDER_JOB,
      exportFamily: "EC2_INSTANCE",
      providerResourceType: "Ec2Instance",
      requestSha256: "a".repeat(64),
      bucket: "customer-compute-optimizer-use1",
      objectKey: OBJECT_KEY,
      metadataKey: `${OBJECT_KEY.slice(0, -4)}-metadata.json`,
    }],
    ...overrides,
  };
}

test("signed .8.5 route issues a Describe-only exact session and returns no credentials", async () => {
  const sharedSecret = randomBytes(32).toString("base64url");
  const registry = new Registry(stored());
  const brokerRequests: ComputeOptimizerExportDescribeSessionRequest[] = [];
  const sdkInputs: DescribeRecommendationExportJobsRequest[] = [];
  const server = createLocalCollectorServer({
    sharedSecret,
    registry,
    mode: "live",
    allowLiveAws: true,
    principalArn: "arn:aws:iam::999988887777:role/SutraCollectorWorkload",
    now: () => NOW,
    computeOptimizerExactDescribeRoleBrokerFactory: () => ({
      assumeValidatedComputeOptimizerExportDescribeSession:
        async (_scope, connectionId, collectionJobId, request) => {
          assert.equal(connectionId, CONNECTION);
          assert.equal(collectionJobId, "fresh-materialize-route");
          brokerRequests.push(request);
          return SESSION;
        },
    }),
    computeOptimizerExactDescribeReaderFactory: (partition, region, credentials) => {
      assert.equal(partition, "aws");
      assert.equal(region, "us-east-1");
      assert.equal(credentials, SESSION.credentials);
      return {
        describeRecommendationExportJobs: async (input) => {
          sdkInputs.push(input);
          return { recommendationExportJobs: [{
            jobId: PROVIDER_JOB,
            resourceType: "Ec2Instance",
            status: "Complete",
            creationTimestamp: new Date("2026-08-01T12:00:00.000Z"),
            lastUpdatedTimestamp: new Date("2026-08-01T12:30:00.000Z"),
            destination: { s3: {
              bucket: "customer-compute-optimizer-use1",
              key: OBJECT_KEY,
              metadataKey: `${OBJECT_KEY.slice(0, -4)}-metadata.json`,
            } },
          }] };
        },
      };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const path =
    `/v1/connections/${CONNECTION}/compute-optimizer-export-exact-describe`;
  try {
    const unsigned = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body()),
    });
    assert.equal(unsigned.status, 401);
    const response = await signedRequest(baseUrl, sharedSecret, path, body());
    assert.equal(response.status, 200);
    assert.deepEqual(brokerRequests, [{
      contractId: SOURCE_CONTRACT,
      region: "us-east-1",
      plannedJobIds: [PROVIDER_JOB],
    }]);
    assert.deepEqual(sdkInputs, [{ jobIds: [PROVIDER_JOB], maxResults: 1_000 }]);
    const serialized = JSON.stringify(response.value);
    for (const secret of ["ASIAEXACTROUTE", "never-return-route-secret",
      "never-return-route-token"]) assert.equal(serialized.includes(secret), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("route denies .8.4 and account, partition, region, contract or body widening", async () => {
  const sharedSecret = randomBytes(32).toString("base64url");
  const registry = new Registry(stored({ permissionPackVersion: "standard-2026-08.4" }));
  let brokerCalls = 0;
  const server = createLocalCollectorServer({
    sharedSecret,
    registry,
    mode: "live",
    allowLiveAws: true,
    principalArn: "arn:aws:iam::999988887777:role/SutraCollectorWorkload",
    now: () => NOW,
    computeOptimizerExactDescribeRoleBrokerFactory: () => ({
      assumeValidatedComputeOptimizerExportDescribeSession: async () => {
        brokerCalls += 1;
        return SESSION;
      },
    }),
    computeOptimizerExactDescribeReaderFactory: () => ({
      describeRecommendationExportJobs: async () => {
        throw new Error("must not reach provider");
      },
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const path =
    `/v1/connections/${CONNECTION}/compute-optimizer-export-exact-describe`;
  try {
    assert.equal((await signedRequest(baseUrl, sharedSecret, path, body())).status, 409);
    registry.record = stored();
    for (const replacement of [
      { accountId: "999988887777" },
      { partition: "aws-cn" },
      { region: "us-west-2" },
      { contractId: "neighbor-contract" },
      { filters: [] },
      { jobIds: [PROVIDER_JOB] },
      { credentials: SESSION.credentials },
    ]) {
      const response = await signedRequest(baseUrl, sharedSecret, path, {
        ...body(), ...replacement,
      });
      assert.equal(new Set([400, 409]).has(response.status), true);
    }
    assert.equal(brokerCalls, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function signedRequest(
  baseUrl: string,
  secret: string,
  path: string,
  payload: unknown,
): Promise<{ readonly status: number; readonly value: unknown }> {
  const requestBody = JSON.stringify(payload);
  const timestamp = NOW.getTime().toString();
  const nonce = `nonce_${randomBytes(18).toString("base64url")}`;
  const signature = hmac(secret,
    `POST\n${path}\n${timestamp}\n${nonce}\n${sha256(requestBody)}`);
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sutra-timestamp": timestamp,
      "x-sutra-nonce": nonce,
      "x-sutra-signature": signature,
    },
    body: requestBody,
  });
  const responseBody = await response.text();
  assert.equal(
    response.headers.get("x-sutra-response-signature"),
    hmac(secret, `${response.status}\n${path}\n${nonce}\n${sha256(responseBody)}`),
  );
  return { status: response.status, value: JSON.parse(responseBody) as unknown };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(secret: string, value: string): string {
  return createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(value, "utf8").digest("hex");
}
