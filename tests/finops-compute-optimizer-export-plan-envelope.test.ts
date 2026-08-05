import assert from "node:assert/strict";
import test from "node:test";

import { COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG } from "../lib/finops-compute-optimizer-export-field-catalog.ts";
import {
  COMPUTE_OPTIMIZER_EXPORT_PLAN_ENVELOPE_BOUNDS,
  COMPUTE_OPTIMIZER_EXPORT_PLAN_ENVELOPE_FORMAT,
  ComputeOptimizerExportPlanEnvelope,
  ComputeOptimizerExportPlanEnvelopeError,
  type ComputeOptimizerExportPlanEnvelopeContext,
  type SealedComputeOptimizerExportPlan,
} from "../lib/finops-compute-optimizer-export-plan-envelope.ts";
import {
  createComputeOptimizerExportPlan,
  type ComputeOptimizerExportPlan,
  type ComputeOptimizerExportPlanInput,
} from "../lib/finops-compute-optimizer-export-plan.ts";

const CONNECTION = `conn_${"a".repeat(32)}`;
const DISCOVERY_RUN = `cor_${"d".repeat(64)}`;
const ACCOUNT = "111122223333";
const ROOT_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const OTHER_ROOT_KEY = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const KEY_VERSION = "finops-evidence-v1";

function input(): ComputeOptimizerExportPlanInput {
  const bucket = "sutra-co-us-east-1";
  const effectivePrefix = `compute-optimizer/${ACCOUNT}/`;
  const jobId = "job-us-east-1-ec2";
  const objectKey = `${effectivePrefix}us-east-1-2026-08-02T000000Z-${jobId}.csv`;
  return {
    scope: {
      orgId: "org_alpha",
      customerId: "customer_alpha",
      connectionId: CONNECTION,
    },
    requesterAccountId: ACCOUNT,
    partition: "aws",
    regions: ["us-east-1"],
    exportFamilies: ["EC2_INSTANCE"],
    targets: [{
      region: "us-east-1",
      exportFamily: "EC2_INSTANCE",
      bucket,
      optionalPrefix: null,
      effectivePrefix,
      request: {
        operation: "ExportEC2InstanceRecommendations",
        region: "us-east-1",
        fileFormat: "Csv",
        includeMemberAccounts: true,
        filters: [],
        fieldsToExport: COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG.EC2_INSTANCE.minimumProjection,
        s3DestinationConfig: { bucket, keyPrefix: null },
      },
      expectedJob: {
        jobId,
        providerResourceType: "Ec2Instance",
        bucket,
        objectKey,
        metadataKey: `${objectKey.slice(0, -4)}-metadata.json`,
      },
    }],
  };
}

function context(
  plan: ComputeOptimizerExportPlan,
  overrides: Partial<ComputeOptimizerExportPlanEnvelopeContext> = {},
): ComputeOptimizerExportPlanEnvelopeContext {
  return {
    orgId: plan.scope.orgId,
    customerId: plan.scope.customerId,
    connectionId: plan.scope.connectionId,
    discoveryRunId: DISCOVERY_RUN,
    planId: plan.planId,
    contentSha256: plan.contentSha256,
    ...overrides,
  };
}

async function rejectsOpaque(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(error instanceof ComputeOptimizerExportPlanEnvelopeError, true);
    assert.equal((error as Error).name, "ComputeOptimizerExportPlanEnvelopeError");
    assert.equal((error as Error).message, "Compute Optimizer export plan envelope rejected");
    assert.equal(Object.hasOwn(error as object, "code"), false);
    return true;
  });
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function aad(value: ComputeOptimizerExportPlanEnvelopeContext): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: "sutra.compute-optimizer-export-plan-envelope-aad.v1",
    orgId: value.orgId,
    customerId: value.customerId,
    connectionId: value.connectionId,
    discoveryRunId: value.discoveryRunId,
    planId: value.planId,
    contentSha256: value.contentSha256,
  }));
}

