# Sutra FinOps — Cloud Intelligence Dashboards implementation tracker

Status: **ACTIVE — implementation incomplete; release prohibited until every applicable gate passes**

Catalog reviewed: **2026-08-01**

Current release scope confirmed: **2026-08-02 — build and acceptance target is
the 27 AWS-backed dashboards. ADD-02 Azure CID and ADD-03 GCP CID remain in the
official product catalog but are explicitly excluded from this release build at
the user's direction. Exclusion is not completion: both rows retain their
truthful `PARTIAL_PIPELINE` maturity and no local/live acceptance is claimed.**

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
| Advanced | 13 | 10 | 3 | 0 | 0 | 0 | 0 |
| Additional | 13 | 2 | 11 | 0 | 0 | 0 | 0 |
| **Total** | **29** | **15** | **14** | **0** | **0** | **0** | **0** |

### Current release-scope view

| Release scope | Catalog rows | Candidate | Partial pipeline | Local verified | Live accepted |
|---|---:|---:|---:|---:|---:|
| In scope — AWS-backed dashboards | 27 | 15 | 12 | 0 | 0 |
| Excluded from this build — Azure CID and GCP CID | 2 | 0 | 2 | 0 | 0 |
| **Official catalog retained** | **29** | **15** | **14** | **0** | **0** |

