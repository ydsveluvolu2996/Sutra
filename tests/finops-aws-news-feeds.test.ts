import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAwsNewsFeedRedirectChain,
  assertAwsNewsFeedRequestTarget,
  AWS_NEWS_FEED_COLLECTION_BOUNDS,
  AWS_NEWS_FEED_SOURCES,
  awsNewsFeedsSourceEvidence,
  AwsNewsFeedsError,
  normalizeAwsNewsFeedsCapture,
  type AwsNewsFeedCapture,
  type AwsNewsFeedItemCapture,
  type AwsNewsFeedsCapture,
  type AwsNewsFeedSourceDefinition,
  type AwsNewsTenantBoundary,
} from "../lib/finops-aws-news-feeds.ts";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const SCOPE = {
  orgId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: `conn_${"a".repeat(32)}`,
};

type Mutable<T> = T extends readonly []
  ? []
  : T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
  ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
  : T;

const ITEM_URL: Record<AwsNewsFeedSourceDefinition["id"], string> = {
  aws_whats_new:
    "https://aws.amazon.com/about-aws/whats-new/2026/07/amazon-ec2-launch/",
  aws_news_blog:
    "https://aws.amazon.com/blogs/aws/amazon-s3-launch/?trk=ignored#section",
  aws_security_blog:
    "https://aws.amazon.com/blogs/security/secure-amazon-eks/",
  aws_security_bulletins:
    "https://aws.amazon.com/security/security-bulletins/AWS-2026-001/",
  aws_official_video: "https://www.youtube.com/watch?v=AbCdEf123_-&feature=rss",
};

function item(
  source: AwsNewsFeedSourceDefinition,
): AwsNewsFeedItemCapture {
  return {
    externalId: `${source.id}:item-1`,
    canonicalUrl: ITEM_URL[source.id],
    title: source.id === "aws_whats_new"
      ? "Amazon EC2 launches a new capability"
      : source.id === "aws_news_blog"
      ? "New storage controls for Amazon S3"
      : source.id === "aws_official_video"
      ? "Amazon EKS technical session"
      : `${source.label} update`,
    summary: "Official AWS feed summary.",
    publishedAt: "2026-07-31T10:00:00.000Z",
    updatedAt: null,
    serviceLabels: source.id === "aws_news_blog" ? ["Amazon S3"] : [],
    categories: source.id === "aws_official_video" ? ["Amazon EKS"] : [],
  };
}

function succeeded(
  source: AwsNewsFeedSourceDefinition,
): AwsNewsFeedCapture {
  return {
    sourceId: source.id,
    status: "SUCCEEDED",
    requestUrl: source.feedUrl,
    finalUrl: source.feedUrl,
    redirectChain: [source.feedUrl],
    contentType: source.parser === "ATOM_1"
      ? "text/xml; charset=UTF-8"
      : "application/rss+xml;charset=UTF-8",
    responseBytes: 4_096,
    durationMs: 250,
    fetchedAt: "2026-07-31T11:59:30.000Z",
    parser: source.parser,
    truncated: false,
    failureCode: null,
    items: [item(source)],
  };
}

function capture(): Mutable<AwsNewsFeedsCapture> {
  return {
    schemaVersion: "sutra.aws-news-feeds.v1",
    scope: { ...SCOPE },
    captureId: `news_${"b".repeat(64)}`,
    startedAt: "2026-07-31T11:59:20.000Z",
    completedAt: "2026-07-31T12:00:00.000Z",
    feeds: AWS_NEWS_FEED_SOURCES.map(succeeded) as Mutable<AwsNewsFeedCapture>[],
  };
}

function boundary(): Mutable<AwsNewsTenantBoundary> {
  return {
    scope: { ...SCOPE },
    binding: "SERVER_RESOLVED_CONNECTION",
    catalogId: `catalog_${"c".repeat(64)}`,
    catalogCapturedAt: "2026-07-31T11:50:00.000Z",
    services: [{
      serviceId: "amazon-ec2",
      displayName: "Amazon EC2",
      aliases: ["Amazon EC2", "EC2"],
      enabled: true,
      observation: {
        basis: "RESOURCE_INVENTORY",
        observedAt: "2026-07-31T11:00:00.000Z",
        evidenceId: "inventory:ec2:20260731",
      },
    }, {
      serviceId: "amazon-eks",
      displayName: "Amazon EKS",
      aliases: ["Amazon EKS", "EKS"],
      enabled: true,
      observation: null,
    }, {
      serviceId: "amazon-s3",
      displayName: "Amazon S3",
      aliases: ["Amazon S3", "S3"],
      enabled: true,
      observation: {
        basis: "CUR2_DATA_EXPORT",
        observedAt: "2026-07-31T06:00:00.000Z",
        evidenceId: "cur2:billing:20260731",
      },
    }],
  };
}

