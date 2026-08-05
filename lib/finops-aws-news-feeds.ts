/**
 * Evidence-honest AWS News Feeds normalization and tenant relevance engine.
 *
 * This is a pure trust boundary: it performs no network/database I/O, accepts
 * no credentials or request-derived tenant identifiers, and keeps no global
 * tenant cache. A credential-free scheduler/transport must use the exported
 * exact-source policy, parse XML without resolving external entities, and pass
 * a capture together with the server-resolved tenant service catalog.
 */
import type {
  FinopsSourceEvidence,
  FinopsSourceScope,
} from "./finops-source-health.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CAPTURE_ID = /^news_[a-f0-9]{64}$/u;
const CATALOG_ID = /^catalog_[a-f0-9]{64}$/u;
const EXTERNAL_ID = /^[\p{L}\p{N}][\p{L}\p{N}._:@/+\-=]{0,511}$/u;
const SERVICE_ID = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

export const AWS_NEWS_FEED_COLLECTION_BOUNDS = Object.freeze({
  maximumFeeds: 5,
  maximumItemsPerFeed: 500,
  maximumItemsPerCapture: 2_000,
  maximumFeedBytes: 2 * 1_024 * 1_024,
  maximumCaptureBytes: 12 * 1_024 * 1_024,
  maximumOutputBytes: 8 * 1_024 * 1_024,
  maximumFeedDurationMs: 10_000,
  maximumCollectionDurationMs: 45_000,
  maximumRedirects: 2,
  maximumItemAgeDays: 400,
  maximumDashboardItems: 1_000,
  maximumServices: 500,
  maximumAliasesPerService: 20,
  maximumCategoriesPerItem: 30,
  maximumServiceLabelsPerItem: 30,
  maximumTitleCharacters: 300,
  maximumSummaryCharacters: 2_000,
  maximumCategoryCharacters: 128,
  maximumServiceLabelCharacters: 128,
  freshnessSlaHours: 48,
} as const);

export type AwsNewsFeedSourceId =
  | "aws_whats_new"
  | "aws_news_blog"
  | "aws_security_blog"
  | "aws_security_bulletins"
  | "aws_official_video";

export type AwsNewsFeedKind =
  | "WHATS_NEW"
  | "BLOG"
  | "SECURITY_BLOG"
  | "SECURITY_BULLETIN"
  | "VIDEO";

export interface AwsNewsFeedSourceDefinition {
  readonly id: AwsNewsFeedSourceId;
  readonly label: string;
  readonly kind: AwsNewsFeedKind;
  readonly feedUrl: string;
  readonly parser: "RSS_2" | "ATOM_1";
  readonly authority: "AWS_OWNED" | "AWS_OFFICIAL_CHANNEL";
  readonly availability: "AVAILABLE";
}

/**
 * Exact current public feed endpoints. The video channel is the same official
 * channel pinned by AWS's Cloud Intelligence Dashboards data-collection
 * module. No caller-supplied host/path/query is accepted.
 */
export const AWS_NEWS_FEED_SOURCES: readonly AwsNewsFeedSourceDefinition[] =
  Object.freeze([
    Object.freeze({
      id: "aws_whats_new",
      label: "AWS What's New",
      kind: "WHATS_NEW",
      feedUrl: "https://aws.amazon.com/about-aws/whats-new/recent/feed/",
      parser: "RSS_2",
      authority: "AWS_OWNED",
      availability: "AVAILABLE",
    }),
    Object.freeze({
      id: "aws_news_blog",
      label: "AWS News Blog",
      kind: "BLOG",
      feedUrl: "https://aws.amazon.com/blogs/aws/feed/",
      parser: "RSS_2",
      authority: "AWS_OWNED",
      availability: "AVAILABLE",
    }),
    Object.freeze({
      id: "aws_security_blog",
      label: "AWS Security Blog",
      kind: "SECURITY_BLOG",
      feedUrl: "https://aws.amazon.com/blogs/security/feed/",
      parser: "RSS_2",
      authority: "AWS_OWNED",
      availability: "AVAILABLE",
    }),
    Object.freeze({
      id: "aws_security_bulletins",
      label: "AWS Security Bulletins",
      kind: "SECURITY_BULLETIN",
      feedUrl:
        "https://aws.amazon.com/security/security-bulletins/rss/feed/",
      parser: "RSS_2",
      authority: "AWS_OWNED",
      availability: "AVAILABLE",
    }),
    Object.freeze({
      id: "aws_official_video",
      label: "AWS official videos",
      kind: "VIDEO",
      feedUrl:
        "https://www.youtube.com/feeds/videos.xml?channel_id=UCd6MoB9NC6uYN2grvUNT-Zg",
      parser: "ATOM_1",
      authority: "AWS_OFFICIAL_CHANNEL",
      availability: "AVAILABLE",
    }),
  ] satisfies readonly AwsNewsFeedSourceDefinition[]);

