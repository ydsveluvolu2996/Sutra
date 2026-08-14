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
 * The runner below resolves scope again from durable control-plane state,
 * executes the authenticated hosted broker call, and settles the scoped sync
 * run before the queue job may complete.
 */

import type { RunnableJob } from "./background-job-runner.ts";
import { assertAwsStaticCredentialsOnboardingEnabled } from "./aws-static-credentials-feature.ts";
import { isLiveAwsSourceKind } from "./pilot-types.ts";
import type { PilotConnection, PilotSnapshotPayload, SnapshotOrigin, SyncStatus } from "./pilot-types.ts";

export const HOSTED_COLLECTOR_COLLECT_JOB_KIND = "hosted.collector.collect";
export const HOSTED_COLLECTOR_ACTOR_ID = "system-hosted-collector";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CURRENT_PERMISSION_PACK = "standard-2026-07.4";
const LIVE_ORIGIN: SnapshotOrigin = { kind: "aws_live", fixtureId: null, fixtureVersion: null };

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
  public constructor(message = "Hosted collection job request rejected") {
    super(message);
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

export interface HostedCollectorSyncRun {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly status: SyncStatus;
}

export interface HostedCollectorJobDependencies {
  readonly getConnection: (orgId: string, connectionId: string) => Promise<PilotConnection | null>;
  /**
   * Returns runs whose idempotency key belongs to this logical onboarding
   * operation. Implementations must scope by org, customer, and connection.
   */
  readonly listOperationRuns: (input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly idempotencyBase: string;
  }) => Promise<readonly HostedCollectorSyncRun[]>;
  readonly createSyncRun: (
    connectionId: string,
    options: {
      readonly orgId: string;
      readonly idempotencyKey: string;
      readonly triggerKind: "onboarding";
    },
  ) => Promise<string>;
  readonly runCollectorSync: (input: {
    readonly tenantId: string;
    readonly connectionId: string;
    readonly jobId: string;
    readonly accountId: string;
    readonly partition: PilotConnection["partition"];
  }) => Promise<{
    readonly snapshot: PilotSnapshotPayload;
    /** Exact authenticated broker response bytes, before JSON parsing. */
    readonly rawEvidenceBytes: Uint8Array;
  }>;
  readonly persistSnapshot: (input: {
    readonly runId: string;
    readonly payload: PilotSnapshotPayload;
    readonly rawEvidenceBytes: Uint8Array;
    readonly actorId: string;
    readonly origin: SnapshotOrigin;
    readonly orgId: string;
  }) => Promise<string>;
  readonly failSyncRun: (
    runId: string,
    connectionId: string,
    actorId: string,
    safeReason: string,
    orgId: string,
  ) => Promise<void>;
  readonly markConnectionNeedsAttention: (
    connectionId: string,
    actorId: string,
    safeReason: string,
    orgId: string,
  ) => Promise<unknown>;
  readonly safeFailureCode: (error: unknown) => string;
}

function parseCollectionPayload(value: unknown): {
  readonly connectionId: string;
  readonly operationId: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HostedCollectorJobError("hosted-collector-payload-invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    typeof record.connectionId !== "string" || !IDENTIFIER.test(record.connectionId) ||
    typeof record.operationId !== "string" || !IDENTIFIER.test(record.operationId)
  ) {
    throw new HostedCollectorJobError("hosted-collector-payload-invalid");
  }
  return { connectionId: record.connectionId, operationId: record.operationId };
}

