import assert from "node:assert/strict";
import test from "node:test";
import type { RunnableJob } from "../lib/background-job-runner.ts";
import { canonicalJson } from "../lib/canonical-json.ts";
import {
  AWS_CARBON_EMISSIONS_COLUMNS,
  SUSTAINABILITY_CARBON_BOUNDS,
  type SustainabilityCarbonCapture,
  type SustainabilityCarbonSnapshot,
} from "../lib/finops-sustainability-carbon.ts";
import {
  SUSTAINABILITY_EXPORT_READ_ACTIONS,
  SUSTAINABILITY_VERSIONED_READ_ACTIONS,
} from "../lib/finops-sustainability-carbon-job.ts";
import {
  SUSTAINABILITY_CARBON_RUNTIME_ACTIVATION_REASONS,
  SUSTAINABILITY_CARBON_RUNTIME_ARCHIVE_MAX_BYTES,
  SUSTAINABILITY_CARBON_RUNTIME_BINDING,
  SUSTAINABILITY_CARBON_RUNTIME_JOB_KIND,
  SUSTAINABILITY_CARBON_RUNTIME_TIMEOUT_MS,
  SUSTAINABILITY_PROXY_METRIC_CONTRACT,
  SustainabilityCarbonRuntimeBindingError,
  runSustainabilityCarbonRuntimeHandler,
  scheduleSustainabilityCarbonCollections,
  type SustainabilityCarbonAcceptedRuntimeAttempt,
  type SustainabilityCarbonRuntimeDependencies,
  type SustainabilityCarbonRuntimeFailureCode,
  type SustainabilityCarbonRuntimeRequest,
  type SustainabilityCarbonServerBoundary,
} from "../lib/finops-sustainability-carbon-runtime-binding.ts";
import type {
  StoredSustainabilitySnapshot,
  SustainabilityPersistenceScope,
} from "../db/finops-sustainability-carbon-repository.ts";

const NOW = Date.parse("2026-08-02T01:00:00.000Z");
const WINDOW = "2026-08-02T00:00:00.000Z";
const CONNECTION = `conn_${"a".repeat(32)}`;
const PAYER = "111122223333";
const MEMBER = "222233334444";
const SCOPE: SustainabilityPersistenceScope = {
  organizationId: "org_add08",
  customerId: "customer_add08",
  connectionId: CONNECTION,
};
const BOUNDARY: SustainabilityCarbonServerBoundary = {
  scope: {
    orgId: SCOPE.organizationId,
    customerId: SCOPE.customerId,
    connectionId: SCOPE.connectionId,
    accountId: PAYER,
    partition: "aws",
  },
  allowedUsageAccountIds: [PAYER, MEMBER],
  activeCur2: {
    source: "AWS_CUR2_ACTIVE_GENERATION",
    state: "ACTIVE_RECONCILED",
    generationId: `fbg_${"b".repeat(64)}`,
    sourceEvidenceId: `fss_${"c".repeat(64)}`,
    manifestSha256: "d".repeat(64),
    dataThroughAtIso: "2026-08-02T00:00:00.000Z",
    rowsExhausted: true,
    metricContract: SUSTAINABILITY_PROXY_METRIC_CONTRACT,
    classificationContractVersion: "sutra-cur2-resource-proxy-v1",
  },
  carbonExport: {
    source: "AWS_SUSTAINABILITY_CARBON_DATA_EXPORT",
    tableName: "CARBON_EMISSIONS",
    exportName: "sutra_carbon_monthly",
    exportArn: `arn:aws:bcm-data-exports:us-east-1:${PAYER}:export/sutra_carbon_monthly`,
    exportRegion: "us-east-1",
    bucket: "sutra-carbon-evidence-111122223333",
    prefix: "tenant-carbon/",
    expectedBucketOwner: PAYER,
    generationId: `fbg_${"e".repeat(64)}`,
    manifestSha256: "f".repeat(64),
    schemaColumns: AWS_CARBON_EMISSIONS_COLUMNS,
    publicationKind: "MONTHLY",
    publishedAtIso: "2026-07-21T12:00:00.000Z",
    expectedUsagePeriods: ["2026-06"],
  },
};
const JOB: RunnableJob = {
  id: `job_${"9".repeat(32)}`,
  orgId: SCOPE.organizationId,
  customerId: SCOPE.customerId,
  connectionId: SCOPE.connectionId,
  kind: SUSTAINABILITY_CARBON_RUNTIME_JOB_KIND,
  payload: { scheduledWindow: WINDOW },
  attempt: 1,
  maxAttempts: 5,
};