async function forge(
  plaintext: Uint8Array,
  value: ComputeOptimizerExportPlanEnvelopeContext,
  rootKey: Uint8Array = ROOT_KEY,
): Promise<SealedComputeOptimizerExportPlan> {
  const source = await globalThis.crypto.subtle.importKey(
    "raw",
    arrayBuffer(rootKey),
    "HKDF",
    false,
    ["deriveKey"],
  );
  const key = await globalThis.crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("sutra.finops.application-key-derivation.salt.v1"),
      info: new TextEncoder().encode(
        "sutra.compute-optimizer-export-plan-envelope.aes-256-gcm.v1",
      ),
    },
    source,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = Uint8Array.from({ length: 12 }, (_, index) => index + 11);
  const encrypted = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: arrayBuffer(iv),
      additionalData: arrayBuffer(aad(value)),
      tagLength: 128,
    },
    key,
    arrayBuffer(plaintext),
  ));
  const sealed = new Uint8Array(iv.byteLength + encrypted.byteLength);
  sealed.set(iv);
  sealed.set(encrypted, iv.byteLength);
  return {
    format: COMPUTE_OPTIMIZER_EXPORT_PLAN_ENVELOPE_FORMAT,
    keyVersion: KEY_VERSION,
    ciphertext: Buffer.from(sealed).toString("base64url"),
  };
}

test("round-trips only a verified plan and uses a fresh AES-GCM IV", async () => {
  const plan = await createComputeOptimizerExportPlan(input());
  const envelope = await ComputeOptimizerExportPlanEnvelope.fromRawRootKey({
    rootKey: ROOT_KEY,
    keyVersion: KEY_VERSION,
  });
  const scope = context(plan);
  const first = await envelope.seal(plan, scope);
  const second = await envelope.seal(structuredClone(plan), scope);

  assert.equal(first.format, COMPUTE_OPTIMIZER_EXPORT_PLAN_ENVELOPE_FORMAT);
  assert.equal(first.keyVersion, KEY_VERSION);
  assert.match(first.ciphertext, /^[A-Za-z0-9_-]+$/u);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.deepEqual(await envelope.open(first, scope), plan);
  assert.equal(Object.isFrozen(await envelope.open(second, scope)), true);
});

test("derives the same domain-separated key from the configured root key", async () => {
  const plan = await createComputeOptimizerExportPlan(input());
  const scope = context(plan);
  const direct = await ComputeOptimizerExportPlanEnvelope.fromRawRootKey({
    rootKey: ROOT_KEY,
    keyVersion: KEY_VERSION,
  });
  const configured = await ComputeOptimizerExportPlanEnvelope.fromEnvironment({
    SUTRA_FINOPS_EVIDENCE_REFERENCE_KEY: Buffer.from(ROOT_KEY).toString("base64url"),
    SUTRA_FINOPS_EVIDENCE_REFERENCE_KEY_VERSION: KEY_VERSION,
  });

  assert.deepEqual(await configured.open(await direct.seal(plan, scope), scope), plan);
  assert.deepEqual(await direct.open(await configured.seal(plan, scope), scope), plan);

  await rejectsOpaque(ComputeOptimizerExportPlanEnvelope.fromEnvironment({}));
  await rejectsOpaque(ComputeOptimizerExportPlanEnvelope.fromEnvironment({
    SUTRA_FINOPS_EVIDENCE_REFERENCE_KEY: `${Buffer.from(ROOT_KEY).toString("base64url")}=`,
    SUTRA_FINOPS_EVIDENCE_REFERENCE_KEY_VERSION: KEY_VERSION,
  }));
  await rejectsOpaque(ComputeOptimizerExportPlanEnvelope.fromEnvironment({
    SUTRA_FINOPS_EVIDENCE_REFERENCE_KEY: Buffer.from(ROOT_KEY.subarray(0, 31)).toString("base64url"),
    SUTRA_FINOPS_EVIDENCE_REFERENCE_KEY_VERSION: KEY_VERSION,
  }));
});

test("rejects copied ciphertext for every authenticated scope and identity field", async () => {
  const plan = await createComputeOptimizerExportPlan(input());
  const envelope = await ComputeOptimizerExportPlanEnvelope.fromRawRootKey({
    rootKey: ROOT_KEY,
    keyVersion: KEY_VERSION,
  });
  const scope = context(plan);
  const sealed = await envelope.seal(plan, scope);
  const wrongContexts: ComputeOptimizerExportPlanEnvelopeContext[] = [
    context(plan, { orgId: "org_beta" }),
    context(plan, { customerId: "customer_beta" }),
    context(plan, { connectionId: `conn_${"b".repeat(32)}` }),
    context(plan, { discoveryRunId: `cor_${"e".repeat(64)}` }),
    context(plan, { planId: `cope_${"e".repeat(64)}` }),
    context(plan, { contentSha256: "e".repeat(64) }),
  ];
  for (const wrongContext of wrongContexts) {
    await rejectsOpaque(envelope.open(sealed, wrongContext));
  }

  await rejectsOpaque(envelope.seal(plan, context(plan, { orgId: "org_beta" })));
});

