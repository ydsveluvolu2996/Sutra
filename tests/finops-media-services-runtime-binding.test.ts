import assert from "node:assert/strict";
import test from "node:test";
import type { RunnableJob } from "../lib/background-job-runner.ts";
import {
  MEDIA_SERVICES_INSIGHTS_READ_OPERATIONS,
  type MediaProvider,
  type MediaServicesCapture,
  type MediaServicesSnapshot,
} from "../lib/finops-media-services-insights.ts";
import {
  MEDIA_SERVICES_RUNTIME_ACTIVATION_REASON,
  MEDIA_SERVICES_RUNTIME_BINDING,
  MEDIA_SERVICES_RUNTIME_JOB_KIND,
  MEDIA_SERVICES_RUNTIME_MAX_CAPTURE_BYTES,
  MEDIA_SERVICES_RUNTIME_TIMEOUT_MS,
  MEDIA_SERVICES_RUNTIME_WORKFLOWS,
  MediaServicesRuntimeBindingError,
  runMediaServicesRuntimeHandler,
  scheduleMediaServicesCollections,
  type MediaServicesAcceptedRuntimeAttempt,
  type MediaServicesRuntimeAdapterRequest,
  type MediaServicesRuntimeDependencies,
  type MediaServicesRuntimeFailureCode,
  type MediaServicesRuntimeTarget,
} from "../lib/finops-media-services-runtime-binding.ts";
import type {
  MediaServicesPersistenceScope,
  StoredMediaServicesSnapshot,
} from "../db/finops-media-services-repository.ts";

const NOW = Date.parse("2026-08-02T01:00:00.000Z");
const WINDOW = "2026-08-02T00:00:00.000Z";
const CONNECTION = `conn_${"a".repeat(32)}`;
const SCOPE: MediaServicesPersistenceScope = {
  organizationId: "org_adv13",
  customerId: "customer_adv13",
  connectionId: CONNECTION,
};
const FLOW_ARN =
  "arn:aws:mediaconnect:us-east-1:111122223333:flow:flow-1:primary";
const TARGET: MediaServicesRuntimeTarget = {
  orgId: SCOPE.organizationId,
  customerId: SCOPE.customerId,
  connectionId: SCOPE.connectionId,
  accountId: "111122223333",
  partition: "aws",
  region: "us-east-1",
  lastAcceptedCompletedAtIso: "2026-08-01T00:05:00.000Z",
  activeBilling: {
    source: "AWS_CUR2_ACTIVE_GENERATION",
    state: "ACTIVE_RECONCILED",
    generationId: `fbg_${"b".repeat(64)}`,
    manifestSha256: "c".repeat(64),
    dataThroughAtIso: "2026-08-02T00:05:00.000Z",
    costBasis: "NET_AMORTIZED",
    currency: "USD",
    rowsExhausted: true,
  },
  planningEvidence: {
    budget: {
      state: "PINNED",
      source: "AWS_BUDGETS_ACCEPTED_GENERATION",
      generationId: `abg_${"d".repeat(64)}`,
      contentSha256: "e".repeat(64),
      dataThroughAtIso: "2026-08-02T00:00:00.000Z",
      currency: "USD",
    },
    reservationPricing: {
      state: "PINNED",
      source: "AWS_PRICE_LIST_ACCEPTED_GENERATION",
      generationId: `fss_${"f".repeat(64)}`,
      contentSha256: "1".repeat(64),
      effectiveAtIso: "2026-08-01T00:00:00.000Z",
      currency: "USD",
    },
  },
};
const JOB: RunnableJob = {
  id: "job_media_runtime_1",
  orgId: SCOPE.organizationId,
  customerId: SCOPE.customerId,
  connectionId: SCOPE.connectionId,
  kind: MEDIA_SERVICES_RUNTIME_JOB_KIND,
  payload: { scheduledWindow: WINDOW },
  attempt: 1,
  maxAttempts: 5,
};
const PROVIDERS: readonly MediaProvider[] = [
  "MEDIACONNECT", "MEDIACONVERT", "MEDIALIVE", "MEDIAPACKAGE_V1",
  "MEDIAPACKAGE_V2", "MEDIATAILOR",
];