export type AwsNewsFeedFailureCode =
  | "NETWORK_TIMEOUT"
  | "HTTP_FAILURE"
  | "REDIRECT_REJECTED"
  | "BYTE_LIMIT_REACHED"
  | "ITEM_LIMIT_REACHED"
  | "INVALID_CONTENT_TYPE"
  | "INVALID_DOCUMENT"
  | "PROVIDER_UNAVAILABLE"
  | "UNKNOWN";

export type AwsNewsFeedBoundaryErrorCode =
  | "INVALID_INPUT"
  | "SCOPE_MISMATCH"
  | "SOURCE_POLICY_VIOLATION"
  | "UNSAFE_CONTENT"
  | "LIMIT_EXCEEDED"
  | "CONFLICTING_DUPLICATE";

export class AwsNewsFeedsError extends Error {
  readonly code: AwsNewsFeedBoundaryErrorCode;

  constructor(code: AwsNewsFeedBoundaryErrorCode) {
    super("AWS news feed evidence is invalid.");
    this.name = "AwsNewsFeedsError";
    this.code = code;
  }
}

export interface AwsNewsFeedItemCapture {
  readonly externalId: string;
  readonly canonicalUrl: string;
  readonly title: string;
  /** Plain text produced by the non-HTML XML parser; markup is rejected. */
  readonly summary: string;
  readonly publishedAt: string;
  readonly updatedAt: string | null;
  /** Provider-authored service labels only, never inferred by the transport. */
  readonly serviceLabels: readonly string[];
  readonly categories: readonly string[];
}

interface AwsNewsFeedCaptureBase {
  readonly sourceId: AwsNewsFeedSourceId;
  readonly requestUrl: string;
  /** Includes requestUrl followed by every redirect target, if any. */
  readonly redirectChain: readonly string[];
  readonly durationMs: number;
  readonly fetchedAt: string;
}

export interface AwsNewsFeedSucceededCapture extends AwsNewsFeedCaptureBase {
  readonly status: "SUCCEEDED";
  readonly finalUrl: string;
  readonly contentType: string;
  readonly responseBytes: number;
  readonly parser: "RSS_2" | "ATOM_1";
  readonly truncated: boolean;
  readonly failureCode: null;
  readonly items: readonly AwsNewsFeedItemCapture[];
}

export interface AwsNewsFeedFailedCapture extends AwsNewsFeedCaptureBase {
  readonly status: "FAILED";
  readonly finalUrl: string | null;
  readonly contentType: null;
  readonly responseBytes: 0;
  readonly parser: null;
  readonly truncated: false;
  readonly failureCode: AwsNewsFeedFailureCode;
  readonly items: readonly [];
}

export type AwsNewsFeedCapture =
  | AwsNewsFeedSucceededCapture
  | AwsNewsFeedFailedCapture;

export interface AwsNewsFeedsCapture {
  readonly schemaVersion: "sutra.aws-news-feeds.v1";
  readonly scope: FinopsSourceScope;
  readonly captureId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly feeds: readonly AwsNewsFeedCapture[];
}

export type AwsNewsObservedServiceBasis =
  | "CUR2_DATA_EXPORT"
  | "RESOURCE_INVENTORY";

export interface AwsNewsTenantService {
  readonly serviceId: string;
  readonly displayName: string;
  /** Lower/upper case is ignored; matching uses whole normalized phrases. */
  readonly aliases: readonly string[];
  readonly enabled: boolean;
  readonly observation: {
    readonly basis: AwsNewsObservedServiceBasis;
    readonly observedAt: string;
    readonly evidenceId: string;
  } | null;
}

