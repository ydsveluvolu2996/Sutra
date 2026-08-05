# ADV-13 — Media Services Insights

Reviewed: **2026-08-01** against current AWS Guidance and immutable public AWS
source commit `f9e36d88c47709f10e8fa784ad11d5cc0e728021`.

Status: `PARTIAL_PIPELINE` (local vertical and permanent runtime binding contract complete; provider activation not claimed)

## Official capability mapping

AWS Guidance describes usage, cost and performance lenses for five Elemental
services and seven user-facing tabs:

- [Media Services Insights Hub — AWS Cloud Intelligence Dashboards](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/media-services-insights.html)

The complete v2.2.1 definition links the legacy
`aws-samples/aws-cudos-framework-deployment` repository URL. Both that linked
URL and the primary `aws-solutions-library-samples/cloud-intelligence-dashboards-framework`
URL resolve to commit
`f9e36d88c47709f10e8fa784ad11d5cc0e728021`; their MSIH manifest, definition
and changelog are byte-identical. The audit does not follow a mutable `main`
branch after recording that SHA.

### Pinned public artifacts

| Artifact | Path / hash basis | SHA-256 |
|---|---|---|
| Dashboard catalog | `dashboards/catalog.yaml`, raw bytes | `169a37fb7be4660e96a1fa258d0f95d4cef597f4294c0c27cfda101dfbdb197d` |
| MSIH manifest | `dashboards/media-services-insights/msih.yaml`, raw bytes | `ab485a191da780a262b09d133731095c19720de4d3827a74dd42b454d974867a` |
| Complete QuickSight definition | `dashboards/media-services-insights/msih-definition.yaml`, raw bytes | `a29384174b7eafb599c3ca3734a8a7f4954b8e057f716e6d79e8750cee88fe4d` |
| Changelog | `changes/CHANGELOG-media-services-insights.md`, raw bytes | `c489667883cbf69a92144f592d3b4d50ad8fae59420833e8dd1a7ad24e043a53` |
| Shared deployment template | `cfn-templates/cid-plugin.yml`, raw bytes | `b96a47e6b53418293ec7127d0a95f96f2ffdae2781cde2b2dffcabad926a713d` |
| Reservation-optimization dataset | `datasets.msih_reservation_optimize.data`, canonical JSON | `86dbd25fc53dd7db2c121465371bc2e33621bbbb761f3391bac1a5e09beb00a4` |
| Reservations dataset | `datasets.msih_reservations.data`, canonical JSON | `7332380211b604b6727c9cbab7292ba61539ac8402a88668a41e8be939fb6ab0` |
| Main dataset | `datasets.msih_view.data`, canonical JSON | `690b21cc539aad83ceffe7f1fc933c6bc59eaed40a5619bd09a911ecaf99e8e5` |
| Reservation-optimization Athena view | `views.msih_reservation_optimize.data`, decoded scalar bytes | `e35911d887dcccca397693a7bc390c6f9539e0aa2c0e2d2e5e1e0c9944517a45` |
| Reservations Athena view | `views.msih_reservations.data`, decoded scalar bytes | `9a8ba7f427db59e695b4f83b61ebed672280f5c7e51d371493e91d1196ccb0f2` |
| Main Athena view | `views.msih_view.data`, decoded scalar bytes | `c53c3ae61c5cc47181c29c2c6ca6cd393796d3c4f5e8f6f6805d5dfd5bee616a` |

The CloudFormation launch uses the shared CID plugin template; no separate
dashboard-specific template is published.

### Exact QuickSight inventory

| Sheet | Visuals | Exact visual-type inventory | Control placements |
|---|---:|---|---:|
| Executive Summary | 20 | 3 bar, 11 KPI, 2 insight, 2 line, 1 table, 1 heat map | 7 |
| MediaLive Reservation & Savings | 27 | 4 table, 1 insight, 1 scatter, 8 bar, 7 line, 4 KPI, 2 combo | 16 |
| MediaConvert | 17 | 1 combo, 4 line, 1 pivot, 2 insight, 6 bar, 3 KPI | 12 |
| MediaConnect | 14 | 1 combo, 2 Sankey, 2 line, 2 insight, 1 pivot, 4 bar, 2 KPI | 8 |
| MediaLive | 35 | 18 bar, 3 combo, 6 line, 2 pivot, 3 insight, 3 KPI | 20 |
| MediaTailor | 16 | 2 pivot, 2 Sankey, 3 KPI, 5 bar, 2 insight, 2 line | 8 |
| MediaPackage | 14 | 1 pivot, 3 KPI, 2 Sankey, 2 insight, 4 bar, 2 line | 8 |
| Raw Data | 1 | 1 table | 13 |
| About | 0 | None | 0 |
| **Total** | **144** | **48 bar, 29 KPI, 14 insight, 25 line, 6 table, 1 heat map, 1 scatter, 7 combo, 7 pivot, 6 Sankey** | **92** |

The definition additionally proves 59 parameter-control placements, 33
filter-control placements, 44 parameter declarations, 175 calculated fields,
241 filter groups, 2 column configurations, and 3 SPICE datasets. The manifest
publishes three Athena views containing 151, 123 and 128 lines respectively.

`lib/finops-media-services-official-definition.ts` maps all 52 documented
sheet purposes and every control placement to supported, partial,
server-pinned, unavailable, or About-evidence states. This includes Flow,
Pipeline, Codec, Resolution, Bit Rate, Frame Rate, Quality, transcoding profile,
usage categories, account controls, cost model, pricing adjustments, lookback,
Top N, reservation scenario and raw-data controls. The report-independent UI
panel renders this inventory in ready, loading, failed, disconnected and
configuration-required states.

AWS recommendation language—especially the statement that MediaLive reserved
instances can save up to 75 percent—is guidance, not evidence that a tenant has
realized or can realize that amount. Sutra therefore marks all reservation
savings, scenario and term recommendations unavailable until versioned prices,
allocation, historical utilization and future-use evidence are independently
reconciled.

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
- Frozen official-source audit: `lib/finops-media-services-official-definition.ts`
- Server-owned job contract: `lib/finops-media-services-collector-job.ts`
- Permanent scheduler/runtime boundary: `lib/finops-media-services-runtime-binding.ts`
- Persistence: `db/finops-media-services-repository.ts`
- SQLite: `drizzle/0095_finops_media_services_insights.sql`
- PostgreSQL: `postgres/migrations/0090_finops_media_services_insights.sql`
- Same-tenant API: `app/api/v1/finops/media-services-insights/route.ts`. Every
  HTTP-200 state includes the pinned official definition.
- Native UI: `app/costs/finops-media-services-insights-dashboard.tsx`, including
  report-independent official artifact/sheet/purpose/control coverage.
- Focused verification: `tests/finops-media-services-insights.test.ts`,
  `tests/finops-media-services-vertical.test.mjs`,
  `tests/finops-media-services-runtime-binding.test.ts`,
  `tests/finops-media-services-official-definition.test.ts`, and
  `tests/finops-media-services-official-ui.test.mjs`

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
