# Sutra Mac Mini execution progress

Authoritative scope and maturity:
`docs/FINOPS_CID_IMPLEMENTATION_TRACKER.md`

Branch: `agent/mac-mini-finops-continuation`

Starting fixed-tree SHA: `a9e3d96a8804aa217af42b0e53eb16087194ba96`

## Current capability baseline

| Item | Current truth |
|---|---|
| Official catalog | 29: 3 Foundational, 13 Advanced, 13 Additional |
| Current release scope | 27 AWS-backed dashboards; ADD-02 Azure CID and ADD-03 GCP CID remain catalogued but are excluded from this build by user direction |
| Local vertical candidates | 13 of 29 |
| Partial pipelines | 16 of 29: 14 in-scope AWS-backed plus 2 excluded provider rows |
| Engine-only capabilities | 0 of 29 |
| Absent capabilities | 0 of 29 |
| Local verticals fully audited | 0 of 29 |
| Production accepted | 0 of 29 |
| Current AWS runtime registry | 27 rows; Azure/GCP require separate provider runtimes and KPI label is outdated |
| Deployment authorization | Received; implementation, verification, reviewed release, and exact-image gates remain |
| Updated image deployed | No |
| Live site showing this branch | No |

## Fixed-tree verification

The baseline was run from one clean tree using Node `v22.23.2`, pnpm
`11.13.1`, and Trivy `0.72.0`. The initial shard-6 attempt failed closed because
Trivy was unavailable. After installing the repository-pinned version, the
focused pipeline test passed 5/5 and the unchanged full shard passed. The final
aggregate below records only the corrected complete run.

| Gate | SHA | Status | Exact result/evidence |
|---|---|---|---|
| Checkout/branch/worktree | `a9e3d96…` | PASS | Correct continuation branch; clean; handover remote is ancestor |
| `pnpm typecheck` | `a9e3d96…` | PASS | 2026-08-01 local run |
| `pnpm typecheck:collector` | `a9e3d96…` | PASS | 2026-08-01 local run |
| `pnpm lint` | `a9e3d96…` | PASS | 2026-08-01 local run |
| `pnpm security:secrets` | `a9e3d96…` | PASS | 1,749 source files scanned |
| `git diff --check` | `a9e3d96…` | PASS | No whitespace errors |
| `pnpm build` | `a9e3d96…` | PASS | Vinext production build completed |
| `pnpm test:rendered` | `a9e3d96…` | PASS | 4 passed, 0 failed, 0 skipped |
| Repository shard 1/6 | `a9e3d96…` | PASS | 472 passed, 0 failed, 1 skipped |
| Repository shard 2/6 | `a9e3d96…` | PASS | 469 passed, 0 failed, 0 skipped |
| Repository shard 3/6 | `a9e3d96…` | PASS | 494 passed, 0 failed, 2 skipped |
| Repository shard 4/6 | `a9e3d96…` | PASS | 526 passed, 0 failed, 0 skipped |
| Repository shard 5/6 | `a9e3d96…` | PASS | 487 passed, 0 failed, 1 skipped |
| Repository shard 6/6 | `a9e3d96…` | PASS | 651 passed, 0 failed, 0 skipped |
| **Repository aggregate** | `a9e3d96…` | **PASS** | **3,099 passed, 0 failed, 4 skipped** |
| PostgreSQL 16 migrations/runtime roles | `a9e3d96…` | NOT YET PROVEN | Required before release |
| Docker/image/compose/rollback | — | NOT STARTED | Required after implementation |
| Controlled AWS/Azure/GCP validation | — | NOT STARTED | Required before live acceptance |
| GitHub exact-SHA release gates | — | NOT STARTED | Required before image publication/deployment |

## Release-boundary discovery

| Item | Verified current state |
|---|---|
| Public origin | `https://www.sutracmdb.com` responds successfully |
| Public health | `GET /api/healthz` returned HTTP 200 with `{"ok":true}` on 2026-08-01 |
| Currently served image | `738663485493.dkr.ecr.ap-south-1.amazonaws.com/sutra/app@sha256:dac227d0a9cbe84c70abecb82c046c7324edb45c9bc0ec345a8513d8d7a30ebc` |
| Currently deployed Git revision | Last successful private-beta workflow ran from `main` at `89376840a8b9c2cfe8a970d611065f4e4add6153`; the public header proves the digest, while the workflow run provides the revision association |
| Configured release path | `.github/workflows/ec2-private-beta-release.yml` with GitHub OIDC, immutable ECR digest, Trivy gate, SSM deployment, and public post-deploy checks |
| Repository release variables | AWS account, `ap-south-1`, release role, and exact EC2 instance are configured in GitHub |
| Managed HA environments | Not configured in the repository; the currently usable reviewed path is the existing EC2 private-beta release workflow |
| New release eligibility | **NO** — implementation and exact-revision gates are still open; the current live digest must remain unchanged until they close |

The deployed revision statement above is an inference from the latest successful
release workflow plus the live immutable digest header. Final G10 evidence must
repeat both checks after deployment and record the exact new workflow run.

## Execution queue

| Order | Workstream | Exit condition |
|---:|---|---|
| 1 | Correct 29-row presentation catalog/readiness logic | Azure/GCP visible without false AWS bindings; labels/counts/tests exact; source health cannot imply implementation completion |
| 2 | Complete FinOps information architecture | 29-row Foundational/Advanced/Additional navigation and shared filters/drilldowns/evidence/export/states |
| 3 | Trusted Advisor Organizational | Full standard-check organizational view plus separately labelled Priority supplement; collector/history/API/UI/tests complete |
| 4 | Remaining 18 engine-only rows | Each gains source/collector/persistence/API/UI/tests/evidence |
| 5 | Data Collection Monitor and FOCUS | Both satisfy their official dashboard contracts |
| 6 | Audit and finish six candidates | Every local gate is proven for all six |
| 7 | Audit all 27 in-scope AWS dashboards | Every source/collector/persistence/API/UI/state contract and evidence row is exact; Azure/GCP exclusions remain explicit |
| 8 | Full exact-tree verification | Every in-scope local gate, PostgreSQL, Docker, rendered and accessibility audit passes |
| 9 | Controlled provider acceptance | AWS and specialized in-scope sources reconciled; two-tenant evidence attached |
| 10 | GitHub and immutable release | Scoped commits pushed/reviewed, exact-SHA checks, image provenance, deployment, rollback, and live proof complete |

