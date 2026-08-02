import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ComputeOptimizerExportObjectContractError,
  computeOptimizerExportObjectPrefixArn,
  computeOptimizerKmsViaService,
  parseComputeOptimizerExportObjectAddress,
  parseComputeOptimizerExportObjectContracts,
  parseComputeOptimizerExportObjectVersionIdentity,
} from "../src/compute-optimizer-export-object-contract.js";
import type {
  AwsPartition,
  ComputeOptimizerExportObjectContract,
} from "../src/types.js";
import {
  parsePersistedConnection,
  EncryptedFileConnectionRegistry,
  RegistryIntegrityError,
} from "../src/local-registry.js";
import { HostedPostgresState } from "../src/hosted-postgres-state.js";

const OWNER = {
  tenantId: "tenant-object",
  connectionId: `conn_${"a".repeat(32)}`,
  expectedAccountId: "123456789012",
  partition: "aws" as const,
};

function contract(
  overrides: Partial<ComputeOptimizerExportObjectContract> = {},
): ComputeOptimizerExportObjectContract {
  return {
    tenantId: OWNER.tenantId,
    connectionId: OWNER.connectionId,
    accountId: OWNER.expectedAccountId,
    partition: OWNER.partition,
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

test("parses, sorts and freezes exact regional object contracts", () => {
  const west = contract({
    region: "us-west-2",
    contractId: "co-object-usw2-ebs",
    policyName:
      "SutraComputeOptimizerExportReadV1-us-west-2-customer-compute-optimizer-usw2",
    bucket: "customer-compute-optimizer-usw2",
    effectivePrefix: "ebs-volume-recommendations/compute-optimizer/123456789012/",
    encryptionMode: "SSE_KMS",
    kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/12345678-abcd-4321-aaaa-123456789012",
  });
  const parsed = parseComputeOptimizerExportObjectContracts([west, contract()], OWNER);
  assert.deepEqual(parsed.map(({ contractId }) => contractId), [
    "co-object-use1-ec2",
    "co-object-usw2-ebs",
  ]);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed[0]));
  assert.equal(
    computeOptimizerExportObjectPrefixArn(parsed[0]!),
    "arn:aws:s3:::customer-compute-optimizer-use1/" +
      "ec2-instance-recommendations/compute-optimizer/123456789012/*",
  );
});

test("accepts only exact CSV and paired metadata provider filenames", () => {
  const item = contract();
  const jobId = "12345678-abcd-4321-aaaa-123456789012";
  const csv = parseComputeOptimizerExportObjectAddress(
    item,
    "aws",
    "us-east-1",
    item.bucket,
    `${item.effectivePrefix}us-east-1-2026-08-02T000000Z-${jobId}.csv`,
    jobId,
  );
  const metadata = parseComputeOptimizerExportObjectAddress(
    item,
    "aws",
    "us-east-1",
    item.bucket,
    `${item.effectivePrefix}us-east-1-2026-08-02T000000-${jobId}-metadata.json`,
    jobId,
  );
  assert.equal(csv.kind, "CSV");
  assert.equal(metadata.kind, "METADATA");
  assert.equal(metadata.providerTimestamp, "2026-08-02T000000");
  for (const key of [
    `${item.effectivePrefix}us-west-2-2026-08-02T000000Z-${jobId}.csv`,
    `${item.effectivePrefix}us-east-1-2026-08-02T000000Z-other.csv`,
    `${item.effectivePrefix}../us-east-1-2026-${jobId}.csv`,
    `${item.effectivePrefix}us-east-1-2026-${jobId}.json`,
    `neighbor/${item.effectivePrefix}us-east-1-2026-${jobId}.csv`,
  ]) {
    assert.throws(
      () => parseComputeOptimizerExportObjectAddress(
        item, "aws", "us-east-1", item.bucket, key, jobId,
      ),
      ComputeOptimizerExportObjectContractError,
    );
  }
});