export interface AwsNewsTenantBoundary {
  readonly scope: FinopsSourceScope;
  /** The caller must obtain this catalog from the server-side connection. */
  readonly binding: "SERVER_RESOLVED_CONNECTION";
  readonly catalogId: string;
  readonly catalogCapturedAt: string;
  /** Sorted by serviceId and immutable for this evaluation. */
  readonly services: readonly AwsNewsTenantService[];
}

export type AwsNewsRelevanceReasonKind =
  | "PROVIDER_SERVICE_LABEL"
  | "EXACT_CATEGORY_ALIAS"
  | "EXACT_TITLE_ALIAS";

export interface AwsNewsMatchedService {
  readonly serviceId: string;
  readonly displayName: string;
  readonly usageBasis: "OBSERVED" | "ENABLED";
  readonly observedAt: string | null;
  readonly observationBasis: AwsNewsObservedServiceBasis | null;
  readonly reason: {
    readonly kind: AwsNewsRelevanceReasonKind;
    readonly matchedAlias: string;
  };
}

export interface AwsNewsNormalizedItem {
  readonly sourceId: AwsNewsFeedSourceId;
  readonly sourceLabel: string;
  readonly feedKind: AwsNewsFeedKind;
  readonly externalId: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly summary: string;
  readonly publishedAt: string;
  readonly updatedAt: string | null;
  readonly serviceLabels: readonly string[];
  readonly categories: readonly string[];
  readonly matchedServices: readonly AwsNewsMatchedService[];
  readonly tenantRelevant: boolean;
  /** Public news is context only; this engine does not assert customer impact. */
  readonly impactAssessment: "NOT_ASSESSED";
}

export interface AwsNewsSourceEvidence {
  readonly sourceId: AwsNewsFeedSourceId;
  readonly label: string;
  readonly kind: AwsNewsFeedKind;
  readonly authority: "AWS_OWNED" | "AWS_OFFICIAL_CHANNEL";
  readonly status: "SUCCEEDED" | "FAILED" | "TRUNCATED";
  readonly fetchedAt: string;
  readonly lastPublishedAt: string | null;
  readonly acceptedItems: number;
  readonly failureCode: AwsNewsFeedFailureCode | null;
  readonly stale: boolean;
}

export interface AwsNewsFeedsSnapshot {
  readonly schemaVersion: "sutra.aws-news-feeds.snapshot.v1";
  readonly scope: FinopsSourceScope;
  readonly captureId: string;
  readonly catalogId: string;
  readonly observedAt: string;
  readonly state: "READY" | "PARTIAL" | "STALE" | "FAILED";
  readonly coverage: "COMPLETE" | "PARTIAL" | "UNKNOWN";
  readonly sourceEvidence: readonly AwsNewsSourceEvidence[];
  readonly items: readonly AwsNewsNormalizedItem[];
  readonly relevantItems: readonly AwsNewsNormalizedItem[];
  readonly counts: {
    readonly sourcesSucceeded: number;
    readonly sourcesFailed: number;
    readonly sourcesTruncated: number;
    readonly acceptedItems: number;
    readonly deduplicatedItems: number;
    readonly tenantRelevantItems: number;
  };
  readonly limitations: readonly string[];
}

const SOURCE_BY_ID = new Map(
  AWS_NEWS_FEED_SOURCES.map((source) => [source.id, source]),
);

/** Validate a scheduler request before any network call. */
export function assertAwsNewsFeedRequestTarget(
  sourceId: AwsNewsFeedSourceId,
  targetUrl: string,
): void {
  const source = SOURCE_BY_ID.get(sourceId);
  if (source === undefined || canonicalFeedUrl(targetUrl) !== source.feedUrl) {
    invalid("SOURCE_POLICY_VIOLATION");
  }
}

/**
 * Validate redirect history before parsing a response. Redirects can never
 * change scheme, authority, path, or query away from the pinned source.
 */
export function assertAwsNewsFeedRedirectChain(
  sourceId: AwsNewsFeedSourceId,
  redirectChain: readonly string[],
): void {
  if (
    !Array.isArray(redirectChain)
    || redirectChain.length < 1
    || redirectChain.length > AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumRedirects + 1
  ) invalid("SOURCE_POLICY_VIOLATION");
  for (const target of redirectChain) {
    assertAwsNewsFeedRequestTarget(sourceId, target);
  }
}

