# ADD-01 — CORA Dashboard evidence

Status: **PARTIAL_RUNTIME**. This vertical has a fail-closed export-object materialization boundary, immutable persistence, tenant-scoped read API, resource-deduplicated dashboard projection, and an exact immutable inventory of all five official CORA sheets. It does **not** prove a live Cost Optimization Hub export collection, native QuickSight pixel/layout/runtime parity, or production acceptance.

## Primary-source audit

Audited 2026-08-01:

- AWS CID CORA: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/cora-dashboard.html>
- Cost Optimization Hub overview: <https://docs.aws.amazon.com/cost-management/latest/userguide/cost-optimization-hub.html>
- Recommended actions and savings fields: <https://docs.aws.amazon.com/cost-management/latest/userguide/coh-view-recommendations.html>
- Filtering and prioritization: <https://docs.aws.amazon.com/cost-management/latest/userguide/coh-prioritize-opportunities.html>
- Savings-opportunity deduplication: <https://docs.aws.amazon.com/cost-management/latest/userguide/coh-savings-opportunities.html>
- Official CID framework CORA definition at audited commit `f9e36d88c47709f10e8fa784ad11d5cc0e728021`: <https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework/blob/f9e36d88c47709f10e8fa784ad11d5cc0e728021/dashboards/cora/cora-definition.yaml>
- Official CORA manifest at the same commit: <https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework/blob/f9e36d88c47709f10e8fa784ad11d5cc0e728021/dashboards/cora/cora.yaml>
- Official CORA changelog at the same commit: <https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework/blob/f9e36d88c47709f10e8fa784ad11d5cc0e728021/changes/CHANGELOG-cora.md>

The exact public artifacts are frozen as follows:

| Artifact | SHA-256 |
|---|---|
| `dashboards/cora/cora-definition.yaml` | `6486f50810f40558423cffb90c245a658678597fccdda8445e26a40e02e6a644` |
| `dashboards/cora/cora.yaml` | `54bde11bcee2ed0d333c891371eea29a5c2bfc6871e8e63d273682ace01d16bd` |
| `changes/CHANGELOG-cora.md` | `c44fd6153a8f936a31664ff4207c465eef20abc9c325fe686d590d766313b57b` |
| Inline `views.cora_view.data` Athena SQL | `1e39c206cf5ae2b2ac9a5f87253935b77782c2ea46cdf3ac180f7db555c2b02e` |

The manifest identifies CORA **v0.0.11**, category **Additional**, theme
**MIDNIGHT**, and dataset `cora_view`. The definition proves exact totals of
**5 sheets, 28 visuals, 11 parameter controls, 41 filter-control placements,
8 parameter declarations, 48 calculated fields, 50 filter groups, 16 column
configurations, and 1 dataset declaration**.

| Official sheet | Visual inventory | Parameter / filter controls | Native mapping |
|---|---|---|---|
| Summary | 13: 1 KPI, 1 scatter, 4 tables, 1 Sankey, 3 bars, 2 pivots, 1 pie | 8 / 12 | `NATIVE_EVIDENCE_PARTIAL`: exact-money summaries, resource deduplication, action details, filters, export and history exist; scatter/Sankey/pivot/pie/GroupBy geometry is not reproduced one-for-one. |
| Usage Optimization | 6: 1 pie, 2 pivots, 3 bars | 1 / 8 | `NATIVE_EVIDENCE_PARTIAL`: usage actions and drilldown exist; the six official visual layouts and arbitrary GroupBy tree are partial. |
| Rate Optimization - Saving Plans | 2 pivots | 1 / 10 | `PROVIDER_DIMENSIONS_BLOCKED`: SP evidence exists; level, term, upfront and type matrices are not normalized. |
| Rate Optimization - Reserved Instances | 7: 2 pivots, 1 table, 4 bars | 1 / 11 | `PROVIDER_DIMENSIONS_BLOCKED`: RI evidence and Region exist; service, level, term and upfront matrices remain unnormalized. |
| About | 0 | 0 / 0 | `ABOUT_EVIDENCE`: native freshness, coverage, lineage, hashes and limitations; the official sheet has no visual objects. |