## Checkpoint log

Append one tracker-linked record after every completed child gate or pushed
slice. Never replace current failures or skips with historical results.

```text
UTC time:
Tracker row / gate:
Maturity transition:
Commit:
Files:
Tests passed/failed/skipped:
Unavailable or failed gates:
Controlled-live evidence:
Limitations/blockers:
PR/check/image/deploy evidence:
Next gate:
```

### 2026-08-01 — catalog and shared evidence shell

| Field | Evidence |
|---|---|
| Tracker rows / gates | All 29 / presentation inventory and shared G5 foundation |
| Maturity transition | None; 6 candidate, 2 partial, 19 engine-only, and 2 absent remain truthful |
| Commit | `6efe74b6b0` pushed to `origin/agent/mac-mini-finops-continuation` |
| Files | Canonical catalog, responsive level navigation, reusable evidence shell, cost-workspace integration, focused tests |
| Tests | 10 passed, 0 failed, 0 skipped; touched-file ESLint and `git diff --check` passed |
| Correctness audit | Exact 3/13/13 counts; official names/audiences; Azure/GCP remain outside AWS runtime bindings; no false ready/live labels; shared-analysis action receives a real focus/scroll target |
| Visual acceptance | Source/render contracts complete; signed-in Chrome behavior run is pending because the installed Browser plugin control channel cannot attach |
| Release evidence | Commit pushed; no image published and current live digest remains unchanged |
| Next gate | Complete authoritative collectors/APIs, bind per-dashboard live data to the shared shell, then run browser and exact-tree acceptance |

### 2026-08-01 — Trusted Advisor standard-check collector

| Field | Evidence |
|---|---|
| Tracker row / gates | ADV-01 / G1 complete locally; first bounded portion of G2 implemented and focused-tested |
| Maturity transition | None; remains `ENGINE_ONLY` until organization fan-out, persistence, API, and visual UI are complete |
| Collector evidence | Exact read-only `support:DescribeTrustedAdvisorChecks` and `support:DescribeTrustedAdvisorCheckResult`; commercial partition and `us-east-1`; no refresh; deterministic 512-check/25,000-resource/8-MiB limits |
| Readiness correction | Organizations taxonomy and standard checks are required; Priority organization recommendations remain supplemental |
| Tests | Collector runner/dispatch 18 passed; source-health/compute/TA/FOCUS/UI integration set 44 passed; registry/permissions 16 passed; root and collector typechecks, changed-file ESLint, and `git diff --check` passed |
| Limitations | Organization fan-out, immutable organization history, authenticated TAO API/UI, and deployable onboarding policy are not in this slice |
| Next gate | ADV-01 G2 organization orchestration, then G3 immutable manifest/account/organization persistence |

### 2026-08-01 — dedicated FOCUS 1.2 report API

| Field | Evidence |
|---|---|
| Tracker row / gates | ADD-04 / bounded G4 report/API foundation over the existing active immutable billing generations |
| Maturity transition | None; remains `PARTIAL_PIPELINE` until its complete visual dashboard and acceptance gates pass |
| Engine/API evidence | FOCUS 1.2 only; CUR/FOCUS 1.0 substitution rejected; same-tenant active AWS connection; 36 periods/250,000 rows; signed bigint micros; currencies separate; schema quality, source rejections, freshness, bounded dimensions and drilldowns |
| Tests | 9 passed, 0 failed, 0 skipped; root typecheck and focused ESLint passed |
| Limitations | `conformanceClaim:false`; no invoice-reconciliation claim; dedicated visual dashboard not yet connected |
| Next gate | ADD-04 G5 visual report with filters, trends, dimension charts/table, drilldown, quality and evidence drawer |

### 2026-08-01 — four-slice FinOps integration checkpoint

| Field | Evidence |
|---|---|
| Tracker rows / gates | ADV-01 G3 foundation; ADV-02 G2 discovery; ADV-03 audited G0–G6 candidate; ADD-04 AWS FOCUS 1.2 G5 slice |
| Code commit | `a9f7cb7` on `agent/mac-mini-finops-continuation`; push follows the evidence commit |
| Cost Anomaly | Official-style account/service/region/date/impact controls, trends, safe CSV, root-cause drilldown, evidence coverage, honest lifecycle/currency labels; 43 application and 24 collector tests passed |
| FOCUS | Exact per-currency bigint-micros KPIs, month trend, bounded dimensions/line drilldown, quality and evidence drawers, all delivery states; direct suite 14 passed |
| Trusted Advisor Organizational | Frozen manifest/account orchestration plus immutable SQLite/PostgreSQL account/check/resource/organization history and complete-only monotonic head; focused integrated suite passed |
| Compute Optimizer | Exact read-only enrollment/member/export-job discovery; bounded pagination/output/deadlines, deterministic evidence, hashed provider destinations, no export/S3 authority; 19 collector/dispatch tests passed |
| Integration gates | Root and collector typechecks, changed-file ESLint, secret scan of 1,775 files, `git diff --check`, collector build, and production app build passed |
| Maturity audit | FOCUS remains `PARTIAL_PIPELINE`: official multi-version/provider consolidation, tag taxonomy, and effective discount rate are not yet implemented; no optimistic elevation |
| Controlled-live evidence | None; current onboarding roles do not yet activate TA standard checks or Compute Optimizer discovery, and provider/two-tenant acceptance is pending |
| Release evidence | No image published or deployed; current live digest remains unchanged |
| Next gate | Push exact commits and continue ADV-01/ADV-02 through API/UI, then complete the remaining engine-only rows |

### 2026-08-01 — Compute Optimizer export-history vertical

| Field | Evidence |
|---|---|
| Tracker row / gates | ADV-02 / local G2–G6 candidate slice over organization S3 export objects |
| Maturity transition | ADV-02 `ENGINE_ONLY` → `PARTIAL_PIPELINE`; aggregate is 6 candidates, 18 partial pipelines, 3 engine-only, and 2 absent |
| Trust boundary | Only completed, hash-addressed organization S3 exports enter recommendation history; discovery and direct recommendation APIs are explicitly excluded |
| Delivery | Immutable complete-head export generations and retained history, same-tenant API, organization/account/Region/resource views, over/under/idle/optimized status, savings/risk, owner/team/business-unit and eligibility-tag analysis, formula-safe CSV |
| Focused verification | Engine plus vertical 18 passed; full TypeScript and targeted ESLint passed before shared integration |
| Remaining gates | Register production S3 export-object adapter and durable handler, bind completed discovery jobs without using discovery as recommendation evidence, validate real organization/all-Region/resource-type exports, and run two-tenant/provider/visual/live acceptance |
| Release evidence | Source slice only; no image published or deployed |
| Next gate | Integrate release migrations and navigation, then continue Extended Support, Graviton, and Health Events |

