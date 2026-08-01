# Sutra FinOps — Cloud Intelligence Dashboards implementation tracker

Status: **ACTIVE — implementation incomplete; release prohibited until every applicable gate passes**

Catalog reviewed: **2026-08-01**

Official authority: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/dashboards.html>

## Scope contract

The official catalog contains **29 dashboards**: 3 Foundational, 13 Advanced,
and 13 Additional. Sutra must implement every dashboard as a native,
tenant-scoped source/collector → immutable persistence → authenticated API →
evidence-honest visual UI slice.

A domain engine, source-health entry, documentation file, generic readiness
card, successful build, or source-only ingestion path is not a completed
dashboard. Source readiness and implementation maturity are separate facts.
Neither may imply production acceptance.

The existing AWS runtime catalog contains 27 AWS-backed capabilities. Azure CID
and GCP CID belong in this presentation/product catalog but must not be added to
AWS permission, trust-role, or collector registries. They require separate
provider connection and runtime contracts.

## Status vocabulary

### Capability maturity

| Status | Meaning |
|---|---|
| `ABSENT` | No capability-specific end-to-end implementation exists. |
| `ENGINE_ONLY` | A bounded engine or contract may exist, but collector, durable persistence, API, or UI is missing. |
| `PARTIAL_PIPELINE` | More than an engine exists, but the official provider-to-visual path is incomplete or materially mismatched. |
| `LOCAL_VERTICAL_CANDIDATE` | Collector/persistence/API/UI appear present, but the full definition of done and exact-tree evidence have not been audited. |
| `LOCAL_VERTICAL_VERIFIED` | Every local stage and adversarial/fixed-tree gate is proven at one exact SHA. |
| `LIVE_ACCEPTED` | The exact deployed digest passed controlled provider, two-tenant, visual, rollback, and post-deploy acceptance. |

`BLOCKED` is recorded separately and never substitutes for maturity.

### Per-stage status

Use `NOT_STARTED`, `PARTIAL`, `IMPLEMENTED_UNVERIFIED`, `VERIFIED`, or
`NOT_APPLICABLE`. A stage is `VERIFIED` only when evidence names the exact SHA,
files or artifacts, test command, result, timestamp, and verifier.

### Required runtime and UI states

Every dashboard must render without fabricated values:

`LOADING`, `CONFIGURATION_REQUIRED`, `WAITING_FOR_FIRST_RUN`,
`EMPTY_VERIFIED`, `PARTIAL`, `STALE`, `FAILED`, and `COMPLETE`.

An entitlement or permission limitation is not empty data. A failed or partial
collection may show an explicitly labelled last accepted generation but must
never replace it or masquerade as current success.

## Current truthful baseline

| Level | Catalog rows | Candidate | Partial pipeline | Engine only | Absent | Local verified | Live accepted |
|---|---:|---:|---:|---:|---:|---:|---:|
| Foundational | 3 | 3 | 0 | 0 | 0 | 0 | 0 |
| Advanced | 13 | 1 | 1 | 11 | 0 | 0 | 0 |
| Additional | 13 | 2 | 1 | 8 | 2 | 0 | 0 |
| **Total** | **29** | **6** | **2** | **19** | **2** | **0** | **0** |

The six candidates are CUDOS, Cost Intelligence, KPI and Modernization, Cost
Anomaly, Trends, and Data Transfer. The two partial pipelines are Data
Collection Monitor and FOCUS. Azure CID and GCP CID are absent.

## Parent capability tracker

