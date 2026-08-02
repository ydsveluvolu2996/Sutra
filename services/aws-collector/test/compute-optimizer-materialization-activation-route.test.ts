import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  createLocalCollectorServer,
  type ComputeOptimizerActivationManifestIdentityAttestor,
  type LocalCollectorServerOptions,
} from "../src/local-server.js";
import type { RegisteredAwsConnection } from "../src/local-registry.js";
import type {
  ConnectionScope,
  OnboardingTrustVerification,
  StoredAwsConnection,
} from "../src/types.js";

const TENANT = "tenant-activation-route";
const CONNECTION = `conn_${"a".repeat(32)}`;
const ACCOUNT = "123456789012";
const REGIONS = ["us-east-1", "us-west-2"] as const;
const PATH =
  `/v1/connections/${CONNECTION}/compute-optimizer-materialization-activation-manifest`;
const NOW = Date.parse("2026-08-02T12:00:00.000Z");

function request(tenantId = TENANT) {
  return {
    schema: "sutra.compute-optimizer-materialization-activation-manifest-request.v1",
    requestId: "activation-request-route-1",
    tenantId,
    connectionId: CONNECTION,
    accountId: ACCOUNT,
    partition: "aws",
    requiredPermissionPackVersion: "standard-2026-08.5",
  } as const;
}

function source(region: string) {
  return {
    tenantId: TENANT, connectionId: CONNECTION, contractId: `co-source-${region}`,
    sourceId: "compute_optimizer_organization_export" as const,
    accountId: ACCOUNT, partition: "aws" as const, region,
    permissionContractId: "aws-compute-optimizer-organization-export-read-v1",
    policyName: "SutraFinopsComputeOptimizerExportReadV1",
  };
}

function launch(region: string) {
  const bucket = `sutra-compute-optimizer-${region}`;
  const basePrefix = `exports/${region}/`;
  const effectivePrefix = `${basePrefix}compute-optimizer/${ACCOUNT}/`;
  return {
    tenantId: TENANT, connectionId: CONNECTION, accountId: ACCOUNT,
    partition: "aws" as const, region, contractId: `co-launch-${region}`,
    permissionPackVersion: "standard-2026-08.5" as const,
    permissionContractId: "compute-optimizer-export-launch-v1" as const,
    policyName: `SutraComputeOptimizerExportLaunchV1-${region}`,
    bucket, bucketArn: `arn:aws:s3:::${bucket}`, basePrefix, effectivePrefix,
    objectArnPrefix: `arn:aws:s3:::${bucket}/${effectivePrefix}*`,
    encryptionMode: "SSE_S3" as const, bucketVersioningStatus: "Enabled" as const,
    servicePrincipal: "compute-optimizer.amazonaws.com" as const,
  };
}

function objectRead(region: string) {
  const destination = launch(region);
  return {
    tenantId: TENANT, connectionId: CONNECTION, accountId: ACCOUNT,
    partition: "aws" as const, region, contractId: `co-object-${region}`,
    permissionPackVersion: "standard-2026-08.4" as const,
    permissionContractId: "compute-optimizer-export-read-v1" as const,
    policyName: `SutraComputeOptimizerExportReadV1-${region}-${destination.bucket}`,
    bucket: destination.bucket, effectivePrefix: destination.effectivePrefix,
    encryptionMode: "SSE_S3" as const, kmsKeyArn: null,
  };
}

function stored(
  overrides: Partial<RegisteredAwsConnection> = {},
): RegisteredAwsConnection {
  return {
    tenantId: TENANT, connectionId: CONNECTION, expectedAccountId: ACCOUNT,
    partition: "aws", roleArn: `arn:aws:iam::${ACCOUNT}:role/sutra/SutraCollectorRole`,
    externalId: "4a3e789b-5a2e-47db-9cab-226cbe52fc04", status: "ACTIVE",
    permissionPackVersion: "standard-2026-08.5", enabledRegions: [...REGIONS].reverse(),
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    finopsSourceContracts: REGIONS.map(source).reverse(),
    computeOptimizerExportLaunchContracts: REGIONS.map(launch).reverse(),
    computeOptimizerExportObjectContracts: REGIONS.map(objectRead).reverse(),
    ...overrides,
  };
}

function storedWithoutLaunchContracts(): RegisteredAwsConnection {
  const { computeOptimizerExportLaunchContracts: _omitted, ...connection } = stored();
  void _omitted;
  return connection as RegisteredAwsConnection;
}

class Registry {
  public constructor(public readonly record: RegisteredAwsConnection) {}
  public async resolve(scope: ConnectionScope, id: string): Promise<StoredAwsConnection | null> {
    return scope.tenantId === this.record.tenantId && id === CONNECTION
      ? this.record : null;
  }
  public async getRegistered(
    scope: ConnectionScope,
    id: string,
  ): Promise<RegisteredAwsConnection | null> {
    return this.resolve(scope, id) as Promise<RegisteredAwsConnection | null>;
  }
  public async markOnboardingVerified(
    _scope: ConnectionScope,
    _id: string,
    _verification: OnboardingTrustVerification,
  ): Promise<void> { void _scope; void _id; void _verification; }
  public async upsert(): Promise<void> {}
  public async disable(): Promise<void> {}
  public async offboard(): Promise<void> {}
  public async activateOnboarding(): Promise<void> {}
  public async discardStagedOnboarding(): Promise<void> {}
}

