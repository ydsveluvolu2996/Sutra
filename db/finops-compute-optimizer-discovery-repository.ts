/**
 * Immutable persistence for read-only Compute Optimizer organization discovery.
 *
 * This repository deliberately has no recommendation rows, export-object
 * binding, S3 location, or API payload parser. Current discovery materializes
 * as partial/unavailable history only and never advances the complete head.
 */
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const RUN_ID = /^cor_[a-f0-9]{64}$/u;
const ACCOUNT_ID = /^[0-9]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,95}$/u;
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,127}$/u;
const SEALED_REFERENCE = /^fsev1\.[A-Za-z0-9_-]{26,8186}$/u;
const MAX_MEMBERS = 1_000;
const MAX_JOBS = 5_000;
const OPERATIONS = new Set([
  "GET_ENROLLMENT_STATUS",
  "GET_ENROLLMENT_STATUSES_FOR_ORGANIZATION",
  "DESCRIBE_RECOMMENDATION_EXPORT_JOBS",
]);

export interface ComputeOptimizerDiscoveryScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface ComputeOptimizerEnrollmentEvidence {
  readonly status: "ACTIVE" | "INACTIVE" | "PENDING" | "FAILED";
  readonly reasonCode: string | null;
  readonly memberAccountsEnrolled: boolean | null;
  readonly numberOfMemberAccountsOptedIn: number | null;
  readonly lastUpdatedAt: string | null;
}

export interface ComputeOptimizerMemberEvidence {
  readonly accountId: string;
  readonly status: ComputeOptimizerEnrollmentEvidence["status"];
  readonly reasonCode: string | null;
  readonly lastUpdatedAt: string | null;
}

export interface ComputeOptimizerExportJobEvidence {
  readonly jobId: string;
  readonly resourceType: string;
  readonly status: "QUEUED" | "IN_PROGRESS" | "COMPLETE" | "FAILED";
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly failureCode: string | null;
  /** Hashes only. Raw bucket names and object keys are not accepted. */
  readonly destination: {
    readonly bucketSha256: string | null;
    readonly objectKeySha256: string | null;
    readonly metadataKeySha256: string | null;
  };
}

export interface ComputeOptimizerCoverageEvidence {
  readonly operation: "GET_ENROLLMENT_STATUS" | "GET_ENROLLMENT_STATUSES_FOR_ORGANIZATION" | "DESCRIBE_RECOMMENDATION_EXPORT_JOBS";
  readonly status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  readonly pagesObserved: number;
  readonly recordsObserved: number;
  readonly recordsAccepted: number;
  readonly recordsRejected: number;
  readonly recordsOmitted: number;
  readonly errorCode: string | null;
}

export interface ComputeOptimizerDiscoveryHashInput {
  readonly accountId: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly region: string;
  readonly status: "partial" | "unavailable";
  readonly collectedAt: string;
  readonly dataThroughAt: string | null;
  readonly enrollment: ComputeOptimizerEnrollmentEvidence | null;
  readonly memberEnrollments: readonly ComputeOptimizerMemberEvidence[];
  readonly exportJobs: readonly ComputeOptimizerExportJobEvidence[];
  readonly coverage: readonly ComputeOptimizerCoverageEvidence[];
  readonly errorCode: string;
  readonly limitations: readonly string[];
  readonly evidenceReference: { readonly ciphertext: string; readonly keyVersion: string };
}

export interface RecordComputeOptimizerDiscoveryInput extends ComputeOptimizerDiscoveryHashInput {
  readonly contentSha256: string;
}

export interface StoredComputeOptimizerDiscoveryRun {
  readonly scope: ComputeOptimizerDiscoveryScope;
  readonly runId: string;
  readonly jobId: string;
  readonly status: "pending" | "running" | "complete" | "partial" | "unavailable";
  readonly contentSha256: string | null;
  readonly collectedAt: string | null;
  readonly dataThroughAt: string | null;
  readonly accountId: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly region: string;
  readonly memberCount: number;
  readonly exportJobCount: number;
  readonly coverageCount: number;
  readonly errorCode: string | null;
  readonly limitations: readonly string[];
  readonly createdAtIso: string;
  readonly startedAtIso: string | null;
  readonly finalizedAtIso: string | null;
}

export class ComputeOptimizerDiscoveryRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "CHECKSUM_MISMATCH" | "IMMUTABLE_CONFLICT" | "INVALID_TRANSITION" | "STORED_STATE_INVALID";
  public constructor(code: ComputeOptimizerDiscoveryRepositoryError["code"]) {
    super("Compute Optimizer discovery persistence operation rejected");
    this.name = "ComputeOptimizerDiscoveryRepositoryError";
    this.code = code;
  }
}

interface RunRow {
  run_id: string; org_id: string; customer_id: string; connection_id: string; job_id: string;
  account_id: string; partition: "aws" | "aws-us-gov" | "aws-cn"; region: string;
  status: StoredComputeOptimizerDiscoveryRun["status"]; content_sha256: string | null;
  collected_at: string | null; data_through_at: string | null; member_count: number | string;
  export_job_count: number | string; coverage_count: number | string; error_code: string | null;
  limitations_json: string | null; created_at: number | string; started_at: number | string | null;
  finalized_at: number | string | null;
}

function reject(code: ComputeOptimizerDiscoveryRepositoryError["code"] = "INVALID_INPUT"): never {
  throw new ComputeOptimizerDiscoveryRepositoryError(code);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function safeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER, stored = false): number {
  const candidate = typeof value === "string" ? Number(value) : value;
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0 || candidate > maximum) {
    reject(stored ? "STORED_STATE_INVALID" : "INVALID_INPUT");
  }
  return candidate;
}

function iso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

function assertScope(scope: ComputeOptimizerDiscoveryScope): void {
  if (!IDENTIFIER.test(scope.organizationId) || !IDENTIFIER.test(scope.customerId) || !CONNECTION_ID.test(scope.connectionId)) reject();
}

function canonicalize(input: ComputeOptimizerDiscoveryHashInput): ComputeOptimizerDiscoveryHashInput {
  const collectedAt = iso(input.collectedAt);
  const dataThroughAt = input.dataThroughAt === null ? null : iso(input.dataThroughAt);
  if (
    !ACCOUNT_ID.test(input.accountId) || !REGION.test(input.region)
    || !new Set(["aws", "aws-us-gov", "aws-cn"]).has(input.partition)
    || !new Set(["partial", "unavailable"]).has(input.status)
    || collectedAt === null || (input.dataThroughAt !== null && dataThroughAt === null)
    || (dataThroughAt !== null && dataThroughAt > collectedAt)
    || !SAFE_CODE.test(input.errorCode)
    || !SEALED_REFERENCE.test(input.evidenceReference.ciphertext)
    || !SAFE_VALUE.test(input.evidenceReference.keyVersion)
  ) reject();

  const limitations = [...new Set(input.limitations)].sort();
  if (limitations.length < 1 || limitations.some((value) => !SAFE_CODE.test(value))) reject();
  const members = [...input.memberEnrollments].sort((left, right) => left.accountId.localeCompare(right.accountId));
  if (members.length > MAX_MEMBERS || new Set(members.map(({ accountId }) => accountId)).size !== members.length) reject();
  for (const member of members) {
    if (!ACCOUNT_ID.test(member.accountId) || !new Set(["ACTIVE", "INACTIVE", "PENDING", "FAILED"]).has(member.status)
      || (member.reasonCode !== null && !SAFE_CODE.test(member.reasonCode))
      || (member.lastUpdatedAt !== null && iso(member.lastUpdatedAt) === null)) reject();
  }
  const jobs = [...input.exportJobs].sort((left, right) => left.jobId.localeCompare(right.jobId));
  if (jobs.length > MAX_JOBS || new Set(jobs.map(({ jobId }) => jobId)).size !== jobs.length) reject();
  for (const job of jobs) {
    const createdAt = iso(job.createdAt);
    const lastUpdatedAt = iso(job.lastUpdatedAt);
    if (!SAFE_VALUE.test(job.jobId) || !SAFE_VALUE.test(job.resourceType)
      || !new Set(["QUEUED", "IN_PROGRESS", "COMPLETE", "FAILED"]).has(job.status)
      || createdAt === null || lastUpdatedAt === null || lastUpdatedAt < createdAt
      || (job.failureCode !== null && !SAFE_CODE.test(job.failureCode))
      || Object.values(job.destination).some((hash) => hash !== null && !SHA256.test(hash))) reject();
  }
  const coverage = [...input.coverage].sort((left, right) => left.operation.localeCompare(right.operation));
  if (coverage.length < 1 || coverage.length > 3 || new Set(coverage.map(({ operation }) => operation)).size !== coverage.length) reject();
  for (const entry of coverage) {
    if (!OPERATIONS.has(entry.operation) || !new Set(["SUCCEEDED", "PARTIAL", "FAILED"]).has(entry.status)
      || ![entry.pagesObserved, entry.recordsObserved, entry.recordsAccepted, entry.recordsRejected, entry.recordsOmitted]
        .every((count) => Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000_000)
      || entry.pagesObserved > 10 || (entry.errorCode !== null && !SAFE_CODE.test(entry.errorCode))) reject();
  }
  if (input.enrollment !== null) {
    const enrollment = input.enrollment;
    if (!new Set(["ACTIVE", "INACTIVE", "PENDING", "FAILED"]).has(enrollment.status)
      || (enrollment.reasonCode !== null && !SAFE_CODE.test(enrollment.reasonCode))
      || (enrollment.numberOfMemberAccountsOptedIn !== null && safeInteger(enrollment.numberOfMemberAccountsOptedIn, 1_000_000_000) < 0)
      || (enrollment.lastUpdatedAt !== null && iso(enrollment.lastUpdatedAt) === null)) reject();
  }
  if (input.status === "unavailable" && (input.enrollment !== null || members.length !== 0 || jobs.length !== 0)) reject();
  return {
    accountId: input.accountId,
    partition: input.partition,
    region: input.region,
    status: input.status,
    collectedAt,
    dataThroughAt,
    enrollment: input.enrollment === null ? null : {
      ...input.enrollment,
      lastUpdatedAt: input.enrollment.lastUpdatedAt === null ? null : iso(input.enrollment.lastUpdatedAt),
    },
    memberEnrollments: members.map((member) => ({
      ...member,
      lastUpdatedAt: member.lastUpdatedAt === null ? null : iso(member.lastUpdatedAt),
    })),
    exportJobs: jobs.map((job) => ({
      ...job,
      createdAt: iso(job.createdAt)!,
      lastUpdatedAt: iso(job.lastUpdatedAt)!,
      destination: { ...job.destination },
    })),
    coverage,
    errorCode: input.errorCode,
    limitations,
    evidenceReference: { ...input.evidenceReference },
  };
}

