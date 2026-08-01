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
| Partial pipelines | 2 of 29 |
| Engine-only capabilities | 19 of 29 |
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
