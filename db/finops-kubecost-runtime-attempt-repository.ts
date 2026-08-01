/** Immutable ADD-06 scheduler/broker attempt history. */
import type { KubecostAllocationScope } from "../lib/finops-kubecost-allocation.ts";
import type {
  KubecostRuntimeAttempt,
  KubecostRuntimeAttemptStore,
  KubecostRuntimeFailureCode,
} from "../lib/finops-kubecost-runtime-binding.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const REQUEST_ID = /^kur_[a-f0-9]{64}$/u;
const EXECUTION_ID = /^kue_[a-f0-9]{64}$/u;
const JOB_ID = /^job_[a-f0-9]{32}$/u;
const GENERATION_ID = /^kcg_[a-f0-9]{64}$/u;
const CAPTURE_ID = /^kubecost_[a-f0-9]{64}$/u;
const CUR2_GENERATION_ID = /^fbg_[a-f0-9]{64}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const CLUSTER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,255}$/u;
const BILLING_PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const BROKER_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SCHEDULED_WINDOW = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/u;
const STATES = ["CONFIGURATION_REQUIRED", "WAITING_FIRST_DELIVERY", "UNKNOWN", "ERROR",
  "EMPTY", "PARTIAL", "STALE", "READY", "FAILED"] as const;
const FAILURES = ["BROKER_AUTHENTICATION_FAILED", "BROKER_TIMEOUT", "BROKER_UNAVAILABLE",
  "BROKER_RESPONSE_INVALID", "SCOPE_REJECTED", "DESTINATION_REJECTED", "VERSION_PIN_REJECTED",
  "CUR2_LINEAGE_REJECTED", "EVIDENCE_REJECTED", "PERSISTENCE_REJECTED", "INTERNAL_ERROR"] as const;

interface AttemptRow {
  execution_id: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  partition: KubecostAllocationScope["partition"];
  billing_period: string;
  active_cur2_generation_id: string;
  scope_sha256: string;
  destination_sha256: string;
  active_cur2_sha256: string;
  account_count: number | string;
  cluster_count: number | string;
  request_id: string;
  job_id: string;
  job_attempt: number | string;
  scheduled_window: string;
  state: KubecostRuntimeAttempt["state"];
  generation_id: string | null;
  capture_id: string | null;
  request_body_sha256: string;
  response_body_sha256: string | null;
  broker_key_id: string | null;
  failure_code: KubecostRuntimeFailureCode | null;
  content_sha256: string;
  completed_at: number | string;
  created_at: number | string;
}

export interface StoredKubecostRuntimeAttempt extends KubecostRuntimeAttempt {
  readonly executionId: string;
  readonly scopeSha256: string;
  readonly destinationSha256: string;
  readonly activeCur2Sha256: string;
  readonly jobId: string;
  readonly scheduledWindow: string;
  readonly requestBodySha256: string;
  readonly responseBodySha256: string | null;
  readonly brokerKeyId: string | null;
  readonly contentSha256: string;
  readonly completedAtIso: string;
}

export class KubecostRuntimeAttemptRepositoryError extends Error {
  public constructor(public readonly code:
  "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "IMMUTABLE_CONFLICT" | "STORED_STATE_INVALID") {
    super("Kubecost runtime attempt persistence rejected");
    this.name = "KubecostRuntimeAttemptRepositoryError";
  }
}

function reject(code: KubecostRuntimeAttemptRepositoryError["code"] = "INVALID_INPUT"): never {
  throw new KubecostRuntimeAttemptRepositoryError(code);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function integer(value: number | string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) reject("STORED_STATE_INVALID");
  return result;
}

function sortedUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length
    && JSON.stringify(values) === JSON.stringify([...values].sort((left, right) => left.localeCompare(right, "en-US")));
}

function validScope(scope: KubecostAllocationScope): boolean {
  return IDENTIFIER.test(scope.orgId) && IDENTIFIER.test(scope.customerId)
    && CONNECTION_ID.test(scope.connectionId)
    && ["aws", "aws-us-gov", "aws-cn"].includes(scope.partition)
    && BILLING_PERIOD.test(scope.billingPeriod)
    && CUR2_GENERATION_ID.test(scope.activeCur2GenerationId)
    && scope.awsAccountIds.length >= 1 && scope.awsAccountIds.length <= 10_000
    && scope.awsAccountIds.every((account) => ACCOUNT_ID.test(account)) && sortedUnique(scope.awsAccountIds)
    && scope.clusterIds.length >= 1 && scope.clusterIds.length <= 5_000
    && scope.clusterIds.every((cluster) => CLUSTER_ID.test(cluster)) && sortedUnique(scope.clusterIds);
}