test("signed route returns only a sorted exact matrix after identity-only attestation", async () => {
  let attestationInput: Parameters<ComputeOptimizerActivationManifestIdentityAttestor["attest"]>[0]
    | undefined;
  const runtime = await start(stored(), {
    attest: async (input) => {
      attestationInput = input;
      return { verified: true, connectionId: CONNECTION, accountId: ACCOUNT, partition: "aws" };
    },
  });
  try {
    const response = await signed(runtime.url, runtime.secret, request());
    assert.equal(response.status, 200);
    const manifest = JSON.parse(response.body) as Record<string, unknown>;
    assert.deepEqual((manifest.regions as Array<{ region: string }>).map(({ region }) => region),
      REGIONS);
    assert.deepEqual(attestationInput?.sessionActions, ["sts:GetCallerIdentity"]);
    assert.equal(attestationInput?.expectedAccountId, ACCOUNT);
    assert.doesNotMatch(response.body,
      /credential|externalId|roleArn|policyName|policyDocument|secret|sessionToken/u);
  } finally { await runtime.close(); }
});

test("cross-tenant request is indistinguishable from an absent connection and starts no STS", async () => {
  let attestations = 0;
  const runtime = await start(stored(), { attest: async () => {
    attestations += 1;
    throw new Error("must not run");
  } });
  try {
    const response = await signed(runtime.url, runtime.secret, request("neighbor-tenant"));
    assert.equal(response.status, 404);
    assert.match(response.body, /CONNECTION_NOT_FOUND/u);
    assert.equal(attestations, 0);
  } finally { await runtime.close(); }
});

test("route fails closed on inactive capability, implicit regions, partial matrices and identity drift", async () => {
  const fixtures: Array<{
    connection: RegisteredAwsConnection;
    identityAccount?: string;
    expectedStatus: number;
  }> = [
    { connection: stored({ status: "VERIFIED" }), expectedStatus: 409 },
    { connection: stored({ permissionPackVersion: "standard-2026-08.4" }), expectedStatus: 409 },
    { connection: stored({ enabledRegions: ["all-enabled"] }), expectedStatus: 409 },
    { connection: storedWithoutLaunchContracts(), expectedStatus: 409 },
    { connection: stored({ computeOptimizerExportObjectContracts: [objectRead(REGIONS[0])] }), expectedStatus: 409 },
    { connection: stored(), identityAccount: "999988887777", expectedStatus: 409 },
  ];
  for (const fixture of fixtures) {
    let attestations = 0;
    const runtime = await start(fixture.connection, { attest: async () => {
      attestations += 1;
      return { verified: true, connectionId: CONNECTION,
        accountId: fixture.identityAccount ?? ACCOUNT, partition: "aws" };
    } });
    try {
      assert.equal((await signed(runtime.url, runtime.secret, request())).status,
        fixture.expectedStatus);
      assert.equal(attestations, fixture.identityAccount === undefined ? 0 : 1);
    } finally { await runtime.close(); }
  }
});

test("default production adapter registers the identity-only role broker", async () => {
  let brokerInput: unknown;
  let factoryRegion: string | undefined;
  const factory: NonNullable<
    LocalCollectorServerOptions["computeOptimizerActivationManifestRoleBrokerFactory"]
  > = (input) => {
    factoryRegion = input.region;
    return {
      attestComputeOptimizerActivationManifestIdentity: async (
        scope, connectionId, jobId, identityInput,
      ) => {
        brokerInput = { scope, connectionId, jobId, ...identityInput, signal: "redacted" };
        return { verified: true, connectionId: CONNECTION, accountId: ACCOUNT,
          partition: "aws" };
      },
    };
  };
  const runtime = await start(stored(), undefined, factory);
  try {
    const response = await signed(runtime.url, runtime.secret, request());
    assert.equal(response.status, 200);
    assert.equal(factoryRegion, "us-east-1");
    assert.deepEqual(brokerInput, {
      scope: { tenantId: TENANT },
      connectionId: CONNECTION,
      jobId: "activation-request-route-1",
      expectedAccountId: ACCOUNT,
      partition: "aws",
      sessionActions: ["sts:GetCallerIdentity"],
      signal: "redacted",
    });
    assert.doesNotMatch(response.body, /role|credential|sessionToken|secret/u);
  } finally { await runtime.close(); }
});

async function start(
  connection: RegisteredAwsConnection,
  attestor?: ComputeOptimizerActivationManifestIdentityAttestor,
  roleBrokerFactory?: NonNullable<
    LocalCollectorServerOptions["computeOptimizerActivationManifestRoleBrokerFactory"]
  >,
) {
  const secret = randomBytes(32).toString("base64url");
  const server = createLocalCollectorServer({
    sharedSecret: secret,
    registry: new Registry(connection),
    mode: "live",
    allowLiveAws: true,
    principalArn: "arn:aws:iam::999988887777:role/SutraCollectorWorkload",
    now: () => new Date(NOW),
    ...(attestor === undefined
      ? {}
      : { computeOptimizerActivationManifestIdentityAttestor: attestor }),
    ...(roleBrokerFactory === undefined
      ? {}
      : { computeOptimizerActivationManifestRoleBrokerFactory: roleBrokerFactory }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    secret,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function signed(base: string, secret: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const timestamp = NOW.toString();
  const nonce = `nonce_${randomBytes(18).toString("base64url")}`;
  const signature = hmac(secret,
    `POST\n${PATH}\n${timestamp}\n${nonce}\n${hash(body)}`);
  const response = await fetch(`${base}${PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sutra-timestamp": timestamp,
      "x-sutra-nonce": nonce, "x-sutra-signature": signature },
    body,
  });
  const responseBody = await response.text();
  assert.equal(response.headers.get("x-sutra-response-signature"),
    hmac(secret, `${response.status}\n${PATH}\n${nonce}\n${hash(responseBody)}`));
  return { status: response.status, body: responseBody };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(secret: string, value: string): string {
  return createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(value).digest("hex");
}