export function normalizeAwsNewsFeedsCapture(
  capture: AwsNewsFeedsCapture,
  boundary: AwsNewsTenantBoundary,
  nowMs = Date.now(),
): AwsNewsFeedsSnapshot {
  validateNow(nowMs);
  validateScope(capture.scope);
  validateScope(boundary.scope);
  if (!sameScope(capture.scope, boundary.scope)) invalid("SCOPE_MISMATCH");
  if (
    capture.schemaVersion !== "sutra.aws-news-feeds.v1"
    || !CAPTURE_ID.test(capture.captureId)
    || boundary.binding !== "SERVER_RESOLVED_CONNECTION"
    || !CATALOG_ID.test(boundary.catalogId)
  ) invalid();

  const startedMs = timestamp(capture.startedAt, nowMs + MAX_CLOCK_SKEW_MS);
  const completedMs = timestamp(capture.completedAt, nowMs + MAX_CLOCK_SKEW_MS);
  const catalogCapturedMs = timestamp(
    boundary.catalogCapturedAt,
    nowMs + MAX_CLOCK_SKEW_MS,
  );
  if (
    completedMs < startedMs
    || completedMs - startedMs
      > AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumCollectionDurationMs
    || catalogCapturedMs > completedMs + MAX_CLOCK_SKEW_MS
  ) invalid("LIMIT_EXCEEDED");
  if (utf8Bytes(capture) > AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumCaptureBytes) {
    invalid("LIMIT_EXCEEDED");
  }

  const services = validateServiceCatalog(boundary.services, nowMs);
  if (
    !Array.isArray(capture.feeds)
    || capture.feeds.length !== AWS_NEWS_FEED_SOURCES.length
  ) invalid("LIMIT_EXCEEDED");

  const sourceEvidence: AwsNewsSourceEvidence[] = [];
  const normalizedCandidates: Array<
    Omit<AwsNewsNormalizedItem, "matchedServices" | "tenantRelevant">
  > = [];
  const observedSources = new Set<AwsNewsFeedSourceId>();
  let rawAcceptedItems = 0;

  for (const feed of capture.feeds) {
    if (observedSources.has(feed.sourceId)) invalid("CONFLICTING_DUPLICATE");
    observedSources.add(feed.sourceId);
    const source = SOURCE_BY_ID.get(feed.sourceId);
    if (source === undefined) invalid("SOURCE_POLICY_VIOLATION");
    assertAwsNewsFeedRequestTarget(feed.sourceId, feed.requestUrl);
    assertAwsNewsFeedRedirectChain(feed.sourceId, feed.redirectChain);
    const fetchedMs = timestamp(feed.fetchedAt, nowMs + MAX_CLOCK_SKEW_MS);
    integer(
      feed.durationMs,
      0,
      AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumFeedDurationMs,
    );
    if (fetchedMs < startedMs || fetchedMs > completedMs + MAX_CLOCK_SKEW_MS) {
      invalid();
    }

    if (feed.status === "FAILED") {
      validateFailedFeed(feed);
      sourceEvidence.push({
        sourceId: source.id,
        label: source.label,
        kind: source.kind,
        authority: source.authority,
        status: "FAILED",
        fetchedAt: feed.fetchedAt,
        lastPublishedAt: null,
        acceptedItems: 0,
        failureCode: feed.failureCode,
        stale: nowMs - fetchedMs
          > AWS_NEWS_FEED_COLLECTION_BOUNDS.freshnessSlaHours * 60 * 60 * 1_000,
      });
      continue;
    }

    validateSucceededFeed(feed, source);
    rawAcceptedItems += feed.items.length;
    if (
      rawAcceptedItems
      > AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumItemsPerCapture
    ) invalid("LIMIT_EXCEEDED");
    let lastPublishedAt: string | null = null;
    for (const item of feed.items) {
      const normalized = normalizeItem(item, source, fetchedMs);
      normalizedCandidates.push(normalized);
      if (lastPublishedAt === null || normalized.publishedAt > lastPublishedAt) {
        lastPublishedAt = normalized.publishedAt;
      }
    }
    sourceEvidence.push({
      sourceId: source.id,
      label: source.label,
      kind: source.kind,
      authority: source.authority,
      status: feed.truncated ? "TRUNCATED" : "SUCCEEDED",
      fetchedAt: feed.fetchedAt,
      lastPublishedAt,
      acceptedItems: feed.items.length,
      failureCode: feed.truncated ? "ITEM_LIMIT_REACHED" : null,
      stale: nowMs - fetchedMs
        > AWS_NEWS_FEED_COLLECTION_BOUNDS.freshnessSlaHours * 60 * 60 * 1_000,
    });
  }

  if (observedSources.size !== AWS_NEWS_FEED_SOURCES.length) {
    invalid("SOURCE_POLICY_VIOLATION");
  }

  const deduplicated = deduplicateItems(normalizedCandidates);
  const items = deduplicated
    .map((item) => attachRelevance(item, services))
    .sort(compareItems)
    .slice(0, AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumDashboardItems);
  const relevantItems = items.filter((item) => item.tenantRelevant);
  const orderedEvidence = sourceEvidence.sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId)
  );
  const sourcesFailed = orderedEvidence.filter(
    (entry) => entry.status === "FAILED",
  ).length;
  const sourcesTruncated = orderedEvidence.filter(
    (entry) => entry.status === "TRUNCATED",
  ).length;
  const sourcesSucceeded = orderedEvidence.length - sourcesFailed;
  const stale = orderedEvidence.some((entry) => entry.stale);
  const state = sourcesSucceeded === 0
    ? "FAILED"
    : sourcesFailed > 0 || sourcesTruncated > 0
    ? "PARTIAL"
    : stale
    ? "STALE"
    : "READY";
  const snapshot: AwsNewsFeedsSnapshot = {
    schemaVersion: "sutra.aws-news-feeds.snapshot.v1",
    scope: { ...capture.scope },
    captureId: capture.captureId,
    catalogId: boundary.catalogId,
    observedAt: capture.completedAt,
    state,
    coverage: state === "READY" || state === "STALE"
      ? "COMPLETE"
      : sourcesSucceeded > 0
      ? "PARTIAL"
      : "UNKNOWN",
    sourceEvidence: orderedEvidence,
    items,
    relevantItems,
    counts: {
      sourcesSucceeded,
      sourcesFailed,
      sourcesTruncated,
      acceptedItems: rawAcceptedItems,
      deduplicatedItems: deduplicated.length,
      tenantRelevantItems: relevantItems.length,
    },
    limitations: [
      "AWS public feeds provide announcements and guidance, not evidence that a tenant resource is affected.",
      "Tenant relevance is an explainable exact match against the server-pinned enabled or observed service catalog; impact is never inferred.",
      "Feed freshness reflects successful public-feed retrieval, not real-time delivery or complete historical retention.",
    ],
  };
  if (utf8Bytes(snapshot) > AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumOutputBytes) {
    invalid("LIMIT_EXCEEDED");
  }
  return snapshot;
}

