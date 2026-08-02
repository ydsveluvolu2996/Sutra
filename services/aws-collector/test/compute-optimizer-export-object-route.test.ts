import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { GetObjectCommand, GetObjectCommandOutput } from "@aws-sdk/client-s3";

import { createLocalCollectorServer } from "../src/local-server.js";
import { ConnectionIntegrityError, type ConnectionScope,
  type OnboardingTrustVerification, type StoredAwsConnection,
  type ValidatedRoleSession } from "../src/types.js";
import type { RegisteredAwsConnection } from "../src/local-registry.js";
import type {
  ComputeOptimizerExportObjectSessionRequest,
} from "../src/role-broker.js";

const NOW = new Date("2026-08-02T00:00:00.000Z");
const TENANT = "tenant-object";
const CONNECTION = `conn_${"a".repeat(32)}`;
const PLANNED_JOB = "12345678-abcd-4321-aaaa-123456789012";
const KEY = "ec2-instance-recommendations/compute-optimizer/123456789012/" +
  `us-east-1-2026-08-02T000000Z-${PLANNED_JOB}.csv`;

function stored(
  overrides: Partial<RegisteredAwsConnection> = {},
): RegisteredAwsConnection {
  return {
    tenantId: TENANT,
    connectionId: CONNECTION,
    expectedAccountId: "123456789012",
    partition: "aws",
    roleArn: "arn:aws:iam::123456789012:role/sutra/SutraCollectorRole",
    externalId: "4a3e789b-5a2e-47db-9cab-226cbe52fc04",
    status: "ACTIVE",
    permissionPackVersion: "standard-2026-08.4",
    sessionNamePrefix: "sutra-",
    roleProvisioningMode: "sutra_template",
    expectedRolePath: "/sutra/",
    expectedRoleName: "SutraCollectorRole",
    enabledRegions: ["us-east-1"],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    computeOptimizerExportObjectContracts: [{
      tenantId: TENANT,
      connectionId: CONNECTION,
      accountId: "123456789012",
      partition: "aws",
      region: "us-east-1",
      contractId: "co-object-use1-ec2",
      permissionPackVersion: "standard-2026-08.4",
      permissionContractId: "compute-optimizer-export-read-v1",
      policyName:
        "SutraComputeOptimizerExportReadV1-us-east-1-customer-compute-optimizer-use1",
      bucket: "customer-compute-optimizer-use1",
      effectivePrefix:
        "ec2-instance-recommendations/compute-optimizer/123456789012/",
      encryptionMode: "SSE_S3",
      kmsKeyArn: null,
    }],
    ...overrides,
  };
}

function storedLaunch(): RegisteredAwsConnection {
  const bucket = "customer-compute-optimizer-use1";
  const basePrefix = "ec2-instance-recommendations/";
  const effectivePrefix = `${basePrefix}compute-optimizer/123456789012/`;
  const { computeOptimizerExportObjectContracts: _objectContracts, ...base } = stored({
    permissionPackVersion: "standard-2026-08.5",
  });
  void _objectContracts;
  return {
    ...base,
    computeOptimizerExportLaunchContracts: [{
      tenantId: TENANT,
      connectionId: CONNECTION,
      accountId: "123456789012",
      partition: "aws",
      region: "us-east-1",
      contractId: "co-launch-use1",
      permissionPackVersion: "standard-2026-08.5",
      permissionContractId: "compute-optimizer-export-launch-v1",
      policyName: "SutraComputeOptimizerExportLaunchV1-us-east-1",
      bucket,
      bucketArn: `arn:aws:s3:::${bucket}`,
      basePrefix,
      effectivePrefix,
      objectArnPrefix: `arn:aws:s3:::${bucket}/${effectivePrefix}*`,
      encryptionMode: "SSE_S3",
      bucketVersioningStatus: "Enabled",
      servicePrincipal: "compute-optimizer.amazonaws.com",
    }],
  };
}

