# AWS News Feeds: governed collection and tenant relevance

## Status

This slice provides a production-oriented, transport-independent normalizer,
source policy, relevance engine, source-health projection, and tests. It does
not schedule network calls, persist captures, expose an API, or render a UI.
It is therefore implementation evidence, not live or production-accepted
evidence.

AWS documents the Cloud Intelligence Dashboard as covering What's New, blog
posts, videos, and security bulletins with service/feed/category filtering:

- [AWS News Feeds dashboard](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/news-feeds.html)
- [AWS Cloud Intelligence Dashboards data collection](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/data-collection.html)
- [Current AWS Solutions Library collector source](https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-data-collection/blob/main/data-collection/deploy/module-aws-feeds.yaml)

## Pinned official sources

The following exact HTTPS endpoints returned HTTP 200 with an XML/RSS content
type during engineering verification on 2026-07-31. `AVAILABLE` means the
endpoint was authoritative and reachable at that observation; it is not an
availability guarantee.

| Source | Exact feed | Authority | Availability basis |
|---|---|---|---|
| AWS What's New | `https://aws.amazon.com/about-aws/whats-new/recent/feed/` | AWS-owned | Used by the current AWS Solutions Library collector |
| AWS News Blog | `https://aws.amazon.com/blogs/aws/feed/` | AWS-owned | AWS directs subscribers to this feed and the current collector uses it |
| AWS Security Blog | `https://aws.amazon.com/blogs/security/feed/` | AWS-owned | Feed published by the AWS Security Blog |
| AWS Security Bulletins | `https://aws.amazon.com/security/security-bulletins/rss/feed/` | AWS-owned | Used by the current AWS Solutions Library collector; the [Security Bulletins page](https://aws.amazon.com/security/security-bulletins/) advertises RSS |
| AWS official videos | `https://www.youtube.com/feeds/videos.xml?channel_id=UCd6MoB9NC6uYN2grvUNT-Zg` | AWS official channel on YouTube | Exact channel feed pinned by the current AWS Solutions Library collector |

No community, reseller, scraped-search, `aws-news.com`, client-supplied, or
redirect-discovered source is allowed. The CID workshop feed in the upstream
collector is intentionally excluded because this Sutra capability is for AWS
service/news relevance rather than product-specific CID release notes.

## Trust boundary

`lib/finops-aws-news-feeds.ts` is pure and holds no credentials or global
tenant cache. It accepts:

1. A capture produced by a credential-free governed transport using all five
   exact source definitions.
2. A server-resolved tenant boundary containing the exact organization,
   customer, connection, immutable catalog ID, and sorted enabled/observed AWS
   service catalog.

The service catalog must come from persisted connection state on the server.
An API must never deserialize the catalog, tenant/customer ID, connection ID,
aliases, enabled state, observation basis, or observation evidence ID from a
browser request. Observed usage is limited to a CUR2 Data Export or resource
inventory evidence reference. A service may also be explicitly enabled without
an observation; disabled and unobserved services are rejected.

Tenant relevance is deterministic and explainable. A service matches only by:

- an exact provider service label;
- a whole normalized phrase in a provider category; or
- a whole normalized phrase in the title.

Each match returns the exact alias, method, and whether the tenant basis is
`OBSERVED` or `ENABLED`. The engine does not use opaque NLP, sentiment,
severity inference, or summary-text guessing. Every item states
`impactAssessment: NOT_ASSESSED`: public AWS news is not evidence that a
tenant resource is affected.

## Governed transport contract

The eventual collector/gateway must meet all of these requirements before
this slice can be considered wired:

- take a source ID from the server schedule, never a URL from a request;
- call `assertAwsNewsFeedRequestTarget` before connection;
- require HTTPS, the exact host, exact path, and exact query from the source
  table; reject userinfo, custom ports, fragments, IP literals, host suffixes,
  and alternate schemes;
- disable automatic redirects, validate every `Location` with
  `assertAwsNewsFeedRedirectChain`, allow at most two, and reject any redirect
  that changes the pinned scheme/authority/path/query;
- set a 10-second per-feed deadline and 45-second overall deadline;
- stream at most 2 MiB per feed and 12 MiB per capture; do not rely only on a
  `Content-Length` header;
- accept only RSS/Atom/XML MIME types and reject HTML;
- parse XML with DTD, external entities, XInclude, external schemas, and
  network entity resolution disabled;
- emit parsed plain text only; markup, script protocols, control/bidirectional
  override characters, and encoded angle-tag forms are rejected again at this
  normalizer boundary;
- collect at most 500 items per feed and 2,000 per capture, reject records over
  400 days old or more than five minutes in the future, and mark an exactly
  bounded feed as truncated;
- emit only allowlisted generic failure codes. Provider response bodies,
  exception strings, addresses, headers, and tokens must not enter the capture,
  logs, persistence, API, or UI.

Canonical item links are independently constrained to the source's AWS-owned
path. Tracking queries and fragments are removed. Official videos are reduced
to `https://www.youtube.com/watch?v=<validated-id>`. Conflicting duplicate
canonical links fail closed; identical duplicates merge only deterministic
category/service-label sets.

## Evidence behavior

The snapshot exposes per-source authority, retrieval status, item count, last
publication time, generic failure code, and stale flag. Overall states are:

- `READY`: all five sources succeeded without truncation and are fresh;
- `STALE`: coverage was complete but at least one capture exceeds the 48-hour
  freshness SLA;
- `PARTIAL`: at least one source failed or was truncated while another
  succeeded;
- `FAILED`: no source succeeded.

Open public feeds do not provide a stable expected item total, so source health
reports accepted records but keeps expected/rejected record counts unknown.

## Remaining production gates

The following are intentionally not claimed by this slice:

1. governed outbound gateway/collector implementing streaming byte limits,
   redirect interception, XML hardening, retry/backoff, and egress controls;
2. durable, idempotent, tenant-scoped schedule and source-job ledger wiring;
3. immutable capture/snapshot persistence with retention and correction
   semantics;
4. tenant-authorized API/query service with bounded pagination and no
   request-derived scope or service catalog;
5. professional dashboard views/filters and explicit partial/stale evidence;
6. live official-source collection, failure/recovery tests, tenant-isolation
   tests, security review, observability/alerts, and production acceptance.

No deployment, image publication, permission change, or live-site mutation is
part of this implementation.
