# Claude Code FinOps handover — 2026-08-02

This document is the continuation contract for the Sutra Cloud Intelligence / FinOps dashboard work.
It is deliberately conservative: a dashboard is not promoted merely because isolated engine or UI code exists.

## Repository and immutable handoff point

| Item | Value |
|---|---|
| Repository | `https://github.com/ydsveluvolu2996/Sutra.git` |
| Branch | `agent/mac-mini-finops-continuation` |
| Draft PR | `https://github.com/ydsveluvolu2996/Sutra/pull/26` |
| Last fully tracked status commit | `d5b2f0608271a2a129b3b38075202b53de072ad3` |
| Complete remaining-work WIP snapshot | `b75f751` (`wip(finops): snapshot remaining dashboard verticals`) |
| Release scope | 27 AWS-backed dashboards |
| Explicitly excluded from this build | ADD-02 Azure CID and ADD-03 GCP CID |
| Deployment performed | No |
| Production image changed | No |

The WIP snapshot contains every uncommitted file that existed when work stopped: 185 files, 10,958 insertions and 432 deletions. It was pushed intentionally as one WIP safety commit so no agent output is only local.

## Snapshot health

These checks passed against `b75f751` after all agents were stopped:

```text
pnpm typecheck                 PASS
pnpm typecheck:collector       PASS
pnpm security:secrets          PASS (2,460 source files)
git diff --check               PASS
```

`cfn-lint` 1.46.0 is installed at:

```text
/Users/Shared/sutra-codex/tools/cfnlint-venv/bin/cfn-lint
```

Before the WIP snapshot, the full 13-template CloudFormation gate through permission pack `.8.11` passed. The repository script suppressed only its documented inherited Bedrock catalog false positives.

The authoritative dashboard tracker intentionally remains at **15 local candidates, 14 partial pipelines total**, which means **15/27 in-scope AWS dashboards are local candidates and 12/27 remain partial**. Do not change those counts merely because the WIP snapshot contains substantial code.

## Claude Code execution ledger — all 27 in-scope dashboards

The word **completed** below means `LOCAL_VERTICAL_CANDIDATE`: the dashboard's local collector/runtime, persistence, API and native UI evidence reached the repository's candidate threshold. It does **not** mean production-deployed or live-accepted. Every candidate still requires the common fixed-SHA release, controlled-provider, signed-in two-tenant and deployment gates described later in this document.

### Completed local candidates — 15 of 27