export function awsNewsFeedsSourceEvidence(
  snapshot: AwsNewsFeedsSnapshot,
): FinopsSourceEvidence {
  const successful = snapshot.counts.sourcesSucceeded > 0;
  const partial = snapshot.state === "PARTIAL";
  return {
    scope: { ...snapshot.scope },
    sourceId: "aws_news_feeds",
    configured: true,
    deliveryObserved: successful,
    lastAttemptAt: snapshot.observedAt,
    lastAttemptOutcome: !successful ? "failed" : partial ? "partial" : "succeeded",
    lastSuccessAt: successful ? snapshot.observedAt : null,
    dataThroughAt: successful ? snapshot.observedAt : null,
    coverage: {
      assessment: snapshot.coverage === "COMPLETE"
        ? "complete"
        : snapshot.coverage === "PARTIAL"
        ? "partial"
        : "unknown",
      acceptedRecords: snapshot.counts.deduplicatedItems,
      expectedRecords: null,
      rejectedRecords: null,
    },
    lastError: partial || !successful
      ? {
        code: partial ? "AWS_NEWS_FEEDS_PARTIAL" : "AWS_NEWS_FEEDS_FAILED",
        message: "AWS news feed collection was not complete.",
        at: snapshot.observedAt,
      }
      : null,
    evidenceBasis:
      "Exact official public feed captures normalized under the Sutra AWS News Feeds v1 contract.",
    limitations: snapshot.limitations,
  };
}