The fifteen candidates are CUDOS, Cost Intelligence, KPI and Modernization, Cost
Anomaly, Compute Optimizer, Extended Support Cost Projection, Health Events, AWS News Feeds, AWS Budgets, Support Cases Radar, ResilienceVue, End User Computing, Data Collection Monitor, Trends, and Data Transfer. The fourteen partial pipelines are Trusted
Advisor Organizational, Graviton Savings,
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
| ADV-01 | Trusted Advisor Organizational Dashboard | `trusted_advisor_organizational` | `PARTIAL_PIPELINE` | [G0–G6 evidence](finops-cid-evidence/ADV-01-trusted-advisor-organizational.md) and [orchestration contract](finops-cid-evidence/ADV-01-standard-orchestration-contract.md): the pinned v4.0.1 inventory maps 11 sheets, 147 visuals and 22 controls; native category/suppression analysis and source-safe sheet navigation exist. The credential-owning fully paged Organizations adapter, exact signed broker route, dedicated RSA-3072 digest-signing key, app-side KMS verifier, immutable `standard-2026-08.2` least-privilege role, protected activation POST/UI control, exact-attempt evidence read, bounded member discovery, and all three durable handlers are implemented and locally tested. The finalizer is queued only after terminal fan-out and transient member failures retain durable retries. Production secret rotation, 08.2 role/source-contract activation, eligible-Support-plan reconciliation, authoritative TA Priority/Well-Architected sources, conditional Security Hub classification and live acceptance remain. Standard checks are never substituted for provider-only datasets. |
| ADV-02 | Compute Optimizer Dashboard | `compute_optimizer` | `LOCAL_VERTICAL_CANDIDATE` | [Current evidence](finops-cid-evidence/ADV-02-compute-optimizer.md): the pinned public source proves 9 module families and 14 preview visual purposes; the unpublished QuickSight definition keeps exact sheet/control totals explicitly unavailable. The canonical eight-export materialization projection, replay-safe launch and activation ledgers, exact-ID Describe barrier, version-bound S3 reader, strict CSVW mapping, all-Region coordinator, immutable exact-generation persistence, durable capability/outbox scheduler, crash-safe sealed-reference handoff, all four shared handlers, same-tenant v2 API, and native exact-micros UI for all 14 purposes are fully wired and locally tested. The exact `.8.5` activation manifest is exposed only through a signed tenant-bound collector route, and the default broker performs identity-only STS attestation with signed responses and absolute deadlines. Partial or ambiguous runs never head; discovery/direct APIs never substitute; alternative savings channels and currencies never merge. Secret/IAM activation, controlled multi-Region provider reconciliation, two-tenant/live acceptance, authorized exact QuickSight geometry, fixed-tree release gates, and deployment remain; no live claim is made. |
| ADV-03 | Cost Anomaly Dashboard | `cost_anomaly` | `LOCAL_VERTICAL_CANDIDATE` | [G0–G6 evidence](finops-cid-evidence/ADV-03-cost-anomaly.md): the pinned 2-sheet/6-visual/12-control definition, bounded null-aware provider analysis, actual/expected evidence, four-dimensional contribution, lifecycle/monitor/subscription coverage, safe export and all-six native mapping are present. Four visual semantics remain explicitly partial; standalone query parity is unclaimed. Controlled payer/two-tenant reconciliation, exact-tree and live acceptance remain. |
| ADV-04 | Extended Support Cost Projection | `extended_support_projection` | `LOCAL_VERTICAL_CANDIDATE` | [Current evidence](finops-cid-evidence/ADV-04-extended-support.md): the pinned 5-sheet/60-visual/17-control definition, deterministic daily scheduler, durable replay/failure ledger, immutable READY-only history, Ed25519 tenant-bound broker, exact STS ceiling, credential-owning collector route, pinned AWS SDK reader across EKS/RDS/Aurora/OpenSearch/ElastiCache/Pricing, same-tenant API, exact signed-micro output and native 3/6/12-month UI are fully wired and locally tested. Immutable `standard-2026-08.6` preserves Compute Optimizer `.8.5` and adds exactly the 14 required read actions. Approved AWS role attestation, authoritative CUR2/lifecycle/rate supplements, controlled bill reconciliation, exact layout, two-tenant/live acceptance, fixed-tree gates and deployment remain; missing evidence stays configuration-required and no live claim is made. |
| ADV-05 | Graviton Savings Dashboard | `graviton_savings` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-05-graviton-savings.md): the pinned v3.0.2 inventory maps 7 sheets, 122 visuals and 53 controls; EC2/ASG, RDS/Aurora, OpenSearch and ElastiCache contracts, prevalidated scheduling, signed replay, exact-micro CUR2 economics, immutable history, same-tenant API and native per-sheet evidence exist. Shared provider/runtime wiring, standalone instance mapping, richer service controls, reconciliation, exact layout and live acceptance remain. |
| ADV-06 | Health Events Dashboard | `health_events` | `LOCAL_VERTICAL_CANDIDATE` | [Current evidence](finops-cid-evidence/ADV-06-health-events.md): the pinned v3.1.0 inventory maps 3 sheets, 33 visuals and 28 controls. The exact `.8.8` customer role, read-only STS ceiling, pinned Health/Organizations SDK reader, entitlement/Organizations/delegated-admin checks, fully paged account/entity/detail capture, conservative initial-load proof, signed local/hosted broker, durable replay/failure ledger, daily shared handler/tick, same-tenant API, four-state collection UI and native 3-sheet planning/export views are fully wired and locally tested. Controlled entitled-organization reconciliation, real 90-day/24-hour provider evidence, exact layout, two-tenant/live acceptance, fixed-tree release gates and deployment remain; no live claim is made. |
| ADV-07 | AWS News Feeds | `aws_news_feeds` | `LOCAL_VERTICAL_CANDIDATE` | [Current evidence](finops-cid-evidence/ADV-07-aws-news-feeds.md): the pinned 6-sheet/21-visual/12-control definition, five exact server-owned sources, hardened controlled-egress XML gateway, durable tenant-bound replay/failure ledger, deterministic six-hour scheduler, shared worker handler, immutable READY-only head, same-tenant API and native four-family/per-sheet inventory are fully wired and locally tested. Provider/live reconciliation, signed-in exact-layout/accessibility acceptance, fixed-tree release gates and deployment remain; therefore no live claim is made. |
| ADV-08 | AWS Budgets Dashboard | `aws_budgets` | `LOCAL_VERTICAL_CANDIDATE` | [Current evidence](finops-cid-evidence/ADV-08-aws-budgets.md): the pinned 2-sheet/11-visual/7-control definition, exact AWS Budgets/Organizations adapter, bounded pagination and response limits, read-only STS ceiling, signed tenant-bound collector route, immutable hierarchy/actual/forecast history, six-hour server scheduler, shared durable handler, same-tenant API and all 11 native visual purposes are fully wired and locally tested. Customer-role permission rollout, deployed asymmetric broker configuration, controlled provider reconciliation, exact Sankey geometry, two-tenant/live acceptance, fixed-tree gates and deployment remain; no live claim is made. |
| ADV-09 | AWS Support Cases Radar Dashboard | `support_cases_radar` | `LOCAL_VERTICAL_CANDIDATE` | [Current evidence](finops-cid-evidence/ADV-09-support-cases-radar.md): the pinned manifest/changelog/preview and 2 published dataset contracts are mapped; managed QuickSight counts remain explicitly unavailable. Privacy-minimized credential-owning collection, HMAC-redacted case evidence, entitlement probing, immutable history, signed local/hosted transport, deterministic cohort scheduler, durable shared handler, same-tenant API, native case/account/age/cadence/topic views and optional-summary state are fully wired and locally tested. Immutable `standard-2026-08.7` preserves `.8.6` and adds exactly `DescribeCases` and `DescribeCommunications`; dedicated production evidence-key wiring and route-specific bounded responses are included. Controlled provider reconciliation, authorized exact template definition, two-tenant/live acceptance, fixed-tree gates and deployment remain; no live claim is made. |
| ADV-10 | ResilienceVue Dashboard | `resiliencevue` | `LOCAL_VERTICAL_CANDIDATE` | [Current evidence](finops-cid-evidence/ADV-10-resiliencevue.md): the pinned v1.0.0 inventory maps 4 sheets, 47 visuals and 9 controls. The credential-owning Resilience Hub client executes all 14 bounded read operations, while durable lease/replay/status persistence, signed tenant-bound transport, migration registration, daily shared handler/tick, same-tenant API, four-state UI and native policy/score/RPO/RTO/recommendation views are fully wired and locally tested. Immutable `standard-2026-08.9` preserves `.8.8` and adds exactly the Resilience Hub reads. Estimated cost, optimization type, architecture and App Component dimensions remain configuration-required until an authoritative versioned schema exists. Controlled provider reconciliation, exact layout, two-tenant/live acceptance, fixed-tree gates and deployment remain; no live claim is made. |
| ADV-11 | AWS End User Computing Dashboard | `end_user_computing` | `LOCAL_VERTICAL_CANDIDATE` | [Current evidence](finops-cid-evidence/ADV-11-end-user-computing.md): the pinned v1.2.0 definition audit covers 7 sheets/82 visuals/24 controls. Credential-owning WorkSpaces/AppStream collection, privacy-minimized metrics, exact CUR2 digest binding, failure-isolated account/Region aggregation, 93-day observed trends, signed bounded transport, hosted reconciled cost context, six-hour handler/tick, durable replay, same-tenant API and native unavailable/collecting/failed/ready UI are fully wired and locally tested. Immutable `standard-2026-08.11` preserves `.8.10` and adds exactly eight EUC reads; predecessor app runtimes remain eligible through explicit non-lexical allowlists. Controlled provider/CUR2 reconciliation, two-tenant/live acceptance, exact layout, fixed-tree gates and deployment remain; no live claim is made. |
| ADV-12 | Data Collection Monitor Dashboard | `data_collection_monitor` | `LOCAL_VERTICAL_CANDIDATE` | [Current evidence](finops-cid-evidence/ADV-12-data-collection-monitor.md): the pinned v1.0.1 manifest and complete embedded definition map exactly 2 sheets, 10 visuals, 6 controls, 5 parameters, 21 calculated fields, 15 filter groups, and 1 dataset. The credential-owning Step Functions reader, exact state-machine/execution ARN policy, bounded signed route, 16-minute durable lease/replay ledger, immutable complete-head history, deterministic hourly handler/tick, same-tenant API and native unavailable/collecting/failed/ready execution/error/retry/latency/coverage UI are fully wired and locally tested. Immutable `standard-2026-08.10` preserves `.8.9` and malformed lexical successors are rejected. Controlled DCF/provider reconciliation, exact geometry, two-tenant/live acceptance, fixed-tree gates and deployment remain; no live claim is made. |
| ADV-13 | Media Services Insights Hub | `media_services_insights` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADV-13-media-services-insights.md): the complete public v2.2.1 definition is hash-pinned at 9 sheets, 144 visuals, 92 control placements, 44 parameters, 175 calculated fields, 241 filter groups and 3 SPICE datasets, with 52 documented purposes mapped into report-independent UI evidence. The replay-safe five-workflow/46-read runtime and immutable CUR2 lineage exist; reservation savings, Budgets, CloudWatch/performance evidence, provider registration, reconciliation and live acceptance remain unavailable. |
| ADD-01 | CORA Dashboard | `cora` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-01-cora.md) and [export activation contract](finops-cid-evidence/ADD-01-cora-export-activation.md): the pinned v0.0.11 inventory maps 5 sheets, 28 visuals and 52 control placements, including the exact embedded Athena SQL. Export materialization, immutable history, retry identity, resource-safe deduplication, same-tenant API and native per-sheet inventory exist; SP/RI dimensions, credential-owning S3/Parquet/runtime adapter, provider reconciliation, exact layout and live acceptance remain. |
| ADD-02 | Cloud Intelligence Dashboard for Azure | `azure_cid` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-02-azure-cid.md): 11 official source/deployment/transformation/query artifacts plus the 21-column dataset and embedded query are hash-pinned. The service-hosted QuickSight definition is unpublished, so object totals remain explicitly null. Native six-month/30-day/allocation/pricing/charge/tag/resource evidence exists; Azure identity, recurring export/Blob delivery, provider adapter, price sheet, reservation recommendations, exact geometry, reconciliation and live acceptance remain. |
| ADD-03 | Cloud Intelligence Dashboard for GCP | `gcp_cid` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-03-gcp-cloud-intelligence.md): 9 official source/deployment/dataset/query artifacts and the complete embedded definition are hash-pinned at 7 sheets, 60 visuals, 54 control placements, 14 parameters, 53 calculated fields, 172 filter groups, 2 datasets and 3 views. Native source-safe report/UI evidence exists; the Workload Identity/BigQuery adapter, live generation and reconciliation, six-level hierarchy parity, exact interactions/geometry and live acceptance remain. |
| ADD-04 | FOCUS Dashboard | `focus` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-04-focus.md): the complete public definition is hash-pinned at 3 sheets, 27 visuals, 20 control placements, 6 parameters, 24 calculated fields, 45 filter groups and 2 datasets. Native report-independent UI evidence and provider-neutral FOCUS 1.0–1.2 normalization exist; AWS FOCUS 1.2 is bound, while Azure/OCI FOCUS adapters, the separate GCP FOCUS export adapter, provider reconciliation, exact-tree and live acceptance remain fail-closed. |
| ADD-05 | AWS Marketplace Single Pane of Glass Dashboard | `marketplace_spg` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-05-marketplace-spg.md): the immutable five-tab/23-area AWS catalog, tenant-bound prevalidated scheduling, signed replay-safe evidence, immutable separated CUR2/control-plane history, same-tenant API, bounded spend rankings, agreement/deployment/charge, license/expiration and explicit unavailable Bedrock-classification views exist; the managed QuickSight analysis tree is unpublished, while real broker/provider and shared handler registration, approved product typing, reconciliation and live buyer acceptance remain. |
| ADD-06 | Kubecost Containers Cost Allocation Dashboard | `kubecost_container_allocation` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-06-kubecost-allocation.md): 8 official source/deployment/export artifacts plus the 62-column dataset and exact Athena query are hash-pinned; AWS documents 3 purpose-level tabs but publishes no QuickSight definition, so object totals remain explicitly unavailable. Tenant-bound six-hour runtime, versioned-export transport, immutable history, same-tenant API and native executive/workload/EKS/showback evidence exist; OpenCost remains supplemental, while node capacity/instance dimensions, shared provider registration, reconciliation and live acceptance remain. |
| ADD-07 | SCAD Containers Cost Allocation Dashboard | `scad_container_allocation` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-07-scad-allocation.md): the immutable AWS manifest and its inconsistent three-tab/five-section guidance are pinned without fabricated QuickSight counts; bounded deep-frozen CUR2/S3 runtime, partial-safe versioned objects, replay-verified daily binding, immutable corrected-period history, same-tenant API, and bounded native KPI/workload/cluster/tag/showback UI exist; shared provider/handler registration, governed non-SCAD TCO/EMR-service joins, provider reconciliation and live acceptance remain. |
| ADD-08 | Sustainability Proxy Metrics and Carbon Emissions Dashboard | `sustainability_proxy` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-08-sustainability-carbon.md): the pinned 6-sheet/25-visual/17-control definition is returned in every successful API state and rendered independently of report availability. Tenant-bound dual-plane materialization, immutable separated CUR2-proxy/provider-carbon history and native coverage/proxy/carbon/target/plan UI exist; regional renewable/map, processor/family, storage-class, transfer-path and idle-network dimensions require versioned evidence, while shared registration, governed targets, provider reconciliation and live acceptance remain. |
| ADD-09 | Trends Dashboard | `trends` | `LOCAL_VERTICAL_CANDIDATE` | [Current evidence](finops-cid-evidence/ADD-09-trends.md): 9 public artifacts and 3 dataset/view contracts are hash-pinned, and all 9 documented feature areas plus 7 provable control names are mapped. AWS does not publish the service-hosted QuickSight definition, so exact object totals remain explicitly unavailable. Native exact comparisons, contributors, deterministic estimates, CUR2 taxonomy/usage/account/Region evidence, automation status, CSV and lineage exist; QuickSight ML/automation, Organizations identity, map coordinates, provider reconciliation and live acceptance remain. |
| ADD-10 | Data Transfer Dashboard | `data_transfer` | `LOCAL_VERTICAL_CANDIDATE` | [Current evidence](finops-cid-evidence/ADD-10-data-transfer.md): the manifest and embedded Athena query are hash-pinned and all 5 AWS-documented purposes are mapped. AWS does not publish the QuickSight definition/template body/changelog, so exact object totals remain explicitly unavailable. Canonical CUR2 retains exact provider path/service/product/operation/transfer-type evidence with native filters, drilldowns and safe export; historical rematerialization, provider/two-tenant reconciliation, release gates and live acceptance remain. |
| ADD-11 | Amazon Connect Cost Insights Dashboard | `amazon_connect_cost_insights` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-11-amazon-connect.md): the pinned complete definition maps exactly 8 sheets, 121 visuals and 61 controls; 5 public artifacts are hash-verified while the unpublished `resource_connect_view` dataset/query remain explicitly null. Tenant-bound signed runtime, exact instance/pagination/privacy/CUR2 boundary, immutable aggregate history, same-tenant API and native seven-area UI exist; provider/handoff registration, supporting-service evidence, governed exact lookup, exact geometry and live acceptance remain. |
| ADD-12 | Config Resource Compliance Dashboard | `config_resource_compliance` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-12-config-resource-compliance.md): the separately linked official v5.0.0 repository is pinned with 5 raw artifacts, 13 dataset definitions and 14 Athena views; its complete definition maps exactly 7 sheets, 124 visuals and 64 controls. Bounded collection/runtime, immutable complete-head persistence, same-tenant API and native compliance/inventory/usage evidence exist; credential-owning adapter/replay/shared-handler registration, tag/resource-specific/threat/event projections, exact geometry and provider acceptance remain. |
| ADD-13 | Pricing Change Analysis Dashboard | `pricing_change` | `PARTIAL_PIPELINE` | [Current evidence](finops-cid-evidence/ADD-13-pricing-change.md): the pinned complete definition maps exactly 2 sheets, 11 visuals and 10 control placements, with 6 hash-verified public artifacts; the current Guidance/manifest category and manifest/changelog version discrepancies remain explicit. Tenant-complete scheduling, sealed evidence, immutable replay-safe metadata, same-tenant API and native purpose mapping exist; historical Price List provider/shared-handler/full-CUR2 reader registration, semantic reconciliation, exact geometry and live acceptance remain. |

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
6. Audit and close all gates for the fifteen local candidates.
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
