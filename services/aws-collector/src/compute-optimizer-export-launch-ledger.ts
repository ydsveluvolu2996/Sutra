import { createHash, randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";

import { canonicalJson } from "./canonical-json.js";
import {
  COMPUTE_OPTIMIZER_EXPORT_LAUNCHER_BOUNDS,
  parseComputeOptimizerExportLaunchAttempt,
  type ComputeOptimizerExportLaunchAttempt,
  type ComputeOptimizerExportLaunchExecution,
} from "./compute-optimizer-export-launcher.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const EXECUTION_ID = /^coele_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CLAIM_TOKEN = /^coelc_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const PROVIDER_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DECIMAL_MILLISECONDS = /^(?:0|[1-9]\d{0,15})$/u;
const DEFAULT_LEASE_MS = 3 * 60_000;

export type ComputeOptimizerExportLaunchLedgerState =
  | "PREPARED" | "IN_PROGRESS" | "TERMINAL" | "AMBIGUOUS";

export type ComputeOptimizerExportLaunchPrepareResult =
  | { readonly state: "PREPARED" }
  | { readonly state: "IN_PROGRESS" }
  | { readonly state: "AMBIGUOUS" }
  | { readonly state: "TERMINAL"; readonly execution: ComputeOptimizerExportLaunchExecution };

export type ComputeOptimizerExportLaunchClaimResult =
  | { readonly state: "CLAIMED"; readonly claimToken: string }
  | { readonly state: "IN_PROGRESS" }
  | { readonly state: "AMBIGUOUS" }
  | { readonly state: "TERMINAL"; readonly execution: ComputeOptimizerExportLaunchExecution };

export interface ComputeOptimizerExportLaunchExecutionLedger {
  prepare(input: {
    readonly tenantId: string;
    readonly connectionId: string;
    readonly attempt: ComputeOptimizerExportLaunchAttempt;
    readonly nowMs: number;
  }): Promise<ComputeOptimizerExportLaunchPrepareResult>;
  claim(input: {
    readonly tenantId: string;
    readonly connectionId: string;
    readonly attempt: ComputeOptimizerExportLaunchAttempt;
    readonly nowMs: number;
  }): Promise<ComputeOptimizerExportLaunchClaimResult>;
  complete(input: {
    readonly tenantId: string;
    readonly connectionId: string;
    readonly attempt: ComputeOptimizerExportLaunchAttempt;
    readonly claimToken: string;
    readonly execution: ComputeOptimizerExportLaunchExecution;
    readonly nowMs: number;
  }): Promise<ComputeOptimizerExportLaunchExecution>;
}

export class ComputeOptimizerExportLaunchLedgerError extends Error {
  public constructor(public readonly code:
    | "INVALID_INPUT" | "ACTIVE" | "AMBIGUOUS" | "STORAGE_FAILED") {
    super("Compute Optimizer export launch ledger rejected the operation");
    this.name = "ComputeOptimizerExportLaunchLedgerError";
  }
}

interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: T[]; readonly rowCount?: number | null }>;
}

interface TransactionPool extends Queryable {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}

interface LedgerRow extends Record<string, unknown> {
  tenant_id: string;
  connection_id: string;
  launch_attempt_id: string;
  attempt_content_sha256: string;
  attempt_json: string;
  state: ComputeOptimizerExportLaunchLedgerState;
  claim_token: string | null;
  lease_expires_at: string | number | Date | null;
  execution_json: string | null;
  execution_sha256: string | null;
}

export interface HostedComputeOptimizerExportLaunchLedgerOptions {
  readonly connectionString?: string;
  readonly pool?: TransactionPool;
  readonly leaseMs?: number;
}