| ID | Official dashboard | Sutra ID | Current maturity | Immediate proof or gap |
|---|---|---|---|---|
| FND-01 | CUDOS Dashboard | `cudos` | `LOCAL_VERTICAL_CANDIDATE` | [G0–G6 evidence](finops-cid-evidence/FND-01-cudos.md); exact-tree and controlled two-tenant/provider acceptance remain. |
| FND-02 | Cost Intelligence Dashboard | `cost_intelligence_dashboard` | `LOCAL_VERTICAL_CANDIDATE` | [G0–G6 evidence](finops-cid-evidence/FND-02-cost-intelligence.md); exact-tree and controlled two-tenant/provider acceptance remain. |
| FND-03 | KPI and Modernization Dashboard | `kpi_dashboard` | `LOCAL_VERTICAL_CANDIDATE` | [G0–G6 evidence](finops-cid-evidence/FND-03-kpi-modernization.md); exact-tree and controlled two-tenant/provider acceptance remain. |
| ADV-01 | Trusted Advisor Organizational Dashboard | `trusted_advisor_organizational` | `ENGINE_ONLY` | Add authoritative standard-check organizational-view export collection/history/API/UI. Existing Priority API logic is supplemental and cannot prove full TAO coverage. |
| ADV-02 | Compute Optimizer Dashboard | `compute_optimizer` | `ENGINE_ONLY` | Complete organization export/history, savings and under-provisioning risk views, API/UI, and coverage evidence. |
| ADV-03 | Cost Anomaly Dashboard | `cost_anomaly` | `LOCAL_VERTICAL_CANDIDATE` | Audit findings, monitors/subscriptions, time series, root cause, last-good evidence, and cross-tenant behavior. |
| ADV-04 | Extended Support Cost Projection | `extended_support_projection` | `ENGINE_ONLY` | Complete ElastiCache/EKS/RDS/OpenSearch inventory/history, lifecycle bands, projections, API/UI, and live reconciliation. |
| ADV-05 | Graviton Savings Dashboard | `graviton_savings` | `ENGINE_ONLY` | Complete compatibility evidence and EC2/RDS/OpenSearch/ElastiCache usage, realized savings, opportunities, persistence, API/UI. |
| ADV-06 | Health Events Dashboard | `health_events` | `ENGINE_ONLY` | Complete organization event/entity history, past/current/upcoming views, entitlement/retention states, API/UI. |
| ADV-07 | AWS News Feeds | `aws_news_feeds` | `ENGINE_ONLY` | Complete governed scheduled persistence and visual What’s New/blog/video/security feeds with provenance and freshness. |
| ADV-08 | AWS Budgets Dashboard | `aws_budgets` | `ENGINE_ONLY` | Complete provider budgets hierarchy, actual/forecast/status history, API/UI, distinct from Sutra-authored budgets. |
| ADV-09 | AWS Support Cases Radar Dashboard | `support_cases_radar` | `ENGINE_ONLY` | Complete privacy-minimized multi-account/org history, API/UI, support-plan states, and optional summary provenance. |
| ADV-10 | ResilienceVue Dashboard | `resiliencevue` | `ENGINE_ONLY` | Complete Resilience Hub application/assessment/drift history across accounts/regions and visual recommendations. |
| ADV-11 | AWS End User Computing Dashboard | `end_user_computing` | `ENGINE_ONLY` | Complete WorkSpaces/AppStream usage, cost, performance, logon, optimization, persistence, API/UI, and privacy-safe user views. |
| ADV-12 | Data Collection Monitor Dashboard | `data_collection_monitor` | `PARTIAL_PIPELINE` | Replace generic telemetry equivalence with official DCF module instrumentation, execution history, errors, Step Functions links, retries, latency, and coverage. |
| ADV-13 | Media Services Insights Hub | `media_services_insights` | `ENGINE_ONLY` | Complete AWS Elemental usage/cost/performance collection, persistence, API/UI, and workflow drilldowns. |
| ADD-01 | CORA Dashboard | `cora` | `ENGINE_ONLY` | Complete Cost Optimization Hub recommendations/history, ownership, status, savings reconciliation, persistence, API/UI. |
| ADD-02 | Cloud Intelligence Dashboard for Azure | `azure_cid` | `ABSENT` | Add Azure billing-export connection, collector, immutable normalized persistence, API, native visual reports, and live Azure validation. |
| ADD-03 | Cloud Intelligence Dashboard for GCP | `gcp_cid` | `ABSENT` | Add GCP Cloud Billing export connection, collector, immutable normalized persistence, API, native visual reports, and live GCP validation. |
| ADD-04 | FOCUS Dashboard | `focus` | `PARTIAL_PIPELINE` | Existing ingestion/persistence is insufficient; add a dedicated API, complete FOCUS visual experience, quality/reconciliation, and evidence states. |
| ADD-05 | AWS Marketplace Single Pane of Glass Dashboard | `marketplace_spg` | `ENGINE_ONLY` | Complete spend, subscriptions, offers, agreements, entitlements/licenses/grants collection, API/UI, and procurement drilldowns. |
| ADD-06 | Kubecost Containers Cost Allocation Dashboard | `kubecost_container_allocation` | `ENGINE_ONLY` | Complete exporter ingestion/persistence, workload allocation, efficiency/right-sizing, showback/chargeback API/UI, and reconciliation. |
| ADD-07 | SCAD Containers Cost Allocation Dashboard | `scad_container_allocation` | `ENGINE_ONLY` | Complete CUR2 SCAD lineage for EKS/ECS, workload allocation, showback/chargeback persistence, API/UI, and reconciliation. |
| ADD-08 | Sustainability Proxy Metrics and Carbon Emissions Dashboard | `sustainability_proxy` | `ENGINE_ONLY` | Complete durable proxy/provider carbon inputs, clearly separated claims, trends, persistence, API/UI, and reconciliation. |
| ADD-09 | Trends Dashboard | `trends` | `LOCAL_VERTICAL_CANDIDATE` | Audit scale, filters, comparison periods, contributors, signals/anomalies, exports, and visual accessibility. |
| ADD-10 | Data Transfer Dashboard | `data_transfer` | `LOCAL_VERTICAL_CANDIDATE` | Audit internet/inter-region/inter-AZ/service flows, byte/cost reconciliation, flow visualizations, and drilldowns. |
| ADD-11 | Amazon Connect Cost Insights Dashboard | `amazon_connect_cost_insights` | `ENGINE_ONLY` | Complete privacy-minimized spend/usage/voice/telecom collection, granular breakdown/search, persistence, API/UI. |
| ADD-12 | Config Resource Compliance Dashboard | `config_resource_compliance` | `ENGINE_ONLY` | Complete organization aggregator inventory/compliance history, accounts/regions/rules/resources/cost, persistence, API/UI. |
| ADD-13 | Pricing Change Analysis Dashboard | `pricing_change` | `ENGINE_ONLY` | Complete version-pinned pricing evidence, immutable repricing report, signed impact, API/UI, and actual-usage reconciliation. |

