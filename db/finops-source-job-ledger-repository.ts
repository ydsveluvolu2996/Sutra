/**
 * Durable Data Collection Monitor job-attempt ledger.
 *
 * Every public operation re-authorizes the exact active tenant/customer/live
 * AWS trust-role connection. Attempts have immutable identities, contiguous
 * retry numbers, deterministic idempotency, bounded pages, and a single
 * queued -> running -> terminal lifecycle.
 */
import {
  FINOPS_SOURCE_DEFINITIONS,
  type FinopsSourceId,
} from "../lib/finops-source-health.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const SOURCE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const MAX_ATTEMPT = 100;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const MAX_CURSOR_LENGTH = 2_048;
const MAX_EVIDENCE_REFERENCE_LENGTH = 1_024;

const SOURCE_IDS = new Set<FinopsSourceId>(
  FINOPS_SOURCE_DEFINITIONS.map((source) => source.id),
);

export type FinopsSourceJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled";

export type FinopsSourceJobTerminalStatus = Exclude<
  FinopsSourceJobStatus,
  "queued" | "running"
>;

export type FinopsSourceJobErrorCode =
  | "AUTHORIZATION_FAILED"
  | "SOURCE_UNAVAILABLE"
  | "THROTTLED"
  | "TIMEOUT"
  | "SCHEMA_MISMATCH"
  | "RECONCILIATION_FAILED"
  | "CANCELLED"
  | "INTERNAL_ERROR";

export type FinopsSourceJobReconciliationOutcome = "matched" | "mismatched";

const GENERIC_ERROR_MESSAGES: Readonly<Record<FinopsSourceJobErrorCode, string>> = {
  AUTHORIZATION_FAILED: "Collection authorization was rejected",
  SOURCE_UNAVAILABLE: "The configured collection source was unavailable",
  THROTTLED: "Collection was delayed by a bounded service quota",
  TIMEOUT: "Collection exceeded its bounded execution window",
  SCHEMA_MISMATCH: "Collected data did not match the accepted schema",
  RECONCILIATION_FAILED: "Collected data did not pass reconciliation",
  CANCELLED: "Collection was cancelled",
  INTERNAL_ERROR: "Collection failed because of an internal processing error",
};

