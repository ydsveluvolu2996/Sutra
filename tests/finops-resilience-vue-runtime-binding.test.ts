import assert from "node:assert/strict";
import test from "node:test";
import type { RunnableJob } from "../lib/background-job-runner.ts";
import {
  RESILIENCE_VUE_READ_OPERATIONS,
  type ResilienceVueCapture,
  type ResilienceVueScope,
  type ResilienceVueSnapshot,
} from "../lib/finops-resilience-vue.ts";
import {
  RESILIENCE_VUE_RUNTIME_ACTIVATION_REASON,
  RESILIENCE_VUE_RUNTIME_BINDING,
  RESILIENCE_VUE_RUNTIME_JOB_KIND,
  RESILIENCE_VUE_RUNTIME_MAX_CAPTURE_BYTES,
  RESILIENCE_VUE_RUNTIME_TIMEOUT_MS,
  ResilienceVueRuntimeBindingError,
  runResilienceVueRuntimeHandler,
  scheduleResilienceVueCollections,
  type ResilienceVueAcceptedRuntimeAttempt,
  type ResilienceVueRuntimeAdapterRequest,
  type ResilienceVueRuntimeDependencies,
  type ResilienceVueRuntimeFailureCode,
} from "../lib/finops-resilience-vue-runtime-binding.ts";
import type {
  ResilienceVuePersistenceScope,
  StoredResilienceVueSnapshot,
} from "../db/finops-resilience-vue-repository.ts";

const NOW = Date.parse("2026-08-02T01:00:00.000Z");
const WINDOW = "2026-08-02T00:00:00.000Z";
const CONNECTION = `conn_${"a".repeat(32)}`;
const SCOPE: ResilienceVuePersistenceScope = {
  organizationId: "org_adv10",
  customerId: "customer_adv10",
  connectionId: CONNECTION,
};
const TARGET: ResilienceVueScope = {
  orgId: SCOPE.organizationId,
  customerId: SCOPE.customerId,
  connectionId: SCOPE.connectionId,
  accountId: "111122223333",
  partition: "aws",
  region: "us-east-1",
};
const CURSOR = "2026-08-01T00:05:00.000Z";
const JOB: RunnableJob = {
  id: "job_resilience_runtime_1",
  orgId: SCOPE.organizationId,
  customerId: SCOPE.customerId,
  connectionId: SCOPE.connectionId,
  kind: RESILIENCE_VUE_RUNTIME_JOB_KIND,
  payload: { scheduledWindow: WINDOW },
  attempt: 1,
  maxAttempts: 5,
};

function emptyPage() {
  return {
    pages: [{
      request: { maxResults: 100, nextToken: null },
      response: { items: [], nextToken: null },
    }],
    exhausted: true,
  } as const;
}

