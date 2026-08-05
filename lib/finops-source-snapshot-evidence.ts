import type {
  StoredFinopsSourceSnapshot,
} from "../db/finops-source-snapshot-repository.ts";
import type {
  FinopsSourceJobAttempt,
  FinopsSourceJobErrorCode,
} from "../db/finops-source-job-ledger-repository.ts";
import {
  FINOPS_SOURCE_DEFINITIONS,
  type FinopsSourceAttemptOutcome,
  type FinopsSourceEvidence,
  type FinopsSourceId,
  type FinopsSourceScope,
} from "./finops-source-health.ts";

const SOURCE_IDS = new Set<FinopsSourceId>(
  FINOPS_SOURCE_DEFINITIONS.map((source) => source.id),
);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;

const GENERIC_ERROR_MESSAGES: Readonly<
  Record<FinopsSourceJobErrorCode, string>
> = {
  AUTHORIZATION_FAILED: "Collection authorization was rejected.",
  SOURCE_UNAVAILABLE: "The configured collection source was unavailable.",
  THROTTLED: "Collection was delayed by a bounded service quota.",
  TIMEOUT: "Collection exceeded its bounded execution window.",
  SCHEMA_MISMATCH: "Collected data did not match the accepted schema.",
  RECONCILIATION_FAILED: "Collected data did not pass reconciliation.",
  CANCELLED: "Collection was cancelled.",
  INTERNAL_ERROR: "Collection failed because of an internal processing error.",
};
const ERROR_CODES = new Set<FinopsSourceJobErrorCode>(
  Object.keys(GENERIC_ERROR_MESSAGES) as FinopsSourceJobErrorCode[],
);

const SNAPSHOT_BASIS =
  "Immutable active FinOps source snapshot metadata.";
const ATTEMPT_BASIS =
  "Durable FinOps source job-attempt ledger metadata.";
const NO_REPLACEMENT_LIMITATION =
  "The latest collection attempt did not replace the last accepted immutable delivery.";
const PENDING_ACCEPTANCE_LIMITATION =
  "The latest successful collection attempt has not produced a newer accepted immutable delivery.";

export interface StoredFinopsSourceEvidenceInput {
  readonly scope: FinopsSourceScope;
  readonly baselineEvidence: readonly FinopsSourceEvidence[];
  readonly activeSnapshots: readonly StoredFinopsSourceSnapshot[];
  readonly latestAttempts: readonly FinopsSourceJobAttempt[];
}

export class StoredFinopsSourceEvidenceError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "SCOPE_MISMATCH"
    | "LIMIT_EXCEEDED";

  public constructor(code: StoredFinopsSourceEvidenceError["code"]) {
    super("Stored FinOps source evidence rejected");
    this.name = "StoredFinopsSourceEvidenceError";
    this.code = code;
  }
}

function reject(
  code: StoredFinopsSourceEvidenceError["code"] = "INVALID_INPUT",
): never {
  throw new StoredFinopsSourceEvidenceError(code);
}

function validIso(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function sameScope(
  scope: FinopsSourceScope,
  candidate: {
    readonly organizationId: string;
    readonly customerId: string;
    readonly connectionId: string;
  },
): boolean {
  return scope.orgId === candidate.organizationId
    && scope.customerId === candidate.customerId
    && scope.connectionId === candidate.connectionId;
}

function sameEvidenceScope(
  scope: FinopsSourceScope,
  candidate: FinopsSourceScope,
): boolean {
  return scope.orgId === candidate.orgId
    && scope.customerId === candidate.customerId
    && scope.connectionId === candidate.connectionId;
}

function safeCount(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) reject();
  return value;
}

function attemptAt(attempt: FinopsSourceJobAttempt): string {
  const value = attempt.finishedAtIso
    ?? attempt.startedAtIso
    ?? attempt.queuedAtIso;
  if (!validIso(value)) reject();
  return value;
}

function attemptOutcome(
  attempt: FinopsSourceJobAttempt,
): FinopsSourceAttemptOutcome {
  if (attempt.status === "succeeded") return "succeeded";
  if (attempt.status === "partial") return "partial";
  if (attempt.status === "failed" || attempt.status === "cancelled") {
    return "failed";
  }
  return "in_progress";
}

function newestEvidenceTime(evidence: FinopsSourceEvidence): number {
  return Math.max(
    evidence.dataThroughAt === null ? -1 : Date.parse(evidence.dataThroughAt),
    evidence.lastSuccessAt === null ? -1 : Date.parse(evidence.lastSuccessAt),
    evidence.lastAttemptAt === null ? -1 : Date.parse(evidence.lastAttemptAt),
  );
}

