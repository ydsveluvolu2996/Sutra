/**
 * Durable app-side orchestration for one server-owned FinOps source contract.
 *
 * The background payload contains identities only. AWS operations, endpoints,
 * ARNs, account ids, regions, credentials, and filters are resolved by the
 * authenticated collector from its encrypted registry and compiled catalog.
 */
import type { RunnableJob } from "./background-job-runner.ts";
import {
  PilotServerError,
  type FinopsSourceCollectionResult,
} from "./pilot-server.ts";
import {
  FINOPS_SOURCE_DEFINITIONS,
  type FinopsSourceId,
} from "./finops-source-health.ts";
import type { PilotConnection } from "./pilot-types.ts";
import type { FinopsEvidenceReferenceSealer } from "./finops-source-evidence-reference.ts";
import type {
  FinopsSourceJobErrorCode,
  FinopsSourceJobIdentity,
  FinopsSourceJobLedgerRepository,
  FinopsSourceJobScope,
} from "../db/finops-source-job-ledger-repository.ts";
import type { EvidenceRepository } from "../db/evidence-repository.ts";
import type { FinopsSourceSnapshotRepository } from "../db/finops-source-snapshot-repository.ts";

export const FINOPS_SOURCE_COLLECT_JOB_KIND = "finops-source-collect";
export const FINOPS_SOURCE_COLLECT_ACTOR_ID = "system_finops_source_collect";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const SOURCE_IDS = new Set<FinopsSourceId>(
  FINOPS_SOURCE_DEFINITIONS.map((definition) => definition.id),
);

export interface FinopsSourceCollectJobPayload {
  readonly connectionId: string;
  readonly sourceId: FinopsSourceId;
  readonly contractId: string;
}

export interface FinopsSourceCollectJobDependencies {
  readonly getConnection: (
    organizationId: string,
    connectionId: string,
  ) => Promise<PilotConnection | null>;
  readonly collect: (input: {
    readonly tenantId: string;
    readonly connectionId: string;
    readonly jobId: string;
    readonly contractId: string;
    readonly sourceId: FinopsSourceId;
    readonly accountId: string;
    readonly partition: PilotConnection["partition"];
  }) => Promise<FinopsSourceCollectionResult>;
  readonly ledger: Pick<
    FinopsSourceJobLedgerRepository,
    "queueAttempt" | "startAttempt" | "finishAttempt"
  >;
  readonly evidence: Pick<EvidenceRepository, "archive">;
  readonly snapshots: Pick<FinopsSourceSnapshotRepository, "recordSnapshot">;
  readonly evidenceReferenceSealer: Pick<FinopsEvidenceReferenceSealer, "seal">;
  readonly now?: () => number;
}

export class FinopsSourceCollectJobError extends Error {
  public readonly code:
    | "INVALID_JOB"
    | "INVALID_SCOPE"
    | "CONNECTION_NOT_RUNNABLE"
    | "COLLECTION_REJECTED";

  public constructor(code: FinopsSourceCollectJobError["code"]) {
    super("FinOps source collection job rejected");
    this.name = "FinopsSourceCollectJobError";
    this.code = code;
  }
}

function reject(code: FinopsSourceCollectJobError["code"]): never {
  throw new FinopsSourceCollectJobError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePayload(value: unknown): FinopsSourceCollectJobPayload {
  if (!isRecord(value)) reject("INVALID_JOB");
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    keys.some((key) => !["connectionId", "sourceId", "contractId"].includes(key)) ||
    typeof value.connectionId !== "string" || !CONNECTION_ID.test(value.connectionId) ||
    typeof value.sourceId !== "string" || !SOURCE_IDS.has(value.sourceId as FinopsSourceId) ||
    typeof value.contractId !== "string" || !IDENTIFIER.test(value.contractId)
  ) reject("INVALID_JOB");
  return value as unknown as FinopsSourceCollectJobPayload;
}

function scopeFor(
  job: RunnableJob,
  payload: FinopsSourceCollectJobPayload,
): FinopsSourceJobScope {
  if (
    job.kind !== FINOPS_SOURCE_COLLECT_JOB_KIND ||
    job.customerId === null ||
    job.connectionId === null ||
    job.connectionId !== payload.connectionId ||
    !IDENTIFIER.test(job.orgId) ||
    !IDENTIFIER.test(job.customerId) ||
    !CONNECTION_ID.test(job.connectionId) ||
    !IDENTIFIER.test(job.id) ||
    !Number.isSafeInteger(job.attempt) || job.attempt < 1 || job.attempt > 100
  ) reject("INVALID_SCOPE");
  return {
    organizationId: job.orgId,
    customerId: job.customerId,
    connectionId: job.connectionId,
  };
}