const STATUSES = new Set<FinopsSourceJobStatus>([
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);
const TERMINAL_STATUSES = new Set<FinopsSourceJobTerminalStatus>([
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);
const ERROR_CODES = new Set<FinopsSourceJobErrorCode>(
  Object.keys(GENERIC_ERROR_MESSAGES) as FinopsSourceJobErrorCode[],
);

export interface FinopsSourceJobScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface FinopsSourceJobIdentity {
  readonly sourceId: FinopsSourceId;
  readonly jobId: string;
  readonly attempt: number;
}

export interface FinopsSourceJobAttempt {
  readonly scope: FinopsSourceJobScope;
  readonly sourceId: FinopsSourceId;
  readonly jobId: string;
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly status: FinopsSourceJobStatus;
  readonly queuedAtIso: string;
  readonly startedAtIso: string | null;
  readonly finishedAtIso: string | null;
  readonly acceptedRecords: number | null;
  readonly rejectedRecords: number | null;
  readonly expectedRecords: number | null;
  readonly processedBytes: number | null;
  readonly reconciliation: {
    readonly outcome: FinopsSourceJobReconciliationOutcome;
    readonly evidenceReference: string;
  } | null;
  readonly error: {
    readonly code: FinopsSourceJobErrorCode;
    readonly message: string;
  } | null;
  readonly queueWaitMs: number | null;
  readonly durationMs: number | null;
  readonly totalDurationMs: number | null;
  readonly createdAt: number;
}

export interface QueueFinopsSourceJobAttemptInput extends FinopsSourceJobIdentity {
  readonly idempotencyKey: string;
  readonly queuedAtIso: string;
}

export interface FinishFinopsSourceJobAttemptInput {
  readonly status: FinopsSourceJobTerminalStatus;
  readonly finishedAtIso: string;
  readonly acceptedRecords?: number | null;
  readonly rejectedRecords?: number | null;
  readonly expectedRecords?: number | null;
  readonly processedBytes?: number | null;
  readonly reconciliation?: {
    readonly outcome: FinopsSourceJobReconciliationOutcome;
    readonly evidenceReference: string;
  } | null;
  /**
   * Only a stable category is accepted. The repository writes its fixed,
   * provider-neutral message and cannot persist raw SDK/provider error text.
   */
  readonly errorCode?: FinopsSourceJobErrorCode | null;
}

export interface FinopsSourceJobAttemptPage {
  readonly attempts: readonly FinopsSourceJobAttempt[];
  readonly nextCursor: string | null;
}

export interface FinopsSourceJobSummary {
  readonly scope: FinopsSourceJobScope;
  readonly sources: readonly {
    readonly sourceId: FinopsSourceId;
    readonly attempts: number;
    readonly statuses: Readonly<Record<FinopsSourceJobStatus, number>>;
    readonly lastQueuedAtIso: string;
    readonly lastSuccessAtIso: string | null;
    readonly latestAttempt: FinopsSourceJobAttempt;
  }[];
}

export class FinopsSourceJobLedgerRepositoryError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "SCOPE_NOT_FOUND"
    | "ATTEMPT_NOT_FOUND"
    | "ATTEMPT_SEQUENCE_CONFLICT"
    | "IDEMPOTENCY_CONFLICT"
    | "INVALID_STATE"
    | "STORED_STATE_INVALID";

  public constructor(code: FinopsSourceJobLedgerRepositoryError["code"]) {
    super("Data Collection Monitor ledger operation rejected");
    this.name = "FinopsSourceJobLedgerRepositoryError";
    this.code = code;
  }
}

interface AttemptRow {
  org_id: string;
  customer_id: string;
  connection_id: string;
  source_id: string;
  job_id: string;
  attempt: number | string;
  idempotency_key: string;
  status: string;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  accepted_records: number | string | null;
  rejected_records: number | string | null;
  expected_records: number | string | null;
  processed_bytes: number | string | null;
  reconciliation_outcome: string | null;
  reconciliation_evidence_reference: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number | string;
}

interface SummaryRow {
  source_id: string;
  attempts: number | string;
  queued: number | string;
  running: number | string;
  succeeded: number | string;
  partial: number | string;
  failed: number | string;
  cancelled: number | string;
  last_queued_at: string;
  last_success_at: string | null;
}

interface CursorPayload {
  readonly v: 1;
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly sourceId: FinopsSourceId | null;
  readonly status: FinopsSourceJobStatus | null;
  readonly queuedAtIso: string;
  readonly cursorSourceId: FinopsSourceId;
  readonly jobId: string;
  readonly attempt: number;
}

interface NormalizedFinish {
  readonly status: FinopsSourceJobTerminalStatus;
  readonly finishedAtIso: string;
  readonly acceptedRecords: number | null;
  readonly rejectedRecords: number | null;
  readonly expectedRecords: number | null;
  readonly processedBytes: number | null;
  readonly reconciliationOutcome: FinopsSourceJobReconciliationOutcome | null;
  readonly reconciliationEvidenceReference: string | null;
  readonly errorCode: FinopsSourceJobErrorCode | null;
  readonly errorMessage: string | null;
}

function reject(
  code: FinopsSourceJobLedgerRepositoryError["code"] = "INVALID_INPUT",
): never {
  throw new FinopsSourceJobLedgerRepositoryError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !value.includes("\0");
}

function normalizedIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

function assertScope(scope: FinopsSourceJobScope): void {
  if (
    !isRecord(scope)
    || !IDENTIFIER.test(String(scope.organizationId))
    || !IDENTIFIER.test(String(scope.customerId))
    || !CONNECTION_ID.test(String(scope.connectionId))
  ) reject();
}

function isSourceId(value: unknown): value is FinopsSourceId {
  return typeof value === "string" && SOURCE_IDS.has(value as FinopsSourceId);
}

function isStatus(value: unknown): value is FinopsSourceJobStatus {
  return typeof value === "string"
    && STATUSES.has(value as FinopsSourceJobStatus);
}

function isTerminalStatus(value: unknown): value is FinopsSourceJobTerminalStatus {
  return typeof value === "string"
    && TERMINAL_STATUSES.has(value as FinopsSourceJobTerminalStatus);
}

function isErrorCode(value: unknown): value is FinopsSourceJobErrorCode {
  return typeof value === "string"
    && ERROR_CODES.has(value as FinopsSourceJobErrorCode);
}

function safeInteger(value: number | string, code: "INVALID_INPUT" | "STORED_STATE_INVALID"): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) reject(code);
  return parsed;
}

function optionalStoredCount(value: number | string | null): number | null {
  return value === null ? null : safeInteger(value, "STORED_STATE_INVALID");
}

function optionalInputCount(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    reject();
  }
  return value;
}

