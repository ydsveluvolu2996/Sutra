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
| Advanced | 13 | 1 | 12 | 0 | 0 | 0 | 0 |
| Additional | 13 | 2 | 11 | 0 | 0 | 0 | 0 |
| **Total** | **29** | **6** | **23** | **0** | **0** | **0** | **0** |

The six candidates are CUDOS, Cost Intelligence, KPI and Modernization, Cost
Anomaly, Trends, and Data Transfer. The twenty-three partial pipelines are Trusted
Advisor Organizational, Compute Optimizer, Extended Support Cost Projection, Graviton Savings, Health Events, AWS News Feeds, AWS Budgets, Support Cases Radar,
ResilienceVue, End User Computing, Data Collection Monitor, CORA, FOCUS, Config
Resource Compliance, Pricing Change Analysis, Media Services Insights,
Marketplace SPG, Kubecost Allocation, SCAD Allocation, Sustainability and
Carbon, Amazon Connect Cost Insights, Azure CID, and GCP CID. No catalog row is
engine-only or absent; production activation and acceptance gaps remain explicit.

## Parent capability tracker

| ID | Official dashboard | Sutra ID | Current maturity | Immediate proof or gap |
|---|---|---|---|---|
| FND-01 | CUDOS Dashboard | `cudos` | `LOCAL_VERTICAL_CANDIDATE` | [G0–G6 evidence](finops-cid-evidence/FND-01-cudos.md); exact-tree and controlled two-tenant/provider acceptance remain. |
| FND-02 | Cost Intelligence Dashboard | `cost_intelligence_dashboard` | `LOCAL_VERTICAL_CANDIDATE` | [G0–G6 evidence](finops-cid-evidence/FND-02-cost-intelligence.md); exact-tree and controlled two-tenant/provider acceptance remain. |
| FND-03 | KPI and Modernization Dashboard | `kpi_dashboard` | `LOCAL_VERTICAL_CANDIDATE` | [G0–G6 evidence](finops-cid-evidence/FND-03-kpi-modernization.md); exact-tree and controlled two-tenant/provider acceptance remain. |
| ADV-01 | Trusted Advisor Organizational Dashboard | `trusted_advisor_organizational` | `PARTIAL_PIPELINE` | [G0–G6 evidence](finops-cid-evidence/ADV-01-trusted-advisor-organizational.md) and [orchestration contract](finops-cid-evidence/ADV-01-standard-orchestration-contract.md): signed taxonomy validation, frozen manifest fan-out, exact standard-check evidence consumption and terminal finalization now exist; the external Organizations adapter, durable handler registration and provider acceptance remain. Priority API logic remains supplemental. |
| ADV-02 | Compute Optimizer Dashboard | `compute_optimizer` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-02-compute-optimizer.md): immutable organization S3-export history, same-tenant API, and native rightsizing/savings/risk/ownership UI exist; production S3 adapter/job binding, real organization-export coverage, and provider acceptance remain. Discovery and direct recommendation APIs are never substituted for export history. |
| ADV-03 | Cost Anomaly Dashboard | `cost_anomaly` | `LOCAL_VERTICAL_CANDIDATE` | [G0–G6 evidence](finops-cid-evidence/ADV-03-cost-anomaly.md); exact-tree and controlled payer/two-tenant acceptance remain. |
| ADV-04 | Extended Support Cost Projection | `extended_support_projection` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-04-extended-support.md): five-service multi-account/Region collection contract, immutable READY-only history, same-tenant API, exact signed-micro output, and native 3/6/12-month UI exist; provider adapter/scheduler/IAM, decimal-string provider money inputs, real calendar/rate/CUR2 reconciliation, and live acceptance remain. |
| ADV-05 | Graviton Savings Dashboard | `graviton_savings` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-05-graviton-savings.md): EC2/ASG, RDS/Aurora, OpenSearch and ElastiCache contracts, exact-micro CUR2 economics, immutable complete history, same-tenant API, native usage/opportunity/trend/drilldown UI and safe export exist; production materializer, authoritative compatibility/pricing/workload evidence, provider coverage confirmation, and live acceptance remain. |
| ADV-06 | Health Events Dashboard | `health_events` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-06-health-events.md): organization past/current/upcoming collection contract, immutable event/entity/detail/status history, same-tenant API, prerequisite/provider states, planning UI and safe export exist with explicit 48-hour-or-more/not-real-time semantics; production broker/handler, eligible-plan/Organizations provider validation, real pagination/retention/initial-load, and live acceptance remain. |
| ADV-07 | AWS News Feeds | `aws_news_feeds` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-07-aws-news-feeds.md): hardened pinned-source XML gateway, replay-safe durable handler contract, immutable accepted history, same-tenant API, and native four-family UI exist; shared worker/tick, durable replay-store and controlled-egress registration, plus provider acceptance remain. |
| ADV-08 | AWS Budgets Dashboard | `aws_budgets` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-08-aws-budgets.md): six-hour server-scoped scheduler contract, signed bounded broker transport, immutable attempt plus hierarchy/actual/forecast history, registered migrations, same-tenant API, and native UI exist; shared handler/adapter registration, secrets and provider acceptance remain. |
| ADV-09 | AWS Support Cases Radar Dashboard | `support_cases_radar` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-09-support-cases-radar.md): privacy-minimized immutable incremental history, exact entitlement-probe request, authenticated broker transport, server-owned daily scheduler/handler contract, same-tenant API, native UI, plan states, and explicit optional-summary state exist; production registration, credential-owning AWS adapter and provider acceptance remain. |
| ADV-10 | ResilienceVue Dashboard | `resiliencevue` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-10-resiliencevue.md): stable replay-safe target/window collection identity, archive-safe bounded 14-operation runtime contract, sealed immutable evidence handoff, multi-account/Region history, same-tenant API, and native posture/RTO-RPO/breach/recommendation UI exist; credential-broker adapter/shared handler registration and provider acceptance remain. |
| ADV-11 | AWS End User Computing Dashboard | `end_user_computing` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-11-end-user-computing.md): server-owned scheduling, exact-byte signed broker transport, privacy-safe WorkSpaces/AppStream/metrics/CUR2 projection, registered immutable attempt/runtime migrations, same-tenant API, and six-area native UI exist; shared handler registration, managed broker credentials/deployment, rolling three-month/provider dimensions, and live acceptance remain. |
| ADV-12 | Data Collection Monitor Dashboard | `data_collection_monitor` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-12-data-collection-monitor.md): bounded metadata-only Step Functions adapter, deterministic hourly runtime/replay contract, tenant-pinned immutable DCF history, same-tenant API, and native module/execution/error/retry/latency/coverage UI with validated console links exist; shared scheduler/handler/replay/provider registration, real DCF acceptance, and live validation remain. |
| ADV-13 | Media Services Insights Hub | `media_services_insights` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-13-media-services-insights.md): stable replay-safe runtime contract freezes five workflows, 46 reads, active reconciled CUR2 plus governed planning lineage, archive-safe sealed evidence handoff, immutable history, same-tenant API, and native workflow UI; credential-broker adapter/shared handler registration and provider acceptance remain. |
| ADD-01 | CORA Dashboard | `cora` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-01-cora.md) and [export activation contract](finops-cid-evidence/ADD-01-cora-export-activation.md): execution-specific Cost Optimization Hub export materialization, immutable complete-only object history, runtime migrations, replay-safe orchestration, same-tenant API and native UI exist; the credential-owning S3/Parquet adapter, durable handler and provider acceptance remain. |
| ADD-02 | Cloud Intelligence Dashboard for Azure | `azure_cid` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-02-azure-cid.md): provider-specific Azure source discovery/selection, strict Standard Actual Cost/FOCUS normalization, exact micros, immutable history, same-tenant API, and native six-month/30-day/allocation/pricing/commitment/charge/tag/resource UI exist; credentials, recurring export/blob delivery, production adapter, and live Azure acceptance remain. |
| ADD-03 | Cloud Intelligence Dashboard for GCP | `gcp_cid` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-03-gcp-cloud-intelligence.md): provider-specific GCP billing sources, WIF/BigQuery contract, exact signed nanos, immutable history, same-tenant source selection/API, and native billed-cost/credit/service/resource/Kubernetes/opportunity/evidence UI exist; production BigQuery adapter/export access, controlled reconciliation, and live GCP acceptance remain. |
| ADD-04 | FOCUS Dashboard | `focus` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-04-focus.md): provider-neutral FOCUS 1.0/1.0r2/1.1/1.2 normalization, immutable provenance, governed/provider/ungoverned tag taxonomy, denominator-safe effective discount rate, same-customer source discovery and native UI exist; Azure/GCP FOCUS adapters, provider reconciliation, exact-tree and live acceptance remain. |
| ADD-05 | AWS Marketplace Single Pane of Glass Dashboard | `marketplace_spg` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-05-marketplace-spg.md): tenant-bound daily scheduling, signed-response/runtime contract, replay-verified archive-safe evidence, immutable separated CUR2/control-plane history, same-tenant API, and native spend/agreement/entitlement UI exist; real broker/provider and shared handler registration, approved offer/product typing, and live buyer acceptance remain. |
| ADD-06 | Kubecost Containers Cost Allocation Dashboard | `kubecost_container_allocation` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-06-kubecost-allocation.md): tenant-bound six-hour scheduling, exact-byte signed versioned-export transport, deep-frozen CUR2/destination scope, registered immutable attempt migrations, same-tenant API, and native executive/workload/EKS/showback UI exist; shared provider/handler registration, component-cost/capacity dimensions, retained hourly trends, and live reconciliation remain. |
| ADD-07 | SCAD Containers Cost Allocation Dashboard | `scad_container_allocation` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-07-scad-allocation.md): bounded deep-frozen CUR2/S3 runtime, version-pinned partial-safe objects, replay-verified daily binding, immutable corrected-period history, same-tenant API, and native delivery/KPI/workload/cluster/tag/showback UI exist; shared provider/handler registration, non-SCAD TCO join, and live reconciliation remain. |
| ADD-08 | Sustainability Proxy Metrics and Carbon Emissions Dashboard | `sustainability_proxy` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-08-sustainability-carbon.md): tenant-bound daily runtime, signed dual-plane materialization contract, replay-verified bounded archive, immutable separated CUR2-proxy/provider-carbon history, same-tenant API, and native UI exist; shared provider/handler registration, governed target writes, and live carbon-export acceptance remain. |
| ADD-09 | Trends Dashboard | `trends` | `LOCAL_VERTICAL_CANDIDATE` | [Current evidence](finops-cid-evidence/ADD-09-trends.md): bounded CUR2 API/native visuals now cover exact monthly/quarterly/yearly comparisons, interactive contributors, signals, CSV, and lineage; forecast/alerts, service taxonomy/usage, friendly account names, map, exact-tree, and provider acceptance remain. |
| ADD-10 | Data Transfer Dashboard | `data_transfer` | `LOCAL_VERTICAL_CANDIDATE` | [Current evidence](finops-cid-evidence/ADD-10-data-transfer.md): pinned internet/Global Accelerator/inter-Region/inter-AZ/CloudFront taxonomy, exact cost/bytes, filters, drilldowns, safe export and lineage are present; exact-tree/provider/live acceptance remain. |
| ADD-11 | Amazon Connect Cost Insights Dashboard | `amazon_connect_cost_insights` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-11-amazon-connect.md): immutable CUR2-backed aggregate history, same-tenant API, and native seven-area privacy-safe UI exist; provider adapter/HMAC service, separately governed exact lookup, and live acceptance remain. |
| ADD-12 | Config Resource Compliance Dashboard | `config_resource_compliance` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-12-config-resource-compliance.md): bounded server-owned collector/job contract, immutable complete-head persistence, same-tenant API and native UI exist; credential-owning adapter/durable-handler registration and provider acceptance remain. |
| ADD-13 | Pricing Change Analysis Dashboard | `pricing_change` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-13-pricing-change.md): identity-only server-owned materialization, active reconciled `fbg_` CUR2 binding, exact historical Price List contract, deterministic sealed evidence, immutable replay-safe metadata, same-tenant API and native UI exist; provider adapter/handler/policy/full-generation reader registration and live acceptance remain. |

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