### 2026-08-01 — Extended Support projection vertical

| Field | Evidence |
|---|---|
| Tracker row / gates | ADV-04 / local G1–G6 candidate slice |
| Maturity transition | ADV-04 `ENGINE_ONLY` → `PARTIAL_PIPELINE`; aggregate is 6 candidates, 19 partial pipelines, 2 engine-only, and 2 absent |
| Delivery | Server-pinned five-service account/Region contract for ElastiCache, EKS, RDS, Aurora and OpenSearch; immutable READY-only accepted history; same-tenant API; exact signed-micro public results; native service, eligibility, effective-date, resource, actual-versus-projection, 3/6/12-month and remediation views |
| Focused verification | Engine plus vertical 14 passed; full lint, targeted UI lint and diff validation passed; no ADV-04 TypeScript errors |
| Honest gaps | Production provider adapter/scheduler/IAM are not deployed; provider price/actual inputs still need decimal or micro strings before end-to-end exact-money status; real calendars, rates, CUR2 and live provider/two-tenant acceptance remain |
| Release evidence | Source slice only; no image published or deployed |
| Next gate | Integrate Graviton and Health Events, then remove provider activation gaps |

### 2026-08-01 — Graviton Savings cross-service vertical

| Field | Evidence |
|---|---|
| Tracker row / gates | ADV-05 / local G1–G6 candidate slice |
| Maturity transition | ADV-05 `ENGINE_ONLY` → `PARTIAL_PIPELINE`; aggregate is 6 candidates, 20 partial pipelines, 1 engine-only, and 2 absent |
| Delivery | EC2/Auto Scaling, RDS/Aurora, OpenSearch and ElastiCache collection/evidence contracts; immutable COMPLETE-only accepted history; authenticated same-tenant API; existing Arm usage; service summaries; modeled-potential versus measured-realized monthly trends; blockers, provenance, resource drilldown and formula-safe CSV |
| Evidence safety | Managed-service opportunities require explicit inventory/pricing authority plus compatibility, CUR2, pricing and metadata; family-name inference and fabricated Compute Optimizer estimates are rejected |
| Focused verification | Engine plus vertical 17 passed; full TypeScript, targeted ESLint and diff validation passed before shared integration |
| Remaining gates | Deploy the production collector/materializer; bind live OpenSearch/ElastiCache compatibility, pricing and workload/license attestations; confirm Compute Optimizer provider coverage; complete multi-account/two-tenant/provider/visual/live acceptance |
| Release evidence | Source slice only; no image published or deployed |
| Next gate | Complete Health Events, Azure CID and GCP CID, then close every activation and acceptance gap |

### 2026-08-01 — AWS Health Events planning vertical

| Field | Evidence |
|---|---|
| Tracker row / gates | ADV-06 / local G1–G6 candidate slice |
| Maturity transition | ADV-06 `ENGINE_ONLY` → `PARTIAL_PIPELINE`; aggregate is 6 candidates, 21 partial pipelines, 0 engine-only, and 2 absent |
| Delivery | Server-owned organization collection contract; past/current/upcoming events; affected accounts/entities/details; immutable status-transition and generation history; same-tenant API; prerequisite and provider-disabled states; privacy disclosure; formula-safe export |
| Planning semantics | The dashboard prominently documents a 48-hour-or-greater lag and is never labelled real-time |
| Focused verification | Engine plus vertical 15 passed; targeted ESLint and diff validation passed; full TypeScript passed before unrelated concurrent Azure work introduced a temporary type error |
| Remaining gates | Deploy credential-broker adapter/durable handler; validate eligible support, Organizations access, provider pagination/retention/initial load; complete signed-in, negative-tenant, provider and live smoke acceptance |
| Release evidence | Source slice only; no image published or deployed |
| Next gate | Build Azure CID and GCP CID, then finish each partial pipeline’s production activation and acceptance gates |

### 2026-08-01 — Data Collection Monitor DCF execution vertical

| Field | Evidence |
|---|---|
| Tracker row / gates | ADV-12 / local G1–G6 candidate slice; maturity remains `PARTIAL_PIPELINE` |
| Delivery | Tenant-pinned DCF Step Functions capture and bounded instrumentation contract; immutable complete-only history; same-tenant API; module/job state, errors, retries, latency, coverage and execution history; links generated only from validated same-account/partition/Region execution ARNs |
| Security | No arbitrary console URL or raw provider payload is accepted or stored; incomplete captures cannot advance the head |
| Focused verification | Vertical and contract 4 passed; full TypeScript, targeted ESLint and diff validation passed before shared integration |
| Remaining gates | Register production scheduler, Step Functions adapter and job handler; validate real DCF pagination, retries, errors, cadence and two-tenant isolation; complete signed-in/provider/live acceptance |
| Release evidence | Source slice only; no image published or deployed |
| Next gate | Finish Azure/GCP verticals and continue production activation closure for each partial pipeline |

### 2026-08-01 — Azure Cloud Intelligence provider vertical

| Field | Evidence |
|---|---|
| Tracker row / gates | ADD-02 / local G0–G6 candidate slice |
| Maturity transition | ADD-02 `ABSENT` → `PARTIAL_PIPELINE`; aggregate is 6 candidates, 22 partial pipelines, 0 engine-only, and 1 absent |
| Provider boundary | Dedicated Azure sources, identity/export/blob operations and server-side authenticated source discovery; no AWS connection or trust-role substitution; no client org/customer scope |
| Delivery | Strict Standard Actual Cost/FOCUS capture; signed exact micros; currency/unit separation; immutable complete/empty accepted heads; native six-month, 30-day, service, subscription, Region, resource-group, pricing, commitment, charge, tag and resource views; formula-safe CSV |
| Focused verification | Native Node 5 passed; full TypeScript, targeted ESLint and diff validation passed |
| Remaining gates | Configure Azure credential/workload identity, recurring Cost Management export and Blob delivery; deploy adapter; reconcile controlled Azure export; complete two-tenant/signed-in/provider/live acceptance |
| Release evidence | Source slice only; no image published or deployed |
| Next gate | Complete GCP CID, then close every remaining production activation and acceptance gap |

