/**
 * Immutable FinOps source-generation persistence.
 *
 * Every generation is bound to one terminal durable source-job attempt and to
 * an exact live tenant/customer/AWS trust-role connection. The only mutable
 * record is a per-source head, advanced in the same database batch only when a
 * READY/COMPLETE generation has full coverage, matched reconciliation, and is
 * fresher than the currently active generation. No raw provider payload or
 * provider error is accepted by this repository.
 */
import {
  FINOPS_SOURCE_DEFINITIONS,
  type FinopsSourceId,
} from "../lib/finops-source-health.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const GENERATION_ID = /^fss_[a-f0-9]{64}$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SCHEMA_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$/u;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const SEALED_REFERENCE = /^fsev1\.[A-Za-z0-9_-]{26,8186}$/u;
const MAX_ATTEMPT = 100;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 100;

const SOURCE_IDS = new Set<FinopsSourceId>(
  FINOPS_SOURCE_DEFINITIONS.map((source) => source.id),
);
const SNAPSHOT_STATUSES = new Set<FinopsSourceSnapshotStatus>([
  "ready",
  "complete",
  "partial",
  "failed",
  "stale",
]);
const RECONCILIATION_OUTCOMES = new Set<FinopsSourceSnapshotReconciliationOutcome>([
  "matched",
  "mismatched",
  "not_run",
]);
const COVERAGE_ASSESSMENTS = new Set(["complete", "partial", "unknown"] as const);

export interface FinopsSourceSnapshotScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export type FinopsSourceSnapshotStatus =
  | "ready"
  | "complete"
  | "partial"
  | "failed"
  | "stale";

export type FinopsSourceSnapshotReconciliationOutcome =
  | "matched"
  | "mismatched"
  | "not_run";

export interface FinopsSourceSnapshotCountEvidence {
  readonly assessment: "complete" | "partial" | "unknown";
  readonly expected: number | null;
  readonly observed: number;
  readonly missing: number | null;
}

export interface FinopsSourceSnapshotReconciliationEvidence {
  readonly expected: number | null;
  readonly accepted: number;
  readonly rejected: number;
  readonly outcome: FinopsSourceSnapshotReconciliationOutcome;
}

export interface EncryptedFinopsEvidenceReference {
  /** `fsev1.`-prefixed application ciphertext; never a raw URI or object key. */
  readonly ciphertext: string;
  readonly keyVersion: string;
}

export interface RecordFinopsSourceSnapshotInput {
  readonly generationId: string;
  readonly sourceId: FinopsSourceId;
  readonly jobId: string;
  readonly attempt: number;
  readonly status: FinopsSourceSnapshotStatus;
  readonly contentSha256: string;
  readonly schemaVersion: string;
  readonly collectedAtIso: string;
  readonly dataThroughAtIso: string;
  readonly coverage: FinopsSourceSnapshotCountEvidence;
  readonly reconciliation: FinopsSourceSnapshotReconciliationEvidence;
  readonly evidenceReference: EncryptedFinopsEvidenceReference;
}

export interface StoredFinopsSourceSnapshot {
  readonly scope: FinopsSourceSnapshotScope;
  readonly sourceId: FinopsSourceId;
  readonly generationId: string;
  readonly activeGenerationId: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly status: FinopsSourceSnapshotStatus;
  readonly contentSha256: string;
  readonly schemaVersion: string;
  readonly collectedAtIso: string;
  readonly dataThroughAtIso: string;
  readonly committedAtIso: string;
  readonly coverage: FinopsSourceSnapshotCountEvidence;
  readonly reconciliation: FinopsSourceSnapshotReconciliationEvidence;
  readonly evidenceReference: EncryptedFinopsEvidenceReference;
  readonly createdAtIso: string;
}

export interface RecordFinopsSourceSnapshotResult {
  readonly snapshot: Omit<StoredFinopsSourceSnapshot, "activeGenerationId" | "committedAtIso">;
  readonly becameActive: boolean;
  readonly activeGenerationId: string | null;
}