function assertIdentity(identity: FinopsSourceJobIdentity): void {
  if (
    !isRecord(identity)
    || !isSourceId(identity.sourceId)
    || !SOURCE_JOB_ID.test(String(identity.jobId))
    || !Number.isSafeInteger(identity.attempt)
    || identity.attempt < 1
    || identity.attempt > MAX_ATTEMPT
  ) reject();
}

function durationBetween(startIso: string | null, finishIso: string | null): number | null {
  if (startIso === null || finishIso === null) return null;
  const duration = Date.parse(finishIso) - Date.parse(startIso);
  if (!Number.isSafeInteger(duration) || duration < 0) {
    reject("STORED_STATE_INVALID");
  }
  return duration;
}

function toAttempt(row: AttemptRow): FinopsSourceJobAttempt {
  const queuedAtIso = normalizedIso(row.queued_at);
  const startedAtIso = row.started_at === null ? null : normalizedIso(row.started_at);
  const finishedAtIso = row.finished_at === null ? null : normalizedIso(row.finished_at);
  const attempt = safeInteger(row.attempt, "STORED_STATE_INVALID");
  const createdAt = safeInteger(row.created_at, "STORED_STATE_INVALID");
  if (
    !IDENTIFIER.test(row.org_id)
    || !IDENTIFIER.test(row.customer_id)
    || !CONNECTION_ID.test(row.connection_id)
    || !isSourceId(row.source_id)
    || !SOURCE_JOB_ID.test(row.job_id)
    || attempt < 1
    || attempt > MAX_ATTEMPT
    || !IDEMPOTENCY_KEY.test(row.idempotency_key)
    || !isStatus(row.status)
    || queuedAtIso === null
    || (row.started_at !== null && startedAtIso === null)
    || (row.finished_at !== null && finishedAtIso === null)
  ) reject("STORED_STATE_INVALID");

  const acceptedRecords = optionalStoredCount(row.accepted_records);
  const rejectedRecords = optionalStoredCount(row.rejected_records);
  const expectedRecords = optionalStoredCount(row.expected_records);
  const processedBytes = optionalStoredCount(row.processed_bytes);
  const reconciliation = row.reconciliation_outcome === null
    && row.reconciliation_evidence_reference === null
    ? null
    : row.reconciliation_outcome !== null
      && new Set(["matched", "mismatched"]).has(row.reconciliation_outcome)
      && validText(
        row.reconciliation_evidence_reference,
        MAX_EVIDENCE_REFERENCE_LENGTH,
      )
      ? {
          outcome: row.reconciliation_outcome as FinopsSourceJobReconciliationOutcome,
          evidenceReference: row.reconciliation_evidence_reference,
        }
      : reject("STORED_STATE_INVALID");
  const error = row.error_code === null && row.error_message === null
    ? null
    : isErrorCode(row.error_code)
      && row.error_message === GENERIC_ERROR_MESSAGES[row.error_code]
      ? {
          code: row.error_code,
          message: row.error_message,
        }
      : reject("STORED_STATE_INVALID");

  return {
    scope: {
      organizationId: row.org_id,
      customerId: row.customer_id,
      connectionId: row.connection_id,
    },
    sourceId: row.source_id,
    jobId: row.job_id,
    attempt,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    queuedAtIso,
    startedAtIso,
    finishedAtIso,
    acceptedRecords,
    rejectedRecords,
    expectedRecords,
    processedBytes,
    reconciliation,
    error,
    queueWaitMs: durationBetween(queuedAtIso, startedAtIso),
    durationMs: durationBetween(startedAtIso, finishedAtIso),
    totalDurationMs: durationBetween(queuedAtIso, finishedAtIso),
    createdAt,
  };
}

function sameQueuedRequest(
  attempt: FinopsSourceJobAttempt,
  input: QueueFinopsSourceJobAttemptInput,
  queuedAtIso: string,
): boolean {
  return attempt.sourceId === input.sourceId
    && attempt.jobId === input.jobId
    && attempt.attempt === input.attempt
    && attempt.idempotencyKey === input.idempotencyKey
    && attempt.queuedAtIso === queuedAtIso;
}