### 2026-08-01 — GCP Cloud Intelligence provider vertical

| Field | Evidence |
|---|---|
| Tracker row / gates | ADD-03 / local G0–G6 candidate slice |
| Maturity transition | ADD-03 `ABSENT` → `PARTIAL_PIPELINE`; aggregate is 6 candidates, 23 partial pipelines, 0 engine-only, and 0 absent |
| Provider boundary | Dedicated GCP billing connections, workload-identity/BigQuery contract, authenticated same-tenant source discovery/selection; no AWS trust-role registry and no service-account key ingestion |
| Delivery | Exact signed nanos; provider billed cost and credits kept separate from calculated pricing variance and Recommender opportunity; immutable complete heads; Summary, Compute Engine, Cloud SQL, BigQuery, Network, Kubernetes, credit, resource, opportunity and evidence views; formula-safe CSV |
| Focused verification | Engine/vertical 5 passed including live D1 trigger checks; full TypeScript, targeted ESLint, diff validation and explicit AWS-registry isolation check passed |
| Remaining gates | Configure controlled GCP detailed usage/pricing exports and WIF binding; deploy BigQuery adapter; reconcile provider results; complete scale, two-tenant, signed-in, provider and live acceptance |
| Release evidence | Source slice only; no image published or deployed |
| Next gate | Close production activation gaps dashboard by dashboard, then run exact-tree/provider/release/deployment acceptance |

### 2026-08-01 — AWS Config collector/job activation contract

| Field | Evidence |
|---|---|
| Tracker row / gates | ADD-12 / production G2 contract advanced; maturity remains `PARTIAL_PIPELINE` |
| Delivery | Server-owned daily job payload; tenant-pinned aggregator/account/Region scope; exact aggregator, Organizations, rule-lifecycle, recorder and optional exact-prefix S3 operations; fixed inventory query; active reconciled CUR2 binding; bounded timeout; normalized persistence handoff |
| Security | Mutation operations, raw provider messages, credential material, client tenancy and arbitrary S3 prefixes are excluded; trusted-scope and returned-scope substitution fail closed |
| Focused verification | New job tests cover pinned operations/privacy/sources and adversarial payload/scope substitution; existing vertical tests continue to prove API/UI honesty |
| Remaining gates | Register credential-owning AWS adapter and durable handler, schedule it, validate real organization aggregator coverage, and complete two-tenant/provider/live acceptance |
| Release evidence | Source contract only; no image published or deployed |
| Next gate | Wire the adapter/handler in the controlled provider environment after exact-tree local verification |

### 2026-08-01 — Pricing Change materialization contract

| Field | Evidence |
|---|---|
| Tracker row / gates | ADD-13 / local server-owned materialization advanced; maturity remains `PARTIAL_PIPELINE` |
| Delivery | Identity-only job; server policy and active reconciled `fbg_` CUR2 binding; exact historical ListPriceLists/GetPriceListFileUrl bulk-file contract; rational repricing; deterministic evidence archive/sealing; immutable replay-safe persistence |
| Security | Client policy/scope, placeholder generation IDs, credential fields, malformed catalog/CUR2 evidence, incomplete reconciliation and persisted lineage mismatch fail closed |
| Focused verification | 20 engine/materializer/migration/API/render tests; full typecheck, touched lint and diff checks pass in the integrated tree |
| Remaining gates | Register policy/full-CUR2 readers, historical Price List adapter and durable handler; provider-verify applicability/tiering; then exact-tree/two-tenant/live acceptance |
| Release evidence | Source slice only; no image published or deployed |
| Next gate | Integrate the next completed runtime binding before the all-dashboard release gate |

### 2026-08-01 — AWS Support Cases signed runtime contract

| Field | Evidence |
|---|---|
| Tracker row / gates | ADV-09 / local signed transport and scheduler/handler binding advanced; maturity remains `PARTIAL_PIPELINE` |
| Delivery | Daily server-resolved scheduling; deterministic collection identity; exact DescribeCases authorization-outcome entitlement probe; Ed25519-signed bounded broker request/response; immutable normalized snapshot handoff |
| Security | Browser scope, raw correspondence/contact/attachments/provider messages/tokens, unsigned or oversized responses, origin/path substitution and cross-tenant evidence fail closed |
| Focused verification | Runtime/broker tests plus existing engine, persistence, API and native UI suites; full typecheck, touched lint and diff checks pass in the integrated tree |
| Remaining gates | Register the shared handler and credential-owning AWS adapter, validate qualifying/non-qualifying plans and pagination in controlled accounts, then exact-tree/two-tenant/live acceptance |
| Release evidence | Source contract only; no image published or deployed |
| Next gate | Continue remaining dashboard production bindings before the release image gate |

### 2026-08-01 — CORA execution-specific export activation

| Field | Evidence |
|---|---|
| Tracker row / gates | ADD-01 / local Cost Optimization Hub export G2–G3 advanced; maturity remains `PARTIAL_PIPELINE` |
| Delivery | Server-pinned organization/export scope; execution-specific manifest and object reconciliation; direct recommendation API exclusion; complete-only immutable SQLite/PostgreSQL heads; replay-safe orchestration; newest bounded lifecycle history; existing CORA API/UI projection |
| Security | Mutable latest manifests, client scope, direct API rows, malformed accepted recommendations, partial coverage, duplicate rows and mixed estimate/observed-cost attribution fail closed |
| Focused verification | 9 activation/migration/runtime/UI tests; full typecheck, touched lint and diff checks pass in the integrated tree |
| Remaining gates | Deploy the credential-owning S3/Parquet adapter and durable handler, reconcile a controlled export, then exact-tree, two-tenant and live acceptance |
| Release evidence | Source slice only; no image published or deployed |
| Next gate | Continue closing remaining production bindings without publishing an incomplete image |

### 2026-08-01 — Provider-neutral FOCUS analysis