export class HostedComputeOptimizerExportLaunchLedger
implements ComputeOptimizerExportLaunchExecutionLedger {
  private readonly pool: TransactionPool;
  private readonly ownsPool: boolean;
  private readonly leaseMs: number;

  public constructor(options: HostedComputeOptimizerExportLaunchLedgerOptions) {
    if (options.pool === undefined &&
        (options.connectionString === undefined || options.connectionString.length === 0)) {
      throw new ComputeOptimizerExportLaunchLedgerError("INVALID_INPUT");
    }
    this.pool = options.pool ?? new pg.Pool({
      connectionString: options.connectionString,
      max: 4,
      idleTimeoutMillis: 30_000,
    });
    this.ownsPool = options.pool === undefined;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 130_000 || this.leaseMs > 600_000) {
      throw new ComputeOptimizerExportLaunchLedgerError("INVALID_INPUT");
    }
  }

  public async ready(): Promise<boolean> {
    try {
      const result = await this.pool.query<{ present: boolean }>(
        "SELECT to_regclass('public.compute_optimizer_export_launch_executions') IS NOT NULL AS present",
      );
      return result.rows[0]?.present === true;
    } catch { return false; }
  }

  public async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  public async prepare(input: {
    readonly tenantId: string; readonly connectionId: string;
    readonly attempt: ComputeOptimizerExportLaunchAttempt; readonly nowMs: number;
  }): Promise<ComputeOptimizerExportLaunchPrepareResult> {
    const boundary = boundaryInput(input);
    return this.transaction(async (client) => {
      await client.query(
        `INSERT INTO compute_optimizer_export_launch_executions
          (tenant_id, connection_id, launch_attempt_id, attempt_content_sha256,
           attempt_json, state, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'PREPARED',$6,$6)
         ON CONFLICT (tenant_id, connection_id, launch_attempt_id) DO NOTHING`,
        [boundary.tenantId, boundary.connectionId, boundary.attempt.launchAttemptId,
          boundary.attempt.contentSha256, boundary.attemptJson, boundary.nowMs],
      );
      const row = await lockRow(client, boundary);
      assertRowBoundary(row, boundary);
      if (row.state === "IN_PROGRESS" && expiryMs(row.lease_expires_at) <= boundary.nowMs) {
        await client.query(
          `UPDATE compute_optimizer_export_launch_executions
              SET state='AMBIGUOUS', claim_token=NULL, lease_expires_at=NULL, updated_at=$4
            WHERE tenant_id=$1 AND connection_id=$2 AND launch_attempt_id=$3
              AND state='IN_PROGRESS'`,
          [boundary.tenantId, boundary.connectionId, boundary.attempt.launchAttemptId, boundary.nowMs],
        );
        return { state: "AMBIGUOUS" };
      }
      return resultFromRow(row, boundary.attempt);
    });
  }

  public async claim(input: {
    readonly tenantId: string; readonly connectionId: string;
    readonly attempt: ComputeOptimizerExportLaunchAttempt; readonly nowMs: number;
  }): Promise<ComputeOptimizerExportLaunchClaimResult> {
    const boundary = boundaryInput(input);
    return this.transaction(async (client) => {
      const row = await lockRow(client, boundary);
      assertRowBoundary(row, boundary);
      if (row.state === "TERMINAL") {
        return { state: "TERMINAL", execution: executionFromRow(row, boundary.attempt) };
      }
      if (row.state === "AMBIGUOUS") return { state: "AMBIGUOUS" };
      if (row.state === "IN_PROGRESS") {
        if (expiryMs(row.lease_expires_at) <= boundary.nowMs) {
          await client.query(
            `UPDATE compute_optimizer_export_launch_executions
                SET state='AMBIGUOUS', claim_token=NULL, lease_expires_at=NULL, updated_at=$4
              WHERE tenant_id=$1 AND connection_id=$2 AND launch_attempt_id=$3
                AND state='IN_PROGRESS'`,
            [boundary.tenantId, boundary.connectionId, boundary.attempt.launchAttemptId, boundary.nowMs],
          );
          return { state: "AMBIGUOUS" };
        }
        return { state: "IN_PROGRESS" };
      }
      if (row.state !== "PREPARED") invalid();
      const claimToken = `coelc_${randomUUID()}`;
      const result = await client.query(
        `UPDATE compute_optimizer_export_launch_executions
            SET state='IN_PROGRESS', claim_token=$4, lease_expires_at=$5, updated_at=$6
          WHERE tenant_id=$1 AND connection_id=$2 AND launch_attempt_id=$3
            AND state='PREPARED'`,
        [boundary.tenantId, boundary.connectionId, boundary.attempt.launchAttemptId,
          claimToken, boundary.nowMs + this.leaseMs, boundary.nowMs],
      );
      if (result.rowCount !== 1) throw new ComputeOptimizerExportLaunchLedgerError("ACTIVE");
      return { state: "CLAIMED", claimToken };
    });
  }

  public async complete(input: {
    readonly tenantId: string; readonly connectionId: string;
    readonly attempt: ComputeOptimizerExportLaunchAttempt; readonly claimToken: string;
    readonly execution: ComputeOptimizerExportLaunchExecution; readonly nowMs: number;
  }): Promise<ComputeOptimizerExportLaunchExecution> {
    const boundary = boundaryInput(input);
    if (!CLAIM_TOKEN.test(input.claimToken)) invalid();
    const execution = validateExecution(boundary.attempt, input.execution);
    const executionJson = canonicalJson(execution);
    const completed = await this.transaction(async (client):
    Promise<ComputeOptimizerExportLaunchExecution | null> => {
      const row = await lockRow(client, boundary);
      assertRowBoundary(row, boundary);
      if (row.state === "TERMINAL") {
        const stored = executionFromRow(row, boundary.attempt);
        if (canonicalJson(stored) !== executionJson) invalid();
        return stored;
      }
      if (row.state !== "IN_PROGRESS" || row.claim_token !== input.claimToken) {
        throw new ComputeOptimizerExportLaunchLedgerError(
          row.state === "AMBIGUOUS" ? "AMBIGUOUS" : "ACTIVE",
        );
      }
      if (expiryMs(row.lease_expires_at) <= boundary.nowMs) {
        await client.query(
          `UPDATE compute_optimizer_export_launch_executions
              SET state='AMBIGUOUS', claim_token=NULL, lease_expires_at=NULL, updated_at=$4
            WHERE tenant_id=$1 AND connection_id=$2 AND launch_attempt_id=$3
              AND state='IN_PROGRESS' AND claim_token=$5`,
          [boundary.tenantId, boundary.connectionId, boundary.attempt.launchAttemptId,
            boundary.nowMs, input.claimToken],
        );
        return null;
      }
      const updated = await client.query(
        `UPDATE compute_optimizer_export_launch_executions
            SET state='TERMINAL', execution_json=$4, execution_sha256=$5,
                claim_token=NULL, lease_expires_at=NULL, updated_at=$6
          WHERE tenant_id=$1 AND connection_id=$2 AND launch_attempt_id=$3
            AND state='IN_PROGRESS' AND claim_token=$7`,
        [boundary.tenantId, boundary.connectionId, boundary.attempt.launchAttemptId,
          executionJson, execution.contentSha256, boundary.nowMs, input.claimToken],
      );
      if (updated.rowCount !== 1) throw new ComputeOptimizerExportLaunchLedgerError("ACTIVE");
      return JSON.parse(executionJson) as ComputeOptimizerExportLaunchExecution;
    });
    if (completed === null) throw new ComputeOptimizerExportLaunchLedgerError("AMBIGUOUS");
    return completed;
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (cause) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (cause instanceof ComputeOptimizerExportLaunchLedgerError) throw cause;
      const failure = new ComputeOptimizerExportLaunchLedgerError("STORAGE_FAILED");
      (failure as { cause?: unknown }).cause = cause;
      throw failure;
    } finally { client.release(); }
  }
}

