# ADV-07 — AWS News Feeds

## Outcome

Local maturity: **PARTIAL_PIPELINE**. This vertical now has a bounded provider
gateway contract, six-hour server-owned job implementation, immutable
tenant-scoped SQLite/PostgreSQL persistence, authenticated same-tenant API,
native accessible dashboard, and focused evidence tests. It is not
`LOCAL_VERIFIED` or live because the durable job registry/tick and a production
XXE-hardened outbound XML gateway are not yet bound, and no provider collection
has been accepted in the deployment environment.

## Official dashboard coverage

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
- SQLite persistence: `drizzle/0090_finops_aws_news_feed_snapshots.sql`
- PostgreSQL persistence: `postgres/migrations/0085_finops_aws_news_feed_snapshots.sql`
- Repository: `db/finops-aws-news-feeds-repository.ts`
- Query projection: `lib/finops-aws-news-dashboard.ts`
- Same-tenant API: `app/api/v1/finops/aws-news-feeds/route.ts`
- Native UI: `app/costs/finops-aws-news-feeds-dashboard.tsx`
- Focused evidence: `tests/finops-aws-news-feeds.test.ts` and
  `tests/finops-aws-news-feeds-vertical.test.mjs`

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

1. Register `AWS_NEWS_FEEDS_JOB_KIND` in the shared background worker and add an
   idempotent per-active-connection six-hour enqueue tick.
2. Bind a production egress-controlled gateway that manually validates
   redirects, streams byte limits, accepts XML MIME only, and parses RSS/Atom
   with DTD, external entity, XInclude, schema, and network resolution disabled.
3. Run live provider success/failure/recovery, tenant isolation, retention,
   observability, and alert acceptance tests.
4. Register migrations and the dashboard in shared runtime/catalog/navigation,
   then pass full CI/build and signed-in browser acceptance before deployment.

No deployment, production acceptance, or live-provider claim is made here.
