/**
 * Enqueue adapter for tenant-scoped hosted collection.
 *
 * When hosted onboarding attaches a customer-owned AWS trust role, the app must
 * hand the actual collection off to the durable queue so the AWS-hosted
 * broker/worker can run it out-of-band. This adapter is the ONLY thing the
 * onboarding route calls to schedule that work.
 *
 * Tenant safety: the adapter carries NO tenant identity in the job payload.
 * org/customer/connection ownership is re-verified inside
 * `JobQueueRepository.enqueue`'s connection-scoped INSERT (which joins
 * aws_connections/organizations/customers), so a caller can never enqueue a
 * collection for a connection it does not own — the same "identity from the
 * persisted row, never the payload" rule the hosted broker ingest path uses.
 *
 * This module does NOT register a runner handler for the job kind — the actual
 * hosted collection execution (broker/worker) is a separate workstream. Until a
 * handler exists, `runDueBackgroundJobs` honestly reports the kind as unhandled
 * and leaves the job queued.
 */

export const HOSTED_COLLECTOR_COLLECT_JOB_KIND = "hosted.collector.collect";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;

export interface TenantCollectionJobRequest {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  /** Idempotency reference carried from the onboarding operation. */
  readonly operationId: string;
}

/**
 * The minimal enqueue surface the adapter needs. `JobQueueRepository` satisfies
 * this structurally; tests can inject a double.
 */
export interface CollectorJobEnqueuePort {
  enqueue(input: {
    readonly orgId: string;
    readonly customerId: string | null;
    readonly connectionId?: string | null;
    readonly kind: string;
    readonly payload: unknown;
  }): Promise<{ readonly id: string }>;
}

export class HostedCollectorJobError extends Error {
  public constructor() {
    super("Hosted collection job request rejected");
    this.name = "HostedCollectorJobError";
  }
}

export async function enqueueTenantCollectionJob(
  port: CollectorJobEnqueuePort,
  request: TenantCollectionJobRequest,
): Promise<{ readonly jobId: string }> {
  if (
    !IDENTIFIER.test(request.orgId) ||
    !IDENTIFIER.test(request.customerId) ||
    !IDENTIFIER.test(request.connectionId) ||
    !IDENTIFIER.test(request.operationId)
  ) {
    throw new HostedCollectorJobError();
  }
  const result = await port.enqueue({
    orgId: request.orgId,
    customerId: request.customerId,
    connectionId: request.connectionId,
    kind: HOSTED_COLLECTOR_COLLECT_JOB_KIND,
    payload: { connectionId: request.connectionId, operationId: request.operationId },
  });
  return { jobId: result.id };
}