function validateSucceededFeed(
  feed: AwsNewsFeedSucceededCapture,
  source: AwsNewsFeedSourceDefinition,
): void {
  if (
    feed.failureCode !== null
    || feed.parser !== source.parser
    || feed.finalUrl !== feed.redirectChain.at(-1)
    || feed.finalUrl !== source.feedUrl
    || typeof feed.truncated !== "boolean"
    || !isAllowedXmlContentType(feed.contentType)
  ) invalid("SOURCE_POLICY_VIOLATION");
  integer(
    feed.responseBytes,
    1,
    AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumFeedBytes,
  );
  if (
    !Array.isArray(feed.items)
    || feed.items.length
      > AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumItemsPerFeed
    || (feed.truncated
      && feed.items.length
        !== AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumItemsPerFeed)
  ) invalid("LIMIT_EXCEEDED");
}

function validateFailedFeed(feed: AwsNewsFeedFailedCapture): void {
  if (
    feed.failureCode === null
    || !FAILURE_CODES.has(feed.failureCode)
    || feed.contentType !== null
    || feed.responseBytes !== 0
    || feed.parser !== null
    || feed.truncated !== false
    || !Array.isArray(feed.items)
    || feed.items.length !== 0
    || (feed.finalUrl !== null
      && feed.finalUrl !== feed.redirectChain.at(-1))
  ) invalid();
}

const FAILURE_CODES = new Set<AwsNewsFeedFailureCode>([
  "NETWORK_TIMEOUT",
  "HTTP_FAILURE",
  "REDIRECT_REJECTED",
  "BYTE_LIMIT_REACHED",
  "ITEM_LIMIT_REACHED",
  "INVALID_CONTENT_TYPE",
  "INVALID_DOCUMENT",
  "PROVIDER_UNAVAILABLE",
  "UNKNOWN",
]);

function normalizeItem(
  item: AwsNewsFeedItemCapture,
  source: AwsNewsFeedSourceDefinition,
  fetchedMs: number,
): Omit<AwsNewsNormalizedItem, "matchedServices" | "tenantRelevant"> {
  if (!EXTERNAL_ID.test(item.externalId)) invalid();
  const title = plainText(
    item.title,
    AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumTitleCharacters,
  );
  const summary = plainText(
    item.summary,
    AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumSummaryCharacters,
    true,
  );
  const publishedMs = timestamp(item.publishedAt, fetchedMs + MAX_CLOCK_SKEW_MS);
  if (
    fetchedMs - publishedMs
    > AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumItemAgeDays * DAY_MS
  ) invalid("LIMIT_EXCEEDED");
  const updatedAt = item.updatedAt === null
    ? null
    : timestampText(item.updatedAt, fetchedMs + MAX_CLOCK_SKEW_MS);
  if (updatedAt !== null && Date.parse(updatedAt) < publishedMs) invalid();
  const categories = stringList(
    item.categories,
    AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumCategoriesPerItem,
    AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumCategoryCharacters,
  );
  const serviceLabels = stringList(
    item.serviceLabels,
    AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumServiceLabelsPerItem,
    AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumServiceLabelCharacters,
  );
  return {
    sourceId: source.id,
    sourceLabel: source.label,
    feedKind: source.kind,
    externalId: item.externalId,
    canonicalUrl: canonicalItemUrl(source.id, item.canonicalUrl),
    title,
    summary,
    publishedAt: new Date(publishedMs).toISOString(),
    updatedAt,
    serviceLabels,
    categories,
    impactAssessment: "NOT_ASSESSED",
  };
}

function validateServiceCatalog(
  values: readonly AwsNewsTenantService[],
  nowMs: number,
): readonly AwsNewsTenantService[] {
  if (
    !Array.isArray(values)
    || values.length > AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumServices
  ) invalid("LIMIT_EXCEEDED");
  const output: AwsNewsTenantService[] = [];
  let previous = "";
  for (const value of values) {
    if (
      !SERVICE_ID.test(value.serviceId)
      || value.serviceId <= previous
      || typeof value.enabled !== "boolean"
    ) invalid();
    previous = value.serviceId;
    const displayName = plainText(value.displayName, 128);
    const aliases = stringList(
      value.aliases,
      AWS_NEWS_FEED_COLLECTION_BOUNDS.maximumAliasesPerService,
      128,
    );
    const foldedAliases = aliases.map(foldPhrase);
    if (
      aliases.length === 0
      || foldedAliases.some((alias) => alias.length < 2)
      || new Set(foldedAliases).size !== aliases.length
    ) {
      invalid();
    }
    let observation: AwsNewsTenantService["observation"] = null;
    if (value.observation !== null) {
      if (
        !new Set(["CUR2_DATA_EXPORT", "RESOURCE_INVENTORY"]).has(
          value.observation.basis,
        )
        || !EVIDENCE_ID.test(value.observation.evidenceId)
      ) invalid();
      observation = {
        basis: value.observation.basis,
        observedAt: timestampText(
          value.observation.observedAt,
          nowMs + MAX_CLOCK_SKEW_MS,
        ),
        evidenceId: value.observation.evidenceId,
      };
    }
    if (!value.enabled && observation === null) invalid();
    output.push({
      serviceId: value.serviceId,
      displayName,
      aliases,
      enabled: value.enabled,
      observation,
    });
  }
  return output;
}