| Field | Evidence |
|---|---|
| Tracker row / gates | ADD-04 / local G1, G4 and G5 advanced; maturity remains `PARTIAL_PIPELINE` |
| Delivery | FOCUS 1.0/1.0r2/1.1/1.2 provider-neutral contract; exact signed micros; immutable source provenance; same-customer Azure/GCP discovery; governed/provider/ungoverned tag taxonomy; denominator-safe effective discount rate; native selector and evidence visuals |
| Security | Client tenant scope, cross-customer sources, duplicate/unbound rows, mixed-currency aggregation, schema substitution and unsupported discount denominators fail closed |
| Focused verification | 19 native engine/neutral/route/render tests; full typecheck, touched lint and diff checks pass in the integrated tree |
| Remaining gates | Deploy Azure/GCP FOCUS export adapters, reconcile controlled provider totals, then exact-tree, two-tenant and live acceptance |
| Release evidence | Source slice only; no image published or deployed |
| Next gate | Continue dashboard-by-dashboard production binding without weakening source honesty |

### 2026-08-01 — Trusted Advisor signed organization orchestration

| Field | Evidence |
|---|---|
| Tracker row / gates | ADV-01 / app-side G2 orchestration advanced; maturity remains `PARTIAL_PIPELINE` |
| Delivery | Fresh fully-paged KMS-signed Organizations taxonomy validation; frozen same-tenant account manifest; active trust-role mapping; manifest-bound account/finalizer queueing; exact standard-check evidence consumption; terminal-only finalization and replay safety |
| Security | Browser account lists, stale/unsigned/cross-tenant captures, duplicate account bindings, Priority substitution, unverified evidence bytes, raw provider errors and non-commercial partitions fail closed |
| Focused verification | 9 orchestration tests plus the existing repository and native API/UI suites; root typecheck, touched lint and diff checks pass in the integrated tree |
| Remaining gates | Register the credential-owning signed Organizations adapter and durable handlers, then run eligible-Support-plan, two-tenant, provider, exact-tree and live acceptance |
| Release evidence | Source contract only; no image published or deployed |
| Next gate | Continue closing the next partial vertical while provider dependencies remain explicit |

### 2026-08-01 — TAO, Trends, Data Transfer, and optimizer persistence checkpoint

| Field | Evidence |
|---|---|
| Tracker rows / gates | ADV-01 G4–G6 partial pipeline; ADV-02 G3 discovery foundation; ADD-09 G0/G4–G6 audit; ADD-10 G0–G6 candidate plus committed manifest-object evidence |
| Maturity transition | ADV-01 `ENGINE_ONLY` → `PARTIAL_PIPELINE`; aggregate is now 6 candidates, 3 partial pipelines, 18 engine-only, and 2 absent |
| Commit | `17da4c5989b4ec61384d9dce032c77dac00b5d88` pushed to `origin/agent/mac-mini-finops-continuation` and draft PR 26 |
| Trusted Advisor Organizational | Authenticated bounded same-tenant standard-check API and native organization/account/check/resource/history visual; activation stays configuration-required until server-owned Organizations taxonomy and worker binding exist |
| Compute Optimizer | Immutable tenant-scoped discovery history, replay/checksum/DB guards, hashed export destinations, complete-head refusal until export-object binding; 8 focused tests passed |
| Trends | 36-month API, monthly/quarterly/yearly comparisons, interactive movement contributors, exact signals, safe CSV, lineage and actual SSR test; 35 focused tests passed |
| Data Transfer | Pinned Global Accelerator/internet/inter-Region/inter-AZ/CloudFront taxonomy, five filters, exact cost/bytes, Region/AZ/resource drilldown, safe CSV and rendered UI; active object counts promote only after full manifest exhaustion |
| Persistence tests | Billing/active-query 8 passed; S3/durable ingestion 14 passed; migration/route/UI 8 passed; FOCUS/source-health affected fixtures 12 passed |
| Integration gates | Root and collector typechecks, full lint, production build, secret scan of 1,798 files, and `git diff --check` passed |
| Controlled-live evidence | None. TAO lacks accepted Organizations taxonomy; Compute Optimizer lacks export-object ingestion; provider/two-tenant acceptance remains open |
| Release evidence | PR checks started for exact head; no image was published or deployed and the current live digest remains unchanged |
| Next gate | Complete the next engine-only verticals (CORA, Config Resource Compliance, Pricing Change), then exact-tree/provider/release gates |

### 2026-08-02 — Compute Optimizer sealed export-launch checkpoint

| Field | Evidence |
|---|---|
| Tracker row / maturity | ADV-02 remains `PARTIAL_PIPELINE`; this checkpoint makes no tracker maturity transition and does not claim a verified or live dashboard |
| Delivery | Immutable content-addressed daily regional attempt for all eight Compute Optimizer export families; exact typed SDK command dispatch; sequential fail-stop execution; hard command/overall deadlines; immutable complete/partial execution evidence; exact completed-Describe proof required before regional plan adaptation |
| IAM / destination | `standard-2026-08.4` is byte-for-byte unchanged. New candidate `standard-2026-08.5` opens only the explicit deny ceiling needed by the eight exports and documented dependencies, while the separately versioned `compute-optimizer-export-launch-v1` add-on owns a retained private versioned SSE-S3 bucket, exact three-statement service policy, exact 25-action launch/dependency Allow set, and prefix-scoped object reads |
| Exact source files | `docs/finops-compute-optimizer-export-launch-v1.md`; `infrastructure/customer-onboarding-role-standard-2026-08.5.yaml`; `infrastructure/finops-compute-optimizer-export-launch-v1.yaml`; `lib/finops-compute-optimizer-export-launch.ts`; `services/aws-collector/src/compute-optimizer-export-launcher.ts`; `services/aws-collector/test/compute-optimizer-export-launcher.test.ts`; `tests/finops-compute-optimizer-export-launch-infrastructure.test.mjs`; `tests/finops-compute-optimizer-export-launch.test.ts` |
| Focused verification | 29 passed: 10 attempt/execution/plan tests via Node 22.23.2 `--experimental-transform-types`; 12 immutable `.8.4`/`.8.5`/add-on infrastructure tests; 7 built collector launcher tests. `pnpm typecheck`, `pnpm typecheck:collector`, touched-file ESLint, cfn-lint 1.46.0 for both new templates, `pnpm security:secrets` (2,206 source files), and `git diff --check` passed |
| Evidence boundaries | No signed launch route, durable attempt/execution persistence, accepted generation/head transition, exact object materialization, controlled provider run, live acceptance, image publication, or deployment is included; production remains unchanged |
| Next gate | Complete exact-ID `DescribeRecommendationExportJobs`, then wire the authenticated signed collector route and narrowly attested `.8.5` broker/session contract before persistence and materialization |

