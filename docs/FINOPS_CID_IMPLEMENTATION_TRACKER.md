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
| FND-01 | CUDOS Dashboard | `cudos` | `LOCAL_VERTICAL_CANDIDATE` | [G0–G6 evidence](finops-cid-evidence/FND-01-cudos.md): the pinned 19-sheet/407-visual/142-control definition, monthly/UTC-weekly/daily trends, FOCUS category rankings, all official service-family modules and active CUR2 completeness disclosure are present; provider telemetry/recommendations, commitment expiry/purchase context, exact layout parity, controlled two-tenant reconciliation and live acceptance remain. |
| FND-02 | Cost Intelligence Dashboard | `cost_intelligence_dashboard` | `LOCAL_VERTICAL_CANDIDATE` | [G0–G6 evidence](finops-cid-evidence/FND-02-cost-intelligence.md): the pinned 10-sheet/77-visual/44-control definition, exact currency-separated summaries/trends/MoM spend, bounded explorer, commitment expiry and native per-sheet coverage are present; compute/storage quantity completeness, full RI/SP evidence, all OPTICS controls, usage pivot, exact-tree, controlled two-tenant/provider reconciliation and live acceptance remain. |
| FND-03 | KPI and Modernization Dashboard | `kpi_dashboard` | `LOCAL_VERTICAL_CANDIDATE` | [G0–G6 evidence](finops-cid-evidence/FND-03-kpi-modernization.md): the pinned v2.2.1 10-sheet/91-visual/94-control definition, all 19 governed formulas/goals, account/payer/period filters, sheet-specific native views and corrected official gp3/one-year formulas are present; goal mutation UI, multi-generation MoM, authoritative inventory/activity/compatibility/pricing evidence, exact-tree, controlled provider reconciliation and live acceptance remain. |
| ADV-01 | Trusted Advisor Organizational Dashboard | `trusted_advisor_organizational` | `PARTIAL_PIPELINE` | [G0–G6 evidence](finops-cid-evidence/ADV-01-trusted-advisor-organizational.md) and [orchestration contract](finops-cid-evidence/ADV-01-standard-orchestration-contract.md): the pinned v4.0.1 inventory maps 11 sheets, 147 visuals and 22 controls; native category/suppression analysis and source-safe sheet navigation exist. The Organizations adapter, durable handlers, support-plan reconciliation, authoritative TA Priority/Well-Architected sources, conditional Security Hub classification and live acceptance remain. Standard checks are never substituted for provider-only datasets. |
| ADV-02 | Compute Optimizer Dashboard | `compute_optimizer` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-02-compute-optimizer.md): the pinned public source proves 9 export module families and 14 preview visual purposes; its QuickSight definition is not publicly committed, so exact sheet/control totals remain explicitly unavailable. Immutable organization S3-export history, same-tenant API, and native rightsizing/savings/risk/ownership UI exist; production S3 adapter/job binding, provider export validation, exact template authorization and live acceptance remain. Discovery and direct recommendation APIs are never substituted for export history. |
| ADV-03 | Cost Anomaly Dashboard | `cost_anomaly` | `LOCAL_VERTICAL_CANDIDATE` | [G0–G6 evidence](finops-cid-evidence/ADV-03-cost-anomaly.md): the pinned 2-sheet/6-visual/12-control definition, bounded null-aware provider analysis, actual/expected evidence, four-dimensional contribution, lifecycle/monitor/subscription coverage, safe export and all-six native mapping are present. Four visual semantics remain explicitly partial; standalone query parity is unclaimed. Controlled payer/two-tenant reconciliation, exact-tree and live acceptance remain. |
| ADV-04 | Extended Support Cost Projection | `extended_support_projection` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-04-extended-support.md): the pinned 5-sheet/60-visual/17-control definition, five-service multi-account/Region contract, prevalidated scheduling, replay-safe durable boundary, immutable READY-only history, same-tenant API, exact signed-micro output and native 3/6/12-month UI exist; credential-owning provider adapter, shared runtime registration/IAM, decimal-string provider inputs, real calendar/rate/CUR2 reconciliation, exact layout and live acceptance remain. |
| ADV-05 | Graviton Savings Dashboard | `graviton_savings` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-05-graviton-savings.md): the pinned v3.0.2 inventory maps 7 sheets, 122 visuals and 53 controls; EC2/ASG, RDS/Aurora, OpenSearch and ElastiCache contracts, prevalidated scheduling, signed replay, exact-micro CUR2 economics, immutable history, same-tenant API and native per-sheet evidence exist. Shared provider/runtime wiring, standalone instance mapping, richer service controls, reconciliation, exact layout and live acceptance remain. |
| ADV-06 | Health Events Dashboard | `health_events` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-06-health-events.md): the pinned v3.1.0 inventory maps 3 sheets, 33 visuals and 28 controls; organization past/current/upcoming history, same-tenant API, prerequisite/provider states, native per-sheet planning UI and safe export retain explicit 48-hour-or-more/not-real-time semantics. Production broker/handler, eligible-plan/Organizations validation, real pagination/retention/initial-load, exact layout and live acceptance remain. |
| ADV-07 | AWS News Feeds | `aws_news_feeds` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-07-aws-news-feeds.md): the pinned 6-sheet/21-visual/12-control definition, hardened XML gateway, replay-safe durable contract, immutable history, same-tenant API and native four-family/per-sheet inventory exist; shared worker/tick, durable replay store, controlled-egress registration, exact layout, provider reconciliation and live acceptance remain. |
| ADV-08 | AWS Budgets Dashboard | `aws_budgets` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-08-aws-budgets.md): the pinned 2-sheet/11-visual/7-control definition, six-hour server-scoped scheduler, signed bounded broker transport, immutable hierarchy/actual/forecast history, same-tenant API and native per-visual coverage exist; arbitrary Group By/Sankey geometry, shared handler/adapter registration, secrets, provider reconciliation and live acceptance remain. |
| ADV-09 | AWS Support Cases Radar Dashboard | `support_cases_radar` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-09-support-cases-radar.md): the pinned manifest/changelog/preview and 2 published dataset contracts are mapped; managed QuickSight counts remain explicitly unavailable. Privacy-minimized immutable history, entitlement probing, signed transport, daily runtime, same-tenant API, native case/account/age/cadence/topic views and optional-summary state exist; production registration, provider reconciliation, authorized template definition and live acceptance remain. |
| ADV-10 | ResilienceVue Dashboard | `resiliencevue` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-10-resiliencevue.md): the pinned v1.0.0 inventory maps 4 sheets, 47 visuals and 9 controls; replay-safe target/window runtime, immutable multi-account/Region history, last-assessment filtering, policy posture, score/RPO/RTO trends and recommendation evidence exist. Estimated cost/optimization/architecture/component dimensions require a versioned schema; credential-broker/runtime registration, provider reconciliation, exact layout and live acceptance remain. |
| ADV-11 | AWS End User Computing Dashboard | `end_user_computing` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-11-end-user-computing.md): the pinned v1.2.0 definition audit covers 7 sheets/82 visuals/24 controls; prevalidated failure-isolated scheduling, exact-byte signed transport, privacy-safe WorkSpaces/Applications/metrics/CUR2 evidence, complete account/Region/mode/bundle/fleet aggregates and native visuals exist; shared runtime/broker registration, rolling three-month and privacy-approved usage dimensions, provider reconciliation and live acceptance remain. |
| ADV-12 | Data Collection Monitor Dashboard | `data_collection_monitor` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-12-data-collection-monitor.md): pinned Main/About inventory, bounded metadata-only Step Functions adapter, deterministic hourly runtime/replay contract, tenant-pinned immutable DCF history, same-tenant API, and native Module/Status Category/Days back/Log Links Mode controls with execution/error/retry/latency/coverage visuals and validated console links exist; shared scheduler/handler/replay/provider registration, exact geometry, real DCF acceptance, and live validation remain. |
| ADV-13 | Media Services Insights Hub | `media_services_insights` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-13-media-services-insights.md): the pinned nine-sheet inventory, stable replay-safe five-workflow/46-read runtime, active reconciled CUR2 and governed planning lineage, immutable history, same-tenant API, native workflow views and explicit reservation-savings evidence gap exist; exact service controls/geometry, credential-broker registration and provider acceptance remain. |
| ADD-01 | CORA Dashboard | `cora` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-01-cora.md) and [export activation contract](finops-cid-evidence/ADD-01-cora-export-activation.md): the pinned v0.0.11 inventory maps 5 sheets, 28 visuals and 52 control placements, including the exact embedded Athena SQL. Export materialization, immutable history, retry identity, resource-safe deduplication, same-tenant API and native per-sheet inventory exist; SP/RI dimensions, credential-owning S3/Parquet/runtime adapter, provider reconciliation, exact layout and live acceptance remain. |
| ADD-02 | Cloud Intelligence Dashboard for Azure | `azure_cid` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-02-azure-cid.md): provider-specific Azure source discovery/selection, strict Standard Actual Cost/FOCUS normalization, identity-only daily scheduling, hash-verified durable replay, exact micros, immutable history, same-tenant API, and native six-month/30-day/allocation/pricing/commitment/charge/tag/resource UI exist; shared runtime registration, credentials, recurring export/blob delivery, production adapter, and live Azure acceptance remain. |
| ADD-03 | Cloud Intelligence Dashboard for GCP | `gcp_cid` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-03-gcp-cloud-intelligence.md): the separately maintained official seven-sheet definition is pinned and mapped; provider-specific billing sources, WIF/BigQuery contract, exact signed nanos, immutable history, same-tenant source selection/API, and native Summary/Compute/SQL/BigQuery/Network/Kubernetes/About plus local credit/resource/opportunity views exist; production adapter, reconciliation, exact geometry and live GCP acceptance remain. |
| ADD-04 | FOCUS Dashboard | `focus` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-04-focus.md): the pinned 3-sheet/27-visual definition, provider-neutral FOCUS 1.0–1.2 normalization, immutable provenance, exact post-validation billing controls, all four cost-column coverage states, daily and bounded MoM trends, dual dimensions, resource drilldown, taxonomy and denominator-safe discount state exist; Azure/GCP FOCUS adapters, provider reconciliation, exact-tree and live acceptance remain. |
| ADD-05 | AWS Marketplace Single Pane of Glass Dashboard | `marketplace_spg` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-05-marketplace-spg.md): the immutable five-tab/23-area AWS catalog, tenant-bound prevalidated scheduling, signed replay-safe evidence, immutable separated CUR2/control-plane history, same-tenant API, bounded spend rankings, agreement/deployment/charge, license/expiration and explicit unavailable Bedrock-classification views exist; the managed QuickSight analysis tree is unpublished, while real broker/provider and shared handler registration, approved product typing, reconciliation and live buyer acceptance remain. |
| ADD-06 | Kubecost Containers Cost Allocation Dashboard | `kubecost_container_allocation` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-06-kubecost-allocation.md): the pinned official three-tab Kubecost scope, tenant-bound six-hour runtime, exact-byte versioned-export transport, deep-frozen CUR2 scope, immutable history, same-tenant API, exact component-cost KPIs, filtered hourly trend and executive/workload/EKS/showback visuals exist; OpenCost is supplemental, while node capacity/instance dimensions, shared registration, provider reconciliation and live acceptance remain. |
| ADD-07 | SCAD Containers Cost Allocation Dashboard | `scad_container_allocation` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-07-scad-allocation.md): the immutable AWS manifest and its inconsistent three-tab/five-section guidance are pinned without fabricated QuickSight counts; bounded deep-frozen CUR2/S3 runtime, partial-safe versioned objects, replay-verified daily binding, immutable corrected-period history, same-tenant API, and bounded native KPI/workload/cluster/tag/showback UI exist; shared provider/handler registration, governed non-SCAD TCO/EMR-service joins, provider reconciliation and live acceptance remain. |
| ADD-08 | Sustainability Proxy Metrics and Carbon Emissions Dashboard | `sustainability_proxy` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-08-sustainability-carbon.md): the pinned 6-sheet/25-visual/17-control definition, tenant-bound daily runtime, signed dual-plane materialization, immutable separated CUR2-proxy/provider-carbon history, same-tenant API and native coverage/proxy/carbon/target/plan UI exist; regional renewable/map, processor/family, storage-class, transfer-path and idle-network dimensions need versioned evidence, while shared registration, governed targets, provider and live acceptance remain. |
| ADD-09 | Trends Dashboard | `trends` | `LOCAL_VERTICAL_CANDIDATE` | [Current evidence](finops-cid-evidence/ADD-09-trends.md): versioned capability projection and native visuals now cover exact monthly/quarterly/yearly comparisons, interactive contributors, deterministic Sutra estimates, CUR2 taxonomy/unit-isolated usage/account/Region evidence, Sutra automation status, CSV, and lineage. QuickSight ML/automation, Organizations identity, map coordinates, exact-tree/provider reconciliation, and live acceptance remain. |
| ADD-10 | Data Transfer Dashboard | `data_transfer` | `LOCAL_VERTICAL_CANDIDATE` | [Current evidence](finops-cid-evidence/ADD-10-data-transfer.md): canonical CUR2 now retains exact provider source/destination/location/service/product/operation/transfer-type evidence; distinct paths cannot collapse, missing endpoints are never inferred, and native filters/drilldowns/safe export expose coverage; historical rematerialization, exact-tree/provider reconciliation and live acceptance remain. |
| ADD-11 | Amazon Connect Cost Insights Dashboard | `amazon_connect_cost_insights` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-11-amazon-connect.md): tenant-bound daily signed runtime, exact instance/pagination/privacy/CUR2 boundary, replay-verified sealed evidence, immutable aggregate history, same-tenant API, and native seven-area UI exist; shared provider/handoff registration, separate supporting-service plane, governed exact lookup, and live acceptance remain. |
| ADD-12 | Config Resource Compliance Dashboard | `config_resource_compliance` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-12-config-resource-compliance.md): bounded server-owned collector plus replay-safe daily runtime contract, immutable complete-head persistence, same-tenant API and native UI exist; credential-owning adapter, permanent replay store/shared-handler registration, and provider acceptance remain. |
| ADD-13 | Pricing Change Analysis Dashboard | `pricing_change` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-13-pricing-change.md): tenant-complete daily scheduling, identity-only five-attempt materialization, active reconciled `fbg_` CUR2 binding, exact historical Price List contract, deterministic sealed evidence, immutable replay-safe metadata, same-tenant API and native UI exist; provider adapter/shared-handler/policy/full-generation reader registration and live acceptance remain. |

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