function attachRelevance(
  item: Omit<AwsNewsNormalizedItem, "matchedServices" | "tenantRelevant">,
  services: readonly AwsNewsTenantService[],
): AwsNewsNormalizedItem {
  const matchedServices: AwsNewsMatchedService[] = [];
  for (const service of services) {
    let match: AwsNewsMatchedService["reason"] | null = null;
    for (const alias of service.aliases) {
      const folded = foldPhrase(alias);
      if (item.serviceLabels.some((label) => foldPhrase(label) === folded)) {
        match = { kind: "PROVIDER_SERVICE_LABEL", matchedAlias: alias };
        break;
      }
      if (item.categories.some((category) => containsPhrase(category, folded))) {
        match ??= { kind: "EXACT_CATEGORY_ALIAS", matchedAlias: alias };
      }
      if (containsPhrase(item.title, folded)) {
        match ??= { kind: "EXACT_TITLE_ALIAS", matchedAlias: alias };
      }
    }
    if (match !== null) {
      matchedServices.push({
        serviceId: service.serviceId,
        displayName: service.displayName,
        usageBasis: service.observation === null ? "ENABLED" : "OBSERVED",
        observedAt: service.observation?.observedAt ?? null,
        observationBasis: service.observation?.basis ?? null,
        reason: match,
      });
    }
  }
  return {
    ...item,
    matchedServices,
    tenantRelevant: matchedServices.length > 0,
  };
}

function deduplicateItems(
  values: readonly Omit<
    AwsNewsNormalizedItem,
    "matchedServices" | "tenantRelevant"
  >[],
): readonly Omit<
  AwsNewsNormalizedItem,
  "matchedServices" | "tenantRelevant"
>[] {
  const byUrl = new Map<string, typeof values[number]>();
  for (const value of [...values].sort(compareCandidateItems)) {
    const existing = byUrl.get(value.canonicalUrl);
    if (existing === undefined) {
      byUrl.set(value.canonicalUrl, value);
      continue;
    }
    if (
      existing.title !== value.title
      || existing.publishedAt !== value.publishedAt
      || existing.feedKind !== value.feedKind
    ) invalid("CONFLICTING_DUPLICATE");
    byUrl.set(value.canonicalUrl, {
      ...existing,
      categories: sortedUnion(existing.categories, value.categories),
      serviceLabels: sortedUnion(
        existing.serviceLabels,
        value.serviceLabels,
      ),
      updatedAt: [existing.updatedAt, value.updatedAt]
        .filter((entry): entry is string => entry !== null)
        .sort()
        .at(-1) ?? null,
    });
  }
  return [...byUrl.values()];
}

function compareCandidateItems(
  left: Omit<AwsNewsNormalizedItem, "matchedServices" | "tenantRelevant">,
  right: Omit<AwsNewsNormalizedItem, "matchedServices" | "tenantRelevant">,
): number {
  return left.canonicalUrl.localeCompare(right.canonicalUrl)
    || left.sourceId.localeCompare(right.sourceId)
    || left.externalId.localeCompare(right.externalId);
}

function compareItems(
  left: AwsNewsNormalizedItem,
  right: AwsNewsNormalizedItem,
): number {
  return right.publishedAt.localeCompare(left.publishedAt)
    || left.sourceId.localeCompare(right.sourceId)
    || left.canonicalUrl.localeCompare(right.canonicalUrl);
}

function canonicalFeedUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 512) invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid("SOURCE_POLICY_VIOLATION");
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.port !== ""
    || url.hash !== ""
    || !new Set(["aws.amazon.com", "www.youtube.com"]).has(url.hostname)
  ) invalid("SOURCE_POLICY_VIOLATION");
  return url.toString();
}

