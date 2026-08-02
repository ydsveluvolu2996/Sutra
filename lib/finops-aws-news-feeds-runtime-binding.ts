/**
 * Permanent runtime facade for ADV-07 AWS News Feeds.
 *
 * This module is deliberately adapter-neutral. It defines the exact global
 * six-hour scheduler input and the exact background-job handler that the
 * shared worker can register without accepting source URLs, tenant scope, or
 * relevance catalogs from a caller.
 */
import type { RunnableJob } from "./background-job-runner.ts";
import {
  AWS_NEWS_FEEDS_DURABLE_HANDLER_SCHEMA,
  AwsNewsFeedsDurableHandlerError,
  handleAwsNewsFeedsDurableJob,
  type AwsNewsFeedsDurableHandlerDependencies,
  type AwsNewsFeedsDurableHandlerResult,
} from "./finops-aws-news-feeds-durable-handler.ts";
import {
  AWS_NEWS_FEEDS_JOB_KIND,
  AWS_NEWS_FEEDS_SCHEDULE_INTERVAL_MS,
  awsNewsFeedsCollectionWindow,
  awsNewsFeedsJobIdempotencyKey,
} from "./finops-aws-news-feeds-job.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const JOB_ID = /^job_[a-f0-9]{32}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T(?:00|06|12|18):00:00\.000Z$/u;
const MAX_ACTIVE_CONNECTIONS = 5_000;
const MAX_CONCURRENCY = 8;

export const AWS_NEWS_FEEDS_RUNTIME_BINDING_SCHEMA =
  "sutra.aws-news-feeds-runtime-binding.v1" as const;

export const AWS_NEWS_FEEDS_RUNTIME_CAPABILITY = Object.freeze({
  schemaVersion: AWS_NEWS_FEEDS_RUNTIME_BINDING_SCHEMA,
  handlerImplemented: true,
  schedulerImplemented: true,
  replayContractImplemented: true,
  intervalMs: AWS_NEWS_FEEDS_SCHEDULE_INTERVAL_MS,
  sharedWorkerRegistered: true,
  durableReplayAdapterRegistered: true,
  outboundGatewayRegistered: true,
  reason: "AWS_NEWS_FEEDS_RUNTIME_REGISTERED" as const,
});

export interface AwsNewsFeedsActiveConnection {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly sourceKind: "aws_trust_role";
  readonly status: "active";
}

export interface AwsNewsFeedsRuntimeQueue {
  enqueue(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly kind: typeof AWS_NEWS_FEEDS_JOB_KIND;
    readonly payload: { readonly scheduledWindow: string };
    readonly maxAttempts: 5;
    readonly runAfter: number;
    readonly idempotencyKey: string;
  }, now: number): Promise<unknown>;
}

export interface AwsNewsFeedsScheduleTickDependencies {
  readonly listActiveConnections: () => Promise<readonly AwsNewsFeedsActiveConnection[]>;
  readonly queue: AwsNewsFeedsRuntimeQueue;
}

export interface AwsNewsFeedsScheduleTickResult {
  readonly schemaVersion: typeof AWS_NEWS_FEEDS_RUNTIME_BINDING_SCHEMA;
  readonly scheduledWindow: string;
  readonly connectionCount: number;
  readonly submittedCount: number;
  readonly rejectedCount: number;
}

export class AwsNewsFeedsRuntimeBindingError extends Error {
  public readonly code: "INVALID_RUNTIME_INPUT" | "RUNTIME_IN_PROGRESS" | "RUNTIME_UNAVAILABLE";

  public constructor(code: AwsNewsFeedsRuntimeBindingError["code"]) {
    super(code === "INVALID_RUNTIME_INPUT"
      ? "AWS News Feeds runtime input was rejected"
      : code === "RUNTIME_IN_PROGRESS"
        ? "AWS News Feeds runtime work remains in progress"
        : "AWS News Feeds runtime is unavailable");
    this.name = "AwsNewsFeedsRuntimeBindingError";
    this.code = code;
  }
}

function reject(): never {
  throw new AwsNewsFeedsRuntimeBindingError("INVALID_RUNTIME_INPUT");
}

function validConnection(value: AwsNewsFeedsActiveConnection): boolean {
  return typeof value === "object" && value !== null
    && IDENTIFIER.test(value.organizationId)
    && IDENTIFIER.test(value.customerId)
    && CONNECTION_ID.test(value.connectionId)
    && value.sourceKind === "aws_trust_role"
    && value.status === "active";
}

function connectionKey(value: AwsNewsFeedsActiveConnection): string {
  return `${value.organizationId}\u0000${value.customerId}\u0000${value.connectionId}`;
}