| ID and dashboard | What is built and wired now | Local evidence / checkpoint | Still required before production |
|---|---|---|---|
| FND-01 CUDOS | Pinned 19-sheet/407-visual/142-control model; monthly, UTC-weekly and daily trends; FOCUS rankings; service-family modules; CUR2 completeness disclosure. | `docs/finops-cid-evidence/FND-01-cudos.md`; tracker state `LOCAL_VERTICAL_CANDIDATE`. | Provider telemetry/recommendations, commitment context, exact-layout parity, controlled two-tenant reconciliation, live acceptance and shared release gates. |
| FND-02 Cost Intelligence | Pinned 10-sheet/77-visual/44-control model; currency-separated summaries/trends/MoM, bounded explorer, commitment expiry and per-sheet coverage. | `docs/finops-cid-evidence/FND-02-cost-intelligence.md`; tracker state `LOCAL_VERTICAL_CANDIDATE`. | Complete compute/storage quantities, RI/SP and OPTICS evidence, usage pivot, exact-tree, controlled reconciliation and live acceptance. |
| FND-03 KPI and Modernization | Pinned v2.2.1 10-sheet/91-visual/94-control model; 19 governed formulas/goals; account/payer/period filters; native sheet views; corrected gp3 and one-year formulas. | `docs/finops-cid-evidence/FND-03-kpi-modernization.md`; tracker state `LOCAL_VERTICAL_CANDIDATE`. | Goal mutation UI, multi-generation MoM and authoritative inventory/activity/compatibility/pricing evidence; exact-tree, reconciliation and live acceptance. |
| ADV-02 Compute Optimizer | Eight-export materialization; replay-safe launch/activation ledgers; exact-ID barrier; version-bound S3/CSVW reader; all-Region coordinator; immutable generation persistence; scheduler and all four handlers; signed STS activation; same-tenant API; 14-purpose exact-micros UI. | Feature `f96b73a`; tracker `9561050`; `docs/finops-cid-evidence/ADV-02-compute-optimizer.md`. | Activate exact `.8.5` IAM/broker secrets, controlled multi-Region provider reconciliation, two-tenant/live acceptance, authorized QuickSight geometry and fixed-tree release gates. |
| ADV-03 Cost Anomaly | Pinned 2-sheet/6-visual/12-control model; null-aware provider analysis; actual/expected amounts; four-dimensional contribution; lifecycle/monitor/subscription coverage; safe export and six native mappings. | `docs/finops-cid-evidence/ADV-03-cost-anomaly.md`; tracker state `LOCAL_VERTICAL_CANDIDATE`. | Close four explicitly partial visual semantics, controlled payer/two-tenant reconciliation, exact-tree and live acceptance. |
| ADV-04 Extended Support | Daily scheduler; durable replay ledger; immutable READY history; Ed25519 broker; STS ceiling; credential-owning route; pinned EKS/RDS/Aurora/OpenSearch/ElastiCache/Pricing reader; same-tenant API; native 3/6/12-month UI; immutable `.8.6`. | Feature `963a54e`; tracker `5ba771f`; `docs/finops-cid-evidence/ADV-04-extended-support.md`. | Approved AWS role attestation, authoritative CUR2/lifecycle/rate supplements, bill reconciliation, exact layout, two-tenant/live acceptance and release gates. |
| ADV-06 AWS Health Events | Exact `.8.8` role; STS ceiling; pinned Health/Organizations reader; entitlement/delegated-admin checks; paged account/entity/detail capture; signed broker; durable replay; daily handler/tick; API and native three-sheet four-state UI. | Feature `6dab352`; tracker `ec18b0d`; `docs/finops-cid-evidence/ADV-06-health-events.md`. | Controlled entitled-organization and real 90-day/24-hour reconciliation, exact layout, two-tenant/live acceptance and release gates. |
| ADV-07 AWS News Feeds | Five exact server-owned feeds; controlled-egress XML gateway; tenant replay/failure ledger; deterministic six-hour scheduler; shared handler; immutable READY head; same-tenant API; four-family/per-sheet UI. | Feature `ddc448b`; tracker `398fa9e`; `docs/finops-cid-evidence/ADV-07-aws-news-feeds.md`. | Provider/live reconciliation, signed-in layout/accessibility acceptance and fixed-tree/deployment gates. |
| ADV-08 AWS Budgets | Exact Budgets/Organizations reader; bounded pagination; STS ceiling; signed route; immutable hierarchy/actual/forecast history; six-hour scheduler; shared handler; same-tenant API and all 11 native visual purposes. | Feature `e2551db`; tracker `8b8745c`; `docs/finops-cid-evidence/ADV-08-aws-budgets.md`. | Customer-role rollout, deployed asymmetric broker configuration, provider reconciliation, exact Sankey geometry, two-tenant/live acceptance and release gates. |
| ADV-09 Support Cases Radar | Privacy-minimized Support collection; HMAC-redacted evidence; entitlement probe; immutable history; signed transport; cohort scheduler; durable handler; API; case/account/age/cadence/topic UI; immutable `.8.7`. | Feature `6d5699b`; tracker `3f1ae64`; `docs/finops-cid-evidence/ADV-09-support-cases-radar.md`. | Controlled provider reconciliation, authorized managed-template definition, two-tenant/live acceptance and fixed-tree/deployment gates. |
| ADV-10 ResilienceVue | All 14 bounded Resilience Hub reads; durable lease/replay/status; signed transport; migration registration; daily handler/tick; API; four-state policy/score/RPO/RTO/recommendation UI; immutable `.8.9`. | Feature `d1e91bf`; tracker `ffbe454`; `docs/finops-cid-evidence/ADV-10-resiliencevue.md`. | Authoritative schema for optional cost/architecture dimensions, controlled reconciliation, exact layout, two-tenant/live acceptance and release gates. |
| ADV-11 End User Computing | WorkSpaces/AppStream collection; privacy-minimized metrics; exact CUR2 digest binding; account/Region failure isolation; 93-day trends; signed transport; six-hour handler/tick; durable replay; API; native four-state UI; immutable `.8.11`. | Feature `98265d5`; tracker `d5b2f06`; `docs/finops-cid-evidence/ADV-11-end-user-computing.md`. | Controlled provider/CUR2 reconciliation, two-tenant/live acceptance, exact layout and fixed-tree/deployment gates. |
| ADV-12 Data Collection Monitor | Exact Step Functions reader and ARN policy; bounded signed route; 16-minute lease/replay; immutable complete-head history; hourly handler/tick; API; four-state execution/error/retry/latency/coverage UI; immutable `.8.10`. | Feature `24c78c9`; tracker `22b9fce`; `docs/finops-cid-evidence/ADV-12-data-collection-monitor.md`. | Controlled DCF/provider reconciliation, exact geometry, two-tenant/live acceptance and fixed-tree/deployment gates. |
| ADD-09 Trends | Nine pinned artifacts and three dataset/view contracts; all nine documented feature areas and seven controls; native comparisons, contributors, estimates, CUR2 taxonomy/usage/account/Region, automation status, CSV and lineage. | `docs/finops-cid-evidence/ADD-09-trends.md`; tracker state `LOCAL_VERTICAL_CANDIDATE`. | QuickSight ML/automation, Organizations identity, map coordinates, provider reconciliation, exact managed geometry if authorized, and live acceptance. |
| ADD-10 Data Transfer | Pinned manifest/query; all five documented purposes; canonical CUR2 provider path/service/product/operation/transfer-type evidence; filters, drilldowns and safe export. | `docs/finops-cid-evidence/ADD-10-data-transfer.md`; tracker state `LOCAL_VERTICAL_CANDIDATE`. | Historical rematerialization, provider/two-tenant reconciliation, fixed-tree release gates and live acceptance. |

### Pending verticals — 12 of 27

All rows below remain `PARTIAL_PIPELINE` until the stated integration and promotion gates pass. The WIP snapshot may contain substantial implementation, so reuse and validate it rather than rebuilding the vertical.