export class FinopsSourceSnapshotRepositoryError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "SCOPE_NOT_FOUND"
    | "ATTEMPT_NOT_ACCEPTED"
    | "IMMUTABLE_GENERATION_CONFLICT"
    | "STORED_STATE_INVALID";

  public constructor(code: FinopsSourceSnapshotRepositoryError["code"]) {
    super("FinOps source snapshot operation rejected");
    this.name = "FinopsSourceSnapshotRepositoryError";
    this.code = code;
  }
}

interface SnapshotRow {
  generation_id: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  source_id: string;
  job_id: string;
  attempt: number | string;
  status: string;
  content_sha256: string;
  schema_version: string;
  collected_at: string;
  data_through_at: string;
  coverage_expected_records: number | string | null;
  coverage_assessment: string;
  coverage_observed_records: number | string;
  coverage_missing_records: number | string | null;
  reconciliation_expected_records: number | string | null;
  reconciliation_accepted_records: number | string;
  reconciliation_rejected_records: number | string;
  reconciliation_outcome: string;
  evidence_reference_ciphertext: string;
  evidence_reference_key_version: string;
  created_at: number | string;
}

interface ActiveSnapshotRow extends SnapshotRow {
  active_generation_id: string;
  advanced_at: number | string;
}

interface AttemptRow {
  status: "succeeded" | "partial" | "failed" | "cancelled";
  accepted_records: number | string | null;
  rejected_records: number | string | null;
  expected_records: number | string | null;
  reconciliation_outcome: "matched" | "mismatched" | null;
}

interface NormalizedSnapshotInput extends RecordFinopsSourceSnapshotInput {
  readonly collectedAtIso: string;
  readonly dataThroughAtIso: string;
}

function reject(
  code: FinopsSourceSnapshotRepositoryError["code"] = "INVALID_INPUT",
): never {
  throw new FinopsSourceSnapshotRepositoryError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

function safeInteger(
  value: unknown,
  code: "INVALID_INPUT" | "STORED_STATE_INVALID" = "INVALID_INPUT",
): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) {
    reject(code);
  }
  return parsed;
}

function nullableSafeInteger(
  value: unknown,
  code: "INVALID_INPUT" | "STORED_STATE_INVALID" = "INVALID_INPUT",
): number | null {
  return value === null ? null : safeInteger(value, code);
}

function assertScope(scope: FinopsSourceSnapshotScope): void {
  if (
    !isRecord(scope)
    || !IDENTIFIER.test(String(scope.organizationId))
    || !IDENTIFIER.test(String(scope.customerId))
    || !CONNECTION_ID.test(String(scope.connectionId))
  ) reject();
}

function assertCounts(
  coverage: FinopsSourceSnapshotCountEvidence,
  reconciliation: FinopsSourceSnapshotReconciliationEvidence,
): void {
  if (!isRecord(coverage) || !isRecord(reconciliation)) reject();
  if (!COVERAGE_ASSESSMENTS.has(coverage.assessment)) reject();
  const coverageExpected = nullableSafeInteger(coverage.expected);
  const coverageObserved = safeInteger(coverage.observed);
  const coverageMissing = nullableSafeInteger(coverage.missing);
  const reconciliationExpected = nullableSafeInteger(reconciliation.expected);
  const reconciliationAccepted = safeInteger(reconciliation.accepted);
  const reconciliationRejected = safeInteger(reconciliation.rejected);
  if (
    ((coverageExpected === null) !== (coverageMissing === null))
    || (coverageExpected !== null
      && coverageMissing !== null
      && coverageObserved + coverageMissing !== coverageExpected)
    || (coverage.assessment === "unknown"
      && (coverageExpected !== null || coverageMissing !== null))
    || (coverage.assessment === "complete"
      && coverageMissing !== null
      && coverageMissing !== 0)
    || (reconciliationExpected !== null
      && reconciliationAccepted + reconciliationRejected > reconciliationExpected)
    || !RECONCILIATION_OUTCOMES.has(reconciliation.outcome)
  ) reject();
}