The API and UI carry this inventory independently of live recommendation
materialization. Every successful API state, including
`configuration_required`, returns `sutra.cora-official-definition.v1`; the UI
shows every official visual title/type/ID, controls, immutable hashes, native
mapping and remaining gap.

| Official contract | Native coverage in this slice | Evidence status |
|---|---|---|
| Usage optimization: rightsizing, idle, migration/upgrade | Separate `RESOURCE_USAGE_OPTIMIZATION` rows, filters, summaries, and drilldown | Implemented over accepted evidence |
| Rate optimization: Savings Plans and Reserved Instances | Separate Savings Plans and RI areas and evidence rows | Partial: option matrices need normalized term/upfront/level/service fields |
| Multi-payer / organization coverage | Expected, enrolled, recommendation-account, rejected-row, and organization-coverage evidence | Implemented; never inferred |
| Daily updates and historical view | Immutable generation history and per-currency/per-class estimates | Implemented locally; no live daily collection proof |
| Workload owner / business-unit attribution | Account, workflow owner, and cost-allocation tag filters | Implemented when exported tags/owners exist |
| Recommendation prioritization | Account, class, action, region, effort, workflow, currency, and tag filters | Implemented |
| Resource-level action details | Current/recommended state, lookback, source, restart, rollback, tags, workflow | Implemented without raw provider JSON |
| Row-level security | Authenticated connection lookup plus `connection:read` customer capability | Implemented at the route boundary |
| Savings semantics | Exact bigint micros, currency isolation, explicit estimate/non-realized labels | Implemented |
| Resource-ID deduplication | Maximum recommendation per identified resource, independently within Usage and Rate/currency; account and region prevent identifier collisions | Implemented; missing resource IDs remain separate and disclosed |
| CORA rate/usage difference disclosure | Rate estimates are explicitly not adjusted for usage-optimization implementation | Implemented |
| FinopsException filtering | Explicit exclusion control plus exact tag-key evidence | Implemented |
| Live COH Data Export collector | Export-object materialization and orchestration contracts exist, but the credential-owning server execution adapter is not bound | **Blocking** |

## G1-G6 closure status

| Gate | Current status | Evidence / remaining work |
|---|---|---|
| G1 — official requirements and visual inventory | **LOCAL_COMPLETE** | Exact five-sheet, 28-visual, 52-control-placement and analysis-object inventory parsed from the pinned definition; all source artifacts and the inline Athena SQL are hash-pinned. Native pixel/layout/runtime parity is not claimed. |
| G2 — provider source and materialization contract | **LOCAL_COMPLETE** | Execution-specific manifest/object reconciliation, hashes, versions/ETags, account/region coverage, rejected-row handling, and no direct API-row fallback are implemented and tested. |
| G3 — durable runtime execution | **PARTIAL** | Orchestration and identity-only job payload exist; a live credential-owning execution adapter, provider permission proof, signed execution archive/replay evidence, and accepted run remain blocking. |
| G4 — immutable persistence and tenant API | **LOCAL_COMPLETE** | Complete-only monotonic head, immutable history, registered SQLite/Postgres migrations, authenticated org/customer/connection scope, and bounded query parsing. |
| G5 — dashboard UI | **PARTIAL** | Summary, Usage, Savings Plans, RI, history, and About/evidence areas render with exact filters and deduplicated opportunity cards. The native official-definition drawer exposes exact hashes, totals, per-sheet controls, all 28 visual IDs/types/titles and honest sheet mapping even in configuration-required state. SP/RI term/upfront/level/service matrices and exact official chart geometry remain pending. |
| G6 — validation and acceptance | **PARTIAL** | Focused domain/UI tests, ESLint, and TypeScript pass locally. Live AWS fixtures, browser visual/accessibility acceptance, and production smoke evidence remain pending. |

## Implemented artifacts

