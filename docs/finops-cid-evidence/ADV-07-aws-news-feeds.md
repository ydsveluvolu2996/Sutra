# ADV-07 — AWS News Feeds

## Outcome

Local maturity: **PARTIAL_PIPELINE**. This vertical now has a concrete
bounded outbound XML gateway, a registry-independent durable/replay-safe handler
contract, six-hour server-owned job implementation, immutable
tenant-scoped SQLite/PostgreSQL persistence, authenticated same-tenant API,
native accessible dashboard, and focused evidence tests. The provider-to-visual
path is still incomplete because the shared worker registry/tick, durable
replay-store adapter, and production egress binding are not connected, and no
provider collection has been accepted in the deployment environment.

## Official dashboard coverage

Reviewed 2026-08-02 against the official AWS
[AWS News Feeds dashboard](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/news-feeds.html),
[Cloud Intelligence dashboard catalog](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/dashboards.html),
and [AWS Security Bulletins](https://aws.amazon.com/security/security-bulletins/).
The AWS guidance identifies the four content families and the service, feed-
type, and category filters implemented below. Exact endpoint availability still
requires the live-provider acceptance gate.

The implementation explicitly covers all four AWS-documented content families:

| AWS requirement | Sutra evidence |
|---|---|
| What's New | Pinned AWS What's New RSS source and `WHATS_NEW` family |
| Blog posts | Pinned AWS News Blog and AWS Security Blog RSS sources |
| Videos | Pinned official AWS YouTube Atom channel; UI opens only the normalized official watch URL in a new tab with `noopener noreferrer` |
| Security bulletins | Pinned AWS Security Bulletins RSS source |
| Filter by AWS service | Exact server-owned enabled/observed service matches, with match reason and usage basis |
| Filter by feed type | `WHATS_NEW`, `BLOG`, `SECURITY_BLOG`, `SECURITY_BULLETIN`, and `VIDEO` |
| Filter by category | Provider-authored normalized categories only |

Public news is never presented as proof of customer impact. Every item remains
`impactAssessment: NOT_ASSESSED`; tenant relevance is an explainable exact
match to a server-resolved service catalog.

## Pipeline evidence

- Engine/source policy: `lib/finops-aws-news-feeds.ts`
- Scheduled worker contract: `lib/finops-aws-news-feeds-job.ts`
- Hardened XML gateway: `lib/finops-aws-news-feeds-xml-gateway.ts`
- Durable shared-handler contract: `lib/finops-aws-news-feeds-durable-handler.ts`
- SQLite persistence: `drizzle/0090_finops_aws_news_feed_snapshots.sql`
- PostgreSQL persistence: `postgres/migrations/0085_finops_aws_news_feed_snapshots.sql`
- Repository: `db/finops-aws-news-feeds-repository.ts`
- Query projection: `lib/finops-aws-news-dashboard.ts`
- Same-tenant API: `app/api/v1/finops/aws-news-feeds/route.ts`
- Native UI: `app/costs/finops-aws-news-feeds-dashboard.tsx`
- Focused evidence: `tests/finops-aws-news-feeds.test.ts` and
  `tests/finops-aws-news-feeds-vertical.test.mjs`, plus
  `tests/finops-aws-news-feeds-gateway-handler.test.mjs`

The gateway accepts only the five frozen source definitions and issues
credential-free `GET` requests with manual redirects. Every redirect must
canonicalize back to the exact pinned URL. It enforces a 10-second source
deadline, 2 MiB decompressed streaming limit, XML-only MIME allowlist, two-
redirect ceiling, 30,000-node/64-depth parser ceiling, and 500-item feed bound.
Its linear parser rejects DTDs, internal/external entities, XInclude, arbitrary
processing instructions, mismatched elements, unknown entity references,
invalid UTF-8, and non-RSS/Atom roots. Only five predefined XML entities and
valid numeric character references are decoded; CDATA/encoded markup is reduced
to plain text and never returned as HTML.

The durable handler validates an exact envelope and deterministic six-hour
idempotency key before claiming a 60-second lease. Completed receipts are shape-
validated and replayed without collection. Acquired work persists through the
existing immutable repository, then commits a SHA-256-bound result receipt.
Concurrent work returns `IN_PROGRESS`; claim, collection, receipt, and secondary
failure details are reduced to stable sanitized error codes.

Focused verification result: **22/22 tests passed**, with zero failures, skips,
or cancellations. Full TypeScript checking and targeted ESLint also passed on
this exact local tree.

Snapshots are content-addressed and immutable. Partial, failed, and stale
generations remain queryable in history, but database guards permit only a
strictly newer `READY` generation to advance the accepted head. The API reads
scope from the authenticated session and server-owned connection; it accepts no
organization ID, customer ID, source URL, or service catalog from the browser.

The UI presents source authority, per-source retrieval state, fetched time,
last publication, accepted count, failure code, overall freshness, immutable
history, evidence identifiers, limitations, safe CSV output, explainable
service relevance, and explicit complete/partial/stale/empty/failed/not-yet-
configured states. Official publication links are constrained by the engine;
videos are never embedded as arbitrary HTML.

## Remaining gates

1. Register `AWS_NEWS_FEEDS_JOB_KIND` and the durable handler in the shared
   background worker and add an idempotent per-active-connection six-hour tick.
2. Bind the handler to the production durable replay store and bind the gateway
   to the egress-controlled runtime. Until then the API truthfully reports
   `AWS_NEWS_FEEDS_JOB_HANDLER_NOT_REGISTERED`.
3. Run live provider success/failure/recovery, timeout, redirect, tenant isolation, retention,
   observability, and alert acceptance tests.
4. Pass the parent exact-tree CI/build, immutable-image, deployment, rollback,
   and signed-in browser acceptance gates.

No deployment, production acceptance, or live-provider claim is made here.
