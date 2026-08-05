import assert from "node:assert/strict";
import test from "node:test";
import type { RunnableJob } from "../lib/background-job-runner.ts";
import {
  SCAD_CUR2_BASE_COLUMNS,
  SCAD_CUR2_SPLIT_COLUMNS,
  buildScadAllocationSnapshot,
  type ScadCur2Row,
  type ScadScope,
} from "../lib/finops-scad-allocation.ts";
import {
  ScadCur2RuntimeAdapter,
  ScadCur2RuntimeError,
  type ScadCur2ManifestObject,
  type ScadCur2Provider,
  type ScadCur2RuntimeBoundary,
} from "../lib/finops-scad-cur2-runtime-adapter.ts";
import {
  SCAD_CUR2_RUNTIME_ACTIVATION_REASON,
  SCAD_CUR2_RUNTIME_BINDING,
  SCAD_CUR2_RUNTIME_JOB_KIND,
  runScadCur2RuntimeHandler,
  scadCur2CollectionWindow,
  scheduleScadCur2Collections,
} from "../lib/finops-scad-durable-runtime-binding.ts";

const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const PAYER = "111111111111";
const MEMBER = "222222222222";
const MANIFEST_SHA = "c".repeat(64);
const SCOPE: ScadScope = { orgId: "org_alpha", customerId: "customer_alpha",
  connectionId: `conn_${"a".repeat(32)}`, partition: "aws", payerAccountIds: [PAYER],
  usageAccountIds: [MEMBER], regions: ["us-east-1"] };
const BOUNDARY: ScadCur2RuntimeBoundary = {
  schemaVersion: "sutra.scad-cur2-runtime-boundary.v1",
  binding: "SERVER_RESOLVED_SCAD_CUR2_EXPORT",
  scope: SCOPE,
  exportName: "sutra_cur2_scad_hourly",
  exportArn: `arn:aws:bcm-data-exports:us-east-1:${PAYER}:export/sutra-scad`,
  bucket: "sutra-cur2-evidence-111111111111",
  prefix: "exports/scad/",
  billingPeriodStartAt: "2026-07-01T00:00:00.000Z",
  billingPeriodEndAt: "2026-08-01T00:00:00.000Z",
  scadEnabledAt: "2026-07-15T00:00:00.000Z",
  firstDeliveryObservedAt: null,
  priorDeliverySequence: 0,
  lastAcceptedGenerationId: null,
  tableConfiguration: { tableName: "COST_AND_USAGE_REPORT", timeGranularity: "HOURLY",
    includeResources: "TRUE", includeSplitCostAllocationData: "TRUE" },
};
const OBJECT: ScadCur2ManifestObject = { key: "exports/scad/2026-07/part-1.csv.gz",
  eTag: "etag-1", versionId: "version-1", sha256: "d".repeat(64), sizeBytes: 4_096 };

function sourceRow(id = "line-1"): Omit<ScadCur2Row, "sourceObjectId"> {
  return { lineItemId: id, sourceRowNumber: 2, payerAccountId: PAYER,
    usageAccountId: MEMBER, region: "us-east-1", usageStartAt: "2026-07-31T10:00:00.000Z",
    usageEndAt: "2026-07-31T11:00:00.000Z", platform: "EKS",
    usageType: "USE1-EKS-EC2-vCPU-Hours", metric: "VCPU", usageUnit: "vCPU-Hours",
    currency: "USD", resourceId: "pod/payments-1", parentResourceId: "i-parent",
    resourceTags: { aws_eks_cluster_name: "prod", aws_eks_namespace: "payments" },
    reservedUsage: "2", actualUsage: "1", splitUsage: "2", splitUsageRatio: "0.5",
    splitCost: "1.25", unusedCost: "0.25", netSplitCost: "1.10", netUnusedCost: "0.20",
    publicOnDemandSplitCost: "1.50", publicOnDemandUnusedCost: "0.30" };
}

function provider(overrides: Partial<ScadCur2Provider> = {}): ScadCur2Provider {
  return {
    async getManifest() {
      return { schemaVersion: "sutra.scad-cur2-provider-manifest.v1", scope: SCOPE,
        exportArn: BOUNDARY.exportArn, bucket: BOUNDARY.bucket, prefix: BOUNDARY.prefix,
        billingPeriodStartAt: BOUNDARY.billingPeriodStartAt,
        billingPeriodEndAt: BOUNDARY.billingPeriodEndAt, manifestSha256: MANIFEST_SHA,
        activeGenerationId: `fbg_${MANIFEST_SHA}`, generatedAt: "2026-07-31T11:45:00.000Z",
        dataThroughAt: "2026-07-31T11:00:00.000Z",
        schemaColumns: [...SCAD_CUR2_BASE_COLUMNS, ...SCAD_CUR2_SPLIT_COLUMNS],
        expectedObjectCount: 1, runtimeS3PermissionsValidated: true };
    },
    async listManifestObjects() { return { objects: [OBJECT], nextToken: null }; },
    async readObjectRows() { return { object: OBJECT, rows: [sourceRow()], nextToken: null }; },
    ...overrides,
  };
}