export async function computeOptimizerDiscoverySha256(
  scope: ComputeOptimizerDiscoveryScope,
  input: ComputeOptimizerDiscoveryHashInput,
): Promise<string> {
  assertScope(scope);
  return sha256(JSON.stringify({ scope, evidence: canonicalize(input) }));
}

function storedRun(row: RunRow): StoredComputeOptimizerDiscoveryRun {
  let limitations: unknown = [];
  if (row.limitations_json !== null) {
    try { limitations = JSON.parse(row.limitations_json); } catch { reject("STORED_STATE_INVALID"); }
  }
  if (!Array.isArray(limitations) || limitations.some((value) => typeof value !== "string")) reject("STORED_STATE_INVALID");
  const createdAt = safeInteger(row.created_at, Number.MAX_SAFE_INTEGER, true);
  const startedAt = row.started_at === null ? null : safeInteger(row.started_at, Number.MAX_SAFE_INTEGER, true);
  const finalizedAt = row.finalized_at === null ? null : safeInteger(row.finalized_at, Number.MAX_SAFE_INTEGER, true);
  return {
    scope: { organizationId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id },
    runId: row.run_id, jobId: row.job_id, status: row.status, contentSha256: row.content_sha256,
    collectedAt: row.collected_at, dataThroughAt: row.data_through_at, accountId: row.account_id,
    partition: row.partition, region: row.region,
    memberCount: safeInteger(row.member_count, MAX_MEMBERS, true),
    exportJobCount: safeInteger(row.export_job_count, MAX_JOBS, true),
    coverageCount: safeInteger(row.coverage_count, 3, true), errorCode: row.error_code,
    limitations, createdAtIso: new Date(createdAt).toISOString(),
    startedAtIso: startedAt === null ? null : new Date(startedAt).toISOString(),
    finalizedAtIso: finalizedAt === null ? null : new Date(finalizedAt).toISOString(),
  };
}

export class ComputeOptimizerDiscoveryRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> { await ensureRuntimeSchema(this.database); return this.database; }

  private async assertLiveScope(
    scope: ComputeOptimizerDiscoveryScope,
    expected?: { readonly accountId: string; readonly partition: string },
  ): Promise<D1Database> {
    assertScope(scope);
    const database = await this.ready();
    const row = await database.prepare(
      `SELECT c.id, c.aws_account_id, c.partition FROM aws_connections c
       JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
       JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id AND cu.status = 'active'
       WHERE c.org_id = ? AND c.customer_id = ? AND c.id = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active' LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId)
      .first<{ id: string; aws_account_id: string; partition: string }>();
    if (row === null || (expected !== undefined
      && (row.aws_account_id !== expected.accountId || row.partition !== expected.partition))) reject("SCOPE_NOT_FOUND");
    return database;
  }

  private async read(database: D1Database, scope: ComputeOptimizerDiscoveryScope, runId: string): Promise<StoredComputeOptimizerDiscoveryRun | null> {
    const row = await database.prepare(
      `SELECT * FROM finops_co_discovery_runs WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND run_id = ? LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId, runId).first<RunRow>();
    return row === null ? null : storedRun(row);
  }

  public async createRun(scope: ComputeOptimizerDiscoveryScope, input: {
    readonly jobId: string; readonly accountId: string; readonly partition: "aws" | "aws-us-gov" | "aws-cn"; readonly region: string;
  }, nowMs = Date.now()): Promise<StoredComputeOptimizerDiscoveryRun> {
    if (!IDENTIFIER.test(input.jobId) || !ACCOUNT_ID.test(input.accountId) || !REGION.test(input.region)
      || !new Set(["aws", "aws-us-gov", "aws-cn"]).has(input.partition) || !Number.isSafeInteger(nowMs) || nowMs < 0) reject();
    const database = await this.assertLiveScope(scope, input);
    const runId = `cor_${await sha256(JSON.stringify({ scope, jobId: input.jobId }))}`;
    const prior = await this.read(database, scope, runId);
    if (prior !== null) {
      if (prior.accountId !== input.accountId || prior.partition !== input.partition || prior.region !== input.region) reject("IMMUTABLE_CONFLICT");
      return prior;
    }
    try {
      await database.prepare(
        `INSERT INTO finops_co_discovery_runs
         (run_id, org_id, customer_id, connection_id, job_id, account_id, partition, region, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      ).bind(runId, scope.organizationId, scope.customerId, scope.connectionId, input.jobId, input.accountId, input.partition, input.region, nowMs).run();
    } catch {
      const raced = await this.read(database, scope, runId);
      if (raced !== null && raced.accountId === input.accountId && raced.partition === input.partition && raced.region === input.region) return raced;
      reject("IMMUTABLE_CONFLICT");
    }
    return await this.read(database, scope, runId) ?? reject("STORED_STATE_INVALID");
  }

  public async startRun(scope: ComputeOptimizerDiscoveryScope, runId: string, nowMs = Date.now()): Promise<StoredComputeOptimizerDiscoveryRun> {
    if (!RUN_ID.test(runId) || !Number.isSafeInteger(nowMs) || nowMs < 0) reject();
    const database = await this.assertLiveScope(scope);
    await database.prepare(
      `UPDATE finops_co_discovery_runs SET status = 'running', started_at = ?
       WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND run_id = ? AND status = 'pending'`,
    ).bind(nowMs, scope.organizationId, scope.customerId, scope.connectionId, runId).run();
    const stored = await this.read(database, scope, runId);
    if (stored === null || stored.status !== "running") reject("INVALID_TRANSITION");
    return stored;
  }

  public async recordDiscovery(scope: ComputeOptimizerDiscoveryScope, runId: string, input: RecordComputeOptimizerDiscoveryInput, nowMs = Date.now()): Promise<StoredComputeOptimizerDiscoveryRun> {
    if (!RUN_ID.test(runId) || !SHA256.test(input.contentSha256) || !Number.isSafeInteger(nowMs) || nowMs < 0) reject();
    const normalized = canonicalize(input);
    if (await computeOptimizerDiscoverySha256(scope, normalized) !== input.contentSha256) reject("CHECKSUM_MISMATCH");
    const database = await this.assertLiveScope(scope);
    const current = await this.read(database, scope, runId);
    if (current === null) reject("INVALID_TRANSITION");
    if (current.status === "partial" || current.status === "unavailable") {
      if (current.contentSha256 !== input.contentSha256) reject("IMMUTABLE_CONFLICT");
      return current;
    }
    if (current.status !== "running" || current.accountId !== input.accountId || current.partition !== input.partition || current.region !== input.region) reject("INVALID_TRANSITION");

    const statements: D1PreparedStatement[] = [];
    for (const member of normalized.memberEnrollments) statements.push(database.prepare(
      `INSERT INTO finops_co_member_enrollments (run_id, account_id, status, reason_code, last_updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).bind(runId, member.accountId, member.status, member.reasonCode, member.lastUpdatedAt === null ? null : iso(member.lastUpdatedAt)));
    for (const job of normalized.exportJobs) statements.push(database.prepare(
      `INSERT INTO finops_co_export_jobs
       (run_id, job_id, resource_type, status, created_at_iso, last_updated_at_iso, failure_code, bucket_sha256, object_key_sha256, metadata_key_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(runId, job.jobId, job.resourceType, job.status, iso(job.createdAt), iso(job.lastUpdatedAt), job.failureCode,
      job.destination.bucketSha256, job.destination.objectKeySha256, job.destination.metadataKeySha256));
    for (const entry of normalized.coverage) statements.push(database.prepare(
      `INSERT INTO finops_co_discovery_coverage
       (run_id, operation, status, pages_observed, records_observed, records_accepted, records_rejected, records_omitted, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(runId, entry.operation, entry.status, entry.pagesObserved, entry.recordsObserved, entry.recordsAccepted,
      entry.recordsRejected, entry.recordsOmitted, entry.errorCode));
    statements.push(database.prepare(
      `UPDATE finops_co_discovery_runs SET status = ?, content_sha256 = ?, collected_at = ?, data_through_at = ?,
       enrollment_status = ?, enrollment_reason_code = ?, member_accounts_enrolled = ?, number_of_member_accounts_opted_in = ?,
       enrollment_last_updated_at = ?, member_count = ?, export_job_count = ?, coverage_count = ?, error_code = ?,
       limitations_json = ?, evidence_reference_ciphertext = ?, evidence_reference_key_version = ?, finalized_at = ?
       WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND run_id = ? AND status = 'running'`,
    ).bind(normalized.status, input.contentSha256, normalized.collectedAt, normalized.dataThroughAt,
      normalized.enrollment?.status ?? null, normalized.enrollment?.reasonCode ?? null,
      normalized.enrollment?.memberAccountsEnrolled === undefined || normalized.enrollment?.memberAccountsEnrolled === null
        ? null : normalized.enrollment.memberAccountsEnrolled ? 1 : 0,
      normalized.enrollment?.numberOfMemberAccountsOptedIn ?? null,
      normalized.enrollment?.lastUpdatedAt === null || normalized.enrollment?.lastUpdatedAt === undefined ? null : iso(normalized.enrollment.lastUpdatedAt),
      normalized.memberEnrollments.length, normalized.exportJobs.length, normalized.coverage.length,
      normalized.errorCode, JSON.stringify(normalized.limitations), normalized.evidenceReference.ciphertext,
      normalized.evidenceReference.keyVersion, nowMs, scope.organizationId, scope.customerId, scope.connectionId, runId));
    try { await database.batch(statements); } catch { reject("IMMUTABLE_CONFLICT"); }
    return await this.read(database, scope, runId) ?? reject("STORED_STATE_INVALID");
  }

  public async getRun(scope: ComputeOptimizerDiscoveryScope, runId: string): Promise<StoredComputeOptimizerDiscoveryRun | null> {
    if (!RUN_ID.test(runId)) reject();
    const database = await this.assertLiveScope(scope);
    return this.read(database, scope, runId);
  }

  public async listHistory(scope: ComputeOptimizerDiscoveryScope, limit = 12): Promise<readonly StoredComputeOptimizerDiscoveryRun[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 36) reject();
    const database = await this.assertLiveScope(scope);
    const rows = await database.prepare(
      `SELECT * FROM finops_co_discovery_runs WHERE org_id = ? AND customer_id = ? AND connection_id = ?
       AND status IN ('complete','partial','unavailable') ORDER BY finalized_at DESC, run_id DESC LIMIT ?`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId, limit).all<RunRow>();
    return (rows.results ?? []).map(storedRun);
  }

  public async getActiveComplete(scope: ComputeOptimizerDiscoveryScope): Promise<StoredComputeOptimizerDiscoveryRun | null> {
    const database = await this.assertLiveScope(scope);
    const row = await database.prepare(
      `SELECT r.* FROM finops_co_discovery_heads h JOIN finops_co_discovery_runs r ON r.run_id = h.active_run_id
       WHERE h.org_id = ? AND h.customer_id = ? AND h.connection_id = ? AND r.status = 'complete' LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId).first<RunRow>();
    return row === null ? null : storedRun(row);
  }
}
