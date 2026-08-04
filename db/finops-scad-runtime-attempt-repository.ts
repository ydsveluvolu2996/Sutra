/** Durable 31-minute CAS replay ledger for the bounded SCAD CUR2 collector. */
import { getRawDb } from "./index.ts";
import { ensureRuntimeSchema } from "./runtime-migrations.ts";
import type {
  ScadCur2ReplayClaim,
  ScadCur2ReplayStore,
  ScadCur2RuntimeResult,
} from "../lib/finops-scad-durable-runtime-binding.ts";

export const SCAD_CUR2_RUNTIME_LEASE_MS = 1_860_000 as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const JOB = /^job_[a-f0-9]{32}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const SHA = /^[a-f0-9]{64}$/u;
const TOKEN = /^scrtl_[a-f0-9]{32}$/u;
const MAX_RESULT_BYTES = 16 * 1_024;

interface ReplayScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly scheduledWindow: string;
}
interface AttemptRow {
  readonly replay_key: string;
  readonly org_id: string;
  readonly customer_id: string;
  readonly connection_id: string;
  readonly job_id: string;
  readonly scheduled_window: string;
  readonly state: "IN_PROGRESS" | "PERSISTED" | "SUCCEEDED" | "RETRYABLE_FAILED" | "FAILED";
  readonly lease_token: string | null;
  readonly lease_expires_at: number | string | null;
  readonly attempt_count: number | string;
  readonly generation_id: string | null;
  readonly result_json: string | null;
  readonly result_sha256: string | null;
  readonly failure_code: "SCAD_CUR2_RUNTIME_FAILED" | null;
  readonly started_at: number | string;
  readonly completed_at: number | string | null;
  readonly updated_at: number | string;
}

export interface ScadCur2RuntimeAttemptStatus {
  readonly state: AttemptRow["state"];
  readonly scheduledWindow: string;
  readonly attemptCount: number;
  readonly failureCode: AttemptRow["failure_code"];
  readonly updatedAtIso: string;
}

export class ScadCur2RuntimeAttemptRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "LEASE_LOST" | "STORED_STATE_INVALID";
  public constructor(code: ScadCur2RuntimeAttemptRepositoryError["code"]) {
    super("SCAD CUR2 replay persistence rejected");
    this.name = "ScadCur2RuntimeAttemptRepositoryError";
    this.code = code;
  }
}
function reject(code: ScadCur2RuntimeAttemptRepositoryError["code"]): never {
  throw new ScadCur2RuntimeAttemptRepositoryError(code);
}
function integer(value: unknown): number {
  const result = typeof value === "string" ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) reject("STORED_STATE_INVALID");
  return result;
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}
function parseKey(value: string): ReplayScope {
  const parts = value.split(":");
  if (parts.length !== 5 || parts[0] !== "scad-cur2") reject("INVALID_INPUT");
  let organizationId: string; let customerId: string; let connectionId: string; let scheduledWindow: string;
  try {
    organizationId = decodeURIComponent(parts[1]!); customerId = decodeURIComponent(parts[2]!);
    connectionId = decodeURIComponent(parts[3]!); scheduledWindow = decodeURIComponent(parts[4]!);
  } catch { reject("INVALID_INPUT"); }
  if (!IDENTIFIER.test(organizationId) || !IDENTIFIER.test(customerId)
    || !CONNECTION.test(connectionId) || !WINDOW.test(scheduledWindow)
    || value !== `scad-cur2:${[organizationId, customerId, connectionId, scheduledWindow]
      .map(encodeURIComponent).join(":")}`) reject("INVALID_INPUT");
  return { organizationId, customerId, connectionId, scheduledWindow };
}
async function replayKey(value: string): Promise<string> { return `scrq_${await sha256(value)}`; }
async function result(value: AttemptRow): Promise<{ readonly value: ScadCur2RuntimeResult; readonly sha256: string }> {
  if (value.result_json === null || value.result_sha256 === null || !SHA.test(value.result_sha256)
    || Buffer.byteLength(value.result_json, "utf8") > MAX_RESULT_BYTES
    || await sha256(value.result_json) !== value.result_sha256) reject("STORED_STATE_INVALID");
  let parsed: unknown; try { parsed = JSON.parse(value.result_json); } catch { reject("STORED_STATE_INVALID"); }
  const runtime = parsed as ScadCur2RuntimeResult;
  if (runtime.generationId !== value.generation_id) reject("STORED_STATE_INVALID");
  return { value: runtime, sha256: value.result_sha256 };
}

