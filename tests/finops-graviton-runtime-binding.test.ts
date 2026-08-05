import assert from "node:assert/strict";
import test from "node:test";
import type { GravitonSavingsCapture, GravitonTenantBoundary } from "../lib/finops-graviton-savings.ts";
import {
  deriveGravitonRequestKey,
  gravitonCollectionWindow,
  GRAVITON_MATERIALIZATION_JOB_KIND,
  GRAVITON_PROVIDER_ADAPTER_UNAVAILABLE,
  GravitonRuntimeBindingError,
  runGravitonDurableJob,
  scheduleGravitonMaterializations,
  type GravitonDurableJob,
  type GravitonRuntimeDependencies,
  type GravitonRuntimeReceipt,
} from "../lib/finops-graviton-runtime-binding.ts";

const scope = { orgId: "org_a", customerId: "customer_a", connectionId: `conn_${"a".repeat(32)}` };
const boundary: GravitonTenantBoundary = {
  scope,
  managementAccountId: "111122223333",
  partition: "aws",
  accountIds: ["111122223333", "444455556666"],
  regions: ["us-east-1", "us-west-2"],
};
const job: GravitonDurableJob = {
  id: `job_${"1".repeat(32)}`,
  kind: GRAVITON_MATERIALIZATION_JOB_KIND,
  orgId: scope.orgId,
  customerId: scope.customerId,
  connectionId: scope.connectionId,
  payload: { scheduledWindow: "2026-08-01T00:00:00.000Z" },
  attempt: 1,
  maxAttempts: 5,
};
const capture = {
  scope,
  managementAccountId: boundary.managementAccountId,
  partition: boundary.partition,
  accountIds: boundary.accountIds,
  regions: boundary.regions,
  collectionId: "collection-1",
} as unknown as GravitonSavingsCapture;

function dependencies(overrides: Partial<GravitonRuntimeDependencies> = {}): GravitonRuntimeDependencies {
  return {
    loadBoundary: async () => boundary,
    collector: { collect: async () => capture },
    store: {
      recordCapture: async () => ({
        generation: {
          generationId: `gvg_${"2".repeat(64)}`,
          snapshot: { collectionId: "collection-1", state: "COMPLETE" },
        },
        becameActive: true,
      }),
    },
    loadReceipt: async () => null,
    verifyReceipt: async () => true,
    sealEvidence: async () => ({ keyId: "kms-key-1", algorithm: "ECDSA_P256_SHA256", value: "signed" }),
    recordReceipt: async () => undefined,
    now: () => Date.parse("2026-08-01T01:00:00.000Z"),
    ...overrides,
  };
}

test("Graviton request identity is stable across retries and rejects noncanonical boundaries", async () => {
  const retryBoundary = {
    ...boundary,
    accountIds: [...boundary.accountIds].reverse(),
    regions: [...boundary.regions].reverse(),
  };
  const first = await deriveGravitonRequestKey(boundary, "2026-08-01T00:00:00.000Z");
  const retry = await deriveGravitonRequestKey(boundary, "2026-08-01T00:00:00.000Z");
  const next = await deriveGravitonRequestKey(boundary, "2026-08-02T00:00:00.000Z");
  assert.equal(first, retry);
  assert.notEqual(first, next);
  assert.match(first, /^gvrq_[a-f0-9]{64}$/u);
  await assert.rejects(
    deriveGravitonRequestKey(retryBoundary, "2026-08-01T00:00:00.000Z"),
    (error) => error instanceof GravitonRuntimeBindingError && error.code === "INVALID_JOB",
  );
});

test("daily scheduler prevalidates every scope before identity-only enqueue", async () => {
  const second = `conn_${"b".repeat(32)}`;
  const enqueued: unknown[] = [];
  assert.equal(gravitonCollectionWindow(Date.parse("2026-08-01T19:30:00.000Z")),
    "2026-08-01T00:00:00.000Z");
  const count = await scheduleGravitonMaterializations({
    scheduledWindow: "2026-08-01T00:00:00.000Z",
    loadEligibleScopes: async () => [
      { organizationId: scope.orgId, customerId: scope.customerId, connectionId: second },
      { organizationId: scope.orgId, customerId: scope.customerId, connectionId: scope.connectionId },
    ],
    queue: { enqueue: async (value) => { enqueued.push(value); } },
  });
  assert.equal(count, 2);
  assert.deepEqual((enqueued[0] as { payload: unknown }).payload,
    { scheduledWindow: "2026-08-01T00:00:00.000Z" });
  assert.equal((enqueued[0] as { maxAttempts: number }).maxAttempts, 5);
  assert.equal((enqueued[0] as { connectionId: string }).connectionId, scope.connectionId);

  let called = false;
  await assert.rejects(scheduleGravitonMaterializations({
    scheduledWindow: "2026-08-01T00:00:00.000Z",
    loadEligibleScopes: async () => [
      { organizationId: scope.orgId, customerId: scope.customerId, connectionId: scope.connectionId },
      { organizationId: scope.orgId, customerId: scope.customerId, connectionId: scope.connectionId },
    ],
    queue: { enqueue: async () => { called = true; } },
  }), (error) => error instanceof GravitonRuntimeBindingError && error.code === "INVALID_JOB");
  assert.equal(called, false);
});

