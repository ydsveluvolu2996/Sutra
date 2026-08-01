# ADV-13 — Media Services Insights

Status: `PARTIAL_PIPELINE` (local implementation; provider activation not claimed)

## Official capability mapping

| AWS Cloud Intelligence Dashboard lens | Sutra implementation | Evidence boundary |
|---|---|---|
| CUR2-backed executive summary | Cross-account/Region portfolio summary with signed micro-unit totals kept separate by currency and cost basis | Immutable active-CUR2 generation and manifest SHA only |
| MediaLive reservations and savings | Channel, offering and reservation inventory; usage/cost trends and resource drilldown | Savings remain `unavailable` until versioned on-demand comparison prices are governed evidence |
| MediaConnect connections/data transfer | Flow inventory, source/output signals, operation/usage/unit dimensions and exact-ARN cost | Inventory plus CUR2; no CloudWatch performance claim |
| MediaConvert jobs/queues/processing | Queue/job inventory, job/queue attributes and CUR2 processing dimensions | Inventory plus CUR2; no job telemetry beyond accepted fields |
| MediaLive channels/utilization/reservations | Channel/multiplex/offering/reservation inventory, attributes and CUR2 dimensions | Configuration evidence is not CloudWatch utilization evidence |
| MediaTailor ad insertion/sessions | Playback configuration/channel/source inventory and CUR2 usage dimensions | No ad revenue or viewer-engagement claim |
| MediaPackage packaging/origination/endpoints | v1/v2 channels, groups, endpoints and harvest jobs with CUR2 usage dimensions | No stream reliability claim |
| Trends | Monthly service/currency/cost-basis points built only from accepted CUR2 rows | Unlike currencies, bases and usage units are never merged |
| Forecast | Clearly labeled trailing-three-period Sutra mean when at least two periods exist | Not an AWS forecast, commitment or recommendation |
| Budget | Explicit unavailable state | AWS Budgets evidence is not part of this vertical contract |
| Drilldown and export | Account, Region, service, provider, resource-type and text filters; accessible tables/details; formula-safe CSV | Only the selected accepted heads are exposed |
| Provenance | Capture, snapshot generation/hash, CUR2 generation/manifest, freshness, history and limitations | New incomplete evidence cannot displace a complete accepted head |

## Vertical files

- Source engine: `lib/finops-media-services-insights.ts`
- Portfolio projection: `lib/finops-media-services-dashboard.ts`
- Server-owned job contract: `lib/finops-media-services-collector-job.ts`
- Persistence: `db/finops-media-services-repository.ts`
- SQLite: `drizzle/0095_finops_media_services_insights.sql`
- PostgreSQL: `postgres/migrations/0090_finops_media_services_insights.sql`
- Same-tenant API: `app/api/v1/finops/media-services-insights/route.ts`
- Native UI: `app/costs/finops-media-services-insights-dashboard.tsx`
- Focused verification: `tests/finops-media-services-insights.test.ts`, `tests/finops-media-services-vertical.test.mjs`

## Controls and failure semantics

- Session organization is server-derived. The API never accepts `orgId` or `customerId`.
- The selected connection must be an active AWS trust-role connection and the session must have `connection:read` for its customer.
- The collector payload contains only a server scheduling window. Account, partition, Region, active CUR2 generation, operations and bounds are server-resolved.
- Normalization validates exact tenant/AWS scope, provider cardinality, pagination/exhaustion, ARN service/account/Region, byte/count/time/concurrency limits, unique identifiers, timestamps, signed decimal micros, currency and active-CUR2 lineage.
- Snapshot JSON is content-addressed. SQLite and PostgreSQL reject snapshot updates/deletes and only permit a complete, newer same-target generation to advance a head.
- Failed, partial and configuration-required attempts remain in immutable history and do not replace an accepted complete head.
- CSV neutralizes spreadsheet formula prefixes.

## Remaining provider gates

1. Register the production credential-broker adapter for the allowlisted Media Services operations.
2. Register the durable daily job handler and target enumerator.
3. Bind every collection to the server-selected active CUR2 generation and prove pagination, throttling, timeout and unsupported-Region behavior against AWS accounts.
4. Apply both migrations through the release path and complete PostgreSQL parity verification.
5. Obtain real multi-account/Region evidence, visual acceptance, negative tenant-isolation evidence, provider validation and live post-deploy smoke evidence.
6. Add governed AWS Budgets and versioned on-demand pricing joins before enabling budget variance or reservation-savings claims.

Until all provider gates pass, the catalog maturity must not exceed `PARTIAL_PIPELINE`, the route returns `MEDIA_SERVICES_AWS_ADAPTER_JOB_HANDLER_NOT_REGISTERED`, and production activation must remain false.
