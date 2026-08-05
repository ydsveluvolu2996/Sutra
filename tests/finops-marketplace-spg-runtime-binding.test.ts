import assert from "node:assert/strict";
import test from "node:test";
import type { RunnableJob } from "../lib/background-job-runner.ts";
import { canonicalJson } from "../lib/canonical-json.ts";
import {
  AWS_MARKETPLACE_ACCOUNT_COVERAGE_IAM_ACTIONS,
  AWS_MARKETPLACE_BUYER_API_OPERATIONS,
  AWS_MARKETPLACE_LICENSE_MANAGER_API_OPERATIONS,
  type AwsMarketplaceOperation,
  type AwsMarketplaceSpgCapture,
  type AwsMarketplaceSpgSnapshot,
} from "../lib/finops-marketplace-spg.ts";
import {
  MARKETPLACE_SPG_RUNTIME_ACTIVATION_REASONS,
  MARKETPLACE_SPG_RUNTIME_ARCHIVE_MAX_BYTES,
  MARKETPLACE_SPG_RUNTIME_BINDING,
  MARKETPLACE_SPG_RUNTIME_JOB_KIND,
  MARKETPLACE_SPG_RUNTIME_TIMEOUT_MS,
  MarketplaceSpgRuntimeBindingError,
  runMarketplaceSpgRuntimeHandler,
  scheduleMarketplaceSpgCollections,
  type MarketplaceSpgAcceptedRuntimeAttempt,
  type MarketplaceSpgRuntimeBrokerRequest,
  type MarketplaceSpgRuntimeDependencies,
  type MarketplaceSpgRuntimeFailureCode,
  type MarketplaceSpgServerBoundary,
} from "../lib/finops-marketplace-spg-runtime-binding.ts";
import type {
  AwsMarketplaceSpgPersistenceScope,
  StoredAwsMarketplaceSpgSnapshot,
} from "../db/finops-marketplace-spg-repository.ts";

const NOW = Date.parse("2026-08-02T01:00:00.000Z");
const WINDOW = "2026-08-02T00:00:00.000Z";
const CONNECTION = `conn_${"a".repeat(32)}`;
const MANAGEMENT = "111122223333";
const MEMBER = "222233334444";
const SCOPE: AwsMarketplaceSpgPersistenceScope = {
  organizationId: "org_add05",
  customerId: "customer_add05",
  connectionId: CONNECTION,
};
const BOUNDARY: MarketplaceSpgServerBoundary = {
  scope: {
    orgId: SCOPE.organizationId,
    customerId: SCOPE.customerId,
    connectionId: SCOPE.connectionId,
    accountId: MANAGEMENT,
    partition: "aws",
    awsOrganizationId: "o-abcdefghij12",
  },
  accountCoverage: {
    basis: "AWS_ORGANIZATIONS_ACTIVE_ACCOUNTS",
    evidenceGenerationId: `fss_${"b".repeat(64)}`,
    contentSha256: "c".repeat(64),
    observedAt: "2026-08-02T00:00:00.000Z",
    expectedAccountIds: [MANAGEMENT, MEMBER],
  },
  licenseManager: {
    collectionMode: "ORGANIZATION",
    region: "us-east-1",
    organizationIntegrationRequired: true,
    crossAccountDiscoveryRequired: true,
  },
  activeCur2: {
    source: "ACTIVE_RECONCILED_CUR2_GENERATION",
    generationId: `fbg_${"d".repeat(64)}`,
    sourceEvidenceId: `fss_${"e".repeat(64)}`,
    manifestSha256: "f".repeat(64),
    dataThroughAt: "2026-08-02T00:00:00.000Z",
    reconciliationState: "reconciled",
    predicate: "CUR2_BILLING_ENTITY_AWS_MARKETPLACE",
    allowedLinkedAccountIds: [MANAGEMENT, MEMBER],
    rowsExhausted: true,
    amountColumns: "BILLED_AND_AMORTIZED_SEPARATE",
    currencyHandling: "MULTI_CURRENCY_ROW_LEVEL",
  },
  approvedProductTypes: [{
    productId: "prod-001",
    type: "SOFTWARE",
    evidenceId: `fss_${"d".repeat(64)}`,
  }],
};
const JOB: RunnableJob = {
  id: `job_${"9".repeat(32)}`,
  orgId: SCOPE.organizationId,
  customerId: SCOPE.customerId,
  connectionId: SCOPE.connectionId,
  kind: MARKETPLACE_SPG_RUNTIME_JOB_KIND,
  payload: { scheduledWindow: WINDOW },
  attempt: 1,
  maxAttempts: 5,
};

