/** Immutable accepted replay and redacted failure audit for ADD-13. */
import { getRawDb } from "./index.ts";
import { ensureRuntimeSchema } from "./runtime-migrations.ts";
import type { PricingChangeJobScope } from "../lib/finops-pricing-change-materialization-job.ts";

const REQUEST = /^pcrt_[a-f0-9]{64}$/u;
const SNAPSHOT = /^pca_[a-f0-9]{64}$/u;
const EVIDENCE = /^fss_[a-f0-9]{64}$/u;
const GENERATION = /^fbg_[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;

export type PricingChangeRuntimeFailureCode = "POLICY_UNAVAILABLE" | "CUR2_UNAVAILABLE" | "PROVIDER_UNAVAILABLE" | "MATERIALIZATION_REJECTED" | "EVIDENCE_REJECTED" | "PERSISTENCE_REJECTED";
export interface PricingChangeRuntimeAcceptance {
  readonly requestKey: string; readonly scope: PricingChangeJobScope; readonly jobId: string; readonly policyId: string;
  readonly snapshotId: string; readonly evidenceGenerationId: string; readonly contentSha256: string;
  readonly activeCur2GenerationId: string; readonly capturedAt: string; readonly becameActive: boolean; readonly acceptedAt: number;
}
interface AcceptanceRow { request_key: string; org_id: string; customer_id: string; connection_id: string; job_id: string; policy_id: string;
  snapshot_id: string; evidence_generation_id: string; content_sha256: string; active_cur2_generation_id: string;
  captured_at: string; became_active: number | string; accepted_at: number | string }
interface FailureRow { failure_id: string; failure_code: string }

export class PricingChangeRuntimeRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "STORED_STATE_INVALID" | "IMMUTABLE_CONFLICT";
  public constructor(code: PricingChangeRuntimeRepositoryError["code"]) { super("Pricing Change runtime persistence rejected"); this.name = "PricingChangeRuntimeRepositoryError"; this.code = code; }
}
function reject(code: PricingChangeRuntimeRepositoryError["code"]): never { throw new PricingChangeRuntimeRepositoryError(code); }
function integer(value: number | string): number { const parsed = typeof value === "number" ? value : Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) reject("STORED_STATE_INVALID"); return parsed; }
function validScope(scope: PricingChangeJobScope): void {
  if (!ID.test(scope.organizationId) || !ID.test(scope.customerId) || !/^conn_[a-f0-9]{32}$/u.test(scope.connectionId)) reject("INVALID_INPUT");
}
function same(left: PricingChangeRuntimeAcceptance, right: PricingChangeRuntimeAcceptance): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function materialize(row: AcceptanceRow): PricingChangeRuntimeAcceptance {
  const acceptedAt = integer(row.accepted_at), became = integer(row.became_active), captured = Date.parse(row.captured_at);
  if (!REQUEST.test(row.request_key) || !ID.test(row.job_id) || !ID.test(row.policy_id) || !SNAPSHOT.test(row.snapshot_id)
    || !EVIDENCE.test(row.evidence_generation_id) || !SHA.test(row.content_sha256) || !GENERATION.test(row.active_cur2_generation_id)
    || !Number.isFinite(captured) || new Date(captured).toISOString() !== row.captured_at || ![0, 1].includes(became)) reject("STORED_STATE_INVALID");
  return { requestKey: row.request_key, scope: { organizationId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id },
    jobId: row.job_id, policyId: row.policy_id, snapshotId: row.snapshot_id, evidenceGenerationId: row.evidence_generation_id,
    contentSha256: row.content_sha256, activeCur2GenerationId: row.active_cur2_generation_id, capturedAt: row.captured_at,
    becameActive: became === 1, acceptedAt };
}