function normalizeInput(input: RecordFinopsSourceSnapshotInput): NormalizedSnapshotInput {
  if (!isRecord(input)) reject();
  const collectedAtIso = normalizedIso(input.collectedAtIso);
  const dataThroughAtIso = normalizedIso(input.dataThroughAtIso);
  if (
    !GENERATION_ID.test(String(input.generationId))
    || !SOURCE_IDS.has(input.sourceId)
    || !JOB_ID.test(String(input.jobId))
    || !Number.isSafeInteger(input.attempt)
    || input.attempt < 1
    || input.attempt > MAX_ATTEMPT
    || !SNAPSHOT_STATUSES.has(input.status)
    || !SHA256.test(String(input.contentSha256))
    || !SCHEMA_VERSION.test(String(input.schemaVersion))
    || collectedAtIso === null
    || dataThroughAtIso === null
    || dataThroughAtIso > collectedAtIso
    || !isRecord(input.evidenceReference)
    || !SEALED_REFERENCE.test(String(input.evidenceReference.ciphertext))
    || !KEY_VERSION.test(String(input.evidenceReference.keyVersion))
  ) reject();
  assertCounts(input.coverage, input.reconciliation);
  if (
    new Set<FinopsSourceSnapshotStatus>(["ready", "complete"]).has(input.status)
    && (
      input.coverage.assessment !== "complete"
      || (input.coverage.missing !== null && input.coverage.missing !== 0)
      || input.reconciliation.outcome !== "matched"
      || input.reconciliation.rejected !== 0
      || (input.reconciliation.expected !== null
        && input.reconciliation.accepted !== input.reconciliation.expected)
    )
  ) reject();
  return { ...input, collectedAtIso, dataThroughAtIso };
}

function terminalAttemptMatches(
  attempt: AttemptRow,
  input: NormalizedSnapshotInput,
): boolean {
  if (
    (attempt.accepted_records !== null
      && safeInteger(attempt.accepted_records, "STORED_STATE_INVALID")
        !== input.reconciliation.accepted)
    || (attempt.rejected_records !== null
      && safeInteger(attempt.rejected_records, "STORED_STATE_INVALID")
        !== input.reconciliation.rejected)
    || (attempt.expected_records !== null
      && safeInteger(attempt.expected_records, "STORED_STATE_INVALID")
        !== input.reconciliation.expected)
  ) return false;
  if (input.status === "ready" || input.status === "complete") {
    return attempt.status === "succeeded"
      && attempt.reconciliation_outcome === "matched";
  }
  if (input.status === "partial") return attempt.status === "partial";
  if (input.status === "failed") {
    return attempt.status === "failed" || attempt.status === "cancelled";
  }
  return attempt.status === "succeeded" || attempt.status === "partial";
}