export class ScadCur2RuntimeAttemptRepository implements ScadCur2ReplayStore {
  private readonly database: D1Database; private readonly now: () => number;
  public constructor(database: D1Database = getRawDb(), now: () => number = Date.now) {
    this.database = database; this.now = now;
  }
  private async ready(): Promise<D1Database> { await ensureRuntimeSchema(this.database); return this.database; }
  private async row(key: string): Promise<AttemptRow | null> {
    return (await this.ready()).prepare("SELECT * FROM finops_scad_runtime_attempts WHERE replay_key=? LIMIT 1")
      .bind(key).first<AttemptRow>();
  }
  public async claim(input: { readonly key: string; readonly jobId: string;
    readonly leaseDurationMs: 1_860_000 }): Promise<ScadCur2ReplayClaim> {
    const scope = parseKey(input.key);
    if (!JOB.test(input.jobId) || input.leaseDurationMs !== SCAD_CUR2_RUNTIME_LEASE_MS) reject("INVALID_INPUT");
    const now = this.now(); if (!Number.isSafeInteger(now) || now < 0) reject("INVALID_INPUT");
    const key = await replayKey(input.key); const token = `scrtl_${crypto.randomUUID().replaceAll("-", "")}`;
    const expires = now + SCAD_CUR2_RUNTIME_LEASE_MS; const database = await this.ready();
    await database.prepare(`INSERT INTO finops_scad_runtime_attempts(replay_key,org_id,customer_id,
      connection_id,job_id,scheduled_window,state,lease_token,lease_expires_at,attempt_count,generation_id,result_json,
      result_sha256,failure_code,started_at,completed_at,updated_at)
      SELECT ?,c.org_id,c.customer_id,c.id,?,?,'IN_PROGRESS',?,?,1,NULL,NULL,NULL,NULL,?,NULL,?
      FROM aws_connections c JOIN organizations o ON o.id=c.org_id AND o.status='active'
      JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id AND cu.status IN ('active','trial')
      WHERE c.org_id=? AND c.customer_id=? AND c.id=? AND c.source_kind='aws_trust_role' AND c.status='active'
      ON CONFLICT DO NOTHING`).bind(key, input.jobId, scope.scheduledWindow, token, expires, now, now,
      scope.organizationId, scope.customerId, scope.connectionId).run();
    let stored = await this.row(key);
    if (stored === null || stored.org_id !== scope.organizationId || stored.customer_id !== scope.customerId
      || stored.connection_id !== scope.connectionId || stored.scheduled_window !== scope.scheduledWindow) reject("SCOPE_NOT_FOUND");
    if (stored.state === "SUCCEEDED") {
      const completed = await result(stored);
      return { state: "COMPLETED", result: completed.value, resultSha256: completed.sha256 };
    }
    if (stored.state === "FAILED") reject("LEASE_LOST");
    if (stored.lease_token === token) return { state: "ACQUIRED", leaseToken: token, recoveredResult: null };
    if ((stored.state === "IN_PROGRESS" || stored.state === "PERSISTED")
      && stored.lease_expires_at !== null && integer(stored.lease_expires_at) > now) return { state: "IN_PROGRESS" };
    const preserve = stored.state === "PERSISTED";
    const reclaimed = await database.prepare(`UPDATE finops_scad_runtime_attempts SET job_id=?,
      state=CASE WHEN state='PERSISTED' THEN 'PERSISTED' ELSE 'IN_PROGRESS' END,lease_token=?,lease_expires_at=?,
      attempt_count=attempt_count+1,result_json=CASE WHEN state='PERSISTED' THEN result_json ELSE NULL END,
      generation_id=CASE WHEN state='PERSISTED' THEN generation_id ELSE NULL END,
      result_sha256=CASE WHEN state='PERSISTED' THEN result_sha256 ELSE NULL END,failure_code=NULL,
      started_at=?,completed_at=NULL,updated_at=? WHERE replay_key=? AND org_id=? AND customer_id=?
      AND connection_id=? AND state IN ('IN_PROGRESS','PERSISTED','RETRYABLE_FAILED')
      AND (state='RETRYABLE_FAILED' OR lease_expires_at<=?) AND attempt_count<25`).bind(input.jobId, token,
      expires, now, now, key, scope.organizationId, scope.customerId, scope.connectionId, now).run();
    if ((reclaimed.meta?.changes ?? 0) !== 1) return { state: "IN_PROGRESS" };
    stored = await this.row(key); if (stored === null || stored.lease_token !== token) reject("LEASE_LOST");
    return { state: "ACQUIRED", leaseToken: token,
      recoveredResult: preserve ? (await result(stored)).value : null };
  }
  public async checkpoint(input: { readonly key: string; readonly jobId: string; readonly leaseToken: string;
    readonly result: ScadCur2RuntimeResult; readonly resultSha256: string }): Promise<void> {
    const scope = parseKey(input.key); if (!JOB.test(input.jobId) || !TOKEN.test(input.leaseToken)
      || !SHA.test(input.resultSha256)) reject("INVALID_INPUT");
    const payload = JSON.stringify(input.result); if (Buffer.byteLength(payload, "utf8") > MAX_RESULT_BYTES
      || await sha256(payload) !== input.resultSha256) reject("INVALID_INPUT");
    const now = this.now(); const changed = await (await this.ready()).prepare(`UPDATE finops_scad_runtime_attempts
      SET state='PERSISTED',generation_id=?,result_json=?,result_sha256=?,updated_at=? WHERE replay_key=? AND org_id=?
      AND customer_id=? AND connection_id=? AND job_id=? AND state='IN_PROGRESS' AND lease_token=?
      AND lease_expires_at>=? AND EXISTS(SELECT 1 FROM finops_scad_allocation_snapshots s
        WHERE s.generation_id=? AND s.org_id=? AND s.customer_id=? AND s.connection_id=?)`).bind(
      input.result.generationId, payload, input.resultSha256, now, await replayKey(input.key), scope.organizationId,
      scope.customerId, scope.connectionId, input.jobId, input.leaseToken, now, input.result.generationId,
      scope.organizationId, scope.customerId, scope.connectionId).run();
    if ((changed.meta?.changes ?? 0) !== 1) reject("LEASE_LOST");
  }
  public async complete(input: { readonly key: string; readonly jobId: string; readonly leaseToken: string;
    readonly result: ScadCur2RuntimeResult; readonly resultSha256: string }): Promise<void> {
    const scope = parseKey(input.key); if (!JOB.test(input.jobId) || !TOKEN.test(input.leaseToken)
      || !SHA.test(input.resultSha256)) reject("INVALID_INPUT");
    const payload = JSON.stringify(input.result); if (Buffer.byteLength(payload, "utf8") > MAX_RESULT_BYTES
      || await sha256(payload) !== input.resultSha256) reject("INVALID_INPUT");
    const now = this.now(); const changed = await (await this.ready()).prepare(`UPDATE finops_scad_runtime_attempts
      SET state='SUCCEEDED',lease_token=NULL,lease_expires_at=NULL,generation_id=?,result_json=?,result_sha256=?,failure_code=NULL,
      completed_at=?,updated_at=? WHERE replay_key=? AND org_id=? AND customer_id=? AND connection_id=?
      AND job_id=? AND state IN ('IN_PROGRESS','PERSISTED') AND lease_token=? AND lease_expires_at>=?
      AND (state='IN_PROGRESS' OR (result_json=? AND result_sha256=?))`).bind(
      input.result.generationId, payload, input.resultSha256, now, now, await replayKey(input.key), scope.organizationId, scope.customerId, scope.connectionId,
      input.jobId, input.leaseToken, now, payload, input.resultSha256).run();
    if ((changed.meta?.changes ?? 0) !== 1) reject("LEASE_LOST");
  }
  public async fail(input: { readonly key: string; readonly jobId: string; readonly leaseToken: string;
    readonly failureCode: "SCAD_CUR2_RUNTIME_FAILED"; readonly terminal?: boolean }): Promise<void> {
    const scope = parseKey(input.key); if (!JOB.test(input.jobId) || !TOKEN.test(input.leaseToken)) reject("INVALID_INPUT");
    const now = this.now();
    await (await this.ready()).prepare(`UPDATE finops_scad_runtime_attempts SET state=?,
      lease_token=NULL,lease_expires_at=NULL,generation_id=NULL,result_json=NULL,result_sha256=NULL,failure_code=?,completed_at=?,updated_at=?
      WHERE replay_key=? AND org_id=? AND customer_id=? AND connection_id=? AND job_id=?
      AND state='IN_PROGRESS' AND lease_token=?`).bind(input.terminal === true ? "FAILED" : "RETRYABLE_FAILED",
      input.failureCode, now, now, await replayKey(input.key),
      scope.organizationId, scope.customerId, scope.connectionId, input.jobId, input.leaseToken).run();
  }
  public async latest(scope: Omit<ReplayScope, "scheduledWindow">): Promise<ScadCur2RuntimeAttemptStatus | null> {
    if (!IDENTIFIER.test(scope.organizationId) || !IDENTIFIER.test(scope.customerId)
      || !CONNECTION.test(scope.connectionId)) reject("INVALID_INPUT");
    // Order by scheduled_window, not updated_at/replay_key. replay_key is a SHA-256 digest, so it tiebreaks by
    // hash, and a late write to an older window bumps that row's updated_at ahead of a newer window. Either way a
    // stale SUCCEEDED can mask a newer terminal FAILED and the caller reports READY. The
    // UNIQUE(org_id,customer_id,connection_id,scheduled_window) constraint makes scheduled_window a total order
    // within a scope, so no tiebreak column is needed.
    const row = await (await this.ready()).prepare(`SELECT * FROM finops_scad_runtime_attempts WHERE org_id=?
      AND customer_id=? AND connection_id=? ORDER BY scheduled_window DESC LIMIT 1`)
      .bind(scope.organizationId, scope.customerId, scope.connectionId).first<AttemptRow>();
    if (row === null) return null;
    return { state: row.state, scheduledWindow: row.scheduled_window, attemptCount: integer(row.attempt_count),
      failureCode: row.failure_code, updatedAtIso: new Date(integer(row.updated_at)).toISOString() };
  }
}
