import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

import { buildAwsNewsDashboardProjection } from "../lib/finops-aws-news-dashboard.ts";
import {
  AWS_NEWS_FEED_SOURCES,
} from "../lib/finops-aws-news-feeds.ts";
import {
  awsNewsFeedsCollectionWindow,
  awsNewsFeedsJobIdempotencyKey,
  runAwsNewsFeedsCollectionJob,
} from "../lib/finops-aws-news-feeds-job.ts";
import { AWS_NEWS_FEEDS_RUNTIME_CAPABILITY } from "../lib/finops-aws-news-feeds-runtime-binding.ts";

const root = path.resolve(import.meta.dirname, "..");
const scope = { organizationId: "org_alpha", customerId: "customer_alpha", connectionId: `conn_${"a".repeat(32)}` };
const snapshotScope = { orgId: scope.organizationId, customerId: scope.customerId, connectionId: scope.connectionId };

function item(overrides = {}) {
  return {
    sourceId: "aws_whats_new", sourceLabel: "AWS What's New", feedKind: "WHATS_NEW",
    externalId: "news:1", canonicalUrl: "https://aws.amazon.com/about-aws/whats-new/2026/07/amazon-ec2/",
    title: "Amazon EC2 launches a capability", summary: "Official summary.",
    publishedAt: "2026-07-31T10:00:00.000Z", updatedAt: null,
    serviceLabels: ["Amazon EC2"], categories: ["Compute"],
    matchedServices: [{ serviceId: "amazon-ec2", displayName: "Amazon EC2", usageBasis: "OBSERVED", observedAt: "2026-07-31T09:00:00.000Z", observationBasis: "RESOURCE_INVENTORY", reason: { kind: "PROVIDER_SERVICE_LABEL", matchedAlias: "Amazon EC2" } }],
    tenantRelevant: true, impactAssessment: "NOT_ASSESSED", ...overrides,
  };
}

function snapshot() {
  const items = [
    item(),
    item({ sourceId: "aws_news_blog", sourceLabel: "AWS News Blog", feedKind: "BLOG", externalId: "news:2", canonicalUrl: "https://aws.amazon.com/blogs/aws/example/", title: "Amazon S3 news", categories: ["Storage"], matchedServices: [], tenantRelevant: false }),
    item({ sourceId: "aws_official_video", sourceLabel: "AWS official videos", feedKind: "VIDEO", externalId: "news:3", canonicalUrl: "https://www.youtube.com/watch?v=AbCdEf123_-", title: "AWS video", categories: ["Video"], matchedServices: [], tenantRelevant: false }),
    item({ sourceId: "aws_security_bulletins", sourceLabel: "AWS Security Bulletins", feedKind: "SECURITY_BULLETIN", externalId: "news:4", canonicalUrl: "https://aws.amazon.com/security/security-bulletins/AWS-2026-001/", title: "Security bulletin", categories: ["Security"], matchedServices: [], tenantRelevant: false }),
  ];
  return {
    schemaVersion: "sutra.aws-news-feeds.snapshot.v1", scope: snapshotScope,
    captureId: `news_${"b".repeat(64)}`, catalogId: `catalog_${"c".repeat(64)}`,
    observedAt: "2026-07-31T12:00:00.000Z", state: "READY", coverage: "COMPLETE",
    sourceEvidence: AWS_NEWS_FEED_SOURCES.map((source) => ({ sourceId: source.id, label: source.label, kind: source.kind, authority: source.authority, status: "SUCCEEDED", fetchedAt: "2026-07-31T12:00:00.000Z", lastPublishedAt: "2026-07-31T10:00:00.000Z", acceptedItems: 1, failureCode: null, stale: false })),
    items, relevantItems: [items[0]], counts: { sourcesSucceeded: 5, sourcesFailed: 0, sourcesTruncated: 0, acceptedItems: 4, deduplicatedItems: 4, tenantRelevantItems: 1 }, limitations: ["Context only."],
  };
}

test("dashboard projection covers the official feed families and AWS service, feed type, and category filters", () => {
  const projected = buildAwsNewsDashboardProjection(snapshot(), [], { sourceId: null, feedKind: null, serviceId: "amazon-ec2", category: "Compute", relevance: "TENANT_RELEVANT", search: "capability" });
  assert.equal(projected.resultCount, 1);
  assert.equal(projected.items[0].impactAssessment, "NOT_ASSESSED");
  assert.deepEqual(snapshot().items.map((entry) => entry.feedKind), ["WHATS_NEW", "BLOG", "VIDEO", "SECURITY_BULLETIN"]);
  assert.deepEqual(projected.filterOptions.categories, ["Compute", "Security", "Storage", "Video"]);
});

