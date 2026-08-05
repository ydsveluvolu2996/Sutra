/** Immutable durable-attempt ledger for the ADV-08 signed broker handler. */
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import type {
  AwsBudgetsDurableAttempt,
  AwsBudgetsDurableAttemptStore,
  AwsBudgetsDurableFailureCode,
} from "../lib/finops-aws-budgets-durable-binding.ts";
import type { AwsBudgetsScope } from "../lib/finops-aws-budgets-organization.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u;
const REQUEST = /^abr_[a-f0-9]{64}$/u;
const EXECUTION = /^abe_[a-f0-9]{64}$/u;
const JOB = /^job_[a-f0-9]{32}$/u;
const GENERATION = /^abg_[a-f0-9]{64}$/u;
const CAPTURE = /^awsbudgets_[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/u;
const MAX_HISTORY = 100;
const STATES = ["ready", "partial", "configuration_required", "unavailable", "failed"] as const;
const FAILURE_CODES = [
  "BROKER_AUTHENTICATION_FAILED", "BROKER_TIMEOUT", "BROKER_UNAVAILABLE",
  "BROKER_RESPONSE_INVALID", "SCOPE_REJECTED", "EVIDENCE_REJECTED",
  "PERSISTENCE_REJECTED", "INTERNAL_ERROR",
] as const;

interface AttemptRow {
  execution_id: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  account_id: string;
  partition: AwsBudgetsScope["partition"];
  request_id: string;
  job_id: string;
  job_attempt: number | string;
  scheduled_window: string;
  state: AwsBudgetsDurableAttempt["state"];
  generation_id: string | null;
  capture_id: string | null;
  hierarchy_evidence_id: string | null;
  request_body_sha256: string | null;
  response_body_sha256: string | null;
  broker_key_id: string | null;
  failure_code: AwsBudgetsDurableFailureCode | null;
  content_sha256: string;
  completed_at: number | string;
  created_at: number | string;
}

export interface StoredAwsBudgetsDurableAttempt extends AwsBudgetsDurableAttempt {
  readonly executionId: string;
  readonly scope: AwsBudgetsScope;
  readonly jobId: string;
  readonly scheduledWindow: string;
  readonly hierarchyEvidenceId: string | null;
  readonly requestBodySha256: string | null;
  readonly responseBodySha256: string | null;
  readonly brokerKeyId: string | null;
  readonly contentSha256: string;
  readonly completedAtIso: string;
  readonly createdAtIso: string;
}

export class AwsBudgetsDurableAttemptRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "IMMUTABLE_CONFLICT" | "STORED_STATE_INVALID";

  public constructor(code: AwsBudgetsDurableAttemptRepositoryError["code"]) {
    super("AWS Budgets durable attempt persistence rejected");
    this.name = "AwsBudgetsDurableAttemptRepositoryError";
    this.code = code;
  }
}

function reject(code: AwsBudgetsDurableAttemptRepositoryError["code"] = "INVALID_INPUT"): never {
  throw new AwsBudgetsDurableAttemptRepositoryError(code);
}

function validScope(scope: AwsBudgetsScope): boolean {
  return ID.test(scope.orgId) && ID.test(scope.customerId) && CONNECTION.test(scope.connectionId)
    && ACCOUNT.test(scope.accountId) && ["aws", "aws-us-gov", "aws-cn"].includes(scope.partition);
}

function integer(value: number | string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0) reject("STORED_STATE_INVALID");
  return parsed;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function rowPayload(row: Omit<AttemptRow, "execution_id" | "content_sha256" | "created_at">): string {
  return JSON.stringify({
    schemaVersion: "sutra.aws-budgets-durable-attempt.v1",
    scope: {
      orgId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id,
      accountId: row.account_id, partition: row.partition,
    },
    requestId: row.request_id, jobId: row.job_id, jobAttempt: Number(row.job_attempt),
    scheduledWindow: row.scheduled_window, state: row.state,
    generationId: row.generation_id, captureId: row.capture_id,
    hierarchyEvidenceId: row.hierarchy_evidence_id,
    requestBodySha256: row.request_body_sha256,
    responseBodySha256: row.response_body_sha256,
    brokerKeyId: row.broker_key_id, failureCode: row.failure_code,
    completedAtMs: Number(row.completed_at),
  });
}