test("rejects ciphertext tampering, wrong root keys, and wrong key versions opaquely", async () => {
  const plan = await createComputeOptimizerExportPlan(input());
  const scope = context(plan);
  const envelope = await ComputeOptimizerExportPlanEnvelope.fromRawRootKey({
    rootKey: ROOT_KEY,
    keyVersion: KEY_VERSION,
  });
  const wrongKey = await ComputeOptimizerExportPlanEnvelope.fromRawRootKey({
    rootKey: OTHER_ROOT_KEY,
    keyVersion: KEY_VERSION,
  });
  const wrongVersion = await ComputeOptimizerExportPlanEnvelope.fromRawRootKey({
    rootKey: ROOT_KEY,
    keyVersion: "finops-evidence-v2",
  });
  const sealed = await envelope.seal(plan, scope);
  const finalCharacter = sealed.ciphertext.at(-1)!;
  const tampered = {
    ...sealed,
    ciphertext: `${sealed.ciphertext.slice(0, -1)}${finalCharacter === "A" ? "B" : "A"}`,
  };

  await rejectsOpaque(envelope.open(tampered, scope));
  await rejectsOpaque(wrongKey.open(sealed, scope));
  await rejectsOpaque(wrongVersion.open(sealed, scope));
  await rejectsOpaque(envelope.open({ ...sealed, keyVersion: "finops-evidence-v2" }, scope));
});

test("strictly rejects malformed contexts and envelope shapes before use", async () => {
  const plan = await createComputeOptimizerExportPlan(input());
  const envelope = await ComputeOptimizerExportPlanEnvelope.fromRawRootKey({
    rootKey: ROOT_KEY,
    keyVersion: KEY_VERSION,
  });
  const scope = context(plan);
  const sealed = await envelope.seal(plan, scope);

  await rejectsOpaque(envelope.open({ ...sealed, extra: true }, scope));
  await rejectsOpaque(envelope.open({ ...sealed, format: "other" }, scope));
  await rejectsOpaque(envelope.open({ ...sealed, ciphertext: `${sealed.ciphertext}=` }, scope));
  await rejectsOpaque(envelope.open({ ...sealed, ciphertext: "A" }, scope));
  await rejectsOpaque(envelope.open(sealed, { ...scope, extra: true } as typeof scope));
  await rejectsOpaque(envelope.open(sealed, { ...scope, orgId: " invalid" }));
  await rejectsOpaque(envelope.open({
    ...sealed,
    ciphertext: "A".repeat(
      Math.ceil(COMPUTE_OPTIMIZER_EXPORT_PLAN_ENVELOPE_BOUNDS.maximumCiphertextBytes * 4 / 3) + 1,
    ),
  }, scope));
});

test("uses fatal UTF-8 and re-verifies the exact decrypted plan shape and hash", async () => {
  const plan = await createComputeOptimizerExportPlan(input());
  const scope = context(plan);
  const envelope = await ComputeOptimizerExportPlanEnvelope.fromRawRootKey({
    rootKey: ROOT_KEY,
    keyVersion: KEY_VERSION,
  });

  await rejectsOpaque(envelope.open(await forge(Uint8Array.of(0xc3, 0x28), scope), scope));

  const withExtra = { ...structuredClone(plan), extra: "not-in-contract" };
  await rejectsOpaque(envelope.open(
    await forge(new TextEncoder().encode(JSON.stringify(withExtra)), scope),
    scope,
  ));

  const hashTampered = { ...structuredClone(plan), requesterAccountId: "999999999999" };
  await rejectsOpaque(envelope.open(
    await forge(new TextEncoder().encode(JSON.stringify(hashTampered)), scope),
    scope,
  ));
});

test("round-trips maximum-length tenant identifiers and rejects 257 characters", async () => {
  const source = input();
  const value: ComputeOptimizerExportPlanInput = {
    ...source,
    scope: {
      ...source.scope,
      orgId: "o".repeat(256),
      customerId: "c".repeat(256),
    },
  };
  const plan = await createComputeOptimizerExportPlan(value);
  const envelope = await ComputeOptimizerExportPlanEnvelope.fromRawRootKey({
    rootKey: ROOT_KEY,
    keyVersion: KEY_VERSION,
  });
  const maximum = context(plan);
  const sealed = await envelope.seal(plan, maximum);
  assert.deepEqual(await envelope.open(sealed, maximum), plan);
  await rejectsOpaque(envelope.open(sealed, {
    ...maximum,
    orgId: "o".repeat(257),
  }));
});