| Priority | ID and dashboard | Reusable implementation already present | Exact next engineering work | Reservation / promotion proof |
|---:|---|---|---|---|
| 1 | ADV-05 Graviton Savings | EC2/ASG, RDS/Aurora, OpenSearch and ElastiCache contracts; bounded provider reader; signed action/session contracts; immutable history; same-tenant API/UI; `.8.12` template; Drizzle `0122`; PostgreSQL `0118`; shared handler/tick and signer. | First register PostgreSQL `0118` in `db/postgres-runtime-migrations.ts`; audit all three registries; finish standalone instance mapping/shared provider wiring; run complete focused and predecessor regressions. | Permission `.8.12`; migrations `0122/0118`; reported 33/33 focused tests must be rerun at fixed SHA, followed by typechecks/builds, CFN lint, migration parity and tracker promotion. |
| 2 | ADD-05 Marketplace SPG | Buyer-only agreement/discovery/license adapter; signed broker; durable runtime; product taxonomy; four-state API/UI; Drizzle `0123`; PostgreSQL `0119`. | Pin three Marketplace/License SDKs; create immutable `.8.13`; register route/broker/handler/tick and all migration registries; extend explicit predecessor allowlists; keep Bedrock classification unavailable. | Permission `.8.13`; migrations `0123/0119`; rerun reported 30/30 focused tests plus shared route, predecessor, migration, build and CFN gates. |
| 3 | ADD-01 CORA | Strict export adapter; signed broker; production composition; 17-minute CAS lease/replay; Drizzle `0124`; PostgreSQL `0120`; API/UI states and exact evidence handling. | Pin BCM Data Exports and Cost Optimization Hub SDKs; security/license review and pin a bounded Parquet decoder; create `.8.14`; register migrations/route/broker/handler/tick; extend allowlists. | Permission `.8.14`; migrations `0124/0120`; rerun reported 43/43 app/runtime, 3/3 provider and 4/4 lease tests plus build/CFN/migration gates. |
| 4 | ADD-08 Sustainability and Carbon | Strict export/provider route; signed broker; durable runtime; governed target repository/API; evidence-gated dimensions; exact 6-sheet/25-visual/17-control UI; migrations `0126/0122`. | Create `.8.15` with bounded S3/Data Exports/Sustainability reads; register migrations/route/broker/handler/tick/loaders; extend allowlists; preserve separation of provider carbon and proxy estimates. | Permission `.8.15`; migrations `0126/0122`; rerun reported 31/31 focused and 4/4 collector tests plus build/CFN/migration and reconciliation gates. |
| 5 | ADD-11 Amazon Connect Cost Insights | Connect adapter/route; exact instance ARN and `TargetArn`; privacy aggregation/HMAC IDs; 17-minute lease/replay; signed broker; daily composition; migrations `0127/0123`; four-state API/UI. | Pin Connect SDK; create `.8.16` with exact Connect/Directory Service reads; register route/broker/handler/tick/migrations/loaders; extend allowlists; leave unpublished/supporting dimensions unavailable. | Permission `.8.16`; migrations `0127/0123`; rerun reported 33/33 focused tests plus privacy, migration, build and CFN gates. |
| 6 | ADD-13 Pricing Change Analysis | 1,001-row CUR2 reader; historical Price List reader/route; signed broker; durable repository/composition; migrations `0128/0124`; runtime UI states. | Create `.8.17` with only `pricing:ListPriceLists` and `pricing:GetPriceListFileUrl`; register route/handler/tick/migrations/composition; extend allowlists; retain official metadata discrepancies. | Permission `.8.17`; migrations `0128/0124`; rerun 33 regressions, 4 closure and 3 collector tests plus build/CFN/migration gates. |
| 7 | ADD-12 Config Resource Compliance | Config/Organizations paginator and sanitizer; strict signed route; durable daily runtime; migrations `0129/0125`; exact 7-sheet/124-visual/64-control/13-dataset/14-view UI. | Pin Config Service SDK; create `.8.18`; register route/broker/handler/tick/activation/migrations; extend allowlists; do not substitute Security Hub or CloudTrail for unavailable evidence. | Permission `.8.18`; migrations `0129/0125`; rerun reported 23/23 runtime, 4/4 UI, 3/3 provider and 3/3 production tests plus shared gates. |
| 8 | ADD-04 FOCUS | Existing authenticated FOCUS report API, provider-neutral normalization and report-independent three-sheet UI; AWS FOCUS path is partially bound. | Build durable AWS export discovery/materialization/runtime state; pin BCM Data Exports SDK; bind persisted export ARN/bucket/prefix; create/register `.8.19`, `0130/0126`, handler/tick and activation; keep Azure/GCP paths fail-closed. | Permission `.8.19`; reserved migrations `0130/0126`; no new closure test claim exists—establish focused, migration, replay, two-tenant and provider reconciliation proof before promotion. |
| 9 | ADD-06 Kubecost Allocation | Correct daily Snappy Parquet schema 2.0.0; exact 62 columns/node dimensions; version-pinned S3 reader; strict route; six-hour composition; four-state native UI. | Register provider route, exact bucket/prefix/CMK session policy, handler/tick and activation; use explicit known permission-pack allowlist from `.8.9`, never lexical version comparison. | No new SDK, migration or permission version; rerun reported 36/36 tests plus exact S3 scope, replay, shared handler and provider reconciliation gates. |
| 10 | ADD-07 SCAD Allocation | Strict CUR2 route; signed provider; dedicated 31-minute CAS ledger; Drizzle `0125`; PostgreSQL `0121`; persisted checkpoint/orphan recovery and four-state UI. | Register all migrations plus exact `foundational-cur2-export-v1` route/session/handler/daily tick; do not fabricate non-SCAD TCO or EMR joins. | No new permission pack; migrations `0125/0121`; rerun 19 closure, 7 vertical and 2 provider tests plus CAS recovery, migration and reconciliation gates. |
| 11 | ADV-01 Trusted Advisor Organizational | Fully paged Organizations adapter; signed broker; RSA-3072 evidence key/verifier; `.8.2` role; activation API/UI; bounded discovery; three durable handlers and retry-safe finalization. | Rotate production secret; activate `.8.2` source contract; reconcile eligible Support plans; add authoritative TA Priority/Well-Architected sources; make Security Hub conditional; complete provider and two-tenant acceptance. | Existing `.8.2`; no reserved migration in this handoff; rerun orchestration/crypto/fan-out tests and all controlled-provider, fixed-tree and live gates. |
| 12 | ADV-13 Media Services Insights | Hash-pinned v2.2.1 9-sheet/144-visual/92-control definition; five-workflow/46-read replay-safe runtime; immutable CUR2 lineage; 52 UI purposes. | Complete reservation-savings, Budgets, CloudWatch/performance evidence, provider registration and reconciliation; preserve unavailable dimensions instead of synthesizing them. | Audit required IAM additions before assigning any successor version; prove runtime/provider reconciliation, exact evidence tree, two-tenant and live acceptance before promotion. |

