import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  COMPUTE_OPTIMIZER_BASE_ROLE_OUTPUT_KEYS,
  COMPUTE_OPTIMIZER_REGIONAL_LAUNCH_OUTPUT_KEYS,
  MAX_COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PROVISIONING_DURATION_MS,
  ComputeOptimizerExportLaunchProvisioningError,
  stageComputeOptimizerExportLaunchProvisioning,
  type ComputeOptimizerExportLaunchProvisioningCandidate,
  type ComputeOptimizerProvisioningOutputs,
} from "../src/compute-optimizer-export-launch-provisioning.js";
import {
  FinopsSourceContractError,
  parseFinopsSourceContracts,
} from "../src/finops-source-contract.js";
import {
  EncryptedFileConnectionRegistry,
  RegistryConnectionNotFoundError,
  RegistryIntegrityError,
  RegistryStateError,
} from "../src/local-registry.js";
import type {
  ComputeOptimizerExportLaunchProvisioningVerification,
  FinopsSourceContract,
} from "../src/types.js";

const TENANT = "tenant-provisioning";
const CONNECTION_ID = `conn_${"a".repeat(32)}`;
const ACCOUNT = "123456789012";
const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/sutra/SutraCollectorRole`;
const EXTERNAL_ID = "4a3e789b-5a2e-47db-9cab-226cbe52fc04";
const REGIONS = ["us-east-1", "us-west-2"] as const;
const SCOPE = { tenantId: TENANT } as const;

function deadline(): number {
  return Date.now() + 30_000;
}

function source(
  sourceId: string,
  region: string,
  contractId = `${sourceId}-${region}`,
  policyName = sourceId === "compute_optimizer_organization_export"
    ? "SutraFinopsComputeOptimizerExportReadV1"
    : "SutraFinopsCostAnomalyReadV1",
): FinopsSourceContract {
  return {
    tenantId: TENANT,
    connectionId: CONNECTION_ID,
    contractId,
    sourceId,
    accountId: ACCOUNT,
    partition: "aws",
    region,
    permissionContractId: sourceId === "compute_optimizer_organization_export"
      ? "aws-compute-optimizer-organization-export-read-v1"
      : "aws-cost-anomaly-read-v1",
    policyName,
  };
}

function baseOutputs(): ComputeOptimizerProvisioningOutputs {
  return {
    CustomerReadRoleArn: ROLE_ARN,
    PermissionPackVersion: "standard-2026-08.5",
    RequiredFoundationalFinopsAddOn: "foundational-cur2-export-v1",
    RequiredComputeOptimizerExportReadAddOn: "compute-optimizer-export-read-v1",
    RequiredComputeOptimizerExportLaunchAddOn:
      "compute-optimizer-export-launch-v1",
  };
}

function regionalOutputs(region: string): ComputeOptimizerProvisioningOutputs {
  const bucket = `sutra-co-${region}-${ACCOUNT}`;
  const basePrefix = "sutra-finops/";
  const effectivePrefix = `${basePrefix}compute-optimizer/${ACCOUNT}/`;
  const bucketArn = `arn:aws:s3:::${bucket}`;
  return {
    AttachedPolicyName: `SutraComputeOptimizerExportLaunchV1-${region}`,
    BucketPolicyLogicalId: "ComputeOptimizerExportBucketPolicy",
    BucketVersioningStatus: "Enabled",
    CollectorRoleArn: ROLE_ARN,
    CollectorRoleName: "SutraCollectorRole",
    ComputeOptimizerServicePrincipal: "compute-optimizer.amazonaws.com",
    ContractVersion: "compute-optimizer-export-launch-v1",
    EffectivePrefix: effectivePrefix,
    EncryptionMode: "SSE_S3",
    ExportBasePrefix: basePrefix,
    ExportBucketArn: bucketArn,
    ExportBucketName: bucket,
    ExportRegion: region,
    ObjectArnPrefix: `${bucketArn}/${effectivePrefix}*`,
    RequesterAccountId: ACCOUNT,
    RequiredBasePermissionPackVersion: "standard-2026-08.5",
    StackPartition: "aws",
  };
}

function regionalObjectReadOutputs(region: string): ComputeOptimizerProvisioningOutputs {
  const launch = regionalOutputs(region);
  return {
    AttachedPolicyName:
      `SutraComputeOptimizerExportReadV1-${region}-${launch.ExportBucketName}`,
    CollectorRoleArn: ROLE_ARN,
    CollectorRoleName: "SutraCollectorRole",
    ContractVersion: "compute-optimizer-export-read-v1",
    EffectivePrefix: launch.EffectivePrefix!,
    ExistingBucketName: launch.ExportBucketName!,
    ExportBasePrefix: launch.ExportBasePrefix!,
    ExportRegion: region,
    KmsKeyArn: "NONE",
    KmsMode: "SSE_S3",
    ObjectArnPrefix: launch.ObjectArnPrefix!,
    RequesterAccountId: ACCOUNT,
    RequiredBasePermissionPackVersion: "standard-2026-08.4",
    StackPartition: "aws",
  };
}

function expectedRegionalContractId(
  kind: "object" | "launch",
  region: string,
  outputs: ComputeOptimizerProvisioningOutputs,
): string {
  const canonical = Object.fromEntries(
    Object.entries(outputs).sort(([left], [right]) => left.localeCompare(right)),
  );
  const digest = createHash("sha256").update(JSON.stringify({
    tenantId: TENANT,
    connectionId: CONNECTION_ID,
    accountId: ACCOUNT,
    partition: "aws",
    region,
    outputs: canonical,
  }), "utf8").digest("hex").slice(0, 24);
  return `co-${kind}-${region}-${digest}`;
}

function candidate(
  overrides: Partial<ComputeOptimizerExportLaunchProvisioningCandidate> = {},
): ComputeOptimizerExportLaunchProvisioningCandidate {
  return {
    tenantId: TENANT,
    connectionId: CONNECTION_ID,
    expectedAccountId: ACCOUNT,
    partition: "aws",
    roleArn: ROLE_ARN,
    status: "ACTIVE",
    permissionPackVersion: "standard-2026-07.4",
    enabledRegions: REGIONS,
    finopsSourceContracts: [source("cost_anomaly_detection", "us-east-1")],
    ...overrides,
  };
}

test("regional Compute Optimizer source identities share one exact IAM policy only", () => {
  const owner = {
    tenantId: TENANT,
    connectionId: CONNECTION_ID,
    expectedAccountId: ACCOUNT,
    partition: "aws" as const,
  };
  const east = source("compute_optimizer_organization_export", "us-east-1");
  const west = source("compute_optimizer_organization_export", "us-west-2");
  const parsed = parseFinopsSourceContracts([
    west,
    source("cost_anomaly_detection", "us-east-1"),
    east,
  ], owner);
  assert.deepEqual(
    parsed.filter(({ sourceId }) =>
      sourceId === "compute_optimizer_organization_export").map(({ region }) => region).sort(),
    [...REGIONS],
  );
  for (const invalid of [
    [east, { ...east, contractId: "different-id-same-region" }],
    [source("cost_anomaly_detection", "us-east-1"),
      source("cost_anomaly_detection", "us-west-2", "cost-west")],
    [source("cost_anomaly_detection", "us-east-1"),
      source("trusted_advisor_standard_checks", "us-east-1", "ta", "SutraFinopsCostAnomalyReadV1")],
  ]) assert.throws(
    () => parseFinopsSourceContracts(invalid, owner),
    FinopsSourceContractError,
  );
});

test("trusted staging reads exact server outputs, retains singleton sources and never auto-activates", async () => {
  let stored = candidate();
  let attested = 0;
  let marked: ComputeOptimizerExportLaunchProvisioningVerification | null = null;
  const verification = await stageComputeOptimizerExportLaunchProvisioning({
    scope: SCOPE,
    connectionId: CONNECTION_ID,
    operationId: "provision-co85",
    deadlineAtMs: deadline(),
  }, {
    registry: {
      async getRegistered() { return stored; },
      async markComputeOptimizerExportLaunchProvisioningVerified(
        _scope,
        _connectionId,
        value,
      ) {
        marked = value;
        stored = { ...stored, status: "VERIFIED", permissionPackVersion: "standard-2026-08.5" };
      },
    },
    outputs: {
      async readBaseRoleOutputs() { return baseOutputs(); },
      async readRegionalLaunchOutputs(input) { return regionalOutputs(input.region); },
      async readRegionalObjectReadOutputs(input) {
        return regionalObjectReadOutputs(input.region);
      },
    },
    attestor: {
      async attest(input) {
        attested += 1;
        assert.equal(input.sourceContracts.length, 5);
        assert.equal(input.objectContracts.length, 2);
        assert.equal(input.launchContracts.length, 2);
        return {
          identityAttested: true,
          permissionPolicyAttested: true,
          launchPoliciesAttested: true,
        };
      },
    },
  });
  assert.equal(attested, 1);
  assert.equal(marked, verification);
  assert.equal(stored.status, "VERIFIED");
  assert.equal(verification.baseRoleOutputsSha256.length, 64);
  assert.equal(verification.regionalObjectReadOutputsSha256.length, 64);
  assert.equal(verification.regionalLaunchOutputsSha256.length, 64);
  assert.deepEqual(verification.enabledRegions, [...REGIONS]);
  assert.equal(verification.sourceContracts.filter(({ sourceId }) =>
    sourceId === "cost_anomaly_detection").length, 1);
  assert.equal(verification.sourceContracts.filter(({ sourceId }) =>
    sourceId === "compute_optimizer_organization_export").length, 2);
  for (const objectContract of verification.objectContracts) {
    assert.equal(
      objectContract.contractId,
      expectedRegionalContractId(
        "object",
        objectContract.region,
        regionalObjectReadOutputs(objectContract.region),
      ),
    );
    assert.notEqual(
      objectContract.contractId,
      expectedRegionalContractId(
        "object",
        objectContract.region,
        regionalOutputs(objectContract.region),
      ),
    );
  }
  assert.deepEqual(COMPUTE_OPTIMIZER_BASE_ROLE_OUTPUT_KEYS, [
    "CustomerReadRoleArn",
    "PermissionPackVersion",
    "RequiredFoundationalFinopsAddOn",
    "RequiredComputeOptimizerExportReadAddOn",
    "RequiredComputeOptimizerExportLaunchAddOn",
  ]);
  assert.equal(COMPUTE_OPTIMIZER_REGIONAL_LAUNCH_OUTPUT_KEYS.length, 17);
});

test("browser-shaped fields and every output ownership expansion fail before attestation", async () => {
  const attacks: Array<(base: ComputeOptimizerProvisioningOutputs, region: string) =>
  ComputeOptimizerProvisioningOutputs> = [
    (base) => ({ ...base, RequesterAccountId: "999999999999" }),
    (base) => ({ ...base, StackPartition: "aws-cn" }),
    (base) => ({ ...base, ExportRegion: "eu-west-1" }),
    (base) => ({ ...base, CollectorRoleArn: `arn:aws:iam::${ACCOUNT}:role/Admin` }),
    (base) => ({ ...base, EffectivePrefix: "compute-optimizer/999999999999/" }),
    (base) => ({ ...base, ObjectArnPrefix: `${base.ExportBucketArn}/*` }),
    (base) => ({ ...base, EncryptionMode: "aws:kms" }),
    (base) => ({ ...base, BucketVersioningStatus: "Suspended" }),
    (base) => ({ ...base, wildcard: "*" }),
  ];
  for (const attack of attacks) {
    let attested = false;
    await assert.rejects(stageComputeOptimizerExportLaunchProvisioning({
      scope: SCOPE,
      connectionId: CONNECTION_ID,
      operationId: "adversarial-co85",
      deadlineAtMs: deadline(),
    }, {
      registry: {
        async getRegistered() { return candidate(); },
        async markComputeOptimizerExportLaunchProvisioningVerified() {
          assert.fail("invalid outputs reached registry mutation");
        },
      },
      outputs: {
        async readBaseRoleOutputs() { return baseOutputs(); },
        async readRegionalLaunchOutputs(input) {
          return attack(regionalOutputs(input.region), input.region);
        },
        async readRegionalObjectReadOutputs(input) {
          return regionalObjectReadOutputs(input.region);
        },
      },
      attestor: {
        async attest() {
          attested = true;
          return { identityAttested: true, permissionPolicyAttested: true,
            launchPoliciesAttested: true };
        },
      },
    }), (error: unknown) => error instanceof ComputeOptimizerExportLaunchProvisioningError
      && error.code === "OUTPUTS_INVALID");
    assert.equal(attested, false);
  }
  await assert.rejects(stageComputeOptimizerExportLaunchProvisioning({
    scope: SCOPE,
    connectionId: CONNECTION_ID,
    operationId: "adversarial-extra",
    deadlineAtMs: deadline(),
    launchContracts: [] as never,
  } as never, {
    registry: {
      async getRegistered() { assert.fail("invalid input reached registry"); },
      async markComputeOptimizerExportLaunchProvisioningVerified() {},
    },
    outputs: {
      async readBaseRoleOutputs() { return baseOutputs(); },
      async readRegionalLaunchOutputs(input) { return regionalOutputs(input.region); },
      async readRegionalObjectReadOutputs(input) {
        return regionalObjectReadOutputs(input.region);
      },
    },
    attestor: { async attest() { assert.fail("invalid input reached attestor"); } },
  }), (error: unknown) => error instanceof ComputeOptimizerExportLaunchProvisioningError
    && error.code === "INVALID_INPUT");
});

test("regional read add-on must be complete, exact and bound to the launch destination", async () => {
  const attacks: Array<(value: ComputeOptimizerProvisioningOutputs) =>
  ComputeOptimizerProvisioningOutputs> = [
    (value) => {
      const { AttachedPolicyName: _missing, ...missing } = value;
      void _missing;
      return missing;
    },
    (value) => ({ ...value, KmsMode: "SSE_KMS", KmsKeyArn:
      `arn:aws:kms:us-east-1:${ACCOUNT}:key/not-attested` }),
    (value) => ({ ...value, AttachedPolicyName: "SutraComputeOptimizerExportReadV1-wrong" }),
    (value) => {
      const bucket = `${value.ExistingBucketName}-neighbor`;
      const objectArnPrefix = `arn:aws:s3:::${bucket}/${value.EffectivePrefix}*`;
      return { ...value, ExistingBucketName: bucket, ObjectArnPrefix: objectArnPrefix,
        AttachedPolicyName: `SutraComputeOptimizerExportReadV1-${value.ExportRegion}-${bucket}` };
    },
  ];
  for (const attack of attacks) {
    let attested = false;
    await assert.rejects(stageComputeOptimizerExportLaunchProvisioning({
      scope: SCOPE, connectionId: CONNECTION_ID, operationId: "read-output-attack",
      deadlineAtMs: deadline(),
    }, {
      registry: {
        async getRegistered() { return candidate(); },
        async markComputeOptimizerExportLaunchProvisioningVerified() {
          assert.fail("invalid read outputs reached registry mutation");
        },
      },
      outputs: {
        async readBaseRoleOutputs() { return baseOutputs(); },
        async readRegionalLaunchOutputs(input) { return regionalOutputs(input.region); },
        async readRegionalObjectReadOutputs(input) {
          return attack(regionalObjectReadOutputs(input.region));
        },
      },
      attestor: { async attest() { attested = true; return {
        identityAttested: true, permissionPolicyAttested: true,
        launchPoliciesAttested: true,
      }; } },
    }), (error: unknown) => error instanceof ComputeOptimizerExportLaunchProvisioningError
      && error.code === "OUTPUTS_INVALID");
    assert.equal(attested, false);
  }
});

test("one absolute deadline bounds every uncooperative provisioning adapter", async () => {
  type StuckStage = "registry-get" | "base" | "launch" | "read" | "attestor"
    | "registry-stage";
  const never = <T>(): Promise<T> => new Promise<T>(() => {});
  for (const stuckAt of [
    "registry-get", "base", "launch", "read", "attestor", "registry-stage",
  ] as const satisfies readonly StuckStage[]) {
    let receivedSignal: AbortSignal | undefined;
    const promise = stageComputeOptimizerExportLaunchProvisioning({
      scope: SCOPE,
      connectionId: CONNECTION_ID,
      operationId: `stuck-${stuckAt}`,
      deadlineAtMs: Date.now() + 75,
    }, {
      registry: {
        async getRegistered(_scope, _connectionId, signal) {
          if (stuckAt === "registry-get") {
            receivedSignal = signal;
            return never();
          }
          return candidate({ enabledRegions: [REGIONS[0]] });
        },
        async markComputeOptimizerExportLaunchProvisioningVerified(
          _scope, _connectionId, _verification, signal,
        ) {
          if (stuckAt === "registry-stage") {
            receivedSignal = signal;
            return never();
          }
        },
      },
      outputs: {
        async readBaseRoleOutputs(input) {
          if (stuckAt === "base") { receivedSignal = input.signal; return never(); }
          return baseOutputs();
        },
        async readRegionalLaunchOutputs(input) {
          if (stuckAt === "launch") { receivedSignal = input.signal; return never(); }
          return regionalOutputs(input.region);
        },
        async readRegionalObjectReadOutputs(input) {
          if (stuckAt === "read") { receivedSignal = input.signal; return never(); }
          return regionalObjectReadOutputs(input.region);
        },
      },
      attestor: {
        async attest(input) {
          if (stuckAt === "attestor") { receivedSignal = input.signal; return never(); }
          return { identityAttested: true, permissionPolicyAttested: true,
            launchPoliciesAttested: true };
        },
      },
    });
    await assert.rejects(promise, (error: unknown) =>
      error instanceof ComputeOptimizerExportLaunchProvisioningError
      && error.code === "DEADLINE_EXCEEDED");
    assert.equal(receivedSignal?.aborted, true, `${stuckAt} did not receive abort`);
  }
});

test("parent abort is stable, sanitized and cancels the same hard boundary", async () => {
  const controller = new AbortController();
  let registrySignal: AbortSignal | undefined;
  const promise = stageComputeOptimizerExportLaunchProvisioning({
    scope: SCOPE,
    connectionId: CONNECTION_ID,
    operationId: "parent-abort",
    deadlineAtMs: deadline(),
    signal: controller.signal,
  }, {
    registry: {
      async getRegistered(_scope, _connectionId, signal) {
        registrySignal = signal;
        return new Promise(() => {});
      },
      async markComputeOptimizerExportLaunchProvisioningVerified() {
        assert.fail("aborted operation reached registry stage");
      },
    },
    outputs: {
      async readBaseRoleOutputs() { assert.fail("aborted operation reached outputs"); },
      async readRegionalLaunchOutputs() { assert.fail("aborted operation reached outputs"); },
      async readRegionalObjectReadOutputs() { assert.fail("aborted operation reached outputs"); },
    },
    attestor: { async attest() { assert.fail("aborted operation reached attestor"); } },
  });
  controller.abort(new Error("sensitive-parent-reason"));
  await assert.rejects(promise, (error: unknown) =>
    error instanceof ComputeOptimizerExportLaunchProvisioningError
    && error.code === "ABORTED"
    && error.message === "Compute Optimizer export launch provisioning rejected"
    && !error.message.includes("sensitive-parent-reason"));
  assert.equal(registrySignal?.aborted, true);
});

test("a terminal boundary never invokes a late dependency", async () => {
  const controller = new AbortController();
  controller.abort();
  let dependencyCalls = 0;
  await assert.rejects(stageComputeOptimizerExportLaunchProvisioning({
    scope: SCOPE,
    connectionId: CONNECTION_ID,
    operationId: "already-aborted",
    deadlineAtMs: deadline(),
    signal: controller.signal,
  }, {
    registry: {
      async getRegistered() { dependencyCalls += 1; return candidate(); },
      async markComputeOptimizerExportLaunchProvisioningVerified() { dependencyCalls += 1; },
    },
    outputs: {
      async readBaseRoleOutputs() { dependencyCalls += 1; return baseOutputs(); },
      async readRegionalLaunchOutputs(input) {
        dependencyCalls += 1; return regionalOutputs(input.region);
      },
      async readRegionalObjectReadOutputs(input) {
        dependencyCalls += 1; return regionalObjectReadOutputs(input.region);
      },
    },
    attestor: { async attest() { dependencyCalls += 1; return {
      identityAttested: true, permissionPolicyAttested: true,
      launchPoliciesAttested: true,
    }; } },
  }), (error: unknown) => error instanceof ComputeOptimizerExportLaunchProvisioningError
    && error.code === "ABORTED");
  assert.equal(dependencyCalls, 0);
});

test("deadline input cannot widen the reviewed total duration ceiling", async () => {
  await assert.rejects(stageComputeOptimizerExportLaunchProvisioning({
    scope: SCOPE,
    connectionId: CONNECTION_ID,
    operationId: "deadline-widening",
    deadlineAtMs: Date.now()
      + MAX_COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PROVISIONING_DURATION_MS + 1_000,
  }, {
    registry: {
      async getRegistered() { assert.fail("invalid deadline reached registry"); },
      async markComputeOptimizerExportLaunchProvisioningVerified() {},
    },
    outputs: {
      async readBaseRoleOutputs() { assert.fail("invalid deadline reached outputs"); },
      async readRegionalLaunchOutputs() { assert.fail("invalid deadline reached outputs"); },
      async readRegionalObjectReadOutputs() { assert.fail("invalid deadline reached outputs"); },
    },
    attestor: { async attest() { assert.fail("invalid deadline reached attestor"); } },
  }), (error: unknown) => error instanceof ComputeOptimizerExportLaunchProvisioningError
    && error.code === "INVALID_INPUT");
});

test("encrypted registry stages .8.5 fail-closed and requires exact-role activation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-co85-provisioning-"));
  const filePath = join(directory, "connections.enc.json");
  try {
    const registry = new EncryptedFileConnectionRegistry({
      filePath,
      encryptionKey: randomBytes(32).toString("base64"),
      now: () => new Date("2026-08-02T00:00:00.000Z"),
    });
    await registry.upsert({
      tenantId: TENANT,
      connectionId: CONNECTION_ID,
      expectedAccountId: ACCOUNT,
      partition: "aws",
      roleArn: ROLE_ARN,
      externalId: EXTERNAL_ID,
      enabledRegions: [...REGIONS],
    });
    const onboarding = {
      connectionId: CONNECTION_ID,
      accountId: ACCOUNT,
      partition: "aws" as const,
      roleArn: ROLE_ARN,
      callerIdentityArn:
        `arn:aws:sts::${ACCOUNT}:assumed-role/SutraCollectorRole/sutra-onboard`,
      roleSessionName: "sutra-onboard",
      missingExternalIdDenied: true as const,
      wrongExternalIdDenied: true as const,
      trustPolicyAttested: true as const,
      permissionPolicyAttested: true as const,
      sessionPolicyApplied: true as const,
      permissionPackVersion: "standard-2026-07.4" as const,
      capabilityAssessment: { grantedActions: [], missingActions: [] },
    };
    await registry.markOnboardingVerified(SCOPE, CONNECTION_ID, onboarding);
    await registry.activateOnboarding(SCOPE, CONNECTION_ID, ROLE_ARN);
    assert.equal((await registry.getRegistered(SCOPE, CONNECTION_ID))?.permissionPackVersion,
      "standard-2026-07.4");

    const verification = await stageComputeOptimizerExportLaunchProvisioning({
      scope: SCOPE,
      connectionId: CONNECTION_ID,
      operationId: "registry-stage-co85",
      deadlineAtMs: deadline(),
    }, {
      registry,
      outputs: {
        async readBaseRoleOutputs() { return baseOutputs(); },
        async readRegionalLaunchOutputs(input) { return regionalOutputs(input.region); },
        async readRegionalObjectReadOutputs(input) {
          return regionalObjectReadOutputs(input.region);
        },
      },
      attestor: {
        async attest() {
          return { identityAttested: true, permissionPolicyAttested: true,
            launchPoliciesAttested: true };
        },
      },
    });
    const staged = await registry.getRegistered(SCOPE, CONNECTION_ID);
    assert.equal(staged?.status, "VERIFIED");
    assert.equal(staged?.permissionPackVersion, "standard-2026-08.5");
    assert.equal(staged?.computeOptimizerExportObjectContracts?.length, 2);
    assert.equal(staged?.computeOptimizerExportLaunchContracts?.length, 2);
    await assert.rejects(
      registry.activateComputeOptimizerExportLaunchProvisioning(
        SCOPE,
        CONNECTION_ID,
        `arn:aws:iam::${ACCOUNT}:role/Admin`,
      ),
      RegistryStateError,
    );
    await registry.activateComputeOptimizerExportLaunchProvisioning(
      SCOPE,
      CONNECTION_ID,
      ROLE_ARN,
    );
    assert.equal((await registry.getRegistered(SCOPE, CONNECTION_ID))?.status, "ACTIVE");
    await registry.markComputeOptimizerExportLaunchProvisioningVerified(
      SCOPE,
      CONNECTION_ID,
      verification,
    );
    await assert.rejects(
      registry.markComputeOptimizerExportLaunchProvisioningVerified(
        SCOPE,
        CONNECTION_ID,
        {
          ...verification,
          objectContracts: verification.objectContracts.map((contract, index) =>
            index === 0 ? { ...contract, effectivePrefix:
              `neighbor/compute-optimizer/${ACCOUNT}/` } : contract),
        },
      ),
      RegistryIntegrityError,
    );
    await assert.rejects(
      registry.markComputeOptimizerExportLaunchProvisioningVerified(
        { tenantId: "other-tenant" },
        CONNECTION_ID,
        {} as ComputeOptimizerExportLaunchProvisioningVerification,
      ),
      RegistryConnectionNotFoundError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