- `lib/finops-cora.ts`: existing bounded capture normalization and evidence semantics.
- `drizzle/0089_finops_cora_snapshots.sql` and `postgres/migrations/0084_finops_cora_snapshots.sql`: immutable normalized snapshots and complete-only monotonic head.
- `db/finops-cora-repository.ts`: accepts typed `CoraCapture`, invokes the boundary itself, hashes canonical normalized JSON, and never accepts raw provider payloads.
- `lib/finops-cora-dashboard.ts`: exact-micros, currency-separated filtered presentation projection.
- `lib/finops-cora-official-definition.ts`: immutable public-source hashes, exact structural inventory, every visual, per-sheet controls, native mapping, and preserved gaps.
- `app/api/v1/finops/cora/route.ts`: authenticated same-tenant read route with complete/partial/stale/empty/failed/configuration-required states.
- `app/costs/finops-cora-dashboard.tsx` and its dedicated CSS module: responsive summary, filters, safe CSV, action drilldown, history, and evidence drawer.

## Evidence-honesty invariants

1. Only a normalized snapshot whose domain state is `READY` can advance the active head.
2. Organization enrollment must be complete, rejected export rows must be zero, and recommendation evidence must be ready or proven empty before `READY` is durable.
3. Partial, stale, empty, failed, and configuration-required generations remain immutable history and cannot replace the complete head.
4. Money stays in signed integer micros and currencies are never combined.
5. Usage and rate optimization stay separate. Opportunity cards choose the greatest recommendation per identified resource within each class and currency; rows without resource IDs remain separate. Raw sums remain evidence only.
6. CUR2 observations remain evidence, never causal or realized-savings attribution.
7. Raw Cost Optimization Hub export objects, raw configuration detail JSON, bucket names, and object keys are not exposed by the dashboard route.

## Verification

- `node --experimental-strip-types --test tests/finops-cora.test.ts tests/finops-cora-dashboard.test.ts tests/finops-cora-export-activation.test.mjs tests/finops-cora-official-definition.test.ts tests/finops-cora-dashboard-ui-contract.test.mjs`
  — **34 passed, 0 failed, 0 skipped**.
- `pnpm exec eslint lib/finops-cora-official-definition.ts lib/finops-cora-dashboard.ts app/api/v1/finops/cora/route.ts app/costs/finops-cora-dashboard.tsx tests/finops-cora-official-definition.test.ts tests/finops-cora-dashboard-ui-contract.test.mjs tests/finops-cora-dashboard.test.ts`
  — **passed with no warnings**.
- Root `pnpm typecheck` — **passed**.
- Exact-file `git diff --check` — **passed**.

## Remaining blockers

- Bind a credential-owning server collector to the existing CORA source contract and this repository, including manifest/object exhaustion and rejected-row evidence.
- Normalize Savings Plans level/term/upfront and Reserved Instance service/level/term/upfront dimensions before claiming exact option-matrix parity.
- Run the collector against an enabled organization-level Cost Optimization Hub Data Export and retain accepted provider evidence.
- Complete release-SHA review, browser visual/accessibility acceptance, immutable image and production deployment gates; no pixel/layout parity claim is implied by the exact public-definition inventory.

## Merge record — 2026-08-06

Merged to `main` since this record was last updated (2026-08-05 15:01). Every
item below is source-only work that landed through review with CI green on the
merge commit — nothing more. No provider, live, two-tenant, or release evidence
is created by any of it.

**Maturity is unchanged (`PARTIAL_PIPELINE`) and no child-stage gate passed.** G7
fixed-tree, G8 controlled provider acceptance, G9 release and G10 deployment
remain unpassed for this row; no live acceptance, provider reconciliation, or
two-tenant acceptance is claimed.

- **Native chart kit and catalog identity — `4ac72bd` (PR #36) and `f107cdf`
  (PR #37).** This row's view moved onto the shared native chart kit at
  `app/components/charts`:
  - `app/costs/finops-cora-dashboard.tsx`

  Focused rendering proof added with it:
  - `tests/finops-cora-savings-trend.test.mjs`

  Across `app/costs/`, 28 view modules plus the catalog page now import the kit,
  and the kit's own rendering suite `tests/chart-kit-rendering.test.mjs` holds
  12 tests. `app/costs/finops-dashboard-identity.tsx` renders each dashboard's
  catalog glyph, name and ID above every opened view
  (`tests/finops-dashboard-identity.test.mjs`). This is UI rendering work only:
  no source contract, collector operation, migration, API shape, or evidence
  semantic changed, and no G5 or G6 stage status is promoted by it.