function validWindow(value: string): boolean {
  return WINDOW.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

/**
 * Submits one deterministic job per exact active connection and six-hour UTC
 * window. One tenant queue failure does not suppress other tenants; only
 * aggregate failure counts leave this system-level scheduler boundary.
 */
export async function runAwsNewsFeedsScheduleTick(input: {
  readonly scheduledAtMs: number;
  readonly dependencies: AwsNewsFeedsScheduleTickDependencies;
}): Promise<AwsNewsFeedsScheduleTickResult> {
  if (!Number.isSafeInteger(input.scheduledAtMs) || input.scheduledAtMs < 0) reject();
  let received: readonly AwsNewsFeedsActiveConnection[];
  try {
    received = await input.dependencies.listActiveConnections();
  } catch {
    throw new AwsNewsFeedsRuntimeBindingError("RUNTIME_UNAVAILABLE");
  }
  if (!Array.isArray(received) || received.length > MAX_ACTIVE_CONNECTIONS
    || received.some((connection) => !validConnection(connection))) reject();
  const connections = [...received].sort((left, right) =>
    connectionKey(left).localeCompare(connectionKey(right), "en-US"));
  if (new Set(connections.map(connectionKey)).size !== connections.length) reject();
  const scheduledWindow = awsNewsFeedsCollectionWindow(input.scheduledAtMs);
  if (!validWindow(scheduledWindow)) reject();

  let cursor = 0;
  let submittedCount = 0;
  let rejectedCount = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, connections.length) }, async () => {
    while (cursor < connections.length) {
      const connection = connections[cursor++]!;
      const scope = {
        organizationId: connection.organizationId,
        customerId: connection.customerId,
        connectionId: connection.connectionId,
      };
      try {
        await input.dependencies.queue.enqueue({
          orgId: scope.organizationId,
          customerId: scope.customerId,
          connectionId: scope.connectionId,
          kind: AWS_NEWS_FEEDS_JOB_KIND,
          payload: Object.freeze({ scheduledWindow }),
          maxAttempts: 5,
          runAfter: input.scheduledAtMs,
          idempotencyKey: awsNewsFeedsJobIdempotencyKey(scope, scheduledWindow),
        }, input.scheduledAtMs);
        submittedCount += 1;
      } catch {
        rejectedCount += 1;
      }
    }
  });
  await Promise.all(workers);
  return Object.freeze({
    schemaVersion: AWS_NEWS_FEEDS_RUNTIME_BINDING_SCHEMA,
    scheduledWindow,
    connectionCount: connections.length,
    submittedCount,
    rejectedCount,
  });
}

function exactPayload(value: unknown): { readonly scheduledWindow: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["scheduledWindow"])
    || typeof (value as Record<string, unknown>).scheduledWindow !== "string"
    || !validWindow((value as Record<string, unknown>).scheduledWindow as string)) reject();
  return { scheduledWindow: (value as Record<string, string>).scheduledWindow };
}

/** Converts a leased shared-queue job into the exact durable envelope. */
export async function runAwsNewsFeedsRuntimeJob(
  job: RunnableJob,
  dependencies: AwsNewsFeedsDurableHandlerDependencies,
): Promise<AwsNewsFeedsDurableHandlerResult> {
  if (job.kind !== AWS_NEWS_FEEDS_JOB_KIND
    || !JOB_ID.test(job.id)
    || !IDENTIFIER.test(job.orgId)
    || job.customerId === null || !IDENTIFIER.test(job.customerId)
    || job.connectionId === null || !CONNECTION_ID.test(job.connectionId)
    || !Number.isSafeInteger(job.attempt) || job.attempt < 1 || job.attempt > 5
    || job.maxAttempts !== 5) reject();
  const payload = exactPayload(job.payload);
  const scope = {
    organizationId: job.orgId,
    customerId: job.customerId,
    connectionId: job.connectionId,
  };
  return handleAwsNewsFeedsDurableJob({
    schemaVersion: AWS_NEWS_FEEDS_DURABLE_HANDLER_SCHEMA,
    kind: AWS_NEWS_FEEDS_JOB_KIND,
    idempotencyKey: awsNewsFeedsJobIdempotencyKey(scope, payload.scheduledWindow),
    job: {
      id: job.id,
      orgId: job.orgId,
      customerId: job.customerId,
      connectionId: job.connectionId,
      payload,
    },
  }, dependencies);
}

/**
 * Produces a shared-worker handler. An existing lease is retried by the queue;
 * it is never marked successful while another replica still owns the replay
 * claim.
 */
export function buildAwsNewsFeedsRuntimeHandler(
  dependencies: AwsNewsFeedsDurableHandlerDependencies,
): (job: RunnableJob) => Promise<void> {
  return async (job) => {
    let result: AwsNewsFeedsDurableHandlerResult;
    try {
      result = await runAwsNewsFeedsRuntimeJob(job, dependencies);
    } catch (error) {
      if (error instanceof AwsNewsFeedsDurableHandlerError) throw error;
      throw new AwsNewsFeedsRuntimeBindingError("INVALID_RUNTIME_INPUT");
    }
    if (result.disposition === "IN_PROGRESS") {
      throw new AwsNewsFeedsRuntimeBindingError("RUNTIME_IN_PROGRESS");
    }
  };
}