async function materialize(row: AttemptRow): Promise<StoredAwsBudgetsDurableAttempt> {
  if (!EXECUTION.test(row.execution_id) || !REQUEST.test(row.request_id) || !JOB.test(row.job_id)
    || !SHA.test(row.content_sha256) || !validScope({
      orgId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id,
      accountId: row.account_id, partition: row.partition,
    })) reject("STORED_STATE_INVALID");
  const attempt = integer(row.job_attempt);
  const completedAt = integer(row.completed_at);
  const createdAt = integer(row.created_at);
  const succeeded = row.state !== "failed";
  if (attempt < 1 || !WINDOW.test(row.scheduled_window) || !STATES.includes(row.state)
    || (row.hierarchy_evidence_id !== null && !ID.test(row.hierarchy_evidence_id))
    || (row.request_body_sha256 !== null && !SHA.test(row.request_body_sha256))
    || (succeeded && (
      row.generation_id === null || !GENERATION.test(row.generation_id)
      || row.capture_id === null || !CAPTURE.test(row.capture_id)
      || row.request_body_sha256 === null || !SHA.test(row.request_body_sha256)
      || row.response_body_sha256 === null || !SHA.test(row.response_body_sha256)
      || row.broker_key_id === null || !KEY_ID.test(row.broker_key_id)
      || row.failure_code !== null || (row.state === "ready" && row.hierarchy_evidence_id === null)
    )) || (!succeeded && (
      row.generation_id !== null || row.capture_id !== null || row.failure_code === null
      || !FAILURE_CODES.includes(row.failure_code) || row.hierarchy_evidence_id !== null
      || row.response_body_sha256 !== null || row.broker_key_id !== null
    ))) reject("STORED_STATE_INVALID");
  const payload = rowPayload(row);
  const contentSha256 = await sha256(payload);
  if (contentSha256 !== row.content_sha256 || row.execution_id !== `abe_${contentSha256}`) {
    reject("STORED_STATE_INVALID");
  }
  return {
    executionId: row.execution_id,
    scope: {
      orgId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id,
      accountId: row.account_id, partition: row.partition,
    },
    requestId: row.request_id, jobId: row.job_id, jobAttempt: attempt,
    scheduledWindow: row.scheduled_window, state: row.state,
    generationId: row.generation_id, captureId: row.capture_id,
    hierarchyEvidenceId: row.hierarchy_evidence_id,
    requestBodySha256: row.request_body_sha256,
    responseBodySha256: row.response_body_sha256,
    brokerKeyId: row.broker_key_id, failureCode: row.failure_code,
    contentSha256, completedAtIso: new Date(completedAt).toISOString(),
    createdAtIso: new Date(createdAt).toISOString(),
  };
}

const LIVE_SCOPE = `
  JOIN aws_connections c ON c.id = e.connection_id AND c.org_id = e.org_id
    AND c.customer_id = e.customer_id AND c.aws_account_id = e.account_id
    AND c.partition = e.partition AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
  JOIN organizations o ON o.id = e.org_id AND o.status = 'active'
  JOIN customers cu ON cu.id = e.customer_id AND cu.org_id = e.org_id
    AND cu.status IN ('active','trial')`;

export class AwsBudgetsDurableAttemptRepository implements AwsBudgetsDurableAttemptStore {
  public constructor(private readonly database: D1Database = getRawDb()) {}

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  public async getAttempt(
    scope: AwsBudgetsScope,
    requestId: string,
    jobAttempt: number,
  ): Promise<StoredAwsBudgetsDurableAttempt | null> {
    if (!validScope(scope) || !REQUEST.test(requestId) || !Number.isSafeInteger(jobAttempt)
      || jobAttempt < 1 || jobAttempt > 25) reject();
    const database = await this.ready();
    const row = await database.prepare(
      `SELECT e.* FROM finops_aws_budget_job_attempts e ${LIVE_SCOPE}
       WHERE e.org_id = ? AND e.customer_id = ? AND e.connection_id = ?
         AND e.account_id = ? AND e.partition = ? AND e.request_id = ?
         AND e.job_attempt = ? LIMIT 1`,
    ).bind(scope.orgId, scope.customerId, scope.connectionId, scope.accountId,
      scope.partition, requestId, jobAttempt).first<AttemptRow>();
    return row === null ? null : materialize(row);
  }

