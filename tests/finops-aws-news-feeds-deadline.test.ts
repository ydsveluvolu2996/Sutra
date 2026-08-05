import assert from "node:assert/strict";
import test from "node:test";
import {
  AWS_NEWS_FEED_COLLECTION_BOUNDS,
  AWS_NEWS_FEED_SOURCES,
} from "../lib/finops-aws-news-feeds.ts";
import { runAwsNewsFeedsCollectionJob } from "../lib/finops-aws-news-feeds-job.ts";

const scope = {
  organizationId: "org_news_deadline",
  customerId: "customer_news_deadline",
  connectionId: `conn_${"e".repeat(32)}`,
};
const window = "2026-07-31T12:00:00.000Z";

function failed(source: (typeof AWS_NEWS_FEED_SOURCES)[number]) {
  return {
    sourceId: source.id,
    status: "FAILED" as const,
    requestUrl: source.feedUrl,
    finalUrl: source.feedUrl,
    redirectChain: [source.feedUrl],
    durationMs: 10,
    fetchedAt: window,
    contentType: null,
    responseBytes: 0 as const,
    parser: null,
    truncated: false as const,
    failureCode: "PROVIDER_UNAVAILABLE" as const,
    items: [] as const,
  };
}

test("collection deadline expires before catalog or persistence and cannot fabricate success", async () => {
  const times = [
    Date.parse(window),
    Date.parse(window) + AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumCollectionDurationMs + 1,
  ];
  let boundaryCalls = 0;
  let persistenceCalls = 0;
  await assert.rejects(runAwsNewsFeedsCollectionJob({
    id: `job_${"4".repeat(32)}`,
    orgId: scope.organizationId,
    customerId: scope.customerId,
    connectionId: scope.connectionId,
    payload: { scheduledWindow: window },
  }, {
    gateway: { collect: async (source) => failed(source) },
    loadTenantBoundary: async () => {
      boundaryCalls += 1;
      throw new Error("must not load after deadline");
    },
    recordCapture: async () => {
      persistenceCalls += 1;
      throw new Error("must not persist after deadline");
    },
    now: () => times.shift()!,
  }), /finops-aws-news-feeds-job-invalid/u);
  assert.equal(boundaryCalls, 0);
  assert.equal(persistenceCalls, 0);
});

test("the job collects each exact pinned source once with no pagination or caller URL surface", async () => {
  const seen: string[] = [];
  const times = [Date.parse(window), Date.parse(window) + 1_000];
  const result = await runAwsNewsFeedsCollectionJob({
    id: `job_${"5".repeat(32)}`,
    orgId: scope.organizationId,
    customerId: scope.customerId,
    connectionId: scope.connectionId,
    payload: { scheduledWindow: window },
  }, {
    gateway: { collect: async (source, signal) => {
      assert.equal(signal.aborted, false);
      seen.push(source.feedUrl);
      return failed(source);
    } },
    loadTenantBoundary: async (received, signal) => {
      assert.equal(signal.aborted, false);
      return {
        scope: { orgId: received.organizationId, customerId: received.customerId, connectionId: received.connectionId },
        binding: "SERVER_RESOLVED_CONNECTION",
        catalogId: `catalog_${"f".repeat(64)}`,
        catalogCapturedAt: window,
        services: [],
      };
    },
    recordCapture: async (_received, capture, _boundary, _now, signal) => {
      assert.equal(signal.aborted, false);
      assert.equal(capture.feeds.every((feed) => feed.status === "FAILED"), true);
      return {
        snapshot: {
          scope,
          generationId: `newsg_${"6".repeat(64)}`,
          contentSha256: "7".repeat(64),
          snapshot: { state: "FAILED" },
          createdAtIso: window,
          committedAtIso: null,
        },
        becameActive: false,
      } as never;
    },
    now: () => times.shift()!,
  });
  assert.deepEqual(seen, AWS_NEWS_FEED_SOURCES.map((source) => source.feedUrl));
  assert.equal(new Set(seen).size, AWS_NEWS_FEED_SOURCES.length);
  assert.equal(result.state, "FAILED");
  assert.equal(result.becameActive, false);
});