export class PricingChangeRuntimeRepository {
  private readonly database: D1Database;
  public constructor(database: D1Database = getRawDb()) { this.database = database; }
  private async live(scope: PricingChangeJobScope): Promise<void> {
    validScope(scope); await ensureRuntimeSchema(this.database);
    const row = await this.database.prepare(`SELECT c.id FROM aws_connections c
      JOIN organizations o ON o.id=c.org_id AND o.status='active'
      JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id AND cu.status='active'
      WHERE c.org_id=? AND c.customer_id=? AND c.id=? AND c.source_kind='aws_trust_role' AND c.status='active' LIMIT 1`)
      .bind(scope.organizationId, scope.customerId, scope.connectionId).first();
    if (row === null) reject("SCOPE_NOT_FOUND");
  }
  public async getAccepted(scope: PricingChangeJobScope, requestKey: string): Promise<PricingChangeRuntimeAcceptance | null> {
    if (!REQUEST.test(requestKey)) reject("INVALID_INPUT"); await this.live(scope);
    const row = await this.database.prepare(`SELECT * FROM finops_pricing_change_runtime_acceptances
      WHERE org_id=? AND customer_id=? AND connection_id=? AND request_key=? LIMIT 1`)
      .bind(scope.organizationId, scope.customerId, scope.connectionId, requestKey).first<AcceptanceRow>();
    return row === null ? null : materialize(row);
  }
  public async accept(input: PricingChangeRuntimeAcceptance): Promise<PricingChangeRuntimeAcceptance> {
    validScope(input.scope);
    if (!REQUEST.test(input.requestKey) || !ID.test(input.jobId) || !ID.test(input.policyId) || !SNAPSHOT.test(input.snapshotId)
      || !EVIDENCE.test(input.evidenceGenerationId) || !SHA.test(input.contentSha256) || !GENERATION.test(input.activeCur2GenerationId)
      || !Number.isSafeInteger(input.acceptedAt) || input.acceptedAt < 0 || !Number.isFinite(Date.parse(input.capturedAt))
      || new Date(Date.parse(input.capturedAt)).toISOString() !== input.capturedAt) reject("INVALID_INPUT");
    await this.live(input.scope);
    await this.database.prepare(`INSERT INTO finops_pricing_change_runtime_acceptances
      (request_key,org_id,customer_id,connection_id,job_id,policy_id,snapshot_id,evidence_generation_id,content_sha256,
       active_cur2_generation_id,captured_at,became_active,accepted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
      .bind(input.requestKey, input.scope.organizationId, input.scope.customerId, input.scope.connectionId, input.jobId,
        input.policyId, input.snapshotId, input.evidenceGenerationId, input.contentSha256, input.activeCur2GenerationId,
        input.capturedAt, input.becameActive ? 1 : 0, input.acceptedAt).run();
    const persisted = await this.getAccepted(input.scope, input.requestKey);
    if (persisted === null || !same(persisted, input)) reject("IMMUTABLE_CONFLICT"); return persisted;
  }
  public async recordFailure(input: { readonly failureId: string; readonly requestKey: string; readonly scope: PricingChangeJobScope;
    readonly jobId: string; readonly policyId: string; readonly attempt: number; readonly code: PricingChangeRuntimeFailureCode; readonly failedAt: number }): Promise<void> {
    validScope(input.scope);
    if (!/^pcrf_[a-f0-9]{64}$/u.test(input.failureId) || !REQUEST.test(input.requestKey) || !ID.test(input.jobId) || !ID.test(input.policyId)
      || !Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > 5 || !Number.isSafeInteger(input.failedAt) || input.failedAt < 0) reject("INVALID_INPUT");
    await this.live(input.scope);
    await this.database.prepare(`INSERT INTO finops_pricing_change_runtime_failures
      (failure_id,org_id,customer_id,connection_id,request_key,job_id,policy_id,attempt,failure_code,failed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(input.failureId, input.scope.organizationId, input.scope.customerId,
        input.scope.connectionId, input.requestKey, input.jobId, input.policyId, input.attempt, input.code, input.failedAt).run();
    const stored = await this.database.prepare(`SELECT failure_id,failure_code FROM finops_pricing_change_runtime_failures
      WHERE org_id=? AND customer_id=? AND connection_id=? AND job_id=? AND attempt=? LIMIT 1`)
      .bind(input.scope.organizationId, input.scope.customerId, input.scope.connectionId, input.jobId, input.attempt).first<FailureRow>();
    if (stored?.failure_id !== input.failureId || stored.failure_code !== input.code) reject("IMMUTABLE_CONFLICT");
  }
}