test("server-owned scheduled job uses all pinned sources and accepts no URL or catalog in its payload", async () => {
  const seen = [];
  const now = [Date.parse("2026-07-31T12:00:00.000Z"), Date.parse("2026-07-31T12:00:20.000Z")];
  let recorded = null;
  const result = await runAwsNewsFeedsCollectionJob({ id: "job_test", orgId: scope.organizationId, customerId: scope.customerId, connectionId: scope.connectionId, payload: { scheduledWindow: "2026-07-31T12:00:00.000Z" } }, {
    gateway: { collect: async (source) => {
      seen.push(source.feedUrl);
      return { sourceId: source.id, status: "FAILED", requestUrl: source.feedUrl, finalUrl: null, redirectChain: [source.feedUrl], contentType: null, responseBytes: 0, durationMs: 10, fetchedAt: "2026-07-31T12:00:10.000Z", parser: null, truncated: false, failureCode: "PROVIDER_UNAVAILABLE", items: [] };
    } },
    loadTenantBoundary: async () => ({ scope: snapshotScope, binding: "SERVER_RESOLVED_CONNECTION", catalogId: `catalog_${"c".repeat(64)}`, catalogCapturedAt: "2026-07-31T11:00:00.000Z", services: [] }),
    recordCapture: async (recordScope, capture) => {
      recorded = { recordScope, capture };
      return { snapshot: { scope: recordScope, generationId: `newsg_${"d".repeat(64)}`, contentSha256: "d".repeat(64), snapshot: { ...snapshot(), state: "FAILED" }, createdAtIso: "2026-07-31T12:00:20.000Z", committedAtIso: null }, becameActive: false };
    },
    now: () => now.shift(),
  });
  assert.deepEqual(seen, AWS_NEWS_FEED_SOURCES.map((source) => source.feedUrl));
  assert.match(recorded.capture.captureId, /^news_[a-f0-9]{64}$/u);
  assert.equal(result.state, "FAILED");
  await assert.rejects(() => runAwsNewsFeedsCollectionJob({ id: "job_test", orgId: scope.organizationId, customerId: scope.customerId, connectionId: scope.connectionId, payload: { scheduledWindow: "2026-07-31T12:00:00.000Z", url: "https://evil.example" } }, {}), /job-invalid/u);
  assert.equal(awsNewsFeedsCollectionWindow(Date.parse("2026-07-31T15:59:00.000Z")), "2026-07-31T12:00:00.000Z");
  assert.match(awsNewsFeedsJobIdempotencyKey(scope, "2026-07-31T12:00:00.000Z"), /^aws-news-feeds:org_alpha/u);
});

test("route authenticates and tenant-scopes immutable reads; runtime capability remains honest", async () => {
  const route = await readFile(new URL("../app/api/v1/finops/aws-news-feeds/route.ts", import.meta.url), "utf8");
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /getConnectionForOrg\(authenticated\.subject\.orgId/u);
  assert.match(route, /assertSessionCapability\(authenticated, "connection:read", connection\.customerId\)/u);
  assert.match(route, /repository\.getActiveSnapshot\(scope\)/u);
  assert.match(route, /AWS_NEWS_FEEDS_RUNTIME_CAPABILITY/u);
  assert.doesNotMatch(route, /AWS_NEWS_FEEDS_JOB_HANDLER_NOT_REGISTERED/u);
  assert.doesNotMatch(route, /searchParams\.get\("orgId"\)|searchParams\.get\("customerId"\)/u);
});

test("SQLite and PostgreSQL migrations enforce immutable complete-only monotonic heads", async () => {
  for (const url of [new URL("../drizzle/0090_finops_aws_news_feed_snapshots.sql", import.meta.url), new URL("../postgres/migrations/0085_finops_aws_news_feed_snapshots.sql", import.meta.url)]) {
    const sql = await readFile(url, "utf8");
    assert.match(sql, /FINOPS_AWS_NEWS_FEED_SNAPSHOT_IMMUTABLE/u);
    assert.match(sql, /source_state[^\n]*READY|source_state` = 'READY'/u);
    assert.match(sql, /candidate\.`observed_at` > active\.`observed_at`|candidate\.observed_at > active\.observed_at/u);
  }
});

test("native report renders official families, required filters, provenance, freshness, safe external links, and history", async () => {
  const vite = await createServer({ root, configFile: false, logLevel: "silent", plugins: [react()], server: { middlewareMode: true } });
  try {
    const dashboardModule = await vite.ssrLoadModule("/app/costs/finops-aws-news-feeds-dashboard.tsx");
    const base = snapshot();
    const projection = buildAwsNewsDashboardProjection(base, [{ generationId: `newsg_${"d".repeat(64)}`, captureId: base.captureId, catalogId: base.catalogId, observedAt: base.observedAt, state: "READY", coverage: "COMPLETE", counts: base.counts, contentSha256: "d".repeat(64) }], { sourceId: null, feedKind: null, serviceId: null, category: null, relevance: null, search: null });
    const report = { ...projection, connectionId: scope.connectionId, sourceState: "partial", freshness: { observedAt: base.observedAt, ageHours: 2, staleAfterHours: 48 }, sourceEvidence: base.sourceEvidence, evidence: { generationId: `newsg_${"d".repeat(64)}` }, collection: AWS_NEWS_FEEDS_RUNTIME_CAPABILITY, disclosure: "Public AWS announcements are contextual intelligence, not evidence that a tenant resource is affected." };
    const html = renderToStaticMarkup(createElement(dashboardModule.AwsNewsFeedsReportView, { report, filters: projection.filters, onFiltersChange: () => undefined }));
    for (const expected of ["AWS service", "Feed type", "Category", "WHATS NEW", "BLOG", "VIDEO", "SECURITY BULLETIN", "Scheduled collection runtime", "Every 6 hours", "Shared worker not registered", "Durable adapter not registered", "Gateway not registered", "Source provenance", "freshness", "Immutable collection history", "Watch on the official AWS YouTube channel", "Export visible rows", "Context, not impact evidence", "newer collection is incomplete"]) assert.match(html, new RegExp(expected, "iu"));
    assert.match(html, /target="_blank" rel="noopener noreferrer"/u);
  } finally { await vite.close(); }
});