function newestAcceptedEventTime(evidence: FinopsSourceEvidence): number {
  return Math.max(
    evidence.lastSuccessAt === null ? -1 : Date.parse(evidence.lastSuccessAt),
    evidence.lastAttemptAt === null ? -1 : Date.parse(evidence.lastAttemptAt),
  );
}

function snapshotEvidence(
  scope: FinopsSourceScope,
  snapshot: StoredFinopsSourceSnapshot,
): FinopsSourceEvidence {
  if (
    snapshot.activeGenerationId !== snapshot.generationId
    || (snapshot.status !== "ready" && snapshot.status !== "complete")
    || snapshot.coverage.assessment !== "complete"
    || snapshot.reconciliation.outcome !== "matched"
    || snapshot.reconciliation.rejected !== 0
    || (
      snapshot.reconciliation.expected !== null
      && snapshot.reconciliation.accepted
        !== snapshot.reconciliation.expected
    )
    || !validIso(snapshot.collectedAtIso)
    || !validIso(snapshot.dataThroughAtIso)
    || !validIso(snapshot.committedAtIso)
  ) reject();
  const acceptedRecords = safeCount(snapshot.reconciliation.accepted);
  const expectedRecords = safeCount(snapshot.reconciliation.expected);
  const rejectedRecords = safeCount(snapshot.reconciliation.rejected);
  return {
    scope: { ...scope },
    sourceId: snapshot.sourceId,
    configured: true,
    deliveryObserved: true,
    lastAttemptAt: snapshot.collectedAtIso,
    lastAttemptOutcome: "succeeded",
    lastSuccessAt: snapshot.committedAtIso,
    dataThroughAt: snapshot.dataThroughAtIso,
    coverage: {
      assessment: "complete",
      acceptedRecords,
      expectedRecords,
      rejectedRecords,
    },
    lastError: null,
    evidenceBasis: SNAPSHOT_BASIS,
    limitations: [
      "Snapshot coverage proves accepted collection and reconciliation, not invoice correctness outside the source contract.",
    ],
  };
}

function coverageFromAttempt(
  attempt: FinopsSourceJobAttempt,
): FinopsSourceEvidence["coverage"] {
  const acceptedRecords = safeCount(attempt.acceptedRecords);
  const expectedRecords = safeCount(attempt.expectedRecords);
  const rejectedRecords = safeCount(attempt.rejectedRecords);
  const complete = attempt.status === "succeeded"
    && rejectedRecords !== null
    && rejectedRecords === 0
    && (
      expectedRecords === null
      || acceptedRecords !== null && acceptedRecords === expectedRecords
    );
  const partial = attempt.status === "partial"
    || attempt.status === "failed"
    || attempt.status === "cancelled";
  return {
    assessment: complete ? "complete" : partial ? "partial" : "unknown",
    acceptedRecords,
    expectedRecords,
    rejectedRecords,
  };
}

function genericAttemptError(
  attempt: FinopsSourceJobAttempt,
  at: string,
): FinopsSourceEvidence["lastError"] {
  if (attempt.status === "partial") {
    return {
      code: "PARTIAL_COLLECTION",
      message: "The latest collection completed with partial coverage.",
      at,
    };
  }
  if (attempt.status !== "failed" && attempt.status !== "cancelled") {
    return null;
  }
  const code = attempt.status === "cancelled"
    ? "CANCELLED"
    : attempt.error !== null && ERROR_CODES.has(attempt.error.code)
      ? attempt.error.code
      : "INTERNAL_ERROR";
  return {
    code,
    message: GENERIC_ERROR_MESSAGES[code],
    at,
  };
}

function evidenceWithAttempt(
  scope: FinopsSourceScope,
  accepted: FinopsSourceEvidence | null,
  acceptedSnapshot: StoredFinopsSourceSnapshot | null,
  attempt: FinopsSourceJobAttempt,
): FinopsSourceEvidence {
  const at = attemptAt(attempt);
  const representedByActiveSnapshot = acceptedSnapshot !== null
    && acceptedSnapshot.jobId === attempt.jobId
    && acceptedSnapshot.attempt === attempt.attempt;
  const acceptedEventAt = accepted === null
    ? -1
    : newestAcceptedEventTime(accepted);
  const newerAttempt = accepted === null
    || (!representedByActiveSnapshot && Date.parse(at) > acceptedEventAt);
  if (!newerAttempt && accepted !== null) return accepted;

  const outcome = attemptOutcome(attempt);
  const failureOrPartial = outcome === "failed" || outcome === "partial";
  const basis = accepted === null
    ? ATTEMPT_BASIS
    : `${accepted.evidenceBasis} ${ATTEMPT_BASIS}`;
  const limitations = [
    ...(accepted?.limitations ?? []),
    ...(failureOrPartial && accepted !== null
      ? [NO_REPLACEMENT_LIMITATION]
      : []),
    ...(outcome === "succeeded"
      ? [PENDING_ACCEPTANCE_LIMITATION]
      : []),
  ];
  return {
    scope: { ...scope },
    sourceId: attempt.sourceId,
    configured: true,
    deliveryObserved: accepted?.deliveryObserved ?? false,
    lastAttemptAt: at,
    lastAttemptOutcome: outcome,
    lastSuccessAt: accepted?.lastSuccessAt ?? null,
    dataThroughAt: accepted?.dataThroughAt ?? null,
    coverage: failureOrPartial
      ? coverageFromAttempt(attempt)
      : accepted?.coverage ?? coverageFromAttempt(attempt),
    lastError: genericAttemptError(attempt, at),
    evidenceBasis: basis,
    limitations,
  };
}