test("materializes an exact server-pinned SCAD generation and first-delivery lineage", async () => {
  let reads = 0;
  const source = provider({ async readObjectRows(input) {
    reads += 1;
    assert.equal(input.boundary, BOUNDARY);
    assert.equal(input.pageSize, 1_000);
    return { object: OBJECT, rows: [sourceRow()], nextToken: null };
  } });
  const result = await new ScadCur2RuntimeAdapter(source, () => NOW).collectGeneration(
    BOUNDARY, new AbortController().signal);
  assert.equal(result.disposition, "MATERIALIZED");
  if (result.disposition !== "MATERIALIZED") return;
  assert.equal(result.sourceState, "READY");
  assert.equal(result.capture.deliverySequence, 1);
  assert.equal(result.capture.firstDeliveryObservedAt, "2026-07-31T12:00:00.000Z");
  assert.equal(result.capture.rows[0]?.sourceObjectId, result.capture.objects[0]?.objectId);
  assert.equal(result.capture.coverage.rowsExhausted, true);
  assert.equal(reads, 1);
});

test("detects duplicate manifest before listing or reading S3 data objects", async () => {
  let objectRequests = 0;
  const source = provider({ async listManifestObjects() { objectRequests += 1;
    return { objects: [OBJECT], nextToken: null }; }, async readObjectRows() { objectRequests += 1;
    return { object: OBJECT, rows: [sourceRow()], nextToken: null }; } });
  const result = await new ScadCur2RuntimeAdapter(source, () => NOW).collectGeneration(
    { ...BOUNDARY, firstDeliveryObservedAt: "2026-07-30T12:00:00.000Z", priorDeliverySequence: 1,
      lastAcceptedGenerationId: `fbg_${MANIFEST_SHA}` }, new AbortController().signal);
  assert.equal(result.disposition, "DUPLICATE");
  assert.equal(objectRequests, 0);
});

test("discards all rows from an object whose pagination cannot be exhausted", async () => {
  let calls = 0;
  const source = provider({ async readObjectRows() {
    calls += 1;
    if (calls === 1) return { object: OBJECT, rows: [sourceRow()], nextToken: "page-2" };
    throw new Error("hostile detail: secret-token");
  } });
  const adapter = new ScadCur2RuntimeAdapter(source, () => NOW, async () => {});
  const result = await adapter.collectGeneration(BOUNDARY, new AbortController().signal);
  assert.equal(result.disposition, "MATERIALIZED");
  if (result.disposition !== "MATERIALIZED") return;
  assert.equal(result.sourceState, "PARTIAL");
  assert.equal(result.capture.rows.length, 0);
  assert.equal(result.capture.objects.length, 0);
  assert.equal(result.capture.coverage.failedObjectCount, 1);
  assert.deepEqual(result.failureCodes, ["SOURCE_UNAVAILABLE"]);
  assert.doesNotMatch(JSON.stringify(result), /secret-token/u);
});

test("rejects repeated pagination tokens and object identity changes with sanitized codes", async () => {
  const repeated = provider({ async listManifestObjects(input) {
    return input.token === null ? { objects: [], nextToken: "same" }
      : { objects: [], nextToken: "same" };
  } });
  await assert.rejects(new ScadCur2RuntimeAdapter(repeated, () => NOW).collectGeneration(
    BOUNDARY, new AbortController().signal), (error: unknown) =>
    error instanceof ScadCur2RuntimeError && error.code === "PAGINATION_INVALID");

  const changed = provider({ async readObjectRows() {
    return { object: { ...OBJECT, eTag: "mutated" }, rows: [sourceRow()], nextToken: null };
  } });
  const result = await new ScadCur2RuntimeAdapter(changed, () => NOW, async () => {})
    .collectGeneration(BOUNDARY, new AbortController().signal);
  assert.equal(result.disposition, "MATERIALIZED");
  if (result.disposition === "MATERIALIZED") {
    assert.equal(result.sourceState, "PARTIAL");
    assert.deepEqual(result.failureCodes, ["OBJECT_CHANGED"]);
  }
});

test("unversioned current-key objects remain partial and can never advance a complete head", async () => {
  let rowsRead = false;
  const unversioned = { ...OBJECT, versionId: null };
  const source = provider({
    async listManifestObjects() { return { objects: [unversioned], nextToken: null }; },
    async readObjectRows() { rowsRead = true; return { object: unversioned, rows: [sourceRow()], nextToken: null }; },
  });
  const result = await new ScadCur2RuntimeAdapter(source, () => NOW)
    .collectGeneration(BOUNDARY, new AbortController().signal);
  assert.equal(result.disposition, "MATERIALIZED");
  if (result.disposition !== "MATERIALIZED") return;
  assert.equal(rowsRead, false);
  assert.equal(result.sourceState, "PARTIAL");
  assert.deepEqual(result.failureCodes, ["OBJECT_CHANGED"]);
  assert.equal(result.capture.coverage.processedObjectCount, 0);
});