function baseSnapshot(row: SnapshotRow): RecordFinopsSourceSnapshotResult["snapshot"] {
  const collectedAtIso = normalizedIso(row.collected_at);
  const dataThroughAtIso = normalizedIso(row.data_through_at);
  const createdAt = safeInteger(row.created_at, "STORED_STATE_INVALID");
  if (
    !GENERATION_ID.test(row.generation_id)
    || !IDENTIFIER.test(row.org_id)
    || !IDENTIFIER.test(row.customer_id)
    || !CONNECTION_ID.test(row.connection_id)
    || !SOURCE_IDS.has(row.source_id as FinopsSourceId)
    || !JOB_ID.test(row.job_id)
    || !SNAPSHOT_STATUSES.has(row.status as FinopsSourceSnapshotStatus)
    || !SHA256.test(row.content_sha256)
    || !SCHEMA_VERSION.test(row.schema_version)
    || collectedAtIso === null
    || dataThroughAtIso === null
    || !RECONCILIATION_OUTCOMES.has(
      row.reconciliation_outcome as FinopsSourceSnapshotReconciliationOutcome,
    )
    || !SEALED_REFERENCE.test(row.evidence_reference_ciphertext)
    || !KEY_VERSION.test(row.evidence_reference_key_version)
  ) reject("STORED_STATE_INVALID");
  return {
    scope: {
      organizationId: row.org_id,
      customerId: row.customer_id,
      connectionId: row.connection_id,
    },
    sourceId: row.source_id as FinopsSourceId,
    generationId: row.generation_id,
    jobId: row.job_id,
    attempt: safeInteger(row.attempt, "STORED_STATE_INVALID"),
    status: row.status as FinopsSourceSnapshotStatus,
    contentSha256: row.content_sha256,
    schemaVersion: row.schema_version,
    collectedAtIso,
    dataThroughAtIso,
    coverage: {
      assessment: COVERAGE_ASSESSMENTS.has(
        row.coverage_assessment as "complete" | "partial" | "unknown",
      )
        ? row.coverage_assessment as "complete" | "partial" | "unknown"
        : reject("STORED_STATE_INVALID"),
      expected: nullableSafeInteger(
        row.coverage_expected_records,
        "STORED_STATE_INVALID",
      ),
      observed: safeInteger(row.coverage_observed_records, "STORED_STATE_INVALID"),
      missing: nullableSafeInteger(
        row.coverage_missing_records,
        "STORED_STATE_INVALID",
      ),
    },
    reconciliation: {
      expected: nullableSafeInteger(
        row.reconciliation_expected_records,
        "STORED_STATE_INVALID",
      ),
      accepted: safeInteger(
        row.reconciliation_accepted_records,
        "STORED_STATE_INVALID",
      ),
      rejected: safeInteger(
        row.reconciliation_rejected_records,
        "STORED_STATE_INVALID",
      ),
      outcome: row.reconciliation_outcome as FinopsSourceSnapshotReconciliationOutcome,
    },
    evidenceReference: {
      ciphertext: row.evidence_reference_ciphertext,
      keyVersion: row.evidence_reference_key_version,
    },
    createdAtIso: new Date(createdAt).toISOString(),
  };
}

function activeSnapshot(row: ActiveSnapshotRow): StoredFinopsSourceSnapshot {
  const snapshot = baseSnapshot(row);
  const advancedAt = safeInteger(row.advanced_at, "STORED_STATE_INVALID");
  if (row.active_generation_id !== snapshot.generationId) {
    reject("STORED_STATE_INVALID");
  }
  return {
    ...snapshot,
    activeGenerationId: row.active_generation_id,
    committedAtIso: new Date(advancedAt).toISOString(),
  };
}

function sameSnapshot(
  stored: RecordFinopsSourceSnapshotResult["snapshot"],
  scope: FinopsSourceSnapshotScope,
  input: NormalizedSnapshotInput,
): boolean {
  return stored.scope.organizationId === scope.organizationId
    && stored.scope.customerId === scope.customerId
    && stored.scope.connectionId === scope.connectionId
    && stored.sourceId === input.sourceId
    && stored.generationId === input.generationId
    && stored.jobId === input.jobId
    && stored.attempt === input.attempt
    && stored.status === input.status
    && stored.contentSha256 === input.contentSha256
    && stored.schemaVersion === input.schemaVersion
    && stored.collectedAtIso === input.collectedAtIso
    && stored.dataThroughAtIso === input.dataThroughAtIso
    && stored.coverage.assessment === input.coverage.assessment
    && stored.coverage.expected === input.coverage.expected
    && stored.coverage.observed === input.coverage.observed
    && stored.coverage.missing === input.coverage.missing
    && stored.reconciliation.expected === input.reconciliation.expected
    && stored.reconciliation.accepted === input.reconciliation.accepted
    && stored.reconciliation.rejected === input.reconciliation.rejected
    && stored.reconciliation.outcome === input.reconciliation.outcome
    && stored.evidenceReference.ciphertext === input.evidenceReference.ciphertext
    && stored.evidenceReference.keyVersion === input.evidenceReference.keyVersion;
}

