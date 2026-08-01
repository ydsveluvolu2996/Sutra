# ADD-01 — CORA Dashboard evidence

Status: **PARTIAL_PIPELINE**. This change adds a fail-closed native persistence, read API, and responsive dashboard projection over the existing CORA domain boundary. It does **not** prove a live Cost Optimization Hub export collection, and therefore does not elevate CORA to a local vertical candidate or provider-accepted state.

## Primary-source audit

Audited 2026-08-01:

- AWS CID CORA: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/cora-dashboard.html>
- Cost Optimization Hub overview: <https://docs.aws.amazon.com/cost-management/latest/userguide/cost-optimization-hub.html>
- Recommended actions and savings fields: <https://docs.aws.amazon.com/cost-management/latest/userguide/coh-view-recommendations.html>
- Filtering and prioritization: <https://docs.aws.amazon.com/cost-management/latest/userguide/coh-prioritize-opportunities.html>
- Savings-opportunity deduplication: <https://docs.aws.amazon.com/cost-management/latest/userguide/coh-savings-opportunities.html>

| Official contract | Native coverage in this slice | Evidence status |
|---|---|---|
| Usage optimization: rightsizing, idle, migration/upgrade | Separate `RESOURCE_USAGE_OPTIMIZATION` rows, filters, summaries, and drilldown | Implemented over accepted evidence |
| Rate optimization: Savings Plans and Reserved Instances | Separate `RATE_COMMITMENT_OPTIMIZATION` rows and summaries | Implemented over accepted evidence |
| Multi-payer / organization coverage | Expected, enrolled, recommendation-account, rejected-row, and organization-coverage evidence | Implemented; never inferred |
| Daily updates and historical view | Immutable generation history and per-currency/per-class estimates | Implemented locally; no live daily collection proof |
| Workload owner / business-unit attribution | Account, workflow owner, and cost-allocation tag filters | Implemented when exported tags/owners exist |
| Recommendation prioritization | Account, class, action, region, effort, workflow, currency, and tag filters | Implemented |
| Resource-level action details | Current/recommended state, lookback, source, restart, rollback, tags, workflow | Implemented without raw provider JSON |
| Row-level security | Authenticated connection lookup plus `connection:read` customer capability | Implemented at the route boundary |
| Savings semantics | Exact bigint micros, currency isolation, explicit estimate/non-realized labels | Implemented |
| CORA rate/usage difference disclosure | Rate estimates are explicitly not adjusted for usage-optimization implementation | Implemented |
| Live COH Data Export collector | Source registry contract exists, but orchestration is not bound to this repository | **Blocking** |

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
5. Usage and rate optimization stay separate; their non-deduplicated row sums are never presented as portfolio savings.
6. CUR2 observations remain evidence, never causal or realized-savings attribution.
7. Raw Cost Optimization Hub export objects, raw configuration detail JSON, bucket names, and object keys are not exposed by the dashboard route.

## Verification

- `node --experimental-strip-types --test tests/finops-cora-dashboard.test.ts`
- `node --test tests/finops-cora-dashboard-ui-contract.test.mjs`
- `pnpm exec eslint db/finops-cora-repository.ts lib/finops-cora-dashboard.ts app/api/v1/finops/cora/route.ts app/costs/finops-cora-dashboard.tsx tests/finops-cora-dashboard.test.ts tests/finops-cora-dashboard-ui-contract.test.mjs`
- `pnpm exec tsc --noEmit --pretty false`

## Remaining blockers

- Bind a credential-owning server collector to the existing CORA source contract and this repository, including manifest/object exhaustion and rejected-row evidence.
- Register migrations in both runtime registries (intentionally excluded from this isolated agent slice).
- Wire the standalone component into the shared catalog/navigation (intentionally excluded from this isolated agent slice).
- Run the collector against an enabled organization-level Cost Optimization Hub Data Export and retain accepted provider evidence.
- Complete browser visual/accessibility acceptance and production deployment gates.
