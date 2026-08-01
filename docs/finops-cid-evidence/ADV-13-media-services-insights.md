# ADV-13 — Media Services Insights

Status: `PARTIAL_PIPELINE` (local vertical and permanent runtime binding contract complete; provider activation not claimed)

## Official capability mapping

Pinned definition audit: CID framework commit
`f9e36d88c47709f10e8fa784ad11d5cc0e728021`,
<https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework/blob/f9e36d88c47709f10e8fa784ad11d5cc0e728021/dashboards/media-services-insights/msih-definition.yaml>.
The nine official sheets are **Executive Summary**, **MediaLive Reservation &
Savings**, **MediaConvert**, **MediaConnect**, **MediaLive**, **MediaTailor**,
**MediaPackage**, **Raw Data**, and **About**. Sutra exposes these navigation
areas as evidence views while marking reservation savings partial until governed
comparison prices exist. Official service-specific controls (including Flow,
Pipeline, Codec, Resolution, Bit Rate, Frame Rate, Quality, transcoding profile,
usage category, cost model, pricing adjustments, lookback and Top N) remain
exact-tree gaps where the normalized projection has no equivalent dimension.

G1/G2/G3/G4 are local-complete contracts for inventory, source boundaries,
durable runtime and persistence/API. G5 remains partial for exact service-sheet
control and visual geometry. G6 remains partial pending provider and browser
acceptance.

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
- Permanent scheduler/runtime boundary: `lib/finops-media-services-runtime-binding.ts`
- Persistence: `db/finops-media-services-repository.ts`
- SQLite: `drizzle/0095_finops_media_services_insights.sql`
- PostgreSQL: `postgres/migrations/0090_finops_media_services_insights.sql`
- Same-tenant API: `app/api/v1/finops/media-services-insights/route.ts`
- Native UI: `app/costs/finops-media-services-insights-dashboard.tsx`
- Focused verification: `tests/finops-media-services-insights.test.ts`, `tests/finops-media-services-vertical.test.mjs`, `tests/finops-media-services-runtime-binding.test.ts`

## Controls and failure semantics

- Session organization is server-derived. The API never accepts `orgId` or `customerId`.
- The selected connection must be an active AWS trust-role connection and the session must have `connection:read` for its customer.
- The collector payload contains only a server scheduling window. Account, partition, Region, active CUR2 generation, operations and bounds are server-resolved.
- The permanent daily scheduler enumerates eligible connections only from trusted server state and enqueues exactly `{ scheduledWindow }`. The handler reloads the connection and every account/partition/Region target, incremental cursor, active reconciled CUR2 generation, manifest SHA, data-through timestamp, cost basis, currency, and governed planning-evidence reference before any adapter call.
- Every deterministic target/window/billing/planning request stays stable when its incremental cursor advances during queue replay and freezes the five official workflow definitions and all 46 declared reads, a 100-item page size, 20,000-call ceiling per provider, token-replay rejection, exhaustion evidence, four-worker concurrency, archive-safe 11 MiB runtime capture ceiling, and one 15-minute abort window. MediaPackage v1/v2 remain separate provider contracts inside the single packaging/origination workflow.
- The adapter result must reproduce the exact server-selected CUR2 generation, manifest, data-through time, cost basis, currency, and exhaustive-row state. Exact-ARN resource attribution remains separate from service-level unattributed spend.
- Governed Budget and MediaLive on-demand-price inputs are accepted only as pinned immutable generation/hash/date/currency references. When missing they carry explicit unavailable reason codes. The runtime contract accepts no threshold, price, amount, or savings value, and the existing visual continues to report budget variance and reservation savings as unavailable until a separately validated projection consumes governed values.
- The canonical request and capture are archived as `finops_source_snapshot`, assigned a deterministic `fss_...` generation, sealed with tenant/customer/connection/source/generation AAD, and handed to an application port that must durably bind the evidence lineage to the normalized `msg_...` snapshot. Accepted replay identities bypass repeat AWS, archive, and persistence calls. Only generic failure codes are handed off; raw provider messages are not persisted.
- Normalization validates exact tenant/AWS scope, provider cardinality, pagination/exhaustion, ARN service/account/Region, byte/count/time/concurrency limits, unique identifiers, timestamps, signed decimal micros, currency and active-CUR2 lineage.
- Snapshot JSON is content-addressed. SQLite and PostgreSQL reject snapshot updates/deletes and only permit a complete, newer same-target generation to advance a head.
- Failed, partial and configuration-required attempts remain in immutable history and do not replace an accepted complete head.
- CSV neutralizes spreadsheet formula prefixes.

## Remaining provider gates

1. Implement and register the authenticated credential-broker adapter for the exact 46 reads, including service-specific resource scoping, regional availability, retry/throttling behavior, token handling and byte/call/time enforcement.
2. Bind the trusted eligible-connection resolver and Organizations-aware account/partition/Region target resolver, plus the active reconciled CUR2 selector that returns complete generation, manifest, data-through, cost-basis and currency lineage.
3. Implement the permanent immutable-handoff port so archived/sealed `fss_...` evidence, governed planning references, and normalized `msg_...` snapshot are committed atomically or recoverably under the deterministic request identity.
4. Register `finops-media-services-insights-daily-collect` in the shared durable handler registry and bind the scheduler, queue, evidence archive, key service, role-session broker and observability. `MEDIA_SERVICES_RUNTIME_BINDING.registeredInSharedRuntime` intentionally remains `false`; shared registry files were not changed by this isolated closure.
5. Apply the existing SQLite/PostgreSQL snapshot migrations through the release path and complete PostgreSQL parity verification.
6. Provider-validate governed AWS Budgets and versioned on-demand Price List joins before changing the existing unavailable budget or reservation-savings visual. Independently reproduce any future amounts and retain currency/effective-date lineage; absence must remain unavailable.
7. Run controlled live multi-account/Region acceptance for all five workflows and six provider contracts, including pagination exhaustion, throttling, timeouts, unsupported Regions, partial captures, exact CUR2 lineage substitution, cross-tenant denial, resources without CUR ARNs, credits and unlike units. Retain signed evidence, complete visual acceptance, rollback and post-deploy smoke results.

Until all provider gates pass, the catalog maturity must not exceed `PARTIAL_PIPELINE`, the route returns `MEDIA_SERVICES_AWS_ADAPTER_JOB_HANDLER_NOT_REGISTERED`, and production activation must remain false.
