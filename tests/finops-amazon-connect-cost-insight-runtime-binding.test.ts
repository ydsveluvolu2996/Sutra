import assert from "node:assert/strict";
import test from "node:test";
import type { RunnableJob } from "../lib/background-job-runner.ts";
import { canonicalJson } from "../lib/canonical-json.ts";
import {
  AMAZON_CONNECT_COST_INSIGHT_BOUNDS,
  AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS,
  type AmazonConnectCostInsightCapture,
  type AmazonConnectCostInsightSnapshot,
} from "../lib/finops-amazon-connect-cost-insight.ts";
import {
  AMAZON_CONNECT_COST_RUNTIME_ACTIVATION_REASONS,
  AMAZON_CONNECT_COST_RUNTIME_ARCHIVE_MAX_BYTES,
  AMAZON_CONNECT_COST_RUNTIME_BINDING,
  AMAZON_CONNECT_COST_RUNTIME_JOB_KIND,
  AMAZON_CONNECT_COST_RUNTIME_TIMEOUT_MS,
  AmazonConnectCostRuntimeBindingError,
  runAmazonConnectCostRuntimeHandler,
  scheduleAmazonConnectCostCollections,
  type AmazonConnectCostAcceptedRuntimeAttempt,
  type AmazonConnectCostRuntimeBoundary,
  type AmazonConnectCostRuntimeDependencies,
  type AmazonConnectCostRuntimeFailureCode,
  type AmazonConnectCostRuntimeRequest,
} from "../lib/finops-amazon-connect-cost-insight-runtime-binding.ts";
import type {
  AmazonConnectCostInsightPersistenceScope,
  StoredAmazonConnectCostInsightSnapshot,
} from "../db/finops-amazon-connect-cost-insight-repository.ts";

const NOW = Date.parse("2026-08-02T01:00:00.000Z");
const WINDOW = "2026-08-02T00:00:00.000Z";
const CONNECTION = `conn_${"a".repeat(32)}`;
const ACCOUNT = "111122223333";
const INSTANCE_ID = "12345678-1234-1234-1234-123456789abc";
const INSTANCE_ARN = `arn:aws:connect:us-east-1:${ACCOUNT}:instance/${INSTANCE_ID}`;
const SCOPE: AmazonConnectCostInsightPersistenceScope = {
  organizationId: "org_add11",
  customerId: "customer_add11",
  connectionId: CONNECTION,
};
const BOUNDARY: AmazonConnectCostRuntimeBoundary = {
  scope: {
    orgId: SCOPE.organizationId,
    customerId: SCOPE.customerId,
    connectionId: SCOPE.connectionId,
    accountId: ACCOUNT,
    partition: "aws",
    region: "us-east-1",
    instanceArns: [INSTANCE_ARN],
  },
  activeCur2: {
    source: "AWS_CUR2_ACTIVE_GENERATION",
    state: "ACTIVE_RECONCILED",
    generationId: `fbg_${"b".repeat(64)}`,
    sourceEvidenceId: `fss_${"c".repeat(64)}`,
    manifestSha256: "d".repeat(64),
    dataThroughAtIso: "2026-08-02T00:00:00.000Z",
    costBasis: "NET_AMORTIZED",
    currency: "USD",
    rowsExhausted: true,
    contactResourceIdsIncluded: true,
    activatedSystemTags: [
      "aws:connect:instanceId",
      "aws:connect:systemEndpoint",
    ],
    predicate: "PRODUCT_CODE_AMAZON_CONNECT_AND_CONTACT_CENTER_TELECOMMUNICATIONS",
    classificationContractVersion: "sutra-connect-cur2-v1",
    associatedServiceCoverage: "NOT_INCLUDED_SEPARATE_EVIDENCE_REQUIRED",
  },
  permissionAttestation: {
    generationId: `fss_${"e".repeat(64)}`,
    contentSha256: "f".repeat(64),
    observedAtIso: "2026-08-02T00:00:00.000Z",
    operations: AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS,
    resources: {
      describeInstanceArns: [INSTANCE_ARN],
      listPhoneNumbersArn: `arn:aws:connect:us-east-1:${ACCOUNT}:phone-number/*`,
      directoryServiceResource: "*",
    },
    denyMutationOperations: true,
  },
  privacy: {
    tokenization: "HMAC_SHA256_TENANT_SCOPED_ROTATING",
    tokenKeyVersion: "key_2026_08",
    contactDrilldownEnabled: false,
    rawProviderPayloadRetention: "FORBIDDEN",
  },
};
const JOB: RunnableJob = {
  id: `job_${"9".repeat(32)}`,
  orgId: SCOPE.organizationId,
  customerId: SCOPE.customerId,
  connectionId: SCOPE.connectionId,
  kind: AMAZON_CONNECT_COST_RUNTIME_JOB_KIND,
  payload: { scheduledWindow: WINDOW },
  attempt: 1,
  maxAttempts: 5,
};