class Registry {
  public constructor(public record: RegisteredAwsConnection) {}
  public async resolve(scope: ConnectionScope, connectionId: string):
  Promise<StoredAwsConnection | null> {
    return this.matches(scope, connectionId) ? this.record : null;
  }
  public async getRegistered(scope: ConnectionScope, connectionId: string):
  Promise<RegisteredAwsConnection | null> {
    return this.matches(scope, connectionId) ? this.record : null;
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
  private matches(scope: ConnectionScope, connectionId: string): boolean {
    return scope.tenantId === this.record.tenantId &&
      connectionId === this.record.connectionId;
  }
}

const SESSION: ValidatedRoleSession = {
  connectionId: CONNECTION,
  accountId: "123456789012",
  partition: "aws",
  roleArn: "arn:aws:iam::123456789012:role/sutra/SutraCollectorRole",
  roleSessionName: "sutra-object-session",
  callerIdentityArn:
    "arn:aws:sts::123456789012:assumed-role/SutraCollectorRole/sutra-object-session",
  expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  credentials: {
    accessKeyId: "ASIAOBJECT",
    secretAccessKey: "secret",
    sessionToken: "token",
    expiration: new Date("2099-01-01T00:00:00.000Z"),
  },
};

function body(): Record<string, unknown> {
  return {
    tenantId: TENANT,
    connectionId: CONNECTION,
    jobId: "materialize-job",
    contractId: "co-object-use1-ec2",
    plannedJobId: PLANNED_JOB,
    region: "us-east-1",
    bucket: "customer-compute-optimizer-use1",
    key: KEY,
    offset: 0,
    maximumBytes: 4,
    versionId: null,
    ifMatch: null,
  };
}

test("signed .8.4 exact-object action reaches its broker and returns only bounded bytes", async () => {
  const sharedSecret = randomBytes(32).toString("base64url");
  const registry = new Registry(stored());
  const brokerCalls: ComputeOptimizerExportObjectSessionRequest[] = [];
  const s3Inputs: GetObjectCommand["input"][] = [];
  const server = createLocalCollectorServer({
    sharedSecret,
    registry,
    mode: "live",
    allowLiveAws: true,
    principalArn: "arn:aws:iam::999988887777:role/SutraCollectorWorkload",
    now: () => NOW,
    computeOptimizerExportObjectRoleBrokerFactory: () => ({
      assumeValidatedComputeOptimizerExportObjectSession:
        async (_scope, _connectionId, _jobId, request) => {
          void _scope; void _connectionId; void _jobId;
          assertExactBrokerRequest(request);
          brokerCalls.push(request);
          return SESSION;
        },
    }),
    computeOptimizerExportObjectChunkClientFactory: () => ({
      send: async (command) => {
        s3Inputs.push(command.input);
        return {
          $metadata: {},
          ContentRange: "bytes 0-3/8",
          ContentLength: 4,
          ETag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
          VersionId: "version-1",
          Body: { async *[Symbol.asyncIterator]() { yield new Uint8Array([1, 2, 3, 4]); } },
        } as GetObjectCommandOutput;
      },
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const path = `/v1/connections/${CONNECTION}/compute-optimizer-export-object-chunk`;
  try {
    const unsigned = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body()),
    });
    assert.equal(unsigned.status, 401);

    const response = await signedRequest(baseUrl, sharedSecret, path, body());
    assert.equal(response.status, 200);
    const value = response.value as Record<string, unknown>;
    assert.equal(value.schema, "sutra.compute-optimizer-export-object-chunk.v1");
    assert.equal(value.bodyBase64, Buffer.from([1, 2, 3, 4]).toString("base64"));
    assert.deepEqual(value.identity, {
      kind: "VERSION", versionId: "version-1", eTag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    });
    assert.equal(brokerCalls.length, 1);
    assert.equal(s3Inputs.length, 1);
    assert.equal(JSON.stringify(value).includes("ASIAOBJECT"), false);
    assert.equal(JSON.stringify(value).includes("secret"), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("route denies .8.3 and rejects contract/job/address/version substitution", async () => {
  const sharedSecret = randomBytes(32).toString("base64url");
  const registry = new Registry(stored({
    permissionPackVersion: "standard-2026-08.3",
  }));
  let brokerCalls = 0;
  const server = createLocalCollectorServer({
    sharedSecret,
    registry,
    mode: "live",
    allowLiveAws: true,
    principalArn: "arn:aws:iam::999988887777:role/SutraCollectorWorkload",
    now: () => NOW,
    computeOptimizerExportObjectRoleBrokerFactory: () => ({
      assumeValidatedComputeOptimizerExportObjectSession:
        async (_scope, _connectionId, _jobId, request) => {
          void _scope; void _connectionId; void _jobId;
          brokerCalls += 1;
          assertExactBrokerRequest(request);
          return SESSION;
        },
    }),
    computeOptimizerExportObjectChunkClientFactory: () => ({
      send: async () => { throw new Error("must not reach S3"); },
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const path = `/v1/connections/${CONNECTION}/compute-optimizer-export-object-chunk`;
  try {
    assert.equal((await signedRequest(baseUrl, sharedSecret, path, body())).status, 409);
    assert.equal(brokerCalls, 0);

    registry.record = stored();
    for (const replacement of [
      { contractId: "other-contract" },
      { plannedJobId: "other-job" },
      { key: KEY.replace("ec2-instance", "ebs-volume") },
      { offset: 4, versionId: "other-version", ifMatch: null },
    ]) {
      const response = await signedRequest(baseUrl, sharedSecret, path, {
        ...body(), ...replacement,
      });
      assert.equal(response.status, 400);
    }
    assert.equal(brokerCalls, 4);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("signed .8.5 launch contract reaches the same one-object route and denies siblings", async () => {
  const sharedSecret = randomBytes(32).toString("base64url");
  const registry = new Registry(storedLaunch());
  const acceptedKey = KEY;
  let brokerCalls = 0;
  const server = createLocalCollectorServer({
    sharedSecret,
    registry,
    mode: "live",
    allowLiveAws: true,
    principalArn: "arn:aws:iam::999988887777:role/SutraCollectorWorkload",
    now: () => NOW,
    computeOptimizerExportObjectRoleBrokerFactory: () => ({
      assumeValidatedComputeOptimizerExportObjectSession:
        async (_scope, _connectionId, _jobId, request) => {
          void _scope; void _connectionId; void _jobId;
          brokerCalls += 1;
          if (
            request.contractId !== "co-launch-use1" ||
            request.region !== "us-east-1" ||
            request.bucket !== "customer-compute-optimizer-use1" ||
            request.objectKey !== acceptedKey ||
            request.plannedJobId !== PLANNED_JOB
          ) throw new ConnectionIntegrityError();
          return SESSION;
        },
    }),
    computeOptimizerExportObjectChunkClientFactory: () => ({
      send: async () => ({
        $metadata: {}, ContentRange: "bytes 0-3/8", ContentLength: 4,
        ETag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"', VersionId: "version-1",
        Body: { async *[Symbol.asyncIterator]() { yield new Uint8Array([1, 2, 3, 4]); } },
      } as GetObjectCommandOutput),
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const path = `/v1/connections/${CONNECTION}/compute-optimizer-export-object-chunk`;
  try {
    const accepted = await signedRequest(baseUrl, sharedSecret, path, {
      ...body(), contractId: "co-launch-use1",
    });
    assert.equal(accepted.status, 200);
    assert.doesNotMatch(JSON.stringify(accepted.value), /ASIAOBJECT|secret|token/u);
    for (const tamper of [
      { contractId: "neighbor-contract" },
      { bucket: "neighbor-safe-bucket" },
      { key: KEY.replace("ec2-instance-recommendations", "neighbor-prefix") },
    ]) {
      const rejected = await signedRequest(baseUrl, sharedSecret, path, {
        ...body(), contractId: "co-launch-use1", ...tamper,
      });
      assert.equal(rejected.status, 400);
    }
    assert.equal(brokerCalls, 4);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function assertExactBrokerRequest(request: ComputeOptimizerExportObjectSessionRequest): void {
  if (
    request.contractId !== "co-object-use1-ec2" ||
    request.plannedJobId !== PLANNED_JOB ||
    request.region !== "us-east-1" ||
    request.bucket !== "customer-compute-optimizer-use1" ||
    request.objectKey !== KEY ||
    (request.versionIdentity.kind === "VERSION" &&
      request.versionIdentity.versionId !== "version-1")
  ) throw new ConnectionIntegrityError();
}

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
