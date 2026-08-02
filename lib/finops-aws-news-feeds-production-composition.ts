/**
 * Production dependency composition for ADV-07.
 *
 * The shared worker imports this module's narrow handler and scheduler hooks;
 * both runtime migrations are registered before production composition is
 * reported as active.
 */
import type { RunnableJob } from "./background-job-runner.ts";
import { AWS_NEWS_FEED_SOURCES, type AwsNewsTenantBoundary } from "./finops-aws-news-feeds.ts";
import type { AwsNewsFeedsPersistenceScope } from "../db/finops-aws-news-feeds-repository.ts";
import { AwsNewsFeedsRepository } from "../db/finops-aws-news-feeds-repository.ts";
import {
  AwsNewsFeedsRuntimeRepository,
  type AwsNewsFeedsRuntimeRepositoryOptions,
} from "../db/finops-aws-news-feeds-runtime-repository.ts";
import { JobQueueRepository } from "../db/job-queue-repository.ts";
import { AwsNewsFeedsXmlGateway } from "./finops-aws-news-feeds-xml-gateway.ts";
import {
  buildAwsNewsFeedsRuntimeHandler,
  runAwsNewsFeedsScheduleTick,
  type AwsNewsFeedsScheduleTickResult,
} from "./finops-aws-news-feeds-runtime-binding.ts";

export const AWS_NEWS_FEEDS_PRODUCTION_COMPOSITION_SCHEMA =
  "sutra.aws-news-feeds-production-composition.v1" as const;

export const AWS_NEWS_FEEDS_PRODUCTION_COMPOSITION_STATUS = Object.freeze({
  schemaVersion: AWS_NEWS_FEEDS_PRODUCTION_COMPOSITION_SCHEMA,
  pinnedGatewayImplemented: true,
  controlledEgressTransportRequired: true,
  durableReplayRepositoryImplemented: true,
  snapshotRepositoryImplemented: true,
  deterministicTickImplemented: true,
  sharedWorkerRegistered: true,
  sqliteMigrationRegistered: true,
  postgresMigrationRegistered: true,
  activationState: "REGISTERED_LOCAL_RUNTIME" as const,
});

