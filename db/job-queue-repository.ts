import { decideNextAttempt } from "../lib/job-queue.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const JOB_ID = /^job_[a-f0-9]{32}$/u;
const JOB_KIND = /^[a-z][a-z0-9.-]{0,63}$/u;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_ERROR_LENGTH = 2_000;
const BASE_RETRY_DELAY_MS = 5_000;
const LEASE_MS = 60_000;

export type BackgroundJobStatus = "queued" | "leased" | "succeeded" | "failed" | "dead_letter";

export interface BackgroundJob {
  readonly id: string;
  readonly orgId: string;
  readonly customerId: string | null;
  readonly kind: string;
  readonly payload: unknown;
  readonly status: BackgroundJobStatus;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly leaseExpiresAt: number | null;
  readonly runAfter: number;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface JobRow {
  id: string; org_id: string; customer_id: string | null; kind: string; payload_json: string;
  status: BackgroundJobStatus; attempt: number; max_attempts: number; lease_expires_at: number | null;
  run_after: number; last_error: string | null; created_at: number; updated_at: number;
}

export class JobQueueRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "INVALID_STATE";
  public constructor(code: JobQueueRepositoryError["code"]) {
    super("Background job operation rejected");
    this.name = "JobQueueRepositoryError";
    this.code = code;
  }
}

function invalid(): never {
  throw new JobQueueRepositoryError("INVALID_INPUT");
}