Claude Code must update both this ledger and `docs/FINOPS_CID_IMPLEMENTATION_TRACKER.md` when a vertical is promoted. A row moves to completed only after collector → persistence → scheduler/handler → authenticated API → native UI/four states → focused tests → shared regressions are all green at the same commit. Do not lower the remaining count for code presence alone.

## Fully closed and independently committed verticals

The following were completed as isolated feature commits and then recorded by isolated tracker commits:

| Dashboard | Feature commit | Tracker commit | Local state |
|---|---|---|---|
| ADV-07 AWS News Feeds | `ddc448b` | `398fa9e` | Candidate |
| ADV-02 Compute Optimizer | `f96b73a` | `9561050` | Candidate |
| ADV-08 AWS Budgets | `e2551db` | `8b8745c` | Candidate |
| ADV-04 Extended Support | `963a54e` | `5ba771f` | Candidate |
| ADV-09 Support Cases Radar | `6d5699b` | `3f1ae64` | Candidate |
| ADV-06 AWS Health Events | `6dab352` | `ec18b0d` | Candidate |
| ADV-10 ResilienceVue | `d1e91bf` | `ffbe454` | Candidate |
| ADV-12 Data Collection Monitor | `24c78c9` | `22b9fce` | Candidate |
| ADV-11 End User Computing | `98265d5` | `d5b2f06` | Candidate |

The tracker already included six earlier candidates: FND-01 CUDOS, FND-02 Cost Intelligence, FND-03 KPI and Modernization, ADV-03 Cost Anomaly, ADD-09 Trends and ADD-10 Data Transfer.

## Remaining 12 in-scope partial dashboards

### 1. ADV-05 Graviton Savings — finish this first

The WIP snapshot contains the nearly complete shared `.8.12` integration plus the previously green unique vertical.

Implemented in the snapshot:

- immutable `standard-2026-08.12` template;
- pinned `@aws-sdk/client-auto-scaling@3.1087.0`;
- concrete bounded cross-service reader and strict provider route;
- exact Graviton action/session contracts (OpenSearch uses the correct `es:` IAM prefix);
- Drizzle `0122` and PostgreSQL `0118` migration files;
- D1 registry, CLI migration list, local registry, role broker, collector route;
- shared handler/daily tick, Ed25519 evidence signer, authority-row binding and activation;
- predecessor catalog extension through `.8.12`;
- 33/33 focused Graviton/successor/collector tests were reported green before the stop;
- root and collector typechecks pass in the WIP snapshot.

Known concrete gap to fix before promotion:

- `db/postgres-runtime-migrations.ts` does **not** import/register `postgres/migrations/0118_finops_graviton_runtime.sql`, although `scripts/postgres-migrate.mjs` does. Add it and prove migration parity.

Then rerun focused tests, root/collector typechecks and builds, lint, secrets, native CFN lint, PostgreSQL migration tests, and predecessor D1 regressions. Only then create an isolated Graviton completion commit and promote ADV-05 in the tracker.

### 2. ADD-05 Marketplace SPG — unique vertical complete, shared integration pending

WIP state reported green: 30/30 focused tests, collector typecheck, ESLint, diff and secrets.

Implemented: buyer-only adapter/route, signed broker, durable runtime repository, production composition, approved SOFTWARE/DATA/PROFESSIONAL_SERVICES taxonomy, four-state API/UI, Drizzle `0123`, PostgreSQL `0119`.

Remaining shared work:

- add pinned SDK dependencies: `@aws-sdk/client-marketplace-agreement`, `@aws-sdk/client-marketplace-discovery`, `@aws-sdk/client-license-manager` at `3.1087.0`;
- create immutable `.8.13` successor preserving `.8.12`;
- exact role-broker/session/local-server/handler/tick/migration registration;
- extend predecessor app allowlists through `.8.13`;
- keep Bedrock classification explicitly unavailable without authoritative evidence.

### 3. ADD-01 CORA — unique vertical complete, shared integration pending

WIP state reported green: 43/43 app/runtime, 3/3 provider, 4/4 durable lease tests, collector typecheck/build, lint/diff/secrets.

Implemented: strict export adapter/route, signed broker, production composition, dedicated 17-minute CAS lease/replay repository, Drizzle `0124`, PostgreSQL `0120`, API/UI states and exact evidence handling.

Remaining shared work:

- create immutable `.8.14` successor;
- register migrations and handler/tick/collector/role-broker hooks;
- add pinned `@aws-sdk/client-bcm-data-exports@3.1087.0` and `@aws-sdk/client-cost-optimization-hub@3.1087.0`;
- select and pin a bounded Parquet decoder only after license/security review;
- extend predecessor app allowlists through `.8.14`.

### 4. ADD-08 Sustainability and Carbon — unique vertical complete, shared integration pending

WIP state reported green: 31/31 focused tests, 4/4 collector tests, root/collector typechecks/build, lint/diff/secrets.