function captureFor(request: MediaServicesRuntimeAdapterRequest): MediaServicesCapture {
  return {
    schemaVersion: "sutra.media-services-insights.v1",
    scope: request.scope,
    captureId: request.expectedCaptureId,
    startedAtIso: "2026-08-02T00:04:00.000Z",
    completedAtIso: "2026-08-02T00:05:00.000Z",
    execution: { concurrencyLimit: 4, observedPeakConcurrency: 2 },
    collections: PROVIDERS.map((provider, index) => ({
      provider,
      configured: true,
      regionSupported: true,
      readPermissionsValidated: true,
      paginationExhausted: true,
      apiCallCount: 1,
      failureCode: null,
      resources: index === 0 ? [{
        provider: "MEDIACONNECT",
        service: "MEDIACONNECT",
        resourceType: "FLOW",
        resourceArn: FLOW_ARN,
        resourceId: "flow-1",
        name: "primary",
        state: "ACTIVE",
        observedAtIso: "2026-08-02T00:05:00.000Z",
        tags: [],
        attributes: [],
      }] : [],
    })),
    costEvidence: {
      source: request.activeBilling.source,
      generationId: request.activeBilling.generationId,
      manifestSha256: request.activeBilling.manifestSha256,
      dataThroughAtIso: request.activeBilling.dataThroughAtIso,
      costBasis: request.activeBilling.costBasis,
      currency: request.activeBilling.currency,
      rowsExhausted: request.activeBilling.rowsExhausted,
      rows: [{
        rowId: "cur2-flow-1",
        service: "MEDIACONNECT",
        accountId: request.scope.accountId,
        region: request.scope.region,
        resourceArn: FLOW_ARN,
        chargePeriodStartIso: "2026-08-01T23:00:00.000Z",
        chargePeriodEndIso: "2026-08-02T00:00:00.000Z",
        operation: "RunFlow",
        usageType: "USE1-ActiveFlowHours",
        usageUnit: "Hrs",
        usageQuantityMicros: "1000000",
        costMicros: "2500000",
        chargeCategory: "USAGE",
      }],
    },
  };
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0")).join("");
}

async function stored(snapshot: MediaServicesSnapshot): Promise<StoredMediaServicesSnapshot> {
  const contentSha256 = await sha256(JSON.stringify(snapshot));
  return {
    scope: SCOPE,
    generationId: `msg_${contentSha256}`,
    contentSha256,
    snapshot,
    createdAtIso: snapshot.completedAtIso,
    committedAtIso: snapshot.complete ? snapshot.completedAtIso : null,
  };
}

function expectCode(code: MediaServicesRuntimeBindingError["code"]) {
  return (error: unknown): boolean => error instanceof MediaServicesRuntimeBindingError
    && error.code === code
    && error.message === "Media Services runtime collection failed";
}

function dependencies(input?: {
  readonly adapter?: MediaServicesRuntimeDependencies["adapter"];
  readonly loadScope?: MediaServicesRuntimeDependencies["loadScope"];
  readonly listTargets?: MediaServicesRuntimeDependencies["listTargets"];
  readonly mutateCapture?: (
    capture: MediaServicesCapture,
  ) => MediaServicesCapture;
  readonly archiveHashMismatch?: boolean;
}) {
  const accepted = new Map<string, MediaServicesAcceptedRuntimeAttempt>();
  const requests: MediaServicesRuntimeAdapterRequest[] = [];
  const archives: Uint8Array[] = [];
  const failures: Array<{
    readonly code: MediaServicesRuntimeFailureCode;
    readonly serialized: string;
  }> = [];
  let commits = 0;
  const runtime: MediaServicesRuntimeDependencies = {
    now: () => NOW,
    loadScope: input?.loadScope ?? (async () => SCOPE),
    listTargets: input?.listTargets ?? (async () => [TARGET]),
    adapter: input?.adapter === undefined ? {
      collect: async (request, signal) => {
        assert.equal(signal.aborted, false);
        requests.push(request);
        const capture = captureFor(request);
        return input?.mutateCapture?.(capture) ?? capture;
      },
    } : input.adapter,
    evidence: {
      archive: async (archive) => {
        archives.push(archive.body);
        return {
          id: `eobj_${"2".repeat(32)}`,
          status: "available",
          contentSha256: input?.archiveHashMismatch
            ? "3".repeat(64) : await sha256(archive.body),
        };
      },
    },
    sealer: {
      seal: async () => ({
        ciphertext: `fsev1.${"A".repeat(32)}`,
        keyVersion: "media-key-v1",
      }),
    },
    handoff: {
      getAccepted: async (_scope, _target, requestId) =>
        accepted.get(requestId) ?? null,
      commit: async (commit) => {
        commits += 1;
        const value: MediaServicesAcceptedRuntimeAttempt = {
          requestId: commit.requestId,
          scheduledWindow: commit.scheduledWindow,
          snapshot: await stored(commit.normalizedSnapshot),
          evidence: commit.evidence,
        };
        accepted.set(commit.requestId, value);
        return { accepted: value, becameActive: commit.normalizedSnapshot.complete };
      },
      recordFailure: async (failure) => {
        failures.push({ code: failure.code, serialized: JSON.stringify(failure) });
      },
    },
  };
  return {
    runtime,
    requests,
    archives,
    failures,
    commits: () => commits,
  };
}

