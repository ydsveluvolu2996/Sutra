/**
 * Server-owned orchestration contract for the credential-free AWS News Feeds
 * collection. The durable worker supplies tenant scope from its leased job and
 * a hardened outbound/XML gateway; no URL or service catalog is accepted from
 * the job payload.
 */
import {
  AWS_NEWS_FEED_COLLECTION_BOUNDS,
  AWS_NEWS_FEED_SOURCES,
  assertAwsNewsFeedRequestTarget,
  type AwsNewsFeedCapture,
  type AwsNewsFeedSourceDefinition,
  type AwsNewsFeedsCapture,
  type AwsNewsTenantBoundary,
} from "./finops-aws-news-feeds.ts";
import type {
  AwsNewsFeedsPersistenceScope,
  StoredAwsNewsFeedsSnapshot,
} from "../db/finops-aws-news-feeds-repository.ts";

export const AWS_NEWS_FEEDS_JOB_KIND = "finops-aws-news-feeds-collect";
export const AWS_NEWS_FEEDS_SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const WINDOW = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:00|06|12|18):00:00\.000Z$/u;

export interface AwsNewsFeedsCollectionJob {
  readonly id: string;
  readonly orgId: string;
  readonly customerId: string | null;
  readonly connectionId: string | null;
  readonly payload: unknown;
}

export interface AwsNewsFeedsSourceGateway {
  /**
   * The gateway receives a frozen allowlisted source, not a caller URL. It must
   * enforce manual redirects, streaming byte limits, XML MIME validation, and
   * XXE-safe RSS/Atom parsing before returning the typed capture.
   */
  collect(
    source: AwsNewsFeedSourceDefinition,
    signal: AbortSignal,
  ): Promise<AwsNewsFeedCapture>;
}

export interface AwsNewsFeedsCollectionJobDependencies {
  readonly gateway: AwsNewsFeedsSourceGateway;
  readonly loadTenantBoundary: (
    scope: AwsNewsFeedsPersistenceScope,
    signal: AbortSignal,
  ) => Promise<AwsNewsTenantBoundary>;
  readonly recordCapture: (
    scope: AwsNewsFeedsPersistenceScope,
    capture: AwsNewsFeedsCapture,
    boundary: AwsNewsTenantBoundary,
    nowMs: number,
    signal: AbortSignal,
  ) => Promise<{ readonly snapshot: StoredAwsNewsFeedsSnapshot; readonly becameActive: boolean }>;
  readonly now?: () => number;
}

export interface AwsNewsFeedsCollectionJobResult {
  readonly generationId: string;
  readonly captureId: string;
  readonly state: StoredAwsNewsFeedsSnapshot["snapshot"]["state"];
  readonly becameActive: boolean;
}

function invalid(): never { throw new Error("finops-aws-news-feeds-job-invalid"); }

async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(hash)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

export function awsNewsFeedsCollectionWindow(nowMs = Date.now()): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) invalid();
  const interval = AWS_NEWS_FEEDS_SCHEDULE_INTERVAL_MS;
  return new Date(Math.floor(nowMs / interval) * interval).toISOString();
}

export function awsNewsFeedsJobIdempotencyKey(scope: AwsNewsFeedsPersistenceScope, window: string): string {
  if (!WINDOW.test(window)) invalid();
  return `aws-news-feeds:${scope.organizationId}:${scope.customerId}:${scope.connectionId}:${window}`;
}

export async function runAwsNewsFeedsCollectionJob(
  job: AwsNewsFeedsCollectionJob,
  dependencies: AwsNewsFeedsCollectionJobDependencies,
): Promise<AwsNewsFeedsCollectionJobResult> {
  if (job.customerId === null || job.connectionId === null
    || typeof job.payload !== "object" || job.payload === null || Array.isArray(job.payload)) invalid();
  const keys = Object.keys(job.payload as Record<string, unknown>);
  const scheduledWindow = (job.payload as Record<string, unknown>).scheduledWindow;
  if (keys.length !== 1 || keys[0] !== "scheduledWindow" || typeof scheduledWindow !== "string"
    || !WINDOW.test(scheduledWindow)) invalid();
  const scope = { organizationId: job.orgId, customerId: job.customerId, connectionId: job.connectionId };
  const startedAtMs = (dependencies.now ?? Date.now)();
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) invalid();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumCollectionDurationMs);
  let feeds: readonly AwsNewsFeedCapture[];
  try {
    feeds = await Promise.all(AWS_NEWS_FEED_SOURCES.map(async (source) => {
      assertAwsNewsFeedRequestTarget(source.id, source.feedUrl);
      const captured = await dependencies.gateway.collect(source, controller.signal);
      if (captured.sourceId !== source.id || captured.requestUrl !== source.feedUrl) invalid();
      return captured;
    }));
    if (controller.signal.aborted) invalid();
    const completedAtMs = (dependencies.now ?? Date.now)();
    if (!Number.isSafeInteger(completedAtMs) || completedAtMs < startedAtMs
      || completedAtMs - startedAtMs > AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumCollectionDurationMs) invalid();
    const captureBase = {
      schemaVersion: "sutra.aws-news-feeds.v1" as const,
      scope: { orgId: scope.organizationId, customerId: scope.customerId, connectionId: scope.connectionId },
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      feeds,
    };
    const capture: AwsNewsFeedsCapture = {
      ...captureBase,
      captureId: `news_${await digest(captureBase)}`,
    };
    if (controller.signal.aborted) invalid();
    const boundary = await dependencies.loadTenantBoundary(scope, controller.signal);
    if (controller.signal.aborted || boundary.binding !== "SERVER_RESOLVED_CONNECTION") invalid();
    const recorded = await dependencies.recordCapture(
      scope, capture, boundary, completedAtMs, controller.signal,
    );
    if (controller.signal.aborted) invalid();
    return {
      generationId: recorded.snapshot.generationId,
      captureId: capture.captureId,
      state: recorded.snapshot.snapshot.state,
      becameActive: recorded.becameActive,
    };
  } finally {
    clearTimeout(timeout);
  }
}