function canonicalItemUrl(
  sourceId: AwsNewsFeedSourceId,
  value: unknown,
): string {
  if (typeof value !== "string" || value.length > 2_048) invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid("SOURCE_POLICY_VIOLATION");
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.port !== ""
  ) invalid("SOURCE_POLICY_VIOLATION");
  url.hash = "";
  if (sourceId === "aws_official_video") {
    const videoId = url.searchParams.get("v");
    if (
      url.hostname !== "www.youtube.com"
      || url.pathname !== "/watch"
      || videoId === null
      || !YOUTUBE_VIDEO_ID.test(videoId)
    ) invalid("SOURCE_POLICY_VIOLATION");
    url.search = "";
    url.searchParams.set("v", videoId);
    return url.toString();
  }
  if (url.hostname !== "aws.amazon.com") {
    invalid("SOURCE_POLICY_VIOLATION");
  }
  const requiredPrefix: Record<Exclude<AwsNewsFeedSourceId, "aws_official_video">, string> = {
    aws_whats_new: "/about-aws/whats-new/",
    aws_news_blog: "/blogs/aws/",
    aws_security_blog: "/blogs/security/",
    aws_security_bulletins: "/security/security-bulletins/",
  };
  if (!url.pathname.startsWith(requiredPrefix[sourceId])) {
    invalid("SOURCE_POLICY_VIOLATION");
  }
  url.search = "";
  return url.toString();
}

function isAllowedXmlContentType(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 128) return false;
  const mime = value.split(";", 1)[0]?.trim().toLowerCase();
  return new Set([
    "application/rss+xml",
    "application/atom+xml",
    "application/xml",
    "text/xml",
  ]).has(mime ?? "");
}

function plainText(
  value: unknown,
  maximum: number,
  emptyAllowed = false,
): string {
  if (typeof value !== "string") invalid("UNSAFE_CONTENT");
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (
    (!emptyAllowed && normalized.length === 0)
    || normalized.length > maximum
    || /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(normalized)
    || /&(?:lt|gt|#0*60|#0*62|#x0*3c|#x0*3e);/iu.test(normalized)
    || /(?:javascript|vbscript|data\s*:\s*text\/html)\s*:/iu.test(normalized)
  ) invalid("UNSAFE_CONTENT");
  return normalized;
}

function stringList(
  values: readonly string[],
  maximumItems: number,
  maximumCharacters: number,
): readonly string[] {
  if (!Array.isArray(values) || values.length > maximumItems) {
    invalid("LIMIT_EXCEEDED");
  }
  const normalized = values.map((value) => plainText(value, maximumCharacters));
  const unique = new Map(normalized.map((value) => [foldPhrase(value), value]));
  return [...unique.values()].sort((left, right) => left.localeCompare(right));
}

function containsPhrase(value: string, foldedPhrase: string): boolean {
  return ` ${foldPhrase(value)} `.includes(` ${foldedPhrase} `);
}

function foldPhrase(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function sortedUnion(
  left: readonly string[],
  right: readonly string[],
): readonly string[] {
  return [...new Set([...left, ...right])].sort((a, b) => a.localeCompare(b));
}

function timestamp(value: unknown, maximumMs: number): number {
  const candidate = timestampText(value, maximumMs);
  return Date.parse(candidate);
}

function timestampText(value: unknown, maximumMs: number): string {
  if (typeof value !== "string" || value.length > 40) invalid();
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== value
    || milliseconds > maximumMs
  ) invalid();
  return value;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) invalid("LIMIT_EXCEEDED");
  return value as number;
}

function validateScope(scope: FinopsSourceScope): void {
  if (
    scope === null
    || typeof scope !== "object"
    || !IDENTIFIER.test(scope.orgId)
    || !IDENTIFIER.test(scope.customerId)
    || !CONNECTION_ID.test(scope.connectionId)
  ) invalid();
}

function sameScope(left: FinopsSourceScope, right: FinopsSourceScope): boolean {
  return left.orgId === right.orgId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId;
}

function validateNow(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) invalid();
}

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function invalid(code: AwsNewsFeedBoundaryErrorCode = "INVALID_INPUT"): never {
  throw new AwsNewsFeedsError(code);
}