Implemented: strict provider/export route, signed broker, durable runtime, governed target repository/API, evidence-gated optional dimensions, Drizzle `0126`, PostgreSQL `0122`, exact 6-sheet/25-visual/17-control UI. Export, proxy and optional direct-API comparator are kept separate.

Remaining shared work:

- create immutable `.8.15` successor with exact S3/Data Exports/Sustainability reads;
- register migrations, role/route/handler/daily tick and production loaders;
- extend predecessor app allowlists through `.8.15`;
- never merge proxy estimates with provider emissions or invent carbon factors.

### 5. ADD-11 Amazon Connect Cost Insights — unique vertical complete, shared integration pending

WIP state reported green: 33/33 focused tests, root/collector typechecks, lint/diff/secrets.

Implemented: Connect adapter/default client/strict route, exact instance ARN and `TargetArn` controls, privacy aggregation/HMAC identifiers, durable 17-minute lease/replay, signed broker, daily composition, Drizzle `0127`, PostgreSQL `0123`, four-state API/UI.

Remaining shared work:

- add `@aws-sdk/client-connect@3.1087.0`;
- create immutable `.8.16` successor with exact `connect:DescribeInstance`, `connect:ListPhoneNumbersV2` and `ds:DescribeDirectories` grants;
- register migrations, route, broker, handler/tick and canonical CUR2/evidence loaders;
- extend predecessor app allowlists through `.8.16`;
- keep unpublished `resource_connect_view`, supporting-service evidence and privileged contact lookup unavailable.

### 6. ADD-13 Pricing Change Analysis — unique vertical complete, shared integration pending

WIP state reported green: 33 existing regressions, 4 production closure tests, 3 collector tests, lint/diff/secrets.

Implemented: 1,001-row-capable CUR2 reader, real historical Price List reader/route, signed broker, durable repository/composition, Drizzle `0128`, PostgreSQL `0124`, runtime UI state.

Remaining shared work:

- create immutable `.8.17` successor with only `pricing:ListPriceLists` and `pricing:GetPriceListFileUrl` on `*`;
- register migrations, route, handler/daily tick and signed production composition;
- extend predecessor app allowlists through `.8.17`;
- preserve the official Guidance/manifest category and version discrepancies explicitly.

### 7. ADD-12 Config Resource Compliance — unique vertical complete, shared integration pending

WIP state reported green: 23/23 engine/job/runtime/official, 4/4 UI, 3/3 provider, 3/3 production, root/collector typechecks/build, lint/diff/secrets.

Implemented: Config/Organizations paginator and sanitizer, strict signed route, durable daily runtime, Drizzle `0129`, PostgreSQL `0125`, exact 7-sheet/124-visual/64-control/13-dataset/14-view UI and four states.

Remaining shared work:

- add `@aws-sdk/client-config-service@3.1087.0`;
- create immutable `.8.18` successor with exact Config/Organizations and optional contract-bound S3 reads;
- register migrations, route, broker, handler/tick and activation;
- extend predecessor app allowlists through `.8.18`;
- do not substitute Security Hub or CloudTrail for missing versioned evidence.

### 8. ADD-04 FOCUS — work was only audited/reserved at stop time

Reserved continuation:

- permission successor `.8.19`;
- Drizzle `0130`, PostgreSQL `0126`;
- add `@aws-sdk/client-bcm-data-exports@3.1087.0`;
- exact persisted export ARN/bucket/prefix scope;
- build durable discovery/materialization/runtime state and shared registration;
- keep excluded Azure/GCP provider paths explicitly unavailable rather than fabricating parity.

No substantial new FOCUS implementation was included in `b75f751`; continue from the existing partial pipeline.

### 9. ADD-06 Kubecost Allocation — unique vertical complete, shared integration pending

WIP state reported green: 36/36 focused tests, root/collector typechecks, lint/diff/secrets.

Implemented: corrected daily Snappy Parquet schema 2.0.0, exact 62 columns and node dimensions, version-pinned S3 reader, strict route, six-hour composition and four states.

No new migration, SDK or permission pack is required. Register the route, exact bucket/prefix/CMK session policy, handler/tick and activation. Accept only the explicit known permission-pack allowlist starting at `.8.9`; never use lexical version comparison.

### 10. ADD-07 SCAD Allocation — unique vertical complete, shared integration pending

WIP state reported green: 19/19 closure, 7/7 vertical, 2/2 provider plus CAS recovery, root/collector typechecks, lint/secrets.

Implemented: strict CUR2 route, signed provider, dedicated 31-minute CAS ledger, Drizzle `0125`, PostgreSQL `0121`, PERSISTED checkpoint/orphan recovery/four-state UI.

No new permission pack or SDK is needed. Register migrations and exact `foundational-cur2-export-v1` route/session/handler/daily tick. Do not fabricate non-SCAD TCO or EMR joins.

### 11. ADV-01 Trusted Advisor Organizational

This remains partial in the authoritative tracker. It was not materially advanced in the WIP snapshot. Complete the previously documented secret rotation, permission-pack activation, eligible Support-plan reconciliation, authoritative TA Priority/Well-Architected sources, conditional Security Hub classification, provider/two-tenant acceptance and fixed-tree gates.

### 12. ADV-13 Media Services Insights Hub

This remains partial and was not materially advanced in the WIP snapshot. Finish reservation savings, Budgets, CloudWatch/performance evidence, provider registration, reconciliation and live acceptance without inventing unsupported dimensions.

## Permission-pack sequence — do not collide or mutate old templates