### 2026-08-02 — Compute Optimizer exact Describe and `.8.5` broker checkpoint

| Field | Evidence |
|---|---|
| Tracker row / maturity | ADV-02 remains `PARTIAL_PIPELINE`; this checkpoint makes no tracker maturity transition and does not claim a verified or live dashboard |
| Delivery | Authenticated signed exact-ID `DescribeRecommendationExportJobs` transport; immutable app-side fresh-evidence reader; `.8.5` encrypted registry and hosted-state launch-contract preservation; narrowly admitted `.8.5` exact current/version object reads |
| Security | Exact tenant/connection/account/partition/Region/contract/job/destination binding; `.8.4` exact Describe denied; `.8.5` role re-attested before a distinct caller-identity-plus-Describe-only session; bounded pagination and deadlines; replayed tokens, missing/duplicate/extra jobs, sibling-object substitution, unsafe keys, stale chronology, provider-field substitution, credentials and raw provider messages fail closed |
| Focused verification | Full collector corpus 285 passed with Node 22 `--experimental-transform-types`; 7 app reader/signed-transport tests passed; root and collector typechecks, touched-file ESLint, repository secret scan (2,214 source files), and `git diff --check` passed |
| Evidence boundaries | No public launch mutation route is included. Durable idempotent launch attempt/execution persistence, accepted generation/head transition, exact object materialization, controlled provider run, two-tenant/live acceptance, image publication and deployment remain pending; production is unchanged |
| P0 / next gate | Build and prove a durable collector-side launch execution ledger before exposing any launch mutation route; then bind exact persistence/materialization and complete provider/live release gates |

### 2026-08-02 — Compute Optimizer exact-generation persistence checkpoint

| Field | Evidence |
|---|---|
| Tracker row / maturity | ADV-02 remains `PARTIAL_PIPELINE`; this checkpoint makes no tracker maturity transition and does not claim a verified or live dashboard |
| Delivery | Immutable tenant/customer/connection-scoped attempt and accepted-generation artifacts; content-addressed 960 KiB chunks with chained hashes; commit-last manifests; monotonic accepted-generation heads; D1 and PostgreSQL schema/runtime registration |
| Capacity boundary | The current non-streaming writers fail closed above 8 MiB on D1/Workers and 32 MiB on hosted PostgreSQL. Larger verified generations require a future streaming writer and are not claimed as supported |
| Integrity | Exact plan-set/account/partition scope, finalized complete plan-set membership, canonical payload hashes, chunk order and chain, whole-evidence hash, immutable artifacts/chunks/manifests and strictly newer accepted heads are enforced on write and recomputed on read |
| Focused verification | 9/9 exact persistence/schema checks passed: 7 D1 repository behaviors and 2 isolated PostgreSQL schema/forgery checks. The isolated PostgreSQL harness applied all 109 migrations successfully; root typecheck, touched-file ESLint, repository secret scan (2,214 source files), and `git diff --check` passed |
| Evidence boundaries | Durable collector launch execution ledger, launch orchestration, exact object materialization into accepted generations, repository-to-API/UI wiring, controlled provider run, two-tenant/live acceptance, image publication and deployment remain pending; production is unchanged |
| Next gate | Implement the durable idempotent launch ledger and orchestration, then bind exact materialization and native API/UI evidence before provider/live release gates |

### 2026-08-02 — Compute Optimizer exact API and native visual checkpoint

| Field | Evidence |
|---|---|
| Tracker row / maturity | ADV-02 remains `PARTIAL_PIPELINE`; no production/provider/live acceptance or release-image claim |
| Delivery | Accepted-head reference rehydrates the immutable plan set, authenticates sealed regional plans, reads the exact referenced generation, canonically re-verifies it, and projects a same-tenant bounded v2 response. The native UI renders every one of the 14 publicly documented visual purposes from exact organization-export evidence |
| Evidence integrity | Signed 64-bit source micros remain strings; aggregate BigInts use bounded canonical integers; currencies and alternative discount channels never merge; object/job/hash/version lineage is preserved; partial generations and discovery/direct recommendation results never substitute for an accepted export generation |
| API/browser boundary | Query validation happens before authentication/evidence reads; authorization scope is derived from the session-owned active connection; missing keys and corrupt evidence fail closed with sanitized responses; the browser parser validates exact variants, definition identity, IDs/hashes, coverage, paging, freshness, evidence, rows, visual bounds and serialized size before rendering |
| Focused verification | Exact dashboard/plan reader/executable route/SSR UI 17/17; persistence 9/9; whole-tree TypeScript, touched ESLint, production build and diff checks pass |
| Retired path | The unconsumed float-based export history/repository/job slice and its legacy vertical test are removed; release migrations remain compatible |
| Remaining gates | Build and prove the server-owned launch/finalization producer, activate release evidence keys/IAM, reconcile controlled all-Region exports in two tenants, and complete signed-in/provider/rollback/live acceptance before any image deployment |
| GitHub | Intended for the existing `agent/mac-mini-finops-continuation` branch and draft PR 26 as an independently reviewed checkpoint |

### 2026-08-02 — Compute Optimizer production materialization worker checkpoint

| Field | Evidence |
|---|---|
| Tracker row / maturity | ADV-02 remains `PARTIAL_PIPELINE`; the worker is registered but the upstream server-owned launch/finalization producer remains open |
| Delivery | Strict durable job payload, active `.8.5` capability gate, authenticated sealed plan-set rehydration, exact discovery-evidence binding, signed Describe/object readers, exact coordinator execution, immutable persistence, durable outcome telemetry and shared background-handler registration |
| Queue privacy | Background jobs and audit telemetry retain tenant-bound IDs, schedule, hashes and opaque contract IDs only; bucket, prefix, object keys, sealed envelopes, credentials and provider messages are excluded |
| Completion semantics | Only a newly accepted generation or a repository-proven already-accepted replay completes the job; fresh-blocked and partial checkpoints are telemetered then thrown for durable retry/dead-letter handling |
| Runtime bounds | One materialization job per drain, four concurrent object reads, 330-second worker ceiling, abort propagation, exact tenant/account/partition/Region/plan-set checks and deterministic idempotency |
| Focused verification | Runtime/coordinator/readers/object/generation/plan-reader 103/103; handler registry 1/1; persistence 9/9; prior handler regression 4/4; whole-tree TypeScript, focused ESLint and diff checks pass |
| Explicit open gate | No non-test producer yet creates/finalizes activation and plan-set lineage or enqueues this worker. The app registry does not own the collector-private regional launch/source contract IDs, so fabricating them or accepting browser-supplied contracts is forbidden |
| Release evidence | Partial runtime checkpoint only; API collection remains unavailable and no image publication or deployment is authorized |