function parseRow(row: JobRow): BackgroundJob {
  let payload: unknown;
  try { payload = JSON.parse(row.payload_json); } catch { payload = { coverage: "unknown", reason: "invalid-stored-payload" }; }
  return {
    id: row.id, orgId: row.org_id, customerId: row.customer_id, kind: row.kind, payload,
    status: row.status, attempt: Number(row.attempt), maxAttempts: Number(row.max_attempts),
    leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
    runAfter: Number(row.run_after), lastError: row.last_error,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

export class JobQueueRepository {
  private readonly database: D1Database;
  public constructor(database: D1Database = getRawDb()) { this.database = database; }
  private async ready(): Promise<D1Database> { await ensureRuntimeSchema(this.database); return this.database; }

  public async enqueue(input: {
    readonly orgId: string; readonly customerId: string | null; readonly kind: string;
    readonly payload: unknown; readonly maxAttempts?: number; readonly runAfter?: number;
  }, now = Date.now()): Promise<BackgroundJob> {
    if (!IDENTIFIER.test(input.orgId) || (input.customerId !== null && !IDENTIFIER.test(input.customerId)) || !JOB_KIND.test(input.kind)) invalid();
    const maxAttempts = input.maxAttempts ?? 5;
    const runAfter = input.runAfter ?? now;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 25 || !Number.isFinite(runAfter)) invalid();
    let payloadJson: string;
    try { payloadJson = JSON.stringify(input.payload); } catch { invalid(); }
    if (payloadJson === undefined || new TextEncoder().encode(payloadJson).byteLength > MAX_PAYLOAD_BYTES) invalid();
    const db = await this.ready();
    const id = `job_${crypto.randomUUID().replaceAll("-", "")}`;
    const result = input.customerId === null
      ? await db.prepare(
        `INSERT INTO background_jobs
          (id, org_id, customer_id, kind, payload_json, status, attempt, max_attempts, run_after, created_at, updated_at)
         SELECT ?, o.id, NULL, ?, ?, 'queued', 0, ?, ?, ?, ?
           FROM organizations o WHERE o.id = ? AND o.status = 'active'`,
      ).bind(id, input.kind, payloadJson, maxAttempts, runAfter, now, now, input.orgId).run()
      : await db.prepare(
        `INSERT INTO background_jobs
          (id, org_id, customer_id, kind, payload_json, status, attempt, max_attempts, run_after, created_at, updated_at)
         SELECT ?, c.org_id, c.id, ?, ?, 'queued', 0, ?, ?, ?, ?
           FROM customers c WHERE c.id = ? AND c.org_id = ? AND c.status IN ('active', 'trial')`,
      ).bind(id, input.kind, payloadJson, maxAttempts, runAfter, now, now, input.customerId, input.orgId).run();
    if (Number(result.meta?.changes ?? 0) === 0) throw new JobQueueRepositoryError("SCOPE_NOT_FOUND");
    const stored = await db.prepare(`SELECT * FROM background_jobs WHERE id = ?`).bind(id).first<JobRow>();
    if (stored === null) throw new JobQueueRepositoryError("SCOPE_NOT_FOUND");
    return parseRow(stored);
  }

  public async lease(orgId: string, kind: string, now = Date.now()): Promise<BackgroundJob | null> {
    if (!IDENTIFIER.test(orgId) || !JOB_KIND.test(kind) || !Number.isFinite(now)) invalid();
    const db = await this.ready();
    const row = await db.prepare(
      `UPDATE background_jobs
          SET status = 'leased', attempt = attempt + 1, lease_expires_at = ?, updated_at = ?
        WHERE id = (
          SELECT id FROM background_jobs
           WHERE org_id = ? AND kind = ? AND status = 'queued' AND run_after <= ?
           ORDER BY run_after ASC, created_at ASC, id ASC LIMIT 1
        ) AND status = 'queued'
       RETURNING *`,
    ).bind(now + LEASE_MS, now, orgId, kind, now).first<JobRow>();
    return row === null ? null : parseRow(row);
  }

  public async complete(orgId: string, id: string, now = Date.now()): Promise<boolean> {
    if (!IDENTIFIER.test(orgId) || !JOB_ID.test(id)) invalid();
    const db = await this.ready();
    const result = await db.prepare(
      `UPDATE background_jobs SET status = 'succeeded', lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND org_id = ? AND status = 'leased'`,
    ).bind(now, id, orgId).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }

  public async fail(orgId: string, id: string, error: string, now = Date.now()): Promise<BackgroundJob> {
    if (!IDENTIFIER.test(orgId) || !JOB_ID.test(id) || error.length < 1 || error.length > MAX_ERROR_LENGTH) invalid();
    const db = await this.ready();
    const current = await db.prepare(
      `SELECT * FROM background_jobs WHERE id = ? AND org_id = ? AND status = 'leased' LIMIT 1`,
    ).bind(id, orgId).first<JobRow>();
    if (current === null) throw new JobQueueRepositoryError("INVALID_STATE");
    const decision = decideNextAttempt({
      attempt: Number(current.attempt), maxAttempts: Number(current.max_attempts),
      baseDelayMs: BASE_RETRY_DELAY_MS, nowMs: now,
    });
    const terminal = decision.kind === "dead-letter";
    const updated = await db.prepare(
      `UPDATE background_jobs
          SET status = ?, run_after = ?, lease_expires_at = NULL, last_error = ?, updated_at = ?
        WHERE id = ? AND org_id = ? AND status = 'leased'
       RETURNING *`,
    ).bind(terminal ? "dead_letter" : "queued", terminal ? current.run_after : decision.runAfterMs, error, now, id, orgId).first<JobRow>();
    if (updated === null) throw new JobQueueRepositoryError("INVALID_STATE");
    return parseRow(updated);
  }

  public async list(orgId: string, customerId: string | null, limit = 100): Promise<readonly BackgroundJob[]> {
    if (!IDENTIFIER.test(orgId) || (customerId !== null && !IDENTIFIER.test(customerId)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) invalid();
    const db = await this.ready();
    const rows = customerId === null
      ? await db.prepare(`SELECT * FROM background_jobs WHERE org_id = ? ORDER BY created_at DESC LIMIT ?`).bind(orgId, limit).all<JobRow>()
      : await db.prepare(`SELECT * FROM background_jobs WHERE org_id = ? AND customer_id = ? ORDER BY created_at DESC LIMIT ?`).bind(orgId, customerId, limit).all<JobRow>();
    return (rows.results ?? []).map(parseRow);
  }
}