test("missing provider adapter returns an explicit configuration state without persistence", async () => {
  let stored = false;
  const result = await runGravitonDurableJob(job, dependencies({
    collector: null,
    store: { recordCapture: async () => { stored = true; throw new Error("must not persist"); } },
  }));
  assert.equal(result.status, "configuration_required");
  assert.equal(result.activationReason, GRAVITON_PROVIDER_ADAPTER_UNAVAILABLE);
  assert.equal(stored, false);
});

test("successful durable execution passes identity to the collector and records signed replay evidence", async () => {
  let collectorRequestKey = "";
  const receipts: GravitonRuntimeReceipt[] = [];
  const result = await runGravitonDurableJob(job, dependencies({
    collector: { collect: async (request) => {
      collectorRequestKey = request.requestKey;
      assert.equal(request.scheduledWindow, "2026-08-01T00:00:00.000Z");
      return capture;
    } },
    recordReceipt: async (receipt) => { receipts.push(receipt); },
  }));
  assert.equal(result.status, "recorded");
  assert.equal(result.requestKey, collectorRequestKey);
  assert.equal(receipts[0]?.requestKey, result.requestKey);
  assert.match(receipts[0]?.evidenceSha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(receipts[0]?.signature.keyId, "kms-key-1");
});

test("verified receipt replay skips provider collection and snapshot persistence", async () => {
  const requestKey = await deriveGravitonRequestKey(boundary, "2026-08-01T00:00:00.000Z");
  const receipt: GravitonRuntimeReceipt = {
    schemaVersion: "sutra.graviton-runtime-receipt.v1",
    requestKey,
    scope,
    scheduledWindow: "2026-08-01T00:00:00.000Z",
    generationId: `gvg_${"3".repeat(64)}`,
    sourceCollectionId: "collection-existing",
    sourceState: "COMPLETE",
    becameActive: true,
    completedAtIso: "2026-08-01T01:00:00.000Z",
    evidenceSha256: "4".repeat(64),
    signature: { keyId: "kms-key-1", algorithm: "ECDSA_P256_SHA256", value: "signed" },
  };
  let collected = false;
  let stored = false;
  const result = await runGravitonDurableJob(job, dependencies({
    collector: { collect: async () => { collected = true; return capture; } },
    store: { recordCapture: async () => { stored = true; throw new Error("must not persist"); } },
    loadReceipt: async () => receipt,
  }));
  assert.equal(result.status, "replayed");
  assert.equal(result.replayed, true);
  assert.equal(collected, false);
  assert.equal(stored, false);
});

test("invalid payloads, scope substitution, and unverifiable replay receipts fail closed", async () => {
  await assert.rejects(
    runGravitonDurableJob({ ...job, payload: { scheduledWindow: "2026-08-01", accountId: "attacker" } }, dependencies()),
    (error) => error instanceof GravitonRuntimeBindingError && error.code === "INVALID_JOB",
  );
  await assert.rejects(
    runGravitonDurableJob({ ...job, maxAttempts: 4 }, dependencies()),
    (error) => error instanceof GravitonRuntimeBindingError && error.code === "INVALID_JOB",
  );
  await assert.rejects(
    runGravitonDurableJob(job, dependencies({ loadBoundary: async () => ({ ...boundary, scope: { ...scope, orgId: "org_b" } }) })),
    (error) => error instanceof GravitonRuntimeBindingError && error.code === "SCOPE_MISMATCH",
  );
  const requestKey = await deriveGravitonRequestKey(boundary, "2026-08-01T00:00:00.000Z");
  const receipt = {
    schemaVersion: "sutra.graviton-runtime-receipt.v1",
    requestKey,
    scope,
    scheduledWindow: "2026-08-01T00:00:00.000Z",
    generationId: `gvg_${"5".repeat(64)}`,
    sourceCollectionId: "collection-existing",
    sourceState: "COMPLETE",
    becameActive: true,
    completedAtIso: "2026-08-01T01:00:00.000Z",
    evidenceSha256: "6".repeat(64),
    signature: { keyId: "kms-key-1", algorithm: "ECDSA_P256_SHA256", value: "tampered" },
  } satisfies GravitonRuntimeReceipt;
  await assert.rejects(
    runGravitonDurableJob(job, dependencies({ loadReceipt: async () => receipt, verifyReceipt: async () => false })),
    (error) => error instanceof GravitonRuntimeBindingError && error.code === "REPLAY_REJECTED",
  );
});