function captureFor(request: ResilienceVueRuntimeAdapterRequest): ResilienceVueCapture {
  return {
    schemaVersion: "sutra.resilience-vue.v1",
    scope: request.scope,
    captureId: request.expectedCaptureId,
    startedAtIso: "2026-08-02T00:04:00.000Z",
    completedAtIso: "2026-08-02T00:05:00.000Z",
    execution: { concurrencyLimit: 4, observedPeakConcurrency: 1 },
    prerequisites: {
      serviceConfigured: true,
      readPermissionsValidated: true,
      collectorRegionEnabled: true,
    },
    applications: emptyPage(),
    applicationDetails: [],
    policies: emptyPage(),
    policyDetails: [],
    assessmentHistories: [],
    assessmentEvidence: [],
    resourceInventories: [],
  };
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

async function storedSnapshot(
  snapshot: ResilienceVueSnapshot,
): Promise<StoredResilienceVueSnapshot> {
  const contentSha256 = await sha256(JSON.stringify(snapshot));
  return {
    scope: SCOPE,
    generationId: `rvg_${contentSha256}`,
    contentSha256,
    snapshot,
    createdAtIso: snapshot.completedAtIso,
    committedAtIso: snapshot.complete ? snapshot.completedAtIso : null,
  };
}

function expectCode(code: ResilienceVueRuntimeBindingError["code"]) {
  return (error: unknown): boolean => error instanceof ResilienceVueRuntimeBindingError
    && error.code === code
    && error.message === "ResilienceVue runtime collection failed";
}

function dependencies(input?: {
  readonly adapter?: ResilienceVueRuntimeDependencies["adapter"];
  readonly loadScope?: ResilienceVueRuntimeDependencies["loadScope"];
  readonly listTargets?: ResilienceVueRuntimeDependencies["listTargets"];
  readonly archiveHashMismatch?: boolean;
}) {
  const accepted = new Map<string, ResilienceVueAcceptedRuntimeAttempt>();
  const requests: ResilienceVueRuntimeAdapterRequest[] = [];
  const archives: Array<{
    readonly snapshotId: string;
    readonly body: Uint8Array;
  }> = [];
  const failures: Array<{
    readonly code: ResilienceVueRuntimeFailureCode;
    readonly serialized: string;
  }> = [];
  let commits = 0;
  const runtime: ResilienceVueRuntimeDependencies = {
    now: () => NOW,
    loadScope: input?.loadScope ?? (async () => SCOPE),
    listTargets: input?.listTargets ?? (async () => [{
      ...TARGET,
      lastAcceptedCompletedAtIso: CURSOR,
    }]),
    adapter: input?.adapter === undefined ? {
      collect: async (request, signal) => {
        assert.equal(signal.aborted, false);
        requests.push(request);
        return captureFor(request);
      },
    } : input.adapter,
    evidence: {
      archive: async (archive) => {
        archives.push({ snapshotId: archive.snapshotId, body: archive.body });
        return {
          id: `eobj_${"b".repeat(32)}`,
          status: "available",
          contentSha256: input?.archiveHashMismatch
            ? "f".repeat(64)
            : await sha256(archive.body),
        };
      },
    },
    sealer: {
      seal: async () => ({
        ciphertext: `fsev1.${"A".repeat(32)}`,
        keyVersion: "resilience-key-v1",
      }),
    },
    handoff: {
      prepareAttempt: async () => undefined,
      getAccepted: async (_scope, _target, requestId) =>
        accepted.get(requestId) ?? null,
      commit: async (commit) => {
        commits += 1;
        const value: ResilienceVueAcceptedRuntimeAttempt = {
          requestId: commit.requestId,
          scheduledWindow: commit.scheduledWindow,
          snapshot: await storedSnapshot(commit.normalizedSnapshot),
          evidence: commit.evidence,
        };
        accepted.set(commit.requestId, value);
        return { accepted: value, becameActive: true };
      },
      recordFailure: async (failure) => {
        failures.push({ code: failure.code, serialized: JSON.stringify(failure) });
      },
    },
  };
  return {
    runtime,
    accepted,
    requests,
    archives,
    failures,
    commits: () => commits,
  };
}

test("scheduler queues identity-only daily jobs from trusted connection scope", async () => {
  const queued: unknown[] = [];
  const result = await scheduleResilienceVueCollections({
    scheduledWindow: WINDOW,
    loadEligibleScopes: async () => [SCOPE],
    queue: { enqueue: async (input) => { queued.push(input); } },
  });
  assert.deepEqual(result, { scheduledWindow: WINDOW, enqueued: 1 });
  assert.deepEqual(queued, [{
    orgId: SCOPE.organizationId,
    customerId: SCOPE.customerId,
    connectionId: SCOPE.connectionId,
    kind: RESILIENCE_VUE_RUNTIME_JOB_KIND,
    payload: { scheduledWindow: WINDOW },
    maxAttempts: 5,
    idempotencyKey: `resilience-vue:${CONNECTION}:${WINDOW}`,
  }]);
  assert.equal(JSON.stringify(queued).includes(TARGET.accountId), false);
  assert.equal(JSON.stringify(queued).includes(TARGET.region), false);

  await assert.rejects(scheduleResilienceVueCollections({
    scheduledWindow: WINDOW,
    loadEligibleScopes: async () => [SCOPE, SCOPE],
    queue: { enqueue: async () => undefined },
  }), expectCode("SCOPE_REJECTED"));
});

test("runtime pins exact read-only scope and bounds before immutable evidence handoff", async () => {
  const context = dependencies();
  const result = await runResilienceVueRuntimeHandler(JOB, context.runtime);
  assert.equal(result.status, "collected");
  if (result.status !== "collected") return;
  assert.equal(result.targetCount, 1);
  assert.equal(result.acceptedHeadCount, 1);
  assert.equal(result.incompleteCount, 0);
  assert.equal(result.replayedCount, 0);
  assert.equal(context.commits(), 1);

  const request = context.requests[0];
  assert.ok(request);
  assert.deepEqual(request.scope, TARGET);
  assert.equal(request.incrementalAfterIso, CURSOR);
  assert.equal(request.credentials, "SERVER_OWNED_TRUST_ROLE_SESSION");
  assert.deepEqual(request.operations, RESILIENCE_VUE_READ_OPERATIONS);
  assert.deepEqual(request.pagination, {
    pageSize: 100,
    maximumPages: 20_000,
    rejectTokenReplay: true,
    requireExhaustionEvidence: true,
  });
  assert.equal(request.maximumDurationMs, RESILIENCE_VUE_RUNTIME_TIMEOUT_MS);
  assert.equal(request.bounds.maximumCaptureBytes, 11 * 1_024 * 1_024);
  assert.match(request.requestId, /^rvr_[a-f0-9]{64}$/u);
  assert.equal(
    request.expectedCaptureId,
    `resilience_${request.requestId.slice("rvr_".length)}`,
  );

  const archive = context.archives[0];
  assert.ok(archive);
  assert.match(archive.snapshotId, /^fss_[a-f0-9]{64}$/u);
  const evidence = JSON.parse(new TextDecoder().decode(archive.body)) as {
    readonly schemaVersion: string;
    readonly request: ResilienceVueRuntimeAdapterRequest;
    readonly capture: ResilienceVueCapture;
  };
  assert.equal(evidence.schemaVersion, "sutra.resilience-vue-runtime-evidence.v1");
  assert.deepEqual(evidence.request.operations, RESILIENCE_VUE_READ_OPERATIONS);
  assert.equal(evidence.capture.captureId, request.expectedCaptureId);
  assert.deepEqual(result.evidenceGenerations, [archive.snapshotId]);
});

test("at-least-once replay reuses deterministic accepted evidence without recollection", async () => {
  let targetReads = 0;
  const context = dependencies({
    listTargets: async () => [{
      ...TARGET,
      lastAcceptedCompletedAtIso: targetReads++ === 0
        ? "2026-08-01T00:00:00.000Z"
        : "2026-08-02T00:05:00.000Z",
    }],
  });
  const first = await runResilienceVueRuntimeHandler(JOB, context.runtime);
  const replay = await runResilienceVueRuntimeHandler(JOB, context.runtime);
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
  assert.equal(context.requests[0]?.incrementalAfterIso, "2026-08-01T00:00:00.000Z");
});

test("unregistered adapter is explicit and cannot be mistaken for a successful binding", async () => {
  const context = dependencies({ adapter: null });
  const result = await runResilienceVueRuntimeHandler(JOB, context.runtime);
  assert.deepEqual(result, {
    status: "unavailable",
    reason: RESILIENCE_VUE_RUNTIME_ACTIVATION_REASON,
  });
  assert.equal(context.requests.length, 0);
  assert.equal(context.archives.length, 0);
  assert.equal(RESILIENCE_VUE_RUNTIME_BINDING.registeredInSharedRuntime, false);
  assert.equal(
    RESILIENCE_VUE_RUNTIME_BINDING.activationReason,
    "RESILIENCE_VUE_AWS_ADAPTER_JOB_HANDLER_NOT_REGISTERED",
  );
});

test("cross-tenant targets, substituted captures, and evidence mismatch fail closed", async () => {
  let adapterCalls = 0;
  const crossTenant = dependencies({
    loadScope: async () => ({ ...SCOPE, customerId: "customer_attacker" }),
    adapter: {
      collect: async (request) => {
        adapterCalls += 1;
        return captureFor(request);
      },
    },
  });
  await assert.rejects(
    runResilienceVueRuntimeHandler(JOB, crossTenant.runtime),
    expectCode("SCOPE_REJECTED"),
  );
  assert.equal(adapterCalls, 0);

  const badCapture = dependencies({
    adapter: {
      collect: async (request) => ({
        ...captureFor(request),
        captureId: `resilience_${"9".repeat(64)}`,
      }),
    },
  });
  await assert.rejects(
    runResilienceVueRuntimeHandler(JOB, badCapture.runtime),
    expectCode("CAPTURE_REJECTED"),
  );
  assert.equal(badCapture.archives.length, 0);
  assert.equal(badCapture.commits(), 0);

  const badEvidence = dependencies({ archiveHashMismatch: true });
  await assert.rejects(
    runResilienceVueRuntimeHandler(JOB, badEvidence.runtime),
    expectCode("EVIDENCE_REJECTED"),
  );
  assert.equal(badEvidence.commits(), 0);

  const oversized = dependencies({
    adapter: {
      collect: async (request) => ({
        ...captureFor(request),
        untrustedPadding: "x".repeat(RESILIENCE_VUE_RUNTIME_MAX_CAPTURE_BYTES),
      }) as ResilienceVueCapture,
    },
  });
  await assert.rejects(
    runResilienceVueRuntimeHandler(JOB, oversized.runtime),
    expectCode("CAPTURE_REJECTED"),
  );
  assert.equal(oversized.archives.length, 0);
});

test("raw provider failures are reduced to generic immutable failure codes", async () => {
  const raw = "AccessDenied arn:aws:iam::111122223333:role/private-role";
  const context = dependencies({
    adapter: { collect: async () => { throw new Error(raw); } },
  });
  await assert.rejects(
    runResilienceVueRuntimeHandler(JOB, context.runtime),
    (error: unknown) => expectCode("ADAPTER_UNAVAILABLE")(error)
      && !(error as Error).message.includes("AccessDenied"),
  );
  assert.deepEqual(context.failures.map((failure) => failure.code), [
    "ADAPTER_UNAVAILABLE",
  ]);
  assert.equal(context.failures.some((failure) =>
    failure.serialized.includes(raw)), false);
  assert.equal(context.archives.length, 0);
  assert.equal(context.commits(), 0);
});