function canonicalAttempt(row: Omit<AttemptRow, "execution_id" | "content_sha256" | "created_at">): string {
  return JSON.stringify({
    schema: "sutra.kubecost-runtime-attempt.v1",
    orgId: row.org_id,
    customerId: row.customer_id,
    connectionId: row.connection_id,
    partition: row.partition,
    billingPeriod: row.billing_period,
    activeCur2GenerationId: row.active_cur2_generation_id,
    scopeSha256: row.scope_sha256,
    destinationSha256: row.destination_sha256,
    activeCur2Sha256: row.active_cur2_sha256,
    accountCount: Number(row.account_count),
    clusterCount: Number(row.cluster_count),
    requestId: row.request_id,
    jobId: row.job_id,
    jobAttempt: Number(row.job_attempt),
    scheduledWindow: row.scheduled_window,
    state: row.state,
    generationId: row.generation_id,
    captureId: row.capture_id,
    requestBodySha256: row.request_body_sha256,
    responseBodySha256: row.response_body_sha256,
    brokerKeyId: row.broker_key_id,
    failureCode: row.failure_code,
    completedAtMs: Number(row.completed_at),
  });
}

function validOutcome(row: AttemptRow): boolean {
  const success = row.state !== "FAILED";
  const attempt = integer(row.job_attempt);
  const accounts = integer(row.account_count);
  const clusters = integer(row.cluster_count);
  return STATES.includes(row.state) && REQUEST_ID.test(row.request_id) && JOB_ID.test(row.job_id)
    && attempt >= 1 && attempt <= 25 && SCHEDULED_WINDOW.test(row.scheduled_window)
    && BILLING_PERIOD.test(row.billing_period) && CUR2_GENERATION_ID.test(row.active_cur2_generation_id)
    && SHA256.test(row.scope_sha256) && SHA256.test(row.destination_sha256)
    && SHA256.test(row.active_cur2_sha256) && SHA256.test(row.request_body_sha256)
    && accounts >= 1 && accounts <= 10_000 && clusters >= 1 && clusters <= 5_000
    && (success
      ? row.generation_id !== null && GENERATION_ID.test(row.generation_id)
        && row.capture_id !== null && CAPTURE_ID.test(row.capture_id)
        && row.response_body_sha256 !== null && SHA256.test(row.response_body_sha256)
        && row.broker_key_id !== null && BROKER_KEY_ID.test(row.broker_key_id)
        && row.failure_code === null
      : row.generation_id === null && row.capture_id === null && row.response_body_sha256 === null
        && row.broker_key_id === null && row.failure_code !== null && FAILURES.includes(row.failure_code));
}

async function scopeHash(scope: KubecostAllocationScope): Promise<string> {
  return sha256(JSON.stringify(scope));
}

async function materialize(row: AttemptRow, scope: KubecostAllocationScope): Promise<StoredKubecostRuntimeAttempt> {
  if (!validScope(scope) || !EXECUTION_ID.test(row.execution_id) || !SHA256.test(row.content_sha256)
    || !validOutcome(row) || row.org_id !== scope.orgId || row.customer_id !== scope.customerId
    || row.connection_id !== scope.connectionId || row.partition !== scope.partition
    || row.billing_period !== scope.billingPeriod
    || row.active_cur2_generation_id !== scope.activeCur2GenerationId
    || Number(row.account_count) !== scope.awsAccountIds.length
    || Number(row.cluster_count) !== scope.clusterIds.length
    || integer(row.created_at) !== integer(row.completed_at)
    || row.scope_sha256 !== await scopeHash(scope)) reject("STORED_STATE_INVALID");
  const contentSha256 = await sha256(canonicalAttempt(row));
  if (contentSha256 !== row.content_sha256 || row.execution_id !== `kue_${contentSha256}`) {
    reject("STORED_STATE_INVALID");
  }
  return {
    executionId: row.execution_id,
    scopeSha256: row.scope_sha256,
    destinationSha256: row.destination_sha256,
    activeCur2Sha256: row.active_cur2_sha256,
    requestId: row.request_id,
    jobId: row.job_id,
    jobAttempt: integer(row.job_attempt),
    scheduledWindow: row.scheduled_window,
    state: row.state,
    generationId: row.generation_id,
    captureId: row.capture_id,
    requestBodySha256: row.request_body_sha256,
    responseBodySha256: row.response_body_sha256,
    brokerKeyId: row.broker_key_id,
    failureCode: row.failure_code,
    contentSha256,
    completedAtIso: new Date(integer(row.completed_at)).toISOString(),
  };
}

const LIVE_SCOPE = `JOIN aws_connections c ON c.id=e.connection_id AND c.org_id=e.org_id
  AND c.customer_id=e.customer_id AND c.partition=e.partition AND c.source_kind='aws_trust_role'
  AND c.status='active' JOIN organizations o ON o.id=e.org_id AND o.status='active'
  JOIN customers cu ON cu.id=e.customer_id AND cu.org_id=e.org_id AND cu.status IN ('active','trial')`;

