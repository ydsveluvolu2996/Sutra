import assert from "node:assert/strict";
import test from "node:test";
import type {
  StoredFinopsSourceSnapshot,
} from "../db/finops-source-snapshot-repository.ts";
import type {
  FinopsSourceJobAttempt,
  FinopsSourceJobStatus,
} from "../db/finops-source-job-ledger-repository.ts";
import {
  FINOPS_SOURCE_DEFINITIONS,
  buildFinopsSourceReadiness,
  type FinopsSourceEvidence,
  type FinopsSourceId,
} from "../lib/finops-source-health.ts";
import {
  StoredFinopsSourceEvidenceError,
  buildStoredFinopsSourceEvidence,
} from "../lib/finops-source-snapshot-evidence.ts";

const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const SCOPE = {
  orgId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: `conn_${"a".repeat(32)}`,
};
const STORED_SCOPE = {
  organizationId: SCOPE.orgId,
  customerId: SCOPE.customerId,
  connectionId: SCOPE.connectionId,
};

function snapshot(
  sourceId: FinopsSourceId,
  overrides: Partial<StoredFinopsSourceSnapshot> = {},
): StoredFinopsSourceSnapshot {
  const generationId = `fss_${"a".repeat(64)}`;
  return {
    scope: STORED_SCOPE,
    sourceId,
    generationId,
    activeGenerationId: generationId,
    jobId: `job-${sourceId}`,
    attempt: 1,
    status: "complete",
    contentSha256: "b".repeat(64),
    schemaVersion: "source-v1",
    collectedAtIso: "2026-07-31T10:00:00.000Z",
    dataThroughAtIso: "2026-07-31T09:00:00.000Z",
    committedAtIso: "2026-07-31T10:01:00.000Z",
    coverage: {
      assessment: "complete",
      expected: 100,
      observed: 100,
      missing: 0,
    },
    reconciliation: {
      expected: 100,
      accepted: 100,
      rejected: 0,
      outcome: "matched",
    },
    evidenceReference: {
      ciphertext: `fsev1.${"PRIVATE_CIPHERTEXT".repeat(3)}`,
      keyVersion: "private-key-v1",
    },
    createdAtIso: "2026-07-31T10:01:00.000Z",
    ...overrides,
  };
}

function attempt(
  sourceId: FinopsSourceId,
  status: FinopsSourceJobStatus,
  overrides: Partial<FinopsSourceJobAttempt> = {},
): FinopsSourceJobAttempt {
  const terminal = status !== "queued" && status !== "running";
  const failed = status === "failed";
  const partial = status === "partial";
  const cancelled = status === "cancelled";
  return {
    scope: STORED_SCOPE,
    sourceId,
    jobId: `new-job-${sourceId}`,
    attempt: 2,
    idempotencyKey: `new-attempt-${sourceId}`,
    status,
    queuedAtIso: "2026-07-31T11:00:00.000Z",
    startedAtIso: status === "queued"
      ? null
      : "2026-07-31T11:01:00.000Z",
    finishedAtIso: terminal
      ? "2026-07-31T11:02:00.000Z"
      : null,
    acceptedRecords: terminal ? (partial ? 80 : failed || cancelled ? 0 : 100) : null,
    rejectedRecords: terminal ? (partial ? 20 : failed || cancelled ? 1 : 0) : null,
    expectedRecords: terminal ? 100 : null,
    processedBytes: terminal ? 4_096 : null,
    reconciliation: terminal
      ? {
          outcome: status === "succeeded" ? "matched" : "mismatched",
          evidenceReference: "raw-provider://private/evidence/object",
        }
      : null,
    error: failed || cancelled
      ? {
          code: cancelled ? "CANCELLED" : "TIMEOUT",
          message: "AccessKeyId=raw-provider-secret-detail",
        }
      : null,
    queueWaitMs: status === "queued" ? null : 60_000,
    durationMs: terminal ? 60_000 : null,
    totalDurationMs: terminal ? 120_000 : null,
    createdAt: NOW,
    ...overrides,
  };
}