function coverage(operation: AwsMarketplaceOperation) {
  return {
    operation,
    state: "SUCCEEDED" as const,
    recordCount: 0,
    pageCount: 1,
    failureCode: null,
  };
}

function captureFor(request: MarketplaceSpgRuntimeBrokerRequest): AwsMarketplaceSpgCapture {
  const operations: readonly AwsMarketplaceOperation[] = [
    ...AWS_MARKETPLACE_BUYER_API_OPERATIONS,
    "GetServiceSettings",
    "ListReceivedLicensesForOrganization",
    "ListReceivedGrantsForOrganization",
  ];
  return {
    schemaVersion: "sutra.aws-marketplace-spg.v1",
    scope: request.scope,
    captureId: request.expectedCaptureId,
    startedAt: "2026-08-02T00:04:00.000Z",
    completedAt: "2026-08-02T00:05:00.000Z",
    agreementRegion: request.endpoints.agreementRegion,
    discoveryRegion: request.endpoints.discoveryRegion,
    licenseManagerRegion: request.endpoints.licenseManagerRegion,
    agreementParty: request.buyerParty,
    agreementAccountCoverage: {
      basis: request.accountCoverage.basis,
      evidenceId: request.accountCoverage.evidenceGenerationId,
      observedAt: request.accountCoverage.observedAt,
      expectedAccountIds: request.accountCoverage.expectedAccountIds,
      capturedAgreementAccountIds: request.accountCoverage.expectedAccountIds,
    },
    licenseCollectionMode: "ORGANIZATION",
    licenseManagerSettings: {
      organizationIntegrationEnabled: true,
      crossAccountDiscoveryEnabled: true,
    },
    operationCoverage: operations.map(coverage),
    agreements: [],
    licenses: [],
    grants: [],
    cur2: {
      scope: request.scope,
      generationId: request.billing.generationId,
      sourceEvidenceId: request.billing.sourceEvidenceId,
      dataThroughAt: request.billing.dataThroughAt,
      reconciliationState: request.billing.reconciliationState,
      predicate: request.billing.predicate,
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
  snapshot: AwsMarketplaceSpgSnapshot,
): Promise<StoredAwsMarketplaceSpgSnapshot> {
  const contentSha256 = await sha256(JSON.stringify(snapshot));
  return {
    scope: SCOPE,
    generationId: `mspg_${contentSha256}`,
    contentSha256,
    snapshot,
    createdAtIso: snapshot.capturedAt,
    committedAtIso: snapshot.state === "READY" || snapshot.state === "EMPTY"
      ? snapshot.capturedAt : null,
  };
}

function expectCode(code: MarketplaceSpgRuntimeBindingError["code"]) {
  return (error: unknown): boolean => error instanceof MarketplaceSpgRuntimeBindingError
    && error.code === code
    && error.message === "Marketplace SPG runtime collection failed";
}

function dependencies(input?: {
  readonly boundary?: MarketplaceSpgServerBoundary | null;
  readonly broker?: MarketplaceSpgRuntimeDependencies["broker"];
  readonly mutateCapture?: (
    capture: AwsMarketplaceSpgCapture,
  ) => AwsMarketplaceSpgCapture;
  readonly forgedVerification?: boolean;
  readonly archiveHashMismatch?: boolean;
}) {
  const accepted = new Map<string, MarketplaceSpgAcceptedRuntimeAttempt>();
  const requests: MarketplaceSpgRuntimeBrokerRequest[] = [];
  const archives: Uint8Array[] = [];
  const failures: Array<{
    readonly code: MarketplaceSpgRuntimeFailureCode;
    readonly serialized: string;
  }> = [];
  let commits = 0;
  const runtime: MarketplaceSpgRuntimeDependencies = {
    now: () => NOW,
    loadBoundary: async () => input?.boundary === undefined ? BOUNDARY : input.boundary,
    broker: input?.broker === undefined ? {
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
            brokerKeyId: "marketplace-broker-v1",
          },
        };
      },
    } : input.broker,
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
        keyVersion: "marketplace-key-v1",
      }),
    },
    handoff: {
      getAccepted: async (_scope, requestId) => accepted.get(requestId) ?? null,
      commit: async (commit) => {
        commits += 1;
        const value: MarketplaceSpgAcceptedRuntimeAttempt = {
          requestId: commit.requestId,
          scheduledWindow: commit.scheduledWindow,
          sourceBoundarySha256: commit.sourceBoundarySha256,
          snapshot: await stored(commit.normalizedSnapshot),
          evidence: commit.evidence,
        };
        accepted.set(commit.requestId, value);
        return {
          accepted: value,
          becameActive: commit.normalizedSnapshot.state === "READY"
            || commit.normalizedSnapshot.state === "EMPTY",
        };
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

test("scheduler queues only a trusted connection identity and daily window", async () => {
  const queued: unknown[] = [];
  const result = await scheduleMarketplaceSpgCollections({
    scheduledWindow: WINDOW,
    loadEligibleScopes: async () => [SCOPE],
    queue: { enqueue: async (value) => { queued.push(value); } },
  });
  assert.deepEqual(result, { scheduledWindow: WINDOW, enqueued: 1 });
  assert.deepEqual(queued, [{
    orgId: SCOPE.organizationId,
    customerId: SCOPE.customerId,
    connectionId: SCOPE.connectionId,
    kind: MARKETPLACE_SPG_RUNTIME_JOB_KIND,
    payload: { scheduledWindow: WINDOW },
    maxAttempts: 5,
    idempotencyKey: `marketplace-spg:${SCOPE.organizationId}:${SCOPE.customerId}:${CONNECTION}:${encodeURIComponent(WINDOW)}`,
  }]);
  assert.equal(JSON.stringify(queued).includes(MEMBER), false);
  const rejectedQueue: unknown[] = [];
  await assert.rejects(scheduleMarketplaceSpgCollections({
    scheduledWindow: WINDOW,
    loadEligibleScopes: async () => [SCOPE, SCOPE],
    queue: { enqueue: async (value) => { rejectedQueue.push(value); } },
  }), expectCode("SCOPE_REJECTED"));
  assert.equal(rejectedQueue.length, 0);
});

test("runtime pins buyer/license reads, account coverage, CUR2, privacy and signed evidence", async () => {
  const context = dependencies();
  const result = await runMarketplaceSpgRuntimeHandler(JOB, context.runtime);
  assert.equal(result.status, "collected");
  if (result.status !== "collected") return;
  assert.equal(result.state, "EMPTY");
  assert.equal(result.becameActive, true);
  const request = context.requests[0];
  assert.ok(request);
  assert.deepEqual(request.buyerOperations, AWS_MARKETPLACE_BUYER_API_OPERATIONS);
  assert.deepEqual(request.licenseOperations,
    AWS_MARKETPLACE_LICENSE_MANAGER_API_OPERATIONS);
  assert.deepEqual(request.accountCoverageActions,
    AWS_MARKETPLACE_ACCOUNT_COVERAGE_IAM_ACTIONS);
  assert.deepEqual(request.pagination, {
    agreementPageSize: 50,
    licenseManagerPageSize: 100,
    maximumPagesPerSequence: 5_000,
    rejectTokenReplay: true,
    requireExhaustionEvidence: true,
  });
  assert.equal(request.maximumDurationMs, MARKETPLACE_SPG_RUNTIME_TIMEOUT_MS);
  assert.equal(request.archiveMaximumBytes, MARKETPLACE_SPG_RUNTIME_ARCHIVE_MAX_BYTES);
  assert.deepEqual(Object.values(request.privacy), [false, false, false, false, false, false]);
  assert.equal(request.billing.generationId, BOUNDARY.activeCur2.generationId);
  assert.equal(request.billing.manifestSha256, BOUNDARY.activeCur2.manifestSha256);

  const evidence = JSON.parse(new TextDecoder().decode(context.archives[0])) as {
    readonly sourceBoundary: MarketplaceSpgServerBoundary;
    readonly verification: { readonly authentication: string };
  };
  assert.equal(evidence.sourceBoundary.activeCur2.manifestSha256,
    BOUNDARY.activeCur2.manifestSha256);
  assert.equal(evidence.sourceBoundary.accountCoverage.evidenceGenerationId,
    BOUNDARY.accountCoverage.evidenceGenerationId);
  assert.equal(evidence.verification.authentication,
    "ED25519_RESPONSE_SIGNATURE_VERIFIED");
});

test("accepted at-least-once replay performs no second broker or evidence write", async () => {
  const context = dependencies();
  const first = await runMarketplaceSpgRuntimeHandler(JOB, context.runtime);
  const replay = await runMarketplaceSpgRuntimeHandler(JOB, context.runtime);
  assert.equal(first.status, "collected");
  assert.equal(replay.status, "collected");
  if (first.status !== "collected" || replay.status !== "collected") return;
  assert.equal(replay.replayed, true);
  assert.equal(replay.generationId, first.generationId);
  assert.equal(replay.evidenceGenerationId, first.evidenceGenerationId);
  assert.equal(context.requests.length, 1);
  assert.equal(context.archives.length, 1);
  assert.equal(context.commits(), 1);

  const accepted = context.accepted.get(context.requests[0]!.requestId);
  assert.ok(accepted);
  context.accepted.set(accepted.requestId, {
    ...accepted,
    snapshot: { ...accepted.snapshot, contentSha256: "0".repeat(64) },
  });
  await assert.rejects(
    runMarketplaceSpgRuntimeHandler(JOB, context.runtime),
    expectCode("PERSISTENCE_REJECTED"),
  );
});

test("missing server boundary and unregistered signed broker stay explicitly unavailable", async () => {
  const noBoundary = dependencies({ boundary: null });
  assert.deepEqual(await runMarketplaceSpgRuntimeHandler(JOB, noBoundary.runtime), {
    status: "unavailable",
    reason: MARKETPLACE_SPG_RUNTIME_ACTIVATION_REASONS.boundary,
  });
  const noBroker = dependencies({ broker: null });
  assert.deepEqual(await runMarketplaceSpgRuntimeHandler(JOB, noBroker.runtime), {
    status: "unavailable",
    reason: MARKETPLACE_SPG_RUNTIME_ACTIVATION_REASONS.adapter,
  });
  assert.equal(MARKETPLACE_SPG_RUNTIME_BINDING.registeredInSharedRuntime, false);
});

test("partial account coverage persists history without claiming an active complete head", async () => {
  const context = dependencies({
    mutateCapture: (capture) => ({
      ...capture,
      agreementAccountCoverage: {
        ...capture.agreementAccountCoverage,
        capturedAgreementAccountIds: [MANAGEMENT],
      },
    }),
  });
  const result = await runMarketplaceSpgRuntimeHandler(JOB, context.runtime);
  assert.equal(result.status, "collected");
  if (result.status !== "collected") return;
  assert.equal(result.state, "PARTIAL");
  assert.equal(result.becameActive, false);
});

test("boundary, signed response, CUR2 substitution and raw provider failures fail closed", async () => {
  const extraBoundary = {
    ...BOUNDARY,
    privateOfferClassification: "PRIVATE",
  } as unknown as MarketplaceSpgServerBoundary;
  await assert.rejects(
    runMarketplaceSpgRuntimeHandler(JOB, dependencies({ boundary: extraBoundary }).runtime),
    expectCode("BOUNDARY_REJECTED"),
  );

  const forged = dependencies({ forgedVerification: true });
  await assert.rejects(runMarketplaceSpgRuntimeHandler(JOB, forged.runtime),
    expectCode("BROKER_AUTHENTICATION_FAILED"));
  assert.equal(forged.archives.length, 0);

  const substituted = dependencies({
    mutateCapture: (capture) => ({
      ...capture,
      cur2: capture.cur2 === null ? null : {
        ...capture.cur2,
        generationId: `fbg_${"9".repeat(64)}`,
      },
    }),
  });
  await assert.rejects(runMarketplaceSpgRuntimeHandler(JOB, substituted.runtime),
    expectCode("CAPTURE_REJECTED"));
  assert.equal(substituted.archives.length, 0);

  const raw = "AccessDenied arn:aws:iam::111122223333:role/private";
  const failed = dependencies({
    broker: { collect: async () => { throw new Error(raw); } },
  });
  await assert.rejects(runMarketplaceSpgRuntimeHandler(JOB, failed.runtime),
    (error: unknown) => expectCode("BROKER_UNAVAILABLE")(error)
      && !(error as Error).message.includes(raw));
  assert.deepEqual(failed.failures.map((failure) => failure.code), [
    "BROKER_UNAVAILABLE",
  ]);
  assert.equal(failed.failures.some((failure) =>
    failure.serialized.includes("AccessDenied")), false);
});