function normalizeFinish(input: FinishFinopsSourceJobAttemptInput): NormalizedFinish {
  if (!isRecord(input) || !isTerminalStatus(input.status)) reject();
  const finishedAtIso = normalizedIso(input.finishedAtIso);
  if (finishedAtIso === null) reject();
  const acceptedRecords = optionalInputCount(input.acceptedRecords);
  const rejectedRecords = optionalInputCount(input.rejectedRecords);
  const expectedRecords = optionalInputCount(input.expectedRecords);
  const processedBytes = optionalInputCount(input.processedBytes);
  if (
    expectedRecords !== null
    && acceptedRecords !== null
    && rejectedRecords !== null
    && acceptedRecords + rejectedRecords > expectedRecords
  ) reject();

  const reconciliation = input.reconciliation ?? null;
  if (
    reconciliation !== null
    && (
      !isRecord(reconciliation)
      || !new Set(["matched", "mismatched"]).has(
        String(reconciliation.outcome),
      )
      || !validText(
        reconciliation.evidenceReference,
        MAX_EVIDENCE_REFERENCE_LENGTH,
      )
    )
  ) reject();
  const reconciliationOutcome = reconciliation?.outcome ?? null;
  const reconciliationEvidenceReference =
    reconciliation?.evidenceReference ?? null;
  if (input.status === "succeeded" && reconciliationOutcome === "mismatched") {
    reject();
  }

  let errorCode = input.errorCode ?? null;
  if (input.status === "cancelled") {
    if (errorCode !== null && errorCode !== "CANCELLED") reject();
    errorCode = "CANCELLED";
  } else if (input.status === "failed" && errorCode === null) {
    reject();
  }
  if (input.status !== "cancelled" && errorCode === "CANCELLED") reject();
  if (input.status === "succeeded" && errorCode !== null) reject();
  if (errorCode !== null && !isErrorCode(errorCode)) reject();

  return {
    status: input.status,
    finishedAtIso,
    acceptedRecords,
    rejectedRecords,
    expectedRecords,
    processedBytes,
    reconciliationOutcome,
    reconciliationEvidenceReference,
    errorCode,
    errorMessage: errorCode === null ? null : GENERIC_ERROR_MESSAGES[errorCode],
  };
}

function sameFinish(
  attempt: FinopsSourceJobAttempt,
  finish: NormalizedFinish,
): boolean {
  return attempt.status === finish.status
    && attempt.finishedAtIso === finish.finishedAtIso
    && attempt.acceptedRecords === finish.acceptedRecords
    && attempt.rejectedRecords === finish.rejectedRecords
    && attempt.expectedRecords === finish.expectedRecords
    && attempt.processedBytes === finish.processedBytes
    && attempt.reconciliation?.outcome ===
      (finish.reconciliationOutcome ?? undefined)
    && attempt.reconciliation?.evidenceReference ===
      (finish.reconciliationEvidenceReference ?? undefined)
    && attempt.error?.code === (finish.errorCode ?? undefined)
    && attempt.error?.message === (finish.errorMessage ?? undefined);
}