## Child-stage gates for every parent row

| Gate | Required evidence |
|---|---|
| G0 — Official requirements | Catalog/detail URL, review date, functional and visual inventory, authoritative sources, limitations, and acceptance cases. |
| G1 — Source and permission contract | Exact provider operations/export schema, bounded pagination, least-privilege read role, entitlement/regional behavior, and negative tests. |
| G2 — Collector | Server-owned scope, retries/backoff, rate limits, deterministic idempotency, schema rejection, partial-run handling, and source provenance. |
| G3 — Persistence | Migration, immutable tenant/customer/connection snapshot, checksums, accepted-head publication, last-good retention, retention policy, and replay/substitution tests. |
| G4 — API | Authenticated server-derived tenant scope, bounded filters/pagination/export, honest freshness/coverage/error contract, cache isolation, and adversarial tests. |
| G5 — Visual UI | Official feature inventory represented with native Sutra visuals, global filters/drilldowns/evidence drawer/export, responsive and keyboard-accessible behavior, and every evidence state. |
| G6 — Focused verification | Unit, integration, route, repository, tenant isolation, pagination, replay, schema, timestamp, stale/partial/failure, and rendered UI tests. |
| G7 — Fixed-tree local gate | Root/collector typecheck, lint, secret scan, `git diff --check`, build, rendered tests, six repository shards, PostgreSQL 16 migrations/runtime roles, and Docker/image checks at one SHA. |
| G8 — Controlled provider acceptance | Non-production provider data, source reconciliation, multi-account/region coverage, two-tenant isolation, scale/boundary testing, and dated artifacts. |
| G9 — GitHub/release gate | Scoped commits pushed, PR review, protected-main merge, exact-SHA CI/CodeQL/SBOM/provenance, and environment approval. |
| G10 — Deployment acceptance | Immutable digest, migration/backup proof, canary/health checks, rollback proof, post-deploy browser/API/two-tenant smoke tests, live URL, and exact deployed SHA. |

User deployment authorization was received on 2026-08-01. Authorization does
not turn an unpassed gate into a pass. Deployment begins only after G0–G9 are
complete for every applicable row.

## Mandatory evidence record

Every parent row must link a child evidence record containing:

- official URL, review timestamp, and requirement/visual inventory;
- exact Git SHA and implementation owner;
- source contract, IAM/export operations, account/region coverage;
- collector files, limits, and focused tests;
- migrations, repositories, immutable snapshot/head semantics;
- API route, response schema, authorization and cache-isolation tests;
- UI route/components, filters, charts/tables, drilldowns, evidence drawer,
  desktop/narrow screenshots, and keyboard/accessibility evidence;
- exact commands with pass/fail/skip counts;
- fixture, two-tenant, scale, and controlled-live evidence kept distinct;
- limitations, blockers, next action, PR/check runs;
- image digest, deployed SHA, deployment run, rollback and live acceptance
  artifacts when applicable.

A filename, source-health result, screenshot, or green aggregate check alone is
not sufficient proof.

## Release invariants

- Partial or failed collection never replaces the last accepted complete snapshot.
- Empty, missing permission, stale, partial, and failed are never presented as zero or healthy.
- No fixtures, samples, placeholder zeros, fabricated savings, or synthetic live evidence.
- Collector roles remain read-only; provisioning/remediation roles are separate.
- Cross-tenant, replay, substitution, pagination, schema, and cache isolation are mandatory.
- Catalog drift is checked immediately before release; a new or renamed official row reopens scope.
- No image publication or production mutation occurs until every row is
  `LOCAL_VERTICAL_VERIFIED`, G7 is green at the exact release SHA, and G8–G9
  evidence is attached.
- `LIVE_ACCEPTED` is set only after G10 succeeds on the exact deployed digest.

## Execution order

1. Correct the 29-row presentation catalog and readiness semantics.
2. Add the Foundational/Advanced/Additional dashboard navigation and shared evidence shell.
3. Complete Trusted Advisor Organizational using standard-check organizational data plus a separately labelled Priority supplement.
4. Complete each remaining engine-only row as a full vertical slice.
5. Finish Data Collection Monitor and FOCUS rather than inheriting optimistic handover labels.
6. Audit and close all gates for the six local candidates.
7. Build Azure CID and GCP CID with provider-specific connection/runtime contracts.
8. Run exact-tree local, controlled-provider, GitHub, image, deployment, rollback, and live-site gates.

## Checkpoint template

| Field | Value |
|---|---|
| Parent ID / dashboard | |
| Previous → new maturity | |
| Exact SHA / UTC time | |
| Collector evidence | |
| Persistence evidence | |
| API evidence | |
| UI/render evidence | |
| Tests passed/failed/skipped | |
| Unavailable or failed gates | |
| Controlled-live evidence | |
| Limitations/blockers | |
| PR/check/image/deploy evidence | |
| Next child gate | |