test("validates current and version identities as an exact discriminated union", () => {
  assert.deepEqual(
    parseComputeOptimizerExportObjectVersionIdentity({ kind: "CURRENT", versionId: null }),
    { kind: "CURRENT", versionId: null },
  );
  assert.deepEqual(
    parseComputeOptimizerExportObjectVersionIdentity({ kind: "VERSION", versionId: "3Lg-x_9" }),
    { kind: "VERSION", versionId: "3Lg-x_9" },
  );
  for (const value of [
    { kind: "CURRENT", versionId: "v1" },
    { kind: "VERSION", versionId: null },
    { kind: "VERSION", versionId: "*" },
    { kind: "VERSION", versionId: "v1", action: "s3:*" },
  ]) assert.throws(
    () => parseComputeOptimizerExportObjectVersionIdentity(value),
    ComputeOptimizerExportObjectContractError,
  );
});

test("rejects cross-scope, widened, duplicate and out-of-bound contracts", () => {
  const invalid = [
    contract({ tenantId: "other" }),
    contract({ connectionId: "conn-object" }),
    contract({ accountId: "999999999999" }),
    contract({ partition: "aws-cn" }),
    contract({ region: "cn-north-1" }),
    contract({ effectivePrefix: "compute-optimizer/123456789012/../" }),
    contract({ effectivePrefix: "x%2f/compute-optimizer/123456789012/" }),
    contract({ effectivePrefix: "x*/compute-optimizer/123456789012/" }),
    contract({ kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/key" }),
    contract({
      encryptionMode: "SSE_KMS",
      kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/key",
    }),
  ];
  for (const value of invalid) assert.throws(
    () => parseComputeOptimizerExportObjectContracts([value], OWNER),
    ComputeOptimizerExportObjectContractError,
  );
  const extra = { ...contract(), wildcard: "*" };
  assert.throws(
    () => parseComputeOptimizerExportObjectContracts([extra], OWNER),
    ComputeOptimizerExportObjectContractError,
  );
  assert.throws(
    () => parseComputeOptimizerExportObjectContracts([contract(), contract()], OWNER),
    ComputeOptimizerExportObjectContractError,
  );
  assert.throws(
    () => parseComputeOptimizerExportObjectContracts(
      Array.from({ length: 51 }, (_, index) => contract({
        contractId: `contract-${index}`,
        bucket: `bucket-${String(index).padStart(3, "0")}`,
        policyName:
          `SutraComputeOptimizerExportReadV1-us-east-1-bucket-${String(index).padStart(3, "0")}`,
      })),
      OWNER,
    ),
    ComputeOptimizerExportObjectContractError,
  );
});

test("binds China and GovCloud contracts to partition-specific regions and KMS ViaService", () => {
  for (const fixture of [
    {
      partition: "aws-cn" as const,
      region: "cn-north-1",
      suffix: "amazonaws.com",
    },
    {
      partition: "aws-us-gov" as const,
      region: "us-gov-west-1",
      suffix: "amazonaws.com",
    },
  ]) {
    const owner = { ...OWNER, partition: fixture.partition as AwsPartition };
    const item = contract({
      partition: fixture.partition,
      region: fixture.region,
      contractId: `contract-${fixture.partition}`,
      bucket: `bucket-${fixture.partition}`,
      policyName:
        `SutraComputeOptimizerExportReadV1-${fixture.region}-bucket-${fixture.partition}`,
      encryptionMode: "SSE_KMS",
      kmsKeyArn:
        `arn:${fixture.partition}:kms:${fixture.region}:123456789012:key/key-123`,
    });
    const parsed = parseComputeOptimizerExportObjectContracts([item], owner)[0]!;
    assert.equal(
      computeOptimizerKmsViaService(parsed),
      `s3.${fixture.region}.${fixture.suffix}`,
    );
  }
});

test("registry serialization accepts .8.4 exactly and rejects old-pack or widened bindings", () => {
  const persisted = {
    tenantId: OWNER.tenantId,
    connectionId: OWNER.connectionId,
    expectedAccountId: OWNER.expectedAccountId,
    partition: OWNER.partition,
    roleArn: "arn:aws:iam::123456789012:role/sutra/SutraCollectorRole",
    externalId: "4a3e789b-5a2e-47db-9cab-226cbe52fc04",
    status: "ACTIVE",
    sessionNamePrefix: "sutra-",
    enabledRegions: ["us-east-1"],
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    permissionPackVersion: "standard-2026-08.4",
    roleProvisioningMode: "sutra_template",
    expectedRolePath: "/sutra/",
    expectedRoleName: "SutraCollectorRole",
    computeOptimizerExportObjectContracts: [contract()],
  };
  const parsed = parsePersistedConnection(persisted);
  assert.equal(parsed.computeOptimizerExportObjectContracts?.[0]?.contractId,
    "co-object-use1-ec2");
  assert.notEqual(parsed.computeOptimizerExportObjectContracts,
    persisted.computeOptimizerExportObjectContracts);
  assert.throws(
    () => parsePersistedConnection({
      ...persisted,
      permissionPackVersion: "standard-2026-08.3",
    }),
    RegistryIntegrityError,
  );
  assert.throws(
    () => parsePersistedConnection({
      ...persisted,
      computeOptimizerExportObjectContracts: [{ ...contract(), wildcard: "*" }],
    }),
    RegistryIntegrityError,
  );
});

test("encrypted registry preserves object contracts only for unchanged trust identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-co-object-registry-"));
  const path = join(directory, "connections.enc.json");
  const keyBytes = randomBytes(32);
  const persisted = {
    tenantId: OWNER.tenantId,
    connectionId: OWNER.connectionId,
    expectedAccountId: OWNER.expectedAccountId,
    partition: OWNER.partition,
    roleArn: "arn:aws:iam::123456789012:role/sutra/SutraCollectorRole",
    externalId: "4a3e789b-5a2e-47db-9cab-226cbe52fc04",
    status: "ACTIVE",
    sessionNamePrefix: "sutra-",
    enabledRegions: ["us-east-1"],
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    permissionPackVersion: "standard-2026-08.4",
    roleProvisioningMode: "sutra_template" as const,
    expectedRolePath: "/sutra/",
    expectedRoleName: "SutraCollectorRole",
    computeOptimizerExportObjectContracts: [contract()],
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes, iv);
  cipher.setAAD(Buffer.from("sutra-local-registry:v1", "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({
      version: 3,
      connections: { [`${OWNER.tenantId}\u001f${OWNER.connectionId}`]: persisted },
      tombstones: {},
    }), "utf8"),
    cipher.final(),
  ]);
  await writeFile(path, JSON.stringify({
    version: 1,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  }), { mode: 0o600 });
  try {
    const registry = new EncryptedFileConnectionRegistry({
      filePath: path,
      encryptionKey: keyBytes.toString("base64"),
      now: () => new Date("2026-08-02T01:00:00.000Z"),
    });
    await registry.upsert(persisted);
    const unchanged = await registry.resolve(SCOPE_FOR_REGISTRY, OWNER.connectionId);
    assert.equal(unchanged?.permissionPackVersion, "standard-2026-08.4");
    assert.equal(unchanged?.computeOptimizerExportObjectContracts?.length, 1);

    await registry.upsert({ ...persisted, externalId: `${persisted.externalId}A` });
    const changed = await registry.resolve(SCOPE_FOR_REGISTRY, OWNER.connectionId);
    assert.equal(changed?.status, "PENDING");
    assert.equal(changed?.permissionPackVersion, "live-demo-2026-07.1");
    assert.equal(changed?.computeOptimizerExportObjectContracts, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const SCOPE_FOR_REGISTRY = { tenantId: OWNER.tenantId } as const;

test("hosted registry applies the same unchanged-trust preservation rule", async () => {
  const key = randomBytes(32);
  const persisted = {
    tenantId: OWNER.tenantId,
    connectionId: OWNER.connectionId,
    expectedAccountId: OWNER.expectedAccountId,
    partition: OWNER.partition,
    roleArn: "arn:aws:iam::123456789012:role/sutra/SutraCollectorRole",
    externalId: "4a3e789b-5a2e-47db-9cab-226cbe52fc04",
    status: "ACTIVE",
    sessionNamePrefix: "sutra-",
    enabledRegions: ["us-east-1"],
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    permissionPackVersion: "standard-2026-08.4",
    roleProvisioningMode: "sutra_template" as const,
    expectedRolePath: "/sutra/",
    expectedRoleName: "SutraCollectorRole",
    computeOptimizerExportObjectContracts: [contract()],
  };
  const fake = new HostedConnectionPool(key, persisted);
  const hosted = new HostedPostgresState({
    connectionString: "postgresql://unit.invalid/sutra",
    encryptionKey: key.toString("base64url"),
    pool: fake as never,
    now: () => Date.parse("2026-08-02T01:00:00.000Z"),
  });
  await hosted.upsert(persisted);
  const unchanged = await hosted.resolve(SCOPE_FOR_REGISTRY, OWNER.connectionId);
  assert.equal(unchanged?.permissionPackVersion, "standard-2026-08.4");
  assert.equal(unchanged?.computeOptimizerExportObjectContracts?.length, 1);

  await hosted.upsert({ ...persisted, expectedAccountId: "999999999999",
    roleArn: "arn:aws:iam::999999999999:role/sutra/SutraCollectorRole" });
  const changed = await hosted.resolve(SCOPE_FOR_REGISTRY, OWNER.connectionId);
  assert.equal(changed?.permissionPackVersion, "live-demo-2026-07.1");
  assert.equal(changed?.computeOptimizerExportObjectContracts, undefined);
});

interface HostedRow {
  tenant_id: string;
  connection_id: string;
  encrypted_state: string | null;
  state_sha256: string | null;
  tombstoned_at: null;
}

class HostedConnectionPool {
  private row: HostedRow;

  public constructor(key: Buffer, persisted: unknown) {
    this.row = hostedRow(key, OWNER.tenantId, OWNER.connectionId, persisted);
  }

  public async query(source: string): Promise<{ rows: HostedRow[]; rowCount: number }> {
    if (!source.includes("FROM hosted_broker_connections")) {
      throw new Error("unexpected hosted pool query");
    }
    return { rows: [this.row], rowCount: 1 };
  }

  public async connect(): Promise<{
    query: (source: string, values?: readonly unknown[]) => Promise<{
      rows: HostedRow[]; rowCount: number;
    }>;
    release: () => void;
  }> {
    return {
      query: async (source, values = []) => {
        if (source === "BEGIN" || source === "COMMIT" || source === "ROLLBACK") {
          return { rows: [], rowCount: 0 };
        }
        if (source.includes("FOR UPDATE")) return { rows: [this.row], rowCount: 1 };
        if (source.includes("INSERT INTO hosted_broker_connections")) {
          assert.equal(typeof values[2], "string");
          assert.equal(typeof values[3], "string");
          this.row = {
            tenant_id: String(values[0]),
            connection_id: String(values[1]),
            encrypted_state: values[2] as string,
            state_sha256: values[3] as string,
            tombstoned_at: null,
          };
          return { rows: [], rowCount: 1 };
        }
        throw new Error("unexpected hosted client query");
      },
      release: () => undefined,
    };
  }

  public async end(): Promise<void> {}
}

function hostedRow(
  key: Buffer,
  tenantId: string,
  connectionId: string,
  value: unknown,
): HostedRow {
  const cleartext = JSON.stringify(value);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${tenantId}\0${connectionId}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(cleartext, "utf8"), cipher.final()]);
  return {
    tenant_id: tenantId,
    connection_id: connectionId,
    encrypted_state: JSON.stringify({
      version: 1,
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    }),
    state_sha256: createHash("sha256").update(cleartext, "utf8").digest("hex"),
    tombstoned_at: null,
  };
}