test("daily scheduler accepts only trusted connection scope and an identity-only window", async () => {
  const queued: unknown[] = [];
  const result = await scheduleMediaServicesCollections({
    scheduledWindow: WINDOW,
    loadEligibleScopes: async () => [SCOPE],
    queue: { enqueue: async (value) => { queued.push(value); } },
  });
  assert.deepEqual(result, { scheduledWindow: WINDOW, enqueued: 1 });
  assert.deepEqual(queued, [{
    orgId: SCOPE.organizationId,
    customerId: SCOPE.customerId,
    connectionId: SCOPE.connectionId,
    kind: MEDIA_SERVICES_RUNTIME_JOB_KIND,
    payload: { scheduledWindow: WINDOW },
    maxAttempts: 5,
    idempotencyKey: `media-services:${CONNECTION}:${WINDOW}`,
  }]);
  assert.equal(JSON.stringify(queued).includes(TARGET.accountId), false);
  assert.equal(JSON.stringify(queued).includes(TARGET.region), false);
  await assert.rejects(scheduleMediaServicesCollections({
    scheduledWindow: WINDOW,
    loadEligibleScopes: async () => [SCOPE, SCOPE],
    queue: { enqueue: async () => undefined },
  }), expectCode("SCOPE_REJECTED"));
});

test("runtime freezes five workflows, 46 reads, pagination, CUR2 and governed lineage", async () => {
  const context = dependencies();
  const result = await runMediaServicesRuntimeHandler(JOB, context.runtime);
  assert.equal(result.status, "collected");
  if (result.status !== "collected") return;
  assert.equal(result.targetCount, 1);
  assert.equal(result.acceptedHeadCount, 1);
  assert.equal(result.governedBudgetTargetCount, 1);
  assert.equal(result.governedReservationPricingTargetCount, 1);
  const request = context.requests[0];
  assert.ok(request);
  assert.equal(request.workflows, MEDIA_SERVICES_RUNTIME_WORKFLOWS);
  assert.equal(request.workflows.length, 5);
  assert.equal(Object.values(request.operations).flat().length, 46);
  assert.deepEqual(request.operations, MEDIA_SERVICES_INSIGHTS_READ_OPERATIONS);
  assert.deepEqual(request.pagination, {
    pageSize: 100,
    maximumApiCallsPerProvider: 20_000,
    rejectTokenReplay: true,
    requireExhaustionEvidence: true,
  });
  assert.equal(request.maximumDurationMs, MEDIA_SERVICES_RUNTIME_TIMEOUT_MS);
  assert.equal(request.bounds.maximumCaptureBytes, 11 * 1_024 * 1_024);
  assert.deepEqual(request.activeBilling, TARGET.activeBilling);
  assert.deepEqual(request.planningEvidence, TARGET.planningEvidence);
  assert.equal(request.costJoin, "EXACT_RESOURCE_ARN_OR_SERVICE_LEVEL_UNATTRIBUTED");

  const evidence = JSON.parse(new TextDecoder().decode(context.archives[0])) as {
    readonly request: MediaServicesRuntimeAdapterRequest;
    readonly capture: MediaServicesCapture;
  };
  assert.equal(evidence.capture.costEvidence.generationId,
    TARGET.activeBilling.generationId);
  assert.equal(evidence.capture.costEvidence.manifestSha256,
    TARGET.activeBilling.manifestSha256);
  assert.equal(evidence.capture.costEvidence.costBasis,
    TARGET.activeBilling.costBasis);
  assert.equal(evidence.capture.costEvidence.currency,
    TARGET.activeBilling.currency);
  assert.equal(/amount|threshold|savingsMicros/iu.test(
    JSON.stringify(evidence.request.planningEvidence)), false);
});

test("replay is deterministic and does not recollect, archive, or persist", async () => {
  let targetReads = 0;
  const context = dependencies({
    listTargets: async () => [{
      ...TARGET,
      lastAcceptedCompletedAtIso: targetReads++ === 0
        ? "2026-08-01T00:00:00.000Z"
        : "2026-08-02T00:05:00.000Z",
    }],
  });
  const first = await runMediaServicesRuntimeHandler(JOB, context.runtime);
  const replay = await runMediaServicesRuntimeHandler(JOB, context.runtime);
  assert.equal(first.status, "collected");
  assert.equal(replay.status, "collected");
  if (first.status !== "collected" || replay.status !== "collected") return;
  assert.equal(replay.replayedCount, 1);
  assert.equal(replay.acceptedHeadCount, 0);
  assert.deepEqual(replay.generations, first.generations);
  assert.deepEqual(replay.evidenceGenerations, first.evidenceGenerations);
  assert.equal(context.requests.length, 1);
  assert.equal(context.archives.length, 1);
  assert.equal(context.commits(), 1);
  assert.equal(context.requests[0]?.incrementalAfterIso,
    "2026-08-01T00:00:00.000Z");
});