test("pins five current official sources and their parser/authority contracts", () => {
  assert.equal(AWS_NEWS_FEED_SOURCES.length, 5);
  assert.deepEqual(
    AWS_NEWS_FEED_SOURCES.map((source) => source.id),
    [
      "aws_whats_new",
      "aws_news_blog",
      "aws_security_blog",
      "aws_security_bulletins",
      "aws_official_video",
    ],
  );
  for (const source of AWS_NEWS_FEED_SOURCES) {
    assert.equal(new URL(source.feedUrl).protocol, "https:");
    assert.equal(source.availability, "AVAILABLE");
    assert.doesNotThrow(() =>
      assertAwsNewsFeedRequestTarget(source.id, source.feedUrl)
    );
  }
  assert.equal(
    AWS_NEWS_FEED_SOURCES.at(-1)?.feedUrl,
    "https://www.youtube.com/feeds/videos.xml?channel_id=UCd6MoB9NC6uYN2grvUNT-Zg",
  );
});

test("normalizes official items and explains tenant relevance without inventing impact", () => {
  const snapshot = normalizeAwsNewsFeedsCapture(capture(), boundary(), NOW.getTime());
  assert.equal(snapshot.state, "READY");
  assert.equal(snapshot.coverage, "COMPLETE");
  assert.equal(snapshot.counts.sourcesSucceeded, 5);
  assert.equal(snapshot.counts.acceptedItems, 5);
  assert.equal(snapshot.counts.tenantRelevantItems, 3);
  assert.equal(snapshot.relevantItems.length, 3);
  assert.ok(snapshot.items.every((entry) => entry.impactAssessment === "NOT_ASSESSED"));

  const ec2 = snapshot.items.find((entry) => entry.sourceId === "aws_whats_new");
  assert.equal(ec2?.matchedServices[0]?.serviceId, "amazon-ec2");
  assert.equal(ec2?.matchedServices[0]?.usageBasis, "OBSERVED");
  assert.equal(ec2?.matchedServices[0]?.reason.kind, "EXACT_TITLE_ALIAS");
  const s3 = snapshot.items.find((entry) => entry.sourceId === "aws_news_blog");
  assert.equal(s3?.canonicalUrl.includes("trk="), false);
  assert.equal(s3?.canonicalUrl.includes("#"), false);
  assert.equal(s3?.matchedServices[0]?.reason.kind, "PROVIDER_SERVICE_LABEL");
  const eks = snapshot.items.find((entry) => entry.sourceId === "aws_official_video");
  assert.equal(eks?.canonicalUrl, "https://www.youtube.com/watch?v=AbCdEf123_-");
  assert.equal(eks?.matchedServices[0]?.usageBasis, "ENABLED");
  assert.match(snapshot.limitations.join(" "), /not evidence.*affected/iu);
});

test("rejects scope substitution and a non-server-bound service catalog", () => {
  const attacker = boundary();
  attacker.scope.customerId = "customer_attacker";
  assert.throws(
    () => normalizeAwsNewsFeedsCapture(capture(), attacker, NOW.getTime()),
    (error) => error instanceof AwsNewsFeedsError
      && error.code === "SCOPE_MISMATCH",
  );

  const clientCatalog = boundary();
  clientCatalog.binding = "CLIENT_REQUEST" as "SERVER_RESOLVED_CONNECTION";
  assert.throws(
    () => normalizeAwsNewsFeedsCapture(capture(), clientCatalog, NOW.getTime()),
    (error) => error instanceof AwsNewsFeedsError,
  );
});