  public async recordAttempt(input: Parameters<AwsBudgetsDurableAttemptStore["recordAttempt"]>[0]): Promise<StoredAwsBudgetsDurableAttempt> {
    if (!validScope(input.scope) || !REQUEST.test(input.requestId) || !JOB.test(input.jobId)
      || !Number.isSafeInteger(input.jobAttempt) || input.jobAttempt < 1 || input.jobAttempt > 25
      || !WINDOW.test(input.scheduledWindow) || !Number.isSafeInteger(input.completedAtMs)
      || input.completedAtMs < 0 || !STATES.includes(input.state)
      || (input.hierarchyEvidenceId !== null && !ID.test(input.hierarchyEvidenceId))
      || (input.requestBodySha256 !== null && !SHA.test(input.requestBodySha256))) reject();
    const succeeded = input.state !== "failed";
    if ((succeeded && (
      input.generationId === null || !GENERATION.test(input.generationId)
      || input.captureId === null || !CAPTURE.test(input.captureId)
      || input.requestBodySha256 === null || !SHA.test(input.requestBodySha256)
      || input.responseBodySha256 === null || !SHA.test(input.responseBodySha256)
      || input.brokerKeyId === null || !KEY_ID.test(input.brokerKeyId)
      || input.failureCode !== null
      || (input.state === "ready" && input.hierarchyEvidenceId === null)
    )) || (!succeeded && (
      input.generationId !== null || input.captureId !== null || input.failureCode === null
      || !FAILURE_CODES.includes(input.failureCode) || input.hierarchyEvidenceId !== null
      || input.responseBodySha256 !== null || input.brokerKeyId !== null
    ))) reject();
    const base = {
      org_id: input.scope.orgId, customer_id: input.scope.customerId,
      connection_id: input.scope.connectionId, account_id: input.scope.accountId,
      partition: input.scope.partition, request_id: input.requestId, job_id: input.jobId,
      job_attempt: input.jobAttempt, scheduled_window: input.scheduledWindow,
      state: input.state, generation_id: input.generationId, capture_id: input.captureId,
      hierarchy_evidence_id: input.hierarchyEvidenceId,
      request_body_sha256: input.requestBodySha256,
      response_body_sha256: input.responseBodySha256,
      broker_key_id: input.brokerKeyId, failure_code: input.failureCode,
      completed_at: input.completedAtMs,
    } satisfies Omit<AttemptRow, "execution_id" | "content_sha256" | "created_at">;
    const contentSha256 = await sha256(rowPayload(base));
    const executionId = `abe_${contentSha256}`;
    const database = await this.ready();
    await database.prepare(
      `INSERT INTO finops_aws_budget_job_attempts (
        execution_id, org_id, customer_id, connection_id, account_id, partition,
        request_id, job_id, job_attempt, scheduled_window, state, generation_id,
        capture_id, hierarchy_evidence_id, request_body_sha256, response_body_sha256,
        broker_key_id, failure_code, content_sha256, completed_at, created_at
      ) SELECT ?, c.org_id, c.customer_id, c.id, c.aws_account_id, c.partition,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM aws_connections c
        JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
        JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
          AND cu.status IN ('active','trial')
       WHERE c.org_id = ? AND c.customer_id = ? AND c.id = ?
         AND c.aws_account_id = ? AND c.partition = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
         AND (? IS NULL OR EXISTS (
           SELECT 1 FROM finops_aws_budget_snapshots s
            WHERE s.generation_id = ? AND s.org_id = c.org_id
              AND s.customer_id = c.customer_id AND s.connection_id = c.id
              AND s.account_id = c.aws_account_id AND s.partition = c.partition
              AND s.source_capture_id = ?
         ))
       ON CONFLICT DO NOTHING`,
    ).bind(
      executionId, input.requestId, input.jobId, input.jobAttempt, input.scheduledWindow,
      input.state, input.generationId, input.captureId, input.hierarchyEvidenceId,
      input.requestBodySha256, input.responseBodySha256, input.brokerKeyId,
      input.failureCode, contentSha256, input.completedAtMs, input.completedAtMs,
      input.scope.orgId, input.scope.customerId, input.scope.connectionId,
      input.scope.accountId, input.scope.partition,
      input.generationId, input.generationId, input.captureId,
    ).run();
    const stored = await this.getAttempt(input.scope, input.requestId, input.jobAttempt);
    if (stored === null) reject("SCOPE_NOT_FOUND");
    if (stored.executionId !== executionId || stored.contentSha256 !== contentSha256) {
      reject("IMMUTABLE_CONFLICT");
    }
    return stored;
  }

  public async listHistory(scope: AwsBudgetsScope, limit = 36): Promise<readonly StoredAwsBudgetsDurableAttempt[]> {
    if (!validScope(scope) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY) reject();
    const database = await this.ready();
    const rows = await database.prepare(
      `SELECT e.* FROM finops_aws_budget_job_attempts e ${LIVE_SCOPE}
       WHERE e.org_id = ? AND e.customer_id = ? AND e.connection_id = ?
         AND e.account_id = ? AND e.partition = ?
       ORDER BY e.completed_at DESC, e.execution_id DESC LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, scope.connectionId, scope.accountId,
      scope.partition, limit).all<AttemptRow>();
    return Promise.all((rows.results ?? []).map(materialize));
  }
}
