# ADV-07 — AWS News Feeds

## Outcome

Local maturity: **PARTIAL_PIPELINE**. This vertical now has a concrete
bounded outbound XML gateway, a registry-independent durable/replay-safe handler
contract, an adapter-neutral six-hour scheduler/shared-worker facade, immutable
tenant-scoped SQLite/PostgreSQL persistence, authenticated same-tenant API,
native accessible dashboard, and focused evidence tests. The provider-to-visual
path is still incomplete because the shared worker registry/tick, durable
replay-store adapter, and production egress binding are not connected, and no
provider collection has been accepted in the deployment environment.

## Official dashboard coverage

Reviewed 2026-08-01 against the official AWS
[AWS News Feeds dashboard](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/news-feeds.html),
[Cloud Intelligence dashboard catalog](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/dashboards.html),
and [AWS Security Bulletins](https://aws.amazon.com/security/security-bulletins/).
The AWS guidance identifies the four content families and the service, feed-
type, and category filters implemented below. Exact endpoint availability still
requires the live-provider acceptance gate.

The public framework manifest is pinned at commit
`f9e36d88c47709f10e8fa784ad11d5cc0e728021`, path
`dashboards/aws-feeds/aws-feeds.yaml`, SHA-256
`1e3c569b4fe4100971a0c0c1530492745726408f58e9c5edd817895c516a4d6e`.
Its embedded QuickSight definition SHA-256 is
`ac9bffb471fcf9730d765c45270ddc818c363ed8539c2d62f1df2da6f6115c4e`.
Independent parsing proves exactly **6 sheets, 21 visuals, 12 parameter
controls, 0 filter controls, 20 parameter declarations, 16 calculated fields,
20 filter groups and 5 datasets**. Visuals comprise 7 tables, 7 bar charts, 1
word cloud, 3 pivot tables, 1 custom-content visual and 2 insights. Every exact
sheet, visual ID/type and control placement is exposed in the native source
inventory; native equivalents do not claim QuickSight pixel or interaction
parity.

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

AWS's Important and Informational security-bulletin classifications remain
provider-authored categories. Sutra does not reinterpret either classification
as evidence that a tenant resource is affected.

## Pipeline evidence

- Engine/source policy: `lib/finops-aws-news-feeds.ts`
- Scheduled worker contract: `lib/finops-aws-news-feeds-job.ts`
- Hardened XML gateway: `lib/finops-aws-news-feeds-xml-gateway.ts`
- Durable shared-handler contract: `lib/finops-aws-news-feeds-durable-handler.ts`
- Runtime scheduler/shared-worker facade: `lib/finops-aws-news-feeds-runtime-binding.ts`
- SQLite persistence: `drizzle/0090_finops_aws_news_feed_snapshots.sql`
- PostgreSQL persistence: `postgres/migrations/0085_finops_aws_news_feed_snapshots.sql`
- Repository: `db/finops-aws-news-feeds-repository.ts`
- Query projection: `lib/finops-aws-news-dashboard.ts`
- Same-tenant API: `app/api/v1/finops/aws-news-feeds/route.ts`
- Native UI: `app/costs/finops-aws-news-feeds-dashboard.tsx`
- Focused evidence: `tests/finops-aws-news-feeds.test.ts` and
  `tests/finops-aws-news-feeds-vertical.test.mjs`, plus
  `tests/finops-aws-news-feeds-gateway-handler.test.mjs` and
  `tests/finops-aws-news-feeds-runtime-binding.test.mjs`

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

The runtime facade validates the active AWS trust-role connection inventory,
rejects duplicate or malformed tenant scope, caps one tick at 5,000
connections, and submits deterministic per-connection jobs for exact UTC
00/06/12/18 windows with bounded concurrency. One queue-adapter rejection does
not suppress other tenant jobs and only aggregate rejection counts leave the
scheduler boundary. The shared-worker handler maps an existing replay lease to
a retryable generic error, so another replica's in-progress work cannot be
marked successful.

Focused verification result: **30/30 tests passed**, with zero failures, skips,
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
   background worker, then invoke the implemented idempotent
   per-active-connection six-hour tick from the deployment scheduler.
2. Bind the handler to the production durable replay store and bind the gateway
   to the egress-controlled runtime. Until then the API truthfully reports
   `AWS_NEWS_FEEDS_RUNTIME_ADAPTERS_NOT_REGISTERED` and the UI identifies each
   unregistered adapter separately.
3. Run live provider success/failure/recovery, timeout, redirect, tenant isolation, retention,
   observability, and alert acceptance tests.
4. Pass the parent exact-tree CI/build, immutable-image, deployment, rollback,
   and signed-in browser acceptance gates.

No deployment, production acceptance, or live-provider claim is made here.