async function operationIdempotencyBase(input: {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly operationId: string;
}): Promise<string> {
  const bytes = new TextEncoder().encode(
    `${input.orgId}\u0000${input.customerId}\u0000${input.connectionId}\u0000${input.operationId}`,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `hosted_collector_${[...digest].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

const CONNECTION_ATTENTION_CODES = new Set([
  "ASSUME_ROLE_DENIED",
  "TRUST_POLICY_UNSAFE",
  "CALLER_IDENTITY_MISMATCH",
  "NEGATIVE_PROBE_INCONCLUSIVE",
]);

/**
 * Execute one durable hosted onboarding collection.
 *
 * At-least-once safety:
 * - logical duplicate enqueues share an operation-derived idempotency base;
 * - a previously successful run is an exact no-op;
 * - a running run is resumed with the same broker job id after worker death;
 * - a settled failed attempt receives a new deterministic attempt suffix.
 */
export async function runHostedCollectorJob(
  job: RunnableJob,
  deps: HostedCollectorJobDependencies,
): Promise<void> {
  if (job.kind !== HOSTED_COLLECTOR_COLLECT_JOB_KIND || job.customerId === null || job.connectionId === null) {
    throw new HostedCollectorJobError("hosted-collector-job-scope-invalid");
  }
  const payload = parseCollectionPayload(job.payload);
  if (payload.connectionId !== job.connectionId) {
    throw new HostedCollectorJobError("hosted-collector-job-scope-mismatch");
  }

  const connection = await deps.getConnection(job.orgId, job.connectionId);
  if (
    connection === null ||
    connection.customerId !== job.customerId ||
    connection.id !== job.connectionId
  ) {
    throw new HostedCollectorJobError("hosted-collector-connection-scope-mismatch");
  }
  if (
    !isLiveAwsSourceKind(connection.sourceKind) ||
    connection.status !== "active" ||
    connection.permissionPackVersion !== CURRENT_PERMISSION_PACK
  ) {
    throw new HostedCollectorJobError("hosted-collector-connection-not-runnable");
  }
  if (connection.sourceKind === "aws_static_credentials") {
    assertAwsStaticCredentialsOnboardingEnabled();
  }

  const idempotencyBase = await operationIdempotencyBase({
    orgId: job.orgId,
    customerId: job.customerId,
    connectionId: job.connectionId,
    operationId: payload.operationId,
  });
  const prior = await deps.listOperationRuns({
    orgId: job.orgId,
    customerId: job.customerId,
    connectionId: job.connectionId,
    idempotencyBase,
  });
  if (prior.some((run) => run.status === "succeeded" || run.status === "partial")) return;

  const resumable = prior.find((run) => run.status === "running" || run.status === "queued");
  const idempotencyKey = resumable?.idempotencyKey ?? `${idempotencyBase}.${job.attempt}`;
  let runId: string | null = resumable?.id ?? null;
  try {
    if (runId === null) {
      runId = await deps.createSyncRun(job.connectionId, {
        orgId: job.orgId,
        idempotencyKey,
        triggerKind: "onboarding",
      });
    }
    const collected = await deps.runCollectorSync({
      tenantId: job.orgId,
      connectionId: job.connectionId,
      jobId: idempotencyKey,
      accountId: connection.awsAccountId,
      partition: connection.partition,
    });
    await deps.persistSnapshot({
      runId,
      payload: collected.snapshot,
      rawEvidenceBytes: collected.rawEvidenceBytes,
      actorId: HOSTED_COLLECTOR_ACTOR_ID,
      origin: LIVE_ORIGIN,
      orgId: job.orgId,
    });
  } catch (error) {
    if (runId !== null) {
      const safeReason = deps.safeFailureCode(error);
      try {
        await deps.failSyncRun(runId, job.connectionId, HOSTED_COLLECTOR_ACTOR_ID, safeReason, job.orgId);
        if (CONNECTION_ATTENTION_CODES.has(safeReason)) {
          await deps.markConnectionNeedsAttention(
            job.connectionId,
            HOSTED_COLLECTOR_ACTOR_ID,
            safeReason,
            job.orgId,
          );
        }
      } catch {
        // Preserve the broker/persistence failure. A committed success is found
        // by the operation lookup on retry; a stale transition is never allowed
        // to replace the primary error.
      }
    }
    throw error;
  }
}