### 2026-08-02 — Compute Optimizer signed activation transport checkpoint

| Field | Evidence |
|---|---|
| Tracker row / maturity | ADV-02 remains `PARTIAL_PIPELINE`; no production/provider/live acceptance or release-image claim |
| Commit | `f59aa6584251e704f13ad7b274c7461875570c08` pushed to `origin/agent/mac-mini-finops-continuation`; local, remote, and draft PR 26 heads matched exactly |
| Delivery | Active `.8.5` encrypted-registry manifest reader; signed tenant/customer/connection-bound collector route; app-side signed request/response transport with an absolute deadline and streaming 64 KiB response ceiling |
| Broker security | The default production adapter performs only `sts:GetCallerIdentity`, verifies exact account/partition/assumed-role identity, and never returns or retains AWS credentials; cross-tenant, inactive, implicit-Region, partial-matrix and identity-drift requests fail closed |
| Focused verification | 16 collector broker/manifest/route tests and 3 app transport tests passed; root and collector typechecks, repository secret scan of 2,244 source files, and `git diff --check` passed |
| Remaining gate | Complete the durable capability/outbox scheduler and crash-safe sealed-reference handoff before registering the full producer; controlled all-Region/two-tenant/provider/live acceptance remains open |
| Release evidence | Source checkpoint only; no image was published or deployed and the production digest remains unchanged |

### 2026-08-02 — AWS News Feeds local vertical closure

| Field | Evidence |
|---|---|
| Tracker row / maturity | ADV-07 `PARTIAL_PIPELINE` → `LOCAL_VERTICAL_CANDIDATE`; aggregate is 7 candidates and 22 partial pipelines, including 20 in-scope AWS partials and 2 excluded provider partials |
| Commit | `ddc448ba56af27d0ae92be8c950259f667cdbec1` pushed to `origin/agent/mac-mini-finops-continuation`; local, remote, and draft PR 26 heads matched exactly |
| Delivery | Five pinned AWS sources; controlled-egress RSS/Atom gateway; deterministic six-hour scheduling; durable tenant-bound replay/failure receipts; immutable READY-only accepted head; real shared worker/drain wiring; same-tenant API and native 6-sheet/21-visual/12-control UI |
| Security and integrity | Caller URLs, redirects, credentials, active content, DTD/entities/XInclude, MIME confusion, oversized bodies/items, tenant substitution, corrupt receipts, partial-head promotion and raw provider failures fail closed |
| Focused verification | 39/39 engine/gateway/repository/runtime/API/UI tests, 5/5 shared handler tests, 2/2 transport-boundary tests, migration parity, root typecheck, scoped ESLint, PostgreSQL migration/runtime suite and repository secret scan passed |
| Remaining gates | Controlled provider reconciliation, signed-in exact-layout/accessibility acceptance, fixed-tree full verification and live deployment proof |
| Release evidence | Complete local vertical only; no image was published or deployed and production remains unchanged |

### 2026-08-02 — Compute Optimizer local vertical closure

| Field | Evidence |
|---|---|
| Tracker row / maturity | ADV-02 `PARTIAL_PIPELINE` → `LOCAL_VERTICAL_CANDIDATE`; aggregate is 8 candidates and 21 partial pipelines, including 19 in-scope AWS partials and 2 excluded provider partials |
| Commit | `f96b73a` pushed to `origin/agent/mac-mini-finops-continuation`; the scoped commit excludes concurrent AWS Budgets and Extended Support work |
| Delivery | Strict launch, discovery, reconcile and materialization ordering; immutable activation/capability state; leased CAS outbox; crash-safe sealed-plan handoff; exact `.8.5` signed capability transport; all shared scheduler handlers; same-tenant API; durable unavailable/collecting/failed/ready UI |
| Security and integrity | Identity-only broker requests, exact tenant/account/partition binding, absolute deadlines and abort propagation, signed canonical bodies, replay/tamper rejection, deterministic UTC scheduling, immutable generations, exact currency/channel separation and failure-closed materialization |
| Focused verification | 31 activation/capability/production/UI tests, 10 exact-route/transport tests and 5 repository tests passed independently; root and collector typechecks, scoped lint, migration parity, diff checks and repository secret scan passed |
| Remaining gates | Activate the `.8.5` AWS stack and evidence keys, reconcile controlled all-Region exports in two tenants, complete authorized exact-layout/accessibility and fixed-tree release gates, then publish and deploy the reviewed image |
| Release evidence | Complete local vertical only; no image was published or deployed and production remains unchanged |

### 2026-08-02 — AWS Budgets local vertical closure

| Field | Evidence |
|---|---|
| Tracker row / maturity | ADV-08 `PARTIAL_PIPELINE` → `LOCAL_VERTICAL_CANDIDATE`; aggregate is 9 candidates and 20 partial pipelines, including 18 in-scope AWS partials and 2 excluded provider partials |
| Commit | `e2551db` pushed to `origin/agent/mac-mini-finops-continuation` as an isolated ADV-08 vertical commit |
| Delivery | Exact AWS Budgets and Organizations SDK collection, bounded pagination/deadlines/records, read-only STS session ceiling, signed tenant-bound collector route, immutable production composition, six-hour scheduler, shared durable handler, registered API truth and all 11 native visual purposes |
| Security and integrity | Server-owned scope, tenant/account/connection/header substitution protection, immutable complete generations, currency separation, sanitized provider failures and no browser-controlled credentials or provider targets |
| Focused verification | 37/37 focused root and collector tests; root and collector typechecks, collector build, full production build, scoped lint, secret scan of 2,289 files and `git diff --check` passed |
| Remaining gates | Roll out the exact customer permission contract and deployed asymmetric broker configuration, execute registered migrations, reconcile controlled provider evidence, complete two-tenant/live and fixed-tree gates, then publish and deploy the reviewed image |
| Release evidence | Complete local vertical only; no image was published or deployed and production remains unchanged |