function captureFor(request: AmazonConnectCostRuntimeRequest): AmazonConnectCostInsightCapture {
  return {
    schemaVersion: "sutra.amazon-connect-cost-insight.v1",
    scope: request.scope,
    captureId: request.expectedCaptureId,
    startedAtIso: "2026-08-02T00:04:00.000Z",
    completedAtIso: "2026-08-02T00:05:00.000Z",
    execution: { concurrencyLimit: 4, observedPeakConcurrency: 1 },
    privacy: {
      rawContactRecordsAccepted: false,
      rawPhoneNumbersAccepted: false,
      tokenization: request.privacy.tokenization,
      tokenKeyVersion: request.privacy.tokenKeyVersion,
      contactDrilldownEnabled: request.privacy.contactDrilldownEnabled,
    },
    collections: [{
      instanceArn: INSTANCE_ARN,
      configured: true,
      regionSupported: true,
      permissionsValidated: true,
      pagesExhausted: true,
      apiCallCount: 2,
      phoneRecordsScanned: 1,
      failureCode: null,
      instance: {
        instanceArn: INSTANCE_ARN,
        instanceId: INSTANCE_ID,
        alias: "support-prod",
        status: "ACTIVE",
        inboundCallsEnabled: true,
        outboundCallsEnabled: true,
        observedAtIso: "2026-08-02T00:04:30.000Z",
      },
      phoneInventory: [{
        instanceArn: INSTANCE_ARN,
        countryCode: "US",
        phoneNumberType: "DID",
        status: "CLAIMED",
        count: 1,
      }],
    }],
    costEvidence: {
      source: "AWS_CUR2_ACTIVE_GENERATION",
      generationId: request.billing.generationId,
      manifestSha256: request.billing.manifestSha256,
      dataThroughAtIso: request.billing.dataThroughAtIso,
      costBasis: request.billing.costBasis,
      currency: request.billing.currency,
      rowsExhausted: true,
      contactResourceIdsIncluded: request.billing.contactResourceIdsIncluded,
      activatedSystemTags: request.billing.activatedSystemTags,
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
  snapshot: AmazonConnectCostInsightSnapshot,
): Promise<StoredAmazonConnectCostInsightSnapshot> {
  const contentSha256 = await sha256(JSON.stringify(snapshot));
  return {
    scope: SCOPE,
    generationId: `acig_${contentSha256}`,
    contentSha256,
    snapshot,
    createdAtIso: snapshot.completedAtIso,
    committedAtIso: snapshot.complete ? snapshot.completedAtIso : null,
  };
}

function expectCode(code: AmazonConnectCostRuntimeBindingError["code"]) {
  return (error: unknown): boolean => error instanceof AmazonConnectCostRuntimeBindingError
    && error.code === code
    && error.message === "Amazon Connect cost runtime collection failed";
}

function dependencies(input?: {
  readonly boundary?: AmazonConnectCostRuntimeBoundary | null;
  readonly materializer?: AmazonConnectCostRuntimeDependencies["materializer"];
  readonly mutateCapture?: (
    capture: AmazonConnectCostInsightCapture,
  ) => AmazonConnectCostInsightCapture;
  readonly forgedVerification?: boolean;
  readonly archiveHashMismatch?: boolean;
}) {
  const accepted = new Map<string, AmazonConnectCostAcceptedRuntimeAttempt>();
  const requests: AmazonConnectCostRuntimeRequest[] = [];
  const archives: Uint8Array[] = [];
  const failures: Array<{
    readonly code: AmazonConnectCostRuntimeFailureCode;
    readonly serialized: string;
  }> = [];
  let commits = 0;
  const runtime: AmazonConnectCostRuntimeDependencies = {
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
            materializerKeyId: "amazon-connect-materializer-v1",
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
        keyVersion: "amazon-connect-evidence-v1",
      }),
    },
    handoff: {
      getAccepted: async (_scope, requestId) => accepted.get(requestId) ?? null,
      commit: async (commit) => {
        commits += 1;
        const value: AmazonConnectCostAcceptedRuntimeAttempt = {
          requestId: commit.requestId,
          scheduledWindow: commit.scheduledWindow,
          sourceBoundarySha256: commit.sourceBoundarySha256,
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
  return { runtime, requests, archives, failures, commits: () => commits };
}

test("scheduler queues only trusted connection identity and a daily window", async () => {
  const queued: unknown[] = [];
  const result = await scheduleAmazonConnectCostCollections({
    scheduledWindow: WINDOW,
    loadEligibleScopes: async () => [SCOPE],
    queue: { enqueue: async (value) => { queued.push(value); } },
  });
  assert.deepEqual(result, { scheduledWindow: WINDOW, enqueued: 1 });
  assert.deepEqual(queued, [{
    orgId: SCOPE.organizationId,
    customerId: SCOPE.customerId,
    connectionId: SCOPE.connectionId,
    kind: AMAZON_CONNECT_COST_RUNTIME_JOB_KIND,
    payload: { scheduledWindow: WINDOW },
    maxAttempts: 5,
    idempotencyKey: `amazon-connect-cost:${SCOPE.organizationId}:${SCOPE.customerId}:${CONNECTION}:${encodeURIComponent(WINDOW)}`,
  }]);
  const serialized = JSON.stringify(queued);
  assert.equal(serialized.includes(ACCOUNT), false);
  assert.equal(serialized.includes(INSTANCE_ID), false);
});

test("scheduler prevalidates duplicate scopes before any enqueue", async () => {
  let enqueued = 0;
  await assert.rejects(scheduleAmazonConnectCostCollections({
    scheduledWindow: WINDOW,
    loadEligibleScopes: async () => [SCOPE, SCOPE],
    queue: { enqueue: async () => { enqueued += 1; } },
  }), expectCode("SCOPE_REJECTED"));
  assert.equal(enqueued, 0);
});

test("runtime rejects attempts outside the fixed five-attempt contract and empty boundaries", async () => {
  for (const invalidJob of [
    { ...JOB, attempt: 6 },
    { ...JOB, maxAttempts: 6 },
  ]) {
    await assert.rejects(runAmazonConnectCostRuntimeHandler(
      invalidJob, dependencies().runtime,
    ), expectCode("INVALID_JOB"));
  }
  await assert.rejects(runAmazonConnectCostRuntimeHandler(
    JOB,
    dependencies({ boundary: {
      ...BOUNDARY,
      scope: { ...BOUNDARY.scope, instanceArns: [] },
      permissionAttestation: {
        ...BOUNDARY.permissionAttestation,
        resources: {
          ...BOUNDARY.permissionAttestation.resources,
          describeInstanceArns: [],
        },
      },
    } }).runtime,
  ), expectCode("BOUNDARY_REJECTED"));
});

test("runtime pins exact instance reads, CUR2 lineage, privacy and immutable evidence", async () => {
  const context = dependencies();
  const result = await runAmazonConnectCostRuntimeHandler(JOB, context.runtime);
  assert.equal(result.status, "collected");
  if (result.status !== "collected") return;
  assert.equal(result.state, "current");
  assert.equal(result.becameActive, true);
  const request = context.requests[0];
  assert.ok(request);
  assert.deepEqual(request.operations, AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS);
  assert.deepEqual(request.permissionAttestation.resources.describeInstanceArns,
    [INSTANCE_ARN]);
  assert.equal(request.permissionAttestation.resources.listPhoneNumbersArn,
    `arn:aws:connect:us-east-1:${ACCOUNT}:phone-number/*`);
  assert.equal(request.providerReads.listPhoneNumbersTargetArnRequired, true);
  assert.equal(request.providerReads.unscopedPhoneNumberListingForbidden, true);
  assert.equal(request.providerReads.trafficDistributionGroupsIncluded, false);
  assert.equal(request.providerReads.phonePageSize, 1_000);
  assert.equal(request.billing.generationId, BOUNDARY.activeCur2.generationId);
  assert.equal(request.billing.manifestSha256, BOUNDARY.activeCur2.manifestSha256);
  assert.equal(request.billing.associatedServiceCoverage,
    "NOT_INCLUDED_SEPARATE_EVIDENCE_REQUIRED");
  assert.equal(request.maximumDurationMs, AMAZON_CONNECT_COST_RUNTIME_TIMEOUT_MS);
  assert.equal(request.archiveMaximumBytes, AMAZON_CONNECT_COST_RUNTIME_ARCHIVE_MAX_BYTES);
  assert.deepEqual(request.bounds, AMAZON_CONNECT_COST_INSIGHT_BOUNDS);
  for (const [key, value] of Object.entries(request.privacy)) {
    if (key.endsWith("Accepted")) assert.equal(value, false);
  }
  const evidence = JSON.parse(new TextDecoder().decode(context.archives[0])) as {
    readonly privacyDisposition: Record<string, string>;
    readonly sourceBoundary: AmazonConnectCostRuntimeBoundary;
  };
  assert.equal(evidence.privacyDisposition.rawPhoneAndContactPayloads, "FORBIDDEN");
  assert.equal(evidence.sourceBoundary.permissionAttestation.generationId,
    BOUNDARY.permissionAttestation.generationId);
});

test("accepted replay performs no second materializer, archive, or commit", async () => {
  const context = dependencies();
  const first = await runAmazonConnectCostRuntimeHandler(JOB, context.runtime);
  const replay = await runAmazonConnectCostRuntimeHandler(JOB, context.runtime);
  assert.equal(first.status, "collected");
  assert.equal(replay.status, "collected");
  if (first.status !== "collected" || replay.status !== "collected") return;
  assert.equal(replay.replayed, true);
  assert.equal(replay.generationId, first.generationId);
  assert.equal(context.requests.length, 1);
  assert.equal(context.archives.length, 1);
  assert.equal(context.commits(), 1);
});

test("missing boundary and materializer remain explicitly unavailable", async () => {
  assert.deepEqual(await runAmazonConnectCostRuntimeHandler(
    JOB, dependencies({ boundary: null }).runtime,
  ), {
    status: "unavailable",
    reason: AMAZON_CONNECT_COST_RUNTIME_ACTIVATION_REASONS.boundary,
  });
  assert.deepEqual(await runAmazonConnectCostRuntimeHandler(
    JOB, dependencies({ materializer: null }).runtime,
  ), {
    status: "unavailable",
    reason: AMAZON_CONNECT_COST_RUNTIME_ACTIVATION_REASONS.adapter,
  });
  assert.equal(AMAZON_CONNECT_COST_RUNTIME_BINDING.registeredInSharedRuntime, false);
});

test("partial provider pagination persists history without advancing the head", async () => {
  const context = dependencies({
    mutateCapture: (capture) => ({
      ...capture,
      collections: capture.collections.map((collection) => ({
        ...collection,
        pagesExhausted: false,
        failureCode: "BOUND_REACHED" as const,
      })),
    }),
  });
  const result = await runAmazonConnectCostRuntimeHandler(JOB, context.runtime);
  assert.equal(result.status, "collected");
  if (result.status !== "collected") return;
  assert.equal(result.state, "partial");
  assert.equal(result.becameActive, false);
});

test("boundary, signature, CUR2/privacy substitution and raw failures fail closed", async () => {
  const wildcardBoundary = {
    ...BOUNDARY,
    permissionAttestation: {
      ...BOUNDARY.permissionAttestation,
      resources: {
        ...BOUNDARY.permissionAttestation.resources,
        listPhoneNumbersArn: "*",
      },
    },
  };
  await assert.rejects(runAmazonConnectCostRuntimeHandler(
    JOB, dependencies({ boundary: wildcardBoundary }).runtime,
  ), expectCode("BOUNDARY_REJECTED"));

  const forged = dependencies({ forgedVerification: true });
  await assert.rejects(runAmazonConnectCostRuntimeHandler(JOB, forged.runtime),
    expectCode("MATERIALIZER_AUTHENTICATION_FAILED"));
  assert.equal(forged.archives.length, 0);

  for (const mutateCapture of [
    (capture: AmazonConnectCostInsightCapture): AmazonConnectCostInsightCapture => ({
      ...capture,
      costEvidence: {
        ...capture.costEvidence,
        generationId: `fbg_${"7".repeat(64)}`,
      },
    }),
    (capture: AmazonConnectCostInsightCapture): AmazonConnectCostInsightCapture => ({
      ...capture,
      privacy: { ...capture.privacy, tokenKeyVersion: "key_attacker" },
    }),
  ]) {
    const substituted = dependencies({ mutateCapture });
    await assert.rejects(runAmazonConnectCostRuntimeHandler(
      JOB, substituted.runtime,
    ), expectCode("CAPTURE_REJECTED"));
    assert.equal(substituted.archives.length, 0);
  }

  const archive = dependencies({ archiveHashMismatch: true });
  await assert.rejects(runAmazonConnectCostRuntimeHandler(JOB, archive.runtime),
    expectCode("EVIDENCE_REJECTED"));

  const raw = "AccessDenied +12065550199 arn:aws:connect:us-east-1:111122223333";
  const failed = dependencies({
    materializer: { collect: async () => { throw new Error(raw); } },
  });
  await assert.rejects(runAmazonConnectCostRuntimeHandler(JOB, failed.runtime),
    (error: unknown) => expectCode("MATERIALIZER_UNAVAILABLE")(error)
      && !(error as Error).message.includes(raw));
  assert.deepEqual(failed.failures.map((failure) => failure.code), [
    "MATERIALIZER_UNAVAILABLE",
  ]);
  assert.equal(failed.failures.some((failure) => failure.serialized.includes(raw)), false);
});