function acceptedEvidence(
  baseline: FinopsSourceEvidence | null,
  snapshot: FinopsSourceEvidence | null,
): FinopsSourceEvidence | null {
  if (baseline === null) return snapshot;
  if (snapshot === null) return baseline;
  return newestEvidenceTime(snapshot) > newestEvidenceTime(baseline)
    ? snapshot
    : baseline;
}

/**
 * Merges public health metadata only. Encrypted evidence references,
 * reconciliation references, provider payloads, hashes, and raw provider
 * errors are deliberately neither read nor copied into the result.
 */
export function buildStoredFinopsSourceEvidence(
  input: StoredFinopsSourceEvidenceInput,
): readonly FinopsSourceEvidence[] {
  if (
    input === null
    || typeof input !== "object"
    || input.scope === null
    || typeof input.scope !== "object"
    || !IDENTIFIER.test(input.scope.orgId)
    || !IDENTIFIER.test(input.scope.customerId)
    || !CONNECTION_ID.test(input.scope.connectionId)
    || !Array.isArray(input.baselineEvidence)
    || !Array.isArray(input.activeSnapshots)
    || !Array.isArray(input.latestAttempts)
  ) reject();
  if (
    input.baselineEvidence.length > FINOPS_SOURCE_DEFINITIONS.length
    || input.activeSnapshots.length > FINOPS_SOURCE_DEFINITIONS.length
    || input.latestAttempts.length > FINOPS_SOURCE_DEFINITIONS.length
  ) reject("LIMIT_EXCEEDED");

  const baselineBySource = new Map<FinopsSourceId, FinopsSourceEvidence>();
  for (const evidence of input.baselineEvidence) {
    if (!SOURCE_IDS.has(evidence.sourceId)) reject();
    if (!sameEvidenceScope(input.scope, evidence.scope)) {
      reject("SCOPE_MISMATCH");
    }
    if (baselineBySource.has(evidence.sourceId)) reject();
    baselineBySource.set(evidence.sourceId, evidence);
  }

  const snapshotBySource = new Map<
    FinopsSourceId,
    { readonly stored: StoredFinopsSourceSnapshot; readonly evidence: FinopsSourceEvidence }
  >();
  for (const snapshot of input.activeSnapshots) {
    if (!SOURCE_IDS.has(snapshot.sourceId)) reject();
    if (!sameScope(input.scope, snapshot.scope)) reject("SCOPE_MISMATCH");
    if (snapshotBySource.has(snapshot.sourceId)) reject();
    snapshotBySource.set(snapshot.sourceId, {
      stored: snapshot,
      evidence: snapshotEvidence(input.scope, snapshot),
    });
  }

  const attemptBySource = new Map<FinopsSourceId, FinopsSourceJobAttempt>();
  for (const attempt of input.latestAttempts) {
    if (!SOURCE_IDS.has(attempt.sourceId)) reject();
    if (!sameScope(input.scope, attempt.scope)) reject("SCOPE_MISMATCH");
    if (attemptBySource.has(attempt.sourceId)) reject();
    attemptBySource.set(attempt.sourceId, attempt);
  }

  const evidence: FinopsSourceEvidence[] = [];
  for (const source of FINOPS_SOURCE_DEFINITIONS) {
    const baseline = baselineBySource.get(source.id) ?? null;
    const snapshot = snapshotBySource.get(source.id) ?? null;
    const accepted = acceptedEvidence(baseline, snapshot?.evidence ?? null);
    const attempt = attemptBySource.get(source.id);
    if (attempt !== undefined) {
      evidence.push(evidenceWithAttempt(
        input.scope,
        accepted,
        accepted === snapshot?.evidence ? snapshot.stored : null,
        attempt,
      ));
    } else if (accepted !== null) {
      evidence.push(accepted);
    }
  }
  return evidence;
}