const ACTIVE_COLUMNS = `s.*, h.active_generation_id, h.advanced_at`;
const ACTIVE_FROM = `
  FROM finops_source_snapshot_heads h
  JOIN finops_source_snapshots s
    ON s.org_id = h.org_id
   AND s.customer_id = h.customer_id
   AND s.connection_id = h.connection_id
   AND s.source_id = h.source_id
   AND s.generation_id = h.active_generation_id
  JOIN aws_connections c
    ON c.id = h.connection_id
   AND c.org_id = h.org_id
   AND c.customer_id = h.customer_id
  JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
  JOIN customers cu
    ON cu.id = c.customer_id AND cu.org_id = c.org_id
   AND cu.status = 'active'`;

export class FinopsSourceSnapshotRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  private async assertLiveScope(
    scope: FinopsSourceSnapshotScope,
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

  private async readGeneration(
    database: D1Database,
    scope: FinopsSourceSnapshotScope,
    sourceId: FinopsSourceId,
    generationId: string,
  ): Promise<RecordFinopsSourceSnapshotResult["snapshot"] | null> {
    const row = await database.prepare(
      `SELECT s.*
         FROM finops_source_snapshots s
         JOIN aws_connections c
           ON c.id = s.connection_id AND c.org_id = s.org_id
          AND c.customer_id = s.customer_id
         JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
         JOIN customers cu
           ON cu.id = c.customer_id AND cu.org_id = c.org_id
          AND cu.status = 'active'
        WHERE s.org_id = ? AND s.customer_id = ? AND s.connection_id = ?
          AND s.source_id = ? AND s.generation_id = ?
          AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
        LIMIT 1`,
    ).bind(
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      sourceId,
      generationId,
    ).first<SnapshotRow>();
    return row === null ? null : baseSnapshot(row);
  }

  private async activeGenerationId(
    database: D1Database,
    scope: FinopsSourceSnapshotScope,
    sourceId: FinopsSourceId,
  ): Promise<string | null> {
    const row = await database.prepare(
      `SELECT active_generation_id
         FROM finops_source_snapshot_heads
        WHERE org_id = ? AND customer_id = ? AND connection_id = ?
          AND source_id = ?
        LIMIT 1`,
    ).bind(
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      sourceId,
    ).first<{ active_generation_id: string }>();
    return row?.active_generation_id ?? null;
  }

  public async recordSnapshot(
    scope: FinopsSourceSnapshotScope,
    candidate: RecordFinopsSourceSnapshotInput,
    nowMs = Date.now(),
  ): Promise<RecordFinopsSourceSnapshotResult> {
    const input = normalizeInput(candidate);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) reject();
    const database = await this.assertLiveScope(scope);
    const existing = await this.readGeneration(
      database,
      scope,
      input.sourceId,
      input.generationId,
    );
    if (existing !== null) {
      if (!sameSnapshot(existing, scope, input)) {
        reject("IMMUTABLE_GENERATION_CONFLICT");
      }
      const activeGenerationId = await this.activeGenerationId(
        database,
        scope,
        input.sourceId,
      );
      return {
        snapshot: existing,
        becameActive: false,
        activeGenerationId,
      };
    }

    const previousActiveGenerationId = await this.activeGenerationId(
      database,
      scope,
      input.sourceId,
    );

    const attempt = await database.prepare(
      `SELECT status, accepted_records, rejected_records, expected_records,
              reconciliation_outcome
         FROM finops_source_job_attempts
        WHERE org_id = ? AND customer_id = ? AND connection_id = ?
          AND source_id = ? AND job_id = ? AND attempt = ?
        LIMIT 1`,
    ).bind(
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      input.sourceId,
      input.jobId,
      input.attempt,
    ).first<AttemptRow>();
    if (attempt === null || !terminalAttemptMatches(attempt, input)) {
      reject("ATTEMPT_NOT_ACCEPTED");
    }

    await database.batch([
      database.prepare(
        `INSERT INTO finops_source_snapshots (
           generation_id, org_id, customer_id, connection_id, source_id,
           job_id, attempt, status, content_sha256, schema_version,
           collected_at, data_through_at,
           coverage_assessment, coverage_expected_records, coverage_observed_records,
           coverage_missing_records, reconciliation_expected_records,
           reconciliation_accepted_records, reconciliation_rejected_records,
           reconciliation_outcome, evidence_reference_ciphertext,
           evidence_reference_key_version, created_at
         )
         SELECT ?, c.org_id, c.customer_id, c.id, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           FROM aws_connections c
           JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
           JOIN customers cu
             ON cu.id = c.customer_id AND cu.org_id = c.org_id
            AND cu.status = 'active'
          WHERE c.org_id = ? AND c.customer_id = ? AND c.id = ?
            AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
            AND EXISTS (
              SELECT 1 FROM finops_source_job_attempts a
               WHERE a.org_id = c.org_id AND a.customer_id = c.customer_id
                 AND a.connection_id = c.id AND a.source_id = ?
                 AND a.job_id = ? AND a.attempt = ?
            )
         ON CONFLICT DO NOTHING`,
      ).bind(
        input.generationId,
        input.sourceId,
        input.jobId,
        input.attempt,
        input.status,
        input.contentSha256,
        input.schemaVersion,
        input.collectedAtIso,
        input.dataThroughAtIso,
        input.coverage.assessment,
        input.coverage.expected,
        input.coverage.observed,
        input.coverage.missing,
        input.reconciliation.expected,
        input.reconciliation.accepted,
        input.reconciliation.rejected,
        input.reconciliation.outcome,
        input.evidenceReference.ciphertext,
        input.evidenceReference.keyVersion,
        nowMs,
        scope.organizationId,
        scope.customerId,
        scope.connectionId,
        input.sourceId,
        input.jobId,
        input.attempt,
      ),
      database.prepare(
        `INSERT INTO finops_source_snapshot_heads (
           org_id, customer_id, connection_id, source_id,
           active_generation_id, advanced_at
         )
         SELECT s.org_id, s.customer_id, s.connection_id, s.source_id,
                s.generation_id, ?
           FROM finops_source_snapshots s
          WHERE s.org_id = ? AND s.customer_id = ? AND s.connection_id = ?
            AND s.source_id = ? AND s.generation_id = ?
            AND s.status IN ('ready', 'complete')
            AND s.coverage_assessment = 'complete'
            AND COALESCE(s.coverage_missing_records, 0) = 0
            AND s.reconciliation_outcome = 'matched'
            AND s.reconciliation_rejected_records = 0
            AND (s.reconciliation_expected_records IS NULL
              OR s.reconciliation_accepted_records
                = s.reconciliation_expected_records)
         ON CONFLICT (org_id, customer_id, connection_id, source_id)
         DO UPDATE SET
           active_generation_id = excluded.active_generation_id,
           advanced_at = excluded.advanced_at
         WHERE excluded.active_generation_id
                 <> finops_source_snapshot_heads.active_generation_id
           AND EXISTS (
             SELECT 1
               FROM finops_source_snapshots candidate
               JOIN finops_source_snapshots active
                 ON active.org_id = finops_source_snapshot_heads.org_id
                AND active.customer_id = finops_source_snapshot_heads.customer_id
                AND active.connection_id = finops_source_snapshot_heads.connection_id
                AND active.source_id = finops_source_snapshot_heads.source_id
                AND active.generation_id
                  = finops_source_snapshot_heads.active_generation_id
              WHERE candidate.generation_id = excluded.active_generation_id
                AND candidate.org_id = finops_source_snapshot_heads.org_id
                AND candidate.customer_id = finops_source_snapshot_heads.customer_id
                AND candidate.connection_id
                  = finops_source_snapshot_heads.connection_id
                AND candidate.source_id = finops_source_snapshot_heads.source_id
                AND (
                  candidate.data_through_at > active.data_through_at
                  OR (
                    candidate.data_through_at = active.data_through_at
                    AND candidate.collected_at > active.collected_at
                  )
                )
           )`,
      ).bind(
        nowMs,
        scope.organizationId,
        scope.customerId,
        scope.connectionId,
        input.sourceId,
        input.generationId,
      ),
    ]);

    const stored = await this.readGeneration(
      database,
      scope,
      input.sourceId,
      input.generationId,
    );
    if (stored === null || !sameSnapshot(stored, scope, input)) {
      reject("IMMUTABLE_GENERATION_CONFLICT");
    }
    const activeGenerationId = await this.activeGenerationId(
      database,
      scope,
      input.sourceId,
    );
    return {
      snapshot: stored,
      becameActive: previousActiveGenerationId !== input.generationId
        && activeGenerationId === input.generationId,
      activeGenerationId,
    };
  }

  public async getActiveSnapshot(
    scope: FinopsSourceSnapshotScope,
    sourceId: FinopsSourceId,
  ): Promise<StoredFinopsSourceSnapshot | null> {
    if (!SOURCE_IDS.has(sourceId)) reject();
    const database = await this.assertLiveScope(scope);
    const row = await database.prepare(
      `SELECT ${ACTIVE_COLUMNS}
       ${ACTIVE_FROM}
        WHERE h.org_id = ? AND h.customer_id = ? AND h.connection_id = ?
          AND h.source_id = ?
          AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
        LIMIT 1`,
    ).bind(
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      sourceId,
    ).first<ActiveSnapshotRow>();
    return row === null ? null : activeSnapshot(row);
  }

  /** Latest persisted complete or partial generation; never crosses scope. */
  public async getLatestSnapshot(
    scope: FinopsSourceSnapshotScope,
    sourceId: FinopsSourceId,
  ): Promise<RecordFinopsSourceSnapshotResult["snapshot"] | null> {
    if (!SOURCE_IDS.has(sourceId)) reject();
    const database = await this.assertLiveScope(scope);
    const row = await database.prepare(
      `SELECT s.*
         FROM finops_source_snapshots s
         JOIN finops_source_job_attempts a
           ON a.org_id = s.org_id AND a.customer_id = s.customer_id
          AND a.connection_id = s.connection_id AND a.source_id = s.source_id
          AND a.job_id = s.job_id AND a.attempt = s.attempt
         JOIN aws_connections c
           ON c.id = s.connection_id AND c.org_id = s.org_id
          AND c.customer_id = s.customer_id
         JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
         JOIN customers cu
           ON cu.id = c.customer_id AND cu.org_id = c.org_id
          AND cu.status = 'active'
        WHERE s.org_id = ? AND s.customer_id = ? AND s.connection_id = ?
          AND s.source_id = ?
          AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
        ORDER BY a.queued_at DESC, s.job_id DESC, s.attempt DESC
        LIMIT 1`,
    ).bind(
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      sourceId,
    ).first<SnapshotRow>();
    return row === null ? null : baseSnapshot(row);
  }

  public async listActiveSnapshots(
    scope: FinopsSourceSnapshotScope,
    options: { readonly limit?: number } = {},
  ): Promise<readonly StoredFinopsSourceSnapshot[]> {
    const limit = options.limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      reject();
    }
    const database = await this.assertLiveScope(scope);
    const rows = await database.prepare(
      `SELECT ${ACTIVE_COLUMNS}
       ${ACTIVE_FROM}
        WHERE h.org_id = ? AND h.customer_id = ? AND h.connection_id = ?
          AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
        ORDER BY h.source_id ASC
        LIMIT ?`,
    ).bind(
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      limit,
    ).all<ActiveSnapshotRow>();
    return (rows.results ?? []).map(activeSnapshot);
  }
}