| Version | Owner |
|---|---|
| `.8.5` | Compute Optimizer |
| `.8.6` | Extended Support |
| `.8.7` | Support Cases |
| `.8.8` | Health Events |
| `.8.9` | ResilienceVue |
| `.8.10` | Data Collection Monitor |
| `.8.11` | End User Computing |
| `.8.12` | Graviton (in WIP snapshot) |
| `.8.13` | Marketplace SPG |
| `.8.14` | CORA |
| `.8.15` | Sustainability |
| `.8.16` | Amazon Connect |
| `.8.17` | Pricing Change |
| `.8.18` | Config Compliance |
| `.8.19` | FOCUS (reserved) |

Every successor must be immutable, preserve every prior policy, extend the central explicit app allowlists, and include D1 regressions. Never accept versions by string ordering or an open-ended regex.

## Migration reservations — preserve this exact order

| Dashboard | Drizzle | PostgreSQL |
|---|---:|---:|
| Graviton | `0122` | `0118` |
| Marketplace SPG | `0123` | `0119` |
| CORA | `0124` | `0120` |
| SCAD | `0125` | `0121` |
| Sustainability | `0126` | `0122` |
| Amazon Connect | `0127` | `0123` |
| Pricing Change | `0128` | `0124` |
| Config Compliance | `0129` | `0125` |
| FOCUS reserved | `0130` | `0126` |

For every vertical, update all three registries together:

- `db/runtime-migrations.ts`
- `db/postgres-runtime-migrations.ts`
- `scripts/postgres-migrate.mjs`

Then run SQLite and PostgreSQL migration parity tests before promotion.

## Recommended continuation order

1. Checkout/pull `agent/mac-mini-finops-continuation`; confirm `HEAD` contains `b75f751` and this handover commit.
2. Run `pnpm install --frozen-lockfile`, root and collector typechecks, secrets and `git diff --check`.
3. Finish Graviton `.8.12` first, especially the missing PostgreSQL runtime registry entry; validate and commit it separately; then promote ADV-05 in a separate tracker commit.
4. Integrate one shared vertical at a time in permission order: Marketplace `.8.13`, CORA `.8.14`, Sustainability `.8.15`, Amazon Connect `.8.16`, Pricing `.8.17`, Config `.8.18`, FOCUS `.8.19`.
5. Integrate Kubecost and SCAD exact S3/CUR2 bindings without creating unnecessary new permission versions.
6. Finish Trusted Advisor Organizational and Media Services Insights Hub.
7. Only after all 27 in-scope rows are local candidates/verified, run the full fixed-SHA release matrix: root/collector typechecks and builds, all test shards, PostgreSQL 16 migrations/runtime roles, rendered/accessibility tests, lint, secret scan, Trivy/SBOM, Docker/compose/rollback.
8. Perform controlled AWS provider reconciliation and signed-in two-tenant acceptance.
9. Merge/review, publish one immutable image, deploy through the existing private-beta workflow, and capture live/rollback proof.

## Commands for the next agent

```bash
cd /Users/Shared/sutra-codex/Sutra
git switch agent/mac-mini-finops-continuation
git pull --ff-only origin agent/mac-mini-finops-continuation
git status --short
pnpm install --frozen-lockfile
pnpm typecheck
pnpm typecheck:collector
pnpm security:secrets
git diff --check
PATH=/Users/Shared/sutra-codex/tools/cfnlint-venv/bin:$PATH pnpm lint:cloudformation
```

Use Node `v22.23.2` for authoritative full-suite evidence. A prior 365/367 collector run under Node 22.16 had two environment-only dynamic `.ts` import failures in compiled local-server tests; rerun with the repository-approved Node before classifying them as product failures.

## Ten-minute bootstrap for Claude Code

Run this before editing anything. Stop if the branch is wrong, the handover checkpoint is missing, the pull is not fast-forward, or the worktree is unexpectedly dirty.

```bash
cd /Users/Shared/sutra-codex/Sutra
git fetch origin
git switch agent/mac-mini-finops-continuation
git pull --ff-only origin agent/mac-mini-finops-continuation
git merge-base --is-ancestor 6a9b4f5 HEAD
git status --short --branch
node --version                         # expected v22.23.2
pnpm --version
pnpm install --frozen-lockfile
pnpm typecheck
pnpm typecheck:collector
pnpm security:secrets
git diff --check
PATH=/Users/Shared/sutra-codex/tools/cfnlint-venv/bin:$PATH pnpm lint:cloudformation
```

The `6a9b4f5` check proves that the complete execution ledger is an ancestor; the branch tip may legitimately be newer. If the working tree is dirty before Claude edits it, preserve and identify those changes instead of resetting, overwriting or folding them into the next vertical.

Root `CLAUDE.md` is the mandatory repository instruction contract. Before editing a partial dashboard, create and complete the pre-edit sections of `docs/FINOPS_VERTICAL_CLOSURE_TEMPLATE.md`. This worksheet is the no-duplicate-work control: every discovered asset must be classified as reuse, repair, missing or contractually unavailable before implementation begins.

## No-rework execution contract

Zero rework cannot be guaranteed in software, especially before controlled AWS evidence exists. The following controls are mandatory to minimize it and to prevent avoidable duplicate or conflicting work:

1. **Audit before edit:** search every alias for the dashboard across `app`, `lib`, `db`, collector, infrastructure, tests and documentation. Complete the closure worksheet before changing code.
2. **Freeze proven work:** files classified `REUSE_AS_IS` do not change unless a named requirement or failing test proves the need. Record that proof in the worksheet first.
3. **Bound the edit set:** list vertical-specific and shared files before work. If a new file becomes necessary, update the worksheet with the reason before touching it.
4. **One vertical to G6:** do not begin another dashboard until the current feature and its tracker/evidence update are committed, pushed and remote-verified.
5. **One shared-file integrator:** parallel agents may touch only disjoint vertical-specific files. A single integrator owns dependency manifests/lockfile, role broker, local server, daily scheduler, migration registries, permission successors, central allowlists and program trackers.
6. **Sequential IAM chain:** `.8.12` through `.8.19` are integrated strictly in order by the same integrator. Never build successors in parallel against different predecessors.
7. **No opportunistic cleanup:** no refactors, renames, formatting sweeps or unrelated dependency upgrades during closure. Record non-blocking cleanup separately.
8. **Test at the final feature SHA:** interrupted-agent and pre-integration results establish a starting point only. Candidate evidence comes from the exact pushed feature commit.
9. **Two-commit close:** push implementation first, then evidence/tracker promotion. This makes rollback and review precise and avoids marking unpushed code complete.
10. **Fail closed on uncertainty:** conflicting schemas, unpublished dimensions, missing provider evidence or unclear permission scope remain unavailable until authoritative proof exists; never guess to finish a row.

The following shared files are an exclusive integration lane and must never be edited by multiple agents concurrently:

```text
package.json
pnpm-lock.yaml
services/aws-collector/src/role-broker.ts
services/aws-collector/src/local-server.ts
lib/finops-daily.ts
db/runtime-migrations.ts
db/postgres-runtime-migrations.ts
scripts/postgres-migrate.mjs
infrastructure/customer-onboarding-role-standard-2026-08.*.yaml
central permission catalogs and explicit version allowlists
docs/FINOPS_CID_IMPLEMENTATION_TRACKER.md
docs/CLAUDE_CODE_FINOPS_HANDOVER_2026-08-02.md
```

An agent that finishes vertical-specific work hands the integrator its starting SHA, asset inventory, bounded file list, exact tests/results, unresolved gaps and commit SHA. The integrator reuses that commit, performs shared wiring once, and alone promotes the tracker row.

## Canonical file and responsibility map

| Concern | Canonical locations | Required handling |
|---|---|---|
| Truthful program status | `docs/FINOPS_CID_IMPLEMENTATION_TRACKER.md`, this handover, `docs/finops-cid-evidence/` | Tracker maturity is authoritative. Update the vertical evidence and tracker only after same-SHA promotion gates pass. |
| Native dashboard/UI | `app/costs/finops-*-dashboard.tsx`, matching CSS modules, `lib/finops-*-dashboard.ts` | Preserve unavailable/collecting/failed/ready states and never present absent provider evidence as zero. |
| Authenticated report APIs | `app/api/v1/finops/*/route.ts` | Enforce same-tenant authorization, bounded responses, explicit failure states and no credential exposure. |
| Domain/runtime composition | `lib/finops-*`, especially `*-job.ts`, `*-runtime-binding.ts`, `*-production-composition.ts`, `*-signed-broker.ts` | Keep scheduler identity, replay, deadlines, evidence signing and immutable READY-head semantics consistent. |
| Durable storage | `db/finops-*`, `drizzle/*.sql`, `postgres/migrations/*.sql` | Preserve tenant keys, leases/CAS, replay identity and immutable evidence. Register each new migration in all three registries. |
| Collector provider boundary | `services/aws-collector/src/*-provider-adapter.ts`, `*-provider-route.ts`, SDK readers, `role-broker.ts`, `local-server.ts` | Collector owns AWS credentials. Use bounded/paginated reads, exact session ceilings, signed responses and explicit provider contracts. |
| Shared scheduler | `lib/finops-daily.ts` and dashboard-specific jobs/compositions | A unique vertical is not closed until shared handler/tick registration and durable failure behavior are tested. |
| Permission packs | `infrastructure/customer-onboarding-role-standard-2026-08.*.yaml`, `scripts/cfn-lint.mjs`, permission contract tests | Add immutable successors only; preserve all predecessors; update explicit allowlists and CFN lint inputs. |
| Dependency pins | root and collector `package.json` files plus `pnpm-lock.yaml` | Use exact approved SDK versions (`3.1087.0` in this sequence), regenerate the lockfile with pnpm and review transitive/license impact. |
| Release verification | root `package.json` scripts, `tests/`, collector tests | Focused tests support iteration; `pnpm verify` is the repository-wide release gate, not a substitute for provider/live acceptance. |

For a vertical, locate its complete surface before editing:

```bash
dashboard_term=graviton
rg --files app lib db services/aws-collector/src tests infrastructure docs \
  | rg "$dashboard_term"
rg -n "$dashboard_term|standard-2026-08" \
  lib/finops-daily.ts services/aws-collector/src/local-server.ts \
  services/aws-collector/src/role-broker.ts db/runtime-migrations.ts \
  db/postgres-runtime-migrations.ts scripts/postgres-migrate.mjs
```

Use a task-specific variable such as `dashboard_term`; do not repurpose system variables. Repeat the inventory with the dashboard's alternate identifiers (for example `config-compliance` and `aws_config_resource_compliance`) so no shared registration is missed.

## Candidate definition of done