export class KubecostRuntimeAttemptRepository implements KubecostRuntimeAttemptStore {
  public constructor(private readonly database: D1Database = getRawDb()) {}

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  public async getAttempt(scope: KubecostAllocationScope, requestId: string,
    jobAttempt: number): Promise<StoredKubecostRuntimeAttempt | null> {
    if (!validScope(scope) || !REQUEST_ID.test(requestId) || !Number.isSafeInteger(jobAttempt)
      || jobAttempt < 1 || jobAttempt > 25) reject();
    const database = await this.ready();
    const row = await database.prepare(`SELECT e.* FROM finops_kubecost_runtime_attempts e ${LIVE_SCOPE}
      WHERE e.org_id=? AND e.customer_id=? AND e.connection_id=? AND e.partition=?
      AND e.request_id=? AND e.job_attempt=? LIMIT 1`)
      .bind(scope.orgId, scope.customerId, scope.connectionId, scope.partition, requestId, jobAttempt)
      .first<AttemptRow>();
    return row === null ? null : materialize(row, scope);
  }

  public async recordAttempt(input: Parameters<KubecostRuntimeAttemptStore["recordAttempt"]>[0]):
  Promise<StoredKubecostRuntimeAttempt> {
    if (!validScope(input.scope)) reject();
    const scopeSha256 = await scopeHash(input.scope);
    const base = {
      org_id: input.scope.orgId,
      customer_id: input.scope.customerId,
      connection_id: input.scope.connectionId,
      partition: input.scope.partition,
      billing_period: input.scope.billingPeriod,
      active_cur2_generation_id: input.scope.activeCur2GenerationId,
      scope_sha256: scopeSha256,
      destination_sha256: input.destinationSha256,
      active_cur2_sha256: input.activeCur2Sha256,
      account_count: input.scope.awsAccountIds.length,
      cluster_count: input.scope.clusterIds.length,
      request_id: input.requestId,
      job_id: input.jobId,
      job_attempt: input.jobAttempt,
      scheduled_window: input.scheduledWindow,
      state: input.state,
      generation_id: input.generationId,
      capture_id: input.captureId,
      request_body_sha256: input.requestBodySha256 ?? "",
      response_body_sha256: input.responseBodySha256,
      broker_key_id: input.brokerKeyId,
      failure_code: input.failureCode,
      completed_at: input.completedAtMs,
    } satisfies Omit<AttemptRow, "execution_id" | "content_sha256" | "created_at">;
    const check = { ...base, execution_id: `kue_${"0".repeat(64)}`,
      content_sha256: "0".repeat(64), created_at: input.completedAtMs };
    if (!validOutcome(check)) reject();
    const contentSha256 = await sha256(canonicalAttempt(base));
    const executionId = `kue_${contentSha256}`;
    const database = await this.ready();
    await database.prepare(`INSERT INTO finops_kubecost_runtime_attempts(
      execution_id,org_id,customer_id,connection_id,partition,billing_period,active_cur2_generation_id,
      scope_sha256,destination_sha256,active_cur2_sha256,account_count,cluster_count,request_id,job_id,
      job_attempt,scheduled_window,state,generation_id,capture_id,request_body_sha256,response_body_sha256,
      broker_key_id,failure_code,content_sha256,completed_at,created_at)
      SELECT ?,c.org_id,c.customer_id,c.id,c.partition,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
      FROM aws_connections c JOIN organizations o ON o.id=c.org_id AND o.status='active'
      JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id AND cu.status IN ('active','trial')
      WHERE c.id=? AND c.org_id=? AND c.customer_id=? AND c.partition=?
      AND c.source_kind='aws_trust_role' AND c.status='active'
      AND (? IS NULL OR EXISTS(SELECT 1 FROM finops_kubecost_snapshots s
        WHERE s.generation_id=? AND s.org_id=c.org_id AND s.customer_id=c.customer_id
        AND s.connection_id=c.id AND s.partition=c.partition AND s.billing_period=?
        AND s.active_cur2_generation_id=? AND s.source_capture_id=? AND s.source_state=?))
      ON CONFLICT DO NOTHING`).bind(
      executionId, input.scope.billingPeriod, input.scope.activeCur2GenerationId, scopeSha256,
      input.destinationSha256, input.activeCur2Sha256, input.scope.awsAccountIds.length,
      input.scope.clusterIds.length, input.requestId, input.jobId, input.jobAttempt, input.scheduledWindow,
      input.state, input.generationId, input.captureId, input.requestBodySha256,
      input.responseBodySha256, input.brokerKeyId, input.failureCode, contentSha256,
      input.completedAtMs, input.completedAtMs, input.scope.connectionId, input.scope.orgId,
      input.scope.customerId, input.scope.partition, input.generationId, input.generationId,
      input.scope.billingPeriod, input.scope.activeCur2GenerationId, input.captureId, input.state,
    ).run();
    const stored = await this.getAttempt(input.scope, input.requestId, input.jobAttempt);
    if (stored === null) reject("SCOPE_NOT_FOUND");
    if (stored.executionId !== executionId) reject("IMMUTABLE_CONFLICT");
    return stored;
  }
}
