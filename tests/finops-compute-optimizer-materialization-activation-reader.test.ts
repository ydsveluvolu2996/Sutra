import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ComputeOptimizerMaterializationActivationReaderError,
  readComputeOptimizerMaterializationActivationManifest,
  type ComputeOptimizerMaterializationActivationManifestTransport,
} from "../lib/finops-compute-optimizer-materialization-activation-reader.ts";
import type {
  ComputeOptimizerMaterializationActivationManifest,
  ComputeOptimizerMaterializationActivationManifestRequest,
} from "../services/aws-collector/src/compute-optimizer-materialization-activation-manifest.ts";

const CONNECTION = `conn_${"a".repeat(32)}`;
const ACCOUNT = "123456789012";
const REGIONS = ["us-east-1", "us-west-2"] as const;

function request(): ComputeOptimizerMaterializationActivationManifestRequest {
  return {
    schema: "sutra.compute-optimizer-materialization-activation-manifest-request.v1",
    requestId: "activation-request-1",
    tenantId: "tenant-activation",
    connectionId: CONNECTION,
    accountId: ACCOUNT,
    partition: "aws",
    requiredPermissionPackVersion: "standard-2026-08.5",
  };
}

function response(): ComputeOptimizerMaterializationActivationManifest {
  const fixed = request();
  return {
    schema: "sutra.compute-optimizer-materialization-activation-manifest-response.v1",
    requestId: fixed.requestId,
    tenantId: fixed.tenantId,
    connectionId: fixed.connectionId,
    accountId: fixed.accountId,
    partition: fixed.partition,
    permissionPackVersion: "standard-2026-08.5",
    regions: REGIONS.map((region) => ({
      region,
      describeContractId: `co-source-${region}`,
      launchContractId: `co-launch-${region}`,
      objectReadContractId: `co-object-${region}`,
      bucket: `sutra-compute-optimizer-${region}`,
      basePrefix: `exports/${region}/`,
      effectivePrefix: `exports/${region}/compute-optimizer/${ACCOUNT}/`,
    })),
  };
}

function read(
  transport: ComputeOptimizerMaterializationActivationManifestTransport,
  options: Parameters<typeof readComputeOptimizerMaterializationActivationManifest>[2] = {},
) {
  return readComputeOptimizerMaterializationActivationManifest({
    request: request(),
    enabledRegions: [...REGIONS].reverse(),
  }, transport, options);
}

function code(expected: ComputeOptimizerMaterializationActivationReaderError["code"]) {
  return (error: unknown) =>
    error instanceof ComputeOptimizerMaterializationActivationReaderError
    && error.code === expected;
}

test("returns a frozen exact manifest from the abstract signed transport", async () => {
  const calls: unknown[] = [];
  const manifest = await read({
    readActivationManifest: async (value, context) => {
      calls.push({ value, signal: context.signal });
      return response();
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0] as { value: unknown }).value, request());
  assert.deepEqual(manifest.regions.map(({ region }) => region), REGIONS);
  assert.ok(Object.isFrozen(manifest));
  assert.ok(Object.isFrozen(manifest.regions[0]));
  assert.doesNotMatch(JSON.stringify(manifest), /credential|secret|externalId|roleArn|policy/u);
});

test("rejects hostile identity, prefix, duplicate, partial and extra-field responses", async () => {
  const base = response();
  const candidates: unknown[] = [
    { ...base, tenantId: "neighbor" },
    { ...base, connectionId: `conn_${"b".repeat(32)}` },
    { ...base, accountId: "999988887777" },
    { ...base, partition: "aws-cn" },
    { ...base, permissionPackVersion: "standard-2026-08.4" },
    { ...base, regions: base.regions.slice(0, 1) },
    { ...base, regions: [...base.regions].reverse() },
    { ...base, credentials: { secretAccessKey: "forbidden" } },
    { ...base, regions: base.regions.map((row, index) => index === 0
      ? { ...row, roleArn: "arn:aws:iam::123456789012:role/forbidden" }
      : row) },
    { ...base, regions: base.regions.map((row, index) => index === 0
      ? { ...row, effectivePrefix: "exports/compute-optimizer/999988887777/" }
      : row) },
    { ...base, regions: base.regions.map((row, index) => index === 1
      ? { ...row, launchContractId: base.regions[0]!.launchContractId }
      : row) },
  ];
  for (const candidate of candidates) await assert.rejects(read({
    readActivationManifest: async () => candidate,
  }), (error: unknown) => code("BROKER_RESPONSE_INVALID")(error)
    || code("REGION_MATRIX_INVALID")(error));
});

test("hard deadline and parent abort stop an uncooperative transport", async () => {
  let deadlineSignal: AbortSignal | undefined;
  await assert.rejects(read({
    readActivationManifest: async (_value, context) => {
      deadlineSignal = context.signal;
      return new Promise(() => undefined);
    },
  }, { maximumDurationMs: 5 }), code("DEADLINE_EXCEEDED"));
  assert.equal(deadlineSignal?.aborted, true);

  let abortSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const pending = read({
    readActivationManifest: async (_value, context) => {
      abortSignal = context.signal;
      return new Promise(() => undefined);
    },
  }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, code("ABORTED"));
  assert.equal(abortSignal?.aborted ?? controller.signal.aborted, true);
});

test("transport failures are sanitized and never disclose the broker error", async () => {
  const secret = "signed broker secret and stack";
  await assert.rejects(read({
    readActivationManifest: async () => { throw new Error(secret); },
  }), (error: unknown) => code("TRANSPORT_FAILED")(error)
    && !(error as Error).message.includes(secret));
});
