# ADD-01 — CORA Dashboard evidence

Status: **PARTIAL_RUNTIME**. This vertical has a fail-closed export-object materialization boundary, immutable persistence, tenant-scoped read API, resource-deduplicated dashboard projection, and explicit coverage for the five official CORA sheets. It does **not** prove a live Cost Optimization Hub export collection, exact QuickSight visual-tree parity, or production acceptance.

## Primary-source audit

Audited 2026-08-01:

- AWS CID CORA: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/cora-dashboard.html>
- Cost Optimization Hub overview: <https://docs.aws.amazon.com/cost-management/latest/userguide/cost-optimization-hub.html>
- Recommended actions and savings fields: <https://docs.aws.amazon.com/cost-management/latest/userguide/coh-view-recommendations.html>
- Filtering and prioritization: <https://docs.aws.amazon.com/cost-management/latest/userguide/coh-prioritize-opportunities.html>
- Savings-opportunity deduplication: <https://docs.aws.amazon.com/cost-management/latest/userguide/coh-savings-opportunities.html>
- Official CID framework CORA definition at audited commit `f9e36d88c47709f10e8fa784ad11d5cc0e728021`: <https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework/blob/f9e36d88c47709f10e8fa784ad11d5cc0e728021/dashboards/cora/cora-definition.yaml>

The official definition has five sheets: **Summary**, **Usage Optimization**, **Rate Optimization - Saving Plans**, **Rate Optimization - Reserved Instances**, and **About**. The local coverage contract uses these areas verbatim while distinguishing implemented evidence from provider dimensions that are not normalized yet.

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
| G1 — official requirements and visual inventory | **LOCAL_COMPLETE** | Five sheets and official controls/visual families audited against the pinned definition; exact QuickSight asset-tree parity is not claimed. |
| G2 — provider source and materialization contract | **LOCAL_COMPLETE** | Execution-specific manifest/object reconciliation, hashes, versions/ETags, account/region coverage, rejected-row handling, and no direct API-row fallback are implemented and tested. |
| G3 — durable runtime execution | **PARTIAL** | Orchestration and identity-only job payload exist; a live credential-owning execution adapter, provider permission proof, signed execution archive/replay evidence, and accepted run remain blocking. |
| G4 — immutable persistence and tenant API | **LOCAL_COMPLETE** | Complete-only monotonic head, immutable history, registered SQLite/Postgres migrations, authenticated org/customer/connection scope, and bounded query parsing. |
| G5 — dashboard UI | **PARTIAL** | Summary, Usage, Savings Plans, RI, history, and About/evidence areas render with exact filters and deduplicated opportunity cards. SP/RI term/upfront/level/service matrices and exact official chart geometry remain pending. |
| G6 — validation and acceptance | **PARTIAL** | Focused domain/UI tests, ESLint, and TypeScript pass locally. Live AWS fixtures, browser visual/accessibility acceptance, and production smoke evidence remain pending. |

## Implemented artifacts

- `lib/finops-cora.ts`: existing bounded capture normalization and evidence semantics.
- `drizzle/0089_finops_cora_snapshots.sql` and `postgres/migrations/0084_finops_cora_snapshots.sql`: immutable normalized snapshots and complete-only monotonic head.
- `db/finops-cora-repository.ts`: accepts typed `CoraCapture`, invokes the boundary itself, hashes canonical normalized JSON, and never accepts raw provider payloads.
- `lib/finops-cora-dashboard.ts`: exact-micros, currency-separated filtered presentation projection.
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

- `node --experimental-strip-types --test tests/finops-cora-dashboard.test.ts`
- `node --test tests/finops-cora-dashboard-ui-contract.test.mjs`
- `pnpm exec eslint db/finops-cora-repository.ts lib/finops-cora-dashboard.ts app/api/v1/finops/cora/route.ts app/costs/finops-cora-dashboard.tsx tests/finops-cora-dashboard.test.ts tests/finops-cora-dashboard-ui-contract.test.mjs`
- `pnpm exec tsc --noEmit --pretty false`

## Remaining blockers

- Bind a credential-owning server collector to the existing CORA source contract and this repository, including manifest/object exhaustion and rejected-row evidence.
- Normalize Savings Plans level/term/upfront and Reserved Instance service/level/term/upfront dimensions before claiming exact option-matrix parity.
- Run the collector against an enabled organization-level Cost Optimization Hub Data Export and retain accepted provider evidence.
- Complete exact-tree/visual comparison, browser visual/accessibility acceptance, and production deployment gates.