export interface AwsNewsFeedsProductionCompositionOptions {
  readonly database?: D1Database;
  /** Server-owned inventory/CUR2 catalog lookup; caller request data is forbidden. */
  readonly loadTenantBoundary?: (
    scope: AwsNewsFeedsPersistenceScope,
    signal: AbortSignal,
  ) => Promise<AwsNewsTenantBoundary>;
  /** Required controlled-egress transport; unrestricted global fallback is forbidden. */
  readonly fetcher: (input: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => number;
  readonly replay?: Omit<AwsNewsFeedsRuntimeRepositoryOptions, "now">;
}

export interface AwsNewsFeedsProductionComposition {
  readonly schemaVersion: typeof AWS_NEWS_FEEDS_PRODUCTION_COMPOSITION_SCHEMA;
  readonly handler: (job: RunnableJob) => Promise<void>;
  readonly scheduleTick: (scheduledAtMs: number) => Promise<AwsNewsFeedsScheduleTickResult>;
  readonly replayRepository: AwsNewsFeedsRuntimeRepository;
  readonly snapshotRepository: AwsNewsFeedsRepository;
}

const PINNED_FEED_URLS = new Set(AWS_NEWS_FEED_SOURCES.map((source) => source.feedUrl));
const EGRESS_INIT_KEYS = ["credentials", "headers", "method", "redirect", "signal"];

/**
 * Wraps a transport with a second, composition-level egress boundary. Even a
 * substituted gateway dependency cannot add a destination, credential, body,
 * automatic redirect, or unbounded request mode.
 */
export function createAwsNewsFeedsControlledEgressFetcher(
  transport: (input: string, init: RequestInit) => Promise<Response>,
): (input: string, init: RequestInit) => Promise<Response> {
  if (typeof transport !== "function") {
    throw new Error("AWS_NEWS_FEEDS_CONTROLLED_EGRESS_REQUIRED");
  }
  return async (input, init) => {
    const headers = new Headers(init.headers);
    if (!PINNED_FEED_URLS.has(input)
      || JSON.stringify(Object.keys(init).sort()) !== JSON.stringify(EGRESS_INIT_KEYS)
      || init.method !== "GET" || init.redirect !== "manual" || init.credentials !== "omit"
      || !(init.signal instanceof AbortSignal)
      || JSON.stringify([...headers.keys()].sort()) !== JSON.stringify(["accept", "user-agent"])
      || headers.get("accept")
        !== "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9"
      || headers.get("user-agent") !== "Sutra-AWS-News-Feeds/1.0") {
      throw new Error("AWS_NEWS_FEEDS_EGRESS_POLICY_REJECTED");
    }
    return transport(input, init);
  };
}

function sameScope(boundary: AwsNewsTenantBoundary, scope: AwsNewsFeedsPersistenceScope): boolean {
  return boundary.scope.orgId === scope.organizationId
    && boundary.scope.customerId === scope.customerId
    && boundary.scope.connectionId === scope.connectionId
    && boundary.binding === "SERVER_RESOLVED_CONNECTION";
}

/**
 * Composes the exact pinned feed gateway, replay receipts, immutable snapshots,
 * and shared queue for the central handler and scheduler registry.
 */
export function createAwsNewsFeedsProductionComposition(
  options: AwsNewsFeedsProductionCompositionOptions,
): AwsNewsFeedsProductionComposition {
  if (typeof options.fetcher !== "function") {
    throw new Error("AWS_NEWS_FEEDS_CONTROLLED_EGRESS_REQUIRED");
  }
  const now = options.now ?? Date.now;
  const database = options.database;
  const replayRepository = new AwsNewsFeedsRuntimeRepository(database, {
    ...options.replay,
    now,
  });
  const snapshotRepository = new AwsNewsFeedsRepository(database);
  const queue = new JobQueueRepository(database);
  const gateway = new AwsNewsFeedsXmlGateway({
    fetcher: createAwsNewsFeedsControlledEgressFetcher(options.fetcher),
    now,
  });
  const dependencies = {
    replayStore: replayRepository,
    gateway,
    loadTenantBoundary: async (scope: AwsNewsFeedsPersistenceScope, signal: AbortSignal) => {
      if (signal.aborted) throw new Error("AWS_NEWS_FEEDS_COLLECTION_ABORTED");
      const boundary = await (options.loadTenantBoundary
        ?? replayRepository.loadTenantBoundary.bind(replayRepository))(scope, signal);
      if (!sameScope(boundary, scope)) {
        throw new Error("AWS_NEWS_FEEDS_TENANT_BOUNDARY_REJECTED");
      }
      return boundary;
    },
    recordCapture: async (scope: AwsNewsFeedsPersistenceScope, capture: Parameters<AwsNewsFeedsRepository["recordCapture"]>[1], boundary: AwsNewsTenantBoundary, completedAtMs: number, signal: AbortSignal) => {
      if (signal.aborted) throw new Error("AWS_NEWS_FEEDS_COLLECTION_ABORTED");
      return snapshotRepository.recordCapture(scope, capture, boundary, completedAtMs);
    },
    now,
  };
  return Object.freeze({
    schemaVersion: AWS_NEWS_FEEDS_PRODUCTION_COMPOSITION_SCHEMA,
    handler: buildAwsNewsFeedsRuntimeHandler(dependencies),
    scheduleTick: (scheduledAtMs: number) => runAwsNewsFeedsScheduleTick({
      scheduledAtMs,
      dependencies: {
        listActiveConnections: replayRepository.listActiveConnections.bind(replayRepository),
        queue,
      },
    }),
    replayRepository,
    snapshotRepository,
  });
}