function iso(now: () => number): string {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) reject("INVALID_JOB");
  return new Date(value).toISOString();
}

function safeCountSum(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) reject("COLLECTION_REJECTED");
  return total;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) =>
    `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function minimizedEvidence(result: FinopsSourceCollectionResult): Uint8Array {
  // Deliberately omit tenant aliases, connection identity, job identity,
  // provider error strings, and free-form limitations. Scope and attempt
  // lineage remain in the repositories; this object holds evidence only.
  return new TextEncoder().encode(canonicalJson({
    schemaVersion: "sutra.finops-source-evidence.v1",
    sourceId: result.sourceId,
    contractId: result.contractId,
    accountId: result.accountId,
    partition: result.partition,
    region: result.region,
    collectedAt: result.collectedAt,
    dataThroughAt: result.dataThroughAt,
    coverage: result.coverage,
    evidence: result.evidence,
  }));
}

export function genericFinopsSourceErrorCode(error: unknown): FinopsSourceJobErrorCode {
  const code = error instanceof PilotServerError ? error.code : null;
  if (new Set([
    "ASSUME_ROLE_DENIED",
    "ASSUME_ROLE_FAILED",
    "CALLER_IDENTITY_MISMATCH",
    "NEGATIVE_PROBE_INCONCLUSIVE",
    "PERMISSION_DENIED",
    "TRUST_POLICY_UNSAFE",
  ]).has(code ?? "")) return "AUTHORIZATION_FAILED";
  if (code === "THROTTLED") return "THROTTLED";
  if (code === "BROKER_RESPONSE_INVALID") return "SCHEMA_MISMATCH";
  if (code === "BROKER_UNAVAILABLE" || code === "CONNECTION_NOT_FOUND") {
    return "SOURCE_UNAVAILABLE";
  }
  return "INTERNAL_ERROR";
}

function genericResultErrorCode(result: FinopsSourceCollectionResult): FinopsSourceJobErrorCode {
  const code = result.errorCode;
  if (code === "TIMEOUT") return "TIMEOUT";
  if (code === "TEMPORARILY_UNAVAILABLE" || code === "THROTTLED") return "THROTTLED";
  if (new Set([
    "ACCESS_DENIED",
    "ASSUME_ROLE_DENIED",
    "PERMISSION_DENIED",
  ]).has(code ?? "")) return "AUTHORIZATION_FAILED";
  if (new Set([
    "DATA_UNAVAILABLE",
    "SOURCE_NOT_CONFIGURED",
    "SOURCE_ADAPTER_NOT_IMPLEMENTED",
    "COLLECTION_FAILED",
  ]).has(code ?? "")) return "SOURCE_UNAVAILABLE";
  if (new Set([
    "OUTPUT_SIZE_LIMIT_REACHED",
    "SOURCE_COVERAGE_INCOMPLETE",
  ]).has(code ?? "")) return "RECONCILIATION_FAILED";
  return "INTERNAL_ERROR";
}

function identityFor(
  payload: FinopsSourceCollectJobPayload,
  job: RunnableJob,
): FinopsSourceJobIdentity {
  return {
    sourceId: payload.sourceId,
    jobId: job.id,
    attempt: job.attempt,
  };
}

/** Runs one at-least-once durable collection attempt. */
export async function runFinopsSourceCollectJob(
  job: RunnableJob,
  dependencies: FinopsSourceCollectJobDependencies,
): Promise<void> {
  const payload = parsePayload(job.payload);
  const scope = scopeFor(job, payload);
  const connection = await dependencies.getConnection(
    scope.organizationId,
    scope.connectionId,
  );
  if (
    connection === null ||
    connection.id !== scope.connectionId ||
    connection.customerId !== scope.customerId ||
    connection.sourceKind !== "aws_trust_role" ||
    connection.status !== "active" ||
    connection.roleArn === null
  ) reject("CONNECTION_NOT_RUNNABLE");

  const now = dependencies.now ?? Date.now;
  const identity = identityFor(payload, job);
  let started = false;
  let terminal = false;
  await dependencies.ledger.queueAttempt(scope, {
    ...identity,
    idempotencyKey: `${job.id}:${job.attempt}`,
    queuedAtIso: iso(now),
  });
  await dependencies.ledger.startAttempt(scope, identity, iso(now));
  started = true;

  try {
    const result = await dependencies.collect({
      tenantId: scope.organizationId,
      connectionId: scope.connectionId,
      jobId: job.id,
      contractId: payload.contractId,
      sourceId: payload.sourceId,
      accountId: connection.awsAccountId,
      partition: connection.partition,
    });
    if (
      result.tenantId !== scope.organizationId ||
      result.connectionId !== scope.connectionId ||
      result.jobId !== job.id ||
      result.contractId !== payload.contractId ||
      result.sourceId !== payload.sourceId ||
      result.accountId !== connection.awsAccountId ||
      result.partition !== connection.partition
    ) reject("COLLECTION_REJECTED");
    if (result.collectionStatus === "UNAVAILABLE" || result.evidence === null) {
      await dependencies.ledger.finishAttempt(scope, identity, {
        status: "failed",
        finishedAtIso: iso(now),
        acceptedRecords: result.coverage.recordsAccepted,
        rejectedRecords: safeCountSum(
          result.coverage.recordsRejected,
          result.coverage.recordsOmitted,
        ),
        expectedRecords: result.coverage.recordsObserved,
        errorCode: genericResultErrorCode(result),
      });
      terminal = true;
      reject("COLLECTION_REJECTED");
    }

    const rejectedRecords = safeCountSum(
      result.coverage.recordsRejected,
      result.coverage.recordsOmitted,
    );
    const body = minimizedEvidence(result);
    const contentSha256 = await sha256(new TextDecoder().decode(body));
    const generationId = `fss_${await sha256([
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      payload.sourceId,
      job.id,
      String(job.attempt),
      contentSha256,
    ].join("\0"))}`;
    const attemptRunId = `${job.id}.${job.attempt}`;
    const archived = await dependencies.evidence.archive({
      scope: {
        orgId: scope.organizationId,
        customerId: scope.customerId,
        connectionId: scope.connectionId,
      },
      runId: attemptRunId,
      snapshotId: generationId,
      artifactKind: "finops_source_snapshot",
      contentType: "application/json",
      body,
      createdBy: FINOPS_SOURCE_COLLECT_ACTOR_ID,
      now: Date.parse(result.collectedAt),
    });
    if (archived.status !== "available" || archived.contentSha256 !== contentSha256) {
      reject("COLLECTION_REJECTED");
    }
    const evidenceReference = await dependencies.evidenceReferenceSealer.seal(
      archived.id,
      {
        organizationId: scope.organizationId,
        customerId: scope.customerId,
        connectionId: scope.connectionId,
        sourceId: payload.sourceId,
        generationId,
      },
    );
    const complete = result.collectionStatus === "COMPLETE";
    await dependencies.ledger.finishAttempt(scope, identity, {
      status: complete ? "succeeded" : "partial",
      finishedAtIso: iso(now),
      acceptedRecords: result.coverage.recordsAccepted,
      rejectedRecords,
      expectedRecords: result.coverage.recordsObserved,
      processedBytes: body.byteLength,
      reconciliation: {
        outcome: complete ? "matched" : "mismatched",
        evidenceReference: evidenceReference.ciphertext,
      },
      ...(complete ? {} : { errorCode: genericResultErrorCode(result) }),
    });
    terminal = true;

    // A missing data-through watermark is valid partial telemetry, but it is
    // not a durable generation. The ledger and private archived evidence still
    // record the attempt without inventing freshness.
    if (result.dataThroughAt === null) return;
    await dependencies.snapshots.recordSnapshot(scope, {
      generationId,
      sourceId: payload.sourceId,
      jobId: job.id,
      attempt: job.attempt,
      status: complete ? "complete" : "partial",
      contentSha256,
      schemaVersion: "sutra.finops-source-evidence.v1",
      collectedAtIso: result.collectedAt,
      dataThroughAtIso: result.dataThroughAt,
      coverage: {
        assessment: complete ? "complete" : "partial",
        expected: result.coverage.recordsObserved,
        observed: result.coverage.recordsAccepted,
        missing: result.coverage.recordsObserved - result.coverage.recordsAccepted,
      },
      reconciliation: {
        expected: result.coverage.recordsObserved,
        accepted: result.coverage.recordsAccepted,
        rejected: rejectedRecords,
        outcome: complete ? "matched" : "mismatched",
      },
      evidenceReference,
    }, Date.parse(result.collectedAt));
  } catch (error) {
    if (started && !terminal) {
      try {
        await dependencies.ledger.finishAttempt(scope, identity, {
          status: "failed",
          finishedAtIso: iso(now),
          errorCode: genericFinopsSourceErrorCode(error),
        });
      } catch {
        // Preserve one provider-neutral failure at the queue boundary. The
        // repository keeps any successfully written state for operator review.
      }
    }
    if (error instanceof FinopsSourceCollectJobError) throw error;
    reject("COLLECTION_REJECTED");
  }
}