test("rejects SSRF targets and redirect escape before transport parsing", () => {
  const attacks = [
    "http://aws.amazon.com/about-aws/whats-new/recent/feed/",
    "https://aws.amazon.com.evil.example/about-aws/whats-new/recent/feed/",
    "https://169.254.169.254/latest/meta-data/",
    "https://user@aws.amazon.com/about-aws/whats-new/recent/feed/",
    "https://aws.amazon.com/about-aws/whats-new/recent/feed/?url=http://169.254.169.254",
  ];
  for (const attack of attacks) {
    assert.throws(
      () => assertAwsNewsFeedRequestTarget("aws_whats_new", attack),
      (error) => error instanceof AwsNewsFeedsError
        && error.message === "AWS news feed evidence is invalid.",
    );
  }
  const expected = AWS_NEWS_FEED_SOURCES[0]!.feedUrl;
  assert.throws(
    () => assertAwsNewsFeedRedirectChain(
      "aws_whats_new",
      [expected, "https://evil.example/feed.xml"],
    ),
    (error) => error instanceof AwsNewsFeedsError
      && error.code === "SOURCE_POLICY_VIOLATION",
  );
  assert.throws(
    () => assertAwsNewsFeedRedirectChain(
      "aws_whats_new",
      [expected, expected, expected, expected],
    ),
    (error) => error instanceof AwsNewsFeedsError,
  );
});

test("rejects HTML responses, embedded markup, scripts, and encoded tags", () => {
  for (const mutation of [
    (value: Mutable<AwsNewsFeedsCapture>) => {
      const first = value.feeds[0] as Mutable<Extract<AwsNewsFeedCapture, { status: "SUCCEEDED" }>>;
      first.contentType = "text/html; charset=UTF-8";
    },
    (value: Mutable<AwsNewsFeedsCapture>) => {
      const first = value.feeds[0] as Mutable<Extract<AwsNewsFeedCapture, { status: "SUCCEEDED" }>>;
      first.items[0]!.summary = "<script>alert(1)</script>";
    },
    (value: Mutable<AwsNewsFeedsCapture>) => {
      const first = value.feeds[0] as Mutable<Extract<AwsNewsFeedCapture, { status: "SUCCEEDED" }>>;
      first.items[0]!.title = "&lt;img src=x onerror=alert(1)&gt;";
    },
  ]) {
    const unsafe = capture();
    mutation(unsafe);
    assert.throws(
      () => normalizeAwsNewsFeedsCapture(unsafe, boundary(), NOW.getTime()),
      (error) => error instanceof AwsNewsFeedsError,
    );
  }
});

test("enforces feed, item, byte, duration, and publication-date bounds", () => {
  const tooMany = capture();
  const first = tooMany.feeds[0] as Mutable<Extract<AwsNewsFeedCapture, { status: "SUCCEEDED" }>>;
  first.items = Array.from(
    { length: AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumItemsPerFeed + 1 },
    (_, index) => {
      const base = item(AWS_NEWS_FEED_SOURCES[0]!);
      return {
        ...base,
        externalId: `item:${index}`,
        serviceLabels: [...base.serviceLabels],
        categories: [...base.categories],
      };
    },
  );
  assert.throws(
    () => normalizeAwsNewsFeedsCapture(tooMany, boundary(), NOW.getTime()),
    (error) => error instanceof AwsNewsFeedsError
      && error.code === "LIMIT_EXCEEDED",
  );

  const tooLarge = capture();
  (tooLarge.feeds[0] as Mutable<Extract<AwsNewsFeedCapture, { status: "SUCCEEDED" }>>)
    .responseBytes = AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumFeedBytes + 1;
  assert.throws(
    () => normalizeAwsNewsFeedsCapture(tooLarge, boundary(), NOW.getTime()),
    (error) => error instanceof AwsNewsFeedsError,
  );

  const tooSlow = capture();
  tooSlow.feeds[0]!.durationMs =
    AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumFeedDurationMs + 1;
  assert.throws(
    () => normalizeAwsNewsFeedsCapture(tooSlow, boundary(), NOW.getTime()),
    (error) => error instanceof AwsNewsFeedsError,
  );

  for (const publishedAt of [
    "2025-01-01T00:00:00.000Z",
    "2026-07-31T12:10:00.000Z",
  ]) {
    const invalidDate = capture();
    const feed = invalidDate.feeds[0] as Mutable<Extract<AwsNewsFeedCapture, { status: "SUCCEEDED" }>>;
    feed.items[0]!.publishedAt = publishedAt;
    assert.throws(
      () => normalizeAwsNewsFeedsCapture(invalidDate, boundary(), NOW.getTime()),
      (error) => error instanceof AwsNewsFeedsError,
    );
  }
});