### 2026-08-02 — Extended Support local vertical closure

| Field | Evidence |
|---|---|
| Tracker row / maturity | ADV-04 `PARTIAL_PIPELINE` → `LOCAL_VERTICAL_CANDIDATE`; aggregate is 10 candidates and 19 partial pipelines, including 17 in-scope AWS partials and 2 excluded provider partials |
| Commit | `963a54e` pushed to `origin/agent/mac-mini-finops-continuation` as an isolated ADV-04 vertical commit |
| Delivery | Deterministic daily scheduling, durable replay/failure receipts, immutable READY-only history, Ed25519 signed broker, exact STS intersection, credential-owning route, pinned multi-service AWS SDK reader, same-tenant API, and native 5-sheet/60-visual/17-control states |
| Permission integrity | Immutable `standard-2026-08.6` preserves `.8.5` and adds exactly ADV-04's 14 read actions; 25 predecessor compatibility tests prove Compute Optimizer remains authorized after upgrade |
| Focused verification | 33/33 ADV-04 tests plus 25/25 predecessor tests passed; root and collector typechecks, targeted lint, collector and root production builds, diff check and repository secret scan of 2,309 files passed |
| Remaining gates | Deploy and independently attest `.8.6`, configure authoritative CUR2/lifecycle/rate supplements, reconcile controlled bills and provider evidence, complete two-tenant/live and fixed-tree gates, then publish and deploy the reviewed image |
| Release evidence | Complete local vertical only; no image was published or deployed and production remains unchanged |

### 2026-08-02 — Support Cases Radar local vertical closure

| Field | Evidence |
|---|---|
| Tracker row / maturity | ADV-09 `PARTIAL_PIPELINE` → `LOCAL_VERTICAL_CANDIDATE`; aggregate is 11 candidates and 18 partial pipelines, including 16 in-scope AWS partials and 2 excluded provider partials |
| Commit | `6d5699b` pushed to `origin/agent/mac-mini-finops-continuation` as an isolated ADV-09 vertical commit |
| Delivery | Credential-owning AWS Support client, strict signed local/hosted route, HMAC-minimized evidence, immutable snapshots, entitlement state, deterministic one-job-per-cohort scheduler, durable handler, same-tenant API, native case/account/age/cadence/topic UI, and production evidence-key deployment wiring |
| Permission and scale integrity | Immutable `standard-2026-08.7` preserves `.8.6` and adds exactly two read actions; one organization fan-out is scheduled per tenant/customer/partition cohort, preventing the prior O(N²) account multiplication |
| Focused verification | 34/34 ADV-09 tests, root and collector typechecks, targeted lint, secret scan of 2,328 files, diff check, `.8.7` and production-HA CFN lint, 10/10 HA infrastructure tests and 3/3 runtime-secret tests passed |
| Remaining gates | Deploy and attest `.8.7`, provision its unique evidence key, reconcile controlled provider evidence, complete authorized template/two-tenant/live and fixed-tree gates, then publish and deploy the reviewed image |
| Release evidence | Complete local vertical only; no image was published or deployed and production remains unchanged |

### 2026-08-02 — AWS Health Events local vertical closure

| Field | Evidence |
|---|---|
| Tracker row / maturity | ADV-06 `PARTIAL_PIPELINE` → `LOCAL_VERTICAL_CANDIDATE`; aggregate is 12 candidates and 17 partial pipelines, including 15 in-scope AWS partials and 2 excluded provider partials |
| Commit | `6dab352` pushed to `origin/agent/mac-mini-finops-continuation` as an isolated ADV-06 vertical commit |
| Delivery | Exact Health/Organizations SDK reader, entitlement and delegated-admin checks, full pagination, conservative initial-load proof, signed bounded route, durable leases/replay/failures, daily handler/tick, immutable history, same-tenant API and four-state 3-sheet UI |
| Permission integrity | Immutable `standard-2026-08.8` preserves `.8.7` and adds exactly seven Health/prerequisite role reads with an eight-action STS ceiling; Extended Support and Support Cases compatibility remains green |
| Focused verification | 45/45 root Health tests, 10/10 collector Health tests, 30/30 broker/registry tests, 18/18 shared/runtime compatibility and 9/9 predecessor-template tests passed; root and collector typechecks, lint, CFN lint, secret scan of 2,350 files and diff check passed |
| Remaining gates | Deploy and attest `.8.8`, capture controlled entitled Organization evidence including management/delegated-admin pagination and retention windows, apply PostgreSQL 0115, complete two-tenant/live and fixed-tree gates, then publish and deploy the reviewed image |
| Release evidence | Complete local vertical only; no image was published or deployed and production remains unchanged |

### 2026-08-02 — ResilienceVue local vertical closure

| Field | Evidence |
|---|---|
| Tracker row / maturity | ADV-10 `PARTIAL_PIPELINE` → `LOCAL_VERTICAL_CANDIDATE`; aggregate is 13 candidates and 16 partial pipelines, including 14 in-scope AWS partials and 2 excluded provider partials |
| Commit | `d1e91bf` pushed to `origin/agent/mac-mini-finops-continuation` as an isolated ADV-10 vertical commit |
| Delivery | Pinned Resilience Hub SDK/default client, exact 14-operation bounded collection, strict signed route, durable tenant/account/Region lease/replay/status, migrations, daily handler/tick, same-tenant API and native four-state 4-sheet/47-visual/9-control UI |
| Permission integrity | Immutable `standard-2026-08.9` preserves `.8.8` and adds the dedicated exact Resilience Hub read policy; Health, Support Cases and Extended Support successor compatibility remains enabled |
| Focused verification | 12/12 ADV-10 integration tests, 4/4 permission/inheritance tests and 5/5 collector tests passed; root/collector typechecks, collector and production builds, lint, diff, secret scan of 2,370 files and `.8.9` CFN lint passed |
| Remaining gates | Deploy and attest `.8.9`, validate controlled live Resilience Hub applications and all 14 reads, apply PostgreSQL 0116, complete two-tenant/live and fixed-tree gates, then publish and deploy the reviewed image |
| Release evidence | Complete local vertical only; no image was published or deployed and production remains unchanged |
