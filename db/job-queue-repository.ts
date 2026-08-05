import { decideNextAttempt } from "../lib/job-queue.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const JOB_ID = /^job_[a-f0-9]{32}$/u;
const JOB_KIND = /^[a-z][a-z0-9.-]{0,63}$/u;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_ERROR_LENGTH = 2_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 512;
const BASE_RETRY_DELAY_MS = 5_000;
// A live AWS inventory request is bounded at 330 seconds. Keep the durable
// queue lease beyond that boundary so a healthy collection cannot be reclaimed
// by another replica while the authenticated broker request is still running.
const LEASE_MS = 7 * 60_000;

export type BackgroundJobStatus = "queued" | "leased" | "succeeded" | "failed" | "dead_letter";

export interface BackgroundJob {
  readonly id: string;
  readonly orgId: string;
  readonly customerId: string | null;
  readonly connectionId: string | null;
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
  id: string; org_id: string; customer_id: string | null; connection_id: string | null; kind: string; payload_json: string;
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

async function deterministicJobId(input: {
  readonly orgId: string;
  readonly customerId: string | null;
  readonly connectionId: string | null;
  readonly kind: string;
  readonly idempotencyKey: string;
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify({
      schema: "sutra.background-job-idempotency.v1",
      ...input,
    })),
  );
  return `job_${[...new Uint8Array(digest)]
    .slice(0, 16)
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")}`;
}

