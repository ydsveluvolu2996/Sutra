# Sutra Mac Mini execution progress

Authoritative scope and maturity:
`docs/FINOPS_CID_IMPLEMENTATION_TRACKER.md`

Branch: `agent/mac-mini-finops-continuation`

Starting fixed-tree SHA: `a9e3d96a8804aa217af42b0e53eb16087194ba96`

## Current capability baseline

| Item | Current truth |
|---|---|
| Official catalog | 29: 3 Foundational, 13 Advanced, 13 Additional |
| Local vertical candidates | 6 of 29 |
| Partial pipelines | 6 of 29 |
| Engine-only capabilities | 15 of 29 |
| Absent capabilities | 2 of 29: Azure CID and GCP CID |
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
| 7 | Azure CID and GCP CID | Provider-specific connections, collectors, persistence, APIs, visuals, and controlled validation complete |
| 8 | Full exact-tree verification | Every local gate, PostgreSQL, Docker, rendered and accessibility audit passes |
| 9 | Controlled provider acceptance | AWS/Azure/GCP/specialized sources reconciled; two-tenant evidence attached |
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