function captureFor(request: SustainabilityCarbonRuntimeRequest): SustainabilityCarbonCapture {
  const key = "tenant-carbon/model_version=v3.0.1/usage_period=2026-06/report.csv.gz";
  return {
    schemaVersion: "sutra.sustainability-carbon.v1",
    scope: request.scope,
    captureId: request.expectedCaptureId,
    startedAtIso: "2026-08-02T00:04:00.000Z",
    completedAtIso: "2026-08-02T00:05:00.000Z",
    allowedUsageAccountIds: request.allowedUsageAccountIds,
    configuration: {
      cur2Configured: true,
      carbonExportConfigured: true,
      carbonExportAccessValidated: true,
    },
    proxyEvidence: {
      source: "AWS_CUR2_ACTIVE_GENERATION",
      generationId: request.channels.proxy.generationId,
      manifestSha256: request.channels.proxy.manifestSha256,
      dataThroughAtIso: request.channels.proxy.dataThroughAtIso,
      rowsExhausted: true,
      rows: [],
    },
    carbonEvidence: {
      source: "AWS_SUSTAINABILITY_CARBON_DATA_EXPORT",
      tableName: "CARBON_EMISSIONS",
      exportName: request.channels.providerCarbon.exportName,
      exportArn: request.channels.providerCarbon.exportArn,
      exportRegion: request.channels.providerCarbon.exportRegion,
      bucket: request.channels.providerCarbon.bucket,
      prefix: request.channels.providerCarbon.prefix.replace(/\/$/u, ""),
      generationId: request.channels.providerCarbon.generationId,
      manifestSha256: request.channels.providerCarbon.manifestSha256,
      schemaColumns: request.channels.providerCarbon.schemaColumns,
      publicationKind: request.channels.providerCarbon.publicationKind,
      publishedAtIso: request.channels.providerCarbon.publishedAtIso,
      allowedUsageAccountIds: request.allowedUsageAccountIds,
      expectedUsagePeriods: request.channels.providerCarbon.expectedUsagePeriods,
      objectsExhausted: true,
      objects: [{
        bucket: request.channels.providerCarbon.bucket,
        key,
        eTag: "etag-carbon-001",
        versionId: "version-carbon-001",
        sha256: "1".repeat(64),
        sizeBytes: 0,
      }],
      rowsExhausted: true,
      periods: [{
        usagePeriod: "2026-06",
        selectedModelVersion: "v3.0.1",
        deliveryState: "DELIVERED_EMPTY",
        objectKeys: [key],
        complete: true,
      }],
      rows: [],
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

async function stored(
  snapshot: SustainabilityCarbonSnapshot,
): Promise<StoredSustainabilitySnapshot> {
  const contentSha256 = await sha256(JSON.stringify(snapshot));
  return {
    scope: SCOPE,
    generationId: `scg_${contentSha256}`,
    contentSha256,
    snapshot,
    createdAtIso: snapshot.completedAtIso,
    committedAtIso: snapshot.complete
      && (snapshot.state === "current" || snapshot.state === "empty")
      ? snapshot.completedAtIso : null,
  };
}

function expectCode(code: SustainabilityCarbonRuntimeBindingError["code"]) {
  return (error: unknown): boolean =>
    error instanceof SustainabilityCarbonRuntimeBindingError
    && error.code === code
    && error.message === "Sustainability carbon runtime collection failed";
}

function dependencies(input?: {
  readonly boundary?: SustainabilityCarbonServerBoundary | null;
  readonly materializer?: SustainabilityCarbonRuntimeDependencies["materializer"];
  readonly mutateCapture?: (
    capture: SustainabilityCarbonCapture,
  ) => SustainabilityCarbonCapture;
  readonly forgedVerification?: boolean;
  readonly archiveHashMismatch?: boolean;
}) {
  const accepted = new Map<string, SustainabilityCarbonAcceptedRuntimeAttempt>();
  const requests: SustainabilityCarbonRuntimeRequest[] = [];
  const archives: Uint8Array[] = [];
  const failures: Array<{
    readonly code: SustainabilityCarbonRuntimeFailureCode;
    readonly serialized: string;
  }> = [];
  let commits = 0;
  const runtime: SustainabilityCarbonRuntimeDependencies = {
    now: () => NOW,
    loadBoundary: async () => input?.boundary === undefined ? BOUNDARY : input.boundary,
    materializer: input?.materializer === undefined ? {
      collect: async (request, signal) => {
        assert.equal(signal.aborted, false);
        requests.push(request);
        const original = captureFor(request);
        const capture = input?.mutateCapture?.(original) ?? original;
        return {
          capture,
          verification: {
            authentication: "ED25519_RESPONSE_SIGNATURE_VERIFIED",
            requestBodySha256: input?.forgedVerification
              ? "0".repeat(64) : await sha256(canonicalJson(request)),
            captureBodySha256: await sha256(canonicalJson(capture)),
            materializerKeyId: "sustainability-materializer-v1",
          },
        };
      },
    } : input.materializer,
    evidence: {
      archive: async (archive) => {
        archives.push(archive.body);
        return {
          id: `eobj_${"1".repeat(32)}`,
          status: "available",
          contentSha256: input?.archiveHashMismatch
            ? "2".repeat(64) : await sha256(archive.body),
        };
      },
    },
    sealer: {
      seal: async () => ({
        ciphertext: `fsev1.${"A".repeat(32)}`,
        keyVersion: "sustainability-key-v1",
      }),
    },
    handoff: {
      getAccepted: async (_scope, requestId) => accepted.get(requestId) ?? null,
      commit: async (commit) => {
        commits += 1;
        const value: SustainabilityCarbonAcceptedRuntimeAttempt = {
          requestId: commit.requestId,
          scheduledWindow: commit.scheduledWindow,
          sourceBoundarySha256: commit.sourceBoundarySha256,
          snapshot: await stored(commit.normalizedSnapshot),
          evidence: commit.evidence,
        };
        accepted.set(commit.requestId, value);
        return {
          accepted: value,
          becameActive: commit.normalizedSnapshot.complete
            && (commit.normalizedSnapshot.state === "current"
              || commit.normalizedSnapshot.state === "empty"),
        };
      },
      recordFailure: async (failure) => {
        failures.push({ code: failure.code, serialized: JSON.stringify(failure) });
      },
    },
  };
  return { runtime, requests, archives, failures, commits: () => commits };
}

test("scheduler queues only trusted connection identity and a daily window", async () => {
  const queued: unknown[] = [];
  const result = await scheduleSustainabilityCarbonCollections({
    scheduledWindow: WINDOW,
    loadEligibleScopes: async () => [SCOPE],
    queue: { enqueue: async (value) => { queued.push(value); } },
  });
  assert.deepEqual(result, { scheduledWindow: WINDOW, enqueued: 1 });
  assert.deepEqual(queued, [{
    orgId: SCOPE.organizationId,
    customerId: SCOPE.customerId,
    connectionId: SCOPE.connectionId,
    kind: SUSTAINABILITY_CARBON_RUNTIME_JOB_KIND,
    payload: { scheduledWindow: WINDOW },
    maxAttempts: 5,
    idempotencyKey: `sustainability-carbon:${SCOPE.organizationId}:${SCOPE.customerId}:${CONNECTION}:${encodeURIComponent(WINDOW)}`,
  }]);
  const serialized = JSON.stringify(queued);
  assert.equal(serialized.includes(PAYER), false);
  assert.equal(serialized.includes(MEMBER), false);
  assert.equal(serialized.includes("tenant-carbon"), false);
});

test("runtime pins independent CUR2 proxy and AWS carbon export evidence", async () => {
  const context = dependencies();
  const result = await runSustainabilityCarbonRuntimeHandler(JOB, context.runtime);
  assert.equal(result.status, "collected");
  if (result.status !== "collected") return;
  assert.equal(result.state, "empty");
  assert.equal(result.proxyState, "empty");
  assert.equal(result.carbonState, "empty");
  assert.equal(result.becameActive, true);
  const request = context.requests[0];
  assert.ok(request);
  assert.deepEqual(request.channels.proxy.metricContract,
    SUSTAINABILITY_PROXY_METRIC_CONTRACT);
  assert.equal(request.channels.proxy.conversionToMtco2e, false);
  assert.equal(request.channels.providerCarbon.allocateToCur2ResourcesOrTags, false);
  assert.equal(request.channels.providerCarbon.keepLbmAndMbmSeparate, true);
  assert.equal(request.channels.providerCarbon.keepTotalsAndScopesSeparate, true);
  assert.equal(request.channels.providerCarbon.schemaColumns.length, 23);
  assert.deepEqual(request.objectReads.current, SUSTAINABILITY_EXPORT_READ_ACTIONS);
  assert.deepEqual(request.objectReads.versioned, SUSTAINABILITY_VERSIONED_READ_ACTIONS);
  assert.equal(request.objectReads.enforceExactPrefix, true);
  assert.equal(request.objectReads.enforceExpectedBucketOwner, true);
  assert.deepEqual(request.bounds, SUSTAINABILITY_CARBON_BOUNDS);
  assert.equal(request.maximumDurationMs, SUSTAINABILITY_CARBON_RUNTIME_TIMEOUT_MS);
  assert.equal(request.archiveMaximumBytes, SUSTAINABILITY_CARBON_RUNTIME_ARCHIVE_MAX_BYTES);

  const evidence = JSON.parse(new TextDecoder().decode(context.archives[0])) as {
    readonly separation: Record<string, string>;
    readonly sourceBoundary: SustainabilityCarbonServerBoundary;
  };
  assert.equal(evidence.separation.proxyToCarbonConversion, "FORBIDDEN");
  assert.equal(evidence.separation.providerCarbonWorkloadAllocation, "FORBIDDEN");
  assert.equal(evidence.sourceBoundary.activeCur2.manifestSha256,
    BOUNDARY.activeCur2.manifestSha256);
  assert.equal(evidence.sourceBoundary.carbonExport.manifestSha256,
    BOUNDARY.carbonExport.manifestSha256);
});

test("accepted at-least-once replay performs no second materialization or write", async () => {
  const context = dependencies();
  const first = await runSustainabilityCarbonRuntimeHandler(JOB, context.runtime);
  const replay = await runSustainabilityCarbonRuntimeHandler(JOB, context.runtime);
  assert.equal(first.status, "collected");
  assert.equal(replay.status, "collected");
  if (first.status !== "collected" || replay.status !== "collected") return;
  assert.equal(replay.replayed, true);
  assert.equal(replay.generationId, first.generationId);
  assert.equal(replay.evidenceGenerationId, first.evidenceGenerationId);
  assert.equal(context.requests.length, 1);
  assert.equal(context.archives.length, 1);
  assert.equal(context.commits(), 1);
});

test("missing dual-source boundary and adapter remain explicitly unavailable", async () => {
  assert.deepEqual(await runSustainabilityCarbonRuntimeHandler(
    JOB, dependencies({ boundary: null }).runtime,
  ), {
    status: "unavailable",
    reason: SUSTAINABILITY_CARBON_RUNTIME_ACTIVATION_REASONS.boundary,
  });
  assert.deepEqual(await runSustainabilityCarbonRuntimeHandler(
    JOB, dependencies({ materializer: null }).runtime,
  ), {
    status: "unavailable",
    reason: SUSTAINABILITY_CARBON_RUNTIME_ACTIVATION_REASONS.adapter,
  });
  assert.equal(SUSTAINABILITY_CARBON_RUNTIME_BINDING.registeredInSharedRuntime, false);
});

test("partial carbon delivery remains history and cannot mask the complete proxy plane", async () => {
  const context = dependencies({
    mutateCapture: (capture) => ({
      ...capture,
      carbonEvidence: capture.carbonEvidence === null ? null : {
        ...capture.carbonEvidence,
        objectsExhausted: false,
      },
    }),
  });
  const result = await runSustainabilityCarbonRuntimeHandler(JOB, context.runtime);
  assert.equal(result.status, "collected");
  if (result.status !== "collected") return;
  assert.equal(result.state, "partial");
  assert.equal(result.proxyState, "empty");
  assert.equal(result.carbonState, "partial");
  assert.equal(result.becameActive, false);
});

test("boundary, signature, CUR2/carbon substitutions and raw failures fail closed", async () => {
  const extraBoundary = {
    ...BOUNDARY,
    estimatedCarbonFactor: "0.0001",
  } as unknown as SustainabilityCarbonServerBoundary;
  await assert.rejects(runSustainabilityCarbonRuntimeHandler(
    JOB, dependencies({ boundary: extraBoundary }).runtime,
  ), expectCode("BOUNDARY_REJECTED"));

  const forged = dependencies({ forgedVerification: true });
  await assert.rejects(runSustainabilityCarbonRuntimeHandler(JOB, forged.runtime),
    expectCode("MATERIALIZER_AUTHENTICATION_FAILED"));
  assert.equal(forged.archives.length, 0);

  for (const mutateCapture of [
    (capture: SustainabilityCarbonCapture): SustainabilityCarbonCapture => ({
      ...capture,
      proxyEvidence: capture.proxyEvidence === null ? null : {
        ...capture.proxyEvidence,
        generationId: `fbg_${"7".repeat(64)}`,
      },
    }),
    (capture: SustainabilityCarbonCapture): SustainabilityCarbonCapture => ({
      ...capture,
      carbonEvidence: capture.carbonEvidence === null ? null : {
        ...capture.carbonEvidence,
        bucket: "attacker-carbon-bucket",
      },
    }),
  ]) {
    const substituted = dependencies({ mutateCapture });
    await assert.rejects(runSustainabilityCarbonRuntimeHandler(
      JOB, substituted.runtime,
    ), expectCode("CAPTURE_REJECTED"));
    assert.equal(substituted.archives.length, 0);
  }

  const mismatchedArchive = dependencies({ archiveHashMismatch: true });
  await assert.rejects(runSustainabilityCarbonRuntimeHandler(
    JOB, mismatchedArchive.runtime,
  ), expectCode("EVIDENCE_REJECTED"));

  const raw = "AccessDenied arn:aws:iam::111122223333:role/private-carbon";
  const failed = dependencies({
    materializer: { collect: async () => { throw new Error(raw); } },
  });
  await assert.rejects(runSustainabilityCarbonRuntimeHandler(JOB, failed.runtime),
    (error: unknown) => expectCode("MATERIALIZER_UNAVAILABLE")(error)
      && !(error as Error).message.includes(raw));
  assert.deepEqual(failed.failures.map((failure) => failure.code), [
    "MATERIALIZER_UNAVAILABLE",
  ]);
  assert.equal(failed.failures.some((failure) => failure.serialized.includes(raw)), false);
});