| Gate | Required evidence at one commit | Candidate may be promoted? |
|---|---|---|
| G0 Official contract | Version/hash-pinned AWS source, honest published/unpublished QuickSight inventory, supported dimensions explicitly separated from unavailable ones. | No |
| G1 Collector/provider | Credential-owning adapter and SDK reader, exact actions/resources, pagination/bounds/deadlines, strict route validation and signed tenant-bound response. | No |
| G2 Persistence | Drizzle and PostgreSQL schemas, all three runtime registries, tenant isolation, lease/replay/CAS behavior and migration parity tests. | No |
| G3 Orchestration | Deterministic scheduler, shared handler/tick, retry/failure isolation, immutable complete/READY head and production composition. | No |
| G4 API/security | Same-tenant authenticated route, bounded payloads, explicit unavailable/collecting/failed/ready states, no secrets or raw sensitive provider fields. | No |
| G5 Native UI | Dashboard-specific visuals/controls backed by real API fields, four-state behavior, accessibility/render contract and no fabricated zero/parity claims. | No |
| G6 Local verification | Focused vertical, collector, route/UI, shared-registration, permission, migration and predecessor regression tests; both typechecks/builds, lint, secret and CFN checks green. | Yes—`LOCAL_VERTICAL_CANDIDATE` only |
| G7 Release acceptance | `pnpm verify`, fixed-tree checks, controlled AWS reconciliation, signed-in two-tenant acceptance, image/SBOM/Trivy/rollback evidence at one fixed SHA. | Required for release/deployment, not for local candidate promotion |

Every promotion commit must link or update the matching `docs/finops-cid-evidence/<ID>-*.md` record with the exact test commands and observed results. Reported test counts from interrupted work are navigation aids, not reusable proof; rerun them after the final shared integration.

## Safe per-vertical commit and push protocol

1. Start from a clean, pulled branch and record the starting SHA.
2. Inventory the entire vertical across UI, API, `lib`, `db`, collector, infrastructure, tests and evidence.
3. Implement one vertical only. Do not combine the next permission successor or unrelated WIP cleanup.
4. Run focused tests while iterating, then the G0–G6 candidate matrix at the final feature SHA.
5. Inspect `git diff --check`, `git status --short`, `git diff --stat` and `git diff --cached` before committing.
6. Commit the implementation with explicit paths and push it immediately.
7. In a second commit, update the evidence record, execution ledger and authoritative tracker count; push again.
8. Verify `git rev-parse HEAD` equals `git ls-remote origin refs/heads/agent/mac-mini-finops-continuation` before moving to the next vertical.

Do not amend, squash, force-push or rewrite the checkpoint commits. The draft PR is the safety journal until the final reviewed merge.

## Known traps and fail-closed decisions

| Trap | Required response |
|---|---|
| WIP code looks nearly complete | Reuse it, but keep the tracker `PARTIAL_PIPELINE` until shared registration and same-SHA tests pass. |
| Permission version comparison | Use exact enumerated allowlists; never lexical comparison, permissive regexes or “latest” matching. |
| Successor permission template | Create a new immutable file, preserve prior policies, extend CFN lint/tests and prove predecessor apps still work. Never edit an older standard in place. |
| Migration exists as a SQL file | It is incomplete until registered in `db/runtime-migrations.ts`, `db/postgres-runtime-migrations.ts` and `scripts/postgres-migrate.mjs`, with SQLite/PostgreSQL parity proof. |
| Provider returns no evidence | Render unavailable/collecting/failed as appropriate; never coerce absence to zero, healthy, compliant or optimized. |
| Unpublished AWS/QuickSight objects | Keep counts/geometry/dimensions explicitly unavailable unless an authorized versioned artifact proves them. |
| Optional proxy or alternate source | Keep it visually and semantically separated from authoritative provider measurements; never merge carbon proxies, OpenCost, Security Hub or CloudTrail into provider-native claims. |
| Monetary calculations | Preserve exact micros/currency separation and source lineage; do not use floating-point aggregation or combine currencies. |
| Tenant/provider boundary | AWS credentials stay in the collector. Bind tenant, connection, account, request identity, deadline and evidence signature end to end. |
| Tests pass under a different Node version | Reproduce under Node `v22.23.2` before treating results as release evidence. |
| Full local suite passes | Do not deploy. Controlled AWS, two-tenant, image security and rollback gates still remain. |
| Azure/GCP code is visible | Preserve ADD-02/ADD-03 catalog/tracker rows but do not work on or count them in this 27-dashboard release. |

## Ready-to-paste Claude Code continuation prompt

```text
Continue the Sutra AWS FinOps dashboard program from
agent/mac-mini-finops-continuation. Read
docs/CLAUDE_CODE_FINOPS_HANDOVER_2026-08-02.md completely, then read
docs/FINOPS_CID_IMPLEMENTATION_TRACKER.md and the evidence record for the
vertical you are closing. Do not rebuild existing WIP. Begin with ADV-05
Graviton and the missing PostgreSQL 0118 runtime-registry entry. Complete one
vertical end to end across collector, IAM, persistence, scheduler, API, native
four-state UI, tests and evidence before starting another. Preserve immutable
permission versions and the exact migration reservations. Keep ADD-02 Azure
and ADD-03 GCP excluded. Promote a tracker row only after G0-G6 pass at the
same SHA. Commit and push the feature, then commit and push the evidence/tracker
update separately. Do not merge, publish an image or deploy until all 27
in-scope rows and G7 release acceptance pass.
```

## Release safety rules

- Do not merge the WIP snapshot directly to main as a completed release.
- Do not promote a tracker row until collector → persistence → scheduler/handler → API → UI/states → tests are all wired.
- Do not deploy or publish an image until all 27 in-scope dashboards and fixed-tree/provider/two-tenant gates pass.
- Never alter older permission templates in place.
- Never stage unrelated agent work into a vertical completion commit; use explicit file staging.
- Preserve Azure/GCP catalog rows but keep ADD-02/ADD-03 excluded from this build.

Production remained unchanged throughout this handoff.