function parseRow(row: JobRow): BackgroundJob {
  let payload: unknown;
  try { payload = JSON.parse(row.payload_json); } catch { payload = { coverage: "unknown", reason: "invalid-stored-payload" }; }
  return {
    id: row.id, orgId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id, kind: row.kind, payload,
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
    readonly orgId: string; readonly customerId: string | null; readonly connectionId?: string | null;
    readonly kind: string; readonly payload: unknown; readonly maxAttempts?: number; readonly runAfter?: number;
    readonly idempotencyKey?: string;
  }, now = Date.now()): Promise<BackgroundJob> {
    if (!IDENTIFIER.test(input.orgId) || (input.customerId !== null && !IDENTIFIER.test(input.customerId)) || !JOB_KIND.test(input.kind)) invalid();
    const connectionId = input.connectionId ?? null;
    // A connection-bound job must also be customer-bound; its ownership is
    // re-verified against the persisted aws_connections row below, never trusted
    // from the caller — the tenant-scoping enforcement point for hosted collection.
    if (connectionId !== null && (!IDENTIFIER.test(connectionId) || input.customerId === null)) invalid();
    const maxAttempts = input.maxAttempts ?? 5;
    const runAfter = input.runAfter ?? now;
    if (
      !Number.isSafeInteger(maxAttempts)
      || maxAttempts < 1
      || maxAttempts > 25
      || !Number.isFinite(runAfter)
      || (
        input.idempotencyKey !== undefined
        && (
          typeof input.idempotencyKey !== "string"
          || input.idempotencyKey.length < 1
          || input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
          || input.idempotencyKey.includes("\0")
        )
      )
    ) invalid();
    let payloadJson: string;
    try { payloadJson = JSON.stringify(input.payload); } catch { invalid(); }
    if (payloadJson === undefined || new TextEncoder().encode(payloadJson).byteLength > MAX_PAYLOAD_BYTES) invalid();
    const db = await this.ready();
    const id = input.idempotencyKey === undefined
      ? `job_${crypto.randomUUID().replaceAll("-", "")}`
      : await deterministicJobId({
          orgId: input.orgId,
          customerId: input.customerId,
          connectionId,
          kind: input.kind,
          idempotencyKey: input.idempotencyKey,
        });
    const insert = input.idempotencyKey === undefined ? "INSERT" : "INSERT OR IGNORE";
    const result = connectionId !== null
      ? await db.prepare(
        `${insert} INTO background_jobs
          (id, org_id, customer_id, connection_id, kind, payload_json, status, attempt, max_attempts, run_after, created_at, updated_at)
         SELECT ?, cn.org_id, cn.customer_id, cn.id, ?, ?, 'queued', 0, ?, ?, ?, ?
           FROM aws_connections cn
           JOIN organizations o ON o.id = cn.org_id AND o.status = 'active'
           JOIN customers c ON c.id = cn.customer_id AND c.org_id = cn.org_id AND c.status IN ('active', 'trial')
          WHERE cn.id = ? AND cn.org_id = ? AND cn.customer_id = ? AND cn.status = 'active'`,
      ).bind(id, input.kind, payloadJson, maxAttempts, runAfter, now, now, connectionId, input.orgId, input.customerId).run()
      : input.customerId === null
      ? await db.prepare(
        `${insert} INTO background_jobs
          (id, org_id, customer_id, kind, payload_json, status, attempt, max_attempts, run_after, created_at, updated_at)
         SELECT ?, o.id, NULL, ?, ?, 'queued', 0, ?, ?, ?, ?
           FROM organizations o WHERE o.id = ? AND o.status = 'active'`,
      ).bind(id, input.kind, payloadJson, maxAttempts, runAfter, now, now, input.orgId).run()
      : await db.prepare(
        `${insert} INTO background_jobs
          (id, org_id, customer_id, kind, payload_json, status, attempt, max_attempts, run_after, created_at, updated_at)
         SELECT ?, c.org_id, c.id, ?, ?, 'queued', 0, ?, ?, ?, ?
           FROM customers c WHERE c.id = ? AND c.org_id = ? AND c.status IN ('active', 'trial')`,
      ).bind(id, input.kind, payloadJson, maxAttempts, runAfter, now, now, input.customerId, input.orgId).run();
    if (Number(result.meta?.changes ?? 0) === 0 && input.idempotencyKey === undefined) {
      throw new JobQueueRepositoryError("SCOPE_NOT_FOUND");
    }
    const stored = await db.prepare(`SELECT * FROM background_jobs WHERE id = ?`).bind(id).first<JobRow>();
    if (stored === null) throw new JobQueueRepositoryError("SCOPE_NOT_FOUND");
    if (
      stored.org_id !== input.orgId
      || stored.customer_id !== input.customerId
      || stored.connection_id !== connectionId
      || stored.kind !== input.kind
      || stored.payload_json !== payloadJson
      || Number(stored.max_attempts) !== maxAttempts
    ) throw new JobQueueRepositoryError("INVALID_STATE");
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

  /**
   * Lease the oldest ready job of a kind across ALL tenants — the entry point
   * for the system worker, which is not scoped to one org. Also reclaims jobs
   * whose lease has expired (a worker died mid-job) so work is never stranded.
   * At-least-once: a reclaimed job's attempt counter advances like any lease.
   */
  public async leaseNext(kind: string, now = Date.now()): Promise<BackgroundJob | null> {
    if (!JOB_KIND.test(kind) || !Number.isFinite(now)) invalid();
    const db = await this.ready();
    const row = await db.prepare(
      `UPDATE background_jobs
          SET status = 'leased', attempt = attempt + 1, lease_expires_at = ?, updated_at = ?
        WHERE id = (
          SELECT id FROM background_jobs
           WHERE kind = ?
             AND (
               (status = 'queued' AND run_after <= ?)
               OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
             )
           ORDER BY run_after ASC, created_at ASC, id ASC LIMIT 1
        ) AND status IN ('queued', 'leased')
       RETURNING *`,
    ).bind(now + LEASE_MS, now, kind, now, now).first<JobRow>();
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

  /**
   * Lease the oldest ready job for ONE tenant connection. Unlike leaseNext (the
   * cross-tenant system drain), this can only ever return a job whose org_id AND
   * connection_id match — the dequeue surface for a per-tenant collector worker.
   * Reclaims expired leases so a died worker's job is never stranded.
   */
  public async leaseConnectionJob(orgId: string, connectionId: string, kind: string, now = Date.now()): Promise<BackgroundJob | null> {
    if (!IDENTIFIER.test(orgId) || !IDENTIFIER.test(connectionId) || !JOB_KIND.test(kind) || !Number.isFinite(now)) invalid();
    const db = await this.ready();
    const row = await db.prepare(
      `UPDATE background_jobs
          SET status = 'leased', attempt = attempt + 1, lease_expires_at = ?, updated_at = ?
        WHERE id = (
          SELECT id FROM background_jobs
           WHERE org_id = ? AND connection_id = ? AND kind = ?
             AND (
               (status = 'queued' AND run_after <= ?)
               OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
             )
           ORDER BY run_after ASC, created_at ASC, id ASC LIMIT 1
        ) AND status IN ('queued', 'leased')
       RETURNING *`,
    ).bind(now + LEASE_MS, now, orgId, connectionId, kind, now, now).first<JobRow>();
    return row === null ? null : parseRow(row);
  }

  public async completeConnectionJob(orgId: string, connectionId: string, id: string, now = Date.now()): Promise<boolean> {
    if (!IDENTIFIER.test(orgId) || !IDENTIFIER.test(connectionId) || !JOB_ID.test(id)) invalid();
    const db = await this.ready();
    const result = await db.prepare(
      `UPDATE background_jobs SET status = 'succeeded', lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND org_id = ? AND connection_id = ? AND status = 'leased'`,
    ).bind(now, id, orgId, connectionId).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }

  public async failConnectionJob(orgId: string, connectionId: string, id: string, error: string, now = Date.now()): Promise<BackgroundJob> {
    if (!IDENTIFIER.test(orgId) || !IDENTIFIER.test(connectionId) || !JOB_ID.test(id) || error.length < 1 || error.length > MAX_ERROR_LENGTH) invalid();
    const db = await this.ready();
    const current = await db.prepare(
      `SELECT * FROM background_jobs WHERE id = ? AND org_id = ? AND connection_id = ? AND status = 'leased' LIMIT 1`,
    ).bind(id, orgId, connectionId).first<JobRow>();
    if (current === null) throw new JobQueueRepositoryError("INVALID_STATE");
    const decision = decideNextAttempt({
      attempt: Number(current.attempt), maxAttempts: Number(current.max_attempts),
      baseDelayMs: BASE_RETRY_DELAY_MS, nowMs: now,
    });
    const terminal = decision.kind === "dead-letter";
    const updated = await db.prepare(
      `UPDATE background_jobs
          SET status = ?, run_after = ?, lease_expires_at = NULL, last_error = ?, updated_at = ?
        WHERE id = ? AND org_id = ? AND connection_id = ? AND status = 'leased'
       RETURNING *`,
    ).bind(terminal ? "dead_letter" : "queued", terminal ? current.run_after : decision.runAfterMs, error, now, id, orgId, connectionId).first<JobRow>();
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
