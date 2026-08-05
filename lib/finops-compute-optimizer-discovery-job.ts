/** Server-owned enqueue contract for read-only Compute Optimizer discovery. */
import type { ComputeOptimizerDiscoveryScope, StoredComputeOptimizerDiscoveryRun } from "../db/finops-compute-optimizer-discovery-repository.ts";

export const FINOPS_COMPUTE_OPTIMIZER_DISCOVERY_JOB_KIND = "finops-compute-optimizer-discovery";
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const RUN_ID = /^cor_[a-f0-9]{64}$/u;

export interface ComputeOptimizerDiscoveryJobPayload { readonly runId: string; readonly connectionId: string }
export interface ComputeOptimizerDiscoveryQueue {
  enqueue(input: {
    readonly orgId: string; readonly customerId: string; readonly connectionId: string;
    readonly kind: string; readonly payload: ComputeOptimizerDiscoveryJobPayload;
    readonly maxAttempts: number; readonly idempotencyKey: string;
  }, nowMs?: number): Promise<{ readonly id: string }>;
}

export class ComputeOptimizerDiscoveryJobError extends Error {
  public readonly code: "INVALID_JOB" | "INVALID_SCOPE" | "INVALID_RUN" | "QUEUE_REJECTED";
  public constructor(code: ComputeOptimizerDiscoveryJobError["code"]) {
    super("Compute Optimizer discovery job rejected"); this.name = "ComputeOptimizerDiscoveryJobError"; this.code = code;
  }
}
function reject(code: ComputeOptimizerDiscoveryJobError["code"]): never { throw new ComputeOptimizerDiscoveryJobError(code); }

export function parseComputeOptimizerDiscoveryJobPayload(value: unknown): ComputeOptimizerDiscoveryJobPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject("INVALID_JOB");
  const record = value as Readonly<Record<string, unknown>>;
  if (Object.keys(record).length !== 2 || !("runId" in record) || !("connectionId" in record)
    || typeof record.runId !== "string" || !RUN_ID.test(record.runId)
    || typeof record.connectionId !== "string" || !CONNECTION_ID.test(record.connectionId)) reject("INVALID_JOB");
  return { runId: record.runId, connectionId: record.connectionId };
}

export async function enqueueComputeOptimizerDiscovery(
  queue: ComputeOptimizerDiscoveryQueue,
  scope: ComputeOptimizerDiscoveryScope,
  run: StoredComputeOptimizerDiscoveryRun,
  nowMs = Date.now(),
): Promise<string> {
  if (run.scope.organizationId !== scope.organizationId || run.scope.customerId !== scope.customerId
    || run.scope.connectionId !== scope.connectionId || !CONNECTION_ID.test(scope.connectionId)) reject("INVALID_SCOPE");
  if (run.status !== "pending" || !RUN_ID.test(run.runId) || !Number.isSafeInteger(nowMs) || nowMs < 0) reject("INVALID_RUN");
  const payload = parseComputeOptimizerDiscoveryJobPayload({ runId: run.runId, connectionId: scope.connectionId });
  const queued = await queue.enqueue({
    orgId: scope.organizationId, customerId: scope.customerId, connectionId: scope.connectionId,
    kind: FINOPS_COMPUTE_OPTIMIZER_DISCOVERY_JOB_KIND, payload, maxAttempts: 6,
    idempotencyKey: `finops-compute-optimizer-discovery:${run.runId}`,
  }, nowMs);
  if (!/^job_[a-f0-9]{32}$/u.test(queued.id)) reject("QUEUE_REJECTED");
  return queued.id;
}