test("partial provider evidence remains incomplete and unavailable adapter stays explicit", async () => {
  const partial = dependencies({
    mutateCapture: (capture) => ({
      ...capture,
      collections: capture.collections.map((collection, index) => index === 0
        ? { ...collection, paginationExhausted: false, failureCode: "THROTTLED" }
        : collection),
    }),
  });
  const partialResult = await runMediaServicesRuntimeHandler(JOB, partial.runtime);
  assert.equal(partialResult.status, "collected");
  if (partialResult.status === "collected") {
    assert.equal(partialResult.incompleteCount, 1);
    assert.equal(partialResult.acceptedHeadCount, 0);
  }

  const unavailable = dependencies({ adapter: null });
  assert.deepEqual(await runMediaServicesRuntimeHandler(JOB, unavailable.runtime), {
    status: "unavailable",
    reason: MEDIA_SERVICES_RUNTIME_ACTIVATION_REASON,
  });
  assert.equal(MEDIA_SERVICES_RUNTIME_BINDING.registeredInSharedRuntime, false);
});

test("scope, planning values, CUR2 lineage, and archive substitutions fail closed", async () => {
  let adapterCalls = 0;
  const crossTenant = dependencies({
    loadScope: async () => ({ ...SCOPE, customerId: "customer_attacker" }),
    adapter: { collect: async (request) => {
      adapterCalls += 1;
      return captureFor(request);
    } },
  });
  await assert.rejects(runMediaServicesRuntimeHandler(JOB, crossTenant.runtime),
    expectCode("SCOPE_REJECTED"));
  assert.equal(adapterCalls, 0);

  const inventedTarget = {
    ...TARGET,
    planningEvidence: {
      ...TARGET.planningEvidence,
      budget: { ...TARGET.planningEvidence.budget, thresholdMicros: "1000000" },
    },
  } as unknown as MediaServicesRuntimeTarget;
  const invented = dependencies({ listTargets: async () => [inventedTarget] });
  await assert.rejects(runMediaServicesRuntimeHandler(JOB, invented.runtime),
    expectCode("TARGETS_REJECTED"));
  assert.equal(invented.requests.length, 0);

  const changedBilling = dependencies({
    mutateCapture: (capture) => ({
      ...capture,
      costEvidence: { ...capture.costEvidence, currency: "EUR" },
    }),
  });
  await assert.rejects(runMediaServicesRuntimeHandler(JOB, changedBilling.runtime),
    expectCode("CAPTURE_REJECTED"));
  assert.equal(changedBilling.archives.length, 0);

  const badArchive = dependencies({ archiveHashMismatch: true });
  await assert.rejects(runMediaServicesRuntimeHandler(JOB, badArchive.runtime),
    expectCode("EVIDENCE_REJECTED"));
  assert.equal(badArchive.commits(), 0);

  const oversized = dependencies({
    adapter: {
      collect: async (request) => ({
        ...captureFor(request),
        untrustedPadding: "x".repeat(MEDIA_SERVICES_RUNTIME_MAX_CAPTURE_BYTES),
      }) as MediaServicesCapture,
    },
  });
  await assert.rejects(runMediaServicesRuntimeHandler(JOB, oversized.runtime),
    expectCode("CAPTURE_REJECTED"));
  assert.equal(oversized.archives.length, 0);
});

test("raw AWS failures are reduced to generic immutable failure codes", async () => {
  const raw = "AccessDenied arn:aws:iam::111122223333:role/private";
  const context = dependencies({
    adapter: { collect: async () => { throw new Error(raw); } },
  });
  await assert.rejects(runMediaServicesRuntimeHandler(JOB, context.runtime),
    (error: unknown) => expectCode("ADAPTER_UNAVAILABLE")(error)
      && !(error as Error).message.includes(raw));
  assert.deepEqual(context.failures.map((failure) => failure.code), [
    "ADAPTER_UNAVAILABLE",
  ]);
  assert.equal(context.failures.some((failure) =>
    failure.serialized.includes("AccessDenied")), false);
  assert.equal(context.archives.length, 0);
  assert.equal(context.commits(), 0);
});