function boundaryInput(input: {
  readonly tenantId: string; readonly connectionId: string;
  readonly attempt: ComputeOptimizerExportLaunchAttempt; readonly nowMs: number;
}): {
  readonly tenantId: string; readonly connectionId: string;
  readonly attempt: ComputeOptimizerExportLaunchAttempt;
  readonly attemptJson: string; readonly nowMs: number;
} {
  if (!IDENTIFIER.test(input.tenantId) || !CONNECTION_ID.test(input.connectionId) ||
      !Number.isSafeInteger(input.nowMs) || input.nowMs < 0) invalid();
  const attempt = parseComputeOptimizerExportLaunchAttempt(input.attempt);
  if (attempt.scope.orgId !== input.tenantId || attempt.scope.connectionId !== input.connectionId) invalid();
  return { tenantId: input.tenantId, connectionId: input.connectionId, attempt,
    attemptJson: canonicalJson(attempt), nowMs: input.nowMs };
}

async function lockRow(client: Queryable, boundary: ReturnType<typeof boundaryInput>): Promise<LedgerRow> {
  const result = await client.query<LedgerRow>(
    `SELECT tenant_id,connection_id,launch_attempt_id,attempt_content_sha256,
            attempt_json,state,claim_token,lease_expires_at,execution_json,execution_sha256
       FROM compute_optimizer_export_launch_executions
      WHERE tenant_id=$1 AND connection_id=$2 AND launch_attempt_id=$3
      FOR UPDATE`,
    [boundary.tenantId, boundary.connectionId, boundary.attempt.launchAttemptId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ComputeOptimizerExportLaunchLedgerError("STORAGE_FAILED");
  return row;
}

function assertRowBoundary(row: LedgerRow, boundary: ReturnType<typeof boundaryInput>): void {
  if (row.tenant_id !== boundary.tenantId || row.connection_id !== boundary.connectionId ||
      row.launch_attempt_id !== boundary.attempt.launchAttemptId ||
      row.attempt_content_sha256 !== boundary.attempt.contentSha256 ||
      row.attempt_json !== boundary.attemptJson) invalid();
}

function resultFromRow(
  row: LedgerRow,
  attempt: ComputeOptimizerExportLaunchAttempt,
): ComputeOptimizerExportLaunchPrepareResult {
  if (row.state === "TERMINAL") return { state: "TERMINAL", execution: executionFromRow(row, attempt) };
  if (row.state === "PREPARED" || row.state === "IN_PROGRESS" || row.state === "AMBIGUOUS") {
    return { state: row.state };
  }
  return invalid();
}

function executionFromRow(
  row: LedgerRow,
  attempt: ComputeOptimizerExportLaunchAttempt,
): ComputeOptimizerExportLaunchExecution {
  if (row.execution_json === null || row.execution_sha256 === null) invalid();
  let value: unknown;
  try { value = JSON.parse(row.execution_json) as unknown; } catch { return invalid(); }
  const execution = validateExecution(attempt, value);
  if (row.execution_sha256 !== execution.contentSha256 || canonicalJson(execution) !== row.execution_json) invalid();
  return execution;
}

export function validateComputeOptimizerExportLaunchExecution(
  unsafeAttempt: unknown,
  value: unknown,
): ComputeOptimizerExportLaunchExecution {
  return validateExecution(parseComputeOptimizerExportLaunchAttempt(unsafeAttempt), value);
}

function validateExecution(
  attempt: ComputeOptimizerExportLaunchAttempt,
  value: unknown,
): ComputeOptimizerExportLaunchExecution {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const execution = value as Record<string, unknown>;
  if (!exactKeys(execution, ["schemaVersion", "executionId", "contentSha256", "requestBatchId",
    "launchAttemptId", "status", "startedAtIso", "finishedAtIso", "outcomes"]) ||
    execution.schemaVersion !== "sutra.compute-optimizer-export-launch-execution.v1" ||
    execution.requestBatchId !== attempt.requestBatchId ||
    execution.launchAttemptId !== attempt.launchAttemptId ||
    typeof execution.executionId !== "string" || !EXECUTION_ID.test(execution.executionId) ||
    typeof execution.contentSha256 !== "string" || !SHA256.test(execution.contentSha256) ||
    (execution.status !== "COMPLETE" && execution.status !== "PARTIAL") ||
    !canonicalTimestamp(execution.startedAtIso) || !canonicalTimestamp(execution.finishedAtIso) ||
    Date.parse(execution.finishedAtIso) < Date.parse(execution.startedAtIso) ||
    !Array.isArray(execution.outcomes) || execution.outcomes.length !== attempt.targets.length) invalid();
  for (let index = 0; index < attempt.targets.length; index += 1) {
    const target = attempt.targets[index]!;
    const outcome = execution.outcomes[index];
    if (typeof outcome !== "object" || outcome === null || Array.isArray(outcome)) invalid();
    const item = outcome as Record<string, unknown>;
    if (!exactKeys(item, ["targetId", "exportFamily", "operation", "status", "jobId", "bucket",
      "objectKey", "metadataKey", "errorCode"]) || item.targetId !== target.targetId ||
      item.exportFamily !== target.exportFamily || item.operation !== target.operation) invalid();
    if (item.status === "SUCCEEDED") {
      if (typeof item.jobId !== "string" || !PROVIDER_JOB_ID.test(item.jobId) ||
          item.bucket !== target.bucket || typeof item.objectKey !== "string" ||
          typeof item.metadataKey !== "string" || item.errorCode !== null ||
          !item.objectKey.startsWith(`${target.effectivePrefix}${target.region}-`) ||
          !item.objectKey.endsWith(`-${item.jobId}.csv`) ||
          item.metadataKey !== `${item.objectKey.slice(0, -4)}-metadata.json`) invalid();
    } else if (item.status === "FAILED" || item.status === "NOT_ATTEMPTED") {
      if (item.jobId !== null || item.bucket !== null || item.objectKey !== null ||
          item.metadataKey !== null || typeof item.errorCode !== "string" ||
          !new Set(["ABORTED", "ACCESS_DENIED", "CONCURRENT_EXPORT_LIMIT", "DEADLINE_EXCEEDED",
            "ENROLLMENT_REQUIRED", "INVALID_PROVIDER_RESPONSE", "INVALID_REQUEST",
            "PROVIDER_REQUEST_FAILED", "RATE_LIMITED", "SERVICE_UNAVAILABLE"]).has(item.errorCode)) invalid();
    } else invalid();
  }
  const succeeded = (execution.outcomes as Array<{ status: string }>).every(({ status }) => status === "SUCCEEDED");
  if ((execution.status === "COMPLETE") !== succeeded) invalid();
  const body = { schemaVersion: execution.schemaVersion, requestBatchId: execution.requestBatchId,
    launchAttemptId: execution.launchAttemptId, status: execution.status,
    startedAtIso: execution.startedAtIso, finishedAtIso: execution.finishedAtIso,
    outcomes: execution.outcomes };
  const contentSha256 = hash(canonicalJson(body));
  if (execution.contentSha256 !== contentSha256 || execution.executionId !== `coele_${contentSha256}` ||
      Buffer.byteLength(canonicalJson(execution), "utf8") >
        COMPUTE_OPTIMIZER_EXPORT_LAUNCHER_BOUNDS.maximumEnvelopeBytes) invalid();
  return JSON.parse(canonicalJson(execution)) as ComputeOptimizerExportLaunchExecution;
}

function expiryMs(value: LedgerRow["lease_expires_at"]): number {
  const result = value instanceof Date ? value.getTime() : typeof value === "number"
    ? value : typeof value === "string" && DECIMAL_MILLISECONDS.test(value)
      ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(result) || result < 0) invalid();
  return result;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isSafeInteger(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function invalid(): never { throw new ComputeOptimizerExportLaunchLedgerError("INVALID_INPUT"); }