function encodeCursor(cursor: CursorPayload): string {
  return btoa(JSON.stringify(cursor))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursor(
  encoded: string,
  scope: FinopsSourceJobScope,
  sourceId: FinopsSourceId | null,
  status: FinopsSourceJobStatus | null,
): CursorPayload {
  if (!validText(encoded, MAX_CURSOR_LENGTH)) reject();
  try {
    const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const parsed: unknown = JSON.parse(atob(padded));
    if (
      !isRecord(parsed)
      || parsed.v !== 1
      || parsed.organizationId !== scope.organizationId
      || parsed.customerId !== scope.customerId
      || parsed.connectionId !== scope.connectionId
      || parsed.sourceId !== sourceId
      || parsed.status !== status
      || normalizedIso(parsed.queuedAtIso) !== parsed.queuedAtIso
      || !isSourceId(parsed.cursorSourceId)
      || !SOURCE_JOB_ID.test(String(parsed.jobId))
      || !Number.isSafeInteger(parsed.attempt)
      || Number(parsed.attempt) < 1
      || Number(parsed.attempt) > MAX_ATTEMPT
    ) reject();
    return parsed as unknown as CursorPayload;
  } catch (error) {
    if (error instanceof FinopsSourceJobLedgerRepositoryError) throw error;
    reject();
  }
}

export class FinopsSourceJobLedgerRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  private async assertLiveScope(
    scope: FinopsSourceJobScope,
  ): Promise<D1Database> {
    assertScope(scope);
    const database = await this.ready();
    const row = await database.prepare(
      `SELECT c.id
         FROM aws_connections c
         JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
         JOIN customers cu
           ON cu.id = c.customer_id AND cu.org_id = c.org_id
          AND cu.status = 'active'
        WHERE c.org_id = ? AND c.customer_id = ? AND c.id = ?
          AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
        LIMIT 1`,
    ).bind(
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
    ).first<{ id: string }>();
    if (row === null) reject("SCOPE_NOT_FOUND");
    return database;
  }

  private async readAttempt(
    database: D1Database,
    scope: FinopsSourceJobScope,
    identity: FinopsSourceJobIdentity,
  ): Promise<FinopsSourceJobAttempt | null> {
    const row = await database.prepare(
      `SELECT a.*
         FROM finops_source_job_attempts a
         JOIN aws_connections c
           ON c.id = a.connection_id AND c.org_id = a.org_id
          AND c.customer_id = a.customer_id
         JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
         JOIN customers cu
           ON cu.id = c.customer_id AND cu.org_id = c.org_id
          AND cu.status = 'active'
        WHERE a.org_id = ? AND a.customer_id = ? AND a.connection_id = ?
          AND a.source_id = ? AND a.job_id = ? AND a.attempt = ?
          AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
        LIMIT 1`,
    ).bind(
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      identity.sourceId,
      identity.jobId,
      identity.attempt,
    ).first<AttemptRow>();
    return row === null ? null : toAttempt(row);
  }

  private async readByIdempotency(
    database: D1Database,
    scope: FinopsSourceJobScope,
    sourceId: FinopsSourceId,
    idempotencyKey: string,
  ): Promise<FinopsSourceJobAttempt | null> {
    const row = await database.prepare(
      `SELECT a.*
         FROM finops_source_job_attempts a
         JOIN aws_connections c
           ON c.id = a.connection_id AND c.org_id = a.org_id
          AND c.customer_id = a.customer_id
         JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
         JOIN customers cu
           ON cu.id = c.customer_id AND cu.org_id = c.org_id
          AND cu.status = 'active'
        WHERE a.org_id = ? AND a.customer_id = ? AND a.connection_id = ?
          AND a.source_id = ? AND a.idempotency_key = ?
          AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
        LIMIT 1`,
    ).bind(
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      sourceId,
      idempotencyKey,
    ).first<AttemptRow>();
    return row === null ? null : toAttempt(row);
  }

  public async queueAttempt(
    scope: FinopsSourceJobScope,
    input: QueueFinopsSourceJobAttemptInput,
    nowMs = Date.now(),
  ): Promise<FinopsSourceJobAttempt> {
    assertIdentity(input);
    if (
      !IDEMPOTENCY_KEY.test(String(input.idempotencyKey))
      || !Number.isSafeInteger(nowMs)
      || nowMs < 0
    ) reject();
    const queuedAtIso = normalizedIso(input.queuedAtIso);
    if (queuedAtIso === null) reject();
    const database = await this.assertLiveScope(scope);

    const idempotent = await this.readByIdempotency(
      database,
      scope,
      input.sourceId,
      input.idempotencyKey,
    );
    if (idempotent !== null) {
      if (!sameQueuedRequest(idempotent, input, queuedAtIso)) {
        reject("IDEMPOTENCY_CONFLICT");
      }
      return idempotent;
    }

    await database.prepare(
      `INSERT INTO finops_source_job_attempts (
         org_id, customer_id, connection_id, source_id, job_id, attempt,
         idempotency_key, status, queued_at, created_at
       )
       SELECT c.org_id, c.customer_id, c.id, ?, ?, ?, ?, 'queued', ?, ?
         FROM aws_connections c
         JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
         JOIN customers cu
           ON cu.id = c.customer_id AND cu.org_id = c.org_id
          AND cu.status = 'active'
        WHERE c.org_id = ? AND c.customer_id = ? AND c.id = ?
          AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
          AND (
            (
              ? = 1
              AND NOT EXISTS (
                SELECT 1 FROM finops_source_job_attempts existing
                 WHERE existing.org_id = c.org_id
                   AND existing.customer_id = c.customer_id
                   AND existing.connection_id = c.id
                   AND existing.source_id = ?
                   AND existing.job_id = ?
              )
            )
            OR (
              ? > 1
              AND EXISTS (
                SELECT 1 FROM finops_source_job_attempts previous
                 WHERE previous.org_id = c.org_id
                   AND previous.customer_id = c.customer_id
                   AND previous.connection_id = c.id
                   AND previous.source_id = ?
                   AND previous.job_id = ?
                   AND previous.attempt = ? - 1
                   AND previous.status IN (
                     'succeeded', 'partial', 'failed', 'cancelled'
                   )
              )
              AND NOT EXISTS (
                SELECT 1 FROM finops_source_job_attempts newer
                 WHERE newer.org_id = c.org_id
                   AND newer.customer_id = c.customer_id
                   AND newer.connection_id = c.id
                   AND newer.source_id = ?
                   AND newer.job_id = ?
                   AND newer.attempt >= ?
              )
            )
          )
       ON CONFLICT DO NOTHING`,
    ).bind(
      input.sourceId,
      input.jobId,
      input.attempt,
      input.idempotencyKey,
      queuedAtIso,
      nowMs,
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      input.attempt,
      input.sourceId,
      input.jobId,
      input.attempt,
      input.sourceId,
      input.jobId,
      input.attempt,
      input.sourceId,
      input.jobId,
      input.attempt,
    ).run();

    const byIdempotency = await this.readByIdempotency(
      database,
      scope,
      input.sourceId,
      input.idempotencyKey,
    );
    if (byIdempotency !== null) {
      if (!sameQueuedRequest(byIdempotency, input, queuedAtIso)) {
        reject("IDEMPOTENCY_CONFLICT");
      }
      return byIdempotency;
    }
    reject("ATTEMPT_SEQUENCE_CONFLICT");
  }

  public async getAttempt(
    scope: FinopsSourceJobScope,
    identity: FinopsSourceJobIdentity,
  ): Promise<FinopsSourceJobAttempt | null> {
    assertIdentity(identity);
    const database = await this.assertLiveScope(scope);
    return this.readAttempt(database, scope, identity);
  }

  public async startAttempt(
    scope: FinopsSourceJobScope,
    identity: FinopsSourceJobIdentity,
    startedAtIsoInput: string,
  ): Promise<FinopsSourceJobAttempt> {
    assertIdentity(identity);
    const startedAtIso = normalizedIso(startedAtIsoInput);
    if (startedAtIso === null) reject();
    const database = await this.assertLiveScope(scope);
    const current = await this.readAttempt(database, scope, identity);
    if (current === null) reject("ATTEMPT_NOT_FOUND");
    if (current.startedAtIso !== null) {
      if (current.startedAtIso === startedAtIso) return current;
      reject("INVALID_STATE");
    }
    if (
      current.status !== "queued"
      || Date.parse(startedAtIso) < Date.parse(current.queuedAtIso)
    ) reject("INVALID_STATE");

    await database.prepare(
      `UPDATE finops_source_job_attempts
          SET status = 'running', started_at = ?
        WHERE org_id = ? AND customer_id = ? AND connection_id = ?
          AND source_id = ? AND job_id = ? AND attempt = ?
          AND status = 'queued' AND started_at IS NULL
          AND EXISTS (
            SELECT 1
              FROM aws_connections c
              JOIN organizations o
                ON o.id = c.org_id AND o.status = 'active'
              JOIN customers cu
                ON cu.id = c.customer_id AND cu.org_id = c.org_id
               AND cu.status = 'active'
             WHERE c.org_id = ? AND c.customer_id = ? AND c.id = ?
               AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
          )`,
    ).bind(
      startedAtIso,
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      identity.sourceId,
      identity.jobId,
      identity.attempt,
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
    ).run();
    const updated = await this.readAttempt(database, scope, identity);
    if (updated !== null && updated.startedAtIso === startedAtIso) return updated;
    reject("INVALID_STATE");
  }

  public async finishAttempt(
    scope: FinopsSourceJobScope,
    identity: FinopsSourceJobIdentity,
    input: FinishFinopsSourceJobAttemptInput,
  ): Promise<FinopsSourceJobAttempt> {
    assertIdentity(identity);
    const finish = normalizeFinish(input);
    const database = await this.assertLiveScope(scope);
    const current = await this.readAttempt(database, scope, identity);
    if (current === null) reject("ATTEMPT_NOT_FOUND");
    if (isTerminalStatus(current.status)) {
      if (sameFinish(current, finish)) return current;
      reject("INVALID_STATE");
    }
    if (
      current.status !== "running"
      || current.startedAtIso === null
      || Date.parse(finish.finishedAtIso) < Date.parse(current.startedAtIso)
    ) reject("INVALID_STATE");

    await database.prepare(
      `UPDATE finops_source_job_attempts
          SET status = ?, finished_at = ?,
              accepted_records = ?, rejected_records = ?,
              expected_records = ?, processed_bytes = ?,
              reconciliation_outcome = ?,
              reconciliation_evidence_reference = ?,
              error_code = ?, error_message = ?
        WHERE org_id = ? AND customer_id = ? AND connection_id = ?
          AND source_id = ? AND job_id = ? AND attempt = ?
          AND status = 'running' AND started_at = ?
          AND EXISTS (
            SELECT 1
              FROM aws_connections c
              JOIN organizations o
                ON o.id = c.org_id AND o.status = 'active'
              JOIN customers cu
                ON cu.id = c.customer_id AND cu.org_id = c.org_id
               AND cu.status = 'active'
             WHERE c.org_id = ? AND c.customer_id = ? AND c.id = ?
               AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
          )`,
    ).bind(
      finish.status,
      finish.finishedAtIso,
      finish.acceptedRecords,
      finish.rejectedRecords,
      finish.expectedRecords,
      finish.processedBytes,
      finish.reconciliationOutcome,
      finish.reconciliationEvidenceReference,
      finish.errorCode,
      finish.errorMessage,
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      identity.sourceId,
      identity.jobId,
      identity.attempt,
      current.startedAtIso,
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
    ).run();
    const updated = await this.readAttempt(database, scope, identity);
    if (updated !== null && sameFinish(updated, finish)) return updated;
    reject("INVALID_STATE");
  }

  public async listAttempts(
    scope: FinopsSourceJobScope,
    options: {
      readonly sourceId?: FinopsSourceId;
      readonly status?: FinopsSourceJobStatus;
      readonly cursor?: string;
      readonly limit?: number;
    } = {},
  ): Promise<FinopsSourceJobAttemptPage> {
    const sourceId = options.sourceId ?? null;
    const status = options.status ?? null;
    const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
    if (
      (sourceId !== null && !isSourceId(sourceId))
      || (status !== null && !isStatus(status))
      || !Number.isSafeInteger(limit)
      || limit < 1
      || limit > MAX_PAGE_LIMIT
    ) reject();
    const database = await this.assertLiveScope(scope);
    const cursor = options.cursor === undefined
      ? null
      : decodeCursor(options.cursor, scope, sourceId, status);
    const conditions = [
      "a.org_id = ?",
      "a.customer_id = ?",
      "a.connection_id = ?",
      "c.source_kind = 'aws_trust_role'",
      "c.status = 'active'",
    ];
    const bindings: (string | number)[] = [
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
    ];
    if (sourceId !== null) {
      conditions.push("a.source_id = ?");
      bindings.push(sourceId);
    }
    if (status !== null) {
      conditions.push("a.status = ?");
      bindings.push(status);
    }
    if (cursor !== null) {
      conditions.push(
        `(a.queued_at < ?
          OR (a.queued_at = ? AND a.source_id < ?)
          OR (
            a.queued_at = ? AND a.source_id = ? AND a.job_id < ?
          )
          OR (
            a.queued_at = ? AND a.source_id = ? AND a.job_id = ?
            AND a.attempt < ?
          ))`,
      );
      bindings.push(
        cursor.queuedAtIso,
        cursor.queuedAtIso,
        cursor.cursorSourceId,
        cursor.queuedAtIso,
        cursor.cursorSourceId,
        cursor.jobId,
        cursor.queuedAtIso,
        cursor.cursorSourceId,
        cursor.jobId,
        cursor.attempt,
      );
    }
    const rows = await database.prepare(
      `SELECT a.*
         FROM finops_source_job_attempts a
         JOIN aws_connections c
           ON c.id = a.connection_id AND c.org_id = a.org_id
          AND c.customer_id = a.customer_id
         JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
         JOIN customers cu
           ON cu.id = c.customer_id AND cu.org_id = c.org_id
          AND cu.status = 'active'
        WHERE ${conditions.join(" AND ")}
        ORDER BY a.queued_at DESC, a.source_id DESC,
                 a.job_id DESC, a.attempt DESC
        LIMIT ?`,
    ).bind(...bindings, limit + 1).all<AttemptRow>();
    const materialized = (rows.results ?? []).map(toAttempt);
    const hasMore = materialized.length > limit;
    const attempts = materialized.slice(0, limit);
    const last = attempts.at(-1);
    return {
      attempts,
      nextCursor: hasMore && last !== undefined
        ? encodeCursor({
            v: 1,
            organizationId: scope.organizationId,
            customerId: scope.customerId,
            connectionId: scope.connectionId,
            sourceId,
            status,
            queuedAtIso: last.queuedAtIso,
            cursorSourceId: last.sourceId,
            jobId: last.jobId,
            attempt: last.attempt,
          })
        : null,
    };
  }

  /**
   * Bounded, tenant-scoped source summary intended for later source-health
   * integration. It reports only persisted attempts; absent sources are absent.
   */
  public async summarize(
    scope: FinopsSourceJobScope,
    sourceId?: FinopsSourceId,
  ): Promise<FinopsSourceJobSummary> {
    if (sourceId !== undefined && !isSourceId(sourceId)) reject();
    const database = await this.assertLiveScope(scope);
    const sourceCondition = sourceId === undefined ? "" : "AND a.source_id = ?";
    const baseBindings = [
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      ...(sourceId === undefined ? [] : [sourceId]),
    ];
    const grouped = await database.prepare(
      `SELECT a.source_id,
              COUNT(*) AS attempts,
              SUM(CASE WHEN a.status = 'queued' THEN 1 ELSE 0 END) AS queued,
              SUM(CASE WHEN a.status = 'running' THEN 1 ELSE 0 END) AS running,
              SUM(CASE WHEN a.status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
              SUM(CASE WHEN a.status = 'partial' THEN 1 ELSE 0 END) AS partial,
              SUM(CASE WHEN a.status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN a.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
              MAX(a.queued_at) AS last_queued_at,
              MAX(
                CASE WHEN a.status = 'succeeded' THEN a.finished_at ELSE NULL END
              ) AS last_success_at
         FROM finops_source_job_attempts a
         JOIN aws_connections c
           ON c.id = a.connection_id AND c.org_id = a.org_id
          AND c.customer_id = a.customer_id
         JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
         JOIN customers cu
           ON cu.id = c.customer_id AND cu.org_id = c.org_id
          AND cu.status = 'active'
        WHERE a.org_id = ? AND a.customer_id = ? AND a.connection_id = ?
          AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
          ${sourceCondition}
        GROUP BY a.source_id
        ORDER BY a.source_id ASC
        LIMIT ?`,
    ).bind(...baseBindings, FINOPS_SOURCE_DEFINITIONS.length).all<SummaryRow>();
    const latest = await database.prepare(
      `WITH ranked AS (
         SELECT a.*,
                ROW_NUMBER() OVER (
                  PARTITION BY a.source_id
                  ORDER BY a.queued_at DESC, a.job_id DESC, a.attempt DESC
                ) AS source_rank
           FROM finops_source_job_attempts a
           JOIN aws_connections c
             ON c.id = a.connection_id AND c.org_id = a.org_id
            AND c.customer_id = a.customer_id
           JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
           JOIN customers cu
             ON cu.id = c.customer_id AND cu.org_id = c.org_id
            AND cu.status = 'active'
          WHERE a.org_id = ? AND a.customer_id = ? AND a.connection_id = ?
            AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
            ${sourceCondition}
       )
       SELECT * FROM ranked
        WHERE source_rank = 1
        ORDER BY source_id ASC
        LIMIT ?`,
    ).bind(...baseBindings, FINOPS_SOURCE_DEFINITIONS.length).all<AttemptRow>();
    const latestBySource = new Map(
      (latest.results ?? []).map((row) => {
        const attempt = toAttempt(row);
        return [attempt.sourceId, attempt] as const;
      }),
    );
    return {
      scope: { ...scope },
      sources: (grouped.results ?? []).map((row) => {
        if (!isSourceId(row.source_id)) reject("STORED_STATE_INVALID");
        const latestAttempt = latestBySource.get(row.source_id);
        if (latestAttempt === undefined) reject("STORED_STATE_INVALID");
        const lastQueuedAtIso = normalizedIso(row.last_queued_at);
        const lastSuccessAtIso = row.last_success_at === null
          ? null
          : normalizedIso(row.last_success_at);
        if (
          lastQueuedAtIso === null
          || (row.last_success_at !== null && lastSuccessAtIso === null)
        ) reject("STORED_STATE_INVALID");
        return {
          sourceId: row.source_id,
          attempts: safeInteger(row.attempts, "STORED_STATE_INVALID"),
          statuses: {
            queued: safeInteger(row.queued, "STORED_STATE_INVALID"),
            running: safeInteger(row.running, "STORED_STATE_INVALID"),
            succeeded: safeInteger(row.succeeded, "STORED_STATE_INVALID"),
            partial: safeInteger(row.partial, "STORED_STATE_INVALID"),
            failed: safeInteger(row.failed, "STORED_STATE_INVALID"),
            cancelled: safeInteger(row.cancelled, "STORED_STATE_INVALID"),
          },
          lastQueuedAtIso,
          lastSuccessAtIso,
          latestAttempt,
        };
      }),
    };
  }
}
