import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ComputeOptimizerMaterializationActivationManifestError,
  parseComputeOptimizerMaterializationActivationManifest,
  projectComputeOptimizerMaterializationActivationManifest,
  type ComputeOptimizerMaterializationActivationManifestOwner,
  type ComputeOptimizerMaterializationActivationManifestRequest,
} from "../src/compute-optimizer-materialization-activation-manifest.js";
import type {
  ComputeOptimizerExportLaunchContract,
  ComputeOptimizerExportObjectContract,
  FinopsSourceContract,
} from "../src/types.js";

const CONNECTION = `conn_${"a".repeat(32)}`;
const ACCOUNT = "123456789012";
const REGIONS = ["us-east-1", "us-west-2"] as const;

const owner: ComputeOptimizerMaterializationActivationManifestOwner = {
  tenantId: "tenant-activation",
  connectionId: CONNECTION,
  expectedAccountId: ACCOUNT,
  partition: "aws",
  permissionPackVersion: "standard-2026-08.5",
  enabledRegions: [...REGIONS].reverse(),
};

const request: ComputeOptimizerMaterializationActivationManifestRequest = {
  schema: "sutra.compute-optimizer-materialization-activation-manifest-request.v1",
  requestId: "activation-request-1",
  tenantId: owner.tenantId,
  connectionId: CONNECTION,
  accountId: ACCOUNT,
  partition: "aws",
  requiredPermissionPackVersion: "standard-2026-08.5",
};

function source(region: string): FinopsSourceContract {
  return {
    tenantId: owner.tenantId, connectionId: CONNECTION,
    contractId: `co-source-${region}`, sourceId: "compute_optimizer_organization_export",
    accountId: ACCOUNT, partition: "aws", region,
    permissionContractId: "aws-compute-optimizer-organization-export-read-v1",
    policyName: "SutraFinopsComputeOptimizerExportReadV1",
  };
}

function launch(region: string): ComputeOptimizerExportLaunchContract {
  const bucket = `sutra-compute-optimizer-${region}`;
  const basePrefix = `exports/${region}/`;
  const effectivePrefix = `${basePrefix}compute-optimizer/${ACCOUNT}/`;
  return {
    tenantId: owner.tenantId, connectionId: CONNECTION, accountId: ACCOUNT,
    partition: "aws", region, contractId: `co-launch-${region}`,
    permissionPackVersion: "standard-2026-08.5",
    permissionContractId: "compute-optimizer-export-launch-v1",
    policyName: `SutraComputeOptimizerExportLaunchV1-${region}`,
    bucket, bucketArn: `arn:aws:s3:::${bucket}`, basePrefix, effectivePrefix,
    objectArnPrefix: `arn:aws:s3:::${bucket}/${effectivePrefix}*`,
    encryptionMode: "SSE_KMS", bucketVersioningStatus: "Enabled",
    kmsKeyArn: `arn:aws:kms:${region}:${ACCOUNT}:key/compute-optimizer-key`,
    servicePrincipal: "compute-optimizer.amazonaws.com",
  };
}

function objectRead(region: string): ComputeOptimizerExportObjectContract {
  const exactLaunch = launch(region);
  return {
    tenantId: owner.tenantId, connectionId: CONNECTION, accountId: ACCOUNT,
    partition: "aws", region, contractId: `co-object-${region}`,
    permissionPackVersion: "standard-2026-08.4",
    permissionContractId: "compute-optimizer-export-read-v1",
    policyName: `SutraComputeOptimizerExportReadV1-${region}-${exactLaunch.bucket}`,
    bucket: exactLaunch.bucket, effectivePrefix: exactLaunch.effectivePrefix,
    encryptionMode: "SSE_KMS",
    kmsKeyArn: `arn:aws:kms:${region}:${ACCOUNT}:key/compute-optimizer-key`,
  };
}

function project(overrides: Partial<Parameters<
  typeof projectComputeOptimizerMaterializationActivationManifest
>[0]> = {}) {
  return projectComputeOptimizerMaterializationActivationManifest({
    owner,
    request,
    sourceContracts: REGIONS.map(source).reverse(),
    launchContracts: REGIONS.map(launch).reverse(),
    objectReadContracts: REGIONS.map(objectRead).reverse(),
    ...overrides,
  });
}

test("projects one sorted, complete and secret-free collector-owned regional matrix", () => {
  const manifest = project();
  assert.deepEqual(manifest.regions.map(({ region }) => region), REGIONS);
  assert.ok(Object.isFrozen(manifest));
  assert.ok(Object.isFrozen(manifest.regions));
  assert.deepEqual(manifest.regions[0], {
    region: "us-east-1",
    describeContractId: "co-source-us-east-1",
    launchContractId: "co-launch-us-east-1",
    objectReadContractId: "co-object-us-east-1",
    bucket: "sutra-compute-optimizer-us-east-1",
    basePrefix: "exports/us-east-1/",
    effectivePrefix: `exports/us-east-1/compute-optimizer/${ACCOUNT}/`,
  });
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /credential|secret|externalId|roleArn|policyName|policyDocument/u);
});

test("fails closed on scope, pack, substitution, duplicate and partial contract matrices", () => {
  const tooManyRegions = Array.from({ length: 51 }, (_, index) =>
    `aa-${String.fromCharCode(97 + (index % 26))}${index < 26 ? "b" : "a"}-1`);
  const invalid: Parameters<typeof project>[0][] = [
    { owner: { ...owner, tenantId: "neighbor" } },
    { owner: { ...owner, permissionPackVersion: "standard-2026-08.4" } },
    { owner: { ...owner, enabledRegions: [] } },
    { owner: { ...owner, enabledRegions: tooManyRegions } },
    { sourceContracts: [source(REGIONS[0])] },
    { sourceContracts: [source(REGIONS[0]), source(REGIONS[0])] },
    { launchContracts: [launch(REGIONS[0])] },
    { objectReadContracts: [objectRead(REGIONS[0])] },
    { objectReadContracts: REGIONS.map((region) => region === REGIONS[0]
      ? { ...objectRead(region), bucket: "neighbor-bucket",
        policyName: `SutraComputeOptimizerExportReadV1-${region}-neighbor-bucket` }
      : objectRead(region)) },
  ];
  for (const overrides of invalid) assert.throws(
    () => project(overrides),
    ComputeOptimizerMaterializationActivationManifestError,
  );
});

test("manifest parser rejects extra fields, identity substitution and any partial region response", () => {
  const manifest = project();
  for (const candidate of [
    { ...manifest, tenantId: "neighbor" },
    { ...manifest, accountId: "999988887777" },
    { ...manifest, permissionPackVersion: "standard-2026-08.4" },
    { ...manifest, regions: manifest.regions.slice(0, 1) },
    { ...manifest, regions: [...manifest.regions].reverse() },
    { ...manifest, credentials: { accessKeyId: "forbidden" } },
    { ...manifest, regions: manifest.regions.map((row, index) => index === 0
      ? { ...row, policyArn: "arn:aws:iam::123456789012:policy/forbidden" }
      : row) },
    { ...manifest, regions: manifest.regions.map((row, index) => index === 0
      ? { ...row, effectivePrefix: "exports/compute-optimizer/999988887777/" }
      : row) },
    { ...manifest, regions: manifest.regions.map((row, index) => index === 1
      ? { ...row, describeContractId: manifest.regions[0]!.describeContractId }
      : row) },
  ]) assert.throws(
    () => parseComputeOptimizerMaterializationActivationManifest(
      candidate,
      owner,
      request.requestId,
    ),
    ComputeOptimizerMaterializationActivationManifestError,
  );
});