function stateFor(input: {
  readonly snapshots?: readonly StoredFinopsSourceSnapshot[];
  readonly attempts?: readonly FinopsSourceJobAttempt[];
  readonly baseline?: readonly FinopsSourceEvidence[];
  readonly nowMs?: number;
}): ReturnType<typeof buildFinopsSourceReadiness>["sources"][number] {
  const evidence = buildStoredFinopsSourceEvidence({
    scope: SCOPE,
    baselineEvidence: input.baseline ?? [],
    activeSnapshots: input.snapshots ?? [],
    latestAttempts: input.attempts ?? [],
  });
  const report = buildFinopsSourceReadiness({
    scope: SCOPE,
    evidence,
    nowMs: input.nowMs ?? NOW,
  });
  const source = report.sources.find(
    (entry) => entry.id === "aws_budgets",
  );
  assert.ok(source);
  return source;
}

test("immutable snapshots and latest attempts project every source-health state", () => {
  assert.equal(stateFor({}).state, "not_configured");
  assert.equal(stateFor({
    attempts: [attempt("aws_budgets", "queued")],
  }).state, "waiting_first_delivery");
  assert.equal(stateFor({
    snapshots: [snapshot("aws_budgets")],
  }).state, "healthy");
  assert.equal(stateFor({
    snapshots: [snapshot("aws_budgets", {
      collectedAtIso: "2026-07-27T10:00:00.000Z",
      dataThroughAtIso: "2026-07-27T09:00:00.000Z",
      committedAtIso: "2026-07-27T10:01:00.000Z",
    })],
  }).state, "stale");
  assert.equal(stateFor({
    snapshots: [snapshot("aws_budgets")],
    attempts: [attempt("aws_budgets", "partial")],
  }).state, "partial");
  assert.equal(stateFor({
    snapshots: [snapshot("aws_budgets")],
    attempts: [attempt("aws_budgets", "failed")],
  }).state, "failed");
});

test("new partial and failed attempts update public attempt state without replacing the accepted delivery", () => {
  const partial = stateFor({
    snapshots: [snapshot("aws_budgets")],
    attempts: [attempt("aws_budgets", "partial")],
  });
  assert.equal(partial.freshness.lastSuccessAt, "2026-07-31T10:01:00.000Z");
  assert.equal(partial.freshness.dataThroughAt, "2026-07-31T09:00:00.000Z");
  assert.equal(partial.lastAttemptAt, "2026-07-31T11:02:00.000Z");
  assert.equal(partial.lastAttemptOutcome, "partial");
  assert.deepEqual(partial.coverage, {
    assessment: "partial",
    acceptedRecords: 80,
    expectedRecords: 100,
    rejectedRecords: 20,
    percent: 80,
  });
  assert.deepEqual(partial.lastError, {
    code: "PARTIAL_COLLECTION",
    message: "The latest collection completed with partial coverage.",
    at: "2026-07-31T11:02:00.000Z",
  });

  const failed = stateFor({
    snapshots: [snapshot("aws_budgets")],
    attempts: [attempt("aws_budgets", "failed")],
  });
  assert.equal(failed.freshness.lastSuccessAt, "2026-07-31T10:01:00.000Z");
  assert.deepEqual(failed.lastError, {
    code: "TIMEOUT",
    message: "Collection exceeded its bounded execution window.",
    at: "2026-07-31T11:02:00.000Z",
  });
});

test("an attempt that predates the active snapshot commit cannot override that accepted delivery", () => {
  const source = stateFor({
    snapshots: [snapshot("aws_budgets", {
      committedAtIso: "2026-07-31T11:30:00.000Z",
    })],
    attempts: [attempt("aws_budgets", "failed")],
  });
  assert.equal(source.state, "healthy");
  assert.equal(source.lastAttemptOutcome, "succeeded");
  assert.equal(source.lastAttemptAt, "2026-07-31T10:00:00.000Z");
  assert.equal(source.freshness.lastSuccessAt, "2026-07-31T11:30:00.000Z");
  assert.equal(source.lastError, null);
});