test("daily scheduler is deterministic and binding remains explicitly unregistered", async () => {
  const enqueued: unknown[] = [];
  const window = scadCur2CollectionWindow(NOW);
  const outcome = await scheduleScadCur2Collections({ scheduledWindow: window,
    loadEligibleScopes: async () => [{ organizationId: SCOPE.orgId,
      customerId: SCOPE.customerId, connectionId: SCOPE.connectionId }],
    queue: { async enqueue(value) { enqueued.push(value); } } });
  assert.equal(outcome.enqueued, 1);
  assert.match(JSON.stringify(enqueued), /scad-cur2%3A|scad-cur2:/u);
  assert.equal(SCAD_CUR2_RUNTIME_BINDING.registeredInSharedRuntime, false);
  assert.equal(SCAD_CUR2_RUNTIME_ACTIVATION_REASON,
    "SCAD_CUR2_MATERIALIZER_JOB_HANDLER_NOT_REGISTERED");
});

test("durable handler records one immutable snapshot then replays a verified receipt", async () => {
  const adapter = new ScadCur2RuntimeAdapter(provider(), () => NOW);
  let completed: { result: import("../lib/finops-scad-durable-runtime-binding.ts").ScadCur2RuntimeResult;
    resultSha256: string } | null = null;
  let records = 0;
  const replayStore = {
    async claim() { return completed === null ? { state: "ACQUIRED" as const, leaseToken: "lease-1" }
      : { state: "COMPLETED" as const, ...completed }; },
    async complete(input: { result: import("../lib/finops-scad-durable-runtime-binding.ts").ScadCur2RuntimeResult;
      resultSha256: string }) { completed = { result: input.result, resultSha256: input.resultSha256 }; },
    async fail() {},
  };
  const dependencies = { loadBoundary: async () => BOUNDARY, adapter, replayStore, now: () => NOW,
    async record(scope: { organizationId: string; customerId: string; connectionId: string },
      trusted: ScadScope, capture: import("../lib/finops-scad-allocation.ts").ScadCapture, nowMs: number) {
      records += 1;
      const snapshot = buildScadAllocationSnapshot(capture, trusted, nowMs);
      const json = JSON.stringify(snapshot);
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
      const contentSha256 = [...new Uint8Array(hash)].map((part) => part.toString(16).padStart(2, "0")).join("");
      return { snapshot: { scope, generationId: `scg_${contentSha256}`, contentSha256, snapshot,
        createdAtIso: new Date(nowMs).toISOString(), committedAtIso: new Date(nowMs).toISOString() },
        becameActive: true };
    } };
  const job: RunnableJob = { id: `job_${"b".repeat(32)}`, orgId: SCOPE.orgId,
    customerId: SCOPE.customerId, connectionId: SCOPE.connectionId,
    kind: SCAD_CUR2_RUNTIME_JOB_KIND, payload: { scheduledWindow: scadCur2CollectionWindow(NOW) },
    attempt: 1, maxAttempts: 5 };
  const first = await runScadCur2RuntimeHandler(job, dependencies);
  const replay = await runScadCur2RuntimeHandler(job, dependencies);
  assert.equal(first.disposition, "EXECUTED");
  assert.equal(replay.disposition, "REPLAYED");
  assert.equal(records, 1);
});

test("durable handler records provider unavailability without leaking provider detail", async () => {
  const adapter = new ScadCur2RuntimeAdapter(provider({ async getManifest() {
    throw new Error("credential=do-not-leak");
  } }), () => NOW, async () => {});
  let receipt: unknown = null;
  const job: RunnableJob = { id: `job_${"c".repeat(32)}`, orgId: SCOPE.orgId,
    customerId: SCOPE.customerId, connectionId: SCOPE.connectionId,
    kind: SCAD_CUR2_RUNTIME_JOB_KIND, payload: { scheduledWindow: scadCur2CollectionWindow(NOW) },
    attempt: 1, maxAttempts: 5 };
  const result = await runScadCur2RuntimeHandler(job, { loadBoundary: async () => BOUNDARY,
    adapter, now: () => NOW,
    async record() { throw new Error("record must not be called"); },
    replayStore: { async claim() { return { state: "ACQUIRED", leaseToken: "lease-2" }; },
      async complete(input) { receipt = input; }, async fail() {} } });
  assert.equal(result.disposition, "EXECUTED");
  assert.equal(result.result.sourceState, "UNAVAILABLE");
  assert.deepEqual(result.result.failureCodes, ["SOURCE_UNAVAILABLE"]);
  assert.doesNotMatch(JSON.stringify({ result, receipt }), /do-not-leak/u);
});