test("deduplicates deterministically and rejects conflicting duplicate evidence", () => {
  const duplicated = capture();
  const first = duplicated.feeds[0] as Mutable<Extract<AwsNewsFeedCapture, { status: "SUCCEEDED" }>>;
  first.items.push({
    ...first.items[0]!,
    serviceLabels: ["Amazon EC2"],
    categories: ["Compute"],
  });
  const forward = normalizeAwsNewsFeedsCapture(duplicated, boundary(), NOW.getTime());
  duplicated.feeds.reverse();
  const reversed = normalizeAwsNewsFeedsCapture(duplicated, boundary(), NOW.getTime());
  assert.deepEqual(reversed, forward);
  assert.equal(forward.counts.acceptedItems, 6);
  assert.equal(forward.counts.deduplicatedItems, 5);
  assert.deepEqual(
    forward.items.find((entry) => entry.sourceId === "aws_whats_new")?.categories,
    ["Compute"],
  );

  const conflict = capture();
  const conflictFeed = conflict.feeds[0] as Mutable<Extract<AwsNewsFeedCapture, { status: "SUCCEEDED" }>>;
  conflictFeed.items.push({ ...conflictFeed.items[0]!, title: "Conflicting title" });
  assert.throws(
    () => normalizeAwsNewsFeedsCapture(conflict, boundary(), NOW.getTime()),
    (error) => error instanceof AwsNewsFeedsError
      && error.code === "CONFLICTING_DUPLICATE",
  );
});

test("preserves partial and stale evidence using generic provider failures only", () => {
  const partial = capture();
  const source = AWS_NEWS_FEED_SOURCES[2]!;
  partial.feeds[2] = {
    sourceId: source.id,
    status: "FAILED",
    requestUrl: source.feedUrl,
    finalUrl: null,
    redirectChain: [source.feedUrl],
    contentType: null,
    responseBytes: 0,
    durationMs: 10_000,
    fetchedAt: "2026-07-31T11:59:30.000Z",
    parser: null,
    truncated: false,
    failureCode: "NETWORK_TIMEOUT",
    items: [],
    providerError: "secret upstream response must never escape",
  } as Mutable<AwsNewsFeedCapture>;
  const snapshot = normalizeAwsNewsFeedsCapture(partial, boundary(), NOW.getTime());
  assert.equal(snapshot.state, "PARTIAL");
  assert.equal(snapshot.coverage, "PARTIAL");
  assert.equal(snapshot.counts.sourcesFailed, 1);
  assert.equal(JSON.stringify(snapshot).includes("secret upstream"), false);
  const sourceEvidence = awsNewsFeedsSourceEvidence(snapshot);
  assert.equal(sourceEvidence.lastAttemptOutcome, "partial");
  assert.equal(sourceEvidence.coverage.assessment, "partial");
  assert.equal(sourceEvidence.lastError?.message, "AWS news feed collection was not complete.");

  const stale = capture();
  stale.startedAt = "2026-07-28T11:59:20.000Z";
  stale.completedAt = "2026-07-28T12:00:00.000Z";
  for (const feed of stale.feeds) {
    feed.fetchedAt = "2026-07-28T11:59:30.000Z";
    if (feed.status === "SUCCEEDED") {
      for (const feedItem of feed.items) {
        feedItem.publishedAt = "2026-07-28T10:00:00.000Z";
      }
    }
  }
  const oldBoundary = boundary();
  oldBoundary.catalogCapturedAt = "2026-07-28T11:50:00.000Z";
  const staleSnapshot = normalizeAwsNewsFeedsCapture(
    stale,
    oldBoundary,
    NOW.getTime(),
  );
  assert.equal(staleSnapshot.state, "STALE");
  assert.equal(staleSnapshot.coverage, "COMPLETE");
  assert.ok(staleSnapshot.sourceEvidence.every((entry) => entry.stale));
});

test("rejects malformed service catalogs and does not match disabled unobserved services", () => {
  const unsorted = boundary();
  unsorted.services.reverse();
  assert.throws(
    () => normalizeAwsNewsFeedsCapture(capture(), unsorted, NOW.getTime()),
    (error) => error instanceof AwsNewsFeedsError,
  );

  const disabled = boundary();
  disabled.services[0]!.enabled = false;
  disabled.services[0]!.observation = null;
  assert.throws(
    () => normalizeAwsNewsFeedsCapture(capture(), disabled, NOW.getTime()),
    (error) => error instanceof AwsNewsFeedsError,
  );

  const emptyFoldAlias = boundary();
  emptyFoldAlias.services[0]!.aliases = ["+++"];
  assert.throws(
    () => normalizeAwsNewsFeedsCapture(capture(), emptyFoldAlias, NOW.getTime()),
    (error) => error instanceof AwsNewsFeedsError,
  );
});