test("source data-through freshness never suppresses a newer operational failure", () => {
  const baseline: FinopsSourceEvidence = {
    scope: SCOPE,
    sourceId: "aws_budgets",
    configured: true,
    deliveryObserved: true,
    lastAttemptAt: "2026-07-31T10:00:00.000Z",
    lastAttemptOutcome: "succeeded",
    lastSuccessAt: "2026-07-31T10:01:00.000Z",
    dataThroughAt: "2026-07-31T11:45:00.000Z",
    coverage: {
      assessment: "complete",
      acceptedRecords: 100,
      expectedRecords: 100,
      rejectedRecords: 0,
    },
    lastError: null,
    evidenceBasis: "Existing accepted source evidence.",
  };
  const source = stateFor({
    baseline: [baseline],
    attempts: [attempt("aws_budgets", "failed")],
  });
  assert.equal(source.state, "failed");
  assert.equal(source.lastAttemptAt, "2026-07-31T11:02:00.000Z");
  assert.equal(source.freshness.lastSuccessAt, "2026-07-31T10:01:00.000Z");
  assert.equal(source.freshness.dataThroughAt, "2026-07-31T11:45:00.000Z");
});

test("the adapter projects all 25 registered sources from active immutable metadata", () => {
  const activeSnapshots = FINOPS_SOURCE_DEFINITIONS.map((source, index) => {
    const generationId = `fss_${index.toString(16).padStart(64, "0")}`;
    return snapshot(source.id, {
      generationId,
      activeGenerationId: generationId,
      jobId: `source-${index}`,
    });
  });
  const evidence = buildStoredFinopsSourceEvidence({
    scope: SCOPE,
    baselineEvidence: [],
    activeSnapshots,
    latestAttempts: [],
  });
  const report = buildFinopsSourceReadiness({
    scope: SCOPE,
    evidence,
    nowMs: NOW,
  });
  assert.equal(FINOPS_SOURCE_DEFINITIONS.length, 25);
  assert.equal(evidence.length, 25);
  assert.equal(report.sources.length, 25);
  assert.equal(report.summary.sources.healthy, 25);
});

test("foreign tenant metadata fails closed and private evidence never reaches health output", () => {
  assert.throws(
    () => buildStoredFinopsSourceEvidence({
      scope: SCOPE,
      baselineEvidence: [],
      activeSnapshots: [snapshot("aws_budgets", {
        scope: { ...STORED_SCOPE, customerId: "customer_attacker" },
      })],
      latestAttempts: [],
    }),
    (error) => error instanceof StoredFinopsSourceEvidenceError
      && error.code === "SCOPE_MISMATCH",
  );
  assert.throws(
    () => buildStoredFinopsSourceEvidence({
      scope: SCOPE,
      baselineEvidence: [],
      activeSnapshots: [],
      latestAttempts: [attempt("aws_budgets", "failed", {
        scope: { ...STORED_SCOPE, organizationId: "org_attacker" },
      })],
    }),
    (error) => error instanceof StoredFinopsSourceEvidenceError
      && error.code === "SCOPE_MISMATCH",
  );

  const rawProviderAttempt = {
    ...attempt("aws_budgets", "failed"),
    error: {
      code: "RAW_PROVIDER_CODE",
      message: "AccessKeyId=raw-provider-secret-detail",
    },
  } as unknown as FinopsSourceJobAttempt;
  const output = stateFor({
    snapshots: [snapshot("aws_budgets")],
    attempts: [rawProviderAttempt],
  });
  const serialized = JSON.stringify(output);
  assert.equal(output.lastError?.code, "INTERNAL_ERROR");
  assert.equal(
    output.lastError?.message,
    "Collection failed because of an internal processing error.",
  );
  assert.doesNotMatch(
    serialized,
    /PRIVATE_CIPHERTEXT|private-key|raw-provider|RAW_PROVIDER_CODE|AccessKeyId|secret-detail/u,
  );
});
